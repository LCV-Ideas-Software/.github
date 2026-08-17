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

import {
  SEALED_PROTOCOL_ACTIVATED_AT,
  SEALED_PROTOCOL_ACTIVATION_ID,
  SEALED_PROTOCOL_MIGRATION,
  SEALED_PROTOCOL_REVISION,
  SEALED_PROTOCOL_SCHEMA_REVISION,
  SLACK_DELIVERY_PROTOCOL_CONTRACT_SQL,
  validateSlackDeliveryProtocolContract,
} from "./slack-delivery-protocol-contract.mjs";
import { SLACK_RECONCILIATION_SCHEMA_OBJECT_CONTRACT } from "../workers/github-slack-relay/src/slack-reconciliation-schema-contract.ts";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RELAY_ROOT = join(REPOSITORY_ROOT, "workers", "github-slack-relay");
const WRANGLER_ENTRYPOINT = join(
  RELAY_ROOT,
  "node_modules",
  "wrangler",
  "bin",
  "wrangler.js",
);
const EXPAND_MIGRATION_NAME = "0004_confirm_slack_delivery.sql";
const TARGET_MIGRATION_NAME = "0005_reconcile_live_slack_receipts.sql";
const SEAL_MIGRATION_NAME = SEALED_PROTOCOL_MIGRATION;
const BASELINE_MIGRATION_NAMES = Object.freeze([
  "0001_initial.sql",
  "0002_add_destination.sql",
  "0003_rename_delivery_acceptance.sql",
  EXPAND_MIGRATION_NAME,
  TARGET_MIGRATION_NAME,
  SEAL_MIGRATION_NAME,
]);
const MIGRATION_NAME_PATTERN = /^(?<number>[0-9]+)_[0-9A-Za-z_-]+\.sql$/u;
const KNOWN_LOSS_ID = "de345e40-95b1-11f1-8d38-fac15f0bb4cd";
const ISSUE_COMMENT_PREFIX =
  "https://github.com/LCV-Ideas-Software/.github/issues/171#issuecomment-";
const DATABASE_NAME_PREFIX = "tmp-slack-relay-171-";
const DISPOSABLE_DATABASE_NAME_PATTERN =
  /^tmp-slack-relay-171-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DATABASE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CLOUDFLARE_TIMESTAMP_PATTERN =
  /^(?<year>[0-9]{4})-(?<month>[0-9]{2})-(?<day>[0-9]{2})T(?<hour>[0-9]{2}):(?<minute>[0-9]{2}):(?<second>[0-9]{2})(?:\.(?<fraction>[0-9]{1,9}))?Z$/u;
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/u;
const PRODUCTION_DATABASE_ID = "cf070eb0-32d9-4ee0-9516-d469833cdc77";
export const API_TIMEOUT_MS = 15_000;
export const MAX_CLOUDFLARE_JSON_BYTES = 4_000_000;
export const WRANGLER_TIMEOUT_MS = 120_000;
const DELETE_CONFIRMATION_ATTEMPTS = 4;
const CREATE_RECONCILIATION_ATTEMPTS = 5;
const CREATION_CLOCK_SKEW_MS = 5 * 60_000;
export const REMOTE_PROOF_WORKFLOW_TIMEOUT_MS = 60 * 60_000;
export const REMOTE_PROOF_JOB_DEADLINE_BUFFER_MS = 60_000;
export const REMOTE_PROOF_MINIMUM_MARGIN_MS = 10 * 60_000;
export const STALE_DATABASE_AGE_MS = 3 * REMOTE_PROOF_WORKFLOW_TIMEOUT_MS;
// Cloudflare documents 50,000 D1 databases for Workers Paid accounts and a
// maximum list page size of 10,000. Keep these values coupled to the bounded
// workflow budget and its focused contract test.
export const D1_DATABASE_ACCOUNT_LIMIT = 50_000;
export const REAPER_DATABASE_LIST_PAGE_SIZE = 10_000;
export const REAPER_DATABASE_LIST_PAGE_CAP = Math.ceil(
  D1_DATABASE_ACCOUNT_LIMIT / REAPER_DATABASE_LIST_PAGE_SIZE,
);
export const REAPER_MAX_DATABASES_PER_RUN = 1;
export const REAPER_WORKFLOW_TIMEOUT_MS = 10 * 60_000;
const DISPOSABLE_DATABASE_DELETE_API_REQUEST_CAP =
  2 * DELETE_CONFIRMATION_ATTEMPTS + 1 + 2 * DELETE_CONFIRMATION_ATTEMPTS;
const REAPER_API_REQUESTS_PER_DATABASE =
  1 + DISPOSABLE_DATABASE_DELETE_API_REQUEST_CAP;
const REAPER_RETRY_DELAY_BUDGET_MS =
  2 *
  Array.from(
    { length: DELETE_CONFIRMATION_ATTEMPTS - 1 },
    (_, attempt) => 250 * 2 ** attempt,
  ).reduce((total, delay) => total + delay, 0);
export const REAPER_API_REQUEST_CAP =
  REAPER_DATABASE_LIST_PAGE_CAP +
  REAPER_MAX_DATABASES_PER_RUN * REAPER_API_REQUESTS_PER_DATABASE;
export const REAPER_WORST_CASE_RUNTIME_MS =
  REAPER_API_REQUEST_CAP * API_TIMEOUT_MS +
  REAPER_MAX_DATABASES_PER_RUN * REAPER_RETRY_DELAY_BUDGET_MS;
const REMOTE_PROOF_OWNERSHIP_BARRIERS = 6;
// Successful proof path: one absence check, one create, 35 seed/assertion
// queries, six ownership barriers, and one bounded deletion. Wrangler's own
// remote calls stay inside its three separately bounded subprocesses.
const REMOTE_PROOF_SQL_API_REQUESTS = 35;
const OWNERSHIP_RETRY_DELAY_BUDGET_MS = Array.from(
  { length: DELETE_CONFIRMATION_ATTEMPTS - 1 },
  (_, attempt) => 250 * 2 ** attempt,
).reduce((total, delay) => total + delay, 0);
export const REMOTE_PROOF_API_REQUEST_CAP =
  2 +
  REMOTE_PROOF_OWNERSHIP_BARRIERS * DELETE_CONFIRMATION_ATTEMPTS * 2 +
  REMOTE_PROOF_SQL_API_REQUESTS +
  DISPOSABLE_DATABASE_DELETE_API_REQUEST_CAP;
export const REMOTE_PROOF_WRANGLER_CALL_CAP = 3;
export const REMOTE_PROOF_RETRY_DELAY_BUDGET_MS =
  REMOTE_PROOF_OWNERSHIP_BARRIERS * OWNERSHIP_RETRY_DELAY_BUDGET_MS +
  REAPER_RETRY_DELAY_BUDGET_MS;
export const REMOTE_PROOF_WORST_CASE_RUNTIME_MS =
  REMOTE_PROOF_API_REQUEST_CAP * API_TIMEOUT_MS +
  REMOTE_PROOF_WRANGLER_CALL_CAP * WRANGLER_TIMEOUT_MS +
  REMOTE_PROOF_RETRY_DELAY_BUDGET_MS;
export const REMOTE_PROOF_REQUIRED_REMAINING_MS =
  REMOTE_PROOF_WORST_CASE_RUNTIME_MS + REMOTE_PROOF_MINIMUM_MARGIN_MS;
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

