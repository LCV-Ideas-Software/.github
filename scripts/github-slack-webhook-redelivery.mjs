import { pathToFileURL } from "node:url";

export const API_VERSION = "2026-03-10";
export const CHECKPOINT_VARIABLE = "SLACK_RELAY_LAST_REDELIVERY";

const API_ORIGIN = "https://api.github.com";
const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const MAX_REDELIVERY_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const PAGE_SIZE = 100;
const MAX_PAGES = 1_000;
const REQUEST_TIMEOUT_MS = 30_000;
const USER_AGENT = "lcv-github-slack-webhook-redelivery";

export class GitHubApiError extends Error {
  constructor(message, { status, requestId, rateLimited } = {}) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
    this.requestId = requestId;
    this.rateLimited = Boolean(rateLimited);
  }
}

function requiredEnvironmentValue(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Required environment variable ${name} is missing.`);
  }
  return value.trim();
}

export function readConfiguration(environment = process.env) {
  const hookId = requiredEnvironmentValue(environment, "HOOK_ID");
  if (!/^\d+$/.test(hookId) || BigInt(hookId) <= 0n) {
    throw new Error("HOOK_ID must be a positive integer.");
  }
  const organizationId = requiredEnvironmentValue(
    environment,
    "ORGANIZATION_ID",
  );
  if (!/^\d+$/.test(organizationId) || BigInt(organizationId) <= 0n) {
    throw new Error("ORGANIZATION_ID must be a positive integer.");
  }

  return Object.freeze({
    token: requiredEnvironmentValue(environment, "TOKEN"),
    organizationName: requiredEnvironmentValue(
      environment,
      "ORGANIZATION_NAME",
    ),
    organizationId,
    hookId,
    workflowRepoOwner: requiredEnvironmentValue(
      environment,
      "WORKFLOW_REPO_OWNER",
    ),
    workflowRepoName: requiredEnvironmentValue(
      environment,
      "WORKFLOW_REPO_NAME",
    ),
  });
}

function endpointPath(parts) {
  return parts.map((part) => encodeURIComponent(part)).join("/");
}

function apiUrl(pathname, searchParams) {
  const url = new URL(pathname, API_ORIGIN);
  if (searchParams) {
    for (const [name, value] of Object.entries(searchParams)) {
      if (value !== undefined) {
        url.searchParams.set(name, String(value));
      }
    }
  }
  return url;
}

function apiError(response, method, pathname) {
  const remaining = response.headers.get("x-ratelimit-remaining");
  const reset = response.headers.get("x-ratelimit-reset");
  const retryAfter = response.headers.get("retry-after");
  const requestId = response.headers.get("x-github-request-id") ?? undefined;
  const oauthScopes = (response.headers.get("x-oauth-scopes") ?? "")
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
  const ssoAuthorization = response.headers.get("x-github-sso");
  const rateLimited =
    response.status === 429 || (response.status === 403 && remaining === "0");

  const context = [];
  if (rateLimited) {
    context.push("GitHub API rate limit reached");
  }
  if (retryAfter) {
    context.push(`retry-after=${retryAfter}s`);
  }
  if (reset && /^\d+$/.test(reset)) {
    context.push(
      `rate-limit-reset=${new Date(Number(reset) * 1000).toISOString()}`,
    );
  }
  if (requestId) {
    context.push(`request-id=${requestId}`);
  }
  if (response.status === 404 && oauthScopes.length > 0) {
    context.push(
      `admin:org_hook-scope=${oauthScopes.includes("admin:org_hook") ? "present" : "missing"}`,
    );
  }
  if (ssoAuthorization) {
    context.push("sso-authorization=required");
  }

  const suffix = context.length > 0 ? ` (${context.join(", ")})` : "";
  return new GitHubApiError(
    `GitHub API ${method} ${pathname} returned HTTP ${response.status}${suffix}.`,
    { status: response.status, requestId, rateLimited },
  );
}

async function githubRequest({
  token,
  method = "GET",
  url,
  body,
  fetchImpl,
  allowedStatuses = [],
}) {
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": API_VERSION,
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new Error(
        `GitHub API ${method} ${url.pathname} timed out after ${REQUEST_TIMEOUT_MS}ms.`,
        { cause: error },
      );
    }
    throw new Error(
      `GitHub API ${method} ${url.pathname} could not be reached.`,
      { cause: error },
    );
  }

  if (!response.ok && !allowedStatuses.includes(response.status)) {
    throw apiError(response, method, url.pathname);
  }
  return response;
}

async function readJson(response, description) {
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`GitHub returned invalid JSON for ${description}.`, {
      cause: error,
    });
  }
}

async function readDeliveryPageJson(response) {
  let text;
  try {
    text = await response.text();
  } catch (error) {
    throw new Error("GitHub webhook deliveries could not be read.", {
      cause: error,
    });
  }

  try {
    return JSON.parse(text, (key, value, context) => {
      // GitHub delivery IDs currently exceed Number.MAX_SAFE_INTEGER. The
      // reviver's source text preserves every decimal digit before the rounded
      // JavaScript Number can reach endpoint construction.
      if (
        key === "id" &&
        typeof value === "number" &&
        typeof context?.source === "string" &&
        /^\d+$/.test(context.source)
      ) {
        return BigInt(context.source);
      }
      return value;
    });
  } catch (error) {
    throw new Error(
      "GitHub returned invalid JSON for organization webhook deliveries.",
      { cause: error },
    );
  }
}

export function parseNextCursor(
  linkHeader,
  expectedPathname,
  canonicalPathname,
) {
  if (!linkHeader) {
    return undefined;
  }

  for (const match of linkHeader.matchAll(/<([^>]+)>([^,]*)/g)) {
    const [, candidate, parameters] = match;
    const relation = parameters.match(/(?:^|;)\s*rel\s*=\s*"?([^";,]+)"?/i);
    if (!relation?.[1].split(/\s+/).includes("next")) {
      continue;
    }

    let nextUrl;
    try {
      nextUrl = new URL(candidate);
    } catch (error) {
      throw new Error("GitHub returned an invalid next-page URL.", {
        cause: error,
      });
    }
    const allowedPathnames = new Set(
      [expectedPathname, canonicalPathname].filter(Boolean),
    );
    if (
      nextUrl.origin !== API_ORIGIN ||
      !allowedPathnames.has(nextUrl.pathname)
    ) {
      throw new Error(
        "GitHub returned a next-page URL outside the expected deliveries endpoint.",
      );
    }

    const cursor = nextUrl.searchParams.get("cursor");
    if (!cursor) {
      throw new Error("GitHub returned a next-page URL without a cursor.");
    }
    return cursor;
  }

  return undefined;
}

function parseCheckpoint(value) {
  if (/^\d+$/.test(value)) {
    return Number(value);
  }
  return Date.parse(value);
}

export function resolveCheckpoint(
  storedValue,
  startedAt,
  { warn = () => {} } = {},
) {
  if (!Number.isSafeInteger(startedAt) || startedAt <= 0) {
    throw new Error(
      "The run start time must be a positive epoch millisecond value.",
    );
  }

  const candidate =
    storedValue === undefined
      ? startedAt - DEFAULT_LOOKBACK_MS
      : parseCheckpoint(storedValue);
  if (!Number.isSafeInteger(candidate) || candidate <= 0) {
    throw new Error(
      `${CHECKPOINT_VARIABLE} must contain epoch milliseconds or a valid timestamp.`,
    );
  }
  if (candidate > startedAt) {
    throw new Error(`${CHECKPOINT_VARIABLE} cannot be in the future.`);
  }

  const oldestRedeliverable = startedAt - MAX_REDELIVERY_AGE_MS;
  if (candidate < oldestRedeliverable) {
    warn(
      `${CHECKPOINT_VARIABLE} is older than GitHub's three-day redelivery window; clamping the scan to the oldest redeliverable instant.`,
    );
    return oldestRedeliverable;
  }
  return candidate;
}

