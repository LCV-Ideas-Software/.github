#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const API_ROOT = "https://api.github.com";
const API_VERSION = "2026-03-10";
const ALLOWED_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);
const DEPENDABOT_ACTOR_ID = 49699333;
const DEPENDABOT_ACTOR_LOGIN = "dependabot[bot]";
const DEPENDABOT_ALREADY_CURRENT_RESPONSE =
  "Looks like this PR is already up-to-date with main! If you'd still like to recreate it from scratch, overwriting any edits, you can request `@dependabot recreate`.";
const DEPENDABOT_REBASE_RETRY_DELAY_MS = 10 * 60 * 1000;
const WEB_FLOW_ACTOR_ID = 19864447;
const WEB_FLOW_ACTOR_LOGIN = "web-flow";
// Verified against live GitHub check-run payloads. Unlike an App slug, this
// database ID is immutable when an App is renamed.
const GITHUB_ACTIONS_APP_ID = 15368;
const CONNECTOR_ACTOR_DATABASE_ID = 199175422;
const CONNECTOR_ACTOR_LOGINS = new Set([
  "chatgpt-codex-connector",
  "chatgpt-codex-connector[bot]",
]);
const DEFAULT_SETTLE_TIMEOUT_SECONDS = 180;
const DEFAULT_SETTLE_POLL_SECONDS = 10;
const REVIEW_THREADS_QUERY = `
  query DependabotReviewThreads(
    $owner: String!
    $repo: String!
    $number: Int!
    $after: String
  ) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $after) {
          nodes {
            isResolved
            isOutdated
            comments(first: 100) {
              nodes {
                author {
                  login
                  ... on Bot {
                    databaseId
                  }
                }
                body
                url
              }
              pageInfo {
                hasNextPage
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`;

function log(message) {
  process.stdout.write(`${message}\n`);
}

function assertNonEmpty(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function parseBoundedPositiveInteger(raw, name, { defaultValue, maximum }) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return defaultValue;
  }
  const normalized = String(raw).trim();
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const value = Number(normalized);
  if (!Number.isSafeInteger(value) || value > maximum) {
    throw new Error(`${name} must be at most ${maximum}`);
  }
  return value;
}

export function parseRequiredChecks(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("REQUIRED_CHECKS_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("REQUIRED_CHECKS_JSON must be a non-empty JSON array");
  }
  const checks = parsed.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(
        "Each required check must be an object with name and app_id",
      );
    }
    if (!Number.isSafeInteger(value.app_id) || value.app_id <= 0) {
      throw new Error("required check app_id must be a positive safe integer");
    }
    return {
      name: assertNonEmpty(value.name, "required check name"),
      app_id: value.app_id,
    };
  });
  if (new Set(checks.map((check) => check.name)).size !== checks.length) {
    throw new Error("REQUIRED_CHECKS_JSON must not contain duplicate names");
  }
  return checks;
}

export function isTrustedPullRequest(pull, repository) {
  return Boolean(
    pull &&
    pull.state === "open" &&
    pull.draft === false &&
    pull.user?.id === DEPENDABOT_ACTOR_ID &&
    pull.user?.login === DEPENDABOT_ACTOR_LOGIN &&
    pull.head?.repo?.full_name === repository &&
    pull.base?.repo?.full_name === repository &&
    pull.base?.ref === "main" &&
    typeof pull.head?.ref === "string" &&
    pull.head.ref.startsWith("dependabot/") &&
    /^[0-9a-f]{40}$/i.test(pull.head?.sha ?? ""),
  );
}

export function hasExpectedDependabotCommitShape(commits, headSha) {
  if (!Array.isArray(commits) || commits.length !== 1) return false;
  const commit = commits[0];
  const hasTrustedCommitter =
    (commit.committer?.id === WEB_FLOW_ACTOR_ID &&
      commit.committer?.login === WEB_FLOW_ACTOR_LOGIN) ||
    (commit.committer?.id === DEPENDABOT_ACTOR_ID &&
      commit.committer?.login === DEPENDABOT_ACTOR_LOGIN);
  return Boolean(
    commit.sha === headSha &&
    commit.author?.id === DEPENDABOT_ACTOR_ID &&
    commit.author?.login === DEPENDABOT_ACTOR_LOGIN &&
    hasTrustedCommitter &&
    commit.commit?.author?.email ===
      "49699333+dependabot[bot]@users.noreply.github.com" &&
    commit.commit?.verification?.verified === true &&
    Array.isArray(commit.parents) &&
    commit.parents.length === 1 &&
    /^[0-9a-f]{40}$/i.test(commit.parents[0]?.sha ?? ""),
  );
}

