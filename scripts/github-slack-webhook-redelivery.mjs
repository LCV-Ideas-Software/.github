import { pathToFileURL } from "node:url";

export const API_VERSION = "2026-03-10";
export const MAX_DELIVERY_ATTEMPTS = 3;
export const MAX_DELIVERY_CLOCK_SKEW_MS = 60 * 1000;
export const MAX_REDELIVERIES_PER_RUN = 10;
export const MAX_REDELIVERY_AGE_MS = 3 * 24 * 60 * 60 * 1000;
export const RETENTION_SAFETY_MARGIN_MS = 15 * 60 * 1000;
export const REDELIVERY_WORKFLOW_FILE = "github-slack-webhook-redelivery.yml";
export const REDELIVERY_WORKFLOW_PATH =
  ".github/workflows/github-slack-webhook-redelivery.yml";

const API_ORIGIN = "https://api.github.com";
const PAGE_SIZE = 100;
const MAX_PAGES = 1_000;
const MAX_ACTION_RUN_PAGES = 10;
const REQUEST_TIMEOUT_MS = 30_000;
const USER_AGENT = "lcv-github-slack-webhook-redelivery";
const RECOVERY_STEP_NAME = "Recover failed webhook deliveries";
const TERMINAL_CONCLUSIONS = new Set([
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "skipped",
  "stale",
  "success",
  "timed_out",
]);

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
  const actionsToken = requiredEnvironmentValue(environment, "ACTIONS_TOKEN");
  const hookToken = requiredEnvironmentValue(environment, "HOOK_TOKEN");
  if (actionsToken === hookToken) {
    throw new Error(
      "ACTIONS_TOKEN and HOOK_TOKEN must be distinct least-privilege credentials.",
    );
  }
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
    actionsToken,
    hookToken,
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
  if (ssoAuthorization) {
    context.push("sso-authorization=required");
  }

  const suffix = context.length > 0 ? ` (${context.join(", ")})` : "";
  return new GitHubApiError(
    `GitHub API ${method} ${pathname} returned HTTP ${response.status}${suffix}.`,
    { status: response.status, requestId, rateLimited },
  );
}

async function githubRequest({ token, method = "GET", url, body, fetchImpl }) {
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

  if (!response.ok) {
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

  let nextCandidate;
  let nextRelationCount = 0;
  for (const rawEntry of linkHeader.split(",")) {
    const entry = rawEntry.trim();
    const closingBracketIndex = entry.indexOf(">");
    if (
      !entry.startsWith("<") ||
      closingBracketIndex <= 1 ||
      entry.lastIndexOf(">") !== closingBracketIndex
    ) {
      throw new Error("GitHub returned a malformed Link header.");
    }
    const candidate = entry.slice(1, closingBracketIndex);
    const rawParameters = entry.slice(closingBracketIndex + 1);
    let parameters = [];
    if (rawParameters !== "") {
      const firstNonWhitespaceIndex = rawParameters.search(/\S/);
      if (
        firstNonWhitespaceIndex === -1 ||
        rawParameters[firstNonWhitespaceIndex] !== ";"
      ) {
        throw new Error("GitHub returned a malformed Link header.");
      }
      parameters = rawParameters
        .slice(firstNonWhitespaceIndex + 1)
        .split(";")
        .map((parameter) => parameter.trim());
      if (parameters.some((parameter) => parameter === "")) {
        throw new Error("GitHub returned a malformed Link parameter.");
      }
    }
    for (const parameter of parameters) {
      const parameterMatch = parameter.match(
        /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s*=\s*(?:"([^"]*)"|([^\s;]+))$/,
      );
      if (!parameterMatch) {
        throw new Error("GitHub returned a malformed Link parameter.");
      }
      if (parameterMatch[1].toLowerCase() !== "rel") {
        continue;
      }
      const relations = (parameterMatch[2] ?? parameterMatch[3])
        .split(/\s+/)
        .filter(Boolean);
      for (const relation of relations) {
        if (relation.toLowerCase() === "next") {
          nextRelationCount += 1;
          nextCandidate = candidate;
        }
      }
    }
  }

  if (nextRelationCount === 0) {
    return undefined;
  }
  if (nextRelationCount !== 1 || !nextCandidate) {
    throw new Error(
      "GitHub must return exactly one next relation in a paginated Link header.",
    );
  }

  let nextUrl;
  try {
    nextUrl = new URL(nextCandidate);
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
    nextUrl.username !== "" ||
    nextUrl.password !== "" ||
    nextUrl.hash !== "" ||
    !allowedPathnames.has(nextUrl.pathname)
  ) {
    throw new Error(
      "GitHub returned a next-page URL outside the expected deliveries endpoint.",
    );
  }

  const queryEntries = [...nextUrl.searchParams.entries()];
  const cursorValues = queryEntries
    .filter(([name]) => name === "cursor")
    .map(([, value]) => value);
  const perPageValues = queryEntries
    .filter(([name]) => name === "per_page")
    .map(([, value]) => value);
  if (cursorValues.length === 0) {
    throw new Error("GitHub returned a next-page URL without a cursor.");
  }
  if (cursorValues.length !== 1) {
    throw new Error(
      "GitHub returned a next-page URL without exactly one cursor.",
    );
  }
  if (cursorValues[0].trim() === "") {
    throw new Error(
      "GitHub returned a next-page URL without a non-empty cursor.",
    );
  }
  if (perPageValues.length !== 1 || perPageValues[0] !== String(PAGE_SIZE)) {
    throw new Error(
      `GitHub returned a next-page URL without per_page=${PAGE_SIZE} exactly once.`,
    );
  }
  if (queryEntries.length !== 2) {
    throw new Error(
      "GitHub returned a next-page URL with unexpected query parameters.",
    );
  }
  return cursorValues[0];
}

