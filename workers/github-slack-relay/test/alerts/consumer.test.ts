import { afterEach, describe, expect, it } from "vitest";

import { processAlertMessage } from "../../src/alerts/consumer";
import { AlertStore } from "../../src/alerts/store";
import { closeAlertDatabases, makeAlertDb } from "./helpers";

afterEach(closeAlertDatabases);

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
    })) as unknown as typeof fetch;
}

async function comLinha(
  payload = '{"title":"T","delivery_id":"d-1"}',
): Promise<AlertStore> {
  const store = new AlertStore(makeAlertDb().d1);
  await store.insert("d-1", payload, 1_000);
  return store;
}

function deps(store: AlertStore, f: typeof fetch) {
  return { store, botToken: "xoxb-token-de-teste", fetch: f, now: () => 50_000 };
}

describe("consumidor (ADR-002 §8: ok:true = enviado; resto fica pendente)", () => {
  it("o POST é o contrato da entrega: endpoint, Bearer, canal, texto e content-type", async () => {
    // Achado da revisão: respostas enlatadas sem inspecionar a REQUISIÇÃO
    // deixariam endpoint, token, canal ou corpo regredirem em silêncio.
    const store = await comLinha(
      '{"title":"Título do contrato","delivery_id":"d-1"}',
    );
    const capturadas: Array<{ url: string; init: RequestInit }> = [];
    const capturando: typeof fetch = (async (
      url: string,
      init: RequestInit,
    ) => {
      capturadas.push({ url, init });
      return new Response('{"ok":true}');
    }) as unknown as typeof fetch;

    await processAlertMessage(
      { v: 2, delivery_id: "d-1" },
      deps(store, capturando),
    );

    expect(capturadas).toHaveLength(1);
    const [req] = capturadas;
    expect(req?.url).toBe("https://slack.com/api/chat.postMessage");
    expect(req?.init.method).toBe("POST");
    const headers = req?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer xoxb-token-de-teste");
    expect(headers["Content-Type"]).toBe("application/json; charset=utf-8");
    const corpo = JSON.parse(String(req?.init.body)) as {
      channel: string;
      text: string;
    };
    expect(corpo.channel).toBe("C0BMUK793NV"); // ALERTS_CHANNEL_ID
    expect(corpo.text).toContain("Título do contrato");
  });

  it("ok:true marca sent e guarda ts", async () => {
    const store = await comLinha();
    await processAlertMessage(
      { v: 2, delivery_id: "d-1" },
      deps(store, fakeFetch(200, { ok: true, ts: "1786.000010" })),
    );
    expect(await store.get("d-1")).toMatchObject({
      state: "sent",
      slackMessageTs: "1786.000010",
    });
  });

  it("ok:true SEM ts também é sent — ts é recibo, não prova (§7)", async () => {
    const store = await comLinha();
    await processAlertMessage(
      { v: 2, delivery_id: "d-1" },
      deps(store, fakeFetch(200, { ok: true })),
    );
    expect(await store.get("d-1")).toMatchObject({
      state: "sent",
      slackMessageTs: null,
    });
  });

  it("ok:false fica pendente com o código registrado — nunca desiste (decisão 12)", async () => {
    const store = await comLinha();
    await processAlertMessage(
      { v: 2, delivery_id: "d-1" },
      deps(store, fakeFetch(200, { ok: false, error: "channel_not_found" })),
    );
    expect(await store.get("d-1")).toMatchObject({
      state: "pending",
      lastError: "channel_not_found",
    });
  });

  it("HTTP 500 fica pendente com http_500", async () => {
    const store = await comLinha();
    await processAlertMessage(
      { v: 2, delivery_id: "d-1" },
      deps(store, fakeFetch(500, "<html>")),
    );
    expect(await store.get("d-1")).toMatchObject({
      state: "pending",
      lastError: "http_500",
    });
  });

  it("linha já sent: reentrega da plataforma NÃO posta de novo", async () => {
    const store = await comLinha();
    await store.markSent("d-1", "1786.1", 2_000);
    let chamadas = 0;
    const contando: typeof fetch = (async () => {
      chamadas++;
      return new Response("{}");
    }) as unknown as typeof fetch;
    await processAlertMessage({ v: 2, delivery_id: "d-1" }, deps(store, contando));
    expect(chamadas).toBe(0);
  });

  it("exceção no fetch: registra e RETORNA — nunca escapa para a fila", async () => {
    const store = await comLinha();
    const explosivo: typeof fetch = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    await expect(
      processAlertMessage({ v: 2, delivery_id: "d-1" }, deps(store, explosivo)),
    ).resolves.toBeUndefined();
    const row = await store.get("d-1");
    expect(row?.state).toBe("pending");
    expect(row?.lastError).toMatch(/^exception:/);
  });

  it("linha AUSENTE no store: retorna sem lançar e sem postar — a mensagem morre, o alerta não existe", async () => {
    // O nome anterior prometia "payload que não é JSON válido", que este
    // caso não exercita (achado da revisão): json_valid barra lixo no
    // INSERT (schema.test) e a exceção do renderizador está coberta acima.
    // O que ESTE caso prende é a guarda de linha ausente do consumidor.
    const store = new AlertStore(makeAlertDb().d1);
    await expect(
      processAlertMessage(
        { v: 2, delivery_id: "nao-existe" },
        deps(store, fakeFetch(200, { ok: true })),
      ),
    ).resolves.toBeUndefined();
  });

  it("mensagem que não é {v:2, delivery_id} é ignorada sem lançar", async () => {
    const store = await comLinha();
    await expect(
      processAlertMessage({ deliveryId: "legado" }, deps(store, fakeFetch(200, {}))),
    ).resolves.toBeUndefined();
    expect((await store.get("d-1"))?.state).toBe("pending");
  });
});