export function isAllowedDependabotPath(filename) {
  if (typeof filename !== "string" || filename === "") return false;
  if (/^\.github\/workflows\/.+\.ya?ml$/i.test(filename)) return true;
  if (
    /^(?:.+\/)?(?:package(?:-lock)?\.json|npm-shrinkwrap\.json)$/i.test(
      filename,
    )
  ) {
    return true;
  }
  if (/^(?:.+\/)?Cargo\.(?:toml|lock)$/i.test(filename)) return true;
  if (/^(?:.+\/)?requirements[^/]*\.(?:txt|in)$/i.test(filename)) return true;
  if (/^(?:.+\/)?python-tools-requirements\.(?:txt|in)$/i.test(filename)) {
    return true;
  }
  if (/^(?:.+\/)?deno\.(?:jsonc?|lock)$/i.test(filename)) return true;
  if (/^\.github\/zizmor\/Dockerfile$/i.test(filename)) return true;
  if (
    /^(?:.+\/)?(?:pyproject\.toml|poetry\.lock|Pipfile(?:\.lock)?|uv\.lock|setup\.py|setup\.cfg)$/i.test(
      filename,
    )
  ) {
    return true;
  }
  return /^\.pre-commit-config\.ya?ml$/i.test(filename);
}

export function classifyChecks({
  checkRuns,
  statuses = [],
  combinedStatusState = "pending",
  requiredChecks,
}) {
  const relevantRuns = checkRuns;
  const latestStatuses = new Map();
  for (const status of statuses) {
    const previous = latestStatuses.get(status.context);
    if (!previous || Number(status.id) > Number(previous.id)) {
      latestStatuses.set(status.context, status);
    }
  }
  const relevantStatuses = [...latestStatuses.values()];

  if (relevantRuns.length + relevantStatuses.length === 0) {
    return {
      state: "pending",
      reason: "no checks are attached to the head SHA",
    };
  }

  const missing = requiredChecks.filter(
    (required) =>
      !relevantRuns.some(
        (check) =>
          check.name === required.name && check.app?.id === required.app_id,
      ),
  );
  if (missing.length > 0) {
    return {
      state: "pending",
      reason: `required checks not attached from expected producers: ${missing
        .map((check) => `${check.name}@app:${check.app_id}`)
        .join(", ")}`,
    };
  }

  const pendingRuns = relevantRuns.filter(
    (check) => check.status !== "completed",
  );
  const pendingStatuses = relevantStatuses.filter(
    (status) => status.state === "pending",
  );
  if (
    pendingRuns.length + pendingStatuses.length > 0 ||
    (relevantStatuses.length > 0 && combinedStatusState === "pending")
  ) {
    return { state: "pending", reason: "one or more checks are still running" };
  }

  const failedRuns = relevantRuns.filter(
    (check) => !ALLOWED_CONCLUSIONS.has((check.conclusion ?? "").toLowerCase()),
  );
  const failedStatuses = relevantStatuses.filter(
    (status) => status.state !== "success",
  );
  const requiredNotSuccessful = requiredChecks.filter((required) =>
    relevantRuns.some(
      (check) =>
        check.name === required.name &&
        check.app?.id === required.app_id &&
        (check.conclusion ?? "").toLowerCase() !== "success",
    ),
  );
  if (
    failedRuns.length + failedStatuses.length + requiredNotSuccessful.length >
      0 ||
    (relevantStatuses.length > 0 && combinedStatusState !== "success")
  ) {
    const failures = [
      ...failedRuns.map(
        (check) => `${check.name}=${check.conclusion ?? check.status}`,
      ),
      ...failedStatuses.map((status) => `${status.context}=${status.state}`),
      ...requiredNotSuccessful.map(
        (check) => `${check.name}@app:${check.app_id}=required-not-successful`,
      ),
    ];
    return { state: "failure", reason: [...new Set(failures)].join(", ") };
  }

  return {
    state: "success",
    reason: "all required and attached checks are green",
  };
}

export function hasTrustedDependabotWorkflowProvenance({
  checkRuns,
  workflowRuns,
  requiredChecks,
  headSha,
}) {
  if (
    !Array.isArray(checkRuns) ||
    !Array.isArray(workflowRuns) ||
    !Array.isArray(requiredChecks) ||
    !/^[0-9a-f]{40}$/i.test(headSha ?? "")
  ) {
    return false;
  }

  const requiredNames = new Set(
    requiredChecks
      .filter((required) => required.app_id === GITHUB_ACTIONS_APP_ID)
      .map((required) => required.name),
  );
  const requiredActionsChecks = checkRuns.filter(
    (check) =>
      requiredNames.has(check.name) && check.app?.id === GITHUB_ACTIONS_APP_ID,
  );
  if (requiredActionsChecks.length === 0) return false;

  // Commit author/committer fields are supplied commit metadata and are not
  // provenance. Bind every required Actions check to the immutable account id
  // that triggered the original pull_request run for this exact SHA instead.
  // GitHub re-runs retain that original actor and SHA, so triggering_actor is
  // intentionally not part of this decision.
  const trustedSuiteIds = new Set(
    workflowRuns
      .filter(
        (run) =>
          run.head_sha === headSha &&
          run.event === "pull_request" &&
          run.actor?.id === DEPENDABOT_ACTOR_ID &&
          run.actor?.login === DEPENDABOT_ACTOR_LOGIN &&
          Number.isSafeInteger(run.check_suite_id),
      )
      .map((run) => run.check_suite_id),
  );

  return requiredActionsChecks.every(
    (check) =>
      Number.isSafeInteger(check.check_suite?.id) &&
      trustedSuiteIds.has(check.check_suite.id),
  );
}

