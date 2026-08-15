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
export const RESOLVER_ROWS_PER_RUN = 2;
export const RESOLVER_PAGES_PER_ROW = 3;
export const RESOLVER_SCAN_LOOKBACK_SECONDS = 300;
export const VERIFY_FIRST_SCAN_DELAY_MS = 15 * 60 * 1_000;
export const VERIFY_SECOND_SCAN_DELAY_MS = 24 * 60 * 60 * 1_000;
export const STALE_QUEUED_REQUEUE_AFTER_MS = 5 * 60 * 1_000;

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
  recordLateProof(
    deliveryId: string,
    now: number,
    ts: string,
    channel: string,
  ): Promise<"ambiguous_cas" | "manual_cas" | "audit_only">;
  // Resolver bookkeeping.
  normalizeExpiredLeases(now: number): Promise<number>;
  ambiguousRowsDue(now: number, limit: number): Promise<DispatchOutboxRow[]>;
  verificationRowsDue(now: number, limit: number): Promise<DispatchOutboxRow[]>;
  incrementResolverAttempts(deliveryId: string, now: number): Promise<number>;
  armVerification(deliveryId: string, now: number): Promise<boolean>;
  // CAS on the caller's snapshot of verify_scans_remaining, so overlapping
  // resolver passes cannot double-decrement (panel finding V13).
  completeVerificationScan(
    deliveryId: string,
    now: number,
    nextVerifyAfterMs: number | null,
    expectedRemaining: number,
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
