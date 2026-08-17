// O único agendador (ADR-002 §4). O carimbo acontece NO enfileiramento:
// a linha deixa de ser devida no instante em que é agendada, e publicações
// repetidas morrem no changes=0 do CAS — dois passes, um enfileiramento.
import { CRON_SELECT_LIMIT, ROW_RETENTION_MS, recuoMs } from "./contract";
import type { AlertStore } from "./store";

type Deps = {
  store: AlertStore;
  queue: { send(m: unknown): Promise<void> };
  now: () => number;
};

export async function runAlertCron(
  deps: Deps,
): Promise<{ published: number; purged: number }> {
  const agora = deps.now();
  let published = 0;

  const devidas = await deps.store.dueRows(agora, CRON_SELECT_LIMIT);
  for (const row of devidas) {
    const proximaTentativa = row.attempts + 1;
    const carimbou = await deps.store.stampDue(
      row.deliveryId,
      agora,
      agora + recuoMs(proximaTentativa),
    );
    if (!carimbou) continue; // outro passe venceu, ou o consumidor marcou sent
    try {
      await deps.queue.send({ v: 2, delivery_id: row.deliveryId });
      published++;
    } catch {
      // Publicação falhou DEPOIS do carimbo: direção do erro é atraso
      // (o próximo ciclo recarimba após o recuo), nunca perda nem cópia.
    }
  }

  const purged = await deps.store.deleteSentOlderThan(agora - ROW_RETENTION_MS);
  return { published, purged };
}
