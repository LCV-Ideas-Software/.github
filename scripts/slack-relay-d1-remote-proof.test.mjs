import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parseDocument } from "yaml";

import {
  buildDisposableWranglerConfiguration,
  buildMigrationPlan,
  classifyDatabaseCreationResponse,
  D1_DATABASE_ACCOUNT_LIMIT,
  MAX_CLOUDFLARE_JSON_BYTES,
  readJsonResponse,
  reconcileAmbiguousDatabaseCreation,
  reapSelectedStaleDatabases,
  REMOTE_PROOF_API_REQUEST_CAP,
  REMOTE_PROOF_MINIMUM_MARGIN_MS,
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
} from "./verify-slack-relay-d1-remote.mjs";

const migrationPath =
  "workers/github-slack-relay/migrations/0004_confirm_slack_delivery.sql";
const migrationsDirectory = "workers/github-slack-relay/migrations";
const proofPath = "scripts/verify-slack-relay-d1-remote.mjs";
const workflowPath = ".github/workflows/github-slack-integration.yml";
const reaperWorkflowPath = ".github/workflows/slack-d1-disposable-reaper.yml";

test("the remote D1 migration avoids known server-side parser and pattern limits", () => {
  const migration = readFileSync(migrationPath, "utf8");
  const allMigrations = readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => readFileSync(`${migrationsDirectory}/${name}`, "utf8"))
    .join("\n");
  assert.doesNotMatch(allMigrations, /\bSELECT\s+CASE\b/iu);
  assert.equal(migration.match(/\bSELECT\s+\(CASE\b/giu)?.length, 2);

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
  assert.equal(migration.split(`) = '${prefix}'`).length - 1, 2);
});

test("the disposable proof dynamically includes every production migration", () => {
  const currentNames = readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const futureName = "9999_test_future_contract.sql";
  const plan = buildMigrationPlan([...currentNames, futureName]);
  const targetIndex = currentNames.indexOf("0004_confirm_slack_delivery.sql");

  assert.deepEqual(plan.fullNames, [...currentNames, futureName]);
  assert.deepEqual(plan.preNames, currentNames.slice(0, targetIndex));
  assert.ok(!plan.preNames.includes("0004_confirm_slack_delivery.sql"));
  assert.ok(!plan.preNames.includes(futureName));
});

test("the disposable Wrangler config resolves only the locally generated database name", () => {
  const databaseName =
    "tmp-slack-relay-171-11111111-2222-4333-8444-555555555555";
  const config = JSON.parse(buildDisposableWranglerConfiguration(databaseName));
  assert.deepEqual(config.d1_databases, [
    {
      binding: "DB",
      database_name: databaseName,
      migrations_dir: "migrations",
    },
  ]);
  assert.ok(!JSON.stringify(config).includes("database_id"));

  const productionConfig = readFileSync(
    "workers/github-slack-relay/wrangler.jsonc",
    "utf8",
  );
  assert.match(productionConfig, /"migrations_dir"\s*:\s*"migrations"/u);
  assert.doesNotMatch(productionConfig, /"migrations_(?:pattern|table)"\s*:/u);
});

