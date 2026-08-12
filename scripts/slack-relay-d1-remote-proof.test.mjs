import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parseDocument } from "yaml";

import {
  buildDisposableWranglerConfiguration,
  buildMigrationPlan,
  classifyDatabaseCreationResponse,
  reconcileAmbiguousDatabaseCreation,
  waitForDisposableDatabaseDeletion,
  waitForDisposableDatabaseOwnership,
} from "./verify-slack-relay-d1-remote.mjs";

const migrationPath =
  "workers/github-slack-relay/migrations/0004_confirm_slack_delivery.sql";
const migrationsDirectory = "workers/github-slack-relay/migrations";
const proofPath = "scripts/verify-slack-relay-d1-remote.mjs";
const workflowPath = ".github/workflows/github-slack-integration.yml";

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
