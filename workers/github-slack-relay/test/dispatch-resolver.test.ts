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
  VERIFY_DEFERRAL_BACKOFF_BASE_MS,
  VERIFY_DEFERRAL_BACKOFF_CAP_MS,
  VERIFY_FIRST_SCAN_DELAY_MS,
  VERIFY_SECOND_SCAN_DELAY_MS,
} from "../src/dispatch/contract";
import type {
  DispatchDestination,
  DispatchOutboxRow,
  DispatchStore,
} from "../src/dispatch/contract";
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
    expect(
      markers.map(
        (entry) =>
          (
            JSON.parse(String(entry["evidence_json"])) as {
              consecutive_deferrals: number;
            }
          ).consecutive_deferrals,
      ),
    ).toEqual([1, 2]);
  });

  it("the deferral backoff is capped at 24 h", async () => {
    const { store } = makeStore();
    const deliveryId = "starve-deferral-cap";
    const deliveredMs = DISPATCH_TEST_NOW - VERIFY_FIRST_SCAN_DELAY_MS;
    await deliverViaOperatorResend(store, deliveryId, deliveredMs, TS_EARLY);
    // Eight consecutive deferrals already recorded: 15 min << 2^8 is far
    // past the cap.
    for (let index = 0; index < 8; index += 1) {
      await store.appendAudit({
        deliveryId,
        fromState: "delivered",
        toState: "delivered",
        evidenceJson: JSON.stringify({
          verification_deferred: true,
          reason: "history_error_internal_error",
          consecutive_deferrals: index + 1,
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
    await store.flagDuplicateRepairPending(
      deliveryId,
      deliveredMs,
      JSON.stringify({
        duplicate_repair_pending: true,
        partial_scan: true,
        canonical_ts: TS_EARLY,
        pending_ts: [],
      }),
    );
    const staleSnapshot = await mustGet(store, deliveryId);
    expect(staleSnapshot.verifyScansRemaining).toBe(1);
    const scanNow = deliveredMs + VERIFY_FIRST_SCAN_DELAY_MS + 1_000;

    // The OTHER pass rearms first (same counter value, verify_after_ms moved
    // forward), then the stale pass completes its own scan.
    await store.flagDuplicateRepairPending(
      deliveryId,
      scanNow,
      JSON.stringify({
        duplicate_repair_pending: true,
        partial_scan: true,
        canonical_ts: TS_EARLY,
        pending_ts: [TS_LATE],
      }),
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
      JSON.stringify({
        duplicate_repair_pending: true,
        canonical_ts: TS_EARLY,
        pending_ts: [],
      }),
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
});
