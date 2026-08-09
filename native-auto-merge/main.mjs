#!/usr/bin/env node

import { execFile as nodeExecFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile as nodeReadFile } from "node:fs/promises";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const API_ROOT = "https://api.github.com";
const API_VERSION = "2026-03-10";
const API_TIMEOUT_MILLISECONDS = 15_000;
const GH_TIMEOUT_MILLISECONDS = 60_000;
const GITHUB_ACTIONS_APP_ID = 15368;
const OPEN_PULLS_PER_PAGE = 100;
const MAX_OPEN_PULL_PAGES = 100;
const EFFECTIVE_RULES_PER_PAGE = 100;
const MAX_EFFECTIVE_RULE_PAGES = 100;
const CHECK_RUNS_PER_PAGE = 100;
const MAX_CHECK_RUN_PAGES = 100;
const REVIEW_CONNECTION_LIMIT = 100;
const REVIEW_POLL_MILLISECONDS = 15_000;
const REVIEW_QUIET_MILLISECONDS = 120_000;
const REVIEW_TIMEOUT_MILLISECONDS = 720_000;
const NATIVE_PRIVILEGE_RETRY_MILLISECONDS = 5_000;
const NATIVE_PRIVILEGE_RETRY_ATTEMPTS = 4;
const POLICY_URL = new URL("../native-governance/policy.json", import.meta.url);
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const REVIEW_BOT_DATABASE_IDS = new Set([175728472, 199175422]);
const COPILOT_REVIEW_BOT_DATABASE_ID = 175728472;
const CODEX_REVIEW_BOT_DATABASE_ID = 199175422;
const CODEQL_WORKFLOW_NAME = "CodeQL";
const CODEQL_WORKFLOW_PATH = ".github/workflows/codeql.yml";
const FEEDBACK_WORKFLOW_NAME = "Native PR feedback signal";
const FEEDBACK_WORKFLOW_PATH =
  ".github/workflows/native-pr-feedback-signal.yml";
const FEEDBACK_WORKFLOW_EVENTS = new Set([
  "issue_comment",
  "pull_request_review",
  "pull_request_review_comment",
]);
const REQUIRED_SIMPLE_RULES = [
  "deletion",
  "non_fast_forward",
  "required_signatures",
  "required_linear_history",
];
const execFileAsync = promisify(nodeExecFile);

const NATIVE_STATE_QUERY = `
  query NativeAutoMergeState(
    $owner: String!
    $repo: String!
    $number: Int!
  ) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        id
        autoMergeRequest {
          enabledAt
        }
        mergeQueueEntry {
          id
        }
      }
    }
  }
`;

const DISABLE_AUTO_MERGE_MUTATION = `
  mutation DisableNativeAutoMerge($pullRequestId: ID!) {
    disablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) {
      pullRequest {
        id
      }
    }
  }
`;

const DEQUEUE_PULL_REQUEST_MUTATION = `
  mutation DequeueNativePullRequest($pullRequestId: ID!) {
    dequeuePullRequest(input: { id: $pullRequestId }) {
      mergeQueueEntry {
        id
      }
    }
  }
`;

const REVIEW_RECONCILIATION_QUERY = `
  query NativeAutoMergeReviewState(
    $owner: String!
    $repo: String!
    $number: Int!
    $limit: Int!
  ) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        id
        headRefOid
        comments(first: $limit) {
          nodes {
            id
            author {
              __typename
              login
              ... on Bot {
                databaseId
              }
              ... on User {
                databaseId
              }
            }
            body
            createdAt
            updatedAt
            isMinimized
            minimizedReason
          }
          pageInfo {
            hasNextPage
          }
        }
        reviews(first: $limit) {
          nodes {
            id
            author {
              __typename
              login
              ... on Bot {
                databaseId
              }
              ... on User {
                databaseId
              }
            }
            body
            state
            commit {
              oid
            }
            createdAt
            submittedAt
            updatedAt
            isMinimized
            minimizedReason
          }
          pageInfo {
            hasNextPage
          }
        }
        reviewThreads(first: $limit) {
          nodes {
            id
            isResolved
            isOutdated
            isCollapsed
            comments(first: $limit) {
              nodes {
                id
                author {
                  __typename
                  login
                  ... on Bot {
                    databaseId
                  }
                  ... on User {
                    databaseId
                  }
                }
                originalCommit {
                  oid
                }
                createdAt
                updatedAt
                isMinimized
                minimizedReason
              }
              pageInfo {
                hasNextPage
              }
            }
          }
          pageInfo {
            hasNextPage
          }
        }
      }
    }
  }
`;

function log(message) {
  process.stdout.write(`${message}\n`);
}

