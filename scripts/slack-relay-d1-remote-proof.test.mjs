import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertFinalSchema,
  createDisposableDatabase,
  DATABASE_NAME_PREFIX,
  deleteDatabaseWithConfirmation,
  DISPOSABLE_DATABASE_NAME_PATTERN,
  EXPECTED_FINAL_SCHEMA,
  INVENTORY_PAGE_SIZE,
  inventoryPageIsLast,
  listDatabases,
  MAX_REAP_PER_RUN,
  parseDisposableTimestamp,
  REMOTE_PROOF_MINIMUM_MARGIN_MS,
  selectStaleDisposables,
  STALE_DATABASE_AGE_MS,
  verifyRemoteProofDeadline,
} from "./verify-slack-relay-d1-remote.mjs";

// Configuração de fixture: identificadores obviamente falsos, nunca reais.
const FAKE_CONFIGURATION = Object.freeze({
  accountId: "0".repeat(32),
  apiToken: "token-de-teste-para-fixture",
});

test("the deadline gate fails closed on a missing or malformed value", () => {
  for (const environment of [{}, { REMOTE_PROOF_DEADLINE_MS: "" }, {
    REMOTE_PROOF_DEADLINE_MS: "not-a-number",
  }, { REMOTE_PROOF_DEADLINE_MS: "-5" }]) {
    assert.throws(
      () => verifyRemoteProofDeadline(environment, 1_000),
      /fail-closed deadline/u,
    );
  }
});

test("the deadline gate refuses to start without the minimum margin", () => {
  const now = 1_000_000;
  assert.throws(
    () =>
      verifyRemoteProofDeadline(
        {
          REMOTE_PROOF_DEADLINE_MS: String(
            now + REMOTE_PROOF_MINIMUM_MARGIN_MS - 1,
          ),
        },
        now,
      ),
    /margin/u,
  );
  assert.equal(
    verifyRemoteProofDeadline(
      {
        REMOTE_PROOF_DEADLINE_MS: String(
          now + REMOTE_PROOF_MINIMUM_MARGIN_MS,
        ),
      },
      now,
    ),
    now + REMOTE_PROOF_MINIMUM_MARGIN_MS,
  );
});

test("disposable database names carry the prefix, a timestamp, and entropy", () => {
  const name = `${DATABASE_NAME_PREFIX}1755000000000-0a1b2c3d`;
  assert.match(name, DISPOSABLE_DATABASE_NAME_PATTERN);
  assert.equal(parseDisposableTimestamp(name), 1_755_000_000_000);
  assert.equal(parseDisposableTimestamp("github-slack-alerts-db"), null);
  assert.equal(parseDisposableTimestamp(`${DATABASE_NAME_PREFIX}short-ff`), null);
});

test("the final-schema assertion accepts exactly the v2 surface", () => {
  assert.doesNotThrow(() => assertFinalSchema([...EXPECTED_FINAL_SCHEMA]));
});

test("the final-schema assertion ignores sqlite and Cloudflare internals", () => {
  assert.doesNotThrow(() =>
    assertFinalSchema([
      ...EXPECTED_FINAL_SCHEMA,
      { type: "index", name: "sqlite_autoindex_alert_delivery_1" },
      { type: "table", name: "_cf_KV" },
    ]),
  );
});

test("the final-schema assertion rejects a legacy leftover", () => {
  assert.throws(
    () =>
      assertFinalSchema([
        ...EXPECTED_FINAL_SCHEMA,
        { type: "table", name: "deliveries" },
      ]),
    /not the exact v2 surface/u,
  );
});

test("the final-schema assertion rejects a missing v2 object", () => {
  assert.throws(
    () =>
      assertFinalSchema(
        EXPECTED_FINAL_SCHEMA.filter(
          (entry) => entry.name !== "idx_alert_delivery_due",
        ),
      ),
    /not the exact v2 surface/u,
  );
});

test("inventoryPageIsLast reads the pagination signals correctly", () => {
  assert.equal(inventoryPageIsLast({}, 0, 0), true);
  assert.equal(inventoryPageIsLast({}, INVENTORY_PAGE_SIZE - 1, 999), true);
  assert.equal(
    inventoryPageIsLast(
      { total_count: INVENTORY_PAGE_SIZE },
      INVENTORY_PAGE_SIZE,
      INVENTORY_PAGE_SIZE,
    ),
    true,
  );
  assert.equal(
    inventoryPageIsLast(
      { total_count: INVENTORY_PAGE_SIZE + 1 },
      INVENTORY_PAGE_SIZE,
      INVENTORY_PAGE_SIZE,
    ),
    false,
  );
  assert.equal(inventoryPageIsLast({}, INVENTORY_PAGE_SIZE, INVENTORY_PAGE_SIZE), false);
  assert.equal(inventoryPageIsLast(undefined, INVENTORY_PAGE_SIZE, INVENTORY_PAGE_SIZE), false);
});

