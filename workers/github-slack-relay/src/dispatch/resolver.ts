// ADR-001 §6.3.1-§6.3.3 — resolver: history scan with strict exhaustion
// semantics, verdict application over ambiguous rows, duplicate repair
// (found_many), and post-resend verification scans over delivered rows.
// Verdicts are EVIDENCE, never triggers: the resolver never resends (I1).
import {
  DISPATCH_METADATA_EVENT_TYPE,
  RESOLVER_COOLING_OFF_FLOOR_MS,
  RESOLVER_MAX_ATTEMPTS,
  RESOLVER_PAGES_PER_ROW,
  RESOLVER_ROWS_PER_RUN,
  RESOLVER_SCAN_LOOKBACK_SECONDS,
  VERIFY_FIRST_SCAN_DELAY_MS,
  VERIFY_SECOND_SCAN_DELAY_MS,
  type DispatchDestination,
  type DispatchOutboxRow,
  type DispatchStore,
  type ResolverVerdict,
} from "./contract";

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

function retryAfterMsFrom(headers: {
  get(name: string): string | null;
}): number | null {
  const raw = headers.get("Retry-After");
  if (raw === null) return null;
  const seconds = Number(raw.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.round(seconds * 1000);
}

// §6.3.1 pagination: response_metadata.next_cursor; absent metadata counts
// as an empty cursor.
function nextCursorOf(body: Record<string, unknown>): string {
  const metadata = body["response_metadata"];
  if (typeof metadata !== "object" || metadata === null) return "";
  const cursor = (metadata as Record<string, unknown>)["next_cursor"];
  return typeof cursor === "string" ? cursor : "";
}

// §6.3.1 match rule (R14): top-level messages only (any thread_ts
// disqualifies — R15), exact event_type and event_payload.delivery_id.
function collectMatches(
  body: Record<string, unknown>,
  deliveryId: string,
  matches: string[],
): void {
  const messages = body["messages"];
  if (!Array.isArray(messages)) return;
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const candidate = message as Record<string, unknown>;
    if (candidate["thread_ts"] !== undefined) continue;
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
    if (typeof ts === "string" && ts.length > 0) matches.push(ts);
  }
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
    collectMatches(body, row.deliveryId, matches);
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

// §6.3.3: delivered_at is recoverable from the first scan's schedule
// (verify_after_ms − 15 min); the second scan runs at delivered_at + 24 h.
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
  await deps.store.completeVerificationScan(
    row.deliveryId,
    now,
    nextVerifyAfterMs,
    row.verifyScansRemaining,
  );
}