function nonEmpty(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function parseRepository(value) {
  const repository = nonEmpty(value, "GITHUB_REPOSITORY");
  const parts = repository.split("/");
  if (
    parts.length !== 2 ||
    parts.some(
      (part) =>
        part === "" ||
        !/^[A-Za-z0-9_.-]+$/.test(part) ||
        part === "." ||
        part === "..",
    )
  ) {
    throw new Error("GITHUB_REPOSITORY must be an owner/repository pair");
  }
  return { repository, owner: parts[0], repo: parts[1] };
}

function positivePullNumber(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function malformedEffectiveRules(detail) {
  throw new Error(`Malformed effective branch rules payload: ${detail}`);
}

function malformedPolicy(detail) {
  throw new Error(`Malformed pinned native governance policy: ${detail}`);
}

function validateRequiredChecks(requiredChecks) {
  if (!Array.isArray(requiredChecks) || requiredChecks.length === 0) {
    malformedPolicy("required_checks must be a non-empty array");
  }
  const names = new Set();
  return requiredChecks.map((check) => {
    if (
      !isObject(check) ||
      typeof check.name !== "string" ||
      check.name.trim() === "" ||
      check.name !== check.name.trim() ||
      !Number.isSafeInteger(check.app_id) ||
      check.app_id <= 0
    ) {
      malformedPolicy("required check name or app_id is invalid");
    }
    if (names.has(check.name)) {
      malformedPolicy(`duplicate required check name ${check.name}`);
    }
    names.add(check.name);
    return { name: check.name, app_id: check.app_id };
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validTimestamp(value, label, { nullable = false } = {}) {
  if (value === null && nullable) return null;
  if (typeof value !== "string" || value === "") {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

function graphQlPageIsComplete(connection, label) {
  if (
    !isObject(connection) ||
    !Array.isArray(connection.nodes) ||
    !isObject(connection.pageInfo) ||
    typeof connection.pageInfo.hasNextPage !== "boolean"
  ) {
    throw new Error(`Malformed ${label} connection`);
  }
  if (connection.pageInfo.hasNextPage) {
    throw new Error(`Truncated ${label} connection`);
  }
  return connection.nodes;
}

function normalizedActor(author, label) {
  if (author === null) return null;
  if (
    !isObject(author) ||
    typeof author.__typename !== "string" ||
    typeof author.login !== "string"
  ) {
    throw new Error(`Malformed ${label} author`);
  }
  return {
    type: author.__typename,
    login: author.login,
    databaseId: Number.isSafeInteger(author.databaseId)
      ? author.databaseId
      : null,
  };
}

function isReviewBot(actor) {
  return actor?.type === "Bot" && REVIEW_BOT_DATABASE_IDS.has(actor.databaseId);
}

function parseSuppressedCommentCount(body) {
  const markers = body.match(/Suppressed comments/gi) ?? [];
  if (markers.length === 0) return 0;
  const matches = [
    ...body.matchAll(
      /<summary>\s*Suppressed comments \(([1-9][0-9]*)\)\s*<\/summary>/gi,
    ),
  ];
  if (markers.length !== 1 || matches.length !== 1) {
    throw new Error("Copilot Suppressed comments marker is malformed");
  }
  const match = matches[0];
  const detailsStart = body.lastIndexOf("<details>", match.index);
  const detailsEnd = body.indexOf("</details>", match.index + match[0].length);
  const count = Number(matches[0][1]);
  if (
    detailsStart < 0 ||
    detailsEnd < 0 ||
    !Number.isSafeInteger(count) ||
    count <= 0
  ) {
    throw new Error("Copilot Suppressed comments marker is malformed");
  }
  return count;
}

function parseCopilotReviewBody(body) {
  if (
    typeof body !== "string" ||
    !/^## Pull request overview\r?\n/.test(body)
  ) {
    throw new Error("Copilot review body is malformed");
  }
  const summaries = [
    ...body.matchAll(
      /^Copilot reviewed ([0-9]+) out of ([0-9]+) changed files? in this pull request and generated (no(?: new)? comments?|([1-9][0-9]*) comments?)\.$/gm,
    ),
  ];
  const hasKnownFooter =
    /\r?\n---\r?\n\r?\n💡 <a href="\/[^"\r\n]+\/new\/main\?filename=\.github\/skills\/code-review\/SKILL\.md"[\s\S]*href="https:\/\/docs\.github\.com\/en\/copilot\/how-tos\/use-copilot-agents\/request-a-code-review\/use-code-review#mcp-servers-and-agent-skills"[\s\S]*$/.test(
      body,
    );
  if (summaries.length > 1 || (summaries.length === 0 && !hasKnownFooter)) {
    throw new Error("Copilot review body is malformed");
  }
  if (summaries.length === 1) {
    const reviewed = Number(summaries[0][1]);
    const total = Number(summaries[0][2]);
    const commentCount = summaries[0][4] ? Number(summaries[0][4]) : 0;
    if (
      !Number.isSafeInteger(reviewed) ||
      !Number.isSafeInteger(total) ||
      !Number.isSafeInteger(commentCount) ||
      reviewed < 0 ||
      total <= 0 ||
      reviewed > total ||
      commentCount < 0
    ) {
      throw new Error("Copilot review body is malformed");
    }
  }
  return {
    suppressedCommentCount: parseSuppressedCommentCount(body),
  };
}

function parseCodexReviewComment(body) {
  if (typeof body !== "string" || body === "") {
    throw new Error("Codex review comment is malformed");
  }
  const match = body.match(
    /^Codex Review: Didn't find any major issues\.[^\r\n]*\r?\n\r?\n\*\*Reviewed commit:\*\* `([0-9a-f]{7,40})`(?:\r?\n\r?\n<details>[\s\S]*<\/details>)?\s*$/i,
  );
  if (match) {
    return { clean: true, reviewedCommit: match[1].toLowerCase() };
  }
  const reviewedCommit = body.match(
    /\*\*Reviewed commit:\*\* `([0-9a-f]{7,40})`/i,
  );
  if (!reviewedCommit) {
    throw new Error("Codex review comment is malformed");
  }
  return { clean: false, reviewedCommit: reviewedCommit[1].toLowerCase() };
}

export function assessRequiredCheckRuns(
  requiredChecksCandidate,
  checkRuns,
  headSha,
) {
  const requiredChecks = validateRequiredChecks(requiredChecksCandidate);
  if (!SHA_PATTERN.test(headSha ?? "")) {
    throw new Error("head SHA must be a full hexadecimal SHA-1");
  }
  if (!Array.isArray(checkRuns)) {
    throw new Error("Malformed check-run inventory payload");
  }

  const canonical = [];
  let status = "success";
  for (const required of requiredChecks) {
    const matches = checkRuns.filter(
      (run) =>
        isObject(run) &&
        run.name === required.name &&
        run.app?.id === required.app_id &&
        run.head_sha === headSha,
    );
    if (matches.length > 1) {
      throw new Error(`Duplicate required check run ${required.name}`);
    }
    if (matches.length === 0) {
      status = status === "failure" ? status : "pending";
      canonical.push({
        name: required.name,
        appId: required.app_id,
        state: "missing",
      });
      continue;
    }
    const run = matches[0];
    if (
      !Number.isSafeInteger(run.id) ||
      run.id <= 0 ||
      typeof run.status !== "string" ||
      !isObject(run.app)
    ) {
      throw new Error(`Malformed required check run ${required.name}`);
    }
    if (run.status !== "completed") {
      status = status === "failure" ? status : "pending";
      canonical.push({
        id: run.id,
        name: required.name,
        appId: required.app_id,
        state: run.status,
      });
      continue;
    }
    const completedAt = validTimestamp(
      run.completed_at,
      `${required.name} completed_at`,
    );
    if (run.conclusion !== "success") status = "failure";
    canonical.push({
      id: run.id,
      name: required.name,
      appId: required.app_id,
      state: "completed",
      conclusion: run.conclusion,
      completedAt,
    });
  }

  return {
    status,
    fingerprint: sha256(JSON.stringify(canonical)),
  };
}

export function assessReviewSnapshot(snapshot, headSha) {
  if (!SHA_PATTERN.test(headSha ?? "")) {
    throw new Error("head SHA must be a full hexadecimal SHA-1");
  }
  if (
    !isObject(snapshot) ||
    typeof snapshot.id !== "string" ||
    snapshot.id === "" ||
    snapshot.headRefOid !== headSha
  ) {
    throw new Error("Malformed or stale review reconciliation payload");
  }
  const reviewNodes = graphQlPageIsComplete(snapshot.reviews, "review");
  const issueCommentNodes = graphQlPageIsComplete(
    snapshot.comments,
    "issue comment",
  );
  const threadNodes = graphQlPageIsComplete(
    snapshot.reviewThreads,
    "review thread",
  );

  const codexComments = [];
  const blockingCodexCommentIds = [];
  for (const candidate of issueCommentNodes) {
    if (!isObject(candidate)) throw new Error("Malformed issue comment");
    const author = normalizedActor(candidate.author, "issue comment");
    if (author?.databaseId !== CODEX_REVIEW_BOT_DATABASE_ID) continue;
    if (
      !isReviewBot(author) ||
      typeof candidate.id !== "string" ||
      candidate.id === "" ||
      typeof candidate.body !== "string" ||
      typeof candidate.isMinimized !== "boolean" ||
      !(
        candidate.minimizedReason === null ||
        typeof candidate.minimizedReason === "string"
      )
    ) {
      throw new Error("Malformed Codex issue comment");
    }
    const parsed = parseCodexReviewComment(candidate.body);
    const normalized = {
      id: candidate.id,
      author,
      bodyHash: sha256(candidate.body),
      reviewedCommit: parsed.reviewedCommit,
      clean: parsed.clean,
      createdAt: validTimestamp(candidate.createdAt, "issue comment createdAt"),
      updatedAt: validTimestamp(candidate.updatedAt, "issue comment updatedAt"),
      isMinimized: candidate.isMinimized,
      minimizedReason: candidate.minimizedReason,
    };
    codexComments.push(normalized);
    if (
      headSha.toLowerCase().startsWith(parsed.reviewedCommit) &&
      !parsed.clean
    ) {
      blockingCodexCommentIds.push(candidate.id);
    }
  }

  const botReviews = [];
  for (const candidate of reviewNodes) {
    if (!isObject(candidate)) throw new Error("Malformed pull request review");
    const author = normalizedActor(candidate.author, "review");
    if (!isReviewBot(author)) continue;
    if (
      typeof candidate.id !== "string" ||
      candidate.id === "" ||
      typeof candidate.body !== "string" ||
      typeof candidate.state !== "string" ||
      !isObject(candidate.commit) ||
      !SHA_PATTERN.test(candidate.commit.oid ?? "") ||
      typeof candidate.isMinimized !== "boolean" ||
      !(
        candidate.minimizedReason === null ||
        typeof candidate.minimizedReason === "string"
      )
    ) {
      throw new Error("Malformed bot pull request review");
    }
    const createdAt = validTimestamp(candidate.createdAt, "review createdAt");
    const submittedAt = validTimestamp(
      candidate.submittedAt,
      "review submittedAt",
      { nullable: true },
    );
    const updatedAt = validTimestamp(candidate.updatedAt, "review updatedAt");
    botReviews.push({
      id: candidate.id,
      author,
      body: candidate.body,
      bodyHash: sha256(candidate.body),
      state: candidate.state,
      commit: candidate.commit.oid,
      createdAt,
      submittedAt,
      updatedAt,
      isMinimized: candidate.isMinimized,
      minimizedReason: candidate.minimizedReason,
    });
  }

  const botThreads = [];
  const unresolvedBotThreadIds = [];
  for (const candidate of threadNodes) {
    if (
      !isObject(candidate) ||
      typeof candidate.id !== "string" ||
      candidate.id === "" ||
      typeof candidate.isResolved !== "boolean" ||
      typeof candidate.isOutdated !== "boolean" ||
      typeof candidate.isCollapsed !== "boolean"
    ) {
      throw new Error("Malformed pull request review thread");
    }
    const commentNodes = graphQlPageIsComplete(
      candidate.comments,
      "review thread comments",
    );
    const comments = commentNodes.map((comment) => {
      if (
        !isObject(comment) ||
        typeof comment.id !== "string" ||
        comment.id === "" ||
        typeof comment.isMinimized !== "boolean" ||
        !(
          comment.minimizedReason === null ||
          typeof comment.minimizedReason === "string"
        )
      ) {
        throw new Error("Malformed pull request review comment");
      }
      const author = normalizedActor(comment.author, "review comment");
      return {
        id: comment.id,
        author,
        originalCommit:
          comment.originalCommit === null
            ? null
            : nonEmpty(comment.originalCommit?.oid, "original review commit"),
        createdAt: validTimestamp(
          comment.createdAt,
          "review comment createdAt",
        ),
        updatedAt: validTimestamp(
          comment.updatedAt,
          "review comment updatedAt",
        ),
        isMinimized: comment.isMinimized,
        minimizedReason: comment.minimizedReason,
      };
    });
    if (!comments.some((comment) => isReviewBot(comment.author))) continue;
    const normalized = {
      id: candidate.id,
      isResolved: candidate.isResolved,
      isOutdated: candidate.isOutdated,
      isCollapsed: candidate.isCollapsed,
      comments,
    };
    botThreads.push(normalized);
    if (!candidate.isResolved) unresolvedBotThreadIds.push(candidate.id);
  }

  botReviews.sort((left, right) => left.id.localeCompare(right.id));
  botThreads.sort((left, right) => left.id.localeCompare(right.id));
  codexComments.sort((left, right) => left.id.localeCompare(right.id));
  blockingCodexCommentIds.sort();
  unresolvedBotThreadIds.sort();

  const exactHeadCopilotReviews = botReviews.filter(
    (candidate) =>
      candidate.author.databaseId === COPILOT_REVIEW_BOT_DATABASE_ID &&
      candidate.commit === headSha,
  );
  let suppressedCommentCount = 0;
  for (const copilotReview of exactHeadCopilotReviews) {
    const parsed = parseCopilotReviewBody(copilotReview.body);
    suppressedCommentCount += parsed.suppressedCommentCount;
    if (!Number.isSafeInteger(suppressedCommentCount)) {
      throw new Error("Copilot Suppressed comments count is malformed");
    }
  }

  const canonical = {
    headRefOid: snapshot.headRefOid,
    comments: codexComments,
    reviews: botReviews.map(({ body: _body, ...candidate }) => candidate),
    threads: botThreads,
  };
  return {
    status:
      suppressedCommentCount > 0 ||
      unresolvedBotThreadIds.length > 0 ||
      blockingCodexCommentIds.length > 0
        ? "blocked"
        : "clear",
    suppressedCommentCount,
    blockingCodexCommentIds,
    unresolvedBotThreadIds,
    fingerprint: sha256(JSON.stringify(canonical)),
  };
}

function parameterObjects(rules, type) {
  return rules
    .filter((rule) => rule.type === type)
    .map((rule) => {
      if (!isObject(rule.parameters)) {
        malformedEffectiveRules(`${type} parameters must be an object`);
      }
      return rule.parameters;
    });
}

function parseResponsePayload(response, text) {
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `GitHub API returned a non-JSON response (${response.status})`,
    );
  }
}

async function githubRequest(path, options, runtime = {}) {
  const fetchImpl = runtime.fetch ?? globalThis.fetch;
  const timeoutSignal =
    runtime.timeoutSignal ?? AbortSignal.timeout(API_TIMEOUT_MILLISECONDS);
  const response = await fetchImpl(`${API_ROOT}${path}`, {
    method: options.method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${options.token}`,
      "content-type": "application/json",
      "user-agent": "LCV-Native-Auto-Merge/1.0",
      "x-github-api-version": API_VERSION,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: "error",
    signal: timeoutSignal,
  });
  const text = await response.text();
  const payload = parseResponsePayload(response, text);
  if (!response.ok) {
    const detail = payload?.message ?? `HTTP ${response.status}`;
    throw new Error(
      `GitHub API request failed (${response.status}): ${detail}`,
    );
  }
  return payload;
}

export function extractCandidates(eventName, event, repository) {
  if (
    eventName !== "workflow_run" ||
    event?.repository?.full_name !== repository
  ) {
    return [];
  }

  const run = event.workflow_run;
  if (!isObject(run) || run.status !== "completed") {
    return [];
  }

  if (
    run.name === FEEDBACK_WORKFLOW_NAME &&
    run.path === FEEDBACK_WORKFLOW_PATH &&
    FEEDBACK_WORKFLOW_EVENTS.has(run.event)
  ) {
    const match = run.display_title?.match(
      /^Native PR feedback PR #([1-9][0-9]*) sender #([1-9][0-9]*)$/,
    );
    if (!match) return [];
    const number = Number(match[1]);
    const senderId = Number(match[2]);
    if (
      !positivePullNumber(number) ||
      !Number.isSafeInteger(senderId) ||
      !REVIEW_BOT_DATABASE_IDS.has(senderId)
    ) {
      return [];
    }
    return [{ number, source: "feedback-workflow-run" }];
  }

  if (
    run.name !== CODEQL_WORKFLOW_NAME ||
    run.path !== CODEQL_WORKFLOW_PATH ||
    run.event !== "pull_request" ||
    !SHA_PATTERN.test(run.head_sha ?? "") ||
    !Array.isArray(run.pull_requests) ||
    run.pull_requests.length !== 1
  ) {
    return [];
  }

  const pull = run.pull_requests[0];
  if (
    !positivePullNumber(pull?.number) ||
    pull?.base?.ref !== "main" ||
    pull?.head?.sha !== run.head_sha ||
    !SHA_PATTERN.test(pull.head.sha)
  ) {
    return [];
  }
  return [
    {
      number: pull.number,
      headSha: pull.head.sha,
      source: "workflow_run",
    },
  ];
}

export function workflowRunEventFromInputs(env) {
  let pullRequests;
  try {
    pullRequests = JSON.parse(
      nonEmpty(
        env.INPUT_WORKFLOW_PULL_REQUESTS,
        "workflow_pull_requests input",
      ),
    );
  } catch (error) {
    throw new Error(
      `workflow_pull_requests input is invalid: ${error.message}`,
    );
  }
  if (!Array.isArray(pullRequests)) {
    throw new Error("workflow_pull_requests input must contain a JSON array");
  }
  return {
    repository: {
      full_name: nonEmpty(env.INPUT_EVENT_REPOSITORY, "event_repository input"),
    },
    workflow_run: {
      name: nonEmpty(env.INPUT_WORKFLOW_NAME, "workflow_name input"),
      path: nonEmpty(env.INPUT_WORKFLOW_PATH, "workflow_path input"),
      display_title: nonEmpty(
        env.INPUT_WORKFLOW_DISPLAY_TITLE,
        "workflow_display_title input",
      ),
      status: nonEmpty(env.INPUT_WORKFLOW_STATUS, "workflow_status input"),
      event: nonEmpty(env.INPUT_WORKFLOW_EVENT, "workflow_event input"),
      head_sha: nonEmpty(
        env.INPUT_WORKFLOW_HEAD_SHA,
        "workflow_head_sha input",
      ),
      pull_requests: pullRequests,
    },
  };
}

export function isEligiblePull(pull, candidate, repository) {
  const actor = pull?.user;
  const eligibleActor = Boolean(
    isObject(actor) &&
    typeof actor.login === "string" &&
    /^[^\s\u0000-\u001f\u007f]+$/.test(actor.login) &&
    Number.isSafeInteger(actor.id) &&
    actor.id > 0 &&
    (actor.type === "User" || actor.type === "Bot"),
  );
  return Boolean(
    positivePullNumber(candidate?.number) &&
    pull?.number === candidate.number &&
    pull.state === "open" &&
    pull.draft === false &&
    eligibleActor &&
    SHA_PATTERN.test(candidate?.headSha ?? "") &&
    pull.head?.sha === candidate.headSha &&
    typeof pull.head?.ref === "string" &&
    pull.head.ref !== "" &&
    pull.head?.repo?.full_name === repository &&
    pull.base?.ref === "main" &&
    pull.base?.repo?.full_name === repository,
  );
}

function candidateForOpenPull(candidate, pull) {
  if (candidate?.source !== "feedback-workflow-run") return candidate;
  return {
    ...candidate,
    headSha: pull?.head?.sha,
  };
}

export function hasRequiredNativeEnforcement(rules, requiredChecks) {
  if (!Array.isArray(rules)) {
    malformedEffectiveRules("root must be an array");
  }
  for (const rule of rules) {
    if (!isObject(rule) || typeof rule.type !== "string" || rule.type === "") {
      malformedEffectiveRules("every rule must be an object with a type");
    }
  }

  const pullRules = parameterObjects(rules, "pull_request");
  for (const parameters of pullRules) {
    if (
      !Array.isArray(parameters.allowed_merge_methods) ||
      parameters.allowed_merge_methods.some(
        (method) => typeof method !== "string",
      ) ||
      typeof parameters.required_review_thread_resolution !== "boolean"
    ) {
      malformedEffectiveRules("pull_request parameters are invalid");
    }
  }

  const codeScanningRules = parameterObjects(rules, "code_scanning");
  const codeScanningTools = [];
  for (const parameters of codeScanningRules) {
    if (!Array.isArray(parameters.code_scanning_tools)) {
      malformedEffectiveRules("code_scanning_tools must be an array");
    }
    for (const tool of parameters.code_scanning_tools) {
      if (
        !isObject(tool) ||
        typeof tool.tool !== "string" ||
        typeof tool.alerts_threshold !== "string" ||
        typeof tool.security_alerts_threshold !== "string"
      ) {
        malformedEffectiveRules("code_scanning tool parameters are invalid");
      }
      codeScanningTools.push(tool);
    }
  }

  const mergeQueueRules = parameterObjects(rules, "merge_queue");
  for (const parameters of mergeQueueRules) {
    if (
      typeof parameters.merge_method !== "string" ||
      typeof parameters.grouping_strategy !== "string" ||
      !Number.isSafeInteger(parameters.max_entries_to_build) ||
      !Number.isSafeInteger(parameters.max_entries_to_merge) ||
      !Number.isSafeInteger(parameters.min_entries_to_merge)
    ) {
      malformedEffectiveRules("merge_queue parameters are invalid");
    }
  }

  const statusRules = parameterObjects(rules, "required_status_checks");
  for (const parameters of statusRules) {
    if (!Array.isArray(parameters.required_status_checks)) {
      malformedEffectiveRules("required_status_checks must be an array");
    }
    for (const check of parameters.required_status_checks) {
      if (!isObject(check) || typeof check.context !== "string") {
        malformedEffectiveRules("required status check context is invalid");
      }
      if (
        check.integration_id !== undefined &&
        check.integration_id !== null &&
        (!Number.isSafeInteger(check.integration_id) ||
          check.integration_id <= 0)
      ) {
        malformedEffectiveRules(
          "required status check integration_id is invalid",
        );
      }
    }
  }

  const types = new Set(rules.map((rule) => rule.type));
  const hasSimpleRules = REQUIRED_SIMPLE_RULES.every((type) => types.has(type));
  const hasPullRequestRule = pullRules.some(
    (parameters) =>
      parameters.allowed_merge_methods.length === 1 &&
      parameters.allowed_merge_methods[0] === "squash" &&
      parameters.required_review_thread_resolution === true,
  );
  const hasCodeScanningTool = (name) =>
    codeScanningTools.some(
      (tool) =>
        tool.tool === name &&
        tool.alerts_threshold === "all" &&
        tool.security_alerts_threshold === "all",
    );
  const hasMergeQueueRule = mergeQueueRules.some(
    (parameters) =>
      parameters.merge_method === "SQUASH" &&
      parameters.grouping_strategy === "ALLGREEN" &&
      parameters.max_entries_to_build === 1 &&
      parameters.max_entries_to_merge === 1 &&
      parameters.min_entries_to_merge === 1,
  );
  const hasAppBoundStatusChecks =
    statusRules.length > 0 &&
    statusRules.every(
      (parameters) =>
        parameters.required_status_checks.length > 0 &&
        parameters.required_status_checks.every(
          (check) =>
            check.context.trim() !== "" &&
            Number.isSafeInteger(check.integration_id) &&
            check.integration_id > 0,
        ),
    );
  const statusChecks = statusRules.flatMap(
    (parameters) => parameters.required_status_checks,
  );
  const policyChecks = validateRequiredChecks(requiredChecks);
  const hasEveryPolicyCheck = policyChecks.every((required) =>
    statusChecks.some(
      (effective) =>
        effective.context === required.name &&
        effective.integration_id === required.app_id,
    ),
  );
  const hasActionsAnalysisCheck = statusChecks.some(
    (check) =>
      check.integration_id === GITHUB_ACTIONS_APP_ID &&
      check.context.startsWith("Analyze ") &&
      check.context.slice("Analyze ".length).trim() !== "",
  );
  const hasActionsZizmorCheck = statusChecks.some(
    (check) =>
      check.integration_id === GITHUB_ACTIONS_APP_ID &&
      ["Run zizmor", "Run zizmor / Run zizmor"].includes(check.context),
  );

  return Boolean(
    hasSimpleRules &&
    hasPullRequestRule &&
    hasCodeScanningTool("CodeQL") &&
    hasCodeScanningTool("zizmor") &&
    hasMergeQueueRule &&
    hasAppBoundStatusChecks &&
    hasEveryPolicyCheck &&
    hasActionsAnalysisCheck &&
    hasActionsZizmorCheck,
  );
}

export async function loadRequiredChecks(repository, runtime = {}) {
  const { owner, repo } = parseRepository(repository);
  const readFile = runtime.readFile ?? nodeReadFile;
  let policy;
  try {
    policy = JSON.parse(await readFile(POLICY_URL, "utf8"));
  } catch (error) {
    malformedPolicy(`cannot read or parse policy.json: ${error.message}`);
  }
  if (
    !isObject(policy) ||
    policy.schema_version !== 1 ||
    policy.organization !== owner ||
    !isObject(policy.repositories)
  ) {
    malformedPolicy(
      "root, schema version, organization or repositories invalid",
    );
  }
  if (!Object.hasOwn(policy.repositories, repo)) {
    return null;
  }
  const repositoryPolicy = policy.repositories[repo];
  if (!isObject(repositoryPolicy)) {
    malformedPolicy(`repository ${repo} must be an object`);
  }
  return validateRequiredChecks(repositoryPolicy.required_checks);
}

export async function githubGetPull(repository, number, token, runtime = {}) {
  parseRepository(repository);
  if (!positivePullNumber(number)) {
    throw new Error("pull request number must be a positive safe integer");
  }
  nonEmpty(token, "automation_token input");
  return githubRequest(
    `/repos/${repository}/pulls/${number}`,
    { method: "GET", token },
    runtime,
  );
}

export async function githubListOpenPulls(repository, token, runtime = {}) {
  parseRepository(repository);
  nonEmpty(token, "automation_token input");
  const pulls = [];
  for (let page = 1; page <= MAX_OPEN_PULL_PAGES; page += 1) {
    const payload = await githubRequest(
      `/repos/${repository}/pulls?state=open&base=main&per_page=${OPEN_PULLS_PER_PAGE}&page=${page}`,
      { method: "GET", token },
      runtime,
    );
    if (!Array.isArray(payload)) {
      throw new Error("Malformed open pull request inventory payload");
    }
    pulls.push(...payload);
    if (payload.length < OPEN_PULLS_PER_PAGE) {
      return pulls;
    }
  }
  throw new Error("Open pull request inventory exceeded the pagination limit");
}

export async function githubListCheckRuns(
  repository,
  headSha,
  token,
  runtime = {},
) {
  parseRepository(repository);
  if (!SHA_PATTERN.test(headSha ?? "")) {
    throw new Error("head SHA must be a full hexadecimal SHA-1");
  }
  nonEmpty(token, "automation_token input");
  const checkRuns = [];
  let expectedTotal = null;
  for (let page = 1; page <= MAX_CHECK_RUN_PAGES; page += 1) {
    const payload = await githubRequest(
      `/repos/${repository}/commits/${headSha}/check-runs?filter=latest&per_page=${CHECK_RUNS_PER_PAGE}&page=${page}`,
      { method: "GET", token },
      runtime,
    );
    if (
      !isObject(payload) ||
      !Number.isSafeInteger(payload.total_count) ||
      payload.total_count < 0 ||
      !Array.isArray(payload.check_runs)
    ) {
      throw new Error("Malformed check-run inventory payload");
    }
    if (expectedTotal === null) expectedTotal = payload.total_count;
    if (payload.total_count !== expectedTotal) {
      throw new Error("Check-run inventory changed during pagination");
    }
    checkRuns.push(...payload.check_runs);
    if (checkRuns.length >= expectedTotal) {
      if (checkRuns.length !== expectedTotal) {
        throw new Error("Check-run inventory exceeded its declared total");
      }
      return checkRuns;
    }
    if (payload.check_runs.length < CHECK_RUNS_PER_PAGE) {
      throw new Error("Check-run inventory ended before its declared total");
    }
  }
  throw new Error("Check-run inventory exceeded the pagination limit");
}

export async function githubGetReviewSnapshot(
  repository,
  number,
  token,
  runtime = {},
) {
  const { owner, repo } = parseRepository(repository);
  if (!positivePullNumber(number)) {
    throw new Error("pull request number must be a positive safe integer");
  }
  nonEmpty(token, "automation_token input");
  const payload = await githubRequest(
    "/graphql",
    {
      method: "POST",
      token,
      body: {
        query: REVIEW_RECONCILIATION_QUERY,
        variables: {
          owner,
          repo,
          number,
          limit: REVIEW_CONNECTION_LIMIT,
        },
      },
    },
    runtime,
  );
  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    throw new Error(
      `GitHub GraphQL query failed: ${payload.errors
        .map((error) => error?.message ?? "unknown error")
        .join("; ")}`,
    );
  }
  const snapshot = payload?.data?.repository?.pullRequest;
  if (!snapshot) {
    throw new Error("GitHub GraphQL did not return the pull request reviews");
  }
  return snapshot;
}

export async function readReviewReconciliationState(
  { repository, number, headSha, requiredChecks, token },
  runtime = {},
) {
  const listCheckRuns = runtime.listCheckRuns ?? githubListCheckRuns;
  const getReviewSnapshot =
    runtime.getReviewSnapshot ?? githubGetReviewSnapshot;
  const checkRuns = await listCheckRuns(repository, headSha, token, runtime);
  const checks = assessRequiredCheckRuns(requiredChecks, checkRuns, headSha);
  if (checks.status !== "success") {
    return {
      status: checks.status,
      fingerprint: sha256(`checks:${checks.fingerprint}`),
    };
  }
  const reviews = await readReviewFeedbackState(
    { repository, number, headSha, token },
    { ...runtime, getReviewSnapshot },
  );
  return {
    status: reviews.status,
    fingerprint: sha256(
      JSON.stringify({
        checks: checks.fingerprint,
        reviews: reviews.fingerprint,
      }),
    ),
    suppressedCommentCount: reviews.suppressedCommentCount,
    blockingCodexCommentIds: reviews.blockingCodexCommentIds,
    unresolvedBotThreadIds: reviews.unresolvedBotThreadIds,
  };
}

export async function readReviewFeedbackState(
  { repository, number, headSha, token },
  runtime = {},
) {
  const getReviewSnapshot =
    runtime.getReviewSnapshot ?? githubGetReviewSnapshot;
  const reviewSnapshot = await getReviewSnapshot(
    repository,
    number,
    token,
    runtime,
  );
  const reviews = assessReviewSnapshot(reviewSnapshot, headSha);
  return {
    status: reviews.status,
    fingerprint: reviews.fingerprint,
    suppressedCommentCount: reviews.suppressedCommentCount,
    blockingCodexCommentIds: reviews.blockingCodexCommentIds,
    unresolvedBotThreadIds: reviews.unresolvedBotThreadIds,
  };
}

export async function waitForReviewReconciliation(request, runtime = {}) {
  const readState = runtime.readState ?? readReviewReconciliationState;
  const now = runtime.now ?? Date.now;
  const sleep =
    runtime.sleep ??
    ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const pollMilliseconds = runtime.pollMilliseconds ?? REVIEW_POLL_MILLISECONDS;
  const quietMilliseconds =
    runtime.quietMilliseconds ?? REVIEW_QUIET_MILLISECONDS;
  const timeoutMilliseconds =
    runtime.timeoutMilliseconds ?? REVIEW_TIMEOUT_MILLISECONDS;
  for (const [value, label, allowZero] of [
    [pollMilliseconds, "review poll interval", false],
    [quietMilliseconds, "review quiet window", true],
    [timeoutMilliseconds, "review reconciliation timeout", false],
  ]) {
    if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
      throw new Error(`${label} must be a safe integer`);
    }
  }

  const startedAt = now();
  let stableFingerprint = null;
  let stableSince = null;
  let latestState = null;
  for (;;) {
    const observedAt = now();
    if (
      !Number.isSafeInteger(observedAt) ||
      observedAt < startedAt ||
      observedAt - startedAt > timeoutMilliseconds
    ) {
      throw new Error("Review reconciliation timed out");
    }
    const state = await readState(request, runtime);
    if (!isObject(state) || typeof state.status !== "string") {
      throw new Error("Malformed review reconciliation state");
    }
    latestState = state;
    if (state.status === "failure") {
      return state;
    }
    if (state.status === "clear") {
      if (typeof state.fingerprint !== "string" || state.fingerprint === "") {
        throw new Error("Malformed review reconciliation fingerprint");
      }
      if (state.fingerprint !== stableFingerprint) {
        stableFingerprint = state.fingerprint;
        stableSince = observedAt;
      } else if (observedAt - stableSince >= quietMilliseconds) {
        return state;
      }
    } else if (state.status === "pending" || state.status === "blocked") {
      stableFingerprint = null;
      stableSince = null;
    } else {
      throw new Error("Unknown review reconciliation state");
    }

    const remaining = timeoutMilliseconds - (now() - startedAt);
    if (remaining <= 0) {
      if (latestState?.status === "blocked") return latestState;
      throw new Error("Review reconciliation timed out");
    }
    await sleep(Math.min(pollMilliseconds, remaining));
  }
}

export async function githubGetEffectiveRules(repository, token, runtime = {}) {
  parseRepository(repository);
  nonEmpty(token, "automation_token input");
  const rules = [];
  for (let page = 1; page <= MAX_EFFECTIVE_RULE_PAGES; page += 1) {
    const payload = await githubRequest(
      `/repos/${repository}/rules/branches/main?per_page=${EFFECTIVE_RULES_PER_PAGE}&page=${page}`,
      { method: "GET", token },
      runtime,
    );
    if (!Array.isArray(payload)) {
      malformedEffectiveRules(`page ${page} must be an array`);
    }
    if (payload.length > EFFECTIVE_RULES_PER_PAGE) {
      malformedEffectiveRules(`page ${page} exceeds the requested page size`);
    }
    rules.push(...payload);
    if (payload.length < EFFECTIVE_RULES_PER_PAGE) {
      return rules;
    }
  }
  malformedEffectiveRules("pagination exceeded the safety limit");
}

export async function githubGetNativeState(
  repository,
  number,
  token,
  runtime = {},
) {
  const { owner, repo } = parseRepository(repository);
  if (!positivePullNumber(number)) {
    throw new Error("pull request number must be a positive safe integer");
  }
  nonEmpty(token, "automation_token input");
  const payload = await githubRequest(
    "/graphql",
    {
      method: "POST",
      token,
      body: {
        query: NATIVE_STATE_QUERY,
        variables: { owner, repo, number },
      },
    },
    runtime,
  );
  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    throw new Error(
      `GitHub GraphQL query failed: ${payload.errors
        .map((error) => error?.message ?? "unknown error")
        .join("; ")}`,
    );
  }
  const pull = payload?.data?.repository?.pullRequest;
  if (!pull || typeof pull.id !== "string" || pull.id === "") {
    throw new Error("GitHub GraphQL did not return the pull request");
  }
  return {
    id: pull.id,
    autoMergeRequest: pull.autoMergeRequest ?? null,
    mergeQueueEntry: pull.mergeQueueEntry ?? null,
  };
}

async function githubNativeMutation(
  query,
  variables,
  responsePath,
  expectedId,
  token,
  runtime,
) {
  const payload = await githubRequest(
    "/graphql",
    {
      method: "POST",
      token: nonEmpty(token, "automation_token input"),
      body: { query, variables },
    },
    runtime,
  );
  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    throw new Error(
      `GitHub GraphQL mutation failed: ${payload.errors
        .map((error) => error?.message ?? "unknown error")
        .join("; ")}`,
    );
  }
  let result = payload?.data;
  for (const segment of responsePath) result = result?.[segment];
  if (result?.id !== expectedId) {
    throw new Error("GitHub GraphQL did not confirm the native state mutation");
  }
}

export async function githubDisablePullRequestAutoMerge(
  pullRequestId,
  token,
  runtime = {},
) {
  const id = nonEmpty(pullRequestId, "pull request node ID");
  await githubNativeMutation(
    DISABLE_AUTO_MERGE_MUTATION,
    { pullRequestId: id },
    ["disablePullRequestAutoMerge", "pullRequest"],
    id,
    token,
    runtime,
  );
}

export async function githubDequeuePullRequest(
  pullRequestId,
  mergeQueueEntryId,
  token,
  runtime = {},
) {
  const pullId = nonEmpty(pullRequestId, "pull request node ID");
  const entryId = nonEmpty(mergeQueueEntryId, "merge queue entry node ID");
  await githubNativeMutation(
    DEQUEUE_PULL_REQUEST_MUTATION,
    { pullRequestId: pullId },
    ["dequeuePullRequest", "mergeQueueEntry"],
    entryId,
    token,
    runtime,
  );
}

async function removeNativeMergePrivilege(
  { repository, number, token },
  { getNativeState, disableAutoMerge, dequeuePull },
  runtime = {},
  { retryWhenAbsent = false } = {},
) {
  const sleep =
    runtime.sleep ??
    ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let nativeState = null;
  const attempts = retryWhenAbsent ? NATIVE_PRIVILEGE_RETRY_ATTEMPTS : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    nativeState = await getNativeState(repository, number, token);
    if (nativeState.mergeQueueEntry || nativeState.autoMergeRequest) break;
    if (attempt + 1 < attempts) {
      await sleep(NATIVE_PRIVILEGE_RETRY_MILLISECONDS);
    }
  }
  if (!nativeState?.mergeQueueEntry && !nativeState?.autoMergeRequest) {
    return false;
  }
  if (nativeState.mergeQueueEntry) {
    await dequeuePull(nativeState.id, nativeState.mergeQueueEntry.id, token);
  }
  if (nativeState.autoMergeRequest) {
    await disableAutoMerge(nativeState.id, token);
  }
  const finalNativeState = await getNativeState(repository, number, token);
  if (finalNativeState.mergeQueueEntry || finalNativeState.autoMergeRequest) {
    throw new Error("Native merge privilege remained after late feedback");
  }
  return true;
}

export async function runGhAutoMerge(
  repository,
  number,
  headSha,
  token,
  runtime = {},
) {
  parseRepository(repository);
  if (!positivePullNumber(number)) {
    throw new Error("pull request number must be a positive safe integer");
  }
  if (!SHA_PATTERN.test(headSha ?? "")) {
    throw new Error("head SHA must be a full hexadecimal SHA-1");
  }
  const automationToken = nonEmpty(token, "automation_token input");
  const execFile = runtime.execFile ?? execFileAsync;
  const sourceEnvironment = runtime.processEnv ?? process.env;
  const {
    GITHUB_TOKEN: _githubToken,
    GH_TOKEN: _ghToken,
    INPUT_AUTOMATION_TOKEN: _automationInput,
    ...safeEnvironment
  } = sourceEnvironment;
  await execFile(
    "gh",
    [
      "pr",
      "merge",
      String(number),
      "--repo",
      repository,
      "--auto",
      "--squash",
      "--match-head-commit",
      headSha,
    ],
    {
      encoding: "utf8",
      env: {
        ...safeEnvironment,
        GH_HOST: "github.com",
        GH_TOKEN: automationToken,
        GH_PROMPT_DISABLED: "1",
      },
      shell: false,
      timeout: GH_TIMEOUT_MILLISECONDS,
      windowsHide: true,
    },
  );
}

export async function runNativeAutoMerge(env = process.env, runtime = {}) {
  const { repository } = parseRepository(env.GITHUB_REPOSITORY);
  const eventName = nonEmpty(env.GITHUB_EVENT_NAME, "GITHUB_EVENT_NAME");
  const token = nonEmpty(env.INPUT_AUTOMATION_TOKEN, "automation_token input");
  const event = workflowRunEventFromInputs(env);
  const candidates = extractCandidates(eventName, event, repository);
  if (candidates.length === 0) {
    log("No completed CodeQL pull-request run with an exact head was found.");
    return { action: "none" };
  }

  const getPull = runtime.getPull ?? githubGetPull;
  const listOpenPulls = runtime.listOpenPulls ?? githubListOpenPulls;
  const loadPolicyChecks = runtime.loadRequiredChecks ?? loadRequiredChecks;
  const getEffectiveRules =
    runtime.getEffectiveRules ?? githubGetEffectiveRules;
  const getNativeState = runtime.getNativeState ?? githubGetNativeState;
  const waitForFeedback =
    runtime.waitForReviewReconciliation ?? waitForReviewReconciliation;
  const readFeedback =
    runtime.readReviewReconciliationState ?? readReviewReconciliationState;
  const readFeedbackOnly =
    runtime.readReviewFeedbackState ?? readReviewFeedbackState;
  const enableAutoMerge = runtime.enableAutoMerge ?? runGhAutoMerge;
  const disableAutoMerge =
    runtime.disableAutoMerge ?? githubDisablePullRequestAutoMerge;
  const dequeuePull = runtime.dequeuePull ?? githubDequeuePullRequest;
  const candidate = candidates[0];
  const openPulls = await listOpenPulls(repository, token);
  if (!Array.isArray(openPulls)) {
    throw new Error("Malformed open pull request inventory payload");
  }
  const currentPull = openPulls.find((pull) =>
    isEligiblePull(pull, candidateForOpenPull(candidate, pull), repository),
  );
  if (!currentPull) {
    log(
      `PR #${candidate.number}: current identity, state, base or exact head is ineligible.`,
    );
    return { action: "skipped", reason: "ineligible" };
  }
  const canonicalCandidate = {
    number: currentPull.number,
    headSha: currentPull.head.sha,
    source: "github",
  };

  if (candidate.source === "feedback-workflow-run") {
    let feedback;
    try {
      feedback = await readFeedbackOnly(
        {
          repository,
          number: canonicalCandidate.number,
          headSha: canonicalCandidate.headSha,
          token,
        },
        runtime,
      );
    } catch (error) {
      feedback = {
        status: "blocked",
        fingerprint: sha256(`feedback-read-failed:${error.message}`),
      };
    }
    if (feedback?.status === "clear") {
      log(
        `PR #${canonicalCandidate.number}: feedback signal contains no blocking review state.`,
      );
      return { action: "none", reason: "feedback-clear" };
    }
    if (feedback?.status !== "blocked") {
      throw new Error("Malformed late-feedback reconciliation state");
    }

    const changed = await removeNativeMergePrivilege(
      {
        repository,
        number: canonicalCandidate.number,
        token,
      },
      { getNativeState, disableAutoMerge, dequeuePull },
      runtime,
      { retryWhenAbsent: true },
    );
    if (!changed) {
      log(
        `PR #${canonicalCandidate.number}: blocking feedback found with no native merge privilege to remove.`,
      );
      return { action: "none", reason: "feedback-blocking-no-privilege" };
    }

    log(
      `PR #${canonicalCandidate.number}: blocking late feedback removed native merge privilege.`,
    );
    return { action: "deprivileged", pull: canonicalCandidate.number };
  }

  const requiredChecks = await loadPolicyChecks(repository);
  if (requiredChecks === null) {
    log(
      `PR #${canonicalCandidate.number}: repository is absent from pinned policy.`,
    );
    return {
      action: "skipped",
      reason: "repository-not-in-policy",
    };
  }

  const effectiveRules = await getEffectiveRules(repository, token);
  if (!hasRequiredNativeEnforcement(effectiveRules, requiredChecks)) {
    log(
      `PR #${canonicalCandidate.number}: required native enforcement is not fully active on main.`,
    );
    return {
      action: "skipped",
      reason: "native-enforcement-inactive",
    };
  }

  const reconciliationRequest = {
    repository,
    number: canonicalCandidate.number,
    headSha: canonicalCandidate.headSha,
    requiredChecks,
    token,
  };
  const feedback = await waitForFeedback(reconciliationRequest, runtime);
  if (feedback?.status !== "clear") {
    const reason =
      feedback?.status === "blocked"
        ? "review-feedback-blocking"
        : "required-checks-unsuccessful";
    log(
      `PR #${canonicalCandidate.number}: review reconciliation blocked native auto-merge (${reason}).`,
    );
    return { action: "skipped", reason };
  }
  if (typeof feedback.fingerprint !== "string" || feedback.fingerprint === "") {
    throw new Error("Malformed review reconciliation result");
  }

  const state = await getNativeState(
    repository,
    canonicalCandidate.number,
    token,
  );
  if (state.mergeQueueEntry) {
    log(`PR #${canonicalCandidate.number}: already in the native merge queue.`);
    return { action: "already-queued", pull: canonicalCandidate.number };
  }
  if (state.autoMergeRequest) {
    log(
      `PR #${canonicalCandidate.number}: native auto-merge is already enabled.`,
    );
    return { action: "already-enabled", pull: canonicalCandidate.number };
  }

  const finalEffectiveRules = await getEffectiveRules(repository, token);
  if (!hasRequiredNativeEnforcement(finalEffectiveRules, requiredChecks)) {
    log(
      `PR #${canonicalCandidate.number}: required native enforcement changed before the mutation.`,
    );
    return {
      action: "skipped",
      reason: "native-enforcement-inactive",
    };
  }

  const finalPull = await getPull(repository, canonicalCandidate.number, token);
  if (!isEligiblePull(finalPull, canonicalCandidate, repository)) {
    log(
      `PR #${canonicalCandidate.number}: pull request identity, state, base or exact head changed before the mutation.`,
    );
    return { action: "skipped", reason: "ineligible" };
  }

  const finalFeedback = await readFeedback(reconciliationRequest, runtime);
  if (
    finalFeedback?.status !== "clear" ||
    finalFeedback.fingerprint !== feedback.fingerprint
  ) {
    log(
      `PR #${canonicalCandidate.number}: checks or review feedback changed before the mutation.`,
    );
    return { action: "skipped", reason: "review-state-changed" };
  }

  await enableAutoMerge(
    repository,
    canonicalCandidate.number,
    canonicalCandidate.headSha,
    token,
  );

  let postArmFeedback;
  try {
    postArmFeedback = await readFeedback(reconciliationRequest, runtime);
  } catch (error) {
    postArmFeedback = {
      status: "blocked",
      fingerprint: sha256(`post-arm-feedback-read-failed:${error.message}`),
    };
  }
  if (
    postArmFeedback?.status !== "clear" ||
    postArmFeedback.fingerprint !== feedback.fingerprint
  ) {
    const removed = await removeNativeMergePrivilege(
      {
        repository,
        number: canonicalCandidate.number,
        token,
      },
      { getNativeState, disableAutoMerge, dequeuePull },
      runtime,
      { retryWhenAbsent: true },
    );
    if (!removed) {
      throw new Error(
        "Checks or review feedback changed after arm, but no native privilege could be removed",
      );
    }
    log(
      `PR #${canonicalCandidate.number}: post-arm review drift removed native merge privilege.`,
    );
    return {
      action: "deprivileged",
      pull: canonicalCandidate.number,
      reason: "review-state-changed-after-arm",
    };
  }
  log(
    `PR #${canonicalCandidate.number}: native auto-merge enabled for exact head ${canonicalCandidate.headSha}.`,
  );
  return {
    action: "enabled",
    pull: canonicalCandidate.number,
    head: canonicalCandidate.headSha,
  };
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  runNativeAutoMerge().catch((error) => {
    process.stderr.write(`native auto-merge failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
