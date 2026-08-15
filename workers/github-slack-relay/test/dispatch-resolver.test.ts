// ADR-001 architectural REDs — resolver verdicts, scheduling and repair.
// Covers R3, R4 (scheduling half), R9, R12, R14, R17, R18, R19 per
// docs/adr/ADR-001-slack-dispatch-outbox.md §6.3.1-§6.3.3 and §6.10.
// RED phase: these tests are the executable specification and fail until
// src/dispatch/{outbox,resolver} land on the pinned module surface.
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DISPATCH_CLIENT_TIMEOUT_MS,
  DISPATCH_METADATA_EVENT_TYPE,
  RESOLVER_ATTEMPT_WINDOW_MS,
  RESOLVER_COOLING_OFF_FLOOR_MS,
  RESOLVER_LIFETIME_ATTEMPT_CEILING,
  RESOLVER_MAX_ATTEMPTS,
  RESOLVER_PAGES_PER_ROW,
  RETRY_AFTER_CEILING_MS,
  VERIFY_DEFERRAL_BACKOFF_BASE_MS,
  VERIFY_DEFERRAL_BACKOFF_CAP_MS,
  VERIFY_FIRST_SCAN_DELAY_MS,
  VERIFY_NO_PROGRESS_CEILING,
  VERIFY_SECOND_SCAN_DELAY_MS,
} from "../src/dispatch/contract";
import type {
  DispatchDestination,
  DispatchOutboxRow,
  DispatchStore,
} from "../src/dispatch/contract";
import { observerAlarms } from "../src/dispatch/observer";
import { D1DispatchStore } from "../src/dispatch/outbox";
import { resolveAmbiguousRow, runResolverPass } from "../src/dispatch/resolver";
import type { ResolverDeps } from "../src/dispatch/resolver";
import {
  auditRows,
  closeDispatchDatabases,
  DISPATCH_TEST_NOW,
  dispatchDatabase,
  historyMessage,
  scriptedFetch,
  slackHistoryError,
  slackHistoryPage,
  slackRateLimited,
} from "./dispatch-helpers";
import type { FixtureResponse, RecordedSlackCall } from "./dispatch-helpers";

// F0 amendment A4 / R9: workspace retention is "never delete"; the recorded
// evidence pointer is the resolver's proven-absent precondition.
const RETENTION_EVIDENCE = "issue #192 comment 5297540210";
const ALERTS_CHANNEL = "C0BMUK793NV";
const ACTIVITY_CHANNEL = "C0BMQMW3L4E";
const TS_EARLY = "1786664000.000100";
const TS_LATE = "1786664900.000200";

function makeStore() {
  const { database, d1 } = dispatchDatabase();
  return { database, store: new D1DispatchStore(d1) };
}

function resolverDeps(
  store: D1DispatchStore,
  fetchStub: typeof fetch,
  overrides?: Partial<Pick<ResolverDeps, "now" | "retentionVerifiedEvidence">>,
): ResolverDeps {
  return {
    store,
    fetch: fetchStub,
    now: () => DISPATCH_TEST_NOW,
    botToken: "xoxb-test-token",
    channelFor: (destination: DispatchDestination) =>
      destination === "alerts" ? ALERTS_CHANNEL : ACTIVITY_CHANNEL,
    retentionVerifiedEvidence: RETENTION_EVIDENCE,
    ...overrides,
  };
}

function slackDeleteOk(): FixtureResponse {
  return { status: 200, body: { ok: true } };
}

function deleteCalls(calls: readonly RecordedSlackCall[]): RecordedSlackCall[] {
  return calls.filter((call) => call.url.includes("chat.delete"));
}

function historyCallCount(calls: readonly RecordedSlackCall[]): number {
  return calls.filter((call) => call.url.includes("conversations.history"))
    .length;
}

async function mustGet(
  store: D1DispatchStore,
  deliveryId: string,
): Promise<DispatchOutboxRow> {
  const row = await store.get(deliveryId);
  if (row === null) throw new Error(`missing_row:${deliveryId}`);
  return row;
}

// Walks insert -> claim (records last_send_start_ms = sendStartMs) ->
// markAmbiguous. Default sendStartMs is older than the cooling-off floor so
// the row is verdict-eligible at DISPATCH_TEST_NOW (ADR §6.3.1, R12).
async function seedAmbiguous(
  store: D1DispatchStore,
  deliveryId: string,
  options?: { sendStartMs?: number; destination?: DispatchDestination },
): Promise<DispatchOutboxRow> {
  const sendStartMs =
    options?.sendStartMs ??
    DISPATCH_TEST_NOW - RESOLVER_COOLING_OFF_FLOOR_MS - 60_000;
  const destination = options?.destination ?? "alerts";
  const inserted = await store.insert({
    deliveryId,
    destination,
    shadow: false,
    payloadJson: "{}",
    now: sendStartMs - 1_000,
  });
  if (!inserted) throw new Error(`insert_failed:${deliveryId}`);
  const claimed = await store.claim(deliveryId, sendStartMs);
  if (claimed === null) throw new Error(`claim_failed:${deliveryId}`);
  const marked = await store.markAmbiguous(
    deliveryId,
    sendStartMs + 1_000,
    "http_500",
    null,
    "consumer",
    ["sending"],
  );
  if (!marked) throw new Error(`mark_ambiguous_failed:${deliveryId}`);
  return mustGet(store, deliveryId);
}

// Plain consumer delivery (no operator involvement, no verification armed).
async function deliverViaConsumer(
  store: D1DispatchStore,
  deliveryId: string,
  deliveredMs: number,
  ts: string,
): Promise<DispatchOutboxRow> {
  const t0 = deliveredMs - 10_000;
  const inserted = await store.insert({
    deliveryId,
    destination: "alerts",
    shadow: false,
    payloadJson: "{}",
    now: t0,
  });
  if (!inserted) throw new Error(`insert_failed:${deliveryId}`);
  const claimed = await store.claim(deliveryId, t0 + 1_000);
  if (claimed === null) throw new Error(`claim_failed:${deliveryId}`);
  const marked = await store.markDelivered(
    deliveryId,
    deliveredMs,
    ts,
    ALERTS_CHANNEL,
    "consumer",
    ["sending"],
    JSON.stringify({ source: "chat.postMessage" }),
  );
  if (!marked) throw new Error(`mark_delivered_failed:${deliveryId}`);
  return mustGet(store, deliveryId);
}

// ADR §6.3.3: the ONLY resend path — manual -> queued via the operator menu —
// then the ordinary consumer claim/deliver walk. Delivery through this path
// must arm the mandatory verification scans.
async function deliverViaOperatorResend(
  store: D1DispatchStore,
  deliveryId: string,
  deliveredMs: number,
  ts: string,
): Promise<DispatchOutboxRow> {
  const t0 = deliveredMs - 60_000;
  await seedAmbiguous(store, deliveryId, { sendStartMs: t0 });
  const parked = await store.markManual(
    deliveryId,
    t0 + 2_000,
    JSON.stringify({ reason: "resolver_budget_exhausted" }),
    "resolver",
    ["ambiguous"],
  );
  if (!parked) throw new Error(`mark_manual_failed:${deliveryId}`);
  const resent = await store.operatorResend(
    deliveryId,
    t0 + 3_000,
    JSON.stringify({ menu: "possible-duplicate" }),
    null,
  );
  if (!resent) throw new Error(`operator_resend_failed:${deliveryId}`);
  const claimed = await store.claim(deliveryId, t0 + 4_000);
  if (claimed === null) throw new Error(`second_claim_failed:${deliveryId}`);
  const marked = await store.markDelivered(
    deliveryId,
    deliveredMs,
    ts,
    ALERTS_CHANNEL,
    "consumer",
    ["sending"],
    JSON.stringify({ source: "chat.postMessage" }),
  );
  if (!marked) throw new Error(`mark_delivered_failed:${deliveryId}`);
  return mustGet(store, deliveryId);
}

afterEach(() => {
  closeDispatchDatabases();
});

describe("resolver verdicts (R3/R9/R12/R14)", () => {
  it("R3: a sending row with an expired lease is normalized to ambiguous before verdicts", async () => {
    const { database, store } = makeStore();
    const deliveryId = "red3-lease-expired";
    const sendStartMs =
      DISPATCH_TEST_NOW - RESOLVER_COOLING_OFF_FLOOR_MS - 60_000;
    const inserted = await store.insert({
      deliveryId,
      destination: "alerts",
      shadow: false,
      payloadJson: "{}",
      now: sendStartMs - 1_000,
    });
    expect(inserted).toBe(true);
    const claimed = await store.claim(deliveryId, sendStartMs);
    expect(claimed?.state).toBe("sending");

    const { fetch: fetchStub } = scriptedFetch((url) =>
      url.includes("conversations.history")
        ? slackHistoryError("internal_error")
        : undefined,
    );
    const pass = await runResolverPass(resolverDeps(store, fetchStub));

    expect(pass.examined).toBe(1);
    const row = await mustGet(store, deliveryId);
    expect(row.state).toBe("ambiguous");
    expect(row.resolverAttempts).toBe(1);
    const normalization = auditRows(database, deliveryId).find(
      (entry) =>
        entry["from_state"] === "sending" && entry["to_state"] === "ambiguous",
    );
    expect(normalization).toBeDefined();
    expect(String(normalization?.["evidence_json"])).toContain("lease_expired");
  });

  it("R3: a history message matching event_type and delivery_id yields found and delivers the row", async () => {
    const { database, store } = makeStore();
    const deliveryId = "red3-found";
    const row = await seedAmbiguous(store, deliveryId);
    const { fetch: fetchStub, calls } = scriptedFetch((url) =>
      url.includes("conversations.history")
        ? slackHistoryPage([
            historyMessage({
              ts: TS_EARLY,
              deliveryId,
              eventType: DISPATCH_METADATA_EVENT_TYPE,
            }),
          ])
        : undefined,
    );

    const verdict = await resolveAmbiguousRow(
      row,
      resolverDeps(store, fetchStub),
    );

    expect(verdict).toEqual({
      kind: "found",
      ts: TS_EARLY,
      channel: ALERTS_CHANNEL,
    });
    const updated = await mustGet(store, deliveryId);
    expect(updated.state).toBe("delivered");
    expect(updated.slackMessageTs).toBe(TS_EARLY);
    expect(updated.slackChannelId).toBe(ALERTS_CHANNEL);
    expect(deleteCalls(calls)).toHaveLength(0);
    const deliveredAudit = auditRows(database, deliveryId).find(
      (entry) => entry["to_state"] === "delivered",
    );
    expect(deliveredAudit?.["actor"]).toBe("resolver");
  });

  it("R3: exhausted pagination with floor and retention satisfied yields proven-absent into manual, never a resend", async () => {
    const { database, store } = makeStore();
    const deliveryId = "red3-proven-absent";
    const row = await seedAmbiguous(store, deliveryId);
    const { fetch: fetchStub } = scriptedFetch((url) =>
      url.includes("conversations.history")
        ? slackHistoryPage([], { nextCursor: "", hasMore: false })
        : undefined,
    );

    const verdict = await resolveAmbiguousRow(
      row,
      resolverDeps(store, fetchStub),
    );

    expect(verdict.kind).toBe("proven_absent");
    if (verdict.kind === "proven_absent") {
      expect(verdict.evidenceJson.length).toBeGreaterThan(0);
    }
    // No automatic resend exists (I1): manual, NOT queued.
    const updated = await mustGet(store, deliveryId);
    expect(updated.state).toBe("manual");
    const manualAudit = auditRows(database, deliveryId).find(
      (entry) => entry["to_state"] === "manual",
    );
    expect(manualAudit?.["actor"]).toBe("resolver");
    expect(String(manualAudit?.["evidence_json"]).length).toBeGreaterThan(2);
  });

  it("R3: a history API error is inconclusive and increments resolver_attempts", async () => {
    const { store } = makeStore();
    const deliveryId = "red3-history-error";
    const row = await seedAmbiguous(store, deliveryId);
    const { fetch: fetchStub } = scriptedFetch((url) =>
      url.includes("conversations.history")
        ? slackHistoryError("internal_error")
        : undefined,
    );

    const verdict = await resolveAmbiguousRow(
      row,
      resolverDeps(store, fetchStub),
    );

    expect(verdict.kind).toBe("inconclusive");
    const updated = await mustGet(store, deliveryId);
    expect(updated.state).toBe("ambiguous");
    expect(updated.resolverAttempts).toBe(1);
  });

  it("R3: exhausting the page budget with a live cursor is inconclusive, never absence", async () => {
    const { store } = makeStore();
    const deliveryId = "red3-page-budget";
    const row = await seedAmbiguous(store, deliveryId);
    let page = 0;
    const { fetch: fetchStub, calls } = scriptedFetch((url) => {
      if (url.includes("conversations.history")) {
        page += 1;
        return slackHistoryPage([], {
          nextCursor: `cursor-${page}`,
          hasMore: true,
        });
      }
      return undefined;
    });

    const verdict = await resolveAmbiguousRow(
      row,
      resolverDeps(store, fetchStub),
    );

    expect(verdict.kind).toBe("inconclusive");
    expect(historyCallCount(calls)).toBe(RESOLVER_PAGES_PER_ROW);
    const updated = await mustGet(store, deliveryId);
    expect(updated.state).toBe("ambiguous");
    expect(updated.resolverAttempts).toBe(1);
  });

  it("R3: has_more true with an empty cursor is contradictory — inconclusive, never exhaustion", async () => {
    const { store } = makeStore();
    const deliveryId = "red3-contradictory-page";
    const row = await seedAmbiguous(store, deliveryId);
    const { fetch: fetchStub } = scriptedFetch((url) =>
      url.includes("conversations.history")
        ? slackHistoryPage([], { nextCursor: "", hasMore: true })
        : undefined,
    );

    const verdict = await resolveAmbiguousRow(
      row,
      resolverDeps(store, fetchStub),
    );

    expect(verdict.kind).toBe("inconclusive");
    const updated = await mustGet(store, deliveryId);
    expect(updated.state).toBe("ambiguous");
    expect(updated.resolverAttempts).toBe(1);
  });

  it("R3: absent response_metadata counts as an empty cursor — with has_more false and floor met it IS exhaustion", async () => {
    const { store } = makeStore();
    const deliveryId = "red3-absent-metadata";
    const row = await seedAmbiguous(store, deliveryId);
    const { fetch: fetchStub } = scriptedFetch((url) =>
      url.includes("conversations.history")
        ? slackHistoryPage([], { hasMore: false, omitMetadata: true })
        : undefined,
    );

    const verdict = await resolveAmbiguousRow(
      row,
      resolverDeps(store, fetchStub),
    );

    // The distinction against the contradictory case above: absent metadata
    // plus has_more false completes exhaustion and proves absence.
    expect(verdict.kind).toBe("proven_absent");
    const updated = await mustGet(store, deliveryId);
    expect(updated.state).toBe("manual");
  });

  it("R9: the proven-absent audit row records the verified retention evidence", async () => {
    const { database, store } = makeStore();
    const deliveryId = "red9-retention-evidence";
    const row = await seedAmbiguous(store, deliveryId);
    const { fetch: fetchStub } = scriptedFetch((url) =>
      url.includes("conversations.history")
        ? slackHistoryPage([], { nextCursor: "", hasMore: false })
        : undefined,
    );

    const verdict = await resolveAmbiguousRow(
      row,
      resolverDeps(store, fetchStub),
    );

    expect(verdict.kind).toBe("proven_absent");
    const manualAudit = auditRows(database, deliveryId).find(
      (entry) => entry["to_state"] === "manual",
    );
    expect(String(manualAudit?.["evidence_json"])).toContain(
      RETENTION_EVIDENCE,
    );
  });

  it("R12: perfect exhaustion before the cooling-off floor is inconclusive", async () => {
    const { store } = makeStore();
    const deliveryId = "red12-floor-not-reached";
    const row = await seedAmbiguous(store, deliveryId, {
      sendStartMs: DISPATCH_TEST_NOW - RESOLVER_COOLING_OFF_FLOOR_MS + 60_000,
    });
    const { fetch: fetchStub } = scriptedFetch((url) =>
      url.includes("conversations.history")
        ? slackHistoryPage([], { nextCursor: "", hasMore: false })
        : undefined,
    );

    const verdict = await resolveAmbiguousRow(
      row,
      resolverDeps(store, fetchStub),
    );

    expect(verdict.kind).toBe("inconclusive");
    const updated = await mustGet(store, deliveryId);
    expect(updated.state).toBe("ambiguous");
    expect(updated.resolverAttempts).toBe(1);
  });

  it("R12: without verified retention evidence proven-absent is never reached", async () => {
    const { store } = makeStore();
    const deliveryId = "red12-retention-missing";
    const row = await seedAmbiguous(store, deliveryId);
    const { fetch: fetchStub } = scriptedFetch((url) =>
      url.includes("conversations.history")
        ? slackHistoryPage([], { nextCursor: "", hasMore: false })
        : undefined,
    );

    const verdict = await resolveAmbiguousRow(
      row,
      resolverDeps(store, fetchStub, { retentionVerifiedEvidence: null }),
    );

    expect(verdict.kind).toBe("inconclusive");
    const updated = await mustGet(store, deliveryId);
    expect(updated.state).toBe("ambiguous");
  });

  it("R12: after RESOLVER_MAX_ATTEMPTS inconclusive attempts the row moves to manual", async () => {
    const { database, store } = makeStore();
    const deliveryId = "red12-attempt-budget";
    await seedAmbiguous(store, deliveryId);
    const { fetch: fetchStub } = scriptedFetch((url) =>
      url.includes("conversations.history")
        ? slackHistoryError("internal_error")
        : undefined,
    );
    const deps = resolverDeps(store, fetchStub);

    for (let attempt = 1; attempt <= RESOLVER_MAX_ATTEMPTS; attempt += 1) {
      const verdict = await resolveAmbiguousRow(
        await mustGet(store, deliveryId),
        deps,
      );
      expect(verdict.kind).toBe("inconclusive");
      if (attempt < RESOLVER_MAX_ATTEMPTS) {
        expect((await mustGet(store, deliveryId)).state).toBe("ambiguous");
      }
    }

    const row = await mustGet(store, deliveryId);
    expect(row.resolverAttempts).toBe(RESOLVER_MAX_ATTEMPTS);
    expect(row.state).toBe("manual");
    const escalation = auditRows(database, deliveryId).find(
      (entry) => entry["to_state"] === "manual",
    );
    expect(escalation?.["actor"]).toBe("resolver");
  });

  // Copilot suppressed comment (F5) / ADR §6.3.1, verbatim: "after 6 attempts
  // within 1 h → `manual`". The threshold used the LIFETIME resolver_attempts
  // counter, so six inconclusive scans spread across days parked a healthy
  // row in manual.
  it("suppressed F5: six inconclusive attempts spread beyond the 1 h window do NOT escalate", async () => {
    const { database, store } = makeStore();
    const deliveryId = "suppressed-f5-spread";
    const firstAttemptMs = DISPATCH_TEST_NOW - 6 * RESOLVER_ATTEMPT_WINDOW_MS;
    await seedAmbiguous(store, deliveryId, {
      sendStartMs: firstAttemptMs - 60_000,
    });
    const { fetch: fetchStub } = scriptedFetch((url) =>
      url.includes("conversations.history")
        ? slackHistoryError("internal_error")
        : undefined,
    );

    // One attempt per hour + 1 min: no two attempts ever share a window.
    for (let attempt = 0; attempt < RESOLVER_MAX_ATTEMPTS; attempt += 1) {
      const attemptMs =
        firstAttemptMs + attempt * (RESOLVER_ATTEMPT_WINDOW_MS + 60_000);
      const verdict = await resolveAmbiguousRow(
        await mustGet(store, deliveryId),
        resolverDeps(store, fetchStub, { now: () => attemptMs }),
      );
      expect(verdict.kind).toBe("inconclusive");
      expect((await mustGet(store, deliveryId)).state).toBe("ambiguous");
    }

    const row = await mustGet(store, deliveryId);
    // The lifetime counter still records every attempt (§6.3.1 persistence)...
    expect(row.resolverAttempts).toBe(RESOLVER_MAX_ATTEMPTS);
    // ...but the WINDOWED count never reached the threshold, so the row is
    // still resolver-owned instead of parked for the operator.
    expect(row.state).toBe("ambiguous");
    expect(
      auditRows(database, deliveryId).filter(
        (entry) => entry["to_state"] === "manual",
      ),
    ).toHaveLength(0);
  });

  it("suppressed F5: six inconclusive attempts inside the 1 h window escalate to manual with the windowed evidence", async () => {
    const { database, store } = makeStore();
    const deliveryId = "suppressed-f5-window";
    const firstAttemptMs = DISPATCH_TEST_NOW - 50 * 60_000;
    await seedAmbiguous(store, deliveryId, {
      sendStartMs: firstAttemptMs - 60_000,
    });
    const { fetch: fetchStub } = scriptedFetch((url) =>
      url.includes("conversations.history")
        ? slackHistoryError("internal_error")
        : undefined,
    );

    // Six attempts, 10 min apart: the sixth still sees all six in its window.
    for (let attempt = 0; attempt < RESOLVER_MAX_ATTEMPTS; attempt += 1) {
      const attemptMs = firstAttemptMs + attempt * 10 * 60_000;
      const verdict = await resolveAmbiguousRow(
        await mustGet(store, deliveryId),
        resolverDeps(store, fetchStub, { now: () => attemptMs }),
      );
      expect(verdict.kind).toBe("inconclusive");
      if (attempt < RESOLVER_MAX_ATTEMPTS - 1) {
        expect((await mustGet(store, deliveryId)).state).toBe("ambiguous");
      }
    }

    expect((await mustGet(store, deliveryId)).state).toBe("manual");
    const escalation = auditRows(database, deliveryId).find(
      (entry) => entry["to_state"] === "manual",
    );
    expect(escalation?.["actor"]).toBe("resolver");
    expect(
      JSON.parse(String(escalation?.["evidence_json"])) as Record<
        string,
        unknown
      >,
    ).toMatchObject({
      verdict: "resolver_budget_exhausted",
      attempts: RESOLVER_MAX_ATTEMPTS,
      attempts_in_window: RESOLVER_MAX_ATTEMPTS,
      window_ms: RESOLVER_ATTEMPT_WINDOW_MS,
    });
  });

  it("R14: a message with the right delivery_id but the wrong event_type never matches", async () => {
    const { store } = makeStore();
    const deliveryId = "red14-wrong-event-type";
    const row = await seedAmbiguous(store, deliveryId);
    const { fetch: fetchStub, calls } = scriptedFetch((url) =>
      url.includes("conversations.history")
        ? slackHistoryPage([
            historyMessage({
              ts: TS_EARLY,
              deliveryId,
              eventType: "github_relay_delivery_v2",
            }),
          ])
        : undefined,
    );

    const verdict = await resolveAmbiguousRow(
      row,
      resolverDeps(store, fetchStub),
    );

    // The decoy did not match, the scan was exhausted -> proven absent.
    expect(verdict.kind).toBe("proven_absent");
    const updated = await mustGet(store, deliveryId);
    expect(updated.state).toBe("manual");
    expect(deleteCalls(calls)).toHaveLength(0);
  });

  it("R14: a thread reply with matching metadata is ignored — only the top-level message matches", async () => {
    const { store } = makeStore();
    const deliveryId = "red14-thread-reply";
    const row = await seedAmbiguous(store, deliveryId);
    const { fetch: fetchStub, calls } = scriptedFetch((url) =>
      url.includes("conversations.history")
        ? slackHistoryPage([
            historyMessage({
              ts: TS_EARLY,
              deliveryId,
              threadTs: "1786663000.000001",
            }),
            historyMessage({
              ts: TS_LATE,
              deliveryId,
              eventType: DISPATCH_METADATA_EVENT_TYPE,
            }),
          ])
        : undefined,
    );

    const verdict = await resolveAmbiguousRow(
      row,
      resolverDeps(store, fetchStub),
    );

    // The thread reply does NOT count as a second match: the verdict is a
    // plain found (R15 interplay), and no repair deletion is ever attempted.
    expect(verdict).toEqual({
      kind: "found",
      ts: TS_LATE,
      channel: ALERTS_CHANNEL,
    });
    const updated = await mustGet(store, deliveryId);
    expect(updated.state).toBe("delivered");
    expect(updated.slackMessageTs).toBe(TS_LATE);
    expect(deleteCalls(calls)).toHaveLength(0);
  });

  // Audit finding B2 (BLOCKER). Slack, verbatim: "One quirk of threaded
  // messages is that a parent message object will retain a `thread_ts` value,
  // even if all its replies have been deleted." A parent carries
  // `thread_ts === ts`, so the old filter ("any thread_ts disqualifies")
  // dropped OUR OWN message from the match the moment a human replied to it
  // in-thread — the ordinary way an alert channel is used.
  it("B2: a parent message carrying thread_ts === ts is a top-level match; a genuine reply is still ignored", async () => {
    const { store } = makeStore();
    const deliveryId = "b2-parent-with-replies";
    const row = await seedAmbiguous(store, deliveryId);
    const { fetch: fetchStub, calls } = scriptedFetch((url) =>
      url.includes("conversations.history")
        ? slackHistoryPage([
            // Our canonical message, after a human replied to it: Slack
            // stamps the PARENT with thread_ts equal to its own ts.
            historyMessage({
              ts: TS_EARLY,
              deliveryId,
              threadTs: TS_EARLY,
            }),
          ])
        : undefined,
    );

    const verdict = await resolveAmbiguousRow(
      row,
      resolverDeps(store, fetchStub),
    );

    expect(verdict).toEqual({
      kind: "found",
      ts: TS_EARLY,
      channel: ALERTS_CHANNEL,
    });
    const updated = await mustGet(store, deliveryId);
    expect(updated.state).toBe("delivered");
    expect(updated.slackMessageTs).toBe(TS_EARLY);
    expect(deleteCalls(calls)).toHaveLength(0);
  });

  // The other half of B2's fix, on the verification path where the finding
  // does real damage: with the parent invisible, a scan over a delivered row
  // saw ONLY the duplicate, deleted nothing, and still recorded the canonical
  // ts — D1 looked clean while the duplicate survived in Slack.
  it("B2: a verification scan repairs a duplicate even after our own message acquired an in-thread reply", async () => {
    const { store } = makeStore();
    const deliveryId = "b2-verification-parent";
    const deliveredMs = DISPATCH_TEST_NOW - VERIFY_FIRST_SCAN_DELAY_MS;
    await deliverViaOperatorResend(store, deliveryId, deliveredMs, TS_EARLY);
    const { fetch: fetchStub, calls } = scriptedFetch((url) =>
      url.includes("conversations.history")
        ? slackHistoryPage([
            // The canonical copy, now a thread parent (a human replied).
            historyMessage({ ts: TS_EARLY, deliveryId, threadTs: TS_EARLY }),
            // The late server-side materialization §6.3.3 exists to repair.
            historyMessage({ ts: TS_LATE, deliveryId }),
            // A genuine reply carrying the same metadata is NOT a third copy.
            historyMessage({
              ts: "1786664950.000210",
              deliveryId,
              threadTs: TS_EARLY,
            }),
          ])
        : url.includes("chat.delete")
          ? slackDeleteOk()
          : undefined,
    );

    const pass = await runResolverPass(resolverDeps(store, fetchStub));

    expect(pass.examined).toBe(1);
    // The EARLIEST ts stays canonical (§6.3.2) and only the later copy is
    // deleted — the reply is never a deletion target.
    const repaired = await mustGet(store, deliveryId);
    expect(repaired.state).toBe("delivered");
    expect(repaired.slackMessageTs).toBe(TS_EARLY);
    expect(deleteCalls(calls).map((call) => call.body?.["ts"])).toEqual([
      TS_LATE,
    ]);
    expect(await store.repairedDuplicatesTotal()).toBe(1);
  });
});