class CloudflareBodyTransportError extends Error {
  constructor(cause) {
    super("Cloudflare response body transport failed.", { cause });
    this.name = "CloudflareBodyTransportError";
  }
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function startCloudflareRequestBudget(configuration, limit, label) {
  invariant(
    configuration.requestBudget === undefined,
    "Cloudflare request budget was initialized more than once.",
  );
  configuration.requestBudget = { label, limit, used: 0 };
}

function consumeCloudflareRequestBudget(configuration) {
  const budget = configuration.requestBudget;
  if (budget === undefined) return;
  invariant(
    budget.used < budget.limit,
    `${budget.label} exceeded its bounded Cloudflare request budget.`,
  );
  budget.used += 1;
}

function startWranglerCallBudget(configuration, limit) {
  invariant(
    configuration.wranglerBudget === undefined,
    "Wrangler call budget was initialized more than once.",
  );
  configuration.wranglerBudget = { limit, used: 0 };
}

function consumeWranglerCallBudget(configuration) {
  const budget = configuration.wranglerBudget;
  if (budget === undefined) return;
  invariant(
    budget.used < budget.limit,
    "Remote D1 migration proof exceeded its bounded Wrangler call budget.",
  );
  budget.used += 1;
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

export function verifyRemoteProofDeadline(environment, nowMs = Date.now()) {
  const deadlineMs = Number(environment.REMOTE_PROOF_DEADLINE_MS);
  invariant(
    Number.isSafeInteger(deadlineMs) && Number.isSafeInteger(nowMs),
    "REMOTE_PROOF_DEADLINE_MS is missing or malformed.",
  );
  invariant(
    deadlineMs - nowMs >= REMOTE_PROOF_REQUIRED_REMAINING_MS,
    "Remote D1 proof no longer has enough job time for its bounded work and cleanup.",
  );
  return deadlineMs;
}

export async function readJsonResponse(response) {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new Error(`Cloudflare returned non-JSON HTTP ${response.status}.`);
  }
  let bytes = new Uint8Array(0);
  let received = 0;
  try {
    while (true) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (cause) {
        throw new CloudflareBodyTransportError(cause);
      }
      const { done, value } = chunk;
      if (done) break;
      invariant(
        value instanceof Uint8Array,
        "Cloudflare returned a non-byte response body.",
      );
      if (value.byteLength > MAX_CLOUDFLARE_JSON_BYTES - received) {
        const error = new Error("Cloudflare returned an oversized response.");
        try {
          await reader.cancel(error);
        } catch {
          // The bounded response error remains authoritative if cancellation
          // itself races with the remote stream closing.
        }
        throw error;
      }
      const required = received + value.byteLength;
      if (required > bytes.byteLength) {
        let capacity = Math.max(bytes.byteLength, 64 * 1024);
        while (capacity < required) {
          capacity = Math.min(MAX_CLOUDFLARE_JSON_BYTES, capacity * 2);
        }
        const expanded = new Uint8Array(capacity);
        expanded.set(bytes.subarray(0, received));
        bytes = expanded;
      }
      bytes.set(value, received);
      received = required;
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, received),
      ),
    );
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

class CloudflareTransientResponseError extends Error {
  constructor(message, { cause, payload } = {}) {
    super(message, { cause });
    this.name = "CloudflareTransientResponseError";
    this.payload = payload;
  }
}

async function cloudflareRequest(configuration, path, init) {
  consumeCloudflareRequestBudget(configuration);
  let response;
  try {
    response = await (configuration.fetch ?? fetch)(
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
  } catch (cause) {
    throw new CloudflareTransientResponseError(
      "Cloudflare request failed before a response was received.",
      { cause },
    );
  }
  if (retryableCloudflareResponse(response)) {
    let payload;
    try {
      payload = await readJsonResponse(response);
    } catch {
      await response.body?.cancel().catch(() => undefined);
    }
    throw new CloudflareTransientResponseError(
      `Cloudflare returned retryable HTTP ${response.status}.`,
      { payload },
    );
  }
  let payload;
  try {
    payload = await readJsonResponse(response);
  } catch (cause) {
    if (cause instanceof CloudflareBodyTransportError) {
      throw new CloudflareTransientResponseError(
        "Cloudflare response failed during body transport.",
        { cause },
      );
    }
    throw cause;
  }
  return { payload, response };
}

export async function reconcileAmbiguousDatabaseCreation(
  lookup,
  cleanup,
  delay = (milliseconds) =>
    new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)),
) {
  let consecutiveAbsences = 0;
  let finalTransientCause;
  for (
    let attempt = 0;
    attempt < CREATE_RECONCILIATION_ATTEMPTS;
    attempt += 1
  ) {
    const result = await lookup();
    invariant(
      result?.state === "absent" ||
        result?.state === "partial_visibility" ||
        (result?.state === "transient_error" &&
          result.cause instanceof Error) ||
        (result?.state === "owned" &&
          typeof result.database?.id === "string" &&
          DATABASE_ID_PATTERN.test(result.database.id) &&
          result.database.id !== PRODUCTION_DATABASE_ID &&
          typeof result.database.name === "string" &&
          DISPOSABLE_DATABASE_NAME_PATTERN.test(result.database.name) &&
          Number.isSafeInteger(result.database.createdAt)),
      "Disposable D1 creation reconciliation returned an invalid lookup state.",
    );
    if (result.state === "owned") {
      await cleanup(result.database);
      return;
    }
    consecutiveAbsences =
      result.state === "absent" ? consecutiveAbsences + 1 : 0;
    finalTransientCause =
      result.state === "transient_error" ? result.cause : undefined;
    if (attempt + 1 < CREATE_RECONCILIATION_ATTEMPTS) {
      await delay(250 * 2 ** attempt);
    }
  }
  if (consecutiveAbsences < 2) {
    throw new Error(
      "Disposable D1 creation reconciliation did not converge to owned or proven absent.",
      { cause: finalTransientCause },
    );
  }
}

export function classifyDatabaseCreationResponse(response, payload) {
  const payloadIsObject = typeof payload === "object" && payload !== null;
  if (
    response.ok &&
    !retryableCloudflareResponse(response) &&
    payloadIsObject &&
    payload.success === true
  ) {
    return "success";
  }
  const explicitlyRetryable =
    typeof response.headers?.get === "function" &&
    response.headers.get("x-should-retry") === "true";
  const retryableStatus =
    response.status === 408 ||
    response.status === 409 ||
    response.status === 429 ||
    response.status >= 500;
  const errorsAreDefinitive =
    Array.isArray(payload?.errors) &&
    payload.errors.length > 0 &&
    payload.errors.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        Number.isSafeInteger(entry.code) &&
        entry.code >= 1_000 &&
        typeof entry.message === "string" &&
        entry.message.length > 0,
    );
  if (
    response.status >= 400 &&
    response.status < 500 &&
    !explicitlyRetryable &&
    !retryableStatus &&
    payloadIsObject &&
    payload.success === false &&
    errorsAreDefinitive &&
    (payload.result === undefined || payload.result === null)
  ) {
    return "definitive_failure";
  }
  return "ambiguous";
}

