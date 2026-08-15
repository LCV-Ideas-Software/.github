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
  // Audit finding B1 / ADR §10 H14: a delivered row whose verification stopped
  // re-arming after VERIFY_NO_PROGRESS_CEILING no-progress scans. It is the
  // exit the livelocked re-arm never had, so it must be alarmed — an
  // operator sweep (H11) restarts verification and clears this.
  if ((current.verificationAbandoned ?? 0) > 0) {
    alarms.push("verification_abandoned");
  }
  // Review finding F2 / ADR §10 H21: a chat.delete whose repair record never
  // landed. §6.3.2 requires every deletion to be audited AND alarmed, and the
  // deleted ts is unrecoverable from Slack, so the pre-recorded intent is the
  // only evidence left — it must reach the operator instead of sitting in the
  // journal. Cleared by the outcome marker of the same target ts, including a
  // later successful repair of a copy that survived.
  if ((current.unreconciledDeletionIntents ?? 0) > 0) {
    alarms.push("duplicate_deletion_unreconciled");
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
