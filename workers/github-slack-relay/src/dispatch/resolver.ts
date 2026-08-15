// ADR-001 §6.3.1-§6.3.3 — resolver: history scan with strict exhaustion
// semantics, verdict application over ambiguous rows, duplicate repair
// (found_many), and post-resend verification scans over delivered rows.
// Verdicts are EVIDENCE, never triggers: the resolver never resends (I1).
import {
  DISPATCH_CLIENT_TIMEOUT_MS,
  DISPATCH_METADATA_EVENT_TYPE,
  RESOLVER_ATTEMPT_WINDOW_MS,
  RESOLVER_COOLING_OFF_FLOOR_MS,
  RESOLVER_LIFETIME_ATTEMPT_CEILING,
  RESOLVER_MAX_ATTEMPTS,
  RESOLVER_PAGES_PER_ROW,
  RESOLVER_ROWS_PER_RUN,
  RESOLVER_SCAN_LOOKBACK_SECONDS,
  VERIFY_DEFERRAL_BACKOFF_BASE_MS,
  VERIFY_DEFERRAL_BACKOFF_CAP_MS,
  VERIFY_FIRST_SCAN_DELAY_MS,
  VERIFY_NO_PROGRESS_CEILING,
  VERIFY_SECOND_SCAN_DELAY_MS,
  type DispatchDestination,
  type DispatchOutboxRow,
  type DispatchStore,
  type ResolverVerdict,
} from "./contract";
// Copilot suppressed comment (F1): the resolver validates a matched history
// entry's ts with the SAME canonical pattern the §6.2 classifier applies to a
// chat.postMessage body — one shape, one source (migration 0010's CHECK).
// Review finding N3 (ADR §10 H24): the resolver's own copy of the Retry-After
// conversion carried the same pre-multiplication overflow, so it reads the
// header through the classifier's BOUNDED converter — same rule, one source.
import { CANONICAL_TS_PATTERN, retryAfterMsFrom } from "./classifier";

const HISTORY_URL = "https://slack.com/api/conversations.history";
const DELETE_URL = "https://slack.com/api/chat.delete";
// §6.3.1: page size probed at F0 (history read-back green — §9.A4).
const HISTORY_PAGE_LIMIT = 200;

export interface ResolverDeps {
  store: DispatchStore;
  fetch: typeof fetch;
  now: () => number;
  botToken: string;
  channelFor: (destination: DispatchDestination) => string;
  // R9/§9.A4: pointer to the recorded retention verification; proven-absent
  // is unreachable while this is null.
  retentionVerifiedEvidence: string | null;
}

export interface ResolverPassResult {
  examined: number;
  // Audit finding B4: rows whose examination THREW. The pass keeps going and
  // reports them instead of aborting; the cron logs the count.
  failed: number;
}

type ScanResult =
  | {
      readonly kind: "scanned";
      readonly matches: readonly string[];
      readonly exhausted: boolean;
      readonly pages: number;
    }
  | {
      readonly kind: "failed";
      readonly reason: string;
      readonly retryAfterMs: number | null;
    };

function parseJsonObject(bodyText: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Classified as a failed scan by the caller.
  }
  return null;
}

// §6.3.1 pagination: response_metadata.next_cursor; absent metadata counts
// as an empty cursor.
function nextCursorOf(body: Record<string, unknown>): string {
  const metadata = body["response_metadata"];
  if (typeof metadata !== "object" || metadata === null) return "";
  const cursor = (metadata as Record<string, unknown>)["next_cursor"];
  return typeof cursor === "string" ? cursor : "";
}

// §6.3.1 match rule (R14): top-level messages only (R15), exact event_type
// and event_payload.delivery_id.
// Audit finding B2 (BLOCKER): "any thread_ts disqualifies" is NOT what
// top-level means. Slack documents, verbatim: "One quirk of threaded messages
// is that a parent message object will retain a `thread_ts` value, even if all
// its replies have been deleted." A parent carries `thread_ts === ts`, so the
// moment a human replies in-thread to one of our alerts — the ordinary way
// people use an alert channel — our own message became invisible to the
// resolver: a verification scan then saw only the duplicate, deleted nothing,
// and still recorded the canonical ts, so D1 looked clean while the duplicate
// survived; on an ambiguous row the same filter could manufacture a false
// proven_absent. A message is a thread REPLY only when it carries a thread_ts
// that DIFFERS from its own ts; parents and unthreaded messages both match.
// Copilot suppressed comment (F1, SEVERE): a MATCHING entry whose `ts` is
// missing, non-string or malformed used to be dropped silently, so an
// exhausted scan could report absence for a delivery whose message is right
// there in the history — and a non-empty malformed ts that DID pass would
// later violate migration 0010's slack_message_ts CHECK and abort the whole
// resolver pass. Such an entry now makes the scan INCONCLUSIVE (returns
// true), validated with CANONICAL_TS_PATTERN — the exact pattern the §6.2
// classifier applies to a chat.postMessage body, so the resolver and the
// consumer accept the same canonical shape. A NON-matching entry is still
// skipped silently: the guard is scoped to entries whose metadata identifies
// THIS delivery.
function collectMatches(
  body: Record<string, unknown>,
  deliveryId: string,
  matches: string[],
): boolean {
  const messages = body["messages"];
  if (!Array.isArray(messages)) return false;
  let malformedMatch = false;
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const candidate = message as Record<string, unknown>;
    // B2: a reply, never a parent (thread_ts === ts) or an unthreaded message.
    const threadTs = candidate["thread_ts"];
    if (threadTs !== undefined && threadTs !== candidate["ts"]) continue;
    const metadata = candidate["metadata"];
    if (typeof metadata !== "object" || metadata === null) continue;
    const meta = metadata as Record<string, unknown>;
    if (meta["event_type"] !== DISPATCH_METADATA_EVENT_TYPE) continue;
    const payload = meta["event_payload"];
    if (typeof payload !== "object" || payload === null) continue;
    if ((payload as Record<string, unknown>)["delivery_id"] !== deliveryId) {
      continue;
    }
    const ts = candidate["ts"];
    if (typeof ts === "string" && CANONICAL_TS_PATTERN.test(ts)) {
      matches.push(ts);
      continue;
    }
    malformedMatch = true;
  }
  return malformedMatch;
}

