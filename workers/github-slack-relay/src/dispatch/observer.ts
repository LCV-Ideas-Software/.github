// ADR-001 §6.7 — observe-only alarm predicate (R5). Pure by construction:
// plain snapshots in, stable alarm identifiers out; no store handle can
// enter, so a write path cannot exist.
import type { ObserverSnapshot } from "./contract";

const AMBIGUOUS_STALE_THRESHOLD_MS = 30 * 60 * 1_000;

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
  return alarms;
}
