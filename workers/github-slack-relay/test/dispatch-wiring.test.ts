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
  DISPATCH_LEASE_MS,
  STALE_QUEUED_REQUEUE_AFTER_MS,
  VERIFY_FIRST_SCAN_DELAY_MS,
  type DispatchDestination,
} from "../src/dispatch/contract";
import { D1DispatchStore } from "../src/dispatch/outbox";
import {
  acceptPrimary,
  channelForDestination,
  DispatchCronPassError,
  insertLegacyFenced,
  insertShadowPaired,
  runDispatchCronPass,
  type DispatchQueueJobBody,
} from "../src/dispatch/wiring";
import {
  handleFetch,
  handleQueue,
  runDispatchScheduled,
  runScheduled,
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
  TEST_RELAY_SIGNING_SECRET_NEXT,
  workflowPayload,
} from "./helpers";

const POST_URL = "https://slack.com/api/chat.postMessage";
const HISTORY_URL = "https://slack.com/api/conversations.history";
const ALERTS_CHANNEL = "C0BMUK793NV";
// §10 H1: the channel the OFFICIAL "GitHub for Slack" app owns — a shape-valid
// id the dispatcher must never accept as proof (review finding N2).
const ACTIVITY_CHANNEL = "C0BMQMW3L4E";
const ALERT_QUEUE_NAME = "github-slack-alerts";
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
  // Review finding N1: an ambiguous row deferred by a recorded Retry-After
  // (§6.2/R4) is the shape that proves the resolver gate reads DUE rows.
  nextAttemptMs?: number | null;
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
         last_send_start_ms, lease_until_ms, next_attempt_ms, verify_after_ms,
         verify_scans_remaining, slack_channel_id, slack_message_ts,
         created_ms, updated_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.deliveryId,
      input.destination,
      input.shadow ?? 0,
      '{"fixture":"wiring"}',
      input.state,
      input.lastSendStartMs ?? null,
      input.leaseUntilMs ?? null,
      input.nextAttemptMs ?? null,
      input.verifyAfterMs ?? null,
      input.verifyScansRemaining ?? 0,
      input.slackChannelId ?? null,
      input.slackMessageTs ?? null,
      input.createdMs ?? DISPATCH_TEST_NOW,
      input.updatedMs ?? input.createdMs ?? DISPATCH_TEST_NOW,
    );
}

// §10 fixture: an `issues`/`opened` event normalizes to destination
// "activity" (src/domain.ts) — the path the dispatcher no longer owns.
function issuesPayload(): Record<string, unknown> {
  return {
    action: "opened",
    organization: { login: "LCV-Ideas-Software" },
    repository: {
      archived: false,
      default_branch: "main",
      full_name: "LCV-Ideas-Software/cross-review",
      owner: { login: "LCV-Ideas-Software" },
    },
    sender: { login: "octocat" },
    issue: {
      created_at: "2026-08-03T11:58:00Z",
      html_url: "https://github.com/LCV-Ideas-Software/cross-review/issues/1",
      number: 1,
      title: "fixture issue",
      updated_at: "2026-08-03T12:00:00Z",
    },
  };
}

