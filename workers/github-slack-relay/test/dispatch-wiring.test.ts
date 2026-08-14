// Panel-driven coverage for the ADR-001 integration layer
// (docs/adr/ADR-001-slack-dispatch-outbox.md §6.1-§6.8, §6.10, §9):
// src/dispatch/wiring.ts and the index.ts routes/branches that call it —
// ingress fences, /status, marked-body queue branching (DLQ-first), the
// scheduled dispatch pass OUTSIDE runScheduledRecovery, and the panel fixes
// V2, V5/V15, V6, V8/V10, V12, V13, V16/R2, V17, V19, V20, V21.
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  DispatchConsumerDeps,
  DispatchQueueMessage,
} from "../src/dispatch/consumer";
import { processDispatchMessage } from "../src/dispatch/consumer";
import {
  DISPATCH_CLIENT_TIMEOUT_MS,
  STALE_QUEUED_REQUEUE_AFTER_MS,
  type DispatchDestination,
} from "../src/dispatch/contract";
import { D1DispatchStore } from "../src/dispatch/outbox";
import {
  acceptPrimary,
  channelForDestination,
  runDispatchCronPass,
  type DispatchQueueJobBody,
} from "../src/dispatch/wiring";
import {
  handleFetch,
  handleQueue,
  runDispatchScheduled,
  runScheduledRecovery,
} from "../src/index";
import type { QueueJob } from "../src/store";
import {
  auditRows,
  closeDispatchDatabases,
  DISPATCH_TEST_NOW,
  dispatchDatabase,
  historyMessage,
  outboxRow,
  scriptedFetch,
  slackHistoryPage,
  slackPostOk,
} from "./dispatch-helpers";
import {
  FakeQueue,
  makeEnv,
  MemoryDeliveryStore,
  signedRequest,
  workflowPayload,
} from "./helpers";

const POST_URL = "https://slack.com/api/chat.postMessage";
const HISTORY_URL = "https://slack.com/api/conversations.history";
const ALERTS_CHANNEL = "C0BMUK793NV";
const ACTIVITY_CHANNEL = "C0BMQMW3L4E";
const ALERT_DLQ = "github-slack-alerts-dlq";
// Older than the R13 stale-queued threshold, well younger than 30 min.
const STALE_QUEUED_AGE_MS = STALE_QUEUED_REQUEUE_AFTER_MS + 60_000;

afterEach(closeDispatchDatabases);

// Legacy `deliveries` seed: same column set as D1DeliveryStore.insert
// (src/store.ts) and insertShadowPaired (src/dispatch/wiring.ts).
function seedLegacyDelivery(database: DatabaseSync, deliveryId: string): void {
  database
    .prepare(
      `INSERT INTO deliveries (
         delivery_id, event_type, action, repository, destination,
         payload_json, status, attempt_count, next_attempt_at,
         created_at, updated_at
       ) VALUES (?, 'workflow_run', 'completed',
         'LCV-Ideas-Software/cross-review', 'alerts', '{}', 'pending', 0,
         ?, ?, ?)`,
    )
    .run(deliveryId, DISPATCH_TEST_NOW, DISPATCH_TEST_NOW, DISPATCH_TEST_NOW);
}

interface RawOutboxSeed {
  deliveryId: string;
  destination: DispatchDestination;
  state: string;
  shadow?: number;
  lastSendStartMs?: number | null;
  leaseUntilMs?: number | null;
  verifyAfterMs?: number | null;
  verifyScansRemaining?: number;
  slackChannelId?: string | null;
  slackMessageTs?: string | null;
  createdMs?: number;
  updatedMs?: number;
}

