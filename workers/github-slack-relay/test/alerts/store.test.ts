import { afterEach, describe, expect, it } from "vitest";

import { AlertStore } from "../../src/alerts/store";
import { closeAlertDatabases, makeAlertDb } from "./helpers";

afterEach(closeAlertDatabases);

describe("AlertStore — a matriz de escritas do ADR-002 §4", () => {
  it("insert é idempotente pelo GUID: a segunda vez devolve false", async () => {
    const store = new AlertStore(makeAlertDb().d1);
    expect(await store.insert("guid-1", "{}", 1_000)).toBe(true);
    expect(await store.insert("guid-1", "{}", 2_000)).toBe(false);
  });

  it("CAS: linha devida + dois passes = EXATAMENTE UM carimbo (teste vinculante do §9)", async () => {
    const store = new AlertStore(makeAlertDb().d1);
    await store.insert("guid-2", "{}", 1_000); // next_due_ms = 0: devida já
    const primeiro = await store.stampDue("guid-2", 10_000, 310_000);
    const segundo = await store.stampDue("guid-2", 10_001, 310_000);
    expect(primeiro).toBe(true);
    expect(segundo).toBe(false); // next_due_ms=310000 > 10001: não devida
    expect((await store.get("guid-2"))?.attempts).toBe(1);
  });

  it("linha 'sent' nunca é carimbada: o consumidor venceu a corrida", async () => {
    const store = new AlertStore(makeAlertDb().d1);
    await store.insert("guid-3", "{}", 1_000);
    await store.markSent("guid-3", "1786.000001", 2_000);
    expect(await store.stampDue("guid-3", 10_000, 310_000)).toBe(false);
  });

  it("recordFailure NÃO toca agendamento nem created_ms (matriz por mutação)", async () => {
    const store = new AlertStore(makeAlertDb().d1);
    await store.insert("guid-4", "{}", 1_000);
    await store.stampDue("guid-4", 5_000, 305_000);
    await store.recordFailure("guid-4", "http_500");
    const row = await store.get("guid-4");
    expect(row).toMatchObject({
      lastError: "http_500",
      attempts: 1,
      updatedMs: 5_000,
      nextDueMs: 305_000,
      createdMs: 1_000,
      state: "pending",
    });
  });

  it("dueRows ordena por next_due_ms e ignora sent e não-devidas", async () => {
    const store = new AlertStore(makeAlertDb().d1);
    await store.insert("velha", "{}", 1_000);
    await store.insert("nova", "{}", 2_000);
    await store.stampDue("nova", 3_000, 999_000); // não-devida
    await store.insert("entregue", "{}", 1_500);
    await store.markSent("entregue", null, 2_500);
    const due = await store.dueRows(10_000, 10);
    expect(due.map((r) => r.deliveryId)).toEqual(["velha"]);
  });

  it("retenção apaga só sent, por created_ms, e devolve a contagem", async () => {
    const store = new AlertStore(makeAlertDb().d1);
    await store.insert("pendente-velha", "{}", 1_000);
    await store.insert("sent-velha", "{}", 1_000);
    await store.markSent("sent-velha", null, 2_000);
    await store.insert("sent-nova", "{}", 900_000);
    await store.markSent("sent-nova", null, 900_500);
    expect(await store.deleteSentOlderThan(500_000)).toBe(1);
    expect(await store.get("pendente-velha")).not.toBeNull(); // NUNCA apagada
    expect(await store.get("sent-nova")).not.toBeNull();
  });

  it("counts e oldestPendingCreatedMs alimentam o /status", async () => {
    const store = new AlertStore(makeAlertDb().d1);
    await store.insert("a", "{}", 1_000);
    await store.insert("b", "{}", 3_000);
    await store.insert("c", "{}", 2_000);
    await store.markSent("c", null, 4_000);
    expect(await store.counts()).toEqual({ pending: 2, sent: 1 });
    expect(await store.oldestPendingCreatedMs()).toBe(1_000);
  });
});
