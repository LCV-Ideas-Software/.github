#!/usr/bin/env node

import { execFile as nodeExecFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile as nodeReadFile } from "node:fs/promises";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const API_ROOT = "https://api.github.com";
const API_VERSION = "2026-03-10";
const API_TIMEOUT_MILLISECONDS = 15_000;
const READ_RETRY_ATTEMPTS = 3;
const READ_RETRY_BACKOFF_MILLISECONDS = [250, 1_000];
const MAX_READ_RETRY_DELAY_MILLISECONDS = 120_000;
const MAX_READ_RETRY_TOTAL_DELAY_MILLISECONDS = 180_000;
const GH_TIMEOUT_MILLISECONDS = 60_000;
const GITHUB_ACTIONS_APP_ID = 15368;
const OPEN_PULLS_PER_PAGE = 100;
const MAX_OPEN_PULL_PAGES = 100;
const EFFECTIVE_RULES_PER_PAGE = 100;
const MAX_EFFECTIVE_RULE_PAGES = 100;
const CHECK_RUNS_PER_PAGE = 100;
const MAX_CHECK_RUN_PAGES = 100;
const WORKFLOW_RUNS_PER_PAGE = 100;
const MAX_DYNAMIC_WORKFLOW_RUN_PAGES = 10;
const PULLS_FOR_COMMIT_PER_PAGE = 100;
const REVIEW_CONNECTION_LIMIT = 100;
const MAX_REVIEW_CONNECTION_PAGES = 100;
const MAX_REVIEW_THREAD_COMMENT_PAGES = 100;
const MAX_REVIEW_THREAD_CONTINUATIONS = 100;
const MAX_REVIEW_SNAPSHOT_NODES = 100_000;
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
const COPILOT_REVIEW_WORKFLOW_NAME = "Running Copilot Code Review";
const COPILOT_REVIEW_WORKFLOW_PATH =
  "dynamic/agents/copilot-pull-request-reviewer";
const CODEX_CLEAN_REVIEW_HEADLINES = new Set([
  "Codex Review: Didn't find any major issues. :+1:",
  "Codex Review: Didn't find any major issues. :rocket:",
  "Codex Review: Didn't find any major issues. :tada:",
  "Codex Review: Didn't find any major issues. Already looking forward to the next diff.",
  "Codex Review: Didn't find any major issues. Another round soon, please!",
  "Codex Review: Didn't find any major issues. Bravo.",
  "Codex Review: Didn't find any major issues. Breezy!",
  "Codex Review: Didn't find any major issues. Can't wait for the next one!",
  "Codex Review: Didn't find any major issues. Chef's kiss.",
  "Codex Review: Didn't find any major issues. Delightful!",
  "Codex Review: Didn't find any major issues. Hooray!",
  "Codex Review: Didn't find any major issues. Keep it up!",
  "Codex Review: Didn't find any major issues. Keep them coming!",
  "Codex Review: Didn't find any major issues. More of your lovely PRs please.",
  "Codex Review: Didn't find any major issues. Nice work!",
  "Codex Review: Didn't find any major issues. Swish!",
  "Codex Review: Didn't find any major issues. What shall we delve into next?",
  "Codex Review: Didn't find any major issues. You're on a roll.",
]);
const CODEX_PULL_REQUEST_REVIEW_TEMPLATE = [
  "### 💡 Codex Review",
  "",
  "Here are some automated review suggestions for this pull request.",
  "",
  "**Reviewed commit:** `<reviewed-commit>`",
  "",
  "<details> <summary>ℹ️ About Codex in GitHub</summary>",
  "<br/>",
  "",
  "[Your team has set up Codex to review pull requests in this repo](https://chatgpt.com/codex/cloud/settings/general). Reviews are triggered when you",
  "- Open a pull request for review",
  "- Mark a draft as ready",
  '- Comment "@codex review".',
  "",
  "If Codex has suggestions, it will comment; otherwise it will react with 👍.",
  "",
  'Codex can also answer questions or update the PR. Try commenting "@codex address that feedback".',
  "",
  "</details>",
].join("\n");
const CODEQL_WORKFLOW_NAME = "CodeQL";
const CODEQL_WORKFLOW_PATH = ".github/workflows/codeql.yml";
const NATIVE_AUTO_MERGE_WORKFLOW_PATH =
  ".github/workflows/native-auto-merge.yml";
const REQUIRED_SIMPLE_RULES = [
  "deletion",
  "non_fast_forward",
  "required_signatures",
  "required_linear_history",
];
const execFileAsync = promisify(nodeExecFile);