// ADR §10 H10 — regression caught by an adversarial panel before the push.
// The §6.3.1 window is unreachable under resolver budget contention: N due
// ambiguous rows round-robin strictly (ambiguousRowsDue orders by updated_ms
// ASC, every attempt bumps updated_ms), so at N = 6 the per-row cadence is
// 15 min and at most 5 markers ever share a rolling hour. Without the
// lifetime ceiling NO row in this scenario reaches `manual` — the state that
// §6.5 rows 15-16 document as the outcome of a prolonged outage, and the only
// gateway to the operator menu (operatorResend/operatorCloseManual).
describe("resolver budget contention (H10 lifetime ceiling)", () => {
  it("H10: six contending ambiguous rows all reach manual although the 1 h window never closes", async () => {
    const { database, store } = makeStore();
    const deliveryIds = Array.from(
      { length: 6 },
      (_, index) => `h10-contention-${index}`,
    );
    for (const [index, deliveryId] of deliveryIds.entries()) {
      // Staggered so updated_ms is distinct and the round-robin order is
      // deterministic from the first pass.
      await seedAmbiguous(store, deliveryId, {
        sendStartMs:
          DISPATCH_TEST_NOW -
          RESOLVER_COOLING_OFF_FLOOR_MS -
          60_000 -
          (deliveryIds.length - index) * 1_000,
      });
    }
    // Prolonged outage (§6.5 row 16): every history scan fails.
    const { fetch: fetchStub } = scriptedFetch((url) =>
      url.includes("conversations.history")
        ? slackHistoryError("internal_error")
        : undefined,
    );
    // The §6.7 `*/5` cron on a synthetic clock.
    let clock = DISPATCH_TEST_NOW;
    const deps = resolverDeps(store, fetchStub, { now: () => clock });

    // 24 attempts at ceil(6 / 2) = 3 passes per attempt = 72 passes; the
    // bound leaves headroom without ever letting the loop run unbounded.
    const maxPasses = 120;
    let passes = 0;
    let escalated = 0;
    while (passes < maxPasses && escalated < deliveryIds.length) {
      await runResolverPass(deps);
      passes += 1;
      clock += 5 * 60_000;
      escalated = 0;
      for (const deliveryId of deliveryIds) {
        if ((await mustGet(store, deliveryId)).state === "manual") {
          escalated += 1;
        }
      }
    }

    expect(escalated).toBe(deliveryIds.length);
    expect(passes).toBeLessThan(maxPasses);
    // The escalation of the FIRST row proves the window never closed: it
    // parks while all six rows still contend, so its windowed count is below
    // the §6.3.1 threshold and only the lifetime ceiling can have fired.
    const firstEscalation = auditRows(database, deliveryIds[0] ?? "").find(
      (entry) => entry["to_state"] === "manual",
    );
    const evidence = JSON.parse(
      String(firstEscalation?.["evidence_json"]),
    ) as Record<string, unknown>;
    expect(Number(evidence["attempts_in_window"])).toBeLessThan(
      RESOLVER_MAX_ATTEMPTS,
    );
    expect(Number(evidence["attempts"])).toBeGreaterThanOrEqual(
      RESOLVER_LIFETIME_ATTEMPT_CEILING,
    );
  });

  it("H10: a ceiling-triggered escalation is distinguishable from a window-triggered one", async () => {
    const { database, store } = makeStore();
    const { fetch: fetchStub } = scriptedFetch((url) =>
      url.includes("conversations.history")
        ? slackHistoryError("internal_error")
        : undefined,
    );

    // Ceiling: each attempt sits alone in its own 1 h window, so the windowed
    // count never exceeds 1 and only the lifetime ceiling can escalate.
    const ceilingId = "h10-ceiling-evidence";
    const step = RESOLVER_ATTEMPT_WINDOW_MS + 60_000;
    const ceilingFirstMs =
      DISPATCH_TEST_NOW - RESOLVER_LIFETIME_ATTEMPT_CEILING * step;
    await seedAmbiguous(store, ceilingId, {
      sendStartMs: ceilingFirstMs - 60_000,
    });
    for (
      let attempt = 0;
      attempt < RESOLVER_LIFETIME_ATTEMPT_CEILING;
      attempt += 1
    ) {
      const attemptMs = ceilingFirstMs + attempt * step;
      const verdict = await resolveAmbiguousRow(
        await mustGet(store, ceilingId),
        resolverDeps(store, fetchStub, { now: () => attemptMs }),
      );
      expect(verdict.kind).toBe("inconclusive");
    }

    const ceilingRow = await mustGet(store, ceilingId);
    expect(ceilingRow.state).toBe("manual");
    expect(ceilingRow.resolverAttempts).toBe(RESOLVER_LIFETIME_ATTEMPT_CEILING);
    const ceilingEscalation = auditRows(database, ceilingId).find(
      (entry) => entry["to_state"] === "manual",
    );
    expect(ceilingEscalation?.["actor"]).toBe("resolver");
    expect(
      JSON.parse(String(ceilingEscalation?.["evidence_json"])) as Record<
        string,
        unknown
      >,
    ).toMatchObject({
      verdict: "resolver_budget_exhausted",
      reason: "resolver_lifetime_ceiling",
      lifetime_ceiling: RESOLVER_LIFETIME_ATTEMPT_CEILING,
      attempts: RESOLVER_LIFETIME_ATTEMPT_CEILING,
      attempts_in_window: 1,
      window_ms: RESOLVER_ATTEMPT_WINDOW_MS,
    });

    // Window: the PRIMARY trigger — six attempts inside one hour — must never
    // be labelled as the ceiling.
    const windowId = "h10-window-evidence";
    const windowFirstMs = DISPATCH_TEST_NOW - 50 * 60_000;
    await seedAmbiguous(store, windowId, {
      sendStartMs: windowFirstMs - 60_000,
    });
    for (let attempt = 0; attempt < RESOLVER_MAX_ATTEMPTS; attempt += 1) {
      const attemptMs = windowFirstMs + attempt * 10 * 60_000;
      await resolveAmbiguousRow(
        await mustGet(store, windowId),
        resolverDeps(store, fetchStub, { now: () => attemptMs }),
      );
    }

    expect((await mustGet(store, windowId)).state).toBe("manual");
    const windowEscalation = auditRows(database, windowId).find(
      (entry) => entry["to_state"] === "manual",
    );
    const windowEvidence = JSON.parse(
      String(windowEscalation?.["evidence_json"]),
    ) as Record<string, unknown>;
    expect(windowEvidence).toMatchObject({
      verdict: "resolver_budget_exhausted",
      attempts_in_window: RESOLVER_MAX_ATTEMPTS,
    });
    expect(windowEvidence["reason"]).toBeUndefined();
    expect(windowEvidence["lifetime_ceiling"]).toBeUndefined();
  });
});

describe("resolver scheduling (R4)", () => {
  it("R4: a history 429 Retry-After defers the row until the recorded delay elapses", async () => {
    const { store } = makeStore();
    const deliveryId = "red4-retry-after";
    await seedAmbiguous(store, deliveryId);
    const { fetch: fetchStub } = scriptedFetch((url) =>
      url.includes("conversations.history") ? slackRateLimited(120) : undefined,
    );

    const first = await runResolverPass(resolverDeps(store, fetchStub));
    expect(first.examined).toBe(1);
    const row = await mustGet(store, deliveryId);
    expect(row.state).toBe("ambiguous");
    expect(row.resolverAttempts).toBe(1);

    // Before the recorded delay elapses the row is not due and a second pass
    // examines nothing.
    const dueSoon = await store.ambiguousRowsDue(DISPATCH_TEST_NOW + 5_000, 10);
    expect(dueSoon.map((due) => due.deliveryId)).not.toContain(deliveryId);
    const second = await runResolverPass(
      resolverDeps(store, fetchStub, { now: () => DISPATCH_TEST_NOW + 5_000 }),
    );
    expect(second.examined).toBe(0);

    // Once the Retry-After delay has elapsed the row is due again.
    const dueLater = await store.ambiguousRowsDue(
      DISPATCH_TEST_NOW + 121_000,
      10,
    );
    expect(dueLater.map((due) => due.deliveryId)).toContain(deliveryId);
  });
});

