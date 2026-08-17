import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  API_TIMEOUT_MS,
  assertAlertDeliveryStateConstraint,
  assertFinalSchema,
  assertInvalidAlertDeliveryStateWasRejected,
  assertSentAlertDeliveryStateWasAccepted,
  cloudflareRequest,
  createDisposableDatabase,
  DATABASE_ID_PATTERN,
  DATABASE_NAME_PREFIX,
  deadlineBoundedTimeout,
  deleteConfirmationBackoffMs,
  deleteDatabaseWithConfirmation,
  DISPOSABLE_DATABASE_NAME_PATTERN,
  EXPECTED_FINAL_SCHEMA,
  INVENTORY_PAGE_SIZE,
  inventoryPageIsLast,
  isDeadlineAbort,
  listDatabases,
  MAX_REAP_PER_RUN,
  parseDisposableTimestamp,
  partitionRemoteProofDeadline,
  reapStaleDisposables,
  REAPER_MINIMUM_MARGIN_MS,
  REMOTE_PROOF_CLEANUP_RESERVE_MS,
  REMOTE_PROOF_MINIMUM_MARGIN_MS,
  selectStaleDisposables,
  STALE_DATABASE_AGE_MS,
  verifyReaperDeadline,
  verifyRemoteProofDeadline,
} from "./verify-slack-relay-d1-remote.mjs";

// Configuração de fixture: identificadores obviamente falsos, nunca reais.
const FAKE_CONFIGURATION = Object.freeze({
  accountId: "0".repeat(32),
  apiToken: "token-de-teste-para-fixture",
});
const REAPER_WORKFLOW_URL = new URL(
  "../.github/workflows/slack-d1-disposable-reaper.yml",
  import.meta.url,
);
const REMOTE_PROOF_SOURCE_URL = new URL(
  "./verify-slack-relay-d1-remote.mjs",
  import.meta.url,
);

function fakeDatabase(index, name = `db-${String(index)}`) {
  return {
    name,
    uuid: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
  };
}

test("D1 database IDs require the canonical lowercase UUID grouping", () => {
  assert.equal(
    DATABASE_ID_PATTERN.test("00000000-0000-4000-8000-000000000001"),
    true,
  );
  for (const malformedId of [
    "-".repeat(36),
    "000000000000-4000-8000-000000000001",
    "00000000-0000-4000-8000-00000000001-",
    "00000000-0000-4000-8000-00000000000G",
  ]) {
    assert.equal(DATABASE_ID_PATTERN.test(malformedId), false, malformedId);
  }
});

test("the D1 inventory rejects a non-canonical database UUID", async () => {
  await assert.rejects(
    () =>
      listDatabases(FAKE_CONFIGURATION, async () => ({
        result: [{ name: "malformed", uuid: "-".repeat(36) }],
        result_info: { total_count: 1 },
      })),
    /D1 database UUID/u,
  );
});

test("the deadline gate fails closed on a missing or malformed value", () => {
  for (const environment of [
    {},
    { REMOTE_PROOF_DEADLINE_MS: "" },
    {
      REMOTE_PROOF_DEADLINE_MS: "not-a-number",
    },
    { REMOTE_PROOF_DEADLINE_MS: "-5" },
  ]) {
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
        REMOTE_PROOF_DEADLINE_MS: String(now + REMOTE_PROOF_MINIMUM_MARGIN_MS),
      },
      now,
    ),
    now + REMOTE_PROOF_MINIMUM_MARGIN_MS,
  );
});