export class ReviewSnapshotChangedError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReviewSnapshotChangedError";
  }
}

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
    $commentsAfter: String
    $reviewsAfter: String
    $threadsAfter: String
    $includeComments: Boolean!
    $includeReviews: Boolean!
    $includeThreads: Boolean!
  ) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        id
        headRefOid
        updatedAt
        comments(first: $limit, after: $commentsAfter) @include(if: $includeComments) {
          totalCount
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
            endCursor
          }
        }
        reviews(first: $limit, after: $reviewsAfter) @include(if: $includeReviews) {
          totalCount
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
            endCursor
          }
        }
        reviewThreads(first: $limit, after: $threadsAfter) @include(if: $includeThreads) {
          totalCount
          nodes {
            id
            isResolved
            isOutdated
            isCollapsed
            comments(first: $limit) {
              totalCount
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
                pullRequestReview {
                  id
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
                endCursor
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

const REVIEW_THREAD_COMMENTS_QUERY = `
  query NativeAutoMergeReviewThreadComments(
    $threadId: ID!
    $limit: Int!
    $after: String
  ) {
    node(id: $threadId) {
      __typename
      ... on PullRequestReviewThread {
        id
        isResolved
        isOutdated
        isCollapsed
        pullRequest {
          id
          headRefOid
          updatedAt
        }
        comments(first: $limit, after: $after) {
          totalCount
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
            pullRequestReview {
              id
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

function graphQlPayloadHasNoErrors(payload, label) {
  if (!isObject(payload)) {
    throw new Error(`Malformed ${label} GraphQL payload`);
  }
  if (Object.hasOwn(payload, "errors")) {
    if (!Array.isArray(payload.errors)) {
      throw new Error(`Malformed ${label} GraphQL errors`);
    }
    if (payload.errors.length > 0) {
      throw new Error(
        `GitHub GraphQL query failed: ${payload.errors
          .map((error) => error?.message ?? "unknown error")
          .join("; ")}`,
      );
    }
  }
}

function newReviewConnectionState(label) {
  return {
    label,
    nodes: [],
    nodeIds: new Set(),
    cursors: new Set(),
    cursor: null,
    totalCount: null,
    pages: 0,
    done: false,
    endCursor: null,
  };
}

function addReviewSnapshotNodes(budget, nodes) {
  budget.nodes += nodes.length;
  if (budget.nodes > MAX_REVIEW_SNAPSHOT_NODES) {
    throw new Error("Review reconciliation exceeded the node safety limit");
  }
}

function appendReviewConnectionPage(state, connection, budget) {
  if (
    !isObject(connection) ||
    !Array.isArray(connection.nodes) ||
    connection.nodes.length > REVIEW_CONNECTION_LIMIT ||
    !Number.isSafeInteger(connection.totalCount) ||
    connection.totalCount < 0 ||
    connection.totalCount > MAX_REVIEW_SNAPSHOT_NODES ||
    !isObject(connection.pageInfo) ||
    typeof connection.pageInfo.hasNextPage !== "boolean" ||
    !(
      connection.pageInfo.endCursor === null ||
      (typeof connection.pageInfo.endCursor === "string" &&
        connection.pageInfo.endCursor !== "")
    )
  ) {
    throw new Error(`Malformed ${state.label} connection page`);
  }
  if (state.done) {
    throw new Error(`${state.label} connection continued after completion`);
  }
  if (state.pages >= MAX_REVIEW_CONNECTION_PAGES) {
    throw new Error(`${state.label} pagination exceeded the safety limit`);
  }
  if (state.totalCount === null) {
    state.totalCount = connection.totalCount;
  } else if (state.totalCount !== connection.totalCount) {
    throw new ReviewSnapshotChangedError(
      `${state.label} total count changed during pagination`,
    );
  }

  for (const node of connection.nodes) {
    if (!isObject(node) || typeof node.id !== "string" || node.id === "") {
      throw new Error(`Malformed ${state.label} node`);
    }
    if (state.nodeIds.has(node.id)) {
      throw new Error(`Duplicate ${state.label} node ${node.id}`);
    }
    state.nodeIds.add(node.id);
  }
  addReviewSnapshotNodes(budget, connection.nodes);
  state.nodes.push(...connection.nodes);
  state.pages += 1;
  state.endCursor = connection.pageInfo.endCursor;

  if (state.nodes.length > state.totalCount) {
    throw new Error(`${state.label} exceeded its declared total count`);
  }
  if (connection.pageInfo.hasNextPage) {
    const cursor = connection.pageInfo.endCursor;
    if (typeof cursor !== "string" || cursor === "") {
      throw new Error(`${state.label} next page cursor is missing`);
    }
    if (state.cursors.has(cursor)) {
      throw new Error(`${state.label} next page cursor repeated`);
    }
    if (state.nodes.length >= state.totalCount) {
      throw new Error(`${state.label} has a next page beyond its total count`);
    }
    state.cursors.add(cursor);
    state.cursor = cursor;
    return;
  }

  if (state.nodes.length !== state.totalCount) {
    throw new Error(`${state.label} ended before its declared total count`);
  }
  if (typeof connection.pageInfo.endCursor === "string") {
    state.cursor = connection.pageInfo.endCursor;
  }
  state.done = true;
}

function completedReviewConnection(state) {
  if (!state.done || state.nodes.length !== state.totalCount) {
    throw new Error(`Incomplete ${state.label} connection`);
  }
  return {
    totalCount: state.totalCount,
    nodes: state.nodes,
    pageInfo: { hasNextPage: false, endCursor: state.endCursor },
  };
}

function reviewSnapshotIdentity(pullRequest, expected = null) {
  if (
    !isObject(pullRequest) ||
    typeof pullRequest.id !== "string" ||
    pullRequest.id === "" ||
    !SHA_PATTERN.test(pullRequest.headRefOid ?? "")
  ) {
    throw new Error("Malformed review reconciliation pull request identity");
  }
  const identity = {
    id: pullRequest.id,
    headRefOid: pullRequest.headRefOid,
    updatedAt: validTimestamp(
      pullRequest.updatedAt,
      "review reconciliation pull request updatedAt",
    ),
  };
  if (
    expected &&
    (identity.id !== expected.id ||
      identity.headRefOid !== expected.headRefOid ||
      identity.updatedAt !== expected.updatedAt)
  ) {
    throw new ReviewSnapshotChangedError(
      "Review reconciliation pull request changed during pagination",
    );
  }
  return identity;
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
  const knownClean = body.match(
    /^([^\r\n]+)\r?\n\r?\n\*\*Reviewed commit:\*\* `([0-9a-f]{7,40})`(?:\r?\n\r?\n<details>[\s\S]*<\/details>)?\s*$/,
  );
  if (knownClean && CODEX_CLEAN_REVIEW_HEADLINES.has(knownClean[1])) {
    return { clean: true, reviewedCommit: knownClean[2].toLowerCase() };
  }
  const reviewedCommit = body.match(
    /\*\*Reviewed commit:\*\* `([0-9a-f]{7,40})`/i,
  );
  if (!reviewedCommit) {
    throw new Error("Codex review comment is malformed");
  }
  return { clean: false, reviewedCommit: reviewedCommit[1].toLowerCase() };
}

function parseCodexPullRequestReviewBody(body) {
  if (typeof body !== "string") {
    throw new Error("Codex pull request review body is malformed");
  }
  const normalized = body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim()
    .replace(/\n{3,}/g, "\n\n");
  if (normalized === "") {
    return { known: true, reviewedCommit: null };
  }
  const matches = [
    ...normalized.matchAll(/\*\*Reviewed commit:\*\* `([0-9a-f]{7,40})`/gi),
  ];
  if (matches.length !== 1) {
    return { known: false, reviewedCommit: null };
  }
  const reviewedCommit = matches[0][1].toLowerCase();
  const canonical = normalized.replace(
    matches[0][0],
    "**Reviewed commit:** `<reviewed-commit>`",
  );
  return {
    known: canonical === CODEX_PULL_REQUEST_REVIEW_TEMPLATE,
    reviewedCommit,
  };
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
        reviewId: nonEmpty(
          comment.pullRequestReview?.id,
          "pull request review comment review ID",
        ),
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
  const pendingBotReviewStateIds = botReviews
    .filter(
      (candidate) =>
        candidate.commit === headSha && candidate.state === "PENDING",
    )
    .map((candidate) => candidate.id)
    .sort();
  const blockingBotReviewStateIds = botReviews
    .filter(
      (candidate) =>
        candidate.commit === headSha &&
        candidate.state !== "COMMENTED" &&
        candidate.state !== "PENDING",
    )
    .map((candidate) => candidate.id)
    .sort();
  let suppressedCommentCount = 0;
  for (const copilotReview of exactHeadCopilotReviews) {
    if (copilotReview.state !== "COMMENTED") continue;
    const parsed = parseCopilotReviewBody(copilotReview.body);
    suppressedCommentCount += parsed.suppressedCommentCount;
    if (!Number.isSafeInteger(suppressedCommentCount)) {
      throw new Error("Copilot Suppressed comments count is malformed");
    }
  }
  const latestExactHeadCopilotReviewAt =
    exactHeadCopilotReviews
      .filter(
        (review) => review.state === "COMMENTED" && review.submittedAt !== null,
      )
      .map((review) => review.submittedAt)
      .sort((left, right) => Date.parse(left) - Date.parse(right))
      .at(-1) ?? null;

  const codexReviewCommentIds = new Set(
    botThreads.flatMap((thread) =>
      thread.comments
        .filter(
          (comment) =>
            comment.author?.databaseId === CODEX_REVIEW_BOT_DATABASE_ID,
        )
        .map((comment) => comment.reviewId),
    ),
  );
  const blockingCodexReviewIds = [];
  for (const codexReview of botReviews.filter(
    (candidate) =>
      candidate.author.databaseId === CODEX_REVIEW_BOT_DATABASE_ID &&
      candidate.commit === headSha &&
      candidate.state === "COMMENTED",
  )) {
    const parsed = parseCodexPullRequestReviewBody(codexReview.body);
    if (
      !parsed.known ||
      (parsed.reviewedCommit !== null &&
        !codexReview.commit.toLowerCase().startsWith(parsed.reviewedCommit)) ||
      !codexReviewCommentIds.has(codexReview.id)
    ) {
      blockingCodexReviewIds.push(codexReview.id);
    }
  }
  blockingCodexReviewIds.sort();

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
      blockingCodexCommentIds.length > 0 ||
      blockingCodexReviewIds.length > 0 ||
      blockingBotReviewStateIds.length > 0
        ? "blocked"
        : pendingBotReviewStateIds.length > 0
          ? "pending"
          : "clear",
    suppressedCommentCount,
    blockingCodexCommentIds,
    blockingCodexReviewIds,
    blockingBotReviewStateIds,
    pendingBotReviewStateIds,
    unresolvedBotThreadIds,
    latestExactHeadCopilotReviewAt,
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

class GitHubHttpError extends Error {
  constructor(status, detail, headers, payload) {
    super(`GitHub API request failed (${status}): ${detail}`);
    this.name = "GitHubHttpError";
    this.status = status;
    this.headers = headers;
    this.payload = payload;
  }
}

function graphQlRateLimitDetail(payload) {
  if (
    !isObject(payload) ||
    !Array.isArray(payload.errors) ||
    payload.errors.length === 0 ||
    (Object.hasOwn(payload, "data") && payload.data !== null)
  ) {
    return null;
  }
  const messages = [];
  for (const error of payload.errors) {
    if (!isObject(error) || typeof error.message !== "string") return null;
    const classifications = [
      error.type,
      error.extensions?.type,
      error.extensions?.code,
      error.extensions?.classification,
    ];
    const classified = classifications.some(
      (value) => typeof value === "string" && value === "RATE_LIMITED",
    );
    const described = /(?:secondary\s+)?rate limit(?:ed| exceeded)?/i.test(
      error.message,
    );
    if (!classified && !described) return null;
    messages.push(error.message);
  }
  return messages.join("; ");
}

async function githubRequestOnce(path, options, runtime = {}) {
  const fetchImpl = runtime.fetch ?? globalThis.fetch;
  const timeoutSignal =
    runtime.timeoutSignal ??
    (
      runtime.timeoutSignalFactory ??
      (() => AbortSignal.timeout(API_TIMEOUT_MILLISECONDS))
    )();
  const signal = runtime.signal
    ? AbortSignal.any([runtime.signal, timeoutSignal])
    : timeoutSignal;
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
    signal,
  });
  const text = await response.text();
  if (!response.ok) {
    let payload = null;
    try {
      payload = parseResponsePayload(response, text);
    } catch {
      // Error responses are classified by status even when a proxy returns HTML.
    }
    const detail = payload?.message ?? `HTTP ${response.status}`;
    throw new GitHubHttpError(
      response.status,
      detail,
      response.headers,
      payload,
    );
  }
  const payload = parseResponsePayload(response, text);
  if (options.retryGraphqlRateLimit === true) {
    const rateLimitDetail = graphQlRateLimitDetail(payload);
    if (rateLimitDetail !== null) {
      throw new GitHubHttpError(
        429,
        rateLimitDetail,
        response.headers,
        payload,
      );
    }
  }
  return payload;
}

function retryAfterMilliseconds(error, attempt, now) {
  if (error instanceof GitHubHttpError) {
    const transientStatuses = new Set([408, 500, 502, 503, 504]);
    if (transientStatuses.has(error.status)) {
      return READ_RETRY_BACKOFF_MILLISECONDS[attempt] ?? null;
    }
    const message = String(error.payload?.message ?? "").toLowerCase();
    const rateLimited403 =
      error.status === 403 &&
      (error.headers.get("x-ratelimit-remaining") === "0" ||
        message.includes("secondary rate limit") ||
        message.includes("rate limit exceeded"));
    if (error.status !== 429 && !rateLimited403) return null;

    const retryAfter = error.headers.get("retry-after");
    if (retryAfter !== null) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.ceil(seconds * 1_000);
      }
      const date = Date.parse(retryAfter);
      if (Number.isFinite(date)) return Math.max(0, date - now());
      return null;
    }
    if (error.headers.get("x-ratelimit-remaining") === "0") {
      const resetSeconds = Number(error.headers.get("x-ratelimit-reset"));
      if (Number.isFinite(resetSeconds) && resetSeconds >= 0) {
        return Math.max(0, Math.ceil(resetSeconds * 1_000 - now()));
      }
    }
    return 60_000;
  }
  if (
    error instanceof TypeError ||
    error?.name === "TimeoutError" ||
    error?.name === "AbortError"
  ) {
    return READ_RETRY_BACKOFF_MILLISECONDS[attempt] ?? null;
  }
  return null;
}

function defaultRetrySleep(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    function onAbort() {
      clearTimeout(timeout);
      reject(signal.reason);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function githubReadRequest(path, options, runtime = {}) {
  const now = runtime.now ?? Date.now;
  const retrySleep = runtime.retrySleep ?? defaultRetrySleep;
  let totalDelay = 0;
  for (let attempt = 0; attempt < READ_RETRY_ATTEMPTS; attempt += 1) {
    if (runtime.signal?.aborted) throw runtime.signal.reason;
    try {
      return await githubRequestOnce(path, options, runtime);
    } catch (error) {
      if (runtime.signal?.aborted || attempt + 1 >= READ_RETRY_ATTEMPTS) {
        throw error;
      }
      const delay = retryAfterMilliseconds(error, attempt, now);
      if (
        !Number.isSafeInteger(delay) ||
        delay < 0 ||
        delay > MAX_READ_RETRY_DELAY_MILLISECONDS ||
        totalDelay + delay > MAX_READ_RETRY_TOTAL_DELAY_MILLISECONDS
      ) {
        throw error;
      }
      totalDelay += delay;
      await retrySleep(delay, runtime.signal);
    }
  }
  throw new Error("GitHub read retry loop exhausted unexpectedly");
}

function githubRestGet(path, token, runtime) {
  return githubReadRequest(path, { method: "GET", token }, runtime);
}

function githubGraphqlQuery(body, token, runtime) {
  return githubReadRequest(
    "/graphql",
    { method: "POST", token, body, retryGraphqlRateLimit: true },
    runtime,
  );
}

export function extractCandidates(eventName, event, repository) {
  if (event?.repository?.full_name !== repository) {
    return [];
  }

  if (eventName === "pull_request_target") {
    const pull = event.pull_request;
    if (
      event.action !== "review_requested" ||
      event.requested_reviewer?.id !== COPILOT_REVIEW_BOT_DATABASE_ID ||
      !Number.isSafeInteger(event.trigger_run_id) ||
      event.trigger_run_id <= 0 ||
      !positivePullNumber(pull?.number) ||
      !SHA_PATTERN.test(pull?.head?.sha ?? "") ||
      pull.head.repo?.full_name !== repository ||
      pull.base?.ref !== "main"
    ) {
      return [];
    }
    return [
      {
        number: pull.number,
        headSha: pull.head.sha,
        source: "copilot-review-requested",
        triggerRunId: event.trigger_run_id,
      },
    ];
  }

  if (eventName !== "workflow_run") return [];

  const run = event.workflow_run;
  if (!isObject(run) || run.status !== "completed") {
    return [];
  }

  if (
    run.name !== CODEQL_WORKFLOW_NAME ||
    run.path !== CODEQL_WORKFLOW_PATH ||
    run.event !== "pull_request"
  ) {
    return [];
  }
  if (
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
  const actorId = Number(env.INPUT_WORKFLOW_ACTOR_ID);
  if (!Number.isSafeInteger(actorId) || actorId <= 0) {
    throw new Error("workflow_actor_id input must be a positive safe integer");
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
      actor: { id: actorId },
      pull_requests: pullRequests,
    },
  };
}

export function pullRequestTargetEventFromInputs(env) {
  const number = Number(env.INPUT_PULL_NUMBER);
  const requestedReviewerId = Number(env.INPUT_REQUESTED_REVIEWER_ID);
  const triggerRunId = Number(env.INPUT_TRIGGER_RUN_ID);
  if (!positivePullNumber(number)) {
    throw new Error("pull_number input must be a positive safe integer");
  }
  if (!Number.isSafeInteger(requestedReviewerId) || requestedReviewerId <= 0) {
    throw new Error(
      "requested_reviewer_id input must be a positive safe integer",
    );
  }
  if (!Number.isSafeInteger(triggerRunId) || triggerRunId <= 0) {
    throw new Error("trigger_run_id input must be a positive safe integer");
  }
  return {
    repository: {
      full_name: nonEmpty(env.INPUT_EVENT_REPOSITORY, "event_repository input"),
    },
    action: nonEmpty(env.INPUT_EVENT_ACTION, "event_action input"),
    trigger_run_id: triggerRunId,
    requested_reviewer: { id: requestedReviewerId },
    pull_request: {
      number,
      head: {
        sha: nonEmpty(env.INPUT_PULL_HEAD_SHA, "pull_head_sha input"),
        repo: {
          full_name: nonEmpty(
            env.INPUT_PULL_HEAD_REPOSITORY,
            "pull_head_repository input",
          ),
        },
      },
      base: {
        ref: nonEmpty(env.INPUT_PULL_BASE_REF, "pull_base_ref input"),
      },
    },
  };
}

export function mergeGroupEventFromInputs(env) {
  if (
    typeof env.INPUT_AUTOMATION_TOKEN === "string" &&
    env.INPUT_AUTOMATION_TOKEN.trim() !== ""
  ) {
    throw new Error("automation_token is forbidden in the merge-group gate");
  }
  const repository = nonEmpty(
    env.INPUT_EVENT_REPOSITORY,
    "event_repository input",
  );
  if (repository !== nonEmpty(env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY")) {
    throw new Error("merge-group event repository does not match the runner");
  }
  const action = nonEmpty(env.INPUT_EVENT_ACTION, "event_action input");
  const headSha = nonEmpty(
    env.INPUT_MERGE_GROUP_HEAD_SHA,
    "merge_group_head_sha input",
  );
  const baseRef = nonEmpty(
    env.INPUT_MERGE_GROUP_BASE_REF,
    "merge_group_base_ref input",
  );
  const headRef = nonEmpty(
    env.INPUT_MERGE_GROUP_HEAD_REF,
    "merge_group_head_ref input",
  );
  const runnerSha = nonEmpty(env.GITHUB_SHA, "GITHUB_SHA");
  const runnerRef = nonEmpty(env.GITHUB_REF, "GITHUB_REF");
  if (
    action !== "checks_requested" ||
    !SHA_PATTERN.test(headSha) ||
    baseRef !== "refs/heads/main" ||
    !headRef.startsWith("refs/heads/gh-readonly-queue/main/") ||
    headSha !== runnerSha ||
    headRef !== runnerRef
  ) {
    throw new Error("Malformed merge-group event inputs");
  }
  return { repository, action, headSha, baseRef, headRef };
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
      typeof parameters.require_code_owner_review !== "boolean" ||
      typeof parameters.require_last_push_approval !== "boolean" ||
      !Number.isSafeInteger(parameters.required_approving_review_count) ||
      parameters.required_approving_review_count < 0 ||
      typeof parameters.required_review_thread_resolution !== "boolean" ||
      (parameters.required_reviewers !== undefined &&
        !Array.isArray(parameters.required_reviewers))
    ) {
      malformedEffectiveRules("pull_request parameters are invalid");
    }
  }

  const copilotReviewRules = parameterObjects(rules, "copilot_code_review");
  for (const parameters of copilotReviewRules) {
    if (
      typeof parameters.review_draft_pull_requests !== "boolean" ||
      typeof parameters.review_on_push !== "boolean"
    ) {
      malformedEffectiveRules("copilot_code_review parameters are invalid");
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
  const hasPullRequestRule =
    pullRules.length > 0 &&
    pullRules.every(
      (parameters) =>
        parameters.allowed_merge_methods.length === 1 &&
        parameters.allowed_merge_methods[0] === "squash" &&
        parameters.require_code_owner_review === false &&
        parameters.require_last_push_approval === false &&
        parameters.required_approving_review_count === 0 &&
        parameters.required_review_thread_resolution === true &&
        (parameters.required_reviewers === undefined ||
          parameters.required_reviewers.length === 0),
    );
  const hasCopilotReviewOnPush = copilotReviewRules.some(
    (parameters) => parameters.review_on_push === true,
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
    hasCopilotReviewOnPush &&
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
  return githubRestGet(`/repos/${repository}/pulls/${number}`, token, runtime);
}

function normalizeRequestedReviewers(payload) {
  if (
    !isObject(payload) ||
    !Array.isArray(payload.users) ||
    !Array.isArray(payload.teams)
  ) {
    throw new Error("Malformed requested-reviewer inventory payload");
  }
  const userIds = new Set();
  const users = payload.users.map((user) => {
    if (
      !isObject(user) ||
      !Number.isSafeInteger(user.id) ||
      user.id <= 0 ||
      typeof user.login !== "string" ||
      user.login === "" ||
      !["Bot", "User"].includes(user.type) ||
      userIds.has(user.id)
    ) {
      throw new Error("Malformed requested reviewer");
    }
    userIds.add(user.id);
    return { id: user.id, login: user.login, type: user.type };
  });
  const teamIds = new Set();
  const teams = payload.teams.map((team) => {
    if (
      !isObject(team) ||
      !Number.isSafeInteger(team.id) ||
      team.id <= 0 ||
      typeof team.slug !== "string" ||
      team.slug === "" ||
      teamIds.has(team.id)
    ) {
      throw new Error("Malformed requested reviewer team");
    }
    teamIds.add(team.id);
    return { id: team.id, slug: team.slug };
  });
  users.sort((left, right) => left.id - right.id);
  teams.sort((left, right) => left.id - right.id);
  return { users, teams };
}

export async function githubGetRequestedReviewers(
  repository,
  number,
  token,
  runtime = {},
) {
  parseRepository(repository);
  if (!positivePullNumber(number)) {
    throw new Error("pull request number must be a positive safe integer");
  }
  nonEmpty(token, "github_token input");
  return normalizeRequestedReviewers(
    await githubRestGet(
      `/repos/${repository}/pulls/${number}/requested_reviewers`,
      token,
      runtime,
    ),
  );
}

export async function githubListOpenPulls(repository, token, runtime = {}) {
  parseRepository(repository);
  nonEmpty(token, "automation_token input");
  const pulls = [];
  for (let page = 1; page <= MAX_OPEN_PULL_PAGES; page += 1) {
    const payload = await githubRestGet(
      `/repos/${repository}/pulls?state=open&base=main&per_page=${OPEN_PULLS_PER_PAGE}&page=${page}`,
      token,
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
    const payload = await githubRestGet(
      `/repos/${repository}/commits/${headSha}/check-runs?filter=latest&per_page=${CHECK_RUNS_PER_PAGE}&page=${page}`,
      token,
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

export async function githubListDynamicWorkflowRuns(
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
  const runs = [];
  let expectedTotal = null;
  for (let page = 1; page <= MAX_DYNAMIC_WORKFLOW_RUN_PAGES; page += 1) {
    const payload = await githubRestGet(
      `/repos/${repository}/actions/runs?head_sha=${headSha}&event=dynamic&per_page=${WORKFLOW_RUNS_PER_PAGE}&page=${page}`,
      token,
      runtime,
    );
    if (
      !isObject(payload) ||
      !Number.isSafeInteger(payload.total_count) ||
      payload.total_count < 0 ||
      payload.total_count >
        WORKFLOW_RUNS_PER_PAGE * MAX_DYNAMIC_WORKFLOW_RUN_PAGES ||
      !Array.isArray(payload.workflow_runs) ||
      payload.workflow_runs.length > WORKFLOW_RUNS_PER_PAGE
    ) {
      throw new Error("Malformed dynamic workflow-run inventory payload");
    }
    if (expectedTotal === null) expectedTotal = payload.total_count;
    if (payload.total_count !== expectedTotal) {
      throw new Error(
        "Dynamic workflow-run inventory changed during pagination",
      );
    }
    runs.push(...payload.workflow_runs);
    if (runs.length >= expectedTotal) {
      if (runs.length !== expectedTotal) {
        throw new Error(
          "Dynamic workflow-run inventory exceeded its declared total",
        );
      }
      return runs;
    }
    if (payload.workflow_runs.length < WORKFLOW_RUNS_PER_PAGE) {
      throw new Error(
        "Dynamic workflow-run inventory ended before its declared total",
      );
    }
  }
  throw new Error(
    "Dynamic workflow-run inventory exceeded the pagination limit",
  );
}

export async function githubGetWorkflowRun(
  repository,
  runId,
  token,
  runtime = {},
) {
  parseRepository(repository);
  if (!Number.isSafeInteger(runId) || runId <= 0) {
    throw new Error("workflow run id must be a positive safe integer");
  }
  nonEmpty(token, "automation_token input");
  return githubRestGet(
    `/repos/${repository}/actions/runs/${runId}`,
    token,
    runtime,
  );
}

export async function githubListPullsForCommit(
  repository,
  commitSha,
  token,
  runtime = {},
) {
  parseRepository(repository);
  if (!SHA_PATTERN.test(commitSha ?? "")) {
    throw new Error("merge-group head SHA must be a full hexadecimal SHA-1");
  }
  nonEmpty(token, "github_token input");
  const payload = await githubRestGet(
    `/repos/${repository}/commits/${commitSha}/pulls?per_page=${PULLS_FOR_COMMIT_PER_PAGE}&page=1`,
    token,
    runtime,
  );
  if (!Array.isArray(payload)) {
    throw new Error("Malformed pull requests for commit payload");
  }
  if (payload.length !== 1) {
    throw new Error(
      "Merge-group synthetic commit must map to exactly one pull request",
    );
  }
  return payload;
}

function trustedCopilotReviewRequestTime(run, repository, runId, headSha) {
  if (
    !isObject(run) ||
    run.id !== runId ||
    run.path !== NATIVE_AUTO_MERGE_WORKFLOW_PATH ||
    run.event !== "pull_request_target" ||
    typeof run.head_branch !== "string" ||
    run.head_branch === "" ||
    run.head_sha !== headSha ||
    run.status !== "in_progress" ||
    run.repository?.full_name !== repository
  ) {
    throw new Error("Copilot review-request workflow identity drifted");
  }
  const createdAt = validTimestamp(
    run.created_at,
    "Copilot review-request workflow created_at",
  );
  const updatedAt = validTimestamp(
    run.updated_at,
    "Copilot review-request workflow updated_at",
  );
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new Error(
      "Copilot review-request workflow timestamps are inconsistent",
    );
  }
  return createdAt;
}

export function assessCopilotReviewRuns(
  runs,
  headSha,
  number,
  { required = false, requestedAt = null } = {},
) {
  if (
    !Array.isArray(runs) ||
    !SHA_PATTERN.test(headSha ?? "") ||
    !positivePullNumber(number) ||
    typeof required !== "boolean" ||
    !(requestedAt === null || typeof requestedAt === "string")
  ) {
    throw new Error("Malformed Copilot review-run assessment input");
  }
  const requestedAtMilliseconds =
    requestedAt === null
      ? null
      : Date.parse(validTimestamp(requestedAt, "Copilot review request time"));
  const matching = [];
  const runIds = new Set();
  for (const run of runs) {
    if (
      !isObject(run) ||
      !Number.isSafeInteger(run.id) ||
      run.id <= 0 ||
      typeof run.name !== "string" ||
      typeof run.path !== "string" ||
      typeof run.event !== "string" ||
      !SHA_PATTERN.test(run.head_sha ?? "") ||
      typeof run.status !== "string" ||
      !(run.conclusion === null || typeof run.conclusion === "string") ||
      !isObject(run.actor) ||
      !Number.isSafeInteger(run.actor.id) ||
      !Array.isArray(run.pull_requests)
    ) {
      throw new Error("Malformed dynamic workflow run");
    }
    if (runIds.has(run.id)) {
      throw new Error(`Duplicate dynamic workflow run ${run.id}`);
    }
    runIds.add(run.id);
    const knownIdentity =
      run.name === COPILOT_REVIEW_WORKFLOW_NAME &&
      run.path === COPILOT_REVIEW_WORKFLOW_PATH;
    const knownActor = run.actor.id === COPILOT_REVIEW_BOT_DATABASE_ID;
    if (!knownIdentity && !knownActor) continue;
    if (
      !knownIdentity ||
      !knownActor ||
      run.actor.type !== "Bot" ||
      run.event !== "dynamic" ||
      run.head_sha !== headSha
    ) {
      throw new Error("Copilot review workflow identity drifted");
    }
    const associatedPull = run.pull_requests.some(
      (pull) =>
        pull?.number === number &&
        pull?.head?.sha === headSha &&
        pull?.base?.ref === "main",
    );
    if (!associatedPull) {
      throw new Error("Copilot review workflow lost its exact pull request");
    }
    const createdAt = validTimestamp(
      run.created_at,
      "Copilot review run created_at",
    );
    const updatedAt = validTimestamp(
      run.updated_at,
      "Copilot review run updated_at",
    );
    if (Date.parse(updatedAt) < Date.parse(createdAt)) {
      throw new Error("Copilot review workflow timestamps are inconsistent");
    }
    matching.push({ ...run, created_at: createdAt, updated_at: updatedAt });
  }

  if (matching.length === 0) {
    return {
      status: required ? "pending" : "clear",
      fingerprint: sha256(`copilot-review:none:required=${required}`),
      activeRunCount: 0,
    };
  }
  matching.sort((left, right) => {
    const createdAtDifference =
      Date.parse(left.created_at) - Date.parse(right.created_at);
    return createdAtDifference === 0 ? left.id - right.id : createdAtDifference;
  });
  const canonical = matching.map((run) => ({
    id: run.id,
    status: run.status,
    conclusion: run.conclusion,
    headSha: run.head_sha,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
  }));
  const fingerprint = sha256(JSON.stringify(canonical));
  const eligible =
    requestedAtMilliseconds === null
      ? matching
      : matching.filter(
          (run) => Date.parse(run.created_at) >= requestedAtMilliseconds,
        );
  const active = eligible.filter((run) => run.status !== "completed");
  if (active.length > 0) {
    if (active.some((run) => run.conclusion !== null)) {
      throw new Error("Incomplete Copilot review run has a conclusion");
    }
    return { status: "pending", fingerprint, activeRunCount: active.length };
  }
  if (required && eligible.length === 0) {
    return { status: "pending", fingerprint, activeRunCount: 0 };
  }
  const latestCreatedAt = (eligible.at(-1) ?? matching.at(-1)).created_at;
  const latest = (eligible.length > 0 ? eligible : matching).filter(
    (run) => run.created_at === latestCreatedAt,
  );
  if (latest.every((run) => run.conclusion === "success")) {
    return { status: "clear", fingerprint, activeRunCount: 0 };
  }
  if (
    latest.some(
      (run) => typeof run.conclusion !== "string" || run.conclusion === "",
    )
  ) {
    throw new Error("Completed Copilot review run has no conclusion");
  }
  return { status: "failure", fingerprint, activeRunCount: 0 };
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
  const budget = { nodes: 0, threadContinuations: 0 };
  const states = {
    comments: newReviewConnectionState("issue comment"),
    reviews: newReviewConnectionState("review"),
    reviewThreads: newReviewConnectionState("review thread"),
  };
  const threadCommentStates = new Map();
  let identity = null;

  for (let round = 1; round <= MAX_REVIEW_CONNECTION_PAGES; round += 1) {
    const includeComments = !states.comments.done;
    const includeReviews = !states.reviews.done;
    const includeThreads = !states.reviewThreads.done;
    if (!includeComments && !includeReviews && !includeThreads) break;

    const payload = await githubGraphqlQuery(
      {
        query: REVIEW_RECONCILIATION_QUERY,
        variables: {
          owner,
          repo,
          number,
          limit: REVIEW_CONNECTION_LIMIT,
          commentsAfter: states.comments.cursor,
          reviewsAfter: states.reviews.cursor,
          threadsAfter: states.reviewThreads.cursor,
          includeComments,
          includeReviews,
          includeThreads,
        },
      },
      token,
      runtime,
    );
    graphQlPayloadHasNoErrors(payload, "review reconciliation");
    const pullRequest = payload?.data?.repository?.pullRequest;
    const pageIdentity = reviewSnapshotIdentity(pullRequest, identity);
    identity ??= pageIdentity;

    if (includeComments) {
      appendReviewConnectionPage(states.comments, pullRequest.comments, budget);
    }
    if (includeReviews) {
      appendReviewConnectionPage(states.reviews, pullRequest.reviews, budget);
    }
    if (includeThreads) {
      const previousCount = states.reviewThreads.nodes.length;
      appendReviewConnectionPage(
        states.reviewThreads,
        pullRequest.reviewThreads,
        budget,
      );
      for (const thread of states.reviewThreads.nodes.slice(previousCount)) {
        if (
          typeof thread.isResolved !== "boolean" ||
          typeof thread.isOutdated !== "boolean" ||
          typeof thread.isCollapsed !== "boolean"
        ) {
          throw new Error("Malformed review thread state");
        }
        const commentState = newReviewConnectionState(
          `review thread ${thread.id} comment`,
        );
        appendReviewConnectionPage(commentState, thread.comments, budget);
        threadCommentStates.set(thread.id, {
          thread,
          state: commentState,
          rootState: {
            isResolved: thread.isResolved,
            isOutdated: thread.isOutdated,
            isCollapsed: thread.isCollapsed,
          },
        });
      }
    }
  }

  if (
    !states.comments.done ||
    !states.reviews.done ||
    !states.reviewThreads.done
  ) {
    throw new Error(
      "Review reconciliation pagination exceeded the safety limit",
    );
  }

  for (const { thread, state, rootState } of threadCommentStates.values()) {
    while (!state.done) {
      if (state.pages >= MAX_REVIEW_THREAD_COMMENT_PAGES) {
        throw new Error(
          `Review thread ${thread.id} comment pagination exceeded the safety limit`,
        );
      }
      budget.threadContinuations += 1;
      if (budget.threadContinuations > MAX_REVIEW_THREAD_CONTINUATIONS) {
        throw new Error(
          "Review thread comment pagination exceeded the global continuation limit",
        );
      }
      const payload = await githubGraphqlQuery(
        {
          query: REVIEW_THREAD_COMMENTS_QUERY,
          variables: {
            threadId: thread.id,
            limit: REVIEW_CONNECTION_LIMIT,
            after: state.cursor,
          },
        },
        token,
        runtime,
      );
      graphQlPayloadHasNoErrors(payload, "review thread comments");
      const node = payload?.data?.node;
      if (
        !isObject(node) ||
        node.__typename !== "PullRequestReviewThread" ||
        node.id !== thread.id ||
        node.isResolved !== rootState.isResolved ||
        node.isOutdated !== rootState.isOutdated ||
        node.isCollapsed !== rootState.isCollapsed
      ) {
        throw new ReviewSnapshotChangedError(
          "Review thread changed during comment pagination",
        );
      }
      reviewSnapshotIdentity(node.pullRequest, identity);
      appendReviewConnectionPage(state, node.comments, budget);
    }
    thread.comments = completedReviewConnection(state);
  }

  return {
    ...identity,
    comments: completedReviewConnection(states.comments),
    reviews: completedReviewConnection(states.reviews),
    reviewThreads: completedReviewConnection(states.reviewThreads),
  };
}

export async function readReviewReconciliationState(
  {
    repository,
    number,
    headSha,
    requiredChecks,
    token,
    requireCopilotReviewRun = false,
    copilotReviewRequestedAt = null,
  },
  runtime = {},
) {
  const listCheckRuns = runtime.listCheckRuns ?? githubListCheckRuns;
  const listCopilotReviewRuns =
    runtime.listCopilotReviewRuns ?? githubListDynamicWorkflowRuns;
  const getRequestedReviewers =
    runtime.getRequestedReviewers ?? githubGetRequestedReviewers;
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
  const requestedReviewers = normalizeRequestedReviewers(
    await getRequestedReviewers(repository, number, token, runtime),
  );
  if (
    requestedReviewers.users.some(
      (user) => user.id === COPILOT_REVIEW_BOT_DATABASE_ID,
    )
  ) {
    return {
      status: "pending",
      fingerprint: sha256(
        JSON.stringify({
          checks: checks.fingerprint,
          requestedReviewers,
        }),
      ),
    };
  }
  const copilotRuns = await listCopilotReviewRuns(
    repository,
    headSha,
    token,
    runtime,
  );
  const copilot = assessCopilotReviewRuns(copilotRuns, headSha, number, {
    required: requireCopilotReviewRun,
    requestedAt: copilotReviewRequestedAt,
  });
  const freshReviewMustCompleteRequest =
    requireCopilotReviewRun && copilotReviewRequestedAt !== null;
  if (copilot.status !== "clear" && !freshReviewMustCompleteRequest) {
    return {
      status: copilot.status,
      fingerprint: sha256(`copilot:${copilot.fingerprint}`),
    };
  }
  if (copilot.activeRunCount > 0) {
    return {
      status: "pending",
      fingerprint: sha256(`copilot:${copilot.fingerprint}`),
    };
  }
  const reviews = await readReviewFeedbackState(
    { repository, number, headSha, token },
    { ...runtime, getReviewSnapshot },
  );
  if (reviews.status === "blocked") {
    return {
      ...reviews,
      fingerprint: sha256(
        JSON.stringify({
          checks: checks.fingerprint,
          requestedReviewers,
          copilot: copilot.fingerprint,
          reviews: reviews.fingerprint,
        }),
      ),
    };
  }
  const hasFreshExactHeadCopilotReview =
    copilotReviewRequestedAt !== null &&
    reviews.latestExactHeadCopilotReviewAt !== null &&
    Date.parse(reviews.latestExactHeadCopilotReviewAt) >
      Date.parse(copilotReviewRequestedAt);
  if (freshReviewMustCompleteRequest && !hasFreshExactHeadCopilotReview) {
    return {
      status: "pending",
      fingerprint: sha256(
        JSON.stringify({
          copilot: copilot.fingerprint,
          requestedReviewers,
          reviews: reviews.fingerprint,
        }),
      ),
    };
  }
  return {
    status: reviews.status,
    fingerprint: sha256(
      JSON.stringify({
        checks: checks.fingerprint,
        requestedReviewers,
        copilot: copilot.fingerprint,
        reviews: reviews.fingerprint,
      }),
    ),
    suppressedCommentCount: reviews.suppressedCommentCount,
    blockingCodexCommentIds: reviews.blockingCodexCommentIds,
    blockingCodexReviewIds: reviews.blockingCodexReviewIds,
    blockingBotReviewStateIds: reviews.blockingBotReviewStateIds,
    pendingBotReviewStateIds: reviews.pendingBotReviewStateIds,
    unresolvedBotThreadIds: reviews.unresolvedBotThreadIds,
    latestExactHeadCopilotReviewAt: reviews.latestExactHeadCopilotReviewAt,
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
    blockingCodexReviewIds: reviews.blockingCodexReviewIds,
    blockingBotReviewStateIds: reviews.blockingBotReviewStateIds,
    pendingBotReviewStateIds: reviews.pendingBotReviewStateIds,
    unresolvedBotThreadIds: reviews.unresolvedBotThreadIds,
    latestExactHeadCopilotReviewAt: reviews.latestExactHeadCopilotReviewAt,
  };
}

export async function readMergeGroupFeedbackState(
  { repository, number, headSha, token },
  runtime = {},
) {
  const getRequestedReviewers =
    runtime.getRequestedReviewers ?? githubGetRequestedReviewers;
  const listCopilotReviewRuns =
    runtime.listCopilotReviewRuns ?? githubListDynamicWorkflowRuns;
  const requestedReviewers = normalizeRequestedReviewers(
    await getRequestedReviewers(repository, number, token, runtime),
  );
  if (
    requestedReviewers.users.some(
      (user) => user.id === COPILOT_REVIEW_BOT_DATABASE_ID,
    )
  ) {
    return {
      status: "pending",
      fingerprint: sha256(JSON.stringify({ requestedReviewers })),
    };
  }
  const copilotRuns = await listCopilotReviewRuns(
    repository,
    headSha,
    token,
    runtime,
  );
  const copilot = assessCopilotReviewRuns(copilotRuns, headSha, number);
  if (copilot.status !== "clear") {
    return {
      status: copilot.status,
      fingerprint: sha256(`copilot:${copilot.fingerprint}`),
    };
  }
  const reviews = await readReviewFeedbackState(
    { repository, number, headSha, token },
    runtime,
  );
  return {
    ...reviews,
    fingerprint: sha256(
      JSON.stringify({
        requestedReviewers,
        copilot: copilot.fingerprint,
        reviews: reviews.fingerprint,
      }),
    ),
  };
}

export async function waitForReviewReconciliation(request, runtime = {}) {
  const readState = runtime.readState ?? readReviewReconciliationState;
  const beforeRead = runtime.beforeRead ?? (async () => {});
  if (typeof beforeRead !== "function") {
    throw new Error("review reconciliation beforeRead must be a function");
  }
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
    await beforeRead(request, runtime);
    let state;
    try {
      state = await readState(request, runtime);
    } catch (error) {
      if (!(error instanceof ReviewSnapshotChangedError)) throw error;
      stableFingerprint = null;
      stableSince = null;
      latestState = null;
      const remainingAfterDrift = timeoutMilliseconds - (now() - startedAt);
      if (remainingAfterDrift <= 0) {
        throw new Error("Review reconciliation timed out");
      }
      await sleep(Math.min(pollMilliseconds, remainingAfterDrift));
      continue;
    }
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
    const payload = await githubRestGet(
      `/repos/${repository}/rules/branches/main?per_page=${EFFECTIVE_RULES_PER_PAGE}&page=${page}`,
      token,
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
  const payload = await githubGraphqlQuery(
    {
      query: NATIVE_STATE_QUERY,
      variables: { owner, repo, number },
    },
    token,
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
  const payload = await githubRequestOnce(
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

export async function removeNativeMergePrivilege(
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
  const mutationErrors = [];
  for (
    let attempt = 0;
    attempt < NATIVE_PRIVILEGE_RETRY_ATTEMPTS;
    attempt += 1
  ) {
    const pullRequestId = nonEmpty(
      nativeState.id,
      "native pull request node ID",
    );
    if (nativeState.mergeQueueEntry) {
      try {
        await dequeuePull(
          pullRequestId,
          nonEmpty(
            nativeState.mergeQueueEntry.id,
            "native merge queue entry node ID",
          ),
          token,
        );
      } catch (error) {
        mutationErrors.push(error);
      }
    }
    if (nativeState.autoMergeRequest) {
      try {
        await disableAutoMerge(pullRequestId, token);
      } catch (error) {
        mutationErrors.push(error);
      }
    }
    nativeState = await getNativeState(repository, number, token);
    if (!nativeState.mergeQueueEntry && !nativeState.autoMergeRequest) {
      return true;
    }
    if (attempt + 1 < NATIVE_PRIVILEGE_RETRY_ATTEMPTS) {
      await sleep(NATIVE_PRIVILEGE_RETRY_MILLISECONDS);
    }
  }
  throw new AggregateError(
    mutationErrors,
    "Native merge privilege remained after late feedback",
  );
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

function validateMergeGroupPull(pull, repository) {
  if (
    !positivePullNumber(pull?.number) ||
    pull.state !== "open" ||
    pull.draft !== false ||
    !SHA_PATTERN.test(pull.head?.sha ?? "") ||
    typeof pull.head?.ref !== "string" ||
    pull.head.ref === "" ||
    pull.head?.repo?.full_name !== repository ||
    pull.base?.ref !== "main" ||
    pull.base?.repo?.full_name !== repository
  ) {
    throw new Error("Merge-group pull request identity is malformed");
  }
  return {
    number: pull.number,
    headSha: pull.head.sha,
    headRef: pull.head.ref,
  };
}

async function readMergeGroupAssociation(
  { repository, headSha, token },
  runtime = {},
) {
  const listPullsForCommit =
    runtime.listPullsForCommit ?? githubListPullsForCommit;
  const getPull = runtime.getPull ?? githubGetPull;
  const associated = await listPullsForCommit(
    repository,
    headSha,
    token,
    runtime,
  );
  if (!Array.isArray(associated) || associated.length !== 1) {
    throw new Error(
      "Merge-group synthetic commit must map to exactly one pull request",
    );
  }
  const candidate = validateMergeGroupPull(associated[0], repository);
  const current = validateMergeGroupPull(
    await getPull(repository, candidate.number, token, runtime),
    repository,
  );
  if (
    current.number !== candidate.number ||
    current.headSha !== candidate.headSha ||
    current.headRef !== candidate.headRef
  ) {
    throw new Error("Merge-group pull request identity changed after mapping");
  }
  return current;
}

export async function runMergeGroupFeedbackGate(
  env = process.env,
  runtime = {},
) {
  const repository = nonEmpty(env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY");
  parseRepository(repository);
  if (env.GITHUB_EVENT_NAME !== "merge_group") {
    throw new Error("merge-group feedback gate requires a merge_group event");
  }
  const event = mergeGroupEventFromInputs(env);
  if (event.repository !== repository) {
    throw new Error("merge-group event repository does not match the runner");
  }
  const token = nonEmpty(env.INPUT_GITHUB_TOKEN, "github_token input");
  const associationRequest = {
    repository,
    headSha: event.headSha,
    token,
  };
  const initial = await readMergeGroupAssociation(associationRequest, runtime);
  const reconciliationRequest = {
    repository,
    number: initial.number,
    headSha: initial.headSha,
    token,
  };
  const waitForFeedback =
    runtime.waitForReviewReconciliation ?? waitForReviewReconciliation;
  const readFeedback =
    runtime.readMergeGroupFeedbackState ?? readMergeGroupFeedbackState;
  const feedback = await waitForFeedback(reconciliationRequest, {
    ...runtime,
    readState: readFeedback,
  });
  if (
    feedback?.status !== "clear" ||
    typeof feedback.fingerprint !== "string" ||
    feedback.fingerprint === ""
  ) {
    throw new Error("Merge-group bot feedback is blocked or incomplete");
  }
  const final = await readMergeGroupAssociation(associationRequest, runtime);
  if (
    final.number !== initial.number ||
    final.headSha !== initial.headSha ||
    final.headRef !== initial.headRef
  ) {
    throw new Error("Merge-group association changed during reconciliation");
  }
  const finalFeedback = await readFeedback(reconciliationRequest, runtime);
  if (
    finalFeedback?.status !== "clear" ||
    finalFeedback.fingerprint !== feedback.fingerprint
  ) {
    throw new Error("Merge-group bot feedback changed after reconciliation");
  }
  log(
    `PR #${initial.number}: merge-group bot feedback gate passed for exact head ${initial.headSha}.`,
  );
  return {
    action: "merge-group-feedback-clear",
    head: event.headSha,
    pulls: [initial.number],
  };
}

export async function runNativeAutoMerge(env = process.env, runtime = {}) {
  const operation = (env.INPUT_OPERATION ?? "").trim() || "auto-merge";
  if (operation === "merge-group-feedback-gate") {
    return runMergeGroupFeedbackGate(env, runtime);
  }
  if (operation !== "auto-merge") {
    throw new Error("Unsupported native auto-merge operation");
  }
  if (
    typeof env.INPUT_GITHUB_TOKEN === "string" &&
    env.INPUT_GITHUB_TOKEN.trim() !== ""
  ) {
    throw new Error(
      "github_token is forbidden for native auto-merge mutations",
    );
  }
  const { repository } = parseRepository(env.GITHUB_REPOSITORY);
  const eventName = nonEmpty(env.GITHUB_EVENT_NAME, "GITHUB_EVENT_NAME");
  const token = nonEmpty(env.INPUT_AUTOMATION_TOKEN, "automation_token input");
  const event =
    eventName === "pull_request_target"
      ? pullRequestTargetEventFromInputs(env)
      : workflowRunEventFromInputs(env);
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
  const getWorkflowRun = runtime.getWorkflowRun ?? githubGetWorkflowRun;
  const waitForFeedback =
    runtime.waitForReviewReconciliation ?? waitForReviewReconciliation;
  const readFeedback =
    runtime.readReviewReconciliationState ?? readReviewReconciliationState;
  const enableAutoMerge = runtime.enableAutoMerge ?? runGhAutoMerge;
  const disableAutoMerge =
    runtime.disableAutoMerge ?? githubDisablePullRequestAutoMerge;
  const dequeuePull = runtime.dequeuePull ?? githubDequeuePullRequest;
  const candidate = candidates[0];
  const isCopilotReviewRequest =
    candidate.source === "copilot-review-requested";
  const holdCopilotMergePrivilege = async (options = {}) => {
    if (!isCopilotReviewRequest) return false;
    return removeNativeMergePrivilege(
      {
        repository,
        number: candidate.number,
        token,
      },
      { getNativeState, disableAutoMerge, dequeuePull },
      runtime,
      options,
    );
  };
  let retainCopilotMergePrivilege = false;
  let primaryFailure = null;
  try {
    await holdCopilotMergePrivilege();
    const openPulls = await listOpenPulls(repository, token);
    if (!Array.isArray(openPulls)) {
      throw new Error("Malformed open pull request inventory payload");
    }
    const currentPull = openPulls.find((pull) =>
      isEligiblePull(pull, candidate, repository),
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

    let copilotReviewRequestedAt = null;
    if (isCopilotReviewRequest) {
      await holdCopilotMergePrivilege();
      const triggerRun = await getWorkflowRun(
        repository,
        candidate.triggerRunId,
        token,
        runtime,
      );
      copilotReviewRequestedAt = trustedCopilotReviewRequestTime(
        triggerRun,
        repository,
        candidate.triggerRunId,
        canonicalCandidate.headSha,
      );
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
      requireCopilotReviewRun: candidate.source === "copilot-review-requested",
      copilotReviewRequestedAt,
    };
    const reconciliationRuntime = isCopilotReviewRequest
      ? {
          ...runtime,
          beforeRead: async () => holdCopilotMergePrivilege(),
        }
      : runtime;
    let feedback;
    try {
      feedback = await waitForFeedback(
        reconciliationRequest,
        reconciliationRuntime,
      );
    } catch (error) {
      if (isCopilotReviewRequest) {
        await holdCopilotMergePrivilege({ retryWhenAbsent: true });
      }
      throw error;
    }
    if (feedback?.status !== "clear") {
      if (isCopilotReviewRequest) {
        await holdCopilotMergePrivilege({ retryWhenAbsent: true });
      }
      const reason =
        feedback?.status === "blocked"
          ? "review-feedback-blocking"
          : "required-checks-unsuccessful";
      log(
        `PR #${canonicalCandidate.number}: review reconciliation blocked native auto-merge (${reason}).`,
      );
      return { action: "skipped", reason };
    }
    if (
      typeof feedback.fingerprint !== "string" ||
      feedback.fingerprint === ""
    ) {
      throw new Error("Malformed review reconciliation result");
    }

    const state = await getNativeState(
      repository,
      canonicalCandidate.number,
      token,
    );
    if (
      isCopilotReviewRequest &&
      (state.mergeQueueEntry || state.autoMergeRequest)
    ) {
      await holdCopilotMergePrivilege();
    } else if (state.mergeQueueEntry) {
      log(
        `PR #${canonicalCandidate.number}: already in the native merge queue.`,
      );
      return { action: "already-queued", pull: canonicalCandidate.number };
    } else if (state.autoMergeRequest) {
      log(
        `PR #${canonicalCandidate.number}: native auto-merge is already enabled.`,
      );
      return { action: "already-enabled", pull: canonicalCandidate.number };
    }

    await holdCopilotMergePrivilege();
    const finalEffectiveRules = await getEffectiveRules(repository, token);
    if (!hasRequiredNativeEnforcement(finalEffectiveRules, requiredChecks)) {
      await holdCopilotMergePrivilege({ retryWhenAbsent: true });
      log(
        `PR #${canonicalCandidate.number}: required native enforcement changed before the mutation.`,
      );
      return {
        action: "skipped",
        reason: "native-enforcement-inactive",
      };
    }

    await holdCopilotMergePrivilege();
    const finalPull = await getPull(
      repository,
      canonicalCandidate.number,
      token,
    );
    if (!isEligiblePull(finalPull, canonicalCandidate, repository)) {
      await holdCopilotMergePrivilege({ retryWhenAbsent: true });
      log(
        `PR #${canonicalCandidate.number}: pull request identity, state, base or exact head changed before the mutation.`,
      );
      return { action: "skipped", reason: "ineligible" };
    }

    await holdCopilotMergePrivilege();
    const finalFeedback = await readFeedback(reconciliationRequest, runtime);
    if (
      finalFeedback?.status !== "clear" ||
      finalFeedback.fingerprint !== feedback.fingerprint
    ) {
      await holdCopilotMergePrivilege({ retryWhenAbsent: true });
      log(
        `PR #${canonicalCandidate.number}: checks or review feedback changed before the mutation.`,
      );
      return { action: "skipped", reason: "review-state-changed" };
    }

    await holdCopilotMergePrivilege();
    const preArmFeedback = await readFeedback(reconciliationRequest, runtime);
    if (
      preArmFeedback?.status !== "clear" ||
      preArmFeedback.fingerprint !== feedback.fingerprint
    ) {
      await holdCopilotMergePrivilege({ retryWhenAbsent: true });
      log(
        `PR #${canonicalCandidate.number}: checks or review feedback changed immediately before the mutation.`,
      );
      return { action: "skipped", reason: "review-state-changed" };
    }

    try {
      await enableAutoMerge(
        repository,
        canonicalCandidate.number,
        canonicalCandidate.headSha,
        token,
      );
    } catch (enableError) {
      try {
        await removeNativeMergePrivilege(
          {
            repository,
            number: canonicalCandidate.number,
            token,
          },
          { getNativeState, disableAutoMerge, dequeuePull },
          runtime,
          { retryWhenAbsent: true },
        );
      } catch (cleanupError) {
        throw new AggregateError(
          [enableError, cleanupError],
          "Native auto-merge failed ambiguously and privilege cleanup could not be proven",
        );
      }
      throw enableError;
    }

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
    retainCopilotMergePrivilege = true;
    log(
      `PR #${canonicalCandidate.number}: native auto-merge enabled for exact head ${canonicalCandidate.headSha}.`,
    );
    return {
      action: "enabled",
      pull: canonicalCandidate.number,
      head: canonicalCandidate.headSha,
    };
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    if (isCopilotReviewRequest && !retainCopilotMergePrivilege) {
      try {
        await holdCopilotMergePrivilege({ retryWhenAbsent: true });
      } catch (cleanupError) {
        if (primaryFailure) {
          throw new AggregateError(
            [primaryFailure, cleanupError],
            "Copilot review reconciliation failed and native privilege cleanup could not be proven",
          );
        }
        throw cleanupError;
      }
    }
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  runNativeAutoMerge().catch((error) => {
    process.stderr.write(`native auto-merge failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
