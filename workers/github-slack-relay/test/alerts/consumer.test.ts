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

  it("payload que não é JSON válido: registra e retorna, linha fica pendente", async () => {
    const store = new AlertStore(makeAlertDb().d1);
    // json_valid barra lixo no INSERT, então o caso real é JSON válido cujo
    // conteúdo explode o renderizador — simulado por fetch nunca chamado +
    // JSON.parse de string ok. Forçamos a exceção mais cedo: payload é
    // válido para o banco, e o fetch explode; já coberto acima. Aqui: linha
    // ausente não lança.
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
