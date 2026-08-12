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
const RECONCILIATION_RETRY_DELAY_MS = 20 * 60 * 1_000;
const TEST_REVISION = "a".repeat(40);
const SEND_EXECUTION_ID = "FxStoreSqliteSend1";
const DELIVERY_EXECUTION_ID = "FxStoreSqliteDelivery1";
const TRACE_ATTEMPT_ONE = Object.freeze({
  attemptCount: 1,
  sendExecutionId: null,
  destination: null,
  slackChannelId: null,
  messageTs: null,
});
const PRE_SEND_TRACE_ATTEMPT_ONE = Object.freeze({
  attemptCount: 1,
  sendExecutionId: "FxStoreSqliteTraceProof1",
  destination: null,
  slackChannelId: null,
  messageTs: null,
});
const SEND_TRACE_ATTEMPT_ONE = Object.freeze({
  attemptCount: 1,
  sendExecutionId: SEND_EXECUTION_ID,
  destination: null,
  slackChannelId: null,
  messageTs: null,
});
const openDatabases: DatabaseSync[] = [];

function protocolActivation(revision: string, activationId = "3".repeat(64)) {
  return {
    activationId,
    bridgeSourceActivationId: "2".repeat(64),
    revision,
    schemaRevision: "0005_reconcile_live_slack_receipts",
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
      "0005_reconcile_live_slack_receipts.sql",
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

function pauseOnTraceRead(d1: D1Database): {
  d1: D1Database;
  reached: Promise<void>;
  release: () => void;
} {
  let resolveReached: () => void = () => undefined;
  let resolveRelease: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    resolveReached = resolve;
  });
  const released = new Promise<void>((resolve) => {
    resolveRelease = resolve;
  });
  let pausedOnce = false;
  return {
    d1: {
      prepare(query: string): D1PreparedStatement {
        const statement = d1.prepare(query);
        if (
          pausedOnce ||
          !query.includes("FROM slack_workflow_traces") ||
          !query.includes("SELECT delivery_id, outcome")
        ) {
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
            pausedOnce = true;
            resolveReached();
            await released;
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

function pauseBeforeFirstBatch(d1: D1Database): {
  d1: D1Database;
  reached: Promise<void>;
  release: () => void;
} {
  let resolveReached: () => void = () => undefined;
  let resolveRelease: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    resolveReached = resolve;
  });
  const released = new Promise<void>((resolve) => {
    resolveRelease = resolve;
  });
  let paused = false;
  return {
    d1: {
      prepare: d1.prepare.bind(d1),
      async batch<T = unknown>(
        statements: D1PreparedStatement[],
      ): Promise<D1Result<T>[]> {
        if (!paused) {
          paused = true;
          resolveReached();
          await released;
        }
        return d1.batch<T>(statements);
      },
    } as unknown as D1Database,
    reached,
    release: resolveRelease,
  };
}

function missFirstMessageOwnerRead(d1: D1Database): {
  d1: D1Database;
  missed: () => boolean;
} {
  let missed = false;
  return {
    d1: {
      prepare(query: string): D1PreparedStatement {
        const statement = d1.prepare(query);
        if (
          missed ||
          !query.includes("WHERE slack_channel_id = ? AND slack_message_ts = ?")
        ) {
          return statement;
        }
        let bound = statement;
        const staleRead = {
          bind(...values: unknown[]): D1PreparedStatement {
            bound = statement.bind(...values);
            return staleRead as unknown as D1PreparedStatement;
          },
          first: bound.first.bind(bound),
          run: bound.run.bind(bound),
          async all<T = unknown>(): Promise<D1Result<T>> {
            if (!missed) {
              missed = true;
              return d1Result(0, []) as D1Result<T>;
            }
            return bound.all<T>();
          },
        };
        return staleRead as unknown as D1PreparedStatement;
      },
      batch: d1.batch.bind(d1),
    } as unknown as D1Database,
    missed: () => missed,
  };
}

function missFirstDeliveryMessageOwnerRead(d1: D1Database): {
  d1: D1Database;
  missed: () => boolean;
} {
  let missed = false;
  return {
    d1: {
      prepare(query: string): D1PreparedStatement {
        const statement = d1.prepare(query);
        if (
          missed ||
          !query.includes("SELECT delivery_id") ||
          !query.includes("FROM deliveries") ||
          !query.includes("WHERE destination = ? AND slack_message_ts = ?") ||
          !query.includes("LIMIT 2")
        ) {
          return statement;
        }
        let bound = statement;
        const staleRead = {
          bind(...values: unknown[]): D1PreparedStatement {
            bound = statement.bind(...values);
            return staleRead as unknown as D1PreparedStatement;
          },
          first: bound.first.bind(bound),
          run: bound.run.bind(bound),
          async all<T = unknown>(): Promise<D1Result<T>> {
            if (!missed) {
              missed = true;
              return d1Result(0, []) as D1Result<T>;
            }
            return bound.all<T>();
          },
        };
        return staleRead as unknown as D1PreparedStatement;
      },
      batch: d1.batch.bind(d1),
    } as unknown as D1Database,
    missed: () => missed,
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
  it("binds each Slack function execution to one trace while allowing absent execution IDs", async () => {
    const { database, d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);
    for (const deliveryId of ["trace-fx-owner-a", "trace-fx-owner-b"]) {
      await store.insert(input(deliveryId));
    }
    const insertTrace = database.prepare(
      `INSERT INTO slack_workflow_traces (
         trace_id, delivery_id, outcome, relay_attempt, send_execution_id,
         send_boundary_reached, pre_send_failure_proven, started_at_us,
         completed_at_us, updated_at, applied_at
       ) VALUES (?, ?, 'pending', 1, ?, 0, 0, ?, NULL, ?, NULL)`,
    );

    expect(() =>
      insertTrace.run(
        "TrMissingFxA1",
        "trace-fx-owner-a",
        null,
        NOW * 1_000,
        NOW,
      ),
    ).not.toThrow();
    expect(() =>
      insertTrace.run(
        "TrMissingFxB1",
        "trace-fx-owner-b",
        null,
        NOW * 1_000,
        NOW,
      ),
    ).not.toThrow();
    expect(() =>
      insertTrace.run(
        "TrUniqueFxA1",
        "trace-fx-owner-a",
        "FxUniqueTraceOwner1",
        NOW * 1_000,
        NOW,
      ),
    ).not.toThrow();
    expect(() =>
      insertTrace.run(
        "TrUniqueFxB1",
        "trace-fx-owner-b",
        "FxUniqueTraceOwner1",
        NOW * 1_000,
        NOW,
      ),
    ).toThrow(/UNIQUE constraint failed/u);
  });

  it("keeps the expand migration compatible with Wrangler's local splitter", () => {
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

  it("bridges the exact deployed source once through the D1 store CAS", async () => {
    const { database, d1 } = databaseWithMigrations(false);
    for (const migration of [
      "0001_initial.sql",
      "0002_add_destination.sql",
      "0003_rename_delivery_acceptance.sql",
      "0004_confirm_slack_delivery.sql",
    ]) {
      database.exec(migrationSource(migration));
    }
    const sourceRevision = "afe5250504d37543845b07f44af7bfc30a548feb";
    const sourceActivationId = "2".repeat(64);
    database
      .prepare(
        `UPDATE relay_state
         SET slack_delivery_protocol_active = 1,
             slack_delivery_protocol_revision = ?,
             slack_delivery_protocol_activated_at = ?,
             slack_delivery_protocol_activation_id = ?,
             slack_delivery_protocol_schema_revision = ?
         WHERE singleton_id = 1`,
      )
      .run(
        sourceRevision,
        NOW - 1_000,
        sourceActivationId,
        "0004_confirm_slack_delivery",
      );
    database.exec(migrationSource("0005_reconcile_live_slack_receipts.sql"));
    const store = new D1DeliveryStore(d1);

    await expect(
      store.activateSlackDeliveryProtocol({
        activationId: sourceActivationId,
        bridgeSourceActivationId: sourceActivationId,
        revision: sourceRevision,
        schemaRevision: "0004_confirm_slack_delivery",
        now: NOW,
      }),
    ).resolves.toBe("already_applied");

    const target = protocolActivation("d".repeat(40), "4".repeat(64));
    await expect(
      store.activateSlackDeliveryProtocol({
        ...target,
        bridgeSourceActivationId: "5".repeat(64),
      }),
    ).rejects.toThrow("slack_delivery_protocol_activation_conflict");
    await expect(
      store.isSlackDeliveryProtocolActive(sourceRevision),
    ).resolves.toBe(false);

    await expect(
      store.activateSlackDeliveryProtocol({
        ...target,
        bridgeSourceActivationId: sourceActivationId,
      }),
    ).resolves.toBe("applied");
    const activatedState = database
      .prepare(
        `SELECT slack_delivery_protocol_revision,
                slack_delivery_protocol_schema_revision
         FROM relay_state WHERE singleton_id = 1`,
      )
      .get();
    expect(activatedState).toEqual({
      slack_delivery_protocol_revision: "d".repeat(40),
      slack_delivery_protocol_schema_revision:
        "0005_reconcile_live_slack_receipts",
    });
    await expect(
      store.activateSlackDeliveryProtocol({
        ...target,
        bridgeSourceActivationId: sourceActivationId,
      }),
    ).resolves.toBe("already_applied");
    await expect(
      store.activateSlackDeliveryProtocol({
        ...protocolActivation("e".repeat(40), "6".repeat(64)),
        bridgeSourceActivationId: sourceActivationId,
      }),
    ).rejects.toThrow("slack_delivery_protocol_activation_conflict");
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
    database.exec(migrationSource("0005_reconcile_live_slack_receipts.sql"));
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

    // The repaired Worker is deployed only after the next migration has
    // upgraded the production schema.
    database.exec(migrationSource("0005_reconcile_live_slack_receipts.sql"));

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
      functionExecutionId: "FxStoreSqliteSend2",
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

    const secondAttemptAt = NOW + RECONCILIATION_RETRY_DELAY_MS + 3;
    await store.markQueued(deliveryId, NOW + 4);
    await store.claimForSlack(deliveryId, secondAttemptAt);
    await store.markAcceptedByTrigger(
      deliveryId,
      secondAttemptAt + 1,
      NOW + 20 * 60 * 1_000,
    );
    await expect(
      store.advanceSlackActivityCheckpoint((NOW + 60 * 60 * 1_000) * 1_000),
    ).resolves.toBe((secondAttemptAt + 1) * 1_000);
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
      functionExecutionId: "FxStoreSqliteSend2",
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

  it("resolves live Activities evidence through the unique send boundary", async () => {
    const { database, d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-live-activities-receipt";
    await store.insert(input(deliveryId));
    await store.markQueued(deliveryId, NOW);
    await store.claimForSlack(deliveryId, NOW);
    await store.markAcceptedByTrigger(deliveryId, NOW, NOW + 20 * 60 * 1_000);
    await store.recordSlackProgress({
      deliveryId,
      destination: "alerts",
      phase: "send_started",
      messageTs: null,
      attemptCount: 1,
      functionExecutionId: "Fx0BPVFG8ARF",
      now: NOW + 1,
      reconcileAt: NOW + 20 * 60 * 1_000,
    });

    await expect(
      store.resolveSlackTraceIdentityBySendExecutionId("Fx0BPVFG8ARF"),
    ).resolves.toEqual({
      deliveryId,
      destination: "alerts",
      attemptCount: 1,
    });
    await store.recordSlackTrace(
      {
        traceId: "Tr0BPPV04R45",
        deliveryId,
        destination: "alerts",
        outcome: "error",
        attemptCount: 1,
        sendExecutionId: "Fx0BPVFG8ARF",
        slackChannelId: "C0BMUK793NV",
        messageTs: "1786555894.853909",
        sendBoundaryReached: true,
        preSendFailureProven: false,
        startedAtUs: NOW * 1_000,
        completedAtUs: NOW * 1_000 + 1,
      },
      NOW + 2,
    );

    await expect(store.get(deliveryId)).resolves.toMatchObject({
      status: "delivered",
      slackMessageTs: "1786555894.853909",
      slackTraceId: "Tr0BPPV04R45",
      slackSendExecutionId: "Fx0BPVFG8ARF",
      lastError: null,
    });
    expect(
      database
        .prepare(
          `SELECT slack_channel_id, slack_message_ts, applied_at
           FROM slack_workflow_traces WHERE trace_id = ?`,
        )
        .get("Tr0BPPV04R45"),
    ).toEqual({
      slack_channel_id: "C0BMUK793NV",
      slack_message_ts: "1786555894.853909",
      applied_at: NOW + 2,
    });
  });

  it("rejects live Activities evidence that conflicts with a direct receipt", async () => {
    const { database, d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-live-activities-conflicting-receipt";
    await store.insert(input(deliveryId));
    await store.markQueued(deliveryId, NOW);
    await store.claimForSlack(deliveryId, NOW);
    await store.markAcceptedByTrigger(deliveryId, NOW, NOW + 20 * 60 * 1_000);
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
    await store.recordSlackProgress({
      deliveryId,
      destination: "alerts",
      phase: "delivered",
      messageTs: "1785758400.000901",
      attemptCount: 1,
      functionExecutionId: DELIVERY_EXECUTION_ID,
      now: NOW + 2,
      reconcileAt: NOW + 20 * 60 * 1_000,
    });

    await expect(
      store.recordSlackTrace(
        {
          traceId: "TrConflictingLiveReceipt1",
          deliveryId,
          outcome: "error",
          ...SEND_TRACE_ATTEMPT_ONE,
          destination: "alerts",
          slackChannelId: "C0BMUK793NV",
          messageTs: "1785758400.000902",
          sendBoundaryReached: true,
          preSendFailureProven: false,
          startedAtUs: NOW * 1_000,
          completedAtUs: NOW * 1_000 + 1,
        },
        NOW + 3,
      ),
    ).rejects.toThrow("slack_trace_message_resolution_conflict");
    await expect(store.get(deliveryId)).resolves.toMatchObject({
      status: "delivered",
      slackMessageTs: "1785758400.000901",
      slackTraceId: null,
    });
    expect(
      database
        .prepare(
          "SELECT applied_at FROM slack_workflow_traces WHERE trace_id = ?",
        )
        .get("TrConflictingLiveReceipt1"),
    ).toEqual({ applied_at: null });
  });

  it("attaches matching live Activities evidence after a direct receipt", async () => {
    const { database, d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-live-activities-matching-receipt";
    await store.insert(input(deliveryId));
    await store.markQueued(deliveryId, NOW);
    await store.claimForSlack(deliveryId, NOW);
    await store.markAcceptedByTrigger(deliveryId, NOW, NOW + 20 * 60 * 1_000);
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
    await store.recordSlackProgress({
      deliveryId,
      destination: "alerts",
      phase: "delivered",
      messageTs: "1785758400.000903",
      attemptCount: 1,
      functionExecutionId: DELIVERY_EXECUTION_ID,
      now: NOW + 2,
      reconcileAt: NOW + 20 * 60 * 1_000,
    });
    await store.recordSlackTrace(
      {
        traceId: "TrMatchingLiveReceipt1",
        deliveryId,
        outcome: "error",
        ...SEND_TRACE_ATTEMPT_ONE,
        destination: "alerts",
        slackChannelId: "C0BMUK793NV",
        messageTs: "1785758400.000903",
        sendBoundaryReached: true,
        preSendFailureProven: false,
        startedAtUs: NOW * 1_000,
        completedAtUs: NOW * 1_000 + 1,
      },
      NOW + 3,
    );

    await expect(store.get(deliveryId)).resolves.toMatchObject({
      status: "delivered",
      slackMessageTs: "1785758400.000903",
      slackTraceId: "TrMatchingLiveReceipt1",
    });
    expect(
      database
        .prepare(
          "SELECT applied_at FROM slack_workflow_traces WHERE trace_id = ?",
        )
        .get("TrMatchingLiveReceipt1"),
    ).toEqual({ applied_at: NOW + 3 });
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

  it("leases a send boundary to one Slack function and never retries stale pre-send evidence", async () => {
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
        destination: null,
        slackChannelId: null,
        messageTs: null,
        sendBoundaryReached: false,
        preSendFailureProven: true,
        startedAtUs: NOW * 1_000,
        completedAtUs: NOW * 1_000 + 1,
      },
      NOW + 2,
    );
    const secondAttemptAt = NOW + RECONCILIATION_RETRY_DELAY_MS + 2;
    await store.markQueued(deliveryId, NOW + 3);
    await expect(store.claimForSlack(deliveryId, secondAttemptAt)).resolves.toBeNull();
    await expect(store.get(deliveryId)).resolves.toMatchObject({
      status: "manual_review",
      attemptCount: 1,
      slackSendExecutionId: "FxSendLeaseFirst1",
      lastError: "slack_workflow_failed_after_send_boundary",
    });
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
        destination: null,
        slackChannelId: null,
        messageTs: null,
        sendBoundaryReached: false,
        preSendFailureProven: true,
        startedAtUs: NOW * 1_000,
        completedAtUs: NOW * 1_000 + 1,
      },
      NOW + 1,
    );
    const secondAttemptAt = NOW + RECONCILIATION_RETRY_DELAY_MS + 1;
    await store.markQueued(deliveryId, NOW + 2);
    await store.claimForSlack(deliveryId, secondAttemptAt);
    await store.markAcceptedByTrigger(
      deliveryId,
      secondAttemptAt,
      secondAttemptAt + 1_000,
    );
    await store.recordSlackProgress({
      deliveryId,
      destination: "alerts",
      phase: "send_started",
      messageTs: null,
      attemptCount: 2,
      functionExecutionId: "FxAttemptTwoSendOwner2",
      now: secondAttemptAt + 1,
      reconcileAt: secondAttemptAt + 2_000,
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
        destination: null,
        slackChannelId: null,
        messageTs: null,
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

    await expect(store.recordSlackTrace(trace, NOW + 1)).resolves.toBe(
      "changed",
    );
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
    const secondAttemptAt = NOW + RECONCILIATION_RETRY_DELAY_MS + 1;
    await store.markQueued(deliveryId, NOW + 2);
    await store.claimForSlack(deliveryId, secondAttemptAt);
    await store.markAcceptedByTrigger(
      deliveryId,
      secondAttemptAt,
      secondAttemptAt + 1_000,
    );
    await store.recordSlackTrace(trace, secondAttemptAt + 1);

    await expect(store.get(deliveryId)).resolves.toMatchObject({
      status: "accepted_by_trigger",
      slackTraceId: null,
      attemptCount: 2,
    });
    await store.recordSlackProgress({
      deliveryId,
      destination: "alerts",
      phase: "send_started",
      messageTs: null,
      attemptCount: 2,
      functionExecutionId: SEND_EXECUTION_ID,
      now: secondAttemptAt + 2,
      reconcileAt: secondAttemptAt + 2_000,
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
    const secondAttemptAt = NOW + RECONCILIATION_RETRY_DELAY_MS + 1;
    await store.markQueued(deliveryId, NOW + 2);
    await store.claimForSlack(deliveryId, secondAttemptAt);
    await store.markAcceptedByTrigger(
      deliveryId,
      secondAttemptAt,
      secondAttemptAt + 1_000,
    );
    await expect(
      store.recordSlackTrace(
        {
          ...trace,
          sendBoundaryReached: true,
          preSendFailureProven: false,
        },
        secondAttemptAt + 1,
      ),
    ).resolves.toBe("duplicate");

    await expect(store.get(deliveryId)).resolves.toMatchObject({
      status: "accepted_by_trigger",
      attemptCount: 2,
      lastError: null,
    });
  });

  it("blocks a later attempt while positive boundary resolution is pending", async () => {
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
    const secondAttemptAt = NOW + RECONCILIATION_RETRY_DELAY_MS + 2;
    await mutator.markQueued(deliveryId, NOW + 3);
    await expect(
      mutator.claimForSlack(deliveryId, secondAttemptAt),
    ).resolves.toBeNull();
    barrier.release();
    await lateBoundary;

    await expect(mutator.get(deliveryId)).resolves.toMatchObject({
      status: "manual_review",
      attemptCount: 1,
      lastError: "slack_workflow_failed_after_send_boundary",
      slackTraceId: "TrSqliteAttemptRaceBoundary1",
    });
  });

  it("never lets a stale pre-send claim override a persisted send boundary", async () => {
    const { d1 } = databaseWithMigrations(true);
    const deliveryId = "sqlite-persisted-boundary-dominates";
    const store = new D1DeliveryStore(d1);
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
      reconcileAt: NOW + RECONCILIATION_RETRY_DELAY_MS,
    });

    await expect(
      store.recordSlackTrace(
        {
          traceId: "TrSqlitePersistedBoundaryDominates1",
          deliveryId,
          outcome: "error",
          ...SEND_TRACE_ATTEMPT_ONE,
          sendBoundaryReached: false,
          preSendFailureProven: true,
          startedAtUs: NOW * 1_000,
          completedAtUs: NOW * 1_000 + 1,
        },
        NOW + 2,
      ),
    ).resolves.toBe("changed");

    await expect(store.get(deliveryId)).resolves.toMatchObject({
      status: "manual_review",
      attemptCount: 1,
      slackSendExecutionId: SEND_EXECUTION_ID,
      lastError: "slack_workflow_failed_after_send_boundary",
    });
  });

  it("never lets a stale pre-send CAS race a persisted send boundary", async () => {
    const { d1 } = databaseWithMigrations(true);
    const deliveryId = "sqlite-pre-send-send-started-cas-race";
    const mutator = new D1DeliveryStore(d1);
    await mutator.insert(input(deliveryId));
    await mutator.markQueued(deliveryId, NOW);
    await mutator.claimForSlack(deliveryId, NOW);
    await mutator.markAcceptedByTrigger(deliveryId, NOW, NOW + 1_000);

    const barrier = pauseOnDeliveryRead(d1, 2);
    const resolver = new D1DeliveryStore(barrier.d1);
    const stalePreSendTrace = resolver.recordSlackTrace(
      {
        traceId: "TrSqlitePreSendSendStartedCasRace1",
        deliveryId,
        outcome: "error",
        ...SEND_TRACE_ATTEMPT_ONE,
        sendBoundaryReached: false,
        preSendFailureProven: true,
        startedAtUs: NOW * 1_000,
        completedAtUs: NOW * 1_000 + 1,
      },
      NOW + 2,
    );
    await barrier.reached;

    await mutator.recordSlackProgress({
      deliveryId,
      destination: "alerts",
      phase: "send_started",
      messageTs: null,
      attemptCount: 1,
      functionExecutionId: SEND_EXECUTION_ID,
      now: NOW + 1,
      reconcileAt: NOW + RECONCILIATION_RETRY_DELAY_MS,
    });
    barrier.release();
    await expect(stalePreSendTrace).resolves.toBe("changed");

    await expect(mutator.get(deliveryId)).resolves.toMatchObject({
      status: "manual_review",
      attemptCount: 1,
      slackSendExecutionId: SEND_EXECUTION_ID,
      lastError: "slack_workflow_failed_after_send_boundary",
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

  it("reconciles pre-send proof after a sending failure returns to pending", async () => {
    const { database, d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-pre-send-before-sending-failure";
    await store.insert(input(deliveryId));
    await store.markQueued(deliveryId, NOW);
    await store.claimForSlack(deliveryId, NOW);
    const trace = {
      traceId: "TrPreSendBeforeSendingFailure1",
      deliveryId,
      outcome: "error" as const,
      attemptCount: 1,
      sendExecutionId: "FxPreSendBeforeFailure1",
      destination: null,
      slackChannelId: null,
      messageTs: null,
      sendBoundaryReached: false,
      preSendFailureProven: true,
      startedAtUs: NOW * 1_000,
      completedAtUs: NOW * 1_000 + 1,
    };

    await expect(store.recordSlackTrace(trace, NOW + 1)).resolves.toBe(
      "changed",
    );
    expect(
      database
        .prepare(
          "SELECT applied_at FROM slack_workflow_traces WHERE trace_id = ?",
        )
        .get(trace.traceId),
    ).toEqual({ applied_at: null });
    await store.recordFailure(
      deliveryId,
      NOW + 2,
      NOW + 3,
      "pre_trigger_failure",
    );
    await expect(store.claimForSlack(deliveryId, NOW + 3)).resolves.toBeNull();
    await expect(store.recordSlackTrace(trace, NOW + 4)).resolves.toBe(
      "duplicate",
    );

    const retryAt = NOW + 4 + RECONCILIATION_RETRY_DELAY_MS;
    await expect(store.get(deliveryId)).resolves.toMatchObject({
      status: "pending",
      attemptCount: 1,
      nextAttemptAt: retryAt,
      slackTraceId: trace.traceId,
      slackSendExecutionId: trace.sendExecutionId,
      lastError: "slack_workflow_failed_before_send_boundary",
    });
    expect(
      database
        .prepare(
          "SELECT applied_at FROM slack_workflow_traces WHERE trace_id = ?",
        )
        .get(trace.traceId),
    ).toEqual({ applied_at: NOW + 4 });
    await expect(
      store.claimForSlack(deliveryId, retryAt),
    ).resolves.toMatchObject({
      status: "sending",
      attemptCount: 2,
      slackTraceId: null,
      slackSendExecutionId: null,
    });
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
    const secondAttemptAt = NOW + RECONCILIATION_RETRY_DELAY_MS + 1;
    await store.markQueued(deliveryId, NOW + 2);
    await store.claimForSlack(deliveryId, secondAttemptAt);
    await store.markAcceptedByTrigger(
      deliveryId,
      secondAttemptAt,
      secondAttemptAt + 1_000,
    );
    await store.recordSlackProgress({
      deliveryId,
      destination: "alerts",
      phase: "send_started",
      messageTs: null,
      attemptCount: 2,
      functionExecutionId: SEND_EXECUTION_ID,
      now: secondAttemptAt + 1,
      reconcileAt: secondAttemptAt + 2_000,
    });
    await store.recordSlackTrace(trace, secondAttemptAt + 1);

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
        destination: null,
        slackChannelId: null,
        messageTs: null,
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
        destination: null,
        slackChannelId: null,
        messageTs: null,
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

  it("does not let a concurrent pending observation downgrade a terminal trace", async () => {
    const { database, d1 } = databaseWithMigrations(true);
    const deliveryId = "sqlite-trace-terminal-monotonic";
    const terminalStore = new D1DeliveryStore(d1);
    await terminalStore.insert(input(deliveryId));
    await terminalStore.markQueued(deliveryId, NOW);
    await terminalStore.claimForSlack(deliveryId, NOW);
    await terminalStore.markAcceptedByTrigger(
      deliveryId,
      NOW,
      NOW + 20 * 60 * 1_000,
    );

    const barrier = pauseOnTraceRead(d1);
    const pendingStore = new D1DeliveryStore(barrier.d1);
    const pending = pendingStore.recordSlackTrace(
      {
        traceId: "TrTerminalMonotonic1",
        deliveryId,
        outcome: "pending",
        ...TRACE_ATTEMPT_ONE,
        sendBoundaryReached: false,
        preSendFailureProven: false,
        startedAtUs: NOW * 1_000,
        completedAtUs: null,
      },
      NOW + 2,
    );
    await barrier.reached;
    await terminalStore.recordSlackTrace(
      {
        traceId: "TrTerminalMonotonic1",
        deliveryId,
        outcome: "error",
        ...TRACE_ATTEMPT_ONE,
        sendBoundaryReached: false,
        preSendFailureProven: false,
        startedAtUs: NOW * 1_000,
        completedAtUs: NOW * 1_000 + 1,
      },
      NOW + 1,
    );
    barrier.release();
    await pending;

    expect(
      database
        .prepare(
          `SELECT outcome, completed_at_us, applied_at
           FROM slack_workflow_traces WHERE trace_id = ?`,
        )
        .get("TrTerminalMonotonic1"),
    ).toEqual({
      outcome: "error",
      completed_at_us: NOW * 1_000 + 1,
      applied_at: NOW + 1,
    });
    await expect(terminalStore.get(deliveryId)).resolves.toMatchObject({
      status: "manual_review",
      lastError: "slack_workflow_failed_without_pre_send_proof",
    });
  });

  it("treats a pending replay of an existing terminal trace as a duplicate", async () => {
    const { database, d1 } = databaseWithMigrations(true);
    const deliveryId = "sqlite-terminal-pending-replay";
    const traceId = "TrTerminalPendingReplay1";
    const store = new D1DeliveryStore(d1);
    await store.insert(input(deliveryId));
    await store.markQueued(deliveryId, NOW);
    await store.claimForSlack(deliveryId, NOW);
    await store.markAcceptedByTrigger(
      deliveryId,
      NOW,
      NOW + 20 * 60 * 1_000,
    );

    await expect(
      store.recordSlackTrace(
        {
          traceId,
          deliveryId,
          outcome: "error",
          ...TRACE_ATTEMPT_ONE,
          sendBoundaryReached: false,
          preSendFailureProven: false,
          startedAtUs: NOW * 1_000,
          completedAtUs: NOW * 1_000 + 1,
        },
        NOW + 1,
      ),
    ).resolves.toBe("changed");

    await expect(
      store.recordSlackTrace(
        {
          traceId,
          deliveryId,
          outcome: "pending",
          ...TRACE_ATTEMPT_ONE,
          sendBoundaryReached: false,
          preSendFailureProven: false,
          startedAtUs: NOW * 1_000,
          completedAtUs: null,
        },
        NOW + 2,
      ),
    ).resolves.toBe("duplicate");

    expect(
      database
        .prepare(
          `SELECT outcome, completed_at_us, applied_at
           FROM slack_workflow_traces WHERE trace_id = ?`,
        )
        .get(traceId),
    ).toEqual({
      outcome: "error",
      completed_at_us: NOW * 1_000 + 1,
      applied_at: NOW + 1,
    });
    await expect(store.get(deliveryId)).resolves.toMatchObject({
      status: "manual_review",
      lastError: "slack_workflow_failed_without_pre_send_proof",
      slackTraceId: traceId,
    });
  });

  it("does not let a concurrent trace ID rebind proof to another delivery", async () => {
    const { d1 } = databaseWithMigrations(true);
    const firstStore = new D1DeliveryStore(d1);
    const firstDeliveryId = "sqlite-trace-identity-race-a";
    const secondDeliveryId = "sqlite-trace-identity-race-b";
    for (const deliveryId of [firstDeliveryId, secondDeliveryId]) {
      await firstStore.insert(input(deliveryId));
      await firstStore.markQueued(deliveryId, NOW);
      await firstStore.claimForSlack(deliveryId, NOW);
      await firstStore.markAcceptedByTrigger(
        deliveryId,
        NOW,
        NOW + 20 * 60 * 1_000,
      );
    }

    const barrier = pauseOnTraceRead(d1);
    const secondStore = new D1DeliveryStore(barrier.d1);
    const second = secondStore.recordSlackTrace(
      {
        traceId: "TrIdentityRace1",
        deliveryId: secondDeliveryId,
        outcome: "error",
        attemptCount: 1,
        sendExecutionId: "FxIdentityRaceSecond1",
        destination: null,
        slackChannelId: null,
        messageTs: null,
        sendBoundaryReached: false,
        preSendFailureProven: true,
        startedAtUs: NOW * 1_000,
        completedAtUs: NOW * 1_000 + 1,
      },
      NOW + 2,
    );
    await barrier.reached;
    await expect(
      firstStore.recordSlackTrace(
        {
          traceId: "TrIdentityRace1",
          deliveryId: firstDeliveryId,
          outcome: "error",
          attemptCount: 1,
          sendExecutionId: "FxIdentityRaceFirst1",
          destination: null,
          slackChannelId: null,
          messageTs: null,
          sendBoundaryReached: false,
          preSendFailureProven: true,
          startedAtUs: NOW * 1_000,
          completedAtUs: NOW * 1_000 + 1,
        },
        NOW + 1,
      ),
    ).resolves.toBe("changed");
    barrier.release();
    await expect(second).rejects.toThrow("slack_trace_delivery_conflict");

    await expect(firstStore.get(firstDeliveryId)).resolves.toMatchObject({
      status: "pending",
      slackTraceId: "TrIdentityRace1",
    });
    await expect(firstStore.get(secondDeliveryId)).resolves.toMatchObject({
      status: "accepted_by_trigger",
      slackTraceId: null,
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

  it("never lets authenticated pre-send proof override a committed send-started boundary", async () => {
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
        destination: null,
        slackChannelId: null,
        messageTs: null,
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

  it("keeps an applied terminal trace linked when its direct receipt arrives late", async () => {
    const { database, d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-late-receipt-applied-trace";
    const traceId = "TrLateReceiptAppliedTrace1";
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
    await store.recordSlackTrace(
      {
        traceId,
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
    expect(
      database
        .prepare(
          "SELECT applied_at FROM slack_workflow_traces WHERE trace_id = ?",
        )
        .get(traceId),
    ).toEqual({ applied_at: NOW + 2 });
    await expect(store.get(deliveryId)).resolves.toMatchObject({
      status: "manual_review",
      slackTraceId: traceId,
      slackSendExecutionId: SEND_EXECUTION_ID,
    });

    await store.recordSlackProgress({
      deliveryId,
      destination: "alerts",
      phase: "delivered",
      messageTs: "1785758400.001004",
      attemptCount: 1,
      functionExecutionId: DELIVERY_EXECUTION_ID,
      now: NOW + 3,
      reconcileAt: NOW + 20 * 60 * 1_000,
    });

    await expect(store.get(deliveryId)).resolves.toMatchObject({
      status: "delivered",
      slackMessageTs: "1785758400.001004",
      slackTraceId: traceId,
      slackSendExecutionId: SEND_EXECUTION_ID,
      lastError: null,
    });
    const checkpointUs =
      NOW * 1_000 + RECONCILIATION_RETRY_DELAY_MS * 1_000 + 2_000;
    await expect(
      store.advanceSlackActivityCheckpoint(checkpointUs),
    ).resolves.toBe(checkpointUs);
    await expect(store.purgeDeliveredBefore(NOW + 4)).resolves.toBe(1);
    await expect(store.get(deliveryId)).resolves.toBeNull();
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

  it("does not let a stale pre-send resolution overtake message evidence for the same trace", async () => {
    const { d1 } = databaseWithMigrations(true);
    const deliveryId = "sqlite-pre-send-message-race";
    const setup = new D1DeliveryStore(d1);
    await setup.insert(input(deliveryId));
    await setup.markQueued(deliveryId, NOW);
    await setup.claimForSlack(deliveryId, NOW);
    await setup.markAcceptedByTrigger(deliveryId, NOW, NOW + 1_000);
    await setup.recordSlackProgress({
      deliveryId,
      destination: "alerts",
      phase: "send_started",
      messageTs: null,
      attemptCount: 1,
      functionExecutionId: SEND_EXECUTION_ID,
      now: NOW + 1,
      reconcileAt: NOW + 20 * 60 * 1_000,
    });

    const preSendBarrier = pauseBeforeFirstBatch(d1);
    const messageBarrier = pauseBeforeFirstBatch(d1);
    const preSendStore = new D1DeliveryStore(preSendBarrier.d1);
    const messageStore = new D1DeliveryStore(messageBarrier.d1);
    const traceId = "TrPreSendMessageRace1";
    const preSend = preSendStore.recordSlackTrace(
      {
        traceId,
        deliveryId,
        outcome: "error",
        attemptCount: 1,
        sendExecutionId: SEND_EXECUTION_ID,
        destination: null,
        slackChannelId: null,
        messageTs: null,
        sendBoundaryReached: false,
        preSendFailureProven: true,
        startedAtUs: NOW * 1_000,
        completedAtUs: NOW * 1_000 + 1,
      },
      NOW + 2,
    );
    await preSendBarrier.reached;
    const message = messageStore.recordSlackTrace(
      {
        traceId,
        deliveryId,
        outcome: "error",
        attemptCount: 1,
        sendExecutionId: SEND_EXECUTION_ID,
        destination: "alerts",
        slackChannelId: "C0BMUK793NV",
        messageTs: "1785758400.000991",
        sendBoundaryReached: true,
        preSendFailureProven: false,
        startedAtUs: NOW * 1_000,
        completedAtUs: NOW * 1_000 + 1,
      },
      NOW + 3,
    );
    await messageBarrier.reached;
    preSendBarrier.release();
    await preSend;
    messageBarrier.release();
    await expect(message).resolves.toBe("duplicate");

    await expect(setup.get(deliveryId)).resolves.toMatchObject({
      status: "delivered",
      attemptCount: 1,
      slackMessageTs: "1785758400.000991",
      slackTraceId: traceId,
      slackSendExecutionId: SEND_EXECUTION_ID,
      lastError: null,
    });
  });

  it("derives the effective destination when terminal evidence completes a pending message trace", async () => {
    const { d1 } = databaseWithMigrations(true);
    const deliveryId = "sqlite-terminal-after-pending-message";
    const setup = new D1DeliveryStore(d1);
    await setup.insert(input(deliveryId));
    await setup.markQueued(deliveryId, NOW);
    await setup.claimForSlack(deliveryId, NOW);
    await setup.markAcceptedByTrigger(deliveryId, NOW, NOW + 1_000);
    await setup.recordSlackProgress({
      deliveryId,
      destination: "alerts",
      phase: "send_started",
      messageTs: null,
      attemptCount: 1,
      functionExecutionId: SEND_EXECUTION_ID,
      now: NOW + 1,
      reconcileAt: NOW + 20 * 60 * 1_000,
    });

    const barrier = pauseOnTraceRead(d1);
    const delayedTerminalStore = new D1DeliveryStore(barrier.d1);
    const traceId = "TrTerminalAfterPendingMessage1";
    const terminal = delayedTerminalStore.recordSlackTrace(
      {
        traceId,
        deliveryId,
        outcome: "error",
        attemptCount: 1,
        sendExecutionId: SEND_EXECUTION_ID,
        destination: null,
        slackChannelId: null,
        messageTs: null,
        sendBoundaryReached: false,
        preSendFailureProven: true,
        startedAtUs: NOW * 1_000,
        completedAtUs: NOW * 1_000 + 1,
      },
      NOW + 3,
    );
    await barrier.reached;
    await setup.recordSlackTrace(
      {
        traceId,
        deliveryId,
        outcome: "pending",
        attemptCount: 1,
        sendExecutionId: SEND_EXECUTION_ID,
        destination: "alerts",
        slackChannelId: "C0BMUK793NV",
        messageTs: "1785758400.000996",
        sendBoundaryReached: true,
        preSendFailureProven: false,
        startedAtUs: NOW * 1_000,
        completedAtUs: null,
      },
      NOW + 2,
    );
    barrier.release();
    await expect(terminal).resolves.toBe("changed");

    await expect(setup.get(deliveryId)).resolves.toMatchObject({
      status: "delivered",
      attemptCount: 1,
      slackMessageTs: "1785758400.000996",
      slackTraceId: traceId,
      slackSendExecutionId: SEND_EXECUTION_ID,
      lastError: null,
    });
  });

  it("resolves a delayed pending observation from the effective terminal message trace", async () => {
    const { d1 } = databaseWithMigrations(true);
    const deliveryId = "sqlite-pending-message-enrichment";
    const setup = new D1DeliveryStore(d1);
    await setup.insert(input(deliveryId));
    await setup.markQueued(deliveryId, NOW);
    await setup.claimForSlack(deliveryId, NOW);
    await setup.markAcceptedByTrigger(deliveryId, NOW, NOW + 1_000);
    await setup.recordSlackProgress({
      deliveryId,
      destination: "alerts",
      phase: "send_started",
      messageTs: null,
      attemptCount: 1,
      functionExecutionId: SEND_EXECUTION_ID,
      now: NOW + 1,
      reconcileAt: NOW + 20 * 60 * 1_000,
    });

    const barrier = pauseOnTraceRead(d1);
    const delayedStore = new D1DeliveryStore(barrier.d1);
    const traceId = "TrPendingMessageEnrichment1";
    const delayed = delayedStore.recordSlackTrace(
      {
        traceId,
        deliveryId,
        outcome: "pending",
        attemptCount: 1,
        sendExecutionId: SEND_EXECUTION_ID,
        destination: "alerts",
        slackChannelId: "C0BMUK793NV",
        messageTs: "1785758400.000993",
        sendBoundaryReached: true,
        preSendFailureProven: false,
        startedAtUs: NOW * 1_000,
        completedAtUs: null,
      },
      NOW + 3,
    );
    await barrier.reached;
    await setup.recordSlackTrace(
      {
        traceId,
        deliveryId,
        outcome: "error",
        attemptCount: 1,
        sendExecutionId: SEND_EXECUTION_ID,
        destination: null,
        slackChannelId: null,
        messageTs: null,
        sendBoundaryReached: false,
        preSendFailureProven: true,
        startedAtUs: NOW * 1_000,
        completedAtUs: NOW * 1_000 + 1,
      },
      NOW + 2,
    );
    barrier.release();
    await expect(delayed).resolves.toBe("duplicate");

    await expect(setup.get(deliveryId)).resolves.toMatchObject({
      status: "delivered",
      attemptCount: 1,
      slackMessageTs: "1785758400.000993",
      slackTraceId: traceId,
      slackSendExecutionId: SEND_EXECUTION_ID,
      lastError: null,
    });
  });

  it("lets a direct receipt dominate a concurrent pre-send retry release", async () => {
    const { d1 } = databaseWithMigrations(true);
    const deliveryId = "sqlite-direct-receipt-pre-send-race";
    const setup = new D1DeliveryStore(d1);
    await setup.insert(input(deliveryId));
    await setup.markQueued(deliveryId, NOW);
    await setup.claimForSlack(deliveryId, NOW);
    await setup.markAcceptedByTrigger(deliveryId, NOW, NOW + 1_000);
    await setup.recordSlackProgress({
      deliveryId,
      destination: "alerts",
      phase: "send_started",
      messageTs: null,
      attemptCount: 1,
      functionExecutionId: SEND_EXECUTION_ID,
      now: NOW + 1,
      reconcileAt: NOW + 20 * 60 * 1_000,
    });

    const barrier = pauseOnDeliveryRead(d1, 1);
    const receiptStore = new D1DeliveryStore(barrier.d1);
    const receipt = receiptStore.recordSlackProgress({
      deliveryId,
      destination: "alerts",
      phase: "delivered",
      messageTs: "1785758400.000992",
      attemptCount: 1,
      functionExecutionId: DELIVERY_EXECUTION_ID,
      now: NOW + 3,
      reconcileAt: NOW + 20 * 60 * 1_000,
    });
    await barrier.reached;
    await setup.recordSlackTrace(
      {
        traceId: "TrDirectReceiptPreSendRace1",
        deliveryId,
        outcome: "error",
        attemptCount: 1,
        sendExecutionId: SEND_EXECUTION_ID,
        destination: null,
        slackChannelId: null,
        messageTs: null,
        sendBoundaryReached: false,
        preSendFailureProven: true,
        startedAtUs: NOW * 1_000,
        completedAtUs: NOW * 1_000 + 1,
      },
      NOW + 2,
    );
    barrier.release();
    await expect(receipt).resolves.toBe("recorded");

    await expect(setup.get(deliveryId)).resolves.toMatchObject({
      status: "delivered",
      attemptCount: 1,
      slackMessageTs: "1785758400.000992",
      slackSendExecutionId: SEND_EXECUTION_ID,
      lastError: null,
    });
  });

  it("retains the boundary owner in manual review until a late direct receipt arrives", async () => {
    const { d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-late-receipt-before-retry";
    const traceId = "TrLateReceiptBeforeRetry1";
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
    await store.recordSlackTrace(
      {
        traceId,
        deliveryId,
        outcome: "error",
        attemptCount: 1,
        sendExecutionId: SEND_EXECUTION_ID,
        destination: null,
        slackChannelId: null,
        messageTs: null,
        sendBoundaryReached: false,
        preSendFailureProven: true,
        startedAtUs: NOW * 1_000,
        completedAtUs: NOW * 1_000 + 1,
      },
      NOW + 2,
    );

    const retryAt = NOW + RECONCILIATION_RETRY_DELAY_MS;
    await expect(store.get(deliveryId)).resolves.toMatchObject({
      status: "manual_review",
      attemptCount: 1,
      nextAttemptAt: retryAt,
      slackTraceId: traceId,
      slackSendExecutionId: SEND_EXECUTION_ID,
    });
    await expect(
      store.claimForSlack(deliveryId, retryAt - 1),
    ).resolves.toBeNull();
    await expect(
      store.recordSlackProgress({
        deliveryId,
        destination: "alerts",
        phase: "delivered",
        messageTs: "1785758400.000994",
        attemptCount: 1,
        functionExecutionId: DELIVERY_EXECUTION_ID,
        now: NOW + 3,
        reconcileAt: NOW + 20 * 60 * 1_000,
      }),
    ).resolves.toBe("recorded");
    await expect(store.get(deliveryId)).resolves.toMatchObject({
      status: "delivered",
      attemptCount: 1,
      slackMessageTs: "1785758400.000994",
      slackTraceId: null,
      slackSendExecutionId: SEND_EXECUTION_ID,
      lastError: null,
    });
    const checkpointUs =
      NOW * 1_000 + RECONCILIATION_RETRY_DELAY_MS * 1_000 + 2_000;
    await expect(
      store.advanceSlackActivityCheckpoint(checkpointUs),
    ).resolves.toBe((NOW + 3) * 1_000);
    await expect(store.purgeDeliveredBefore(NOW + 4)).resolves.toBe(0);
  });

  it("does not claim a retry and accepts the original receipt after send-started evidence", async () => {
    const { d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-old-receipt-after-next-attempt";
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
    await store.recordSlackTrace(
      {
        traceId: "TrOldReceiptAfterNextAttempt1",
        deliveryId,
        outcome: "error",
        attemptCount: 1,
        sendExecutionId: SEND_EXECUTION_ID,
        destination: null,
        slackChannelId: null,
        messageTs: null,
        sendBoundaryReached: false,
        preSendFailureProven: true,
        startedAtUs: NOW * 1_000,
        completedAtUs: NOW * 1_000 + 1,
      },
      NOW + 2,
    );

    const retryAt = NOW + 2 + RECONCILIATION_RETRY_DELAY_MS;
    await expect(
      store.claimForSlack(deliveryId, retryAt),
    ).resolves.toBeNull();
    await expect(
      store.recordSlackProgress({
        deliveryId,
        destination: "alerts",
        phase: "delivered",
        messageTs: "1785758400.000995",
        attemptCount: 1,
        functionExecutionId: DELIVERY_EXECUTION_ID,
        now: retryAt + 1,
        reconcileAt: retryAt + 20 * 60 * 1_000,
      }),
    ).resolves.toBe("recorded");
    await expect(store.get(deliveryId)).resolves.toMatchObject({
      status: "delivered",
      attemptCount: 1,
      slackMessageTs: "1785758400.000995",
      slackSendExecutionId: SEND_EXECUTION_ID,
      lastError: null,
    });
  });

  it("does not let an earlier trace block a later pre-trigger retry", async () => {
    const { d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-later-pre-trigger-retry";
    await store.insert(input(deliveryId));
    await store.markQueued(deliveryId, NOW);
    await store.claimForSlack(deliveryId, NOW);
    await store.markAcceptedByTrigger(deliveryId, NOW, NOW + 1_000);
    await store.recordSlackTrace(
      {
        traceId: "TrEarlierAttemptBeforeRetry1",
        deliveryId,
        outcome: "error",
        attemptCount: 1,
        sendExecutionId: SEND_EXECUTION_ID,
        destination: null,
        slackChannelId: null,
        messageTs: null,
        sendBoundaryReached: false,
        preSendFailureProven: true,
        startedAtUs: NOW * 1_000,
        completedAtUs: NOW * 1_000 + 1,
      },
      NOW + 1,
    );

    const secondAttemptAt = NOW + 1 + RECONCILIATION_RETRY_DELAY_MS;
    await expect(
      store.claimForSlack(deliveryId, secondAttemptAt),
    ).resolves.toMatchObject({
      status: "sending",
      attemptCount: 2,
      slackTraceId: null,
      slackSendExecutionId: null,
    });
    await store.recordFailure(
      deliveryId,
      secondAttemptAt + 1,
      secondAttemptAt + 2,
      "pre_trigger_failure",
    );
    await expect(
      store.claimForSlack(deliveryId, secondAttemptAt + 2),
    ).resolves.toMatchObject({
      status: "sending",
      attemptCount: 3,
      slackTraceId: null,
      slackSendExecutionId: null,
    });
  });

  it("does not claim a retry after its trace gains positive evidence", async () => {
    const { d1 } = databaseWithMigrations(true);
    const setup = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-positive-trace-before-retry-claim";
    const traceId = "TrPositiveBeforeRetryClaim1";
    await setup.insert(input(deliveryId));
    await setup.markQueued(deliveryId, NOW);
    await setup.claimForSlack(deliveryId, NOW);
    await setup.markAcceptedByTrigger(deliveryId, NOW, NOW + 1_000);
    await setup.recordSlackProgress({
      deliveryId,
      destination: "alerts",
      phase: "send_started",
      messageTs: null,
      attemptCount: 1,
      functionExecutionId: SEND_EXECUTION_ID,
      now: NOW + 1,
      reconcileAt: NOW + 20 * 60 * 1_000,
    });
    await setup.recordSlackTrace(
      {
        traceId,
        deliveryId,
        outcome: "error",
        attemptCount: 1,
        sendExecutionId: SEND_EXECUTION_ID,
        destination: null,
        slackChannelId: null,
        messageTs: null,
        sendBoundaryReached: false,
        preSendFailureProven: true,
        startedAtUs: NOW * 1_000,
        completedAtUs: NOW * 1_000 + 1,
      },
      NOW + 2,
    );

    const barrier = pauseBeforeFirstBatch(d1);
    const resolver = new D1DeliveryStore(barrier.d1);
    const positive = resolver.recordSlackTrace(
      {
        traceId,
        deliveryId,
        outcome: "error",
        attemptCount: 1,
        sendExecutionId: SEND_EXECUTION_ID,
        destination: "alerts",
        slackChannelId: "C0BMUK793NV",
        messageTs: "1785758400.000997",
        sendBoundaryReached: true,
        preSendFailureProven: false,
        startedAtUs: NOW * 1_000,
        completedAtUs: NOW * 1_000 + 1,
      },
      NOW + 3,
    );
    await barrier.reached;

    const retryAt = NOW + 2 + RECONCILIATION_RETRY_DELAY_MS;
    await expect(setup.claimForSlack(deliveryId, retryAt)).resolves.toBeNull();
    barrier.release();
    await expect(positive).resolves.toBe("duplicate");
    await expect(setup.get(deliveryId)).resolves.toMatchObject({
      status: "delivered",
      attemptCount: 1,
      slackMessageTs: "1785758400.000997",
      slackTraceId: traceId,
      slackSendExecutionId: SEND_EXECUTION_ID,
      lastError: null,
    });
  });

  it("rejects a second trace that reuses an owned send execution", async () => {
    const { database, d1 } = databaseWithMigrations(true);
    const setup = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-reused-trace-send-execution";
    const firstTraceId = "TrOwnedSendExecution1";
    await setup.insert(input(deliveryId));
    await setup.markQueued(deliveryId, NOW);
    await setup.claimForSlack(deliveryId, NOW);
    await setup.markAcceptedByTrigger(deliveryId, NOW, NOW + 1_000);
    await setup.recordSlackProgress({
      deliveryId,
      destination: "alerts",
      phase: "send_started",
      messageTs: null,
      attemptCount: 1,
      functionExecutionId: SEND_EXECUTION_ID,
      now: NOW + 1,
      reconcileAt: NOW + 20 * 60 * 1_000,
    });
    await expect(
      setup.recordSlackTrace(
        {
          traceId: firstTraceId,
          deliveryId,
          outcome: "error",
          attemptCount: 1,
          sendExecutionId: SEND_EXECUTION_ID,
          destination: null,
          slackChannelId: null,
          messageTs: null,
          sendBoundaryReached: false,
          preSendFailureProven: true,
          startedAtUs: NOW * 1_000,
          completedAtUs: NOW * 1_000 + 1,
        },
        NOW + 2,
      ),
    ).resolves.toBe("changed");

    await expect(
      setup.recordSlackTrace(
        {
          traceId: "TrReusedSendExecution2",
          deliveryId,
          outcome: "error",
          attemptCount: 1,
          sendExecutionId: SEND_EXECUTION_ID,
          destination: "alerts",
          slackChannelId: "C0BMUK793NV",
          messageTs: "1785758400.000998",
          sendBoundaryReached: true,
          preSendFailureProven: false,
          startedAtUs: NOW * 1_000,
          completedAtUs: NOW * 1_000 + 2,
        },
        NOW + 3,
      ),
    ).rejects.toThrow("slack_trace_send_execution_owner_conflict");

    const traceOwners = database
      .prepare(
        `SELECT trace_id
         FROM slack_workflow_traces
         WHERE send_execution_id = ?
         ORDER BY trace_id`,
      )
      .all(SEND_EXECUTION_ID)
      .map((row) => row.trace_id);
    expect(traceOwners).toEqual([firstTraceId]);
    await expect(setup.get(deliveryId)).resolves.toMatchObject({
      status: "manual_review",
      attemptCount: 1,
      slackMessageTs: null,
      slackTraceId: firstTraceId,
      slackSendExecutionId: SEND_EXECUTION_ID,
      lastError: "slack_workflow_failed_after_send_boundary",
    });
  });

  it("classifies message evidence already owned only by another trace as a reconciliation conflict", async () => {
    const { database, d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);
    const messageTs = "1785758400.000999";
    const staleDeliveryId = "sqlite-stale-message-owner";
    const activeDeliveryId = "sqlite-message-reuse";
    await store.insert(input(staleDeliveryId));
    await store.markQueued(staleDeliveryId, NOW);
    await store.claimForSlack(staleDeliveryId, NOW);
    await store.markAcceptedByTrigger(staleDeliveryId, NOW, NOW + 1_000);

    await expect(
      store.recordSlackTrace(
        {
          traceId: "TrSqliteStaleMessageOwner1",
          deliveryId: staleDeliveryId,
          outcome: "error",
          attemptCount: 1,
          sendExecutionId: "FxSqliteStaleMessageOwner1",
          destination: "alerts",
          slackChannelId: "C0BMUK793NV",
          messageTs,
          sendBoundaryReached: true,
          preSendFailureProven: false,
          startedAtUs: NOW * 1_000,
          completedAtUs: NOW * 1_000 + 1,
        },
        NOW + 1,
      ),
    ).rejects.toThrow("slack_trace_owner_conflict");
    expect(
      database
        .prepare(
          `SELECT trace_id, slack_message_ts
           FROM slack_workflow_traces
           WHERE trace_id = ?`,
        )
        .get("TrSqliteStaleMessageOwner1"),
    ).toEqual({
      trace_id: "TrSqliteStaleMessageOwner1",
      slack_message_ts: messageTs,
    });

    await store.insert(input(activeDeliveryId));
    await store.markQueued(activeDeliveryId, NOW + 2);
    await store.claimForSlack(activeDeliveryId, NOW + 2);
    await store.markAcceptedByTrigger(activeDeliveryId, NOW + 2, NOW + 1_002);
    await store.recordSlackProgress({
      deliveryId: activeDeliveryId,
      destination: "alerts",
      phase: "send_started",
      messageTs: null,
      attemptCount: 1,
      functionExecutionId: "FxSqliteMessageReuse2",
      now: NOW + 3,
      reconcileAt: NOW + 20 * 60 * 1_000,
    });

    const staleOwnerRead = missFirstMessageOwnerRead(d1);
    const racedStore = new D1DeliveryStore(staleOwnerRead.d1);
    const reusedTrace = {
      traceId: "TrSqliteMessageReuse2",
      deliveryId: activeDeliveryId,
      outcome: "error" as const,
      attemptCount: 1,
      sendExecutionId: "FxSqliteMessageReuse2",
      destination: "alerts" as const,
      slackChannelId: "C0BMUK793NV",
      messageTs,
      sendBoundaryReached: true,
      preSendFailureProven: false,
      startedAtUs: NOW * 1_000 + 2,
      completedAtUs: NOW * 1_000 + 3,
    };
    await expect(
      racedStore.recordSlackTrace(reusedTrace, NOW + 4),
    ).rejects.toThrow("slack_trace_message_owner_conflict");
    expect(staleOwnerRead.missed()).toBe(true);
    await expect(
      store.recordSlackTrace(
        {
          ...reusedTrace,
          traceId: "TrSqliteMessageReuse3",
          sendExecutionId: "FxSqliteMessageReuse3",
        },
        NOW + 5,
      ),
    ).rejects.toThrow("slack_trace_message_owner_conflict");
    await expect(store.get(activeDeliveryId)).resolves.toMatchObject({
      status: "send_started",
      slackMessageTs: null,
      slackTraceId: null,
    });
  });

  it("classifies message evidence owned by another delivered row before writing its trace", async () => {
    const { database, d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);
    const ownerDeliveryId = "sqlite-delivery-message-owner";
    const contenderDeliveryId = "sqlite-delivery-message-contender";
    const messageTs = "1785758400.001001";

    await store.insert(input(ownerDeliveryId));
    await store.markQueued(ownerDeliveryId, NOW);
    await store.claimForSlack(ownerDeliveryId, NOW);
    await store.markAcceptedByTrigger(ownerDeliveryId, NOW, NOW + 1_000);
    await store.recordSlackProgress({
      deliveryId: ownerDeliveryId,
      destination: "alerts",
      phase: "send_started",
      messageTs: null,
      attemptCount: 1,
      functionExecutionId: "FxDeliveryMessageOwner1",
      now: NOW + 1,
      reconcileAt: NOW + 20 * 60 * 1_000,
    });
    await store.recordSlackProgress({
      deliveryId: ownerDeliveryId,
      destination: "alerts",
      phase: "delivered",
      messageTs,
      attemptCount: 1,
      functionExecutionId: "FxDeliveryMessageOwnerReceipt1",
      now: NOW + 2,
      reconcileAt: NOW + 20 * 60 * 1_000,
    });

    await store.insert(input(contenderDeliveryId));
    await store.markQueued(contenderDeliveryId, NOW + 3);
    await store.claimForSlack(contenderDeliveryId, NOW + 3);
    await store.markAcceptedByTrigger(
      contenderDeliveryId,
      NOW + 3,
      NOW + 1_003,
    );
    await store.recordSlackProgress({
      deliveryId: contenderDeliveryId,
      destination: "alerts",
      phase: "send_started",
      messageTs: null,
      attemptCount: 1,
      functionExecutionId: "FxDeliveryMessageContender1",
      now: NOW + 4,
      reconcileAt: NOW + 20 * 60 * 1_000,
    });

    await expect(
      store.recordSlackTrace(
        {
          traceId: "TrDeliveryMessageContender1",
          deliveryId: contenderDeliveryId,
          outcome: "error",
          attemptCount: 1,
          sendExecutionId: "FxDeliveryMessageContender1",
          destination: "alerts",
          slackChannelId: "C0BMUK793NV",
          messageTs,
          sendBoundaryReached: true,
          preSendFailureProven: false,
          startedAtUs: NOW * 1_000 + 4,
          completedAtUs: NOW * 1_000 + 5,
        },
        NOW + 5,
      ),
    ).rejects.toThrow("slack_message_timestamp_conflict");
    expect(
      database
        .prepare(
          "SELECT trace_id FROM slack_workflow_traces WHERE trace_id = ?",
        )
        .get("TrDeliveryMessageContender1"),
    ).toBeUndefined();
    await expect(store.get(contenderDeliveryId)).resolves.toMatchObject({
      status: "send_started",
      slackMessageTs: null,
      slackTraceId: null,
    });
  });

  it("rechecks a delivered message owner after a stale trace precheck", async () => {
    const { database, d1 } = databaseWithMigrations(true);
    const setup = new D1DeliveryStore(d1);
    const ownerDeliveryId = "sqlite-raced-delivery-message-owner";
    const contenderDeliveryId = "sqlite-raced-delivery-message-contender";
    const traceId = "TrRacedDeliveryMessageContender1";
    const messageTs = "1785758400.001002";

    await setup.insert(input(ownerDeliveryId));
    await setup.markQueued(ownerDeliveryId, NOW);
    await setup.claimForSlack(ownerDeliveryId, NOW);
    await setup.markAcceptedByTrigger(ownerDeliveryId, NOW, NOW + 1_000);
    await setup.recordSlackProgress({
      deliveryId: ownerDeliveryId,
      destination: "alerts",
      phase: "send_started",
      messageTs: null,
      attemptCount: 1,
      functionExecutionId: "FxRacedDeliveryMessageOwner1",
      now: NOW + 1,
      reconcileAt: NOW + 20 * 60 * 1_000,
    });
    await setup.recordSlackProgress({
      deliveryId: ownerDeliveryId,
      destination: "alerts",
      phase: "delivered",
      messageTs,
      attemptCount: 1,
      functionExecutionId: "FxRacedDeliveryMessageOwnerReceipt1",
      now: NOW + 2,
      reconcileAt: NOW + 20 * 60 * 1_000,
    });

    await setup.insert(input(contenderDeliveryId));
    await setup.markQueued(contenderDeliveryId, NOW + 3);
    await setup.claimForSlack(contenderDeliveryId, NOW + 3);
    await setup.markAcceptedByTrigger(
      contenderDeliveryId,
      NOW + 3,
      NOW + 1_003,
    );
    await setup.recordSlackProgress({
      deliveryId: contenderDeliveryId,
      destination: "alerts",
      phase: "send_started",
      messageTs: null,
      attemptCount: 1,
      functionExecutionId: "FxRacedDeliveryMessageContender1",
      now: NOW + 4,
      reconcileAt: NOW + 20 * 60 * 1_000,
    });

    const staleOwnerRead = missFirstDeliveryMessageOwnerRead(d1);
    const racedStore = new D1DeliveryStore(staleOwnerRead.d1);
    await expect(
      racedStore.recordSlackTrace(
        {
          traceId,
          deliveryId: contenderDeliveryId,
          outcome: "error",
          attemptCount: 1,
          sendExecutionId: "FxRacedDeliveryMessageContender1",
          destination: "alerts",
          slackChannelId: "C0BMUK793NV",
          messageTs,
          sendBoundaryReached: true,
          preSendFailureProven: false,
          startedAtUs: NOW * 1_000 + 4,
          completedAtUs: NOW * 1_000 + 5,
        },
        NOW + 5,
      ),
    ).rejects.toThrow("slack_message_timestamp_conflict");
    expect(staleOwnerRead.missed()).toBe(true);
    expect(
      database
        .prepare(
          `SELECT slack_message_ts, applied_at
           FROM slack_workflow_traces WHERE trace_id = ?`,
        )
        .get(traceId),
    ).toEqual({ slack_message_ts: messageTs, applied_at: null });
    await expect(setup.get(contenderDeliveryId)).resolves.toMatchObject({
      status: "send_started",
      slackMessageTs: null,
      slackTraceId: null,
    });
  });

  it("preserves an unrelated message-resolution batch failure", async () => {
    const { database, d1 } = databaseWithMigrations(true);
    const injected = failNextTraceResolutionBatch(d1);
    const store = new D1DeliveryStore(injected.d1);
    const deliveryId = "sqlite-unrelated-message-resolution-failure";
    const traceId = "TrUnrelatedMessageResolutionFailure1";
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
      functionExecutionId: "FxUnrelatedMessageResolutionFailure1",
      now: NOW + 1,
      reconcileAt: NOW + 20 * 60 * 1_000,
    });

    injected.arm();
    await expect(
      store.recordSlackTrace(
        {
          traceId,
          deliveryId,
          outcome: "error",
          attemptCount: 1,
          sendExecutionId: "FxUnrelatedMessageResolutionFailure1",
          destination: "alerts",
          slackChannelId: "C0BMUK793NV",
          messageTs: "1785758400.001003",
          sendBoundaryReached: true,
          preSendFailureProven: false,
          startedAtUs: NOW * 1_000 + 1,
          completedAtUs: NOW * 1_000 + 2,
        },
        NOW + 2,
      ),
    ).rejects.toThrow("injected_trace_resolution_failure");
    expect(
      database
        .prepare(
          `SELECT slack_message_ts, applied_at
           FROM slack_workflow_traces WHERE trace_id = ?`,
        )
        .get(traceId),
    ).toEqual({
      slack_message_ts: "1785758400.001003",
      applied_at: null,
    });
    await expect(store.get(deliveryId)).resolves.toMatchObject({
      status: "send_started",
      slackMessageTs: null,
      slackTraceId: null,
    });
  });
});
