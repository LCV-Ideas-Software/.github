import { afterEach, describe, expect, it } from "vitest";

import { ROW_RETENTION_MS } from "../../src/alerts/contract";
import { runAlertCron } from "../../src/alerts/cron";
import { AlertStore } from "../../src/alerts/store";
import { closeAlertDatabases, makeAlertDb } from "./helpers";

afterEach(closeAlertDatabases);

function fila(): {
  sent: unknown[];
  queue: { send(m: unknown): Promise<void> };
} {
  const sent: unknown[] = [];
  return {
    sent,
    queue: {
      async send(m) {
        sent.push(m);
      },
    },
  };
}

describe("cron — o único agendador (ADR-002 §4)", () => {
  it("linha devida: carimba e publica {v:2, delivery_id} — e o SEGUNDO passe não republica", async () => {
    const store = new AlertStore(makeAlertDb().d1);
    await store.insert("d-1", "{}", 1_000);
    const { sent, queue } = fila();
    const r1 = await runAlertCron({ store, queue, now: () => 10_000 });
    const r2 = await runAlertCron({ store, queue, now: () => 10_500 });
    expect(r1.published).toBe(1);
    expect(r2.published).toBe(0); // ADR §9: dois passes, UM enfileiramento
    expect(sent).toEqual([{ v: 2, delivery_id: "d-1" }]);
    expect((await store.get("d-1"))?.attempts).toBe(1);
  });

  it("depois do recuo vencer, a linha volta a ser publicada", async () => {
    const store = new AlertStore(makeAlertDb().d1);
    await store.insert("d-2", "{}", 1_000);
    const { queue } = fila();
    await runAlertCron({ store, queue, now: () => 10_000 }); // attempts=1, next=+5min
    const depois = 10_000 + 5 * 60_000 + 1;
    const r = await runAlertCron({ store, queue, now: () => depois });
    expect(r.published).toBe(1);
    expect((await store.get("d-2"))?.attempts).toBe(2);
  });

  it("sent não é publicada; retenção apaga sent velha no mesmo passe", async () => {
    const store = new AlertStore(makeAlertDb().d1);
    await store.insert("s-1", "{}", 1_000);
    await store.markSent("s-1", null, 2_000);
    const agora = 1_000 + ROW_RETENTION_MS + 1;
    const { sent, queue } = fila();
    const r = await runAlertCron({ store, queue, now: () => agora });
    expect(sent).toEqual([]);
    expect(r.purged).toBe(1);
    expect(await store.get("s-1")).toBeNull();
  });

  it("falha do send não perde a linha: o carimbo já correu, o próximo ciclo recarimba", async () => {
    const store = new AlertStore(makeAlertDb().d1);
    await store.insert("d-3", "{}", 1_000);
    const explosiva = {
      async send(): Promise<void> {
        throw new Error("queue down");
      },
    };
    await expect(
      runAlertCron({ store, queue: explosiva, now: () => 10_000 }),
    ).resolves.toMatchObject({ published: 0 });
    expect((await store.get("d-3"))?.state).toBe("pending"); // atraso, nunca perda
  });
});