test("only a well-formed Cloudflare 4xx envelope is a definitive create failure", () => {
  assert.equal(
    classifyDatabaseCreationResponse({ ok: true, status: 200 }, null),
    "ambiguous",
  );
  assert.equal(
    classifyDatabaseCreationResponse({ ok: false, status: 400 }, {}),
    "ambiguous",
  );
  assert.equal(
    classifyDatabaseCreationResponse(
      { ok: false, status: 409 },
      { errors: [{ message: "conflict" }], success: false },
    ),
    "definitive_failure",
  );
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
    [{ createdAt: Date.parse(olderCreatedAt), id: olderId, name: olderName }],
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

test("the remote proof worst-case budget preserves the workflow margin", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const proofSource = readFileSync(proofPath, "utf8");
  const document = parseDocument(workflow, {
    schema: "core",
    uniqueKeys: true,
  });
  assert.deepEqual(document.errors, []);
  const deploy = document.toJS({ maxAliasCount: 0 }).jobs.deploy;

  assert.equal(REMOTE_PROOF_API_REQUEST_CAP, 76);
  assert.equal(REMOTE_PROOF_WRANGLER_CALL_CAP, 2);
  assert.equal(REMOTE_PROOF_RETRY_DELAY_BUDGET_MS, 10_500);
  assert.equal(REMOTE_PROOF_WORST_CASE_RUNTIME_MS, 1_390_500);
  assert.equal(
    deploy["timeout-minutes"] * 60_000,
    REMOTE_PROOF_WORKFLOW_TIMEOUT_MS,
  );
  assert.ok(
    REMOTE_PROOF_WORST_CASE_RUNTIME_MS <=
      REMOTE_PROOF_WORKFLOW_TIMEOUT_MS - REMOTE_PROOF_MINIMUM_MARGIN_MS,
  );
  assert.equal(STALE_DATABASE_AGE_MS, 3 * REMOTE_PROOF_WORKFLOW_TIMEOUT_MS);
  assert.match(
    proofSource,
    /async function cloudflareRequest[\s\S]*?consumeCloudflareRequestBudget\(configuration\)[\s\S]*?await fetch/u,
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
  const deploy = parsed.jobs.deploy;
  assert.equal(deploy.environment, "cloudflare-production");
  assert.equal(deploy.concurrency, undefined);
  const proofStep = deploy.steps.findIndex(
    (step) =>
      step.name === "Prove durable inbox migration in disposable remote D1" &&
      step.run === "node scripts/verify-slack-relay-d1-remote.mjs" &&
      step.env.CLOUDFLARE_ACCOUNT_ID ===
        "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}" &&
      step.env.CLOUDFLARE_API_TOKEN === "${{ secrets.CLOUDFLARE_API_TOKEN }}",
  );
  const productionStep = deploy.steps.findIndex(
    (step) =>
      step.name === "Apply durable inbox migrations" &&
      step.run.includes("wrangler d1 migrations apply github-slack-alerts-db"),
  );
  assert.ok(proofStep >= 0);
  assert.ok(productionStep > proofStep);

  const syntax = spawnSync(process.execPath, ["--check", proofPath], {
    encoding: "utf8",
  });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test("disposable D1 cleanup fails closed until bounded absence is proven", async () => {
  const stillPresent = { id: "proof-id", name: "proof-name" };
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

  const sequence = [stillPresent, stillPresent, undefined, undefined];
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
});

test("disposable D1 cleanup waits through an eventually consistent UUID read", async () => {
  const databaseId = "11111111-2222-4333-8444-555555555555";
  const pending = { id: databaseId, pendingConsistency: true };
  const owned = { id: databaseId, name: "tmp-slack-relay-171-proof" };
  const sequence = [pending, owned];
  let delays = 0;
  const result = await waitForDisposableDatabaseOwnership(
    async () => sequence.shift(),
    async () => {
      delays += 1;
    },
  );
  assert.deepEqual(result, owned);
  assert.equal(delays, 1);
});

test("remote migration ownership tolerates only bounded absence and partial visibility", async () => {
  const databaseId = "11111111-2222-4333-8444-555555555555";
  const pending = { id: databaseId, pendingConsistency: true };
  const owned = { id: databaseId, name: "tmp-slack-relay-171-proof" };
  const sequence = [undefined, pending, owned];
  let delays = 0;
  assert.deepEqual(
    await waitForExpectedDisposableDatabaseOwnership(
      async () => sequence.shift(),
      databaseId,
      async () => {
        delays += 1;
      },
    ),
    owned,
  );
  assert.equal(delays, 2);

  let mismatchDelays = 0;
  await assert.rejects(
    waitForExpectedDisposableDatabaseOwnership(
      async () => ({ id: "22222222-3333-4444-8555-666666666666" }),
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
        return undefined;
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
  const pending = { id: databaseId, pendingConsistency: true };
  const owned = { id: databaseId, name: "tmp-slack-relay-171-proof" };
  const sequence = [undefined, owned, pending, owned];
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
      async () => undefined,
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
  const sequence = [undefined, undefined, databaseId];
  const cleaned = [];
  let delays = 0;

  await reconcileAmbiguousDatabaseCreation(
    async () => sequence.shift(),
    async (foundId) => cleaned.push(foundId),
    async () => {
      delays += 1;
    },
  );

  assert.deepEqual(cleaned, [databaseId]);
  assert.equal(delays, 2);
});

test("ambiguous D1 creation never mistakes cleanup failure for lookup absence", async () => {
  const databaseId = "11111111-2222-4333-8444-555555555555";
  let lookups = 0;
  let cleanupCalls = 0;
  let delays = 0;
  await assert.rejects(
    reconcileAmbiguousDatabaseCreation(
      async () => {
        lookups += 1;
        return lookups === 1 ? databaseId : undefined;
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

test("ambiguous D1 creation does not adopt a database without exact lookup proof", async () => {
  let lookups = 0;
  let cleanupCalls = 0;
  await reconcileAmbiguousDatabaseCreation(
    async () => {
      lookups += 1;
      return undefined;
    },
    async () => {
      cleanupCalls += 1;
    },
    async () => {},
  );
  assert.equal(lookups, 5);
  assert.equal(cleanupCalls, 0);
});
