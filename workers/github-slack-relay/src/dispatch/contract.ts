// ADR-001 (docs/adr/ADR-001-slack-dispatch-outbox.md) — type contract for the
// outbox dispatcher. This file carries NO logic: it pins the state machine,
// the total-classifier outcome space and the store interface that the
// architectural REDs (test/dispatch-*.test.ts, R1-R20) are written against.

export type DispatchMode = "off" | "shadow" | "primary";

// §10 hybrid amendment (operator decision 14/08/2026, issue #192 comment
// 5299997975): the official "GitHub for Slack" app owns #github-activity, so
// the dispatcher carries the single destination "alerts".
export type DispatchDestination = "alerts";

// ADR §6.2/§6.4 — `retry_scheduled` deliberately does not exist (I1).
export type DispatchState =
  | "queued"
  | "sending"
  | "ambiguous"
  | "manual"
  | "delivered"
  | "dead_letter"
  | "closed_manual";

export interface DispatchOutboxRow {
  deliveryId: string;
  destination: DispatchDestination;
  shadow: boolean;
  payloadJson: string;
  state: DispatchState;
  attemptCount: number;
  resolverAttempts: number;
  lastSendStartMs: number | null;
  leaseUntilMs: number | null;
  nextAttemptMs: number | null;
  verifyAfterMs: number | null;
  verifyScansRemaining: number;
  slackChannelId: string | null;
  slackMessageTs: string | null;
  lastError: string | null;
  createdMs: number;
  updatedMs: number;
}

export interface DispatchAuditEntry {
  seq: number;
  deliveryId: string;
  fromState: string;
  toState: string;
  evidenceJson: string;
  actor: "ingress" | "consumer" | "resolver" | "cron" | "operator";
  atMs: number;
}

// ADR §6.2 — the TOTAL outcome classifier's codomain. HTTP status is
// classified first; ok-body rules apply only to HTTP 200.
export type PostMessageOutcome =
  | {
      readonly kind: "delivered";
      readonly ts: string;
      readonly channel: string;
    }
  | {
      readonly kind: "manual";
      readonly errorCode: string;
    }
  | {
      readonly kind: "ambiguous";
      readonly reason: string;
      readonly retryAfterMs: number | null;
    };

// ADR §6.2 — deterministic config/payload failures; automatic retry cannot
// succeed and no Slack effect was applied.
export const MANUAL_ERROR_CODES: ReadonlySet<string> = new Set([
  "invalid_auth",
  "token_revoked",
  "account_inactive",
  "missing_scope",
  "channel_not_found",
  "not_in_channel",
  "is_archived",
  "restricted_action",
  "msg_too_long",
  "no_text",
  "invalid_blocks",
  "invalid_metadata_format",
  "invalid_metadata_schema",
  "metadata_too_large",
  "metadata_must_be_sent_from_app",
  "message_limit_exceeded",
]);

// ADR §6.1/§6.3.1 timing constants (ms).
export const DISPATCH_CLIENT_TIMEOUT_MS = 30_000;
export const DISPATCH_LEASE_MS = 90_000;
export const RESOLVER_COOLING_OFF_FLOOR_MS =
  DISPATCH_CLIENT_TIMEOUT_MS + DISPATCH_LEASE_MS + 60_000;