function findAutomationCommandRequest(
  comments,
  command,
  marker,
  automationActor,
  now = Date.now(),
) {
  const expectedBody = `@dependabot ${command}\n\n${marker}`;
  return comments
    .filter((comment) => {
      const createdAt = Date.parse(comment.created_at ?? "");
      return (
        comment.user?.id === automationActor.id &&
        comment.user?.login === automationActor.login &&
        comment.body === expectedBody &&
        Number.isFinite(createdAt) &&
        now - createdAt >= 0
      );
    })
    .sort((left, right) => {
      const timeDifference =
        Date.parse(right.created_at) - Date.parse(left.created_at);
      return timeDifference || Number(right.id ?? 0) - Number(left.id ?? 0);
    })[0];
}

function isRecentAutomationCommandRequest(request, now = Date.now()) {
  const retryWindowMs = 6 * 60 * 60 * 1000;
  const createdAt = Date.parse(request?.created_at ?? "");
  return (
    Number.isFinite(createdAt) &&
    now - createdAt >= 0 &&
    now - createdAt < retryWindowMs
  );
}

export function hasRecentAutomationRebaseRequest(
  comments,
  marker,
  automationActor,
  now = Date.now(),
) {
  return Boolean(
    isRecentAutomationCommandRequest(
      findAutomationCommandRequest(
        comments,
        "rebase",
        marker,
        automationActor,
        now,
      ),
      now,
    ),
  );
}

function findTrustedDependabotAlreadyCurrentResponse(
  comments,
  request,
  now = Date.now(),
) {
  const requestId = request?.id;
  if (!Number.isSafeInteger(requestId) || requestId <= 0) return undefined;
  const requestCreatedAt = Date.parse(request?.created_at ?? "");
  if (!Number.isFinite(requestCreatedAt)) return undefined;
  return comments
    .filter((comment) => {
      const createdAt = Date.parse(comment.created_at ?? "");
      return (
        comment.user?.id === DEPENDABOT_ACTOR_ID &&
        comment.user?.login === DEPENDABOT_ACTOR_LOGIN &&
        comment.body?.trim() === DEPENDABOT_ALREADY_CURRENT_RESPONSE &&
        Number.isFinite(createdAt) &&
        createdAt >= requestCreatedAt &&
        now - createdAt >= 0 &&
        Number.isSafeInteger(comment.id) &&
        comment.id > requestId
      );
    })
    .sort((left, right) => {
      const timeDifference =
        Date.parse(right.created_at) - Date.parse(left.created_at);
      return timeDifference || right.id - left.id;
    })[0];
}

export function hasTrustedDependabotAlreadyCurrentResponse(
  comments,
  request,
  now = Date.now(),
) {
  return Boolean(
    findTrustedDependabotAlreadyCurrentResponse(comments, request, now),
  );
}

export function evaluateExactHeadReviews(reviews, headSha) {
  const decisiveStates = new Set([
    "APPROVED",
    "CHANGES_REQUESTED",
    "DISMISSED",
  ]);
  const latestByReviewer = new Map();
  for (const review of reviews) {
    if (
      !decisiveStates.has(review.state) ||
      !Number.isSafeInteger(review.user?.id)
    ) {
      continue;
    }
    const previous = latestByReviewer.get(review.user.id);
    if (!previous || Number(review.id) > Number(previous.id)) {
      latestByReviewer.set(review.user.id, review);
    }
  }
  const latest = [...latestByReviewer.values()];
  return {
    vetoed: latest.some((review) => review.state === "CHANGES_REQUESTED"),
    approved: latest.some(
      (review) => review.state === "APPROVED" && review.commit_id === headSha,
    ),
  };
}

export function findBlockingConnectorReviewThreads(threads) {
  if (!Array.isArray(threads)) {
    throw new Error("Review threads must be an array");
  }
  const blocking = [];
  for (const thread of threads) {
    if (thread?.isResolved === true) continue;
    const comments = thread?.comments?.nodes;
    if (!Array.isArray(comments)) {
      throw new Error("Review thread comments must be an array");
    }
    const connectorComment = comments.find(
      (comment) =>
        comment?.author?.databaseId === CONNECTOR_ACTOR_DATABASE_ID &&
        CONNECTOR_ACTOR_LOGINS.has(comment?.author?.login),
    );
    if (connectorComment) {
      blocking.push(
        typeof connectorComment.url === "string" && connectorComment.url !== ""
          ? connectorComment.url
          : "unlinked connector review thread",
      );
    }
  }
  return blocking;
}

async function github(path, { token, method = "GET", body, allow = [] } = {}) {
  const response = await fetch(`${API_ROOT}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${assertNonEmpty(token, "GitHub token")}`,
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "lcv-dependabot-automerge-controller",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!response.ok && !allow.includes(response.status)) {
    const detail =
      typeof payload === "object" && payload
        ? payload.message
        : String(payload ?? "");
    throw new Error(
      `GitHub API ${method} ${path} failed (${response.status}): ${detail}`,
    );
  }
  return { status: response.status, payload, headers: response.headers };
}

