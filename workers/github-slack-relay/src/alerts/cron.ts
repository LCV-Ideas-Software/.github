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
    // Relógio POR carimbo e versão observada no CAS (achado da rodada 15
    // da revisão): num passe lento que atravessa o tique seguinte, o
    // relógio do início do passe já venceu o recuo — um prazo calculado
    // dele nasceria vencido, e o retrato velho de attempts comprimia a
    // curva. O pino da versão mata o carimbo de quem leu retrato morto.
    const agoraDoCarimbo = deps.now();
    const proximaTentativa = row.attempts + 1;
    const carimbou = await deps.store.stampDue(
      row.deliveryId,
      agoraDoCarimbo,
      agoraDoCarimbo + recuoMs(proximaTentativa),
      row.attempts,
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