// slack ts ("seconds.fraction") ordered without float arithmetic — the
// stored ts stays an opaque identifier (§6.4).
function compareSlackTs(a: string, b: string): number {
  const [aSeconds = "", aFraction = ""] = a.split(".");
  const [bSeconds = "", bFraction = ""] = b.split(".");
  if (aSeconds.length !== bSeconds.length) {
    return aSeconds.length - bSeconds.length;
  }
  if (aSeconds !== bSeconds) return aSeconds < bSeconds ? -1 : 1;
  if (aFraction !== bFraction) return aFraction < bFraction ? -1 : 1;
  return 0;
}

// Review finding F1 (§6.3.2 "the EARLIEST ts is canonical"): the earlier of the
// ts the row already RECORDS and the earliest ts a scan observed. Compared with
// compareSlackTs — Slack ts values are decimal strings and lose precision as JS
// numbers, so they are never converted (§6.4: an opaque identifier).
function earlierTs(storedTs: string | null, observedTs: string): string {
  if (storedTs === null) return observedTs;
  return compareSlackTs(storedTs, observedTs) <= 0 ? storedTs : observedTs;
}

async function scanHistory(
  row: DispatchOutboxRow,
  deps: ResolverDeps,
): Promise<ScanResult> {
  const channel = deps.channelFor(row.destination);
  // §6.3.1: oldest = created seconds − lookback; no `latest` bound;
  // ms→seconds conversion at this boundary only.
  const oldest = (
    row.createdMs / 1000 -
    RESOLVER_SCAN_LOOKBACK_SECONDS
  ).toFixed(6);
  const matches: string[] = [];
  let cursor = "";
  let pages = 0;
  while (pages < RESOLVER_PAGES_PER_ROW) {
    const url = new URL(HISTORY_URL);
    url.searchParams.set("channel", channel);
    url.searchParams.set("oldest", oldest);
    url.searchParams.set("inclusive", "true");
    url.searchParams.set("include_all_metadata", "true");
    url.searchParams.set("limit", String(HISTORY_PAGE_LIMIT));
    if (cursor !== "") url.searchParams.set("cursor", cursor);
    let response: Response;
    let bodyText: string;
    try {
      response = await deps.fetch(url.toString(), {
        method: "GET",
        headers: { Authorization: `Bearer ${deps.botToken}` },
        // Copilot finding F2: without an abort signal a stalled Slack
        // response holds the scheduled invocation until the platform kills
        // it, and one resolver row starves the whole pass. Same 30 s hard
        // client timeout the consumer applies (§6.1); the abort lands in the
        // catch below as an INCONCLUSIVE scan — never proven-absent.
        signal: AbortSignal.timeout(DISPATCH_CLIENT_TIMEOUT_MS),
      });
      bodyText = await response.text();
    } catch (error) {
      return {
        kind: "failed",
        reason:
          error instanceof Error
            ? `history_fetch_failed_${error.name}`.slice(0, 128)
            : "history_fetch_failed",
        retryAfterMs: null,
      };
    }
    pages += 1;
    if (response.status === 429) {
      // R4: the Retry-After defers the row via next_attempt_ms.
      return {
        kind: "failed",
        reason: "history_http_429",
        retryAfterMs: retryAfterMsFrom(response.headers),
      };
    }
    if (response.status !== 200) {
      return {
        kind: "failed",
        reason: `history_http_${response.status}`,
        retryAfterMs: null,
      };
    }
    const body = parseJsonObject(bodyText);
    if (body === null || body["ok"] !== true) {
      const errorCode = body?.["error"];
      return {
        kind: "failed",
        reason: `history_error_${
          typeof errorCode === "string" ? errorCode : "unparseable_body"
        }`,
        retryAfterMs: null,
      };
    }
    // Copilot finding F7 (SEVERE): an `ok:true` body is not yet a valid page.
    // With no `messages` array collectMatches sees zero matches, and a
    // missing or non-boolean `has_more` reads as false through `=== true`, so
    // a malformed success body could combine with an empty cursor into
    // EXHAUSTION and manufacture a proven-absent verdict — the one verdict
    // that asserts the message was never posted. §6.3.1 rules an absent
    // `response_metadata` an empty cursor but says nothing about `has_more`,
    // so a missing or non-boolean `has_more` is INCONCLUSIVE, never
    // exhaustion. Matches seen on earlier pages are discarded with the scan:
    // retention is "never delete" (§9.A4), so a later scan re-finds them and
    // the row stays `ambiguous` — never parked by absence on a page we could
    // not read.
    if (
      !Array.isArray(body["messages"]) ||
      typeof body["has_more"] !== "boolean"
    ) {
      return {
        kind: "failed",
        reason: "history_malformed_page",
        retryAfterMs: null,
      };
    }
    if (collectMatches(body, row.deliveryId, matches)) {
      // Copilot suppressed comment (F1): a matching entry without a canonical
      // timestamp is a MALFORMED scan, never absence. The whole scan is
      // discarded — exactly as history_malformed_page above — so this pass
      // can neither park the row by proven-absence nor persist the malformed
      // ts; retention is "never delete" (§9.A4), so a later scan re-finds the
      // matches collected before this page.
      return {
        kind: "failed",
        reason: "history_malformed_match",
        retryAfterMs: null,
      };
    }
    const nextCursor = nextCursorOf(body);
    const hasMore = body["has_more"] === true;
    if (nextCursor === "" && !hasMore) {
      // §6.3.1: exhaustion := empty cursor AND has_more false.
      return { kind: "scanned", matches, exhausted: true, pages };
    }
    if (nextCursor === "") {
      // Contradictory (empty cursor AND has_more true): INCONCLUSIVE,
      // never exhaustion.
      return { kind: "scanned", matches, exhausted: false, pages };
    }
    cursor = nextCursor;
  }
  // Page budget spent with a live cursor: a partial scan is never absence.
  return { kind: "scanned", matches, exhausted: false, pages };
}