export const RESOLVER_MAX_ATTEMPTS = 6;
// ADR §6.3.1, verbatim: "after 6 attempts within 1 h → `manual`". Copilot
// suppressed comment (F5): the escalation threshold is windowed — a lifetime
// cumulative counter would park a row in `manual` after six inconclusive
// scans spread across days.
export const RESOLVER_ATTEMPT_WINDOW_MS = 60 * 60 * 1_000;
// ADR §10 H10 — regression caught by an adversarial panel before the push:
// the windowed threshold above is UNREACHABLE under resolver budget
// contention. `ambiguousRowsDue` orders by `updated_ms ASC` and every attempt
// bumps `updated_ms`, so N due ambiguous rows round-robin strictly; with the
// `*/5` cron (12 passes/h) and RESOLVER_ROWS_PER_RUN = 2 minus the
// floor(2/2) = 1 slot reserved for verification rows, N = 6 (or N = 3 while a
// verification row is due) stretches the per-row cadence to 15 min — at most
// 5 markers in any rolling hour, so the count saturates one short of 6 and no
// row ever escalates. The window stays the intended, fast trigger; this
// lifetime ceiling (4 x RESOLVER_MAX_ATTEMPTS = 24) exists ONLY so a
// contention-starved row still reaches the `manual` park documented in §6.5
// rows 15-16 — `manual` being the only gateway to the operator menu.
export const RESOLVER_LIFETIME_ATTEMPT_CEILING = 4 * RESOLVER_MAX_ATTEMPTS;
export const RESOLVER_ROWS_PER_RUN = 2;
export const RESOLVER_PAGES_PER_ROW = 3;
export const RESOLVER_SCAN_LOOKBACK_SECONDS = 300;
export const VERIFY_FIRST_SCAN_DELAY_MS = 15 * 60 * 1_000;
export const VERIFY_SECOND_SCAN_DELAY_MS = 24 * 60 * 60 * 1_000;
// Copilot finding (resolver starvation): an inconclusive verification scan
// leaves verify_after_ms in the past, so the row stays permanently due and
// consumes the whole per-run budget forever. The deferral doubles from the
// §6.3.3 first-scan delay and is capped at 24 h; it NEVER decrements
// verify_scans_remaining (§6.3.3 invariant).
export const VERIFY_DEFERRAL_BACKOFF_BASE_MS = VERIFY_FIRST_SCAN_DELAY_MS;
export const VERIFY_DEFERRAL_BACKOFF_CAP_MS = 24 * 60 * 60 * 1_000;
export const STALE_QUEUED_REQUEUE_AFTER_MS = 5 * 60 * 1_000;
// ADR §4 item 4 (~1 msg/sec/channel with burst). Copilot suppressed comment
// (F7): max_concurrency 1 serializes consumers but still permits consecutive
// posts faster than that limit, so the dispatcher paces every real send
// through a durable per-destination reservation. The value is the legacy
// path's constant verbatim (MINIMUM_SLACK_INTERVAL_MS, src/index.ts).
export const DISPATCH_MINIMUM_SEND_INTERVAL_MS = 6_100;

// ADR §6.1 — metadata event type used for the resolver's match rule.
export const DISPATCH_METADATA_EVENT_TYPE = "github_relay_delivery";

// ADR §6.3.1 — resolver verdicts over one ambiguous row.
export type ResolverVerdict =
  | { readonly kind: "found"; readonly ts: string; readonly channel: string }
  | {
      readonly kind: "found_many";
      readonly canonicalTs: string;
      readonly channel: string;
      readonly duplicateTs: readonly string[];
    }
  | { readonly kind: "proven_absent"; readonly evidenceJson: string }
  | { readonly kind: "inconclusive"; readonly reason: string };

