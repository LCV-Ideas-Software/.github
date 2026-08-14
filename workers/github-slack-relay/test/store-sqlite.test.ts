import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { URL as NodeUrl } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { unstable_splitSqlQuery } from "wrangler";

import { handleFetch } from "../src/index";
import {
  SLACK_RECONCILIATION_REPORT_ERRORS_TABLE_SQL,
  SLACK_RECONCILIATION_REPORTS_TABLE_SQL,
} from "../src/slack-reconciliation-schema-contract";
import {
  SEALED_SLACK_DELIVERY_PROTOCOL_GUARDS,
  TRANSIENT_SLACK_DELIVERY_PROTOCOL_GUARDS,
} from "../src/slack-delivery-protocol-guards";
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
const SEALED_PROTOCOL_REVISION = "e0131a758123cf210d9cc9e7e537b72dc0441a90";
const SEALED_PROTOCOL_ACTIVATED_AT = 1_786_579_752_661;
const SEALED_PROTOCOL_ACTIVATION_ID =
  "18a94ba84d6bac0f8ae396996a5cd6ac026eb336be5eef702b92b3b6a60d4ff7";
const TRANSIENT_REVISION_BRIDGE_GUARD_SQL =
  TRANSIENT_SLACK_DELIVERY_PROTOCOL_GUARDS.find(
    ({ name }) =>
      name === "enforce_one_time_slack_delivery_protocol_revision_bridge",
  )?.schemaSql;
if (TRANSIENT_REVISION_BRIDGE_GUARD_SQL === undefined) {
  throw new Error("missing transient revision bridge guard definition");
}
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

interface D1BoundaryCounts {
  all: number;
  batch: number;
  first: number;
  run: number;
}