// Copilot finding (resolver starvation): an inconclusive verification scan
// (history error/partial) or a scan with no match must push verify_after_ms
// forward — otherwise the row stays due forever, is re-selected every cron
// and starves the ambiguous backlog. Bounded backoff: the §6.3.3 first-scan
// delay doubled per CONSECUTIVE no-progress scan, capped at 24 h, derived from
// the dispatch_audit markers. §6.3.3 invariant preserved:
// verify_scans_remaining is never decremented by a failed scan.
// Audit finding B1 / ADR §10 H14: the SAME backoff now also governs the
// duplicate-repair re-arm (which was flat 15 min, for ever), both kinds share
// ONE streak, and the streak has a ceiling.
function noProgressDelayMs(
  priorNoProgress: number,
  retryAfterMs: number | null,
): number {
  const backoffMs = Math.min(
    VERIFY_DEFERRAL_BACKOFF_BASE_MS * 2 ** priorNoProgress,
    VERIFY_DEFERRAL_BACKOFF_CAP_MS,
  );
  // Copilot finding F3 / ADR R4 ("recorded Retry-After honored by the
  // resolver's scan scheduling"): a verification scan rejected with 429 +
  // Retry-After was deferred by the generic backoff and the header was
  // discarded, so the next scan could hit Slack before the advertised wait.
  // The deferral takes the LARGER of the two — the backoff stays bounded by
  // its cap, the header is honored even past it.
  return Math.max(backoffMs, retryAfterMs ?? 0);
}

// Review finding F1 (ADR §10 H20): the verification snapshot a no-progress
// write is CASed against — the observation whose staleness would otherwise let
// this pass overwrite a due time armed after it (an operator sweep, H11).
interface VerificationObservation {
  readonly verifyAfterMs: number | null;
  readonly verifyScansRemaining: number;
}

function observedFrom(row: DispatchOutboxRow): VerificationObservation {
  return {
    verifyAfterMs: row.verifyAfterMs,
    verifyScansRemaining: row.verifyScansRemaining,
  };
}

// F1 / H20: which observation the re-arm CASes against depends on WHO last
// wrote the due time. On the verification path the pass-start row IS the
// observation, and it must stay the pass-start one: re-reading here would
// adopt a sweep that landed during the scan and then overwrite it, which is
// precisely the defect. On the ambiguous path this pass's OWN markDelivered /
// recordLateProof legitimately stamped verify_after_ms (§6.3.3), so the
// pass-start value is stale by construction, not by race, and the observation
// is re-read after that write. Residual, recorded rather than hidden: a sweep
// landing between that write and this re-read is still overwritten — closing it
// would require markDelivered to return the stamped due time. The loss is
// bounded to the sweep's due-now scan; R19 keeps the duplicate repairable by
// any later scan, and the re-armed scan this call writes is itself one.
async function observationForArm(
  row: DispatchOutboxRow,
  deps: ResolverDeps,
): Promise<VerificationObservation | null> {
  if (row.state === "delivered") return observedFrom(row);
  const fresh = await deps.store.get(row.deliveryId);
  return fresh === null ? null : observedFrom(fresh);
}

// B1 / H14: the exit. The row stays `delivered` with its counter intact, its
// due time is cleared (so no pass selects it again), the marker is
// distinguishable from every re-arm, and statusCounters turns the resulting
// shape into the `verification_abandoned` observer alarm. An operator sweep
// (H11) re-arms it and restarts the streak.
async function abandonVerification(
  row: DispatchOutboxRow,
  deps: ResolverDeps,
  now: number,
  reason: string,
  observed: VerificationObservation,
): Promise<void> {
  await deps.store.abandonVerification(
    row.deliveryId,
    now,
    // B7 / F1: the snapshot the caller decided on — the same one its sibling
    // re-arm is CASed against, so both paths refuse a post-snapshot sweep.
    observed.verifyAfterMs,
    JSON.stringify({
      verification_abandoned: true,
      reason,
      consecutive_no_progress: VERIFY_NO_PROGRESS_CEILING,
      verify_scans_remaining: observed.verifyScansRemaining,
    }),
  );
}

async function deferVerification(
  row: DispatchOutboxRow,
  deps: ResolverDeps,
  now: number,
  reason: string,
  retryAfterMs: number | null,
): Promise<void> {
  if (row.state !== "delivered" || row.verifyScansRemaining <= 0) return;
  const priorNoProgress = await deps.store.consecutiveNoProgressScans(
    row.deliveryId,
  );
  if (priorNoProgress >= VERIFY_NO_PROGRESS_CEILING) {
    // The row is `delivered` here (guarded above), so the pass-start snapshot
    // is the observation — no other writer of this pass touched the row.
    await abandonVerification(row, deps, now, reason, observedFrom(row));
    return;
  }
  const nextVerifyAfterMs =
    now + noProgressDelayMs(priorNoProgress, retryAfterMs);
  await deps.store.deferVerificationScan(
    row.deliveryId,
    now,
    nextVerifyAfterMs,
    JSON.stringify({
      verification_deferred: true,
      // B1: the shared streak field — see consecutiveNoProgressScans.
      no_progress: true,
      reason,
      consecutive_no_progress: priorNoProgress + 1,
      retry_after_ms: retryAfterMs,
      next_verify_after_ms: nextVerifyAfterMs,
    }),
    // B7: the caller's observed due time joins the CAS.
    row.verifyAfterMs,
  );
}

