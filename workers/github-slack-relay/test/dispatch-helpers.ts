// Shared harness for the ADR-001 architectural REDs (R1-R20).
//
// Module surface pinned for the dispatcher implementation (tests import
// these paths; the implementation must land exactly here):
//   ../src/dispatch/contract   — types + constants (already present)
//   ../src/dispatch/classifier — classifyPostMessageOutcome(...)
//   ../src/dispatch/outbox     — D1DispatchStore implements DispatchStore
//   ../src/dispatch/resolver   — resolveAmbiguousRow(...), runResolverPass(...)
//   ../src/dispatch/consumer   — processDispatchMessage(...)
//   ../src/dispatch/observer   — observerAlarms(...)
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { URL as NodeUrl } from "node:url";

import { unstable_splitSqlQuery } from "wrangler";

export const DISPATCH_TEST_NOW = Date.parse("2026-08-15T12:00:00.000Z");

const SEALED_PROTOCOL_REVISION = "e0131a758123cf210d9cc9e7e537b72dc0441a90";
const SEALED_PROTOCOL_ACTIVATED_AT = 1_786_579_752_661;
const SEALED_PROTOCOL_ACTIVATION_ID =
  "18a94ba84d6bac0f8ae396996a5cd6ac026eb336be5eef702b92b3b6a60d4ff7";

const openDatabases: DatabaseSync[] = [];

export function closeDispatchDatabases(): void {
  for (const database of openDatabases.splice(0)) {
    try {
      database.close();
    } catch {
      // Already closed by the test.
    }
  }
}

export function migrationSource(name: string): string {
  return readFileSync(
    new NodeUrl(`../migrations/${name}`, import.meta.url),
    "utf8",
  );
}

export function migrationStatements(name: string): string[] {
  return unstable_splitSqlQuery(migrationSource(name));
}

function d1Result(changes: number, results: unknown[] = []): D1Result<unknown> {
  return {
    success: true,
    results,
    meta: { changes },
  } as unknown as D1Result<unknown>;
}

export function sqliteD1(database: DatabaseSync): D1Database {
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
            | Record<string, unknown>
            | undefined;
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

// Replays the FULL production migration chain 0001 -> 0011 the same way the
// existing store-sqlite harness does (d1_migrations bookkeeping table plus
// the live protocol tuple must exist before 0006 seals relay_state).
export function dispatchDatabase(): { database: DatabaseSync; d1: D1Database } {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  openDatabases.push(database);

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
    "0010_dispatch_outbox.sql",
    "0011_record_historical_dispositions.sql",
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

  return { database, d1: sqliteD1(database) };
}

// Full schema snapshot of the objects owned by migrations 0001-0009,
// used by R8 to prove the new migrations alter none of them.
export function legacySchemaSnapshot(database: DatabaseSync): string {
  const rows = database
    .prepare(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%'
         AND tbl_name NOT IN ('dispatch_outbox', 'dispatch_audit')
         AND name NOT IN ('d1_migrations')
       ORDER BY type, name`,
    )
    .all();
  return JSON.stringify(rows);
}

// ---------------------------------------------------------------------------
// Slack Web API response fixtures (shapes copied from official docs; the
// exact production metadata shape was proven live in F0 — issue #192
// comment 5297540210).
// ---------------------------------------------------------------------------

export interface FixtureResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export function slackPostOk(
  ts: string,
  channel = "C0BMUK793NV",
): FixtureResponse {
  return { status: 200, body: { ok: true, channel, ts } };
}

export function slackPostError(errorCode: string): FixtureResponse {
  return { status: 200, body: { ok: false, error: errorCode } };
}

export function slackRateLimited(retryAfterSeconds: number): FixtureResponse {
  return {
    status: 429,
    body: { ok: false, error: "ratelimited" },
    headers: { "Retry-After": String(retryAfterSeconds) },
  };
}

export interface FixtureHistoryMessage {
  ts: string;
  deliveryId?: string;
  eventType?: string;
  threadTs?: string;
}

export function historyMessage(
  input: FixtureHistoryMessage,
): Record<string, unknown> {
  return {
    type: "message",
    ts: input.ts,
    text: `fixture ${input.ts}`,
    ...(input.threadTs === undefined ? {} : { thread_ts: input.threadTs }),
    ...(input.deliveryId === undefined
      ? {}
      : {
          metadata: {
            event_type: input.eventType ?? "github_relay_delivery",
            event_payload: { delivery_id: input.deliveryId },
          },
        }),
  };
}

export function slackHistoryPage(
  messages: readonly Record<string, unknown>[],
  options?: { nextCursor?: string; hasMore?: boolean; omitMetadata?: boolean },
): FixtureResponse {
  const body: Record<string, unknown> = {
    ok: true,
    messages,
    has_more: options?.hasMore ?? false,
  };
  if (options?.omitMetadata !== true) {
    body["response_metadata"] = { next_cursor: options?.nextCursor ?? "" };
  }
  return { status: 200, body };
}

export function slackHistoryError(errorCode: string): FixtureResponse {
  return { status: 200, body: { ok: false, error: errorCode } };
}

// fetch stub that serves scripted responses per URL prefix and records every
// request (method, url, parsed body) for assertions.
export interface RecordedSlackCall {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

export function scriptedFetch(
  script: (
    url: string,
    body: Record<string, unknown> | null,
  ) => FixtureResponse | undefined,
): { fetch: typeof fetch; calls: RecordedSlackCall[] } {
  const calls: RecordedSlackCall[] = [];
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    let parsedBody: Record<string, unknown> | null = null;
    if (init?.body !== undefined && typeof init.body === "string") {
      try {
        parsedBody = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        parsedBody = null;
      }
    }
    calls.push({ url, method: init?.method ?? "GET", body: parsedBody });
    const scripted = script(url, parsedBody);
    if (scripted === undefined) {
      throw new Error(`unscripted_fetch:${url}`);
    }
    return new Response(JSON.stringify(scripted.body), {
      status: scripted.status,
      headers: { "Content-Type": "application/json", ...scripted.headers },
    });
  }) as typeof fetch;
  return { fetch: stub, calls };
}

export function outboxRow(
  database: DatabaseSync,
  deliveryId: string,
): Record<string, unknown> | undefined {
  return database
    .prepare("SELECT * FROM dispatch_outbox WHERE delivery_id = ?")
    .get(deliveryId) as Record<string, unknown> | undefined;
}

export function auditRows(
  database: DatabaseSync,
  deliveryId: string,
): Record<string, unknown>[] {
  return database
    .prepare(
      "SELECT * FROM dispatch_audit WHERE delivery_id = ? ORDER BY seq",
    )
    .all(deliveryId) as Record<string, unknown>[];
}