function seedOutboxRow(database: DatabaseSync, input: RawOutboxSeed): void {
  database
    .prepare(
      `INSERT INTO dispatch_outbox (
         delivery_id, destination, shadow, payload_json, state,
         last_send_start_ms, lease_until_ms, verify_after_ms,
         verify_scans_remaining, slack_channel_id, slack_message_ts,
         created_ms, updated_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.deliveryId,
      input.destination,
      input.shadow ?? 0,
      '{"fixture":"wiring"}',
      input.state,
      input.lastSendStartMs ?? null,
      input.leaseUntilMs ?? null,
      input.verifyAfterMs ?? null,
      input.verifyScansRemaining ?? 0,
      input.slackChannelId ?? null,
      input.slackMessageTs ?? null,
      input.createdMs ?? DISPATCH_TEST_NOW,
      input.updatedMs ?? input.createdMs ?? DISPATCH_TEST_NOW,
    );
}

function outboxState(database: DatabaseSync, deliveryId: string): string {
  const row = outboxRow(database, deliveryId);
  expect(row).toBeDefined();
  return String(row?.state);
}

// Marked queue message + batch, as published by the primary ingress and the
// cron republish (dispatchQueueJobBody in src/dispatch/wiring.ts).
function markedBatch(
  queueName: string,
  deliveryId: string,
): {
  batch: MessageBatch<QueueJob>;
  ack: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
} {
  const ack = vi.fn();
  const retry = vi.fn();
  const message = {
    ack,
    attempts: 1,
    body: { deliveryId, path: "dispatch" },
    id: `marked-${deliveryId}`,
    retry,
    timestamp: new Date(DISPATCH_TEST_NOW),
  } as unknown as Message<QueueJob>;
  const batch = {
    queue: queueName,
    messages: [message],
  } as unknown as MessageBatch<QueueJob>;
  return { batch, ack, retry };
}

function consumerDeps(
  store: D1DispatchStore,
  fetchImpl: typeof fetch,
): DispatchConsumerDeps {
  return {
    store,
    fetch: fetchImpl,
    now: () => DISPATCH_TEST_NOW,
    botToken: "xoxb-wiring-fixture-token",
    channelFor: channelForDestination,
  };
}

function consumerMessage(deliveryId: string): {
  message: DispatchQueueMessage;
  ack: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
} {
  const ack = vi.fn();
  const retry = vi.fn();
  return {
    message: {
      body: { deliveryId, mode: "primary" },
      attempts: 1,
      ack,
      retry,
    },
    ack,
    retry,
  };
}

describe("dispatch wiring (ADR-001 integration layer)", () => {
  it("V17/R11 legacyRowExists reads the frozen legacy deliveries table", async () => {
    const { database, d1 } = dispatchDatabase();
    seedLegacyDelivery(database, "wiring-legacy-present");
    const store = new D1DispatchStore(d1);

    expect(await store.legacyRowExists("wiring-legacy-present")).toBe(true);
    expect(await store.legacyRowExists("wiring-legacy-absent")).toBe(false);
  });

  it("V17 acceptPrimary fence blocks cross-path rows, dedups same-path, never creates a fresh row over a shadow row", async () => {
    const { database, d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);

    // A legacy row in ANY state blocks cross-path acceptance (§6.8/R11).
    seedLegacyDelivery(database, "wiring-fence-legacy");
    expect(
      await acceptPrimary(store, {
        deliveryId: "wiring-fence-legacy",
        destination: "alerts",
        payloadJson: '{"text":"fence"}',
        now: DISPATCH_TEST_NOW,
      }),
    ).toBe("blocked_other_path");
    expect(outboxRow(database, "wiring-fence-legacy")).toBeUndefined();

    // Fresh GUID: inserted, then duplicate on the identical redelivery.
    expect(
      await acceptPrimary(store, {
        deliveryId: "wiring-fence-fresh",
        destination: "alerts",
        payloadJson: '{"text":"fresh"}',
        now: DISPATCH_TEST_NOW,
      }),
    ).toBe("inserted");
    expect(
      await acceptPrimary(store, {
        deliveryId: "wiring-fence-fresh",
        destination: "alerts",
        payloadJson: '{"text":"fresh"}',
        now: DISPATCH_TEST_NOW,
      }),
    ).toBe("duplicate");
    const freshCount = database
      .prepare(
        "SELECT COUNT(*) AS n FROM dispatch_outbox WHERE delivery_id = ?",
      )
      .get("wiring-fence-fresh") as { n: number };
    expect(freshCount.n).toBe(1);

    // Pre-existing SHADOW row: fenceDecision excludes shadow rows, so the
    // fence answers accept_new (not blocked, not duplicate_same_path) — but
    // the outbox PK then converts the re-insert into a no-op and
    // acceptPrimary reports "duplicate". ADR §6.8 same-path handling holds:
    // never a fresh row, the shadow row survives untouched (recovered by the
    // cron), and the cross-path fence is unaffected.
    expect(
      await store.insert({
        deliveryId: "wiring-fence-shadow",
        destination: "alerts",
        shadow: true,
        payloadJson: '{"text":"shadow"}',
        now: DISPATCH_TEST_NOW,
      }),
    ).toBe(true);
    expect(auditRows(database, "wiring-fence-shadow")).toHaveLength(1);
    expect(
      await acceptPrimary(store, {
        deliveryId: "wiring-fence-shadow",
        destination: "alerts",
        payloadJson: '{"text":"shadow"}',
        now: DISPATCH_TEST_NOW,
      }),
    ).toBe("duplicate");
    expect(outboxRow(database, "wiring-fence-shadow")).toMatchObject({
      shadow: 1,
      state: "queued",
    });
    expect(auditRows(database, "wiring-fence-shadow")).toHaveLength(1);
  });

  it("V20 /status returns only the aggregate dispatch counters", async () => {
    const { database, d1 } = dispatchDatabase();
    seedOutboxRow(database, {
      deliveryId: "wiring-status-queued",
      destination: "alerts",
      state: "queued",
      createdMs: DISPATCH_TEST_NOW - 1_000,
    });
    const queue = new FakeQueue();

    const response = await handleFetch(
      new Request("https://relay.example/status"),
      makeEnv(queue, { db: d1 }),
      { now: () => DISPATCH_TEST_NOW },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    // Panel F2: aggregate counters ONLY — no metadata_event_type, no
    // stale_queued_requeue_after_ms, no other configuration on the
    // unauthenticated surface.
    expect(Object.keys(body)).toEqual(["dispatch"]);
    const dispatch = body["dispatch"] as Record<string, unknown>;
    expect(Object.keys(dispatch).sort()).toEqual([
      "counters",
      "oldest_non_terminal_age_ms",
      "repaired_duplicates",
    ]);
    const counters = dispatch["counters"] as Record<
      string,
      Record<string, number>
    >;
    expect(Object.keys(counters).sort()).toEqual(["activity", "alerts"]);
    expect(counters["alerts"]).toMatchObject({ queued: 1, sending: 0 });
    expect(dispatch["oldest_non_terminal_age_ms"]).toBe(1_000);
    expect(dispatch["repaired_duplicates"]).toBe(0);
  });

  it("V20 primary ingress inserts the outbox row, publishes a marked job and answers duplicate on redelivery", async () => {
    const { database, d1 } = dispatchDatabase();
    const queue = new FakeQueue();
    const env = makeEnv(queue, { db: d1, dispatchMode: "primary" });
    const deliveryId = "00000000-0000-4000-9000-000000000101";

    const first = await handleFetch(
      await signedRequest("workflow_run", deliveryId, workflowPayload()),
      env,
      { now: () => DISPATCH_TEST_NOW },
    );
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ accepted: true, queued: true });
    expect(queue.sent).toEqual([{ deliveryId, path: "dispatch" }]);
    expect(outboxRow(database, deliveryId)).toMatchObject({
      state: "queued",
      shadow: 0,
      destination: "alerts",
    });
    expect(auditRows(database, deliveryId)).toHaveLength(1);
    // Primary mode never writes the legacy path (§6.8: the fence only READS
    // deliveries).
    const legacyCount = database
      .prepare("SELECT COUNT(*) AS n FROM deliveries")
      .get() as { n: number };
    expect(legacyCount.n).toBe(0);

    const second = await handleFetch(
      await signedRequest("workflow_run", deliveryId, workflowPayload()),
      env,
      { now: () => DISPATCH_TEST_NOW },
    );
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual({ accepted: true, duplicate: true });
    expect(queue.sent).toHaveLength(1);
    const outboxCount = database
      .prepare("SELECT COUNT(*) AS n FROM dispatch_outbox")
      .get() as { n: number };
    expect(outboxCount.n).toBe(1);
    expect(auditRows(database, deliveryId)).toHaveLength(1);
  });

  it("V21 shadow ingress pairs the legacy and shadow rows atomically, once, with one audit row", async () => {
    const { database, d1 } = dispatchDatabase();
    const queue = new FakeQueue();
    const env = makeEnv(queue, { db: d1, dispatchMode: "shadow" });
    const deliveryId = "00000000-0000-4000-9000-000000000201";

    const first = await handleFetch(
      await signedRequest("workflow_run", deliveryId, workflowPayload()),
      env,
      { now: () => DISPATCH_TEST_NOW },
    );
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ accepted: true, queued: true });
    const legacy = database
      .prepare("SELECT status FROM deliveries WHERE delivery_id = ?")
      .get(deliveryId) as { status: string } | undefined;
    expect(legacy?.status).toBe("queued");
    expect(outboxRow(database, deliveryId)).toMatchObject({
      shadow: 1,
      state: "queued",
    });
    expect(auditRows(database, deliveryId)).toHaveLength(1);
    // The legacy consumers keep receiving the UNMARKED body.
    expect(queue.sent).toEqual([{ deliveryId }]);

    // Redelivered GUID: the changes() guard creates NOTHING new — no orphan
    // shadow row, no second audit row, no second publish (panel V21/V11).
    const redelivery = await handleFetch(
      await signedRequest("workflow_run", deliveryId, workflowPayload()),
      env,
      { now: () => DISPATCH_TEST_NOW },
    );
    expect(redelivery.status).toBe(202);
    expect(await redelivery.json()).toEqual({ accepted: true, duplicate: true });
    expect(auditRows(database, deliveryId)).toHaveLength(1);
    expect(queue.sent).toHaveLength(1);
    const pairedCount = database
      .prepare(
        "SELECT COUNT(*) AS n FROM dispatch_outbox WHERE delivery_id = ?",
      )
      .get(deliveryId) as { n: number };
    expect(pairedCount.n).toBe(1);

    // A GUID whose legacy row PRE-EXISTS gets NO shadow row.
    const preExisting = "00000000-0000-4000-9000-000000000202";
    seedLegacyDelivery(database, preExisting);
    const blocked = await handleFetch(
      await signedRequest("workflow_run", preExisting, workflowPayload()),
      env,
      { now: () => DISPATCH_TEST_NOW },
    );
    expect(blocked.status).toBe(202);
    expect(await blocked.json()).toEqual({ accepted: true, duplicate: true });
    expect(outboxRow(database, preExisting)).toBeUndefined();
    expect(auditRows(database, preExisting)).toHaveLength(0);
  });

  it("V5/V15 DLQ routing dead-letters a sending row and spares a queued row in mode off", async () => {
    const { database, d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);
    const queue = new FakeQueue();
    const fetchSpy = vi.fn<typeof fetch>();

    // Marked message on the DLQ (DLQ-first branch in handleQueue): the row
    // in `sending` transitions to dead_letter and the message acks (§6.5
    // row 16).
    await store.insert({
      deliveryId: "wiring-dlq-sending",
      destination: "alerts",
      shadow: false,
      payloadJson: '{"text":"dlq"}',
      now: DISPATCH_TEST_NOW,
    });
    expect(await store.claim("wiring-dlq-sending", DISPATCH_TEST_NOW)).not.toBeNull();
    const sendingArrival = markedBatch(ALERT_DLQ, "wiring-dlq-sending");
    await handleQueue(
      sendingArrival.batch,
      makeEnv(queue, { db: d1, dispatchMode: "primary" }),
      { now: () => DISPATCH_TEST_NOW, fetch: fetchSpy },
    );
    expect(sendingArrival.ack).toHaveBeenCalledTimes(1);
    expect(sendingArrival.retry).not.toHaveBeenCalled();
    const dead = database
      .prepare(
        "SELECT state, last_error FROM dispatch_outbox WHERE delivery_id = ?",
      )
      .get("wiring-dlq-sending") as { state: string; last_error: string };
    expect(dead).toEqual({
      state: "dead_letter",
      last_error: "cloudflare_queue_dead_letter",
    });

    // Same arrival in mode off with the row still queued: R20 deferral trips
    // are deliberate pauses — ack WITHOUT any transition, the row stays
    // queued for the config-only re-enable.
    await store.insert({
      deliveryId: "wiring-dlq-off-queued",
      destination: "alerts",
      shadow: false,
      payloadJson: '{"text":"dlq off"}',
      now: DISPATCH_TEST_NOW,
    });
    const offArrival = markedBatch(ALERT_DLQ, "wiring-dlq-off-queued");
    await handleQueue(
      offArrival.batch,
      makeEnv(queue, { db: d1, dispatchMode: "off" }),
      { now: () => DISPATCH_TEST_NOW, fetch: fetchSpy },
    );
    expect(offArrival.ack).toHaveBeenCalledTimes(1);
    expect(outboxState(database, "wiring-dlq-off-queued")).toBe("queued");
    expect(
      auditRows(database, "wiring-dlq-off-queued").filter(
        (row) => row.to_state === "dead_letter",
      ),
    ).toHaveLength(0);
    // No send was ever attempted from the DLQ branch.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("V6 runDispatchScheduled processes the outbox even when the legacy protocol seal defers recovery", async () => {
    const { database, d1 } = dispatchDatabase();
    const queue = new FakeQueue();
    const env = makeEnv(queue, { db: d1, dispatchMode: "shadow" });
    const store = new D1DispatchStore(d1);
    const staleNow = DISPATCH_TEST_NOW - STALE_QUEUED_AGE_MS;
    await store.insert({
      deliveryId: "wiring-cron-shadow",
      destination: "activity",
      shadow: true,
      payloadJson: '{"text":"stale shadow"}',
      now: staleNow,
    });

    // The legacy scheduled recovery takes its protocol-seal early return...
    const legacyStore = new MemoryDeliveryStore();
    legacyStore.slackDeliveryProtocolActive = false;
    const recovery = await runScheduledRecovery(env, {
      store: legacyStore,
      now: () => DISPATCH_TEST_NOW,
    });
    expect(recovery).toEqual({ purged: 0, recovered: 0, enqueueFailures: 0 });

    // ...and the dispatch pass — wired OUTSIDE runScheduledRecovery in
    // scheduled() — still shadow-delivers the stale queued shadow row
    // (§9.A1: no Slack egress, no ts).
    const fetchSpy = vi.fn<typeof fetch>();
    await runDispatchScheduled(env, {
      now: () => DISPATCH_TEST_NOW,
      fetch: fetchSpy,
    });
    expect(outboxRow(database, "wiring-cron-shadow")).toMatchObject({
      state: "delivered",
      shadow: 1,
      slack_message_ts: null,
      slack_channel_id: null,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(queue.sent).toHaveLength(0);
  });

  it("V8/V10 cron republishes a stale non-shadow queued row in shadow mode and only alarms in mode off", async () => {
    const { database, d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);
    await store.insert({
      deliveryId: "wiring-republish",
      destination: "alerts",
      shadow: false,
      payloadJson: '{"text":"republish"}',
      now: DISPATCH_TEST_NOW - STALE_QUEUED_AGE_MS,
    });

    // §6.8 regime A: after a rollback flip to shadow the non-shadow backlog
    // still drains via a marked republish (consumer applies the
    // consume-time mode).
    const published: {
      destination: DispatchDestination;
      body: DispatchQueueJobBody;
    }[] = [];
    const readBotToken = vi.fn(async () => "xoxb-unused");
    const fetchSpy = vi.fn<typeof fetch>();
    const shadowPass = await runDispatchCronPass({
      database: d1,
      mode: "shadow",
      fetch: fetchSpy,
      now: () => DISPATCH_TEST_NOW,
      readBotToken,
      publish: async (destination, body) => {
        published.push({ destination, body });
      },
    });
    expect(shadowPass).toMatchObject({
      skipped: false,
      requeued: 1,
      shadowProcessed: 0,
    });
    expect(published).toEqual([
      {
        destination: "alerts",
        body: { deliveryId: "wiring-republish", path: "dispatch" },
      },
    ]);
    expect(shadowPass.alarms).not.toContain("queued_backlog_stale");
    expect(fetchSpy).not.toHaveBeenCalled();

    // R20 in mode off: nothing is processed or published; a queued row older
    // than 30 min raises the backlog alarm instead.
    database
      .prepare(
        "UPDATE dispatch_outbox SET created_ms = ?, updated_ms = ? WHERE delivery_id = ?",
      )
      .run(
        DISPATCH_TEST_NOW - 31 * 60_000,
        DISPATCH_TEST_NOW - 31 * 60_000,
        "wiring-republish",
      );
    const offPass = await runDispatchCronPass({
      database: d1,
      mode: "off",
      fetch: fetchSpy,
      now: () => DISPATCH_TEST_NOW,
      readBotToken,
      publish: async (destination, body) => {
        published.push({ destination, body });
      },
    });
    expect(offPass).toMatchObject({ skipped: false, requeued: 0 });
    expect(offPass.alarms).toContain("queued_backlog_stale");
    expect(published).toHaveLength(1);
    expect(outboxState(database, "wiring-republish")).toBe("queued");
    expect(readBotToken).not.toHaveBeenCalled();
  });

  it("V2 mode off pauses resolver egress entirely; mode primary resolves the same row", async () => {
    const { database, d1 } = dispatchDatabase();
    seedOutboxRow(database, {
      deliveryId: "wiring-ambiguous",
      destination: "alerts",
      state: "ambiguous",
      lastSendStartMs: DISPATCH_TEST_NOW - 3_600_000,
      createdMs: DISPATCH_TEST_NOW - 3_600_000,
    });

    // §6.8/R20 "egress pauses": with an ambiguous row due, mode off must not
    // read the bot token nor perform any fetch (panel V2).
    const readBotToken = vi.fn(async () => "xoxb-resolver-token");
    const offFetch = vi.fn<typeof fetch>();
    const offPass = await runDispatchCronPass({
      database: d1,
      mode: "off",
      fetch: offFetch,
      now: () => DISPATCH_TEST_NOW,
      readBotToken,
      publish: async () => {},
    });
    expect(offPass.resolverExamined).toBe(0);
    expect(readBotToken).not.toHaveBeenCalled();
    expect(offFetch).not.toHaveBeenCalled();
    expect(outboxState(database, "wiring-ambiguous")).toBe("ambiguous");

    // Same row in primary: the resolver runs, scans history and lands FOUND.
    const { fetch: historyFetch, calls } = scriptedFetch((url) =>
      url.startsWith(HISTORY_URL)
        ? slackHistoryPage([
            historyMessage({
              ts: "1786708800.000100",
              deliveryId: "wiring-ambiguous",
            }),
          ])
        : undefined,
    );
    const primaryPass = await runDispatchCronPass({
      database: d1,
      mode: "primary",
      fetch: historyFetch,
      now: () => DISPATCH_TEST_NOW,
      readBotToken,
      publish: async () => {},
    });
    expect(primaryPass.resolverExamined).toBe(1);
    expect(readBotToken).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.startsWith(HISTORY_URL)).toBe(true);
    expect(outboxRow(database, "wiring-ambiguous")).toMatchObject({
      state: "delivered",
      slack_message_ts: "1786708800.000100",
    });
  });

  it("V12 an expired shadow lease returns to queued (never ambiguous) with a lease_expired_shadow audit", async () => {
    const { database, d1 } = dispatchDatabase();
    seedOutboxRow(database, {
      deliveryId: "wiring-shadow-lease",
      destination: "activity",
      state: "sending",
      shadow: 1,
      leaseUntilMs: DISPATCH_TEST_NOW - 1_000,
      createdMs: DISPATCH_TEST_NOW - 120_000,
    });
    const store = new D1DispatchStore(d1);

    expect(await store.normalizeExpiredLeases(DISPATCH_TEST_NOW)).toBe(1);

    expect(outboxRow(database, "wiring-shadow-lease")).toMatchObject({
      state: "queued",
      shadow: 1,
      last_error: "lease_expired_shadow",
      lease_until_ms: null,
    });
    const audits = auditRows(database, "wiring-shadow-lease");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      from_state: "sending",
      to_state: "queued",
      actor: "resolver",
      evidence_json: '{"reason":"lease_expired_shadow"}',
    });
  });

  it("V13 completeVerificationScan CASes on the remaining-scan snapshot and decrements exactly once", async () => {
    const { database, d1 } = dispatchDatabase();
    seedOutboxRow(database, {
      deliveryId: "wiring-verify",
      destination: "alerts",
      state: "delivered",
      slackChannelId: ALERTS_CHANNEL,
      slackMessageTs: "1786665600.000100",
      verifyScansRemaining: 2,
      verifyAfterMs: DISPATCH_TEST_NOW - 1_000,
    });
    const store = new D1DispatchStore(d1);
    const nextScanMs = DISPATCH_TEST_NOW + 24 * 60 * 60 * 1_000;

    // Mismatching snapshot: no decrement, no schedule change (panel V13).
    expect(
      await store.completeVerificationScan(
        "wiring-verify",
        DISPATCH_TEST_NOW,
        nextScanMs,
        1,
      ),
    ).toBe(false);
    expect(outboxRow(database, "wiring-verify")).toMatchObject({
      verify_scans_remaining: 2,
      verify_after_ms: DISPATCH_TEST_NOW - 1_000,
    });

    // Correct snapshot: decrements exactly once and stamps the next scan.
    expect(
      await store.completeVerificationScan(
        "wiring-verify",
        DISPATCH_TEST_NOW,
        nextScanMs,
        2,
      ),
    ).toBe(true);
    expect(outboxRow(database, "wiring-verify")).toMatchObject({
      verify_scans_remaining: 1,
      verify_after_ms: nextScanMs,
    });

    // Replaying the stale snapshot cannot double-decrement.
    expect(
      await store.completeVerificationScan(
        "wiring-verify",
        DISPATCH_TEST_NOW,
        nextScanMs,
        2,
      ),
    ).toBe(false);
    expect(outboxRow(database, "wiring-verify")).toMatchObject({
      verify_scans_remaining: 1,
    });
  });

  it("V16/R2 a late ok:true lands via the unconditional audit append and the ambiguous->delivered CAS", async () => {
    const { database, d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);
    const deliveryId = "wiring-late-proof";
    await store.insert({
      deliveryId,
      destination: "alerts",
      shadow: false,
      payloadJson: '{"text":"late proof"}',
      now: DISPATCH_TEST_NOW,
    });

    // The scripted fetch mutates the row OUT of `sending` synchronously
    // before answering ok:true — the markDelivered CAS then no-ops and the
    // §6.3 late-proof rule must land the canonical proof anyway.
    const { fetch: concurrentFetch } = scriptedFetch((url) => {
      if (url !== POST_URL) return undefined;
      database
        .prepare(
          "UPDATE dispatch_outbox SET state = 'ambiguous', updated_ms = ? WHERE delivery_id = ?",
        )
        .run(DISPATCH_TEST_NOW, deliveryId);
      return slackPostOk("1786708800.000200", ALERTS_CHANNEL);
    });
    const { message, ack, retry } = consumerMessage(deliveryId);
    await processDispatchMessage(message, consumerDeps(store, concurrentFetch));

    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    expect(outboxRow(database, deliveryId)).toMatchObject({
      state: "delivered",
      slack_message_ts: "1786708800.000200",
      slack_channel_id: ALERTS_CHANNEL,
    });
    const lateProof = auditRows(database, deliveryId).filter(
      (row) =>
        typeof row.evidence_json === "string" &&
        row.evidence_json.includes('"late_proof":true') &&
        row.evidence_json.includes('"ts":"1786708800.000200"'),
    );
    // Unconditional append first (R2), then the ambiguous->delivered CAS.
    expect(lateProof).toHaveLength(2);
    expect(lateProof[0]).toMatchObject({
      from_state: "ambiguous",
      to_state: "ambiguous",
    });
    expect(lateProof[1]).toMatchObject({
      from_state: "ambiguous",
      to_state: "delivered",
    });
  });

  it("V19 the consumer pins the send abort to DISPATCH_CLIENT_TIMEOUT_MS (30 s)", async () => {
    const { d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);
    const deliveryId = "wiring-timeout-pin";
    await store.insert({
      deliveryId,
      destination: "activity",
      shadow: false,
      payloadJson: '{"text":"timeout"}',
      now: DISPATCH_TEST_NOW,
    });
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    try {
      const { fetch: postFetch } = scriptedFetch((url) =>
        url === POST_URL
          ? slackPostOk("1786708800.000300", ACTIVITY_CHANNEL)
          : undefined,
      );
      const { message, ack } = consumerMessage(deliveryId);
      await processDispatchMessage(message, consumerDeps(store, postFetch));

      expect(ack).toHaveBeenCalledTimes(1);
      expect(DISPATCH_CLIENT_TIMEOUT_MS).toBe(30_000);
      expect(timeoutSpy).toHaveBeenCalledTimes(1);
      expect(timeoutSpy).toHaveBeenCalledWith(30_000);
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});
