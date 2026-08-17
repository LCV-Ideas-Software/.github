import { afterEach, describe, expect, it } from "vitest";

import { handleFetch, handleQueue, runScheduledEntry } from "../../src/index";
import { AlertStore } from "../../src/alerts/store";
import type { AlertQueueMessage } from "../../src/alerts/contract";
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
      { v: 2, delivery_id: deliveryId },
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

  it("INSERT indisponível: 503 persistence_unavailable — antes da fronteira de aceitação, a recuperação é do GitHub (§2)", async () => {
    // Achado da revisão: o caminho existia sem teste. Antes do INSERT
    // durável não há promessa nossa; o 503 faz o GitHub registrar a falha
    // e a janela de redelivery manual cobrir a entrega.
    const queue = new FakeQueue();
    const quebrado = {
      insert: () => Promise.reject(new Error("d1_unavailable")),
    } as unknown as AlertStore;
    const response = await handleFetch(
      await signedRequest(
        "dependabot_alert",
        "88888888-2222-3333-4444-555555555555",
        dependabotPayload(),
      ),
      makeEnv(queue),
      { alertStore: quebrado, now: () => NOW },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "persistence_unavailable" });
    expect(queue.sent).toHaveLength(0); // nada publicado sem linha durável
  });

  it("CARIMBO indisponível DEPOIS do INSERT: 202 queued:false — a linha durável já é nossa, e nasceu devida (§2)", async () => {
    // Achado da revisão: o stampDue pós-INSERT estava fora do try; a
    // exceção virava 500 no wrapper e o GitHub registrava falha de uma
    // entrega que JÁ tem linha durável. A fronteira de aceitação é o
    // INSERT: dali em diante a resposta é 202, e a recuperação é do cron
    // (a linha nunca foi carimbada, então next_due_ms = 0: devida já).
    const queue = new FakeQueue();
    class CarimboQuebrado extends AlertStore {
      override stampDue(): Promise<boolean> {
        return Promise.reject(new Error("d1_hiccup_no_carimbo"));
      }
    }
    const deliveryId = "66666666-2222-3333-4444-555555555555";
    const alertStore = new CarimboQuebrado(makeAlertDb().d1);
    const response = await handleFetch(
      await signedRequest("dependabot_alert", deliveryId, dependabotPayload()),
      makeEnv(queue),
      { alertStore, now: () => NOW },
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      accepted: true,
      queued: false,
      recovery: "cron",
    });
    expect(queue.sent).toHaveLength(0); // publica só quem carimba
    const row = await alertStore.get(deliveryId);
    expect(row).toMatchObject({ state: "pending", nextDueMs: 0 }); // devida já
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
      queue: { send: async (m) => queue.send(m as AlertQueueMessage) },
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
    const cronQueue = {
      send: async (m: unknown) => queue.send(m as AlertQueueMessage),
    };

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
      { v: 2, delivery_id: deliveryId },
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

describe("passe agendado (ADR-002 §4)", () => {
  it("falha do cron de alertas NÃO é engolida: o passe falha observavelmente", async () => {
    // Achado da revisão: o catch do scheduled engolia o erro e toda falha
    // do cron parecia invocação bem-sucedida — uma falha persistente só da
    // retenção seria invisível (o vigia lê idade de PENDENTE) e as linhas
    // `sent` cresceriam sem limite. Com o legado aposentado, o passe é o
    // cron de alertas puro e a exceção sobe direto para a plataforma.
    const quebrado = {
      dueRows: () => Promise.reject(new Error("d1_cron_down")),
    } as unknown as AlertStore;
    await expect(
      runScheduledEntry(makeEnv(new FakeQueue()), {
        alertStore: quebrado,
      }),
    ).rejects.toThrow("d1_cron_down");
  });

  it("cron saudável: o passe agendado resolve", async () => {
    const alertStore = new AlertStore(makeAlertDb().d1);
    await expect(
      runScheduledEntry(makeEnv(new FakeQueue()), {
        alertStore,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("roteamento v:2 na fila (ADR-002 §4)", () => {
  function batchDe(
    queueName: string,
    body: unknown,
  ): { batch: MessageBatch<AlertQueueMessage>; acks: number[] } {
    const acks: number[] = [];
    const message = {
      body: body as AlertQueueMessage,
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
      } as unknown as MessageBatch<AlertQueueMessage>,
      acks,
    };
  }

  it("fila desconhecida LANÇA — a única fila do caminho é github-slack-alerts", async () => {
    // Com o legado aposentado, não existe DLQ nem fila de atividade: um
    // batch de qualquer outra fila é erro de configuração e falha ALTO.
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
    await expect(
      handleQueue(batch, makeEnv(new FakeQueue()), {
        alertStore,
        fetch: contando,
        now: () => 5_000,
      }),
    ).rejects.toThrow("unexpected_queue");
    expect(chamadas).toBe(0); // nenhum POST a partir de fila desconhecida
    expect(acks).toEqual([]);
    expect((await alertStore.get("d-dlq"))?.state).toBe("pending");
  });

  it("token do bot ilegível: NENHUM POST, last_error registrado, linha pendente — e o consumidor retorna sem retry", async () => {
    // Cobertura do ramo fail-safe (achado da revisão): sem token não há
    // envio; o desfecho é registrado, a linha fica pendente e o retorno
    // normal confirma a mensagem — a recuperação é do cron, nunca da fila.
    const alertStore = new AlertStore(makeAlertDb().d1);
    await alertStore.insert(
      "d-sem-token",
      '{"title":"T","delivery_id":"d-sem-token"}',
      1_000,
    );
    let chamadas = 0;
    const contando: typeof fetch = (async () => {
      chamadas++;
      return new Response('{"ok":true}');
    }) as unknown as typeof fetch;
    const { batch, acks } = batchDe("github-slack-alerts", {
      v: 2,
      delivery_id: "d-sem-token",
    });
    // Binding AUSENTE (readSecret lança); a fixture string vazia não lança —
    // ela é o caso do checque de comprimento na prontidão.
    const env = makeEnv(new FakeQueue());
    (env as unknown as Record<string, unknown>).SLACK_BOT_TOKEN = null;
    await handleQueue(batch, env, {
      alertStore,
      fetch: contando,
      now: () => 5_000,
    });
    expect(chamadas).toBe(0); // nenhum POST sem token
    expect(acks).toEqual([]); // nem retry, nem ack explícito: retorno = ack
    const row = await alertStore.get("d-sem-token");
    expect(row?.state).toBe("pending"); // o cron recarimba
    expect(row?.lastError).toBe("bot_token_unavailable");
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

  it("segredo GUARDADO curto: 401 mesmo com o valor certo no header — piso de 32 bytes, a classe do webhook", async () => {
    // Achado da revisão: a rota comparava contra QUALQUER valor guardado —
    // um segredo truncado na provisão virava autenticação de um caractere.
    // A classe já existia no webhook (hasSafeSecretLength na rota); aqui o
    // 401 é idêntico ao de segredo ilegível, e o vigia alarma em dois
    // tiques (fail-loud) até a rotação corrigir.
    const alertStore = new AlertStore(makeAlertDb().d1);
    const r = await handleFetch(
      statusRequest("curto"),
      makeEnv(new FakeQueue(), { statusSecret: "curto" }),
      { alertStore, now: () => NOW },
    );
    expect(r.status).toBe(401);
    expect(await r.text()).not.toContain("pending");
  });

  it("com o segredo: pending, sent e a idade da pendente mais velha por created_ms", async () => {
    const alertStore = new AlertStore(makeAlertDb().d1);
    await alertStore.insert("a-1", "{}", NOW - 120_000);
    await alertStore.insert("a-2", "{}", NOW - 60_000);
    await alertStore.markSent("a-2", null, NOW - 30_000);
    const r = await handleFetch(
      statusRequest("segredo-status-de-teste-com-mais-de-32-bytes"),
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
