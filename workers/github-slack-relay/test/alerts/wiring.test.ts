import { afterEach, describe, expect, it } from "vitest";

import { handleFetch, handleQueue } from "../../src/index";
import { AlertStore } from "../../src/alerts/store";
import type { QueueJob } from "../../src/store";
import { FakeQueue, makeEnv, signedRequest } from "../helpers";
import { closeAlertDatabases, makeAlertDb } from "./helpers";

afterEach(closeAlertDatabases);

const NOW = 1_755_000_000_000;

function dependabotPayload(): Record<string, unknown> {
  return {
    action: "created",
    alert: {
      security_advisory: { severity: "high", summary: "S" },
      html_url: "https://github.com/LCV-Ideas-Software/astrologo-app/security/dependabot/1",
    },
    sender: { login: "octocat" },
    organization: { login: "LCV-Ideas-Software" },
    repository: {
      archived: false,
      full_name: "LCV-Ideas-Software/astrologo-app",
      owner: { login: "LCV-Ideas-Software" },
    },
  };
}

describe("fiação do ingress (ADR-002 §2/§4)", () => {
  it("evento do escopo: grava em alert_delivery e publica {v:2, delivery_id}", async () => {
    const queue = new FakeQueue();
    const alertStore = new AlertStore(makeAlertDb().d1);
    const deliveryId = "11111111-2222-3333-4444-555555555555";
    const response = await handleFetch(
      await signedRequest("dependabot_alert", deliveryId, dependabotPayload()),
      makeEnv(queue),
      { alertStore, now: () => NOW },
    );
    expect(response.status).toBe(202);
    const row = await alertStore.get(deliveryId);
    // O ingress CARIMBA antes de publicar (publica só quem carimba): a
    // primeira tentativa é agendada, e o cron só volta após recuo(1).
    expect(row).toMatchObject({
      state: "pending",
      createdMs: NOW,
      attempts: 1,
      nextDueMs: NOW + 5 * 60_000,
    });
    expect(queue.sent).toEqual([
      { v: 2, delivery_id: deliveryId } as unknown as QueueJob,
    ]);
    // O payload guardado é o NORMALIZADO — a mensagem monta no envio.
    const payload = JSON.parse(row?.payloadJson ?? "{}") as Record<string, unknown>;
    expect(payload.delivery_id).toBe(deliveryId);
    expect(payload.severity).toBe("high");
  });

  it("redelivery do MESMO GUID: 202 duplicate, sem segunda publicação", async () => {
    const queue = new FakeQueue();
    const alertStore = new AlertStore(makeAlertDb().d1);
    const deliveryId = "11111111-2222-3333-4444-555555555555";
    const deps = { alertStore, now: () => NOW };
    await handleFetch(
      await signedRequest("dependabot_alert", deliveryId, dependabotPayload()),
      makeEnv(queue),
      deps,
    );
    const response = await handleFetch(
      await signedRequest("dependabot_alert", deliveryId, dependabotPayload()),
      makeEnv(queue),
      deps,
    );
    expect(response.status).toBe(202);
    expect(queue.sent).toHaveLength(1); // publica SÓ quando insere
  });

  it("fila indisponível: aceito com queued:false — o corpo diz a verdade, e o cron recupera após o recuo", async () => {
    const queue = new FakeQueue();
    queue.fail = true;
    const alertStore = new AlertStore(makeAlertDb().d1);
    const deliveryId = "99999999-2222-3333-4444-555555555555";
    const response = await handleFetch(
      await signedRequest("dependabot_alert", deliveryId, dependabotPayload()),
      makeEnv(queue),
      { alertStore, now: () => NOW },
    );
    expect(response.status).toBe(202); // aceito: a promessa ancora no INSERT
    expect(await response.json()).toEqual({
      accepted: true,
      queued: false,
      recovery: "cron",
    });
    expect((await alertStore.get(deliveryId))?.state).toBe("pending");

    // O carimbo do ingresso afastou o cron por recuo(1); vencido o recuo,
    // o cron recupera.
    queue.fail = false;
    const { runAlertCron } = await import("../../src/alerts/cron");
    const r = await runAlertCron({
      store: alertStore,
      queue: { send: async (m) => queue.send(m as QueueJob) },
      now: () => NOW + 5 * 60_000 + 1,
    });
    expect(r.published).toBe(1);
  });
});

