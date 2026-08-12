import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parseDocument } from "yaml";

import {
  boundedStaleDatabaseSelection,
  buildDisposableWranglerConfiguration,
  buildMigrationPlan,
  classifyDatabaseCreationResponse,
  createDisposableDatabase,
  disposableDatabasePresence,
  exactD1QueryResult,
  exactDisposableDatabaseIdFromList,
  lookupAmbiguousDatabaseCreation,
  parseCloudflareCreatedDatabase,
  parseCloudflareDatabaseRead,
  D1_DATABASE_ACCOUNT_LIMIT,
  MAX_CLOUDFLARE_JSON_BYTES,
  readJsonResponse,
  reconcileAmbiguousDatabaseCreation,
  reapSelectedStaleDatabases,
  REMOTE_PROOF_API_REQUEST_CAP,
  REMOTE_PROOF_JOB_DEADLINE_BUFFER_MS,
  REMOTE_PROOF_MINIMUM_MARGIN_MS,
  REMOTE_PROOF_REQUIRED_REMAINING_MS,
  REMOTE_PROOF_RETRY_DELAY_BUDGET_MS,
  REMOTE_PROOF_WORKFLOW_TIMEOUT_MS,
  REMOTE_PROOF_WORST_CASE_RUNTIME_MS,
  REMOTE_PROOF_WRANGLER_CALL_CAP,
  runWithDisposableDatabaseOwnershipBarriers,
  REAPER_DATABASE_LIST_PAGE_CAP,
  REAPER_DATABASE_LIST_PAGE_SIZE,
  REAPER_API_REQUEST_CAP,
  REAPER_MAX_DATABASES_PER_RUN,
  REAPER_WORKFLOW_TIMEOUT_MS,
  REAPER_WORST_CASE_RUNTIME_MS,
  selectStaleDisposableDatabases,
  STALE_DATABASE_AGE_MS,
  waitForDisposableDatabaseDeletion,
  waitForExpectedDisposableDatabaseOwnership,
  waitForDisposableDatabaseOwnership,
  verifyRemoteProofDeadline,
} from "./verify-slack-relay-d1-remote.mjs";
import {
  SLACK_DELIVERY_PROTOCOL_PREFLIGHT_SQL,
} from "./slack-delivery-protocol-preflight.mjs";

const expandMigrationPath =
  "workers/github-slack-relay/migrations/0004_confirm_slack_delivery.sql";
const targetMigrationPath =
  "workers/github-slack-relay/migrations/0005_reconcile_live_slack_receipts.sql";
const migrationsDirectory = "workers/github-slack-relay/migrations";
const proofPath = "scripts/verify-slack-relay-d1-remote.mjs";
const workflowPath = ".github/workflows/github-slack-integration.yml";
const reaperWorkflowPath = ".github/workflows/slack-d1-disposable-reaper.yml";

test("the remote D1 migration avoids known server-side parser and pattern limits", () => {
  const expandMigration = readFileSync(expandMigrationPath, "utf8");
  const targetMigration = readFileSync(targetMigrationPath, "utf8");
  const allMigrations = readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => readFileSync(`${migrationsDirectory}/${name}`, "utf8"))
    .join("\n");
  assert.doesNotMatch(allMigrations, /\bSELECT\s+CASE\b/iu);
  assert.equal(expandMigration.match(/\bSELECT\s+\(CASE\b/giu)?.length, 2);
  assert.equal(
    targetMigration.match(
      /afe5250504d37543845b07f44af7bfc30a548feb/gu,
    )?.length,
    1,
  );
  assert.match(
    targetMigration,
    /CREATE TRIGGER enforce_one_time_slack_delivery_protocol_revision_bridge/u,
  );

  const patterns = [
    ...allMigrations.matchAll(/\b(?:GLOB|LIKE)\s+'((?:''|[^'])*)'/giu),
  ].map((match) => match[1].replaceAll("''", "'"));
  assert.ok(patterns.length > 0);
  for (const pattern of patterns) {
    assert.ok(
      Buffer.byteLength(pattern, "utf8") <= 50,
      `D1 limits LIKE/GLOB patterns to 50 bytes: ${pattern}`,
    );
  }

  const prefix =
    "https://github.com/LCV-Ideas-Software/.github/issues/171#issuecomment-";
  assert.equal(expandMigration.split(`) = '${prefix}'`).length - 1, 2);
});

test("the disposable proof dynamically includes every production migration", () => {
  const currentNames = readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const futureName = "9999_test_future_contract.sql";
  const plan = buildMigrationPlan([...currentNames, futureName]);
  const expandIndex = currentNames.indexOf("0004_confirm_slack_delivery.sql");
  const targetIndex = currentNames.indexOf(
    "0005_reconcile_live_slack_receipts.sql",
  );

  assert.deepEqual(plan.fullNames, [...currentNames, futureName]);
  assert.deepEqual(plan.preNames, currentNames.slice(0, expandIndex));
  assert.deepEqual(plan.sourceNames, currentNames.slice(0, targetIndex));
  assert.ok(!plan.preNames.includes("0004_confirm_slack_delivery.sql"));
  assert.ok(plan.sourceNames.includes("0004_confirm_slack_delivery.sql"));
  assert.ok(
    !plan.sourceNames.includes("0005_reconcile_live_slack_receipts.sql"),
  );
  assert.ok(!plan.preNames.includes(futureName));
  assert.ok(!plan.sourceNames.includes(futureName));
});