async function paginated(path, token, key = null) {
  const separator = path.includes("?") ? "&" : "?";
  const results = [];
  const maxPages = 10;
  for (let page = 1; page <= maxPages; page += 1) {
    const { payload } = await github(
      `${path}${separator}per_page=100&page=${page}`,
      { token },
    );
    const values = key ? payload?.[key] : payload;
    if (!Array.isArray(values)) {
      throw new Error(`Unexpected paginated response for ${path}`);
    }
    results.push(...values);
    if (values.length < 100) return results;
    if (page === maxPages) {
      throw new Error(`Pagination limit exceeded for ${path}`);
    }
  }
  return results;
}

async function readReviewThreads(owner, repo, number, token) {
  const threads = [];
  let after = null;
  const maxPages = 10;
  for (let page = 1; page <= maxPages; page += 1) {
    const { payload } = await github("/graphql", {
      token,
      method: "POST",
      body: {
        query: REVIEW_THREADS_QUERY,
        variables: { owner, repo, number, after },
      },
    });
    if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
      throw new Error(
        `GitHub GraphQL review-thread query failed: ${payload.errors
          .map((error) => error?.message ?? "unknown error")
          .join("; ")}`,
      );
    }
    const connection = payload?.data?.repository?.pullRequest?.reviewThreads;
    if (!Array.isArray(connection?.nodes)) {
      throw new Error("Unexpected review-thread response from GitHub GraphQL");
    }
    for (const thread of connection.nodes) {
      if (thread?.comments?.pageInfo?.hasNextPage === true) {
        throw new Error(
          `PR #${number} has a review thread with more than 100 comments; refusing to merge without a complete audit`,
        );
      }
      threads.push(thread);
    }
    if (connection.pageInfo?.hasNextPage !== true) return threads;
    after = connection.pageInfo?.endCursor;
    if (typeof after !== "string" || after === "") {
      throw new Error("Review-thread pagination did not provide an end cursor");
    }
    if (page === maxPages) {
      throw new Error("Review-thread pagination limit exceeded");
    }
  }
  return threads;
}

async function readChecks(owner, repo, sha, token) {
  const encodedSha = encodeURIComponent(sha);
  const checkRuns = await paginated(
    `/repos/${owner}/${repo}/commits/${encodedSha}/check-runs?filter=latest`,
    token,
    "check_runs",
  );
  const statuses = await paginated(
    `/repos/${owner}/${repo}/commits/${encodedSha}/statuses`,
    token,
  );
  const { payload: combinedStatus } = await github(
    `/repos/${owner}/${repo}/commits/${encodedSha}/status`,
    { token },
  );
  const workflowRuns = await paginated(
    `/repos/${owner}/${repo}/actions/runs?head_sha=${encodedSha}`,
    token,
    "workflow_runs",
  );
  return {
    checkRuns,
    statuses,
    combinedStatusState: combinedStatus?.state ?? "pending",
    workflowRuns,
  };
}

async function currentMainSha(owner, repo, token) {
  const { payload } = await github(
    `/repos/${owner}/${repo}/git/ref/heads/main`,
    { token },
  );
  const sha = payload?.object?.sha;
  if (!/^[0-9a-f]{40}$/i.test(sha ?? "")) {
    throw new Error("Unable to resolve the current main SHA");
  }
  return sha;
}

async function compareWithMain(owner, repo, mainSha, headSha, token) {
  const { payload } = await github(
    `/repos/${owner}/${repo}/compare/${encodeURIComponent(mainSha)}...${encodeURIComponent(headSha)}`,
    { token },
  );
  return payload;
}

function classifyCanonicalComparison(comparison, expectedMergeBaseSha) {
  if (
    !Number.isSafeInteger(comparison?.behind_by) ||
    comparison.behind_by < 0 ||
    comparison?.merge_base_commit?.sha !== expectedMergeBaseSha
  ) {
    return "invalid";
  }
  if (comparison.behind_by > 0) {
    return comparison.status === "diverged" ? "behind" : "invalid";
  }
  return new Set(["ahead", "identical"]).has(comparison.status)
    ? "current"
    : "invalid";
}

function classifyMergeability(pull) {
  if (pull?.mergeable === false || pull?.mergeable_state === "dirty") {
    return "conflicting";
  }
  if (
    pull?.mergeable !== true ||
    typeof pull.mergeable_state !== "string" ||
    pull.mergeable_state === "" ||
    pull.mergeable_state === "unknown"
  ) {
    return "unknown";
  }
  return "mergeable";
}

async function resolveAutomationActor(token) {
  const { payload: automationActor } = await github("/user", { token });
  if (
    !Number.isSafeInteger(automationActor?.id) ||
    typeof automationActor?.login !== "string" ||
    automationActor.login === ""
  ) {
    throw new Error("Unable to resolve the automation token identity");
  }
  return automationActor;
}