function normalizeDelivery(delivery) {
  if (!delivery || typeof delivery !== "object") {
    throw new Error("GitHub returned a malformed webhook delivery.");
  }
  if (typeof delivery.id !== "bigint" || delivery.id <= 0n) {
    throw new Error("GitHub returned a webhook delivery with an invalid ID.");
  }
  if (typeof delivery.guid !== "string" || delivery.guid === "") {
    throw new Error("GitHub returned a webhook delivery without a GUID.");
  }
  if (typeof delivery.delivered_at !== "string") {
    throw new Error("GitHub returned a webhook delivery without a timestamp.");
  }
  const deliveredAt = Date.parse(delivery.delivered_at);
  if (!Number.isSafeInteger(deliveredAt)) {
    throw new Error(
      "GitHub returned a webhook delivery with an invalid timestamp.",
    );
  }
  if (typeof delivery.status !== "string") {
    throw new Error("GitHub returned a webhook delivery without a status.");
  }
  if (!Number.isInteger(delivery.status_code)) {
    throw new Error(
      "GitHub returned a webhook delivery without a status code.",
    );
  }

  // Deliberately retain metadata only. Request and response payloads are never
  // copied, logged, or persisted by this recovery process.
  return Object.freeze({
    id: delivery.id.toString(),
    guid: delivery.guid,
    deliveredAt,
    status: delivery.status,
    statusCode: delivery.status_code,
  });
}

