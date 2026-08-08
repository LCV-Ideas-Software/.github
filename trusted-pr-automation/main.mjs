import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const ACTIONS_APP_ID = 15368;
export const CONNECTOR_ID = 199175422;
export const CONNECTOR_NODE_ID = "BOT_kgDOC98s_g";
export const COPILOT_REVIEWER_ID = 175728472;
export const COPILOT_REVIEWER_NODE_ID = "BOT_kgDOCnlnWA";
export const TRUSTED_GATE_CHECK_NAME = "LCV Trusted Gate";
export const TRUSTED_GATE_SOURCE_REPOSITORY = "LCV-Ideas-Software/.github";
export const TRUSTED_GATE_SOURCE_WORKFLOW_ID = 329989853;
export const TRUSTED_GATE_SOURCE_WORKFLOW_PATH =
  ".github/workflows/trusted-pr-gate.yml";
export const BOT_REVIEW_VETO_ANNOTATION_TITLE = "LCV_GATE_BOT_REVIEW_VETO";

const API_VERSION = "2026-03-10";
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const CONNECTOR_LOGINS = new Set(["chatgpt-codex-connector"]);
const COPILOT_REVIEWER_IDENTITY = Object.freeze({
  database_id: COPILOT_REVIEWER_ID,
  node_id: COPILOT_REVIEWER_NODE_ID,
  rest_review_login: "copilot-pull-request-reviewer[bot]",
  graphql_login: "copilot-pull-request-reviewer",
  inline_alias_login: "Copilot",
});
const DEPENDABOT_REBASE_MARKER = "LCV-DEPENDABOT-REBASE-HEAD";
const DEFAULT_POLL_SECONDS = 30;
const DEFAULT_TIMEOUT_SECONDS = 15 * 60;

export class BotReviewVetoError extends Error {
  constructor(message, recoveryCode = "NONRECOVERABLE") {
    super(message);
    this.name = "BotReviewVetoError";
    this.recoveryCode = recoveryCode;
  }
}

export function botReviewVetoWorkflowCommand(error) {
  if (!(error instanceof BotReviewVetoError)) return null;
  const message = `BOT_REVIEW_VETO ${error.recoveryCode} ${error.message}`
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
  return `::error title=${BOT_REVIEW_VETO_ANNOTATION_TITLE}::${message}`;
}

class StaleHeadError extends Error {
  constructor(message) {
    super(message);
    this.name = "StaleHeadError";
  }
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function validSha(value) {
  return typeof value === "string" && SHA_PATTERN.test(value);
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join(",") !== wanted.join(",")) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
}

function validateRepositoryProvenance(repository, config) {
  if (config.provenance === undefined) return;
  if (repository !== ".github-private") {
    throw new Error(`${repository} must not define provenance authority`);
  }
  assertObject(config.provenance, `${repository} provenance`);
  assertExactKeys(
    config.provenance,
    ["trusted_gate", "required_check_producers"],
    `${repository} provenance`,
  );

  const gate = config.provenance.trusted_gate;
  assertObject(gate, `${repository} trusted gate provenance`);
  assertExactKeys(
    gate,
    [
      "ruleset_id",
      "repository_id",
      "required_workflow_id",
      "source_repository_id",
      "source_repository",
      "source_workflow_id",
      "source_workflow_path",
      "source_sha",
      "source_blob_sha",
    ],
    `${repository} trusted gate provenance`,
  );
  for (const field of [
    "ruleset_id",
    "repository_id",
    "required_workflow_id",
    "source_repository_id",
    "source_workflow_id",
  ]) {
    if (!positiveSafeInteger(gate[field])) {
      throw new Error(`${repository} trusted gate ${field} is invalid`);
    }
  }
  if (
    gate.source_repository !== TRUSTED_GATE_SOURCE_REPOSITORY ||
    gate.source_workflow_id !== TRUSTED_GATE_SOURCE_WORKFLOW_ID ||
    gate.source_workflow_path !== TRUSTED_GATE_SOURCE_WORKFLOW_PATH ||
    !validSha(gate.source_sha) ||
    !validSha(gate.source_blob_sha)
  ) {
    throw new Error(`${repository} trusted gate source pin is invalid`);
  }

  const producers = config.provenance.required_check_producers;
  if (!Array.isArray(producers) || producers.length === 0) {
    throw new Error(`${repository} producer provenance must be nonempty`);
  }
  const requiredActions = new Set(
    config.required_checks
      .filter(({ app_id: appId }) => appId === ACTIONS_APP_ID)
      .map(({ name, app_id: appId }) => checkKey(name, appId)),
  );
  const producerKeys = new Set();
  for (const producer of producers) {
    assertObject(producer, `${repository} producer provenance`);
    assertExactKeys(
      producer,
      [
        "check_name",
        "app_id",
        "workflow_id",
        "workflow_name",
        "workflow_path",
        "workflow_blob_sha",
        "referenced_workflows",
      ],
      `${repository} producer provenance`,
    );
    const key = checkKey(producer.check_name, producer.app_id);
    if (
      producer.app_id !== ACTIONS_APP_ID ||
      !requiredActions.has(key) ||
      producerKeys.has(key) ||
      !positiveSafeInteger(producer.workflow_id) ||
      typeof producer.workflow_name !== "string" ||
      !producer.workflow_name ||
      typeof producer.workflow_path !== "string" ||
      !producer.workflow_path.startsWith(".github/workflows/") ||
      !validSha(producer.workflow_blob_sha) ||
      !Array.isArray(producer.referenced_workflows)
    ) {
      throw new Error(`${repository} producer provenance ${key} is invalid`);
    }
    producerKeys.add(key);
    for (const reference of producer.referenced_workflows) {
      assertObject(reference, `${repository} referenced workflow`);
      assertExactKeys(
        reference,
        ["path", "sha", "repository", "workflow_path", "blob_sha"],
        `${repository} referenced workflow`,
      );
      if (
        typeof reference.repository !== "string" ||
        !reference.repository.includes("/") ||
        typeof reference.workflow_path !== "string" ||
        !reference.workflow_path.startsWith(".github/workflows/") ||
        !validSha(reference.sha) ||
        !validSha(reference.blob_sha) ||
        reference.path !==
          `${reference.repository}/${reference.workflow_path}@${reference.sha}`
      ) {
        throw new Error(`${repository} referenced workflow pin is invalid`);
      }
    }
  }
  if (
    producerKeys.size !== requiredActions.size ||
    [...requiredActions].some((key) => !producerKeys.has(key))
  ) {
    throw new Error(`${repository} producer provenance is incomplete`);
  }
}

function identityKey(login, id) {
  return `${login}:${id}`;
}

function checkKey(name, appId) {
  return `${name}@${appId}`;
}

function isConnector(actor) {
  const nodeId =
    actor?.node_id ??
    actor?.nodeId ??
    (typeof actor?.id === "string" ? actor.id : null);
  return (
    actor?.databaseId === CONNECTOR_ID &&
    nodeId === CONNECTOR_NODE_ID &&
    (actor?.type ?? actor?.__typename) === "Bot" &&
    CONNECTOR_LOGINS.has(actor?.login)
  );
}

function isCopilotReviewer(actor, policy) {
  const expected = policy?.copilot_reviewer;
  if (!expected) return false;
  const databaseId = Number.isInteger(actor?.databaseId)
    ? actor.databaseId
    : Number.isInteger(actor?.id)
      ? actor.id
      : null;
  const nodeId =
    actor?.node_id ??
    actor?.nodeId ??
    (typeof actor?.id === "string" ? actor.id : null);
  const type = actor?.type ?? actor?.__typename;
  const logins = new Set([
    expected.rest_review_login,
    expected.graphql_login,
    expected.inline_alias_login,
  ]);
  return (
    databaseId === expected.database_id &&
    nodeId === expected.node_id &&
    type === "Bot" &&
    logins.has(actor?.login)
  );
}