test("the standalone reaper requires its own explicit deadline", () => {
  const now = 1_000_000;
  for (const environment of [
    {},
    { D1_REAPER_DEADLINE_MS: "" },
    {
      D1_REAPER_DEADLINE_MS: "not-a-number",
    },
  ]) {
    assert.throws(
      () => verifyReaperDeadline(environment, now),
      /D1_REAPER_DEADLINE_MS/u,
    );
  }
  assert.throws(
    () =>
      verifyReaperDeadline(
        {
          D1_REAPER_DEADLINE_MS: String(now + REAPER_MINIMUM_MARGIN_MS - 1),
        },
        now,
      ),
    /margin/u,
  );
  assert.equal(
    verifyReaperDeadline(
      {
        D1_REAPER_DEADLINE_MS: String(now + REAPER_MINIMUM_MARGIN_MS),
      },
      now,
    ),
    now + REAPER_MINIMUM_MARGIN_MS,
  );
});

test("remote requests are capped by the remaining deadline", () => {
  const now = 1_000_000;
  assert.equal(
    deadlineBoundedTimeout(undefined, now, API_TIMEOUT_MS),
    API_TIMEOUT_MS,
  );
  assert.equal(
    deadlineBoundedTimeout(now + API_TIMEOUT_MS * 2, now, API_TIMEOUT_MS),
    API_TIMEOUT_MS,
  );
  assert.equal(deadlineBoundedTimeout(now + 1_234, now, API_TIMEOUT_MS), 1_234);
  assert.throws(
    () => deadlineBoundedTimeout(now, now, API_TIMEOUT_MS),
    /deadline/u,
  );
});

test("DELETE confirmation backoff is deadline-bounded and absent after the final attempt", () => {
  const nowMs = 1_000_000;
  assert.equal(deleteConfirmationBackoffMs(0, nowMs + 100, nowMs), 100);
  assert.equal(deleteConfirmationBackoffMs(1, nowMs + 1_000, nowMs), 500);
  assert.equal(deleteConfirmationBackoffMs(3, nowMs - 1, nowMs), 0);
  assert.throws(
    () => deleteConfirmationBackoffMs(2, nowMs, nowMs),
    /deadline/u,
  );
});

test("only an abort from the absolute deadline is classified as deferred maintenance", () => {
  const timeoutError = new DOMException("timed out", "TimeoutError");
  const abortedSignal = AbortSignal.abort(timeoutError);
  assert.equal(isDeadlineAbort(timeoutError, abortedSignal, true), true);
  assert.equal(isDeadlineAbort(timeoutError, abortedSignal, false), false);
  assert.equal(
    isDeadlineAbort(
      new SyntaxError("malformed JSON fixture"),
      abortedSignal,
      true,
    ),
    false,
  );
});

test("a response body that fails after the deadline is classified as deferred maintenance", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => ({
    status: 200,
    json: async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      throw new DOMException("The operation was aborted", "AbortError");
    },
  });

  await assert.rejects(
    () =>
      cloudflareRequest(
        FAKE_CONFIGURATION,
        "/accounts/fake/d1/database",
        {},
        Date.now() + 10,
      ),
    /maintenance deadline/u,
  );
});

test("a response body that resolves after the absolute deadline is still rejected", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => ({
    status: 200,
    json: async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { success: true, result: [] };
    },
  });

  await assert.rejects(
    () =>
      cloudflareRequest(
        FAKE_CONFIGURATION,
        "/accounts/fake/d1/database",
        {},
        Date.now() + 10,
      ),
    /maintenance deadline/u,
  );
});

test("a non-abort body error remains visible even after the deadline", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => ({
    status: 200,
    json: async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      throw new SyntaxError("malformed JSON fixture");
    },
  });

  await assert.rejects(
    () =>
      cloudflareRequest(
        FAKE_CONFIGURATION,
        "/accounts/fake/d1/database",
        {},
        Date.now() + 10,
      ),
    /malformed JSON fixture/u,
  );
});