test("the disposable proof validates the exact production preflight row", () => {
  const source = readFileSync(proofPath, "utf8");
  const migratedState = source.slice(
    source.indexOf("async function proveMigratedState"),
    source.indexOf("async function proveSchemaInventory"),
  );

  assert.match(migratedState, /SLACK_DELIVERY_PROTOCOL_PREFLIGHT_SQL/u);
  assert.doesNotMatch(
    migratedState,
    /validateSlackDeliveryProtocolPreflight\([\s\S]*?state\.results/u,
  );
  assert.match(
    SLACK_DELIVERY_PROTOCOL_PREFLIGHT_SQL,
    /duplicate_delivery_execution_id_groups/u,
  );
  assert.match(
    SLACK_DELIVERY_PROTOCOL_PREFLIGHT_SQL,
    /duplicate_slack_trace_execution_id_groups/u,
  );
});

test("the disposable Wrangler config binds the locally generated name to the verified UUID", () => {
  const databaseName =
    "tmp-slack-relay-171-11111111-2222-4333-8444-555555555555";
  const databaseId = "11111111-2222-4333-8444-555555555555";
  const config = JSON.parse(
    buildDisposableWranglerConfiguration(databaseName, databaseId),
  );
  assert.deepEqual(config.d1_databases, [
    {
      binding: "DB",
      database_id: databaseId,
      database_name: databaseName,
      migrations_dir: "migrations",
    },
  ]);

  const productionConfig = readFileSync(
    "workers/github-slack-relay/wrangler.jsonc",
    "utf8",
  );
  assert.match(productionConfig, /"migrations_dir"\s*:\s*"migrations"/u);
  assert.doesNotMatch(productionConfig, /"migrations_(?:pattern|table)"\s*:/u);
});

test("only a well-formed non-retryable Cloudflare 4xx envelope is a definitive create failure", () => {
  assert.equal(
    classifyDatabaseCreationResponse({ ok: true, status: 200 }, null),
    "ambiguous",
  );
  assert.equal(
    classifyDatabaseCreationResponse({ ok: false, status: 400 }, {}),
    "ambiguous",
  );
  const errorEnvelope = {
    errors: [{ code: 7502, message: "conflict" }],
    result: null,
    success: false,
  };
  for (const status of [408, 409, 429, 500]) {
    assert.equal(
      classifyDatabaseCreationResponse(
        { headers: new Headers(), ok: false, status },
        errorEnvelope,
      ),
      "ambiguous",
    );
  }
  assert.equal(
    classifyDatabaseCreationResponse(
      {
        headers: new Headers({ "x-should-retry": "true" }),
        ok: false,
        status: 400,
      },
      errorEnvelope,
    ),
    "ambiguous",
  );
  for (const status of [400, 401, 403, 404, 422]) {
    assert.equal(
      classifyDatabaseCreationResponse(
        { headers: new Headers(), ok: false, status },
        errorEnvelope,
      ),
      "definitive_failure",
    );
  }
  for (const malformed of [
    { errors: [], result: null, success: false },
    { errors: [{}], result: null, success: false },
    { errors: [{ code: 0, message: "invalid" }], result: null, success: false },
    {
      errors: [{ code: -1, message: "invalid" }],
      result: null,
      success: false,
    },
    {
      errors: [{ code: 7502, message: "conflict" }],
      result: {},
      success: false,
    },
  ]) {
    assert.equal(
      classifyDatabaseCreationResponse(
        { headers: new Headers(), ok: false, status: 400 },
        malformed,
      ),
      "ambiguous",
    );
  }
});

test("a successful create response proves exact fresh ownership metadata", () => {
  const databaseName =
    "tmp-slack-relay-171-11111111-2222-4333-8444-555555555555";
  const databaseId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const createdAt = "2026-08-12T16:25:44.442097Z";
  assert.deepEqual(
    parseCloudflareCreatedDatabase(
      {
        result: { created_at: createdAt, name: databaseName, uuid: databaseId },
        success: true,
      },
      { ok: true },
      databaseName,
      {
        notAfterMs: Date.parse("2026-08-12T16:26:00.000Z"),
        notBeforeMs: Date.parse("2026-08-12T16:25:00.000Z"),
      },
    ),
    { createdAt: Date.parse(createdAt), id: databaseId, name: databaseName },
  );
  assert.throws(
    () =>
      parseCloudflareCreatedDatabase(
        {
          result: {
            created_at: "2026-08-12T14:00:00.000Z",
            name: databaseName,
            uuid: databaseId,
          },
          success: true,
        },
        { ok: true },
        databaseName,
        {
          notAfterMs: Date.parse("2026-08-12T16:26:00.000Z"),
          notBeforeMs: Date.parse("2026-08-12T16:25:00.000Z"),
        },
      ),
    /invalid ownership metadata/u,
  );
});

test("the filtered D1 lookup follows Cloudflare pagination metadata rather than total_count", () => {
  const databaseName =
    "tmp-slack-relay-171-11111111-2222-4333-8444-555555555555";
  const databaseId = "11111111-2222-4333-8444-555555555555";
  const officialShapedInfo = {
    count: 1,
    page: 1,
    per_page: REAPER_DATABASE_LIST_PAGE_SIZE,
    total_count: 2_000,
  };
  assert.equal(
    exactDisposableDatabaseIdFromList(
      {
        result: [{ name: databaseName, uuid: databaseId }],
        result_info: officialShapedInfo,
        success: true,
      },
      { ok: true },
      databaseName,
    ),
    databaseId,
  );
  assert.equal(
    exactDisposableDatabaseIdFromList(
      {
        result: [],
        result_info: { ...officialShapedInfo, count: 0 },
        success: true,
      },
      { ok: true },
      databaseName,
    ),
    undefined,
  );
});

test("the filtered D1 lookup rejects incomplete or malformed result sets", () => {
  const databaseName =
    "tmp-slack-relay-171-11111111-2222-4333-8444-555555555555";
  const databaseId = "11111111-2222-4333-8444-555555555555";
  const valid = {
    result: [{ name: databaseName, uuid: databaseId }],
    result_info: {
      count: 1,
      page: 1,
      per_page: REAPER_DATABASE_LIST_PAGE_SIZE,
      total_count: 2_000,
    },
    success: true,
  };
  for (const payload of [
    { ...valid, result: [{ uuid: databaseId }] },
    { ...valid, result: [{ name: databaseName }] },
    { ...valid, result_info: { ...valid.result_info, count: 0 } },
    { ...valid, result_info: { ...valid.result_info, page: 2 } },
    { ...valid, result_info: { ...valid.result_info, per_page: 20 } },
    { ...valid, result_info: { ...valid.result_info, total_count: 0 } },
    {
      ...valid,
      result: Array.from(
        { length: REAPER_DATABASE_LIST_PAGE_SIZE },
        (_, index) => ({
          name: `unrelated-database-${index}`,
          uuid: `${index.toString(16).padStart(8, "0")}-2222-4333-8444-555555555555`,
        }),
      ),
      result_info: {
        count: REAPER_DATABASE_LIST_PAGE_SIZE,
        page: 1,
        per_page: REAPER_DATABASE_LIST_PAGE_SIZE,
        total_count: D1_DATABASE_ACCOUNT_LIMIT,
      },
    },
  ]) {
    assert.throws(
      () =>
        exactDisposableDatabaseIdFromList(payload, { ok: true }, databaseName),
      /lookup returned/u,
    );
  }

  assert.throws(
    () =>
      exactDisposableDatabaseIdFromList(
        {
          ...valid,
          result: [
            { name: "unrelated-a", uuid: databaseId },
            { name: "unrelated-b", uuid: databaseId },
          ],
          result_info: { ...valid.result_info, count: 2 },
        },
        { ok: true },
        databaseName,
      ),
    /duplicate UUIDs/u,
  );
  assert.throws(
    () =>
      exactDisposableDatabaseIdFromList(
        {
          ...valid,
          result: [
            { name: databaseName, uuid: databaseId },
            {
              name: databaseName,
              uuid: "22222222-3333-4444-8555-666666666666",
            },
          ],
          result_info: { ...valid.result_info, count: 2 },
        },
        { ok: true },
        databaseName,
      ),
    /duplicate exact names/u,
  );

  const fullPage = Array.from(
    { length: REAPER_DATABASE_LIST_PAGE_SIZE },
    (_, index) => ({
      name: `unrelated-database-${index}`,
      uuid: `${index.toString(16).padStart(8, "0")}-2222-4333-8444-555555555555`,
    }),
  );
  assert.equal(
    exactDisposableDatabaseIdFromList(
      {
        result: fullPage,
        result_info: {
          count: REAPER_DATABASE_LIST_PAGE_SIZE,
          page: 1,
          per_page: REAPER_DATABASE_LIST_PAGE_SIZE,
          total_count: REAPER_DATABASE_LIST_PAGE_SIZE,
        },
        success: true,
      },
      { ok: true },
      databaseName,
    ),
    undefined,
  );
});

test("a D1 read treats only a well-formed not-found envelope as absent", () => {
  const databaseName =
    "tmp-slack-relay-171-11111111-2222-4333-8444-555555555555";
  const databaseId = "11111111-2222-4333-8444-555555555555";
  const notFound = {
    errors: [{ code: 7404, message: "D1 database not found" }],
    result: null,
    success: false,
  };
  assert.equal(
    parseCloudflareDatabaseRead(
      notFound,
      { ok: false, status: 404 },
      {
        databaseId,
        databaseName,
      },
    ),
    undefined,
  );
  for (const payload of [
    {},
    { ...notFound, errors: [] },
    { ...notFound, errors: [{ code: 7000, message: "wrong error" }] },
    { ...notFound, success: true },
    { ...notFound, result: { name: databaseName, uuid: databaseId } },
  ]) {
    assert.throws(
      () =>
        parseCloudflareDatabaseRead(
          payload,
          { ok: false, status: 404 },
          {
            databaseId,
            databaseName,
          },
        ),
      /read-back failed/u,
    );
  }
  assert.throws(
    () =>
      parseCloudflareDatabaseRead(
        notFound,
        {
          headers: new Headers({ "x-should-retry": "true" }),
          ok: false,
          status: 404,
        },
        { databaseId, databaseName },
      ),
    /read-back failed/u,
  );
});

test("the real HTTP adapter maps only retryable wire failures to transient state", async () => {
  const databaseName =
    "tmp-slack-relay-171-11111111-2222-4333-8444-555555555555";
  const databaseId = "11111111-2222-4333-8444-555555555555";
  const base = {
    accountId: "a".repeat(32),
    apiToken: "t".repeat(32),
    databaseName,
  };
  let calls = 0;
  const throttled = await disposableDatabasePresence(
    {
      ...base,
      fetch: async () => {
        calls += 1;
        return new Response("rate limited", { status: 429 });
      },
    },
    databaseId,
  );
  assert.equal(throttled.state, "transient_error");
  assert.match(throttled.cause.message, /retryable HTTP 429/u);
  assert.equal(calls, 1);

  await assert.rejects(
    disposableDatabasePresence(
      {
        ...base,
        fetch: async () =>
          Response.json(
            {
              errors: [{ code: 1000, message: "do not retry" }],
              result: null,
              success: false,
            },
            {
              headers: { "x-should-retry": "false" },
              status: 503,
            },
          ),
      },
      databaseId,
    ),
    /lookup failed/u,
  );

  await assert.rejects(
    disposableDatabasePresence(
      {
        ...base,
        fetch: async () => new Response("{", { status: 200 }),
      },
      databaseId,
    ),
    /non-JSON HTTP 200/u,
  );

  const bodyTransportFailure = await disposableDatabasePresence(
    {
      ...base,
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError("terminated"));
            },
          }),
        ),
    },
    databaseId,
  );
  assert.equal(bodyTransportFailure.state, "transient_error");
  assert.match(bodyTransportFailure.cause.message, /body transport/u);

  const absentList = {
    result: [],
    result_info: {
      count: 0,
      page: 1,
      per_page: REAPER_DATABASE_LIST_PAGE_SIZE,
      total_count: 3,
    },
    success: true,
  };
  const responses = [
    Response.json(absentList),
    Response.json(
      {
        errors: [{ code: 7404, message: "not found" }],
        result: null,
        success: false,
      },
      {
        headers: { "x-should-retry": "true" },
        status: 404,
      },
    ),
  ];
  const retrying404 = await disposableDatabasePresence(
    { ...base, fetch: async () => responses.shift() },
    databaseId,
  );
  assert.equal(retrying404.state, "transient_error");
});

