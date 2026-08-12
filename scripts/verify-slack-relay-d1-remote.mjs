import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RELAY_ROOT = join(REPOSITORY_ROOT, "workers", "github-slack-relay");
const WRANGLER_ENTRYPOINT = join(
  RELAY_ROOT,
  "node_modules",
  "wrangler",
  "bin",
  "wrangler.js",
);
const TARGET_MIGRATION_NAME = "0004_confirm_slack_delivery.sql";
const BASELINE_MIGRATION_NAMES = Object.freeze([
  "0001_initial.sql",
  "0002_add_destination.sql",
  "0003_rename_delivery_acceptance.sql",
  TARGET_MIGRATION_NAME,
]);
const MIGRATION_NAME_PATTERN = /^(?<number>[0-9]+)_[0-9A-Za-z_-]+\.sql$/u;
const KNOWN_LOSS_ID = "de345e40-95b1-11f1-8d38-fac15f0bb4cd";
const ISSUE_COMMENT_PREFIX =
  "https://github.com/LCV-Ideas-Software/.github/issues/171#issuecomment-";
const DATABASE_NAME_PREFIX = "tmp-slack-relay-171-";
const DATABASE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/u;
const PRODUCTION_DATABASE_ID = "cf070eb0-32d9-4ee0-9516-d469833cdc77";
const API_TIMEOUT_MS = 15_000;
const WRANGLER_TIMEOUT_MS = 120_000;
const DELETE_CONFIRMATION_ATTEMPTS = 4;
const CREATE_RECONCILIATION_ATTEMPTS = 5;
const CREATION_CLOCK_SKEW_MS = 5 * 60_000;
const WRANGLER_ENV_KEYS = Object.freeze([
  "APPDATA",
  "FORCE_COLOR",
  "HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LOCALAPPDATA",
  "NODE_EXTRA_CA_CERTS",
  "NODE_OPTIONS",
  "NO_COLOR",
  "NO_PROXY",
  "PATH",
  "SSL_CERT_FILE",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function readConfiguration(environment) {
  const accountId = environment.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = environment.CLOUDFLARE_API_TOKEN;
  invariant(
    typeof accountId === "string" && ACCOUNT_ID_PATTERN.test(accountId),
    "CLOUDFLARE_ACCOUNT_ID is missing or malformed.",
  );
  invariant(
    typeof apiToken === "string" && apiToken.length >= 32,
    "CLOUDFLARE_API_TOKEN is missing or malformed.",
  );
  return {
    accountId,
    apiToken,
    databaseName: `${DATABASE_NAME_PREFIX}${randomUUID()}`,
  };
}

async function readJsonResponse(response) {
  const text = await response.text();
  invariant(
    text.length <= 1_000_000,
    "Cloudflare returned an oversized response.",
  );
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Cloudflare returned non-JSON HTTP ${response.status}.`);
  }
}

function cloudflareErrors(payload) {
  if (typeof payload !== "object" || payload === null) return "unknown_error";
  const errors = Array.isArray(payload.errors) ? payload.errors : [];
  return errors
    .map((entry) =>
      typeof entry === "object" &&
      entry !== null &&
      typeof entry.message === "string"
        ? entry.message
        : "unknown_error",
    )
    .join("; ");
}

async function cloudflareRequest(configuration, path, init) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${configuration.accountId}${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${configuration.apiToken}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    },
  );
  const payload = await readJsonResponse(response);
  return { payload, response };
}

export async function reconcileAmbiguousDatabaseCreation(
  lookup,
  cleanup,
  delay = (milliseconds) =>
    new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)),
) {
  let finalLookupError;
  for (
    let attempt = 0;
    attempt < CREATE_RECONCILIATION_ATTEMPTS;
    attempt += 1
  ) {
    try {
      const databaseId = await lookup();
      finalLookupError = undefined;
      if (databaseId !== undefined) {
        await cleanup(databaseId);
        return;
      }
    } catch (error) {
      finalLookupError = error;
    }
    if (attempt + 1 < CREATE_RECONCILIATION_ATTEMPTS) {
      await delay(250 * 2 ** attempt);
    }
  }
  if (finalLookupError !== undefined) {
    throw new Error(
      "Disposable D1 creation reconciliation could not prove absence.",
      { cause: finalLookupError },
    );
  }
}

export function classifyDatabaseCreationResponse(response, payload) {
  const payloadIsObject = typeof payload === "object" && payload !== null;
  if (response.ok && payloadIsObject && payload.success === true) {
    return "success";
  }
  if (
    response.status >= 400 &&
    response.status < 500 &&
    payloadIsObject &&
    payload.success === false &&
    Array.isArray(payload.errors)
  ) {
    return "definitive_failure";
  }
  return "ambiguous";
}

async function rejectAmbiguousDatabaseCreation(
  configuration,
  cause,
  ownershipWindow,
) {
  const creationError = new Error(
    `Disposable D1 creation had an ambiguous response. Exact temporary name: ${configuration.databaseName}`,
    { cause },
  );
  try {
    await reconcileAmbiguousDatabaseCreation(
      () => findDisposableDatabase(configuration, ownershipWindow),
      (databaseId) => deleteDisposableDatabase(configuration, databaseId),
    );
  } catch (cleanupError) {
    throw new AggregateError(
      [creationError, cleanupError],
      "Disposable D1 creation response was ambiguous and cleanup could not be proven.",
    );
  }
  throw creationError;
}

async function createDisposableDatabase(configuration) {
  const requestStartedAt = Date.now();
  let result;
  try {
    result = await cloudflareRequest(configuration, "/d1/database", {
      method: "POST",
      body: JSON.stringify({ name: configuration.databaseName }),
    });
  } catch (error) {
    return rejectAmbiguousDatabaseCreation(configuration, error, {
      notAfterMs: Date.now(),
      notBeforeMs: requestStartedAt,
    });
  }
  const { payload, response } = result;
  const classification = classifyDatabaseCreationResponse(response, payload);
  if (classification !== "success") {
    if (classification === "ambiguous") {
      return rejectAmbiguousDatabaseCreation(
        configuration,
        new Error(`Cloudflare returned ambiguous HTTP ${response.status}.`),
        {
          notAfterMs: Date.now(),
          notBeforeMs: requestStartedAt,
        },
      );
    }
    throw new Error(
      `Disposable D1 creation failed: ${cloudflareErrors(payload)}`,
    );
  }
  const id = payload.result?.uuid;
  const name = payload.result?.name;
  if (
    typeof id !== "string" ||
    !DATABASE_ID_PATTERN.test(id) ||
    id === PRODUCTION_DATABASE_ID ||
    name !== configuration.databaseName ||
    !name.startsWith(DATABASE_NAME_PREFIX)
  ) {
    return rejectAmbiguousDatabaseCreation(
      configuration,
      new Error("Disposable D1 creation returned invalid ownership metadata."),
      {
        notAfterMs: Date.now(),
        notBeforeMs: requestStartedAt,
      },
    );
  }
  return id;
}

async function listDisposableDatabaseId(configuration) {
  const search = new URLSearchParams({
    name: configuration.databaseName,
    page: "1",
    per_page: "10000",
  });
  const { payload, response } = await cloudflareRequest(
    configuration,
    `/d1/database?${search.toString()}`,
    { method: "GET" },
  );
  invariant(
    response.ok && payload.success === true && Array.isArray(payload.result),
    `Disposable D1 lookup failed: ${cloudflareErrors(payload)}`,
  );
  invariant(
    payload.result_info?.total_count === payload.result.length,
    "Disposable D1 lookup did not return its complete exact-name result set.",
  );
  const exact = payload.result.filter(
    (database) => database?.name === configuration.databaseName,
  );
  invariant(
    exact.length <= 1,
    "Disposable D1 lookup returned duplicate exact names.",
  );
  if (exact.length === 0) return undefined;
  const id = exact[0]?.uuid;
  invariant(
    typeof id === "string" &&
      DATABASE_ID_PATTERN.test(id) &&
      id !== PRODUCTION_DATABASE_ID,
    "Disposable D1 lookup returned an invalid database ID.",
  );
  return id;
}

async function findDisposableDatabase(configuration, ownershipWindow) {
  const id = await listDisposableDatabaseId(configuration);
  if (id === undefined) return undefined;
  const owned = await getDisposableDatabase(configuration, id, ownershipWindow);
  invariant(
    owned !== undefined,
    "Disposable D1 exact-name lookup disappeared before ownership read-back.",
  );
  return owned.id;
}

async function getDisposableDatabase(
  configuration,
  databaseId,
  ownershipWindow,
) {
  invariant(
    DATABASE_ID_PATTERN.test(databaseId) &&
      databaseId !== PRODUCTION_DATABASE_ID,
    "Refusing to inspect a database outside the disposable proof scope.",
  );
  const { payload, response } = await cloudflareRequest(
    configuration,
    `/d1/database/${databaseId}`,
    { method: "GET" },
  );
  if (response.status === 404) return undefined;
  invariant(
    response.ok && payload.success === true,
    `Disposable D1 read-back failed: ${cloudflareErrors(payload)}`,
  );
  const id = payload.result?.uuid;
  const name = payload.result?.name;
  const createdAt = Date.parse(payload.result?.created_at);
  invariant(
    id === databaseId &&
      name === configuration.databaseName &&
      name.startsWith(DATABASE_NAME_PREFIX) &&
      Number.isFinite(createdAt),
    "Disposable D1 read-back did not prove exact UUID/name ownership.",
  );
  if (ownershipWindow !== undefined) {
    invariant(
      createdAt >= ownershipWindow.notBeforeMs - CREATION_CLOCK_SKEW_MS &&
        createdAt <= ownershipWindow.notAfterMs + CREATION_CLOCK_SKEW_MS,
      "Disposable D1 creation time is outside the ambiguous request window.",
    );
  }
  return { createdAt, id, name };
}

export async function waitForDisposableDatabaseDeletion(
  lookup,
  delay = (milliseconds) =>
    new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)),
) {
  let consecutiveAbsences = 0;
  for (let attempt = 0; attempt < DELETE_CONFIRMATION_ATTEMPTS; attempt += 1) {
    const remaining = await lookup();
    if (remaining === undefined) {
      consecutiveAbsences += 1;
      if (consecutiveAbsences === 2) return;
    } else {
      consecutiveAbsences = 0;
    }
    if (attempt + 1 < DELETE_CONFIRMATION_ATTEMPTS) {
      await delay(250 * 2 ** attempt);
    }
  }
  throw new Error(
    "Disposable D1 deletion did not converge after bounded confirmation.",
  );
}

async function deleteDisposableDatabase(configuration, databaseId) {
  invariant(
    configuration.databaseName.startsWith(DATABASE_NAME_PREFIX) &&
      DATABASE_ID_PATTERN.test(databaseId) &&
      databaseId !== PRODUCTION_DATABASE_ID,
    "Refusing to delete a D1 database outside the disposable proof scope.",
  );
  const ownedDatabase = await waitForDisposableDatabaseOwnership(() =>
    disposableDatabasePresence(configuration, databaseId),
  );
  if (ownedDatabase === undefined) return;
  let deletionError;
  try {
    const { payload, response } = await cloudflareRequest(
      configuration,
      `/d1/database/${databaseId}`,
      { method: "DELETE" },
    );
    if (!(response.ok && payload.success === true)) {
      deletionError = new Error(
        `Disposable D1 cleanup failed: ${cloudflareErrors(payload)}`,
      );
    }
  } catch (error) {
    deletionError = error;
  }

  try {
    await waitForDisposableDatabaseDeletion(() =>
      disposableDatabasePresence(configuration, databaseId),
    );
  } catch (confirmationError) {
    if (deletionError === undefined) throw confirmationError;
    throw new AggregateError(
      [deletionError, confirmationError],
      "Disposable D1 deletion and confirmation both failed.",
    );
  }
}

async function disposableDatabasePresence(configuration, databaseId) {
  const listedId = await listDisposableDatabaseId(configuration);
  invariant(
    listedId === undefined || listedId === databaseId,
    "Disposable D1 name was rebound to a different UUID.",
  );
  const byId = await getDisposableDatabase(configuration, databaseId);
  if (listedId === undefined && byId === undefined) return undefined;
  if (listedId === databaseId && byId !== undefined) return byId;
  return { id: databaseId, pendingConsistency: true };
}

export async function waitForDisposableDatabaseOwnership(
  lookup,
  delay = (milliseconds) =>
    new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)),
) {
  for (let attempt = 0; attempt < DELETE_CONFIRMATION_ATTEMPTS; attempt += 1) {
    const presence = await lookup();
    if (presence === undefined) {
      await waitForDisposableDatabaseDeletion(lookup, delay);
      return undefined;
    }
    if (presence.pendingConsistency !== true) return presence;
    if (attempt + 1 < DELETE_CONFIRMATION_ATTEMPTS) {
      await delay(250 * 2 ** attempt);
    }
  }
  throw new Error(
    "Disposable D1 ownership did not converge before bounded cleanup.",
  );
}

async function d1Query(configuration, databaseId, sql, params = []) {
  const { payload, response } = await cloudflareRequest(
    configuration,
    `/d1/database/${databaseId}/query`,
    {
      method: "POST",
      body: JSON.stringify({ params, sql }),
    },
  );
  const result = Array.isArray(payload.result) ? payload.result[0] : null;
  invariant(
    response.ok &&
      payload.success === true &&
      result !== null &&
      result.success === true,
    `Disposable D1 query failed: ${cloudflareErrors(payload)}`,
  );
  return result;
}

async function expectD1QueryError(
  configuration,
  databaseId,
  sql,
  params,
  expectedFragment,
) {
  const { payload, response } = await cloudflareRequest(
    configuration,
    `/d1/database/${databaseId}/query`,
    {
      method: "POST",
      body: JSON.stringify({ params, sql }),
    },
  );
  const errorText = cloudflareErrors(payload);
  invariant(
    !response.ok &&
      payload.success === false &&
      errorText.includes(expectedFragment),
    `Disposable D1 unexpectedly accepted a forbidden transition (${response.status}).`,
  );
}

function wranglerOutput(result, configuration) {
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return combined
    .replaceAll(configuration.apiToken, "[redacted-token]")
    .replaceAll(configuration.accountId, "[redacted-account]")
    .slice(-8_000);
}

function runWrangler(configuration, args) {
  const inheritedEnvironment = Object.fromEntries(
    WRANGLER_ENV_KEYS.filter((key) => process.env[key] !== undefined).map(
      (key) => [key, process.env[key]],
    ),
  );
  const result = spawnSync(process.execPath, [WRANGLER_ENTRYPOINT, ...args], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    env: {
      ...inheritedEnvironment,
      CI: "true",
      CLOUDFLARE_ACCOUNT_ID: configuration.accountId,
      CLOUDFLARE_API_TOKEN: configuration.apiToken,
    },
    maxBuffer: 2_000_000,
    timeout: WRANGLER_TIMEOUT_MS,
    windowsHide: true,
  });
  invariant(result.error === undefined, "Wrangler could not be started.");
  invariant(
    result.status === 0,
    `Wrangler remote migration proof failed.\n${wranglerOutput(result, configuration)}`,
  );
}

function compareMigrationNames(left, right) {
  const leftMatch = MIGRATION_NAME_PATTERN.exec(left);
  const rightMatch = MIGRATION_NAME_PATTERN.exec(right);
  invariant(leftMatch !== null, `Invalid D1 migration filename: ${left}`);
  invariant(rightMatch !== null, `Invalid D1 migration filename: ${right}`);
  const numericDifference =
    Number.parseInt(leftMatch.groups.number, 10) -
    Number.parseInt(rightMatch.groups.number, 10);
  if (numericDifference !== 0) return numericDifference;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function buildMigrationPlan(candidateNames) {
  const names = [...candidateNames];
  for (const name of names) {
    invariant(
      MIGRATION_NAME_PATTERN.test(name),
      `Invalid D1 migration filename: ${name}`,
    );
  }
  names.sort(compareMigrationNames);
  invariant(names.length > 0, "No D1 migrations were found for remote proof.");
  invariant(
    BASELINE_MIGRATION_NAMES.every((name, index) => names[index] === name),
    "The historical D1 migration prefix changed unexpectedly.",
  );
  const numbers = names.map((name) =>
    Number.parseInt(MIGRATION_NAME_PATTERN.exec(name).groups.number, 10),
  );
  invariant(
    new Set(numbers).size === numbers.length,
    "D1 migration numeric prefixes must be unique.",
  );
  const targetIndex = names.indexOf(TARGET_MIGRATION_NAME);
  return {
    fullNames: names,
    preNames: names.slice(0, targetIndex),
  };
}

async function migrationPlan() {
  const entries = await readdir(join(RELAY_ROOT, "migrations"), {
    withFileTypes: true,
  });
  return buildMigrationPlan(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
      .map((entry) => entry.name),
  );
}

async function prepareMigrationDirectories(root, databaseName, plan) {
  const preRoot = join(root, "pre");
  const fullRoot = join(root, "full");
  await mkdir(join(preRoot, "migrations"), { recursive: true });
  await mkdir(join(fullRoot, "migrations"), { recursive: true });

  for (const name of plan.fullNames) {
    const source = join(RELAY_ROOT, "migrations", name);
    await copyFile(source, join(fullRoot, "migrations", name));
    if (plan.preNames.includes(name)) {
      await copyFile(source, join(preRoot, "migrations", name));
    }
  }

  const config = buildDisposableWranglerConfiguration(databaseName);
  const preConfig = join(preRoot, "wrangler.json");
  const fullConfig = join(fullRoot, "wrangler.json");
  await writeFile(preConfig, `${config}\n`, { encoding: "utf8", mode: 0o600 });
  await writeFile(fullConfig, `${config}\n`, { encoding: "utf8", mode: 0o600 });
  return { fullConfig, preConfig };
}

export function buildDisposableWranglerConfiguration(databaseName) {
  invariant(
    databaseName.startsWith(DATABASE_NAME_PREFIX),
    "Refusing to configure a database outside the disposable proof scope.",
  );
  return JSON.stringify(
    {
      name: databaseName,
      compatibility_date: "2026-08-03",
      d1_databases: [
        {
          binding: "DB",
          database_name: databaseName,
          migrations_dir: "migrations",
        },
      ],
    },
    null,
    2,
  );
}

function applyMigrations(configuration, configPath) {
  runWrangler(configuration, [
    "d1",
    "migrations",
    "apply",
    configuration.databaseName,
    "--remote",
    "--config",
    configPath,
  ]);
}

async function applyMigrationsToOwnedDatabase(
  configuration,
  databaseId,
  configPath,
) {
  invariant(
    (await findDisposableDatabase(configuration)) === databaseId,
    "Disposable D1 name no longer resolves to the created UUID before migration.",
  );
  applyMigrations(configuration, configPath);
  invariant(
    (await findDisposableDatabase(configuration)) === databaseId,
    "Disposable D1 name no longer resolves to the created UUID after migration.",
  );
}

const OLD_DELIVERY_INSERT = `INSERT INTO deliveries (
  delivery_id, event_type, action, repository, destination, payload_json,
  status, attempt_count, next_attempt_at, last_error, created_at,
  updated_at, accepted_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

async function seedOldSchema(configuration, databaseId) {
  const rows = [
    [
      KNOWN_LOSS_ID,
      "pull_request",
      "synchronize",
      "LCV-Ideas-Software/.github",
      "activity",
      "{}",
      "accepted_by_slack",
      1,
      1_000,
      null,
      900,
      1_000,
      1_000,
    ],
    [
      "11111111-1111-1111-1111-111111111111",
      "workflow_run",
      "completed",
      "LCV-Ideas-Software/.github",
      "alerts",
      "{}",
      "accepted_by_slack",
      1,
      1_100,
      null,
      1_000,
      1_100,
      1_100,
    ],
    [
      "22222222-2222-2222-2222-222222222222",
      "issues",
      "opened",
      "LCV-Ideas-Software/.github",
      "activity",
      "{}",
      "pending",
      0,
      1_200,
      null,
      1_200,
      1_200,
      null,
    ],
    [
      "33333333-3333-3333-3333-333333333333",
      "push",
      "created",
      "LCV-Ideas-Software/.github",
      "activity",
      "{}",
      "dead_letter",
      5,
      1_300,
      "queue_exhausted",
      1_200,
      1_300,
      null,
    ],
  ];
  for (const row of rows) {
    await d1Query(configuration, databaseId, OLD_DELIVERY_INSERT, row);
  }
}

function exactRows(actual, expected, label) {
  invariant(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label} did not match the expected remote D1 result.`,
  );
}

async function proveMigratedState(configuration, databaseId, names) {
  const migrations = await d1Query(
    configuration,
    databaseId,
    "SELECT name FROM d1_migrations ORDER BY id",
  );
  exactRows(
    migrations.results,
    names.map((name) => ({ name })),
    "Migration inventory",
  );

  const deliveries = await d1Query(
    configuration,
    databaseId,
    `SELECT delivery_id, status, attempt_count, last_error, accepted_at,
            trigger_accepted_at, legacy_unverified
     FROM deliveries ORDER BY delivery_id`,
  );
  exactRows(
    deliveries.results,
    [
      {
        delivery_id: "11111111-1111-1111-1111-111111111111",
        status: "accepted_by_slack",
        attempt_count: 1,
        last_error: null,
        accepted_at: null,
        trigger_accepted_at: 1_100,
        legacy_unverified: 1,
      },
      {
        delivery_id: "22222222-2222-2222-2222-222222222222",
        status: "pending",
        attempt_count: 0,
        last_error: null,
        accepted_at: null,
        trigger_accepted_at: null,
        legacy_unverified: 0,
      },
      {
        delivery_id: "33333333-3333-3333-3333-333333333333",
        status: "dead_letter",
        attempt_count: 5,
        last_error: "queue_exhausted",
        accepted_at: null,
        trigger_accepted_at: null,
        legacy_unverified: 0,
      },
      {
        delivery_id: KNOWN_LOSS_ID,
        status: "manual_review",
        attempt_count: 1,
        last_error: "known_slack_workflow_timeout_message_absent",
        accepted_at: null,
        trigger_accepted_at: 1_000,
        legacy_unverified: 1,
      },
    ],
    "Migrated deliveries",
  );

  const state = await d1Query(
    configuration,
    databaseId,
    `SELECT slack_activity_checkpoint_us, slack_delivery_protocol_active,
            slack_delivery_protocol_revision,
            slack_delivery_protocol_activated_at,
            slack_delivery_protocol_activation_id,
            slack_delivery_protocol_schema_revision,
            slack_delivery_protocol_confirmation_open
     FROM relay_state WHERE singleton_id = 1`,
  );
  exactRows(
    state.results,
    [
      {
        slack_activity_checkpoint_us: 0,
        slack_delivery_protocol_active: 0,
        slack_delivery_protocol_revision: null,
        slack_delivery_protocol_activated_at: null,
        slack_delivery_protocol_activation_id: null,
        slack_delivery_protocol_schema_revision: null,
        slack_delivery_protocol_confirmation_open: 1,
      },
    ],
    "Initial protocol state",
  );

  const quickCheck = await d1Query(
    configuration,
    databaseId,
    "PRAGMA quick_check",
  );
  exactRows(quickCheck.results, [{ quick_check: "ok" }], "D1 quick_check");
}

async function proveSchemaInventory(configuration, databaseId) {
  const schema = await d1Query(
    configuration,
    databaseId,
    `SELECT type, name
     FROM sqlite_schema
     WHERE type IN ('index', 'table', 'trigger')
       AND name NOT LIKE 'sqlite_%'
       AND name != '_cf_KV'
     ORDER BY type, name`,
  );
  exactRows(
    schema.results,
    [
      { type: "index", name: "idx_deliveries_destination_status" },
      { type: "index", name: "idx_deliveries_recovery" },
      { type: "index", name: "idx_deliveries_retention" },
      { type: "index", name: "idx_deliveries_slack_message" },
      { type: "index", name: "idx_slack_workflow_traces_delivery" },
      { type: "table", name: "d1_migrations" },
      { type: "table", name: "deliveries" },
      { type: "table", name: "relay_state" },
      { type: "table", name: "slack_delivery_recovery_audit" },
      { type: "table", name: "slack_workflow_traces" },
      {
        type: "trigger",
        name: "enforce_one_way_slack_delivery_protocol_activation",
      },
      {
        type: "trigger",
        name: "enforce_one_way_slack_delivery_protocol_confirmation",
      },
      { type: "trigger", name: "quarantine_old_worker_acceptance" },
      {
        type: "trigger",
        name: "release_known_slack_delivery_recovery",
      },
      {
        type: "trigger",
        name: "validate_known_slack_delivery_recovery",
      },
    ],
    "Schema inventory",
  );

  const deliveryColumns = await d1Query(
    configuration,
    databaseId,
    `SELECT name FROM pragma_table_info('deliveries') ORDER BY cid`,
  );
  exactRows(
    deliveryColumns.results,
    [
      "delivery_id",
      "event_type",
      "action",
      "repository",
      "destination",
      "payload_json",
      "status",
      "attempt_count",
      "next_attempt_at",
      "last_error",
      "created_at",
      "updated_at",
      "accepted_at",
      "trigger_accepted_at",
      "send_started_at",
      "delivered_at",
      "slack_message_ts",
      "slack_trace_id",
      "slack_send_execution_id",
      "legacy_unverified",
    ].map((name) => ({ name })),
    "Delivery column inventory",
  );
}

async function proveOldWorkerQuarantine(configuration, databaseId) {
  await d1Query(
    configuration,
    databaseId,
    `UPDATE deliveries
     SET status = 'accepted_by_slack', accepted_at = 1400, updated_at = 1400
     WHERE delivery_id = '22222222-2222-2222-2222-222222222222'`,
  );
  const row = await d1Query(
    configuration,
    databaseId,
    `SELECT status, accepted_at, trigger_accepted_at, legacy_unverified,
            last_error
     FROM deliveries
     WHERE delivery_id = '22222222-2222-2222-2222-222222222222'`,
  );
  exactRows(
    row.results,
    [
      {
        status: "accepted_by_slack",
        accepted_at: null,
        trigger_accepted_at: 1_400,
        legacy_unverified: 1,
        last_error: "legacy_old_worker_acceptance_quarantined",
      },
    ],
    "Old Worker quarantine trigger",
  );
}

async function proveTraceConstraints(configuration, databaseId) {
  const traceInsert = `INSERT INTO slack_workflow_traces (
    trace_id, delivery_id, outcome, relay_attempt, send_execution_id,
    send_boundary_reached, pre_send_failure_proven, started_at_us,
    completed_at_us, updated_at, applied_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const validParameters = [
    "trace-valid",
    "22222222-2222-2222-2222-222222222222",
    "error",
    1,
    "FxRemoteProof1",
    0,
    1,
    1_500_000,
    1_600_000,
    1_600,
    null,
  ];
  await d1Query(configuration, databaseId, traceInsert, validParameters);
  const contradictory = [...validParameters];
  contradictory[0] = "trace-contradictory";
  contradictory[5] = 1;
  await expectD1QueryError(
    configuration,
    databaseId,
    traceInsert,
    contradictory,
    "CHECK constraint failed",
  );
  const missingOwner = [...validParameters];
  missingOwner[0] = "trace-missing-owner";
  missingOwner[4] = null;
  await expectD1QueryError(
    configuration,
    databaseId,
    traceInsert,
    missingOwner,
    "CHECK constraint failed",
  );
  const row = await d1Query(
    configuration,
    databaseId,
    `SELECT trace_id, delivery_id, outcome, relay_attempt, send_execution_id,
            send_boundary_reached, pre_send_failure_proven
     FROM slack_workflow_traces WHERE trace_id = 'trace-valid'`,
  );
  exactRows(
    row.results,
    [
      {
        trace_id: "trace-valid",
        delivery_id: "22222222-2222-2222-2222-222222222222",
        outcome: "error",
        relay_attempt: 1,
        send_execution_id: "FxRemoteProof1",
        send_boundary_reached: 0,
        pre_send_failure_proven: 1,
      },
    ],
    "Slack workflow trace constraints",
  );
}

const RECOVERY_INSERT = `INSERT INTO slack_delivery_recovery_audit (
  delivery_id, destination, absence_proof_reference,
  authorization_reference, absence_proof_sha256, authorization_sha256,
  authorized_by, authorized_at, released_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

async function proveKnownLossRecovery(configuration, databaseId) {
  const validParameters = [
    KNOWN_LOSS_ID,
    "activity",
    `${ISSUE_COMMENT_PREFIX}1234567890`,
    `${ISSUE_COMMENT_PREFIX}1234567891`,
    "a".repeat(64),
    "b".repeat(64),
    "lcv-leo",
    2_000,
    2_000,
  ];
  const invalidParameters = [...validParameters];
  invalidParameters[2] = `${ISSUE_COMMENT_PREFIX}123456789x`;
  await expectD1QueryError(
    configuration,
    databaseId,
    RECOVERY_INSERT,
    invalidParameters,
    "CHECK constraint failed",
  );
  await d1Query(configuration, databaseId, RECOVERY_INSERT, validParameters);
  const delivery = await d1Query(
    configuration,
    databaseId,
    `SELECT status, next_attempt_at, last_error, legacy_unverified
     FROM deliveries WHERE delivery_id = ?`,
    [KNOWN_LOSS_ID],
  );
  exactRows(
    delivery.results,
    [
      {
        status: "pending",
        next_attempt_at: 2_000,
        last_error: "explicit_known_loss_recovery_authorized",
        legacy_unverified: 0,
      },
    ],
    "Known-loss recovery trigger",
  );
}

async function proveOneWayProtocol(configuration, databaseId) {
  const revision = "a".repeat(40);
  const activationId = "b".repeat(64);
  await d1Query(
    configuration,
    databaseId,
    `UPDATE relay_state
     SET slack_delivery_protocol_active = 1,
         slack_delivery_protocol_revision = ?,
         slack_delivery_protocol_activated_at = 2300,
         slack_delivery_protocol_activation_id = ?,
         slack_delivery_protocol_schema_revision =
           '0004_confirm_slack_delivery'
     WHERE singleton_id = 1`,
    [revision, activationId],
  );
  await expectD1QueryError(
    configuration,
    databaseId,
    `UPDATE relay_state
     SET slack_delivery_protocol_revision = ? WHERE singleton_id = 1`,
    ["c".repeat(40)],
    "slack_delivery_protocol_activation_is_one_way",
  );
  await d1Query(
    configuration,
    databaseId,
    `UPDATE relay_state
     SET slack_delivery_protocol_confirmation_open = 0
     WHERE singleton_id = 1`,
  );
  await expectD1QueryError(
    configuration,
    databaseId,
    `UPDATE relay_state
     SET slack_delivery_protocol_confirmation_open = 1
     WHERE singleton_id = 1`,
    [],
    "slack_delivery_protocol_confirmation_is_one_way",
  );
  const finalState = await d1Query(
    configuration,
    databaseId,
    `SELECT slack_delivery_protocol_active,
            slack_delivery_protocol_revision,
            slack_delivery_protocol_activated_at,
            slack_delivery_protocol_activation_id,
            slack_delivery_protocol_schema_revision,
            slack_delivery_protocol_confirmation_open
     FROM relay_state WHERE singleton_id = 1`,
  );
  exactRows(
    finalState.results,
    [
      {
        slack_delivery_protocol_active: 1,
        slack_delivery_protocol_revision: revision,
        slack_delivery_protocol_activated_at: 2_300,
        slack_delivery_protocol_activation_id: activationId,
        slack_delivery_protocol_schema_revision: "0004_confirm_slack_delivery",
        slack_delivery_protocol_confirmation_open: 0,
      },
    ],
    "Final one-way protocol state",
  );
  const quickCheck = await d1Query(
    configuration,
    databaseId,
    "PRAGMA quick_check",
  );
  exactRows(
    quickCheck.results,
    [{ quick_check: "ok" }],
    "Final D1 quick_check",
  );
}

export async function runRemoteMigrationProof(environment = process.env) {
  const configuration = readConfiguration(environment);
  const plan = await migrationPlan();
  const temporaryRoot = await mkdtemp(join(tmpdir(), "lcv-slack-d1-proof-"));
  let databaseId;
  let primaryError;
  let cleanupError;
  let localCleanupError;
  try {
    invariant(
      (await findDisposableDatabase(configuration)) === undefined,
      "Refusing to adopt a pre-existing disposable D1 name.",
    );
    databaseId = await createDisposableDatabase(configuration);
    const { fullConfig, preConfig } = await prepareMigrationDirectories(
      temporaryRoot,
      configuration.databaseName,
      plan,
    );
    await applyMigrationsToOwnedDatabase(configuration, databaseId, preConfig);
    await seedOldSchema(configuration, databaseId);
    await applyMigrationsToOwnedDatabase(configuration, databaseId, fullConfig);
    await proveMigratedState(configuration, databaseId, plan.fullNames);
    await proveSchemaInventory(configuration, databaseId);
    await proveOldWorkerQuarantine(configuration, databaseId);
    await proveTraceConstraints(configuration, databaseId);
    await proveKnownLossRecovery(configuration, databaseId);
    await proveOneWayProtocol(configuration, databaseId);
  } catch (error) {
    primaryError = error;
  } finally {
    if (databaseId !== undefined && cleanupError === undefined) {
      try {
        await deleteDisposableDatabase(configuration, databaseId);
      } catch (error) {
        cleanupError = error;
      }
    }
    try {
      await rm(temporaryRoot, { force: true, recursive: true });
    } catch (error) {
      localCleanupError = error;
    }
  }

  const errors = [primaryError, cleanupError, localCleanupError].filter(
    (error) => error !== undefined,
  );
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      "Remote D1 proof or cleanup failed with multiple errors.",
    );
  }
  if (errors.length === 1) throw errors[0];
  console.log(
    "Remote D1 proof passed: migrations, migrated data, runtime triggers, one-way protocol, quick_check, and cleanup.",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runRemoteMigrationProof();
}