describe("duplicate repair (R17)", () => {
  it("R17: two matches yield found_many — earliest ts canonical, later copy deleted, audited, counted", async () => {
    const { database, store } = makeStore();
    const deliveryId = "red17-found-many";
    const row = await seedAmbiguous(store, deliveryId);
    const { fetch: fetchStub, calls } = scriptedFetch((url) => {
      if (url.includes("conversations.history")) {
        return slackHistoryPage([
          historyMessage({ ts: TS_EARLY, deliveryId }),
          historyMessage({ ts: TS_LATE, deliveryId }),
        ]);
      }
      if (url.includes("chat.delete")) {
        return slackDeleteOk();
      }
      return undefined;
    });

    const verdict = await resolveAmbiguousRow(
      row,
      resolverDeps(store, fetchStub),
    );

    expect(verdict).toEqual({
      kind: "found_many",
      canonicalTs: TS_EARLY,
      channel: ALERTS_CHANNEL,
      duplicateTs: [TS_LATE],
    });
    const updated = await mustGet(store, deliveryId);
    expect(updated.state).toBe("delivered");
    expect(updated.slackMessageTs).toBe(TS_EARLY);

    // chat.delete for the LATER ts only.
    const deletions = deleteCalls(calls);
    expect(deletions).toHaveLength(1);
    expect(deletions[0]?.body).toMatchObject({ ts: TS_LATE });

    // Both actions audited; repaired-duplicates counter incremented.
    const entries = auditRows(database, deliveryId);
    const resolverEntries = entries.filter(
      (entry) => entry["actor"] === "resolver",
    );
    expect(resolverEntries.length).toBeGreaterThanOrEqual(2);
    expect(
      entries.some((entry) =>
        String(entry["evidence_json"]).includes(TS_EARLY),
      ),
    ).toBe(true);
    expect(
      entries.some((entry) => String(entry["evidence_json"]).includes(TS_LATE)),
    ).toBe(true);
    expect(await store.repairedDuplicatesTotal()).toBe(1);
  });

  it("F2: overlapping cursor pages repeating one ts dedupe to found — never found_many, zero deletions", async () => {
    const { store } = makeStore();
    const deliveryId = "f2-overlapping-pages";
    const row = await seedAmbiguous(store, deliveryId);
    // Copilot finding F2: cursor pages can overlap and repeat the SAME
    // message; the repeated identical ts must never mint a found_many
    // (which would chat.delete the sole canonical copy).
    let page = 0;
    const { fetch: fetchStub, calls } = scriptedFetch((url) => {
      if (!url.includes("conversations.history")) return undefined;
      page += 1;
      if (page === 1) {
        return slackHistoryPage(
          [historyMessage({ ts: TS_EARLY, deliveryId })],
          { nextCursor: "overlap-2", hasMore: true },
        );
      }
      return slackHistoryPage(
        [historyMessage({ ts: TS_EARLY, deliveryId })],
        { nextCursor: "", hasMore: false },
      );
    });

    const verdict = await resolveAmbiguousRow(
      row,
      resolverDeps(store, fetchStub),
    );

    expect(verdict).toEqual({
      kind: "found",
      ts: TS_EARLY,
      channel: ALERTS_CHANNEL,
    });
    const updated = await mustGet(store, deliveryId);
    expect(updated.state).toBe("delivered");
    expect(updated.slackMessageTs).toBe(TS_EARLY);
    expect(deleteCalls(calls)).toHaveLength(0);
    expect(await store.repairedDuplicatesTotal()).toBe(0);
  });

  it("R17: a single match never triggers chat.delete", async () => {
    const { store } = makeStore();
    const deliveryId = "red17-single-match";
    const row = await seedAmbiguous(store, deliveryId);
    const { fetch: fetchStub, calls } = scriptedFetch((url) =>
      url.includes("conversations.history")
        ? slackHistoryPage([historyMessage({ ts: TS_EARLY, deliveryId })])
        : undefined,
    );

    const verdict = await resolveAmbiguousRow(
      row,
      resolverDeps(store, fetchStub),
    );

    expect(verdict.kind).toBe("found");
    expect(deleteCalls(calls)).toHaveLength(0);
    expect(await store.repairedDuplicatesTotal()).toBe(0);
  });
});

describe("verdict CAS races and failed deletions (F3/F4/F5)", () => {
  it("F3: a found verdict whose CAS loses to a concurrent manual move lands via the late-proof rule", async () => {
    const { database, store } = makeStore();
    const deliveryId = "f3-cas-lost-to-manual";
    const row = await seedAmbiguous(store, deliveryId);
    // Copilot finding F3: the scripted fetch parks the row in manual (e.g.
    // budget exhaustion) while the scan is in flight, so the resolver's
    // markDelivered WHERE state='ambiguous' CAS matches 0 rows.
    const { fetch: fetchStub } = scriptedFetch((url) => {
      if (!url.includes("conversations.history")) return undefined;
      database
        .prepare(
          "UPDATE dispatch_outbox SET state = 'manual', updated_ms = ? WHERE delivery_id = ?",
        )
        .run(DISPATCH_TEST_NOW, deliveryId);
      return slackHistoryPage([historyMessage({ ts: TS_EARLY, deliveryId })]);
    });

    const verdict = await resolveAmbiguousRow(
      row,
      resolverDeps(store, fetchStub),
    );

    expect(verdict).toEqual({
      kind: "found",
      ts: TS_EARLY,
      channel: ALERTS_CHANNEL,
    });
    // ADR §6.3 late-proof rule: the audit carries the ts and the row ends
    // delivered via the manual -> delivered CAS.
    const updated = await mustGet(store, deliveryId);
    expect(updated.state).toBe("delivered");
    expect(updated.slackMessageTs).toBe(TS_EARLY);
    expect(updated.slackChannelId).toBe(ALERTS_CHANNEL);
    const entries = auditRows(database, deliveryId);
    expect(
      entries.some((entry) =>
        String(entry["evidence_json"]).includes('"late_proof":true'),
      ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          entry["from_state"] === "manual" &&
          entry["to_state"] === "delivered",
      ),
    ).toBe(true);
  });

  it("F4: a found_many CAS lost to a concurrent delivered(later ts) reconciles canonical and never deletes the recorded ts", async () => {
    const { database, store } = makeStore();
    const deliveryId = "f4-cas-lost-to-delivered";
    const row = await seedAmbiguous(store, deliveryId);
    // Copilot finding F4: a concurrent late proof records the LATER copy as
    // delivered while the scan is in flight.
    const { fetch: fetchStub, calls } = scriptedFetch((url) => {
      if (url.includes("chat.delete")) return slackDeleteOk();
      if (!url.includes("conversations.history")) return undefined;
      database
        .prepare(
          `UPDATE dispatch_outbox
           SET state = 'delivered', slack_message_ts = ?,
               slack_channel_id = ?, updated_ms = ?
           WHERE delivery_id = ?`,
        )
        .run(TS_LATE, ALERTS_CHANNEL, DISPATCH_TEST_NOW, deliveryId);
      return slackHistoryPage([
        historyMessage({ ts: TS_EARLY, deliveryId }),
        historyMessage({ ts: TS_LATE, deliveryId }),
      ]);
    });

    const verdict = await resolveAmbiguousRow(
      row,
      resolverDeps(store, fetchStub),
    );

    expect(verdict).toEqual({
      kind: "found_many",
      canonicalTs: TS_EARLY,
      channel: ALERTS_CHANNEL,
      duplicateTs: [TS_LATE],
    });
    // The later message — the ts recorded on the row when the CAS lost — is
    // NOT deleted; the canonical ts is reconciled to the earliest.
    expect(deleteCalls(calls)).toHaveLength(0);
    const updated = await mustGet(store, deliveryId);
    expect(updated.state).toBe("delivered");
    expect(updated.slackMessageTs).toBe(TS_EARLY);
    expect(await store.repairedDuplicatesTotal()).toBe(0);
    const entries = auditRows(database, deliveryId);
    expect(
      entries.some((entry) =>
        String(entry["evidence_json"]).includes(
          `"repaired_from":"${TS_LATE}"`,
        ),
      ),
    ).toBe(true);
    // The undeleted copy keeps a future scan (F5 pending marker + R19).
    expect(
      entries.some((entry) =>
        String(entry["evidence_json"]).includes(
          '"duplicate_repair_pending":true',
        ),
      ),
    ).toBe(true);
    expect(updated.verifyScansRemaining).toBeGreaterThanOrEqual(1);
  });

  it("F5: a failed chat.delete arms verification with a pending marker, counts nothing repaired, and a later scan completes the repair", async () => {
    const { database, store } = makeStore();
    const deliveryId = "f5-delete-failed";
    const row = await seedAmbiguous(store, deliveryId);
    // Copilot finding F5: the delete is rate-limited — the detected
    // duplicate must not be swallowed while the scan is consumed.
    const { fetch: fetchStub, calls } = scriptedFetch((url) => {
      if (url.includes("conversations.history")) {
        return slackHistoryPage([
          historyMessage({ ts: TS_EARLY, deliveryId }),
          historyMessage({ ts: TS_LATE, deliveryId }),
        ]);
      }
      if (url.includes("chat.delete")) {
        return { status: 200, body: { ok: false, error: "ratelimited" } };
      }
      return undefined;
    });

    const verdict = await resolveAmbiguousRow(
      row,
      resolverDeps(store, fetchStub),
    );

    expect(verdict.kind).toBe("found_many");
    expect(deleteCalls(calls)).toHaveLength(1);
    const updated = await mustGet(store, deliveryId);
    expect(updated.state).toBe("delivered");
    expect(updated.slackMessageTs).toBe(TS_EARLY);
    // (b) verification eligibility guaranteed for a future repair scan.
    expect(updated.verifyScansRemaining).toBeGreaterThanOrEqual(1);
    expect(updated.verifyAfterMs).toBe(
      DISPATCH_TEST_NOW + VERIFY_FIRST_SCAN_DELAY_MS,
    );
    // (a) pending marker audited; (c) the failed copy is NOT counted.
    const entries = auditRows(database, deliveryId);
    expect(
      entries.some((entry) =>
        String(entry["evidence_json"]).includes(
          '"duplicate_repair_pending":true',
        ),
      ),
    ).toBe(true);
    expect(await store.repairedDuplicatesTotal()).toBe(0);

    // A later scan with a succeeding delete completes the repair (R19).
    const later = DISPATCH_TEST_NOW + VERIFY_FIRST_SCAN_DELAY_MS;
    const { fetch: repairFetch, calls: repairCalls } = scriptedFetch((url) => {
      if (url.includes("conversations.history")) {
        return slackHistoryPage([
          historyMessage({ ts: TS_EARLY, deliveryId }),
          historyMessage({ ts: TS_LATE, deliveryId }),
        ]);
      }
      if (url.includes("chat.delete")) return slackDeleteOk();
      return undefined;
    });
    const pass = await runResolverPass(
      resolverDeps(store, repairFetch, { now: () => later }),
    );
    expect(pass.examined).toBe(1);
    const repairs = deleteCalls(repairCalls);
    expect(repairs).toHaveLength(1);
    expect(repairs[0]?.body).toMatchObject({ ts: TS_LATE });
    expect(await store.repairedDuplicatesTotal()).toBe(1);
    const final = await mustGet(store, deliveryId);
    expect(final.state).toBe("delivered");
    expect(final.slackMessageTs).toBe(TS_EARLY);
    expect(final.verifyScansRemaining).toBe(0);
  });
});

describe("partial-scan finalization (F9)", () => {
  it("F9: a partial scan with one match delivers AND arms verification with the partial marker; a later exhausted scan repairs canonical", async () => {
    const { database, store } = makeStore();
    const deliveryId = "f9-partial-found";
    const row = await seedAmbiguous(store, deliveryId);
    // Copilot finding F9: a live cursor on every page — the page budget is
    // spent with the scan explicitly PARTIAL, so unseen pages may hold an
    // earlier canonical ts. The seen match is still delivery proof (§6.2).
    let page = 0;
    const { fetch: partialFetch, calls: partialCalls } = scriptedFetch(
      (url) => {
        if (!url.includes("conversations.history")) return undefined;
        page += 1;
        return slackHistoryPage(
          [historyMessage({ ts: TS_LATE, deliveryId })],
          { nextCursor: `live-${page}`, hasMore: true },
        );
      },
    );

    const verdict = await resolveAmbiguousRow(
      row,
      resolverDeps(store, partialFetch),
    );

    expect(verdict).toEqual({
      kind: "found",
      ts: TS_LATE,
      channel: ALERTS_CHANNEL,
    });
    expect(historyCallCount(partialCalls)).toBe(RESOLVER_PAGES_PER_ROW);
    expect(deleteCalls(partialCalls)).toHaveLength(0);
    const updated = await mustGet(store, deliveryId);
    expect(updated.state).toBe("delivered");
    expect(updated.slackMessageTs).toBe(TS_LATE);
    // Verification armed with the partial-scan marker.
    expect(updated.verifyScansRemaining).toBeGreaterThanOrEqual(1);
    expect(updated.verifyAfterMs).toBe(
      DISPATCH_TEST_NOW + VERIFY_FIRST_SCAN_DELAY_MS,
    );
    const marker = auditRows(database, deliveryId).find((entry) =>
      String(entry["evidence_json"]).includes('"partial_scan":true'),
    );
    expect(marker).toBeDefined();
    expect(String(marker?.["evidence_json"])).toContain(
      '"duplicate_repair_pending":true',
    );
    expect(await store.repairedDuplicatesTotal()).toBe(0);

    // A later EXHAUSTED scan reveals the true earliest: canonical is
    // reconciled and the later copy deleted (R18/R19 machinery).
    const later = DISPATCH_TEST_NOW + VERIFY_FIRST_SCAN_DELAY_MS;
    const { fetch: fullFetch, calls: fullCalls } = scriptedFetch((url) => {
      if (url.includes("conversations.history")) {
        return slackHistoryPage([
          historyMessage({ ts: TS_EARLY, deliveryId }),
          historyMessage({ ts: TS_LATE, deliveryId }),
        ]);
      }
      if (url.includes("chat.delete")) return slackDeleteOk();
      return undefined;
    });
    const pass = await runResolverPass(
      resolverDeps(store, fullFetch, { now: () => later }),
    );
    expect(pass.examined).toBe(1);
    const final = await mustGet(store, deliveryId);
    expect(final.state).toBe("delivered");
    expect(final.slackMessageTs).toBe(TS_EARLY);
    const repairs = deleteCalls(fullCalls);
    expect(repairs).toHaveLength(1);
    expect(repairs[0]?.body).toMatchObject({ ts: TS_LATE });
    expect(await store.repairedDuplicatesTotal()).toBe(1);
    expect(
      auditRows(database, deliveryId).some((entry) =>
        String(entry["evidence_json"]).includes(
          `"repaired_from":"${TS_LATE}"`,
        ),
      ),
    ).toBe(true);
    expect(final.verifyScansRemaining).toBe(0);
  });

  it("F9: an exhausted single-match scan does not arm verification (no behavior change)", async () => {
    const { database, store } = makeStore();
    const deliveryId = "f9-exhausted-found";
    const row = await seedAmbiguous(store, deliveryId);
    const { fetch: fetchStub } = scriptedFetch((url) =>
      url.includes("conversations.history")
        ? slackHistoryPage([historyMessage({ ts: TS_EARLY, deliveryId })])
        : undefined,
    );

    const verdict = await resolveAmbiguousRow(
      row,
      resolverDeps(store, fetchStub),
    );

    expect(verdict.kind).toBe("found");
    const updated = await mustGet(store, deliveryId);
    expect(updated.state).toBe("delivered");
    expect(updated.verifyScansRemaining).toBe(0);
    expect(updated.verifyAfterMs).toBeNull();
    expect(
      auditRows(database, deliveryId).some((entry) =>
        String(entry["evidence_json"]).includes("duplicate_repair_pending"),
      ),
    ).toBe(false);
  });

  it("F9: a partial verification scan never consumes the §6.3.3 counter", async () => {
    const { store } = makeStore();
    const deliveryId = "f9-partial-verification";
    const deliveredMs = DISPATCH_TEST_NOW - VERIFY_FIRST_SCAN_DELAY_MS;
    await deliverViaOperatorResend(store, deliveryId, deliveredMs, TS_EARLY);
    let page = 0;
    const { fetch: fetchStub, calls } = scriptedFetch((url) => {
      if (!url.includes("conversations.history")) return undefined;
      page += 1;
      return slackHistoryPage(
        [historyMessage({ ts: TS_EARLY, deliveryId })],
        { nextCursor: `live-${page}`, hasMore: true },
      );
    });

    await runResolverPass(resolverDeps(store, fetchStub));

    const row = await mustGet(store, deliveryId);
    expect(row.state).toBe("delivered");
    expect(row.slackMessageTs).toBe(TS_EARLY);
    // Counter untouched; the next scan is rescheduled, not burned.
    expect(row.verifyScansRemaining).toBe(2);
    expect(row.verifyAfterMs).toBe(
      DISPATCH_TEST_NOW + VERIFY_FIRST_SCAN_DELAY_MS,
    );
    expect(deleteCalls(calls)).toHaveLength(0);
  });
});

