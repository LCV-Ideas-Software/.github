import { afterEach, describe, expect, it, vi } from "vitest";

import { handleFetch } from "../src/index";
import { runAlertCron } from "../src/alerts/cron";
import { AlertStore } from "../src/alerts/store";
import type { AlertQueueMessage } from "../src/alerts/contract";
import { closeAlertDatabases, makeAlertDb } from "./alerts/helpers";
import { FakeQueue, makeEnv, signedRequest, workflowPayload } from "./helpers";

afterEach(closeAlertDatabases);

const NOW = Date.parse("2026-08-03T12:00:00.000Z");

describe("GitHub webhook ingress", () => {
  it("verifies HMAC before parsing and accepts a relevant workflow failure", async () => {
    // ADR-002 §2/§4: aceito = linha em alert_delivery; publica {v:2, ...}.
    const queue = new FakeQueue();
    const alertStore = new AlertStore(makeAlertDb().d1);
    const deliveryId = "00000000-0000-4000-8000-000000000001";
    const request = await signedRequest(
      "workflow_run",
      deliveryId,
      workflowPayload(),
    );

    const response = await handleFetch(request, makeEnv(queue), {
      alertStore,
      now: () => NOW,
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true, queued: true });
    expect(queue.sent).toEqual([
      { v: 2, delivery_id: deliveryId },
    ]);
    expect((await alertStore.get(deliveryId))?.state).toBe("pending");
  });

  it("rejects an invalid signature without parsing a malformed body", async () => {
    const queue = new FakeQueue();
    const alertStore = new AlertStore(makeAlertDb().d1);
    const request = await signedRequest(
      "workflow_run",
      "00000000-0000-4000-8000-000000000002",
      {},
      { rawBody: "{malformed", secret: "wrong-secret" },
    );

    const response = await handleFetch(request, makeEnv(queue), { alertStore });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "invalid_signature" });
    expect((await alertStore.statusSnapshot()).pending).toBe(0);
    expect(queue.sent).toHaveLength(0);
  });

  it("returns a JSON error for a signed but malformed body", async () => {
    const queue = new FakeQueue();
    const request = await signedRequest(
      "workflow_run",
      "00000000-0000-4000-8000-000000000003",
      {},
      { rawBody: "{malformed" },
    );

    const response = await handleFetch(request, makeEnv(queue), {
      alertStore: new AlertStore(makeAlertDb().d1),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_json_payload" });
  });

  it("validates the organization before accepting the initial ping", async () => {
    const queue = new FakeQueue();
    const alertStore = new AlertStore(makeAlertDb().d1);
    const validPing = await signedRequest(
      "ping",
      "00000000-0000-4000-8000-000000000004",
      { organization: { login: "LCV-Ideas-Software" }, zen: "test" },
    );
    const accepted = await handleFetch(validPing, makeEnv(queue), {
      alertStore,
    });

    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ accepted: true, event: "ping" });
    expect(queue.sent).toHaveLength(0);

    const invalidPing = await signedRequest(
      "ping",
      "00000000-0000-4000-8000-000000000005",
      { organization: { login: "another-owner" } },
    );
    const rejected = await handleFetch(invalidPing, makeEnv(queue), {
      alertStore,
    });
    expect(rejected.status).toBe(403);
  });

  it("filters successful workflows, unsupported events, and archived repositories", async () => {
    const queue = new FakeQueue();
    const alertStore = new AlertStore(makeAlertDb().d1);

    const successful = await signedRequest(
      "workflow_run",
      "00000000-0000-4000-8000-000000000006",
      workflowPayload("success"),
    );
    const successfulResponse = await handleFetch(successful, makeEnv(queue), {
      alertStore,
    });
    expect(successfulResponse.status).toBe(202);
    expect(await successfulResponse.json()).toMatchObject({ ignored: true });

    const unsupported = await signedRequest(
      "fork",
      "00000000-0000-4000-8000-000000000007",
      {
        action: "opened",
        organization: { login: "LCV-Ideas-Software" },
      },
    );
    const unsupportedResponse = await handleFetch(unsupported, makeEnv(queue), {
      alertStore,
    });
    expect(await unsupportedResponse.json()).toMatchObject({
      ignored: true,
      reason: "event_not_supported",
    });

    const archivedPayload = workflowPayload();
    (archivedPayload.repository as Record<string, unknown>).archived = true;
    const archived = await signedRequest(
      "workflow_run",
      "00000000-0000-4000-8000-000000000008",
      archivedPayload,
    );
    const archivedResponse = await handleFetch(archived, makeEnv(queue), {
      alertStore,
    });
    expect(await archivedResponse.json()).toMatchObject({
      ignored: true,
      reason: "repository_archived",
    });

    expect((await alertStore.statusSnapshot()).pending).toBe(0);
    expect(queue.sent).toHaveLength(0);
  });

  it("deduplicates X-GitHub-Delivery before enqueueing", async () => {
    // Decisão 10: a linha guardada É a trava; publica SÓ quando insere.
    const queue = new FakeQueue();
    const alertStore = new AlertStore(makeAlertDb().d1);
    const deliveryId = "00000000-0000-4000-8000-000000000009";

    const first = await handleFetch(
      await signedRequest("workflow_run", deliveryId, workflowPayload()),
      makeEnv(queue),
      { alertStore, now: () => NOW },
    );
    const second = await handleFetch(
      await signedRequest("workflow_run", deliveryId, workflowPayload()),
      makeEnv(queue),
      { alertStore, now: () => NOW },
    );

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual({ accepted: true, duplicate: true });
    expect(queue.sent).toHaveLength(1);
  });

  it("persists before enqueue and the CRON recovers a queue failure", async () => {
    // ADR-002 §4: a fila é otimização de latência; o cron é a vivacidade.
    const queue = new FakeQueue();
    queue.fail = true;
    const alertStore = new AlertStore(makeAlertDb().d1);
    const deliveryId = "00000000-0000-4000-8000-000000000010";

    const response = await handleFetch(
      await signedRequest("workflow_run", deliveryId, workflowPayload()),
      makeEnv(queue),
      { alertStore, now: () => NOW },
    );

    expect(response.status).toBe(202);
    expect((await alertStore.get(deliveryId))?.state).toBe("pending");

    queue.fail = false;
    // O ingress carimbou a primeira tentativa (recuo(1) = 5 min); o cron
    // só a reagenda depois de o recuo vencer.
    const result = await runAlertCron({
      store: alertStore,
      queue: { send: (m) => queue.send(m as AlertQueueMessage) },
      now: () => NOW + 5 * 60_000 + 1,
    });
    expect(result.published).toBe(1);
    expect(queue.sent).toEqual([
      { v: 2, delivery_id: deliveryId },
    ]);
  });

  it("accepts a legitimate signed payload larger than 2 MiB", async () => {
    const queue = new FakeQueue();
    const alertStore = new AlertStore(makeAlertDb().d1);
    const deliveryId = "00000000-0000-4000-8000-000000000011";
    const payload = {
      ...workflowPayload(),
      ignored_padding: "x".repeat(2 * 1024 * 1024 + 1),
    };
    const request = await signedRequest("workflow_run", deliveryId, payload);

    const response = await handleFetch(request, makeEnv(queue), {
      alertStore,
      now: () => NOW,
    });

    expect(response.status).toBe(202);
    expect(await alertStore.get(deliveryId)).not.toBeNull();
  });

  it("cancels a streamed body once the hard 25,000,000-byte limit is exceeded", async () => {
    const queue = new FakeQueue();
    const oversized = new Uint8Array(25_000_001);
    const request = new Request("https://relay.example/github/webhook", {
      method: "POST",
      headers: {
        "X-GitHub-Delivery": "00000000-0000-4000-8000-000000000012",
        "X-GitHub-Event": "workflow_run",
        "X-Hub-Signature-256": `sha256=${"0".repeat(64)}`,
      },
      body: oversized,
    });

    const response = await handleFetch(request, makeEnv(queue), {
      alertStore: new AlertStore(makeAlertDb().d1),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "payload_too_large" });
  });

  it("reports ready only after the live bindings and schema validate", async () => {
    const queue = new FakeQueue();
    const fetchMock = vi.fn<typeof fetch>();
    const response = await handleFetch(
      new Request("https://relay.example/healthz"),
      makeEnv(queue),
      { fetch: fetchMock, alertStore: new AlertStore(makeAlertDb().d1) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["GITHUB_WEBHOOK_SECRET", null],
    ["GITHUB_WEBHOOK_SECRET", "short"],
    // ADR-002: a CLASSE da prontidão é "toda credencial que uma rota do
    // Worker exige" (achado da revisão: /healthz dizia ready com o token
    // ilegível e cada mensagem v2 parada em pending).
    ["SLACK_BOT_TOKEN", null],
    ["SLACK_BOT_TOKEN", ""],
    ["ALERTS_STATUS_SECRET", null],
    ["ALERTS_STATUS_SECRET", ""],
    // Piso de 32 bytes na classe "segredo que NÓS provisionamos" (achado
    // da revisão): curto demais autenticava e dizia ready.
    ["ALERTS_STATUS_SECRET", "short"],
  ])(
    "returns the same generic 503 for invalid binding %s",
    async (binding, value) => {
      const queue = new FakeQueue();
      const env = makeEnv(queue);
      (env as unknown as Record<string, unknown>)[binding] = value;

      const response = await handleFetch(
        new Request("https://relay.example/healthz"),
        env,
        { alertStore: new AlertStore(makeAlertDb().d1) },
      );

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: "unavailable" });
    },
  );

  it("returns the same generic 503 when alert_delivery is unavailable — o caminho v2 é a prontidão", async () => {
    // O esquema que a rota precisa tem de existir. O sondador é o
    // schemaProbe (trabalho constante — o /healthz é público, e agregado
    // aqui seria amplificação de carga).
    const queue = new FakeQueue();
    const alertStore = {
      schemaProbe: () => Promise.reject(new Error("no_such_table")),
    } as unknown as AlertStore;

    const response = await handleFetch(
      new Request("https://relay.example/healthz"),
      makeEnv(queue),
      { alertStore },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unavailable" });
  });
});