function validateStartedAt(startedAt) {
  if (!Number.isSafeInteger(startedAt) || startedAt <= 0) {
    throw new Error(
      "The run start time must be a positive epoch millisecond value.",
    );
  }
}

export function resolveContinuityCheckpoint(workflowRun, startedAt) {
  validateStartedAt(startedAt);
  if (
    !workflowRun ||
    typeof workflowRun !== "object" ||
    !Number.isSafeInteger(workflowRun.runStartedAt) ||
    workflowRun.runStartedAt <= 0
  ) {
    throw new Error(
      "A valid successful scheduled workflow run is required for continuity.",
    );
  }

  const candidate = workflowRun.runStartedAt;
  if (candidate > startedAt) {
    throw new Error(
      "The successful scheduled workflow run cannot start in the future.",
    );
  }

  const oldestSafelyRedeliverable =
    startedAt - MAX_REDELIVERY_AGE_MS + RETENTION_SAFETY_MARGIN_MS;
  if (candidate <= oldestSafelyRedeliverable) {
    throw new Error(
      "The last successful scheduled workflow run is older than GitHub's three-day redelivery window or inside its 15-minute safety margin; refusing recovery because unrecoverable deliveries may exist.",
    );
  }
  return candidate;
}

function parseRequiredTimestamp(value, description) {
  if (typeof value !== "string" || value === "") {
    throw new Error(`GitHub returned a workflow run without ${description}.`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new Error(
      `GitHub returned a workflow run with an invalid ${description}.`,
    );
  }
  return timestamp;
}

function normalizeSuccessfulScheduledRun(rawRun, { oldestAllowed, startedAt }) {
  if (!rawRun || typeof rawRun !== "object") {
    throw new Error("GitHub returned a malformed workflow run.");
  }
  if (!Number.isSafeInteger(rawRun.id) || rawRun.id <= 0) {
    throw new Error("GitHub returned a workflow run with an invalid ID.");
  }
  if (rawRun.path !== REDELIVERY_WORKFLOW_PATH) {
    throw new Error(
      "GitHub returned a workflow run for an unexpected workflow path.",
    );
  }
  if (
    rawRun.event !== "schedule" ||
    rawRun.status !== "completed" ||
    rawRun.conclusion !== "success" ||
    rawRun.head_branch !== "main"
  ) {
    throw new Error(
      "GitHub returned a workflow run that does not satisfy the requested schedule, success, completed, and main filters.",
    );
  }
  if (
    typeof rawRun.head_sha !== "string" ||
    !/^[0-9a-f]{40}$/i.test(rawRun.head_sha)
  ) {
    throw new Error("GitHub returned a workflow run with an invalid head SHA.");
  }
  if (!Number.isSafeInteger(rawRun.run_attempt) || rawRun.run_attempt <= 0) {
    throw new Error(
      "GitHub returned a workflow run with an invalid run attempt.",
    );
  }

  const createdAt = parseRequiredTimestamp(rawRun.created_at, "created_at");
  const runStartedAt = parseRequiredTimestamp(
    rawRun.run_started_at,
    "run_started_at",
  );
  const updatedAt = parseRequiredTimestamp(rawRun.updated_at, "updated_at");
  if (
    createdAt < oldestAllowed ||
    createdAt > runStartedAt ||
    runStartedAt > updatedAt ||
    updatedAt > startedAt
  ) {
    throw new Error(
      "GitHub returned a workflow run with timestamps outside the requested continuity window or in an invalid order.",
    );
  }

  return Object.freeze({
    id: String(rawRun.id),
    createdAt,
    runStartedAt,
    updatedAt,
    headSha: rawRun.head_sha.toLowerCase(),
    runAttempt: rawRun.run_attempt,
  });
}

export async function fetchLastSuccessfulScheduledRun({
  token,
  owner,
  repository,
  startedAt,
  fetchImpl = globalThis.fetch,
}) {
  validateStartedAt(startedAt);
  const oldestAllowed =
    startedAt - MAX_REDELIVERY_AGE_MS + RETENTION_SAFETY_MARGIN_MS;
  const pathname = `/repos/${endpointPath([
    owner,
    repository,
  ])}/actions/workflows/${endpointPath([REDELIVERY_WORKFLOW_FILE])}/runs`;
  const createdFilter = `>=${new Date(oldestAllowed).toISOString()}`;
  let expectedTotalCount;
  const seenIds = new Set();
  const runs = [];

  for (let page = 1; page <= MAX_ACTION_RUN_PAGES; page += 1) {
    const response = await githubRequest({
      token,
      url: apiUrl(pathname, {
        branch: "main",
        created: createdFilter,
        event: "schedule",
        status: "success",
        per_page: PAGE_SIZE,
        page,
      }),
      fetchImpl,
    });
    const data = await readJson(response, "successful scheduled workflow runs");
    if (
      !data ||
      typeof data !== "object" ||
      !Number.isSafeInteger(data.total_count) ||
      data.total_count < 0 ||
      !Array.isArray(data.workflow_runs) ||
      data.workflow_runs.length > PAGE_SIZE
    ) {
      throw new Error(
        "GitHub returned a malformed successful scheduled workflow-runs page.",
      );
    }
    if (expectedTotalCount === undefined) {
      expectedTotalCount = data.total_count;
      if (expectedTotalCount > PAGE_SIZE * MAX_ACTION_RUN_PAGES) {
        throw new Error(
          `GitHub workflow-run pagination exceeded the safety limit of ${MAX_ACTION_RUN_PAGES} pages.`,
        );
      }
    } else if (data.total_count !== expectedTotalCount) {
      throw new Error(
        "GitHub changed the workflow-run total while it was being paginated.",
      );
    }

    for (const rawRun of data.workflow_runs) {
      const run = normalizeSuccessfulScheduledRun(rawRun, {
        oldestAllowed,
        startedAt,
      });
      if (seenIds.has(run.id)) {
        throw new Error(
          "GitHub returned a duplicate workflow-run ID while paginating.",
        );
      }
      seenIds.add(run.id);
      runs.push(run);
    }

    if (runs.length > expectedTotalCount) {
      throw new Error(
        "GitHub returned more workflow runs than its declared total count.",
      );
    }
    if (runs.length === expectedTotalCount) {
      break;
    }
    if (data.workflow_runs.length === 0) {
      throw new Error(
        "GitHub returned an empty workflow-runs page before the declared total was collected.",
      );
    }
    if (page === MAX_ACTION_RUN_PAGES) {
      throw new Error(
        `GitHub workflow-run pagination exceeded the safety limit of ${MAX_ACTION_RUN_PAGES} pages.`,
      );
    }
  }

  if (expectedTotalCount === undefined || runs.length !== expectedTotalCount) {
    throw new Error(
      "GitHub workflow-run pagination ended before the declared total was collected.",
    );
  }
  if (runs.length === 0) {
    throw new Error(
      "No successful scheduled redelivery workflow run exists within GitHub's three-day redelivery window; refusing recovery without a continuity checkpoint.",
    );
  }

  runs.sort((left, right) => {
    if (left.runStartedAt !== right.runStartedAt) {
      return right.runStartedAt - left.runStartedAt;
    }
    const leftId = BigInt(left.id);
    const rightId = BigInt(right.id);
    return leftId < rightId ? 1 : leftId > rightId ? -1 : 0;
  });
  for (const run of runs) {
    const proof = await verifyRecoveryStepExecution({
      token,
      owner,
      repository,
      workflowRun: run,
      fetchImpl,
    });
    if (proof) {
      return run;
    }
  }

  throw new Error(
    "No successful scheduled redelivery workflow run contains a proven successful recovery step within GitHub's three-day redelivery window; refusing recovery without a continuity checkpoint.",
  );
}

function normalizeWorkflowJob(rawJob, workflowRun) {
  if (!rawJob || typeof rawJob !== "object") {
    throw new Error("GitHub returned a malformed workflow job.");
  }
  if (!Number.isSafeInteger(rawJob.id) || rawJob.id <= 0) {
    throw new Error("GitHub returned a workflow job with an invalid job ID.");
  }
  if (
    !Number.isSafeInteger(rawJob.run_id) ||
    rawJob.run_id <= 0 ||
    String(rawJob.run_id) !== workflowRun.id
  ) {
    throw new Error(
      "GitHub returned a workflow job for an unexpected workflow run.",
    );
  }
  if (
    !Number.isSafeInteger(rawJob.run_attempt) ||
    rawJob.run_attempt <= 0 ||
    rawJob.run_attempt !== workflowRun.runAttempt
  ) {
    throw new Error(
      "GitHub returned a workflow job for an unexpected workflow run attempt.",
    );
  }
  if (rawJob.status !== "completed") {
    throw new Error(
      "GitHub returned a workflow job with an invalid terminal job status.",
    );
  }
  if (!TERMINAL_CONCLUSIONS.has(rawJob.conclusion)) {
    throw new Error(
      "GitHub returned a workflow job with an invalid terminal job conclusion.",
    );
  }
  if (!Array.isArray(rawJob.steps)) {
    throw new Error("GitHub returned a workflow job without a steps array.");
  }

  const seenStepNumbers = new Set();
  const steps = rawJob.steps.map((rawStep) => {
    if (!rawStep || typeof rawStep !== "object") {
      throw new Error("GitHub returned a malformed workflow step.");
    }
    if (typeof rawStep.name !== "string" || rawStep.name === "") {
      throw new Error("GitHub returned a workflow step without a valid name.");
    }
    if (!Number.isSafeInteger(rawStep.number) || rawStep.number <= 0) {
      throw new Error(
        "GitHub returned a workflow step with an invalid step number.",
      );
    }
    if (seenStepNumbers.has(rawStep.number)) {
      throw new Error(
        "GitHub returned duplicate workflow step numbers in one job.",
      );
    }
    seenStepNumbers.add(rawStep.number);
    if (rawStep.status !== "completed") {
      throw new Error(
        "GitHub returned a workflow step with an invalid terminal step status.",
      );
    }
    if (!TERMINAL_CONCLUSIONS.has(rawStep.conclusion)) {
      throw new Error(
        "GitHub returned a workflow step with an invalid terminal step conclusion.",
      );
    }
    return Object.freeze({
      name: rawStep.name,
      number: rawStep.number,
      status: rawStep.status,
      conclusion: rawStep.conclusion,
    });
  });

  return Object.freeze({
    id: String(rawJob.id),
    status: rawJob.status,
    conclusion: rawJob.conclusion,
    steps: Object.freeze(steps),
  });
}

export async function verifyRecoveryStepExecution({
  token,
  owner,
  repository,
  workflowRun,
  fetchImpl = globalThis.fetch,
}) {
  if (
    !workflowRun ||
    typeof workflowRun !== "object" ||
    typeof workflowRun.id !== "string" ||
    !/^\d+$/.test(workflowRun.id) ||
    BigInt(workflowRun.id) <= 0n ||
    !Number.isSafeInteger(workflowRun.runAttempt) ||
    workflowRun.runAttempt <= 0
  ) {
    throw new Error(
      "A valid successful scheduled workflow run is required for job verification.",
    );
  }
  const pathname = `/repos/${endpointPath([
    owner,
    repository,
  ])}/actions/runs/${endpointPath([workflowRun.id])}/attempts/${endpointPath([
    String(workflowRun.runAttempt),
  ])}/jobs`;
  let expectedTotalCount;
  const seenJobIds = new Set();
  const jobs = [];

  for (let page = 1; page <= MAX_ACTION_RUN_PAGES; page += 1) {
    const response = await githubRequest({
      token,
      url: apiUrl(pathname, { per_page: PAGE_SIZE, page }),
      fetchImpl,
    });
    const data = await readJson(response, "workflow-run attempt jobs");
    if (
      !data ||
      typeof data !== "object" ||
      !Number.isSafeInteger(data.total_count) ||
      data.total_count < 0 ||
      !Array.isArray(data.jobs) ||
      data.jobs.length > PAGE_SIZE
    ) {
      throw new Error("GitHub returned a malformed workflow-jobs page.");
    }
    if (expectedTotalCount === undefined) {
      expectedTotalCount = data.total_count;
      if (expectedTotalCount > PAGE_SIZE * MAX_ACTION_RUN_PAGES) {
        throw new Error(
          `GitHub workflow-job pagination exceeded the safety limit of ${MAX_ACTION_RUN_PAGES} pages.`,
        );
      }
    } else if (data.total_count !== expectedTotalCount) {
      throw new Error(
        "GitHub changed the workflow-job total while it was being paginated.",
      );
    }

    for (const rawJob of data.jobs) {
      const job = normalizeWorkflowJob(rawJob, workflowRun);
      if (seenJobIds.has(job.id)) {
        throw new Error(
          "GitHub returned a duplicate workflow-job ID while paginating.",
        );
      }
      seenJobIds.add(job.id);
      jobs.push(job);
    }

    if (jobs.length > expectedTotalCount) {
      throw new Error(
        "GitHub returned more workflow jobs than its declared total count.",
      );
    }
    if (jobs.length === expectedTotalCount) {
      break;
    }
    if (data.jobs.length === 0) {
      throw new Error(
        "GitHub returned an empty workflow-jobs page before the declared total was collected.",
      );
    }
    if (page === MAX_ACTION_RUN_PAGES) {
      throw new Error(
        `GitHub workflow-job pagination exceeded the safety limit of ${MAX_ACTION_RUN_PAGES} pages.`,
      );
    }
  }

  if (expectedTotalCount === undefined || jobs.length !== expectedTotalCount) {
    throw new Error(
      "GitHub workflow-job pagination ended before the declared total was collected.",
    );
  }

  const matches = jobs.flatMap((job) =>
    job.steps
      .filter((step) => step.name === RECOVERY_STEP_NAME)
      .map((step) => ({ job, step })),
  );
  if (matches.length > 1) {
    throw new Error(
      `A scheduled workflow run must not contain more than one recovery step named ${RECOVERY_STEP_NAME}.`,
    );
  }
  if (matches.length === 0) {
    return undefined;
  }
  const [{ job, step }] = matches;
  if (job.status !== "completed" || job.conclusion !== "success") {
    return undefined;
  }
  if (step.status !== "completed" || step.conclusion !== "success") {
    return undefined;
  }

  return Object.freeze({ jobId: job.id, stepNumber: step.number });
}

function normalizeDelivery(delivery, observedAt) {
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
  if (deliveredAt > observedAt + MAX_DELIVERY_CLOCK_SKEW_MS) {
    throw new Error(
      "GitHub returned a webhook delivery with a future timestamp.",
    );
  }
  if (typeof delivery.status !== "string" || delivery.status === "") {
    throw new Error("GitHub returned a webhook delivery without a status.");
  }
  if (
    !Number.isInteger(delivery.status_code) ||
    delivery.status_code < 200 ||
    delivery.status_code > 599
  ) {
    throw new Error(
      "GitHub returned a webhook delivery whose status code is not between 200 and 599.",
    );
  }
  if (typeof delivery.redelivery !== "boolean") {
    throw new Error(
      "GitHub returned a webhook delivery without a boolean redelivery flag.",
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
    redelivery: delivery.redelivery,
  });
}

export async function fetchDeliveriesSince({
  token,
  organizationName,
  organizationId,
  hookId,
  cutoff,
  startedAt,
  now = Date.now,
  fetchImpl = globalThis.fetch,
}) {
  validateStartedAt(startedAt);
  if (typeof now !== "function") {
    throw new Error("A clock implementation is required for delivery reads.");
  }
  if (!Number.isSafeInteger(cutoff) || cutoff <= 0 || cutoff > startedAt) {
    throw new Error(
      "The delivery cutoff must be a positive epoch millisecond value no later than the run start time.",
    );
  }
  const deliveriesPath = `/orgs/${endpointPath([
    organizationName,
  ])}/hooks/${endpointPath([hookId])}/deliveries`;
  const canonicalDeliveriesPath = `/organizations/${endpointPath([
    organizationId,
  ])}/hooks/${endpointPath([hookId])}/deliveries`;
  let cursor;
  let lastObservedAt = startedAt;
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
    const pageObservedAt = now();
    validateStartedAt(pageObservedAt);
    if (pageObservedAt < lastObservedAt) {
      throw new Error(
        "The delivery observation clock moved backwards while paginating.",
      );
    }
    lastObservedAt = pageObservedAt;
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
      const delivery = normalizeDelivery(rawDelivery, pageObservedAt);
      const prior = seenDeliveries.get(delivery.id);
      if (
        prior &&
        (prior.guid !== delivery.guid ||
          prior.deliveredAt !== delivery.deliveredAt ||
          prior.status !== delivery.status ||
          prior.statusCode !== delivery.statusCode ||
          prior.redelivery !== delivery.redelivery)
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
  if (
    !Number.isInteger(delivery?.statusCode) ||
    delivery.statusCode < 200 ||
    delivery.statusCode > 599
  ) {
    throw new Error(
      "A webhook delivery with a status code outside 200-599 reached selection.",
    );
  }
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
    if (!delivery || typeof delivery !== "object") {
      throw new Error("A malformed webhook delivery reached selection.");
    }
    if (typeof delivery.redelivery !== "boolean") {
      throw new Error(
        "A webhook delivery without a boolean redelivery flag reached selection.",
      );
    }
    const attempts = byGuid.get(delivery.guid) ?? [];
    attempts.push(delivery);
    byGuid.set(delivery.guid, attempts);
  }

  const failures = [];
  for (const attempts of byGuid.values()) {
    const hasSuccessfulAttempt = attempts.map(wasSuccessful).some(Boolean);
    if (hasSuccessfulAttempt) {
      continue;
    }
    const originalCount = attempts.filter(
      (attempt) => attempt.redelivery === false,
    ).length;
    if (originalCount !== 1) {
      throw new Error(
        "A webhook delivery GUID must have exactly one original delivery in the retained history; refusing automatic redelivery because the history may be truncated or contradictory.",
      );
    }
    if (attempts.length >= MAX_DELIVERY_ATTEMPTS) {
      throw new Error(
        `A webhook delivery reached the fail-closed limit of ${MAX_DELIVERY_ATTEMPTS} unsuccessful attempts; refusing further automatic redelivery.`,
      );
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
  if (typeof now !== "function") {
    throw new Error("A clock implementation is required for recovery.");
  }

  let lastObservedAt;
  const readMonotonicNow = () => {
    const observedAt = now();
    validateStartedAt(observedAt);
    if (lastObservedAt !== undefined && observedAt < lastObservedAt) {
      throw new Error(
        "The recovery clock moved backwards; refusing webhook mutation.",
      );
    }
    lastObservedAt = observedAt;
    return observedAt;
  };

  const startedAt = readMonotonicNow();
  const continuityRun = await fetchLastSuccessfulScheduledRun({
    token: configuration.actionsToken,
    owner: configuration.workflowRepoOwner,
    repository: configuration.workflowRepoName,
    startedAt,
    fetchImpl,
  });
  const continuityStartedAt = resolveContinuityCheckpoint(
    continuityRun,
    startedAt,
  );

  // Stay fifteen minutes inside GitHub's documented three-day retention edge.
  // This makes an original attempt disappearing at the boundary fail closed
  // instead of silently renewing a GUID's automatic retry budget.
  const cutoff = startedAt - MAX_REDELIVERY_AGE_MS + RETENTION_SAFETY_MARGIN_MS;

  const deliveries = await fetchDeliveriesSince({
    token: configuration.hookToken,
    organizationName: configuration.organizationName,
    organizationId: configuration.organizationId,
    hookId: configuration.hookId,
    cutoff,
    startedAt,
    now: readMonotonicNow,
    fetchImpl,
  });
  const failedDeliveryIds = selectFailedDeliveryIds(deliveries);
  const targetBatch = failedDeliveryIds.slice(0, MAX_REDELIVERIES_PER_RUN);
  let deferredTargets = failedDeliveryIds.length - targetBatch.length;

  let acceptedRedeliveries = 0;
  let staleTargetsSkipped = 0;
  let revalidatedTargets = targetBatch;
  if (targetBatch.length > 0) {
    const revalidationStartedAt = readMonotonicNow();
    if (revalidationStartedAt < startedAt) {
      throw new Error(
        "The revalidation clock moved backwards; refusing webhook mutation.",
      );
    }
    const refreshedDeliveries = await fetchDeliveriesSince({
      token: configuration.hookToken,
      organizationName: configuration.organizationName,
      organizationId: configuration.organizationId,
      hookId: configuration.hookId,
      cutoff,
      startedAt: revalidationStartedAt,
      now: readMonotonicNow,
      fetchImpl,
    });
    const refreshedFailedDeliveryIds =
      selectFailedDeliveryIds(refreshedDeliveries);
    const refreshedFailedIds = new Set(refreshedFailedDeliveryIds);
    revalidatedTargets = targetBatch.filter((deliveryId) => {
      if (refreshedFailedIds.has(deliveryId)) {
        return true;
      }
      staleTargetsSkipped += 1;
      return false;
    });
    const revalidatedTargetIds = new Set(revalidatedTargets);
    deferredTargets = refreshedFailedDeliveryIds.filter(
      (deliveryId) => !revalidatedTargetIds.has(deliveryId),
    ).length;
  }

  for (const deliveryId of revalidatedTargets) {
    // GitHub exposes no conditional redelivery precondition tied to a delivery
    // snapshot. One complete revalidation occurs before this bounded mutation
    // batch; a residual race can still exist between that snapshot and a POST.
    await redeliver({
      token: configuration.hookToken,
      organizationName: configuration.organizationName,
      hookId: configuration.hookId,
      deliveryId,
      fetchImpl,
    });
    acceptedRedeliveries += 1;
  }

  logger.info(
    `Accepted ${acceptedRedeliveries} webhook redelivery request(s), skipped ${staleTargetsSkipped} stale target(s), deferred ${deferredTargets} target(s) to a later run, and initially examined ${deliveries.length} delivery record(s) since ${new Date(cutoff).toISOString()}; continuity was proven by successful scheduled workflow run ${continuityRun.id}.`,
  );
  return Object.freeze({
    examined: deliveries.length,
    redeliveries: acceptedRedeliveries,
    continuityStartedAt: String(continuityStartedAt),
    continuityRunId: continuityRun.id,
    deferredTargets,
    staleTargetsSkipped,
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