describe("post-resend verification (R18)", () => {
  it("R18: delivery via operator resend arms two verification scans at +15 min", async () => {
    const { store } = makeStore();
    const deliveryId = "red18-armed";
    const deliveredMs = DISPATCH_TEST_NOW - 1_000;

    const row = await deliverViaOperatorResend(
      store,
      deliveryId,
      deliveredMs,
      TS_EARLY,
    );

    expect(row.state).toBe("delivered");
    expect(row.verifyScansRemaining).toBe(2);
    expect(row.verifyAfterMs).toBe(deliveredMs + VERIFY_FIRST_SCAN_DELAY_MS);
    const before = await store.verificationRowsDue(
      deliveredMs + VERIFY_FIRST_SCAN_DELAY_MS - 1,
      10,
    );
    expect(before.map((due) => due.deliveryId)).not.toContain(deliveryId);
    const due = await store.verificationRowsDue(
      deliveredMs + VERIFY_FIRST_SCAN_DELAY_MS,
      10,
    );
    expect(due.map((entry) => entry.deliveryId)).toContain(deliveryId);
  });

  it("R18: a verification scan with exactly one match decrements the counter and schedules the +24 h scan", async () => {
    const { store } = makeStore();
    const deliveryId = "red18-single-scan";
    const deliveredMs = DISPATCH_TEST_NOW - VERIFY_FIRST_SCAN_DELAY_MS;
    await deliverViaOperatorResend(store, deliveryId, deliveredMs, TS_EARLY);
    const { fetch: fetchStub, calls } = scriptedFetch((url) =>
      url.includes("conversations.history")
        ? slackHistoryPage([historyMessage({ ts: TS_EARLY, deliveryId })])
        : undefined,
    );

    await runResolverPass(resolverDeps(store, fetchStub));

    const row = await mustGet(store, deliveryId);
    expect(row.state).toBe("delivered");
    expect(row.slackMessageTs).toBe(TS_EARLY);
    expect(row.verifyScansRemaining).toBe(1);
    expect(row.verifyAfterMs).toBe(deliveredMs + VERIFY_SECOND_SCAN_DELAY_MS);
    expect(deleteCalls(calls)).toHaveLength(0);
  });

  it("R18: a multi-match during verification is repaired FROM delivered", async () => {
    const { database, store } = makeStore();
    const deliveryId = "red18-repair-from-delivered";
    const deliveredMs = DISPATCH_TEST_NOW - VERIFY_FIRST_SCAN_DELAY_MS;
    await deliverViaOperatorResend(store, deliveryId, deliveredMs, TS_LATE);
    const { fetch: fetchStub, calls } = scriptedFetch((url) => {
      if (url.includes("conversations.history")) {
        return slackHistoryPage([
          historyMessage({ ts: TS_EARLY, deliveryId }),
          historyMessage({ ts: TS_LATE, deliveryId }),
        ]);
      }
      if (url.includes("chat.delete")) {
        return slackDeleteOk();
      }
      return undefined;
    });

    await runResolverPass(resolverDeps(store, fetchStub));

    // Earliest ts becomes canonical even though the recorded delivery was the
    // later copy; the row never leaves delivered.
    const row = await mustGet(store, deliveryId);
    expect(row.state).toBe("delivered");
    expect(row.slackMessageTs).toBe(TS_EARLY);
    const deletions = deleteCalls(calls);
    expect(deletions).toHaveLength(1);
    expect(deletions[0]?.body).toMatchObject({ ts: TS_LATE });
    expect(await store.repairedDuplicatesTotal()).toBe(1);
    const entries = auditRows(database, deliveryId);
    expect(
      entries.some((entry) =>
        String(entry["evidence_json"]).includes(TS_EARLY),
      ),
    ).toBe(true);
  });

  it("R18: an inconclusive verification scan does not decrement verify_scans_remaining", async () => {
    const { store } = makeStore();
    const deliveryId = "red18-inconclusive-scan";
    const deliveredMs = DISPATCH_TEST_NOW - VERIFY_FIRST_SCAN_DELAY_MS;
    await deliverViaOperatorResend(store, deliveryId, deliveredMs, TS_EARLY);
    const { fetch: fetchStub } = scriptedFetch((url) =>
      url.includes("conversations.history")
        ? slackHistoryError("internal_error")
        : undefined,
    );

    await runResolverPass(resolverDeps(store, fetchStub));

    const row = await mustGet(store, deliveryId);
    expect(row.state).toBe("delivered");
    expect(row.slackMessageTs).toBe(TS_EARLY);
    expect(row.verifyScansRemaining).toBe(2);
  });
});

// Copilot finding (resolver starvation): due verification rows used to
// consume the entire per-run budget, and an inconclusive verification scan
// left verify_after_ms in the past — so the same two rows were selected every
// cron forever and no ambiguous row was ever examined.
describe("resolver starvation (budget reservation + deferral backoff)", () => {
  it("two due verification rows never crowd out a due ambiguous row in the same pass", async () => {
    const { store } = makeStore();
    const firstVerify = "starve-verify-first";
    const secondVerify = "starve-verify-second";
    const ambiguous = "starve-ambiguous";
    const firstTs = "1786664100.000300";
    const secondTs = "1786664100.000301";
    const ambiguousTs = "1786664100.000302";
    const deliveredMs = DISPATCH_TEST_NOW - VERIFY_FIRST_SCAN_DELAY_MS;
    // BOTH are due at DISPATCH_TEST_NOW; ordered by verify_after_ms, the
    // FIRST row is the one the reserved verification slot must select.
    await deliverViaOperatorResend(
      store,
      firstVerify,
      deliveredMs - 1_000,
      firstTs,
    );
    await deliverViaOperatorResend(store, secondVerify, deliveredMs, secondTs);
    await seedAmbiguous(store, ambiguous);
    const { fetch: fetchStub } = scriptedFetch((url) =>
      url.includes("conversations.history")
        ? slackHistoryPage([
            historyMessage({ ts: firstTs, deliveryId: firstVerify }),
            historyMessage({ ts: secondTs, deliveryId: secondVerify }),
            historyMessage({ ts: ambiguousTs, deliveryId: ambiguous }),
          ])
        : undefined,
    );

    const pass = await runResolverPass(resolverDeps(store, fetchStub));

    expect(pass.examined).toBe(2);
    // The ambiguous row WAS examined: its found verdict delivered it.
    const ambiguousRow = await mustGet(store, ambiguous);
    expect(ambiguousRow.state).toBe("delivered");
    expect(ambiguousRow.slackMessageTs).toBe(ambiguousTs);
    // Verification took at most half the budget: only the earliest-due row.
    expect((await mustGet(store, firstVerify)).verifyScansRemaining).toBe(1);
    expect((await mustGet(store, secondVerify)).verifyScansRemaining).toBe(2);
  });

  it("an inconclusive verification scan reschedules into the future, keeps the counter, and backs off further on the next one", async () => {
    const { database, store } = makeStore();
    const deliveryId = "starve-deferral-backoff";
    const deliveredMs = DISPATCH_TEST_NOW - VERIFY_FIRST_SCAN_DELAY_MS;
    await deliverViaOperatorResend(store, deliveryId, deliveredMs, TS_EARLY);
    const { fetch: fetchStub } = scriptedFetch((url) =>
      url.includes("conversations.history")
        ? slackHistoryError("internal_error")
        : undefined,
    );

    await runResolverPass(resolverDeps(store, fetchStub));

    const first = await mustGet(store, deliveryId);
    expect(first.verifyScansRemaining).toBe(2);
    expect(first.verifyAfterMs).toBe(
      DISPATCH_TEST_NOW + VERIFY_DEFERRAL_BACKOFF_BASE_MS,
    );
    expect(
      await store.verificationRowsDue(DISPATCH_TEST_NOW, 10),
    ).toHaveLength(0);

    // Second consecutive deferral, taken at the rescheduled due time.
    const secondNow = DISPATCH_TEST_NOW + VERIFY_DEFERRAL_BACKOFF_BASE_MS;
    const secondPass = await runResolverPass(
      resolverDeps(store, fetchStub, { now: () => secondNow }),
    );

    expect(secondPass.examined).toBe(1);
    const second = await mustGet(store, deliveryId);
    expect(second.verifyScansRemaining).toBe(2);
    expect(second.verifyAfterMs).toBe(
      secondNow + VERIFY_DEFERRAL_BACKOFF_BASE_MS * 2,
    );
    const markers = auditRows(database, deliveryId).filter((entry) =>
      String(entry["evidence_json"]).includes('"verification_deferred":true'),
    );
    expect(markers).toHaveLength(2);
    // Audit finding B1: the streak field is `consecutive_no_progress` — one
    // streak shared by the deferral and the duplicate-repair re-arm, because
    // two separate streaks reset each other whenever the failure kind
    // alternates (see the alternation test below).
    expect(
      markers.map(
        (entry) =>
          (
            JSON.parse(String(entry["evidence_json"])) as {
              consecutive_no_progress: number;
            }
          ).consecutive_no_progress,
      ),
    ).toEqual([1, 2]);
  });

  it("the deferral backoff is capped at 24 h", async () => {
    const { store } = makeStore();
    const deliveryId = "starve-deferral-cap";
    const deliveredMs = DISPATCH_TEST_NOW - VERIFY_FIRST_SCAN_DELAY_MS;
    await deliverViaOperatorResend(store, deliveryId, deliveredMs, TS_EARLY);
    // Seven consecutive no-progress scans already recorded: 15 min x 2^7 is
    // past the 24 h cap. Audit finding B1: the streak marker is the shared
    // `no_progress` field, and SEVEN is the last value below
    // VERIFY_NO_PROGRESS_CEILING — the eighth deferral is the one that walks
    // the ladder to its cap, and the ninth no-progress scan abandons (H14).
    for (let index = 0; index < VERIFY_NO_PROGRESS_CEILING - 1; index += 1) {
      await store.appendAudit({
        deliveryId,
        fromState: "delivered",
        toState: "delivered",
        evidenceJson: JSON.stringify({
          verification_deferred: true,
          no_progress: true,
          reason: "history_error_internal_error",
          consecutive_no_progress: index + 1,
        }),
        actor: "resolver",
        atMs: deliveredMs + index,
      });
    }
    const { fetch: fetchStub } = scriptedFetch((url) =>
      url.includes("conversations.history")
        ? slackHistoryError("internal_error")
        : undefined,
    );

    await runResolverPass(resolverDeps(store, fetchStub));

    const row = await mustGet(store, deliveryId);
    expect(row.verifyScansRemaining).toBe(2);
    expect(row.verifyAfterMs).toBe(
      DISPATCH_TEST_NOW + VERIFY_DEFERRAL_BACKOFF_CAP_MS,
    );
  });

  it("a verification scan with no match defers instead of leaving the row permanently due", async () => {
    const { store } = makeStore();
    const deliveryId = "starve-no-match";
    const deliveredMs = DISPATCH_TEST_NOW - VERIFY_FIRST_SCAN_DELAY_MS;
    await deliverViaOperatorResend(store, deliveryId, deliveredMs, TS_EARLY);
    const { fetch: fetchStub } = scriptedFetch((url) =>
      url.includes("conversations.history") ? slackHistoryPage([]) : undefined,
    );

    await runResolverPass(resolverDeps(store, fetchStub));

    const row = await mustGet(store, deliveryId);
    expect(row.verifyScansRemaining).toBe(2);
    expect(row.verifyAfterMs).toBe(
      DISPATCH_TEST_NOW + VERIFY_DEFERRAL_BACKOFF_BASE_MS,
    );
  });
});

// Audit finding B1 (BLOCKER) / ADR §10 H14 — the non-exhausted scan
// livelocked: `flagDuplicateRepairPending` re-armed it at a flat +15 min with
// no backoff, no cap and no ceiling, `completeScan` is gated on exhaustion, and
// no observer alarm matched a livelocked `delivered` row. The row re-scanned
// every 15 minutes for ever, silently, with no operator exit.
describe("B1: the non-exhausted verification scan terminates (H14)", () => {
  // Every page carries a live cursor, so the 3-page budget always runs out:
  // the scan is PARTIAL for ever, which is the livelock's precondition.
  function neverExhaustingHistory(deliveryId: string): typeof fetch {
    return scriptedFetch((url) =>
      url.includes("conversations.history")
        ? slackHistoryPage([historyMessage({ ts: TS_EARLY, deliveryId })], {
            nextCursor: "cursor-page-2",
            hasMore: true,
          })
        : undefined,
    ).fetch;
  }

  // Drives the row through consecutive no-progress scans, always at its own
  // due time, and returns the last `now` used.
  async function runNoProgressScans(
    store: D1DispatchStore,
    deliveryId: string,
    fetchStub: typeof fetch,
    count: number,
  ): Promise<number> {
    let now = DISPATCH_TEST_NOW;
    for (let scan = 0; scan < count; scan += 1) {
      const row = await mustGet(store, deliveryId);
      if (row.verifyAfterMs === null) {
        throw new Error(`row_not_armed_before_scan_${scan}`);
      }
      now = Math.max(now, row.verifyAfterMs);
      const pass = await runResolverPass(
        resolverDeps(store, fetchStub, { now: () => now }),
      );
      expect(pass.examined).toBe(1);
    }
    return now;
  }

  it("B1: a scan that can never exhaust stops re-arming at the ceiling, parks the row alarmed, and an operator sweep restarts it", async () => {
    const { database, store } = makeStore();
    const deliveryId = "b1-livelock-terminates";
    const deliveredMs = DISPATCH_TEST_NOW - VERIFY_FIRST_SCAN_DELAY_MS;
    await deliverViaOperatorResend(store, deliveryId, deliveredMs, TS_EARLY);
    const fetchStub = neverExhaustingHistory(deliveryId);

    // The ceiling's worth of re-arms: bounded backoff, capped, always armed.
    const lastArmedNow = await runNoProgressScans(
      store,
      deliveryId,
      fetchStub,
      VERIFY_NO_PROGRESS_CEILING,
    );
    const armed = await mustGet(store, deliveryId);
    expect(armed.verifyAfterMs).toBe(
      lastArmedNow + VERIFY_DEFERRAL_BACKOFF_CAP_MS,
    );
    expect(armed.verifyScansRemaining).toBe(2);

    // The next no-progress scan PARKS the row instead of re-arming it.
    const parkNow = armed.verifyAfterMs ?? lastArmedNow;
    await runResolverPass(
      resolverDeps(store, fetchStub, { now: () => parkNow }),
    );
    const parked = await mustGet(store, deliveryId);
    expect(parked.state).toBe("delivered");
    expect(parked.verifyAfterMs).toBeNull();
    // The counter survives as evidence of the unfinished verification.
    expect(parked.verifyScansRemaining).toBe(2);
    // The livelock is over: no future pass, however far ahead, selects it.
    expect(
      await store.verificationRowsDue(parkNow + 365 * 24 * 3_600_000, 10),
    ).toHaveLength(0);

    // Distinguishable audit marker...
    const marker = auditRows(database, deliveryId).at(-1);
    expect(marker).toMatchObject({ actor: "resolver", to_state: "delivered" });
    expect(JSON.parse(String(marker?.["evidence_json"]))).toMatchObject({
      verification_abandoned: true,
      consecutive_no_progress: VERIFY_NO_PROGRESS_CEILING,
    });
    // ...and an observer alarm, so the park is visible instead of silent.
    const counters = await store.statusCounters(parkNow);
    expect(counters.verificationAbandoned).toBe(1);
    expect(
      observerAlarms(
        {
          deadLetter: 0,
          manual: 0,
          oldestAmbiguousAgeMs: null,
          repairedDuplicates: counters.repairedDuplicates,
          verificationAbandoned: counters.verificationAbandoned,
        },
        null,
      ),
    ).toContain("verification_abandoned");

    // R19/H11: the operator sweep restarts verification — and clears the alarm.
    const sweepNow = parkNow + 60_000;
    expect(
      await store.operatorSweepVerification(
        deliveryId,
        sweepNow,
        JSON.stringify({ operator_action: "sweep", verification_armed: true }),
        null,
      ),
    ).toBe(true);
    const swept = await mustGet(store, deliveryId);
    expect(swept.verifyAfterMs).toBe(sweepNow);
    expect((await store.statusCounters(sweepNow)).verificationAbandoned).toBe(0);

    // The streak restarted with it: the next no-progress scan re-arms from the
    // base delay instead of parking the row again.
    await runResolverPass(
      resolverDeps(store, fetchStub, { now: () => sweepNow }),
    );
    expect((await mustGet(store, deliveryId)).verifyAfterMs).toBe(
      sweepNow + VERIFY_DEFERRAL_BACKOFF_BASE_MS,
    );
  });

  it("B1: alternating no-progress kinds still reach the ceiling — one streak, not two", async () => {
    const { database, store } = makeStore();
    const deliveryId = "b1-alternating-no-progress";
    const deliveredMs = DISPATCH_TEST_NOW - VERIFY_FIRST_SCAN_DELAY_MS;
    await deliverViaOperatorResend(store, deliveryId, deliveredMs, TS_EARLY);
    // The shape a busy channel with occasional 429s actually produces: a
    // partial scan (duplicate_repair_pending marker) alternating with a failed
    // history read (verification_deferred marker). A streak per marker kind
    // would reset the other one on every step and NEITHER would ever reach a
    // ceiling — the livelock would survive the fix.
    // The kind is flipped between PASSES (not between pages of one scan).
    let partial = true;
    const { fetch: fetchStub } = scriptedFetch((url) =>
      !url.includes("conversations.history")
        ? undefined
        : partial
          ? slackHistoryPage([historyMessage({ ts: TS_EARLY, deliveryId })], {
              nextCursor: "cursor-page-2",
              hasMore: true,
            })
          : slackHistoryError("internal_error"),
    );

    let lastArmedNow = DISPATCH_TEST_NOW;
    for (let scan = 0; scan < VERIFY_NO_PROGRESS_CEILING; scan += 1) {
      const row = await mustGet(store, deliveryId);
      expect(row.verifyAfterMs).not.toBeNull();
      lastArmedNow = Math.max(lastArmedNow, row.verifyAfterMs ?? 0);
      await runResolverPass(
        resolverDeps(store, fetchStub, { now: () => lastArmedNow }),
      );
      partial = !partial;
    }
    const markers = auditRows(database, deliveryId).filter((entry) =>
      String(entry["evidence_json"]).includes('"no_progress":true'),
    );
    // Both kinds are present, and they counted as ONE streak.
    expect(
      markers.filter((entry) =>
        String(entry["evidence_json"]).includes('"duplicate_repair_pending"'),
      ).length,
    ).toBeGreaterThan(0);
    expect(
      markers.filter((entry) =>
        String(entry["evidence_json"]).includes('"verification_deferred"'),
      ).length,
    ).toBeGreaterThan(0);
    expect(markers).toHaveLength(VERIFY_NO_PROGRESS_CEILING);

    const armed = await mustGet(store, deliveryId);
    const parkNow = armed.verifyAfterMs ?? lastArmedNow;
    await runResolverPass(
      resolverDeps(store, fetchStub, { now: () => parkNow }),
    );

    const parked = await mustGet(store, deliveryId);
    expect(parked.verifyAfterMs).toBeNull();
    expect(
      JSON.parse(String(auditRows(database, deliveryId).at(-1)?.["evidence_json"])),
    ).toMatchObject({ verification_abandoned: true });
  });
});