function emptyD1BoundaryCounts(): D1BoundaryCounts {
  return { all: 0, batch: 0, first: 0, run: 0 };
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

function sqliteD1(
  database: DatabaseSync,
  boundaries?: D1BoundaryCounts,
): D1Database {
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
          if (boundaries !== undefined) boundaries.run += 1;
          return run();
        },
        async first<T>(columnName?: string): Promise<T | null> {
          if (boundaries !== undefined) boundaries.first += 1;
          const row = statement.get(...values) as
            Record<string, unknown> | undefined;
          if (row === undefined) return null;
          return (columnName === undefined ? row : row[columnName]) as T;
        },
        async all<T>(): Promise<D1Result<T>> {
          if (boundaries !== undefined) boundaries.all += 1;
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
      if (boundaries !== undefined) boundaries.batch += 1;
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

function seedLiveProtocolTuple(database: DatabaseSync): void {
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
}

function applyMigrationAtomically(
  database: DatabaseSync,
  migration: string,
): void {
  database.exec("BEGIN IMMEDIATE TRANSACTION;");
  try {
    database.exec(migrationSource(migration));
    database.exec("COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

function databaseReadyToSeal(): {
  database: DatabaseSync;
  d1: D1Database;
} {
  const result = databaseWithMigrations(true);
  result.database.exec(
    "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
  );
  seedLiveProtocolTuple(result.database);
  return result;
}

function databaseWithReconciliationJournal(): {
  database: DatabaseSync;
  d1: D1Database;
} {
  const result = databaseReadyToSeal();
  applyMigrationAtomically(
    result.database,
    "0006_seal_slack_delivery_protocol.sql",
  );
  applyMigrationAtomically(
    result.database,
    "0007_journal_slack_reconciliation_reports.sql",
  );
  applyMigrationAtomically(
    result.database,
    "0008_resume_bounded_slack_activity_scan.sql",
  );
  applyMigrationAtomically(
    result.database,
    "0009_track_slack_trace_hydration.sql",
  );
  return result;
}

function replaceSchemaFragment(
  schemaSql: string,
  fragment: string,
  replacement: string,
): string {
  const occurrences = schemaSql.split(fragment).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `expected exactly one schema fragment occurrence, found ${occurrences}`,
    );
  }
  return schemaSql.replace(fragment, replacement);
}

function replaceReconciliationJournalSchema(
  database: DatabaseSync,
  reportsTableSql: string,
  reportErrorsTableSql: string,
): void {
  database.exec(`
    DROP TABLE slack_reconciliation_report_errors;
    DROP TABLE slack_reconciliation_reports;
    ${reportsTableSql};
    CREATE INDEX idx_slack_reconciliation_reports_completed
      ON slack_reconciliation_reports (completed_at);
    ${reportErrorsTableSql};
    CREATE INDEX idx_slack_reconciliation_report_errors_report
      ON slack_reconciliation_report_errors (report_id);
  `);
}

const RECONCILIATION_SCHEMA_CHECK_MUTATIONS = [
  {
    name: "the report identifier length predicate is missing",
    reportsTableSql: replaceSchemaFragment(
      SLACK_RECONCILIATION_REPORTS_TABLE_SQL,
      "    length(report_id) = 64\n    AND ",
      "",
    ),
    reportErrorsTableSql: SLACK_RECONCILIATION_REPORT_ERRORS_TABLE_SQL,
  },
  {
    name: "the report identifier hexadecimal predicate is missing",
    reportsTableSql: replaceSchemaFragment(
      SLACK_RECONCILIATION_REPORTS_TABLE_SQL,
      "\n    AND report_id NOT GLOB '*[^0-9a-f]*'",
      "",
    ),
    reportErrorsTableSql: SLACK_RECONCILIATION_REPORT_ERRORS_TABLE_SQL,
  },
  {
    name: "the report trace-count bound is weakened",
    reportsTableSql: replaceSchemaFragment(
      SLACK_RECONCILIATION_REPORTS_TABLE_SQL,
      "trace_count BETWEEN 0 AND 25",
      "trace_count >= 0",
    ),
    reportErrorsTableSql: SLACK_RECONCILIATION_REPORT_ERRORS_TABLE_SQL,
  },
  {
    name: "the changed-error trace-count bound is weakened",
    reportsTableSql: replaceSchemaFragment(
      SLACK_RECONCILIATION_REPORTS_TABLE_SQL,
      "changed_error_traces BETWEEN 0 AND trace_count",
      "changed_error_traces >= 0",
    ),
    reportErrorsTableSql: SLACK_RECONCILIATION_REPORT_ERRORS_TABLE_SQL,
  },
  {
    name: "the requested-checkpoint nonnegative predicate is missing",
    reportsTableSql: replaceSchemaFragment(
      SLACK_RECONCILIATION_REPORTS_TABLE_SQL,
      "requested_checkpoint_us INTEGER NOT NULL CHECK (requested_checkpoint_us >= 0)",
      "requested_checkpoint_us INTEGER NOT NULL",
    ),
    reportErrorsTableSql: SLACK_RECONCILIATION_REPORT_ERRORS_TABLE_SQL,
  },
  {
    name: "the committed checkpoint bound is weakened",
    reportsTableSql: replaceSchemaFragment(
      SLACK_RECONCILIATION_REPORTS_TABLE_SQL,
      "checkpoint_us BETWEEN 0 AND requested_checkpoint_us",
      "checkpoint_us >= 0",
    ),
    reportErrorsTableSql: SLACK_RECONCILIATION_REPORT_ERRORS_TABLE_SQL,
  },
  {
    name: "the report completion-time predicate is missing",
    reportsTableSql: replaceSchemaFragment(
      SLACK_RECONCILIATION_REPORTS_TABLE_SQL,
      "completed_at INTEGER NOT NULL CHECK (completed_at > 0)",
      "completed_at INTEGER NOT NULL",
    ),
    reportErrorsTableSql: SLACK_RECONCILIATION_REPORT_ERRORS_TABLE_SQL,
  },
  {
    name: "the error receipt report identifier length predicate is missing",
    reportsTableSql: SLACK_RECONCILIATION_REPORTS_TABLE_SQL,
    reportErrorsTableSql: replaceSchemaFragment(
      SLACK_RECONCILIATION_REPORT_ERRORS_TABLE_SQL,
      "    length(report_id) = 64\n    AND ",
      "",
    ),
  },
  {
    name: "the error receipt report identifier hexadecimal predicate is missing",
    reportsTableSql: SLACK_RECONCILIATION_REPORTS_TABLE_SQL,
    reportErrorsTableSql: replaceSchemaFragment(
      SLACK_RECONCILIATION_REPORT_ERRORS_TABLE_SQL,
      "\n    AND report_id NOT GLOB '*[^0-9a-f]*'",
      "",
    ),
  },
  {
    name: "the error receipt commit-time predicate is missing",
    reportsTableSql: SLACK_RECONCILIATION_REPORTS_TABLE_SQL,
    reportErrorsTableSql: replaceSchemaFragment(
      SLACK_RECONCILIATION_REPORT_ERRORS_TABLE_SQL,
      "committed_at INTEGER NOT NULL CHECK (committed_at > 0)",
      "committed_at INTEGER NOT NULL",
    ),
  },
] as const;

const RECONCILIATION_SCHEMA_EXTRA_FOREIGN_KEY = {
  name: "the error receipt has an unexpected report foreign key",
  reportsTableSql: SLACK_RECONCILIATION_REPORTS_TABLE_SQL,
  reportErrorsTableSql: replaceSchemaFragment(
    SLACK_RECONCILIATION_REPORT_ERRORS_TABLE_SQL,
    "report_id TEXT NOT NULL CHECK (",
    "report_id TEXT NOT NULL REFERENCES slack_reconciliation_reports(report_id) CHECK (",
  ),
} as const;

const RECONCILIATION_SCHEMA_INVENTORY_MUTATIONS = [
  {
    name: "the reviewed report index becomes compound",
    mutate(database: DatabaseSync): void {
      database.exec(`
        DROP INDEX idx_slack_reconciliation_reports_completed;
        CREATE INDEX idx_slack_reconciliation_reports_completed
          ON slack_reconciliation_reports (completed_at, report_id);
      `);
    },
  },
  {
    name: "the reviewed report index becomes partial",
    mutate(database: DatabaseSync): void {
      database.exec(`
        DROP INDEX idx_slack_reconciliation_reports_completed;
        CREATE INDEX idx_slack_reconciliation_reports_completed
          ON slack_reconciliation_reports (completed_at)
          WHERE completed_at > 0;
      `);
    },
  },
  {
    name: "the reviewed report index is renamed",
    mutate(database: DatabaseSync): void {
      database.exec(`
        DROP INDEX idx_slack_reconciliation_reports_completed;
        CREATE INDEX idx_unreviewed_slack_reconciliation_reports_completed
          ON slack_reconciliation_reports (completed_at);
      `);
    },
  },
  {
    name: "an unreviewed trigger is attached to the journal",
    mutate(database: DatabaseSync): void {
      database.exec(`
        CREATE TRIGGER unreviewed_slack_reconciliation_report_trigger
        AFTER INSERT ON slack_reconciliation_reports
        BEGIN
          SELECT 1;
        END;
      `);
    },
  },
  {
    name: "an implicit autoindex is added to the journal",
    mutate(database: DatabaseSync): void {
      const reportsTableSql = replaceSchemaFragment(
        SLACK_RECONCILIATION_REPORTS_TABLE_SQL,
        "  completed_at INTEGER NOT NULL CHECK (completed_at > 0)\n)",
        "  completed_at INTEGER NOT NULL CHECK (completed_at > 0),\n  UNIQUE (completed_at)\n)",
      );
      replaceReconciliationJournalSchema(
        database,
        reportsTableSql,
        SLACK_RECONCILIATION_REPORT_ERRORS_TABLE_SQL,
      );
    },
  },
  {
    name: "canonical journal DDL whitespace drifts",
    mutate(database: DatabaseSync): void {
      const reportsTableSql = replaceSchemaFragment(
        SLACK_RECONCILIATION_REPORTS_TABLE_SQL,
        "  trace_count INTEGER NOT NULL",
        "   trace_count INTEGER NOT NULL",
      );
      replaceReconciliationJournalSchema(
        database,
        reportsTableSql,
        SLACK_RECONCILIATION_REPORT_ERRORS_TABLE_SQL,
      );
    },
  },
] as const;

function protocolGuardRows(
  database: DatabaseSync,
  names: readonly string[],
): unknown[] {
  const placeholders = names.map(() => "?").join(", ");
  return database
    .prepare(
      `SELECT name, tbl_name, sql
       FROM sqlite_schema
       WHERE type = 'trigger'
         AND name IN (${placeholders})
       ORDER BY name`,
    )
    .all(...names);
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
  it("does not infer an error receipt for a historical trace", async () => {
    const { database, d1 } = databaseReadyToSeal();
    const store = new D1DeliveryStore(d1);
    await store.insert(input("sqlite-historical-reconciliation-error"));
    database
      .prepare(
        `INSERT INTO slack_workflow_traces (
           trace_id, delivery_id, outcome, relay_attempt,
           send_boundary_reached, pre_send_failure_proven,
           started_at_us, completed_at_us, updated_at, applied_at
         ) VALUES (?, ?, 'error', 1, 0, 0, ?, ?, ?, ?)`,
      )
      .run(
        "TrHistoricalReconciliationError1",
        "sqlite-historical-reconciliation-error",
        NOW * 1_000 - 1,
        NOW * 1_000,
        NOW,
        NOW + 1,
      );
    applyMigrationAtomically(database, "0006_seal_slack_delivery_protocol.sql");
    applyMigrationAtomically(
      database,
      "0007_journal_slack_reconciliation_reports.sql",
    );

    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM slack_reconciliation_report_errors`,
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  it("atomically journals reconciliation novelty and its clamped checkpoint", async () => {
    const { database, d1 } = databaseWithReconciliationJournal();
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-journaled-reconciliation-error";
    const traceId = "TrJournaledReconciliationError1";
    const reportId = "a".repeat(64);
    const requestedCheckpointUs = (NOW + 100) * 1_000;
    await store.insert(input(deliveryId));
    database
      .prepare(
        `INSERT INTO slack_workflow_traces (
           trace_id, delivery_id, outcome, relay_attempt,
           send_boundary_reached, pre_send_failure_proven,
           started_at_us, completed_at_us, updated_at, applied_at
         ) VALUES (?, ?, 'error', 1, 0, 0, ?, ?, ?, ?)`,
      )
      .run(traceId, deliveryId, NOW * 1_000 - 1, NOW * 1_000, NOW, NOW);
    database.exec(`
      CREATE TRIGGER reject_reconciliation_journal
      BEFORE INSERT ON slack_reconciliation_reports
      BEGIN
        SELECT RAISE(ABORT, 'simulated_journal_failure');
      END;
    `);

    await expect(
      store.finalizeSlackReconciliationReport(
        reportId,
        1,
        [traceId],
        requestedCheckpointUs,
        NOW + 2,
      ),
    ).rejects.toThrow("simulated_journal_failure");
    expect(
      database
        .prepare(
          `SELECT slack_activity_checkpoint_us
           FROM relay_state WHERE singleton_id = 1`,
        )
        .get(),
    ).toEqual({ slack_activity_checkpoint_us: 0 });
    expect(
      database
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM slack_reconciliation_reports) AS reports,
             (SELECT COUNT(*) FROM slack_reconciliation_report_errors) AS errors`,
        )
        .get(),
    ).toEqual({ reports: 0, errors: 0 });

    database.exec("DROP TRIGGER reject_reconciliation_journal;");
    const committed = await store.finalizeSlackReconciliationReport(
      reportId,
      1,
      [traceId],
      requestedCheckpointUs,
      NOW + 3,
    );
    expect(committed).toEqual({
      traceCount: 1,
      changedErrorTraces: 1,
      requestedCheckpointUs,
      checkpointUs: NOW * 1_000,
    });
    await expect(
      store.finalizeSlackReconciliationReport(
        reportId,
        1,
        [traceId],
        requestedCheckpointUs,
        NOW + 4,
      ),
    ).resolves.toEqual(committed);
    await expect(
      store.finalizeSlackReconciliationReport(
        "b".repeat(64),
        1,
        [traceId],
        requestedCheckpointUs,
        NOW + 5,
      ),
    ).resolves.toMatchObject({ changedErrorTraces: 0 });
    database
      .prepare(
        `INSERT INTO slack_reconciliation_reports (
           report_id, trace_count, changed_error_traces,
           requested_checkpoint_us, checkpoint_us, completed_at
         ) VALUES (?, 0, 0, 0, 0, ?)`,
      )
      .run("c".repeat(64), NOW - 24 * 60 * 60 * 1_000 - 1);
    await store.finalizeSlackReconciliationReport(
      "d".repeat(64),
      0,
      [],
      requestedCheckpointUs,
      NOW + 6,
    );
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM slack_reconciliation_reports
           WHERE report_id = ?`,
        )
        .get("c".repeat(64)),
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare(
          `SELECT trace_id, report_id
           FROM slack_reconciliation_report_errors`,
        )
        .get(),
    ).toEqual({ trace_id: traceId, report_id: reportId });
  });

  it("keeps real D1 reconciliation boundaries constant from one to 25 traces", async () => {
    const reconcileAndCount = async (
      traceCount: 1 | 25,
    ): Promise<D1BoundaryCounts> => {
      const { database } = databaseWithReconciliationJournal();
      const boundaries = emptyD1BoundaryCounts();
      const store = new D1DeliveryStore(sqliteD1(database, boundaries));
      const traces = [];
      for (let index = 0; index < traceCount; index += 1) {
        const suffix = String(index + 1).padStart(2, "0");
        const deliveryId = `sqlite-boundary-budget-${traceCount}-${suffix}`;
        await store.insert(input(deliveryId));
        database
          .prepare(
            `UPDATE deliveries
             SET status = 'accepted_by_trigger', attempt_count = 1
             WHERE delivery_id = ?`,
          )
          .run(deliveryId);
        traces.push({
          traceId: `TrBoundaryBudget${traceCount}${suffix}`,
          deliveryId,
          outcome: "pending" as const,
          attemptCount: 1,
          sendExecutionId: null,
          slackChannelId: null,
          messageTs: null,
          sendBoundaryReached: false,
          preSendFailureProven: false,
          startedAtUs: NOW * 1_000 - index,
          completedAtUs: null,
        });
      }
      Object.assign(boundaries, emptyD1BoundaryCounts());

      await store.reconcileSlackReport({
        reportId: (traceCount === 1 ? "1" : "2").repeat(64),
        traces,
        checkpointUs: NOW * 1_000,
        scanState: "preserve",
        now: NOW,
      });
      return boundaries;
    };

    const oneTrace = await reconcileAndCount(1);
    const maximumTraces = await reconcileAndCount(25);

    expect(oneTrace).toEqual({ all: 1, batch: 1, first: 1, run: 0 });
    expect(maximumTraces).toEqual(oneTrace);
  });

  it("persists only the relay-acknowledged checkpoint for bounded scan resume", async () => {
    const { database, d1 } = databaseWithReconciliationJournal();
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-bounded-scan-checkpoint-clamp";
    await store.insert(input(deliveryId));

    const requestedCheckpointUs = (NOW + 100) * 1_000;
    const resumed = await store.reconcileSlackReport({
      reportId: "3".repeat(64),
      traces: [],
      checkpointUs: requestedCheckpointUs,
      scanState: "resume",
      now: NOW + 1,
    });

    expect(resumed).toMatchObject({
      requestedCheckpointUs,
      checkpointUs: NOW * 1_000,
    });
    await expect(store.getSlackActivityScanState()).resolves.toEqual({
      checkpointUs: NOW * 1_000,
      resumeFromUs: NOW * 1_000,
      pendingTraceIds: [],
      pendingTraceTotal: 0,
      pendingTraceOldestUs: null,
    });

    database
      .prepare("DELETE FROM deliveries WHERE delivery_id = ?")
      .run(deliveryId);
    await store.reconcileSlackReport({
      reportId: "4".repeat(64),
      traces: [],
      checkpointUs: requestedCheckpointUs,
      scanState: "complete",
      now: NOW + 2,
    });
    await expect(store.getSlackActivityScanState()).resolves.toEqual({
      checkpointUs: requestedCheckpointUs,
      resumeFromUs: null,
      pendingTraceIds: [],
      pendingTraceTotal: 0,
      pendingTraceOldestUs: null,
    });
  });

  it("rotates a bounded pending-trace checkpoint page fairly beyond its limit", async () => {
    const { database, d1 } = databaseWithReconciliationJournal();
    const store = new D1DeliveryStore(d1);
    const expectedIds: string[] = [];
    for (let index = 1; index <= 30; index += 1) {
      const suffix = String(index).padStart(2, "0");
      const deliveryId = `sqlite-hydration-fairness-${suffix}`;
      const traceId = `TrHydrationFairness${suffix}`;
      expectedIds.push(traceId);
      await store.insert(input(deliveryId));
      database
        .prepare(
          `INSERT INTO slack_workflow_traces (
             trace_id, delivery_id, outcome, relay_attempt,
             send_boundary_reached, pre_send_failure_proven,
             started_at_us, completed_at_us, updated_at, applied_at
           ) VALUES (?, ?, 'pending', 1, 0, 0, ?, NULL, ?, NULL)`,
        )
        .run(traceId, deliveryId, NOW * 1_000 - index, NOW + index);
    }

    const firstPage = [...expectedIds].reverse().slice(0, 25);
    await expect(store.getSlackActivityScanState()).resolves.toMatchObject({
      pendingTraceIds: firstPage,
      pendingTraceTotal: 30,
      pendingTraceOldestUs: NOW * 1_000 - 30,
    });

    await store.reconcileSlackReport({
      reportId: "5".repeat(64),
      traces: [],
      hydrations: firstPage.map((traceId) => {
        const sequence = Number.parseInt(traceId.slice(-2), 10);
        return {
          traceId,
          firstObservedUs: NOW * 1_000 - sequence,
          lastObservedUs: NOW * 1_000 - sequence,
          attempted: true,
          status: "pending" as const,
          debtReason: null,
        };
      }),
      checkpointUs: NOW * 1_000,
      scanState: "resume",
      now: NOW + 1_000,
    });

    await expect(store.getSlackActivityScanState()).resolves.toMatchObject({
      pendingTraceIds: [
        ...expectedIds.slice(0, 5).reverse(),
        ...firstPage.slice(0, 20),
      ],
      pendingTraceTotal: 30,
      pendingTraceOldestUs: NOW * 1_000 - 30,
    });
  });

  it("prioritizes a never-attempted pending hydration before attempted peers", async () => {
    const { d1 } = databaseWithReconciliationJournal();
    const store = new D1DeliveryStore(d1);
    const attemptedTraceIds = [
      "TrHydrationAttemptedA",
      "TrHydrationAttemptedB",
    ] as const;
    const neverAttemptedTraceId = "TrHydrationNeverAttemptedZ";
    const firstObservedUs = NOW * 1_000;

    await store.reconcileSlackReport({
      reportId: "e".repeat(64),
      traces: [],
      hydrations: [
        ...attemptedTraceIds.map((traceId, index) => ({
          traceId,
          firstObservedUs: firstObservedUs + index,
          lastObservedUs: firstObservedUs + index,
          attempted: true,
          status: "pending" as const,
          debtReason: null,
        })),
        {
          traceId: neverAttemptedTraceId,
          firstObservedUs: firstObservedUs + 2,
          lastObservedUs: firstObservedUs + 2,
          attempted: false,
          status: "pending",
          debtReason: null,
        },
      ],
      checkpointUs: firstObservedUs,
      scanState: "resume",
      now: NOW + 1,
    });

    await expect(store.getSlackActivityScanState()).resolves.toMatchObject({
      pendingTraceIds: [neverAttemptedTraceId, ...attemptedTraceIds],
      pendingTraceTotal: 3,
      pendingTraceOldestUs: firstObservedUs,
    });
  });

  it("orders normalized never-attempted traces by observation age before attempted peers", async () => {
    const { database, d1 } = databaseWithReconciliationJournal();
    const store = new D1DeliveryStore(d1);
    const attemptedTraceId = "TrHydrationAttemptedOld";
    const oldestNeverAttemptedTraceId = "TrHydrationNeverAttemptedZ";
    const newerNeverAttemptedTraceIds = Array.from(
      { length: 25 },
      (_, index) =>
        `TrHydrationNeverAttemptedA${String(index).padStart(2, "0")}`,
    );
    const oldestObservedUs = NOW * 1_000;

    await store.reconcileSlackReport({
      reportId: "a".repeat(64),
      traces: [],
      hydrations: [
        {
          traceId: attemptedTraceId,
          firstObservedUs: oldestObservedUs - 1,
          lastObservedUs: oldestObservedUs - 1,
          attempted: true,
          status: "pending",
          debtReason: null,
        },
      ],
      checkpointUs: oldestObservedUs,
      scanState: "resume",
      now: NOW,
    });

    for (const [index, traceId] of newerNeverAttemptedTraceIds.entries()) {
      database
        .prepare(
          `INSERT INTO slack_trace_hydration_registry (
             trace_id, first_observed_us, last_observed_us, last_hydrated_at,
             status, debt_reason, updated_at
           ) VALUES (?, ?, ?, 0, 'pending', NULL, ?)`,
        )
        .run(
          traceId,
          oldestObservedUs + index + 1,
          oldestObservedUs + index + 1,
          NOW + 1,
        );
    }

    const deliveryId = "sqlite-normalized-never-attempted";
    await store.insert(input(deliveryId));
    database
      .prepare(
        `INSERT INTO slack_workflow_traces (
           trace_id, delivery_id, outcome, relay_attempt,
           send_boundary_reached, pre_send_failure_proven,
           started_at_us, completed_at_us, updated_at, applied_at
         ) VALUES (?, ?, 'pending', 1, 0, 0, ?, NULL, ?, NULL)`,
      )
      .run(oldestNeverAttemptedTraceId, deliveryId, oldestObservedUs, NOW + 2);

    expect(
      database
        .prepare(
          `SELECT last_hydrated_at FROM slack_trace_hydration_registry
           WHERE trace_id = ?`,
        )
        .get(attemptedTraceId),
    ).toEqual({ last_hydrated_at: NOW });
    await expect(store.getSlackActivityScanState()).resolves.toMatchObject({
      pendingTraceIds: [
        oldestNeverAttemptedTraceId,
        ...newerNeverAttemptedTraceIds.slice(0, 24),
      ],
      pendingTraceTotal: 27,
      pendingTraceOldestUs: oldestObservedUs - 1,
    });
  });

  it("atomically moves an owned expired hydration to manual review and replays once", async () => {
    const { database, d1 } = databaseWithReconciliationJournal();
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-owned-hydration-debt";
    const traceId = "TrOwnedHydrationDebt1";
    const reportId = "8".repeat(64);
    const expiredUs = (NOW - 8 * 24 * 60 * 60 * 1_000) * 1_000;
    await store.insert(input(deliveryId));
    database
      .prepare(
        `UPDATE deliveries
         SET status = 'accepted_by_trigger', attempt_count = 1
         WHERE delivery_id = ?`,
      )
      .run(deliveryId);
    database
      .prepare(
        `INSERT INTO slack_workflow_traces (
           trace_id, delivery_id, outcome, relay_attempt,
           send_boundary_reached, pre_send_failure_proven,
           started_at_us, completed_at_us, updated_at, applied_at
         ) VALUES (?, ?, 'pending', 1, 0, 0, ?, NULL, ?, NULL)`,
      )
      .run(traceId, deliveryId, expiredUs, NOW);

    const request = {
      reportId,
      traces: [],
      hydrations: [
        {
          traceId,
          firstObservedUs: expiredUs,
          lastObservedUs: expiredUs + 1,
          attempted: true,
          status: "pending",
          debtReason: null,
        },
      ],
      checkpointUs: NOW * 1_000,
      scanState: "complete",
      now: NOW + 1,
    } as unknown as Parameters<typeof store.reconcileSlackReport>[0];
    const first = await store.reconcileSlackReport(request);
    const replay = await store.reconcileSlackReport(request);

    expect(replay).toEqual(first);
    expect(
      database
        .prepare(
          `SELECT status, last_error, slack_trace_id
           FROM deliveries WHERE delivery_id = ?`,
        )
        .get(deliveryId),
    ).toEqual({
      status: "manual_review",
      last_error: "slack_activity_trace_retention_expired",
      slack_trace_id: traceId,
    });
    expect(
      database
        .prepare(
          `SELECT applied_at FROM slack_workflow_traces WHERE trace_id = ?`,
        )
        .get(traceId),
    ).toEqual({ applied_at: NOW + 1 });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM slack_reconciliation_reports
           WHERE report_id = ?`,
        )
        .get(reportId),
    ).toEqual({ count: 1 });
    await expect(store.getSlackActivityScanState()).resolves.toMatchObject({
      pendingTraceIds: [],
      pendingTraceTotal: 0,
      pendingTraceOldestUs: null,
    });
  });

  it("keeps a delivered receipt stronger than owned expired hydration debt", async () => {
    const { database, d1 } = databaseWithReconciliationJournal();
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-delivered-hydration-debt";
    const traceId = "TrSqliteDeliveredHydrationDebt1";
    const expiredUs = (NOW - 8 * 24 * 60 * 60 * 1_000) * 1_000;
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
      functionExecutionId: "FxSqliteDeliveredHydrationSend1",
      now: NOW + 1,
      reconcileAt: NOW + 20 * 60 * 1_000,
    });
    await store.recordSlackTrace(
      {
        traceId,
        deliveryId,
        outcome: "pending",
        attemptCount: 1,
        sendExecutionId: "FxSqliteDeliveredHydrationSend1",
        destination: null,
        slackChannelId: null,
        messageTs: null,
        sendBoundaryReached: true,
        preSendFailureProven: false,
        startedAtUs: expiredUs,
        completedAtUs: null,
      },
      NOW + 2,
    );
    await store.recordSlackProgress({
      deliveryId,
      destination: "alerts",
      phase: "delivered",
      messageTs: "1785758400.001100",
      attemptCount: 1,
      functionExecutionId: "FxSqliteDeliveredHydrationSend1",
      now: NOW + 3,
      reconcileAt: NOW + 20 * 60 * 1_000,
    });

    await store.reconcileSlackReport({
      reportId: "f".repeat(64),
      traces: [],
      hydrations: [
        {
          traceId,
          firstObservedUs: expiredUs,
          lastObservedUs: expiredUs + 1,
          attempted: true,
          status: "debt",
          debtReason: "retention_expired",
        },
      ],
      checkpointUs: NOW * 1_000,
      scanState: "complete",
      now: NOW + 4,
    });

    expect(
      database
        .prepare(
          `SELECT status, last_error, slack_trace_id, slack_message_ts
           FROM deliveries WHERE delivery_id = ?`,
        )
        .get(deliveryId),
    ).toEqual({
      status: "delivered",
      last_error: null,
      slack_trace_id: null,
      slack_message_ts: "1785758400.001100",
    });
    expect(
      database
        .prepare(
          `SELECT outcome, applied_at FROM slack_workflow_traces
           WHERE trace_id = ?`,
        )
        .get(traceId),
    ).toEqual({ outcome: "pending", applied_at: NOW + 4 });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM slack_trace_hydration_registry
           WHERE trace_id = ?`,
        )
        .get(traceId),
    ).toEqual({ count: 0 });
  });

  it("durably quarantines ambiguous same-delivery hydration debt without inventing an owner", async () => {
    const { database, d1 } = databaseWithReconciliationJournal();
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-ambiguous-owned-hydration-debt";
    const traceIds = ["TrAmbiguousHydrationDebt1", "TrAmbiguousHydrationDebt2"];
    const reportId = "a".repeat(64);
    const expiredUs = (NOW - 8 * 24 * 60 * 60 * 1_000) * 1_000;
    await store.insert(input(deliveryId));
    database
      .prepare(
        `UPDATE deliveries
         SET status = 'accepted_by_trigger', attempt_count = 1
         WHERE delivery_id = ?`,
      )
      .run(deliveryId);
    const insertTrace = database.prepare(
      `INSERT INTO slack_workflow_traces (
         trace_id, delivery_id, outcome, relay_attempt,
         send_boundary_reached, pre_send_failure_proven,
         started_at_us, completed_at_us, updated_at, applied_at
       ) VALUES (?, ?, 'pending', 1, 0, 0, ?, NULL, ?, NULL)`,
    );
    for (const [index, traceId] of traceIds.entries()) {
      insertTrace.run(traceId, deliveryId, expiredUs + index, NOW);
    }

    const request = {
      reportId,
      traces: [],
      hydrations: traceIds.map((traceId, index) => ({
        traceId,
        firstObservedUs: expiredUs + index,
        lastObservedUs: expiredUs + index + 1,
        attempted: true,
        status: "debt" as const,
        debtReason: "retention_expired" as const,
      })),
      checkpointUs: NOW * 1_000,
      scanState: "complete" as const,
      now: NOW + 1,
    };
    const first = await store.reconcileSlackReport(request);
    const replay = await store.reconcileSlackReport(request);

    expect(replay).toEqual(first);
    expect(
      database
        .prepare(
          `SELECT status, last_error, slack_trace_id
           FROM deliveries WHERE delivery_id = ?`,
        )
        .get(deliveryId),
    ).toEqual({
      status: "manual_review",
      last_error: "slack_trace_hydration_owner_ambiguous",
      slack_trace_id: null,
    });
    expect(
      database
        .prepare(
          `SELECT trace_id, status, debt_reason
           FROM slack_trace_hydration_registry
           WHERE trace_id IN (?, ?)
           ORDER BY trace_id`,
        )
        .all(...traceIds),
    ).toEqual(
      traceIds.map((traceId) => ({
        trace_id: traceId,
        status: "debt",
        debt_reason: "retention_expired",
      })),
    );
    expect(
      database
        .prepare(
          `SELECT trace_id, applied_at
           FROM slack_workflow_traces
           WHERE trace_id IN (?, ?)
           ORDER BY trace_id`,
        )
        .all(...traceIds),
    ).toEqual(
      traceIds.map((traceId) => ({ trace_id: traceId, applied_at: null })),
    );
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM slack_reconciliation_reports
           WHERE report_id = ?`,
        )
        .get(reportId),
    ).toEqual({ count: 1 });
    await expect(store.claimForSlack(deliveryId, NOW + 2)).resolves.toBeNull();
    await expect(
      store.healthcheck(NOW + 2, SEALED_PROTOCOL_REVISION),
    ).resolves.toBe(false);
  });

  it("keeps authenticated receipt cleanup authoritative over a stale hydration report", async () => {
    const { database, d1 } = databaseWithReconciliationJournal();
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-receipt-after-ambiguous-hydration-debt";
    const traceIds = [
      "TrSqliteReceiptAfterHydrationDebt1",
      "TrSqliteReceiptAfterHydrationDebt2",
    ] as const;
    const functionExecutionId = "FxSqliteReceiptAfterHydrationDebt1";
    const messageTs = "1785758400.001101";
    const observedUs = (NOW - 1_000) * 1_000;

    await store.insert(input(deliveryId));
    await store.markQueued(deliveryId, NOW);
    await store.claimForSlack(deliveryId, NOW);
    await store.markAcceptedByTrigger(
      deliveryId,
      NOW,
      NOW + RECONCILIATION_RETRY_DELAY_MS,
    );
    await store.recordSlackProgress({
      deliveryId,
      destination: "alerts",
      phase: "send_started",
      messageTs: null,
      attemptCount: 1,
      functionExecutionId,
      now: NOW + 1,
      reconcileAt: NOW + RECONCILIATION_RETRY_DELAY_MS,
    });
    for (const [index, traceId] of traceIds.entries()) {
      await store.recordSlackTrace(
        {
          traceId,
          deliveryId,
          outcome: "pending",
          attemptCount: 1,
          sendExecutionId: null,
          destination: null,
          slackChannelId: null,
          messageTs: null,
          sendBoundaryReached: false,
          preSendFailureProven: false,
          startedAtUs: observedUs + index,
          completedAtUs: null,
        },
        NOW + 1,
      );
    }
    await store.reconcileSlackReport({
      reportId: "7".repeat(64),
      traces: [],
      hydrations: traceIds.map((traceId, index) => ({
        traceId,
        firstObservedUs: observedUs + index,
        lastObservedUs: observedUs + index + 1,
        attempted: true,
        status: "debt" as const,
        debtReason: "pagination_bound" as const,
      })),
      checkpointUs: NOW * 1_000,
      scanState: "complete",
      now: NOW + 2,
    });
    await expect(
      store.healthcheck(NOW + 2, SEALED_PROTOCOL_REVISION),
    ).resolves.toBe(false);

    const receipt = {
      deliveryId,
      destination: "alerts" as const,
      phase: "delivered" as const,
      messageTs,
      attemptCount: 1,
      functionExecutionId,
      now: NOW + 3,
      reconcileAt: NOW + RECONCILIATION_RETRY_DELAY_MS,
    };
    await expect(store.recordSlackProgress(receipt)).resolves.toBe("recorded");
    await expect(store.recordSlackProgress(receipt)).resolves.toBe("duplicate");

    expect(
      database
        .prepare(
          `SELECT status, last_error, slack_trace_id, slack_message_ts
           FROM deliveries WHERE delivery_id = ?`,
        )
        .get(deliveryId),
    ).toEqual({
      status: "delivered",
      last_error: null,
      slack_trace_id: null,
      slack_message_ts: messageTs,
    });
    expect(
      database
        .prepare(
          `SELECT trace_id, applied_at
           FROM slack_workflow_traces
           WHERE trace_id IN (?, ?)
           ORDER BY trace_id`,
        )
        .all(...traceIds),
    ).toEqual(
      traceIds.map((traceId) => ({
        trace_id: traceId,
        applied_at: NOW + 3,
      })),
    );
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM slack_trace_hydration_registry
           WHERE trace_id IN (?, ?)`,
        )
        .get(...traceIds),
    ).toEqual({ count: 0 });
    await expect(store.getSlackActivityScanState()).resolves.toMatchObject({
      pendingTraceIds: [],
      pendingTraceTotal: 0,
      pendingTraceOldestUs: null,
    });
    await expect(
      store.healthcheck(NOW + 3, SEALED_PROTOCOL_REVISION),
    ).resolves.toBe(true);

    const staleCheckpointUs = NOW * 1_000 + 100;
    const staleReport = {
      reportId: "8".repeat(64),
      traces: [],
      hydrations: [
        {
          traceId: traceIds[0],
          firstObservedUs: observedUs,
          lastObservedUs: observedUs + 1,
          attempted: true,
          status: "pending" as const,
          debtReason: null,
        },
      ],
      checkpointUs: staleCheckpointUs,
      scanState: "complete" as const,
      now: NOW + 4,
    };
    const stale = await store.reconcileSlackReport(staleReport);
    await expect(store.reconcileSlackReport(staleReport)).resolves.toEqual(
      stale,
    );

    expect(stale).toMatchObject({ checkpointUs: staleCheckpointUs });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM slack_trace_hydration_registry
           WHERE trace_id IN (?, ?)`,
        )
        .get(...traceIds),
    ).toEqual({ count: 0 });
    await expect(store.getSlackActivityScanState()).resolves.toMatchObject({
      pendingTraceIds: [],
      pendingTraceTotal: 0,
      pendingTraceOldestUs: null,
    });
    await expect(
      store.healthcheck(NOW + 4, SEALED_PROTOCOL_REVISION),
    ).resolves.toBe(true);
  });

  it("preserves ambiguity across sequential hydration debts for the same delivery", async () => {
    const { database, d1 } = databaseWithReconciliationJournal();
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-sequential-hydration-debt";
    const traceIds = [
      "TrSequentialHydrationDebt1",
      "TrSequentialHydrationDebt2",
    ] as const;
    const expiredUs = (NOW - 8 * 24 * 60 * 60 * 1_000) * 1_000;
    await store.insert(input(deliveryId));
    database
      .prepare(
        `UPDATE deliveries
         SET status = 'accepted_by_trigger', attempt_count = 1
         WHERE delivery_id = ?`,
      )
      .run(deliveryId);
    const insertTrace = database.prepare(
      `INSERT INTO slack_workflow_traces (
         trace_id, delivery_id, outcome, relay_attempt,
         send_boundary_reached, pre_send_failure_proven,
         started_at_us, completed_at_us, updated_at, applied_at
       ) VALUES (?, ?, 'pending', 1, 0, 0, ?, NULL, ?, NULL)`,
    );
    for (const [index, traceId] of traceIds.entries()) {
      insertTrace.run(traceId, deliveryId, expiredUs + index, NOW);
    }

    for (const [index, traceId] of traceIds.entries()) {
      await store.reconcileSlackReport({
        reportId: (index === 0 ? "b" : "c").repeat(64),
        traces: [],
        hydrations: [
          {
            traceId,
            firstObservedUs: expiredUs + index,
            lastObservedUs: expiredUs + index + 1,
            attempted: true,
            status: "pending",
            debtReason: null,
          },
        ],
        checkpointUs: NOW * 1_000,
        scanState: "complete",
        now: NOW + index + 1,
      });
    }

    expect(
      database
        .prepare(
          `SELECT status, last_error, slack_trace_id
           FROM deliveries WHERE delivery_id = ?`,
        )
        .get(deliveryId),
    ).toEqual({
      status: "manual_review",
      last_error: "slack_trace_hydration_owner_ambiguous",
      slack_trace_id: null,
    });
    expect(
      database
        .prepare(
          `SELECT trace_id, status, debt_reason
           FROM slack_trace_hydration_registry
           WHERE trace_id = ?`,
        )
        .get(traceIds[1]),
    ).toEqual({
      trace_id: traceIds[1],
      status: "debt",
      debt_reason: "retention_expired",
    });
    expect(
      database
        .prepare(
          `SELECT trace_id, applied_at
           FROM slack_workflow_traces
           WHERE trace_id IN (?, ?)
           ORDER BY trace_id`,
        )
        .all(...traceIds),
    ).toEqual([
      { trace_id: traceIds[0], applied_at: NOW + 1 },
      { trace_id: traceIds[1], applied_at: null },
    ]);
  });

  it("does not replace an applied terminal owner with pending hydration debt", async () => {
    const { database, d1 } = databaseWithReconciliationJournal();
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-terminal-owner-hydration-debt";
    const pendingTraceId = "TrPendingDebtBesideTerminal1";
    const terminalTraceId = "TrAppliedTerminalOwner1";
    const observedUs = NOW * 1_000;
    await store.insert(input(deliveryId));
    database
      .prepare(
        `UPDATE deliveries
         SET status = 'manual_review', attempt_count = 1,
             last_error = 'slack_workflow_failed_without_pre_send_proof',
             slack_trace_id = ?, updated_at = ?
         WHERE delivery_id = ?`,
      )
      .run(terminalTraceId, NOW, deliveryId);
    const insertTrace = database.prepare(
      `INSERT INTO slack_workflow_traces (
         trace_id, delivery_id, outcome, relay_attempt,
         send_boundary_reached, pre_send_failure_proven,
         started_at_us, completed_at_us, updated_at, applied_at
       ) VALUES (?, ?, ?, 1, 0, 0, ?, ?, ?, ?)`,
    );
    insertTrace.run(
      terminalTraceId,
      deliveryId,
      "error",
      observedUs - 2,
      observedUs - 1,
      NOW,
      NOW,
    );
    insertTrace.run(
      pendingTraceId,
      deliveryId,
      "pending",
      observedUs,
      null,
      NOW,
      null,
    );

    await store.reconcileSlackReport({
      reportId: "f".repeat(64),
      traces: [],
      hydrations: [
        {
          traceId: pendingTraceId,
          firstObservedUs: observedUs,
          lastObservedUs: observedUs + 1,
          attempted: true,
          status: "debt",
          debtReason: "pagination_bound",
        },
      ],
      checkpointUs: observedUs,
      scanState: "complete",
      now: NOW + 1,
    });

    expect(
      database
        .prepare(
          `SELECT status, last_error, slack_trace_id
           FROM deliveries WHERE delivery_id = ?`,
        )
        .get(deliveryId),
    ).toEqual({
      status: "manual_review",
      last_error: "slack_trace_hydration_owner_ambiguous",
      slack_trace_id: null,
    });
    expect(
      database
        .prepare(
          `SELECT trace_id, outcome, applied_at
           FROM slack_workflow_traces
           WHERE delivery_id = ? ORDER BY trace_id`,
        )
        .all(deliveryId),
    ).toEqual([
      { trace_id: terminalTraceId, outcome: "error", applied_at: NOW },
      { trace_id: pendingTraceId, outcome: "pending", applied_at: null },
    ]);
    expect(
      database
        .prepare(
          `SELECT trace_id, status, debt_reason
           FROM slack_trace_hydration_registry WHERE trace_id = ?`,
        )
        .get(pendingTraceId),
    ).toEqual({
      trace_id: pendingTraceId,
      status: "debt",
      debt_reason: "pagination_bound",
    });
  });

  it("preserves durable hydration ambiguity when terminal traces arrive later", async () => {
    const { database, d1 } = databaseWithReconciliationJournal();
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-late-terminal-hydration-ambiguity";
    const traceIds = [
      "TrLateTerminalAmbiguity1",
      "TrLateTerminalAmbiguity2",
    ] as const;
    const observedUs = NOW * 1_000;
    await store.insert(input(deliveryId));
    database
      .prepare(
        `UPDATE deliveries
         SET status = 'manual_review', attempt_count = 1,
             last_error = 'slack_trace_hydration_owner_ambiguous',
             slack_trace_id = NULL, updated_at = ?
         WHERE delivery_id = ?`,
      )
      .run(NOW, deliveryId);
    const insertTrace = database.prepare(
      `INSERT INTO slack_workflow_traces (
         trace_id, delivery_id, outcome, relay_attempt,
         send_boundary_reached, pre_send_failure_proven,
         started_at_us, completed_at_us, updated_at, applied_at
       ) VALUES (?, ?, 'pending', 1, 0, 0, ?, NULL, ?, NULL)`,
    );
    const insertHydration = database.prepare(
      `INSERT INTO slack_trace_hydration_registry (
         trace_id, first_observed_us, last_observed_us, last_hydrated_at,
         status, debt_reason, updated_at
       ) VALUES (?, ?, ?, ?, 'debt', 'pagination_bound', ?)`,
    );
    for (const [index, traceId] of traceIds.entries()) {
      insertTrace.run(traceId, deliveryId, observedUs + index, NOW);
      insertHydration.run(
        traceId,
        observedUs + index,
        observedUs + index,
        NOW,
        NOW,
      );
    }

    for (const [index, traceId] of traceIds.entries()) {
      await store.reconcileSlackReport({
        reportId: (index === 0 ? "6" : "7").repeat(64),
        traces: [
          {
            traceId,
            deliveryId,
            outcome: "error",
            attemptCount: 1,
            sendExecutionId: null,
            slackChannelId: null,
            messageTs: null,
            sendBoundaryReached: false,
            preSendFailureProven: false,
            startedAtUs: observedUs + index,
            completedAtUs: observedUs + index + 10,
          },
        ],
        hydrations: [],
        checkpointUs: observedUs + index + 10,
        scanState: "complete",
        now: NOW + index + 1,
      });

      expect(
        database
          .prepare(
            `SELECT status, last_error, slack_trace_id
             FROM deliveries WHERE delivery_id = ?`,
          )
          .get(deliveryId),
      ).toEqual({
        status: "manual_review",
        last_error: "slack_trace_hydration_owner_ambiguous",
        slack_trace_id: null,
      });
    }
    expect(
      database
        .prepare(
          `SELECT trace_id, outcome, applied_at
           FROM slack_workflow_traces
           WHERE delivery_id = ? ORDER BY trace_id`,
        )
        .all(deliveryId),
    ).toEqual(
      traceIds.map((traceId, index) => ({
        trace_id: traceId,
        outcome: "error",
        applied_at: NOW + index + 1,
      })),
    );
  });

  it("keeps hydration fairness timestamps monotonic across reordered reports", async () => {
    const { database, d1 } = databaseWithReconciliationJournal();
    const store = new D1DeliveryStore(d1);
    const traceId = "TrMonotonicHydrationFairness1";
    const observedUs = NOW * 1_000;
    const hydration = {
      traceId,
      firstObservedUs: observedUs,
      lastObservedUs: observedUs + 1,
      attempted: true,
      status: "pending" as const,
      debtReason: null,
    };

    await store.reconcileSlackReport({
      reportId: "4".repeat(64),
      traces: [],
      hydrations: [hydration],
      checkpointUs: observedUs,
      scanState: "preserve",
      now: NOW + 2,
    });
    await store.reconcileSlackReport({
      reportId: "5".repeat(64),
      traces: [],
      hydrations: [hydration],
      checkpointUs: observedUs,
      scanState: "preserve",
      now: NOW + 1,
    });

    expect(
      database
        .prepare(
          `SELECT last_hydrated_at, updated_at
           FROM slack_trace_hydration_registry WHERE trace_id = ?`,
        )
        .get(traceId),
    ).toEqual({ last_hydrated_at: NOW + 2, updated_at: NOW + 2 });
  });

  it("preserves a pending trace hydration until a terminal trace arrives", async () => {
    const { database, d1 } = databaseWithReconciliationJournal();
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-pending-trace-hydration";
    const traceId = "TrPendingTraceHydration1";
    const observedUs = NOW * 1_000;
    await store.insert(input(deliveryId));
    database
      .prepare(
        `UPDATE deliveries
         SET status = 'accepted_by_trigger', attempt_count = 1
         WHERE delivery_id = ?`,
      )
      .run(deliveryId);
    database
      .prepare(
        `INSERT INTO slack_trace_hydration_registry (
           trace_id, first_observed_us, last_observed_us, last_hydrated_at,
           status, debt_reason, updated_at
         ) VALUES (?, ?, ?, ?, 'pending', NULL, ?)`,
      )
      .run(traceId, observedUs - 1, observedUs, NOW, NOW);

    const pendingTrace = {
      traceId,
      deliveryId,
      outcome: "pending" as const,
      attemptCount: 1,
      sendExecutionId: null,
      slackChannelId: null,
      messageTs: null,
      sendBoundaryReached: false,
      preSendFailureProven: false,
      startedAtUs: observedUs,
      completedAtUs: null,
    };
    const pendingReport = {
      reportId: "e".repeat(64),
      traces: [pendingTrace],
      hydrations: [],
      checkpointUs: observedUs,
      scanState: "preserve" as const,
      now: NOW + 1,
    };

    const pending = await store.reconcileSlackReport(pendingReport);
    await expect(store.reconcileSlackReport(pendingReport)).resolves.toEqual(
      pending,
    );
    expect(
      database
        .prepare(
          `SELECT status, first_observed_us, last_observed_us
           FROM slack_trace_hydration_registry WHERE trace_id = ?`,
        )
        .get(traceId),
    ).toEqual({
      status: "pending",
      first_observed_us: observedUs - 1,
      last_observed_us: observedUs,
    });

    const terminalReport = {
      ...pendingReport,
      reportId: "f".repeat(64),
      traces: [
        {
          ...pendingTrace,
          outcome: "error" as const,
          completedAtUs: observedUs + 1,
        },
      ],
      checkpointUs: observedUs + 1,
      now: NOW + 2,
    };
    const terminal = await store.reconcileSlackReport(terminalReport);
    await expect(store.reconcileSlackReport(terminalReport)).resolves.toEqual(
      terminal,
    );
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM slack_trace_hydration_registry WHERE trace_id = ?`,
        )
        .get(traceId),
    ).toEqual({ count: 0 });
  });

  it("atomically removes a confirmed legacy trace from the hydration registry", async () => {
    const { database, d1 } = databaseWithReconciliationJournal();
    const store = new D1DeliveryStore(d1);
    const traceId = "TrConfirmedLegacyHydration1";
    const observedUs = NOW * 1_000;
    database
      .prepare(
        `INSERT INTO slack_trace_hydration_registry (
           trace_id, first_observed_us, last_observed_us, last_hydrated_at,
           status, debt_reason, updated_at
         ) VALUES (?, ?, ?, 0, 'pending', NULL, ?)`,
      )
      .run(traceId, observedUs - 1, observedUs, NOW);
    const request = {
      reportId: "9".repeat(64),
      traces: [],
      hydrations: [
        {
          traceId,
          firstObservedUs: observedUs - 1,
          lastObservedUs: observedUs,
          attempted: false,
          status: "legacy",
          debtReason: null,
        },
      ],
      checkpointUs: observedUs,
      scanState: "complete",
      now: NOW + 1,
    } as unknown as Parameters<typeof store.reconcileSlackReport>[0];

    const first = await store.reconcileSlackReport(request);
    const replay = await store.reconcileSlackReport(request);

    expect(replay).toEqual(first);
    expect(first).toMatchObject({ traceCount: 1, checkpointUs: observedUs });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM slack_trace_hydration_registry WHERE trace_id = ?`,
        )
        .get(traceId),
    ).toEqual({ count: 0 });
    await expect(store.getSlackActivityScanState()).resolves.toMatchObject({
      pendingTraceIds: [],
      pendingTraceTotal: 0,
      pendingTraceOldestUs: null,
    });
  });

  it("inherits first observed time from an existing normalized pending trace", async () => {
    const { database, d1 } = databaseWithReconciliationJournal();
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-normalized-first-observed";
    const traceId = "TrNormalizedFirstObserved1";
    const expiredUs = (NOW - 8 * 24 * 60 * 60 * 1_000) * 1_000;
    await store.insert(input(deliveryId));
    database
      .prepare(
        `UPDATE deliveries
         SET status = 'accepted_by_trigger', attempt_count = 1
         WHERE delivery_id = ?`,
      )
      .run(deliveryId);
    database
      .prepare(
        `INSERT INTO slack_workflow_traces (
           trace_id, delivery_id, outcome, relay_attempt,
           send_boundary_reached, pre_send_failure_proven,
           started_at_us, completed_at_us, updated_at, applied_at
         ) VALUES (?, ?, 'pending', 1, 0, 0, ?, NULL, ?, NULL)`,
      )
      .run(traceId, deliveryId, expiredUs, NOW);

    await store.reconcileSlackReport({
      reportId: "d".repeat(64),
      traces: [],
      hydrations: [
        {
          traceId,
          firstObservedUs: NOW * 1_000,
          lastObservedUs: NOW * 1_000,
          attempted: true,
          status: "pending",
          debtReason: null,
        },
      ],
      checkpointUs: NOW * 1_000,
      scanState: "complete",
      now: NOW + 1,
    });

    expect(
      database
        .prepare(
          `SELECT status, last_error, slack_trace_id
           FROM deliveries WHERE delivery_id = ?`,
        )
        .get(deliveryId),
    ).toEqual({
      status: "manual_review",
      last_error: "slack_activity_trace_retention_expired",
      slack_trace_id: traceId,
    });
    expect(
      database
        .prepare(
          `SELECT applied_at FROM slack_workflow_traces WHERE trace_id = ?`,
        )
        .get(traceId),
    ).toEqual({ applied_at: NOW + 1 });
  });

  it("accepts 127-character hydration trace IDs and rejects 128", () => {
    const { database } = databaseWithReconciliationJournal();
    const acceptedTraceId = `Tr${"a".repeat(125)}`;
    const rejectedTraceId = `Tr${"b".repeat(126)}`;
    const insertHydration = database.prepare(
      `INSERT INTO slack_trace_hydration_registry (
         trace_id, first_observed_us, last_observed_us, last_hydrated_at,
         status, debt_reason, updated_at
       ) VALUES (?, 1, 1, 1, 'pending', NULL, 1)`,
    );

    expect(() => insertHydration.run(acceptedTraceId)).not.toThrow();
    expect(() => insertHydration.run(rejectedTraceId)).toThrow();
  });

  it("persists an unowned hydration debt that blocks health without inventing an owner", async () => {
    const { database, d1 } = databaseWithReconciliationJournal();
    const store = new D1DeliveryStore(d1);
    const traceId = "TrUnownedHydrationDebt1";

    await store.reconcileSlackReport({
      reportId: "9".repeat(64),
      traces: [],
      hydrations: [
        {
          traceId,
          firstObservedUs: NOW * 1_000 - 7 * 24 * 60 * 60 * 1_000_000,
          lastObservedUs: NOW * 1_000 - 1,
          attempted: true,
          status: "debt",
          debtReason: "retention_expired",
        },
      ],
      checkpointUs: NOW * 1_000,
      scanState: "complete",
      now: NOW + 1,
    } as unknown as Parameters<typeof store.reconcileSlackReport>[0]);

    expect(
      database
        .prepare(
          `SELECT trace_id, status, debt_reason
           FROM slack_trace_hydration_registry WHERE trace_id = ?`,
        )
        .get(traceId),
    ).toEqual({
      trace_id: traceId,
      status: "debt",
      debt_reason: "retention_expired",
    });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM deliveries").get(),
    ).toEqual({ count: 0 });
    await expect(
      store.healthcheck(NOW + 2, SEALED_PROTOCOL_REVISION),
    ).resolves.toBe(false);
  });

  it("does not advance the checkpoint before an unresolved hydration becomes normalized or debt", async () => {
    const { database, d1 } = databaseWithReconciliationJournal();
    const store = new D1DeliveryStore(d1);
    const requestedCheckpointUs = NOW * 1_000;
    const traceId = "TrPendingHydrationCheckpoint1";

    const result = await store.reconcileSlackReport({
      reportId: "7".repeat(64),
      traces: [],
      hydrations: [
        {
          traceId,
          firstObservedUs: requestedCheckpointUs - 1,
          lastObservedUs: requestedCheckpointUs,
          attempted: true,
          status: "pending",
          debtReason: null,
        },
      ],
      checkpointUs: requestedCheckpointUs,
      scanState: "resume",
      now: NOW + 1,
    } as unknown as Parameters<typeof store.reconcileSlackReport>[0]);

    expect(result).toMatchObject({
      requestedCheckpointUs,
      checkpointUs: 0,
    });
    expect(
      database
        .prepare(
          `SELECT trace_id, status
           FROM slack_trace_hydration_registry WHERE trace_id = ?`,
        )
        .get(traceId),
    ).toEqual({ trace_id: traceId, status: "pending" });
  });

  it("rolls back checkpoint and scan resume state when the report journal fails", async () => {
    const { database, d1 } = databaseWithReconciliationJournal();
    const store = new D1DeliveryStore(d1);
    const initialCheckpointUs = NOW * 1_000;
    await store.reconcileSlackReport({
      reportId: "5".repeat(64),
      traces: [],
      checkpointUs: initialCheckpointUs,
      scanState: "resume",
      now: NOW,
    });
    database.exec(`
      CREATE TRIGGER reject_scan_state_journal
      BEFORE INSERT ON slack_reconciliation_reports
      BEGIN
        SELECT RAISE(ABORT, 'simulated_scan_state_journal_failure');
      END;
    `);

    await expect(
      store.reconcileSlackReport({
        reportId: "6".repeat(64),
        traces: [],
        checkpointUs: (NOW + 1) * 1_000,
        scanState: "complete",
        now: NOW + 1,
      }),
    ).rejects.toThrow("simulated_scan_state_journal_failure");
    await expect(store.getSlackActivityScanState()).resolves.toEqual({
      checkpointUs: initialCheckpointUs,
      resumeFromUs: initialCheckpointUs,
      pendingTraceIds: [],
      pendingTraceTotal: 0,
      pendingTraceOldestUs: null,
    });
  });

  it("rolls back the entire 25-trace reconciliation when the last trace fails", async () => {
    const { database, d1 } = databaseWithReconciliationJournal();
    const store = new D1DeliveryStore(d1);
    const traces = [];
    for (let index = 0; index < 25; index += 1) {
      const suffix = String(index + 1).padStart(2, "0");
      const deliveryId = `sqlite-atomic-reconciliation-${suffix}`;
      const sendExecutionId = `FxSqliteAtomicReconciliation${suffix}`;
      await store.insert(input(deliveryId));
      database
        .prepare(
          `UPDATE deliveries
           SET status = 'accepted_by_trigger', attempt_count = 1,
               slack_send_execution_id = ?
           WHERE delivery_id = ?`,
        )
        .run(sendExecutionId, deliveryId);
      traces.push({
        traceId: `TrAtomicBatch${suffix}`,
        deliveryId,
        outcome: "error" as const,
        attemptCount: 1,
        sendExecutionId,
        slackChannelId: null,
        messageTs: null,
        sendBoundaryReached: false,
        preSendFailureProven: true,
        startedAtUs: NOW * 1_000 - index,
        completedAtUs: NOW * 1_000,
      });
    }
    database.exec(`
      CREATE TRIGGER reject_last_atomic_reconciliation_trace
      BEFORE INSERT ON slack_workflow_traces
      WHEN NEW.trace_id = 'TrAtomicBatch25'
      BEGIN
        SELECT RAISE(ABORT, 'simulated_batch_failure');
      END;
    `);

    await expect(
      store.reconcileSlackReport({
        reportId: "f".repeat(64),
        traces,
        checkpointUs: NOW * 1_000,
        scanState: "preserve",
        now: NOW,
      }),
    ).rejects.toThrow("simulated_batch_failure");

    expect(
      database
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM slack_workflow_traces) AS traces,
             (SELECT COUNT(*) FROM slack_reconciliation_reports) AS reports,
             (SELECT COUNT(*) FROM slack_reconciliation_report_errors) AS errors,
             (SELECT slack_activity_checkpoint_us FROM relay_state
              WHERE singleton_id = 1) AS checkpoint_us,
             (SELECT COUNT(*) FROM deliveries
              WHERE status = 'accepted_by_trigger'
                AND slack_trace_id IS NULL
                AND last_error IS NULL) AS untouched_deliveries`,
        )
        .get(),
    ).toEqual({
      traces: 0,
      reports: 0,
      errors: 0,
      checkpoint_us: 0,
      untouched_deliveries: 25,
    });

    database.exec("DROP TRIGGER reject_last_atomic_reconciliation_trace;");
    const committed = await store.reconcileSlackReport({
      reportId: "f".repeat(64),
      traces,
      checkpointUs: NOW * 1_000,
      scanState: "preserve",
      now: NOW,
    });
    expect(committed).toEqual({
      traceCount: 25,
      changedErrorTraces: 25,
      requestedCheckpointUs: NOW * 1_000,
      checkpointUs: NOW * 1_000,
    });
    expect(
      database
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM slack_workflow_traces
              WHERE outcome = 'error' AND applied_at = ?) AS traces,
             (SELECT COUNT(*) FROM slack_reconciliation_reports) AS reports,
             (SELECT COUNT(*) FROM slack_reconciliation_report_errors) AS errors,
             (SELECT slack_activity_checkpoint_us FROM relay_state
              WHERE singleton_id = 1) AS checkpoint_us,
             (SELECT COUNT(*) FROM deliveries
              WHERE status = 'pending'
                AND last_error =
                    'slack_workflow_failed_before_send_boundary'
                AND slack_trace_id IS NOT NULL) AS reconciled_deliveries`,
        )
        .get(NOW),
    ).toEqual({
      traces: 25,
      reports: 1,
      errors: 25,
      checkpoint_us: NOW * 1_000,
      reconciled_deliveries: 25,
    });
    await expect(
      store.reconcileSlackReport({
        reportId: "f".repeat(64),
        traces,
        checkpointUs: NOW * 1_000,
        scanState: "preserve",
        now: NOW + 1,
      }),
    ).resolves.toEqual(committed);
  });

  it("atomically resolves an execution-owned Slack message with its journal", async () => {
    const { database, d1 } = databaseWithReconciliationJournal();
    const store = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-atomic-message-reconciliation";
    const sendExecutionId = "FxSqliteAtomicMessage1";
    const traceId = "TrSqliteAtomicMessage1";
    const messageTs = "1785758400.000321";
    await store.insert(input(deliveryId));
    database
      .prepare(
        `UPDATE deliveries
         SET status = 'send_started', attempt_count = 1,
             slack_send_execution_id = ?
         WHERE delivery_id = ?`,
      )
      .run(sendExecutionId, deliveryId);

    await expect(
      store.reconcileSlackReport({
        reportId: "e".repeat(64),
        traces: [
          {
            traceId,
            deliveryId: null,
            outcome: "error",
            attemptCount: null,
            sendExecutionId,
            slackChannelId: "C0BMUK793NV",
            messageTs,
            sendBoundaryReached: true,
            preSendFailureProven: false,
            startedAtUs: NOW * 1_000 - 1,
            completedAtUs: NOW * 1_000,
          },
        ],
        checkpointUs: NOW * 1_000,
        scanState: "complete",
        now: NOW,
      }),
    ).resolves.toEqual({
      traceCount: 1,
      changedErrorTraces: 1,
      requestedCheckpointUs: NOW * 1_000,
      checkpointUs: NOW * 1_000,
    });
    expect(
      database
        .prepare(
          `SELECT status, slack_message_ts, slack_trace_id,
                  slack_send_execution_id, last_error
           FROM deliveries WHERE delivery_id = ?`,
        )
        .get(deliveryId),
    ).toEqual({
      status: "delivered",
      slack_message_ts: messageTs,
      slack_trace_id: traceId,
      slack_send_execution_id: sendExecutionId,
      last_error: null,
    });
    expect(
      database
        .prepare(
          `SELECT outcome, slack_channel_id, slack_message_ts, applied_at
           FROM slack_workflow_traces WHERE trace_id = ?`,
        )
        .get(traceId),
    ).toEqual({
      outcome: "error",
      slack_channel_id: "C0BMUK793NV",
      slack_message_ts: messageTs,
      applied_at: NOW,
    });
  });

  it("rolls back a stale reconciliation plan when a competing trace wins the race", async () => {
    const { database, d1 } = databaseWithReconciliationJournal();
    const barrier = pauseBeforeFirstBatch(d1);
    const resolver = new D1DeliveryStore(barrier.d1);
    const mutator = new D1DeliveryStore(d1);
    const deliveryId = "sqlite-atomic-competing-trace";
    const sendExecutionId = "FxSqliteAtomicCompeting1";
    const reportTraceId = "TrSqliteAtomicCompetingReport1";
    const competingTraceId = "TrSqliteAtomicCompetingWinner1";
    await resolver.insert(input(deliveryId));
    database
      .prepare(
        `UPDATE deliveries
         SET status = 'accepted_by_trigger', attempt_count = 1,
             slack_send_execution_id = ?
         WHERE delivery_id = ?`,
      )
      .run(sendExecutionId, deliveryId);

    const reconciliation = resolver.reconcileSlackReport({
      reportId: "d".repeat(64),
      traces: [
        {
          traceId: reportTraceId,
          deliveryId,
          outcome: "error",
          attemptCount: 1,
          sendExecutionId,
          slackChannelId: null,
          messageTs: null,
          sendBoundaryReached: false,
          preSendFailureProven: true,
          startedAtUs: NOW * 1_000 - 1,
          completedAtUs: NOW * 1_000,
        },
      ],
      checkpointUs: NOW * 1_000,
      scanState: "preserve",
      now: NOW,
    });
    await barrier.reached;
    await mutator.recordSlackTrace(
      {
        traceId: competingTraceId,
        deliveryId,
        outcome: "pending",
        attemptCount: 1,
        sendExecutionId: null,
        destination: null,
        slackChannelId: null,
        messageTs: null,
        sendBoundaryReached: false,
        preSendFailureProven: false,
        startedAtUs: NOW * 1_000,
        completedAtUs: null,
      },
      NOW,
    );
    barrier.release();

    await expect(reconciliation).rejects.toThrow();
    expect(
      database
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM slack_workflow_traces
              WHERE trace_id = ?) AS report_trace,
             (SELECT COUNT(*) FROM slack_workflow_traces
              WHERE trace_id = ?) AS competing_trace,
             (SELECT COUNT(*) FROM slack_reconciliation_reports) AS reports,
             (SELECT status FROM deliveries WHERE delivery_id = ?) AS status`,
        )
        .get(reportTraceId, competingTraceId, deliveryId),
    ).toEqual({
      report_trace: 0,
      competing_trace: 1,
      reports: 0,
      status: "accepted_by_trigger",
    });
  });

  it("keeps migration guard SQL byte-exact with the runtime definitions", () => {
    const { database } = databaseReadyToSeal();
    const orderedTransient = [...TRANSIENT_SLACK_DELIVERY_PROTOCOL_GUARDS].sort(
      (left, right) => left.name.localeCompare(right.name),
    );

    expect(
      protocolGuardRows(
        database,
        orderedTransient.map(({ name }) => name),
      ),
    ).toEqual(
      orderedTransient.map(({ name, tableName, schemaSql }) => ({
        name,
        tbl_name: tableName,
        sql: schemaSql,
      })),
    );

    applyMigrationAtomically(database, "0006_seal_slack_delivery_protocol.sql");
    const orderedSealed = [...SEALED_SLACK_DELIVERY_PROTOCOL_GUARDS].sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    expect(
      protocolGuardRows(
        database,
        orderedSealed.map(({ name }) => name),
      ),
    ).toEqual(
      orderedSealed.map(({ name, tableName, schemaSql }) => ({
        name,
        tbl_name: tableName,
        sql: schemaSql,
      })),
    );
  });

  it("seals only the exact live protocol tuple and permits new valid Worker revisions", async () => {
    const { database, d1 } = databaseReadyToSeal();

    applyMigrationAtomically(database, "0006_seal_slack_delivery_protocol.sql");
    applyMigrationAtomically(
      database,
      "0007_journal_slack_reconciliation_reports.sql",
    );
    applyMigrationAtomically(
      database,
      "0008_resume_bounded_slack_activity_scan.sql",
    );
    applyMigrationAtomically(database, "0009_track_slack_trace_hydration.sql");
    const store = new D1DeliveryStore(d1);

    await expect(
      store.isSlackDeliveryProtocolActive("b".repeat(40)),
    ).resolves.toBe(true);
    await expect(store.healthcheck(NOW, "b".repeat(40))).resolves.toBe(true);
    await expect(
      store.isSlackDeliveryProtocolActive("not-a-worker-revision"),
    ).resolves.toBe(false);
    await expect(store.healthcheck(NOW, "not-a-worker-revision")).resolves.toBe(
      false,
    );

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
      slack_delivery_protocol_revision: SEALED_PROTOCOL_REVISION,
      slack_delivery_protocol_activated_at: SEALED_PROTOCOL_ACTIVATED_AT,
      slack_delivery_protocol_activation_id: SEALED_PROTOCOL_ACTIVATION_ID,
      slack_delivery_protocol_schema_revision:
        "0005_reconcile_live_slack_receipts",
      slack_delivery_protocol_confirmation_open: 0,
    });
    expect(
      database
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'trigger'
             AND name LIKE 'enforce_%slack_delivery_protocol%'
           ORDER BY name`,
        )
        .all(),
    ).toEqual([
      { name: "enforce_sealed_slack_delivery_protocol_delete" },
      { name: "enforce_sealed_slack_delivery_protocol_insert" },
      { name: "enforce_sealed_slack_delivery_protocol_update" },
    ]);

    database
      .prepare(
        "UPDATE relay_state SET next_slack_at = ? WHERE singleton_id = 1",
      )
      .run(NOW + 1);
    for (const mutation of [
      "singleton_id = 2",
      "slack_delivery_protocol_active = 0",
      `slack_delivery_protocol_revision = '${"b".repeat(40)}'`,
      `slack_delivery_protocol_activated_at = ${SEALED_PROTOCOL_ACTIVATED_AT + 1}`,
      `slack_delivery_protocol_activation_id = '${"2".repeat(64)}'`,
      "slack_delivery_protocol_schema_revision = '0004_confirm_slack_delivery'",
      "slack_delivery_protocol_confirmation_open = 1",
    ]) {
      expect(() =>
        database
          .prepare(`UPDATE relay_state SET ${mutation} WHERE singleton_id = 1`)
          .run(),
      ).toThrow("slack_delivery_protocol_is_sealed");
    }
    expect(() =>
      database.prepare("DELETE FROM relay_state WHERE singleton_id = 1").run(),
    ).toThrow("slack_delivery_protocol_is_sealed");
    expect(() =>
      database
        .prepare(
          `INSERT INTO relay_state (singleton_id, next_slack_at)
           VALUES (1, 0)`,
        )
        .run(),
    ).toThrow("slack_delivery_protocol_is_sealed");
    expect(() =>
      database
        .prepare(
          `INSERT OR REPLACE INTO relay_state (
             singleton_id, next_slack_at, slack_activity_checkpoint_us,
             slack_delivery_protocol_active,
             slack_delivery_protocol_revision,
             slack_delivery_protocol_activated_at,
             slack_delivery_protocol_activation_id,
             slack_delivery_protocol_schema_revision,
             slack_delivery_protocol_confirmation_open
           ) VALUES (1, 0, 0, 1, ?, ?, ?,
             '0005_reconcile_live_slack_receipts', 0)`,
        )
        .run(
          SEALED_PROTOCOL_REVISION,
          SEALED_PROTOCOL_ACTIVATED_AT,
          SEALED_PROTOCOL_ACTIVATION_ID,
        ),
    ).toThrow("slack_delivery_protocol_is_sealed");
  });

  it("rolls the seal migration back atomically for any divergent source tuple", () => {
    const { database } = databaseWithMigrations(true);
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
      .run("c".repeat(40), NOW, "4".repeat(64));

    expect(() =>
      applyMigrationAtomically(
        database,
        "0006_seal_slack_delivery_protocol.sql",
      ),
    ).toThrow();
    expect(
      database
        .prepare(
          `SELECT slack_delivery_protocol_revision,
                  slack_delivery_protocol_confirmation_open
           FROM relay_state WHERE singleton_id = 1`,
        )
        .get(),
    ).toEqual({
      slack_delivery_protocol_revision: "c".repeat(40),
      slack_delivery_protocol_confirmation_open: 1,
    });
    expect(
      database
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'trigger'
             AND name IN (
               'enforce_one_time_slack_delivery_protocol_revision_bridge',
               'enforce_one_way_slack_delivery_protocol_confirmation'
             ) ORDER BY name`,
        )
        .all(),
    ).toHaveLength(2);
    expect(
      database
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'trigger'
             AND name LIKE 'enforce_sealed_slack_delivery_protocol_%'`,
        )
        .all(),
    ).toEqual([]);
  });

  it("allows a sealed replay only when D1 recorded migration 0006", () => {
    const { database } = databaseReadyToSeal();
    applyMigrationAtomically(database, "0006_seal_slack_delivery_protocol.sql");

    expect(() =>
      applyMigrationAtomically(
        database,
        "0006_seal_slack_delivery_protocol.sql",
      ),
    ).toThrow();
    database
      .prepare("INSERT INTO d1_migrations (id, name) VALUES (6, ?)")
      .run("0006_seal_slack_delivery_protocol.sql");
    expect(() =>
      applyMigrationAtomically(
        database,
        "0006_seal_slack_delivery_protocol.sql",
      ),
    ).not.toThrow();
  });

  it("rejects a ledger-backed replay when a permanent guard kept its name but changed its body", () => {
    const { database } = databaseReadyToSeal();
    applyMigrationAtomically(database, "0006_seal_slack_delivery_protocol.sql");
    database
      .prepare("INSERT INTO d1_migrations (id, name) VALUES (6, ?)")
      .run("0006_seal_slack_delivery_protocol.sql");
    database.exec(`
      DROP TRIGGER enforce_sealed_slack_delivery_protocol_update;
      CREATE TRIGGER enforce_sealed_slack_delivery_protocol_update
      BEFORE UPDATE ON relay_state
      WHEN 0
      BEGIN
        SELECT 1;
      END;
    `);

    expect(() =>
      applyMigrationAtomically(
        database,
        "0006_seal_slack_delivery_protocol.sql",
      ),
    ).toThrow();
    expect(
      database
        .prepare(
          `SELECT sql FROM sqlite_schema
           WHERE type = 'trigger'
             AND name = 'enforce_sealed_slack_delivery_protocol_update'`,
        )
        .get(),
    ).toEqual({
      sql: expect.stringContaining("WHEN 0"),
    });
  });

  it("rolls back instead of hiding a missing transient source guard", () => {
    const { database } = databaseReadyToSeal();
    database.exec(
      "DROP TRIGGER enforce_one_way_slack_delivery_protocol_confirmation",
    );

    expect(() =>
      applyMigrationAtomically(
        database,
        "0006_seal_slack_delivery_protocol.sql",
      ),
    ).toThrow();
    expect(
      database
        .prepare(
          `SELECT slack_delivery_protocol_confirmation_open
           FROM relay_state WHERE singleton_id = 1`,
        )
        .get(),
    ).toEqual({ slack_delivery_protocol_confirmation_open: 1 });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS guard_count FROM sqlite_master
           WHERE type = 'trigger'
             AND name LIKE 'enforce_sealed_slack_delivery_protocol_%'`,
        )
        .get(),
    ).toEqual({ guard_count: 0 });
  });

  it.each([
    {
      drift: "an inert body",
      name: "enforce_one_way_slack_delivery_protocol_confirmation",
      sql: `CREATE TRIGGER enforce_one_way_slack_delivery_protocol_confirmation
BEFORE UPDATE OF slack_delivery_protocol_confirmation_open ON relay_state
WHEN 0
BEGIN
  SELECT 1;
END`,
    },
    {
      drift: "a whitespace-only body change",
      name: "enforce_one_time_slack_delivery_protocol_revision_bridge",
      sql: TRANSIENT_REVISION_BRIDGE_GUARD_SQL.replace(
        "BEFORE UPDATE OF",
        "BEFORE  UPDATE OF",
      ),
    },
  ])(
    "rolls back instead of replacing a transient source guard with $drift",
    ({ name, sql }) => {
      const { database } = databaseReadyToSeal();
      database.exec(`DROP TRIGGER ${name};\n${sql};`);

      expect(() =>
        applyMigrationAtomically(
          database,
          "0006_seal_slack_delivery_protocol.sql",
        ),
      ).toThrow();
      expect(
        database
          .prepare(
            `SELECT slack_delivery_protocol_confirmation_open
             FROM relay_state WHERE singleton_id = 1`,
          )
          .get(),
      ).toEqual({ slack_delivery_protocol_confirmation_open: 1 });
      expect(
        database
          .prepare(
            `SELECT sql FROM sqlite_schema
             WHERE type = 'trigger' AND name = ?`,
          )
          .get(name),
      ).toEqual({ sql });
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS guard_count FROM sqlite_schema
             WHERE type = 'trigger'
               AND name GLOB 'enforce_sealed_slack_delivery_protocol_*'`,
          )
          .get(),
      ).toEqual({ guard_count: 0 });
    },
  );

  it("rolls back when an unrelated trigger also targets relay_state", () => {
    const { database } = databaseReadyToSeal();
    database.exec(`
      CREATE TRIGGER unexpected_relay_state_blocker
      BEFORE UPDATE ON relay_state
      WHEN 0
      BEGIN
        SELECT 1;
      END;
    `);

    expect(() =>
      applyMigrationAtomically(
        database,
        "0006_seal_slack_delivery_protocol.sql",
      ),
    ).toThrow();
    expect(
      database
        .prepare(
          `SELECT slack_delivery_protocol_confirmation_open
           FROM relay_state WHERE singleton_id = 1`,
        )
        .get(),
    ).toEqual({ slack_delivery_protocol_confirmation_open: 1 });
    expect(
      database
        .prepare(
          `SELECT sql FROM sqlite_schema
           WHERE type = 'trigger' AND name = 'unexpected_relay_state_blocker'`,
        )
        .get(),
    ).toEqual({ sql: expect.stringContaining("WHEN 0") });
  });

  it("rejects a missing permanent seal guard", async () => {
    const { database, d1 } = databaseReadyToSeal();
    applyMigrationAtomically(database, "0006_seal_slack_delivery_protocol.sql");
    database.exec("DROP TRIGGER enforce_sealed_slack_delivery_protocol_delete");
    const store = new D1DeliveryStore(d1);

    await expect(
      store.isSlackDeliveryProtocolActive(TEST_REVISION),
    ).rejects.toThrow("slack_delivery_protocol_seal_incomplete");
    await expect(store.healthcheck(NOW, TEST_REVISION)).resolves.toBe(false);
  });

  it("rejects a permanent seal guard whose name is canonical but body is inert", async () => {
    const { database, d1 } = databaseReadyToSeal();
    applyMigrationAtomically(database, "0006_seal_slack_delivery_protocol.sql");
    database.exec(`
      DROP TRIGGER enforce_sealed_slack_delivery_protocol_update;
      CREATE TRIGGER enforce_sealed_slack_delivery_protocol_update
      BEFORE UPDATE ON relay_state
      WHEN 0
      BEGIN
        SELECT 1;
      END;
    `);
    const store = new D1DeliveryStore(d1);

    await expect(
      store.isSlackDeliveryProtocolActive(TEST_REVISION),
    ).rejects.toThrow("slack_delivery_protocol_seal_incomplete");
    await expect(store.healthcheck(NOW, TEST_REVISION)).resolves.toBe(false);
  });

  it("rejects any unexpected fourth trigger on relay_state", async () => {
    const { database, d1 } = databaseReadyToSeal();
    applyMigrationAtomically(database, "0006_seal_slack_delivery_protocol.sql");
    database.exec(`
      CREATE TRIGGER unexpected_relay_state_blocker
      BEFORE UPDATE ON relay_state
      WHEN 0
      BEGIN
        SELECT 1;
      END;
    `);
    const store = new D1DeliveryStore(d1);

    await expect(
      store.isSlackDeliveryProtocolActive(TEST_REVISION),
    ).rejects.toThrow("slack_delivery_protocol_seal_incomplete");
    await expect(store.healthcheck(NOW, TEST_REVISION)).resolves.toBe(false);
  });

  it("rejects open, divergent, and missing protocol state", async () => {
    const open = databaseReadyToSeal();
    const openStore = new D1DeliveryStore(open.d1);
    await expect(
      openStore.isSlackDeliveryProtocolActive(TEST_REVISION),
    ).rejects.toThrow("slack_delivery_protocol_state_inconsistent");
    await expect(openStore.healthcheck(NOW, TEST_REVISION)).resolves.toBe(
      false,
    );

    const divergent = databaseWithMigrations(true);
    divergent.database
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
      .run("c".repeat(40), NOW, "4".repeat(64));
    const divergentStore = new D1DeliveryStore(divergent.d1);
    await expect(
      divergentStore.isSlackDeliveryProtocolActive(TEST_REVISION),
    ).rejects.toThrow("slack_delivery_protocol_state_inconsistent");
    await expect(divergentStore.healthcheck(NOW, TEST_REVISION)).resolves.toBe(
      false,
    );

    const missing = databaseWithMigrations(true);
    missing.database.exec("DELETE FROM relay_state");
    await expect(
      new D1DeliveryStore(missing.d1).isSlackDeliveryProtocolActive(
        TEST_REVISION,
      ),
    ).rejects.toThrow("slack_delivery_protocol_state_missing");
  });

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
    const { d1 } = databaseWithReconciliationJournal();
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

  it("recognizes the migrated schema only after protocol sealing", async () => {
    const { database, d1 } = databaseReadyToSeal();
    const store = new D1DeliveryStore(d1);

    await expect(store.healthcheck(NOW, "e".repeat(40))).resolves.toBe(false);
    applyMigrationAtomically(database, "0006_seal_slack_delivery_protocol.sql");
    await expect(store.healthcheck(NOW, "e".repeat(40))).resolves.toBe(false);
    applyMigrationAtomically(
      database,
      "0007_journal_slack_reconciliation_reports.sql",
    );
    await expect(store.healthcheck(NOW, "e".repeat(40))).resolves.toBe(false);
    applyMigrationAtomically(
      database,
      "0008_resume_bounded_slack_activity_scan.sql",
    );
    await expect(store.healthcheck(NOW, "e".repeat(40))).resolves.toBe(false);
    applyMigrationAtomically(database, "0009_track_slack_trace_hydration.sql");
    await expect(store.healthcheck(NOW, "e".repeat(40))).resolves.toBe(true);
  });

  it("makes readiness fail when the reconciliation journal schema is absent", async () => {
    const { database, d1 } = databaseWithReconciliationJournal();
    const store = new D1DeliveryStore(d1);
    await expect(store.healthcheck(NOW, TEST_REVISION)).resolves.toBe(true);
    database.exec("DROP TABLE slack_reconciliation_reports;");
    await expect(store.healthcheck(NOW, TEST_REVISION)).resolves.toBe(false);
  });

  it("makes readiness fail when the report identifier is not the primary key", async () => {
    const { database, d1 } = databaseWithReconciliationJournal();
    const reportSql = database
      .prepare(
        `SELECT sql FROM sqlite_schema
         WHERE type = 'table' AND name = 'slack_reconciliation_reports'`,
      )
      .get() as { sql: string };
    const withoutPrimaryKey = reportSql.sql.replace(" PRIMARY KEY", "");
    expect(withoutPrimaryKey).not.toBe(reportSql.sql);
    database.exec(`
      DROP INDEX idx_slack_reconciliation_reports_completed;
      ALTER TABLE slack_reconciliation_reports
        RENAME TO slack_reconciliation_reports_reviewed;
      ${withoutPrimaryKey};
      CREATE INDEX idx_slack_reconciliation_reports_completed
        ON slack_reconciliation_reports (completed_at);
      DROP TABLE slack_reconciliation_reports_reviewed;
    `);
    const store = new D1DeliveryStore(d1);

    await expect(store.healthcheck(NOW, TEST_REVISION)).resolves.toBe(false);
  });

  it("makes readiness fail when the report identifier primary key is not text", async () => {
    const { database, d1 } = databaseWithReconciliationJournal();
    const reportSql = database
      .prepare(
        `SELECT sql FROM sqlite_schema
         WHERE type = 'table' AND name = 'slack_reconciliation_reports'`,
      )
      .get() as { sql: string };
    const integerPrimaryKey = reportSql.sql.replace(
      "report_id TEXT PRIMARY KEY",
      "report_id INTEGER PRIMARY KEY",
    );
    expect(integerPrimaryKey).not.toBe(reportSql.sql);
    database.exec(`
      DROP INDEX idx_slack_reconciliation_reports_completed;
      ALTER TABLE slack_reconciliation_reports
        RENAME TO slack_reconciliation_reports_reviewed;
      ${integerPrimaryKey};
      CREATE INDEX idx_slack_reconciliation_reports_completed
        ON slack_reconciliation_reports (completed_at);
      DROP TABLE slack_reconciliation_reports_reviewed;
    `);
    const store = new D1DeliveryStore(d1);

    await expect(store.healthcheck(NOW, TEST_REVISION)).resolves.toBe(false);
  });

  it.each([
    ...RECONCILIATION_SCHEMA_CHECK_MUTATIONS,
    RECONCILIATION_SCHEMA_EXTRA_FOREIGN_KEY,
  ])(
    "makes readiness fail when $name",
    async ({ reportsTableSql, reportErrorsTableSql }) => {
      const { database, d1 } = databaseWithReconciliationJournal();
      const store = new D1DeliveryStore(d1);
      await expect(store.healthcheck(NOW, TEST_REVISION)).resolves.toBe(true);

      replaceReconciliationJournalSchema(
        database,
        reportsTableSql,
        reportErrorsTableSql,
      );

      await expect(store.healthcheck(NOW, TEST_REVISION)).resolves.toBe(false);
    },
  );

  it.each(RECONCILIATION_SCHEMA_INVENTORY_MUTATIONS)(
    "makes readiness fail when $name",
    async ({ mutate }) => {
      const { database, d1 } = databaseWithReconciliationJournal();
      const store = new D1DeliveryStore(d1);
      await expect(store.healthcheck(NOW, TEST_REVISION)).resolves.toBe(true);

      mutate(database);

      await expect(store.healthcheck(NOW, TEST_REVISION)).resolves.toBe(false);
    },
  );

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
    const { database, d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM sqlite_master
           WHERE type = 'table'
             AND name = 'slack_trace_hydration_registry'`,
        )
        .get(),
    ).toEqual({ count: 0 });
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
    await expect(
      store.claimForSlack(deliveryId, secondAttemptAt),
    ).resolves.toBeNull();
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
    const { database, d1 } = databaseWithReconciliationJournal();
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
    database.exec(
      "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
    );
    seedLiveProtocolTuple(database);
    applyMigrationAtomically(database, "0006_seal_slack_delivery_protocol.sql");
    applyMigrationAtomically(
      database,
      "0007_journal_slack_reconciliation_reports.sql",
    );
    applyMigrationAtomically(
      database,
      "0008_resume_bounded_slack_activity_scan.sql",
    );
    applyMigrationAtomically(database, "0009_track_slack_trace_hydration.sql");
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
    await store.markAcceptedByTrigger(deliveryId, NOW, NOW + 20 * 60 * 1_000);

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
    const { database, d1 } = databaseWithReconciliationJournal();
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
    const { d1 } = databaseWithReconciliationJournal();
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
    await expect(store.claimForSlack(deliveryId, retryAt)).resolves.toBeNull();
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