describe("corrida ingress×cron no carimbo (ADR-002 §4)", () => {
  it("cron carimba entre o INSERT e o carimbo do ingress: UMA publicação total, e é a do cron", async () => {
    // Corrida determinística por barreira: o insert do store dispara um
    // passe do cron ANTES de o ingress carimbar. O CAS decide: o cron
    // vence, o stampDue do ingress devolve false, e o send do ingress é
    // GATEADO — total de publicações TEM de ser 1.
    const queue = new FakeQueue();
    const { d1 } = makeAlertDb();
    const base = new AlertStore(d1);
    const { runAlertCron } = await import("../../src/alerts/cron");
    const cronQueue = { send: async (m: unknown) => queue.send(m as QueueJob) };

    // Subclasse com barreira: depois do INSERT do ingress e ANTES do seu
    // carimbo, o "outro isolate" roda um passe do cron sobre o MESMO banco.
    class RacingStore extends AlertStore {
      override async insert(
        id: string,
        payload: string,
        now: number,
      ): Promise<boolean> {
        const inserted = await super.insert(id, payload, now);
        if (inserted) {
          await runAlertCron({ store: base, queue: cronQueue, now: () => now });
        }
        return inserted;
      }
    }
    const racing = new RacingStore(d1);

    const deliveryId = "77777777-2222-3333-4444-555555555555";
    const response = await handleFetch(
      await signedRequest("dependabot_alert", deliveryId, dependabotPayload()),
      makeEnv(queue),
      { alertStore: racing, now: () => NOW },
    );

    expect(response.status).toBe(202);
    // O ingress perdeu o CAS: o corpo diz queued:false (a publicação é do cron).
    expect(await response.json()).toEqual({
      accepted: true,
      queued: false,
      recovery: "cron",
    });
    // UMA publicação no total — a do cron. Duas seria a corrida que a
    // revisão apontou.
    expect(queue.sent).toEqual([
      { v: 2, delivery_id: deliveryId } as unknown as QueueJob,
    ]);
    expect((await base.get(deliveryId))?.attempts).toBe(1);
  });

  it("drenagem acima do LIMIT: 150 devidas drenam em dois passes (100 + 50), sem inanição", async () => {
    const base = new AlertStore(makeAlertDb().d1);
    const sent: unknown[] = [];
    const queue = { send: async (m: unknown) => void sent.push(m) };
    const { runAlertCron } = await import("../../src/alerts/cron");
    for (let i = 0; i < 150; i++) {
      await base.insert(`d-${String(i).padStart(3, "0")}`, "{}", 1_000 + i);
    }
    const r1 = await runAlertCron({ store: base, queue, now: () => 10_000 });
    const r2 = await runAlertCron({ store: base, queue, now: () => 10_500 });
    expect(r1.published).toBe(100); // CRON_SELECT_LIMIT
    expect(r2.published).toBe(50); // as carimbadas no passe 1 não voltam
    expect(sent).toHaveLength(150);
  });
});

describe("roteamento v:2 na fila (ADR-002 §4)", () => {
  function batchDe(
    queueName: string,
    body: unknown,
  ): { batch: MessageBatch<QueueJob>; acks: number[] } {
    const acks: number[] = [];
    const message = {
      body: body as QueueJob,
      ack: () => acks.push(1),
      retry: () => acks.push(-1),
      attempts: 1,
      id: "m-1",
      timestamp: new Date(0),
    };
    return {
      batch: {
        queue: queueName,
        messages: [message],
      } as unknown as MessageBatch<QueueJob>,
      acks,
    };
  }

  it("v:2 na DLQ é DESCARTADA — a DLQ não é segundo caminho de entrega", async () => {
    const alertStore = new AlertStore(makeAlertDb().d1);
    await alertStore.insert("d-dlq", "{}", 1_000);
    let chamadas = 0;
    const contando: typeof fetch = (async () => {
      chamadas++;
      return new Response('{"ok":true}');
    }) as unknown as typeof fetch;
    const { batch, acks } = batchDe("github-slack-alerts-dlq", {
      v: 2,
      delivery_id: "d-dlq",
    });
    await handleQueue(batch, makeEnv(new FakeQueue()), {
      alertStore,
      fetch: contando,
      now: () => 5_000,
    });
    expect(chamadas).toBe(0); // nenhum POST a partir da DLQ
    expect(acks).toEqual([1]); // confirmada e descartada
    expect((await alertStore.get("d-dlq"))?.state).toBe("pending"); // o cron recarimba
  });

  it("v:2 na fila primária é processada", async () => {
    const alertStore = new AlertStore(makeAlertDb().d1);
    await alertStore.insert("d-prim", '{"title":"T","delivery_id":"d-prim"}', 1_000);
    const okFetch: typeof fetch = (async () =>
      new Response('{"ok":true,"ts":"1786.9"}')) as unknown as typeof fetch;
    const { batch } = batchDe("github-slack-alerts", {
      v: 2,
      delivery_id: "d-prim",
    });
    await handleQueue(batch, makeEnv(new FakeQueue()), {
      alertStore,
      fetch: okFetch,
      now: () => 5_000,
    });
    expect((await alertStore.get("d-prim"))?.state).toBe("sent");
  });
});

describe("/alerts/status (decisão 9)", () => {
  function statusRequest(secret?: string): Request {
    return new Request("https://relay.example/alerts/status", {
      method: "GET",
      headers: secret === undefined ? {} : { "x-alerts-status-secret": secret },
    });
  }

  it("sem segredo ou com segredo errado: 401 sem contagens", async () => {
    const alertStore = new AlertStore(makeAlertDb().d1);
    const env = makeEnv(new FakeQueue());
    for (const req of [statusRequest(), statusRequest("errado")]) {
      const r = await handleFetch(req, env, { alertStore, now: () => NOW });
      expect(r.status).toBe(401);
      expect(await r.text()).not.toContain("pending");
    }
  });

  it("com o segredo: pending, sent e a idade da pendente mais velha por created_ms", async () => {
    const alertStore = new AlertStore(makeAlertDb().d1);
    await alertStore.insert("a-1", "{}", NOW - 120_000);
    await alertStore.insert("a-2", "{}", NOW - 60_000);
    await alertStore.markSent("a-2", null, NOW - 30_000);
    const r = await handleFetch(
      statusRequest("segredo-status-de-teste"),
      makeEnv(new FakeQueue()),
      { alertStore, now: () => NOW },
    );
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      pending: 1,
      sent: 1,
      oldest_pending_age_ms: 120_000,
    });
  });
});