function visibleMarkdownLines(body) {
  if (typeof body !== "string") return [];
  const lines = [];
  let fence = null;
  for (const rawLine of body.split(/\r?\n/)) {
    if (fence !== null) {
      const closing = rawLine.match(/^( {0,3})(`{3,}|~{3,})\s*$/);
      if (
        closing &&
        closing[2][0] === fence.marker &&
        closing[2].length >= fence.length
      ) {
        fence = null;
      }
      continue;
    }
    const opening = rawLine.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
    if (opening) {
      fence = { marker: opening[2][0], length: opening[2].length };
      continue;
    }
    if (/^(?: {4,}|\t)/.test(rawLine)) continue;
    const line = rawLine.trim();
    if (!line || line.startsWith(">")) continue;
    lines.push(line);
  }
  return lines;
}

function hasExactMarkdownLine(body, expected) {
  return visibleMarkdownLines(body).includes(expected);
}

function suppressedCopilotCommentCount(body) {
  const label =
    "(?:Suppressed comments|Comments suppressed due to low confidence)";
  const summaryPattern = new RegExp(
    `^<summary>\\s*${label}\\s*\\(\\s*(\\d+)\\s*\\)\\s*</summary>$`,
    "i",
  );
  const linePattern = new RegExp(`^${label}\\s*\\(\\s*(\\d+)\\s*\\)$`, "i");
  const counts = visibleMarkdownLines(body)
    .map((line) => line.match(summaryPattern) ?? line.match(linePattern))
    .filter(Boolean)
    .map((match) => Number(match[1]))
    .filter(Number.isSafeInteger);
  return { count: counts.length === 0 ? 0 : Math.max(...counts) };
}

export function validatePolicy(raw) {
  assertObject(raw, "policy");
  if (raw.schema_version !== 1) {
    throw new Error("policy schema_version must be 1");
  }
  if (typeof raw.organization !== "string" || !raw.organization.trim()) {
    throw new Error("policy organization must be a nonempty string");
  }
  if (!Array.isArray(raw.allowed_actors) || raw.allowed_actors.length === 0) {
    throw new Error("policy allowed_actors must be nonempty");
  }

  assertObject(raw.copilot_reviewer, "Copilot reviewer identity");
  for (const [field, value] of Object.entries(COPILOT_REVIEWER_IDENTITY)) {
    if (raw.copilot_reviewer[field] !== value) {
      throw new Error(`Copilot reviewer identity has invalid ${field}`);
    }
  }
  if (
    Object.keys(raw.copilot_reviewer).sort().join(",") !==
    Object.keys(COPILOT_REVIEWER_IDENTITY).sort().join(",")
  ) {
    throw new Error("Copilot reviewer identity has unexpected fields");
  }

  const actorKeys = new Set();
  const actorLogins = new Set();
  const actorIds = new Set();
  for (const actor of raw.allowed_actors) {
    assertObject(actor, "allowed actor");
    if (typeof actor.login !== "string" || !Number.isInteger(actor.id)) {
      throw new Error("allowed actor needs a login and integer id");
    }
    const key = identityKey(actor.login, actor.id);
    if (
      actorKeys.has(key) ||
      actorLogins.has(actor.login) ||
      actorIds.has(actor.id)
    ) {
      throw new Error(`duplicate allowed actor: ${key}`);
    }
    actorKeys.add(key);
    actorLogins.add(actor.login);
    actorIds.add(actor.id);
  }

  assertObject(raw.repositories, "policy repositories");
  if (Object.keys(raw.repositories).length === 0) {
    throw new Error("policy repositories must be nonempty");
  }
  for (const [repository, config] of Object.entries(raw.repositories)) {
    if (!repository || repository.includes("/")) {
      throw new Error(`invalid repository name: ${repository}`);
    }
    assertObject(config, `repository ${repository}`);
    if (
      !Array.isArray(config.required_checks) ||
      config.required_checks.length === 0
    ) {
      throw new Error(`${repository} required_checks must be nonempty`);
    }
    if (
      config.merge_group_required_checks !== undefined &&
      !Array.isArray(config.merge_group_required_checks)
    ) {
      throw new Error(
        `${repository} merge_group_required_checks must be an array`,
      );
    }
    const keys = new Set();
    for (const [listName, requiredChecks] of [
      ["required_checks", config.required_checks],
      ["merge_group_required_checks", config.merge_group_required_checks ?? []],
    ]) {
      for (const required of requiredChecks) {
        assertObject(required, `${repository} ${listName} check`);
        if (
          typeof required.name !== "string" ||
          !Number.isInteger(required.app_id)
        ) {
          throw new Error(
            `${repository} ${listName} check needs name and integer app_id`,
          );
        }
        if (required.name === TRUSTED_GATE_CHECK_NAME) {
          throw new Error(`${repository} must not require itself`);
        }
        const key = checkKey(required.name, required.app_id);
        if (keys.has(key)) {
          throw new Error(`duplicate required check for ${repository}: ${key}`);
        }
        keys.add(key);
      }
    }
    validateRepositoryProvenance(repository, config);
  }
  return structuredClone(raw);
}

export function requiredChecksForPhase(repositoryPolicy, phase) {
  assertObject(repositoryPolicy, "repository policy");
  if (!Array.isArray(repositoryPolicy.required_checks)) {
    throw new Error("repository policy has no required_checks");
  }
  if (phase === "pull_request") return repositoryPolicy.required_checks;
  if (phase === "merge_group") {
    return [
      ...repositoryPolicy.required_checks,
      ...(repositoryPolicy.merge_group_required_checks ?? []),
    ];
  }
  throw new Error(`unsupported check phase: ${phase}`);
}

export function isTrustedPullRequest(pullRequest, fullRepository, policy) {
  if (pullRequest?.state !== "open")
    return { ok: false, reason: "pull request is not open" };
  if (pullRequest?.draft !== false)
    return { ok: false, reason: "pull request draft state is not trusted" };
  const expectedActor = policy.allowed_actors.some(
    (allowed) =>
      allowed.login === pullRequest?.user?.login &&
      allowed.id === pullRequest?.user?.id,
  );
  if (!expectedActor)
    return { ok: false, reason: "pull request actor is not allowlisted" };
  if (pullRequest?.base?.ref !== "main") {
    return { ok: false, reason: "pull request must target base main" };
  }
  if (
    pullRequest?.head?.repo?.full_name !== fullRepository ||
    pullRequest?.base?.repo?.full_name !== fullRepository
  ) {
    return { ok: false, reason: "pull request must use the same repository" };
  }
  if (!validSha(pullRequest?.head?.sha)) {
    return { ok: false, reason: "pull request has an invalid head SHA" };
  }
  if (!validSha(pullRequest?.base?.sha)) {
    return { ok: false, reason: "pull request has an invalid base SHA" };
  }
  return { ok: true };
}

export function evaluateConnectorEvidence({
  headSha,
  issueComments,
  reviews,
  threads,
  policy,
}) {
  if (!validSha(headSha))
    return { ok: false, reason: "invalid connector evidence head SHA" };

  for (const comment of issueComments ?? []) {
    if (!isConnector(comment?.user)) continue;
    const body = typeof comment?.body === "string" ? comment.body.trim() : "";
    if (!body) continue;
    const reviewed = body
      .match(/\*\*Reviewed commit:\*\*\s+`([0-9a-f]{10,40})`/i)?.[1]
      ?.toLowerCase();
    if (
      hasExactMarkdownLine(body, "### 💡 Codex Review") &&
      reviewed &&
      headSha.startsWith(reviewed)
    ) {
      return {
        ok: false,
        reason:
          "connector issue comment reports a current-head finding without a resolvable thread",
        botVeto: true,
      };
    }
  }

  const latestDecisiveReviews = latestByIdentity(
    (reviews ?? []).filter(
      (review) =>
        review?.commit_id === headSha &&
        ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review?.state),
    ),
    (review) => identityKey(review?.user?.login, review?.user?.id),
  );
  const requestedChanges = [...latestDecisiveReviews.values()].filter(
    (review) => review?.state === "CHANGES_REQUESTED",
  );
  const humanChangeRequest = requestedChanges.some(
    (review) =>
      !isConnector(review?.user) && !isCopilotReviewer(review?.user, policy),
  );
  const connectorChangeRequest = requestedChanges.some((review) =>
    isConnector(review?.user),
  );
  const copilotChangeRequest = requestedChanges.some((review) =>
    isCopilotReviewer(review?.user, policy),
  );
  const decisiveVeto =
    requestedChanges.length === 0
      ? null
      : {
          ok: false,
          reason: "changes requested on the current head",
          botVeto: !humanChangeRequest,
          recoveryCode: humanChangeRequest
            ? undefined
            : connectorChangeRequest
              ? "CONNECTOR_CHANGES_REQUESTED"
              : copilotChangeRequest
                ? "COPILOT_CHANGES_REQUESTED"
                : undefined,
        };
  if (decisiveVeto && !decisiveVeto.botVeto) return decisiveVeto;

  const correlatedConnectorComments = new Map();
  let unresolvedConnectorThread = false;
  for (const thread of threads ?? []) {
    const connectorLookingComments = (thread.comments ?? []).filter((comment) =>
      isConnector(comment.author),
    );
    if (connectorLookingComments.length === 0) continue;
    if (!thread.isResolved) {
      unresolvedConnectorThread = true;
    }
    for (const comment of connectorLookingComments) {
      const sourceReview = (reviews ?? []).find(
        (review) => review?.id === comment?.reviewId,
      );
      if (
        !Number.isInteger(comment?.reviewId) ||
        !validSha(comment?.reviewCommit?.oid) ||
        !isConnector(sourceReview?.user) ||
        sourceReview?.commit_id !== comment?.reviewCommit?.oid
      ) {
        continue;
      }
      correlatedConnectorComments.set(
        comment.reviewId,
        (correlatedConnectorComments.get(comment.reviewId) ?? 0) + 1,
      );
    }
  }
  for (const review of reviews ?? []) {
    if (!isConnector(review?.user) || review?.commit_id !== headSha) continue;
    if (
      ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review?.state)
    ) {
      continue;
    }
    if (review?.state !== "COMMENTED") {
      continue;
    }
    const body = typeof review.body === "string" ? review.body.trim() : "";
    if (!body) continue;
    if (
      hasExactMarkdownLine(body, "### 💡 Codex Review") &&
      (correlatedConnectorComments.get(review.id) ?? 0) === 0
    ) {
      return {
        ok: false,
        reason:
          "connector review reports a current-head finding without a resolvable thread",
        botVeto: true,
      };
    }
  }
  if (unresolvedConnectorThread) {
    return {
      ok: false,
      reason: "unresolved connector thread remains",
      botVeto: true,
      recoveryCode: "UNRESOLVED_CONNECTOR_THREAD",
    };
  }
  if (decisiveVeto) return decisiveVeto;
  return { ok: true };
}

export function evaluateCopilotEvidence({ headSha, reviews, threads, policy }) {
  if (!validSha(headSha)) {
    return { ok: false, reason: "invalid Copilot evidence head SHA" };
  }

  const copilotReviews = (reviews ?? []).filter((review) =>
    isCopilotReviewer(review?.user, policy),
  );
  const correlatedComments = new Map();
  let unresolvedCopilotThread = false;

  for (const thread of threads ?? []) {
    const copilotLookingComments = (thread.comments ?? []).filter((comment) =>
      isCopilotReviewer(comment?.author, policy),
    );
    if (copilotLookingComments.length === 0) continue;
    if (!thread.isResolved) {
      unresolvedCopilotThread = true;
    }
    for (const comment of copilotLookingComments) {
      const sourceReview = copilotReviews.find(
        (review) => review?.id === comment?.reviewId,
      );
      if (
        !Number.isInteger(comment?.reviewId) ||
        !validSha(comment?.reviewCommit?.oid) ||
        sourceReview?.commit_id !== comment?.reviewCommit?.oid
      ) {
        continue;
      }
      correlatedComments.set(
        comment.reviewId,
        (correlatedComments.get(comment.reviewId) ?? 0) + 1,
      );
    }
  }

  const exactReviews = copilotReviews
    .filter((review) => review?.commit_id === headSha)
    .sort((left, right) => Number(right?.id ?? 0) - Number(left?.id ?? 0));
  const exactReview = exactReviews[0];
  if (!exactReview) {
    if (unresolvedCopilotThread) {
      return {
        ok: false,
        reason: "unresolved Copilot review thread remains",
        recoveryCode: "UNRESOLVED_COPILOT_THREAD",
      };
    }
    return { ok: true };
  }

  const latestDecisiveCopilotReview = [...exactReviews]
    .filter((review) =>
      ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review?.state),
    )
    .sort((left, right) => Number(right?.id ?? 0) - Number(left?.id ?? 0))[0];
  const decisiveCopilotVeto =
    latestDecisiveCopilotReview?.state === "CHANGES_REQUESTED"
      ? {
          ok: false,
          reason: "Copilot requested changes on the current head",
          recoveryCode: "COPILOT_CHANGES_REQUESTED",
        }
      : null;

  for (const review of exactReviews) {
    if (review.state !== "COMMENTED") {
      continue;
    }
    const suppressed = suppressedCopilotCommentCount(review?.body);
    if (suppressed.count > 0) {
      return {
        ok: false,
        reason: "suppressed Copilot finding exists on the current head",
      };
    }
    const body = typeof review.body === "string" ? review.body : "";
    const reportsVisibleFinding = visibleMarkdownLines(body).some((line) =>
      /^Copilot reviewed \d+ out of \d+ changed files? in this pull request and generated [1-9]\d* (?:new )?comments?\.$/i.test(
        line,
      ),
    );
    if (
      reportsVisibleFinding &&
      (correlatedComments.get(review.id) ?? 0) === 0
    ) {
      return {
        ok: false,
        reason:
          "Copilot review reports a current-head finding without a resolvable thread",
      };
    }
  }
  if (unresolvedCopilotThread) {
    return {
      ok: false,
      reason: "unresolved Copilot review thread remains",
      recoveryCode: "UNRESOLVED_COPILOT_THREAD",
    };
  }
  if (decisiveCopilotVeto) return decisiveCopilotVeto;
  return { ok: true };
}

export function dependabotRebaseBody(headSha) {
  if (!validSha(headSha)) throw new Error("invalid Dependabot rebase head SHA");
  return `@dependabot rebase\n\n<!-- ${DEPENDABOT_REBASE_MARKER}:${headSha} -->`;
}

export async function ensureDependabotRebaseRequest({
  api,
  owner,
  repo,
  number,
  headSha,
  expectedBase,
  policy,
}) {
  if (
    !Number.isInteger(number) ||
    !validSha(headSha) ||
    !validSha(expectedBase)
  ) {
    throw new Error("invalid Dependabot rebase boundary identity");
  }
  const expectedBody = dependabotRebaseBody(headSha);
  const issueComments = await api.pages(
    `/repos/${owner}/${repo}/issues/${number}/comments`,
  );
  const exists = issueComments.some(
    (comment) =>
      policy.allowed_actors.some(
        (allowed) =>
          allowed.login === comment?.user?.login &&
          allowed.id === comment?.user?.id,
      ) && comment?.body === expectedBody,
  );
  if (exists) return "dependabot-rebase-pending";

  const mainSha = await currentMain(api, owner, repo);
  const pullRequest = await api.request(
    `/repos/${owner}/${repo}/pulls/${number}`,
  );
  const fullRepository = `${owner}/${repo}`;
  if (
    pullRequest?.number !== number ||
    pullRequest?.state !== "open" ||
    pullRequest?.draft !== false ||
    pullRequest?.base?.ref !== "main" ||
    pullRequest?.user?.login !== "dependabot[bot]" ||
    pullRequest?.user?.id !== 49699333 ||
    pullRequest?.head?.repo?.full_name !== fullRepository ||
    pullRequest?.base?.repo?.full_name !== fullRepository ||
    pullRequest?.head?.sha !== headSha ||
    pullRequest?.base?.sha !== expectedBase ||
    mainSha !== expectedBase
  ) {
    return "dependabot-rebase-stale";
  }
  const mergeability = classifyPullRequestMergeability(pullRequest);
  if (mergeability === "pending") {
    return "dependabot-rebase-mergeability-pending";
  }
  if (mergeability === "ready") return "dependabot-rebase-no-conflict";
  if (mergeability !== "conflict") {
    throw new Error("Dependabot rebase mergeability is incoherent");
  }
  await api.request(`/repos/${owner}/${repo}/issues/${number}/comments`, {
    method: "POST",
    body: { body: expectedBody },
  });
  return "dependabot-rebase-requested";
}

function latestByIdentity(items, identity) {
  const latest = new Map();
  for (const item of items ?? []) {
    const key = identity(item);
    const previous = latest.get(key);
    if (!previous || Number(item.id ?? 0) > Number(previous.id ?? 0))
      latest.set(key, item);
  }
  return latest;
}

function checkRunInstanceKey(run) {
  const key = checkKey(run?.name, run?.app?.id);
  if (run?.app?.id !== ACTIONS_APP_ID) return key;
  const suiteId = run?.check_suite?.id;
  return Number.isSafeInteger(suiteId) && suiteId > 0
    ? `${key}:suite:${suiteId}`
    : `${key}:invalid-suite:${String(run?.id ?? "missing")}`;
}

function latestCheckRunsBySuite(checkRuns) {
  return latestByIdentity(checkRuns, checkRunInstanceKey);
}

export function classifyChecks({ checkRuns, statuses, requiredChecks }) {
  const failures = [];
  const pendings = [];
  const latestRuns = [...latestCheckRunsBySuite(checkRuns).values()].filter(
    (run) =>
      !(
        run?.name === TRUSTED_GATE_CHECK_NAME && run?.app?.id === ACTIONS_APP_ID
      ),
  );

  for (const required of requiredChecks) {
    const key = checkKey(required.name, required.app_id);
    const matching = latestRuns.filter(
      (run) => checkKey(run?.name, run?.app?.id) === key,
    );
    if (matching.length === 0) {
      pendings.push(`missing required check ${key}`);
      continue;
    }
    for (const run of matching) {
      if (run.status !== "completed") {
        pendings.push(`required check ${key} is ${run.status}`);
      } else if (["neutral", "skipped"].includes(run.conclusion)) {
        pendings.push(
          `required check ${key} concluded ${run.conclusion} and has not converged to success`,
        );
      } else if (run.conclusion !== "success") {
        failures.push(
          `required check ${key} concluded ${run.conclusion ?? "without conclusion"}`,
        );
      }
    }
  }

  const optionalFailures = new Set([
    "action_required",
    "cancelled",
    "failure",
    "stale",
    "startup_failure",
    "timed_out",
  ]);
  for (const run of latestRuns) {
    const key = checkRunInstanceKey(run);
    if (
      run?.app?.id === ACTIONS_APP_ID &&
      (!Number.isSafeInteger(run?.check_suite?.id) || run.check_suite.id <= 0)
    ) {
      failures.push(`observed check ${key} has no valid check-suite identity`);
      continue;
    }
    if (run.status !== "completed") {
      pendings.push(`observed check ${key} is ${run.status}`);
    } else if (optionalFailures.has(run.conclusion)) {
      failures.push(`observed check ${key} concluded ${run.conclusion}`);
    } else if (!["success", "neutral", "skipped"].includes(run.conclusion)) {
      failures.push(
        `observed check ${key} has unknown conclusion ${run.conclusion ?? "none"}`,
      );
    }
  }

  const latestStatuses = latestByIdentity(statuses, (status) => status.context);
  for (const [context, status] of latestStatuses) {
    if (status.state === "pending") {
      pendings.push(`commit status ${context} is pending`);
    } else if (status.state !== "success") {
      failures.push(`commit status ${context} is ${status.state ?? "unknown"}`);
    }
  }

  const reasons = [...failures, ...pendings];
  return {
    state: failures.length
      ? "failure"
      : pendings.length
        ? "pending"
        : "success",
    reasons,
  };
}

function sortFingerprintRecords(records) {
  return records.sort((left, right) => {
    const leftJson = JSON.stringify(left);
    const rightJson = JSON.stringify(right);
    if (leftJson < rightJson) return -1;
    if (leftJson > rightJson) return 1;
    return 0;
  });
}

export function checkEvidenceFingerprint({ checkRuns, statuses }) {
  return JSON.stringify({
    checkRuns: sortFingerprintRecords(
      (checkRuns ?? []).map((run) => ({
        id: run?.id ?? null,
        name: run?.name ?? null,
        appId: run?.app?.id ?? null,
        checkSuiteId: run?.check_suite?.id ?? null,
        status: run?.status ?? null,
        conclusion: run?.conclusion ?? null,
        detailsUrl: run?.details_url ?? null,
        startedAt: run?.started_at ?? null,
        completedAt: run?.completed_at ?? null,
      })),
    ),
    statuses: sortFingerprintRecords(
      (statuses ?? []).map((status) => ({
        id: status?.id ?? null,
        context: status?.context ?? null,
        creatorId: status?.creator?.id ?? null,
        state: status?.state ?? null,
        targetUrl: status?.target_url ?? null,
        createdAt: status?.created_at ?? null,
        updatedAt: status?.updated_at ?? null,
      })),
    ),
  });
}

function canonicalRepositoryFileUrl(repository, revision, workflowPath) {
  return `https://github.com/${repository}/blob/${revision}/${workflowPath}`;
}

function referencedWorkflowIdentity(entries) {
  if (!Array.isArray(entries)) return null;
  return entries.map((entry) => ({
    path: entry?.path,
    sha: entry?.sha,
  }));
}

async function verifyReferencedWorkflowBlobs(api, references) {
  for (const reference of references) {
    const file = await api.request(
      `/repos/${reference.repository}/contents/${reference.workflow_path}?ref=${reference.sha}`,
    );
    if (
      file?.path !== reference.workflow_path ||
      file?.sha !== reference.blob_sha ||
      file?.html_url !==
        canonicalRepositoryFileUrl(
          reference.repository,
          reference.sha,
          reference.workflow_path,
        )
    ) {
      throw new Error(
        `referenced workflow ${reference.path} blob is inconsistent`,
      );
    }
  }
}

async function verifyRequiredCheckProducer({
  api,
  owner,
  repo,
  headSha,
  expectedEvent,
  checkRun,
  producer,
  repositoryId,
}) {
  if (
    !positiveSafeInteger(checkRun?.id) ||
    checkRun?.name !== producer.check_name ||
    checkRun?.app?.id !== producer.app_id ||
    !positiveSafeInteger(checkRun?.check_suite?.id)
  ) {
    throw new Error(
      `required producer ${producer.check_name} check identity is invalid`,
    );
  }
  const fullRepository = `${owner}/${repo}`;
  const detailsPrefix = `https://github.com/${fullRepository}/actions/runs/`;
  const details = checkRun.details_url?.startsWith(detailsPrefix)
    ? checkRun.details_url.slice(detailsPrefix.length)
    : "";
  const detailsMatch = details.match(/^([1-9]\d*)\/job\/([1-9]\d*)$/);
  const runId = Number(detailsMatch?.[1]);
  const jobId = Number(detailsMatch?.[2]);
  if (!positiveSafeInteger(runId) || !positiveSafeInteger(jobId)) {
    throw new Error(
      `required producer ${producer.check_name} details URL is invalid`,
    );
  }
  const expectedCheckUrl = `https://api.github.com/repos/${fullRepository}/check-runs/${checkRun.id}`;
  const expectedRunUrl = `https://api.github.com/repos/${fullRepository}/actions/runs/${runId}`;
  const job = await api.request(
    `/repos/${owner}/${repo}/actions/jobs/${jobId}`,
  );
  if (
    job?.id !== jobId ||
    job?.run_id !== runId ||
    job?.run_url !== expectedRunUrl ||
    job?.check_run_url !== expectedCheckUrl ||
    job?.head_sha !== headSha ||
    job?.name !== producer.check_name ||
    job?.workflow_name !== producer.workflow_name ||
    job?.status !== checkRun.status ||
    job?.conclusion !== checkRun.conclusion ||
    !positiveSafeInteger(job?.run_attempt)
  ) {
    throw new Error(
      `required producer ${producer.check_name} job is inconsistent`,
    );
  }

  const runs = await api.pages(
    `/repos/${owner}/${repo}/actions/runs?check_suite_id=${checkRun.check_suite.id}&head_sha=${headSha}`,
    { extract: (payload) => payload?.workflow_runs },
  );
  if (runs.length !== 1) {
    throw new Error(
      `required producer ${producer.check_name} suite does not map to one run`,
    );
  }
  const [run] = runs;
  const workflowUrl = `https://api.github.com/repos/${fullRepository}/actions/workflows/${producer.workflow_id}`;
  const expectedReferences = producer.referenced_workflows.map(
    ({ path, sha }) => ({ path, sha }),
  );
  if (
    run?.id !== runId ||
    run?.url !== expectedRunUrl ||
    run?.check_suite_id !== checkRun.check_suite.id ||
    run?.head_sha !== headSha ||
    run?.event !== expectedEvent ||
    run?.name !== producer.workflow_name ||
    run?.path !== producer.workflow_path ||
    run?.workflow_id !== producer.workflow_id ||
    run?.workflow_url !== workflowUrl ||
    run?.repository?.id !== repositoryId ||
    run?.repository?.full_name !== fullRepository ||
    run?.head_repository?.id !== repositoryId ||
    run?.head_repository?.full_name !== fullRepository ||
    !positiveSafeInteger(run?.run_attempt) ||
    run.run_attempt < job.run_attempt ||
    JSON.stringify(referencedWorkflowIdentity(run?.referenced_workflows)) !==
      JSON.stringify(expectedReferences)
  ) {
    throw new Error(
      `required producer ${producer.check_name} run is inconsistent`,
    );
  }

  const workflow = await api.request(workflowUrl);
  if (
    workflow?.id !== producer.workflow_id ||
    workflow?.name !== producer.workflow_name ||
    workflow?.path !== producer.workflow_path ||
    workflow?.state !== "active" ||
    workflow?.url !== workflowUrl
  ) {
    throw new Error(
      `required producer ${producer.check_name} workflow is inconsistent`,
    );
  }

  const graphRun = await readWorkflowRunIdentity(api, run.node_id);
  const htmlRunUrl = `https://github.com/${fullRepository}/actions/runs/${runId}`;
  const sourceFileUrl = canonicalRepositoryFileUrl(
    fullRepository,
    headSha,
    producer.workflow_path,
  );
  const workflowResourcePath = `/${fullRepository}/actions/workflows/${producer.workflow_path.split("/").at(-1)}`;
  if (
    graphRun?.databaseId !== runId ||
    graphRun?.event !== expectedEvent ||
    graphRun?.runAttempt !== run.run_attempt ||
    graphRun?.url !== htmlRunUrl ||
    typeof graphRun?.file?.id !== "string" ||
    !graphRun.file.id ||
    graphRun.file.path !== producer.workflow_path ||
    graphRun.file.repositoryName !== fullRepository ||
    graphRun.file.repositoryFileUrl !== sourceFileUrl ||
    graphRun.file.resourcePath !==
      `/${fullRepository}/actions/runs/${runId}/workflow` ||
    graphRun.file.url !== `${htmlRunUrl}/workflow` ||
    graphRun?.workflow?.databaseId !== producer.workflow_id ||
    graphRun.workflow.name !== producer.workflow_name ||
    graphRun.workflow.state !== "ACTIVE" ||
    graphRun.workflow.resourcePath !== workflowResourcePath ||
    graphRun.workflow.url !== `https://github.com${workflowResourcePath}`
  ) {
    throw new Error(
      `required producer ${producer.check_name} GraphQL identity is inconsistent`,
    );
  }
  const sourceFile = await api.request(
    `/repos/${fullRepository}/contents/${producer.workflow_path}?ref=${headSha}`,
  );
  if (
    sourceFile?.path !== producer.workflow_path ||
    sourceFile?.sha !== producer.workflow_blob_sha ||
    sourceFile?.html_url !== sourceFileUrl
  ) {
    throw new Error(
      `required producer ${producer.check_name} blob is inconsistent`,
    );
  }
  await verifyReferencedWorkflowBlobs(api, producer.referenced_workflows);
  return { checkRun, job, run, sourceRevisionVerified: true };
}

async function verifyRequiredCheckProducerProvenance(options) {
  const {
    api,
    owner,
    repo,
    headSha,
    expectedEvent,
    checkRuns,
    requiredChecks,
    repositoryPolicy,
  } = options;
  const provenance = repositoryPolicy.provenance;
  if (
    repo !== ".github-private" ||
    !validSha(headSha) ||
    !["pull_request", "merge_group"].includes(expectedEvent)
  ) {
    throw new Error("required producer provenance scope is invalid");
  }
  const actionRequirements = requiredChecks.filter(
    (required) => required?.app_id === ACTIONS_APP_ID,
  );
  for (const required of actionRequirements) {
    const key = checkKey(required.name, required.app_id);
    const producer = provenance.required_check_producers.find(
      (candidate) => checkKey(candidate.check_name, candidate.app_id) === key,
    );
    if (!producer)
      throw new Error(`required producer policy ${key} is missing`);
    const candidates = checkRuns.filter(
      (run) => checkKey(run?.name, run?.app?.id) === key,
    );
    if (candidates.length === 0) {
      throw new Error(`required producer check ${key} is missing`);
    }
    const verified = [];
    for (const checkRun of candidates) {
      verified.push(
        await verifyRequiredCheckProducer({
          api,
          owner,
          repo,
          headSha,
          expectedEvent,
          checkRun,
          producer,
          repositoryId: provenance.trusted_gate.repository_id,
        }),
      );
    }
    selectCurrentTrustedGateRun(verified);
  }
  return {
    outcome: "required-check-producer-provenance-verified",
    producerProvenanceVerified: true,
  };
}

export function inspectRequiredCheckProducerProvenance({
  api,
  owner,
  repo,
  headSha,
  expectedEvent = "pull_request",
  checkRuns,
  requiredChecks,
  repositoryPolicy,
}) {
  const latestRuns = [...latestCheckRunsBySuite(checkRuns).values()];
  const actionRequirements = (requiredChecks ?? []).filter(
    (required) => required?.app_id === ACTIONS_APP_ID,
  );
  if (actionRequirements.length === 0) {
    return { outcome: "required-check-producer-provenance-not-applicable" };
  }
  if (repositoryPolicy?.provenance) {
    return verifyRequiredCheckProducerProvenance({
      api,
      owner,
      repo,
      headSha,
      expectedEvent,
      checkRuns,
      requiredChecks,
      repositoryPolicy,
    });
  }
  for (const required of actionRequirements) {
    const key = checkKey(required.name, required.app_id);
    const matching = latestRuns.filter(
      (run) => checkKey(run?.name, run?.app?.id) === key,
    );
    if (matching.length === 0) {
      throw new Error(`required producer check ${key} is missing`);
    }
    if (
      matching.some(
        (run) =>
          !Number.isSafeInteger(run?.check_suite?.id) ||
          run.check_suite.id <= 0,
      )
    ) {
      throw new Error(
        `required producer check ${key} has invalid suite identity`,
      );
    }
  }
  return {
    outcome: "required-check-producer-provenance-unverified",
    producerProvenanceVerified: false,
  };
}

export function controllerCheckOutcome(result) {
  if (result?.state === "failure") {
    throw new Error(result.reasons?.join("; ") || "a check failed");
  }
  if (result?.state === "pending") return "checks-pending";
  if (result?.state === "success") return "checks-success";
  throw new Error("invalid check classification");
}

export async function verifyCodeScanningAfterChecks({
  api,
  owner,
  repo,
  number,
  checkState,
}) {
  if (checkState === "pending") return "checks-pending";
  if (checkState !== "success") {
    throw new Error(
      "code-scanning verification requires green exact-head checks",
    );
  }
  const alerts = await api.pages(
    `/repos/${owner}/${repo}/code-scanning/alerts?state=open&pr=${number}`,
  );
  if (alerts.length !== 0) {
    throw new Error(
      `${repo}#${number}: ${alerts.length} open code-scanning alert(s)`,
    );
  }
  return "code-scanning-success";
}

function trustedGateCheckRuns(checkRuns) {
  return (checkRuns ?? []).filter(
    (run) =>
      run?.name === TRUSTED_GATE_CHECK_NAME && run?.app?.id === ACTIONS_APP_ID,
  );
}

function expectedGateWorkflowUrl(gate) {
  const sourceRepository =
    gate?.source_repository ?? TRUSTED_GATE_SOURCE_REPOSITORY;
  const sourceWorkflowId =
    gate?.source_workflow_id ?? TRUSTED_GATE_SOURCE_WORKFLOW_ID;
  return `https://api.github.com/repos/${sourceRepository}/actions/workflows/${sourceWorkflowId}`;
}

const WORKFLOW_RUN_IDENTITY_QUERY = `
  query($id: ID!) {
    node(id: $id) {
      ... on WorkflowRun {
        databaseId
        event
        runAttempt
        url
        file {
          id
          path
          repositoryName
          repositoryFileUrl
          resourcePath
          url
        }
        workflow {
          databaseId
          name
          resourcePath
          url
          state
        }
      }
    }
  }
`;

async function readWorkflowRunIdentity(api, nodeId) {
  if (typeof nodeId !== "string" || !nodeId) {
    throw new Error("workflow run has no GraphQL node identity");
  }
  const data = await api.graphql(WORKFLOW_RUN_IDENTITY_QUERY, { id: nodeId });
  if (!data?.node || typeof data.node !== "object") {
    throw new Error("workflow run GraphQL identity is missing");
  }
  return data.node;
}

function exactArray(value, expected) {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

function verifyCanaryRuleset(ruleset, owner, gate) {
  const workflowsRules = (ruleset?.rules ?? []).filter(
    (rule) => rule?.type === "workflows",
  );
  const copilotRules = (ruleset?.rules ?? []).filter(
    (rule) => rule?.type === "copilot_code_review",
  );
  const workflowPins = workflowsRules[0]?.parameters?.workflows;
  const workflowPin = Array.isArray(workflowPins) ? workflowPins[0] : null;
  const copilot = copilotRules[0]?.parameters;
  if (
    ruleset?.id !== gate.ruleset_id ||
    ruleset?.target !== "branch" ||
    ruleset?.source_type !== "Organization" ||
    ruleset?.source !== owner ||
    !["active", "evaluate"].includes(ruleset?.enforcement) ||
    !exactArray(ruleset?.bypass_actors, []) ||
    !exactArray(ruleset?.conditions?.repository_id?.repository_ids, [
      gate.repository_id,
    ]) ||
    !exactArray(ruleset?.conditions?.ref_name?.include, ["~DEFAULT_BRANCH"]) ||
    !exactArray(ruleset?.conditions?.ref_name?.exclude, []) ||
    workflowsRules.length !== 1 ||
    copilotRules.length !== 1 ||
    ruleset.rules.length !== 2 ||
    workflowsRules[0]?.parameters?.do_not_enforce_on_create !== false ||
    !Array.isArray(workflowPins) ||
    workflowPins.length !== 1 ||
    workflowPin?.repository_id !== gate.source_repository_id ||
    workflowPin?.path !== gate.source_workflow_path ||
    workflowPin?.sha !== gate.source_sha ||
    (workflowPin?.ref !== undefined && workflowPin.ref !== null) ||
    copilot?.review_on_push !== true ||
    copilot?.review_draft_pull_requests !== false
  ) {
    throw new Error("trusted gate canary ruleset identity is inconsistent");
  }
  return ruleset.enforcement;
}

async function verifyTrustedGateCheck({
  api,
  owner,
  repo,
  headSha,
  checkRun,
  expectedEvent,
  repositoryPolicy,
}) {
  if (!Number.isSafeInteger(checkRun?.id) || checkRun.id <= 0) {
    throw new Error("LCV Trusted Gate has no check-run identity");
  }
  const checkSuiteId = checkRun?.check_suite?.id;
  if (!Number.isSafeInteger(checkSuiteId) || checkSuiteId <= 0) {
    throw new Error("LCV Trusted Gate has no check-suite identity");
  }
  const fullRepository = `${owner}/${repo}`;
  const detailsPrefix = `https://github.com/${fullRepository}/actions/runs/`;
  const details = checkRun.details_url?.startsWith(detailsPrefix)
    ? checkRun.details_url.slice(detailsPrefix.length)
    : "";
  const detailsMatch = details.match(/^([1-9]\d*)\/job\/([1-9]\d*)$/);
  const runId = Number(detailsMatch?.[1]);
  const jobId = Number(detailsMatch?.[2]);
  if (
    !Number.isSafeInteger(runId) ||
    runId <= 0 ||
    !Number.isSafeInteger(jobId) ||
    jobId <= 0
  ) {
    throw new Error("LCV Trusted Gate details URL is not canonical");
  }
  const expectedCheckUrl = `https://api.github.com/repos/${fullRepository}/check-runs/${checkRun.id}`;
  const job = await api.request(
    `/repos/${owner}/${repo}/actions/jobs/${jobId}`,
  );
  if (
    job?.id !== jobId ||
    job?.check_run_url !== expectedCheckUrl ||
    job?.head_sha !== headSha ||
    job?.name !== TRUSTED_GATE_CHECK_NAME ||
    job?.workflow_name !== TRUSTED_GATE_CHECK_NAME ||
    job?.status !== checkRun.status ||
    job?.conclusion !== checkRun.conclusion ||
    !Number.isSafeInteger(job?.run_attempt) ||
    job.run_attempt <= 0 ||
    job?.run_id !== runId
  ) {
    throw new Error("LCV Trusted Gate job identity is inconsistent");
  }
  const expectedRunUrl = `https://api.github.com/repos/${fullRepository}/actions/runs/${runId}`;
  const expectedDetailsUrl = `${detailsPrefix}${runId}/job/${jobId}`;
  if (
    job.run_url !== expectedRunUrl ||
    checkRun.details_url !== expectedDetailsUrl
  ) {
    throw new Error("LCV Trusted Gate job URL is not canonical");
  }

  const runs = await api.pages(
    `/repos/${owner}/${repo}/actions/runs?check_suite_id=${checkSuiteId}&head_sha=${headSha}`,
    { extract: (payload) => payload?.workflow_runs },
  );
  if (runs.length !== 1) {
    throw new Error(
      "LCV Trusted Gate check suite does not map to exactly one workflow run",
    );
  }
  const [run] = runs;
  const gate = repositoryPolicy?.provenance?.trusted_gate;
  const workflowUrl = expectedGateWorkflowUrl(gate);
  const expectedWorkflowId = gate?.required_workflow_id;
  const expectedRunWorkflowUrl = gate
    ? `https://api.github.com/repos/${fullRepository}/actions/required_workflows/${expectedWorkflowId}`
    : workflowUrl;
  if (
    run?.id !== runId ||
    run?.url !== expectedRunUrl ||
    run?.check_suite_id !== checkSuiteId ||
    run?.head_sha !== headSha ||
    run?.event !== expectedEvent ||
    run?.name !== TRUSTED_GATE_CHECK_NAME ||
    run?.path !==
      (gate?.source_workflow_path ?? TRUSTED_GATE_SOURCE_WORKFLOW_PATH) ||
    run?.workflow_id !==
      (expectedWorkflowId ?? TRUSTED_GATE_SOURCE_WORKFLOW_ID) ||
    run?.workflow_url !== expectedRunWorkflowUrl ||
    run?.repository?.full_name !== fullRepository ||
    run?.head_repository?.full_name !== fullRepository ||
    !Number.isSafeInteger(run?.run_attempt) ||
    run.run_attempt < job.run_attempt
  ) {
    throw new Error("LCV Trusted Gate workflow-run identity is inconsistent");
  }

  const workflow = await api.request(workflowUrl);
  if (
    workflow?.id !==
      (gate?.source_workflow_id ?? TRUSTED_GATE_SOURCE_WORKFLOW_ID) ||
    workflow?.name !== TRUSTED_GATE_CHECK_NAME ||
    workflow?.path !==
      (gate?.source_workflow_path ?? TRUSTED_GATE_SOURCE_WORKFLOW_PATH) ||
    workflow?.state !== "active" ||
    workflow?.url !== workflowUrl
  ) {
    throw new Error(
      "LCV Trusted Gate source workflow identity is inconsistent",
    );
  }
  if (gate) {
    if (
      run?.repository?.id !== gate.repository_id ||
      run?.head_repository?.id !== gate.repository_id ||
      !Array.isArray(run?.referenced_workflows) ||
      run.referenced_workflows.length !== 0
    ) {
      throw new Error(
        "trusted gate target repository identity is inconsistent",
      );
    }
    const graphRun = await readWorkflowRunIdentity(api, run.node_id);
    const htmlRunUrl = `https://github.com/${fullRepository}/actions/runs/${runId}`;
    const sourceFileUrl = `https://github.com/${gate.source_repository}/blob/${gate.source_sha}/${gate.source_workflow_path}`;
    const workflowResourcePath = `/${fullRepository}/actions/workflows/required/${gate.source_repository}/${gate.source_workflow_path}`;
    const runWorkflowUrl = `https://github.com${workflowResourcePath}`;
    if (
      graphRun?.databaseId !== runId ||
      graphRun?.event !== expectedEvent ||
      graphRun?.runAttempt !== run.run_attempt ||
      graphRun?.url !== htmlRunUrl ||
      typeof graphRun?.file?.id !== "string" ||
      !graphRun.file.id ||
      graphRun.file.path !== gate.source_workflow_path ||
      graphRun.file.repositoryName !== gate.source_repository ||
      graphRun.file.repositoryFileUrl !== sourceFileUrl ||
      graphRun.file.resourcePath !==
        `/${fullRepository}/actions/runs/${runId}/workflow` ||
      graphRun.file.url !== `${htmlRunUrl}/workflow` ||
      graphRun?.workflow?.databaseId !== gate.required_workflow_id ||
      graphRun.workflow.name !== TRUSTED_GATE_CHECK_NAME ||
      graphRun.workflow.state !== "ACTIVE" ||
      graphRun.workflow.resourcePath !== workflowResourcePath ||
      graphRun.workflow.url !== runWorkflowUrl
    ) {
      throw new Error("trusted gate GraphQL source identity is inconsistent");
    }
    const sourceFile = await api.request(
      `/repos/${gate.source_repository}/contents/${gate.source_workflow_path}?ref=${gate.source_sha}`,
    );
    if (
      sourceFile?.path !== gate.source_workflow_path ||
      sourceFile?.sha !== gate.source_blob_sha ||
      sourceFile?.html_url !== sourceFileUrl
    ) {
      throw new Error("trusted gate source blob identity is inconsistent");
    }
    const ruleset = await api.request(
      `/orgs/${owner}/rulesets/${gate.ruleset_id}`,
    );
    const enforcement = verifyCanaryRuleset(ruleset, owner, gate);
    return {
      checkRun,
      job,
      run,
      sourceRevisionVerified: enforcement === "active",
    };
  }
  // The current REST payload proves check -> job -> run -> central workflow,
  // but it does not expose job.workflow_sha for a ruleset-required run. Until
  // the .github-private canary supplies an observable, documented pin binding,
  // this bootstrap controller deliberately has no enqueue authority.
  return { checkRun, job, run, sourceRevisionVerified: false };
}

export function selectCurrentTrustedGateRun(verified) {
  if (!Array.isArray(verified) || verified.length === 0) {
    throw new Error("no authenticated LCV Trusted Gate run exists");
  }
  const byRun = new Map();
  for (const candidate of verified) {
    const runId = candidate?.run?.id;
    const runAttempt = candidate?.run?.run_attempt;
    const jobAttempt = candidate?.job?.run_attempt;
    if (
      !Number.isSafeInteger(runId) ||
      runId <= 0 ||
      !Number.isSafeInteger(runAttempt) ||
      runAttempt <= 0 ||
      !Number.isSafeInteger(jobAttempt) ||
      jobAttempt <= 0 ||
      jobAttempt > runAttempt
    ) {
      throw new Error("LCV Trusted Gate run-attempt identity is inconsistent");
    }
    const entries = byRun.get(runId) ?? [];
    entries.push(candidate);
    byRun.set(runId, entries);
  }
  const currentByRun = [];
  for (const entries of byRun.values()) {
    const attempts = new Set(entries.map(({ run }) => run.run_attempt));
    if (attempts.size !== 1) {
      throw new Error("LCV Trusted Gate run attempt changed across evidence");
    }
    const [runAttempt] = attempts;
    const current = entries.filter(({ job }) => job.run_attempt === runAttempt);
    if (current.length === 0) {
      throw new Error("no check exists for the current run attempt");
    }
    if (current.length !== 1) {
      throw new Error("multiple checks exist for the current run attempt");
    }
    const [candidate] = current;
    if (
      candidate.run.status !== candidate.checkRun.status ||
      candidate.run.conclusion !== candidate.checkRun.conclusion
    ) {
      throw new Error("current LCV Trusted Gate outcome is inconsistent");
    }
    currentByRun.push(candidate);
  }
  currentByRun.sort((left, right) => right.run.id - left.run.id);
  if (
    currentByRun.length > 1 &&
    currentByRun[0].run.id === currentByRun[1].run.id
  ) {
    throw new Error("multiple current LCV Trusted Gate runs are ambiguous");
  }
  return currentByRun[0];
}

export function isRecoverableBotReviewVetoFailure({
  current,
  annotations,
  owner,
  repo,
  number,
  headSha,
}) {
  if (
    current?.sourceRevisionVerified !== true ||
    !Number.isInteger(number) ||
    !validSha(headSha) ||
    current?.checkRun?.status !== "completed" ||
    current?.checkRun?.conclusion !== "failure" ||
    current?.job?.run_attempt !== 1 ||
    current?.run?.run_attempt !== 1 ||
    current?.run?.head_sha !== headSha ||
    current?.run?.event !== "pull_request" ||
    current?.run?.repository?.full_name !== `${owner}/${repo}` ||
    current?.run?.head_repository?.full_name !== `${owner}/${repo}`
  ) {
    return false;
  }
  const expectedPrefixes = [
    "UNRESOLVED_CONNECTOR_THREAD",
    "UNRESOLVED_COPILOT_THREAD",
    "CONNECTOR_CHANGES_REQUESTED",
    "COPILOT_CHANGES_REQUESTED",
  ].map((code) => `BOT_REVIEW_VETO ${code} ${repo}#${number}@${headSha}: `);
  const botVetoAnnotations = (annotations ?? []).filter(
    (annotation) => annotation?.title === BOT_REVIEW_VETO_ANNOTATION_TITLE,
  );
  if (botVetoAnnotations.length !== 1) return false;
  const [annotation] = botVetoAnnotations;
  return (
    annotation?.annotation_level === "failure" &&
    typeof annotation?.message === "string" &&
    expectedPrefixes.filter((prefix) => annotation.message.startsWith(prefix))
      .length === 1
  );
}

export async function inspectTrustedGate({
  api,
  owner,
  repo,
  headSha,
  checkRuns,
  expectedEvent = "pull_request",
  number,
  repositoryPolicy,
}) {
  if (!validSha(headSha))
    throw new Error("invalid trusted-gate recovery head SHA");
  const gateRuns = trustedGateCheckRuns(checkRuns);
  if (gateRuns.length === 0) return { outcome: "trusted-gate-pending" };
  const verified = [];
  for (const checkRun of gateRuns) {
    verified.push(
      await verifyTrustedGateCheck({
        api,
        owner,
        repo,
        headSha,
        checkRun,
        expectedEvent,
        repositoryPolicy,
      }),
    );
  }
  const current = selectCurrentTrustedGateRun(verified);
  if (verified.some(({ sourceRevisionVerified }) => !sourceRevisionVerified)) {
    return { outcome: "trusted-gate-provenance-unverified" };
  }
  if (current.checkRun.status !== "completed") {
    return { outcome: "trusted-gate-pending" };
  }
  if (current.checkRun.conclusion === "success") {
    return { outcome: "trusted-gate-success" };
  }
  const { checkRun, run } = current;
  if (!["failure", "timed_out"].includes(checkRun.conclusion)) {
    throw new Error(
      `LCV Trusted Gate concluded ${checkRun.conclusion ?? "without conclusion"}`,
    );
  }
  if (checkRun.conclusion === "failure" && Number.isInteger(number)) {
    const annotations = await api.pages(
      `/repos/${owner}/${repo}/check-runs/${checkRun.id}/annotations`,
    );
    if (
      isRecoverableBotReviewVetoFailure({
        current,
        annotations,
        owner,
        repo,
        number,
        headSha,
      })
    ) {
      return {
        outcome: "trusted-gate-bot-veto-rerun-needed",
        checkRunId: checkRun.id,
        run,
      };
    }
  }
  return { outcome: "trusted-gate-failed", checkRunId: checkRun.id, run };
}

export function allCommitsVerified(commits, headSha) {
  if (!Array.isArray(commits) || commits.length === 0) {
    return { ok: false, reason: "no commits were returned" };
  }
  if (commits.at(-1)?.sha !== headSha) {
    return { ok: false, reason: "last commit does not match the exact head" };
  }
  for (const commit of commits) {
    if (!validSha(commit?.sha))
      return { ok: false, reason: "a commit has an invalid SHA" };
    if (commit?.commit?.verification?.verified !== true) {
      return { ok: false, reason: `commit ${commit.sha} is not verified` };
    }
  }
  return { ok: true };
}

export function selectAssociatedPullRequests(pulls, fullRepository, policy) {
  if (!Array.isArray(pulls) || pulls.length === 0) {
    throw new Error("merge group has no associated pull request");
  }
  const seen = new Set();
  for (const pullRequest of pulls) {
    if (seen.has(pullRequest.number)) {
      throw new Error(
        `merge group returned duplicate pull request #${pullRequest.number}`,
      );
    }
    seen.add(pullRequest.number);
    const trusted = isTrustedPullRequest(pullRequest, fullRepository, policy);
    if (!trusted.ok)
      throw new Error(`#${pullRequest.number}: ${trusted.reason}`);
  }
  return pulls;
}

export function validateMergeQueueEvidence({
  queue,
  pulls,
  groupHead,
  groupBase,
}) {
  if (!queue) throw new Error("main has no merge queue");
  if (
    queue.configuration?.maximumEntriesToBuild !== 1 ||
    queue.configuration?.maximumEntriesToMerge !== 1
  ) {
    throw new Error(
      "merge queue must use maximumEntriesToBuild=1 and maximumEntriesToMerge=1",
    );
  }
  if (pulls.length !== 1)
    throw new Error("merge group must contain exactly one pull request");
  const [pullRequest] = pulls;
  const matching = (queue.entries?.nodes ?? []).filter(
    (entry) => entry?.pullRequest?.number === pullRequest.number,
  );
  if (matching.length !== 1) {
    throw new Error(
      "merge group does not map to exactly one merge-queue entry",
    );
  }
  const [entry] = matching;
  if (entry?.baseCommit?.oid !== groupBase) {
    throw new Error("merge-queue entry base does not match the event base");
  }
  if (entry?.headCommit?.oid !== groupHead) {
    throw new Error(
      "merge-queue entry head does not match the synthetic group head",
    );
  }
  if (entry?.pullRequest?.headRefOid !== pullRequest.head.sha) {
    throw new Error("merge-queue pull-request head changed");
  }
  if (entry?.pullRequest?.baseRefName !== "main") {
    throw new Error("merge-queue pull request does not target main");
  }
  if (entry?.state === "UNMERGEABLE") {
    throw new Error("merge-queue entry is unmergeable");
  }
  return entry;
}

export function buildEnqueueInput(pullRequestId, headSha) {
  if (typeof pullRequestId !== "string" || !pullRequestId) {
    throw new Error("pull request node id is required");
  }
  if (!validSha(headSha)) throw new Error("invalid enqueue head SHA");
  return { pullRequestId, expectedHeadOid: headSha, jump: false };
}

export class GitHubApi {
  constructor(token, fetchImplementation = globalThis.fetch) {
    if (!token) throw new Error("TOKEN is required");
    this.token = token;
    this.fetch = fetchImplementation;
  }

  async request(
    path,
    { method = "GET", body, retryRead = method === "GET" } = {},
  ) {
    const url = path.startsWith("http")
      ? path
      : `https://api.github.com${path}`;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      let response;
      try {
        response = await this.fetch(url, {
          method,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${this.token}`,
            "X-GitHub-Api-Version": API_VERSION,
            "User-Agent": "lcv-trusted-pr-automation",
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch {
        if (retryRead && attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 250));
          continue;
        }
        throw new Error(`GitHub API ${method} ${path} had a transport failure`);
      }

      const text = await response.text();
      let parsed;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      if (response.ok) return parsed;

      const rateLimited =
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers?.get?.("x-ratelimit-remaining") === "0" ||
            response.headers?.get?.("retry-after")));
      const transient =
        response.status === 408 || response.status >= 500 || rateLimited;
      if (retryRead && transient && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 250));
        continue;
      }
      const message =
        typeof parsed === "object" ? parsed?.message : String(parsed);
      throw new Error(
        `GitHub API ${method} ${path} failed (${response.status}): ${message}`,
      );
    }
    throw new Error(`GitHub API ${method} ${path} exhausted read retries`);
  }

  async pages(path, { extract = (value) => value, maxPages = 10 } = {}) {
    const separator = path.includes("?") ? "&" : "?";
    const collected = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const payload = await this.request(
        `${path}${separator}per_page=100&page=${page}`,
      );
      const values = extract(payload);
      if (!Array.isArray(values))
        throw new Error(`paginated endpoint ${path} was not an array`);
      collected.push(...values);
      if (values.length < 100) return collected;
    }
    throw new Error(
      `paginated endpoint ${path} exceeded ${maxPages * 100} records`,
    );
  }

  graphql(query, variables) {
    return this.request("/graphql", {
      method: "POST",
      body: { query, variables },
      retryRead: !/^\s*mutation\b/i.test(query),
    }).then((payload) => {
      if (payload?.errors?.length) {
        throw new Error(
          `GitHub GraphQL failed: ${payload.errors.map((error) => error.message).join("; ")}`,
        );
      }
      return payload?.data;
    });
  }
}

async function loadPolicy() {
  const raw = JSON.parse(
    await readFile(new URL("./policy.json", import.meta.url), "utf8"),
  );
  return validatePolicy(raw);
}

export async function readBotReviewEvidence(api, owner, repo, number) {
  const query = `
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          number
          state
          isDraft
          headRefOid
          baseRefOid
          baseRefName
          comments(first: 100) {
            nodes {
              databaseId
              body
              createdAt
              updatedAt
              author {
                __typename
                login
                ... on User { databaseId id }
                ... on Bot { databaseId id }
              }
            }
            pageInfo { hasNextPage }
          }
          reviews(first: 100) {
            nodes {
              databaseId
              body
              state
              submittedAt
              commit { oid }
              author {
                __typename
                login
                ... on User { databaseId id }
                ... on Bot { databaseId id }
              }
            }
            pageInfo { hasNextPage }
          }
          reviewThreads(first: 100) {
            nodes {
              isResolved
              isOutdated
              comments(first: 100) {
                nodes {
                  author {
                    __typename
                    login
                    ... on User { databaseId id }
                    ... on Bot { databaseId id }
                  }
                  body
                  createdAt
                  commit { oid }
                  originalCommit { oid }
                  pullRequestReview { databaseId commit { oid } }
                }
                pageInfo { hasNextPage }
              }
            }
            pageInfo { hasNextPage }
          }
        }
      }
    }`;
  const data = await api.graphql(query, { owner, repo, number });
  const pullRequest = data?.repository?.pullRequest;
  const comments = pullRequest?.comments;
  const reviews = pullRequest?.reviews;
  const threads = pullRequest?.reviewThreads;
  const validConnection = (connection) =>
    connection &&
    typeof connection === "object" &&
    Array.isArray(connection.nodes) &&
    typeof connection.pageInfo?.hasNextPage === "boolean";
  if (
    !Number.isInteger(pullRequest?.number) ||
    !validSha(pullRequest?.headRefOid) ||
    !validSha(pullRequest?.baseRefOid) ||
    typeof pullRequest?.baseRefName !== "string" ||
    typeof pullRequest?.state !== "string" ||
    typeof pullRequest?.isDraft !== "boolean" ||
    !validConnection(comments) ||
    !validConnection(reviews) ||
    !validConnection(threads) ||
    threads.nodes.some(
      (thread) =>
        typeof thread?.isResolved !== "boolean" ||
        !validConnection(thread?.comments),
    )
  ) {
    throw new Error(`#${number}: BOT_EVIDENCE_INVALID`);
  }
  if (
    comments.pageInfo?.hasNextPage ||
    reviews.pageInfo?.hasNextPage ||
    threads.pageInfo?.hasNextPage ||
    (threads.nodes ?? []).some(
      (thread) => thread.comments?.pageInfo?.hasNextPage,
    )
  ) {
    throw new Error(`#${number}: BOT_EVIDENCE_TRUNCATED`);
  }
  return {
    pullRequest: {
      number: pullRequest.number,
      state: pullRequest.state,
      isDraft: pullRequest.isDraft,
      headRefOid: pullRequest.headRefOid,
      baseRefOid: pullRequest.baseRefOid,
      baseRefName: pullRequest.baseRefName,
    },
    issueComments: (comments.nodes ?? []).map((comment) => ({
      id: comment.databaseId,
      user: comment.author,
      body: comment.body,
      created_at: comment.createdAt,
      updated_at: comment.updatedAt,
    })),
    reviews: (reviews.nodes ?? []).map((review) => ({
      id: review.databaseId,
      user: review.author,
      state: review.state,
      commit_id: review.commit?.oid ?? null,
      body: review.body,
      submitted_at: review.submittedAt,
    })),
    threads: (threads.nodes ?? []).map((thread) => ({
      ...thread,
      comments: (thread.comments?.nodes ?? []).map((comment) => ({
        ...comment,
        reviewId: comment.pullRequestReview?.databaseId ?? null,
        reviewCommit: comment.pullRequestReview?.commit ?? null,
      })),
    })),
  };
}

export async function readCheckEvidence(api, owner, repo, sha) {
  const [checkRuns, statuses] = await Promise.all([
    api.pages(`/repos/${owner}/${repo}/commits/${sha}/check-runs?filter=all`, {
      extract: (payload) => payload?.check_runs,
    }),
    api.pages(`/repos/${owner}/${repo}/commits/${sha}/statuses`),
  ]);
  return { checkRuns, statuses };
}

async function readPullEvidence(api, owner, repo, number) {
  const [pullRequest, botEvidence, commits] = await Promise.all([
    api.request(`/repos/${owner}/${repo}/pulls/${number}`),
    readBotReviewEvidence(api, owner, repo, number),
    api.pages(`/repos/${owner}/${repo}/pulls/${number}/commits`),
  ]);
  return {
    pullRequest,
    issueComments: botEvidence.issueComments,
    reviews: botEvidence.reviews,
    threads: botEvidence.threads,
    botSnapshotPullRequest: botEvidence.pullRequest,
    commits,
  };
}

async function currentMain(api, owner, repo) {
  const branch = await api.request(`/repos/${owner}/${repo}/branches/main`);
  if (!validSha(branch?.commit?.sha))
    throw new Error(`${repo}: main SHA unavailable`);
  return branch.commit.sha;
}

export async function assessPullCore({ api, owner, repo, number, policy }) {
  const fullRepository = `${owner}/${repo}`;
  const evidence = await readPullEvidence(api, owner, repo, number);
  const trusted = isTrustedPullRequest(
    evidence.pullRequest,
    fullRepository,
    policy,
  );
  if (!trusted.ok) throw new Error(`${repo}#${number}: ${trusted.reason}`);
  if (
    evidence.botSnapshotPullRequest?.number !== evidence.pullRequest.number ||
    evidence.botSnapshotPullRequest?.state !== "OPEN" ||
    evidence.botSnapshotPullRequest?.isDraft !== evidence.pullRequest.draft ||
    evidence.botSnapshotPullRequest?.headRefOid !==
      evidence.pullRequest.head.sha ||
    evidence.botSnapshotPullRequest?.baseRefOid !==
      evidence.pullRequest.base.sha ||
    evidence.botSnapshotPullRequest?.baseRefName !==
      evidence.pullRequest.base.ref
  ) {
    throw new Error(`${repo}#${number}: BOT_EVIDENCE_SNAPSHOT_MISMATCH`);
  }

  const mainSha = await currentMain(api, owner, repo);

  const commits = allCommitsVerified(
    evidence.commits,
    evidence.pullRequest.head.sha,
  );
  if (!commits.ok) throw new Error(`${repo}#${number}: ${commits.reason}`);
  const connector = evaluateConnectorEvidence({
    headSha: evidence.pullRequest.head.sha,
    issueComments: evidence.issueComments,
    reviews: evidence.reviews,
    threads: evidence.threads,
    policy,
  });
  const copilot = evaluateCopilotEvidence({
    headSha: evidence.pullRequest.head.sha,
    reviews: evidence.reviews,
    threads: evidence.threads,
    policy,
  });
  const negative = [connector, copilot].filter((result) => !result.ok);
  const nonrecoverable = negative.find(
    (result) => result.recoveryCode === undefined,
  );
  const veto = nonrecoverable ?? negative[0];
  if (veto) {
    const message = `${repo}#${number}@${evidence.pullRequest.head.sha}: ${veto.reason}`;
    if (veto === copilot || veto.botVeto) {
      throw new BotReviewVetoError(message, veto.recoveryCode);
    }
    throw new Error(message);
  }
  return {
    ...evidence,
    mainSha,
  };
}

export async function finalizePullTrustBoundary({
  expectedHead,
  expectedBase,
  label,
  reassess,
  scanCode,
  recheckChecks,
}) {
  if (!validSha(expectedHead) || typeof reassess !== "function") {
    throw new Error("invalid final pull-trust boundary");
  }
  if (expectedBase !== undefined && !validSha(expectedBase)) {
    throw new Error("invalid final pull-trust base");
  }
  if (
    typeof label !== "string" ||
    !label ||
    typeof scanCode !== "function" ||
    typeof recheckChecks !== "function"
  ) {
    throw new Error("invalid final pull-trust callbacks");
  }
  const assertBoundary = (evidence) => {
    if (evidence?.pullRequest?.head?.sha !== expectedHead) {
      throw new Error(`${label}: head changed at final trust boundary`);
    }
    if (expectedBase !== undefined && evidence?.mainSha !== expectedBase) {
      throw new Error(`${label}: base changed at final trust boundary`);
    }
    return evidence;
  };

  assertBoundary(await reassess());
  const checksBeforeScan = await recheckChecks();
  if (typeof checksBeforeScan !== "string" || !checksBeforeScan) {
    throw new Error(`${label}: check inventory fingerprint is invalid`);
  }
  await scanCode();
  const finalEvidence = assertBoundary(await reassess());
  const checksAfterScan = await recheckChecks();
  if (checksAfterScan !== checksBeforeScan) {
    throw new Error(
      `${label}: exact-SHA check inventory changed while code scanning was verified`,
    );
  }
  return finalEvidence;
}

function gateTiming() {
  const timeoutSeconds = Number(
    process.env.LCV_GATE_TIMEOUT_SECONDS ?? DEFAULT_TIMEOUT_SECONDS,
  );
  const pollSeconds = Number(
    process.env.LCV_GATE_POLL_SECONDS ?? DEFAULT_POLL_SECONDS,
  );
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) {
    throw new Error("LCV_GATE_TIMEOUT_SECONDS must be a nonnegative number");
  }
  if (!Number.isFinite(pollSeconds) || pollSeconds <= 0) {
    throw new Error("LCV_GATE_POLL_SECONDS must be a positive number");
  }
  return { deadline: Date.now() + timeoutSeconds * 1000, pollSeconds };
}

export async function readExactPullCore(options, assess = assessPullCore) {
  const evidence = await assess(options);
  if (
    options.expectedHead !== undefined &&
    evidence?.pullRequest?.head?.sha !== options.expectedHead
  ) {
    throw new StaleHeadError(
      `${options.repo}#${options.number}: head changed at exact-head evidence read`,
    );
  }
  return evidence;
}

export async function waitForGateEvidence({
  api,
  owner,
  repo,
  sha,
  requiredChecks,
  timing,
}) {
  while (true) {
    const checks = await readCheckEvidence(api, owner, repo, sha);
    const result = classifyChecks({ ...checks, requiredChecks });
    if (result.state === "failure") throw new Error(result.reasons.join("; "));
    if (result.state === "success") return;
    if (Date.now() >= timing.deadline) {
      throw new Error(
        `checks did not become green before timeout: ${result.reasons.join("; ")}`,
      );
    }
    await new Promise((resolve) =>
      setTimeout(resolve, timing.pollSeconds * 1000),
    );
  }
}

async function requireGateEvidenceNow({
  api,
  owner,
  repo,
  sha,
  requiredChecks,
}) {
  const checks = await readCheckEvidence(api, owner, repo, sha);
  const result = classifyChecks({ ...checks, requiredChecks });
  if (result.state !== "success") {
    throw new Error(
      `final exact-SHA check inventory is ${result.state}: ${result.reasons.join("; ")}`,
    );
  }
  return checkEvidenceFingerprint(checks);
}

async function runPullRequestGate({ api, event, owner, repo, policy }) {
  const eventHead = event?.pull_request?.head?.sha;
  if (!validSha(eventHead))
    throw new Error("pull_request event has no valid head SHA");
  const number = event?.pull_request?.number;
  const timing = gateTiming();
  const evidence = await readExactPullCore({
    api,
    owner,
    repo,
    number,
    policy,
    expectedHead: eventHead,
  });
  if (evidence.pullRequest.head.sha !== eventHead) {
    throw new Error(`${repo}#${number}: event head is stale`);
  }
  await waitForGateEvidence({
    api,
    owner,
    repo,
    sha: eventHead,
    requiredChecks: requiredChecksForPhase(
      policy.repositories[repo],
      "pull_request",
    ),
    timing,
  });
  await finalizePullTrustBoundary({
    expectedHead: eventHead,
    label: `${repo}#${number}`,
    reassess: () => assessPullCore({ api, owner, repo, number, policy }),
    scanCode: () =>
      verifyCodeScanningAfterChecks({
        api,
        owner,
        repo,
        number,
        checkState: "success",
      }),
    recheckChecks: () =>
      requireGateEvidenceNow({
        api,
        owner,
        repo,
        sha: eventHead,
        requiredChecks: requiredChecksForPhase(
          policy.repositories[repo],
          "pull_request",
        ),
      }),
  });
  console.log(`${repo}#${number}@${eventHead}: trusted gate passed`);
}

async function mergeQueueEvidence(api, owner, repo) {
  const query = `
    query($owner: String!, $repo: String!) {
      repository(owner: $owner, name: $repo) {
        mergeQueue(branch: "main") {
          configuration { maximumEntriesToBuild maximumEntriesToMerge }
          entries(first: 100) {
            totalCount
            nodes {
              id
              state
              baseCommit { oid }
              headCommit { oid }
              pullRequest { number headRefOid baseRefOid baseRefName }
            }
            pageInfo { hasNextPage }
          }
        }
      }
    }`;
  const data = await api.graphql(query, { owner, repo });
  const queue = data?.repository?.mergeQueue;
  if (queue?.entries?.pageInfo?.hasNextPage) {
    throw new Error(`${repo}: merge queue exceeded 100 entries`);
  }
  return queue;
}

async function runMergeGroupGate({ api, event, owner, repo, policy }) {
  const groupHead = event?.merge_group?.head_sha;
  const groupBase = event?.merge_group?.base_sha;
  if (!validSha(groupHead) || !validSha(groupBase)) {
    throw new Error("merge_group event has invalid head/base SHA");
  }
  const timing = gateTiming();
  if ((await currentMain(api, owner, repo)) !== groupBase) {
    throw new Error(`${repo}: merge-group base is no longer current main`);
  }
  const associated = await api.pages(
    `/repos/${owner}/${repo}/commits/${groupHead}/pulls`,
  );
  const pulls = selectAssociatedPullRequests(
    associated,
    `${owner}/${repo}`,
    policy,
  );
  const queue = await mergeQueueEvidence(api, owner, repo);
  validateMergeQueueEvidence({ queue, pulls, groupHead, groupBase });
  for (const pullRequest of pulls) {
    const evidence = await readExactPullCore({
      api,
      owner,
      repo,
      number: pullRequest.number,
      policy,
      expectedHead: pullRequest.head.sha,
    });
    if (evidence.pullRequest.head.sha !== pullRequest.head.sha) {
      throw new Error(`${repo}#${pullRequest.number}: associated head changed`);
    }
    const comparison = await api.request(
      `/repos/${owner}/${repo}/compare/${pullRequest.head.sha}...${groupHead}`,
    );
    if (
      comparison?.behind_by !== 0 ||
      comparison?.merge_base_commit?.sha !== pullRequest.head.sha
    ) {
      throw new Error(
        `${repo}#${pullRequest.number}: head is not included in merge-group head`,
      );
    }
  }
  await waitForGateEvidence({
    api,
    owner,
    repo,
    sha: groupHead,
    requiredChecks: requiredChecksForPhase(
      policy.repositories[repo],
      "merge_group",
    ),
    timing,
  });
  for (const pullRequest of pulls) {
    await finalizePullTrustBoundary({
      expectedHead: pullRequest.head.sha,
      expectedBase: groupBase,
      label: `${repo}#${pullRequest.number}`,
      reassess: () =>
        assessPullCore({
          api,
          owner,
          repo,
          number: pullRequest.number,
          policy,
        }),
      scanCode: () =>
        verifyCodeScanningAfterChecks({
          api,
          owner,
          repo,
          number: pullRequest.number,
          checkState: "success",
        }),
      recheckChecks: () =>
        requireGateEvidenceNow({
          api,
          owner,
          repo,
          sha: groupHead,
          requiredChecks: requiredChecksForPhase(
            policy.repositories[repo],
            "merge_group",
          ),
        }),
    });
  }
  console.log(
    `${repo}@${groupHead}: trusted merge-group gate passed for ${pulls.length} PR(s)`,
  );
}

async function runGate(api, policy) {
  const repository = process.env.GITHUB_REPOSITORY;
  const [owner, repo, extra] = repository?.split("/") ?? [];
  if (
    !owner ||
    !repo ||
    extra ||
    owner !== policy.organization ||
    !policy.repositories[repo]
  ) {
    throw new Error(
      `repository is not covered by trusted policy: ${repository ?? "unknown"}`,
    );
  }
  const event = JSON.parse(
    await readFile(process.env.GITHUB_EVENT_PATH, "utf8"),
  );
  if (process.env.GITHUB_EVENT_NAME === "pull_request") {
    return runPullRequestGate({ api, event, owner, repo, policy });
  }
  if (process.env.GITHUB_EVENT_NAME === "merge_group") {
    return runMergeGroupGate({ api, event, owner, repo, policy });
  }
  throw new Error(
    `unsupported trusted-gate event: ${process.env.GITHUB_EVENT_NAME}`,
  );
}

async function pullQueueState(api, owner, repo, number) {
  const query = `
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          id
          state
          isDraft
          headRefOid
          baseRefOid
          baseRefName
          mergeQueue { id }
          mergeQueueEntry { id state }
        }
      }
    }`;
  const data = await api.graphql(query, { owner, repo, number });
  return data?.repository?.pullRequest;
}

async function enqueue(api, input) {
  const mutation = `
    mutation($input: EnqueuePullRequestInput!) {
      enqueuePullRequest(input: $input) {
        mergeQueueEntry { id state }
      }
    }`;
  return api.graphql(mutation, { input });
}

export function classifyPullRequestMergeability(pullRequest) {
  if (pullRequest?.mergeable == null) {
    return "pending";
  }
  if (typeof pullRequest.mergeable !== "boolean") {
    return "invalid";
  }
  if (pullRequest.mergeable === false) {
    return "conflict";
  }
  if (
    pullRequest.mergeable_state == null ||
    pullRequest.mergeable_state === "unknown"
  ) {
    return "pending";
  }
  if (pullRequest.mergeable_state === "dirty") return "conflict";
  if (
    ["clean", "has_hooks", "blocked", "behind", "unstable"].includes(
      pullRequest.mergeable_state,
    )
  ) {
    return "ready";
  }
  return "invalid";
}

export async function enqueueAfterFinalTrustAssessment({
  expectedHead,
  expectedBase,
  reassess,
  recheckChecks,
  scanCode,
  enqueueMutation,
}) {
  if (
    !validSha(expectedHead) ||
    !validSha(expectedBase) ||
    typeof reassess !== "function" ||
    typeof recheckChecks !== "function" ||
    typeof scanCode !== "function" ||
    typeof enqueueMutation !== "function"
  ) {
    throw new Error("invalid final enqueue boundary");
  }
  const assertBoundary = (evidence) => {
    if (evidence?.pullRequest?.head?.sha !== expectedHead) {
      throw new Error("pull-request head changed at final enqueue boundary");
    }
    if (evidence?.mainSha !== expectedBase) {
      throw new Error("main changed at final enqueue boundary");
    }
    if (classifyPullRequestMergeability(evidence?.pullRequest) !== "ready") {
      throw new Error("pull-request mergeability is not ready for enqueue");
    }
  };
  assertBoundary(await reassess());
  const checksBeforeScan = await recheckChecks();
  if (typeof checksBeforeScan !== "string" || !checksBeforeScan) {
    throw new Error("final enqueue check inventory fingerprint is invalid");
  }
  await scanCode();
  assertBoundary(await reassess());
  const checksAfterScan = await recheckChecks();
  if (checksAfterScan !== checksBeforeScan) {
    throw new Error(
      "exact-SHA check inventory changed while enqueue code scanning was verified",
    );
  }
  return enqueueMutation();
}

export async function requestResolvedBotReviewVetoRerun({
  api,
  owner,
  repo,
  number,
  expectedHead,
  expectedBase,
  gate,
  reassess,
  repositoryPolicy,
}) {
  if (
    gate?.outcome !== "trusted-gate-bot-veto-rerun-needed" ||
    !Number.isSafeInteger(gate?.run?.id) ||
    !Number.isInteger(number) ||
    !validSha(expectedHead) ||
    !validSha(expectedBase) ||
    typeof reassess !== "function"
  ) {
    throw new Error("invalid resolved bot-review veto rerun boundary");
  }
  const assertEvidence = (evidence) => {
    if (
      evidence?.pullRequest?.head?.sha !== expectedHead ||
      evidence?.mainSha !== expectedBase
    ) {
      throw new Error("bot-review veto rerun head/base changed");
    }
  };
  assertEvidence(await reassess());
  const run = await api.request(gate.run.url);
  const provenanceGate = repositoryPolicy?.provenance?.trusted_gate;
  const expectedWorkflowId =
    provenanceGate?.required_workflow_id ?? TRUSTED_GATE_SOURCE_WORKFLOW_ID;
  const expectedWorkflowUrl = provenanceGate
    ? `https://api.github.com/repos/${owner}/${repo}/actions/required_workflows/${expectedWorkflowId}`
    : expectedGateWorkflowUrl();
  const expectedWorkflowPath =
    provenanceGate?.source_workflow_path ?? TRUSTED_GATE_SOURCE_WORKFLOW_PATH;
  if (
    run?.id !== gate.run.id ||
    run?.url !== gate.run.url ||
    run?.head_sha !== expectedHead ||
    run?.event !== "pull_request" ||
    run?.run_attempt !== 1 ||
    run?.status !== "completed" ||
    run?.conclusion !== "failure" ||
    run?.check_suite_id !== gate.run.check_suite_id ||
    run?.repository?.full_name !== `${owner}/${repo}` ||
    run?.head_repository?.full_name !== `${owner}/${repo}` ||
    run?.workflow_id !== expectedWorkflowId ||
    run?.workflow_url !== expectedWorkflowUrl ||
    run?.path !== expectedWorkflowPath ||
    run?.workflow_id !== gate.run.workflow_id ||
    run?.workflow_url !== gate.run.workflow_url ||
    run?.path !== gate.run.path ||
    (provenanceGate &&
      (run?.repository?.id !== provenanceGate.repository_id ||
        run?.head_repository?.id !== provenanceGate.repository_id))
  ) {
    throw new Error("bot-review veto rerun identity changed");
  }
  assertEvidence(await reassess());
  await api.request(
    `/repos/${owner}/${repo}/actions/runs/${run.id}/rerun-failed-jobs`,
    { method: "POST" },
  );
  return "trusted-gate-bot-veto-rerun-requested";
}

export async function assessForEnqueue({
  api,
  owner,
  repo,
  pullRequest,
  policy,
  assess = assessPullCore,
}) {
  const evidence = await assess({
    api,
    owner,
    repo,
    number: pullRequest.number,
    policy,
  });
  if (evidence.pullRequest.head.sha !== pullRequest.head.sha) {
    throw new Error(`${repo}#${pullRequest.number}: listed head changed`);
  }
  const mergeability = classifyPullRequestMergeability(evidence.pullRequest);
  if (mergeability === "pending") {
    return { outcome: "mergeability-pending" };
  }
  if (mergeability === "invalid") {
    throw new Error(
      `${repo}#${pullRequest.number}: pull request mergeability is incoherent`,
    );
  }
  if (mergeability === "conflict") {
    const isDependabot =
      evidence.pullRequest.user?.login === "dependabot[bot]" &&
      evidence.pullRequest.user?.id === 49699333;
    if (!isDependabot) {
      throw new Error(
        `${repo}#${pullRequest.number}: pull request has merge conflicts`,
      );
    }
    const outcome = await ensureDependabotRebaseRequest({
      api,
      owner,
      repo,
      number: pullRequest.number,
      headSha: evidence.pullRequest.head.sha,
      expectedBase: evidence.mainSha,
      policy,
    });
    return { outcome };
  }
  const checks = await readCheckEvidence(
    api,
    owner,
    repo,
    evidence.pullRequest.head.sha,
  );
  const requiredChecks = requiredChecksForPhase(
    policy.repositories[repo],
    "pull_request",
  );
  const result = classifyChecks({ ...checks, requiredChecks });
  let checkOutcome;
  try {
    checkOutcome = controllerCheckOutcome(result);
  } catch (error) {
    throw new Error(`${repo}#${pullRequest.number}: ${error.message}`);
  }
  if (checkOutcome === "checks-pending") return { outcome: checkOutcome };
  const producerProvenance = await inspectRequiredCheckProducerProvenance({
    api,
    owner,
    repo,
    headSha: evidence.pullRequest.head.sha,
    expectedEvent: "pull_request",
    checkRuns: checks.checkRuns,
    requiredChecks,
    repositoryPolicy: policy.repositories[repo],
  });
  if (
    producerProvenance.outcome !== "required-check-producer-provenance-verified"
  ) {
    return { outcome: producerProvenance.outcome };
  }
  await verifyCodeScanningAfterChecks({
    api,
    owner,
    repo,
    number: pullRequest.number,
    checkState: "success",
  });
  const gateOutcome = await inspectTrustedGate({
    api,
    owner,
    repo,
    headSha: evidence.pullRequest.head.sha,
    checkRuns: checks.checkRuns,
    number: pullRequest.number,
    repositoryPolicy: policy.repositories[repo],
  });
  if (gateOutcome.outcome === "trusted-gate-bot-veto-rerun-needed") {
    return {
      outcome: await requestResolvedBotReviewVetoRerun({
        api,
        owner,
        repo,
        number: pullRequest.number,
        expectedHead: evidence.pullRequest.head.sha,
        expectedBase: evidence.mainSha,
        gate: gateOutcome,
        repositoryPolicy: policy.repositories[repo],
        reassess: () =>
          assess({
            api,
            owner,
            repo,
            number: pullRequest.number,
            policy,
          }),
      }),
    };
  }
  if (gateOutcome.outcome !== "trusted-gate-success") return gateOutcome;

  const queueState = await pullQueueState(api, owner, repo, pullRequest.number);
  if (!queueState)
    throw new Error(`${repo}#${pullRequest.number}: GraphQL PR unavailable`);
  if (queueState.mergeQueueEntry) return { outcome: "already-enqueued" };
  if (!queueState.mergeQueue) return { outcome: "no-merge-queue" };
  if (
    queueState.state !== "OPEN" ||
    queueState.isDraft !== false ||
    queueState.headRefOid !== evidence.pullRequest.head.sha ||
    queueState.baseRefOid !== evidence.mainSha ||
    queueState.baseRefName !== "main"
  ) {
    throw new Error(
      `${repo}#${pullRequest.number}: head/base changed at enqueue boundary`,
    );
  }
  const input = buildEnqueueInput(queueState.id, queueState.headRefOid);
  await enqueueAfterFinalTrustAssessment({
    expectedHead: queueState.headRefOid,
    expectedBase: queueState.baseRefOid,
    reassess: () =>
      assessPullCore({
        api,
        owner,
        repo,
        number: pullRequest.number,
        policy,
      }),
    recheckChecks: async () => {
      const finalChecks = await readCheckEvidence(
        api,
        owner,
        repo,
        queueState.headRefOid,
      );
      const finalResult = classifyChecks({
        ...finalChecks,
        requiredChecks,
      });
      if (finalResult.state !== "success") {
        throw new Error(
          `${repo}#${pullRequest.number}: final exact-SHA check inventory is ${finalResult.state}: ${finalResult.reasons.join("; ")}`,
        );
      }
      const finalProducerProvenance =
        await inspectRequiredCheckProducerProvenance({
          api,
          owner,
          repo,
          headSha: queueState.headRefOid,
          expectedEvent: "pull_request",
          checkRuns: finalChecks.checkRuns,
          requiredChecks,
          repositoryPolicy: policy.repositories[repo],
        });
      if (
        finalProducerProvenance.outcome !==
        "required-check-producer-provenance-verified"
      ) {
        throw new Error(
          `${repo}#${pullRequest.number}: ${finalProducerProvenance.outcome}`,
        );
      }
      const finalGate = await inspectTrustedGate({
        api,
        owner,
        repo,
        checkRuns: finalChecks.checkRuns,
        headSha: queueState.headRefOid,
        number: pullRequest.number,
        repositoryPolicy: policy.repositories[repo],
      });
      if (finalGate.outcome !== "trusted-gate-success") {
        throw new Error(
          `${repo}#${pullRequest.number}: final LCV Trusted Gate is ${finalGate.outcome}`,
        );
      }
      return checkEvidenceFingerprint(finalChecks);
    },
    scanCode: () =>
      verifyCodeScanningAfterChecks({
        api,
        owner,
        repo,
        number: pullRequest.number,
        checkState: "success",
      }),
    enqueueMutation: () => enqueue(api, input),
  });
  return { outcome: "enqueued" };
}

async function runController(api, policy) {
  if (
    process.env.GITHUB_REPOSITORY !== `${policy.organization}/.github` ||
    process.env.GITHUB_REF !== "refs/heads/main"
  ) {
    throw new Error(
      "controller may run only from LCV-Ideas-Software/.github main",
    );
  }
  const errors = [];
  for (const repo of Object.keys(policy.repositories).sort()) {
    let pulls;
    try {
      pulls = await api.pages(
        `/repos/${policy.organization}/${repo}/pulls?state=open&base=main`,
      );
    } catch (error) {
      errors.push(new Error(`${repo}: ${error.message}`));
      continue;
    }
    for (const pullRequest of pulls) {
      const trusted = isTrustedPullRequest(
        pullRequest,
        `${policy.organization}/${repo}`,
        policy,
      );
      if (!trusted.ok) {
        console.log(
          `${repo}#${pullRequest.number}: skipped (${trusted.reason})`,
        );
        continue;
      }
      try {
        const result = await assessForEnqueue({
          api,
          owner: policy.organization,
          repo,
          pullRequest,
          policy,
        });
        console.log(`${repo}#${pullRequest.number}: ${result.outcome}`);
      } catch (error) {
        errors.push(
          new Error(`${repo}#${pullRequest.number}: ${error.message}`),
        );
      }
    }
  }
  if (errors.length)
    throw new AggregateError(errors, "trusted PR controller failed closed");
}

async function main() {
  const policy = await loadPolicy();
  const api = new GitHubApi(process.env.TOKEN);
  if (process.env.LCV_MODE === "gate") return runGate(api, policy);
  if (process.env.LCV_MODE === "controller") return runController(api, policy);
  throw new Error("LCV_MODE must be gate or controller");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    if (process.env.LCV_MODE === "gate") {
      const command = botReviewVetoWorkflowCommand(error);
      if (command) console.error(command);
    }
    console.error(error instanceof AggregateError ? error.errors : error);
    process.exitCode = 1;
  });
}