// B1 / H14: the duplicate-repair re-arm — a partial scan, a failed deletion, a
// lost CAS. It used to write a flat `verify_after_ms = now + 15 min` with no
// backoff, no cap and no exit, and completeScan is gated on exhaustion, so a
// row whose window can never be exhausted re-scanned every 15 minutes for
// ever, invisible to every observer alarm. It now shares the deferral's
// bounded backoff and the same streak and ceiling.
async function armDuplicateRepair(
  row: DispatchOutboxRow,
  deps: ResolverDeps,
  now: number,
  marker: Record<string, unknown>,
): Promise<void> {
  // F1 / H20: the observation this write is CASed against (see
  // observationForArm). A row that no longer exists has nothing to re-arm.
  const observed = await observationForArm(row, deps);
  if (observed === null) return;
  const priorNoProgress = await deps.store.consecutiveNoProgressScans(
    row.deliveryId,
  );
  if (priorNoProgress >= VERIFY_NO_PROGRESS_CEILING) {
    await abandonVerification(
      row,
      deps,
      now,
      "duplicate_repair_no_progress",
      observed,
    );
    return;
  }
  const nextVerifyAfterMs = now + noProgressDelayMs(priorNoProgress, null);
  await deps.store.flagDuplicateRepairPending(
    row.deliveryId,
    now,
    nextVerifyAfterMs,
    JSON.stringify({
      ...marker,
      no_progress: true,
      consecutive_no_progress: priorNoProgress + 1,
      next_verify_after_ms: nextVerifyAfterMs,
    }),
    // F1 / H20: the observed due time AND counter join the CAS, so a sweep
    // that landed after this observation is never postponed by this re-arm.
    observed.verifyAfterMs,
    observed.verifyScansRemaining,
  );
}

// §6.3.3: delivered_at is recoverable from the first scan's schedule
// (verify_after_ms − 15 min); the second scan runs at delivered_at + 24 h.
// After a deferral that derivation shifts, and only in the safe direction: a
// deferred due time is always ≥ delivered_at + 15 min, so the derived second
// scan lands LATER than delivered_at + 24 h, never earlier — and any later
// scan applies the same repair (R19).
async function completeScan(
  row: DispatchOutboxRow,
  deps: ResolverDeps,
  now: number,
): Promise<void> {
  // An operator sweep over a row with no scans remaining (R19) has no
  // counter to consume — only §6.3.3 verification scans decrement.
  if (row.verifyScansRemaining <= 0) return;
  const nextVerifyAfterMs =
    row.verifyScansRemaining >= 2
      ? (row.verifyAfterMs ?? now) -
        VERIFY_FIRST_SCAN_DELAY_MS +
        VERIFY_SECOND_SCAN_DELAY_MS
      : null;
  // Copilot finding F1: the completion CAS carries the caller's OBSERVED
  // verify_after_ms beside the counter, so a rearm that happened after this
  // pass's snapshot cannot be consumed by it.
  await deps.store.completeVerificationScan(
    row.deliveryId,
    now,
    nextVerifyAfterMs,
    row.verifyScansRemaining,
    row.verifyAfterMs,
  );
}

// §6.3.2: delete one later copy; only a confirmed deletion is audited with
// the repaired-duplicate marker that feeds the counter. Copilot finding F5:
// the outcome is reported to the caller — a failed deletion must re-arm
// verification so a later scan completes the repair (R19), never be
// silently swallowed.
// Review finding F3 (§6.2's fail-safe rule applied to chat.delete). The
// taxonomy is the SEND classifier's, not a second one: HTTP status first,
// ok-body rules ONLY on 200 (src/dispatch/classifier.ts).
// - "deleted": HTTP 200 with ok:true — the copy is gone.
// - "refused": HTTP 200 with an explicit ok:false — a DEFINITE negative. Slack
//   answered and applied nothing, so the copy is still in the channel.
// - "ambiguous": everything else — 429, 5xx, unexpected status, unparseable or
//   unrecognized body. Slack may have applied the deletion anyway.
type DeleteOutcome = "deleted" | "refused" | "ambiguous";

function classifyDeleteOutcome(
  httpStatus: number,
  bodyText: string,
): DeleteOutcome {
  if (httpStatus !== 200) return "ambiguous";
  const body = parseJsonObject(bodyText);
  if (body === null) return "ambiguous";
  if (body["ok"] === true) return "deleted";
  if (body["ok"] === false) return "refused";
  return "ambiguous";
}

