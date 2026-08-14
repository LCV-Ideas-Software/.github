// ADR-001 §6.7 — observe-only alarm predicate (R5). Pure by construction:
// plain snapshots in, stable alarm identifiers out; no store handle can
// enter, so a write path cannot exist.
import type { ObserverSnapshot } from "./contract";

const AMBIGUOUS_STALE_THRESHOLD_MS = 30 * 60 * 1_000;
// §6.8/R20: "rows accumulate in `queued` (alarmed)" — a queued backlog that
// is not draining must become visible (panel V9). The age source is the
// oldest NON-TERMINAL row, so this alarms at least as early as a precise
// per-state age would (fail-safe direction).
const QUEUED_BACKLOG_THRESHOLD_MS = 30 * 60 * 1_000;

export function observerAlarms(
  current: ObserverSnapshot,
  previous: { repairedDuplicates: number } | null,
): string[] {
  const alarms: string[] = [];
  if (current.deadLetter > 0) {
    alarms.push("dead_letter_present");
  }
  if (current.manual > 0) {
    alarms.push("manual_present");
  }
  if (
    current.oldestAmbiguousAgeMs !== null &&
    current.oldestAmbiguousAgeMs > AMBIGUOUS_STALE_THRESHOLD_MS
  ) {
    alarms.push("ambiguous_stale");
  }
  if (
    previous !== null &&
    current.repairedDuplicates > previous.repairedDuplicates
  ) {
    alarms.push("repaired_duplicates_increased");
  }
  if (
    (current.queued ?? 0) > 0 &&
    current.oldestNonTerminalAgeMs !== undefined &&
    current.oldestNonTerminalAgeMs !== null &&
    current.oldestNonTerminalAgeMs > QUEUED_BACKLOG_THRESHOLD_MS
  ) {
    alarms.push("queued_backlog_stale");
  }
  return alarms;
}