test("the D1 inventory traverses every page before concluding", async () => {
  const firstPage = Array.from({ length: INVENTORY_PAGE_SIZE }, (_, index) => ({
    name: `db-${index}`,
    uuid: `fake-${index}`,
  }));
  const secondPage = [{ name: "db-final", uuid: "fake-final" }];
  const requestedPaths = [];
  const requestFn = async (_configuration, path) => {
    requestedPaths.push(path);
    return requestedPaths.length === 1
      ? {
          result: firstPage,
          result_info: { total_count: INVENTORY_PAGE_SIZE + 1 },
        }
      : {
          result: secondPage,
          result_info: { total_count: INVENTORY_PAGE_SIZE + 1 },
        };
  };
  const databases = await listDatabases(FAKE_CONFIGURATION, requestFn);
  assert.equal(databases.length, INVENTORY_PAGE_SIZE + 1);
  assert.equal(requestedPaths.length, 2);
  assert.match(requestedPaths[0], /page=1/u);
  assert.match(requestedPaths[1], /page=2/u);
});

test("a runaway inventory fails closed instead of truncating silently", async () => {
  const fullPage = Array.from({ length: INVENTORY_PAGE_SIZE }, (_, index) => ({
    name: `db-${index}`,
    uuid: `fake-${index}`,
  }));
  await assert.rejects(
    () =>
      listDatabases(FAKE_CONFIGURATION, async () => ({
        result: fullPage,
        result_info: {},
      })),
    /partial read/u,
  );
});

test("selectStaleDisposables reaps oldest-first, caps the run, and reports the remainder", () => {
  const nowMs = 1_755_000_000_000 + 10 * STALE_DATABASE_AGE_MS;
  const staleName = (ageMultiplier) =>
    `${DATABASE_NAME_PREFIX}${String(nowMs - ageMultiplier * STALE_DATABASE_AGE_MS)}-00000000`;
  const databases = [
    { name: "github-slack-alerts-db", uuid: "fake-producao" },
    { name: staleName(2), uuid: "fake-a" },
    { name: `${DATABASE_NAME_PREFIX}${String(nowMs - 1_000)}-00000000`, uuid: "fake-fresco" },
    { name: staleName(4), uuid: "fake-b" },
    { name: staleName(3), uuid: "fake-c" },
  ];
  const selection = selectStaleDisposables(databases, nowMs, 2);
  assert.deepEqual(
    selection.stale.map((database) => database.uuid),
    ["fake-b", "fake-c"],
  );
  assert.equal(selection.deferredCount, 1);
  const uncapped = selectStaleDisposables(databases, nowMs);
  assert.equal(uncapped.stale.length, 3);
  assert.equal(uncapped.deferredCount, 0);
  assert.equal(MAX_REAP_PER_RUN >= 1, true);
});

test("an ambiguous creation failure deletes the orphan it may have left", async () => {
  const orphanId = "11111111-1111-4111-8111-111111111111";
  let capturedName = null;
  let orphanDeleted = false;
  const requestFn = async (_configuration, path, init = {}) => {
    const method = init.method ?? "GET";
    if (method === "POST") {
      capturedName = JSON.parse(init.body).name;
      throw new Error("simulated timeout after an accepted create");
    }
    if (method === "DELETE") {
      assert.match(path, new RegExp(`${orphanId}$`, "u"));
      orphanDeleted = true;
      return { success: true, result: null };
    }
    return {
      result: orphanDeleted
        ? []
        : [{ name: capturedName, uuid: orphanId }],
      result_info: {},
    };
  };
  await assert.rejects(
    () =>
      createDisposableDatabase(FAKE_CONFIGURATION, 1_755_000_000_000, requestFn),
    /simulated timeout/u,
  );
  assert.equal(orphanDeleted, true);
});

test("a final DELETE error is not authoritative when the database is already gone", async () => {
  const databaseId = "22222222-2222-4222-8222-222222222222";
  let deleteAttempts = 0;
  let listCalls = 0;
  const requestFn = async (_configuration, _path, init = {}) => {
    if ((init.method ?? "GET") === "DELETE") {
      deleteAttempts += 1;
      throw new Error("simulated delete failure");
    }
    listCalls += 1;
    return {
      result:
        listCalls <= 3 ? [{ name: "qualquer", uuid: databaseId }] : [],
      result_info: {},
    };
  };
  await deleteDatabaseWithConfirmation(
    FAKE_CONFIGURATION,
    databaseId,
    requestFn,
  );
  assert.equal(deleteAttempts, 4);
  assert.equal(listCalls, 4);
});

test("a final DELETE error with the database still listed propagates", async () => {
  const databaseId = "33333333-3333-4333-8333-333333333333";
  const requestFn = async (_configuration, _path, init = {}) => {
    if ((init.method ?? "GET") === "DELETE") {
      throw new Error("simulated delete failure");
    }
    return {
      result: [{ name: "qualquer", uuid: databaseId }],
      result_info: {},
    };
  };
  await assert.rejects(
    () =>
      deleteDatabaseWithConfirmation(FAKE_CONFIGURATION, databaseId, requestFn),
    /simulated delete failure/u,
  );
});