test("the proof stops work before cleanup and retains a live cleanup budget", () => {
  const now = 1_000_000;
  const proofDeadlineMs = now + 20 * 60_000;
  const { workDeadlineMs, reaperDeadlineMs, cleanupDeadlineMs } =
    partitionRemoteProofDeadline(proofDeadlineMs, now);
  assert.equal(
    cleanupDeadlineMs - workDeadlineMs,
    REMOTE_PROOF_CLEANUP_RESERVE_MS,
  );
  assert.ok(REMOTE_PROOF_CLEANUP_RESERVE_MS > 2 * 60_000);
  assert.ok(reaperDeadlineMs <= workDeadlineMs);
  assert.throws(
    () => deadlineBoundedTimeout(workDeadlineMs, workDeadlineMs),
    /deadline/u,
  );
  assert.equal(
    deadlineBoundedTimeout(cleanupDeadlineMs, workDeadlineMs),
    API_TIMEOUT_MS,
  );
});

test("the reaper workflow establishes an internal deadline before its ten-minute timeout", async () => {
  const source = await readFile(REAPER_WORKFLOW_URL, "utf8");
  assert.match(source, /timeout-minutes: 10/u);
  assert.match(source, /D1_REAPER_DEADLINE_MS/u);
  assert.match(source, /8 \* 60 \* 1000/u);
  const deadlineStep = source.indexOf(
    "Establish the fail-closed reaper deadline",
  );
  const checkoutStep = source.indexOf(
    "Checkout default branch without persisted credentials",
  );
  const reaperStep = source.indexOf("Reap stale disposable D1 proof databases");
  assert.notEqual(deadlineStep, -1);
  assert.notEqual(checkoutStep, -1);
  assert.notEqual(reaperStep, -1);
  assert.ok(deadlineStep < checkoutStep);
  assert.ok(deadlineStep < reaperStep);
});

test("the remote proof creates its local cleanup scope before the remote database", async () => {
  const source = await readFile(REMOTE_PROOF_SOURCE_URL, "utf8");
  const start = source.indexOf("export async function proveRemoteMigration");
  const end = source.indexOf(
    "export async function reapStaleDisposablesOnly",
    start,
  );
  const proof = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  const localScope = proof.indexOf("await mkdtemp(");
  const cleanupScope = proof.indexOf("try {", localScope);
  const remoteCreation = proof.indexOf("await createDisposableDatabase(");
  const cleanupFinally = proof.indexOf("} finally {", remoteCreation);
  const localCleanup = proof.indexOf(
    "await rm(temporaryDirectory",
    cleanupFinally,
  );
  assert.notEqual(localScope, -1);
  assert.notEqual(cleanupScope, -1);
  assert.notEqual(remoteCreation, -1);
  assert.notEqual(cleanupFinally, -1);
  assert.notEqual(localCleanup, -1);
  assert.ok(
    localScope < cleanupScope &&
      cleanupScope < remoteCreation &&
      remoteCreation < cleanupFinally &&
      cleanupFinally < localCleanup,
    "remote D1 creation must remain inside the local cleanup try/finally",
  );
});

test("the remote roundtrip rejects an arbitrary state before accepting sent", async () => {
  const source = await readFile(REMOTE_PROOF_SOURCE_URL, "utf8");
  const start = source.indexOf("async function proveAlertDeliveryRoundtrip");
  const end = source.indexOf(
    "export async function proveRemoteMigration",
    start,
  );
  const roundtrip = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  const arbitraryProbe = roundtrip.indexOf("SET state = 'unexpected'");
  const arbitraryAssertion = roundtrip.indexOf(
    "assertInvalidAlertDeliveryStateWasRejected(rejectedArbitraryStateRows)",
  );
  const sentTransition = roundtrip.indexOf("SET state = 'sent'");
  assert.ok(
    arbitraryProbe >= 0 &&
      arbitraryProbe < arbitraryAssertion &&
      arbitraryAssertion < sentTransition,
    "an arbitrary out-of-contract state must be rejected before sent is accepted",
  );
});

