// ADR-001 architectural REDs — resolver verdicts, scheduling and repair.
// Covers R3, R4 (scheduling half), R9, R12, R14, R17, R18, R19 per
// docs/adr/ADR-001-slack-dispatch-outbox.md §6.3.1-§6.3.3 and §6.10.
// RED phase: these tests are the executable specification and fail until
// src/dispatch/{outbox,resolver} land on the pinned module surface.
import { afterEach, describe, expect, it } from "vitest";

import {
  DISPATCH_METADATA_EVENT_TYPE,
  RESOLVER_COOLING_OFF_FLOOR_MS,
  RESOLVER_MAX_ATTEMPTS,
  RESOLVER_PAGES_PER_ROW,
  VERIFY_FIRST_SCAN_DELAY_MS,
  VERIFY_SECOND_SCAN_DELAY_MS,
} from "../src/dispatch/contract";
import type {
  DispatchDestination,
  DispatchOutboxRow,
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