// Audit finding B4 — the try/catch in deleteDuplicate wrapped ONLY the fetch,
// so the unguarded appendAudit that follows it rejected on any transient D1
// error and the rejection escaped every frame up to the cron's top-level
// catch: the remaining rows of the pass were skipped.
describe("B4: one row's failure never aborts the resolver pass", () => {
  // Fails the named store method N times, then behaves normally.
  function storeWithFailing(
    store: DispatchStore,
    method: keyof DispatchStore,
    failures: number,
  ): DispatchStore {
    let remaining = failures;
    return new Proxy(store, {
      get(target, property, _receiver) {
        const value = Reflect.get(target, property, target) as unknown;
        if (typeof value !== "function") return value;
        const bound = (value as (...args: unknown[]) => unknown).bind(target);
        if (property !== method) return bound;
        return async (...args: unknown[]): Promise<unknown> => {
          if (remaining > 0) {
            remaining -= 1;
            throw new Error("d1_transient_failure");
          }
          return bound(...args);
        };
      },
    }) as DispatchStore;
  }

  it("B4: a transient failure while auditing a repair is contained — the second row is still examined and the failure is reported", async () => {
    const { store } = makeStore();
    const repairId = "b4-repair-audit-fails";
    const ambiguousId = "b4-second-row";
    const deliveredMs = DISPATCH_TEST_NOW - VERIFY_FIRST_SCAN_DELAY_MS;
    // Row 1 is a verification row that will find a duplicate — the repair path
    // whose audit append is the finding's failure point. Row 2 is a due
    // ambiguous row whose message is right there in the history.
    await deliverViaOperatorResend(store, repairId, deliveredMs, TS_EARLY);
    await seedAmbiguous(store, ambiguousId);
    const ambiguousTs = "1786664100.000700";
    const { fetch: fetchStub } = scriptedFetch((url) =>
      url.includes("conversations.history")
        ? slackHistoryPage([
            historyMessage({ ts: TS_EARLY, deliveryId: repairId }),
            historyMessage({ ts: TS_LATE, deliveryId: repairId }),
            historyMessage({ ts: ambiguousTs, deliveryId: ambiguousId }),
          ])
        : url.includes("chat.delete")
          ? slackDeleteOk()
          : undefined,
    );

    const pass = await runResolverPass({
      ...resolverDeps(store, fetchStub),
      store: storeWithFailing(store, "appendAudit", 1),
    });

    // The pass finished BOTH rows and reported nothing as failed: the repair
    // audit failure is absorbed by deleteDuplicate as "not repaired".
    expect(pass).toEqual({ examined: 2, failed: 0 });
    // The second row's verdict landed — the finding's actual damage.
    const second = await mustGet(store, ambiguousId);
    expect(second.state).toBe("delivered");
    expect(second.slackMessageTs).toBe(ambiguousTs);
    // The uncounted copy keeps a future scan armed (R19), so the repair is
    // never lost: the row stays verification-eligible.
    const repaired = await mustGet(store, repairId);
    expect(repaired.verifyScansRemaining).toBeGreaterThan(0);
    expect(repaired.verifyAfterMs).not.toBeNull();
    expect(await store.repairedDuplicatesTotal()).toBe(0);
  });

  it("B4: a row whose examination throws outright is counted and the pass continues", async () => {
    const { store } = makeStore();
    const failingId = "b4-throwing-row";
    const ambiguousId = "b4-survivor-row";
    const deliveredMs = DISPATCH_TEST_NOW - VERIFY_FIRST_SCAN_DELAY_MS;
    await deliverViaOperatorResend(store, failingId, deliveredMs, TS_EARLY);
    await seedAmbiguous(store, ambiguousId);
    const ambiguousTs = "1786664100.000701";
    const { fetch: fetchStub } = scriptedFetch((url) =>
      url.includes("conversations.history")
        ? slackHistoryPage([
            historyMessage({ ts: TS_EARLY, deliveryId: failingId }),
            historyMessage({ ts: ambiguousTs, deliveryId: ambiguousId }),
          ])
        : undefined,
    );

    // completeVerificationScan runs on the verification row only; the failure
    // therefore lands inside the FIRST examination of the pass.
    const pass = await runResolverPass({
      ...resolverDeps(store, fetchStub),
      store: storeWithFailing(store, "completeVerificationScan", 1),
    });

    expect(pass).toEqual({ examined: 2, failed: 1 });
    const survivor = await mustGet(store, ambiguousId);
    expect(survivor.state).toBe("delivered");
    expect(survivor.slackMessageTs).toBe(ambiguousTs);
    // The failed row is untouched, so the next pass re-examines it.
    const failed = await mustGet(store, failingId);
    expect(failed.verifyScansRemaining).toBe(2);
    expect(failed.verifyAfterMs).toBe(deliveredMs + VERIFY_FIRST_SCAN_DELAY_MS);
  });
});

describe("repair-from-anywhere (R19)", () => {
  it("R19: updateCanonicalTs rewrites the recorded ts on an arbitrary delivered row with audit", async () => {
    const { database, store } = makeStore();
    const deliveryId = "red19-update-canonical";
    const deliveredMs = DISPATCH_TEST_NOW - 3_600_000;
    const row = await deliverViaConsumer(
      store,
      deliveryId,
      deliveredMs,
      TS_LATE,
    );
    expect(row.verifyScansRemaining).toBe(0);

    const updatedOk = await store.updateCanonicalTs(
      deliveryId,
      DISPATCH_TEST_NOW,
      TS_EARLY,
      JSON.stringify({ repaired_from: TS_LATE, canonical: TS_EARLY }),
      // E1 enumeration / §10 H25: the caller's observed ts joins the CAS.
      row.slackMessageTs,
    );

    expect(updatedOk).toBe(true);
    const updated = await mustGet(store, deliveryId);
    expect(updated.state).toBe("delivered");
    expect(updated.slackMessageTs).toBe(TS_EARLY);
    const entries = auditRows(database, deliveryId);
    expect(
      entries.some((entry) =>
        String(entry["evidence_json"]).includes(TS_EARLY),
      ),
    ).toBe(true);
  });

  it("R19: an operator sweep over a delivered row outside any verification window applies the same multi-match repair", async () => {
    const { store } = makeStore();
    const deliveryId = "red19-sweep-repair";
    const deliveredMs = DISPATCH_TEST_NOW - 3_600_000;
    const row = await deliverViaConsumer(
      store,
      deliveryId,
      deliveredMs,
      TS_LATE,
    );
    expect(row.verifyScansRemaining).toBe(0);
    const { fetch: fetchStub, calls } = scriptedFetch((url) => {
      if (url.includes("conversations.history")) {
        return slackHistoryPage([
          historyMessage({ ts: TS_EARLY, deliveryId }),
          historyMessage({ ts: TS_LATE, deliveryId }),
        ]);
      }
      if (url.includes("chat.delete")) {
        return slackDeleteOk();
      }
      return undefined;
    });

    const verdict = await resolveAmbiguousRow(
      row,
      resolverDeps(store, fetchStub),
    );

    expect(verdict.kind).toBe("found_many");
    const updated = await mustGet(store, deliveryId);
    expect(updated.state).toBe("delivered");
    expect(updated.slackMessageTs).toBe(TS_EARLY);
    const deletions = deleteCalls(calls);
    expect(deletions).toHaveLength(1);
    expect(deletions[0]?.body).toMatchObject({ ts: TS_LATE });
    expect(await store.repairedDuplicatesTotal()).toBe(1);
  });
});