async function rejectAmbiguousDatabaseCreation(
  configuration,
  cause,
  ownershipWindow,
  candidateId,
) {
  const creationError = new Error(
    `Disposable D1 creation had an ambiguous response. Exact temporary name: ${configuration.databaseName}`,
    { cause },
  );
  try {
    const reconciliation = { candidateId };
    await reconcileAmbiguousDatabaseCreation(
      () =>
        lookupAmbiguousDatabaseCreation(
          configuration,
          ownershipWindow,
          reconciliation,
        ),
      (database) =>
        deleteDisposableDatabase(
          configuration,
          database.id,
          database.createdAt,
        ),
      configuration.delay,
    );
  } catch (cleanupError) {
    throw new AggregateError(
      [creationError, cleanupError],
      "Disposable D1 creation response was ambiguous and cleanup could not be proven.",
    );
  }
  throw creationError;
}

function safeDisposableCandidateId(payload, databaseName) {
  return DISPOSABLE_DATABASE_NAME_PATTERN.test(databaseName) &&
    typeof payload?.result?.uuid === "string" &&
    DATABASE_ID_PATTERN.test(payload.result.uuid) &&
    payload.result.uuid !== PRODUCTION_DATABASE_ID &&
    payload.result?.name === databaseName
    ? payload.result.uuid
    : undefined;
}

export function parseCloudflareCreatedDatabase(
  payload,
  response,
  databaseName,
  ownershipWindow,
) {
  invariant(
    response.ok &&
      !retryableCloudflareResponse(response) &&
      payload?.success === true,
    "Disposable D1 creation returned an invalid success envelope.",
  );
  const id = payload.result?.uuid;
  const name = payload.result?.name;
  const createdAt = parseCloudflareTimestamp(payload.result?.created_at);
  invariant(
    typeof id === "string" &&
      DATABASE_ID_PATTERN.test(id) &&
      id !== PRODUCTION_DATABASE_ID &&
      name === databaseName &&
      DISPOSABLE_DATABASE_NAME_PATTERN.test(name) &&
      createdAt >= ownershipWindow.notBeforeMs - CREATION_CLOCK_SKEW_MS &&
      createdAt <= ownershipWindow.notAfterMs + CREATION_CLOCK_SKEW_MS,
    "Disposable D1 creation returned invalid ownership metadata.",
  );
  return { createdAt, id, name };
}

export async function createDisposableDatabase(configuration) {
  const requestStartedAt = Date.now();
  let result;
  try {
    result = await cloudflareRequest(configuration, "/d1/database", {
      method: "POST",
      body: JSON.stringify({ name: configuration.databaseName }),
    });
  } catch (error) {
    return rejectAmbiguousDatabaseCreation(
      configuration,
      error,
      {
        notAfterMs: Date.now(),
        notBeforeMs: requestStartedAt,
      },
      safeDisposableCandidateId(error?.payload, configuration.databaseName),
    );
  }
  const { payload, response } = result;
  const ownershipWindow = {
    notAfterMs: Date.now(),
    notBeforeMs: requestStartedAt,
  };
  const classification = classifyDatabaseCreationResponse(response, payload);
  if (classification !== "success") {
    if (classification === "ambiguous") {
      return rejectAmbiguousDatabaseCreation(
        configuration,
        new Error(`Cloudflare returned ambiguous HTTP ${response.status}.`),
        ownershipWindow,
        safeDisposableCandidateId(payload, configuration.databaseName),
      );
    }
    throw new Error(
      `Disposable D1 creation failed: ${cloudflareErrors(payload)}`,
    );
  }
  try {
    return parseCloudflareCreatedDatabase(
      payload,
      response,
      configuration.databaseName,
      ownershipWindow,
    );
  } catch (error) {
    const candidateId = safeDisposableCandidateId(
      payload,
      configuration.databaseName,
    );
    return rejectAmbiguousDatabaseCreation(
      configuration,
      error,
      ownershipWindow,
      candidateId,
    );
  }
}

export function exactDisposableDatabaseIdFromList(
  payload,
  response,
  databaseName,
) {
  invariant(
    response.ok &&
      !retryableCloudflareResponse(response) &&
      payload?.success === true &&
      Array.isArray(payload.result),
    `Disposable D1 lookup failed: ${cloudflareErrors(payload)}`,
  );
  const info = payload.result_info;
  invariant(
    Number.isSafeInteger(info?.count) &&
      info.count === payload.result.length &&
      Number.isSafeInteger(info.page) &&
      info.page === 1 &&
      Number.isSafeInteger(info.per_page) &&
      info.per_page === REAPER_DATABASE_LIST_PAGE_SIZE &&
      Number.isSafeInteger(info.total_count) &&
      info.total_count >= payload.result.length &&
      info.total_count <= D1_DATABASE_ACCOUNT_LIMIT &&
      (payload.result.length < info.per_page ||
        info.total_count <= info.page * info.per_page),
    "Disposable D1 lookup returned inconsistent or incomplete pagination metadata.",
  );
  invariant(
    payload.result.every(
      (database) =>
        typeof database?.name === "string" &&
        database.name.length > 0 &&
        typeof database.uuid === "string" &&
        DATABASE_ID_PATTERN.test(database.uuid),
    ),
    "Disposable D1 lookup returned incomplete or malformed database metadata.",
  );
  invariant(
    new Set(payload.result.map((database) => database.uuid)).size ===
      payload.result.length,
    "Disposable D1 lookup returned duplicate UUIDs.",
  );
  const exact = payload.result.filter(
    (database) => database.name === databaseName,
  );
  invariant(
    exact.length <= 1,
    "Disposable D1 lookup returned duplicate exact names.",
  );
  if (exact.length === 0) return undefined;
  const id = exact[0].uuid;
  invariant(
    id !== PRODUCTION_DATABASE_ID,
    "Disposable D1 lookup returned an invalid database ID.",
  );
  return id;
}

function retryableCloudflareResponse(response) {
  const retryHeader =
    typeof response.headers?.get === "function"
      ? response.headers.get("x-should-retry")
      : null;
  if (retryHeader === "true") return true;
  if (retryHeader === "false") return false;
  return (
    response.status === 408 ||
    response.status === 409 ||
    response.status === 429 ||
    response.status >= 500
  );
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
  return exactDisposableDatabaseIdFromList(
    payload,
    response,
    configuration.databaseName,
  );
}

async function findDisposableDatabase(configuration, ownershipWindow) {
  const id = await listDisposableDatabaseId(configuration);
  if (id === undefined) return undefined;
  const owned = await getDisposableDatabase(configuration, id, {
    ownershipWindow,
  });
  invariant(
    owned !== undefined,
    "Disposable D1 exact-name lookup disappeared before ownership read-back.",
  );
  return owned.id;
}

export async function lookupAmbiguousDatabaseCreation(
  configuration,
  ownershipWindow,
  reconciliation = { candidateId: undefined },
) {
  let databaseId;
  try {
    databaseId = await listDisposableDatabaseId(configuration);
  } catch (error) {
    if (error instanceof CloudflareTransientResponseError) {
      return { cause: error, state: "transient_error" };
    }
    throw error;
  }
  if (databaseId !== undefined) {
    invariant(
      reconciliation.candidateId === undefined ||
        reconciliation.candidateId === databaseId,
      "Disposable D1 creation reconciliation observed a different UUID.",
    );
    reconciliation.candidateId = databaseId;
  }
  const candidateId = reconciliation.candidateId;
  if (candidateId === undefined) return { state: "absent" };
  let owned;
  try {
    owned = await getDisposableDatabase(configuration, candidateId, {
      ownershipWindow,
    });
  } catch (error) {
    if (error instanceof CloudflareTransientResponseError) {
      return { cause: error, state: "transient_error" };
    }
    throw error;
  }
  if (owned === undefined) {
    return databaseId === undefined
      ? { state: "absent" }
      : { state: "partial_visibility" };
  }
  return { database: owned, state: "owned" };
}

