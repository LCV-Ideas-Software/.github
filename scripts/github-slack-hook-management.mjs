import { pathToFileURL } from "node:url";

export const API_VERSION = "2026-03-10";
export const HOOK_VARIABLE = "SLACK_RELAY_ORG_HOOK_ID";
export const WEBHOOK_URL =
  "https://github-slack-alerts.lcv.workers.dev/github/webhook";
export const HOOK_EVENTS = Object.freeze([
  "workflow_run",
  "deployment_status",
  "dependabot_alert",
  "code_scanning_alert",
  "secret_scanning_alert",
  "push",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "issues",
  "issue_comment",
  "release",
  "discussion",
  "discussion_comment",
]);

const API_ORIGIN = "https://api.github.com";
const PAGE_SIZE = 100;
const MAX_PAGES = 1_000;
const REQUEST_TIMEOUT_MS = 30_000;
const USER_AGENT = "lcv-github-slack-hook-management";
const OPERATIONS = new Set(["provision", "activate", "deactivate", "ping"]);

export class GitHubApiError extends Error {
  constructor(message, { status, requestId, rateLimited } = {}) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
    this.requestId = requestId;
    this.rateLimited = Boolean(rateLimited);
  }
}

class UncertainVariableMutationError extends AggregateError {
  constructor(errors) {
    super(
      errors,
      `The outcome of synchronizing repository variable ${HOOK_VARIABLE} is uncertain; the managed organization webhook was preserved for safe reconciliation.`,
    );
    this.name = "UncertainVariableMutationError";
    this.rollbackSafe = false;
  }
}