// Copilot review 4943012170 — resolver-side findings of the current HEAD.
describe("resolver hardening (rearm race, abort, Retry-After, malformed page)", () => {
  // Records the AbortSignal every call received without changing the
  // scripted responses.
  function withSignalCapture(
    inner: typeof fetch,
    sink: (AbortSignal | null | undefined)[],
  ): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      sink.push(init?.signal);
      return inner(input, init);
    }) as typeof fetch;
  }

  // Runs `after` once, right after the named store method returns — the only
  // way to place a concurrent writer INSIDE the window a finding describes.
  function storeWithHookAfter(
    store: DispatchStore,
    method: keyof DispatchStore,
    after: () => void,
  ): DispatchStore {
    let fired = false;
    return new Proxy(store, {
      get(target, property, _receiver) {
        const value = Reflect.get(target, property, target) as unknown;
        if (typeof value !== "function") return value;
        const bound = (value as (...args: unknown[]) => unknown).bind(target);
        if (property !== method) return bound;
        return async (...args: unknown[]): Promise<unknown> => {
          const result = await bound(...args);
          if (!fired) {
            fired = true;
            after();
          }
          return result;
        };
      },
    }) as DispatchStore;
  }

  it("F1 (rearm race): a stale pass cannot complete its scan against a counter another pass rearmed", async () => {
    const { store } = makeStore();
    const deliveryId = "hardening-rearm-race";
    const deliveredMs = DISPATCH_TEST_NOW - 3_600_000;
    await deliverViaConsumer(store, deliveryId, deliveredMs, TS_EARLY);
    // One scan armed and due: the shape left by a partial scan or a failed
    // duplicate deletion (flagDuplicateRepairPending).
    // B1: the due time is the CALLER's now (the flat +15 min the store used to
    // hard-code is now the resolver's bounded no-progress backoff) — the same
    // value this test always asserted.
    await store.flagDuplicateRepairPending(
      deliveryId,
      deliveredMs,
      deliveredMs + VERIFY_FIRST_SCAN_DELAY_MS,
      JSON.stringify({
        duplicate_repair_pending: true,
        partial_scan: true,
        canonical_ts: TS_EARLY,
        pending_ts: [],
      }),
      // Review finding F1 / §10 H20: the re-arm CASes on the caller's observed
      // due time and counter. A consumer delivery leaves both unset.
      null,
      0,
    );
    const staleSnapshot = await mustGet(store, deliveryId);
    expect(staleSnapshot.verifyScansRemaining).toBe(1);
    const scanNow = deliveredMs + VERIFY_FIRST_SCAN_DELAY_MS + 1_000;

    // The OTHER pass rearms first (same counter value, verify_after_ms moved
    // forward), then the stale pass completes its own scan.
    await store.flagDuplicateRepairPending(
      deliveryId,
      scanNow,
      scanNow + VERIFY_FIRST_SCAN_DELAY_MS,
      JSON.stringify({
        duplicate_repair_pending: true,
        partial_scan: true,
        canonical_ts: TS_EARLY,
        pending_ts: [TS_LATE],
      }),
      // F1 / H20: the OTHER pass holds the current snapshot, so its re-arm
      // applies — the guard refuses stale writers, never current ones.
      staleSnapshot.verifyAfterMs,
      staleSnapshot.verifyScansRemaining,
    );
    const rearmed = await mustGet(store, deliveryId);
    expect(rearmed.verifyScansRemaining).toBe(1);
    expect(rearmed.verifyAfterMs).toBe(scanNow + VERIFY_FIRST_SCAN_DELAY_MS);

    const { fetch: fetchStub } = scriptedFetch((url) =>
      url.includes("conversations.history")
        ? slackHistoryPage([historyMessage({ ts: TS_EARLY, deliveryId })])
        : undefined,
    );
    const verdict = await resolveAmbiguousRow(
      staleSnapshot,
      resolverDeps(store, fetchStub, { now: () => scanNow }),
    );

    expect(verdict.kind).toBe("found");
    // The rearm survives: the scan is still armed and still due at the
    // rearmed time — the stale completion consumed nothing.
    const afterStale = await mustGet(store, deliveryId);
    expect(afterStale.verifyScansRemaining).toBe(1);
    expect(afterStale.verifyAfterMs).toBe(scanNow + VERIFY_FIRST_SCAN_DELAY_MS);

    // Positive control: a pass holding the CURRENT snapshot still completes.
    const freshNow = rearmed.verifyAfterMs! + 1_000;
    await resolveAmbiguousRow(
      await mustGet(store, deliveryId),
      resolverDeps(store, fetchStub, { now: () => freshNow }),
    );
    const afterFresh = await mustGet(store, deliveryId);
    expect(afterFresh.verifyScansRemaining).toBe(0);
  });

  it("F1 (rearm race): an operator sweep stamped at the stale pass's own due time is not consumed by it", async () => {
    const { store } = makeStore();
    const deliveryId = "hardening-sweep-same-due-time";
    const deliveredMs = DISPATCH_TEST_NOW - 3_600_000;
    await deliverViaConsumer(store, deliveryId, deliveredMs, TS_EARLY);
    await store.flagDuplicateRepairPending(
      deliveryId,
      deliveredMs,
      deliveredMs + VERIFY_FIRST_SCAN_DELAY_MS,
      JSON.stringify({
        duplicate_repair_pending: true,
        canonical_ts: TS_EARLY,
        pending_ts: [],
      }),
      // F1 / H20: a consumer delivery leaves no due time and no scans.
      null,
      0,
    );
    const staleSnapshot = await mustGet(store, deliveryId);
    // The pass reads the row exactly at its due time — the ONE value an
    // operator sweep stamps too (verify_after_ms = now), so the sweep cannot
    // rely on moving the due time forward to protect its scan.
    const scanNow = staleSnapshot.verifyAfterMs ?? DISPATCH_TEST_NOW;

    expect(
      await store.operatorSweepVerification(
        deliveryId,
        scanNow,
        JSON.stringify({ operator_action: "sweep", verification_armed: true }),
        null,
      ),
    ).toBe(true);
    const swept = await mustGet(store, deliveryId);
    expect(swept.verifyAfterMs).toBe(scanNow);
    expect(swept.verifyScansRemaining).toBe(
      staleSnapshot.verifyScansRemaining + 1,
    );

    const { fetch: fetchStub } = scriptedFetch((url) =>
      url.includes("conversations.history")
        ? slackHistoryPage([historyMessage({ ts: TS_EARLY, deliveryId })])
        : undefined,
    );
    await resolveAmbiguousRow(
      staleSnapshot,
      resolverDeps(store, fetchStub, { now: () => scanNow }),
    );

    // The operator's scan survives, still due, still uncounted.
    const after = await mustGet(store, deliveryId);
    expect(after.verifyScansRemaining).toBe(swept.verifyScansRemaining);
    expect(after.verifyAfterMs).toBe(scanNow);
  });

  it("F2 (unbounded fetch): the history scan carries the 30 s abort signal and a timeout is inconclusive", async () => {
    const { store } = makeStore();
    const deliveryId = "hardening-history-abort";
    const row = await seedAmbiguous(store, deliveryId);
    const signals: (AbortSignal | null | undefined)[] = [];
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const abortingFetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      signals.push(init?.signal);
      throw new DOMException("history stalled", "TimeoutError");
    }) as typeof fetch;

    try {
      const verdict = await resolveAmbiguousRow(
        row,
        resolverDeps(store, abortingFetch),
      );

      expect(verdict).toEqual({
        kind: "inconclusive",
        reason: "history_fetch_failed_TimeoutError",
      });
      expect(signals).toHaveLength(1);
      expect(signals[0]).toBeInstanceOf(AbortSignal);
      expect(timeoutSpy).toHaveBeenCalledWith(DISPATCH_CLIENT_TIMEOUT_MS);
    } finally {
      timeoutSpy.mockRestore();
    }
    // Never proven-absent: the row stays ambiguous with the attempt counted.
    const updated = await mustGet(store, deliveryId);
    expect(updated.state).toBe("ambiguous");
    expect(updated.resolverAttempts).toBe(1);
  });

  it("F2 (unbounded fetch): the chat.delete repair call carries the same abort signal", async () => {
    const { store } = makeStore();
    const deliveryId = "hardening-delete-abort";
    const row = await seedAmbiguous(store, deliveryId);
    const signals: (AbortSignal | null | undefined)[] = [];
    const { fetch: fetchStub } = scriptedFetch((url) => {
      if (url.includes("conversations.history")) {
        return slackHistoryPage([
          historyMessage({ ts: TS_EARLY, deliveryId }),
          historyMessage({ ts: TS_LATE, deliveryId }),
        ]);
      }
      if (url.includes("chat.delete")) return slackDeleteOk();
      return undefined;
    });

    const verdict = await resolveAmbiguousRow(
      row,
      resolverDeps(store, withSignalCapture(fetchStub, signals)),
    );

    expect(verdict.kind).toBe("found_many");
    expect(signals).toHaveLength(2);
    for (const signal of signals) {
      expect(signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("F3 (Retry-After discarded): a verification 429 defers by the header when it exceeds the backoff", async () => {
    const { database, store } = makeStore();
    const deliveryId = "hardening-verify-retry-after";
    const deliveredMs = DISPATCH_TEST_NOW - VERIFY_FIRST_SCAN_DELAY_MS;
    await deliverViaOperatorResend(store, deliveryId, deliveredMs, TS_EARLY);
    // Two hours: far past the 15 min first backoff step, so the header wins.
    const retryAfterSeconds = 2 * 60 * 60;
    const { fetch: fetchStub } = scriptedFetch((url) =>
      url.includes("conversations.history")
        ? slackRateLimited(retryAfterSeconds)
        : undefined,
    );

    await runResolverPass(resolverDeps(store, fetchStub));

    const row = await mustGet(store, deliveryId);
    // §6.3.3: the deferral never decrements the counter.
    expect(row.verifyScansRemaining).toBe(2);
    expect(row.verifyAfterMs).toBe(
      DISPATCH_TEST_NOW + retryAfterSeconds * 1_000,
    );
    const marker = auditRows(database, deliveryId).find((entry) =>
      String(entry["evidence_json"]).includes('"verification_deferred":true'),
    );
    expect(JSON.parse(String(marker?.["evidence_json"]))).toMatchObject({
      reason: "history_http_429",
      retry_after_ms: retryAfterSeconds * 1_000,
    });
  });

  // Review finding B (class E7) / ADR §10 H31, on the RESOLVER's own call. The
  // fix moved `const now = deps.now()` below `scanHistory`, but nothing pinned
  // it: moving the sample back above the scan broke no test, which makes the
  // fix a coincidence rather than a guarantee. This test is the guarantee. The
  // scan is charged real time here, exactly as a slow Slack charges it — up to
  // RESOLVER_PAGES_PER_ROW requests, each with a 30 s abort — so a deadline
  // anchored at pass start lands SCAN_COST_MS early and the assertion fails.
  it("E7: a history 429 defers from the instant the scan returned, not from the pass start", async () => {
    const { store } = makeStore();
    const deliveryId = "e7-clock-sampled-after-scan";
    const deliveredMs = DISPATCH_TEST_NOW - VERIFY_FIRST_SCAN_DELAY_MS;
    await deliverViaOperatorResend(store, deliveryId, deliveredMs, TS_EARLY);
    const retryAfterSeconds = 2 * 60 * 60;
    const SCAN_COST_MS = 25_000;
    let elapsedMs = 0;
    const { fetch: fetchStub } = scriptedFetch((url) => {
      if (!url.includes("conversations.history")) return undefined;
      elapsedMs += SCAN_COST_MS;
      return slackRateLimited(retryAfterSeconds);
    });

    await runResolverPass(
      resolverDeps(store, fetchStub, {
        now: () => DISPATCH_TEST_NOW + elapsedMs,
      }),
    );

    const row = await mustGet(store, deliveryId);
    // The row is selected as due at the pass-start instant, so the scan cost
    // cannot come from the selection: it is in the deadline only because the
    // clock was read after the response.
    expect(row.verifyAfterMs).toBe(
      DISPATCH_TEST_NOW + SCAN_COST_MS + retryAfterSeconds * 1_000,
    );
    expect(row.verifyScansRemaining).toBe(2);
  });

  it("F3 (Retry-After discarded): a shorter Retry-After keeps the bounded backoff", async () => {
    const { store } = makeStore();
    const deliveryId = "hardening-verify-retry-after-small";
    const deliveredMs = DISPATCH_TEST_NOW - VERIFY_FIRST_SCAN_DELAY_MS;
    await deliverViaOperatorResend(store, deliveryId, deliveredMs, TS_EARLY);
    const { fetch: fetchStub } = scriptedFetch((url) =>
      url.includes("conversations.history") ? slackRateLimited(60) : undefined,
    );

    await runResolverPass(resolverDeps(store, fetchStub));

    const row = await mustGet(store, deliveryId);
    expect(row.verifyScansRemaining).toBe(2);
    expect(row.verifyAfterMs).toBe(
      DISPATCH_TEST_NOW + VERIFY_DEFERRAL_BACKOFF_BASE_MS,
    );
  });

  // Review finding N3 (ADR §10 H24): the resolver's own copy of the conversion
  // carried the same pre-multiplication overflow. On a VERIFICATION row the
  // damage is worse than on an ambiguous one: an unreachable verify_after_ms
  // never comes due, so the row is never scanned again AND never reaches
  // H14's no-progress ceiling — it can never raise `verification_abandoned`.
  it("N3: an overflowing Retry-After on a verification 429 still schedules a reachable scan", async () => {
    const cases: Array<[string, number, number]> = [
      // Infinity in ms: absent header, so the bounded backoff governs.
      [
        "n3-verify-retry-overflow",
        1e308,
        DISPATCH_TEST_NOW + VERIFY_DEFERRAL_BACKOFF_BASE_MS,
      ],
      // Finite but absurd: clamped to the documented ceiling.
      [
        "n3-verify-retry-huge",
        1e12,
        DISPATCH_TEST_NOW + RETRY_AFTER_CEILING_MS,
      ],
    ];
    for (const [deliveryId, retryAfterSeconds, expected] of cases) {
      const { store } = makeStore();
      const deliveredMs = DISPATCH_TEST_NOW - VERIFY_FIRST_SCAN_DELAY_MS;
      await deliverViaOperatorResend(store, deliveryId, deliveredMs, TS_EARLY);
      const { fetch: fetchStub } = scriptedFetch((url) =>
        url.includes("conversations.history")
          ? slackRateLimited(retryAfterSeconds)
          : undefined,
      );

      await runResolverPass(resolverDeps(store, fetchStub));

      const row = await mustGet(store, deliveryId);
      // §6.3.3: a deferral never decrements the counter...
      expect(row.verifyScansRemaining).toBe(2);
      // ...and the row stays REACHABLE: finite, and inside the ceiling.
      expect(row.verifyAfterMs).toBe(expected);
      expect(Number.isFinite(row.verifyAfterMs ?? Number.NaN)).toBe(true);
      expect(row.verifyAfterMs ?? Number.NaN).toBeLessThanOrEqual(
        DISPATCH_TEST_NOW + RETRY_AFTER_CEILING_MS,
      );
    }
  });

  it("F4 (found_many vs recordLateProof): an audit_only race still arms duplicate repair", async () => {
    const { database, store } = makeStore();
    const deliveryId = "hardening-found-many-audit-only";
    const row = await seedAmbiguous(store, deliveryId);
    // (1) While the history call is in flight, an operator resend moves the
    // row out of `ambiguous`, so the found_many CAS loses.
    const { fetch: fetchStub } = scriptedFetch((url) => {
      if (url.includes("conversations.history")) {
        database
          .prepare(
            "UPDATE dispatch_outbox SET state = 'queued' WHERE delivery_id = ?",
          )
          .run(deliveryId);
        return slackHistoryPage([
          historyMessage({ ts: TS_EARLY, deliveryId }),
          historyMessage({ ts: TS_LATE, deliveryId }),
        ]);
      }
      if (url.includes("chat.delete")) return slackDeleteOk();
      return undefined;
    });
    // (2) Between the re-read (which sees `queued`) and recordLateProof,
    // ANOTHER resolver delivers the row — so both late-proof CASes fail and
    // the proof is audit_only.
    const racingStore = storeWithHookAfter(store, "get", () => {
      database
        .prepare(
          `UPDATE dispatch_outbox
           SET state = 'delivered',
               slack_message_ts = ?,
               slack_channel_id = ?
           WHERE delivery_id = ?`,
        )
        .run(TS_LATE, ALERTS_CHANNEL, deliveryId);
    });

    const verdict = await resolveAmbiguousRow(row, {
      ...resolverDeps(store, fetchStub),
      store: racingStore,
    });

    expect(verdict.kind).toBe("found_many");
    // The winning resolver may have seen only ONE message: this pass is the
    // only witness of the duplicate, so it must leave the repair armed.
    const updated = await mustGet(store, deliveryId);
    expect(updated.state).toBe("delivered");
    expect(updated.verifyScansRemaining).toBeGreaterThanOrEqual(1);
    expect(updated.verifyAfterMs).toBe(
      DISPATCH_TEST_NOW + VERIFY_FIRST_SCAN_DELAY_MS,
    );
    const pending = auditRows(database, deliveryId).find((entry) =>
      String(entry["evidence_json"]).includes('"duplicate_repair_pending":true'),
    );
    expect(JSON.parse(String(pending?.["evidence_json"]))).toMatchObject({
      duplicate_repair_pending: true,
      canonical_ts: TS_EARLY,
      pending_ts: [TS_LATE],
    });
    // Nothing was deleted this pass — a later scan completes the repair (R19).
    expect(await store.repairedDuplicatesTotal()).toBe(0);
  });

  it("F7 (malformed page): ok:true without a messages array is inconclusive, never exhaustion", async () => {
    const { store } = makeStore();
    const deliveryId = "hardening-page-no-messages";
    const row = await seedAmbiguous(store, deliveryId);
    const { fetch: fetchStub } = scriptedFetch((url) =>
      url.includes("conversations.history")
        ? {
            status: 200,
            body: { ok: true, has_more: false, response_metadata: {} },
          }
        : undefined,
    );

    const verdict = await resolveAmbiguousRow(
      row,
      resolverDeps(store, fetchStub),
    );

    expect(verdict).toEqual({
      kind: "inconclusive",
      reason: "history_malformed_page",
    });
    const updated = await mustGet(store, deliveryId);
    expect(updated.state).toBe("ambiguous");
    expect(updated.resolverAttempts).toBe(1);
  });

  it("F7 (malformed page): a non-boolean or missing has_more is inconclusive, never exhaustion", async () => {
    const { store } = makeStore();
    for (const [deliveryId, body] of [
      [
        "hardening-page-string-has-more",
        { ok: true, messages: [], has_more: "false" },
      ],
      ["hardening-page-missing-has-more", { ok: true, messages: [] }],
    ] as const) {
      const row = await seedAmbiguous(store, deliveryId);
      const { fetch: fetchStub } = scriptedFetch((url) =>
        url.includes("conversations.history")
          ? { status: 200, body }
          : undefined,
      );

      const verdict = await resolveAmbiguousRow(
        row,
        resolverDeps(store, fetchStub),
      );

      expect(verdict).toEqual({
        kind: "inconclusive",
        reason: "history_malformed_page",
      });
      // The verdict that would have been manufactured is proven_absent: the
      // row must NOT be parked in manual by an unreadable page.
      expect((await mustGet(store, deliveryId)).state).toBe("ambiguous");
    }
  });

  it("F7 (malformed page): a well-formed exhausted page still proves absence", async () => {
    const { store } = makeStore();
    const deliveryId = "hardening-page-well-formed";
    const row = await seedAmbiguous(store, deliveryId);
    const { fetch: fetchStub } = scriptedFetch((url) =>
      url.includes("conversations.history") ? slackHistoryPage([]) : undefined,
    );

    const verdict = await resolveAmbiguousRow(
      row,
      resolverDeps(store, fetchStub),
    );

    expect(verdict.kind).toBe("proven_absent");
    expect((await mustGet(store, deliveryId)).state).toBe("manual");
  });

  // Copilot suppressed comment (F1, SEVERE): a history entry whose metadata
  // MATCHES the delivery but whose `ts` is missing was ignored, so an
  // exhausted scan could manufacture proven_absent for a message that is
  // present; and a non-empty malformed ts was accepted, later violating
  // migration 0010's slack_message_ts CHECK and aborting the resolver pass.
  // Both are now one INCONCLUSIVE malformed scan.
  it("suppressed F1 (malformed match): a matching entry with no ts is inconclusive, never proven_absent", async () => {
    const { store } = makeStore();
    const deliveryId = "suppressed-f1-match-without-ts";
    const row = await seedAmbiguous(store, deliveryId);
    const { fetch: fetchStub } = scriptedFetch((url) =>
      url.includes("conversations.history")
        ? {
            status: 200,
            body: {
              ok: true,
              has_more: false,
              response_metadata: { next_cursor: "" },
              messages: [
                {
                  type: "message",
                  text: "matching entry with no ts",
                  metadata: {
                    event_type: DISPATCH_METADATA_EVENT_TYPE,
                    event_payload: { delivery_id: deliveryId },
                  },
                },
              ],
            },
          }
        : undefined,
    );

    const verdict = await resolveAmbiguousRow(
      row,
      resolverDeps(store, fetchStub),
    );

    expect(verdict).toEqual({
      kind: "inconclusive",
      reason: "history_malformed_match",
    });
    const updated = await mustGet(store, deliveryId);
    // The verdict that would have been manufactured is proven_absent.
    expect(updated.state).toBe("ambiguous");
    expect(updated.slackMessageTs).toBeNull();
    expect(updated.resolverAttempts).toBe(1);
  });

  it("suppressed F1 (malformed match): a matching entry with a non-canonical ts is inconclusive and never persisted", async () => {
    const { store } = makeStore();
    const deliveryId = "suppressed-f1-match-malformed-ts";
    const row = await seedAmbiguous(store, deliveryId);
    const { fetch: fetchStub } = scriptedFetch((url) =>
      url.includes("conversations.history")
        ? slackHistoryPage([
            historyMessage({ ts: "x", deliveryId }),
          ])
        : undefined,
    );

    const verdict = await resolveAmbiguousRow(
      row,
      resolverDeps(store, fetchStub),
    );

    expect(verdict).toEqual({
      kind: "inconclusive",
      reason: "history_malformed_match",
    });
    const updated = await mustGet(store, deliveryId);
    expect(updated.state).toBe("ambiguous");
    // A malformed ts never reaches the row: migration 0010 CHECKs the column,
    // so persisting it would abort the whole resolver pass.
    expect(updated.slackMessageTs).toBeNull();
  });

  it("suppressed F1 (malformed match): a well-formed match is still FOUND", async () => {
    const { store } = makeStore();
    const deliveryId = "suppressed-f1-well-formed-match";
    const row = await seedAmbiguous(store, deliveryId);
    const { fetch: fetchStub } = scriptedFetch((url) =>
      url.includes("conversations.history")
        ? slackHistoryPage([historyMessage({ ts: TS_EARLY, deliveryId })])
        : undefined,
    );

    const verdict = await resolveAmbiguousRow(
      row,
      resolverDeps(store, fetchStub),
    );

    expect(verdict).toEqual({
      kind: "found",
      ts: TS_EARLY,
      channel: ALERTS_CHANNEL,
    });
    expect(await mustGet(store, deliveryId)).toMatchObject({
      state: "delivered",
      slackMessageTs: TS_EARLY,
    });
  });

  it("suppressed F1 (malformed match): a NON-matching entry without a ts is skipped silently and absence still proves", async () => {
    const { store } = makeStore();
    const deliveryId = "suppressed-f1-non-matching-entry";
    const row = await seedAmbiguous(store, deliveryId);
    const { fetch: fetchStub } = scriptedFetch((url) =>
      url.includes("conversations.history")
        ? {
            status: 200,
            body: {
              ok: true,
              has_more: false,
              response_metadata: { next_cursor: "" },
              messages: [
                {
                  type: "message",
                  text: "someone else's delivery, no ts",
                  metadata: {
                    event_type: DISPATCH_METADATA_EVENT_TYPE,
                    event_payload: { delivery_id: "another-delivery" },
                  },
                },
              ],
            },
          }
        : undefined,
    );

    const verdict = await resolveAmbiguousRow(
      row,
      resolverDeps(store, fetchStub),
    );

    // The guard is scoped to entries that identify THIS delivery: a foreign
    // entry never turns a scan inconclusive.
    expect(verdict.kind).toBe("proven_absent");
    expect((await mustGet(store, deliveryId)).state).toBe("manual");
  });
});

// Review finding F1 (ADR §10 H20) — flagDuplicateRepairPending was the ONE
// no-progress writer without a snapshot guard, while completeVerificationScan,
// deferVerificationScan and abandonVerification all carry one. An operator
// sweep (H11) landing after the pass's read stamps verify_after_ms = now to
// force a due-now scan; the stale pass's re-arm overwrote it with its backoff
// and postponed exactly the scan the sweep promised.
describe("F1: the duplicate-repair re-arm carries the caller's snapshot", () => {
  it("F1: an operator sweep landing after the pass's read is not postponed by the re-arm", async () => {
    const { database, store } = makeStore();
    const deliveryId = "f1-sweep-vs-rearm";
    const scanNow = DISPATCH_TEST_NOW;
    // Delivered through the only resend path: two scans armed, the first due
    // 60 s ago — so the sweep's `now` differs from the row's due time and the
    // sweep is not H11's rejected no-op case.
    const deliveredMs = scanNow - VERIFY_FIRST_SCAN_DELAY_MS - 60_000;
    await deliverViaOperatorResend(store, deliveryId, deliveredMs, TS_EARLY);
    const staleSnapshot = await mustGet(store, deliveryId);
    expect(staleSnapshot.verifyScansRemaining).toBe(2);
    expect(staleSnapshot.verifyAfterMs).toBe(scanNow - 60_000);

    // The sweep lands INSIDE the scan — after this pass read the row, before
    // it writes. A partial page (live cursor) sends the pass to the re-arm.
    let sweptOnce = false;
    const partialPage = slackHistoryPage(
      [historyMessage({ ts: TS_EARLY, deliveryId })],
      { nextCursor: "cursor-1", hasMore: true },
    );
    const sweepDuringScan = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.includes("conversations.history")) {
        throw new Error(`unscripted_fetch:${url}`);
      }
      if (!sweptOnce) {
        sweptOnce = true;
        expect(
          await store.operatorSweepVerification(
            deliveryId,
            scanNow,
            JSON.stringify({
              operator_action: "sweep",
              verification_armed: true,
            }),
            null,
          ),
        ).toBe(true);
      }
      return new Response(JSON.stringify(partialPage.body), {
        status: partialPage.status,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const verdict = await resolveAmbiguousRow(
      staleSnapshot,
      resolverDeps(store, sweepDuringScan, { now: () => scanNow }),
    );

    expect(verdict.kind).toBe("found");
    expect(sweptOnce).toBe(true);
    // The sweep's promise is a scan armed and due NOW; the stale re-arm must
    // not push it to now + backoff.
    const after = await mustGet(store, deliveryId);
    expect(after.verifyAfterMs).toBe(scanNow);
    expect(after.verifyScansRemaining).toBe(2);
    // The re-arm's audit row shares the CAS predicate, so a refused re-arm
    // leaves no pending marker behind either (§6.1).
    expect(
      auditRows(database, deliveryId).filter((entry) =>
        String(entry["evidence_json"]).includes('"duplicate_repair_pending"'),
      ),
    ).toHaveLength(0);

    // Positive control: the guard refuses STALE writers, not current ones — a
    // pass holding the swept snapshot re-arms with the ordinary backoff.
    const freshNow = scanNow + 1_000;
    await resolveAmbiguousRow(
      await mustGet(store, deliveryId),
      resolverDeps(store, sweepDuringScan, { now: () => freshNow }),
    );
    const rearmed = await mustGet(store, deliveryId);
    expect(rearmed.verifyAfterMs).toBe(
      freshNow + VERIFY_DEFERRAL_BACKOFF_BASE_MS,
    );
    expect(
      auditRows(database, deliveryId).filter((entry) =>
        String(entry["evidence_json"]).includes('"duplicate_repair_pending"'),
      ),
    ).toHaveLength(1);
  });
});

// E1 enumeration (ADR §10 H25) — updateCanonicalTs was the second CAS whose
// predicate did not encode the value its caller decided from. A pass whose
// scan was PARTIAL could overwrite an EARLIER canonical ts recorded by a fuller
// concurrent scan, regressing the row to a later copy — the inverse of
// §6.3.2's "the EARLIEST ts is canonical".
describe("H25: the canonical-ts repair carries the caller's observed ts", () => {
  it("H25: a stale repair cannot overwrite an earlier canonical ts recorded meanwhile", async () => {
    const { store } = makeStore();
    const deliveryId = "h25-canonical-regression";
    const TS_EARLIEST = "1786663000.000050";
    const deliveredMs = DISPATCH_TEST_NOW - 3_600_000;
    // The row records the LATE copy; this pass's scan saw TS_EARLY and will
    // try to record it.
    const staleSnapshot = await deliverViaConsumer(
      store,
      deliveryId,
      deliveredMs,
      TS_LATE,
    );

    // A fuller concurrent scan lands first with the TRUE earliest ts.
    expect(
      await store.updateCanonicalTs(
        deliveryId,
        DISPATCH_TEST_NOW,
        TS_EARLIEST,
        JSON.stringify({ canonical_ts: TS_EARLIEST }),
        staleSnapshot.slackMessageTs,
      ),
    ).toBe(true);

    // The stale pass then applies its own, LATER canonical against the ts it
    // observed at pass start.
    const stale = await store.updateCanonicalTs(
      deliveryId,
      DISPATCH_TEST_NOW + 1_000,
      TS_EARLY,
      JSON.stringify({ canonical_ts: TS_EARLY }),
      staleSnapshot.slackMessageTs,
    );

    expect(stale).toBe(false);
    // §6.3.2 holds: the EARLIEST ts stays recorded.
    expect((await mustGet(store, deliveryId)).slackMessageTs).toBe(TS_EARLIEST);

    // Positive control: a pass holding the CURRENT ts still repairs.
    expect(
      await store.updateCanonicalTs(
        deliveryId,
        DISPATCH_TEST_NOW + 2_000,
        TS_EARLY,
        JSON.stringify({ canonical_ts: TS_EARLY }),
        TS_EARLIEST,
      ),
    ).toBe(true);
    expect((await mustGet(store, deliveryId)).slackMessageTs).toBe(TS_EARLY);
  });
});

// Review finding F2 (ADR §10 H21) — chat.delete is the dispatcher's one
// IRREVERSIBLE egress: once it returns ok the ts is gone from Slack, so a
// repair record that fails to land afterwards can never be rebuilt by a later
// history scan (the evidence such a scan looks for is exactly what was
// deleted). The deletion intent is therefore durable BEFORE the call and
// reconciled to an outcome after it.
describe("F2: every duplicate deletion is recorded before the call", () => {
  // Fails appendAudit only for markers matching `match` — the interleaving a
  // call-count proxy cannot express, since the intent and the completion both
  // go through appendAudit.
  function storeFailingAuditMatching(
    store: DispatchStore,
    match: string,
  ): DispatchStore {
    return new Proxy(store, {
      get(target, property, _receiver) {
        const value = Reflect.get(target, property, target) as unknown;
        if (typeof value !== "function") return value;
        const bound = (value as (...args: unknown[]) => unknown).bind(target);
        if (property !== "appendAudit") return bound;
        return async (...args: unknown[]): Promise<unknown> => {
          const entry = args[0] as { evidenceJson: string };
          if (entry.evidenceJson.includes(match)) {
            throw new Error("d1_transient_failure");
          }
          return bound(...args);
        };
      },
    }) as DispatchStore;
  }

  async function deliveredWithVerification(
    store: D1DispatchStore,
    deliveryId: string,
  ): Promise<DispatchOutboxRow> {
    return deliverViaOperatorResend(
      store,
      deliveryId,
      DISPATCH_TEST_NOW - VERIFY_FIRST_SCAN_DELAY_MS,
      TS_EARLY,
    );
  }

  function duplicateHistory(
    deliveryId: string,
    deleteResponse: FixtureResponse,
  ): { fetch: typeof fetch; calls: RecordedSlackCall[] } {
    return scriptedFetch((url) => {
      if (url.includes("conversations.history")) {
        return slackHistoryPage([
          historyMessage({ ts: TS_EARLY, deliveryId }),
          historyMessage({ ts: TS_LATE, deliveryId }),
        ]);
      }
      if (url.includes("chat.delete")) return deleteResponse;
      return undefined;
    });
  }

  it("F2: a deletion whose repair record never lands stays counted and alarmed", async () => {
    const { database, store } = makeStore();
    const deliveryId = "f2-completion-audit-lost";
    const row = await deliveredWithVerification(store, deliveryId);
    const { fetch: fetchStub, calls } = duplicateHistory(
      deliveryId,
      slackDeleteOk(),
    );

    const verdict = await resolveAmbiguousRow(row, {
      ...resolverDeps(store, fetchStub),
      store: storeFailingAuditMatching(store, '"repaired_duplicate"'),
    });

    expect(verdict.kind).toBe("found_many");
    // The copy IS gone from Slack: no later scan can rediscover it.
    expect(deleteCalls(calls).map((call) => call.body?.["ts"])).toEqual([
      TS_LATE,
    ]);
    expect(await store.repairedDuplicatesTotal()).toBe(0);
    // The intent recorded BEFORE the call is the surviving evidence.
    const intents = auditRows(database, deliveryId).filter((entry) =>
      String(entry["evidence_json"]).includes('"duplicate_deletion_intent"'),
    );
    expect(intents).toHaveLength(1);
    expect(JSON.parse(String(intents[0]?.["evidence_json"]))).toMatchObject({
      duplicate_deletion_intent: true,
      canonical_ts: TS_EARLY,
      target_ts: TS_LATE,
    });
    // Countable...
    const counters = await store.statusCounters(DISPATCH_TEST_NOW);
    expect(counters.unreconciledDeletionIntents).toBe(1);
    // ...and alarmed (§6.7): the ADR requires every deletion to be BOTH.
    expect(
      observerAlarms(
        {
          deadLetter: 0,
          manual: 0,
          oldestAmbiguousAgeMs: null,
          repairedDuplicates: counters.repairedDuplicates,
          unreconciledDeletionIntents: counters.unreconciledDeletionIntents,
        },
        null,
      ),
    ).toContain("duplicate_deletion_unreconciled");
  });

  it("F2: a chat.delete that did not succeed reconciles its own intent — no alarm for a copy still in Slack", async () => {
    const { database, store } = makeStore();
    const deliveryId = "f2-delete-refused";
    const row = await deliveredWithVerification(store, deliveryId);
    const { fetch: fetchStub } = duplicateHistory(deliveryId, {
      status: 200,
      body: { ok: false, error: "cant_delete_message" },
    });

    await resolveAmbiguousRow(row, resolverDeps(store, fetchStub));

    const entries = auditRows(database, deliveryId).map((entry) =>
      String(entry["evidence_json"]),
    );
    expect(
      entries.filter((json) => json.includes('"duplicate_deletion_intent"')),
    ).toHaveLength(1);
    expect(
      entries.filter((json) =>
        json.includes('"duplicate_deletion_not_applied"'),
      ),
    ).toHaveLength(1);
    // The copy survived, so this is NOT an unrecorded deletion.
    expect(
      (await store.statusCounters(DISPATCH_TEST_NOW))
        .unreconciledDeletionIntents,
    ).toBe(0);
    expect(await store.repairedDuplicatesTotal()).toBe(0);
    // R19: the row keeps a future scan, so the repair is never lost.
    const pending = await mustGet(store, deliveryId);
    expect(pending.verifyScansRemaining).toBeGreaterThan(0);
    expect(pending.verifyAfterMs).not.toBeNull();
  });

  it("F3: an AMBIGUOUS chat.delete outcome leaves the intent unreconciled and alarmed", async () => {
    const { database, store } = makeStore();
    const deliveryId = "f3-delete-ambiguous";
    const row = await deliveredWithVerification(store, deliveryId);
    // The one interleaving §6.2's fail-safe rule exists for: Slack applies the
    // deletion and the response never arrives (our 30 s abort, a socket
    // failure). The copy may already be gone, and no later history scan can
    // rediscover it — reconciling this as "not applied" both uncounted the
    // deletion and suppressed the alarm.
    const { fetch: fetchStub, calls } = scriptedFetch((url) => {
      if (url.includes("conversations.history")) {
        return slackHistoryPage([
          historyMessage({ ts: TS_EARLY, deliveryId }),
          historyMessage({ ts: TS_LATE, deliveryId }),
        ]);
      }
      // Unscripted => the stub throws, exactly as an aborted fetch does.
      return undefined;
    });

    await resolveAmbiguousRow(row, resolverDeps(store, fetchStub));

    expect(deleteCalls(calls)).toHaveLength(1);
    const entries = auditRows(database, deliveryId).map((entry) =>
      String(entry["evidence_json"]),
    );
    // The intent stands alone: no outcome marker may reconcile an AMBIGUOUS
    // result.
    expect(
      entries.filter((json) => json.includes('"duplicate_deletion_intent"')),
    ).toHaveLength(1);
    expect(
      entries.filter((json) =>
        json.includes('"duplicate_deletion_not_applied"'),
      ),
    ).toHaveLength(0);
    const counters = await store.statusCounters(DISPATCH_TEST_NOW);
    expect(counters.unreconciledDeletionIntents).toBe(1);
    expect(
      observerAlarms(
        {
          deadLetter: 0,
          manual: 0,
          oldestAmbiguousAgeMs: null,
          repairedDuplicates: counters.repairedDuplicates,
          unreconciledDeletionIntents: counters.unreconciledDeletionIntents,
        },
        null,
      ),
    ).toContain("duplicate_deletion_unreconciled");
    // Unchanged by this finding: the copy is reported not repaired, so R19
    // keeps a scan armed.
    expect(await store.repairedDuplicatesTotal()).toBe(0);
    const pending = await mustGet(store, deliveryId);
    expect(pending.verifyScansRemaining).toBeGreaterThan(0);
    expect(pending.verifyAfterMs).not.toBeNull();
  });

  it("F3: an HTTP 5xx chat.delete is ambiguous too — only an explicit ok:false reconciles", async () => {
    const { database, store } = makeStore();
    const deliveryId = "f3-delete-5xx";
    const row = await deliveredWithVerification(store, deliveryId);
    const { fetch: fetchStub } = duplicateHistory(deliveryId, {
      status: 503,
      body: { ok: false, error: "service_unavailable" },
    });

    await resolveAmbiguousRow(row, resolverDeps(store, fetchStub));

    // §6.2 precedence: the HTTP status is classified FIRST, so an ok:false
    // body under a non-200 status is not the definite negative it looks like.
    expect(
      auditRows(database, deliveryId).filter((entry) =>
        String(entry["evidence_json"]).includes(
          '"duplicate_deletion_not_applied"',
        ),
      ),
    ).toHaveLength(0);
    expect(
      (await store.statusCounters(DISPATCH_TEST_NOW))
        .unreconciledDeletionIntents,
    ).toBe(1);
  });

  it("F2: a completed repair reconciles its intent — the ordinary path raises no alarm", async () => {
    const { store } = makeStore();
    const deliveryId = "f2-repair-completes";
    const row = await deliveredWithVerification(store, deliveryId);
    const { fetch: fetchStub } = duplicateHistory(deliveryId, slackDeleteOk());

    await resolveAmbiguousRow(row, resolverDeps(store, fetchStub));

    expect(await store.repairedDuplicatesTotal()).toBe(1);
    const counters = await store.statusCounters(DISPATCH_TEST_NOW);
    expect(counters.unreconciledDeletionIntents).toBe(0);
    expect(
      observerAlarms(
        {
          deadLetter: 0,
          manual: 0,
          oldestAmbiguousAgeMs: null,
          repairedDuplicates: counters.repairedDuplicates,
          unreconciledDeletionIntents: counters.unreconciledDeletionIntents,
        },
        null,
      ),
    ).not.toContain("duplicate_deletion_unreconciled");
  });
});

// Review findings F1 and F2 — both are defects INTRODUCED by the previous
// round's H25 fix. H25 gave updateCanonicalTs a CAS on the caller's observed
// ts, but left the CALLER deciding from the same pre-guard values: which ts
// wins (F1) and which copies may be deleted (F2) were still computed as if the
// observation were complete and the write had succeeded.
describe("F1/F2: the canonical-ts repair decides from the row, not from the page budget", () => {
  it("F1: a partial scan never regresses an earlier recorded canonical ts", async () => {
    const { database, store } = makeStore();
    const deliveryId = "f1-partial-scan-regression";
    // The row already carries canonical proof of the EARLIEST copy.
    const TS_EARLIEST = "1786663000.000050";
    const row = await deliverViaOperatorResend(
      store,
      deliveryId,
      DISPATCH_TEST_NOW - VERIFY_FIRST_SCAN_DELAY_MS,
      TS_EARLIEST,
    );
    // conversations.history returns newest-first, so a scan stopped by the
    // page budget sees exactly the LATER copies and never reaches TS_EARLIEST.
    const { fetch: fetchStub, calls } = scriptedFetch((url) => {
      if (url.includes("conversations.history")) {
        return slackHistoryPage(
          [
            historyMessage({ ts: TS_EARLY, deliveryId }),
            historyMessage({ ts: TS_LATE, deliveryId }),
          ],
          { nextCursor: "cursor-live", hasMore: true },
        );
      }
      if (url.includes("chat.delete")) return slackDeleteOk();
      return undefined;
    });

    const verdict = await resolveAmbiguousRow(
      row,
      resolverDeps(store, fetchStub),
    );

    // §6.3.2: the EARLIEST ts is canonical. The recorded proof stands.
    const updated = await mustGet(store, deliveryId);
    expect(updated.slackMessageTs).toBe(TS_EARLIEST);
    expect(verdict).toMatchObject({
      kind: "found_many",
      canonicalTs: TS_EARLIEST,
    });
    // No repair was written at all — there was nothing to repair.
    const entries = auditRows(database, deliveryId).map((entry) =>
      String(entry["evidence_json"]),
    );
    expect(entries.filter((json) => json.includes('"repaired_from"'))).toEqual(
      [],
    );
    // The earliest OBSERVED copy is a later duplicate, but this pass does not
    // delete it: an exhausted scan that still cannot see TS_EARLIEST may mean
    // that message is gone (§6.5 row 17), and chat.delete is irreversible.
    expect(deleteCalls(calls).map((call) => call.body?.["ts"])).toEqual([
      TS_LATE,
    ]);
    // It stays pending instead, so a later scan completes the repair (R19).
    const pendingMarker = entries.find((json) =>
      json.includes('"duplicate_repair_pending":true'),
    );
    expect(JSON.parse(String(pendingMarker))).toMatchObject({
      canonical_ts: TS_EARLIEST,
      pending_ts: [TS_EARLY],
    });
    expect(updated.verifyScansRemaining).toBeGreaterThan(0);
    expect(updated.verifyAfterMs).not.toBeNull();
  });

  it("F1: an EXHAUSTED scan that cannot see the recorded ts adopts the earliest observed copy", async () => {
    const { database, store } = makeStore();
    const deliveryId = "f1-exhausted-adopts";
    // Same shape as the partial-scan case, with one difference that changes
    // the meaning of the evidence: the scan EXHAUSTS. A complete census that
    // does not contain the recorded ts proves that message is gone (§6.5
    // row 17), so keeping it as canonical would leave the row pointing at
    // nothing while both observed copies survive — and repeated scans would
    // end in `verification_abandoned` without ever restoring the truth.
    const TS_EARLIEST = "1786663000.000050";
    const row = await deliverViaOperatorResend(
      store,
      deliveryId,
      DISPATCH_TEST_NOW - VERIFY_FIRST_SCAN_DELAY_MS,
      TS_EARLIEST,
    );
    const { fetch: fetchStub, calls } = scriptedFetch((url) => {
      if (url.includes("conversations.history")) {
        return slackHistoryPage([
          historyMessage({ ts: TS_EARLY, deliveryId }),
          historyMessage({ ts: TS_LATE, deliveryId }),
        ]);
      }
      if (url.includes("chat.delete")) return slackDeleteOk();
      return undefined;
    });

    const verdict = await resolveAmbiguousRow(
      row,
      resolverDeps(store, fetchStub),
    );

    // The earliest SURVIVING copy becomes canonical...
    const updated = await mustGet(store, deliveryId);
    expect(updated.slackMessageTs).toBe(TS_EARLY);
    expect(verdict).toMatchObject({ kind: "found_many", canonicalTs: TS_EARLY });
    expect(
      auditRows(database, deliveryId).some((entry) =>
        String(entry["evidence_json"]).includes(
          `"repaired_from":"${TS_EARLIEST}"`,
        ),
      ),
    ).toBe(true);
    // ...and every later copy is deleted, so the repair CONVERGES: exactly one
    // message is left in the channel and the row records it.
    expect(deleteCalls(calls).map((call) => call.body?.["ts"])).toEqual([
      TS_LATE,
    ]);
    expect(await store.repairedDuplicatesTotal()).toBe(1);
    expect(updated.verifyScansRemaining).toBe(row.verifyScansRemaining - 1);
  });

  it("F2: a lost canonical-ts CAS deletes nothing and re-arms instead", async () => {
    const { database, store } = makeStore();
    const deliveryId = "f2-canonical-cas-lost";
    // The row records the LATE copy; this scan sees an earlier one and will
    // try to repair the canonical ts to it.
    const row = await deliverViaOperatorResend(
      store,
      deliveryId,
      DISPATCH_TEST_NOW - VERIFY_FIRST_SCAN_DELAY_MS,
      TS_LATE,
    );
    // Another resolver records a different ts between this pass's observation
    // and its write, so the H25 CAS refuses. The result used to be ignored,
    // and the deletion set — computed from the stale observation — still held
    // TS_LATE: the pass deleted the ts the row itself records.
    const casLost = new Proxy(store, {
      get(target, property, _receiver) {
        const value = Reflect.get(target, property, target) as unknown;
        if (typeof value !== "function") return value;
        const bound = (value as (...args: unknown[]) => unknown).bind(target);
        if (property !== "updateCanonicalTs") return bound;
        return async (): Promise<boolean> => false;
      },
    }) as DispatchStore;
    const { fetch: fetchStub, calls } = scriptedFetch((url) => {
      if (url.includes("conversations.history")) {
        return slackHistoryPage([
          historyMessage({ ts: TS_EARLY, deliveryId }),
          historyMessage({ ts: TS_LATE, deliveryId }),
        ]);
      }
      if (url.includes("chat.delete")) return slackDeleteOk();
      return undefined;
    });

    const verdict = await resolveAmbiguousRow(row, {
      ...resolverDeps(store, fetchStub),
      store: casLost,
    });

    expect(verdict.kind).toBe("found_many");
    // Nothing was deleted: the row's own canonical proof survives.
    expect(deleteCalls(calls)).toHaveLength(0);
    const updated = await mustGet(store, deliveryId);
    expect(updated.slackMessageTs).toBe(TS_LATE);
    expect(await store.repairedDuplicatesTotal()).toBe(0);
    // The pass repaired nothing, so it may not consume a verification scan.
    expect(updated.verifyScansRemaining).toBe(row.verifyScansRemaining);
    const marker = auditRows(database, deliveryId)
      .map((entry) => String(entry["evidence_json"]))
      .find((json) => json.includes('"canonical_ts_cas_lost":true'));
    expect(JSON.parse(String(marker))).toMatchObject({
      duplicate_repair_pending: true,
      canonical_ts_cas_lost: true,
      pending_ts: [TS_LATE],
    });
    expect(updated.verifyAfterMs).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Review round 11 (ADR §10 H45-H48). Three defect shapes, one family: a
// CORRECTIVE second write that is omitted, mis-keyed, or lost, leaving a row
// or an audit intent that reads "done" to every query the system makes of it.
// ---------------------------------------------------------------------------
describe("H45-H48: absence-typed deletions, the atomic arm, single-match reconciliation", () => {
  afterEach(() => {
    closeDispatchDatabases();
  });

  // A ts no history fixture below ever returns — the value a CONCURRENT writer
  // recorded on the row while this pass was scanning.
  const TS_MID = "1786664500.000150";

  // Every method of the real store, with ONE forced to reject — the transient
  // D1 failure that runResolverPass contains per row (resolver.ts:1136-1142).
  function storeFailingOn(
    store: DispatchStore,
    method: keyof DispatchStore,
  ): DispatchStore {
    return new Proxy(store, {
      get(target, property, _receiver) {
        const value = Reflect.get(target, property, target) as unknown;
        if (typeof value !== "function") return value;
        const bound = (value as (...args: unknown[]) => unknown).bind(target);
        if (property !== method) return bound;
        return async (): Promise<never> => {
          throw new Error("d1_transient_failure");
        };
      },
    }) as DispatchStore;
  }

  // markDelivered loses its CAS because `concurrent` ran first — the exact
  // interleaving resolver.ts:952-1007 exists for.
  function storeWithLostDeliveredCas(
    store: DispatchStore,
    concurrent: () => Promise<void>,
    alsoFailing?: keyof DispatchStore,
  ): DispatchStore {
    return new Proxy(store, {
      get(target, property, _receiver) {
        const value = Reflect.get(target, property, target) as unknown;
        if (typeof value !== "function") return value;
        const bound = (value as (...args: unknown[]) => unknown).bind(target);
        if (property === "markDelivered") {
          return async (): Promise<boolean> => {
            await concurrent();
            return false;
          };
        }
        if (alsoFailing !== undefined && property === alsoFailing) {
          return async (): Promise<never> => {
            throw new Error("d1_transient_failure");
          };
        }
        return bound;
      },
    }) as DispatchStore;
  }

  // A scan whose cursor never empties: the page budget is spent, so the scan
  // is PARTIAL and `exhausted` is false (resolver.ts:295).
  function partialHistory(
    messages: readonly Record<string, unknown>[],
    deleteResponse?: FixtureResponse,
  ): { fetch: typeof fetch; calls: RecordedSlackCall[] } {
    let page = 0;
    return scriptedFetch((url) => {
      if (url.includes("conversations.history")) {
        page += 1;
        return slackHistoryPage(page === 1 ? messages : [], {
          nextCursor: `live-${page}`,
          hasMore: true,
        });
      }
      if (url.includes("chat.delete")) return deleteResponse;
      return undefined;
    });
  }

  // An EXHAUSTED scan over two copies of the same delivery, with the scripted
  // chat.delete outcome. (Local twin of the F2 block's fixture — that one is
  // scoped to its own describe.)
  function duplicateHistory(
    deliveryId: string,
    deleteResponse: FixtureResponse,
  ): { fetch: typeof fetch; calls: RecordedSlackCall[] } {
    return scriptedFetch((url) => {
      if (url.includes("conversations.history")) {
        return slackHistoryPage([
          historyMessage({ ts: TS_EARLY, deliveryId }),
          historyMessage({ ts: TS_LATE, deliveryId }),
        ]);
      }
      if (url.includes("chat.delete")) return deleteResponse;
      return undefined;
    });
  }

  // A delivered row recording TS_EARLY with both §6.3.3 scans armed.
  async function deliveredWithVerification(
    store: D1DispatchStore,
    deliveryId: string,
  ): Promise<DispatchOutboxRow> {
    return deliverViaOperatorResend(
      store,
      deliveryId,
      DISPATCH_TEST_NOW - VERIFY_FIRST_SCAN_DELAY_MS,
      TS_EARLY,
    );
  }

  function markerFor(
    database: ReturnType<typeof makeStore>["database"],
    deliveryId: string,
    needle: string,
  ): Record<string, unknown> | undefined {
    const json = auditRows(database, deliveryId)
      .map((entry) => String(entry["evidence_json"]))
      .find((evidence) => evidence.includes(needle));
    return json === undefined
      ? undefined
      : (JSON.parse(json) as Record<string, unknown>);
  }

  // -------------------------------------------------------------------------
  // H45 — `message_not_found` is an ABSENCE assertion, not a refusal.
  // -------------------------------------------------------------------------

  it("H45: a message_not_found deletion writes no outcome marker and reconciles no earlier intent", async () => {
    const { database, store } = makeStore();
    const deliveryId = "h45-absent-deletion";
    const row = await deliveredWithVerification(store, deliveryId);

    // Pass A: the response is lost (500 -> AMBIGUOUS), so its intent is
    // deliberately left dangling — the only trace that survives if Slack DID
    // apply the deletion (§10 H21).
    const { fetch: firstFetch } = duplicateHistory(deliveryId, {
      status: 500,
      body: {},
    });
    await resolveAmbiguousRow(row, resolverDeps(store, firstFetch));
    expect(
      (await store.statusCounters(DISPATCH_TEST_NOW))
        .unreconciledDeletionIntents,
    ).toBe(1);

    // Pass B targets the SAME ts and Slack answers "it is not there" — which is
    // consistent with pass A having deleted it. It must not certify pass A.
    const { fetch: secondFetch } = duplicateHistory(deliveryId, {
      status: 200,
      body: { ok: false, error: "message_not_found" },
    });
    await resolveAmbiguousRow(
      await mustGet(store, deliveryId),
      resolverDeps(store, secondFetch),
    );

    const counters = await store.statusCounters(DISPATCH_TEST_NOW);
    expect(counters.unreconciledDeletionIntents).toBe(2);
    expect(
      markerFor(database, deliveryId, '"duplicate_deletion_not_applied"'),
    ).toBeUndefined();
    expect(
      observerAlarms(
        {
          deadLetter: 0,
          manual: 0,
          oldestAmbiguousAgeMs: null,
          repairedDuplicates: counters.repairedDuplicates,
          unreconciledDeletionIntents: counters.unreconciledDeletionIntents,
        },
        null,
      ),
    ).toContain("duplicate_deletion_unreconciled");
  });

  // -------------------------------------------------------------------------
  // H46 — the verification arm is committed WITH the delivered transition.
  // -------------------------------------------------------------------------

  it("H46 (site 1, single match): a lost arm after a partial scan leaves the row selectable", async () => {
    const { store } = makeStore();
    const deliveryId = "h46-single-match-arm-lost";
    const row = await seedAmbiguous(store, deliveryId);
    const { fetch: fetchStub } = partialHistory([
      historyMessage({ ts: TS_EARLY, deliveryId }),
    ]);

    await expect(
      resolveAmbiguousRow(row, {
        ...resolverDeps(store, fetchStub),
        store: storeFailingOn(store, "flagDuplicateRepairPending"),
      }),
    ).rejects.toThrow("d1_transient_failure");

    const stranded = await mustGet(store, deliveryId);
    expect(stranded.state).toBe("delivered");
    // The row was finalized on an UNVERIFIED partial scan, so a follow-up scan
    // is owed. It is owed durably: counter AND due time, or no pass selects it.
    expect(stranded.verifyScansRemaining).toBeGreaterThanOrEqual(1);
    // Stamped by the delivered batch itself, not by some later writer: the
    // §6.3.3 first-scan delay measured from THIS pass's clock.
    expect(stranded.verifyAfterMs).toBe(
      DISPATCH_TEST_NOW + VERIFY_FIRST_SCAN_DELAY_MS,
    );
    const due = await store.verificationRowsDue(
      DISPATCH_TEST_NOW + VERIFY_FIRST_SCAN_DELAY_MS,
      10,
    );
    expect(due.map((selected) => selected.deliveryId)).toContain(deliveryId);
  });

  it("H46 (site 2, found_many): a lost arm after an undeleted duplicate leaves the row selectable", async () => {
    const { store } = makeStore();
    const deliveryId = "h46-found-many-arm-lost";
    const row = await seedAmbiguous(store, deliveryId);
    // The deletion is refused, so a surviving copy is KNOWN to be in Slack.
    const { fetch: fetchStub } = duplicateHistory(deliveryId, {
      status: 200,
      body: { ok: false, error: "cant_delete_message" },
    });

    await expect(
      resolveAmbiguousRow(row, {
        ...resolverDeps(store, fetchStub),
        store: storeFailingOn(store, "flagDuplicateRepairPending"),
      }),
    ).rejects.toThrow("d1_transient_failure");

    const stranded = await mustGet(store, deliveryId);
    expect(stranded.state).toBe("delivered");
    expect(stranded.verifyScansRemaining).toBeGreaterThanOrEqual(1);
    expect(stranded.verifyAfterMs).not.toBeNull();
  });

  it("H46 (site 3, late proof): a lost arm after recordLateProof delivers the row leaves it selectable", async () => {
    const { store } = makeStore();
    const deliveryId = "h46-late-proof-arm-lost";
    const row = await seedAmbiguous(store, deliveryId);
    const { fetch: fetchStub } = duplicateHistory(deliveryId, slackDeleteOk());
    // The row is parked in `manual` between this pass's scan and its CAS, so
    // markDelivered loses and recordLateProof's manual->delivered CAS is what
    // delivers it (outbox.ts:598-607).
    const lostCas = storeWithLostDeliveredCas(
      store,
      async () => {
        await store.markManual(
          deliveryId,
          DISPATCH_TEST_NOW - 1,
          JSON.stringify({ verdict: "resolver_budget_exhausted" }),
          "resolver",
          ["ambiguous"],
        );
      },
      "flagDuplicateRepairPending",
    );

    await expect(
      resolveAmbiguousRow(row, {
        ...resolverDeps(store, fetchStub),
        store: lostCas,
      }),
    ).rejects.toThrow("d1_transient_failure");

    const stranded = await mustGet(store, deliveryId);
    expect(stranded.state).toBe("delivered");
    expect(stranded.verifyScansRemaining).toBeGreaterThanOrEqual(1);
    // The manual->delivered CAS of recordLateProof is what armed it, so the due
    // time is that batch's stamp — not a backoff written by some later path.
    expect(stranded.verifyAfterMs).toBe(
      DISPATCH_TEST_NOW + VERIFY_FIRST_SCAN_DELAY_MS,
    );
  });

  it("H46 (site 4, lost CAS onto a delivered row): the arm precedes the irreversible deletion loop", async () => {
    const { store } = makeStore();
    const deliveryId = "h46-lost-cas-delivered-arm";
    const row = await seedAmbiguous(store, deliveryId);
    // A concurrent writer delivers the row with a ts this scan never saw and
    // leaves the counter at 0 — the shape no automatic predicate selects.
    const lostCas = storeWithLostDeliveredCas(
      store,
      async () => {
        const delivered = await store.markDelivered(
          deliveryId,
          DISPATCH_TEST_NOW - 1,
          TS_MID,
          ALERTS_CHANNEL,
          "consumer",
          ["ambiguous"],
          JSON.stringify({ source: "concurrent" }),
        );
        if (!delivered) throw new Error("concurrent_delivery_failed");
      },
      "flagDuplicateRepairPending",
    );
    const { fetch: fetchStub } = duplicateHistory(deliveryId, {
      status: 200,
      body: { ok: false, error: "cant_delete_message" },
    });

    await expect(
      resolveAmbiguousRow(row, {
        ...resolverDeps(store, fetchStub),
        store: lostCas,
      }),
    ).rejects.toThrow("d1_transient_failure");

    const stranded = await mustGet(store, deliveryId);
    expect(stranded.state).toBe("delivered");
    expect(stranded.verifyScansRemaining).toBeGreaterThanOrEqual(1);
    expect(stranded.verifyAfterMs).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // H47 — the single-match arm reconciles the recorded ts, exactly as the
  // multi-match arm already does (resolver.ts:1009-1023).
  // -------------------------------------------------------------------------

  it("H47 (i): an EXHAUSTED single match replaces a recorded ts the census did not see", async () => {
    const { store } = makeStore();
    const deliveryId = "h47-exhausted-adopts-survivor";
    const row = await deliveredWithVerification(store, deliveryId);
    expect(row.slackMessageTs).toBe(TS_EARLY);
    // TS_EARLY is gone from the channel; one copy survives.
    const { fetch: fetchStub } = scriptedFetch((url) =>
      url.includes("conversations.history")
        ? slackHistoryPage([historyMessage({ ts: TS_LATE, deliveryId })])
        : undefined,
    );

    await resolveAmbiguousRow(row, resolverDeps(store, fetchStub));

    const updated = await mustGet(store, deliveryId);
    expect(updated.slackMessageTs).toBe(TS_LATE);
    // The scan observed and repaired, so it may consume its scan.
    expect(updated.verifyScansRemaining).toBe(row.verifyScansRemaining - 1);
  });

  it("H47 (ii): a PARTIAL single match earlier than the recorded ts becomes canonical", async () => {
    const { store } = makeStore();
    const deliveryId = "h47-partial-earlier-wins";
    const row = await deliverViaOperatorResend(
      store,
      deliveryId,
      DISPATCH_TEST_NOW - VERIFY_FIRST_SCAN_DELAY_MS,
      TS_LATE,
    );
    const { fetch: fetchStub } = partialHistory([
      historyMessage({ ts: TS_EARLY, deliveryId }),
    ]);

    await resolveAmbiguousRow(row, resolverDeps(store, fetchStub));

    const updated = await mustGet(store, deliveryId);
    // §6.3.2: the EARLIEST ts is canonical.
    expect(updated.slackMessageTs).toBe(TS_EARLY);
    // A partial scan never consumes the §6.3.3 counter.
    expect(updated.verifyScansRemaining).toBe(row.verifyScansRemaining);
  });

  it("H47 (iii): a PARTIAL single match LATER than the recorded ts keeps it, and the marker says so", async () => {
    const { database, store } = makeStore();
    const deliveryId = "h47-partial-later-pending";
    const row = await deliveredWithVerification(store, deliveryId);
    expect(row.slackMessageTs).toBe(TS_EARLY);
    // Newest-first paging: a budget-stopped scan sees the LATER copy only.
    const { fetch: fetchStub } = partialHistory([
      historyMessage({ ts: TS_LATE, deliveryId }),
    ]);

    await resolveAmbiguousRow(row, resolverDeps(store, fetchStub));

    const updated = await mustGet(store, deliveryId);
    expect(updated.slackMessageTs).toBe(TS_EARLY);
    const marker = markerFor(
      database,
      deliveryId,
      '"duplicate_repair_pending":true',
    );
    // The evidence carries the EFFECTIVE canonical ts — the one the row
    // records — and lists the surviving copy this pass did not delete.
    expect(marker).toMatchObject({
      partial_scan: true,
      canonical_ts: TS_EARLY,
      pending_ts: [TS_LATE],
    });
  });

  it("H47 (iv): a lost canonical CAS on the single-match path arms and does NOT consume a scan", async () => {
    const { database, store } = makeStore();
    const deliveryId = "h47-single-match-cas-lost";
    const row = await deliveredWithVerification(store, deliveryId);
    const casLost = new Proxy(store, {
      get(target, property, _receiver) {
        const value = Reflect.get(target, property, target) as unknown;
        if (typeof value !== "function") return value;
        const bound = (value as (...args: unknown[]) => unknown).bind(target);
        if (property !== "updateCanonicalTs") return bound;
        return async (): Promise<boolean> => false;
      },
    }) as DispatchStore;
    const { fetch: fetchStub } = scriptedFetch((url) =>
      url.includes("conversations.history")
        ? slackHistoryPage([historyMessage({ ts: TS_LATE, deliveryId })])
        : undefined,
    );

    await resolveAmbiguousRow(row, {
      ...resolverDeps(store, fetchStub),
      store: casLost,
    });

    const updated = await mustGet(store, deliveryId);
    // A pass that repaired nothing may not consume a §6.3.3 scan.
    expect(updated.verifyScansRemaining).toBe(row.verifyScansRemaining);
    expect(
      markerFor(database, deliveryId, '"canonical_ts_cas_lost":true'),
    ).toMatchObject({ duplicate_repair_pending: true });
  });

  it("H47 (v): a lost delivered CAS on the single-match path reconciles the concurrent ts", async () => {
    const { store } = makeStore();
    const deliveryId = "h47-single-match-late-proof-reconcile";
    const row = await seedAmbiguous(store, deliveryId);
    const lostCas = storeWithLostDeliveredCas(store, async () => {
      const delivered = await store.markDelivered(
        deliveryId,
        DISPATCH_TEST_NOW - 1,
        TS_MID,
        ALERTS_CHANNEL,
        "consumer",
        ["ambiguous"],
        JSON.stringify({ source: "concurrent" }),
      );
      if (!delivered) throw new Error("concurrent_delivery_failed");
    });
    // An EXHAUSTED census that does not contain TS_MID: that message is gone.
    const { fetch: fetchStub } = scriptedFetch((url) =>
      url.includes("conversations.history")
        ? slackHistoryPage([historyMessage({ ts: TS_EARLY, deliveryId })])
        : undefined,
    );

    await resolveAmbiguousRow(row, {
      ...resolverDeps(store, fetchStub),
      store: lostCas,
    });

    const updated = await mustGet(store, deliveryId);
    expect(updated.state).toBe("delivered");
    expect(updated.slackMessageTs).toBe(TS_EARLY);
  });
});