async function deleteDuplicate(
  row: DispatchOutboxRow,
  deps: ResolverDeps,
  now: number,
  canonicalTs: string,
  duplicateTs: string,
  channel: string,
): Promise<boolean> {
  // Review finding F2 (ADR §10 H21): the deletion INTENT is durable BEFORE the
  // side effect. chat.delete is the one irreversible egress the dispatcher
  // performs: once it returns ok the ts is gone from Slack, so a failure to
  // record the repair afterwards cannot be recovered by any later history scan
  // — the evidence the scan would look for is exactly what was deleted. The
  // pre-recorded intent survives that window, so the deletion stays countable
  // (unreconciledDeletionIntents) and alarmed instead of silently lost.
  // A failure HERE is fail-safe in the other direction: nothing is deleted,
  // the copy stays in Slack, and R19 repairs it on a later scan.
  try {
    await deps.store.appendAudit({
      deliveryId: row.deliveryId,
      fromState: "delivered",
      toState: "delivered",
      evidenceJson: JSON.stringify({
        duplicate_deletion_intent: true,
        canonical_ts: canonicalTs,
        // The correlation key shared by all three deletion markers (§10 H21).
        target_ts: duplicateTs,
      }),
      actor: "resolver",
      atMs: now,
    });
  } catch {
    return false;
  }
  let outcome: DeleteOutcome;
  try {
    const response = await deps.fetch(DELETE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deps.botToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel, ts: duplicateTs }),
      // Copilot finding F2: the repair deletion gets the same 30 s hard
      // client timeout as every other egress call (§6.1) — a stalled
      // chat.delete must not hold the scheduled invocation. An abort lands in
      // the catch below as AMBIGUOUS (review finding F3), so the copy stays
      // pending and a later scan completes the repair (R19).
      signal: AbortSignal.timeout(DISPATCH_CLIENT_TIMEOUT_MS),
    });
    outcome = classifyDeleteOutcome(response.status, await response.text());
  } catch {
    // Our own 30 s abort, TLS/DNS/socket failure — §6.5 rows 7-8, where the
    // exception timing proves nothing about what the server applied.
    outcome = "ambiguous";
  }
  if (outcome !== "deleted") {
    // §10 H21: the intent is reconciled ONLY by a DEFINITE negative — a parsed
    // HTTP 200 whose body explicitly says ok:false. Slack answered and applied
    // nothing, the copy is still in the channel, so this is not an unrecorded
    // deletion and must not raise the alarm.
    // Review finding F3: an AMBIGUOUS outcome is deliberately left
    // UNRECONCILED. When Slack applies the deletion but the response stalls,
    // our timeout reaches the catch above even though the copy is already gone
    // — reconciling that as "not applied" made the deletion uncounted AND
    // suppressed `duplicate_deletion_unreconciled`, and no later history scan
    // can recover the evidence, because what it would look for is exactly what
    // was deleted. The dangling intent is the only trace that survives, which
    // is the whole reason H21 records it before the call.
    // If the append below fails, the intent stays dangling too: the fail-safe
    // direction (visible, and cleared by the next scan's outcome marker for the
    // same target ts).
    if (outcome === "refused") {
      try {
        await deps.store.appendAudit({
          deliveryId: row.deliveryId,
          fromState: "delivered",
          toState: "delivered",
          evidenceJson: JSON.stringify({
            duplicate_deletion_not_applied: true,
            canonical_ts: canonicalTs,
            target_ts: duplicateTs,
          }),
          actor: "resolver",
          atMs: now,
        });
      } catch {
        // Deliberately swallowed: the deletion did not happen, so the caller's
        // outcome ("not repaired", copy joins pendingTs) is already correct.
      }
    }
    return false;
  }
  // Audit finding B4: this append is a bare prepare/bind/run and rejects on a
  // transient D1 error. Unguarded, that rejection escaped the deletion loop,
  // resolveAmbiguousRow and runResolverPass — one failed audit aborted the
  // whole cron pass. Worse than the lost pass: an ambiguous row marked
  // delivered moments earlier would have been left with the duplicate
  // undeleted, no pending marker and (its counter being 0) no scan to find it
  // again. A failed audit is therefore reported as "not repaired", exactly
  // like a failed chat.delete (F5): the copy joins pendingTs and a later scan
  // completes the repair (R19). The copy is already gone from Slack, so the
  // later scan simply will not see it; the cost is one uncounted
  // repaired_duplicates marker, never a surviving duplicate.
  try {
    await deps.store.appendAudit({
      deliveryId: row.deliveryId,
      fromState: "delivered",
      toState: "delivered",
      evidenceJson: JSON.stringify({
        repaired_duplicate: true,
        canonical_ts: canonicalTs,
        deleted_ts: duplicateTs,
        // §10 H21: `deleted_ts` stays the repair evidence field (unchanged);
        // `target_ts` is the correlation key that reconciles the intent above.
        target_ts: duplicateTs,
      }),
      actor: "resolver",
      atMs: now,
    });
  } catch {
    // §10 H21: the copy IS deleted and this repair record did not land — the
    // one interleaving whose evidence a later scan can never rebuild. The
    // pre-recorded intent stays unreconciled, so the deletion is counted and
    // alarmed rather than lost. The caller's outcome is unchanged (B4): "not
    // repaired", so the copy keeps a future scan armed.
    return false;
  }
  return true;
}

async function recordInconclusive(
  row: DispatchOutboxRow,
  deps: ResolverDeps,
  now: number,
  reason: string,
  retryAfterMs: number | null,
): Promise<ResolverVerdict> {
  if (row.state !== "ambiguous") {
    // §6.3.3: verification scans are INCONCLUSIVE-safe — no counter
    // decrement. The row is nevertheless rescheduled with bounded backoff,
    // or it would consume the verification budget on every cron forever.
    // F3: a 429's Retry-After overrides that backoff when it is longer.
    await deferVerification(row, deps, now, reason, retryAfterMs);
    return { kind: "inconclusive", reason };
  }
  const attempts = await deps.store.incrementResolverAttempts(
    row.deliveryId,
    now,
  );
  // ADR §6.3.1, verbatim: "INCONCLUSIVE otherwise (history 429/error/partial
  // scan/floor not reached) → stay `ambiguous`, `resolver_attempts + 1`;
  // after 6 attempts within 1 h → `manual`; audited per attempt."
  // Copilot suppressed comment (F5): `attempts` is the LIFETIME counter, so
  // gating on it alone parks a row that merely accumulated six inconclusive
  // scans across days. The escalation reads the windowed count instead —
  // derived from the audit markers written just above.
  const attemptsInWindow = await deps.store.inconclusiveAttemptsSince(
    row.deliveryId,
    now - RESOLVER_ATTEMPT_WINDOW_MS,
  );
  // ADR §10 H10: the window is the PRIMARY, fast trigger, but it is
  // unreachable under resolver budget contention — strict round-robin over N
  // due rows stretches the per-row cadence past 15 min at N = 6 (N = 3 while
  // a verification row holds its reserved slot), so no rolling hour ever
  // holds six markers. The lifetime ceiling only bites in exactly that case,
  // so a starved row still reaches the `manual` park of §6.5 rows 15-16
  // instead of being alarmed forever with no gateway to the operator menu.
  // `attempts` is the read-back of the lifetime counter; if the row left
  // `ambiguous` concurrently it is the unchanged value, and the markManual
  // CAS below fails on its own — the ceiling adds no new race.
  const windowExhausted = attemptsInWindow >= RESOLVER_MAX_ATTEMPTS;
  if (windowExhausted || attempts >= RESOLVER_LIFETIME_ATTEMPT_CEILING) {
    // §6.3.1: budget exhausted — park in manual with evidence, never a
    // resend. A ceiling-triggered park is labelled so the operator can tell
    // the two escalation causes apart.
    await deps.store.markManual(
      row.deliveryId,
      now,
      JSON.stringify({
        verdict: "resolver_budget_exhausted",
        ...(windowExhausted
          ? {}
          : {
              reason: "resolver_lifetime_ceiling",
              lifetime_ceiling: RESOLVER_LIFETIME_ATTEMPT_CEILING,
            }),
        attempts,
        attempts_in_window: attemptsInWindow,
        window_ms: RESOLVER_ATTEMPT_WINDOW_MS,
        last_reason: reason,
      }),
      "resolver",
      ["ambiguous"],
    );
  } else if (retryAfterMs !== null) {
    await deps.store.markAmbiguous(
      row.deliveryId,
      now,
      reason,
      retryAfterMs,
      "resolver",
      ["ambiguous"],
    );
  }
  return { kind: "inconclusive", reason };
}