async function requestDependabotRebase(
  owner,
  repo,
  pull,
  expectedMainSha,
  expectedMergeBaseSha,
  repository,
  readToken,
  automationToken,
) {
  const number = pull.number;
  const headSha = pull.head.sha;
  const mainSha = expectedMainSha;
  const marker = `<!-- lcv-dependabot-rebase:${headSha}:${mainSha} -->`;
  const retryMarker = `<!-- lcv-dependabot-rebase-retry:${headSha}:${mainSha} -->`;
  const automationActor = await resolveAutomationActor(automationToken);
  const comments = await paginated(
    `/repos/${owner}/${repo}/issues/${number}/comments`,
    readToken,
  );
  const rebaseRequest = findAutomationCommandRequest(
    comments,
    "rebase",
    marker,
    automationActor,
  );
  let commandMarker = marker;
  let requestedState = "requested";
  const rebaseNoOpResponse =
    rebaseRequest &&
    findTrustedDependabotAlreadyCurrentResponse(comments, rebaseRequest);
  if (rebaseRequest && !rebaseNoOpResponse) {
    if (!isRecentAutomationCommandRequest(rebaseRequest)) {
      throw new Error(
        `PR #${number}: Dependabot did not process the guarded rebase request within six hours; refusing repeated commands for the same head and base.`,
      );
    }
    log(
      `PR #${number}: waiting for Dependabot to process the existing guarded rebase request.`,
    );
    return "waiting";
  }
  if (rebaseRequest) {
    const retryRequest = findAutomationCommandRequest(
      comments,
      "rebase",
      retryMarker,
      automationActor,
    );
    if (retryRequest) {
      if (hasTrustedDependabotAlreadyCurrentResponse(comments, retryRequest)) {
        throw new Error(
          `PR #${number}: Dependabot twice reported a still-behind head as current; refusing destructive recreation and requiring visible intervention.`,
        );
      }
      if (!isRecentAutomationCommandRequest(retryRequest)) {
        throw new Error(
          `PR #${number}: Dependabot did not process the guarded rebase retry within six hours; refusing repeated commands for the same head and base.`,
        );
      }
      log(
        `PR #${number}: waiting for Dependabot to process the existing guarded rebase retry.`,
      );
      return "waiting";
    }
    const noOpResponseCreatedAt = Date.parse(rebaseNoOpResponse.created_at);
    if (Date.now() - noOpResponseCreatedAt < DEPENDABOT_REBASE_RETRY_DELAY_MS) {
      log(
        `PR #${number}: Dependabot reported the still-behind head as current; waiting at least ten minutes before the one guarded rebase retry.`,
      );
      return "waiting";
    }
    commandMarker = retryMarker;
    requestedState = "requested-retry";
    log(
      `PR #${number}: Dependabot reported the still-behind head as current; requesting one non-destructive guarded rebase retry.`,
    );
  }

  const boundary = await validateRebaseBoundary({
    owner,
    repo,
    number,
    expectedHeadSha: headSha,
    expectedMainSha,
    expectedMergeBaseSha,
    repository,
    token: readToken,
  });
  if (!boundary.eligible) {
    log(
      `PR #${number}: rebase boundary changed (${boundary.reason}); deferred.`,
    );
    return "deferred";
  }

  // GitHub's issue-comment endpoint has no expected-head/base precondition. The
  // immediately preceding immutable-head and live-main reads minimize, but
  // cannot eliminate, the residual race before this POST.
  await github(`/repos/${owner}/${repo}/issues/${number}/comments`, {
    token: automationToken,
    method: "POST",
    body: { body: `@dependabot rebase\n\n${commandMarker}` },
  });
  return requestedState;
}

async function inspectPullCandidate(owner, repo, pull, token) {
  const commits = await paginated(
    `/repos/${owner}/${repo}/pulls/${pull.number}/commits`,
    token,
  );
  const hasExpectedCommitShape = hasExpectedDependabotCommitShape(
    commits,
    pull.head.sha,
  );

  const files = await paginated(
    `/repos/${owner}/${repo}/pulls/${pull.number}/files`,
    token,
  );
  if (files.length === 0) {
    return { eligible: false, reason: "pull request has no changed files" };
  }
  const unexpected = files
    .map((file) => file.filename)
    .filter((filename) => !isAllowedDependabotPath(filename));
  if (unexpected.length > 0) {
    return {
      eligible: false,
      reason: `unexpected changed paths: ${unexpected.join(", ")}`,
    };
  }
  return {
    eligible: true,
    hasExpectedCommitShape,
    canonicalParentSha: hasExpectedCommitShape
      ? commits[0].parents[0].sha
      : null,
    reason: hasExpectedCommitShape
      ? "expected commit shape and dependency-only paths"
      : "dependency-only paths with a noncanonical commit set",
  };
}

