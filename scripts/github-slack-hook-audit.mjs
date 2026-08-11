import { pathToFileURL } from "node:url";

export const API_VERSION = "2026-03-10";
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
const USER_AGENT = "lcv-github-slack-hook-audit";

export class GitHubApiError extends Error {
  constructor(message, { status, requestId, rateLimited } = {}) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
    this.requestId = requestId;
    this.rateLimited = Boolean(rateLimited);
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
  if (
    requiredEnvironmentValue(environment, "GITHUB_REF") !== "refs/heads/main"
  ) {
    throw new Error("Organization webhook audit is restricted to main.");
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
  if (
    requiredEnvironmentValue(environment, "WORKFLOW_REPO_NAME") !== ".github"
  ) {
    throw new Error("Organization webhook audit is restricted to .github.");
  }

  return Object.freeze({
    token: requiredEnvironmentValue(environment, "TOKEN", { sensitive: true }),
    hookId: positiveHookId(requiredEnvironmentValue(environment, "HOOK_ID")),
    organizationName,
  });
}

function endpointPath(parts) {
  return parts.map((part) => encodeURIComponent(part)).join("/");
}

function apiUrl(pathname, searchParams) {
  const url = new URL(pathname, API_ORIGIN);
  if (searchParams) {
    for (const [name, value] of Object.entries(searchParams)) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
  }
  return url;
}

function apiError(response, pathname) {
  const remaining = response.headers.get("x-ratelimit-remaining");
  const reset = response.headers.get("x-ratelimit-reset");
  const retryAfter = response.headers.get("retry-after");
  const requestId = response.headers.get("x-github-request-id") ?? undefined;
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

  const suffix = context.length > 0 ? ` (${context.join(", ")})` : "";
  return new GitHubApiError(
    `GitHub API GET ${pathname} returned HTTP ${response.status}${suffix}.`,
    { status: response.status, requestId, rateLimited },
  );
}

async function githubGet({ token, url, fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": API_VERSION,
      },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new Error(
        `GitHub API GET ${url.pathname} timed out after ${REQUEST_TIMEOUT_MS}ms.`,
        { cause: error },
      );
    }
    throw new Error(`GitHub API GET ${url.pathname} could not be reached.`, {
      cause: error,
    });
  }

  if (response.status !== 200) throw apiError(response, url.pathname);
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

function validateTargetHook(hook, expectedHookId) {
  const hookId = hookIdFromResponse(hook);
  if (hookId !== expectedHookId) {
    throw new Error(
      `Installation-visible organization webhook ${hookId} does not match configured HOOK_ID.`,
    );
  }
  if (hook.active !== true) {
    throw new Error(`Organization webhook ${hookId} is not active.`);
  }
  if (
    hook.name !== "web" ||
    !hook.config ||
    hook.config.url !== WEBHOOK_URL ||
    hook.config.content_type !== "json" ||
    String(hook.config.insecure_ssl) !== "0" ||
    !sameEvents(hook.events)
  ) {
    throw new Error(
      `Organization webhook ${hookId} does not exactly match the GitHub Slack relay contract.`,
    );
  }
  return Object.freeze({ hookId, active: true });
}

export function parseNextHookPage(linkHeader, expectedPathname, expectedPage) {
  if (!linkHeader) return undefined;

  const nextCandidates = [];
  for (const match of linkHeader.matchAll(/<([^>]+)>([^,]*)/g)) {
    const [, candidate, parameters] = match;
    const relation = parameters.match(/(?:^|;)\s*rel\s*=\s*"?([^";,]+)"?/i);
    if (!relation?.[1].split(/\s+/).includes("next")) continue;
    nextCandidates.push(candidate);
  }
  if (nextCandidates.length === 0) return undefined;
  if (nextCandidates.length !== 1) {
    throw new Error("GitHub returned multiple next-page URLs.");
  }
  if (!Number.isSafeInteger(expectedPage) || expectedPage <= 1) {
    throw new Error("The expected GitHub next-page number is invalid.");
  }

  let nextUrl;
  try {
    nextUrl = new URL(nextCandidates[0]);
  } catch (error) {
    throw new Error("GitHub returned an invalid next-page URL.", {
      cause: error,
    });
  }
  if (nextUrl.origin !== API_ORIGIN || nextUrl.pathname !== expectedPathname) {
    throw new Error(
      "GitHub returned a next-page URL outside the expected organization hooks endpoint.",
    );
  }
  const parameterNames = [...nextUrl.searchParams.keys()];
  const pageSizes = nextUrl.searchParams.getAll("per_page");
  const pages = nextUrl.searchParams.getAll("page");
  if (
    parameterNames.length !== 2 ||
    pageSizes.length !== 1 ||
    pages.length !== 1 ||
    parameterNames.some(
      (parameterName) =>
        parameterName !== "per_page" && parameterName !== "page",
    )
  ) {
    throw new Error(
      "GitHub returned a next-page URL with unexpected query parameters.",
    );
  }
  if (pageSizes[0] !== String(PAGE_SIZE)) {
    throw new Error(
      "GitHub returned a next-page URL with an invalid page size.",
    );
  }
  const page = pages[0];
  const pageNumber = Number(page);
  if (
    !/^[1-9]\d*$/.test(page) ||
    !Number.isSafeInteger(pageNumber) ||
    pageNumber <= 1 ||
    String(pageNumber) !== page
  ) {
    throw new Error(
      "GitHub returned a next-page URL with an invalid page number.",
    );
  }
  if (pageNumber !== expectedPage) {
    throw new Error("GitHub returned a non-contiguous next-page URL.");
  }
  return apiUrl(expectedPathname, {
    per_page: PAGE_SIZE,
    page: pageNumber,
  });
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

    const response = await githubGet({ token, url: nextUrl, fetchImpl });
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

    nextUrl = parseNextHookPage(
      response.headers.get("link"),
      pathname,
      Number(page) + 1,
    );
    if (!nextUrl) return hooks;
  }

  throw new Error(
    `GitHub organization hooks pagination exceeded ${MAX_PAGES} pages.`,
  );
}

async function getHook({ token, organizationName, hookId, fetchImpl }) {
  const pathname = `/orgs/${endpointPath([
    organizationName,
  ])}/hooks/${endpointPath([hookId])}`;
  const response = await githubGet({
    token,
    url: apiUrl(pathname),
    fetchImpl,
  });
  return readJson(response, `organization webhook ${hookId}`);
}

export async function auditOrganizationWebhook({
  environment = process.env,
  fetchImpl = globalThis.fetch,
  logger = console,
} = {}) {
  const configuration = readConfiguration(environment);
  if (typeof fetchImpl !== "function") {
    throw new Error("A Fetch-compatible implementation is required.");
  }

  const hooks = await listVisibleHooks({ ...configuration, fetchImpl });
  if (hooks.length !== 1) {
    throw new Error(
      `Expected exactly one installation-visible organization webhook; found ${hooks.length}.`,
    );
  }
  validateTargetHook(hooks[0], configuration.hookId);
  validateTargetHook(
    await getHook({ ...configuration, fetchImpl }),
    configuration.hookId,
  );
  logger.info(
    `Verified active organization webhook ${configuration.hookId} using GET requests only.`,
  );
  return Object.freeze({ hookId: configuration.hookId, active: true });
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (invokedPath === import.meta.url) {
  auditOrganizationWebhook().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Webhook audit failed.",
    );
    process.exitCode = 1;
  });
}