function validateCompleteD1Inventory(databases, expectedTotal) {
  invariant(
    databases.length === expectedTotal,
    "D1 inventory did not converge to its advertised total.",
  );
  const ids = databases.map((database) => database?.uuid);
  invariant(
    ids.every((id) => typeof id === "string" && DATABASE_ID_PATTERN.test(id)) &&
      new Set(ids).size === ids.length,
    "D1 inventory contains missing, malformed, or duplicate UUIDs.",
  );
  return databases;
}

async function listAllD1Databases(configuration) {
  const databases = [];
  let expectedTotal;
  for (let page = 1; page <= REAPER_DATABASE_LIST_PAGE_CAP; page += 1) {
    const search = new URLSearchParams({
      page: String(page),
      per_page: String(REAPER_DATABASE_LIST_PAGE_SIZE),
    });
    const { payload, response } = await cloudflareRequest(
      configuration,
      `/d1/database?${search.toString()}`,
      { method: "GET" },
    );
    invariant(
      response.ok && payload.success === true && Array.isArray(payload.result),
      `D1 inventory failed: ${cloudflareErrors(payload)}`,
    );
    const info = payload.result_info;
    invariant(
      Number.isSafeInteger(info?.count) &&
        info.count === payload.result.length &&
        Number.isSafeInteger(info.page) &&
        info.page === page &&
        Number.isSafeInteger(info.per_page) &&
        info.per_page === REAPER_DATABASE_LIST_PAGE_SIZE &&
        Number.isSafeInteger(info.total_count) &&
        info.total_count >= payload.result.length &&
        info.total_count <= D1_DATABASE_ACCOUNT_LIMIT &&
        payload.result.length <= REAPER_DATABASE_LIST_PAGE_SIZE,
      "D1 inventory returned inconsistent pagination metadata.",
    );
    if (expectedTotal === undefined) expectedTotal = info.total_count;
    invariant(
      info.total_count === expectedTotal,
      "D1 inventory total changed during pagination.",
    );
    databases.push(...payload.result);
    if (databases.length === expectedTotal) {
      return validateCompleteD1Inventory(databases, expectedTotal);
    }
    invariant(
      databases.length < expectedTotal && payload.result.length > 0,
      "D1 inventory pagination did not converge exactly.",
    );
  }
  throw new Error("D1 inventory exceeded its bounded page cap.");
}

function parseCloudflareTimestamp(value) {
  invariant(
    typeof value === "string",
    "Disposable D1 ownership metadata contains an invalid creation timestamp.",
  );
  const match = CLOUDFLARE_TIMESTAMP_PATTERN.exec(value);
  invariant(
    match !== null,
    "Disposable D1 ownership metadata contains an invalid creation timestamp.",
  );
  const milliseconds = Date.parse(value);
  const year = Number.parseInt(match.groups.year, 10);
  const month = Number.parseInt(match.groups.month, 10);
  const day = Number.parseInt(match.groups.day, 10);
  const hour = Number.parseInt(match.groups.hour, 10);
  const minute = Number.parseInt(match.groups.minute, 10);
  const second = Number.parseInt(match.groups.second, 10);
  const fractionMilliseconds = Number.parseInt(
    `${match.groups.fraction ?? ""}000`.slice(0, 3),
    10,
  );
  const reconstructed = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    second,
    fractionMilliseconds,
  );
  const exact = new Date(reconstructed);
  invariant(
    Number.isFinite(milliseconds) &&
      milliseconds === reconstructed &&
      exact.getUTCFullYear() === year &&
      exact.getUTCMonth() === month - 1 &&
      exact.getUTCDate() === day &&
      exact.getUTCHours() === hour &&
      exact.getUTCMinutes() === minute &&
      exact.getUTCSeconds() === second,
    "Disposable D1 ownership metadata contains an invalid creation timestamp.",
  );
  return milliseconds;
}

function isWellFormedCloudflareNotFound(payload, response) {
  return (
    response.ok === false &&
    response.status === 404 &&
    !retryableCloudflareResponse(response) &&
    payload?.success === false &&
    (payload.result === undefined || payload.result === null) &&
    Array.isArray(payload.errors) &&
    payload.errors.length > 0 &&
    payload.errors.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        entry.code === 7404 &&
        typeof entry.message === "string" &&
        entry.message.length > 0,
    )
  );
}

export function parseCloudflareDatabaseRead(
  payload,
  response,
  { databaseId, databaseName, expectedCreatedAt, ownershipWindow },
) {
  if (isWellFormedCloudflareNotFound(payload, response)) return undefined;
  invariant(
    response.ok && payload?.success === true,
    `Disposable D1 read-back failed: ${cloudflareErrors(payload)}`,
  );
  const id = payload.result?.uuid;
  const name = payload.result?.name;
  const createdAt = parseCloudflareTimestamp(payload.result?.created_at);
  invariant(
    id === databaseId &&
      name === databaseName &&
      DISPOSABLE_DATABASE_NAME_PATTERN.test(name),
    "Disposable D1 read-back did not prove exact UUID/name ownership metadata.",
  );
  if (ownershipWindow !== undefined) {
    invariant(
      createdAt >= ownershipWindow.notBeforeMs - CREATION_CLOCK_SKEW_MS &&
        createdAt <= ownershipWindow.notAfterMs + CREATION_CLOCK_SKEW_MS,
      "Disposable D1 creation time is outside the ambiguous request window.",
    );
  }
  if (expectedCreatedAt !== undefined) {
    invariant(
      createdAt === expectedCreatedAt,
      "Disposable D1 creation timestamp changed after ownership was proven.",
    );
  }
  return { createdAt, id, name };
}

async function getDisposableDatabase(
  configuration,
  databaseId,
  { expectedCreatedAt, ownershipWindow } = {},
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
  return parseCloudflareDatabaseRead(payload, response, {
    databaseId,
    databaseName: configuration.databaseName,
    expectedCreatedAt,
    ownershipWindow,
  });
}

async function deleteDisposableDatabase(
  configuration,
  databaseId,
  expectedCreatedAt,
) {
  invariant(
    DISPOSABLE_DATABASE_NAME_PATTERN.test(configuration.databaseName) &&
      DATABASE_ID_PATTERN.test(databaseId) &&
      databaseId !== PRODUCTION_DATABASE_ID &&
      Number.isSafeInteger(expectedCreatedAt),
    "Refusing to delete a D1 database outside the disposable proof scope.",
  );
  const ownedDatabase = await waitForDisposableDatabaseOwnership(() =>
    disposableDatabasePresence(configuration, databaseId, {
      expectedCreatedAt,
    }),
  );
  if (ownedDatabase === undefined) return false;
  invariant(
    ownedDatabase.createdAt === expectedCreatedAt,
    "Stale disposable D1 ownership changed before bounded cleanup.",
  );
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
      disposableDatabasePresence(configuration, databaseId, {
        expectedCreatedAt,
      }),
    );
  } catch (confirmationError) {
    if (deletionError === undefined) throw confirmationError;
    throw new AggregateError(
      [deletionError, confirmationError],
      "Disposable D1 deletion and confirmation both failed.",
    );
  }
  return true;
}