function legacyRow(
  database: DatabaseSync,
  deliveryId: string,
): { status: string; destination: string } | undefined {
  return database
    .prepare("SELECT status, destination FROM deliveries WHERE delivery_id = ?")
    .get(deliveryId) as { status: string; destination: string } | undefined;
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
    // Review finding F4: the key set is pinned deliberately and grows by
    // exactly the two ALARMED aggregates the body used to drop. Both are
    // counts, so §6.7's "aggregate counters only" rule is unchanged — the
    // runbook sends the operator here until the F3 channel exists (§10 H26).
    expect(Object.keys(dispatch).sort()).toEqual([
      "counters",
      "oldest_non_terminal_age_ms",
      "repaired_duplicates",
      "unreconciled_deletion_intents",
      "verification_abandoned",
    ]);
    const counters = dispatch["counters"] as Record<
      string,
      Record<string, number>
    >;
    // §10: a single destination — the dispatcher no longer owns activity.
    expect(Object.keys(counters).sort()).toEqual(["alerts"]);
    expect(counters["alerts"]).toMatchObject({ queued: 1, sending: 0 });
    expect(dispatch["oldest_non_terminal_age_ms"]).toBe(1_000);
    expect(dispatch["repaired_duplicates"]).toBe(0);
    expect(dispatch["verification_abandoned"]).toBe(0);
    expect(dispatch["unreconciled_deletion_intents"]).toBe(0);
  });

  it("F4 /status surfaces the two alarmed aggregates it used to drop", async () => {
    const { database, d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);
    // A delivered row that gave up on verification (§10 H14) — the shape
    // statusCounters turns into the `verification_abandoned` alarm.
    seedOutboxRow(database, {
      deliveryId: "wiring-status-abandoned",
      destination: "alerts",
      state: "delivered",
      slackMessageTs: "1786664000.000100",
      slackChannelId: "C0BMUK793NV",
      verifyScansRemaining: 2,
      verifyAfterMs: null,
      createdMs: DISPATCH_TEST_NOW - 1_000,
    });
    // A duplicate-deletion intent with no outcome marker (§10 H21 + review
    // finding F3): the chat.delete may have been applied and its repair record
    // never landed, so it is the one loss no later scan can rebuild.
    await store.appendAudit({
      deliveryId: "wiring-status-abandoned",
      fromState: "delivered",
      toState: "delivered",
      evidenceJson: JSON.stringify({
        duplicate_deletion_intent: true,
        canonical_ts: "1786664000.000100",
        target_ts: "1786664900.000200",
      }),
      actor: "resolver",
      atMs: DISPATCH_TEST_NOW - 500,
    });

    const response = await handleFetch(
      new Request("https://relay.example/status"),
      makeEnv(new FakeQueue(), { db: d1 }),
      { now: () => DISPATCH_TEST_NOW },
    );

    expect(response.status).toBe(200);
    const dispatch = ((await response.json()) as Record<string, unknown>)[
      "dispatch"
    ] as Record<string, unknown>;
    // Both alarms are actionable and, until F3, only reachable through here.
    expect(dispatch["verification_abandoned"]).toBe(1);
    expect(dispatch["unreconciled_deletion_intents"]).toBe(1);
    // §6.7 unchanged: no identifiers on the unauthenticated surface.
    expect(JSON.stringify(dispatch)).not.toContain("wiring-status-abandoned");
    expect(JSON.stringify(dispatch)).not.toContain("1786664900.000200");
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

  it("F8: the outbox INSERT refuses a GUID with a legacy row inside the same statement (non-shadow only)", async () => {
    const { database, d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);
    // Copilot finding F8 / ADR §6.8: the presence fence is enforced INSIDE
    // the insert batch, closing the check-then-insert window — no outbox
    // row and no audit row commit over a legacy row.
    seedLegacyDelivery(database, "wiring-f8-legacy-first");
    expect(
      await store.insert({
        deliveryId: "wiring-f8-legacy-first",
        destination: "alerts",
        shadow: false,
        payloadJson: '{"text":"fenced"}',
        now: DISPATCH_TEST_NOW,
      }),
    ).toBe(false);
    expect(outboxRow(database, "wiring-f8-legacy-first")).toBeUndefined();
    expect(auditRows(database, "wiring-f8-legacy-first")).toHaveLength(0);

    // Shadow inserts stay exempt (§6.8: F2 pairing requires the legacy row).
    seedLegacyDelivery(database, "wiring-f8-legacy-shadow");
    expect(
      await store.insert({
        deliveryId: "wiring-f8-legacy-shadow",
        destination: "alerts",
        shadow: true,
        payloadJson: '{"text":"shadow"}',
        now: DISPATCH_TEST_NOW,
      }),
    ).toBe(true);
    expect(outboxRow(database, "wiring-f8-legacy-shadow")).toMatchObject({
      shadow: 1,
      state: "queued",
    });
  });

  it("F8: insertLegacyFenced refuses a GUID with a non-shadow outbox row and ignores shadow rows", async () => {
    const { database, d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);
    const legacyInput = (deliveryId: string) => ({
      deliveryId,
      eventType: "workflow_run",
      action: "completed",
      repository: "proj-x/exemplo-projeto-000",
      destination: "alerts" as const,
      payloadJson: "{}",
      now: DISPATCH_TEST_NOW,
    });

    // Non-shadow outbox row present: the legacy INSERT itself refuses
    // (Copilot F8 — concurrent-shape scenario, asserted at the SQL level).
    await store.insert({
      deliveryId: "wiring-f8-outbox-first",
      destination: "alerts",
      shadow: false,
      payloadJson: '{"text":"outbox"}',
      now: DISPATCH_TEST_NOW,
    });
    expect(
      await insertLegacyFenced(d1, legacyInput("wiring-f8-outbox-first")),
    ).toBe(false);
    const blocked = database
      .prepare("SELECT COUNT(*) AS n FROM deliveries WHERE delivery_id = ?")
      .get("wiring-f8-outbox-first") as { n: number };
    expect(blocked.n).toBe(0);

    // A shadow outbox row does not block (§6.8: shadow rows are excluded).
    await store.insert({
      deliveryId: "wiring-f8-shadow-outbox",
      destination: "alerts",
      shadow: true,
      payloadJson: '{"text":"shadow"}',
      now: DISPATCH_TEST_NOW,
    });
    expect(
      await insertLegacyFenced(d1, legacyInput("wiring-f8-shadow-outbox")),
    ).toBe(true);
    // ON CONFLICT DO NOTHING semantics preserved: a replay is a duplicate.
    expect(
      await insertLegacyFenced(d1, legacyInput("wiring-f8-shadow-outbox")),
    ).toBe(false);
  });

  it("F8: insertShadowPaired's legacy INSERT carries the same fence — nothing commits over a non-shadow outbox row", async () => {
    const { database, d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);
    await store.insert({
      deliveryId: "wiring-f8-paired",
      destination: "alerts",
      shadow: false,
      payloadJson: '{"text":"primary row"}',
      now: DISPATCH_TEST_NOW,
    });
    const auditCountBefore = auditRows(database, "wiring-f8-paired").length;

    const paired = await insertShadowPaired(d1, {
      deliveryId: "wiring-f8-paired",
      eventType: "workflow_run",
      action: "completed",
      repository: "proj-x/exemplo-projeto-000",
      destination: "alerts",
      payloadJson: "{}",
      now: DISPATCH_TEST_NOW,
    });

    expect(paired).toEqual({ legacyInserted: false, shadowInserted: false });
    const legacyCount = database
      .prepare("SELECT COUNT(*) AS n FROM deliveries WHERE delivery_id = ?")
      .get("wiring-f8-paired") as { n: number };
    expect(legacyCount.n).toBe(0);
    expect(outboxRow(database, "wiring-f8-paired")).toMatchObject({
      shadow: 0,
      state: "queued",
    });
    expect(auditRows(database, "wiring-f8-paired")).toHaveLength(
      auditCountBefore,
    );
  });

  it("F8: off-mode ingress with the default D1 store routes through the fenced legacy insert end-to-end", async () => {
    const { database, d1 } = dispatchDatabase();
    const queue = new FakeQueue();
    const env = makeEnv(queue, { db: d1, dispatchMode: "off" });
    const deliveryId = "00000000-0000-4000-9000-000000000301";

    // No store override: dependencies.store is the default D1DeliveryStore,
    // so index.ts must take the insertLegacyFenced branch (Copilot F8) with
    // the response semantics unchanged.
    const response = await handleFetch(
      await signedRequest("workflow_run", deliveryId, workflowPayload()),
      env,
      { now: () => DISPATCH_TEST_NOW },
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true, queued: true });
    const legacy = database
      .prepare("SELECT status FROM deliveries WHERE delivery_id = ?")
      .get(deliveryId) as { status: string } | undefined;
    expect(legacy?.status).toBe("queued");
    // Off mode keeps publishing the UNMARKED legacy queue body.
    expect(queue.sent).toEqual([{ deliveryId }]);
  });

  it("F6: an old manual row plus a fresh ambiguous row never raises ambiguous_stale (ADR §6.7)", async () => {
    const { database, d1 } = dispatchDatabase();
    const OLD_CREATED_MS = DISPATCH_TEST_NOW - 31 * 60_000;
    seedOutboxRow(database, {
      deliveryId: "wiring-f6-old-manual",
      destination: "alerts",
      state: "manual",
      createdMs: OLD_CREATED_MS,
    });
    seedOutboxRow(database, {
      deliveryId: "wiring-f6-fresh-ambiguous",
      destination: "alerts",
      state: "ambiguous",
      createdMs: DISPATCH_TEST_NOW - 60_000,
    });
    // Copilot finding F6: the counters expose the oldest AMBIGUOUS age as
    // its own additive field; the non-terminal age stays for the drain
    // view and the queued-backlog alarm.
    const store = new D1DispatchStore(d1);
    const counters = await store.statusCounters(DISPATCH_TEST_NOW);
    expect(counters.oldestAmbiguousAgeMs).toBe(60_000);
    expect(counters.oldestNonTerminalAgeMs).toBe(31 * 60_000);

    // Mode off: no egress, alarms still computed from the snapshot.
    const readBotToken = vi.fn(async () => "xoxb-unused");
    const fetchSpy = vi.fn<typeof fetch>();
    const cronDeps = {
      database: d1,
      mode: "off" as const,
      fetch: fetchSpy,
      now: () => DISPATCH_TEST_NOW,
      readBotToken,
      publish: async () => {},
    };
    const first = await runDispatchCronPass(cronDeps);
    expect(first.alarms).toContain("manual_present");
    expect(first.alarms).not.toContain("ambiguous_stale");

    // Once the AMBIGUOUS row itself is older than 30 min, the alarm fires.
    database
      .prepare("UPDATE dispatch_outbox SET created_ms = ? WHERE delivery_id = ?")
      .run(OLD_CREATED_MS, "wiring-f6-fresh-ambiguous");
    const second = await runDispatchCronPass(cronDeps);
    expect(second.alarms).toContain("ambiguous_stale");
    expect(second.alarms).toContain("manual_present");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readBotToken).not.toHaveBeenCalled();
  });

  // Copilot suppressed comment (F3) / ADR §6.7 + R5: a Secrets Store or Slack
  // failure threw before the observer snapshot, so every existing alarm
  // vanished exactly while resolver egress was unhealthy — only the generic
  // cron failure log remained. The alarms are read-only and must always run.
  it("suppressed F3: a throwing resolver step still yields the observer alarms, and the original failure still propagates", async () => {
    const { database, d1 } = dispatchDatabase();
    const staleCreatedMs = DISPATCH_TEST_NOW - 31 * 60_000;
    seedOutboxRow(database, {
      deliveryId: "wiring-f3-manual",
      destination: "alerts",
      state: "manual",
      createdMs: staleCreatedMs,
    });
    seedOutboxRow(database, {
      deliveryId: "wiring-f3-dead-letter",
      destination: "alerts",
      state: "dead_letter",
      createdMs: staleCreatedMs,
    });
    seedOutboxRow(database, {
      deliveryId: "wiring-f3-stale-ambiguous",
      destination: "alerts",
      state: "ambiguous",
      createdMs: staleCreatedMs,
    });

    const secretFailure = new Error("secrets_store_unavailable");
    const cronDeps = {
      database: d1,
      mode: "primary" as const,
      fetch: vi.fn<typeof fetch>(),
      now: () => DISPATCH_TEST_NOW,
      // The §6.3.1 resolver step: reading the bot token fails.
      readBotToken: vi.fn(async () => {
        throw secretFailure;
      }),
      publish: async () => {},
    };

    const failure = await runDispatchCronPass(cronDeps).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(DispatchCronPassError);
    const passError = failure as InstanceType<typeof DispatchCronPassError>;
    // The alarms exist DESPITE the failure...
    expect([...passError.alarms].sort()).toEqual([
      "ambiguous_stale",
      "dead_letter_present",
      "manual_present",
    ]);
    // ...and the original error still propagates, untouched, as the cause.
    expect(passError.cause).toBe(secretFailure);

    // End to end: the scheduled entrypoint logs the same alarm set it would
    // have logged on a healthy pass, plus the unchanged failure summary.
    const brokenToken = {
      get: async () => {
        throw secretFailure;
      },
    } as unknown as SecretsStoreSecret;
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    let logged: string[];
    try {
      await runDispatchScheduled(
        {
          ...makeEnv(new FakeQueue(), { db: d1, dispatchMode: "primary" }),
          SLACK_DISPATCH_BOT_TOKEN: brokenToken,
        },
        { now: () => DISPATCH_TEST_NOW },
      );
      // Read before mockRestore: it resets the recorded calls.
      logged = errorLog.mock.calls.map((call) => String(call[0]));
    } finally {
      errorLog.mockRestore();
    }
    expect(
      logged.filter((line) => line.includes('"dispatch_cron_pass_failed"')),
    ).toHaveLength(1);
    for (const alarm of [
      "manual_present",
      "dead_letter_present",
      "ambiguous_stale",
    ]) {
      expect(
        logged.some(
          (line) =>
            line.includes('"dispatch_observer_alarm"') && line.includes(alarm),
        ),
      ).toBe(true);
    }
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
    // Audit finding B3 (ADR §10 H15): the DLQ arrival is placed AFTER the 90 s
    // lease expired, which is the shape H9 means by "a crash between claim and
    // outcome". A live-lease arrival is spared instead — pinned by the
    // dedicated test below.
    const crashedArrivalMs = DISPATCH_TEST_NOW + DISPATCH_LEASE_MS + 1_000;
    await handleQueue(
      sendingArrival.batch,
      makeEnv(queue, { db: d1, dispatchMode: "primary" }),
      { now: () => crashedArrivalMs, fetch: fetchSpy },
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

  // Audit finding B3/B8 (ADR §10 H15): duplicate DLQ arrivals are routine, and
  // the handler decided from a bare read-then-act snapshot while the store
  // predicate did not encode that decision — so a row in `sending` under a
  // LIVE lease was dead-lettered mid-flight.
  it("B3: a DLQ arrival while the lease is still live spares the row; the same arrival after the lease dead-letters it", async () => {
    const { database, d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);
    const queue = new FakeQueue();
    const fetchSpy = vi.fn<typeof fetch>();
    const deliveryId = "wiring-dlq-live-lease";

    await store.insert({
      deliveryId,
      destination: "alerts",
      shadow: false,
      payloadJson: '{"text":"dlq live lease"}',
      now: DISPATCH_TEST_NOW,
    });
    expect(await store.claim(deliveryId, DISPATCH_TEST_NOW)).not.toBeNull();

    const liveArrival = markedBatch(ALERT_DLQ, deliveryId);
    await handleQueue(
      liveArrival.batch,
      makeEnv(queue, { db: d1, dispatchMode: "primary" }),
      { now: () => DISPATCH_TEST_NOW + DISPATCH_LEASE_MS - 1, fetch: fetchSpy },
    );

    // Acked (the row is durable and owned by the in-flight send), untouched.
    expect(liveArrival.ack).toHaveBeenCalledTimes(1);
    expect(liveArrival.retry).not.toHaveBeenCalled();
    expect(outboxState(database, deliveryId)).toBe("sending");
    expect(
      auditRows(database, deliveryId).filter(
        (row) => row.to_state === "dead_letter",
      ),
    ).toHaveLength(0);

    // After the lease: the crash between claim and outcome H9 describes.
    const crashedArrival = markedBatch(ALERT_DLQ, deliveryId);
    await handleQueue(
      crashedArrival.batch,
      makeEnv(queue, { db: d1, dispatchMode: "primary" }),
      { now: () => DISPATCH_TEST_NOW + DISPATCH_LEASE_MS + 1, fetch: fetchSpy },
    );
    expect(outboxState(database, deliveryId)).toBe("dead_letter");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Audit finding B3 (the amplifier): the cron republished every stale queued
  // row on EVERY pass, because the republish changed nothing on the row.
  it("B3: the cron republishes a stale queued row once per interval, not once per pass", async () => {
    const { d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);
    const deliveryId = "wiring-republish-spacing";
    await store.insert({
      deliveryId,
      destination: "alerts",
      shadow: false,
      payloadJson: '{"text":"republish spacing"}',
      now: DISPATCH_TEST_NOW - STALE_QUEUED_AGE_MS,
    });
    const published: string[] = [];
    const cronDeps = (now: number) => ({
      database: d1,
      mode: "primary" as const,
      fetch: vi.fn<typeof fetch>(),
      now: () => now,
      readBotToken: async () => "xoxb-unused",
      publish: async (
        _destination: DispatchDestination,
        body: DispatchQueueJobBody,
      ) => {
        published.push(body.deliveryId);
      },
    });

    expect(await runDispatchCronPass(cronDeps(DISPATCH_TEST_NOW))).toMatchObject(
      { requeued: 1 },
    );
    // The very next cron pass (5 min later, the */5 schedule) must NOT
    // republish the same row again.
    expect(
      await runDispatchCronPass(
        cronDeps(DISPATCH_TEST_NOW + STALE_QUEUED_REQUEUE_AFTER_MS),
      ),
    ).toMatchObject({ requeued: 0 });
    expect(published).toEqual([deliveryId]);

    // One full interval after the republish it becomes an input again (R13
    // keeps re-entering the row until it leaves `queued`).
    expect(
      await runDispatchCronPass(
        cronDeps(DISPATCH_TEST_NOW + STALE_QUEUED_REQUEUE_AFTER_MS + 1),
      ),
    ).toMatchObject({ requeued: 1 });
    expect(published).toEqual([deliveryId, deliveryId]);
  });

  // Audit finding B1 / ADR §10 H14: the livelocked verification had no
  // observer alarm — observer.ts had no condition matching a `delivered` row.
  // A row that gave up on verification must be visible in the SAME alarm set
  // the operator already watches.
  it("B1: a row whose verification was abandoned raises the observer alarm through the cron pass", async () => {
    const { database, d1 } = dispatchDatabase();
    // The shape abandonVerification leaves: delivered, scans still remaining,
    // no due time — and therefore invisible to verificationRowsDue.
    seedOutboxRow(database, {
      deliveryId: "wiring-verification-abandoned",
      destination: "alerts",
      state: "delivered",
      slackChannelId: ALERTS_CHANNEL,
      slackMessageTs: "1786708800.000900",
      verifyScansRemaining: 2,
      verifyAfterMs: null,
      createdMs: DISPATCH_TEST_NOW - 3_600_000,
    });
    const readBotToken = vi.fn(async () => "xoxb-unused");
    const fetchSpy = vi.fn<typeof fetch>();

    const pass = await runDispatchCronPass({
      database: d1,
      mode: "primary",
      fetch: fetchSpy,
      now: () => DISPATCH_TEST_NOW,
      readBotToken,
      publish: async () => {},
    });

    expect(pass.alarms).toContain("verification_abandoned");
    // Read-only: the alarm never re-arms the row (R5), and no egress happened.
    expect(outboxRow(database, "wiring-verification-abandoned")).toMatchObject({
      verify_after_ms: null,
      verify_scans_remaining: 2,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Review finding C (class E8) — a failure in one unit of work must not exit
  // a pass that also carries INDEPENDENT work. The stale-row publish and the
  // resolver share one try: a queue-only outage froze the resolver too, even
  // though its recovery path is D1 plus Slack history and never touches the
  // queue.
  it("C: a stale-row publish failure does not stop lease normalization or the resolver", async () => {
    const { database, d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);
    const staleNow = DISPATCH_TEST_NOW - STALE_QUEUED_AGE_MS;
    // (1) a stale queued row whose republish will reject...
    await store.insert({
      deliveryId: "wiring-c-stale-publish-fails",
      destination: "alerts",
      shadow: false,
      payloadJson: '{"text":"stale"}',
      now: staleNow,
    });
    // (2) ...and an INDEPENDENT row in `sending` with an expired lease, whose
    // recovery is a pure D1 transition (§6.3.1 normalization, §10 H23).
    seedOutboxRow(database, {
      deliveryId: "wiring-c-expired-lease",
      destination: "alerts",
      state: "sending",
      leaseUntilMs: DISPATCH_TEST_NOW - 1_000,
      lastSendStartMs: DISPATCH_TEST_NOW - 200_000,
      createdMs: DISPATCH_TEST_NOW - 3_600_000,
    });

    const pass = await runDispatchCronPass({
      database: d1,
      mode: "primary",
      fetch: vi.fn<typeof fetch>(),
      now: () => DISPATCH_TEST_NOW,
      readBotToken: vi.fn(async () => "xoxb-unused"),
      publish: async () => {
        throw new Error("queue_unavailable");
      },
    });

    // The publish failure is contained and REPORTED, not swallowed...
    expect(pass.staleFailed).toBe(1);
    expect(pass.requeued).toBe(0);
    // ...the stale row keeps its stale window, so R13 re-selects it...
    expect(outboxRow(database, "wiring-c-stale-publish-fails")).toMatchObject({
      state: "queued",
      updated_ms: staleNow,
    });
    // ...and the independent row still reached the resolver's input state,
    // which is what makes it visible to the ambiguous_stale alarm.
    expect(outboxRow(database, "wiring-c-expired-lease")).toMatchObject({
      state: "ambiguous",
    });
    expect(pass.alarms).toContain("ambiguous_stale");
  });

  it("V6 runDispatchScheduled processes the outbox even when the legacy protocol seal defers recovery", async () => {
    const { database, d1 } = dispatchDatabase();
    const queue = new FakeQueue();
    const env = makeEnv(queue, { db: d1, dispatchMode: "shadow" });
    const store = new D1DispatchStore(d1);
    const staleNow = DISPATCH_TEST_NOW - STALE_QUEUED_AGE_MS;
    await store.insert({
      deliveryId: "wiring-cron-shadow",
      destination: "alerts",
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
      destination: "alerts",
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
        DISPATCH_TEST_NOW - 1_000,
      ),
    ).toBe(false);
    expect(outboxRow(database, "wiring-verify")).toMatchObject({
      verify_scans_remaining: 2,
      verify_after_ms: DISPATCH_TEST_NOW - 1_000,
    });

    // F1: the counter matches but the observed verify_after_ms does not —
    // the shape a rearm leaves behind. No decrement either.
    expect(
      await store.completeVerificationScan(
        "wiring-verify",
        DISPATCH_TEST_NOW,
        nextScanMs,
        2,
        DISPATCH_TEST_NOW - 999_999,
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
        DISPATCH_TEST_NOW - 1_000,
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
        DISPATCH_TEST_NOW - 1_000,
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
      destination: "alerts",
      shadow: false,
      payloadJson: '{"text":"timeout"}',
      now: DISPATCH_TEST_NOW,
    });
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    try {
      const { fetch: postFetch } = scriptedFetch((url) =>
        url === POST_URL
          ? slackPostOk("1786708800.000300", ALERTS_CHANNEL)
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

  it("§10 primary mode leaves an activity delivery on the legacy path — no outbox row, unmarked job", async () => {
    const { database, d1 } = dispatchDatabase();
    const alertsQueue = new FakeQueue();
    const activityQueue = new FakeQueue();
    const env = makeEnv(alertsQueue, {
      db: d1,
      dispatchMode: "primary",
      activityQueue,
    });
    const deliveryId = "00000000-0000-4000-9000-000000000401";

    const response = await handleFetch(
      await signedRequest("issues", deliveryId, issuesPayload()),
      env,
      { now: () => DISPATCH_TEST_NOW },
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true, queued: true });
    // The dispatcher never saw this delivery: no outbox row, no audit row.
    expect(outboxRow(database, deliveryId)).toBeUndefined();
    expect(auditRows(database, deliveryId)).toHaveLength(0);
    // The legacy table is the accepting path, carrying the activity row.
    expect(legacyRow(database, deliveryId)).toEqual({
      status: "queued",
      destination: "activity",
    });
    // UNMARKED legacy body on the activity queue; the alerts queue untouched.
    expect(activityQueue.sent).toEqual([{ deliveryId }]);
    expect(alertsQueue.sent).toHaveLength(0);
  });

  it("§10 shadow mode pairs no shadow row for an activity delivery — legacy row only", async () => {
    const { database, d1 } = dispatchDatabase();
    const alertsQueue = new FakeQueue();
    const activityQueue = new FakeQueue();
    const env = makeEnv(alertsQueue, {
      db: d1,
      dispatchMode: "shadow",
      activityQueue,
    });
    const deliveryId = "00000000-0000-4000-9000-000000000402";

    const response = await handleFetch(
      await signedRequest("issues", deliveryId, issuesPayload()),
      env,
      { now: () => DISPATCH_TEST_NOW },
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true, queued: true });
    expect(legacyRow(database, deliveryId)).toEqual({
      status: "queued",
      destination: "activity",
    });
    // §10: F2 pairing applies to alerts only — the outbox stays empty.
    expect(outboxRow(database, deliveryId)).toBeUndefined();
    expect(auditRows(database, deliveryId)).toHaveLength(0);
    const outboxCount = database
      .prepare("SELECT COUNT(*) AS n FROM dispatch_outbox")
      .get() as { n: number };
    expect(outboxCount.n).toBe(0);
    expect(activityQueue.sent).toEqual([{ deliveryId }]);
    expect(alertsQueue.sent).toHaveLength(0);
  });

  it("§10 statusCounters and the observer aggregate over the single destination", async () => {
    const { database, d1 } = dispatchDatabase();
    const staleMs = DISPATCH_TEST_NOW - 31 * 60_000;
    seedOutboxRow(database, {
      deliveryId: "wiring-single-queued",
      destination: "alerts",
      state: "queued",
      createdMs: staleMs,
    });
    seedOutboxRow(database, {
      deliveryId: "wiring-single-ambiguous",
      destination: "alerts",
      state: "ambiguous",
      createdMs: staleMs,
    });
    seedOutboxRow(database, {
      deliveryId: "wiring-single-manual",
      destination: "alerts",
      state: "manual",
      createdMs: DISPATCH_TEST_NOW - 1_000,
    });
    seedOutboxRow(database, {
      deliveryId: "wiring-single-delivered",
      destination: "alerts",
      state: "delivered",
      slackChannelId: ALERTS_CHANNEL,
      slackMessageTs: "1786708800.000400",
      createdMs: DISPATCH_TEST_NOW - 1_000,
    });

    const store = new D1DispatchStore(d1);
    const counters = await store.statusCounters(DISPATCH_TEST_NOW);
    expect(Object.keys(counters.byStateAndDestination)).toEqual(["alerts"]);
    expect(counters.byStateAndDestination.alerts).toEqual({
      queued: 1,
      sending: 0,
      ambiguous: 1,
      manual: 1,
      delivered: 1,
      dead_letter: 0,
      closed_manual: 0,
    });
    expect(counters.oldestAmbiguousAgeMs).toBe(31 * 60_000);
    expect(counters.oldestNonTerminalAgeMs).toBe(31 * 60_000);

    // The cron's aggregate helpers iterate the single destination: the pass
    // still sees every row and the observer still raises every alarm.
    const fetchSpy = vi.fn<typeof fetch>();
    const pass = await runDispatchCronPass({
      database: d1,
      mode: "off",
      fetch: fetchSpy,
      now: () => DISPATCH_TEST_NOW,
      readBotToken: async () => "xoxb-unused",
      publish: async () => {},
    });
    expect(pass.skipped).toBe(false);
    expect([...pass.alarms].sort()).toEqual([
      "ambiguous_stale",
      "manual_present",
      "queued_backlog_stale",
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("R20 a mode-off arrival is ACKED and the cron re-enters the row after the flip, never dead-lettering it", async () => {
    const { database, d1 } = dispatchDatabase();
    const queue = new FakeQueue();
    const store = new D1DispatchStore(d1);
    const deliveryId = "wiring-mode-off-reentry";
    const staleNow = DISPATCH_TEST_NOW - STALE_QUEUED_AGE_MS;
    await store.insert({
      deliveryId,
      destination: "alerts",
      shadow: false,
      payloadJson: '{"text":"mode off"}',
      now: staleNow,
    });

    // Cross-review round 4 (codex): mode off ACKS instead of retrying, so no
    // retry budget is consumed and no DLQ trip can dead-letter this healthy
    // queued row after a later re-enable.
    const arrival = markedBatch(ALERT_QUEUE_NAME, deliveryId);
    const fetchSpy = vi.fn<typeof fetch>();
    await handleQueue(
      arrival.batch,
      makeEnv(queue, { db: d1, dispatchMode: "off" }),
      { now: () => DISPATCH_TEST_NOW, fetch: fetchSpy },
    );
    expect(arrival.ack).toHaveBeenCalledTimes(1);
    expect(arrival.retry).not.toHaveBeenCalled();
    expect(outboxRow(database, deliveryId)).toMatchObject({
      state: "queued",
      updated_ms: staleNow,
    });
    expect(queue.sent).toHaveLength(0);

    // Config-only re-enable: the cron republishes the marked job with no
    // operator step (§6.8/R20 automatic re-entry).
    await runDispatchScheduled(
      makeEnv(queue, { db: d1, dispatchMode: "primary" }),
      { now: () => DISPATCH_TEST_NOW, fetch: fetchSpy },
    );
    expect(queue.sent).toEqual([{ deliveryId, path: "dispatch" }]);
    expect(outboxState(database, deliveryId)).toBe("queued");
    expect(
      auditRows(database, deliveryId).every(
        (row) => row.to_state !== "dead_letter",
      ),
    ).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Copilot suppressed comment (F1): the bot token used to be read BEFORE the
  // consume-time mode check, so in mode off a Secrets Store failure retried
  // the message instead of taking the R20 ack path — consuming max_retries
  // and recreating the DLQ/mode-flip failure §10.1 Residual 1 eliminated.
  it("suppressed F1: in mode off a failing bot-token secret still takes the R20 ack path, and the row is untouched", async () => {
    const { database, d1 } = dispatchDatabase();
    const queue = new FakeQueue();
    const store = new D1DispatchStore(d1);
    const deliveryId = "wiring-suppressed-f1-mode-off";
    await store.insert({
      deliveryId,
      destination: "alerts",
      shadow: false,
      payloadJson: '{"text":"mode off secret failure"}',
      now: DISPATCH_TEST_NOW,
    });
    const secretRead = vi.fn(async (): Promise<string> => {
      throw new Error("secrets_store_unavailable");
    });
    const brokenToken = { get: secretRead } as unknown as SecretsStoreSecret;
    const fetchSpy = vi.fn<typeof fetch>();

    const offArrival = markedBatch(ALERT_QUEUE_NAME, deliveryId);
    await handleQueue(
      offArrival.batch,
      {
        ...makeEnv(queue, { db: d1, dispatchMode: "off" }),
        SLACK_DISPATCH_BOT_TOKEN: brokenToken,
      },
      { now: () => DISPATCH_TEST_NOW, fetch: fetchSpy },
    );

    // The secret is never read while the mode is off, so its failure cannot
    // consume the queue's finite retry budget.
    expect(secretRead).not.toHaveBeenCalled();
    expect(offArrival.ack).toHaveBeenCalledTimes(1);
    expect(offArrival.retry).not.toHaveBeenCalled();
    expect(outboxRow(database, deliveryId)).toMatchObject({
      state: "queued",
      attempt_count: 0,
      last_send_start_ms: null,
      updated_ms: DISPATCH_TEST_NOW,
    });
    expect(fetchSpy).not.toHaveBeenCalled();

    // Outside mode off the deferral path is intact: the same failure retries
    // the message and still leaves the row queued.
    const primaryArrival = markedBatch(ALERT_QUEUE_NAME, deliveryId);
    await handleQueue(
      primaryArrival.batch,
      {
        ...makeEnv(queue, { db: d1, dispatchMode: "primary" }),
        SLACK_DISPATCH_BOT_TOKEN: brokenToken,
      },
      { now: () => DISPATCH_TEST_NOW, fetch: fetchSpy },
    );
    expect(secretRead).toHaveBeenCalledTimes(1);
    expect(primaryArrival.ack).not.toHaveBeenCalled();
    expect(primaryArrival.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(outboxState(database, deliveryId)).toBe("queued");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Copilot suppressed comment (F2): the dispatch pass is documented as
  // isolated from the legacy recovery, but a rejection from
  // runScheduledRecovery skipped it entirely.
  it("suppressed F2: a rejecting legacy recovery still runs the dispatch pass, and the legacy failure still surfaces", async () => {
    const { database, d1 } = dispatchDatabase();
    const queue = new FakeQueue();
    const store = new D1DispatchStore(d1);
    const deliveryId = "wiring-suppressed-f2-isolation";
    await store.insert({
      deliveryId,
      destination: "alerts",
      shadow: false,
      payloadJson: '{"text":"isolation"}',
      now: DISPATCH_TEST_NOW - STALE_QUEUED_AGE_MS,
    });

    // A D1/protocol lookup failure inside the legacy pass (the seal check
    // itself swallows errors, so the rejection comes from the next step).
    const legacyStore = new MemoryDeliveryStore();
    legacyStore.purgeDeliveredBefore = async (): Promise<number> => {
      throw new Error("legacy_recovery_failed");
    };
    const fetchSpy = vi.fn<typeof fetch>();

    await expect(
      runScheduled(makeEnv(queue, { db: d1, dispatchMode: "primary" }), {
        store: legacyStore,
        now: () => DISPATCH_TEST_NOW,
        fetch: fetchSpy,
      }),
    ).rejects.toThrow("legacy_recovery_failed");

    // Observable effect of the dispatch pass: the stale queued row was
    // republished (R13) despite the legacy rejection.
    expect(queue.sent).toEqual([{ deliveryId, path: "dispatch" }]);
    expect(outboxState(database, deliveryId)).toBe("queued");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Copilot suppressed comment (F7), transport consequence: the pacing retry
  // consumes the queue's retry budget, so a burst can push a message to the
  // DLQ while its row is still `queued` and perfectly healthy. §10.1
  // Residual 1 forbids dead-lettering such a row (it would require an
  // operator menu step, which §6.8/R20 excludes). Row 16's transport failure
  // keeps its transition: a `sending` row still dead-letters (V5/V15).
  it("suppressed F7: a deferral DLQ trip never dead-letters a healthy queued row, in any mode", async () => {
    const { database, d1 } = dispatchDatabase();
    const queue = new FakeQueue();
    const store = new D1DispatchStore(d1);
    const deliveryId = "wiring-suppressed-f7-dlq-queued";
    await store.insert({
      deliveryId,
      destination: "alerts",
      shadow: false,
      payloadJson: '{"text":"paced"}',
      now: DISPATCH_TEST_NOW - STALE_QUEUED_AGE_MS,
    });
    const fetchSpy = vi.fn<typeof fetch>();

    const arrival = markedBatch(ALERT_DLQ, deliveryId);
    await handleQueue(
      arrival.batch,
      makeEnv(queue, { db: d1, dispatchMode: "primary" }),
      { now: () => DISPATCH_TEST_NOW, fetch: fetchSpy },
    );

    expect(arrival.ack).toHaveBeenCalledTimes(1);
    expect(arrival.retry).not.toHaveBeenCalled();
    expect(outboxState(database, deliveryId)).toBe("queued");
    expect(
      auditRows(database, deliveryId).filter(
        (row) => row.to_state === "dead_letter",
      ),
    ).toHaveLength(0);

    // The row is durable and re-enters the pipeline through the cron, with
    // no operator step (§6.8/R20).
    await runDispatchScheduled(
      makeEnv(queue, { db: d1, dispatchMode: "primary" }),
      { now: () => DISPATCH_TEST_NOW, fetch: fetchSpy },
    );
    expect(queue.sent).toEqual([{ deliveryId, path: "dispatch" }]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// Copilot finding: operatorResend/operatorCloseManual had no route, so the
// audited operator menu of ADR §6.2/§6.3/§6.9 was unreachable and every
// manual/dead_letter row was parked permanently. The route authenticates
// with the EXISTING SLACK_RELAY_SIGNING_SECRET machinery (active slot), so
// no new binding and no new secret enter the worker.
describe("operator menu route (ADR §6.2/§6.3 I1)", () => {
  const OPERATOR_TIMESTAMP = String(Math.floor(DISPATCH_TEST_NOW / 1_000));
  const OPERATOR_EVIDENCE = "issue #192 operator menu fixture";
  // F8: canonical proof supplied by the operator for `mark_delivered`.
  const OPERATOR_PROOF_TS = "1786708800.000600";

  async function hmacHexadecimal(
    message: string,
    secret: string,
  ): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { hash: "SHA-256", name: "HMAC" },
      false,
      ["sign"],
    );
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: "HMAC" },
        key,
        new TextEncoder().encode(message),
      ),
    );
    return [...signature]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  // Mirrors the wire format pinned in src/index.ts: the signature travels
  // inside the body, over the version-tagged canonical array. Copilot
  // finding F8: the canonical proof of `mark_delivered` is part of that
  // canonical (empty for every other action), so an intercepted command can
  // never have its recorded ts swapped.
  async function operatorRequest(
    action: "resend" | "close_manual" | "sweep" | "mark_delivered",
    deliveryId: string,
    options: {
      secret?: string;
      signature?: string;
      timestamp?: string;
      slackMessageTs?: string;
      slackChannelId?: string;
    } = {},
  ): Promise<Request> {
    const timestamp = options.timestamp ?? OPERATOR_TIMESTAMP;
    const proof = action === "mark_delivered";
    const messageTs =
      options.slackMessageTs ?? (proof ? OPERATOR_PROOF_TS : "");
    const channelId =
      options.slackChannelId ?? (proof ? ALERTS_CHANNEL : "");
    const canonical = JSON.stringify([
      "dispatch_operator_action_v1",
      action,
      deliveryId,
      OPERATOR_EVIDENCE,
      timestamp,
      messageTs,
      channelId,
    ]);
    const signature =
      options.signature ??
      (await hmacHexadecimal(
        canonical,
        // makeEnv pins SLACK_RELAY_SIGNING_ACTIVE_SLOT to "next".
        options.secret ?? TEST_RELAY_SIGNING_SECRET_NEXT,
      ));
    return new Request("https://relay.example/dispatch/operator", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        delivery_id: deliveryId,
        evidence: OPERATOR_EVIDENCE,
        ...(proof
          ? { slack_message_ts: messageTs, slack_channel_id: channelId }
          : {}),
        request_timestamp: timestamp,
        request_signature: signature,
      }),
    });
  }

  it("a signed resend on a manual row queues it, publishes the marked job and audits the operator action", async () => {
    const { database, d1 } = dispatchDatabase();
    const queue = new FakeQueue();
    const deliveryId = "wiring-operator-manual";
    seedOutboxRow(database, {
      deliveryId,
      destination: "alerts",
      state: "manual",
    });

    const response = await handleFetch(
      await operatorRequest("resend", deliveryId),
      makeEnv(queue, { db: d1 }),
      { now: () => DISPATCH_TEST_NOW },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, queued: true });
    expect(outboxRow(database, deliveryId)).toMatchObject({
      state: "queued",
      // §6.3.3: the resend arms the two mandatory verification scans.
      verify_scans_remaining: 2,
    });
    expect(queue.sent).toEqual([{ deliveryId, path: "dispatch" }]);
    const entries = auditRows(database, deliveryId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actor: "operator",
      from_state: "manual",
      to_state: "queued",
    });
    expect(String(entries[0]?.["evidence_json"])).toContain(
      '"possible_duplicate":true',
    );
  });

  it("a signed resend on a dead_letter row takes the same audited path", async () => {
    const { database, d1 } = dispatchDatabase();
    const queue = new FakeQueue();
    const deliveryId = "wiring-operator-dead-letter";
    seedOutboxRow(database, {
      deliveryId,
      destination: "alerts",
      state: "dead_letter",
    });

    const response = await handleFetch(
      await operatorRequest("resend", deliveryId),
      makeEnv(queue, { db: d1 }),
      { now: () => DISPATCH_TEST_NOW },
    );

    expect(response.status).toBe(200);
    expect(outboxRow(database, deliveryId)).toMatchObject({
      state: "queued",
      verify_scans_remaining: 2,
    });
    expect(queue.sent).toEqual([{ deliveryId, path: "dispatch" }]);
    expect(auditRows(database, deliveryId)).toMatchObject([
      { actor: "operator", from_state: "dead_letter", to_state: "queued" },
    ]);
  });

  it("an unsigned or wrongly signed request is 401 with zero state change", async () => {
    const { database, d1 } = dispatchDatabase();
    const queue = new FakeQueue();
    const deliveryId = "wiring-operator-unsigned";
    seedOutboxRow(database, {
      deliveryId,
      destination: "alerts",
      state: "manual",
    });
    const env = makeEnv(queue, { db: d1 });

    // Well-formed body, signature computed with the wrong secret.
    const forged = await handleFetch(
      await operatorRequest("resend", deliveryId, {
        secret: "forged-operator-secret-at-least-32-bytes",
      }),
      env,
      { now: () => DISPATCH_TEST_NOW },
    );
    expect(forged.status).toBe(401);
    expect(await forged.json()).toEqual({ error: "invalid_signature" });

    // Structurally valid but meaningless signature.
    const unsigned = await handleFetch(
      await operatorRequest("resend", deliveryId, { signature: "0".repeat(64) }),
      env,
      { now: () => DISPATCH_TEST_NOW },
    );
    expect(unsigned.status).toBe(401);

    expect(outboxState(database, deliveryId)).toBe("manual");
    expect(queue.sent).toHaveLength(0);
    expect(auditRows(database, deliveryId)).toHaveLength(0);
  });

  it("a resend on a delivered row is 409 with zero state change (CAS changed nothing)", async () => {
    const { database, d1 } = dispatchDatabase();
    const queue = new FakeQueue();
    const deliveryId = "wiring-operator-delivered";
    seedOutboxRow(database, {
      deliveryId,
      destination: "alerts",
      state: "delivered",
      slackChannelId: ALERTS_CHANNEL,
      slackMessageTs: "1786708800.000500",
    });

    const response = await handleFetch(
      await operatorRequest("resend", deliveryId),
      makeEnv(queue, { db: d1 }),
      { now: () => DISPATCH_TEST_NOW },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "delivery_state_conflict" });
    expect(outboxRow(database, deliveryId)).toMatchObject({
      state: "delivered",
      slack_message_ts: "1786708800.000500",
      verify_scans_remaining: 0,
    });
    expect(queue.sent).toHaveLength(0);
    expect(auditRows(database, deliveryId)).toHaveLength(0);
  });

  it("a signed close_manual on a manual row closes it without any Slack egress or queue publish", async () => {
    const { database, d1 } = dispatchDatabase();
    const queue = new FakeQueue();
    const deliveryId = "wiring-operator-close";
    seedOutboxRow(database, {
      deliveryId,
      destination: "alerts",
      state: "manual",
    });

    const response = await handleFetch(
      await operatorRequest("close_manual", deliveryId),
      makeEnv(queue, { db: d1 }),
      { now: () => DISPATCH_TEST_NOW },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      state: "closed_manual",
    });
    expect(outboxState(database, deliveryId)).toBe("closed_manual");
    expect(queue.sent).toHaveLength(0);
    expect(auditRows(database, deliveryId)).toMatchObject([
      { actor: "operator", from_state: "manual", to_state: "closed_manual" },
    ]);
  });

  // Copilot review 4943012170 — the menu was missing the ADR's R19 sweep and
  // the §6.2 manual -> delivered transition, and every command was replayable
  // inside the freshness window.
  it("F5 sweep: a signed sweep re-arms verification on a delivered row and makes it resolver-due", async () => {
    const { database, d1 } = dispatchDatabase();
    const queue = new FakeQueue();
    const deliveryId = "wiring-operator-sweep";
    seedOutboxRow(database, {
      deliveryId,
      destination: "alerts",
      state: "delivered",
      slackChannelId: ALERTS_CHANNEL,
      slackMessageTs: "1786708800.000700",
      // The R19 shape: both automatic scans already spent.
      verifyScansRemaining: 0,
      verifyAfterMs: null,
    });

    const response = await handleFetch(
      await operatorRequest("sweep", deliveryId),
      makeEnv(queue, { db: d1 }),
      { now: () => DISPATCH_TEST_NOW },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      state: "delivered",
      verification_armed: true,
    });
    expect(outboxRow(database, deliveryId)).toMatchObject({
      state: "delivered",
      verify_scans_remaining: 1,
      // Due NOW: arming the counter without stamping verify_after_ms would
      // leave the row invisible to verificationRowsDue.
      verify_after_ms: DISPATCH_TEST_NOW,
    });
    const due = await new D1DispatchStore(d1).verificationRowsDue(
      DISPATCH_TEST_NOW,
      10,
    );
    expect(due.map((row) => row.deliveryId)).toContain(deliveryId);
    // No Slack egress, no queue publish — the next resolver pass repairs.
    expect(queue.sent).toHaveLength(0);
    const entries = auditRows(database, deliveryId);
    expect(entries).toMatchObject([
      { actor: "operator", from_state: "delivered", to_state: "delivered" },
    ]);
    expect(String(entries[0]?.["evidence_json"])).toContain(
      '"operator_action":"sweep"',
    );
  });

  // Panel finding (ADR §10 H11, corrected): the counter is CHECKed BETWEEN 0
  // AND 2 by migration 0010, and an operator-resent delivered row holds
  // exactly 2 — for ~15 min normally, and indefinitely while §6.3.3/R18
  // inconclusive scans defer without decrementing. That is exactly when the
  // operator reaches for the R19 sweep, and the unconditional increment made
  // the route answer 503 persistence_unavailable for a permanent state
  // precondition, with the audit row rolled back by the atomic batch.
  it("F5 sweep at the schema maximum: a sweep on an operator-resent delivered row (2 scans) is 200 and makes it resolver-due, not 503", async () => {
    const { database, d1 } = dispatchDatabase();
    const queue = new FakeQueue();
    const deliveryId = "wiring-operator-sweep-at-maximum";
    seedOutboxRow(database, {
      deliveryId,
      destination: "alerts",
      state: "delivered",
      slackChannelId: ALERTS_CHANNEL,
      slackMessageTs: "1786708800.000900",
      // The operator-resend shape: both scans armed, first one not yet due.
      verifyScansRemaining: 2,
      verifyAfterMs: DISPATCH_TEST_NOW + VERIFY_FIRST_SCAN_DELAY_MS,
    });

    const response = await handleFetch(
      await operatorRequest("sweep", deliveryId),
      makeEnv(queue, { db: d1 }),
      { now: () => DISPATCH_TEST_NOW },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      state: "delivered",
      verification_armed: true,
    });
    expect(outboxRow(database, deliveryId)).toMatchObject({
      state: "delivered",
      // Clamped at the schema maximum; the due time is the half that moved.
      verify_scans_remaining: 2,
      verify_after_ms: DISPATCH_TEST_NOW,
    });
    const due = await new D1DispatchStore(d1).verificationRowsDue(
      DISPATCH_TEST_NOW,
      10,
    );
    expect(due.map((row) => row.deliveryId)).toContain(deliveryId);
    expect(queue.sent).toHaveLength(0);
    expect(auditRows(database, deliveryId)).toMatchObject([
      { actor: "operator", from_state: "delivered", to_state: "delivered" },
    ]);
  });

  it("F5 sweep: a sweep on a non-delivered row is 409, and an unsigned sweep is 401", async () => {
    const { database, d1 } = dispatchDatabase();
    const queue = new FakeQueue();
    const deliveryId = "wiring-operator-sweep-ambiguous";
    seedOutboxRow(database, {
      deliveryId,
      destination: "alerts",
      state: "ambiguous",
    });
    const env = makeEnv(queue, { db: d1 });

    const conflict = await handleFetch(
      await operatorRequest("sweep", deliveryId),
      env,
      { now: () => DISPATCH_TEST_NOW },
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "delivery_state_conflict" });

    const unsigned = await handleFetch(
      await operatorRequest("sweep", deliveryId, {
        signature: "0".repeat(64),
      }),
      env,
      { now: () => DISPATCH_TEST_NOW },
    );
    expect(unsigned.status).toBe(401);

    expect(outboxRow(database, deliveryId)).toMatchObject({
      state: "ambiguous",
      verify_scans_remaining: 0,
      verify_after_ms: null,
    });
    expect(auditRows(database, deliveryId)).toHaveLength(0);
  });

  it("F6 one-shot: replaying the identical signed resend is 409 already_applied with no second transition or publish", async () => {
    const { database, d1 } = dispatchDatabase();
    const queue = new FakeQueue();
    const deliveryId = "wiring-operator-replay";
    seedOutboxRow(database, {
      deliveryId,
      destination: "alerts",
      state: "manual",
    });
    const env = makeEnv(queue, { db: d1 });

    const first = await handleFetch(
      await operatorRequest("resend", deliveryId),
      env,
      { now: () => DISPATCH_TEST_NOW },
    );
    expect(first.status).toBe(200);

    // The resend fails and the row returns to `manual` quickly — the state
    // that made the command replayable before the fix.
    database
      .prepare(
        "UPDATE dispatch_outbox SET state = 'manual' WHERE delivery_id = ?",
      )
      .run(deliveryId);

    const replay = await handleFetch(
      await operatorRequest("resend", deliveryId),
      env,
      { now: () => DISPATCH_TEST_NOW },
    );

    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual({ error: "already_applied" });
    expect(outboxState(database, deliveryId)).toBe("manual");
    expect(queue.sent).toHaveLength(1);
    expect(auditRows(database, deliveryId)).toHaveLength(1);
  });

  it("F6 one-shot: a DIFFERENT signed command on the same row still executes", async () => {
    const { database, d1 } = dispatchDatabase();
    const queue = new FakeQueue();
    const deliveryId = "wiring-operator-fresh-command";
    seedOutboxRow(database, {
      deliveryId,
      destination: "alerts",
      state: "manual",
    });
    const env = makeEnv(queue, { db: d1 });

    expect(
      (
        await handleFetch(await operatorRequest("resend", deliveryId), env, {
          now: () => DISPATCH_TEST_NOW,
        })
      ).status,
    ).toBe(200);
    database
      .prepare(
        "UPDATE dispatch_outbox SET state = 'manual' WHERE delivery_id = ?",
      )
      .run(deliveryId);

    // New timestamp => new signature => a distinct command, still fresh.
    const second = await handleFetch(
      await operatorRequest("resend", deliveryId, {
        timestamp: String(Math.floor(DISPATCH_TEST_NOW / 1_000) + 1),
      }),
      env,
      { now: () => DISPATCH_TEST_NOW },
    );

    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true, queued: true });
    expect(outboxState(database, deliveryId)).toBe("queued");
    expect(queue.sent).toHaveLength(2);
    expect(auditRows(database, deliveryId)).toHaveLength(2);
  });

  // Copilot suppressed comment (F4): the one-shot guard only exists if the
  // route actually CARRIES the digest into the store mutation. Dropping that
  // argument would leave every other test green — the store tests pass digests
  // themselves, and a sequential route replay is caught by the read-then-act
  // pre-check, which is precisely the check F4 says cannot be trusted under
  // concurrency. This pins the wiring itself, by argument.
  it("suppressed F4: every operator action carries its request-signature digest INTO the store mutation", async () => {
    const { database, d1 } = dispatchDatabase();
    const queue = new FakeQueue();
    const env = makeEnv(queue, { db: d1 });
    const digestPattern = /^[0-9a-f]{64}$/u;
    // [action, seeded state, spied store method, digest argument index]
    const cases = [
      ["resend", "manual", "operatorResend", 3],
      ["close_manual", "manual", "operatorCloseManual", 3],
      ["sweep", "delivered", "operatorSweepVerification", 3],
      ["mark_delivered", "manual", "markDelivered", 7],
    ] as const;

    for (const [action, state, method, digestIndex] of cases) {
      // delivery_id is CHECKed against A-Za-z0-9- only (migration 0010).
      const deliveryId = `wiring-operator-digest-${action.replaceAll("_", "-")}`;
      seedOutboxRow(database, {
        deliveryId,
        destination: "alerts",
        state,
        // Only the sweep case needs a delivered row, so one ts suffices for
        // UNIQUE(destination, slack_message_ts).
        ...(state === "delivered"
          ? {
              slackChannelId: ALERTS_CHANNEL,
              slackMessageTs: "1786708800.001100",
            }
          : {}),
      });
      const spy = vi.spyOn(D1DispatchStore.prototype, method);
      try {
        const response = await handleFetch(
          await operatorRequest(action, deliveryId),
          env,
          { now: () => DISPATCH_TEST_NOW },
        );
        expect(response.status).toBe(200);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0]?.[digestIndex]).toMatch(digestPattern);
      } finally {
        spy.mockRestore();
      }
    }
  });

  it("F8 mark_delivered: a signed mark_delivered records the operator's canonical proof on a manual row", async () => {
    const { database, d1 } = dispatchDatabase();
    const queue = new FakeQueue();
    const deliveryId = "wiring-operator-mark-delivered";
    seedOutboxRow(database, {
      deliveryId,
      destination: "alerts",
      state: "manual",
    });

    const response = await handleFetch(
      await operatorRequest("mark_delivered", deliveryId),
      makeEnv(queue, { db: d1 }),
      { now: () => DISPATCH_TEST_NOW },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, state: "delivered" });
    expect(outboxRow(database, deliveryId)).toMatchObject({
      state: "delivered",
      slack_message_ts: OPERATOR_PROOF_TS,
      slack_channel_id: ALERTS_CHANNEL,
      // Proof of an existing message is not a resend: nothing is armed.
      verify_scans_remaining: 0,
    });
    // Never posts to Slack, never publishes.
    expect(queue.sent).toHaveLength(0);
    const entries = auditRows(database, deliveryId);
    expect(entries).toMatchObject([
      { actor: "operator", from_state: "manual", to_state: "delivered" },
    ]);
    expect(String(entries[0]?.["evidence_json"])).toContain(OPERATOR_PROOF_TS);
  });

  it("F8 mark_delivered: a malformed ts is 400, a non-manual row is 409 and an unsigned command is 401", async () => {
    const { database, d1 } = dispatchDatabase();
    const queue = new FakeQueue();
    const manualId = "wiring-operator-mark-malformed";
    const deliveredId = "wiring-operator-mark-conflict";
    seedOutboxRow(database, {
      deliveryId: manualId,
      destination: "alerts",
      state: "manual",
    });
    seedOutboxRow(database, {
      deliveryId: deliveredId,
      destination: "alerts",
      state: "delivered",
      slackChannelId: ALERTS_CHANNEL,
      slackMessageTs: "1786708800.000800",
    });
    const env = makeEnv(queue, { db: d1 });

    // Correctly signed over a ts that fails the classifier's pattern.
    const malformedTs = await handleFetch(
      await operatorRequest("mark_delivered", manualId, {
        slackMessageTs: "1786708800.00",
      }),
      env,
      { now: () => DISPATCH_TEST_NOW },
    );
    expect(malformedTs.status).toBe(400);
    expect(await malformedTs.json()).toEqual({ error: "invalid_request" });

    const malformedChannel = await handleFetch(
      await operatorRequest("mark_delivered", manualId, {
        slackChannelId: "not-a-channel",
      }),
      env,
      { now: () => DISPATCH_TEST_NOW },
    );
    expect(malformedChannel.status).toBe(400);

    const unsigned = await handleFetch(
      await operatorRequest("mark_delivered", manualId, {
        signature: "0".repeat(64),
      }),
      env,
      { now: () => DISPATCH_TEST_NOW },
    );
    expect(unsigned.status).toBe(401);

    const conflict = await handleFetch(
      await operatorRequest("mark_delivered", deliveredId),
      env,
      { now: () => DISPATCH_TEST_NOW },
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "delivery_state_conflict" });

    expect(outboxState(database, manualId)).toBe("manual");
    expect(outboxRow(database, deliveredId)).toMatchObject({
      slack_message_ts: "1786708800.000800",
    });
    expect(auditRows(database, manualId)).toHaveLength(0);
    expect(auditRows(database, deliveredId)).toHaveLength(0);
    expect(queue.sent).toHaveLength(0);
  });

  // Review finding N2 (ADR §10 H22): the channel was validated by SHAPE only,
  // so a well-formed id for any other channel — #github-activity's included —
  // was accepted as proof for an alerts delivery. `slack_message_ts` is unique
  // only per channel, and every later reader resolves the channel from the
  // row's DESTINATION, so the row would carry proof no sweep could ever find.
  it("N2 mark_delivered: a well-formed channel that is not the dispatcher's is 400 with zero state change", async () => {
    const { database, d1 } = dispatchDatabase();
    const queue = new FakeQueue();
    const deliveryId = "wiring-operator-mark-foreign-channel";
    seedOutboxRow(database, {
      deliveryId,
      destination: "alerts",
      state: "manual",
    });
    const env = makeEnv(queue, { db: d1 });

    // Correctly signed over #github-activity's real id: shape-valid, and the
    // channel the dispatcher does not own (§10 H1/H2).
    const foreign = await handleFetch(
      await operatorRequest("mark_delivered", deliveryId, {
        slackChannelId: ACTIVITY_CHANNEL,
      }),
      env,
      { now: () => DISPATCH_TEST_NOW },
    );

    expect(foreign.status).toBe(400);
    expect(await foreign.json()).toEqual({
      error: "channel_not_dispatcher_owned",
    });
    expect(outboxState(database, deliveryId)).toBe("manual");
    expect(auditRows(database, deliveryId)).toHaveLength(0);

    // Positive control: the CONFIGURED channel is accepted, so the check is
    // identity, not a blanket rejection.
    const accepted = await handleFetch(
      await operatorRequest("mark_delivered", deliveryId, {
        slackChannelId: channelForDestination("alerts"),
      }),
      env,
      { now: () => DISPATCH_TEST_NOW },
    );
    expect(accepted.status).toBe(200);
    expect(outboxRow(database, deliveryId)).toMatchObject({
      state: "delivered",
      slack_channel_id: ALERTS_CHANNEL,
    });
  });
});

// Review finding N1 (ADR §10 H23): §6.3.1 normalization is D1-only — it needs
// no Slack token — but it ran inside runResolverPass, after the bot-token
// read. A Secrets Store outage therefore skipped it: the crashed send stayed
// `sending` and invisible to `ambiguous_stale`, and a shadow row that needs no
// token at all never returned to `queued`.
describe("N1: lease normalization never waits on a secret (ADR §10 H23)", () => {
  it("N1: a Secrets Store outage still normalizes expired leases and keeps the crashed send visible", async () => {
    const { database, d1 } = dispatchDatabase();
    const staleCreatedMs = DISPATCH_TEST_NOW - 31 * 60_000;
    // A real send that crashed between claim and outcome (§6.5 row 10).
    seedOutboxRow(database, {
      deliveryId: "n1-crashed-real-send",
      destination: "alerts",
      state: "sending",
      lastSendStartMs: staleCreatedMs,
      leaseUntilMs: DISPATCH_TEST_NOW - 1_000,
      createdMs: staleCreatedMs,
    });
    // §9.A1/H16: a shadow row performs no egress, so its normalization can
    // never depend on a Slack credential.
    seedOutboxRow(database, {
      deliveryId: "n1-crashed-shadow-send",
      destination: "alerts",
      state: "sending",
      shadow: 1,
      lastSendStartMs: staleCreatedMs,
      leaseUntilMs: DISPATCH_TEST_NOW - 1_000,
      createdMs: staleCreatedMs,
    });
    const secretFailure = new Error("secrets_store_unavailable");
    const readBotToken = vi.fn(async () => {
      throw secretFailure;
    });

    const failure = await runDispatchCronPass({
      database: d1,
      mode: "primary" as const,
      fetch: vi.fn<typeof fetch>(),
      now: () => DISPATCH_TEST_NOW,
      readBotToken,
      publish: async () => {},
    }).then(
      () => null,
      (error: unknown) => error,
    );

    // Normalization ran BEFORE the failing read — the finding's damage.
    expect(outboxRow(database, "n1-crashed-real-send")).toMatchObject({
      state: "ambiguous",
      last_error: "lease_expired",
    });
    expect(outboxRow(database, "n1-crashed-shadow-send")).toMatchObject({
      state: "queued",
      last_error: "lease_expired_shadow",
    });
    // The pass still fails (egress is genuinely unavailable) and still carries
    // the original cause...
    expect(failure).toBeInstanceOf(DispatchCronPassError);
    const passError = failure as InstanceType<typeof DispatchCronPassError>;
    expect(passError.cause).toBe(secretFailure);
    // ...and the crashed send is now visible to the alarm computed after it,
    // instead of hiding in `sending` until the outage ends.
    expect(passError.alarms).toContain("ambiguous_stale");
  });

  it("N1: a backlog that is not due yet costs no secret read", async () => {
    const { d1, database } = dispatchDatabase();
    // §6.2/R4: a recorded Retry-After defers the row. It is `ambiguous` and
    // stale, so the old counter-based gate read the token for it — but the
    // resolver would have found nothing due to examine.
    seedOutboxRow(database, {
      deliveryId: "n1-deferred-ambiguous",
      destination: "alerts",
      state: "ambiguous",
      nextAttemptMs: DISPATCH_TEST_NOW + 60_000,
      createdMs: DISPATCH_TEST_NOW - 31 * 60_000,
    });
    const readBotToken = vi.fn(async () => "xoxb-unused");
    const fetchSpy = vi.fn<typeof fetch>();

    const result = await runDispatchCronPass({
      database: d1,
      mode: "primary" as const,
      fetch: fetchSpy,
      now: () => DISPATCH_TEST_NOW,
      readBotToken,
      publish: async () => {},
    });

    expect(readBotToken).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.resolverExamined).toBe(0);
    // Still alarmed — the row is visible without any secret being read.
    expect(result.alarms).toContain("ambiguous_stale");
  });
});
