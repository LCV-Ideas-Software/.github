import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { URL as NodeUrl } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { unstable_splitSqlQuery } from "wrangler";

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
const TEST_REVISION = "a".repeat(40);
const SEND_EXECUTION_ID = "FxStoreSqliteSend1";
const DELIVERY_EXECUTION_ID = "FxStoreSqliteDelivery1";
const TRACE_ATTEMPT_ONE = Object.freeze({
  attemptCount: 1,
  sendExecutionId: null,
});
const PRE_SEND_TRACE_ATTEMPT_ONE = Object.freeze({
  attemptCount: 1,
  sendExecutionId: "FxStoreSqliteTraceProof1",
});
const SEND_TRACE_ATTEMPT_ONE = Object.freeze({
  attemptCount: 1,
  sendExecutionId: SEND_EXECUTION_ID,
});
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
  const statementRunners = new WeakMap<
    D1PreparedStatement,
    () => D1Result<unknown>
  >();
  return {
    prepare(query: string): D1PreparedStatement {
      const statement = database.prepare(query);
      let values: SQLInputValue[] = [];
      const run = (): D1Result<unknown> => {
        const result = statement.run(...values);
        return d1Result(Number(result.changes));
      };
      const prepared = {
        bind(...bindings: unknown[]): D1PreparedStatement {
          values = bindings as SQLInputValue[];
          return prepared as unknown as D1PreparedStatement;
        },
        async run(): Promise<D1Result<unknown>> {
          return run();
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
      statementRunners.set(prepared as unknown as D1PreparedStatement, run);
      return prepared as unknown as D1PreparedStatement;
    },
    async batch<T = unknown>(
      statements: D1PreparedStatement[],
    ): Promise<D1Result<T>[]> {
      database.exec("BEGIN IMMEDIATE TRANSACTION;");
      try {
        const results = statements.map((statement) => {
          const run = statementRunners.get(statement);
          if (run === undefined) {
            throw new Error("foreign_sqlite_d1_statement");
          }
          return run() as D1Result<T>;
        });
        database.exec("COMMIT;");
        return results;
      } catch (error) {
        database.exec("ROLLBACK;");
        throw error;
      }
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

function pauseOnDeliveryRead(
  d1: D1Database,
  targetRead: number,
): {
  d1: D1Database;
  reached: Promise<void>;
  release: () => void;
} {
  let readCount = 0;
  let resolveReached: () => void = () => undefined;
  let resolveRelease: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    resolveReached = resolve;
  });
  const released = new Promise<void>((resolve) => {
    resolveRelease = resolve;
  });
  return {
    d1: {
      prepare(query: string): D1PreparedStatement {
        const statement = d1.prepare(query);
        if (query !== "SELECT * FROM deliveries WHERE delivery_id = ?") {
          return statement;
        }
        let bound = statement;
        const paused = {
          bind(...values: unknown[]): D1PreparedStatement {
            bound = statement.bind(...values);
            return paused as unknown as D1PreparedStatement;
          },
          async first<T>(columnName?: string): Promise<T | null> {
            const result =
              columnName === undefined
                ? await bound.first<T>()
                : await bound.first<T>(columnName);
            readCount += 1;
            if (readCount === targetRead) {
              resolveReached();
              await released;
            }
            return result;
          },
          run: bound.run.bind(bound),
          all: bound.all.bind(bound),
        };
        return paused as unknown as D1PreparedStatement;
      },
      batch: d1.batch.bind(d1),
    } as unknown as D1Database,
    reached,
    release: resolveRelease,
  };
}

function failNextTraceResolutionBatch(d1: D1Database): {
  d1: D1Database;
  arm: () => void;
} {
  let armed = false;
  return {
    d1: {
      prepare: d1.prepare.bind(d1),
      async batch<T = unknown>(
        statements: D1PreparedStatement[],
      ): Promise<D1Result<T>[]> {
        if (armed) {
          armed = false;
          throw new Error("injected_trace_resolution_failure");
        }
        return d1.batch<T>(statements);
      },
    } as unknown as D1Database,
    arm: () => {
      armed = true;
    },
  };
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
  it("keeps the expand migration executable as individual Wrangler D1 statements", () => {
    const { database } = databaseWithMigrations(false);
    for (const migration of [
      "0001_initial.sql",
      "0002_add_destination.sql",
      "0003_rename_delivery_acceptance.sql",
    ]) {
      database.exec(migrationSource(migration));
    }

    const statements = unstable_splitSqlQuery(
      migrationSource("0004_confirm_slack_delivery.sql"),
    );
    expect(statements).toHaveLength(23);
    for (const statement of statements) {
      expect(() => database.prepare(statement).run()).not.toThrow();
    }
  });

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

    await expect(store.isSlackDeliveryProtocolActive(revision)).resolves.toBe(
      false,
    );
    await expect(store.healthcheck(NOW, revision)).resolves.toBe(false);
    const concurrent = await Promise.all([
      store.activateSlackDeliveryProtocol(activation),
      store.activateSlackDeliveryProtocol(activation),
    ]);
    expect(concurrent.sort()).toEqual(["already_applied", "applied"]);
    await expect(store.isSlackDeliveryProtocolActive(revision)).resolves.toBe(
      true,
    );
    await expect(store.healthcheck(NOW, revision)).resolves.toBe(true);
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
    await expect(
      store.isSlackDeliveryProtocolActive("d".repeat(40)),
    ).resolves.toBe(false);
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
    await expect(store.healthcheck(NOW, TEST_REVISION)).resolves.toBe(false);
    await store.recordSlackTrace(
      {
        traceId: "TrLegacyPreSend1",
        deliveryId: "legacy-unverified",
        outcome: "error",
        ...PRE_SEND_TRACE_ATTEMPT_ONE,
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
        attemptCount: 1,
        functionExecutionId: DELIVERY_EXECUTION_ID,
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
      phase: "send_started",
      messageTs: null,
      attemptCount: 2,
      functionExecutionId: SEND_EXECUTION_ID,
      now: authorizationAt + 2,
      reconcileAt: authorizationAt + 20 * 60 * 1_000,
    });
    await store.recordSlackProgress({
      deliveryId: "de345e40-95b1-11f1-8d38-fac15f0bb4cd",
      destination: "activity",
      phase: "delivered",
      messageTs: "1785758400.000171",
      attemptCount: 2,
      functionExecutionId: DELIVERY_EXECUTION_ID,
      now: authorizationAt + 3,
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
        ...PRE_SEND_TRACE_ATTEMPT_ONE,
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
    await store.markAcceptedByTrigger(
      deliveryId,
      NOW + 6,
      NOW + 20 * 60 * 1_000,
    );
    await expect(
      store.advanceSlackActivityCheckpoint((NOW + 60 * 60 * 1_000) * 1_000),
    ).resolves.toBe((NOW + 6) * 1_000);
  });

  it("recognizes the migrated schema only after protocol activation", async () => {
    const { d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);

    await expect(store.healthcheck(NOW, "e".repeat(40))).resolves.toBe(false);
    await store.activateSlackDeliveryProtocol(
      protocolActivation("e".repeat(40)),
    );
    await expect(store.healthcheck(NOW, "e".repeat(40))).resolves.toBe(true);
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

    await expect(store.healthcheck(NOW, TEST_REVISION)).resolves.toBe(false);
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

    await expect(store.healthcheck(NOW, TEST_REVISION)).resolves.toBe(false);
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

    await expect(store.healthcheck(NOW, TEST_REVISION)).resolves.toBe(false);
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
    await store.recordSlackProgress({
      deliveryId: "sqlite-receipt-one",
      destination: "alerts",
      phase: "send_started",
      messageTs: null,
      attemptCount: 1,
      functionExecutionId: SEND_EXECUTION_ID,
      now: NOW + 1,
      reconcileAt: NOW + 20 * 60 * 1_000,
    });

    await expect(
      store.recordSlackProgress({
        deliveryId: "sqlite-receipt-one",
        destination: "alerts",
        phase: "delivered",
        messageTs: "1785758400.000001",
        attemptCount: 1,
        functionExecutionId: DELIVERY_EXECUTION_ID,
        now: NOW + 2,
        reconcileAt: NOW + 20 * 60 * 1_000,
      }),
    ).resolves.toBe("recorded");
    await expect(
      store.recordSlackProgress({
        deliveryId: "sqlite-receipt-one",
        destination: "alerts",
        phase: "delivered",
        messageTs: "1785758400.000001",
        attemptCount: 1,
        functionExecutionId: DELIVERY_EXECUTION_ID,
        now: NOW + 3,
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
    await store.recordSlackProgress({
      deliveryId: "sqlite-receipt-two",
      destination: "alerts",
      phase: "send_started",
      messageTs: null,
      attemptCount: 1,
      functionExecutionId: SEND_EXECUTION_ID,
      now: NOW + 1,
      reconcileAt: NOW + 20 * 60 * 1_000,
    });
    await expect(
      store.recordSlackProgress({
        deliveryId: "sqlite-receipt-two",
        destination: "alerts",
        phase: "delivered",
        messageTs: "1785758400.000001",
        attemptCount: 1,
        functionExecutionId: DELIVERY_EXECUTION_ID,
        now: NOW + 4,
        reconcileAt: NOW + 20 * 60 * 1_000,
      }),
    ).rejects.toThrow("slack_message_timestamp_conflict");
  });

  it("converges concurrent send-boundary callbacks to one mutation", async () => {
    const { d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-send-boundary-race";
    await store.insert(input(deliveryId));
    await store.markQueued(deliveryId, NOW);
    await store.claimForSlack(deliveryId, NOW);
    await store.markAcceptedByTrigger(deliveryId, NOW, NOW + 1_000);
    const progress = {
      deliveryId,
      destination: "alerts" as const,
      phase: "send_started" as const,
      messageTs: null,
      attemptCount: 1,
      functionExecutionId: SEND_EXECUTION_ID,
      now: NOW + 1,
      reconcileAt: NOW + 20 * 60 * 1_000,
    };

    const outcomes = await Promise.all([
      store.recordSlackProgress(progress),
      store.recordSlackProgress(progress),
    ]);
    expect(outcomes.sort()).toEqual(["duplicate", "recorded"]);
  });

  it("leases a send boundary to one Slack function execution per attempt", async () => {
    const { d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-send-boundary-execution-lease";
    await store.insert(input(deliveryId));
    await store.markQueued(deliveryId, NOW);
    await store.claimForSlack(deliveryId, NOW);
    await store.markAcceptedByTrigger(deliveryId, NOW, NOW + 1_000);
    const firstExecution = {
      deliveryId,
      destination: "alerts" as const,
      phase: "send_started" as const,
      messageTs: null,
      attemptCount: 1,
      functionExecutionId: "FxSendLeaseFirst1",
      now: NOW + 1,
      reconcileAt: NOW + 20 * 60 * 1_000,
    };

    await expect(store.recordSlackProgress(firstExecution)).resolves.toBe(
      "recorded",
    );
    await expect(store.recordSlackProgress(firstExecution)).resolves.toBe(
      "duplicate",
    );
    await expect(
      store.recordSlackProgress({
        ...firstExecution,
        functionExecutionId: "FxSendLeaseSecond2",
      }),
    ).rejects.toThrow("slack_send_execution_conflict");

    await store.recordSlackTrace(
      {
        traceId: "TrSendLeaseAttemptOneFailure1",
        deliveryId,
        outcome: "error",
        attemptCount: 1,
        sendExecutionId: "FxSendLeaseFirst1",
        sendBoundaryReached: false,
        preSendFailureProven: true,
        startedAtUs: NOW * 1_000,
        completedAtUs: NOW * 1_000 + 1,
      },
      NOW + 2,
    );
    await store.markQueued(deliveryId, NOW + 3);
    await store.claimForSlack(deliveryId, NOW + 4);
    await store.markAcceptedByTrigger(deliveryId, NOW + 4, NOW + 5_000);
    await expect(
      store.recordSlackProgress({
        ...firstExecution,
        attemptCount: 2,
        functionExecutionId: "FxSendLeaseAttemptTwo2",
        now: NOW + 5,
      }),
    ).resolves.toBe("recorded");
    await expect(store.recordSlackProgress(firstExecution)).rejects.toThrow(
      "slack_delivery_attempt_conflict",
    );
  });

  it("does not let a competing Slack execution release the active send lease", async () => {
    const { d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-competing-workflow-trace";
    await store.insert(input(deliveryId));
    await store.markQueued(deliveryId, NOW);
    await store.claimForSlack(deliveryId, NOW);
    await store.markAcceptedByTrigger(deliveryId, NOW, NOW + 1_000);
    await store.recordSlackProgress({
      deliveryId,
      destination: "alerts",
      phase: "send_started",
      messageTs: null,
      attemptCount: 1,
      functionExecutionId: "FxSendLeaseOwnerA1",
      now: NOW + 1,
      reconcileAt: NOW + 20 * 60 * 1_000,
    });
    const competingTrace = {
      traceId: "TrCompetingWorkflowB1",
      deliveryId,
      outcome: "error" as const,
      ...PRE_SEND_TRACE_ATTEMPT_ONE,
      sendBoundaryReached: false,
      preSendFailureProven: true,
      attemptCount: 1,
      sendExecutionId: "FxSendLeaseCompetitorB2",
      startedAtUs: NOW * 1_000,
      completedAtUs: NOW * 1_000 + 1,
    };

    await store.recordSlackTrace(competingTrace, NOW + 2);

    await expect(store.get(deliveryId)).resolves.toMatchObject({
      status: "send_started",
      attemptCount: 1,
      slackSendExecutionId: "FxSendLeaseOwnerA1",
    });
  });

  it("does not attach an earlier-attempt trace to a later delivered attempt", async () => {
    const { database, d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-stale-trace-after-later-delivery";
    await store.insert(input(deliveryId));
    await store.markQueued(deliveryId, NOW);
    await store.claimForSlack(deliveryId, NOW);
    await store.markAcceptedByTrigger(deliveryId, NOW, NOW + 1_000);
    await store.recordSlackTrace(
      {
        traceId: "TrAttemptOnePreSendFailure1",
        deliveryId,
        outcome: "error",
        attemptCount: 1,
        sendExecutionId: "FxAttemptOneValidator1",
        sendBoundaryReached: false,
        preSendFailureProven: true,
        startedAtUs: NOW * 1_000,
        completedAtUs: NOW * 1_000 + 1,
      },
      NOW + 1,
    );
    await store.markQueued(deliveryId, NOW + 2);
    await store.claimForSlack(deliveryId, NOW + 3);
    await store.markAcceptedByTrigger(deliveryId, NOW + 3, NOW + 4_000);
    await store.recordSlackProgress({
      deliveryId,
      destination: "alerts",
      phase: "send_started",
      messageTs: null,
      attemptCount: 2,
      functionExecutionId: "FxAttemptTwoSendOwner2",
      now: NOW + 4,
      reconcileAt: NOW + 5_000,
    });
    await store.recordSlackProgress({
      deliveryId,
      destination: "alerts",
      phase: "delivered",
      messageTs: "1785758400.000779",
      attemptCount: 2,
      functionExecutionId: "FxAttemptTwoReceipt2",
      now: NOW + 5,
      reconcileAt: NOW + 5_000,
    });

    await store.recordSlackTrace(
      {
        traceId: "TrAttemptOneLateSuccess1",
        deliveryId,
        outcome: "success",
        attemptCount: 1,
        sendExecutionId: "FxAttemptOneSendOwner1",
        sendBoundaryReached: true,
        preSendFailureProven: false,
        startedAtUs: NOW * 1_000,
        completedAtUs: NOW * 1_000 + 2,
      },
      NOW + 6,
    );

    await expect(store.get(deliveryId)).resolves.toMatchObject({
      status: "delivered",
      attemptCount: 2,
      slackTraceId: null,
      slackSendExecutionId: "FxAttemptTwoSendOwner2",
    });
    expect(
      database
        .prepare(
          "SELECT applied_at FROM slack_workflow_traces WHERE trace_id = ?",
        )
        .get("TrAttemptOneLateSuccess1"),
    ).toEqual({ applied_at: NOW + 6 });
  });

  it("converges concurrent delivered receipts with the same message timestamp", async () => {
    const { d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-delivered-race";
    await store.insert(input(deliveryId));
    await store.markQueued(deliveryId, NOW);
    await store.claimForSlack(deliveryId, NOW);
    await store.markAcceptedByTrigger(deliveryId, NOW, NOW + 1_000);
    await store.recordSlackProgress({
      deliveryId,
      destination: "alerts",
      phase: "send_started",
      messageTs: null,
      attemptCount: 1,
      functionExecutionId: SEND_EXECUTION_ID,
      now: NOW + 1,
      reconcileAt: NOW + 20 * 60 * 1_000,
    });
    const progress = {
      deliveryId,
      destination: "alerts" as const,
      phase: "delivered" as const,
      messageTs: "1785758400.000777",
      attemptCount: 1,
      functionExecutionId: DELIVERY_EXECUTION_ID,
      now: NOW + 2,
      reconcileAt: NOW + 20 * 60 * 1_000,
    };

    const outcomes = await Promise.all([
      store.recordSlackProgress(progress),
      store.recordSlackProgress(progress),
    ]);
    expect(outcomes.sort()).toEqual(["duplicate", "recorded"]);
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
      ...PRE_SEND_TRACE_ATTEMPT_ONE,
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

  it("does not reapply an unchanged terminal trace after the next attempt starts", async () => {
    const { d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-applied-trace-next-attempt";
    await store.insert(input(deliveryId));
    await store.markQueued(deliveryId, NOW);
    await store.claimForSlack(deliveryId, NOW);
    await store.markAcceptedByTrigger(deliveryId, NOW, NOW + 1_000);
    const trace = {
      traceId: "TrAppliedNextAttempt1",
      deliveryId,
      outcome: "error" as const,
      ...PRE_SEND_TRACE_ATTEMPT_ONE,
      sendBoundaryReached: false,
      preSendFailureProven: true,
      startedAtUs: NOW * 1_000,
      completedAtUs: NOW * 1_000 + 1,
    };

    await store.recordSlackTrace(trace, NOW + 1);
    await store.markQueued(deliveryId, NOW + 2);
    await store.claimForSlack(deliveryId, NOW + 3);
    await store.markAcceptedByTrigger(deliveryId, NOW + 3, NOW + 4_000);
    await store.recordSlackTrace(trace, NOW + 4);

    await expect(store.get(deliveryId)).resolves.toMatchObject({
      status: "accepted_by_trigger",
      slackTraceId: trace.traceId,
      attemptCount: 2,
    });
    await store.recordSlackProgress({
      deliveryId,
      destination: "alerts",
      phase: "send_started",
      messageTs: null,
      attemptCount: 2,
      functionExecutionId: SEND_EXECUTION_ID,
      now: NOW + 5,
      reconcileAt: NOW + 5_000,
    });
    await expect(store.get(deliveryId)).resolves.toMatchObject({
      status: "send_started",
      slackTraceId: null,
      attemptCount: 2,
    });
  });

  it("does not quarantine a later D1 attempt when an earlier trace gains a boundary", async () => {
    const { d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-late-boundary-old-attempt";
    await store.insert(input(deliveryId));
    await store.markQueued(deliveryId, NOW);
    await store.claimForSlack(deliveryId, NOW);
    await store.markAcceptedByTrigger(deliveryId, NOW, NOW + 1_000);
    const trace = {
      traceId: "TrSqliteLateBoundary1",
      deliveryId,
      outcome: "error" as const,
      ...PRE_SEND_TRACE_ATTEMPT_ONE,
      sendBoundaryReached: false,
      preSendFailureProven: true,
      startedAtUs: NOW * 1_000,
      completedAtUs: NOW * 1_000 + 1,
    };

    await store.recordSlackTrace(trace, NOW + 1);
    await store.markQueued(deliveryId, NOW + 2);
    await store.claimForSlack(deliveryId, NOW + 3);
    await store.markAcceptedByTrigger(deliveryId, NOW + 3, NOW + 4_000);
    await store.recordSlackTrace(
      {
        ...trace,
        sendBoundaryReached: true,
        preSendFailureProven: false,
      },
      NOW + 4,
    );

    await expect(store.get(deliveryId)).resolves.toMatchObject({
      status: "accepted_by_trigger",
      attemptCount: 2,
      lastError: null,
    });
  });

  it("keeps a trace resolution CAS from mutating an attempt claimed after its read", async () => {
    const { d1 } = databaseWithMigrations(true);
    const deliveryId = "sqlite-trace-resolution-attempt-race";
    const mutator = new D1DeliveryStore(d1);
    await mutator.insert(input(deliveryId));
    await mutator.markQueued(deliveryId, NOW);
    await mutator.claimForSlack(deliveryId, NOW);
    await mutator.markAcceptedByTrigger(deliveryId, NOW, NOW + 1_000);

    const barrier = pauseOnDeliveryRead(d1, 2);
    const resolver = new D1DeliveryStore(barrier.d1);
    const lateBoundary = resolver.recordSlackTrace(
      {
        traceId: "TrSqliteAttemptRaceBoundary1",
        deliveryId,
        outcome: "error",
        ...SEND_TRACE_ATTEMPT_ONE,
        sendBoundaryReached: true,
        preSendFailureProven: false,
        startedAtUs: NOW * 1_000,
        completedAtUs: NOW * 1_000 + 1,
      },
      NOW + 1,
    );
    await barrier.reached;

    await mutator.recordSlackTrace(
      {
        traceId: "TrSqliteAttemptRaceRetry1",
        deliveryId,
        outcome: "error",
        ...PRE_SEND_TRACE_ATTEMPT_ONE,
        sendBoundaryReached: false,
        preSendFailureProven: true,
        startedAtUs: NOW * 1_000,
        completedAtUs: NOW * 1_000 + 2,
      },
      NOW + 2,
    );
    await mutator.markQueued(deliveryId, NOW + 3);
    await mutator.claimForSlack(deliveryId, NOW + 4);
    await mutator.markAcceptedByTrigger(deliveryId, NOW + 4, NOW + 5_000);
    barrier.release();
    await lateBoundary;

    await expect(mutator.get(deliveryId)).resolves.toMatchObject({
      status: "accepted_by_trigger",
      attemptCount: 2,
      lastError: null,
      slackTraceId: "TrSqliteAttemptRaceRetry1",
    });
  });

  it("attaches a trace when its receipt commits after the trace read", async () => {
    const { database, d1 } = databaseWithMigrations(true);
    const deliveryId = "sqlite-trace-resolution-receipt-race";
    const mutator = new D1DeliveryStore(d1);
    await mutator.insert(input(deliveryId));
    await mutator.markQueued(deliveryId, NOW);
    await mutator.claimForSlack(deliveryId, NOW);
    await mutator.markAcceptedByTrigger(deliveryId, NOW, NOW + 1_000);
    await mutator.recordSlackProgress({
      deliveryId,
      destination: "alerts",
      phase: "send_started",
      messageTs: null,
      attemptCount: 1,
      functionExecutionId: SEND_EXECUTION_ID,
      now: NOW + 1,
      reconcileAt: NOW + 20 * 60 * 1_000,
    });

    const barrier = pauseOnDeliveryRead(d1, 2);
    const resolver = new D1DeliveryStore(barrier.d1);
    const successfulTrace = resolver.recordSlackTrace(
      {
        traceId: "TrSqliteReceiptRaceSuccess1",
        deliveryId,
        outcome: "success",
        ...SEND_TRACE_ATTEMPT_ONE,
        sendBoundaryReached: true,
        preSendFailureProven: false,
        startedAtUs: NOW * 1_000,
        completedAtUs: NOW * 1_000 + 1,
      },
      NOW + 2,
    );
    await barrier.reached;
    await mutator.recordSlackProgress({
      deliveryId,
      destination: "alerts",
      phase: "delivered",
      messageTs: "1785758400.000780",
      attemptCount: 1,
      functionExecutionId: DELIVERY_EXECUTION_ID,
      now: NOW + 3,
      reconcileAt: NOW + 20 * 60 * 1_000,
    });
    barrier.release();
    await successfulTrace;

    await expect(mutator.get(deliveryId)).resolves.toMatchObject({
      status: "delivered",
      attemptCount: 1,
      slackTraceId: "TrSqliteReceiptRaceSuccess1",
      slackSendExecutionId: SEND_EXECUTION_ID,
    });
    expect(
      database
        .prepare(
          "SELECT applied_at FROM slack_workflow_traces WHERE trace_id = ?",
        )
        .get("TrSqliteReceiptRaceSuccess1"),
    ).toEqual({ applied_at: NOW + 2 });

    await mutator.advanceSlackActivityCheckpoint(
      (NOW + 30 * 60 * 1_000) * 1_000,
    );
    await expect(mutator.purgeDeliveredBefore(NOW + 4)).resolves.toBe(1);
    await expect(mutator.get(deliveryId)).resolves.toBeNull();
  });

  it("leaves a pre-send trace unapplied until the trigger leaves sending", async () => {
    const { database, d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-sending-before-trigger-acceptance";
    await store.insert(input(deliveryId));
    await store.markQueued(deliveryId, NOW);
    await store.claimForSlack(deliveryId, NOW);
    const trace = {
      traceId: "TrSqliteSendingPreSend1",
      deliveryId,
      outcome: "error" as const,
      ...PRE_SEND_TRACE_ATTEMPT_ONE,
      sendBoundaryReached: false,
      preSendFailureProven: true,
      startedAtUs: NOW * 1_000,
      completedAtUs: NOW * 1_000 + 1,
    };

    await store.recordSlackTrace(trace, NOW + 1);
    expect(
      database
        .prepare(
          "SELECT applied_at FROM slack_workflow_traces WHERE trace_id = ?",
        )
        .get(trace.traceId),
    ).toEqual({ applied_at: null });
    await store.markAcceptedByTrigger(deliveryId, NOW + 2, NOW + 60_000);
    await store.recordSlackTrace(trace, NOW + 3);

    await expect(store.get(deliveryId)).resolves.toMatchObject({
      status: "pending",
      attemptCount: 1,
      slackTraceId: trace.traceId,
      lastError: "slack_workflow_failed_before_send_boundary",
    });
    expect(
      database
        .prepare(
          "SELECT applied_at FROM slack_workflow_traces WHERE trace_id = ?",
        )
        .get(trace.traceId),
    ).toEqual({ applied_at: NOW + 3 });
  });

  it("atomically marks a retry trace before a lost batch response", async () => {
    const { database, d1 } = databaseWithMigrations(true);
    let loseBatchResponse = true;
    const responseLostD1 = {
      prepare: d1.prepare.bind(d1),
      async batch<T = unknown>(
        statements: D1PreparedStatement[],
      ): Promise<D1Result<T>[]> {
        const results = await d1.batch<T>(statements);
        if (loseBatchResponse) {
          loseBatchResponse = false;
          throw new Error("d1_batch_response_lost");
        }
        return results;
      },
    } as unknown as D1Database;
    const store = new D1DeliveryStore(responseLostD1);
    const deliveryId = "sqlite-unmarked-trace-next-attempt";
    await store.insert(input(deliveryId));
    await store.markQueued(deliveryId, NOW);
    await store.claimForSlack(deliveryId, NOW);
    await store.markAcceptedByTrigger(deliveryId, NOW, NOW + 1_000);
    const trace = {
      traceId: "TrUnmarkedNextAttempt1",
      deliveryId,
      outcome: "error" as const,
      ...PRE_SEND_TRACE_ATTEMPT_ONE,
      sendBoundaryReached: false,
      preSendFailureProven: true,
      startedAtUs: NOW * 1_000,
      completedAtUs: NOW * 1_000 + 1,
    };

    await expect(store.recordSlackTrace(trace, NOW + 1)).rejects.toThrow(
      "d1_batch_response_lost",
    );
    expect(
      database
        .prepare(
          "SELECT applied_at FROM slack_workflow_traces WHERE trace_id = ?",
        )
        .get(trace.traceId),
    ).toEqual({ applied_at: NOW + 1 });
    await store.markQueued(deliveryId, NOW + 2);
    await store.claimForSlack(deliveryId, NOW + 3);
    await store.markAcceptedByTrigger(deliveryId, NOW + 3, NOW + 4_000);
    await store.recordSlackProgress({
      deliveryId,
      destination: "alerts",
      phase: "send_started",
      messageTs: null,
      attemptCount: 2,
      functionExecutionId: SEND_EXECUTION_ID,
      now: NOW + 4,
      reconcileAt: NOW + 5_000,
    });
    await store.recordSlackTrace(trace, NOW + 4);

    await expect(store.get(deliveryId)).resolves.toMatchObject({
      status: "send_started",
      slackTraceId: null,
      attemptCount: 2,
    });
  });

  it("keeps a successful legacy acceptance quarantined outside readiness", async () => {
    const { database, d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-legacy-success-quarantine";
    await store.insert(input(deliveryId));
    database
      .prepare(
        `UPDATE deliveries
         SET status = 'accepted_by_slack', attempt_count = 1,
             legacy_unverified = 1,
             trigger_accepted_at = ?, next_attempt_at = ?
         WHERE delivery_id = ?`,
      )
      .run(NOW, NOW + 1_000, deliveryId);

    await store.recordSlackTrace(
      {
        traceId: "TrLegacySuccess1",
        deliveryId,
        outcome: "success",
        ...TRACE_ATTEMPT_ONE,
        sendBoundaryReached: false,
        preSendFailureProven: false,
        startedAtUs: NOW * 1_000,
        completedAtUs: NOW * 1_000 + 1,
      },
      NOW + 1,
    );

    await expect(store.get(deliveryId)).resolves.toMatchObject({
      status: "accepted_by_slack",
      legacyUnverified: true,
      slackTraceId: "TrLegacySuccess1",
    });
    await store.activateSlackDeliveryProtocol(
      protocolActivation(TEST_REVISION),
    );
    await expect(store.healthcheck(NOW + 2, TEST_REVISION)).resolves.toBe(true);
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
        attemptCount: 1,
        sendExecutionId: "FxStoreSqliteBoundary1",
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
        attemptCount: 1,
        sendExecutionId: "FxStoreSqliteBoundary1",
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
        ...PRE_SEND_TRACE_ATTEMPT_ONE,
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
        ...TRACE_ATTEMPT_ONE,
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

  it("lets authenticated pre-send failure proof override a lost send-started response", async () => {
    const { d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-send-started-response-lost";
    await store.insert(input(deliveryId));
    await store.markQueued(deliveryId, NOW);
    await store.claimForSlack(deliveryId, NOW);
    await store.markAcceptedByTrigger(deliveryId, NOW, NOW + 1_000);
    await store.recordSlackProgress({
      deliveryId,
      destination: "alerts",
      phase: "send_started",
      messageTs: null,
      attemptCount: 1,
      functionExecutionId: SEND_EXECUTION_ID,
      now: NOW + 1,
      reconcileAt: NOW + 1_000,
    });

    await store.recordSlackTrace(
      {
        traceId: "TrSendStartedResponseLost1",
        deliveryId,
        outcome: "error",
        attemptCount: 1,
        sendExecutionId: SEND_EXECUTION_ID,
        sendBoundaryReached: false,
        preSendFailureProven: true,
        startedAtUs: NOW * 1_000,
        completedAtUs: NOW * 1_000 + 1,
      },
      NOW + 2,
    );

    await expect(store.get(deliveryId)).resolves.toMatchObject({
      status: "pending",
      lastError: "slack_workflow_failed_before_send_boundary",
      slackTraceId: "TrSendStartedResponseLost1",
    });
  });

  it("merges late send-boundary evidence after a terminal trace was applied", async () => {
    const { d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-late-boundary-after-apply";
    await store.insert(input(deliveryId));
    await store.markQueued(deliveryId, NOW);
    await store.claimForSlack(deliveryId, NOW);
    await store.markAcceptedByTrigger(deliveryId, NOW, NOW + 1_000);
    const base = {
      traceId: "TrLateBoundary1",
      deliveryId,
      outcome: "error" as const,
      ...PRE_SEND_TRACE_ATTEMPT_ONE,
      startedAtUs: NOW * 1_000,
      completedAtUs: NOW * 1_000 + 1,
    };

    await store.recordSlackTrace(
      {
        ...base,
        sendBoundaryReached: false,
        preSendFailureProven: true,
      },
      NOW + 1,
    );
    await expect(store.get(deliveryId)).resolves.toMatchObject({
      status: "pending",
      slackTraceId: base.traceId,
    });

    await store.recordSlackTrace(
      {
        ...base,
        sendBoundaryReached: true,
        preSendFailureProven: false,
      },
      NOW + 2,
    );
    await expect(store.get(deliveryId)).resolves.toMatchObject({
      status: "manual_review",
      lastError: "slack_workflow_failed_after_send_boundary",
      slackTraceId: base.traceId,
    });
  });

  it("retains delivered rows until their Slack trace is correlated", async () => {
    const { d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-delivered-without-trace";
    await store.insert(input(deliveryId));
    await store.markQueued(deliveryId, NOW);
    await store.claimForSlack(deliveryId, NOW);
    await store.markAcceptedByTrigger(deliveryId, NOW, NOW + 1_000);
    await store.recordSlackProgress({
      deliveryId,
      destination: "alerts",
      phase: "send_started",
      messageTs: null,
      attemptCount: 1,
      functionExecutionId: SEND_EXECUTION_ID,
      now: NOW + 1,
      reconcileAt: NOW + 1_000,
    });
    await store.recordSlackProgress({
      deliveryId,
      destination: "alerts",
      phase: "delivered",
      messageTs: "1785758400.000888",
      attemptCount: 1,
      functionExecutionId: DELIVERY_EXECUTION_ID,
      now: NOW + 2,
      reconcileAt: NOW + 1_000,
    });

    await expect(store.purgeDeliveredBefore(NOW + 3)).resolves.toBe(0);
    await expect(store.get(deliveryId)).resolves.toMatchObject({
      status: "delivered",
      slackTraceId: null,
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
      phase: "send_started",
      messageTs: null,
      attemptCount: 1,
      functionExecutionId: SEND_EXECUTION_ID,
      now: NOW + 1,
      reconcileAt: NOW + 1_000,
    });
    await store.recordSlackProgress({
      deliveryId,
      destination: "alerts",
      phase: "delivered",
      messageTs: "1785758400.000099",
      attemptCount: 1,
      functionExecutionId: DELIVERY_EXECUTION_ID,
      now: NOW + 2,
      reconcileAt: NOW + 1_000,
    });
    await store.recordSlackTrace(
      {
        traceId: "TrRetention1",
        deliveryId,
        outcome: "success",
        ...SEND_TRACE_ATTEMPT_ONE,
        sendBoundaryReached: true,
        preSendFailureProven: false,
        startedAtUs: NOW * 1_000,
        completedAtUs: NOW * 1_000 + 1,
      },
      NOW + 2,
    );
    database
      .prepare(
        `UPDATE relay_state
         SET slack_activity_checkpoint_us = ?
         WHERE singleton_id = 1`,
      )
      .run(NOW * 1_000 + 20 * 60 * 1_000 * 1_000 + 2);

    await expect(store.purgeDeliveredBefore(NOW + 3)).resolves.toBe(1);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM deliveries").get(),
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM slack_workflow_traces")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("purges a delivered row after a lost receipt response produces a boundary error trace", async () => {
    const { database, d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-delivered-lost-receipt-response";
    await store.insert(input(deliveryId));
    await store.markQueued(deliveryId, NOW);
    await store.claimForSlack(deliveryId, NOW);
    await store.markAcceptedByTrigger(deliveryId, NOW, NOW + 1_000);
    await store.recordSlackProgress({
      deliveryId,
      destination: "alerts",
      phase: "send_started",
      messageTs: null,
      attemptCount: 1,
      functionExecutionId: SEND_EXECUTION_ID,
      now: NOW + 1,
      reconcileAt: NOW + 1_000,
    });
    await store.recordSlackProgress({
      deliveryId,
      destination: "alerts",
      phase: "delivered",
      messageTs: "1785758400.000299",
      attemptCount: 1,
      functionExecutionId: DELIVERY_EXECUTION_ID,
      now: NOW + 2,
      reconcileAt: NOW + 1_000,
    });
    await store.recordSlackTrace(
      {
        traceId: "TrLostReceiptResponse1",
        deliveryId,
        outcome: "error",
        ...SEND_TRACE_ATTEMPT_ONE,
        sendBoundaryReached: true,
        preSendFailureProven: false,
        startedAtUs: NOW * 1_000,
        completedAtUs: NOW * 1_000 + 1,
      },
      NOW + 2,
    );
    database
      .prepare(
        `UPDATE relay_state
         SET slack_activity_checkpoint_us = ?
         WHERE singleton_id = 1`,
      )
      .run(NOW * 1_000 + 20 * 60 * 1_000 * 1_000 + 2);

    await expect(store.purgeDeliveredBefore(NOW + 3)).resolves.toBe(1);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM deliveries").get(),
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM slack_workflow_traces")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("retains a delivered row whose trace is still inside checkpoint overlap", async () => {
    const { database, d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-delivered-checkpoint-overlap";
    await store.insert(input(deliveryId));
    await store.markQueued(deliveryId, NOW);
    await store.claimForSlack(deliveryId, NOW);
    await store.markAcceptedByTrigger(deliveryId, NOW, NOW + 1_000);
    await store.recordSlackProgress({
      deliveryId,
      destination: "alerts",
      phase: "send_started",
      messageTs: null,
      attemptCount: 1,
      functionExecutionId: SEND_EXECUTION_ID,
      now: NOW + 1,
      reconcileAt: NOW + 1_000,
    });
    await store.recordSlackProgress({
      deliveryId,
      destination: "alerts",
      phase: "delivered",
      messageTs: "1785758400.000199",
      attemptCount: 1,
      functionExecutionId: DELIVERY_EXECUTION_ID,
      now: NOW + 2,
      reconcileAt: NOW + 1_000,
    });
    await store.recordSlackTrace(
      {
        traceId: "TrRetentionOverlap1",
        deliveryId,
        outcome: "success",
        ...SEND_TRACE_ATTEMPT_ONE,
        sendBoundaryReached: true,
        preSendFailureProven: false,
        startedAtUs: NOW * 1_000,
        completedAtUs: NOW * 1_000 + 1,
      },
      NOW + 2,
    );
    database
      .prepare(
        `UPDATE relay_state
         SET slack_activity_checkpoint_us = ?
         WHERE singleton_id = 1`,
      )
      .run(NOW * 1_000 + 20 * 60 * 1_000 * 1_000);

    await expect(store.purgeDeliveredBefore(NOW + 3)).resolves.toBe(0);
    await expect(store.get(deliveryId)).resolves.toMatchObject({
      status: "delivered",
      slackTraceId: "TrRetentionOverlap1",
    });
  });

  it("retries a trigger ambiguity only after complete pre-send trace proof", async () => {
    const { d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-trigger-ambiguity";
    await store.insert(input(deliveryId));
    await store.markQueued(deliveryId, NOW);
    await store.claimForSlack(deliveryId, NOW);
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
        ...PRE_SEND_TRACE_ATTEMPT_ONE,
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
        ...TRACE_ATTEMPT_ONE,
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

  it("releases only the same missing-proof trace when pre-send proof arrives late", async () => {
    const { d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-late-pre-send-proof";
    await store.insert(input(deliveryId));
    await store.markQueued(deliveryId, NOW);
    await store.claimForSlack(deliveryId, NOW);
    await store.markAcceptedByTrigger(deliveryId, NOW, NOW + 1_000);
    const base = {
      traceId: "TrLatePreSendProof1",
      deliveryId,
      outcome: "error" as const,
      ...TRACE_ATTEMPT_ONE,
      sendBoundaryReached: false,
      startedAtUs: NOW * 1_000 - 1,
      completedAtUs: NOW * 1_000,
    };

    await store.recordSlackTrace(
      { ...base, preSendFailureProven: false },
      NOW + 1,
    );
    await expect(store.get(deliveryId)).resolves.toMatchObject({
      status: "manual_review",
      lastError: "slack_workflow_failed_without_pre_send_proof",
      slackTraceId: base.traceId,
    });

    await store.recordSlackTrace(
      {
        ...base,
        ...PRE_SEND_TRACE_ATTEMPT_ONE,
        preSendFailureProven: true,
      },
      NOW + 2,
    );
    await expect(store.get(deliveryId)).resolves.toMatchObject({
      status: "pending",
      lastError: "slack_workflow_failed_before_send_boundary",
      slackTraceId: base.traceId,
    });
  });

  it("reapplies late proof after its first resolution batch fails", async () => {
    const { database, d1 } = databaseWithMigrations(true);
    const injected = failNextTraceResolutionBatch(d1);
    const store = new D1DeliveryStore(injected.d1);
    const deliveryId = "sqlite-late-proof-resolution-retry";
    await store.insert(input(deliveryId));
    await store.markQueued(deliveryId, NOW);
    await store.claimForSlack(deliveryId, NOW);
    await store.markAcceptedByTrigger(deliveryId, NOW, NOW + 1_000);
    const base = {
      traceId: "TrLateProofResolutionRetry1",
      deliveryId,
      outcome: "error" as const,
      ...TRACE_ATTEMPT_ONE,
      sendBoundaryReached: false,
      startedAtUs: NOW * 1_000 - 1,
      completedAtUs: NOW * 1_000,
    };

    await store.recordSlackTrace(
      { ...base, preSendFailureProven: false },
      NOW + 1,
    );
    injected.arm();
    await expect(
      store.recordSlackTrace(
        {
          ...base,
          ...PRE_SEND_TRACE_ATTEMPT_ONE,
          preSendFailureProven: true,
        },
        NOW + 2,
      ),
    ).rejects.toThrow("injected_trace_resolution_failure");
    expect(
      database
        .prepare(
          "SELECT applied_at FROM slack_workflow_traces WHERE trace_id = ?",
        )
        .get(base.traceId),
    ).toEqual({ applied_at: null });

    await store.recordSlackTrace(
      {
        ...base,
        ...PRE_SEND_TRACE_ATTEMPT_ONE,
        preSendFailureProven: true,
      },
      NOW + 3,
    );
    await expect(store.get(deliveryId)).resolves.toMatchObject({
      status: "pending",
      lastError: "slack_workflow_failed_before_send_boundary",
      slackTraceId: base.traceId,
    });
  });

  it("does not release a missing-proof quarantine from an unrelated trace", async () => {
    const { d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-unrelated-pre-send-proof";
    await store.insert(input(deliveryId));
    await store.markQueued(deliveryId, NOW);
    await store.claimForSlack(deliveryId, NOW);
    await store.markAcceptedByTrigger(deliveryId, NOW, NOW + 1_000);

    await store.recordSlackTrace(
      {
        traceId: "TrMissingProofOriginal1",
        deliveryId,
        outcome: "error",
        ...TRACE_ATTEMPT_ONE,
        sendBoundaryReached: false,
        preSendFailureProven: false,
        startedAtUs: NOW * 1_000 - 1,
        completedAtUs: NOW * 1_000,
      },
      NOW + 1,
    );
    await store.recordSlackTrace(
      {
        traceId: "TrUnrelatedProof1",
        deliveryId,
        outcome: "error",
        ...PRE_SEND_TRACE_ATTEMPT_ONE,
        sendBoundaryReached: false,
        preSendFailureProven: true,
        startedAtUs: NOW * 1_000 - 1,
        completedAtUs: NOW * 1_000,
      },
      NOW + 2,
    );

    await expect(store.get(deliveryId)).resolves.toMatchObject({
      status: "manual_review",
      lastError: "slack_workflow_failed_without_pre_send_proof",
      slackTraceId: "TrMissingProofOriginal1",
    });
  });
});