function requiredEnvironmentValue(
  environment,
  name,
  { sensitive = false } = {},
) {
  const value = environment[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Required environment variable ${name} is missing.`);
  }
  if (sensitive && value !== value.trim()) {
    throw new Error(
      `Required environment variable ${name} contains surrounding whitespace.`,
    );
  }
  return sensitive ? value : value.trim();
}

function positiveHookId(value, description = "HOOK_ID") {
  if (!/^\d+$/.test(value) || BigInt(value) <= 0n) {
    throw new Error(`${description} must be a positive integer.`);
  }
  return value;
}

export function readConfiguration(environment = process.env) {
  const operation = requiredEnvironmentValue(environment, "OPERATION");
  if (!OPERATIONS.has(operation)) {
    throw new Error(
      "OPERATION must be one of provision, activate, deactivate, or ping.",
    );
  }
  if (
    requiredEnvironmentValue(environment, "GITHUB_REF") !== "refs/heads/main"
  ) {
    throw new Error("Organization webhook management is restricted to main.");
  }

  const organizationName = requiredEnvironmentValue(
    environment,
    "ORGANIZATION_NAME",
  );
  const workflowRepoOwner = requiredEnvironmentValue(
    environment,
    "WORKFLOW_REPO_OWNER",
  );
  if (organizationName !== workflowRepoOwner) {
    throw new Error(
      "ORGANIZATION_NAME must match WORKFLOW_REPO_OWNER from the GitHub context.",
    );
  }

  const configuration = {
    operation,
    token: requiredEnvironmentValue(environment, "TOKEN", { sensitive: true }),
    organizationName,
    workflowRepoOwner,
    workflowRepoName: requiredEnvironmentValue(
      environment,
      "WORKFLOW_REPO_NAME",
    ),
  };

  if (
    operation === "provision" ||
    operation === "activate" ||
    operation === "deactivate"
  ) {
    configuration.webhookSecret = requiredEnvironmentValue(
      environment,
      "WEBHOOK_SECRET",
      { sensitive: true },
    );
  }
  if (operation !== "provision") {
    configuration.hookId = positiveHookId(
      requiredEnvironmentValue(environment, "HOOK_ID"),
    );
  }

  return Object.freeze(configuration);
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
  if (rateLimited) context.push("GitHub API rate limit reached");
  if (retryAfter) context.push(`retry-after=${retryAfter}s`);
  if (reset && /^\d+$/.test(reset)) {
    context.push(
      `rate-limit-reset=${new Date(Number(reset) * 1_000).toISOString()}`,
    );
  }
  if (requestId) context.push(`request-id=${requestId}`);
  if (response.status === 404 && pathname.startsWith("/orgs/")) {
    context.push(
      `admin:org_hook-scope=${oauthScopes.includes("admin:org_hook") ? "present" : "missing"}`,
    );
  }
  if (ssoAuthorization) context.push("sso-authorization=required");

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
  expectedStatuses = [200],
}) {
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": API_VERSION,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";

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

  if (!expectedStatuses.includes(response.status)) {
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

function hookIdFromResponse(hook) {
  if (!hook || !Number.isSafeInteger(hook.id) || hook.id <= 0) {
    throw new Error(
      "GitHub returned an organization webhook with an invalid ID.",
    );
  }
  return String(hook.id);
}

function sameEvents(events) {
  if (
    !Array.isArray(events) ||
    events.length !== HOOK_EVENTS.length ||
    events.some((event) => typeof event !== "string") ||
    new Set(events).size !== events.length
  ) {
    return false;
  }
  const actual = [...events].sort();
  const expected = [...HOOK_EVENTS].sort();
  return actual.every((event, index) => event === expected[index]);
}

function hasExactConfiguration(hook) {
  return Boolean(
    hook &&
    hook.name === "web" &&
    hook.config &&
    hook.config.url === WEBHOOK_URL &&
    hook.config.content_type === "json" &&
    String(hook.config.insecure_ssl) === "0" &&
    sameEvents(hook.events),
  );
}

function validateTargetHook(hook, { expectedActive } = {}) {
  const hookId = hookIdFromResponse(hook);
  if (typeof hook.active !== "boolean") {
    throw new Error(
      `Organization webhook ${hookId} has an invalid active state.`,
    );
  }
  if (!hasExactConfiguration(hook)) {
    throw new Error(
      `Organization webhook ${hookId} does not exactly match the managed GitHub Slack relay configuration.`,
    );
  }
  if (expectedActive !== undefined && hook.active !== expectedActive) {
    throw new Error(
      `Organization webhook ${hookId} did not reach active=${expectedActive}.`,
    );
  }
  return Object.freeze({ hookId, active: hook.active });
}

export function parseNextHookPage(linkHeader, expectedPathname) {
  if (!linkHeader) return undefined;

  for (const match of linkHeader.matchAll(/<([^>]+)>([^,]*)/g)) {
    const [, candidate, parameters] = match;
    const relation = parameters.match(/(?:^|;)\s*rel\s*=\s*"?([^";,]+)"?/i);
    if (!relation?.[1].split(/\s+/).includes("next")) continue;

    let nextUrl;
    try {
      nextUrl = new URL(candidate);
    } catch (error) {
      throw new Error("GitHub returned an invalid next-page URL.", {
        cause: error,
      });
    }
    if (
      nextUrl.origin !== API_ORIGIN ||
      nextUrl.pathname !== expectedPathname
    ) {
      throw new Error(
        "GitHub returned a next-page URL outside the expected organization hooks endpoint.",
      );
    }
    if (nextUrl.searchParams.get("per_page") !== String(PAGE_SIZE)) {
      throw new Error(
        "GitHub returned a next-page URL with an invalid page size.",
      );
    }
    const page = nextUrl.searchParams.get("page");
    if (!page || !/^\d+$/.test(page) || Number(page) <= 1) {
      throw new Error(
        "GitHub returned a next-page URL with an invalid page number.",
      );
    }
    return nextUrl;
  }
  return undefined;
}

async function listVisibleHooks({ token, organizationName, fetchImpl }) {
  const pathname = `/orgs/${endpointPath([organizationName])}/hooks`;
  let nextUrl = apiUrl(pathname, { per_page: PAGE_SIZE, page: 1 });
  const seenPages = new Set();
  const seenHookIds = new Set();
  const hooks = [];

  for (let pageCount = 1; pageCount <= MAX_PAGES; pageCount += 1) {
    const page = nextUrl.searchParams.get("page");
    if (seenPages.has(page)) {
      throw new Error("GitHub returned a repeated organization hooks page.");
    }
    seenPages.add(page);

    const response = await githubRequest({
      token,
      url: nextUrl,
      fetchImpl,
    });
    const pageData = await readJson(response, "organization webhooks");
    if (!Array.isArray(pageData)) {
      throw new Error("GitHub returned a non-array organization hooks page.");
    }
    for (const hook of pageData) {
      const hookId = hookIdFromResponse(hook);
      if (seenHookIds.has(hookId)) {
        throw new Error(
          `GitHub returned duplicate organization webhook ${hookId}.`,
        );
      }
      seenHookIds.add(hookId);
      hooks.push(hook);
    }

    nextUrl = parseNextHookPage(response.headers.get("link"), pathname);
    if (!nextUrl) return hooks;
  }

  throw new Error(
    `GitHub organization hooks pagination exceeded the safety limit of ${MAX_PAGES} pages.`,
  );
}

function hookPath(organizationName, hookId) {
  return `/orgs/${endpointPath([organizationName])}/hooks/${endpointPath([
    hookId,
  ])}`;
}

async function getHook({ token, organizationName, hookId, fetchImpl }) {
  const pathname = hookPath(organizationName, hookId);
  const response = await githubRequest({
    token,
    url: apiUrl(pathname),
    fetchImpl,
  });
  return readJson(response, `organization webhook ${hookId}`);
}

function targetConfig(secret) {
  return {
    url: WEBHOOK_URL,
    content_type: "json",
    secret,
    insecure_ssl: "0",
  };
}

async function createInactiveHook({
  token,
  webhookSecret,
  organizationName,
  fetchImpl,
}) {
  const pathname = `/orgs/${endpointPath([organizationName])}/hooks`;
  const response = await githubRequest({
    token,
    method: "POST",
    url: apiUrl(pathname),
    body: {
      name: "web",
      config: targetConfig(webhookSecret),
      events: HOOK_EVENTS,
      active: false,
    },
    fetchImpl,
    expectedStatuses: [201],
  });
  return readJson(response, "new organization webhook");
}

async function patchHookActive({
  token,
  webhookSecret,
  organizationName,
  hookId,
  active,
  fetchImpl,
}) {
  const pathname = hookPath(organizationName, hookId);
  const response = await githubRequest({
    token,
    method: "PATCH",
    url: apiUrl(pathname),
    body: {
      name: "web",
      config: targetConfig(webhookSecret),
      events: HOOK_EVENTS,
      active,
    },
    fetchImpl,
  });
  return readJson(response, `updated organization webhook ${hookId}`);
}

async function deleteHook({ token, organizationName, hookId, fetchImpl }) {
  const pathname = hookPath(organizationName, hookId);
  await githubRequest({
    token,
    method: "DELETE",
    url: apiUrl(pathname),
    fetchImpl,
    expectedStatuses: [204],
  });
}

async function pingHook({ token, organizationName, hookId, fetchImpl }) {
  const pathname = `${hookPath(organizationName, hookId)}/pings`;
  await githubRequest({
    token,
    method: "POST",
    url: apiUrl(pathname),
    fetchImpl,
    expectedStatuses: [204],
  });
}

async function upsertHookVariable({
  token,
  owner,
  repository,
  hookId,
  fetchImpl,
}) {
  const variablesPath = `/repos/${endpointPath([
    owner,
    repository,
  ])}/actions/variables`;
  const variablePath = `${variablesPath}/${HOOK_VARIABLE}`;
  const readVariable = async () => {
    const response = await githubRequest({
      token,
      url: apiUrl(variablePath),
      fetchImpl,
      expectedStatuses: [200, 404],
    });
    if (response.status === 404) return undefined;

    const variable = await readJson(
      response,
      `repository variable ${HOOK_VARIABLE}`,
    );
    if (
      !variable ||
      variable.name !== HOOK_VARIABLE ||
      typeof variable.value !== "string"
    ) {
      throw new Error(
        `GitHub returned an invalid repository variable ${HOOK_VARIABLE}.`,
      );
    }
    return variable.value;
  };

  const previousValue = await readVariable();
  if (previousValue === hookId) return;

  try {
    if (previousValue === undefined) {
      await githubRequest({
        token,
        method: "POST",
        url: apiUrl(variablesPath),
        body: { name: HOOK_VARIABLE, value: hookId },
        fetchImpl,
        expectedStatuses: [201],
      });
    } else {
      await githubRequest({
        token,
        method: "PATCH",
        url: apiUrl(variablePath),
        body: { name: HOOK_VARIABLE, value: hookId },
        fetchImpl,
        expectedStatuses: [204],
      });
    }
  } catch (mutationError) {
    try {
      if ((await readVariable()) === hookId) return;
    } catch (reconciliationError) {
      throw new UncertainVariableMutationError([
        mutationError,
        reconciliationError,
      ]);
    }
    throw new UncertainVariableMutationError([mutationError]);
  }

  let persistedValue;
  try {
    persistedValue = await readVariable();
  } catch (verificationError) {
    throw new UncertainVariableMutationError([verificationError]);
  }
  if (persistedValue !== hookId) {
    throw new UncertainVariableMutationError([
      new Error(
        `Repository variable ${HOOK_VARIABLE} did not immediately report the managed organization webhook ID.`,
      ),
    ]);
  }
}

async function rollbackCreatedHook(
  configuration,
  hookId,
  originalError,
  fetchImpl,
) {
  try {
    await deleteHook({ ...configuration, hookId, fetchImpl });
  } catch (rollbackError) {
    throw new AggregateError(
      [originalError, rollbackError],
      "Provisioning failed and rollback of the newly created organization webhook also failed.",
    );
  }
  throw originalError;
}

async function provision(configuration, fetchImpl, logger) {
  const hooks = await listVisibleHooks({ ...configuration, fetchImpl });
  const targetUrlHooks = hooks.filter(
    (hook) => hook?.config?.url === WEBHOOK_URL,
  );
  const exactHooks = targetUrlHooks.filter(hasExactConfiguration);

  if (
    targetUrlHooks.length > 0 &&
    (targetUrlHooks.length !== 1 || exactHooks.length !== 1)
  ) {
    throw new Error(
      "A PAT-visible organization webhook at the managed relay URL has configuration drift or is duplicated.",
    );
  }

  let hookId;
  let created = false;
  if (exactHooks.length === 1) {
    hookId = validateTargetHook(exactHooks[0]).hookId;
    validateTargetHook(await getHook({ ...configuration, hookId, fetchImpl }));
  } else {
    const createdHook = await createInactiveHook({
      ...configuration,
      fetchImpl,
    });
    hookId = hookIdFromResponse(createdHook);
    created = true;
    try {
      validateTargetHook(createdHook, { expectedActive: false });
      validateTargetHook(
        await getHook({ ...configuration, hookId, fetchImpl }),
        { expectedActive: false },
      );
    } catch (error) {
      return rollbackCreatedHook(configuration, hookId, error, fetchImpl);
    }
  }

  try {
    await upsertHookVariable({
      token: configuration.token,
      owner: configuration.workflowRepoOwner,
      repository: configuration.workflowRepoName,
      hookId,
      fetchImpl,
    });
  } catch (error) {
    if (created && error?.rollbackSafe !== false) {
      return rollbackCreatedHook(configuration, hookId, error, fetchImpl);
    }
    throw error;
  }

  logger.info(
    `${created ? "Provisioned inactive" : "Reused PAT-visible"} organization webhook ${hookId} and synchronized ${HOOK_VARIABLE}.`,
  );
  return Object.freeze({ operation: "provision", hookId, created });
}

async function validateSoleManagedHook(configuration, fetchImpl) {
  const hooks = await listVisibleHooks({ ...configuration, fetchImpl });
  const managedUrlHooks = hooks.filter(
    (hook) => hook?.config?.url === WEBHOOK_URL,
  );
  if (managedUrlHooks.length !== 1) {
    throw new Error(
      `Expected exactly one PAT-visible organization webhook at the managed relay URL; found ${managedUrlHooks.length}.`,
    );
  }

  const target = validateTargetHook(managedUrlHooks[0]);
  if (target.hookId !== configuration.hookId) {
    throw new Error(
      `The sole PAT-visible organization webhook at the managed relay URL has ID ${target.hookId}, not configured HOOK_ID ${configuration.hookId}.`,
    );
  }
  return target;
}

async function activate(configuration, fetchImpl, logger) {
  await validateSoleManagedHook(configuration, fetchImpl);
  const before = validateTargetHook(
    await getHook({ ...configuration, fetchImpl }),
  );
  try {
    validateTargetHook(
      await patchHookActive({ ...configuration, active: true, fetchImpl }),
      { expectedActive: true },
    );
    validateTargetHook(await getHook({ ...configuration, fetchImpl }), {
      expectedActive: true,
    });
    await pingHook({ ...configuration, fetchImpl });
  } catch (error) {
    // A transport failure after PATCH is ambiguous: GitHub may have applied the
    // activation even when the response never reached the runner. Always drive
    // a previously inactive hook back to inactive after an attempted PATCH.
    if (!before.active) {
      try {
        validateTargetHook(
          await patchHookActive({ ...configuration, active: false, fetchImpl }),
          { expectedActive: false },
        );
        validateTargetHook(await getHook({ ...configuration, fetchImpl }), {
          expectedActive: false,
        });
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Activation failed and rollback to inactive also failed.",
        );
      }
    }
    throw error;
  }

  logger.info(
    `Activated and pinged organization webhook ${configuration.hookId}.`,
  );
  return Object.freeze({
    operation: "activate",
    hookId: configuration.hookId,
    active: true,
  });
}

async function deactivate(configuration, fetchImpl, logger) {
  await validateSoleManagedHook(configuration, fetchImpl);
  validateTargetHook(await getHook({ ...configuration, fetchImpl }));
  validateTargetHook(
    await patchHookActive({ ...configuration, active: false, fetchImpl }),
    { expectedActive: false },
  );
  validateTargetHook(await getHook({ ...configuration, fetchImpl }), {
    expectedActive: false,
  });
  logger.info(`Deactivated organization webhook ${configuration.hookId}.`);
  return Object.freeze({
    operation: "deactivate",
    hookId: configuration.hookId,
    active: false,
  });
}

async function ping(configuration, fetchImpl, logger) {
  await validateSoleManagedHook(configuration, fetchImpl);
  validateTargetHook(await getHook({ ...configuration, fetchImpl }), {
    expectedActive: true,
  });
  await pingHook({ ...configuration, fetchImpl });
  logger.info(`Pinged active organization webhook ${configuration.hookId}.`);
  return Object.freeze({
    operation: "ping",
    hookId: configuration.hookId,
    active: true,
  });
}

export async function runHookManagement({
  environment = process.env,
  fetchImpl = globalThis.fetch,
  logger = console,
} = {}) {
  const configuration = readConfiguration(environment);
  if (typeof fetchImpl !== "function") {
    throw new Error("A Fetch-compatible implementation is required.");
  }

  switch (configuration.operation) {
    case "provision":
      return provision(configuration, fetchImpl, logger);
    case "activate":
      return activate(configuration, fetchImpl, logger);
    case "deactivate":
      return deactivate(configuration, fetchImpl, logger);
    case "ping":
      return ping(configuration, fetchImpl, logger);
    default:
      throw new Error("Unsupported operation.");
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (invokedPath === import.meta.url) {
  runHookManagement().catch((error) => {
    // Messages contain request metadata only; credentials and response bodies
    // are deliberately never rendered by this process.
    console.error(
      error instanceof Error ? error.message : "Webhook management failed.",
    );
    process.exitCode = 1;
  });
}
