// ADR-001 (docs/adr/ADR-001-slack-dispatch-outbox.md) architectural REDs —
// outbox store + migration slice: R1, R2, R6, R8, R13, R16 plus the schema
// assertions for migrations 0010/0011 (§6.4, §6.9/§9.A5). RED phase of TDD:
// this file imports ../src/dispatch/outbox, which does not exist yet; every
// test here is the executable specification the implementation must satisfy.
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  DISPATCH_LEASE_MS,
  STALE_QUEUED_REQUEUE_AFTER_MS,
  VERIFY_DEFERRAL_BACKOFF_BASE_MS,
  VERIFY_FIRST_SCAN_DELAY_MS,
  VERIFY_SECOND_SCAN_DELAY_MS,
} from "../src/dispatch/contract";
import type { DispatchOutboxRow } from "../src/dispatch/contract";
import { D1DispatchStore } from "../src/dispatch/outbox";
import {
  auditRows,
  closeDispatchDatabases,
  DISPATCH_TEST_NOW,
  dispatchDatabase,
  legacySchemaSnapshot,
  migrationSource,
  outboxRow,
} from "./dispatch-helpers";

const ALERTS_CHANNEL = "C0BMUK793NV";
const ACTIVITY_CHANNEL = "C0BMQMW3L4E";

const HISTORICAL_DELIVERY_A = "d43b2d70-9772-11f1-805f-1846e9afeb67";
const HISTORICAL_DELIVERY_B = "0aac32b0-97b8-11f1-825a-68c75513476d";
const HISTORICAL_DISPOSITION_AT_MS = 1_786_733_700_000;

// Mirrors the private seal tuple in dispatch-helpers.ts so R8 can replay the
// 0001-0009 chain standalone, byte-identically to dispatchDatabase().
const SEALED_PROTOCOL_REVISION = "e0131a758123cf210d9cc9e7e537b72dc0441a90";
const SEALED_PROTOCOL_ACTIVATED_AT = 1_786_579_752_661;
const SEALED_PROTOCOL_ACTIVATION_ID =
  "18a94ba84d6bac0f8ae396996a5cd6ac026eb336be5eef702b92b3b6a60d4ff7";

function legacyChainDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  for (const migration of [
    "0001_initial.sql",
    "0002_add_destination.sql",
    "0003_rename_delivery_acceptance.sql",
    "0004_confirm_slack_delivery.sql",
    "0005_reconcile_live_slack_receipts.sql",
  ]) {
    database.exec(migrationSource(migration));
  }
  database.exec(
    "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
  );
  database
    .prepare(
      `UPDATE relay_state
       SET slack_delivery_protocol_active = 1,
           slack_delivery_protocol_revision = ?,
           slack_delivery_protocol_activated_at = ?,
           slack_delivery_protocol_activation_id = ?,
           slack_delivery_protocol_schema_revision =
             '0005_reconcile_live_slack_receipts'
       WHERE singleton_id = 1`,
    )
    .run(
      SEALED_PROTOCOL_REVISION,
      SEALED_PROTOCOL_ACTIVATED_AT,
      SEALED_PROTOCOL_ACTIVATION_ID,
    );
  for (const migration of [
    "0006_seal_slack_delivery_protocol.sql",
    "0007_journal_slack_reconciliation_reports.sql",
    "0008_resume_bounded_slack_activity_scan.sql",
    "0009_track_slack_trace_hydration.sql",
  ]) {
    database.exec("BEGIN IMMEDIATE TRANSACTION;");
    try {
      database.exec(migrationSource(migration));
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
  }
  return database;
}

interface RawOutboxRowInput {
  deliveryId: string;
  destination: string;
  shadow?: number;
  payloadJson?: string;
  state: string;
  slackChannelId?: string | null;
  slackMessageTs?: string | null;
  // Review finding F3: the aggregate REDs need rows the dispatcher's own
  // store methods cannot write — a schema-legal `activity` row, and the
  // verification shape statusCounters reads for the abandoned alarm.
  createdMs?: number;
  verifyScansRemaining?: number;
  verifyAfterMs?: number | null;
}