async function validateRebaseBoundary({
  owner,
  repo,
  number,
  expectedHeadSha,
  expectedMainSha,
  expectedMergeBaseSha,
  repository,
  token,
}) {
  const { payload: freshPull } = await github(
    `/repos/${owner}/${repo}/pulls/${number}`,
    { token },
  );
  if (
    !isTrustedPullRequest(freshPull, repository) ||
    freshPull.head.sha !== expectedHeadSha
  ) {
    return { eligible: false, reason: "identity or head changed" };
  }

  const candidate = await inspectPullCandidate(owner, repo, freshPull, token);
  if (
    !candidate.eligible ||
    !candidate.hasExpectedCommitShape ||
    candidate.canonicalParentSha !== expectedMergeBaseSha
  ) {
    return { eligible: false, reason: "commit shape or changed paths changed" };
  }

  const freshMainSha = await currentMainSha(owner, repo, token);
  if (freshMainSha !== expectedMainSha) {
    return { eligible: false, reason: "main advanced" };
  }
  const comparison = await compareWithMain(
    owner,
    repo,
    freshMainSha,
    freshPull.head.sha,
    token,
  );
  if (
    classifyCanonicalComparison(comparison, expectedMergeBaseSha) !== "behind"
  ) {
    return { eligible: false, reason: "comparison topology changed" };
  }

  const finalMainSha = await currentMainSha(owner, repo, token);
  const { payload: finalPull } = await github(
    `/repos/${owner}/${repo}/pulls/${number}`,
    { token },
  );
  if (
    finalMainSha !== expectedMainSha ||
    !isTrustedPullRequest(finalPull, repository) ||
    finalPull.head.sha !== expectedHeadSha
  ) {
    return {
      eligible: false,
      reason: "head or main changed at the POST boundary",
    };
  }
  return { eligible: true };
}

async function ensureApproval(owner, repo, pull, token) {
  const reviews = await paginated(
    `/repos/${owner}/${repo}/pulls/${pull.number}/reviews`,
    token,
  );
  const reviewState = evaluateExactHeadReviews(reviews, pull.head.sha);
  if (reviewState.vetoed) {
    log(`PR #${pull.number}: PR has an active CHANGES_REQUESTED veto.`);
    return false;
  }
  if (reviewState.approved) {
    log(`PR #${pull.number}: exact head already has an approval.`);
    return true;
  }
  await github(`/repos/${owner}/${repo}/pulls/${pull.number}/reviews`, {
    token,
    method: "POST",
    body: {
      commit_id: pull.head.sha,
      event: "APPROVE",
      body: `Auto-approved Dependabot update after all configured checks passed for ${pull.head.sha}.`,
    },
  });
  log(`PR #${pull.number}: approved exact head ${pull.head.sha}.`);
  return true;
}

async function mergeSquash(owner, repo, pull, automationToken) {
  const { payload } = await github(
    `/repos/${owner}/${repo}/pulls/${pull.number}/merge`,
    {
      token: automationToken,
      method: "PUT",
      body: {
        merge_method: "squash",
        sha: pull.head.sha,
        commit_title: `${pull.title} (#${pull.number})`,
      },
    },
  );
  if (payload?.merged !== true) {
    throw new Error(
      `PR #${pull.number} was not merged: ${payload?.message ?? "unknown reason"}`,
    );
  }

  log(`PR #${pull.number}: squash-merged exact head ${pull.head.sha}.`);
}

