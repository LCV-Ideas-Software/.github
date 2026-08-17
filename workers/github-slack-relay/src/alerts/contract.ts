// ADR-002 §5, decisão do operador: um canal só.
export const ALERTS_CHANNEL_ID = "C0BMUK793NV";

// Decisão 10: a linha guardada É a janela de deduplicação — 30 dias, e o
// apagamento só alcança linhas `sent` (a promessa proíbe apagar pendente).
export const ROW_RETENTION_MS = 2_592_000_000;

// Limite por passe do cron. A ordenação por next_due_ms garante rotação:
// o carimbo empurra a linha para o fim, então cabeça travada não existe.
export const CRON_SELECT_LIMIT = 100;

// Vigia: falha transitória se resolve em ~20 min pela curva; 60 min dá 3×
// de margem antes de alarmar sobre recuperação normal em curso.
export const WATCHDOG_MAX_PENDING_AGE_MS = 3_600_000;

// A mensagem da fila carrega SÓ a identidade. A linha é a verdade; payload
// embutido seria cópia que envelhece. v:2 discrimina do QueueJob legado
// por declaração, não por inferência de forma.
export type AlertQueueMessage = { v: 2; delivery_id: string };

const RECUO_BASE_MS = 5 * 60_000;
const RECUO_TETO_MS = 24 * 3_600_000;

// ADR-002 §4: recuo(0)=0 (linha nova é devida no próximo passe); depois
// 5min × 3^(n-1), saturando em 24h — que é POLÍTICA da aplicação
// (≤1 cópia/dia em regime), não teto de plataforma.
export function recuoMs(attempts: number): number {
  if (attempts <= 0) return 0;
  return Math.min(RECUO_TETO_MS, RECUO_BASE_MS * 3 ** (attempts - 1));
}