test("ambiguous create reconciliation retains a once-observed UUID until absence is proven by ID", async () => {
  const databaseName =
    "tmp-slack-relay-171-11111111-2222-4333-8444-555555555555";
  const databaseId = "11111111-2222-4333-8444-555555555555";
  const exactList = {
    result: [{ name: databaseName, uuid: databaseId }],
    result_info: {
      count: 1,
      page: 1,
      per_page: REAPER_DATABASE_LIST_PAGE_SIZE,
      total_count: 3,
    },
    success: true,
  };
  const absentList = {
    ...exactList,
    result: [],
    result_info: { ...exactList.result_info, count: 0 },
  };
  const notFound = {
    errors: [{ code: 7404, message: "not found" }],
    result: null,
    success: false,
  };
  const responses = [
    Response.json(exactList),
    Response.json(notFound, { status: 404 }),
    Response.json(absentList),
    Response.json(notFound, { status: 404 }),
  ];
  const reconciliation = { candidateId: undefined };
  const configuration = {
    accountId: "a".repeat(32),
    apiToken: "t".repeat(32),
    databaseName,
    fetch: async () => responses.shift(),
  };
  const ownershipWindow = {
    notAfterMs: Date.parse("2026-08-12T16:26:00.000Z"),
    notBeforeMs: Date.parse("2026-08-12T16:25:00.000Z"),
  };
  assert.deepEqual(
    await lookupAmbiguousDatabaseCreation(
      configuration,
      ownershipWindow,
      reconciliation,
    ),
    { state: "partial_visibility" },
  );
  assert.equal(reconciliation.candidateId, databaseId);
  assert.deepEqual(
    await lookupAmbiguousDatabaseCreation(
      configuration,
      ownershipWindow,
      reconciliation,
    ),
    { state: "absent" },
  );
  assert.equal(responses.length, 0);
});