export function selectStaleDisposableDatabases(databases, nowMs) {
  invariant(Number.isSafeInteger(nowMs), "Reaper time must be a safe integer.");
  const cutoff = nowMs - STALE_DATABASE_AGE_MS;
  return databases
    .filter((database) => {
      invariant(
        typeof database?.name === "string" && database.name.length > 0,
        "D1 inventory item has a missing or malformed name.",
      );
      if (!database.name.startsWith(DATABASE_NAME_PREFIX)) return false;
      let createdAt;
      try {
        createdAt = parseCloudflareTimestamp(database.created_at);
      } catch {
        throw new Error(
          "Disposable D1 inventory item is incomplete or malformed.",
        );
      }
      invariant(
        DISPOSABLE_DATABASE_NAME_PATTERN.test(database.name) &&
          typeof database.uuid === "string" &&
          DATABASE_ID_PATTERN.test(database.uuid) &&
          database.uuid !== PRODUCTION_DATABASE_ID,
        "Disposable D1 inventory item is incomplete or malformed.",
      );
      return Number.isFinite(createdAt) && createdAt <= cutoff;
    })
    .map((database) => ({
      createdAt: parseCloudflareTimestamp(database.created_at),
      id: database.uuid,
      name: database.name,
    }))
    .sort(
      (left, right) =>
        left.createdAt - right.createdAt || left.id.localeCompare(right.id),
    );
}

export function boundedStaleDatabaseSelection(stale) {
  invariant(Array.isArray(stale), "Stale D1 selection must be an array.");
  return {
    remaining: Math.max(0, stale.length - REAPER_MAX_DATABASES_PER_RUN),
    selected: stale.slice(0, REAPER_MAX_DATABASES_PER_RUN),
  };
}

export async function reapStaleDisposableDatabases(
  configuration,
  nowMs = Date.now(),
) {
  startCloudflareRequestBudget(
    configuration,
    REAPER_API_REQUEST_CAP,
    "Disposable D1 reaper",
  );
  const stale = selectStaleDisposableDatabases(
    await listAllD1Databases(configuration),
    nowMs,
  );
  const bounded = boundedStaleDatabaseSelection(stale);
  const removed = await reapSelectedStaleDatabases(
    bounded.selected,
    nowMs,
    {
      inspect: getDisposableDatabase,
      remove: deleteDisposableDatabase,
    },
    configuration,
  );
  invariant(
    bounded.remaining === 0,
    `Disposable D1 reaper removed its bounded batch but ${bounded.remaining} stale database(s) remain.`,
  );
  return removed;
}

export async function reapSelectedStaleDatabases(
  stale,
  nowMs,
  operations,
  configuration = {},
) {
  let removed = 0;
  for (const database of stale) {
    const target = { ...configuration, databaseName: database.name };
    const owned = await operations.inspect(target, database.id);
    if (owned !== undefined) {
      invariant(
        owned.createdAt === database.createdAt &&
          owned.createdAt <= nowMs - STALE_DATABASE_AGE_MS,
        "Stale disposable D1 ownership changed before reaping.",
      );
    }
    const didRemove = await operations.remove(
      target,
      database.id,
      database.createdAt,
    );
    if (didRemove) removed += 1;
  }
  return removed;
}

function validateDisposableDatabasePresence(presence) {
  invariant(
    presence?.state === "absent" ||
      presence?.state === "partial_visibility" ||
      (presence?.state === "transient_error" &&
        presence.cause instanceof Error) ||
      (presence?.state === "owned" &&
        typeof presence.database?.id === "string" &&
        DATABASE_ID_PATTERN.test(presence.database.id) &&
        presence.database.id !== PRODUCTION_DATABASE_ID &&
        typeof presence.database.name === "string" &&
        DISPOSABLE_DATABASE_NAME_PATTERN.test(presence.database.name) &&
        Number.isSafeInteger(presence.database.createdAt)),
    "Disposable D1 lookup returned an invalid presence state.",
  );
  return presence;
}

export async function disposableDatabasePresence(
  configuration,
  databaseId,
  ownership = {},
) {
  let listedId;
  try {
    listedId = await listDisposableDatabaseId(configuration);
  } catch (error) {
    if (error instanceof CloudflareTransientResponseError) {
      return { cause: error, state: "transient_error" };
    }
    throw error;
  }
  invariant(
    listedId === undefined || listedId === databaseId,
    "Disposable D1 name was rebound to a different UUID.",
  );
  let byId;
  try {
    byId = await getDisposableDatabase(configuration, databaseId, ownership);
  } catch (error) {
    if (error instanceof CloudflareTransientResponseError) {
      return { cause: error, state: "transient_error" };
    }
    throw error;
  }
  if (listedId === undefined && byId === undefined) {
    return { state: "absent" };
  }
  if (listedId === databaseId && byId !== undefined) {
    return { database: byId, state: "owned" };
  }
  if (byId !== undefined) return { database: byId, state: "owned" };
  return { state: "partial_visibility" };
}

export async function waitForDisposableDatabaseDeletion(
  lookup,
  delay = (milliseconds) =>
    new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)),
) {
  let consecutiveAbsences = 0;
  let finalTransientCause;
  for (let attempt = 0; attempt < DELETE_CONFIRMATION_ATTEMPTS; attempt += 1) {
    const presence = validateDisposableDatabasePresence(await lookup());
    consecutiveAbsences =
      presence.state === "absent" ? consecutiveAbsences + 1 : 0;
    finalTransientCause =
      presence.state === "transient_error" ? presence.cause : undefined;
    if (attempt + 1 < DELETE_CONFIRMATION_ATTEMPTS) {
      await delay(250 * 2 ** attempt);
    }
  }
  if (consecutiveAbsences < 2) {
    throw new Error(
      "Disposable D1 deletion did not converge after bounded confirmation.",
      { cause: finalTransientCause },
    );
  }
}

export async function waitForDisposableDatabaseOwnership(
  lookup,
  delay = (milliseconds) =>
    new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)),
) {
  let consecutiveAbsences = 0;
  let finalTransientCause;
  for (let attempt = 0; attempt < DELETE_CONFIRMATION_ATTEMPTS; attempt += 1) {
    const presence = validateDisposableDatabasePresence(await lookup());
    if (presence.state === "owned") {
      return presence.database;
    }
    consecutiveAbsences =
      presence.state === "absent" ? consecutiveAbsences + 1 : 0;
    finalTransientCause =
      presence.state === "transient_error" ? presence.cause : undefined;
    if (attempt + 1 < DELETE_CONFIRMATION_ATTEMPTS) {
      await delay(250 * 2 ** attempt);
    }
  }
  if (consecutiveAbsences >= 2) return undefined;
  throw new Error(
    "Disposable D1 ownership did not converge before bounded cleanup.",
    { cause: finalTransientCause },
  );
}

export async function waitForExpectedDisposableDatabaseOwnership(
  lookup,
  expectedDatabaseId,
  delay = (milliseconds) =>
    new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)),
) {
  let finalTransientCause;
  for (let attempt = 0; attempt < DELETE_CONFIRMATION_ATTEMPTS; attempt += 1) {
    const presence = validateDisposableDatabasePresence(await lookup());
    if (presence.state === "owned") {
      invariant(
        presence.database.id === expectedDatabaseId,
        "Disposable D1 ownership resolved to a different UUID.",
      );
      return presence.database;
    }
    finalTransientCause =
      presence.state === "transient_error" ? presence.cause : undefined;
    if (attempt + 1 < DELETE_CONFIRMATION_ATTEMPTS) {
      await delay(250 * 2 ** attempt);
    }
  }
  throw new Error(
    "Disposable D1 ownership did not converge before remote migration.",
    { cause: finalTransientCause },
  );
}