// Review findings F1 and F2 (§6.3.2). Both found_many repair sites — the
// re-read after a lost markDelivered CAS on the ambiguous path, and the
// pass-start snapshot on the delivered path — take the SAME decision here:
// which ts the row must record, and which observed copies this pass may delete.
type CanonicalRepair =
  | {
      kind: "settled";
      canonicalTs: string;
      deletableTs: readonly string[];
      // Copies this pass deliberately leaves in Slack; they keep a scan armed.
      undeletedTs: readonly string[];
    }
  | { kind: "lost" };

async function reconcileCanonicalTs(
  row: DispatchOutboxRow,
  deps: ResolverDeps,
  now: number,
  storedTs: string | null,
  observedCanonicalTs: string,
  observedDuplicateTs: readonly string[],
  // Copilot finding F4, unchanged: on the AMBIGUOUS path the stored ts was
  // written by a CONCURRENT writer between this pass's scan and its lost CAS,
  // so this pass never deletes it — it stays pending and a later scan deletes
  // it once the row unambiguously records the canonical one. On the DELIVERED
  // path this pass owns the row, and the previously recorded copy is an
  // ordinary later duplicate that §6.3.3/R18 repairs by deleting.
  keepStoredTs: boolean,
  // Review finding F1 (codex refinement): an EXHAUSTED scan is a complete
  // census of the window, so a recorded ts it did not see is not merely
  // unpaged — that message is gone from the channel (§6.5 row 17, or a ts
  // recorded by hand through the H13 menu). Keeping it as canonical would
  // leave the row pointing at nothing while every observed copy is spared,
  // and repeated scans would end in `verification_abandoned` with the true
  // canonical never restored. On exhaustion the earliest OBSERVED copy
  // therefore becomes canonical even when it is later than the stored value.
  exhausted: boolean,
): Promise<CanonicalRepair> {
  // `storedTs === null` is DEFENSIVE, not a live case, and deliberately not
  // given its own branch: migration 0010 CHECKs that a non-shadow `delivered`
  // row carries a ts, and a SHADOW row cannot arrive here twice over — every
  // writer that arms verification is predicated on `shadow = 0`
  // (flagDuplicateRepairPending, operatorSweepVerification; operatorResend
  // needs `manual`, which a shadow row never reaches — H16 returns its expired
  // lease to `queued`), and a shadow row posted nothing, so a history scan
  // yields no match to reach found_many with. The ambiguous call site guards
  // `observedTs !== null` independently.
  // The rule, stated once: update only when the candidate is provably EARLIER
  // than the stored ts, or when the scan exhausted.
  const canonicalTs = exhausted
    ? observedCanonicalTs
    : earlierTs(storedTs, observedCanonicalTs);
  // Every observed copy except the canonical one. The canonical ts is never
  // deletable: it is the row's proof.
  const observedLaterTs = [observedCanonicalTs, ...observedDuplicateTs].filter(
    (ts) => ts !== canonicalTs,
  );
  const keptTs = new Set<string>();
  if (canonicalTs !== observedCanonicalTs) {
    // Review finding F1: reachable only on a PARTIAL scan (see `exhausted`).
    // The canonical copy was not paged in, so the earliest OBSERVED copy is
    // the only one this scan can prove exists. Deleting every observed copy
    // would empty the channel if the recorded message were already gone, and
    // chat.delete is irreversible (§10 H21). It stays pending, and the scan
    // that does exhaust resolves the question either way.
    keptTs.add(observedCanonicalTs);
  }
  if (keepStoredTs && storedTs !== null) keptTs.add(storedTs);
  const deletableTs = observedLaterTs.filter((ts) => !keptTs.has(ts));
  const undeletedTs = observedLaterTs.filter((ts) => keptTs.has(ts));
  if (storedTs !== null && storedTs === canonicalTs) {
    // Review finding F1: the row already records a ts EARLIER than anything
    // this scan saw, so there is nothing to repair — and rewriting it to the
    // observed earliest is the regression the finding names. The case is
    // ordinary rather than exotic: conversations.history returns newest-first,
    // so a scan stopped by the page budget (RESOLVER_PAGES_PER_ROW) sees
    // exactly the LATER copies and misses the recorded one.
    // The earliest OBSERVED copy is then itself a later duplicate, but it is
    // NOT deleted by this PARTIAL pass — chat.delete is irreversible (§10 H21)
    // and this scan cannot yet tell "unpaged" from "gone". It is reported as
    // pending, which keeps verification armed; the next scan that EXHAUSTS
    // settles it either way (delete it as a duplicate if the recorded message
    // is really there, or adopt it as canonical if it is not).
    return { kind: "settled", canonicalTs, deletableTs, undeletedTs };
  }
  const repaired = await deps.store.updateCanonicalTs(
    row.deliveryId,
    now,
    canonicalTs,
    JSON.stringify({ canonical_ts: canonicalTs, repaired_from: storedTs }),
    // H25: the ts this decision was taken against.
    storedTs,
  );
  if (!repaired) {
    // Review finding F2: the H25 CAS lost — another writer recorded a different
    // ts between the observation above and this write. The result used to be
    // IGNORED, while deletableTs kept being computed from the stale
    // observation: the ts now ON the row could sit in that set, so the deletion
    // loop could destroy the row's own canonical proof. Nothing is deleted this
    // pass; every observed copy stays pending and R19 repairs from a later
    // scan, which re-reads the row and decides again.
    return { kind: "lost" };
  }
  return { kind: "settled", canonicalTs, deletableTs, undeletedTs };
}