test("a retryable create response carries its candidate UUID into every reconciliation read", async () => {
  const databaseName =
    "tmp-slack-relay-171-11111111-2222-4333-8444-555555555555";
  const databaseId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const absentList = {
    result: [],
    result_info: {
      count: 0,
      page: 1,
      per_page: REAPER_DATABASE_LIST_PAGE_SIZE,
      total_count: 3,
    },
    success: true,
  };
  const notFound = {
    errors: [{ code: 7404, message: "not found" }],
    result: null,
    success: false,
  };
  const urls = [];
  let calls = 0;
  await assert.rejects(
    createDisposableDatabase({
      accountId: "a".repeat(32),
      apiToken: "t".repeat(32),
      databaseName,
      delay: async () => {},
      fetch: async (url) => {
        urls.push(String(url));
        calls += 1;
        if (calls === 1) {
          return Response.json(
            {
              errors: [{ code: 1000, message: "retry" }],
              result: { name: databaseName, uuid: databaseId },
              success: false,
            },
            { status: 429 },
          );
        }
        return calls % 2 === 0
          ? Response.json(absentList)
          : Response.json(notFound, { status: 404 });
      },
    }),
    /ambiguous response/u,
  );
  assert.equal(calls, 11);
  assert.equal(
    urls.filter((url) => url.endsWith(`/d1/database/${databaseId}`)).length,
    5,
  );
});

test("a D1 read and the reaper reject non-ISO creation timestamps", () => {
  const databaseName =
    "tmp-slack-relay-171-11111111-2222-4333-8444-555555555555";
  const databaseId = "11111111-2222-4333-8444-555555555555";
  for (const created_at of [0, 1, "0", "1", "2026-02-30T00:00:00Z"]) {
    assert.throws(
      () =>
        parseCloudflareDatabaseRead(
          {
            result: { created_at, name: databaseName, uuid: databaseId },
            success: true,
          },
          { ok: true, status: 200 },
          { databaseId, databaseName },
        ),
      /ownership metadata/u,
    );
    assert.throws(
      () =>
        selectStaleDisposableDatabases(
          [{ created_at, name: databaseName, uuid: databaseId }],
          Date.parse("2026-08-12T14:00:00.000Z"),
        ),
      /incomplete or malformed/u,
    );
  }
});

test("the out-of-process reaper selects only stale capability names", () => {
  const now = Date.parse("2026-08-12T14:00:00.000Z");
  const staleCreatedAt = new Date(now - STALE_DATABASE_AGE_MS).toISOString();
  const olderCreatedAt = new Date(
    now - STALE_DATABASE_AGE_MS - 1,
  ).toISOString();
  const recentCreatedAt = new Date(
    now - STALE_DATABASE_AGE_MS + 1,
  ).toISOString();
  const staleId = "11111111-2222-4333-8444-555555555555";
  const staleName = `tmp-slack-relay-171-${staleId}`;
  const olderId = "22222222-3333-4444-8555-666666666666";
  const olderName = `tmp-slack-relay-171-${olderId}`;
  assert.deepEqual(
    selectStaleDisposableDatabases(
      [
        { created_at: staleCreatedAt, name: staleName, uuid: staleId },
        { created_at: olderCreatedAt, name: olderName, uuid: olderId },
        {
          created_at: recentCreatedAt,
          name: "tmp-slack-relay-171-66666666-7777-4888-8999-aaaaaaaaaaaa",
          uuid: "66666666-7777-4888-8999-aaaaaaaaaaaa",
        },
        {
          created_at: staleCreatedAt,
          name: "github-slack-alerts-db",
          uuid: "cf070eb0-32d9-4ee0-9516-d469833cdc77",
        },
        {
          created_at: staleCreatedAt,
          name: "unrelated-database",
          uuid: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
        },
      ],
      now,
    ),
    [
      { createdAt: Date.parse(olderCreatedAt), id: olderId, name: olderName },
      { createdAt: Date.parse(staleCreatedAt), id: staleId, name: staleName },
    ],
  );
  assert.deepEqual(
    boundedStaleDatabaseSelection([
      { createdAt: Date.parse(olderCreatedAt), id: olderId, name: olderName },
      { createdAt: Date.parse(staleCreatedAt), id: staleId, name: staleName },
    ]),
    {
      remaining: 1,
      selected: [
        { createdAt: Date.parse(olderCreatedAt), id: olderId, name: olderName },
      ],
    },
  );
});

