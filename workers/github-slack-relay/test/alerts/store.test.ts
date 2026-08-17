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

  it("CAS SOBREPOSTO: dois stampDue concorrentes sobre a mesma linha devida — exatamente um vence", async () => {
    // Passes concorrentes do cron (dois isolates, dois ticks) disputando a
    // mesma linha. O D1 serializa escritas; o WHERE do CAS decide quem
    // venceu. Promise.all dispara os dois sem ordem garantida; a soma dos
    // resultados TEM de ser exatamente 1, e attempts termina em 1.
    const store = new AlertStore(makeAlertDb().d1);
    await store.insert("guid-corrida", "{}", 1_000);
    const [a, b] = await Promise.all([
      store.stampDue("guid-corrida", 10_000, 310_000),
      store.stampDue("guid-corrida", 10_001, 310_001),
    ]);
    expect(Number(a) + Number(b)).toBe(1);
    expect((await store.get("guid-corrida"))?.attempts).toBe(1);
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

  it("statusSnapshot devolve contagens e idade num retrato ÚNICO (uma consulta)", async () => {
    // Duas consultas independentes deixavam o consumidor marcar `sent` no
    // meio: idade velha com pending 0, ou pendente sem idade — e o vigia
    // decide pela idade (achado da revisão). Uma instrução SQL = um
    // retrato consistente no D1.
    const store = new AlertStore(makeAlertDb().d1);
    await store.insert("a", "{}", 1_000);
    await store.insert("b", "{}", 3_000);
    await store.insert("c", "{}", 2_000);
    await store.markSent("c", null, 4_000);
    expect(await store.statusSnapshot()).toEqual({
      pending: 2,
      sent: 1,
      oldestPendingCreatedMs: 1_000,
    });
  });

  it("schemaProbe: resolve com o esquema migrado e rejeita sem a tabela — trabalho constante para o /healthz público", async () => {
    // Achado da revisão: agregado de tabela inteira num probe não
    // autenticado é amplificação de carga; a prontidão sonda com LIMIT 1.
    const migrado = new AlertStore(makeAlertDb().d1);
    await expect(migrado.schemaProbe()).resolves.toBeUndefined();

    const cru = new AlertStore(makeAlertDb({ aplicarMigracao: false }).d1);
    await expect(cru.schemaProbe()).rejects.toThrow();
  });

  it("statusSnapshot com zero pendentes: idade nula e contagens coerentes no MESMO retrato", async () => {
    const store = new AlertStore(makeAlertDb().d1);
    await store.insert("s", "{}", 1_000);
    await store.markSent("s", null, 2_000);
    expect(await store.statusSnapshot()).toEqual({
      pending: 0,
      sent: 1,
      oldestPendingCreatedMs: null,
    });
  });
});