export async function resolveAmbiguousRow(
  row: DispatchOutboxRow,
  deps: ResolverDeps,
): Promise<ResolverVerdict> {
  if (row.state !== "ambiguous" && row.state !== "delivered") {
    return { kind: "inconclusive", reason: `state_not_scannable_${row.state}` };
  }
  const channel = deps.channelFor(row.destination);
  const scan = await scanHistory(row, deps);
  // Review finding B (class E7), applied to this pass's own network call: the
  // clock is sampled AFTER the scan, because every deadline derived below
  // must run from the response, not from the moment the pass started. A scan
  // costs up to RESOLVER_PAGES_PER_ROW requests, each with a 30 s abort, so a
  // history 429's Retry-After anchored at pass start could schedule the next
  // call before the interval Slack asked for had elapsed (R4) — and every
  // verification backoff (§6.3.3) was short by the same amount. Nothing above
  // this line reads the clock, so the move is total: the floor check, the
  // verdict writes and the audit timestamps all now speak of the instant the
  // decision is actually taken.
  const now = deps.now();
  if (scan.kind === "failed") {
    return recordInconclusive(row, deps, now, scan.reason, scan.retryAfterMs);
  }
  // Copilot finding F2: cursor pages can overlap and repeat the SAME ts — a
  // repeated identical ts is ONE message, and must never mint a found_many
  // (which would chat.delete the sole canonical copy). Dedupe by ts first.
  const sorted = [...new Set(scan.matches)].sort(compareSlackTs);
  const canonicalTs = sorted[0];
  if (canonicalTs !== undefined) {
    const duplicateTs = sorted.slice(1);
    if (duplicateTs.length === 0) {
      if (row.state === "ambiguous") {
        const recorded = await deps.store.markDelivered(
          row.deliveryId,
          now,
          canonicalTs,
          channel,
          "resolver",
          ["ambiguous"],
          JSON.stringify({ verdict: "found", ts: canonicalTs }),
        );
        if (!recorded) {
          // Copilot finding F3 / ADR §6.3 late-proof rule: the row left
          // `ambiguous` mid-resolve (e.g. parked in manual by budget
          // exhaustion) — canonical proof still lands durably. Copilot
          // suppressed comment (F6): the provenance is the RESOLVER.
          await deps.store.recordLateProof(
            row.deliveryId,
            now,
            canonicalTs,
            channel,
            "resolver",
          );
        }
      }
      if (!scan.exhausted) {
        // Copilot finding F9: a live-cursor scan is PARTIAL — the seen match
        // is canonical delivery proof (§6.2), but canonical-earliest and
        // duplicate completeness need exhaustion. Arm verification so a
        // future full-window scan re-runs the match rule; a partial
        // verification scan never consumes the §6.3.3 counter.
        // B1: the re-arm is bounded and terminating (armDuplicateRepair).
        await armDuplicateRepair(row, deps, now, {
          duplicate_repair_pending: true,
          partial_scan: true,
          canonical_ts: canonicalTs,
          pending_ts: [],
        });
      } else if (row.state === "delivered") {
        await completeScan(row, deps, now);
      }
      return { kind: "found", ts: canonicalTs, channel };
    }
    // §6.3.2 (R17/R18): the EARLIEST ts is canonical; every later copy is
    // deleted, audited, counted.
    let effectiveCanonicalTs = canonicalTs;
    let deletableTs: readonly string[] = duplicateTs;
    // Review finding F1: observed copies this pass deliberately does not delete.
    let undeletedTs: readonly string[] = [];
    // Review finding F2: a lost canonical-ts CAS invalidates the deletion set
    // this pass computed, so the pass deletes nothing and re-arms instead. It
    // must NOT reach completeScan either — a pass that repaired nothing may not
    // consume a §6.3.3 verification scan.
    const abortRepair = async (): Promise<ResolverVerdict> => {
      await armDuplicateRepair(row, deps, now, {
        duplicate_repair_pending: true,
        ...(scan.exhausted ? {} : { partial_scan: true }),
        canonical_ts_cas_lost: true,
        canonical_ts: canonicalTs,
        pending_ts: duplicateTs,
      });
      return { kind: "found_many", canonicalTs, channel, duplicateTs };
    };
    if (row.state === "ambiguous") {
      const recorded = await deps.store.markDelivered(
        row.deliveryId,
        now,
        canonicalTs,
        channel,
        "resolver",
        ["ambiguous"],
        JSON.stringify({
          verdict: "found_many",
          canonical_ts: canonicalTs,
          duplicate_ts: duplicateTs,
        }),
      );
      if (!recorded) {
        // Copilot finding F4: the CAS lost a race — re-read before ANY
        // deletion.
        const fresh = await deps.store.get(row.deliveryId);
        if (fresh === null || fresh.state !== "delivered") {
          // Row parked off-delivered mid-resolve: land canonical proof via
          // the §6.3 late-proof rule; delete nothing this pass — a later
          // scan repairs (R19).
          // Copilot suppressed comment (F6): resolver-initiated proof.
          await deps.store.recordLateProof(
            row.deliveryId,
            now,
            canonicalTs,
            channel,
            "resolver",
          );
          // Copilot suppressed comment (F4): `audit_only` can also mean that
          // another resolver delivered the row between the re-read above and
          // recordLateProof. Gating the arming on the proof outcome left that
          // race with multiple messages seen, no deletion and no verification
          // — if the winning resolver saw only one message the duplicate
          // would stay permanently undiscovered. Arm unconditionally: the
          // store predicate (state = 'delivered' AND shadow = 0) makes it a
          // no-op unless the row really is delivered.
          await armDuplicateRepair(row, deps, now, {
            duplicate_repair_pending: true,
            // Copilot finding F9: a live cursor marks the scan partial.
            ...(scan.exhausted ? {} : { partial_scan: true }),
            canonical_ts: canonicalTs,
            pending_ts: duplicateTs,
          });
          return { kind: "found_many", canonicalTs, channel, duplicateTs };
        }
        const observedTs = fresh.slackMessageTs;
        if (observedTs !== null && observedTs !== canonicalTs) {
          // F4: a concurrent writer recorded a different ts — reconcile the
          // canonical ts BEFORE any deletion, and never delete the ts that
          // was recorded on the row. F1/F2: which ts wins, and whether this
          // pass may delete at all, is decided by reconcileCanonicalTs.
          const repair = await reconcileCanonicalTs(
            row,
            deps,
            now,
            // H25: the ts this decision was taken against — the re-read value.
            observedTs,
            canonicalTs,
            duplicateTs,
            // F4: a concurrent writer owns that ts — never deleted here.
            true,
            scan.exhausted,
          );
          if (repair.kind === "lost") return abortRepair();
          effectiveCanonicalTs = repair.canonicalTs;
          deletableTs = repair.deletableTs;
          undeletedTs = repair.undeletedTs;
        }
      }
    } else if (row.slackMessageTs !== canonicalTs) {
      const repair = await reconcileCanonicalTs(
        row,
        deps,
        now,
        // H25: the pass-start ts this decision was taken against.
        row.slackMessageTs,
        canonicalTs,
        duplicateTs,
        // §6.3.3/R18: this pass owns the delivered row — the previously
        // recorded copy is an ordinary later duplicate and is deleted.
        false,
        scan.exhausted,
      );
      if (repair.kind === "lost") return abortRepair();
      effectiveCanonicalTs = repair.canonicalTs;
      deletableTs = repair.deletableTs;
      undeletedTs = repair.undeletedTs;
    }
    // Copilot finding F5: track every copy that was NOT confirmed deleted
    // (failed chat.delete or F4 skip) — it must keep a future scan. Review
    // finding F1: a copy left alive because the RECORDED ts is earlier than the
    // whole observation counts here too, or an exhausted scan would consume a
    // verification scan while a known duplicate survives.
    const pendingTs: string[] = [
      ...undeletedTs,
      ...duplicateTs.filter((ts) => !deletableTs.includes(ts)),
    ];
    for (const ts of deletableTs) {
      const deleted = await deleteDuplicate(
        row,
        deps,
        now,
        // F1: the audit evidence carries the EFFECTIVE canonical ts — the one
        // the row records — not merely the earliest ts this scan happened to
        // page in.
        effectiveCanonicalTs,
        ts,
        channel,
      );
      if (!deleted) pendingTs.push(ts);
    }
    if (pendingTs.length > 0 || !scan.exhausted) {
      // F5/R19: the delivered row keeps (or regains) verification
      // eligibility so a later scan completes the repair; the failed copies
      // are NOT counted as repaired. Copilot finding F9: a PARTIAL scan
      // (live cursor) also arms — unseen pages may hold an earlier
      // canonical or more duplicates — and never consumes the §6.3.3
      // counter.
      await armDuplicateRepair(row, deps, now, {
        duplicate_repair_pending: true,
        ...(scan.exhausted ? {} : { partial_scan: true }),
        canonical_ts: effectiveCanonicalTs,
        pending_ts: pendingTs,
      });
    } else if (row.state === "delivered") {
      await completeScan(row, deps, now);
    }
    return {
      kind: "found_many",
      canonicalTs: effectiveCanonicalTs,
      channel,
      duplicateTs,
    };
  }
  if (row.state === "delivered") {
    // A verification scan that found nothing is inconclusive too: the
    // counter stays, the next scan is deferred with bounded backoff.
    await deferVerification(
      row,
      deps,
      now,
      "verification_scan_no_match",
      null,
    );
    return { kind: "inconclusive", reason: "verification_scan_no_match" };
  }
  // §6.3.1/R12: PROVEN-ABSENT only when the cooling-off floor passed AND
  // pagination is exhausted AND retention is verified; any shortfall is
  // inconclusive, never a resend.
  const floorMet =
    row.lastSendStartMs !== null &&
    now >= row.lastSendStartMs + RESOLVER_COOLING_OFF_FLOOR_MS;
  if (scan.exhausted && floorMet && deps.retentionVerifiedEvidence !== null) {
    const evidenceJson = JSON.stringify({
      verdict: "proven_absent",
      pages: scan.pages,
      pagination_exhausted: true,
      scan_oldest_seconds: (
        row.createdMs / 1000 -
        RESOLVER_SCAN_LOOKBACK_SECONDS
      ).toFixed(6),
      floor: {
        last_send_start_ms: row.lastSendStartMs,
        cooling_off_floor_ms: RESOLVER_COOLING_OFF_FLOOR_MS,
        now,
      },
      retention: deps.retentionVerifiedEvidence,
    });
    await deps.store.markManual(row.deliveryId, now, evidenceJson, "resolver", [
      "ambiguous",
    ]);
    return { kind: "proven_absent", evidenceJson };
  }
  const reason = !scan.exhausted
    ? "pagination_not_exhausted"
    : !floorMet
      ? "cooling_off_floor_not_reached"
      : "retention_not_verified";
  return recordInconclusive(row, deps, now, reason, null);
}

