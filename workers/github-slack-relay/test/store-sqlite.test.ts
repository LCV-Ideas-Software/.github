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
  openDatabases.push(database);

  if (applyMigrations) {
    for (const migration of [
      "0001_initial.sql",
      "0002_add_destination.sql",
      "0003_rename_delivery_acceptance.sql",
    ]) {
      database.exec(
        readFileSync(
          new NodeUrl(`../migrations/${migration}`, import.meta.url),
          "utf8",
        ),
      );
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
  it("recognizes the migrated schema and relay_state singleton as usable", async () => {
    const { d1 } = databaseWithMigrations(true);
    const store = new D1DeliveryStore(d1);

    await expect(store.healthcheck()).resolves.toBe(true);
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

    await expect(store.healthcheck()).resolves.toBe(false);
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

    await expect(store.healthcheck()).resolves.toBe(false);
  });
});