export async function runController(env = process.env, runtime = {}) {
  const repository = assertNonEmpty(env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY");
  const [owner, repo, extra] = repository.split("/");
  if (!owner || !repo || extra)
    throw new Error("GITHUB_REPOSITORY must be owner/repo");

  const githubToken = assertNonEmpty(
    env.INPUT_GITHUB_TOKEN ?? env.GITHUB_TOKEN,
    "github_token input",
  );
  const automationToken = assertNonEmpty(
    env.INPUT_AUTOMATION_TOKEN ?? env.LCV_AUTOMATION_TOKEN,
    "automation_token input",
  );
  const requiredChecks = parseRequiredChecks(
    env.INPUT_REQUIRED_CHECKS_JSON ?? env.REQUIRED_CHECKS_JSON,
  );
  const settleTimeoutSeconds = parseBoundedPositiveInteger(
    env.INPUT_SETTLE_TIMEOUT_SECONDS,
    "settle_timeout_seconds",
    { defaultValue: DEFAULT_SETTLE_TIMEOUT_SECONDS, maximum: 480 },
  );
  const settlePollSeconds = parseBoundedPositiveInteger(
    env.INPUT_SETTLE_POLL_SECONDS,
    "settle_poll_seconds",
    { defaultValue: DEFAULT_SETTLE_POLL_SECONDS, maximum: 60 },
  );
  const settleAttempts =
    env.GITHUB_EVENT_NAME === "schedule"
      ? 0
      : Math.ceil(settleTimeoutSeconds / settlePollSeconds);
  const sleep =
    runtime.sleep ??
    ((milliseconds) =>
      new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
      }));
  const dryRun = env.DRY_RUN === "true";
  const pulls = await paginated(
    `/repos/${owner}/${repo}/pulls?state=open&base=main&sort=created&direction=asc`,
    githubToken,
  );
  const dependabotPulls = pulls.filter((pull) =>
    isTrustedPullRequest(pull, repository),
  );
  log(
    `${repository}: ${dependabotPulls.length} candidate open Dependabot PR(s).`,
  );
  if (dependabotPulls.length === 0) return { action: "none" };

  const mainSha = await currentMainSha(owner, repo, githubToken);
  for (const summary of dependabotPulls) {
    const { payload: pull } = await github(
      `/repos/${owner}/${repo}/pulls/${summary.number}`,
      {
        token: githubToken,
      },
    );
    if (!isTrustedPullRequest(pull, repository)) {
      log(
        `PR #${summary.number}: identity changed during inspection; skipped.`,
      );
      continue;
    }

    const candidate = await inspectPullCandidate(
      owner,
      repo,
      pull,
      githubToken,
    );
    if (!candidate.eligible) {
      log(
        `PR #${pull.number}: ineligible candidate (${candidate.reason}); skipped.`,
      );
      continue;
    }

    if (!candidate.hasExpectedCommitShape) {
      log(
        `PR #${pull.number}: commit set is not the expected single verified Dependabot commit; fail-closed without writing to the pull request or its refs.`,
      );
      continue;
    }

    const comparison = await compareWithMain(
      owner,
      repo,
      mainSha,
      pull.head.sha,
      githubToken,
    );
    const comparisonState = classifyCanonicalComparison(
      comparison,
      candidate.canonicalParentSha,
    );
    if (comparisonState === "invalid") {
      log(
        `PR #${pull.number}: GitHub returned an incoherent status, behind count or merge base; deferred.`,
      );
      return { action: "deferred", pull: pull.number, head: pull.head.sha };
    }
    if (comparisonState === "behind") {
      log(
        `PR #${pull.number}: ${comparison.behind_by} commit(s) behind main; requesting a Dependabot-authored rebase.`,
      );
      if (dryRun) {
        return {
          action: "would-request-rebase",
          pull: pull.number,
          head: pull.head.sha,
        };
      }
      const rebaseState = await requestDependabotRebase(
        owner,
        repo,
        pull,
        mainSha,
        candidate.canonicalParentSha,
        repository,
        githubToken,
        automationToken,
      );
      if (rebaseState === "requested") {
        return {
          action: "requested-rebase",
          pull: pull.number,
          head: pull.head.sha,
        };
      }
      if (rebaseState === "requested-retry") {
        return {
          action: "requested-retry",
          pull: pull.number,
          head: pull.head.sha,
        };
      }
      if (rebaseState === "deferred") {
        return { action: "deferred", pull: pull.number, head: pull.head.sha };
      }
      continue;
    }

    let checks = await readChecks(owner, repo, pull.head.sha, githubToken);
    let verdict = classifyChecks({ ...checks, requiredChecks });
    for (
      let settleAttempt = 1;
      verdict.state === "pending" && settleAttempt <= settleAttempts;
      settleAttempt += 1
    ) {
      log(
        `PR #${pull.number}: checks pending; bounded settle poll ${settleAttempt}/${settleAttempts} in ${settlePollSeconds}s.`,
      );
      await sleep(settlePollSeconds * 1000);
      const settledMainSha = await currentMainSha(owner, repo, githubToken);
      const { payload: settledPull } = await github(
        `/repos/${owner}/${repo}/pulls/${pull.number}`,
        { token: githubToken },
      );
      if (
        settledMainSha !== mainSha ||
        !isTrustedPullRequest(settledPull, repository) ||
        settledPull.head.sha !== pull.head.sha
      ) {
        log(
          `PR #${pull.number}: head, identity or main changed while checks settled; deferred.`,
        );
        return { action: "deferred", pull: pull.number, head: pull.head.sha };
      }
      checks = await readChecks(owner, repo, pull.head.sha, githubToken);
      verdict = classifyChecks({ ...checks, requiredChecks });
    }
    log(`PR #${pull.number}: checks=${verdict.state} (${verdict.reason}).`);
    if (verdict.state === "pending" && settleAttempts > 0) {
      log(
        `PR #${pull.number}: bounded ${settleTimeoutSeconds}s settle window expired without a terminal check state.`,
      );
    }
    if (verdict.state !== "success") continue;
    if (
      !hasTrustedDependabotWorkflowProvenance({
        ...checks,
        requiredChecks,
        headSha: pull.head.sha,
      })
    ) {
      log(
        `PR #${pull.number}: required Actions checks lack exact-head Dependabot actor provenance; skipped.`,
      );
      continue;
    }

    const connectorThreads = findBlockingConnectorReviewThreads(
      await readReviewThreads(owner, repo, pull.number, githubToken),
    );
    if (connectorThreads.length > 0) {
      log(
        `PR #${pull.number}: ${connectorThreads.length} unresolved chatgpt-codex-connector inline thread(s) block automation: ${connectorThreads.join(", ")}`,
      );
      continue;
    }

    const { payload: freshPull } = await github(
      `/repos/${owner}/${repo}/pulls/${pull.number}`,
      {
        token: githubToken,
      },
    );
    if (
      !isTrustedPullRequest(freshPull, repository) ||
      freshPull.head.sha !== pull.head.sha
    ) {
      log(
        `PR #${pull.number}: head changed after validation; deferred to the next run.`,
      );
      continue;
    }
    const freshMergeability = classifyMergeability(freshPull);
    if (freshMergeability === "unknown") {
      log(
        `PR #${pull.number}: GitHub mergeability is not yet known; deferred.`,
      );
      return { action: "deferred", pull: pull.number, head: pull.head.sha };
    }
    if (freshMergeability === "conflicting") {
      log(`PR #${pull.number}: GitHub reports merge conflicts; skipped.`);
      continue;
    }

    const freshMainSha = await currentMainSha(owner, repo, githubToken);
    if (freshMainSha !== mainSha) {
      log(
        `PR #${pull.number}: main advanced after validation; deferred to a Dependabot rebase.`,
      );
      return { action: "deferred", pull: pull.number, head: pull.head.sha };
    }

    if (dryRun) {
      log(
        `PR #${pull.number}: dry-run would approve and squash-merge exact head ${pull.head.sha}.`,
      );
      return { action: "would-merge", pull: pull.number, head: pull.head.sha };
    }

    if (!(await ensureApproval(owner, repo, freshPull, githubToken))) {
      continue;
    }

    const postApprovalMainSha = await currentMainSha(owner, repo, githubToken);
    const { payload: postApprovalPull } = await github(
      `/repos/${owner}/${repo}/pulls/${pull.number}`,
      { token: githubToken },
    );
    if (
      postApprovalMainSha !== mainSha ||
      !isTrustedPullRequest(postApprovalPull, repository) ||
      postApprovalPull.head.sha !== pull.head.sha ||
      classifyMergeability(postApprovalPull) !== "mergeable"
    ) {
      log(
        `PR #${pull.number}: head or main changed during approval; merge deferred.`,
      );
      return { action: "deferred", pull: pull.number, head: pull.head.sha };
    }
    const postApprovalCheckSnapshot = await readChecks(
      owner,
      repo,
      pull.head.sha,
      githubToken,
    );
    const postApprovalChecks = classifyChecks({
      ...postApprovalCheckSnapshot,
      requiredChecks,
    });
    if (postApprovalChecks.state !== "success") {
      log(
        `PR #${pull.number}: checks changed during approval; merge deferred.`,
      );
      return { action: "deferred", pull: pull.number, head: pull.head.sha };
    }
    if (
      !hasTrustedDependabotWorkflowProvenance({
        ...postApprovalCheckSnapshot,
        requiredChecks,
        headSha: pull.head.sha,
      })
    ) {
      log(
        `PR #${pull.number}: Actions provenance changed during approval; merge deferred.`,
      );
      return { action: "deferred", pull: pull.number, head: pull.head.sha };
    }

    const finalReviews = await paginated(
      `/repos/${owner}/${repo}/pulls/${pull.number}/reviews`,
      githubToken,
    );
    const finalReviewState = evaluateExactHeadReviews(
      finalReviews,
      pull.head.sha,
    );
    if (finalReviewState.vetoed || !finalReviewState.approved) {
      log(
        `PR #${pull.number}: review state changed during approval; merge deferred.`,
      );
      return { action: "deferred", pull: pull.number, head: pull.head.sha };
    }

    const finalConnectorThreads = findBlockingConnectorReviewThreads(
      await readReviewThreads(owner, repo, pull.number, githubToken),
    );
    if (finalConnectorThreads.length > 0) {
      log(
        `PR #${pull.number}: connector inline feedback changed during approval; merge deferred: ${finalConnectorThreads.join(", ")}`,
      );
      return { action: "deferred", pull: pull.number, head: pull.head.sha };
    }

    // The REST merge endpoint offers an atomic expected head SHA, but no
    // expected base SHA. Re-read both refs and the comparison immediately
    // before that exact-head PUT to minimize the unavoidable base-side race.
    const finalMainSha = await currentMainSha(owner, repo, githubToken);
    const { payload: finalPull } = await github(
      `/repos/${owner}/${repo}/pulls/${pull.number}`,
      { token: githubToken },
    );
    if (
      finalMainSha !== mainSha ||
      !isTrustedPullRequest(finalPull, repository) ||
      finalPull.head.sha !== pull.head.sha ||
      classifyMergeability(finalPull) !== "mergeable"
    ) {
      log(
        `PR #${pull.number}: head or main changed immediately before merge; deferred.`,
      );
      return { action: "deferred", pull: pull.number, head: pull.head.sha };
    }
    const finalComparison = await compareWithMain(
      owner,
      repo,
      finalMainSha,
      finalPull.head.sha,
      githubToken,
    );
    if (
      classifyCanonicalComparison(
        finalComparison,
        candidate.canonicalParentSha,
      ) !== "current"
    ) {
      log(
        `PR #${pull.number}: final comparison status, behind count or merge base changed; deferred.`,
      );
      return { action: "deferred", pull: pull.number, head: pull.head.sha };
    }
    const mergeMainSha = await currentMainSha(owner, repo, githubToken);
    if (mergeMainSha !== mainSha) {
      log(
        `PR #${pull.number}: main advanced at the final merge boundary; deferred.`,
      );
      return { action: "deferred", pull: pull.number, head: pull.head.sha };
    }

    await mergeSquash(owner, repo, finalPull, automationToken);
    return { action: "merged", pull: pull.number, head: pull.head.sha };
  }

  return { action: "none" };
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  runController().catch((error) => {
    process.stderr.write(`controller failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