test("disposable database names carry the prefix, a timestamp, and entropy", () => {
  const name = `${DATABASE_NAME_PREFIX}1755000000000-0a1b2c3d`;
  assert.match(name, DISPOSABLE_DATABASE_NAME_PATTERN);
  assert.equal(parseDisposableTimestamp(name), 1_755_000_000_000);
  assert.equal(parseDisposableTimestamp("github-slack-alerts-db"), null);
  assert.equal(
    parseDisposableTimestamp(`${DATABASE_NAME_PREFIX}short-ff`),
    null,
  );
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

test("the alert_delivery definition requires the exact pending/sent CHECK", () => {
  assert.doesNotThrow(() =>
    assertAlertDeliveryStateConstraint([
      {
        sql: `CREATE TABLE alert_delivery (
          delivery_id TEXT PRIMARY KEY,
          state TEXT NOT NULL CHECK (state IN ('pending', 'sent'))
        )`,
      },
    ]),
  );
  for (const rows of [
    [],
    [{ sql: null }],
    [{ sql: "CREATE TABLE alert_delivery (state TEXT NOT NULL)" }],
    [
      {
        sql: "CREATE TABLE alert_delivery (state TEXT NOT NULL CHECK (state IN ('pending', 'sent', 'parked')))",
      },
    ],
    [
      {
        sql: `CREATE TABLE alert_delivery (
          state TEXT NOT NULL
          /* CHECK (state IN ('pending', 'sent')) */
        )`,
      },
    ],
    [
      {
        sql: `CREATE TABLE alert_delivery (
          state TEXT NOT NULL
          -- CHECK (state IN ('pending', 'sent'))
        )`,
      },
    ],
    [
      {
        sql: `CREATE TABLE alert_delivery (
          state TEXT NOT NULL CHECK (state IN ('pending', 'sent')) COLLATE NOCASE
        )`,
      },
    ],
    [
      {
        sql: `CREATE TABLE alert_delivery (
          "state TEXT NOT NULL CHECK (state IN ('pending', 'sent'))," TEXT,
          state TEXT NOT NULL CHECK (state <> 'parked' AND state <> 'PENDING')
        )`,
      },
    ],
  ]) {
    assert.throws(
      () => assertAlertDeliveryStateConstraint(rows),
      /definition|pending\/sent state constraint/u,
    );
  }
});

test("the alert_delivery behavioral proof rejects an out-of-contract state", () => {
  assert.doesNotThrow(() =>
    assertInvalidAlertDeliveryStateWasRejected([{ state: "pending" }]),
  );
  for (const rows of [[], [{ state: "parked" }], [{ state: "sent" }]]) {
    assert.throws(
      () => assertInvalidAlertDeliveryStateWasRejected(rows),
      /accepted a state outside pending\/sent/u,
    );
  }
  assert.doesNotThrow(() =>
    assertSentAlertDeliveryStateWasAccepted([{ state: "sent" }]),
  );
  for (const rows of [[], [{ state: "pending" }], [{ state: "parked" }]]) {
    assert.throws(
      () => assertSentAlertDeliveryStateWasAccepted(rows),
      /rejected the required sent state/u,
    );
  }
});

test("inventoryPageIsLast reads the pagination signals correctly", () => {
  assert.equal(inventoryPageIsLast({}, 0, 0), true);
  assert.throws(
    () => inventoryPageIsLast({}, INVENTORY_PAGE_SIZE - 1, 999),
    /non-empty short D1 inventory page/u,
  );
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
  assert.equal(
    inventoryPageIsLast({}, INVENTORY_PAGE_SIZE, INVENTORY_PAGE_SIZE),
    false,
  );
  assert.equal(
    inventoryPageIsLast(undefined, INVENTORY_PAGE_SIZE, INVENTORY_PAGE_SIZE),
    false,
  );
  assert.throws(
    () => inventoryPageIsLast(undefined, 1, 1),
    /non-empty short D1 inventory page/u,
  );
  assert.throws(
    () => inventoryPageIsLast({ total_count: 1_001 }, 1, 1),
    /short D1 inventory page/u,
  );
  assert.throws(
    () =>
      inventoryPageIsLast(
        { total_count: INVENTORY_PAGE_SIZE - 1 },
        INVENTORY_PAGE_SIZE,
        INVENTORY_PAGE_SIZE,
      ),
    /exceeds total_count/u,
  );
  assert.throws(
    () =>
      inventoryPageIsLast(
        { total_count: null },
        INVENTORY_PAGE_SIZE,
        INVENTORY_PAGE_SIZE,
      ),
    /total_count/u,
  );
});

test("the D1 inventory traverses every page before concluding", async () => {
  const firstPage = Array.from({ length: INVENTORY_PAGE_SIZE }, (_, index) =>
    fakeDatabase(index),
  );
  const secondPage = [fakeDatabase(INVENTORY_PAGE_SIZE, "db-final")];
  const requestedPaths = [];
  const propagatedDeadlines = [];
  const deadlineMs = Date.now() + 60_000;
  const requestFn = async (_configuration, path, _init, propagatedDeadline) => {
    requestedPaths.push(path);
    propagatedDeadlines.push(propagatedDeadline);
    return requestedPaths.length === 1
      ? {
          result: firstPage,
          result_info: {
            count: INVENTORY_PAGE_SIZE,
            page: 1,
            per_page: INVENTORY_PAGE_SIZE,
            total_count: INVENTORY_PAGE_SIZE + 1,
          },
        }
      : {
          result: secondPage,
          result_info: {
            count: 1,
            page: 2,
            per_page: INVENTORY_PAGE_SIZE,
            total_count: INVENTORY_PAGE_SIZE + 1,
          },
        };
  };
  const databases = await listDatabases(
    FAKE_CONFIGURATION,
    requestFn,
    deadlineMs,
  );
  assert.equal(databases.length, INVENTORY_PAGE_SIZE + 1);
  assert.equal(requestedPaths.length, 2);
  assert.match(requestedPaths[0], /page=1/u);
  assert.match(requestedPaths[1], /page=2/u);
  assert.deepEqual(propagatedDeadlines, [deadlineMs, deadlineMs]);
});

test("without total_count the D1 inventory requires an empty terminal page", async () => {
  let page = 0;
  const firstPage = Array.from({ length: INVENTORY_PAGE_SIZE }, (_, index) =>
    fakeDatabase(index),
  );
  const databases = await listDatabases(FAKE_CONFIGURATION, async () => {
    page += 1;
    return page === 1
      ? { result: firstPage, result_info: {} }
      : { result: [], result_info: {} };
  });
  assert.equal(page, 2);
  assert.deepEqual(databases, firstPage);
});

test("without total_count a non-empty short page fails before requesting a page that could skip entries", async () => {
  let page = 0;
  await assert.rejects(
    () =>
      listDatabases(FAKE_CONFIGURATION, async () => {
        page += 1;
        return { result: [fakeDatabase(0)], result_info: {} };
      }),
    /non-empty short D1 inventory page/u,
  );
  assert.equal(page, 1);
});

test("the D1 inventory rejects contradictory optional pagination metadata", async () => {
  const cases = [
    {
      resultInfo: { count: 2 },
      pattern: /result_info.count/u,
    },
    {
      resultInfo: { page: 2 },
      pattern: /result_info.page/u,
    },
    {
      resultInfo: { per_page: INVENTORY_PAGE_SIZE - 1 },
      pattern: /result_info.per_page/u,
    },
    {
      resultInfo: { total_count: 2 },
      pattern: /short D1 inventory page/u,
    },
  ];
  for (const { resultInfo, pattern } of cases) {
    await assert.rejects(
      () =>
        listDatabases(FAKE_CONFIGURATION, async () => ({
          result: [fakeDatabase(0)],
          result_info: resultInfo,
        })),
      pattern,
    );
  }
});

test("the D1 inventory rejects total_count drift across pages", async () => {
  const firstPage = Array.from({ length: INVENTORY_PAGE_SIZE }, (_, index) =>
    fakeDatabase(index),
  );
  let page = 0;
  await assert.rejects(
    () =>
      listDatabases(FAKE_CONFIGURATION, async () => {
        page += 1;
        return page === 1
          ? {
              result: firstPage,
              result_info: { total_count: INVENTORY_PAGE_SIZE + 1 },
            }
          : {
              result: [fakeDatabase(INVENTORY_PAGE_SIZE)],
              result_info: { total_count: INVENTORY_PAGE_SIZE + 2 },
            };
      }),
    /total_count changed/u,
  );
});

test("the D1 inventory rejects an overlapping or repeated page", async () => {
  const repeatedPage = Array.from({ length: INVENTORY_PAGE_SIZE }, (_, index) =>
    fakeDatabase(index),
  );
  await assert.rejects(
    () =>
      listDatabases(FAKE_CONFIGURATION, async () => ({
        result: repeatedPage,
        result_info: { total_count: INVENTORY_PAGE_SIZE * 2 },
      })),
    /duplicate D1 database UUID/u,
  );
});

test("an expired inventory deadline fails before issuing another request", async () => {
  let requestCount = 0;
  await assert.rejects(
    () =>
      listDatabases(
        FAKE_CONFIGURATION,
        async () => {
          requestCount += 1;
          return { result: [], result_info: {} };
        },
        Date.now() - 1,
      ),
    /deadline/u,
  );
  assert.equal(requestCount, 0);
});

test("an expired creation deadline fails before POST or orphan reconciliation", async () => {
  let requestCount = 0;
  await assert.rejects(
    () =>
      createDisposableDatabase(
        FAKE_CONFIGURATION,
        1_755_000_000_000,
        async () => {
          requestCount += 1;
          throw new Error("must not be called");
        },
        Date.now() - 1,
      ),
    /deadline/u,
  );
  assert.equal(requestCount, 0);
});

test("a runaway inventory fails closed instead of truncating silently", async () => {
  let page = 0;
  await assert.rejects(
    () =>
      listDatabases(FAKE_CONFIGURATION, async () => {
        const offset = page * INVENTORY_PAGE_SIZE;
        page += 1;
        return {
          result: Array.from({ length: INVENTORY_PAGE_SIZE }, (_, index) =>
            fakeDatabase(offset + index),
          ),
          result_info: {},
        };
      }),
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
    {
      name: `${DATABASE_NAME_PREFIX}${String(nowMs - 1_000)}-00000000`,
      uuid: "fake-fresco",
    },
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

test("the stale reaper propagates its deadline through inventory, DELETE, and confirmation", async () => {
  const nowMs = 1_755_000_000_000 + 4 * STALE_DATABASE_AGE_MS;
  const database = fakeDatabase(
    42,
    `${DATABASE_NAME_PREFIX}${String(nowMs - 4 * STALE_DATABASE_AGE_MS)}-00000000`,
  );
  const deadlineMs = Date.now() + 60_000;
  const propagatedDeadlines = [];
  let deleted = false;
  const requestFn = async (_configuration, _path, init = {}, deadline) => {
    propagatedDeadlines.push(deadline);
    if ((init.method ?? "GET") === "DELETE") {
      deleted = true;
      return { success: true, result: null };
    }
    return {
      result: deleted ? [] : [database],
      result_info: {
        count: deleted ? 0 : 1,
        page: 1,
        per_page: 1000,
        total_count: deleted ? 0 : 1,
      },
    };
  };
  const result = await reapStaleDisposables(
    FAKE_CONFIGURATION,
    nowMs,
    requestFn,
    deadlineMs,
  );
  assert.deepEqual(result, { reapedCount: 1, deferredCount: 0 });
  assert.equal(deleted, true);
  assert.equal(propagatedDeadlines.length, 3);
  assert.equal(
    propagatedDeadlines.every((value) => value === deadlineMs),
    true,
  );
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
      result: orphanDeleted ? [] : [{ name: capturedName, uuid: orphanId }],
      result_info: { total_count: orphanDeleted ? 0 : 1 },
    };
  };
  await assert.rejects(
    () =>
      createDisposableDatabase(
        FAKE_CONFIGURATION,
        1_755_000_000_000,
        requestFn,
      ),
    /simulated timeout/u,
  );
  assert.equal(orphanDeleted, true);
});

test("ambiguous creation uses the cleanup reserve after the work deadline", async () => {
  const orphanId = "44444444-4444-4444-8444-444444444444";
  const workDeadlineMs = Date.now() + 60_000;
  const cleanupDeadlineMs = workDeadlineMs + 5 * 60_000;
  const observed = [];
  let capturedName;
  let orphanDeleted = false;
  const requestFn = async (_configuration, path, init = {}, deadlineMs) => {
    const method = init.method ?? "GET";
    observed.push({ method, deadlineMs });
    if (method === "POST") {
      capturedName = JSON.parse(init.body).name;
      throw new Error("simulated response loss at the work deadline");
    }
    if (method === "DELETE") {
      assert.match(path, new RegExp(`${orphanId}$`, "u"));
      orphanDeleted = true;
      return { success: true, result: null };
    }
    return {
      result: orphanDeleted ? [] : [{ name: capturedName, uuid: orphanId }],
      result_info: { total_count: orphanDeleted ? 0 : 1 },
    };
  };
  await assert.rejects(
    () =>
      createDisposableDatabase(
        FAKE_CONFIGURATION,
        1_755_000_000_000,
        requestFn,
        workDeadlineMs,
        cleanupDeadlineMs,
      ),
    /simulated response loss/u,
  );
  assert.equal(orphanDeleted, true);
  assert.equal(observed[0].method, "POST");
  assert.equal(observed[0].deadlineMs, workDeadlineMs);
  assert.equal(
    observed
      .slice(1)
      .every(({ deadlineMs }) => deadlineMs === cleanupDeadlineMs),
    true,
  );
});

test("DELETE confirmation retries contradictory inventory metadata without accepting partial absence", async () => {
  const databaseId = "55555555-5555-4555-8555-555555555555";
  const remainingDatabases = [
    fakeDatabase(1),
    fakeDatabase(2),
    fakeDatabase(3),
  ];
  let deleteAttempts = 0;
  let listCalls = 0;
  const requestFn = async (_configuration, _path, init = {}) => {
    if ((init.method ?? "GET") === "DELETE") {
      deleteAttempts += 1;
      return { success: true, result: null };
    }
    listCalls += 1;
    return {
      result: remainingDatabases,
      result_info: {
        count: remainingDatabases.length,
        page: 1,
        per_page: INVENTORY_PAGE_SIZE,
        // O inventário pode perder o banco antes de total_count convergir.
        total_count:
          listCalls === 1
            ? remainingDatabases.length + 1
            : remainingDatabases.length,
      },
    };
  };

  await deleteDatabaseWithConfirmation(
    FAKE_CONFIGURATION,
    databaseId,
    requestFn,
    Date.now() + 60_000,
  );
  assert.equal(deleteAttempts, 2);
  assert.equal(listCalls, 2);
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
      result: listCalls <= 3 ? [{ name: "qualquer", uuid: databaseId }] : [],
      result_info: { total_count: listCalls <= 3 ? 1 : 0 },
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
      result_info: { total_count: 1 },
    };
  };
  await assert.rejects(
    () =>
      deleteDatabaseWithConfirmation(FAKE_CONFIGURATION, databaseId, requestFn),
    /simulated delete failure/u,
  );
});