function insertRawOutboxRow(
  database: DatabaseSync,
  input: RawOutboxRowInput,
): void {
  database
    .prepare(
      `INSERT INTO dispatch_outbox (
         delivery_id, destination, shadow, payload_json, state,
         slack_channel_id, slack_message_ts, verify_scans_remaining,
         verify_after_ms, created_ms, updated_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.deliveryId,
      input.destination,
      input.shadow ?? 0,
      input.payloadJson ?? '{"fixture":true}',
      input.state,
      input.slackChannelId ?? null,
      input.slackMessageTs ?? null,
      input.verifyScansRemaining ?? 0,
      input.verifyAfterMs ?? null,
      input.createdMs ?? DISPATCH_TEST_NOW,
      input.createdMs ?? DISPATCH_TEST_NOW,
    );
}

function insertRawAuditRow(database: DatabaseSync, actor: string): void {
  database
    .prepare(
      `INSERT INTO dispatch_audit (
         delivery_id, from_state, to_state, evidence_json, actor, at_ms
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "red-audit-actor-probe",
      "queued",
      "sending",
      "{}",
      actor,
      DISPATCH_TEST_NOW,
    );
}

afterEach(closeDispatchDatabases);

describe("migration 0010 dispatch schema (ADR §6.4)", () => {
  it("0010: dispatch_outbox rejects a destination outside alerts/activity", () => {
    const { database } = dispatchDatabase();
    expect(() =>
      insertRawOutboxRow(database, {
        deliveryId: "red-0010-bad-destination",
        destination: "canary",
        state: "queued",
      }),
    ).toThrow(/CHECK constraint failed/);
  });

  it("0010: dispatch_outbox rejects a state outside the §6.2 machine (retry_scheduled does not exist)", () => {
    const { database } = dispatchDatabase();
    expect(() =>
      insertRawOutboxRow(database, {
        deliveryId: "red-0010-bad-state",
        destination: "alerts",
        state: "retry_scheduled",
      }),
    ).toThrow(/CHECK constraint failed/);
  });

  it("0010: dispatch_outbox rejects non-JSON payload_json", () => {
    const { database } = dispatchDatabase();
    expect(() =>
      insertRawOutboxRow(database, {
        deliveryId: "red-0010-bad-payload",
        destination: "alerts",
        state: "queued",
        payloadJson: "not-json",
      }),
    ).toThrow(/CHECK constraint failed/);
  });

  it("0010: a delivered non-shadow row without slack_message_ts violates the ts-on-delivered CHECK", () => {
    const { database } = dispatchDatabase();
    expect(() =>
      insertRawOutboxRow(database, {
        deliveryId: "red-0010-delivered-no-ts",
        destination: "alerts",
        state: "delivered",
        slackChannelId: ALERTS_CHANNEL,
      }),
    ).toThrow(/CHECK constraint failed/);
  });

  it("0010: a shadow row never carries slack_message_ts, and shadow delivered without ts is legal (§9.A1)", () => {
    const { database } = dispatchDatabase();
    expect(() =>
      insertRawOutboxRow(database, {
        deliveryId: "red-0010-shadow-with-ts",
        destination: "alerts",
        shadow: 1,
        state: "delivered",
        slackMessageTs: "1786665495.000001",
      }),
    ).toThrow(/CHECK constraint failed/);
    // A1 amendment: shadow performs NO Slack egress, so a shadow row is
    // exempt from the ts-on-delivered CHECK.
    expect(() =>
      insertRawOutboxRow(database, {
        deliveryId: "red-0010-shadow-delivered",
        destination: "alerts",
        shadow: 1,
        state: "delivered",
      }),
    ).not.toThrow();
  });

  // Copilot finding: the previous GLOB accepted '1garbage.123456' because
  // SQLite `*` matches ANY character sequence. The CHECK now pins exactly
  // the src/index.ts contract SLACK_MESSAGE_TS_PATTERN = /^\d{10,13}\.\d{6}$/.
  it("0010: slack_message_ts enforces the 10-13 digit seconds + six digit fraction format", () => {
    const { database } = dispatchDatabase();
    const rejected = [
      // The exact value Copilot showed passing the old GLOB.
      "1garbage.123456",
      // Same shape, padded to a legal length so only the charset predicate
      // can reject it.
      "1garbagexy.123456",
      // 9-digit seconds.
      "178673714.039589",
      // 5-digit fraction (short, and again at a legal total length).
      "1786737141.03958",
      "1786737141039.03958",
      // No dot at all (short, and again at a legal total length).
      "1786737141039589",
      "17867371410395891234",
      // Two dots inside the seconds field.
      "178673714.0.039589",
      "",
    ];
    for (const [index, value] of rejected.entries()) {
      expect(() =>
        insertRawOutboxRow(database, {
          deliveryId: `red-0010-ts-rejected-${index}`,
          destination: "alerts",
          state: "queued",
          slackMessageTs: value,
        }),
      ).toThrow(/CHECK constraint failed/);
    }
    const accepted = [
      // 10-digit seconds (the live Slack shape).
      "1786737141.039589",
      // 13-digit seconds (upper bound of the contract).
      "1786737141039.039589",
    ];
    for (const [index, value] of accepted.entries()) {
      expect(() =>
        insertRawOutboxRow(database, {
          deliveryId: `red-0010-ts-accepted-${index}`,
          destination: "alerts",
          state: "queued",
          slackMessageTs: value,
        }),
      ).not.toThrow();
    }
  });

  it("0010: UNIQUE(destination, slack_message_ts) blocks a second delivered row per destination but allows the same ts across destinations", () => {
    const { database } = dispatchDatabase();
    const ts = "1786665495.000010";
    insertRawOutboxRow(database, {
      deliveryId: "red-0010-unique-first",
      destination: "alerts",
      state: "delivered",
      slackChannelId: ALERTS_CHANNEL,
      slackMessageTs: ts,
    });
    expect(() =>
      insertRawOutboxRow(database, {
        deliveryId: "red-0010-unique-second",
        destination: "alerts",
        state: "delivered",
        slackChannelId: ALERTS_CHANNEL,
        slackMessageTs: ts,
      }),
    ).toThrow(/UNIQUE constraint failed/);
    expect(() =>
      insertRawOutboxRow(database, {
        deliveryId: "red-0010-unique-other-destination",
        destination: "activity",
        state: "delivered",
        slackChannelId: ACTIVITY_CHANNEL,
        slackMessageTs: ts,
      }),
    ).not.toThrow();
    expect(
      outboxRow(database, "red-0010-unique-other-destination"),
    ).toMatchObject({ destination: "activity", slack_message_ts: ts });
  });

  it("0010: dispatch_audit rejects an unknown actor", () => {
    const { database } = dispatchDatabase();
    expect(() => insertRawAuditRow(database, "monitor")).toThrow(
      /CHECK constraint failed/,
    );
    expect(() => insertRawAuditRow(database, "cron")).not.toThrow();
  });
});

describe("migration 0011 historical dispositions (ADR §6.9 option (a), §9.A5)", () => {
  it("0011: records exactly the two closed_manual dispositions and touches nothing else", () => {
    const { database } = dispatchDatabase();
    const rows = database
      .prepare(
        `SELECT delivery_id, from_state, to_state, actor, at_ms
         FROM dispatch_audit
         ORDER BY seq`,
      )
      .all() as Record<string, unknown>[];
    expect(rows).toEqual([
      {
        delivery_id: HISTORICAL_DELIVERY_A,
        from_state: "accepted_by_trigger",
        to_state: "closed_manual",
        actor: "operator",
        at_ms: HISTORICAL_DISPOSITION_AT_MS,
      },
      {
        delivery_id: HISTORICAL_DELIVERY_B,
        from_state: "accepted_by_trigger",
        to_state: "closed_manual",
        actor: "operator",
        at_ms: HISTORICAL_DISPOSITION_AT_MS,
      },
    ]);
    // The disposition lives in the new-path audit journal ONLY: the legacy
    // deliveries table stays untouched (0 rows in a fresh replay) and no
    // outbox row is minted for the historical GUIDs.
    const legacyCount = database
      .prepare("SELECT COUNT(*) AS n FROM deliveries")
      .get() as { n: number } | undefined;
    expect(legacyCount?.n).toBe(0);
    const outboxCount = database
      .prepare("SELECT COUNT(*) AS n FROM dispatch_outbox")
      .get() as { n: number } | undefined;
    expect(outboxCount?.n).toBe(0);
  });
});

// Review finding F3 (ADR §10 H18, correcting H3): migration 0010 still admits
// `destination = 'activity'` — the schema RED above inserts exactly such a row
// — while §10 H2 reduced the dispatcher to `alerts`. The H3 claim that the
// residue is "inert" was false in the READ direction: statusCounters grouped
// over EVERY destination in the table and indexed its alerts-only map with the
// result, so one schema-valid row made `/status` answer 503 and aborted every
// dispatch cron pass (runDispatchCronPass opens with that call).
describe("F3: aggregates are scoped to dispatcher-owned destinations (ADR §10 H18)", () => {
  it("F3: a schema-legal activity row leaves every /status aggregate intact", async () => {
    const { database, d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);
    const staleMs = DISPATCH_TEST_NOW - 31 * 60_000;
    // One activity row per aggregate the dispatcher reads: the grouped
    // per-state counters, the non-terminal age, the ambiguous age, and the
    // abandoned-verification shape.
    insertRawOutboxRow(database, {
      deliveryId: "f3-activity-queued",
      destination: "activity",
      state: "queued",
      createdMs: staleMs,
    });
    insertRawOutboxRow(database, {
      deliveryId: "f3-activity-ambiguous",
      destination: "activity",
      state: "ambiguous",
      createdMs: staleMs,
    });
    insertRawOutboxRow(database, {
      deliveryId: "f3-activity-abandoned",
      destination: "activity",
      state: "delivered",
      slackChannelId: ACTIVITY_CHANNEL,
      slackMessageTs: "1786664000.000900",
      verifyScansRemaining: 1,
      verifyAfterMs: null,
      createdMs: staleMs,
    });

    const counters = await store.statusCounters(DISPATCH_TEST_NOW);

    // Before the fix this call THREW (undefined["queued"]), so /status was
    // 503 and the cron pass aborted on a row the schema accepts.
    expect(Object.keys(counters.byStateAndDestination)).toEqual(["alerts"]);
    expect(counters.byStateAndDestination.alerts).toEqual({
      queued: 0,
      sending: 0,
      ambiguous: 0,
      manual: 0,
      delivered: 0,
      dead_letter: 0,
      closed_manual: 0,
    });
    expect(counters.oldestNonTerminalAgeMs).toBeNull();
    expect(counters.oldestAmbiguousAgeMs).toBeNull();
    expect(counters.verificationAbandoned).toBe(0);

    // Positive control: the same aggregates still see the dispatcher's own
    // rows — the scope narrows the query, it does not blank it.
    insertRawOutboxRow(database, {
      deliveryId: "f3-alerts-ambiguous",
      destination: "alerts",
      state: "ambiguous",
      createdMs: DISPATCH_TEST_NOW - 60_000,
    });
    insertRawOutboxRow(database, {
      deliveryId: "f3-alerts-abandoned",
      destination: "alerts",
      state: "delivered",
      slackChannelId: ALERTS_CHANNEL,
      slackMessageTs: "1786664000.000901",
      verifyScansRemaining: 1,
      verifyAfterMs: null,
      createdMs: DISPATCH_TEST_NOW - 60_000,
    });
    const owned = await store.statusCounters(DISPATCH_TEST_NOW);
    expect(owned.byStateAndDestination.alerts.ambiguous).toBe(1);
    expect(owned.byStateAndDestination.alerts.delivered).toBe(1);
    expect(owned.oldestNonTerminalAgeMs).toBe(60_000);
    expect(owned.oldestAmbiguousAgeMs).toBe(60_000);
    expect(owned.verificationAbandoned).toBe(1);
  });
});

// Review finding F2 (ADR §10 H21): the two deletion-bookkeeping markers are
// written BETWEEN a no-progress scan and its re-arm. H14's streak is the
// TRAILING run of `no_progress` markers, so counting them as progress would
// reset that run on every pass of a row whose chat.delete keeps failing — the
// unbounded livelock H14 closed would come straight back, invisible again.
describe("H21: the deletion markers are neutral for the H14 no-progress streak", () => {
  it("H21: an intent and a not-applied marker do not reset the streak; a completed repair does", async () => {
    const { d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);
    const deliveryId = "h21-streak-neutrality";
    const marker = async (evidence: Record<string, unknown>): Promise<void> => {
      await store.appendAudit({
        deliveryId,
        fromState: "delivered",
        toState: "delivered",
        evidenceJson: JSON.stringify(evidence),
        actor: "resolver",
        atMs: DISPATCH_TEST_NOW,
      });
    };

    // Two no-progress re-arms, each followed by the deletion bookkeeping of a
    // chat.delete that did not succeed.
    for (const attempt of [1, 2]) {
      await marker({
        duplicate_repair_pending: true,
        no_progress: true,
        consecutive_no_progress: attempt,
      });
      await marker({
        duplicate_deletion_intent: true,
        canonical_ts: "1786664000.000100",
        target_ts: "1786664900.000200",
      });
      await marker({
        duplicate_deletion_not_applied: true,
        canonical_ts: "1786664000.000100",
        target_ts: "1786664900.000200",
      });
    }

    // The streak survives the bookkeeping: H14's ceiling stays reachable.
    expect(await store.consecutiveNoProgressScans(deliveryId)).toBe(2);

    // A COMPLETED repair is real progress and still resets it (unchanged).
    await marker({
      repaired_duplicate: true,
      canonical_ts: "1786664000.000100",
      deleted_ts: "1786664900.000200",
      target_ts: "1786664900.000200",
    });
    expect(await store.consecutiveNoProgressScans(deliveryId)).toBe(0);
  });
});

describe("R8: additive migrations (ADR §6.4)", () => {
  it("R8: migrations 0010/0011 do not alter one byte of the 0001-0009 schema", () => {
    const legacy = legacyChainDatabase();
    const legacyOnlySnapshot = legacySchemaSnapshot(legacy);
    legacy.close();
    const parsed = JSON.parse(legacyOnlySnapshot) as unknown[];
    expect(parsed.length).toBeGreaterThan(0);

    const { database } = dispatchDatabase();
    expect(legacySchemaSnapshot(database)).toBe(legacyOnlySnapshot);
  });
});

describe("D1DispatchStore (ADR §6.1-§6.4)", () => {
  it("R1: duplicate queue delivery claim is a no-op", async () => {
    const { database, d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);
    const deliveryId = "red-r1-duplicate-claim";

    expect(
      await store.insert({
        deliveryId,
        destination: "alerts",
        shadow: false,
        payloadJson: '{"event":"deployment_status"}',
        now: DISPATCH_TEST_NOW,
      }),
    ).toBe(true);
    expect(auditRows(database, deliveryId)).toHaveLength(1);

    const claimed = await store.claim(deliveryId, DISPATCH_TEST_NOW);
    expect(claimed).not.toBeNull();
    expect(claimed).toMatchObject({
      deliveryId,
      state: "sending",
      leaseUntilMs: DISPATCH_TEST_NOW + DISPATCH_LEASE_MS,
      lastSendStartMs: DISPATCH_TEST_NOW,
    });
    expect(outboxRow(database, deliveryId)).toMatchObject({
      state: "sending",
      lease_until_ms: DISPATCH_TEST_NOW + DISPATCH_LEASE_MS,
      last_send_start_ms: DISPATCH_TEST_NOW,
    });
    expect(auditRows(database, deliveryId)).toHaveLength(2);

    // Second delivery of the same queue message while the lease is live:
    // CAS matches 0 rows => null, and NOTHING changes (§6.5 case 11).
    const duplicate = await store.claim(deliveryId, DISPATCH_TEST_NOW + 1_000);
    expect(duplicate).toBeNull();
    expect(outboxRow(database, deliveryId)).toMatchObject({
      state: "sending",
      lease_until_ms: DISPATCH_TEST_NOW + DISPATCH_LEASE_MS,
      last_send_start_ms: DISPATCH_TEST_NOW,
    });
    expect(auditRows(database, deliveryId)).toHaveLength(2);
  });

  it("R2: late ok:true+ts after an ambiguous verdict CASes ambiguous -> delivered(ts)", async () => {
    const { database, d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);
    const deliveryId = "red-r2-ambiguous-late-proof";
    const lateTs = "1786665495.000100";

    await store.insert({
      deliveryId,
      destination: "alerts",
      shadow: false,
      payloadJson: "{}",
      now: DISPATCH_TEST_NOW,
    });
    expect(await store.claim(deliveryId, DISPATCH_TEST_NOW)).not.toBeNull();
    expect(
      await store.markAmbiguous(
        deliveryId,
        DISPATCH_TEST_NOW + 1_000,
        "http_500",
        null,
        "consumer",
        ["sending"],
      ),
    ).toBe(true);

    const auditCountBefore = auditRows(database, deliveryId).length;
    // Copilot suppressed comment (F6): the actor is now explicit — this is
    // the consumer's late proof.
    const result = await store.recordLateProof(
      deliveryId,
      DISPATCH_TEST_NOW + 2_000,
      lateTs,
      ALERTS_CHANNEL,
      "consumer",
    );
    expect(result).toBe("ambiguous_cas");
    expect(outboxRow(database, deliveryId)).toMatchObject({
      state: "delivered",
      slack_message_ts: lateTs,
      slack_channel_id: ALERTS_CHANNEL,
    });
    expect(auditRows(database, deliveryId).length).toBeGreaterThan(
      auditCountBefore,
    );
  });

  it("R2: late ok:true+ts after a manual verdict CASes manual -> delivered(ts)", async () => {
    const { database, d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);
    const deliveryId = "red-r2-manual-late-proof";
    const lateTs = "1786665495.000110";

    await store.insert({
      deliveryId,
      destination: "alerts",
      shadow: false,
      payloadJson: "{}",
      now: DISPATCH_TEST_NOW,
    });
    expect(await store.claim(deliveryId, DISPATCH_TEST_NOW)).not.toBeNull();
    expect(
      await store.markManual(
        deliveryId,
        DISPATCH_TEST_NOW + 1_000,
        "channel_not_found",
        "consumer",
        ["sending"],
      ),
    ).toBe(true);

    const result = await store.recordLateProof(
      deliveryId,
      DISPATCH_TEST_NOW + 2_000,
      lateTs,
      ALERTS_CHANNEL,
      "consumer",
    );
    expect(result).toBe("manual_cas");
    expect(outboxRow(database, deliveryId)).toMatchObject({
      state: "delivered",
      slack_message_ts: lateTs,
      slack_channel_id: ALERTS_CHANNEL,
    });
  });

  it("R2: late proof on an already delivered row is audit_only and the audit append is unconditional", async () => {
    const { database, d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);
    const deliveryId = "red-r2-audit-only";
    const canonicalTs = "1786665495.000120";
    const lateTs = "1786665495.000121";

    await store.insert({
      deliveryId,
      destination: "alerts",
      shadow: false,
      payloadJson: "{}",
      now: DISPATCH_TEST_NOW,
    });
    expect(await store.claim(deliveryId, DISPATCH_TEST_NOW)).not.toBeNull();
    expect(
      await store.markDelivered(
        deliveryId,
        DISPATCH_TEST_NOW + 1_000,
        canonicalTs,
        ALERTS_CHANNEL,
        "consumer",
        ["sending"],
        '{"outcome":"ok"}',
      ),
    ).toBe(true);

    const auditCountBefore = auditRows(database, deliveryId).length;
    const result = await store.recordLateProof(
      deliveryId,
      DISPATCH_TEST_NOW + 2_000,
      lateTs,
      ALERTS_CHANNEL,
      "consumer",
    );
    expect(result).toBe("audit_only");
    // No CAS matched: the canonical ts stands untouched...
    expect(outboxRow(database, deliveryId)).toMatchObject({
      state: "delivered",
      slack_message_ts: canonicalTs,
    });
    // ...but the ts append is UNCONDITIONAL (§6.3: canonical proof is never
    // dropped) — the late ts lands durably in dispatch_audit.
    const entries = auditRows(database, deliveryId);
    expect(entries.length).toBeGreaterThan(auditCountBefore);
    const last = entries.at(-1);
    expect(String(last?.["evidence_json"] ?? "")).toContain(lateTs);
  });

  // Copilot suppressed comment (F2): the proof audit used to commit in a
  // SEPARATE database operation from the CAS that follows it. A worker
  // termination in that window left the row `manual` with the proof only in
  // the journal, and queue redelivery then ACKed an unclaimable manual row —
  // canonical proof never won over inference without operator intervention.
  it("suppressed F2: the late proof and the ambiguous->delivered CAS commit in ONE batch, and the manual guard stays a no-op", async () => {
    const { database, d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);
    const deliveryId = "suppressed-f2-atomic-ambiguous";
    const lateTs = "1786665495.000400";

    await store.insert({
      deliveryId,
      destination: "alerts",
      shadow: false,
      payloadJson: "{}",
      now: DISPATCH_TEST_NOW,
    });
    expect(await store.claim(deliveryId, DISPATCH_TEST_NOW)).not.toBeNull();
    expect(
      await store.markAmbiguous(
        deliveryId,
        DISPATCH_TEST_NOW + 1_000,
        "http_500",
        null,
        "consumer",
        ["sending"],
      ),
    ).toBe(true);
    const before = auditRows(database, deliveryId).length;

    expect(
      await store.recordLateProof(
        deliveryId,
        DISPATCH_TEST_NOW + 2_000,
        lateTs,
        ALERTS_CHANNEL,
        "consumer",
      ),
    ).toBe("ambiguous_cas");

    const entries = auditRows(database, deliveryId).slice(before);
    // Exactly the proof append plus ONE transition: the manual-guarded
    // statements of the same batch see the row already `delivered`, so their
    // state predicate makes them in-batch no-ops.
    expect(entries).toHaveLength(2);
    expect(
      entries.filter((entry) => entry["to_state"] === "delivered"),
    ).toHaveLength(1);
    // The unconditional proof append runs FIRST, so it records the state as it
    // was BEFORE the transition — reordering the batch would rewrite this.
    expect(entries[0]).toMatchObject({
      from_state: "ambiguous",
      to_state: "ambiguous",
    });
    expect(String(entries[0]?.["evidence_json"])).toContain('"late_proof":true');
    expect(outboxRow(database, deliveryId)).toMatchObject({
      state: "delivered",
      slack_message_ts: lateTs,
    });
  });

  it("suppressed F2: a late-proof batch that violates UNIQUE(destination, ts) leaves NEITHER the audit nor the transition", async () => {
    const { database, d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);
    const winnerId = "suppressed-f2-rollback-winner";
    const loserId = "suppressed-f2-rollback-loser";
    const ts = "1786665495.000410";

    // The ts is already recorded on another delivered row of the same
    // destination, so the late-proof UPDATE violates the UNIQUE index.
    await store.insert({
      deliveryId: winnerId,
      destination: "alerts",
      shadow: false,
      payloadJson: "{}",
      now: DISPATCH_TEST_NOW,
    });
    expect(await store.claim(winnerId, DISPATCH_TEST_NOW)).not.toBeNull();
    expect(
      await store.markDelivered(
        winnerId,
        DISPATCH_TEST_NOW + 500,
        ts,
        ALERTS_CHANNEL,
        "consumer",
        ["sending"],
        '{"outcome":"ok"}',
      ),
    ).toBe(true);

    await store.insert({
      deliveryId: loserId,
      destination: "alerts",
      shadow: false,
      payloadJson: "{}",
      now: DISPATCH_TEST_NOW,
    });
    expect(await store.claim(loserId, DISPATCH_TEST_NOW)).not.toBeNull();
    expect(
      await store.markManual(
        loserId,
        DISPATCH_TEST_NOW + 600,
        "channel_not_found",
        "consumer",
        ["sending"],
      ),
    ).toBe(true);
    const before = auditRows(database, loserId).length;

    // §6.1: whether the store surfaces the failure as a throw or a false
    // return, no partial write may survive — the proof append is inside the
    // same batch as the transition it guards.
    await store
      .recordLateProof(
        loserId,
        DISPATCH_TEST_NOW + 1_000,
        ts,
        ALERTS_CHANNEL,
        "consumer",
      )
      .catch(() => undefined);

    expect(outboxRow(database, loserId)).toMatchObject({
      state: "manual",
      slack_message_ts: null,
    });
    expect(auditRows(database, loserId)).toHaveLength(before);
  });

  // §10 narrows R6: with a single destination, "one destination never touches
  // the other" is vacuous, so the RED is restated as row independence inside
  // `alerts` — the property the transitions actually have to carry.
  it("R6 (§10): transitions on one row never touch another row", async () => {
    const { database, d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);
    const movedId = "red-r6-moved";
    const untouchedId = "red-r6-untouched";

    await store.insert({
      deliveryId: movedId,
      destination: "alerts",
      shadow: false,
      payloadJson: "{}",
      now: DISPATCH_TEST_NOW,
    });
    await store.insert({
      deliveryId: untouchedId,
      destination: "alerts",
      shadow: false,
      payloadJson: "{}",
      now: DISPATCH_TEST_NOW,
    });

    expect(await store.claim(movedId, DISPATCH_TEST_NOW)).not.toBeNull();
    expect(
      await store.markDelivered(
        movedId,
        DISPATCH_TEST_NOW + 1_000,
        "1786665495.000130",
        ALERTS_CHANNEL,
        "consumer",
        ["sending"],
        '{"outcome":"ok"}',
      ),
    ).toBe(true);

    const counters = await store.statusCounters(DISPATCH_TEST_NOW + 2_000);
    expect(counters.byStateAndDestination.alerts.delivered).toBe(1);
    expect(counters.byStateAndDestination.alerts.queued).toBe(1);
    expect(counters.byStateAndDestination.alerts.sending).toBe(0);

    // The other row is untouched in every relevant field and grew no audit
    // history beyond its own insert.
    expect(outboxRow(database, untouchedId)).toMatchObject({
      state: "queued",
      updated_ms: DISPATCH_TEST_NOW,
      slack_message_ts: null,
    });
    expect(auditRows(database, untouchedId)).toHaveLength(1);
  });

  it("R13: only stale queued rows are cron re-enqueue inputs", async () => {
    const { d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);
    const staleId = "red-r13-stale-queued";
    const freshId = "red-r13-fresh-queued";
    const sendingId = "red-r13-sending";
    const staleBirth = DISPATCH_TEST_NOW - STALE_QUEUED_REQUEUE_AFTER_MS - 1;

    await store.insert({
      deliveryId: staleId,
      destination: "alerts",
      shadow: false,
      payloadJson: "{}",
      now: staleBirth,
    });
    await store.insert({
      deliveryId: freshId,
      destination: "alerts",
      shadow: false,
      payloadJson: "{}",
      now: DISPATCH_TEST_NOW,
    });
    await store.insert({
      deliveryId: sendingId,
      destination: "alerts",
      shadow: false,
      payloadJson: "{}",
      now: staleBirth,
    });
    expect(await store.claim(sendingId, staleBirth)).not.toBeNull();

    const stale = await store.staleQueuedRows(DISPATCH_TEST_NOW, 10);
    expect(
      stale.map((row: DispatchOutboxRow) => row.deliveryId),
    ).toEqual([staleId]);
    expect(stale[0]?.state).toBe("queued");

    // Audit finding B3 (the DLQ amplifier): a republished row must leave the
    // stale set for a full interval, or every cron pass republishes it again.
    expect(
      await store.markQueuedRepublished(staleId, DISPATCH_TEST_NOW),
    ).toBe(true);
    expect(await store.staleQueuedRows(DISPATCH_TEST_NOW, 10)).toHaveLength(0);
    expect(
      (
        await store.staleQueuedRows(
          DISPATCH_TEST_NOW + STALE_QUEUED_REQUEUE_AFTER_MS + 1,
          10,
        )
      ).map((row: DispatchOutboxRow) => row.deliveryId),
      // The fresh row has aged past the threshold by then too; what this pins
      // is that the republished row comes back exactly one interval later.
    ).toContain(staleId);
    // It is a `queued`-only stamp: a claimed row is never touched by it.
    expect(
      await store.markQueuedRepublished(sendingId, DISPATCH_TEST_NOW),
    ).toBe(false);
  });

  // Audit finding B3/B8 (ADR §10 H15, narrowing H9): markDeadLetter CASed on
  // `state IN ('queued','sending')` with no lease term, so a row in `sending`
  // under a LIVE lease — a send genuinely in flight — was dead-lettered by a
  // duplicate DLQ arrival, and an operator resend landing between the DLQ
  // handler's read and its write produced the `queued -> dead_letter`
  // transition H9 declares impossible.
  it("B3: markDeadLetter spares a live lease and a queued row, and dead-letters only a crashed send", async () => {
    const { database, d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);
    const liveId = "b3-live-lease";
    const queuedId = "b3-queued-row";

    await store.insert({
      deliveryId: liveId,
      destination: "alerts",
      shadow: false,
      payloadJson: "{}",
      now: DISPATCH_TEST_NOW,
    });
    expect(await store.claim(liveId, DISPATCH_TEST_NOW)).not.toBeNull();
    const auditsBefore = auditRows(database, liveId).length;

    // Inside the 90 s lease: the send is in flight, the DLQ arrival is a
    // duplicate queue message — the row must survive untouched.
    expect(
      await store.markDeadLetter(
        liveId,
        DISPATCH_TEST_NOW + DISPATCH_LEASE_MS - 1,
        "cloudflare_queue_dead_letter",
      ),
    ).toBe(false);
    expect(outboxRow(database, liveId)).toMatchObject({
      state: "sending",
      last_error: null,
    });
    // Atomic with the refused UPDATE: no audit row for a transition that did
    // not happen.
    expect(auditRows(database, liveId)).toHaveLength(auditsBefore);

    // Past the lease: a crash between claim and outcome — H9's case.
    expect(
      await store.markDeadLetter(
        liveId,
        DISPATCH_TEST_NOW + DISPATCH_LEASE_MS + 1,
        "cloudflare_queue_dead_letter",
      ),
    ).toBe(true);
    expect(outboxRow(database, liveId)).toMatchObject({
      state: "dead_letter",
      last_error: "cloudflare_queue_dead_letter",
    });
    expect(auditRows(database, liveId).at(-1)).toMatchObject({
      from_state: "sending",
      to_state: "dead_letter",
    });

    // A `queued` row is never dead-lettered, whatever the clock says: H9
    // declares `queued -> dead_letter` impossible, and the predicate — not
    // only the handler's snapshot — now enforces it.
    await store.insert({
      deliveryId: queuedId,
      destination: "alerts",
      shadow: false,
      payloadJson: "{}",
      now: DISPATCH_TEST_NOW,
    });
    expect(
      await store.markDeadLetter(
        queuedId,
        DISPATCH_TEST_NOW + 10 * DISPATCH_LEASE_MS,
        "cloudflare_queue_dead_letter",
      ),
    ).toBe(false);
    expect(outboxRow(database, queuedId)).toMatchObject({ state: "queued" });
    expect(auditRows(database, queuedId)).toHaveLength(1);
  });

  // Audit finding B7: deferVerificationScan predicated only on
  // state/shadow/counter, so a pass acting on a STALE snapshot overwrote a due
  // time re-armed after that snapshot — including an operator sweep's
  // "due now", the whole point of H11.
  it("B7: a deferral holding a stale verify_after_ms cannot overwrite a newer re-arm", async () => {
    const { database, d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);
    const deliveryId = "b7-stale-deferral";
    const deliveredMs = DISPATCH_TEST_NOW + 2_000;
    await seedOperatorResentDelivered(store, deliveryId, deliveredMs);
    const staleDueMs = deliveredMs + VERIFY_FIRST_SCAN_DELAY_MS;
    expect(outboxRow(database, deliveryId)).toMatchObject({
      verify_after_ms: staleDueMs,
    });

    // The operator sweeps: at least one scan armed and due NOW (H11).
    const sweepNow = staleDueMs + 30_000;
    expect(
      await store.operatorSweepVerification(
        deliveryId,
        sweepNow,
        JSON.stringify({ operator_action: "sweep", verification_armed: true }),
        null,
      ),
    ).toBe(true);
    const auditsAfterSweep = auditRows(database, deliveryId).length;

    // The in-flight pass, still holding the pre-sweep snapshot, defers.
    expect(
      await store.deferVerificationScan(
        deliveryId,
        sweepNow + 1_000,
        sweepNow + 1_000 + VERIFY_DEFERRAL_BACKOFF_BASE_MS,
        '{"verification_deferred":true,"no_progress":true}',
        staleDueMs,
      ),
    ).toBe(false);
    // The operator's scan is intact: still due now, still unaudited by the
    // refused deferral.
    expect(outboxRow(database, deliveryId)).toMatchObject({
      verify_after_ms: sweepNow,
      verify_scans_remaining: 2,
    });
    expect(auditRows(database, deliveryId)).toHaveLength(auditsAfterSweep);

    // Positive control: the pass holding the CURRENT snapshot still defers.
    expect(
      await store.deferVerificationScan(
        deliveryId,
        sweepNow + 2_000,
        sweepNow + 2_000 + VERIFY_DEFERRAL_BACKOFF_BASE_MS,
        '{"verification_deferred":true,"no_progress":true}',
        sweepNow,
      ),
    ).toBe(true);
    expect(outboxRow(database, deliveryId)).toMatchObject({
      verify_after_ms: sweepNow + 2_000 + VERIFY_DEFERRAL_BACKOFF_BASE_MS,
    });
  });

  it("R16: statusCounters reflects ambiguous -> manual, and manual is non-terminal for the drain view", async () => {
    const { d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);
    const parkedId = "red-r16-parked";
    const deliveredId = "red-r16-delivered";
    const deadId = "red-r16-dead-letter";

    for (const deliveryId of [parkedId, deliveredId, deadId]) {
      await store.insert({
        deliveryId,
        destination: "alerts",
        shadow: false,
        payloadJson: "{}",
        now: DISPATCH_TEST_NOW,
      });
      expect(await store.claim(deliveryId, DISPATCH_TEST_NOW)).not.toBeNull();
    }
    expect(
      await store.markDelivered(
        deliveredId,
        DISPATCH_TEST_NOW + 500,
        "1786665495.000140",
        ALERTS_CHANNEL,
        "consumer",
        ["sending"],
        '{"outcome":"ok"}',
      ),
    ).toBe(true);
    // Audit finding B3 (ADR §10 H15): dead_letter is reachable only from
    // `sending` with an EXPIRED lease — a crashed send, never a live one — so
    // the DLQ arrival is placed after the row's 90 s lease ran out. The row's
    // state at every later assertion is unchanged.
    expect(
      await store.markDeadLetter(
        deadId,
        DISPATCH_TEST_NOW + DISPATCH_LEASE_MS + 500,
        "queue_retries_exhausted",
      ),
    ).toBe(true);

    expect(
      await store.markAmbiguous(
        parkedId,
        DISPATCH_TEST_NOW + 1_000,
        "client_timeout",
        null,
        "consumer",
        ["sending"],
      ),
    ).toBe(true);
    let counters = await store.statusCounters(DISPATCH_TEST_NOW + 2_000);
    expect(counters.byStateAndDestination.alerts.ambiguous).toBe(1);
    expect(counters.oldestNonTerminalAgeMs).not.toBeNull();

    // A CAS guarded by expectedStates that do not match must refuse.
    expect(
      await store.markManual(
        parkedId,
        DISPATCH_TEST_NOW + 2_500,
        '{"verdict":"wrong_expected_state"}',
        "resolver",
        ["queued"],
      ),
    ).toBe(false);
    expect(
      await store.markManual(
        parkedId,
        DISPATCH_TEST_NOW + 3_000,
        '{"verdict":"proven_absent","pages":3}',
        "resolver",
        ["ambiguous"],
      ),
    ).toBe(true);
    counters = await store.statusCounters(DISPATCH_TEST_NOW + 4_000);
    expect(counters.byStateAndDestination.alerts.ambiguous).toBe(0);
    expect(counters.byStateAndDestination.alerts.manual).toBe(1);
    // §6.8 regime A: manual is parked-with-alarm, NOT terminal — the drain
    // view stays open while a manual row exists.
    expect(counters.oldestNonTerminalAgeMs).not.toBeNull();

    expect(
      await store.operatorCloseManual(
        parkedId,
        DISPATCH_TEST_NOW + 5_000,
        '{"decision":"closed after review"}',
        null,
      ),
    ).toBe(true);
    counters = await store.statusCounters(DISPATCH_TEST_NOW + 6_000);
    expect(counters.byStateAndDestination.alerts.closed_manual).toBe(1);
    expect(counters.byStateAndDestination.alerts.delivered).toBe(1);
    expect(counters.byStateAndDestination.alerts.dead_letter).toBe(1);
    // delivered / dead_letter / closed_manual are ALL terminal: nothing
    // non-terminal remains, so the drain view closes.
    expect(counters.oldestNonTerminalAgeMs).toBeNull();
  });

  it("0010: every mutating store method appends exactly one dispatch_audit row", async () => {
    const { database, d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);
    const deliveryId = "red-audit-per-mutation";

    await store.insert({
      deliveryId,
      destination: "alerts",
      shadow: false,
      payloadJson: "{}",
      now: DISPATCH_TEST_NOW,
    });
    expect(auditRows(database, deliveryId)).toHaveLength(1);

    expect(await store.claim(deliveryId, DISPATCH_TEST_NOW)).not.toBeNull();
    expect(auditRows(database, deliveryId)).toHaveLength(2);

    expect(
      await store.markAmbiguous(
        deliveryId,
        DISPATCH_TEST_NOW + 1_000,
        "http_timeout",
        null,
        "consumer",
        ["sending"],
      ),
    ).toBe(true);
    expect(auditRows(database, deliveryId)).toHaveLength(3);

    expect(
      await store.markManual(
        deliveryId,
        DISPATCH_TEST_NOW + 2_000,
        '{"verdict":"budget_exhausted"}',
        "resolver",
        ["ambiguous"],
      ),
    ).toBe(true);
    expect(auditRows(database, deliveryId)).toHaveLength(4);

    // I1: the ONLY resend path, operator-minted, marked possible-duplicate.
    expect(
      await store.operatorResend(
        deliveryId,
        DISPATCH_TEST_NOW + 3_000,
        '{"resend":"possible-duplicate accepted by operator"}',
        null,
      ),
    ).toBe(true);
    expect(outboxRow(database, deliveryId)).toMatchObject({ state: "queued" });
    expect(auditRows(database, deliveryId)).toHaveLength(5);

    expect(
      await store.claim(deliveryId, DISPATCH_TEST_NOW + 4_000),
    ).not.toBeNull();
    expect(auditRows(database, deliveryId)).toHaveLength(6);

    expect(
      await store.markDelivered(
        deliveryId,
        DISPATCH_TEST_NOW + 5_000,
        "1786665495.000200",
        ALERTS_CHANNEL,
        "consumer",
        ["sending"],
        '{"source":"chat.postMessage"}',
      ),
    ).toBe(true);
    expect(auditRows(database, deliveryId)).toHaveLength(7);

    // Copilot finding (resolver starvation): the deferral is a mutation too —
    // verify_after_ms moves forward in one batch with its marker, and the
    // §6.3.3 counter is untouched.
    // Audit finding B7: the deferral now CASes on the caller's observed
    // verify_after_ms too — here the value markDelivered stamped above.
    expect(
      await store.deferVerificationScan(
        deliveryId,
        DISPATCH_TEST_NOW + 6_000,
        DISPATCH_TEST_NOW + 6_000 + VERIFY_DEFERRAL_BACKOFF_BASE_MS,
        '{"verification_deferred":true,"reason":"history_error_internal"}',
        DISPATCH_TEST_NOW + 5_000 + VERIFY_FIRST_SCAN_DELAY_MS,
      ),
    ).toBe(true);
    expect(outboxRow(database, deliveryId)).toMatchObject({
      state: "delivered",
      verify_scans_remaining: 2,
      verify_after_ms: DISPATCH_TEST_NOW + 6_000 + VERIFY_DEFERRAL_BACKOFF_BASE_MS,
    });
    expect(auditRows(database, deliveryId)).toHaveLength(8);
  });

  it("F7: operatorResend recovers a dead_letter row and still refuses non-menu states (ADR §6.2)", async () => {
    const { database, d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);
    const deadId = "f7-dead-letter-resend";
    const deliveredId = "f7-delivered-refused";

    // Audit finding B3 (ADR §10 H15): a crashed send — claimed long enough ago
    // for its 90 s lease to have expired — is the only shape that reaches
    // dead_letter now. Everything from DISPATCH_TEST_NOW onward is unchanged.
    const crashedSendMs = DISPATCH_TEST_NOW - DISPATCH_LEASE_MS - 2_000;
    await store.insert({
      deliveryId: deadId,
      destination: "alerts",
      shadow: false,
      payloadJson: "{}",
      now: crashedSendMs,
    });
    expect(await store.claim(deadId, crashedSendMs + 1_000)).not.toBeNull();
    expect(
      await store.markDeadLetter(
        deadId,
        DISPATCH_TEST_NOW + 500,
        "queue_retries_exhausted",
      ),
    ).toBe(true);

    // ADR §6.2 routes dead_letter to the operator menu (Copilot F7): same
    // audited possible-duplicate resend, same §6.3.3 verification arming.
    expect(
      await store.operatorResend(
        deadId,
        DISPATCH_TEST_NOW + 1_000,
        '{"resend":"possible-duplicate accepted by operator"}',
        null,
      ),
    ).toBe(true);
    expect(outboxRow(database, deadId)).toMatchObject({
      state: "queued",
      verify_scans_remaining: 2,
      last_error: null,
    });
    const resendAudit = auditRows(database, deadId).at(-1);
    expect(resendAudit).toMatchObject({
      from_state: "dead_letter",
      to_state: "queued",
      actor: "operator",
    });

    // A state outside the operator menu still refuses, with no audit row.
    await store.insert({
      deliveryId: deliveredId,
      destination: "alerts",
      shadow: false,
      payloadJson: "{}",
      now: DISPATCH_TEST_NOW,
    });
    expect(await store.claim(deliveredId, DISPATCH_TEST_NOW)).not.toBeNull();
    expect(
      await store.markDelivered(
        deliveredId,
        DISPATCH_TEST_NOW + 500,
        "1786665495.000160",
        ALERTS_CHANNEL,
        "consumer",
        ["sending"],
        '{"outcome":"ok"}',
      ),
    ).toBe(true);
    const auditCountBefore = auditRows(database, deliveredId).length;
    expect(
      await store.operatorResend(
        deliveredId,
        DISPATCH_TEST_NOW + 1_000,
        '{"resend":"refused"}',
        null,
      ),
    ).toBe(false);
    expect(outboxRow(database, deliveredId)).toMatchObject({
      state: "delivered",
    });
    expect(auditRows(database, deliveredId)).toHaveLength(auditCountBefore);
  });

  it("0010: a transition batch that violates UNIQUE(destination, ts) rolls back its audit row with it", async () => {
    const { database, d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);
    const winnerId = "red-audit-batch-winner";
    const loserId = "red-audit-batch-loser";
    const ts = "1786665495.000150";

    await store.insert({
      deliveryId: winnerId,
      destination: "alerts",
      shadow: false,
      payloadJson: "{}",
      now: DISPATCH_TEST_NOW,
    });
    expect(await store.claim(winnerId, DISPATCH_TEST_NOW)).not.toBeNull();
    expect(
      await store.markDelivered(
        winnerId,
        DISPATCH_TEST_NOW + 500,
        ts,
        ALERTS_CHANNEL,
        "consumer",
        ["sending"],
        '{"outcome":"ok"}',
      ),
    ).toBe(true);

    await store.insert({
      deliveryId: loserId,
      destination: "alerts",
      shadow: false,
      payloadJson: "{}",
      now: DISPATCH_TEST_NOW,
    });
    expect(await store.claim(loserId, DISPATCH_TEST_NOW)).not.toBeNull();

    // Same destination + same ts: the outbox UPDATE violates the UNIQUE
    // index, so the WHOLE batch — audit row included — must roll back
    // (§6.1: outcome applied in ONE batch() with its audit row). Whether
    // the store surfaces the failure as a throw or a false return, no
    // partial write may survive.
    await store
      .markDelivered(
        loserId,
        DISPATCH_TEST_NOW + 1_000,
        ts,
        ALERTS_CHANNEL,
        "consumer",
        ["sending"],
        '{"outcome":"ok"}',
      )
      .catch(() => undefined);
    expect(outboxRow(database, loserId)).toMatchObject({
      state: "sending",
      slack_message_ts: null,
    });
    expect(auditRows(database, loserId)).toHaveLength(2);
  });

  // Copilot suppressed comment (F3) / ADR §6.3.1: "all verdict CASes run
  // WHERE state='ambiguous' only". incrementResolverAttempts was unguarded,
  // so a row delivered or parked by another writer after the scan snapshot
  // was still mutated and collected a FALSE resolver_attempt_inconclusive
  // audit entry.
  it("suppressed F3: incrementResolverAttempts is state-guarded — a row delivered mid-flight is not mutated and gets no false inconclusive audit", async () => {
    const { database, d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);
    const deliveryId = "suppressed-f3-state-guard";

    await store.insert({
      deliveryId,
      destination: "alerts",
      shadow: false,
      payloadJson: "{}",
      now: DISPATCH_TEST_NOW,
    });
    expect(await store.claim(deliveryId, DISPATCH_TEST_NOW)).not.toBeNull();
    expect(
      await store.markAmbiguous(
        deliveryId,
        DISPATCH_TEST_NOW + 1_000,
        "http_500",
        null,
        "consumer",
        ["sending"],
      ),
    ).toBe(true);

    // Ambiguous row: the guard admits the increment (the normal path).
    expect(
      await store.incrementResolverAttempts(
        deliveryId,
        DISPATCH_TEST_NOW + 2_000,
      ),
    ).toBe(1);

    // Another resolver/consumer delivers the row after the scan snapshot.
    expect(
      await store.markDelivered(
        deliveryId,
        DISPATCH_TEST_NOW + 3_000,
        "1786665495.000300",
        ALERTS_CHANNEL,
        "resolver",
        ["ambiguous"],
        '{"verdict":"found"}',
      ),
    ).toBe(true);
    const before = outboxRow(database, deliveryId);
    const auditCountBefore = auditRows(database, deliveryId).length;

    // The stale in-flight verdict must change NOTHING and report the current
    // attempts unchanged.
    expect(
      await store.incrementResolverAttempts(
        deliveryId,
        DISPATCH_TEST_NOW + 4_000,
      ),
    ).toBe(1);
    expect(outboxRow(database, deliveryId)).toEqual(before);
    const after = auditRows(database, deliveryId);
    expect(after).toHaveLength(auditCountBefore);
    expect(
      after.filter((row) =>
        String(row["evidence_json"]).includes("resolver_attempt_inconclusive"),
      ),
    ).toHaveLength(1);
  });

  // Copilot suppressed comment (F6): recordLateProof is also called by the
  // resolver when its FOUND CAS loses, so both the unconditional proof audit
  // AND the delivered transition must carry the CALLER's actor.
  it("suppressed F6: a resolver-initiated late proof audits actor resolver; the consumer path still audits consumer", async () => {
    const { database, d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);

    async function seedAmbiguousRow(deliveryId: string): Promise<void> {
      await store.insert({
        deliveryId,
        destination: "alerts",
        shadow: false,
        payloadJson: "{}",
        now: DISPATCH_TEST_NOW,
      });
      expect(await store.claim(deliveryId, DISPATCH_TEST_NOW)).not.toBeNull();
      expect(
        await store.markAmbiguous(
          deliveryId,
          DISPATCH_TEST_NOW + 1_000,
          "http_500",
          null,
          "consumer",
          ["sending"],
        ),
      ).toBe(true);
    }

    const resolverId = "suppressed-f6-resolver-proof";
    await seedAmbiguousRow(resolverId);
    expect(
      await store.recordLateProof(
        resolverId,
        DISPATCH_TEST_NOW + 2_000,
        "1786665495.000400",
        ALERTS_CHANNEL,
        "resolver",
      ),
    ).toBe("ambiguous_cas");
    const resolverProof = auditRows(database, resolverId).filter((row) =>
      String(row["evidence_json"]).includes('"late_proof":true'),
    );
    // Both rows: the unconditional append and the delivered transition.
    expect(resolverProof).toHaveLength(2);
    expect(resolverProof[0]).toMatchObject({
      actor: "resolver",
      from_state: "ambiguous",
      to_state: "ambiguous",
    });
    expect(resolverProof[1]).toMatchObject({
      actor: "resolver",
      from_state: "ambiguous",
      to_state: "delivered",
    });

    const consumerId = "suppressed-f6-consumer-proof";
    await seedAmbiguousRow(consumerId);
    expect(
      await store.recordLateProof(
        consumerId,
        DISPATCH_TEST_NOW + 2_000,
        "1786665495.000401",
        ALERTS_CHANNEL,
        "consumer",
      ),
    ).toBe("ambiguous_cas");
    const consumerProof = auditRows(database, consumerId).filter((row) =>
      String(row["evidence_json"]).includes('"late_proof":true'),
    );
    expect(consumerProof).toHaveLength(2);
    expect(consumerProof.every((row) => row["actor"] === "consumer")).toBe(
      true,
    );
  });

  // Copilot suppressed comment (F7) / ADR §4 item 4: durable per-destination
  // pacing reservation, same semantics as the legacy reserveSlackSlot
  // (relay_state.next_slack_at) on the dispatcher's own table.
  it("suppressed F7: reserveSendSlot reserves once per interval and reports the remaining wait", async () => {
    const { database, d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);

    // First caller: the row does not exist yet — the upsert self-heals it.
    expect(
      await store.reserveSendSlot("alerts", DISPATCH_TEST_NOW, 6_100),
    ).toBe(0);
    expect(
      database
        .prepare("SELECT * FROM dispatch_rate_limit WHERE destination = ?")
        .get("alerts"),
    ).toMatchObject({
      destination: "alerts",
      next_send_ms: DISPATCH_TEST_NOW + 6_100,
    });

    // Second caller inside the interval: no reservation, remaining wait.
    expect(
      await store.reserveSendSlot("alerts", DISPATCH_TEST_NOW + 100, 6_100),
    ).toBe(6_000);
    expect(
      database
        .prepare(
          "SELECT next_send_ms FROM dispatch_rate_limit WHERE destination = ?",
        )
        .get("alerts"),
    ).toMatchObject({ next_send_ms: DISPATCH_TEST_NOW + 6_100 });

    // Once the interval elapsed the slot is reserved again.
    expect(
      await store.reserveSendSlot("alerts", DISPATCH_TEST_NOW + 6_100, 6_100),
    ).toBe(0);
    expect(
      database
        .prepare(
          "SELECT next_send_ms FROM dispatch_rate_limit WHERE destination = ?",
        )
        .get("alerts"),
    ).toMatchObject({ next_send_ms: DISPATCH_TEST_NOW + 12_200 });
  });

  // Panel finding (sweep vs. migration 0010 CHECK): `verify_scans_remaining`
  // is constrained `BETWEEN 0 AND 2`, and an operator-resent delivered row
  // sits at exactly 2 for the whole first-scan window — indefinitely while
  // §6.3.3/R18 inconclusive scans keep deferring without decrementing. The
  // sweep's unconditional `+ 1` therefore threw the CHECK from the one state
  // the R19 last-resort sweep exists to rescue, rolling the audit row back
  // with it and surfacing a permanent state precondition as a transient 503.
  // The clamp restores the arming; the change-guaranteeing predicate keeps F1
  // closed (ADR §10 H11).
  const seedOperatorResentDelivered = async (
    store: D1DispatchStore,
    deliveryId: string,
    deliveredMs: number,
  ): Promise<void> => {
    // Audit finding B3 (ADR §10 H15): the seeded DLQ trip is a CRASHED send —
    // claimed long enough ago for its 90 s lease to have expired, the only
    // shape that still reaches dead_letter. The sweep timeline below (from
    // DISPATCH_TEST_NOW onward) is untouched.
    const crashedSendMs = DISPATCH_TEST_NOW - DISPATCH_LEASE_MS - 2_000;
    await store.insert({
      deliveryId,
      destination: "alerts",
      shadow: false,
      payloadJson: "{}",
      now: crashedSendMs,
    });
    await store.claim(deliveryId, crashedSendMs + 1_000);
    await store.markDeadLetter(
      deliveryId,
      DISPATCH_TEST_NOW + 500,
      "queue_retries_exhausted",
    );
    // The ONLY resend path (I1) — it arms verify_scans_remaining = 2.
    await store.operatorResend(
      deliveryId,
      DISPATCH_TEST_NOW + 1_000,
      '{"resend":"possible-duplicate accepted by operator"}',
      null,
    );
    await store.claim(deliveryId, deliveredMs);
    // markDelivered preserves the counter and stamps the first scan.
    await store.markDelivered(
      deliveryId,
      deliveredMs,
      "1786665495.000900",
      ALERTS_CHANNEL,
      "consumer",
      ["sending"],
      '{"source":"chat.postMessage"}',
    );
  };

  it("sweep at the schema maximum: an operator-resent delivered row at verify_scans_remaining = 2 is armed, not rejected by the 0010 CHECK", async () => {
    const { database, d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);
    const deliveryId = "sweep-clamp-at-maximum";
    const deliveredMs = DISPATCH_TEST_NOW + 2_000;
    await seedOperatorResentDelivered(store, deliveryId, deliveredMs);
    expect(outboxRow(database, deliveryId)).toMatchObject({
      state: "delivered",
      verify_scans_remaining: 2,
      verify_after_ms: deliveredMs + VERIFY_FIRST_SCAN_DELAY_MS,
    });
    const auditsBefore = auditRows(database, deliveryId).length;

    // The operator reaches for the R19 sweep while the row still holds both
    // scans — the exact state the unconditional increment could not survive.
    const sweepNow = deliveredMs + 60_000;
    expect(
      await store.operatorSweepVerification(
        deliveryId,
        sweepNow,
        JSON.stringify({ operator_action: "sweep", verification_armed: true }),
        null,
      ),
    ).toBe(true);

    // Clamped at the schema maximum, and due NOW: the row is resolver-visible.
    expect(outboxRow(database, deliveryId)).toMatchObject({
      state: "delivered",
      verify_scans_remaining: 2,
      verify_after_ms: sweepNow,
    });
    const due = await store.verificationRowsDue(sweepNow, 10);
    expect(due.map((row) => row.deliveryId)).toContain(deliveryId);

    // The batch is atomic: the audit row landed with the update.
    const entries = auditRows(database, deliveryId);
    expect(entries).toHaveLength(auditsBefore + 1);
    expect(entries.at(-1)).toMatchObject({
      actor: "operator",
      from_state: "delivered",
      to_state: "delivered",
    });
    expect(String(entries.at(-1)?.["evidence_json"])).toContain(
      '"operator_action":"sweep"',
    );
  });

  it("sweep below the maximum: a row at verify_scans_remaining = 1 increments to 2 and becomes due now", async () => {
    const { database, d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);
    const deliveryId = "sweep-clamp-below-maximum";
    const deliveredMs = DISPATCH_TEST_NOW + 2_000;
    await seedOperatorResentDelivered(store, deliveryId, deliveredMs);

    // Spend the first scan the honest way, leaving the row at 1.
    const firstScanMs = deliveredMs + VERIFY_FIRST_SCAN_DELAY_MS;
    expect(
      await store.completeVerificationScan(
        deliveryId,
        firstScanMs,
        deliveredMs + VERIFY_SECOND_SCAN_DELAY_MS,
        2,
        firstScanMs,
      ),
    ).toBe(true);
    expect(outboxRow(database, deliveryId)).toMatchObject({
      verify_scans_remaining: 1,
      verify_after_ms: deliveredMs + VERIFY_SECOND_SCAN_DELAY_MS,
    });
    const auditsBefore = auditRows(database, deliveryId).length;

    const sweepNow = firstScanMs + 60_000;
    expect(
      await store.operatorSweepVerification(
        deliveryId,
        sweepNow,
        JSON.stringify({ operator_action: "sweep", verification_armed: true }),
        null,
      ),
    ).toBe(true);
    expect(outboxRow(database, deliveryId)).toMatchObject({
      state: "delivered",
      verify_scans_remaining: 2,
      verify_after_ms: sweepNow,
    });
    expect(auditRows(database, deliveryId)).toHaveLength(auditsBefore + 1);
  });

  it("sweep no-op: a row already at 2 AND already due at exactly this instant changes nothing and writes no audit row", async () => {
    const { database, d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);
    const deliveryId = "sweep-already-armed-and-due";
    const deliveredMs = DISPATCH_TEST_NOW + 2_000;
    await seedOperatorResentDelivered(store, deliveryId, deliveredMs);
    const auditsBefore = auditRows(database, deliveryId).length;

    // The single case the change-guaranteeing predicate rejects: the sweep
    // would move neither half. It is a genuine no-op (the row is already
    // armed and already due), so it answers false -> 409, never 503.
    const sweepNow = deliveredMs + VERIFY_FIRST_SCAN_DELAY_MS;
    expect(
      await store.operatorSweepVerification(
        deliveryId,
        sweepNow,
        JSON.stringify({ operator_action: "sweep", verification_armed: true }),
        null,
      ),
    ).toBe(false);
    expect(outboxRow(database, deliveryId)).toMatchObject({
      state: "delivered",
      verify_scans_remaining: 2,
      verify_after_ms: sweepNow,
    });
    // Atomic with the update: no audit row for a mutation that did not happen.
    expect(auditRows(database, deliveryId)).toHaveLength(auditsBefore);
  });

  it("F1 preservation at the maximum: a stale completion holding (2, OLD due time) cannot consume the scan a clamped sweep just armed", async () => {
    const { database, d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);
    const deliveryId = "sweep-clamp-f1-preserved";
    const deliveredMs = DISPATCH_TEST_NOW + 2_000;
    await seedOperatorResentDelivered(store, deliveryId, deliveredMs);
    // The snapshot an in-flight verification pass is holding.
    const staleVerifyAfterMs = deliveredMs + VERIFY_FIRST_SCAN_DELAY_MS;

    const sweepNow = staleVerifyAfterMs + 30_000;
    expect(
      await store.operatorSweepVerification(
        deliveryId,
        sweepNow,
        JSON.stringify({ operator_action: "sweep", verification_armed: true }),
        null,
      ),
    ).toBe(true);
    const auditsAfterSweep = auditRows(database, deliveryId).length;

    // The counter half of the F1 CAS still matches (the clamp left it at 2),
    // so the due-time half is the only thing standing between the stale pass
    // and the operator's fresh scan — and the sweep moved it.
    expect(
      await store.completeVerificationScan(
        deliveryId,
        sweepNow + 1_000,
        deliveredMs + VERIFY_SECOND_SCAN_DELAY_MS,
        2,
        staleVerifyAfterMs,
      ),
    ).toBe(false);
    expect(outboxRow(database, deliveryId)).toMatchObject({
      verify_scans_remaining: 2,
      verify_after_ms: sweepNow,
    });
    expect(auditRows(database, deliveryId)).toHaveLength(auditsAfterSweep);

    // Positive control: a pass holding the swept snapshot still completes.
    expect(
      await store.completeVerificationScan(
        deliveryId,
        sweepNow + 2_000,
        deliveredMs + VERIFY_SECOND_SCAN_DELAY_MS,
        2,
        sweepNow,
      ),
    ).toBe(true);
    expect(outboxRow(database, deliveryId)).toMatchObject({
      verify_scans_remaining: 1,
    });
  });

  // Copilot suppressed comment (F4) / ADR §10 H12: the route's read-then-act
  // digest check does not make a command one-shot under concurrency. Both
  // requests observe no digest; for a delivered row with zero scans the first
  // sweep increments 0 -> 1 and the second still satisfies
  // verify_scans_remaining < 2, increments 1 -> 2 and writes the same command
  // twice. These tests execute the STORE call twice with the same digest and
  // NO intervening pre-check — the concurrent shape.
  const OPERATOR_DIGEST = "9".repeat(64);
  const OTHER_DIGEST = "7".repeat(64);

  it("suppressed F4: two concurrent-shaped identical sweeps apply exactly once", async () => {
    const { database, d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);
    const deliveryId = "f4-concurrent-sweep";
    // The R19 shape the finding names: delivered, both automatic scans spent.
    insertRawOutboxRow(database, {
      deliveryId,
      destination: "alerts",
      state: "delivered",
      slackChannelId: ALERTS_CHANNEL,
      slackMessageTs: "1786665495.000500",
    });
    const evidence = JSON.stringify({
      operator_action: "sweep",
      verification_armed: true,
      request_signature_sha256: OPERATOR_DIGEST,
    });

    const first = await store.operatorSweepVerification(
      deliveryId,
      DISPATCH_TEST_NOW,
      evidence,
      OPERATOR_DIGEST,
    );
    const second = await store.operatorSweepVerification(
      deliveryId,
      DISPATCH_TEST_NOW,
      evidence,
      OPERATOR_DIGEST,
    );

    expect(first).toBe(true);
    expect(second).toBe(false);
    // Incremented ONCE (0 -> 1, not 0 -> 2)...
    expect(outboxRow(database, deliveryId)).toMatchObject({
      state: "delivered",
      verify_scans_remaining: 1,
      verify_after_ms: DISPATCH_TEST_NOW,
    });
    // ...and exactly one audit row: the ledger entry IS the guard.
    expect(auditRows(database, deliveryId)).toHaveLength(1);

    // A different signed command on the same row still applies.
    expect(
      await store.operatorSweepVerification(
        deliveryId,
        DISPATCH_TEST_NOW + 1_000,
        JSON.stringify({
          operator_action: "sweep",
          request_signature_sha256: OTHER_DIGEST,
        }),
        OTHER_DIGEST,
      ),
    ).toBe(true);
    expect(outboxRow(database, deliveryId)).toMatchObject({
      verify_scans_remaining: 2,
    });
    expect(auditRows(database, deliveryId)).toHaveLength(2);
  });

  it("suppressed F4: two concurrent-shaped identical resends apply exactly once", async () => {
    const { database, d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);
    const deliveryId = "f4-concurrent-resend";
    insertRawOutboxRow(database, {
      deliveryId,
      destination: "alerts",
      state: "manual",
    });
    const evidence = JSON.stringify({
      operator_action: "resend",
      possible_duplicate: true,
      request_signature_sha256: OPERATOR_DIGEST,
    });

    expect(
      await store.operatorResend(
        deliveryId,
        DISPATCH_TEST_NOW,
        evidence,
        OPERATOR_DIGEST,
      ),
    ).toBe(true);
    // The resend fails and the row returns to `manual` — without the in-batch
    // guard the state CAS alone would accept the same command again and
    // initiate a SECOND operator-marked possible duplicate.
    database
      .prepare(
        "UPDATE dispatch_outbox SET state = 'manual' WHERE delivery_id = ?",
      )
      .run(deliveryId);

    expect(
      await store.operatorResend(
        deliveryId,
        DISPATCH_TEST_NOW,
        evidence,
        OPERATOR_DIGEST,
      ),
    ).toBe(false);
    expect(outboxRow(database, deliveryId)).toMatchObject({ state: "manual" });
    expect(auditRows(database, deliveryId)).toHaveLength(1);
  });

  it("suppressed F4: close_manual and mark_delivered are one-shot inside their own batch", async () => {
    const { database, d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);
    const closedId = "f4-concurrent-close";
    const markedId = "f4-concurrent-mark-delivered";
    insertRawOutboxRow(database, {
      deliveryId: closedId,
      destination: "alerts",
      state: "manual",
    });
    insertRawOutboxRow(database, {
      deliveryId: markedId,
      destination: "alerts",
      state: "manual",
    });
    const backToManual = (deliveryId: string): void => {
      database
        .prepare(
          "UPDATE dispatch_outbox SET state = 'manual'," +
            " slack_message_ts = NULL, slack_channel_id = NULL" +
            " WHERE delivery_id = ?",
        )
        .run(deliveryId);
    };

    const closeEvidence = JSON.stringify({
      operator_action: "close_manual",
      request_signature_sha256: OPERATOR_DIGEST,
    });
    expect(
      await store.operatorCloseManual(
        closedId,
        DISPATCH_TEST_NOW,
        closeEvidence,
        OPERATOR_DIGEST,
      ),
    ).toBe(true);
    backToManual(closedId);
    expect(
      await store.operatorCloseManual(
        closedId,
        DISPATCH_TEST_NOW,
        closeEvidence,
        OPERATOR_DIGEST,
      ),
    ).toBe(false);
    expect(outboxRow(database, closedId)).toMatchObject({ state: "manual" });
    expect(auditRows(database, closedId)).toHaveLength(1);

    const proofTs = "1786665495.000510";
    const markEvidence = JSON.stringify({
      operator_action: "mark_delivered",
      ts: proofTs,
      request_signature_sha256: OPERATOR_DIGEST,
    });
    expect(
      await store.markDelivered(
        markedId,
        DISPATCH_TEST_NOW,
        proofTs,
        ALERTS_CHANNEL,
        "operator",
        ["manual"],
        markEvidence,
        OPERATOR_DIGEST,
      ),
    ).toBe(true);
    backToManual(markedId);
    expect(
      await store.markDelivered(
        markedId,
        DISPATCH_TEST_NOW,
        proofTs,
        ALERTS_CHANNEL,
        "operator",
        ["manual"],
        markEvidence,
        OPERATOR_DIGEST,
      ),
    ).toBe(false);
    expect(outboxRow(database, markedId)).toMatchObject({
      state: "manual",
      slack_message_ts: null,
    });
    expect(auditRows(database, markedId)).toHaveLength(1);
  });
});