// §6.3.2: delete one later copy; only a confirmed deletion is audited with
// the repaired-duplicate marker that feeds the counter. Copilot finding F5:
// the outcome is reported to the caller — a failed deletion must re-arm
// verification so a later scan completes the repair (R19), never be
// silently swallowed.
async function deleteDuplicate(
  row: DispatchOutboxRow,
  deps: ResolverDeps,
  now: number,
  canonicalTs: string,
  duplicateTs: string,
  channel: string,
): Promise<boolean> {
  let deleted = false;
  try {
    const response = await deps.fetch(DELETE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deps.botToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel, ts: duplicateTs }),
    });
    const body = parseJsonObject(await response.text());
    deleted = response.status === 200 && body !== null && body["ok"] === true;
  } catch {
    deleted = false;
  }
  if (!deleted) return false;
  await deps.store.appendAudit({
    deliveryId: row.deliveryId,
    fromState: "delivered",
    toState: "delivered",
    evidenceJson: JSON.stringify({
      repaired_duplicate: true,
      canonical_ts: canonicalTs,
      deleted_ts: duplicateTs,
    }),
    actor: "resolver",
    atMs: now,
  });
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
    // decrement, no bookkeeping against the delivered row.
    return { kind: "inconclusive", reason };
  }
  const attempts = await deps.store.incrementResolverAttempts(
    row.deliveryId,
    now,
  );
  if (attempts >= RESOLVER_MAX_ATTEMPTS) {
    // §6.3.1: budget exhausted — park in manual with evidence, never a
    // resend.
    await deps.store.markManual(
      row.deliveryId,
      now,
      JSON.stringify({
        verdict: "resolver_budget_exhausted",
        attempts,
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

export async function resolveAmbiguousRow(
  row: DispatchOutboxRow,
  deps: ResolverDeps,
): Promise<ResolverVerdict> {
  if (row.state !== "ambiguous" && row.state !== "delivered") {
    return { kind: "inconclusive", reason: `state_not_scannable_${row.state}` };
  }
  const now = deps.now();
  const channel = deps.channelFor(row.destination);
  const scan = await scanHistory(row, deps);
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
          // exhaustion) — canonical proof still lands durably.
          await deps.store.recordLateProof(
            row.deliveryId,
            now,
            canonicalTs,
            channel,
          );
        }
      } else {
        await completeScan(row, deps, now);
      }
      return { kind: "found", ts: canonicalTs, channel };
    }
    // §6.3.2 (R17/R18): the EARLIEST ts is canonical; every later copy is
    // deleted, audited, counted.
    let deletableTs: readonly string[] = duplicateTs;
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
          const proof = await deps.store.recordLateProof(
            row.deliveryId,
            now,
            canonicalTs,
            channel,
          );
          if (proof !== "audit_only") {
            await deps.store.flagDuplicateRepairPending(
              row.deliveryId,
              now,
              JSON.stringify({
                duplicate_repair_pending: true,
                canonical_ts: canonicalTs,
                pending_ts: duplicateTs,
              }),
            );
          }
          return { kind: "found_many", canonicalTs, channel, duplicateTs };
        }
        const observedTs = fresh.slackMessageTs;
        if (observedTs !== null && observedTs !== canonicalTs) {
          // F4: a concurrent writer recorded a different ts — reconcile the
          // canonical ts BEFORE any deletion, and never delete the ts that
          // was recorded on the row.
          await deps.store.updateCanonicalTs(
            row.deliveryId,
            now,
            canonicalTs,
            JSON.stringify({
              canonical_ts: canonicalTs,
              repaired_from: observedTs,
            }),
          );
          deletableTs = duplicateTs.filter((ts) => ts !== observedTs);
        }
      }
    } else if (row.slackMessageTs !== canonicalTs) {
      await deps.store.updateCanonicalTs(
        row.deliveryId,
        now,
        canonicalTs,
        JSON.stringify({
          canonical_ts: canonicalTs,
          repaired_from: row.slackMessageTs,
        }),
      );
    }
    // Copilot finding F5: track every copy that was NOT confirmed deleted
    // (failed chat.delete or F4 skip) — it must keep a future scan.
    const pendingTs: string[] = duplicateTs.filter(
      (ts) => !deletableTs.includes(ts),
    );
    for (const ts of deletableTs) {
      const deleted = await deleteDuplicate(
        row,
        deps,
        now,
        canonicalTs,
        ts,
        channel,
      );
      if (!deleted) pendingTs.push(ts);
    }
    if (pendingTs.length > 0) {
      // F5/R19: the delivered row keeps (or regains) verification
      // eligibility so a later scan completes the repair; the failed copies
      // are NOT counted as repaired.
      await deps.store.flagDuplicateRepairPending(
        row.deliveryId,
        now,
        JSON.stringify({
          duplicate_repair_pending: true,
          canonical_ts: canonicalTs,
          pending_ts: pendingTs,
        }),
      );
    } else if (row.state === "delivered") {
      await completeScan(row, deps, now);
    }
    return { kind: "found_many", canonicalTs, channel, duplicateTs };
  }
  if (row.state === "delivered") {
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
  // §6.3.3: verification-due delivered rows share the resolver's budget and
  // run before the ambiguous backlog.
  const verificationRows = await deps.store.verificationRowsDue(
    now,
    RESOLVER_ROWS_PER_RUN,
  );
  for (const row of verificationRows) {
    await resolveAmbiguousRow(row, deps);
    examined += 1;
  }
  const remaining = RESOLVER_ROWS_PER_RUN - examined;
  if (remaining > 0) {
    const ambiguousRows = await deps.store.ambiguousRowsDue(now, remaining);
    for (const row of ambiguousRows) {
      await resolveAmbiguousRow(row, deps);
      examined += 1;
    }
  }
  return { examined };
}
