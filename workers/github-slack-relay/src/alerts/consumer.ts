// O consumidor do ADR-002 §8, inteiro: ok:true marca enviado; qualquer
// outra coisa deixa a linha pendente para o cron. O corpo INTEIRO vive num
// try — retorno normal é ack implícito da plataforma, e exceção nunca
// escapa para a fila (a fila não é agendador; o cron é).
import { ALERTS_CHANNEL_ID } from "./contract";
import { renderAlertText } from "./render";
import type { AlertStore } from "./store";

type Deps = {
  store: AlertStore;
  botToken: string;
  fetch: typeof fetch;
  now: () => number;
};

export async function processAlertMessage(
  raw: unknown,
  deps: Deps,
): Promise<void> {
  try {
    const msg = raw as { v?: unknown; delivery_id?: unknown };
    if (msg?.v !== 2 || typeof msg.delivery_id !== "string") return;

    // Reler a linha é a guarda contra a reentrega pós-crash (ADR-002 §4):
    // se o desfecho já foi gravado, a duplicata da plataforma morre aqui.
    const row = await deps.store.get(msg.delivery_id);
    if (row === null || row.state === "sent") return;

    // Montagem NO ENVIO, a partir do payload normalizado da linha.
    const texto = renderAlertText(
      JSON.parse(row.payloadJson) as Record<string, unknown>,
    );

    const resp = await deps.fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deps.botToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel: ALERTS_CHANNEL_ID, text: texto }),
      signal: AbortSignal.timeout(10_000),
    });

    let corpo: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = await resp.json();
      if (typeof parsed === "object" && parsed !== null) {
        corpo = parsed as Record<string, unknown>;
      }
    } catch {
      // Corpo ilegível = não-sucesso; a linha fica pendente.
    }

    if (corpo?.ok === true) {
      // Contrato citado no ADR §8: "will always contain a top-level boolean
      // property `ok` that indicates success or failure". ts é recibo.
      const ts = typeof corpo.ts === "string" ? corpo.ts : null;
      await deps.store.markSent(row.deliveryId, ts, deps.now());
      return;
    }
    const codigo =
      typeof corpo?.error === "string" ? corpo.error : `http_${resp.status}`;
    await deps.store.recordFailure(row.deliveryId, codigo);
  } catch (error) {
    // Nunca escapa para a fila. Registrar é melhor-esforço; se até o
    // registro falhar, a linha continua pendente e o cron recarimba.
    try {
      const msg = raw as { delivery_id?: unknown };
      if (typeof msg?.delivery_id === "string") {
        await deps.store.recordFailure(
          msg.delivery_id,
          `exception:${String(error).slice(0, 200)}`,
        );
      }
    } catch {
      // Direção do erro: atraso de um recuo, nunca perda.
    }
  }
}
