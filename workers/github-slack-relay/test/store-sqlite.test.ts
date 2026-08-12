import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { URL as NodeUrl } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { handleFetch } from "../src/index";
import {
  D1DeliveryStore,
  type DeliveryInput,
  type DeliveryStore,
} from "../src/store";
import {
  FakeQueue,
  makeEnv,
  sampleSlackPayload,
  signedRequest,
  workflowPayload,
} from "./helpers";

const NOW = Date.parse("2026-08-03T12:00:00.000Z");
const openDatabases: DatabaseSync[] = [];

function protocolActivation(revision: string, activationId = "3".repeat(64)) {
  return {
    activationId,
    revision,
    schemaRevision: "0004_confirm_slack_delivery",
    now: NOW,
  };
}

function migrationSource(name: string): string {
  return readFileSync(
    new NodeUrl(`../migrations/${name}`, import.meta.url),
    "utf8",
  );
}

function d1Result(changes: number, results: unknown[] = []): D1Result<unknown> {
  return {
    success: true,
    results,
    meta: { changes },
  } as unknown as D1Result<unknown>;
}

function sqliteD1(database: DatabaseSync): D1Database {
  return {
    prepare(query: string): D1PreparedStatement {
      const statement = database.prepare(query);
      let values: SQLInputValue[] = [];
      const prepared = {
        bind(...bindings: unknown[]): D1PreparedStatement {
          values = bindings as SQLInputValue[];
          return prepared as unknown as D1PreparedStatement;
        },
        async run(): Promise<D1Result<unknown>> {
          const result = statement.run(...values);
          return d1Result(Number(result.changes));
        },
        async first<T>(columnName?: string): Promise<T | null> {
          const row = statement.get(...values) as
            Record<string, unknown> | undefined;
          if (row === undefined) return null;
          return (columnName === undefined ? row : row[columnName]) as T;
        },
        async all<T>(): Promise<D1Result<T>> {
          const rows = statement.all(...values) as T[];
          return d1Result(0, rows) as D1Result<T>;
        },
      };
      return prepared as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
}

function databaseWithMigrations(applyMigrations: boolean): {
  database: DatabaseSync;
  d1: D1Database;
} {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  openDatabases.push(database);

  if (applyMigrations) {
    for (const migration of [
      "0001_initial.sql",
      "0002_add_destination.sql",
      "0003_rename_delivery_acceptance.sql",
      "0004_confirm_slack_delivery.sql",
    ]) {
      database.exec(migrationSource(migration));
    }
  }

  return { database, d1: sqliteD1(database) };
}

function input(deliveryId: string): DeliveryInput {
  return {
    deliveryId,
    eventType: "workflow_run",
    action: "completed",
    repository: "LCV-Ideas-Software/cross-review",
    destination: "alerts",
    payload: sampleSlackPayload(deliveryId),
    now: NOW,
  };
}

afterEach(() => {
  for (const database of openDatabases.splice(0)) {
    database.close();
  }
});

describe("D1 schema and constraint behavior on real SQLite", () => {
  it("keeps the expand migration compatible with the previously deployed Worker", () => {
    const { database } = databaseWithMigrations(false);
    for (const migration of [
      "0001_initial.sql",
      "0002_add_destination.sql",
      "0003_rename_delivery_acceptance.sql",
    ]) {
      database.exec(migrationSource(migration));
    }
    database
      .prepare(
        `INSERT INTO deliveries (
         delivery_id, event_type, action, repository, destination,
         payload_json, status, attempt_count, next_attempt_at,
         created_at, updated_at
       ) VALUES ('old-worker-in-flight', 'push', '', '.github', 'activity',
         '{}', 'sending', 1, ?, ?, ?)`,
      )
      .run(NOW, NOW, NOW);

    database.exec(migrationSource("0004_confirm_slack_delivery.sql"));

    expect(() =>
      database
        .prepare(
          `SELECT delivery_id, event_type, action, repository, destination,
                payload_json, status, attempt_count, next_attempt_at,
                last_error, created_at, updated_at, accepted_at
         FROM deliveries WHERE 0 = 1`,
        )
        .all(),
    ).not.toThrow();
    expect(
      database
        .prepare(
          `SELECT next_slack_at FROM relay_state
         WHERE singleton_id = 1 AND typeof(next_slack_at) = 'integer'`,
        )
        .get(),
    ).toEqual({ next_slack_at: 0 });
    expect(() =>
      database
        .prepare(
          `UPDATE deliveries
         SET status = 'accepted_by_slack', accepted_at = ?, updated_at = ?
         WHERE delivery_id = 'old-worker-in-flight' AND status = 'sending'`,
        )
        .run(NOW, NOW),
    ).not.toThrow();
    expect(
      database
        .prepare(
          `SELECT status, accepted_at, trigger_accepted_at, legacy_unverified
         FROM deliveries WHERE delivery_id = 'old-worker-in-flight'`,
        )
        .get(),
    ).toEqual({
      status: "accepted_by_slack",
      accepted_at: null,
      trigger_accepted_at: NOW,
      legacy_unverified: 1,
    });
  });

  it("starts the delivery protocol closed and quarantines old-Worker acceptances", () => {
    const { database } = databaseWithMigrations(false);
    for (const migration of [
      "0001_initial.sql",
      "0002_add_destination.sql",
      "0003_rename_delivery_acceptance.sql",
    ]) {
      database.exec(migrationSource(migration));
    }
    database
      .prepare(
        `INSERT INTO deliveries (
         delivery_id, event_type, action, repository, destination,
         payload_json, status, attempt_count, next_attempt_at,
         created_at, updated_at
       ) VALUES ('old-worker-window', 'push', '', '.github', 'activity',
         '{}', 'sending', 1, ?, ?, ?)`,
      )
      .run(NOW, NOW, NOW);

    database.exec(migrationSource("0004_confirm_slack_delivery.sql"));
    expect(
      database
        .prepare(
          `SELECT slack_delivery_protocol_active,
                slack_delivery_protocol_revision,
                slack_delivery_protocol_activated_at,
                slack_delivery_protocol_activation_id,
                slack_delivery_protocol_schema_revision,
                slack_delivery_protocol_confirmation_open
         FROM relay_state WHERE singleton_id = 1`,
        )
        .get(),
    ).toEqual({
      slack_delivery_protocol_active: 0,
      slack_delivery_protocol_revision: null,
      slack_delivery_protocol_activated_at: null,
      slack_delivery_protocol_activation_id: null,
      slack_delivery_protocol_schema_revision: null,
      slack_delivery_protocol_confirmation_open: 1,
    });

    database
      .prepare(
        `UPDATE deliveries
       SET status = 'accepted_by_slack', accepted_at = ?, updated_at = ?
       WHERE delivery_id = 'old-worker-window' AND status = 'sending'`,
      )
      .run(NOW + 1, NOW + 1);
    expect(
      database
        .prepare(
          `SELECT status, accepted_at, trigger_accepted_at, legacy_unverified
         FROM deliveries WHERE delivery_id = 'old-worker-window'`,
        )
        .get(),
    ).toEqual({
      status: "accepted_by_slack",
      accepted_at: null,
      trigger_accepted_at: NOW + 1,
      legacy_unverified: 1,
    });
  });

  it("applies one activation and confirms only its identical tuple", async () => {
    const { database, d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);
    const revision = "c".repeat(40);
    const activation = protocolActivation(revision);

    await expect(store.isSlackDeliveryProtocolActive()).resolves.toBe(false);
    await expect(store.healthcheck(NOW)).resolves.toBe(false);
    const concurrent = await Promise.all([
      store.activateSlackDeliveryProtocol(activation),
      store.activateSlackDeliveryProtocol(activation),
    ]);
    expect(concurrent.sort()).toEqual(["already_applied", "applied"]);
    await expect(store.isSlackDeliveryProtocolActive()).resolves.toBe(true);
    await expect(store.healthcheck(NOW)).resolves.toBe(true);
    expect(
      database
        .prepare(
          `SELECT slack_delivery_protocol_active,
                slack_delivery_protocol_revision,
                slack_delivery_protocol_activated_at,
                slack_delivery_protocol_activation_id,
                slack_delivery_protocol_schema_revision,
                slack_delivery_protocol_confirmation_open
         FROM relay_state WHERE singleton_id = 1`,
        )
        .get(),
    ).toEqual({
      slack_delivery_protocol_active: 1,
      slack_delivery_protocol_revision: revision,
      slack_delivery_protocol_activated_at: NOW,
      slack_delivery_protocol_activation_id: activation.activationId,
      slack_delivery_protocol_schema_revision: activation.schemaRevision,
      slack_delivery_protocol_confirmation_open: 1,
    });

    await expect(
      store.activateSlackDeliveryProtocol({
        ...activation,
        activationId: "4".repeat(64),
      }),
    ).rejects.toThrow("slack_delivery_protocol_activation_conflict");

    database
      .prepare(
        `UPDATE relay_state
       SET slack_delivery_protocol_confirmation_open = 0
       WHERE singleton_id = 1`,
      )
      .run();
    await expect(
      store.activateSlackDeliveryProtocol(activation),
    ).rejects.toThrow("slack_delivery_protocol_activation_conflict");
    expect(() =>
      database
        .prepare(
          `UPDATE relay_state
         SET slack_delivery_protocol_confirmation_open = 1
         WHERE singleton_id = 1`,
        )
        .run(),
    ).toThrow("slack_delivery_protocol_confirmation_is_one_way");
    expect(() =>
      database
        .prepare(
          `UPDATE relay_state
         SET slack_delivery_protocol_active = 0,
             slack_delivery_protocol_revision = NULL,
             slack_delivery_protocol_activated_at = NULL
         WHERE singleton_id = 1`,
        )
        .run(),
    ).toThrow("slack_delivery_protocol_activation_is_one_way");
  });

  it("refuses activation when an expanded schema artifact is absent", async () => {
    const { database, d1 } = databaseWithMigrations(true);
    database.exec("DROP TRIGGER quarantine_old_worker_acceptance");
    const store = new D1DeliveryStore(d1);

    await expect(
      store.activateSlackDeliveryProtocol(protocolActivation("d".repeat(40))),
    ).rejects.toThrow("slack_delivery_protocol_schema_incomplete");
    await expect(store.isSlackDeliveryProtocolActive()).resolves.toBe(false);
  });

  it("backfills old trigger acceptances as unverified and isolates the known lost delivery", async () => {
    const { database, d1 } = databaseWithMigrations(false);
    for (const migration of [
      "0001_initial.sql",
      "0002_add_destination.sql",
      "0003_rename_delivery_acceptance.sql",
    ]) {
      database.exec(migrationSource(migration));
    }
    const insert = database.prepare(
      `INSERT INTO deliveries (
         delivery_id, event_type, action, repository, destination,
         payload_json, status, attempt_count, next_attempt_at,
         created_at, updated_at, accepted_at
       ) VALUES (?, 'pull_request', 'synchronize', '.github', 'activity',
         '{}', 'accepted_by_slack', 1, ?, ?, ?, ?)`,
    );
    insert.run("de345e40-95b1-11f1-8d38-fac15f0bb4cd", NOW, NOW, NOW, NOW);
    insert.run("legacy-unverified", NOW, NOW, NOW, NOW);

    database.exec(migrationSource("0004_confirm_slack_delivery.sql"));

    expect(
      database
        .prepare(
          `SELECT status, last_error, legacy_unverified, delivered_at,
                slack_message_ts
         FROM deliveries WHERE delivery_id = ?`,
        )
        .get("de345e40-95b1-11f1-8d38-fac15f0bb4cd"),
    ).toEqual({
      status: "manual_review",
      last_error: "known_slack_workflow_timeout_message_absent",
      legacy_unverified: 1,
      delivered_at: null,
      slack_message_ts: null,
    });
    expect(
      database
        .prepare(
          `SELECT status, accepted_at, legacy_unverified, delivered_at, slack_message_ts
         FROM deliveries WHERE delivery_id = 'legacy-unverified'`,
        )
        .get(),
    ).toEqual({
      status: "accepted_by_slack",
      accepted_at: null,
      legacy_unverified: 1,
      delivered_at: null,
      slack_message_ts: null,
    });
    const store = new D1DeliveryStore(d1);
    await expect(store.healthcheck(NOW)).resolves.toBe(false);
    await store.recordSlackTrace(
      {
        traceId: "TrLegacyPreSend1",
        deliveryId: "legacy-unverified",
        outcome: "error",
        sendBoundaryReached: false,
        preSendFailureProven: true,
        startedAtUs: NOW * 1_000,
        completedAtUs: NOW * 1_000 + 1,
      },
      NOW + 1,
    );
    await expect(store.get("legacy-unverified")).resolves.toMatchObject({
      status: "pending",
      legacyUnverified: false,
      lastError: "slack_workflow_failed_before_send_boundary",
    });
    await expect(
      store.get("de345e40-95b1-11f1-8d38-fac15f0bb4cd"),
    ).resolves.toMatchObject({
      status: "manual_review",
      legacyUnverified: true,
    });
  });

  it("releases only the explicitly authorized known loss once and preserves its audit trail", async () => {
    const { database, d1 } = databaseWithMigrations(false);
    for (const migration of [
      "0001_initial.sql",
      "0002_add_destination.sql",
      "0003_rename_delivery_acceptance.sql",
    ]) {
      database.exec(migrationSource(migration));
    }
    database
      .prepare(
        `INSERT INTO deliveries (
         delivery_id, event_type, action, repository, destination,
         payload_json, status, attempt_count, next_attempt_at,
         created_at, updated_at, accepted_at
       ) VALUES (?, 'pull_request', 'synchronize', '.github', 'activity',
         ?, 'accepted_by_slack', 1, ?, ?, ?, ?)`,
      )
      .run(
        "de345e40-95b1-11f1-8d38-fac15f0bb4cd",
        JSON.stringify(
          sampleSlackPayload("de345e40-95b1-11f1-8d38-fac15f0bb4cd"),
        ),
        NOW,
        NOW,
        NOW,
        NOW,
      );
    database.exec(migrationSource("0004_confirm_slack_delivery.sql"));
    const store = new D1DeliveryStore(d1);

    await expect(
      store.recordSlackProgress({
        deliveryId: "de345e40-95b1-11f1-8d38-fac15f0bb4cd",
        destination: "activity",
        phase: "delivered",
        messageTs: "1785758400.000170",
        now: NOW + 1,
        reconcileAt: NOW + 20 * 60 * 1_000,
      }),
    ).rejects.toThrow("known_loss_recovery_authorization_required");

    const authorizationAt = NOW + 100;
    const absenceProof =
      "https://github.com/LCV-Ideas-Software/.github/issues/171#issuecomment-1111111111";
    const authorization =
      "https://github.com/LCV-Ideas-Software/.github/issues/171#issuecomment-2222222222";
    const release = database.prepare(
      `INSERT INTO slack_delivery_recovery_audit (
         delivery_id, destination, absence_proof_reference,
         authorization_reference, absence_proof_sha256,
         authorization_sha256, authorized_by, authorized_at, released_at
       ) VALUES (?, 'activity', ?, ?, ?, ?, 'lcv-leo', ?, ?)`,
    );

    expect(() =>
      release.run(
        "de345e40-95b1-11f1-8d38-fac15f0bb4cd",
        absenceProof,
        absenceProof,
        "a".repeat(64),
        "b".repeat(64),
        authorizationAt,
        authorizationAt,
      ),
    ).toThrow();
    expect(() =>
      release.run(
        "de345e40-95b1-11f1-8d38-fac15f0bb4cd",
        absenceProof,
        authorization,
        "a".repeat(64),
        "b".repeat(64),
        authorizationAt,
        authorizationAt + 1,
      ),
    ).toThrow();
    expect(() =>
      release.run(
        "de345e40-95b1-11f1-8d38-fac15f0bb4cd",
        absenceProof,
        authorization,
        "a".repeat(64),
        "a".repeat(64),
        authorizationAt,
        authorizationAt,
      ),
    ).toThrow();

    release.run(
      "de345e40-95b1-11f1-8d38-fac15f0bb4cd",
      absenceProof,
      authorization,
      "a".repeat(64),
      "b".repeat(64),
      authorizationAt,
      authorizationAt,
    );
    expect(
      database
        .prepare(
          `SELECT status, next_attempt_at, last_error, legacy_unverified
         FROM deliveries WHERE delivery_id = ?`,
        )
        .get("de345e40-95b1-11f1-8d38-fac15f0bb4cd"),
    ).toEqual({
      status: "pending",
      next_attempt_at: authorizationAt,
      last_error: "explicit_known_loss_recovery_authorized",
      legacy_unverified: 0,
    });
    expect(() =>
      release.run(
        "de345e40-95b1-11f1-8d38-fac15f0bb4cd",
        absenceProof,
        authorization,
        "a".repeat(64),
        "b".repeat(64),
        authorizationAt,
        authorizationAt,
      ),
    ).toThrow();

    await expect(
      store.claimForSlack(
        "de345e40-95b1-11f1-8d38-fac15f0bb4cd",
        authorizationAt,
      ),
    ).resolves.toMatchObject({ status: "sending", destination: "activity" });
    await store.markAcceptedByTrigger(
      "de345e40-95b1-11f1-8d38-fac15f0bb4cd",
      authorizationAt + 1,
      authorizationAt + 20 * 60 * 1_000,
    );
    await store.recordSlackProgress({
      deliveryId: "de345e40-95b1-11f1-8d38-fac15f0bb4cd",
      destination: "activity",
      phase: "delivered",
      messageTs: "1785758400.000171",
      now: authorizationAt + 2,
      reconcileAt: authorizationAt + 20 * 60 * 1_000,
    });
    await expect(
      store.get("de345e40-95b1-11f1-8d38-fac15f0bb4cd"),
    ).resolves.toMatchObject({
      status: "delivered",
      slackMessageTs: "1785758400.000171",
    });
    expect(
      database
        .prepare(
          `SELECT destination, absence_proof_reference, authorization_reference,
                absence_proof_sha256, authorization_sha256, authorized_by,
                authorized_at, prior_status, prior_reason, released_at
         FROM slack_delivery_recovery_audit WHERE delivery_id = ?`,
        )
        .get("de345e40-95b1-11f1-8d38-fac15f0bb4cd"),
    ).toEqual({
      destination: "activity",
      absence_proof_reference: absenceProof,
      authorization_reference: authorization,
      absence_proof_sha256: "a".repeat(64),
      authorization_sha256: "b".repeat(64),
      authorized_by: "lcv-leo",
      authorized_at: authorizationAt,
      prior_status: "manual_review",
      prior_reason: "known_slack_workflow_timeout_message_absent",
      released_at: authorizationAt,
    });
  });

  it("clamps the durable checkpoint behind every uncorrelated live attempt", async () => {
    const { d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-late-indexed-trace";
    await store.insert(input(deliveryId));

    await expect(
      store.advanceSlackActivityCheckpoint((NOW + 60 * 60 * 1_000) * 1_000),
    ).resolves.toBe(NOW * 1_000);

    await store.markQueued(deliveryId, NOW);
    await store.claimForSlack(deliveryId, NOW + 1);
    await store.markAcceptedByTrigger(
      deliveryId,
      NOW + 2,
      NOW + 20 * 60 * 1_000,
    );
    await store.recordSlackTrace(
      {
        traceId: "TrLateIndexed1",
        deliveryId,
        outcome: "error",
        sendBoundaryReached: false,
        preSendFailureProven: true,
        startedAtUs: (NOW + 1) * 1_000,
        completedAtUs: (NOW + 3) * 1_000,
      },
      NOW + 3,
    );
    await expect(
      store.advanceSlackActivityCheckpoint((NOW + 60 * 60 * 1_000) * 1_000),
    ).resolves.toBe((NOW + 3) * 1_000);

    await store.markQueued(deliveryId, NOW + 4);
    await store.claimForSlack(deliveryId, NOW + 5);
    await expect(
      store.advanceSlackActivityCheckpoint((NOW + 60 * 60 * 1_000) * 1_000),
    ).resolves.toBe((NOW + 5) * 1_000);
  });

  it("recognizes the migrated schema only after protocol activation", async () => {
    const { d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);

    await expect(store.healthcheck(NOW)).resolves.toBe(false);
    await store.activateSlackDeliveryProtocol(
      protocolActivation("e".repeat(40)),
    );
    await expect(store.healthcheck(NOW)).resolves.toBe(true);
  });

  it("makes readiness fail generically when the remote schema is empty", async () => {
    const { d1 } = databaseWithMigrations(false);
    const queue = new FakeQueue();
    const env = makeEnv(queue);
    env.DB = d1;

    const response = await handleFetch(
      new Request("https://relay.example/healthz"),
      env,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unavailable" });
  });

  it("makes readiness fail when relay_state lacks its singleton", async () => {
    const { database, d1 } = databaseWithMigrations(true);
    database.exec("DELETE FROM relay_state;");
    const store = new D1DeliveryStore(d1);

    await expect(store.healthcheck(NOW)).resolves.toBe(false);
  });

  it("deduplicates only a primary-key conflict and propagates other constraints", async () => {
    const { database, d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);
    const valid = input("sqlite-dedupe-1");

    await expect(store.insert(valid)).resolves.toBe(true);
    await expect(store.insert(valid)).resolves.toBe(false);
    await expect(
      store.insert({
        ...input("sqlite-invalid-constraint"),
        destination: "external" as DeliveryInput["destination"],
      }),
    ).rejects.toThrow();
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM deliveries").get(),
    ).toEqual({ count: 1 });
  });

  it("does not claim or increment a delivery before next_attempt_at", async () => {
    const { d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-future-attempt";
    const dueAt = NOW + 17_000;

    await store.insert(input(deliveryId));
    await store.markEnqueueFailed(deliveryId, NOW, dueAt, "retry_later");

    await expect(store.claimForSlack(deliveryId, NOW)).resolves.toBeNull();
    await expect(store.get(deliveryId)).resolves.toMatchObject({
      attemptCount: 0,
      nextAttemptAt: dueAt,
      status: "pending",
    });

    await expect(store.claimForSlack(deliveryId, dueAt)).resolves.toMatchObject(
      {
        attemptCount: 1,
        status: "sending",
      },
    );
  });

  it("maps a real SQLite constraint failure to the generic webhook 503", async () => {
    const { d1 } = databaseWithMigrations(true);
    const queue = new FakeQueue();
    const store = new D1DeliveryStore(d1);
    const failingStore = Object.create(store) as DeliveryStore;
    failingStore.insert = async (delivery) =>
      store.insert({
        ...delivery,
        destination: "external" as DeliveryInput["destination"],
      });
    const request = await signedRequest(
      "workflow_run",
      "sqlite-webhook-constraint",
      workflowPayload(),
    );

    const response = await handleFetch(request, makeEnv(queue), {
      store: failingStore,
      now: () => NOW,
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "persistence_unavailable" });
    expect(queue.sent).toHaveLength(0);
  });

  it("degrades readiness when a manual_review row exists", async () => {
    const { d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);
    await store.insert(input("sqlite-manual-review"));
    await store.markManualReview(
      "sqlite-manual-review",
      NOW,
      "test_manual_review",
    );

    await expect(store.healthcheck(NOW)).resolves.toBe(false);
  });

  it("degrades readiness when a dead_letter row exists", async () => {
    const { d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);
    await store.insert(input("sqlite-dead-letter"));
    await store.markDeadLetter(
      "sqlite-dead-letter",
      NOW,
      NOW + 60_000,
      "test_dead_letter",
    );

    await expect(store.healthcheck(NOW)).resolves.toBe(false);
  });

  it("stores an authenticated Slack message timestamp once and rejects reuse", async () => {
    const { d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);
    await store.insert(input("sqlite-receipt-one"));
    await store.markQueued("sqlite-receipt-one", NOW);
    await store.claimForSlack("sqlite-receipt-one", NOW);
    await store.markAcceptedByTrigger(
      "sqlite-receipt-one",
      NOW,
      NOW + 20 * 60 * 1_000,
    );

    await expect(
      store.recordSlackProgress({
        deliveryId: "sqlite-receipt-one",
        destination: "alerts",
        phase: "delivered",
        messageTs: "1785758400.000001",
        now: NOW + 1,
        reconcileAt: NOW + 20 * 60 * 1_000,
      }),
    ).resolves.toBe("recorded");
    await expect(
      store.recordSlackProgress({
        deliveryId: "sqlite-receipt-one",
        destination: "alerts",
        phase: "delivered",
        messageTs: "1785758400.000001",
        now: NOW + 2,
        reconcileAt: NOW + 20 * 60 * 1_000,
      }),
    ).resolves.toBe("duplicate");

    await store.insert(input("sqlite-receipt-two"));
    await store.markQueued("sqlite-receipt-two", NOW);
    await store.claimForSlack("sqlite-receipt-two", NOW);
    await store.markAcceptedByTrigger(
      "sqlite-receipt-two",
      NOW,
      NOW + 20 * 60 * 1_000,
    );
    await expect(
      store.recordSlackProgress({
        deliveryId: "sqlite-receipt-two",
        destination: "alerts",
        phase: "delivered",
        messageTs: "1785758400.000001",
        now: NOW + 3,
        reconcileAt: NOW + 20 * 60 * 1_000,
      }),
    ).rejects.toThrow("slack_message_timestamp_conflict");
  });

  it("applies an overlapped terminal Slack trace exactly once", async () => {
    const { database, d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-trace-replay";
    await store.insert(input(deliveryId));
    await store.markQueued(deliveryId, NOW);
    await store.claimForSlack(deliveryId, NOW);
    await store.markAcceptedByTrigger(deliveryId, NOW, NOW + 20 * 60 * 1_000);
    const trace = {
      traceId: "TrSqliteReplay1",
      deliveryId,
      outcome: "error" as const,
      sendBoundaryReached: false,
      preSendFailureProven: true,
      startedAtUs: NOW * 1_000 - 1,
      completedAtUs: NOW * 1_000,
    };

    await store.recordSlackTrace(trace, NOW + 1);
    await expect(store.get(deliveryId)).resolves.toMatchObject({
      status: "pending",
      slackTraceId: trace.traceId,
    });
    await store.markQueued(deliveryId, NOW + 2);
    await store.recordSlackTrace(trace, NOW + 3);

    await expect(store.get(deliveryId)).resolves.toMatchObject({
      status: "queued",
      slackTraceId: trace.traceId,
    });
    expect(
      database
        .prepare(
          "SELECT applied_at FROM slack_workflow_traces WHERE trace_id = ?",
        )
        .get(trace.traceId),
    ).toEqual({ applied_at: NOW + 1 });
  });

  it("preserves an earlier send boundary when a later trace page omits it", async () => {
    const { d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-trace-boundary-overlap";
    await store.insert(input(deliveryId));
    await store.markQueued(deliveryId, NOW);
    await store.claimForSlack(deliveryId, NOW);
    await store.markAcceptedByTrigger(deliveryId, NOW, NOW + 20 * 60 * 1_000);

    await store.recordSlackTrace(
      {
        traceId: "TrBoundaryOverlap1",
        deliveryId,
        outcome: "pending",
        sendBoundaryReached: true,
        preSendFailureProven: false,
        startedAtUs: NOW * 1_000,
        completedAtUs: null,
      },
      NOW + 1,
    );
    await store.recordSlackTrace(
      {
        traceId: "TrBoundaryOverlap1",
        deliveryId,
        outcome: "error",
        sendBoundaryReached: false,
        preSendFailureProven: true,
        startedAtUs: NOW * 1_000,
        completedAtUs: NOW * 1_000 + 1,
      },
      NOW + 2,
    );

    await expect(store.get(deliveryId)).resolves.toMatchObject({
      status: "manual_review",
      lastError: "slack_workflow_failed_after_send_boundary",
      slackTraceId: "TrBoundaryOverlap1",
    });
  });

  it("preserves earlier pre-send proof until a terminal trace arrives", async () => {
    const { d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-trace-pre-send-overlap";
    await store.insert(input(deliveryId));
    await store.markQueued(deliveryId, NOW);
    await store.claimForSlack(deliveryId, NOW);
    await store.markAcceptedByTrigger(deliveryId, NOW, NOW + 1_000);

    await store.recordSlackTrace(
      {
        traceId: "TrPreSendOverlap1",
        deliveryId,
        outcome: "pending",
        sendBoundaryReached: false,
        preSendFailureProven: true,
        startedAtUs: NOW * 1_000,
        completedAtUs: null,
      },
      NOW + 1,
    );
    await store.recordSlackTrace(
      {
        traceId: "TrPreSendOverlap1",
        deliveryId,
        outcome: "error",
        sendBoundaryReached: false,
        preSendFailureProven: false,
        startedAtUs: NOW * 1_000,
        completedAtUs: NOW * 1_000 + 1,
      },
      NOW + 2,
    );

    await expect(store.get(deliveryId)).resolves.toMatchObject({
      status: "pending",
      lastError: "slack_workflow_failed_before_send_boundary",
      slackTraceId: "TrPreSendOverlap1",
    });
  });

  it("purges a delivered row and its reconciled trace together", async () => {
    const { database, d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-delivered-retention";
    await store.insert(input(deliveryId));
    await store.markQueued(deliveryId, NOW);
    await store.claimForSlack(deliveryId, NOW);
    await store.markAcceptedByTrigger(deliveryId, NOW, NOW + 1_000);
    await store.recordSlackProgress({
      deliveryId,
      destination: "alerts",
      phase: "delivered",
      messageTs: "1785758400.000099",
      now: NOW + 1,
      reconcileAt: NOW + 1_000,
    });
    await store.recordSlackTrace(
      {
        traceId: "TrRetention1",
        deliveryId,
        outcome: "success",
        sendBoundaryReached: true,
        preSendFailureProven: false,
        startedAtUs: NOW * 1_000,
        completedAtUs: NOW * 1_000 + 1,
      },
      NOW + 2,
    );

    await expect(store.purgeDeliveredBefore(NOW + 2)).resolves.toBe(1);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM deliveries").get(),
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM slack_workflow_traces")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("retries a trigger ambiguity only after complete pre-send trace proof", async () => {
    const { d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-trigger-ambiguity";
    await store.insert(input(deliveryId));
    await store.markManualReview(
      deliveryId,
      NOW,
      "slack_trigger_request_outcome_ambiguous",
    );

    await store.recordSlackTrace(
      {
        traceId: "TrTriggerSafe1",
        deliveryId,
        outcome: "error",
        sendBoundaryReached: false,
        preSendFailureProven: true,
        startedAtUs: NOW * 1_000 - 1,
        completedAtUs: NOW * 1_000,
      },
      NOW + 1,
    );

    await expect(store.get(deliveryId)).resolves.toMatchObject({
      status: "pending",
      lastError: "slack_workflow_failed_before_send_boundary",
    });
  });

  it("does not retry a terminal error that lacks explicit pre-send proof", async () => {
    const { d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-incomplete-error";
    await store.insert(input(deliveryId));
    await store.markQueued(deliveryId, NOW);
    await store.claimForSlack(deliveryId, NOW);
    await store.markAcceptedByTrigger(deliveryId, NOW, NOW + 1_000);

    await store.recordSlackTrace(
      {
        traceId: "TrIncompleteError1",
        deliveryId,
        outcome: "error",
        sendBoundaryReached: false,
        preSendFailureProven: false,
        startedAtUs: NOW * 1_000 - 1,
        completedAtUs: NOW * 1_000,
      },
      NOW + 1,
    );

    await expect(store.get(deliveryId)).resolves.toMatchObject({
      status: "manual_review",
      lastError: "slack_workflow_failed_without_pre_send_proof",
    });
  });
});