// Store interface implemented over D1 (and mirrored by the test fake).
export interface DispatchStore {
  // Presence fence (ADR §6.8, R11): counts rows for the GUID in the LEGACY
  // deliveries table (any state). Read-only, runs forever.
  legacyRowExists(deliveryId: string): Promise<boolean>;
  // Outbox-side lookup used by the legacy ingress fence and queue branching.
  get(deliveryId: string): Promise<DispatchOutboxRow | null>;
  // Ingress insert; ON CONFLICT DO NOTHING semantics -> false on duplicate.
  insert(row: {
    deliveryId: string;
    destination: DispatchDestination;
    shadow: boolean;
    payloadJson: string;
    now: number;
  }): Promise<boolean>;
  // CAS queued -> sending, recording last_send_start_ms and the lease.
  // 0 rows changed => null (duplicate queue delivery acks — R1).
  claim(deliveryId: string, now: number): Promise<DispatchOutboxRow | null>;
  // Consumer outcome commits (one batch() with an audit row each — ADR §6.1).
  markDelivered(
    deliveryId: string,
    now: number,
    ts: string,
    channel: string,
    actor: "consumer" | "resolver" | "operator",
    expectedStates: readonly DispatchState[],
    evidenceJson: string,
  ): Promise<boolean>;
  markManual(
    deliveryId: string,
    now: number,
    errorCodeOrEvidence: string,
    actor: "consumer" | "resolver",
    expectedStates: readonly DispatchState[],
  ): Promise<boolean>;
  markAmbiguous(
    deliveryId: string,
    now: number,
    reason: string,
    retryAfterMs: number | null,
    actor: "consumer" | "resolver",
    expectedStates: readonly DispatchState[],
  ): Promise<boolean>;
  markDeadLetter(deliveryId: string, now: number, reason: string): Promise<boolean>;
  // Late-proof rule (ADR §6.3, R2): unconditional audit append, then
  // CAS ambiguous->delivered first, manual->delivered fallback.
  // Copilot suppressed comment (F6): the resolver calls this too (its FOUND
  // CAS lost the race), so the actor of the proof audit AND of the delivered
  // transition is the caller's — `resolver` from the resolver, `consumer`
  // from the queue consumer.
  recordLateProof(
    deliveryId: string,
    now: number,
    ts: string,
    channel: string,
    actor: "consumer" | "resolver",
  ): Promise<"ambiguous_cas" | "manual_cas" | "audit_only">;
  // Copilot suppressed comment (F7) / ADR §4 item 4: durable per-destination
  // pacing reservation. Returns 0 when the slot is reserved for this caller,
  // otherwise the remaining wait in ms (the consumer retries the queue
  // message with it — it never sends and never acks).
  reserveSendSlot(
    destination: DispatchDestination,
    now: number,
    intervalMs: number,
  ): Promise<number>;
  // Resolver bookkeeping.
  normalizeExpiredLeases(now: number): Promise<number>;
  ambiguousRowsDue(now: number, limit: number): Promise<DispatchOutboxRow[]>;
  verificationRowsDue(now: number, limit: number): Promise<DispatchOutboxRow[]>;
  incrementResolverAttempts(deliveryId: string, now: number): Promise<number>;
  // Copilot suppressed comment (F5) / ADR §6.3.1 ("after 6 attempts within
  // 1 h"): windowed count of inconclusive resolver attempts, derived from the
  // dispatch_audit markers — no schema column.
  inconclusiveAttemptsSince(
    deliveryId: string,
    sinceMs: number,
  ): Promise<number>;
  // ADR §6.3.3/R19 repair-from-anywhere: the operator sweep leaves a
  // delivered row with at least one scan armed and due immediately, so the
  // next resolver pass re-runs the §6.3.3 match rule. verify_after_ms is
  // stamped here because verificationRowsDue selects on it — arming the
  // counter alone would never make the row due. The counter is a CLAMPED
  // increment (migration 0010 CHECKs it BETWEEN 0 AND 2, and an
  // operator-resent row sits at 2), paired with a predicate that rejects the
  // no-change case, so the sweep always moves the counter or the due time and
  // an in-flight verification pass can never satisfy both halves of the F1
  // completion CAS against the swept row. Returns false — 409, never 503 —
  // for the one genuine no-op: already at 2 and already due at this instant.
  operatorSweepVerification(
    deliveryId: string,
    now: number,
    evidenceJson: string,
  ): Promise<boolean>;
  // CAS on the caller's snapshot of verify_scans_remaining, so overlapping
  // resolver passes cannot double-decrement (panel finding V13). Copilot
  // finding F1: the counter alone is not a monotonic guard — a rearm
  // (flagDuplicateRepairPending) can restore the very value the stale caller
  // observed, and its completion would then consume the rearmed scan. The
  // caller's observed verify_after_ms joins the CAS: every rearm moves it
  // strictly forward (a due row has verify_after_ms <= now < the rearmed
  // value), so a stale completion can no longer match.
  completeVerificationScan(
    deliveryId: string,
    now: number,
    nextVerifyAfterMs: number | null,
    expectedRemaining: number,
    expectedVerifyAfterMs: number | null,
  ): Promise<boolean>;
  // Copilot finding (resolver starvation): an inconclusive verification scan
  // reschedules the row instead of leaving verify_after_ms in the past. The
  // consecutive-deferral count is derived from the dispatch_audit markers
  // (no schema column), and the deferral never touches
  // verify_scans_remaining (§6.3.3).
  consecutiveVerificationDeferrals(deliveryId: string): Promise<number>;
  deferVerificationScan(
    deliveryId: string,
    now: number,
    nextVerifyAfterMs: number,
    evidenceJson: string,
  ): Promise<boolean>;
  updateCanonicalTs(
    deliveryId: string,
    now: number,
    ts: string,
    evidenceJson: string,
  ): Promise<boolean>;
  // Copilot finding F5 (ADR §6.3.2/R19): a detected duplicate whose deletion
  // failed re-arms verification (at least one scan, due at the §6.3.3
  // first-scan delay) and records the pending marker — one batch + audit.
  flagDuplicateRepairPending(
    deliveryId: string,
    now: number,
    evidenceJson: string,
  ): Promise<boolean>;
  // Operator menu (I1: the only resend path; marked possible-duplicate).
  operatorResend(deliveryId: string, now: number, evidenceJson: string): Promise<boolean>;
  operatorCloseManual(deliveryId: string, now: number, evidenceJson: string): Promise<boolean>;
  // Copilot finding F6 (operator command replay): the freshness window bounds
  // replay to five minutes but does not make a non-idempotent command
  // one-shot. Every operator transition bakes the SHA-256 of its request
  // signature into its audit evidence; this read answers "has this exact
  // signed command already been applied?". No schema column — the binding
  // lives for the retention of dispatch_audit (see the route's trade-off
  // note in src/index.ts).
  operatorCommandApplied(
    deliveryId: string,
    requestSignatureSha256: string,
  ): Promise<boolean>;
  // Cron: stale queued re-enqueue inputs (R13).
  staleQueuedRows(now: number, limit: number): Promise<DispatchOutboxRow[]>;
  // /status + observer (ADR §6.7) — read-only aggregates.
  statusCounters(now: number): Promise<DispatchStatusCounters>;
  appendAudit(entry: Omit<DispatchAuditEntry, "seq">): Promise<void>;
  auditEntries(deliveryId: string): Promise<DispatchAuditEntry[]>;
  repairedDuplicatesTotal(): Promise<number>;
  // ADR §6.7 "repaired_duplicates increased since the last observation":
  // read-only count of repair markers at or before a cutoff, so the
  // observe-only cron derives "previous" without any write path (R5).
  repairedDuplicatesBefore(cutoffMs: number): Promise<number>;
}

export interface DispatchStatusCounters {
  byStateAndDestination: Readonly<
    Record<DispatchDestination, Readonly<Record<DispatchState, number>>>
  >;
  oldestNonTerminalAgeMs: number | null;
  // Copilot finding F6 (ADR §6.7): the ambiguous_stale alarm fires ONLY on
  // an AMBIGUOUS row older than 30 min — an old manual/queued row must not
  // stand in for it. Additive field; oldestNonTerminalAgeMs stays for the
  // queued-backlog alarm and the drain view.
  oldestAmbiguousAgeMs: number | null;
  repairedDuplicates: number;
}

// ADR §6.7 — observe-only alarm predicate inputs. `queued` and
// `oldestNonTerminalAgeMs` feed the R20 backlog alarm ("rows accumulate in
// queued, alarmed"); optional so pre-existing callers stay valid.
export interface ObserverSnapshot {
  deadLetter: number;
  manual: number;
  oldestAmbiguousAgeMs: number | null;
  repairedDuplicates: number;
  queued?: number;
  oldestNonTerminalAgeMs?: number | null;
}