export async function fetchDeliveriesSince({
  token,
  organizationName,
  organizationId,
  hookId,
  cutoff,
  fetchImpl = globalThis.fetch,
}) {
  const deliveriesPath = `/orgs/${endpointPath([
    organizationName,
  ])}/hooks/${endpointPath([hookId])}/deliveries`;
  const canonicalDeliveriesPath = `/organizations/${endpointPath([
    organizationId,
  ])}/hooks/${endpointPath([hookId])}/deliveries`;
  let cursor;
  const seenCursors = new Set();
  const seenDeliveries = new Map();
  const deliveries = [];

  const newestFirst = () =>
    deliveries.sort((left, right) => {
      if (left.deliveredAt !== right.deliveredAt) {
        return right.deliveredAt - left.deliveredAt;
      }
      const leftId = BigInt(left.id);
      const rightId = BigInt(right.id);
      return leftId < rightId ? 1 : leftId > rightId ? -1 : 0;
    });

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await githubRequest({
      token,
      url: apiUrl(deliveriesPath, {
        per_page: PAGE_SIZE,
        cursor,
      }),
      fetchImpl,
    });
    const pageData = await readDeliveryPageJson(response);
    if (!Array.isArray(pageData)) {
      throw new Error("GitHub returned a non-array deliveries page.");
    }

    const nextCursor = parseNextCursor(
      response.headers.get("link"),
      deliveriesPath,
      canonicalDeliveriesPath,
    );
    if (pageData.length === 0) {
      if (nextCursor) {
        throw new Error(
          "GitHub returned an empty deliveries page with a next cursor; refusing to advance the checkpoint.",
        );
      }
      return newestFirst();
    }

    for (const rawDelivery of pageData) {
      const delivery = normalizeDelivery(rawDelivery);
      const prior = seenDeliveries.get(delivery.id);
      if (
        prior &&
        (prior.guid !== delivery.guid ||
          prior.deliveredAt !== delivery.deliveredAt ||
          prior.status !== delivery.status ||
          prior.statusCode !== delivery.statusCode)
      ) {
        throw new Error(
          "GitHub returned contradictory metadata for the same webhook delivery ID.",
        );
      }
      if (prior) {
        continue;
      }
      seenDeliveries.set(delivery.id, delivery);

      if (delivery.deliveredAt >= cutoff) {
        deliveries.push(delivery);
      }
    }

    // GitHub does not document a stable order for this endpoint, and webhook
    // events can arrive out of order. Follow every bounded cursor before
    // filtering and sorting, so a newer delivery can never be skipped merely
    // because an older one appeared first.
    if (!nextCursor) {
      return newestFirst();
    }
    if (seenCursors.has(nextCursor)) {
      throw new Error("GitHub returned a repeated deliveries cursor.");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  throw new Error(
    `GitHub deliveries pagination exceeded the safety limit of ${MAX_PAGES} pages.`,
  );
}

export function wasSuccessful(delivery) {
  // The organization-deliveries endpoint classifies 200-399 as success. The
  // numeric status is authoritative so a contradictory textual "OK" can never
  // turn a 4xx/5xx attempt into a successful one.
  return delivery.statusCode >= 200 && delivery.statusCode <= 399;
}

export function selectFailedDeliveryIds(deliveries) {
  const compareIds = (left, right) => {
    const leftId = BigInt(left);
    const rightId = BigInt(right);
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  };

  const byGuid = new Map();
  for (const delivery of deliveries) {
    const attempts = byGuid.get(delivery.guid) ?? [];
    attempts.push(delivery);
    byGuid.set(delivery.guid, attempts);
  }

  const failures = [];
  for (const attempts of byGuid.values()) {
    if (attempts.some(wasSuccessful)) {
      continue;
    }
    const latest = attempts.reduce((candidate, attempt) => {
      if (attempt.deliveredAt !== candidate.deliveredAt) {
        return attempt.deliveredAt > candidate.deliveredAt
          ? attempt
          : candidate;
      }
      return compareIds(attempt.id, candidate.id) > 0 ? attempt : candidate;
    });
    failures.push(latest);
  }

  // Preserve event chronology when several independent deliveries need recovery.
  failures.sort(
    (left, right) =>
      left.deliveredAt - right.deliveredAt || compareIds(left.id, right.id),
  );
  return failures.map((delivery) => delivery.id);
}

async function getCheckpointVariable({ token, owner, repository, fetchImpl }) {
  const pathname = `/repos/${endpointPath([
    owner,
    repository,
  ])}/actions/variables/${CHECKPOINT_VARIABLE}`;
  const response = await githubRequest({
    token,
    url: apiUrl(pathname),
    fetchImpl,
    allowedStatuses: [404],
  });
  if (response.status === 404) {
    return { exists: false, value: undefined };
  }

  const data = await readJson(response, CHECKPOINT_VARIABLE);
  if (!data || typeof data.value !== "string" || data.value === "") {
    throw new Error(`GitHub returned an invalid ${CHECKPOINT_VARIABLE} value.`);
  }
  return { exists: true, value: data.value };
}

async function writeCheckpointVariable({
  token,
  owner,
  repository,
  value,
  exists,
  fetchImpl,
}) {
  const variablesPath = `/repos/${endpointPath([
    owner,
    repository,
  ])}/actions/variables`;
  const url = exists
    ? apiUrl(`${variablesPath}/${CHECKPOINT_VARIABLE}`)
    : apiUrl(variablesPath);
  await githubRequest({
    token,
    method: exists ? "PATCH" : "POST",
    url,
    body: { name: CHECKPOINT_VARIABLE, value },
    fetchImpl,
  });
}

async function redeliver({
  token,
  organizationName,
  hookId,
  deliveryId,
  fetchImpl,
}) {
  const pathname = `/orgs/${endpointPath([
    organizationName,
  ])}/hooks/${endpointPath([hookId])}/deliveries/${endpointPath([
    String(deliveryId),
  ])}/attempts`;
  const response = await githubRequest({
    token,
    method: "POST",
    url: apiUrl(pathname),
    fetchImpl,
  });
  if (response.status !== 202) {
    throw new GitHubApiError(
      `GitHub API POST ${pathname} returned HTTP ${response.status}; expected HTTP 202.`,
      { status: response.status },
    );
  }
}

export async function runRedelivery({
  environment = process.env,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  logger = console,
} = {}) {
  const configuration = readConfiguration(environment);
  if (typeof fetchImpl !== "function") {
    throw new Error("A Fetch-compatible implementation is required.");
  }

  const startedAt = now();
  const checkpoint = await getCheckpointVariable({
    token: configuration.token,
    owner: configuration.workflowRepoOwner,
    repository: configuration.workflowRepoName,
    fetchImpl,
  });
  const cutoff = resolveCheckpoint(checkpoint.value, startedAt, {
    warn: (message) => logger.warn(message),
  });

  const deliveries = await fetchDeliveriesSince({
    token: configuration.token,
    organizationName: configuration.organizationName,
    organizationId: configuration.organizationId,
    hookId: configuration.hookId,
    cutoff,
    fetchImpl,
  });
  const failedDeliveryIds = selectFailedDeliveryIds(deliveries);

  for (const deliveryId of failedDeliveryIds) {
    await redeliver({
      token: configuration.token,
      organizationName: configuration.organizationName,
      hookId: configuration.hookId,
      deliveryId,
      fetchImpl,
    });
  }

  // Persist only after every API read and redelivery request has succeeded. A
  // partial failure therefore keeps the previous checkpoint for the next run.
  await writeCheckpointVariable({
    token: configuration.token,
    owner: configuration.workflowRepoOwner,
    repository: configuration.workflowRepoName,
    value: String(startedAt),
    exists: checkpoint.exists,
    fetchImpl,
  });

  logger.info(
    `Accepted ${failedDeliveryIds.length} webhook redelivery request(s) after examining ${deliveries.length} delivery record(s) since ${new Date(cutoff).toISOString()}.`,
  );
  return Object.freeze({
    examined: deliveries.length,
    redeliveries: failedDeliveryIds.length,
    checkpoint: String(startedAt),
  });
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (invokedPath === import.meta.url) {
  runRedelivery().catch((error) => {
    // Error messages contain only request metadata. Tokens and webhook payloads
    // are intentionally never included in this process's logs.
    console.error(
      error instanceof Error ? error.message : "Redelivery failed.",
    );
    process.exitCode = 1;
  });
}
