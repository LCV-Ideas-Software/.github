// O /status do ADR-002 §4: contagem por estado e a idade da pendente mais
// velha — os dois números que o vigia lê. Protegido por segredo
// compartilhado (decisão 9), comparado por digest para não vazar tamanho
// nem conteúdo por tempo de resposta.
import type { AlertStore } from "./store";

export async function verifyStatusSecret(
  request: Request,
  expectedSecret: string,
): Promise<boolean> {
  const given = request.headers.get("x-alerts-status-secret") ?? "";
  if (given === "" || expectedSecret === "") return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expectedSecret)),
  ]);
  const va = new Uint8Array(a);
  const vb = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= (va[i] ?? 0) ^ (vb[i] ?? 0);
  return diff === 0;
}

export async function statusBody(
  store: AlertStore,
  now: number,
): Promise<{
  pending: number;
  sent: number;
  oldest_pending_age_ms: number | null;
}> {
  // Retrato ÚNICO (achado da revisão): contagens e idade vêm da MESMA
  // instrução SQL, então o vigia nunca vê idade velha com pending 0, nem
  // pendente sem idade.
  const s = await store.statusSnapshot();
  return {
    pending: s.pending,
    sent: s.sent,
    // A idade ancora em created_ms, que nenhum caminho de recuperação
    // escreve (ADR-002 §6, instância B).
    oldest_pending_age_ms:
      s.oldestPendingCreatedMs === null ? null : now - s.oldestPendingCreatedMs,
  };
}