test("a competing cleanup after inventory delegates bounded absence confirmation", async () => {
  const stale = [
    {
      createdAt: Date.parse("2026-08-12T12:00:00.000Z"),
      id: "11111111-2222-4333-8444-555555555555",
      name: "tmp-slack-relay-171-11111111-2222-4333-8444-555555555555",
    },
  ];
  let deletes = 0;
  const removed = await reapSelectedStaleDatabases(
    stale,
    Date.parse("2026-08-12T14:00:00.000Z"),
    {
      inspect: async () => undefined,
      remove: async (_target, _id, expectedCreatedAt) => {
        deletes += 1;
        assert.equal(expectedCreatedAt, stale[0].createdAt);
        return false;
      },
    },
  );
  assert.equal(removed, 0);
  assert.equal(deletes, 1);
});

test("the reaper rejects an incomplete disposable inventory item", () => {
  assert.throws(
    () =>
      selectStaleDisposableDatabases(
        [
          {
            name: "tmp-slack-relay-171-11111111-2222-4333-8444-555555555555",
            uuid: "11111111-2222-4333-8444-555555555555",
          },
        ],
        Date.parse("2026-08-12T14:00:00.000Z"),
      ),
    /incomplete or malformed/,
  );
  assert.throws(
    () =>
      selectStaleDisposableDatabases(
        [
          {
            created_at: "2026-08-12T12:00:00.000Z",
            uuid: "11111111-2222-4333-8444-555555555555",
          },
        ],
        Date.parse("2026-08-12T14:00:00.000Z"),
      ),
    /missing or malformed name/,
  );
});

test("the bounded JSON reader accepts one maximum-size official-shaped D1 list page", async () => {
  const item = {
    created_at: "2026-08-12T14:00:00.000Z",
    jurisdiction: "eu",
    name: "my-database",
    uuid: "11111111-2222-4333-8444-555555555555",
    version: "production",
  };
  const source = JSON.stringify({
    result: Array.from({ length: REAPER_DATABASE_LIST_PAGE_SIZE }, () => item),
    result_info: {
      count: REAPER_DATABASE_LIST_PAGE_SIZE,
      page: 1,
      per_page: REAPER_DATABASE_LIST_PAGE_SIZE,
      total_count: D1_DATABASE_ACCOUNT_LIMIT,
    },
    success: true,
  });
  assert.ok(Buffer.byteLength(source, "utf8") > 1_000_000);
  assert.ok(Buffer.byteLength(source, "utf8") < MAX_CLOUDFLARE_JSON_BYTES);
  const payload = await readJsonResponse(new Response(source));
  assert.equal(payload.result.length, REAPER_DATABASE_LIST_PAGE_SIZE);
});