export async function runWithDisposableDatabaseOwnershipBarriers(
  lookup,
  expectedDatabaseId,
  operation,
  delay,
) {
  await waitForExpectedDisposableDatabaseOwnership(
    lookup,
    expectedDatabaseId,
    delay,
  );
  await operation();
  return waitForExpectedDisposableDatabaseOwnership(
    lookup,
    expectedDatabaseId,
    delay,
  );
}

export function exactD1QueryResult(payload, response) {
  invariant(
    response.ok &&
      payload.success === true &&
      Array.isArray(payload.result) &&
      payload.result.length === 1 &&
      typeof payload.result[0] === "object" &&
      payload.result[0] !== null &&
      typeof payload.result[0].results !== "undefined" &&
      Array.isArray(payload.result[0].results) &&
      payload.result[0].success === true,
    `Disposable D1 query failed or returned an ambiguous result: ${cloudflareErrors(payload)}`,
  );
  const [result] = payload.result;
  invariant(
    result !== null && result.success === true,
    "Disposable D1 query did not return one successful result.",
  );
  return result;
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
  return exactD1QueryResult(payload, response);
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
  const results = Array.isArray(payload.result) ? payload.result : [];
  invariant(
    !response.ok &&
      payload.success === false &&
      results.every((result) => result?.success !== true) &&
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
  consumeWranglerCallBudget(configuration);
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
  const expandIndex = names.indexOf(EXPAND_MIGRATION_NAME);
  const targetIndex = names.indexOf(TARGET_MIGRATION_NAME);
  const sealIndex = names.indexOf(SEAL_MIGRATION_NAME);
  invariant(
    expandIndex >= 0 && targetIndex === expandIndex + 1,
    "The receipt repair must immediately follow the expand migration.",
  );
  invariant(
    sealIndex === targetIndex + 1,
    "The irreversible protocol seal must immediately follow the receipt repair.",
  );
  return {
    fullNames: names,
    preNames: names.slice(0, expandIndex),
    sourceNames: names.slice(0, sealIndex),
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

async function prepareMigrationDirectories(
  root,
  databaseName,
  databaseId,
  plan,
) {
  const preRoot = join(root, "pre");
  const sourceRoot = join(root, "source");
  const fullRoot = join(root, "full");
  await mkdir(join(preRoot, "migrations"), { recursive: true });
  await mkdir(join(sourceRoot, "migrations"), { recursive: true });
  await mkdir(join(fullRoot, "migrations"), { recursive: true });

  for (const name of plan.fullNames) {
    const source = join(RELAY_ROOT, "migrations", name);
    await copyFile(source, join(fullRoot, "migrations", name));
    if (plan.preNames.includes(name)) {
      await copyFile(source, join(preRoot, "migrations", name));
    }
    if (plan.sourceNames.includes(name)) {
      await copyFile(source, join(sourceRoot, "migrations", name));
    }
  }

  const config = buildDisposableWranglerConfiguration(databaseName, databaseId);
  const preConfig = join(preRoot, "wrangler.json");
  const sourceConfig = join(sourceRoot, "wrangler.json");
  const fullConfig = join(fullRoot, "wrangler.json");
  // The only network-derived field is an exact UUID already correlated with
  // the random capability name and creation timestamp. The destination is a
  // new mode-0600 file inside our own mkdtemp directory, never a remote path.
  // codeql[js/http-to-file-access]
  await writeFile(preConfig, `${config}\n`, { encoding: "utf8", mode: 0o600 });
  // codeql[js/http-to-file-access]
  await writeFile(sourceConfig, `${config}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  // codeql[js/http-to-file-access]
  await writeFile(fullConfig, `${config}\n`, { encoding: "utf8", mode: 0o600 });
  return { fullConfig, preConfig, sourceConfig };
}

export function buildDisposableWranglerConfiguration(databaseName, databaseId) {
  invariant(
    DISPOSABLE_DATABASE_NAME_PATTERN.test(databaseName) &&
      DATABASE_ID_PATTERN.test(databaseId) &&
      databaseId !== PRODUCTION_DATABASE_ID,
    "Refusing to configure a database outside the disposable proof scope.",
  );
  return JSON.stringify(
    {
      name: databaseName,
      compatibility_date: "2026-08-03",
      d1_databases: [
        {
          binding: "DB",
          database_id: databaseId,
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
    "DB",
    "--remote",
    "--config",
    configPath,
  ]);
}

async function applyMigrationsToOwnedDatabase(
  configuration,
  databaseId,
  expectedCreatedAt,
  configPath,
) {
  return runWithDisposableDatabaseOwnershipBarriers(
    () =>
      disposableDatabasePresence(configuration, databaseId, {
        expectedCreatedAt,
      }),
    databaseId,
    () => applyMigrations(configuration, configPath),
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

async function prepareProtocolSealSource(configuration, databaseId) {
  await d1Query(
    configuration,
    databaseId,
    `UPDATE relay_state
     SET slack_delivery_protocol_active = 1,
         slack_delivery_protocol_revision = ?,
         slack_delivery_protocol_activated_at = ?,
         slack_delivery_protocol_activation_id = ?,
         slack_delivery_protocol_schema_revision =
           '0005_reconcile_live_slack_receipts'
     WHERE singleton_id = 1`,
    [
      SEALED_PROTOCOL_REVISION,
      SEALED_PROTOCOL_ACTIVATED_AT,
      SEALED_PROTOCOL_ACTIVATION_ID,
    ],
  );
}

export async function proveSealedProtocolContract(
  configuration,
  databaseId,
  query = d1Query,
) {
  const contract = await query(
    configuration,
    databaseId,
    SLACK_DELIVERY_PROTOCOL_CONTRACT_SQL,
  );
  invariant(
    validateSlackDeliveryProtocolContract(
      JSON.stringify([{ success: true, results: contract.results }]),
    ).state === "sealed_exact_contract",
    "Production-parity database did not pass the exact sealed contract postflight.",
  );
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
    `SELECT relay.slack_activity_checkpoint_us, scan.resume_from_us,
            slack_delivery_protocol_active,
            slack_delivery_protocol_revision,
            slack_delivery_protocol_activated_at,
            slack_delivery_protocol_activation_id,
            slack_delivery_protocol_schema_revision,
            slack_delivery_protocol_confirmation_open
     FROM relay_state AS relay
     JOIN slack_activity_scan_state AS scan
       ON scan.singleton_id = relay.singleton_id
     WHERE relay.singleton_id = 1`,
  );
  exactRows(
    state.results,
    [
      {
        slack_activity_checkpoint_us: 0,
        resume_from_us: null,
        slack_delivery_protocol_active: 1,
        slack_delivery_protocol_revision: SEALED_PROTOCOL_REVISION,
        slack_delivery_protocol_activated_at: SEALED_PROTOCOL_ACTIVATED_AT,
        slack_delivery_protocol_activation_id: SEALED_PROTOCOL_ACTIVATION_ID,
        slack_delivery_protocol_schema_revision:
          SEALED_PROTOCOL_SCHEMA_REVISION,
        slack_delivery_protocol_confirmation_open: 0,
      },
    ],
    "Production-parity sealed protocol state",
  );
  const quickCheck = await d1Query(
    configuration,
    databaseId,
    "PRAGMA quick_check",
  );
  exactRows(quickCheck.results, [{ quick_check: "ok" }], "D1 quick_check");
}

export async function proveSchemaInventory(
  configuration,
  databaseId,
  query = d1Query,
) {
  const schema = await query(
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
      // ADR-002: os dois índices da tabela de dois estados (migração 0010);
      // a tabela em si entra abaixo, no bloco das tabelas — a prova compara
      // na ordem do SQL (type, name). Sem as três linhas, o primeiro run da
      // main falharia DEPOIS de aplicar a migração e ANTES do deploy —
      // achado da revisão da PR #201.
      { type: "index", name: "idx_alert_delivery_due" },
      { type: "index", name: "idx_alert_delivery_pending" },
      { type: "index", name: "idx_deliveries_destination_status" },
      { type: "index", name: "idx_deliveries_recovery" },
      { type: "index", name: "idx_deliveries_retention" },
      { type: "index", name: "idx_deliveries_slack_message" },
      { type: "index", name: "idx_deliveries_slack_send_execution" },
      {
        type: "index",
        name: "idx_slack_reconciliation_report_errors_report",
      },
      {
        type: "index",
        name: "idx_slack_reconciliation_reports_completed",
      },
      {
        type: "index",
        name: "idx_slack_trace_hydration_registry_pending",
      },
      { type: "index", name: "idx_slack_workflow_traces_delivery" },
      { type: "index", name: "idx_slack_workflow_traces_message" },
      { type: "index", name: "idx_slack_workflow_traces_send_execution" },
      { type: "table", name: "alert_delivery" },
      { type: "table", name: "d1_migrations" },
      { type: "table", name: "deliveries" },
      { type: "table", name: "relay_state" },
      { type: "table", name: "slack_activity_scan_state" },
      { type: "table", name: "slack_delivery_recovery_audit" },
      { type: "table", name: "slack_reconciliation_report_errors" },
      { type: "table", name: "slack_reconciliation_reports" },
      { type: "table", name: "slack_trace_hydration_registry" },
      { type: "table", name: "slack_workflow_traces" },
      {
        type: "trigger",
        name: "enforce_sealed_slack_delivery_protocol_delete",
      },
      {
        type: "trigger",
        name: "enforce_sealed_slack_delivery_protocol_insert",
      },
      {
        type: "trigger",
        name: "enforce_sealed_slack_delivery_protocol_update",
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

  const deliveryColumns = await query(
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

  const traceColumns = await query(
    configuration,
    databaseId,
    `SELECT name FROM pragma_table_info('slack_workflow_traces') ORDER BY cid`,
  );
  exactRows(
    traceColumns.results,
    [
      "trace_id",
      "delivery_id",
      "outcome",
      "relay_attempt",
      "send_execution_id",
      "send_boundary_reached",
      "pre_send_failure_proven",
      "started_at_us",
      "completed_at_us",
      "updated_at",
      "applied_at",
      "slack_channel_id",
      "slack_message_ts",
    ].map((name) => ({ name })),
    "Slack workflow trace column inventory",
  );

  const reportColumns = await query(
    configuration,
    databaseId,
    `SELECT name, type, "notnull", pk
     FROM pragma_table_info('slack_reconciliation_reports') ORDER BY cid`,
  );
  exactRows(
    reportColumns.results,
    [
      "report_id",
      "trace_count",
      "changed_error_traces",
      "requested_checkpoint_us",
      "checkpoint_us",
      "completed_at",
    ].map((name, index) => ({
      name,
      type: index === 0 ? "TEXT" : "INTEGER",
      notnull: 1,
      pk: index === 0 ? 1 : 0,
    })),
    "Slack reconciliation report column inventory",
  );

  const reportErrorColumns = await query(
    configuration,
    databaseId,
    `SELECT name, type, "notnull", pk
     FROM pragma_table_info('slack_reconciliation_report_errors') ORDER BY cid`,
  );
  exactRows(
    reportErrorColumns.results,
    ["trace_id", "report_id", "committed_at"].map((name, index) => ({
      name,
      type: index === 2 ? "INTEGER" : "TEXT",
      notnull: 1,
      pk: index === 0 ? 1 : 0,
    })),
    "Slack reconciliation error receipt column inventory",
  );

  const scanStateColumns = await query(
    configuration,
    databaseId,
    `SELECT name, type, "notnull", pk
     FROM pragma_table_info('slack_activity_scan_state') ORDER BY cid`,
  );
  exactRows(
    scanStateColumns.results,
    [
      { name: "singleton_id", type: "INTEGER", notnull: 1, pk: 1 },
      { name: "resume_from_us", type: "INTEGER", notnull: 0, pk: 0 },
    ],
    "Slack activity scan-state column inventory",
  );

  const hydrationColumns = await query(
    configuration,
    databaseId,
    `SELECT name, type, "notnull", pk
     FROM pragma_table_info('slack_trace_hydration_registry') ORDER BY cid`,
  );
  exactRows(
    hydrationColumns.results,
    [
      { name: "trace_id", type: "TEXT", notnull: 1, pk: 1 },
      { name: "first_observed_us", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "last_observed_us", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "last_hydrated_at", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "status", type: "TEXT", notnull: 1, pk: 0 },
      { name: "debt_reason", type: "TEXT", notnull: 0, pk: 0 },
      { name: "updated_at", type: "INTEGER", notnull: 1, pk: 0 },
    ],
    "Slack trace hydration column inventory",
  );

  const hydrationIndexes = await query(
    configuration,
    databaseId,
    `SELECT indexes.name AS index_name, indexes."unique", indexes.origin,
            indexes.partial, columns.seqno, columns.name AS column_name
     FROM pragma_index_list('slack_trace_hydration_registry') AS indexes
     JOIN pragma_index_info(indexes.name) AS columns
     ORDER BY index_name, columns.seqno`,
  );
  exactRows(
    hydrationIndexes.results,
    [
      {
        index_name: "idx_slack_trace_hydration_registry_pending",
        unique: 0,
        origin: "c",
        partial: 0,
        seqno: 0,
        column_name: "status",
      },
      {
        index_name: "idx_slack_trace_hydration_registry_pending",
        unique: 0,
        origin: "c",
        partial: 0,
        seqno: 1,
        column_name: "last_hydrated_at",
      },
      {
        index_name: "idx_slack_trace_hydration_registry_pending",
        unique: 0,
        origin: "c",
        partial: 0,
        seqno: 2,
        column_name: "first_observed_us",
      },
      {
        index_name: "idx_slack_trace_hydration_registry_pending",
        unique: 0,
        origin: "c",
        partial: 0,
        seqno: 3,
        column_name: "trace_id",
      },
      {
        index_name: "sqlite_autoindex_slack_trace_hydration_registry_1",
        unique: 1,
        origin: "pk",
        partial: 0,
        seqno: 0,
        column_name: "trace_id",
      },
    ],
    "Slack trace hydration index inventory",
  );

  const reconciliationIndexes = await query(
    configuration,
    databaseId,
    `SELECT 'slack_reconciliation_report_errors' AS table_name,
            indexes.name AS index_name, indexes."unique", indexes.origin,
            indexes.partial, columns.name AS column_name
     FROM pragma_index_list('slack_reconciliation_report_errors') AS indexes
     JOIN pragma_index_info(indexes.name) AS columns
     UNION ALL
     SELECT 'slack_reconciliation_reports' AS table_name,
            indexes.name AS index_name, indexes."unique", indexes.origin,
            indexes.partial, columns.name AS column_name
     FROM pragma_index_list('slack_reconciliation_reports') AS indexes
     JOIN pragma_index_info(indexes.name) AS columns
     ORDER BY table_name, index_name, column_name`,
  );
  exactRows(
    reconciliationIndexes.results,
    [
      {
        table_name: "slack_reconciliation_report_errors",
        index_name: "idx_slack_reconciliation_report_errors_report",
        unique: 0,
        origin: "c",
        partial: 0,
        column_name: "report_id",
      },
      {
        table_name: "slack_reconciliation_report_errors",
        index_name: "sqlite_autoindex_slack_reconciliation_report_errors_1",
        unique: 1,
        origin: "pk",
        partial: 0,
        column_name: "trace_id",
      },
      {
        table_name: "slack_reconciliation_reports",
        index_name: "idx_slack_reconciliation_reports_completed",
        unique: 0,
        origin: "c",
        partial: 0,
        column_name: "completed_at",
      },
      {
        table_name: "slack_reconciliation_reports",
        index_name: "sqlite_autoindex_slack_reconciliation_reports_1",
        unique: 1,
        origin: "pk",
        partial: 0,
        column_name: "report_id",
      },
    ],
    "Slack reconciliation index inventory",
  );

  const reconciliationForeignKeys = await query(
    configuration,
    databaseId,
    `SELECT id, seq, "table", "from", "to", on_update, on_delete, match
     FROM pragma_foreign_key_list('slack_reconciliation_report_errors')
     ORDER BY id, seq`,
  );
  exactRows(
    reconciliationForeignKeys.results,
    [
      {
        id: 0,
        seq: 0,
        table: "slack_workflow_traces",
        from: "trace_id",
        to: "trace_id",
        on_update: "NO ACTION",
        on_delete: "CASCADE",
        match: "NONE",
      },
    ],
    "Slack reconciliation foreign-key inventory",
  );

  const reconciliationSchemaObjects = await query(
    configuration,
    databaseId,
    `SELECT type, name, tbl_name, sql
     FROM sqlite_schema
     WHERE tbl_name IN (
       'slack_activity_scan_state',
       'slack_reconciliation_reports',
       'slack_reconciliation_report_errors',
       'slack_trace_hydration_registry'
       )
       AND sql IS NOT NULL
     ORDER BY type, name`,
  );
  exactRows(
    reconciliationSchemaObjects.results,
    SLACK_RECONCILIATION_SCHEMA_OBJECT_CONTRACT,
    "Slack reconciliation schema-object inventory",
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

async function proveSealedProtocolGuards(configuration, databaseId) {
  await expectD1QueryError(
    configuration,
    databaseId,
    `UPDATE relay_state
     SET slack_delivery_protocol_revision = ?
     WHERE singleton_id = 1`,
    ["e".repeat(40)],
    "slack_delivery_protocol_is_sealed",
  );
  await expectD1QueryError(
    configuration,
    databaseId,
    "DELETE FROM relay_state WHERE singleton_id = 1",
    [],
    "slack_delivery_protocol_is_sealed",
  );
  await expectD1QueryError(
    configuration,
    databaseId,
    `REPLACE INTO relay_state (
       singleton_id, next_slack_at, slack_activity_checkpoint_us,
       slack_delivery_protocol_active, slack_delivery_protocol_revision,
       slack_delivery_protocol_activated_at,
       slack_delivery_protocol_activation_id,
       slack_delivery_protocol_schema_revision,
       slack_delivery_protocol_confirmation_open
     ) VALUES (1, 0, 0, 1, ?, ?, ?, ?, 0)`,
    [
      SEALED_PROTOCOL_REVISION,
      SEALED_PROTOCOL_ACTIVATED_AT,
      SEALED_PROTOCOL_ACTIVATION_ID,
      SEALED_PROTOCOL_SCHEMA_REVISION,
    ],
    "slack_delivery_protocol_is_sealed",
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
        slack_delivery_protocol_revision: SEALED_PROTOCOL_REVISION,
        slack_delivery_protocol_activated_at: SEALED_PROTOCOL_ACTIVATED_AT,
        slack_delivery_protocol_activation_id: SEALED_PROTOCOL_ACTIVATION_ID,
        slack_delivery_protocol_schema_revision:
          SEALED_PROTOCOL_SCHEMA_REVISION,
        slack_delivery_protocol_confirmation_open: 0,
      },
    ],
    "Final sealed protocol state",
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
  verifyRemoteProofDeadline(environment);
  const configuration = readConfiguration(environment);
  startCloudflareRequestBudget(
    configuration,
    REMOTE_PROOF_API_REQUEST_CAP,
    "Remote D1 migration proof",
  );
  startWranglerCallBudget(configuration, REMOTE_PROOF_WRANGLER_CALL_CAP);
  const plan = await migrationPlan();
  const temporaryRoot = await mkdtemp(join(tmpdir(), "lcv-slack-d1-proof-"));
  let databaseId;
  let expectedCreatedAt;
  let primaryError;
  let cleanupError;
  let localCleanupError;
  try {
    invariant(
      (await findDisposableDatabase(configuration)) === undefined,
      "Refusing to adopt a pre-existing disposable D1 name.",
    );
    const createdDatabase = await createDisposableDatabase(configuration);
    databaseId = createdDatabase.id;
    expectedCreatedAt = createdDatabase.createdAt;
    const { fullConfig, preConfig, sourceConfig } =
      await prepareMigrationDirectories(
        temporaryRoot,
        configuration.databaseName,
        databaseId,
        plan,
      );
    await applyMigrationsToOwnedDatabase(
      configuration,
      databaseId,
      expectedCreatedAt,
      preConfig,
    );
    await seedOldSchema(configuration, databaseId);
    await applyMigrationsToOwnedDatabase(
      configuration,
      databaseId,
      expectedCreatedAt,
      sourceConfig,
    );
    await prepareProtocolSealSource(configuration, databaseId);
    await applyMigrationsToOwnedDatabase(
      configuration,
      databaseId,
      expectedCreatedAt,
      fullConfig,
    );
    await proveSealedProtocolContract(configuration, databaseId);
    await proveMigratedState(configuration, databaseId, plan.fullNames);
    await proveSchemaInventory(configuration, databaseId);
    await proveOldWorkerQuarantine(configuration, databaseId);
    await proveTraceConstraints(configuration, databaseId);
    await proveKnownLossRecovery(configuration, databaseId);
    await proveSealedProtocolGuards(configuration, databaseId);
  } catch (error) {
    primaryError = error;
  } finally {
    if (databaseId !== undefined && cleanupError === undefined) {
      try {
        await deleteDisposableDatabase(
          configuration,
          databaseId,
          expectedCreatedAt,
        );
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
    "Remote D1 proof passed: production-parity migrations, sealed delivery contract, migrated data, runtime triggers, quick_check, and cleanup.",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--reap-stale" && process.argv.length === 3) {
    const count = await reapStaleDisposableDatabases(
      readConfiguration(process.env),
    );
    console.log(
      `Disposable D1 reaper passed: ${count} stale database(s) removed.`,
    );
  } else {
    invariant(
      process.argv.length === 2,
      "Usage: verify-slack-relay-d1-remote.mjs [--reap-stale]",
    );
    await runRemoteMigrationProof();
  }
}
