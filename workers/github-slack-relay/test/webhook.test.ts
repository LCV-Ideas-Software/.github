import { describe, expect, it, vi } from "vitest";

import { handleFetch, runScheduledRecovery } from "../src/index";
import {
  FakeQueue,
  makeEnv,
  MemoryDeliveryStore,
  signedRequest,
  TEST_RELAY_SIGNING_SECRET,
  workflowPayload,
} from "./helpers";

const NOW = Date.parse("2026-08-03T12:00:00.000Z");

// A D1 whose dispatcher tables do not exist — what a deploy that never applied
// migration 0010 actually answers (review finding F-C).
function brokenDispatchSchemaD1(): D1Database {
  return {
    prepare(): D1PreparedStatement {
      throw new Error("D1_ERROR: no such table: dispatch_outbox");
    },
    async batch(): Promise<D1Result<unknown>[]> {
      throw new Error("D1_ERROR: no such table: dispatch_outbox");
    },
  } as unknown as D1Database;
}

describe("GitHub webhook ingress", () => {
  it("verifies HMAC before parsing and accepts a relevant workflow failure", async () => {
    const queue = new FakeQueue();
    const store = new MemoryDeliveryStore();
    const deliveryId = "00000000-0000-4000-8000-000000000001";
    const request = await signedRequest(
      "workflow_run",
      deliveryId,
      workflowPayload(),
    );

    const response = await handleFetch(request, makeEnv(queue), {
      store,
      now: () => NOW,
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true, queued: true });
    expect(queue.sent).toEqual([{ deliveryId }]);
    expect(store.deliveries.get(deliveryId)?.status).toBe("queued");
  });

  it("rejects an invalid signature without parsing a malformed body", async () => {
    const queue = new FakeQueue();
    const store = new MemoryDeliveryStore();
    const request = await signedRequest(
      "workflow_run",
      "00000000-0000-4000-8000-000000000002",
      {},
      { rawBody: "{malformed", secret: "wrong-secret" },
    );

    const response = await handleFetch(request, makeEnv(queue), { store });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "invalid_signature" });
    expect(store.deliveries.size).toBe(0);
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
      store: new MemoryDeliveryStore(),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_json_payload" });
  });

  it("validates the organization before accepting the initial ping", async () => {
    const queue = new FakeQueue();
    const store = new MemoryDeliveryStore();
    const validPing = await signedRequest(
      "ping",
      "00000000-0000-4000-8000-000000000004",
      { organization: { login: "LCV-Ideas-Software" }, zen: "test" },
    );
    const accepted = await handleFetch(validPing, makeEnv(queue), { store });

    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ accepted: true, event: "ping" });
    expect(store.deliveries.size).toBe(0);
    expect(queue.sent).toHaveLength(0);

    const invalidPing = await signedRequest(
      "ping",
      "00000000-0000-4000-8000-000000000005",
      { organization: { login: "another-owner" } },
    );
    const rejected = await handleFetch(invalidPing, makeEnv(queue), { store });
    expect(rejected.status).toBe(403);
  });

  it("filters successful workflows, unsupported events, and archived repositories", async () => {
    const queue = new FakeQueue();
    const store = new MemoryDeliveryStore();

    const successful = await signedRequest(
      "workflow_run",
      "00000000-0000-4000-8000-000000000006",
      workflowPayload("success"),
    );
    const successfulResponse = await handleFetch(successful, makeEnv(queue), {
      store,
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
      store,
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
      store,
    });
    expect(await archivedResponse.json()).toMatchObject({
      ignored: true,
      reason: "repository_archived",
    });

    expect(store.deliveries.size).toBe(0);
    expect(queue.sent).toHaveLength(0);
  });

  it("deduplicates X-GitHub-Delivery before enqueueing", async () => {
    const queue = new FakeQueue();
    const store = new MemoryDeliveryStore();
    const deliveryId = "00000000-0000-4000-8000-000000000009";

    const first = await handleFetch(
      await signedRequest("workflow_run", deliveryId, workflowPayload()),
      makeEnv(queue),
      { store, now: () => NOW },
    );
    const second = await handleFetch(
      await signedRequest("workflow_run", deliveryId, workflowPayload()),
      makeEnv(queue),
      { store, now: () => NOW },
    );

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual({ accepted: true, duplicate: true });
    expect(queue.sent).toEqual([{ deliveryId }]);
    expect(store.deliveries.size).toBe(1);
  });

  it("persists before enqueue and lets the scheduler recover a queue failure", async () => {
    const queue = new FakeQueue();
    queue.fail = true;
    const store = new MemoryDeliveryStore();
    const deliveryId = "00000000-0000-4000-8000-000000000010";

    const response = await handleFetch(
      await signedRequest("workflow_run", deliveryId, workflowPayload()),
      makeEnv(queue),
      { store, now: () => NOW },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "queue_unavailable",
      recovery_scheduled: true,
    });
    expect(store.deliveries.get(deliveryId)?.status).toBe("pending");

    queue.fail = false;
    const result = await runScheduledRecovery(makeEnv(queue), {
      store,
      now: () => NOW + 5_001,
    });
    expect(result.recovered).toBe(1);
    expect(queue.sent).toEqual([{ deliveryId }]);
    expect(store.deliveries.get(deliveryId)?.status).toBe("queued");
  });

  it("accepts a legitimate signed payload larger than 2 MiB", async () => {
    const queue = new FakeQueue();
    const store = new MemoryDeliveryStore();
    const payload = {
      ...workflowPayload(),
      ignored_padding: "x".repeat(2 * 1024 * 1024 + 1),
    };
    const request = await signedRequest(
      "workflow_run",
      "00000000-0000-4000-8000-000000000011",
      payload,
    );

    const response = await handleFetch(request, makeEnv(queue), {
      store,
      now: () => NOW,
    });

    expect(response.status).toBe(202);
    expect(store.deliveries.size).toBe(1);
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
      store: new MemoryDeliveryStore(),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "payload_too_large" });
  });

  it("reports ready only after D1 and required live bindings validate", async () => {
    const queue = new FakeQueue();
    const store = new MemoryDeliveryStore();
    const fetchMock = vi.fn<typeof fetch>();
    const response = await handleFetch(
      new Request("https://relay.example/healthz"),
      makeEnv(queue),
      { store, fetch: fetchMock },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ready",
      legacy_unverified: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports quarantined legacy debt without failing readiness", async () => {
    const queue = new FakeQueue();
    const store = new MemoryDeliveryStore();
    store.seed("legacy-quarantine", "accepted_by_slack", NOW, {
      legacyUnverified: true,
    });

    const response = await handleFetch(
      new Request("https://relay.example/healthz"),
      makeEnv(queue),
      { store },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ready",
      legacy_unverified: true,
    });
  });

  it.each([
    ["GITHUB_WEBHOOK_SECRET", null],
    ["GITHUB_WEBHOOK_SECRET", "short"],
    ["SLACK_ALERTS_WORKFLOW_WEBHOOK_URL", null],
    ["SLACK_ALERTS_WORKFLOW_WEBHOOK_URL", "https://example.com/not-slack"],
    ["SLACK_ACTIVITY_WORKFLOW_WEBHOOK_URL", null],
    [
      "SLACK_ACTIVITY_WORKFLOW_WEBHOOK_URL",
      "https://hooks.slack.com/triggers/incomplete",
    ],
    ["SLACK_RELAY_SIGNING_SECRET", null],
    ["SLACK_RELAY_SIGNING_SECRET", "short"],
    ["SLACK_RELAY_SIGNING_SECRET_NEXT", "short"],
    ["SLACK_RELAY_SIGNING_SECRET_NEXT", TEST_RELAY_SIGNING_SECRET],
  ])(
    "returns the same generic 503 for invalid binding %s",
    async (binding, value) => {
      const queue = new FakeQueue();
      const env = makeEnv(queue);
      (env as unknown as Record<string, unknown>)[binding] = value;

      const response = await handleFetch(
        new Request("https://relay.example/healthz"),
        env,
        { store: new MemoryDeliveryStore() },
      );

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: "unavailable" });
    },
  );

  // Review finding F-C (ADR §10 H42): /healthz validated the LEGACY webhook
  // secrets and the LEGACY schema only. Once the outbox became the primary
  // path, a missing dispatch migration or an unreadable
  // SLACK_DISPATCH_BOT_TOKEN left health at 200 while every dispatch retried
  // or every ingress failed. The probe is mode-aware, in the same Promise.all
  // and the same `ready &&` conjunction as the legacy probes.
  it("F-C: reports unavailable when the dispatch schema is missing, in every mode", async () => {
    for (const dispatchMode of ["off", "shadow", "primary"]) {
      const response = await handleFetch(
        new Request("https://relay.example/healthz"),
        makeEnv(new FakeQueue(), {
          db: brokenDispatchSchemaD1(),
          dispatchMode,
        }),
        { store: new MemoryDeliveryStore() },
      );

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: "unavailable" });
    }
  });

  it("F-C: reports unavailable when the dispatch bot token is unusable and egress is enabled", async () => {
    for (const dispatchMode of ["shadow", "primary"]) {
      const env = makeEnv(new FakeQueue(), { dispatchMode });
      (env as unknown as Record<string, unknown>)["SLACK_DISPATCH_BOT_TOKEN"] =
        null;

      const response = await handleFetch(
        new Request("https://relay.example/healthz"),
        env,
        { store: new MemoryDeliveryStore() },
      );

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: "unavailable" });
    }
  });

  it("F-C: an unusable dispatch bot token does not fail health while egress is off", async () => {
    const env = makeEnv(new FakeQueue(), { dispatchMode: "off" });
    (env as unknown as Record<string, unknown>)["SLACK_DISPATCH_BOT_TOKEN"] =
      null;

    const response = await handleFetch(
      new Request("https://relay.example/healthz"),
      env,
      { store: new MemoryDeliveryStore() },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ready",
      legacy_unverified: false,
    });
  });

  it("returns the same generic 503 for an unusable schema", async () => {
    const queue = new FakeQueue();
    const store = new MemoryDeliveryStore();
    store.healthy = false;

    const response = await handleFetch(
      new Request("https://relay.example/healthz"),
      makeEnv(queue),
      { store },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unavailable" });
  });

  it("degrades readiness when any delivery requires manual review", async () => {
    const queue = new FakeQueue();
    const store = new MemoryDeliveryStore();
    store.seed("manual-review-readiness", "manual_review", NOW);

    const response = await handleFetch(
      new Request("https://relay.example/healthz"),
      makeEnv(queue),
      { store },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unavailable" });
  });
});