test("the bounded JSON reader cancels an oversized body before consuming it", async () => {
  const chunk = new Uint8Array(64 * 1024).fill(0x61);
  let cancelReason;
  let pulls = 0;
  const body = new ReadableStream(
    {
      cancel(reason) {
        cancelReason = reason;
      },
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
        if (pulls === 10_000) controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  await assert.rejects(
    readJsonResponse(new Response(body)),
    /oversized response/,
  );
  assert.equal(pulls, 62);
  assert.match(cancelReason?.message ?? "", /oversized response/);
});

test("the bounded JSON reader preserves exact-byte and JSON semantics", async () => {
  const exact = `["${"a".repeat(MAX_CLOUDFLARE_JSON_BYTES - 4)}"]`;
  assert.equal(Buffer.byteLength(exact, "utf8"), MAX_CLOUDFLARE_JSON_BYTES);
  const exactPayload = await readJsonResponse(new Response(exact));
  assert.equal(exactPayload[0].length, MAX_CLOUDFLARE_JSON_BYTES - 4);

  const encoded = new TextEncoder().encode('{"value":"💡"}');
  const emojiStart = encoded.indexOf(0xf0);
  const splitBody = new ReadableStream({
    start(controller) {
      controller.enqueue(encoded.subarray(0, emojiStart + 1));
      controller.enqueue(encoded.subarray(emojiStart + 1));
      controller.close();
    },
  });
  assert.deepEqual(await readJsonResponse(new Response(splitBody)), {
    value: "💡",
  });
  await assert.rejects(
    readJsonResponse(new Response("{", { status: 502 })),
    /Cloudflare returned non-JSON HTTP 502\./,
  );
  await assert.rejects(
    readJsonResponse(new Response(null, { status: 204 })),
    /Cloudflare returned non-JSON HTTP 204\./,
  );
  await assert.rejects(
    readJsonResponse(
      new Response(
        new Uint8Array([
          0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d,
        ]),
      ),
    ),
    /Cloudflare returned non-JSON HTTP 200\./,
  );
});

test("a D1 query accepts exactly one successful result", () => {
  const success = { results: [], success: true };
  assert.equal(
    exactD1QueryResult({ result: [success], success: true }, { ok: true }),
    success,
  );
  for (const result of [
    [],
    [success, success],
    [{ results: [], success: false }],
  ]) {
    assert.throws(
      () => exactD1QueryResult({ result, success: true }, { ok: true }),
      /ambiguous result/u,
    );
  }
});

test("the reaper worst-case API budget fits the workflow timeout", () => {
  assert.equal(D1_DATABASE_ACCOUNT_LIMIT, 50_000);
  assert.equal(REAPER_DATABASE_LIST_PAGE_SIZE, 10_000);
  assert.equal(REAPER_DATABASE_LIST_PAGE_CAP, 5);
  assert.equal(
    REAPER_DATABASE_LIST_PAGE_SIZE * REAPER_DATABASE_LIST_PAGE_CAP,
    D1_DATABASE_ACCOUNT_LIMIT,
  );
  assert.equal(REAPER_MAX_DATABASES_PER_RUN, 1);
  assert.equal(REAPER_API_REQUEST_CAP, 23);
  assert.equal(REAPER_WORST_CASE_RUNTIME_MS, 348_500);
  assert.ok(
    REAPER_WORST_CASE_RUNTIME_MS <= REAPER_WORKFLOW_TIMEOUT_MS - 4 * 60_000,
  );
});

test("the deploy proof never runs the account-wide stale reaper", () => {
  const source = readFileSync(proofPath, "utf8");
  const proof = source.slice(
    source.indexOf("export async function runRemoteMigrationProof"),
    source.indexOf("if (process.argv[1] === fileURLToPath(import.meta.url))"),
  );
  assert.ok(proof.length > 0);
  assert.doesNotMatch(proof, /reapStaleDisposableDatabases/u);
});

test("the successful create identity is carried through config, barriers, and cleanup", () => {
  const source = readFileSync(proofPath, "utf8");
  const proof = source.slice(
    source.indexOf("export async function runRemoteMigrationProof"),
    source.indexOf("if (process.argv[1] === fileURLToPath(import.meta.url))"),
  );
  assert.match(
    proof,
    /const createdDatabase = await createDisposableDatabase\(configuration\);[\s\S]*?databaseId = createdDatabase\.id;[\s\S]*?expectedCreatedAt = createdDatabase\.createdAt;/u,
  );
  assert.match(
    proof,
    /prepareMigrationDirectories\([\s\S]*?databaseId,[\s\S]*?plan,/u,
  );
  assert.equal(
    proof.match(
      /applyMigrationsToOwnedDatabase\([\s\S]*?databaseId,[\s\S]*?expectedCreatedAt,[\s\S]*?(?:preConfig|sourceConfig|fullConfig),/gu,
    )?.length,
    3,
  );
  assert.match(
    proof,
    /preConfig,[\s\S]*?seedOldSchema\(configuration, databaseId\);[\s\S]*?sourceConfig,[\s\S]*?activateProtocolBridgeSource\(configuration, databaseId\);[\s\S]*?fullConfig,/u,
  );
  assert.match(
    proof,
    /deleteDisposableDatabase\([\s\S]*?databaseId,[\s\S]*?expectedCreatedAt,/u,
  );
  assert.equal(
    readFileSync(proofPath, "utf8").match(/codeql\[js\/http-to-file-access\]/gu)
      ?.length,
    3,
  );
});

test("the remote proof worst-case budget preserves the workflow margin", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const proofSource = readFileSync(proofPath, "utf8");
  const document = parseDocument(workflow, {
    schema: "core",
    uniqueKeys: true,
  });
  assert.deepEqual(document.errors, []);
  const proofJob = document.toJS({ maxAliasCount: 0 }).jobs.prove_remote_d1;

  assert.equal(REMOTE_PROOF_API_REQUEST_CAP, 95);
  assert.equal(REMOTE_PROOF_WRANGLER_CALL_CAP, 3);
  assert.equal(REMOTE_PROOF_RETRY_DELAY_BUDGET_MS, 14_000);
  assert.equal(REMOTE_PROOF_WORST_CASE_RUNTIME_MS, 1_799_000);
  assert.equal(REMOTE_PROOF_WORKFLOW_TIMEOUT_MS, 3_600_000);
  assert.equal(REMOTE_PROOF_JOB_DEADLINE_BUFFER_MS, 60_000);
  assert.equal(REMOTE_PROOF_REQUIRED_REMAINING_MS, 2_399_000);
  assert.equal(
    proofJob["timeout-minutes"] * 60_000,
    REMOTE_PROOF_WORKFLOW_TIMEOUT_MS,
  );
  assert.ok(
    REMOTE_PROOF_WORST_CASE_RUNTIME_MS <=
      REMOTE_PROOF_WORKFLOW_TIMEOUT_MS - REMOTE_PROOF_MINIMUM_MARGIN_MS,
  );
  assert.equal(STALE_DATABASE_AGE_MS, 3 * REMOTE_PROOF_WORKFLOW_TIMEOUT_MS);
  const firstStep = proofJob.steps[0];
  assert.equal(
    firstStep.name,
    "Establish the fail-closed remote proof deadline",
  );
  assert.match(firstStep.run, /now_ms="\$\(date \+%s%3N\)"/u);
  assert.match(firstStep.run, /now_ms \+ 59 \* 60 \* 1000/u);
  assert.match(firstStep.run, /REMOTE_PROOF_DEADLINE_MS=%s/u);
  assert.match(
    proofSource,
    /async function cloudflareRequest[\s\S]*?consumeCloudflareRequestBudget\(configuration\)[\s\S]*?await \(configuration\.fetch \?\? fetch\)/u,
  );
  assert.match(
    proofSource,
    /function runWrangler[\s\S]*?consumeWranglerCallBudget\(configuration\)[\s\S]*?spawnSync/u,
  );
  assert.match(
    proofSource,
    /startWranglerCallBudget\(configuration, REMOTE_PROOF_WRANGLER_CALL_CAP\)/u,
  );
});

test("the absolute proof deadline fails before remote work when cleanup time is unavailable", () => {
  const now = 1_786_500_000_000;
  assert.equal(
    verifyRemoteProofDeadline(
      {
        REMOTE_PROOF_DEADLINE_MS: String(
          now + REMOTE_PROOF_REQUIRED_REMAINING_MS,
        ),
      },
      now,
    ),
    now + REMOTE_PROOF_REQUIRED_REMAINING_MS,
  );
  assert.throws(
    () =>
      verifyRemoteProofDeadline(
        {
          REMOTE_PROOF_DEADLINE_MS: String(
            now + REMOTE_PROOF_REQUIRED_REMAINING_MS - 1,
          ),
        },
        now,
      ),
    /enough job time/u,
  );
  assert.throws(
    () => verifyRemoteProofDeadline({}, now),
    /missing or malformed/u,
  );
});

test("a default-branch schedule reaps stale proof databases out of process", () => {
  const source = readFileSync(reaperWorkflowPath, "utf8");
  const document = parseDocument(source, {
    schema: "core",
    uniqueKeys: true,
  });
  assert.deepEqual(document.errors, []);
  const workflow = document.toJS({ maxAliasCount: 0 });
  assert.deepEqual(Object.keys(workflow.on).sort(), [
    "schedule",
    "workflow_dispatch",
  ]);
  assert.deepEqual(workflow.on.schedule, [{ cron: "37 * * * *" }]);
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.concurrency, {
    group: "slack-d1-disposable-reaper-${{ github.repository }}",
    "cancel-in-progress": false,
  });
  assert.equal(workflow.jobs.reap.environment, "cloudflare-production");
  assert.equal(workflow.jobs.reap.if, "github.ref == 'refs/heads/main'");
  assert.equal(
    workflow.jobs.reap["timeout-minutes"] * 60_000,
    REAPER_WORKFLOW_TIMEOUT_MS,
  );
  const step = workflow.jobs.reap.steps.find(
    (candidate) =>
      candidate.name === "Reap stale disposable D1 proof databases",
  );
  assert.equal(
    step.run,
    "node scripts/verify-slack-relay-d1-remote.mjs --reap-stale",
  );
  assert.equal(
    step.env.CLOUDFLARE_ACCOUNT_ID,
    "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
  );
  assert.equal(
    step.env.CLOUDFLARE_API_TOKEN,
    "${{ secrets.CLOUDFLARE_API_TOKEN }}",
  );
  assert.equal(STALE_DATABASE_AGE_MS, 3 * REMOTE_PROOF_WORKFLOW_TIMEOUT_MS);
});

test("the production migration is preceded by the disposable remote D1 proof", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const document = parseDocument(workflow, {
    schema: "core",
    uniqueKeys: true,
  });
  assert.deepEqual(document.errors, []);
  const parsed = document.toJS({ maxAliasCount: 0 });
  const proofJob = parsed.jobs.prove_remote_d1;
  const deploy = parsed.jobs.deploy;
  assert.equal(proofJob.environment, "cloudflare-production");
  assert.equal(deploy.environment, "cloudflare-production");
  assert.equal(proofJob.needs, "verify");
  assert.equal(deploy.needs, "prove_remote_d1");
  assert.equal(parsed.jobs.deploy_slack.needs, "deploy");
  assert.equal(proofJob.if, deploy.if);
  assert.equal(deploy.concurrency, undefined);
  const proofSteps = proofJob.steps.filter(
    (step) =>
      step.name === "Prove durable inbox migration in disposable remote D1" &&
      step.run === "node scripts/verify-slack-relay-d1-remote.mjs" &&
      step.env.CLOUDFLARE_ACCOUNT_ID ===
        "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}" &&
      step.env.CLOUDFLARE_API_TOKEN === "${{ secrets.CLOUDFLARE_API_TOKEN }}",
  );
  const productionSteps = deploy.steps.filter(
    (step) =>
      step.name === "Apply durable inbox migrations" &&
      step.run.includes("wrangler d1 migrations apply github-slack-alerts-db"),
  );
  assert.equal(proofSteps.length, 1);
  assert.equal(productionSteps.length, 1);
  assert.equal(
    deploy.steps.some(
      (step) =>
        step.name === "Prove durable inbox migration in disposable remote D1",
    ),
    false,
  );
  assert.equal(
    proofJob.steps.some(
      (step) => step.name === "Apply durable inbox migrations",
    ),
    false,
  );

  const syntax = spawnSync(process.execPath, ["--check", proofPath], {
    encoding: "utf8",
  });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test("disposable D1 cleanup fails closed until bounded absence is proven", async () => {
  const stillPresent = {
    database: {
      createdAt: 1_786_500_000_000,
      id: "11111111-2222-4333-8444-555555555555",
      name: "tmp-slack-relay-171-11111111-2222-4333-8444-555555555555",
    },
    state: "owned",
  };
  let confirmations = 0;
  await assert.rejects(
    waitForDisposableDatabaseDeletion(
      async () => {
        confirmations += 1;
        return stillPresent;
      },
      async () => {},
    ),
    /deletion did not converge after bounded confirmation/u,
  );
  assert.equal(confirmations, 4);

  confirmations = 0;
  const reappearing = [
    { state: "absent" },
    { state: "absent" },
    stillPresent,
    stillPresent,
  ];
  await assert.rejects(
    waitForDisposableDatabaseDeletion(
      async () => {
        confirmations += 1;
        return reappearing.shift();
      },
      async () => {},
    ),
    /deletion did not converge after bounded confirmation/u,
  );
  assert.equal(confirmations, 4);

  const sequence = [
    { state: "absent" },
    stillPresent,
    { state: "absent" },
    { state: "absent" },
  ];
  confirmations = 0;
  await assert.doesNotReject(
    waitForDisposableDatabaseDeletion(
      async () => {
        confirmations += 1;
        return sequence.shift();
      },
      async () => {},
    ),
  );
  assert.equal(confirmations, 4);

  const transient = {
    cause: new Error("rate limited"),
    state: "transient_error",
  };
  const resetByTransient = [
    { state: "absent" },
    transient,
    { state: "absent" },
    { state: "absent" },
  ];
  await assert.doesNotReject(
    waitForDisposableDatabaseDeletion(
      async () => resetByTransient.shift(),
      async () => {},
    ),
  );
});

test("disposable D1 cleanup waits through an eventually consistent UUID read", async () => {
  const databaseId = "11111111-2222-4333-8444-555555555555";
  const pending = { state: "partial_visibility" };
  const database = {
    createdAt: 1_786_500_000_000,
    id: databaseId,
    name: `tmp-slack-relay-171-${databaseId}`,
  };
  const owned = { database, state: "owned" };
  const sequence = [
    { cause: new Error("rate limited"), state: "transient_error" },
    pending,
    owned,
  ];
  let delays = 0;
  const result = await waitForDisposableDatabaseOwnership(
    async () => sequence.shift(),
    async () => {
      delays += 1;
    },
  );
  assert.deepEqual(result, database);
  assert.equal(delays, 2);
});

test("remote migration ownership tolerates only bounded absence and partial visibility", async () => {
  const databaseId = "11111111-2222-4333-8444-555555555555";
  const pending = { state: "partial_visibility" };
  const database = {
    createdAt: 1_786_500_000_000,
    id: databaseId,
    name: `tmp-slack-relay-171-${databaseId}`,
  };
  const owned = { database, state: "owned" };
  const sequence = [
    { cause: new Error("rate limited"), state: "transient_error" },
    pending,
    owned,
  ];
  let delays = 0;
  assert.deepEqual(
    await waitForExpectedDisposableDatabaseOwnership(
      async () => sequence.shift(),
      databaseId,
      async () => {
        delays += 1;
      },
    ),
    database,
  );
  assert.equal(delays, 2);

  let mismatchDelays = 0;
  await assert.rejects(
    waitForExpectedDisposableDatabaseOwnership(
      async () => ({
        database: {
          createdAt: 1_786_500_000_000,
          id: "22222222-3333-4444-8555-666666666666",
          name: "tmp-slack-relay-171-22222222-3333-4444-8555-666666666666",
        },
        state: "owned",
      }),
      databaseId,
      async () => {
        mismatchDelays += 1;
      },
    ),
    /different UUID/,
  );
  assert.equal(mismatchDelays, 0);

  let absentLookups = 0;
  let absentDelays = 0;
  await assert.rejects(
    waitForExpectedDisposableDatabaseOwnership(
      async () => {
        absentLookups += 1;
        return { state: "absent" };
      },
      databaseId,
      async () => {
        absentDelays += 1;
      },
    ),
    /did not converge before remote migration/,
  );
  assert.equal(absentLookups, 4);
  assert.equal(absentDelays, 3);
});

test("remote migration runs exactly once between independent ownership barriers", async () => {
  const databaseId = "11111111-2222-4333-8444-555555555555";
  const pending = { state: "partial_visibility" };
  const owned = {
    database: {
      createdAt: 1_786_500_000_000,
      id: databaseId,
      name: `tmp-slack-relay-171-${databaseId}`,
    },
    state: "owned",
  };
  const sequence = [{ state: "absent" }, owned, pending, owned];
  let operations = 0;
  await runWithDisposableDatabaseOwnershipBarriers(
    async () => sequence.shift(),
    databaseId,
    async () => {
      operations += 1;
    },
    async () => {},
  );
  assert.equal(operations, 1);
  assert.equal(sequence.length, 0);

  operations = 0;
  await assert.rejects(
    runWithDisposableDatabaseOwnershipBarriers(
      async () => ({ state: "absent" }),
      databaseId,
      async () => {
        operations += 1;
      },
      async () => {},
    ),
    /did not converge before remote migration/,
  );
  assert.equal(operations, 0);
});

test("ambiguous D1 creation reconciles an eventually visible exact-name database", async () => {
  const databaseId = "11111111-2222-4333-8444-555555555555";
  const database = {
    createdAt: 1_786_500_000_000,
    id: databaseId,
    name: `tmp-slack-relay-171-${databaseId}`,
  };
  const sequence = [
    { state: "absent" },
    { state: "partial_visibility" },
    { database, state: "owned" },
  ];
  const cleaned = [];
  let delays = 0;

  await reconcileAmbiguousDatabaseCreation(
    async () => sequence.shift(),
    async (found) => cleaned.push(found),
    async () => {
      delays += 1;
    },
  );

  assert.deepEqual(cleaned, [database]);
  assert.equal(delays, 2);
});

test("ambiguous D1 creation never mistakes cleanup failure for lookup absence", async () => {
  const databaseId = "11111111-2222-4333-8444-555555555555";
  const database = {
    createdAt: 1_786_500_000_000,
    id: databaseId,
    name: `tmp-slack-relay-171-${databaseId}`,
  };
  let lookups = 0;
  let cleanupCalls = 0;
  let delays = 0;
  await assert.rejects(
    reconcileAmbiguousDatabaseCreation(
      async () => {
        lookups += 1;
        return lookups === 1
          ? { database, state: "owned" }
          : { state: "absent" };
      },
      async () => {
        cleanupCalls += 1;
        throw new Error("cleanup confirmation failed");
      },
      async () => {
        delays += 1;
      },
    ),
    /cleanup confirmation failed/,
  );
  assert.equal(lookups, 1);
  assert.equal(cleanupCalls, 1);
  assert.equal(delays, 0);
});

test("ambiguous D1 creation propagates lookup mismatches immediately", async () => {
  const sequence = [
    { state: "absent" },
    { state: "absent" },
    { state: "partial_visibility" },
    new Error("ownership metadata mismatch"),
    { state: "absent" },
  ];
  let lookups = 0;
  let cleanupCalls = 0;
  let delays = 0;
  await assert.rejects(
    reconcileAmbiguousDatabaseCreation(
      async () => {
        lookups += 1;
        const next = sequence.shift();
        if (next instanceof Error) throw next;
        return next;
      },
      async () => {
        cleanupCalls += 1;
      },
      async () => {
        delays += 1;
      },
    ),
    /ownership metadata mismatch/,
  );
  assert.equal(lookups, 4);
  assert.equal(cleanupCalls, 0);
  assert.equal(delays, 3);
});

test("ambiguous D1 creation requires two final consecutive absences", async () => {
  const converging = [
    { state: "absent" },
    { state: "absent" },
    { state: "partial_visibility" },
    { state: "absent" },
    { state: "absent" },
  ];
  let lookups = 0;
  let delays = 0;
  await reconcileAmbiguousDatabaseCreation(
    async () => {
      lookups += 1;
      return converging.shift();
    },
    async () => assert.fail("an absent database must not be cleaned"),
    async () => {
      delays += 1;
    },
  );
  assert.equal(lookups, 5);
  assert.equal(delays, 4);

  const oscillating = [
    { state: "absent" },
    { state: "partial_visibility" },
    { state: "absent" },
    { state: "partial_visibility" },
    { state: "absent" },
  ];
  await assert.rejects(
    reconcileAmbiguousDatabaseCreation(
      async () => oscillating.shift(),
      async () => assert.fail("an absent database must not be cleaned"),
      async () => {},
    ),
    /did not converge to owned or proven absent/,
  );

  const transientFinal = [
    { state: "absent" },
    { state: "absent" },
    { state: "absent" },
    { state: "absent" },
    { cause: new Error("rate limited"), state: "transient_error" },
  ];
  await assert.rejects(
    reconcileAmbiguousDatabaseCreation(
      async () => transientFinal.shift(),
      async () => assert.fail("transient state must not be cleaned"),
      async () => {},
    ),
    /did not converge to owned or proven absent/,
  );
});

test("ambiguous D1 creation does not adopt a database without exact lookup proof", async () => {
  let lookups = 0;
  let cleanupCalls = 0;
  await reconcileAmbiguousDatabaseCreation(
    async () => {
      lookups += 1;
      return { state: "absent" };
    },
    async () => {
      cleanupCalls += 1;
    },
    async () => {},
  );
  assert.equal(lookups, 5);
  assert.equal(cleanupCalls, 0);
});