export async function runResolverPass(
  deps: ResolverDeps,
): Promise<ResolverPassResult> {
  const now = deps.now();
  // §6.3.1: normalization first — expired leases become resolver input.
  await deps.store.normalizeExpiredLeases(now);
  let examined = 0;
  let failed = 0;
  // Audit finding B4: one row's failure must not abort the pass. There was no
  // per-row guard anywhere below this line — not in the deletion loop, not in
  // resolveAmbiguousRow, not here — so a single transient D1 rejection while
  // auditing a repair skipped every remaining row. (The observe-only alarms
  // survive independently: runDispatchCronPass catches the pass failure and
  // still computes them — src/dispatch/wiring.ts, suppressed finding F3.)
  const examine = async (row: DispatchOutboxRow): Promise<void> => {
    try {
      await resolveAmbiguousRow(row, deps);
    } catch {
      // The row keeps its state, its counter and its due time, so the next
      // pass re-examines it; only this pass's work on it is lost.
      failed += 1;
    }
    examined += 1;
  };
  // §6.3.3: verification-due delivered rows share the resolver's budget and
  // run before the ambiguous backlog. Copilot finding (resolver starvation):
  // they may take at most HALF of it (floor), so a due ambiguous row is
  // always examined even while verification rows are due. The total budget
  // is unchanged; an unused verification slot is not handed to a second
  // verification row.
  const verificationRows = await deps.store.verificationRowsDue(
    now,
    Math.floor(RESOLVER_ROWS_PER_RUN / 2),
  );
  for (const row of verificationRows) {
    await examine(row);
  }
  const remaining = RESOLVER_ROWS_PER_RUN - examined;
  if (remaining > 0) {
    const ambiguousRows = await deps.store.ambiguousRowsDue(now, remaining);
    for (const row of ambiguousRows) {
      await examine(row);
    }
  }
  return { examined, failed };
}
