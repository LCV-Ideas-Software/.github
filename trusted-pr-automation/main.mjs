import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const ACTIONS_APP_ID = 15368;
export const CONNECTOR_APP_ID = 1144995;
export const CONNECTOR_ID = 199175422;
export const COPILOT_REVIEWER_ID = 175728472;
export const COPILOT_REVIEWER_NODE_ID = "BOT_kgDOCnlnWA";
export const LATE_REVIEW_TIMEOUT_ANNOTATION = "LCV_GATE_LATE_REVIEW_TIMEOUT";
export const TRUSTED_GATE_CHECK_NAME = "LCV Trusted Gate";
export const TRUSTED_GATE_SOURCE_REPOSITORY = "LCV-Ideas-Software/.github";
export const TRUSTED_GATE_SOURCE_WORKFLOW_ID = 329989853;
export const TRUSTED_GATE_SOURCE_WORKFLOW_PATH =
  ".github/workflows/trusted-pr-gate.yml";

const API_VERSION = "2026-03-10";
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const CONNECTOR_LOGINS = new Set([
  "chatgpt-codex-connector",
  "chatgpt-codex-connector[bot]",
]);
const COPILOT_REVIEWER_IDENTITY = Object.freeze({
  database_id: COPILOT_REVIEWER_ID,
  node_id: COPILOT_REVIEWER_NODE_ID,
  rest_review_login: "copilot-pull-request-reviewer[bot]",
  graphql_login: "copilot-pull-request-reviewer",
  inline_alias_login: "Copilot",
});
const COPILOT_CLEAN_COMPLETION_PATTERN =
  /^Copilot reviewed (\d+) out of (\d+) changed files? in this pull request and generated no(?: new)? comments?\.$/i;
const COPILOT_FINDING_COMPLETION_PATTERN =
  /^Copilot reviewed \d+ out of \d+ changed files? in this pull request and generated [1-9]\d* (?:new )?comments?\.$/i;
const COPILOT_UNREVIEWABLE_COMPLETION =
  "Copilot wasn't able to review any files in this pull request.";
const COPILOT_TRANSIENT_ERROR_COMPLETION =
  "Copilot encountered an error and was unable to review this pull request. You can try again by re-requesting a review.";
const COPILOT_EXCLUDED_BASENAMES = new Set([
  ".gitignore",
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "jest.config.js",
  "next.config.js",
  "tailwind.config.js",
  "tsconfig.json",
  "requirements.txt",
  "Pipfile.lock",
  "Gemfile.lock",
  "composer.lock",
  "Cargo.lock",
  "go.sum",
  "paket.lock",
  "pubspec.lock",
  "stack.yaml",
  "elm.json",
  "Project.toml",
  "Manifest.toml",
  "renv.lock",
  "build.sbt",
  "Package.resolved",
  "deps.edn",
  "build.gradle",
  "mix.lock",
  "build.gradle.kts",
  "cpanfile",
  "Podfile.lock",
  "conanfile.txt",
  "info.rkt",
  "rockspec",
  "opam",
  "rebar.config",
  "nimble",
  "shard.yml",
  "dub.json",
  "dub.sdl",
  "GPR",
  "Mason.toml",
  "fpm.toml",
  "pack.pl",
  "baseline.st",
  "PacletInfo.m",
  "info.ss",
  "Jpkg",
  "box.json",
  "GNAVI.xml",
]);
const COPILOT_EXCLUDED_DIRECTORIES = new Set([
  "dist",
  "node_modules",
  "coverage",
  "out",
  "vendor",
  "generated",
  "generated-sources",
]);
const COPILOT_CHANGED_FILE_STATUSES = new Set([
  "added",
  "removed",
  "modified",
  "renamed",
  "copied",
  "changed",
  "unchanged",
]);
const CLEAN_REVIEW_PREFIX = "Codex Review: Didn't find any major issues.";
const REVIEW_REQUEST_MARKER = "LCV-TRUSTED-REVIEW-HEAD";
const DEPENDABOT_REBASE_MARKER = "LCV-DEPENDABOT-REBASE-HEAD";
const DEFAULT_POLL_SECONDS = 30;
const DEFAULT_TIMEOUT_SECONDS = 15 * 60;

class PendingEvidenceError extends Error {}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function validSha(value) {
  return typeof value === "string" && SHA_PATTERN.test(value);
}

function identityKey(login, id) {
  return `${login}:${id}`;
}

function checkKey(name, appId) {
  return `${name}@${appId}`;
}

function isConnector(actor) {
  return (
    (actor?.id === CONNECTOR_ID || actor?.databaseId === CONNECTOR_ID) &&
    CONNECTOR_LOGINS.has(actor?.login)
  );
}

function isConnectorApp(app) {
  return (
    app?.id === CONNECTOR_APP_ID && app?.slug === "chatgpt-codex-connector"
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

function validCopilotReviewPath(filename) {
  if (
    typeof filename !== "string" ||
    !filename ||
    filename.startsWith("/") ||
    filename.includes("\\")
  ) {
    return false;
  }
  const segments = filename.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return false;
  }
  return true;
}

export function isCopilotReviewExcludedPath(filename) {
  if (!validCopilotReviewPath(filename)) return false;
  const segments = filename.split("/");
  const basename = segments.at(-1);
  if (COPILOT_EXCLUDED_BASENAMES.has(basename)) return true;
  if (
    basename.endsWith(".svg") ||
    basename.endsWith(".log") ||
    basename.endsWith(".lock") ||
    basename.endsWith(".ipynb.raw.html") ||
    basename.endsWith(".min.js") ||
    basename.endsWith(".d.ts") ||
    basename.endsWith(".bundle.js") ||
    basename.endsWith(".map")
  ) {
    return true;
  }
  if (segments.some((segment) => COPILOT_EXCLUDED_DIRECTORIES.has(segment))) {
    return true;
  }
  const binIndex = segments.lastIndexOf("bin");
  if (binIndex === -1 || binIndex === segments.length - 1) return false;
  if (basename.endsWith(".rs")) return false;
  const hybrisCustom = segments.some(
    (segment, index) =>
      segment === "hybris" &&
      segments[index + 1] === "bin" &&
      segments[index + 2] === "custom" &&
      index + 3 < segments.length,
  );
  return !hybrisCustom;
}

function isCopilotReviewExcludedFile(file) {
  if (!file || typeof file !== "object" || Array.isArray(file)) return false;
  if (!COPILOT_CHANGED_FILE_STATUSES.has(file.status)) return false;
  if (!isCopilotReviewExcludedPath(file.filename)) return false;
  if (file.status === "renamed") {
    return isCopilotReviewExcludedPath(file.previous_filename);
  }
  if (file.previous_filename !== undefined) {
    return isCopilotReviewExcludedPath(file.previous_filename);
  }
  return true;
}

function copilotChangedFileEvidence(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: false, reason: "Copilot changed-file evidence is empty" };
  }
  for (const file of files) {
    if (
      !file ||
      typeof file !== "object" ||
      Array.isArray(file) ||
      !COPILOT_CHANGED_FILE_STATUSES.has(file.status) ||
      !validCopilotReviewPath(file.filename) ||
      (file.status === "renamed" &&
        !validCopilotReviewPath(file.previous_filename)) ||
      (file.previous_filename !== undefined &&
        !validCopilotReviewPath(file.previous_filename))
    ) {
      return {
        ok: false,
        reason: "Copilot changed-file evidence is malformed",
      };
    }
  }
  return {
    ok: true,
    total: files.length,
    reviewable: files.filter((file) => !isCopilotReviewExcludedFile(file))
      .length,
  };
}

function suppressedCopilotCommentCount(body) {
  if (typeof body !== "string") return { ok: true, count: 0 };
  const label =
    "(?:Suppressed comments|Comments suppressed due to low confidence)";
  const summaryPattern = new RegExp(
    `^<summary>\\s*${label}\\s*\\(\\s*(\\d+)\\s*\\)\\s*</summary>$`,
    "i",
  );
  const linePattern = new RegExp(`^${label}\\s*\\(\\s*(\\d+)\\s*\\)$`, "i");
  const labelPattern = new RegExp(label, "i");
  const standaloneCandidatePattern = new RegExp(
    `^${label}(?:\\s*\\(|\\s*$)`,
    "i",
  );
  const structuralLines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        (line.toLowerCase().includes("<summary") && labelPattern.test(line)) ||
        standaloneCandidatePattern.test(line),
    );
  if (structuralLines.length === 0) return { ok: true, count: 0 };
  if (structuralLines.length !== 1) return { ok: false };
  const match =
    structuralLines[0].match(summaryPattern) ??
    structuralLines[0].match(linePattern);
  if (!match) return { ok: false };
  const count = Number(match[1]);
  return Number.isSafeInteger(count) ? { ok: true, count } : { ok: false };
}

function timestamp(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
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
  if (pullRequest?.draft)
    return { ok: false, reason: "draft pull request is not trusted" };
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

function reviewedCommit(body) {
  if (typeof body !== "string" || !body.startsWith(CLEAN_REVIEW_PREFIX))
    return null;
  const match = body.match(/\*\*Reviewed commit:\*\*\s+`([0-9a-f]{10,40})`/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function evidenceValue(collection, key) {
  return collection instanceof Map ? collection.get(key) : collection?.[key];
}

export function evaluateConnectorEvidence({
  headSha,
  issueComments,
  reviews,
  threads,
  resolvedReviewCommits,
  requestReactions,
  policy,
}) {
  if (!validSha(headSha))
    return { ok: false, reason: "invalid connector evidence head SHA" };
  const exactClean = [];
  let latestFindingAt = 0;

  for (const comment of issueComments ?? []) {
    if (isReviewRequestForHead(comment, headSha, policy)) {
      for (const reaction of evidenceValue(
        requestReactions,
        String(comment.id),
      ) ?? []) {
        if (reaction?.content === "+1" && isConnector(reaction.user)) {
          const reactedAt = timestamp(reaction.created_at);
          const requestCreatedAt = timestamp(comment.created_at);
          if (requestCreatedAt > 0 && reactedAt > requestCreatedAt) {
            exactClean.push(reactedAt);
          }
        }
      }
    }
    if (!isConnector(comment.user)) continue;
    const reviewed = reviewedCommit(comment.body);
    if (
      reviewed &&
      evidenceValue(resolvedReviewCommits, reviewed) === headSha &&
      isConnectorApp(comment.performed_via_github_app)
    ) {
      const reviewedAt = timestamp(comment.created_at);
      if (reviewedAt > 0) exactClean.push(reviewedAt);
    } else if (
      typeof comment.body === "string" &&
      comment.body.startsWith("Codex Review:")
    ) {
      latestFindingAt = Math.max(
        latestFindingAt,
        timestamp(comment.created_at),
      );
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
  for (const review of latestDecisiveReviews.values()) {
    if (review?.state === "CHANGES_REQUESTED") {
      return { ok: false, reason: "changes requested on the current head" };
    }
  }

  for (const review of reviews ?? []) {
    if (!isConnector(review?.user) || review?.commit_id !== headSha) continue;
    if (typeof review.body === "string" && review.body.trim()) {
      latestFindingAt = Math.max(
        latestFindingAt,
        timestamp(review.submitted_at),
      );
    }
  }

  for (const thread of threads ?? []) {
    const connectorComments = (thread.comments ?? []).filter((comment) =>
      isConnector(comment.author),
    );
    if (connectorComments.length === 0) continue;
    if (
      connectorComments.some((comment) => !validSha(comment?.reviewCommit?.oid))
    ) {
      return {
        ok: false,
        reason: "connector thread has no immutable review commit",
      };
    }
    if (!thread.isResolved) {
      return { ok: false, reason: "unresolved connector thread remains" };
    }
    const currentHeadComments = connectorComments.filter(
      (comment) => comment?.reviewCommit?.oid === headSha,
    );
    if (currentHeadComments.length === 0) continue;
    for (const comment of currentHeadComments) {
      latestFindingAt = Math.max(latestFindingAt, timestamp(comment.createdAt));
    }
  }

  if (exactClean.length === 0) {
    return {
      ok: false,
      reason: "no clean connector review exists for the exact head",
    };
  }
  if (Math.max(...exactClean) <= latestFindingAt) {
    return {
      ok: false,
      reason:
        "no clean connector review exists after the latest connector finding",
    };
  }
  return { ok: true, cleanAt: Math.max(...exactClean) };
}

export function evaluateCopilotEvidence({
  headSha,
  reviews,
  threads,
  files,
  policy,
}) {
  if (!validSha(headSha)) {
    return { ok: false, reason: "invalid Copilot evidence head SHA" };
  }

  const copilotReviews = (reviews ?? []).filter((review) =>
    isCopilotReviewer(review?.user, policy),
  );

  for (const thread of threads ?? []) {
    const copilotComments = (thread.comments ?? []).filter((comment) =>
      isCopilotReviewer(comment?.author, policy),
    );
    if (copilotComments.length === 0) continue;
    if (
      copilotComments.some((comment) => !validSha(comment?.reviewCommit?.oid))
    ) {
      return {
        ok: false,
        reason: "Copilot thread has no immutable review commit",
      };
    }
    if (
      copilotComments.some((comment) => {
        const sourceReview = copilotReviews.find(
          (review) => review?.id === comment?.reviewId,
        );
        return (
          !Number.isInteger(comment?.reviewId) ||
          sourceReview?.commit_id !== comment?.reviewCommit?.oid
        );
      })
    ) {
      return {
        ok: false,
        reason: "Copilot thread review identity is inconsistent",
      };
    }
    if (
      copilotComments.some((comment) => comment?.reviewCommit?.oid === headSha)
    ) {
      return {
        ok: false,
        reason: "Copilot finding exists on the current head",
      };
    }
    if (!thread.isResolved) {
      return {
        ok: false,
        reason: "unresolved Copilot review thread remains",
      };
    }
  }

  const exactReviews = copilotReviews
    .filter((review) => review?.commit_id === headSha)
    .sort((left, right) => Number(right?.id ?? 0) - Number(left?.id ?? 0));
  const exactReview = exactReviews[0];
  if (!exactReview) {
    return {
      ok: false,
      reason: "no Copilot review COMMENTED exists for the exact head",
    };
  }
  if (!Number.isInteger(exactReview.id)) {
    return {
      ok: false,
      reason: "Copilot exact-head review has no immutable identity",
    };
  }
  if (exactReview.state !== "COMMENTED") {
    return {
      ok: false,
      reason: "Copilot exact-head review has an unexpected state",
    };
  }

  for (const review of exactReviews) {
    const suppressed = suppressedCopilotCommentCount(review?.body);
    if (!suppressed.ok) {
      return {
        ok: false,
        reason:
          "Copilot exact-head review has malformed suppressed-comments metadata",
      };
    }
    if (suppressed.count > 0) {
      return {
        ok: false,
        reason: "suppressed Copilot finding exists on the current head",
      };
    }
    const reviewLines =
      typeof review?.body === "string"
        ? review.body.split(/\r?\n/).map((line) => line.trim())
        : [];
    if (
      reviewLines.some((line) => COPILOT_FINDING_COMPLETION_PATTERN.test(line))
    ) {
      return {
        ok: false,
        reason: "Copilot finding exists on the current head",
      };
    }
  }

  const lines =
    typeof exactReview.body === "string"
      ? exactReview.body
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
      : [];
  if (lines.includes(COPILOT_TRANSIENT_ERROR_COMPLETION)) {
    return {
      ok: false,
      reason: "Copilot review attempt failed for the exact head",
    };
  }

  if (lines.includes(COPILOT_UNREVIEWABLE_COMPLETION)) {
    const fileEvidence = copilotChangedFileEvidence(files);
    if (!fileEvidence.ok || fileEvidence.reviewable !== 0) {
      return {
        ok: false,
        reason: "Copilot could not review all changed files on the exact head",
      };
    }
    return { ok: true };
  }

  const fileEvidence = copilotChangedFileEvidence(files);
  if (!fileEvidence.ok) return fileEvidence;

  const completions = lines
    .map((line) => line.match(COPILOT_CLEAN_COMPLETION_PATTERN))
    .filter(Boolean);
  if (completions.length !== 1) {
    return {
      ok: false,
      reason: "Copilot exact-head review has an unrecognized completion body",
    };
  }
  const reviewed = Number(completions[0][1]);
  const changed = Number(completions[0][2]);
  if (
    !Number.isSafeInteger(reviewed) ||
    !Number.isSafeInteger(changed) ||
    reviewed <= 0 ||
    reviewed < fileEvidence.reviewable ||
    reviewed > changed ||
    changed !== fileEvidence.total
  ) {
    return {
      ok: false,
      reason: "Copilot review coverage does not match the exact-head diff",
    };
  }
  return { ok: true };
}

export function connectorFailureCanSettleWithoutHeadChange(reason) {
  return (
    typeof reason === "string" &&
    (reason.startsWith("no clean connector review") ||
      reason === "unresolved connector thread remains")
  );
}

export function copilotFailureCanSettleWithoutHeadChange(reason) {
  return (
    reason === "no Copilot review COMMENTED exists for the exact head" ||
    reason === "unresolved Copilot review thread remains"
  );
}

export function controllerCopilotDisposition(reason) {
  if (!copilotFailureCanSettleWithoutHeadChange(reason)) {
    throw new Error("Copilot blocker is not safely observable");
  }
  return reason === "no Copilot review COMMENTED exists for the exact head"
    ? "request-review"
    : `copilot-blocked: ${reason}`;
}

export function controllerConnectorDisposition(reason) {
  if (!connectorFailureCanSettleWithoutHeadChange(reason)) {
    throw new Error("connector blocker is not safely observable");
  }
  return reason.startsWith("no clean connector review")
    ? "request-review"
    : `connector-blocked: ${reason}`;
}

export function reviewRequestBody(headSha) {
  if (!validSha(headSha)) throw new Error("invalid review-request head SHA");
  return `@codex review\n\n<!-- ${REVIEW_REQUEST_MARKER}:${headSha} -->`;
}

function isReviewRequestForHead(comment, headSha, policy) {
  const expectedBody = `@codex review\n\n<!-- ${REVIEW_REQUEST_MARKER}:${headSha} -->`;
  const createdAt = timestamp(comment?.created_at);
  const updatedAt = timestamp(comment?.updated_at);
  return (
    Number.isInteger(comment?.id) &&
    createdAt > 0 &&
    updatedAt > 0 &&
    comment.created_at === comment.updated_at &&
    policy?.allowed_actors?.some(
      (allowed) =>
        allowed.login === comment?.user?.login &&
        allowed.id === comment?.user?.id,
    ) &&
    comment?.body === expectedBody
  );
}

export function hasReviewRequestForHead(issueComments, headSha, policy) {
  return (issueComments ?? []).some((comment) =>
    isReviewRequestForHead(comment, headSha, policy),
  );
}

export async function resolveConnectorReviewCommits({
  api,
  owner,
  repo,
  headSha,
  issueComments,
}) {
  if (!validSha(headSha))
    throw new Error(`${repo}: invalid review-resolution head SHA`);
  const prefixes = new Set();
  for (const comment of issueComments ?? []) {
    if (
      !isConnector(comment?.user) ||
      !isConnectorApp(comment?.performed_via_github_app)
    ) {
      continue;
    }
    const prefix = reviewedCommit(comment.body);
    if (prefix && headSha.toLowerCase().startsWith(prefix))
      prefixes.add(prefix);
  }
  const resolved = new Map();
  for (const prefix of prefixes) {
    const commit = await api.request(
      `/repos/${owner}/${repo}/commits/${prefix}`,
    );
    if (
      !validSha(commit?.sha) ||
      !commit.sha.toLowerCase().startsWith(prefix)
    ) {
      throw new Error(
        `${repo}: reviewed commit prefix ${prefix} did not resolve uniquely`,
      );
    }
    resolved.set(prefix, commit.sha);
  }
  return resolved;
}

async function readRequestReactions({
  api,
  owner,
  repo,
  headSha,
  issueComments,
  policy,
}) {
  const reactions = new Map();
  for (const comment of issueComments ?? []) {
    if (!isReviewRequestForHead(comment, headSha, policy)) continue;
    reactions.set(
      String(comment.id),
      await api.pages(
        `/repos/${owner}/${repo}/issues/comments/${comment.id}/reactions`,
      ),
    );
  }
  return reactions;
}

export async function ensureConnectorReviewRequest({
  api,
  owner,
  repo,
  number,
  headSha,
  issueComments,
  policy,
}) {
  if (hasReviewRequestForHead(issueComments, headSha, policy)) {
    return "connector-review-pending";
  }
  await api.request(`/repos/${owner}/${repo}/issues/${number}/comments`, {
    method: "POST",
    body: { body: reviewRequestBody(headSha) },
  });
  return "connector-review-requested";
}

export async function ensureCopilotReviewRequest({
  api,
  owner,
  repo,
  number,
  requestedReviewers,
  policy,
}) {
  if (
    (requestedReviewers ?? []).some((reviewer) =>
      isCopilotReviewer(reviewer, policy),
    )
  ) {
    return "copilot-review-pending";
  }
  await api.request(
    `/repos/${owner}/${repo}/pulls/${number}/requested_reviewers`,
    {
      method: "POST",
      body: { reviewers: [policy.copilot_reviewer.rest_review_login] },
    },
  );
  return "copilot-review-requested";
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
  issueComments,
  policy,
}) {
  const marker = `<!-- ${DEPENDABOT_REBASE_MARKER}:${headSha} -->`;
  const exists = (issueComments ?? []).some(
    (comment) =>
      policy.allowed_actors.some(
        (allowed) =>
          allowed.login === comment?.user?.login &&
          allowed.id === comment?.user?.id,
      ) && comment?.body?.includes(marker),
  );
  if (exists) return "dependabot-rebase-pending";
  await api.request(`/repos/${owner}/${repo}/issues/${number}/comments`, {
    method: "POST",
    body: { body: dependabotRebaseBody(headSha) },
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

export function inspectRequiredCheckProducerProvenance({
  checkRuns,
  requiredChecks,
}) {
  const latestRuns = [...latestCheckRunsBySuite(checkRuns).values()];
  const actionRequirements = (requiredChecks ?? []).filter(
    (required) => required?.app_id === ACTIONS_APP_ID,
  );
  if (actionRequirements.length === 0) {
    return { outcome: "required-check-producer-provenance-not-applicable" };
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

function expectedGateWorkflowUrl() {
  return `https://api.github.com/repos/${TRUSTED_GATE_SOURCE_REPOSITORY}/actions/workflows/${TRUSTED_GATE_SOURCE_WORKFLOW_ID}`;
}

async function verifyTrustedGateCheck({
  api,
  owner,
  repo,
  headSha,
  checkRun,
  expectedEvent,
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
  const workflowUrl = expectedGateWorkflowUrl();
  if (
    run?.id !== runId ||
    run?.url !== expectedRunUrl ||
    run?.check_suite_id !== checkSuiteId ||
    run?.head_sha !== headSha ||
    run?.event !== expectedEvent ||
    run?.name !== TRUSTED_GATE_CHECK_NAME ||
    run?.path !== TRUSTED_GATE_SOURCE_WORKFLOW_PATH ||
    run?.workflow_id !== TRUSTED_GATE_SOURCE_WORKFLOW_ID ||
    run?.workflow_url !== workflowUrl ||
    run?.repository?.full_name !== fullRepository ||
    run?.head_repository?.full_name !== fullRepository ||
    run?.status !== checkRun.status ||
    run?.conclusion !== checkRun.conclusion
  ) {
    throw new Error("LCV Trusted Gate workflow-run identity is inconsistent");
  }

  const workflow = await api.request(workflowUrl);
  if (
    workflow?.id !== TRUSTED_GATE_SOURCE_WORKFLOW_ID ||
    workflow?.name !== TRUSTED_GATE_CHECK_NAME ||
    workflow?.path !== TRUSTED_GATE_SOURCE_WORKFLOW_PATH ||
    workflow?.state !== "active" ||
    workflow?.url !== workflowUrl
  ) {
    throw new Error(
      "LCV Trusted Gate source workflow identity is inconsistent",
    );
  }
  // The current REST payload proves check -> job -> run -> central workflow,
  // but it does not expose job.workflow_sha for a ruleset-required run. Until
  // the .github-private canary supplies an observable, documented pin binding,
  // this bootstrap controller deliberately has no enqueue authority.
  return { checkRun, run, sourceRevisionVerified: false };
}

export async function inspectTrustedGate({
  api,
  owner,
  repo,
  headSha,
  checkRuns,
  expectedEvent = "pull_request",
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
      }),
    );
  }
  if (verified.some(({ sourceRevisionVerified }) => !sourceRevisionVerified)) {
    return { outcome: "trusted-gate-provenance-unverified" };
  }
  if (verified.some(({ checkRun }) => checkRun.status !== "completed")) {
    return { outcome: "trusted-gate-pending" };
  }
  const failures = verified.filter(
    ({ checkRun }) => checkRun.conclusion !== "success",
  );
  if (failures.length === 0) return { outcome: "trusted-gate-success" };
  if (failures.length !== 1) {
    throw new Error("multiple LCV Trusted Gate runs failed");
  }
  const [{ checkRun, run }] = failures;
  if (!["failure", "timed_out"].includes(checkRun.conclusion)) {
    throw new Error(
      `LCV Trusted Gate concluded ${checkRun.conclusion ?? "without conclusion"}`,
    );
  }
  return {
    outcome: "trusted-gate-rerun-needed",
    checkRunId: checkRun.id,
    run,
  };
}

function isExactLateReviewTimeoutAnnotation(annotation, repo, headSha) {
  if (annotation?.title !== LATE_REVIEW_TIMEOUT_ANNOTATION) return false;
  const prefix = `Exact-head bot review timed out for ${repo}#`;
  const suffix = ` at ${headSha}`;
  if (
    typeof annotation.message !== "string" ||
    !annotation.message.startsWith(prefix) ||
    !annotation.message.endsWith(suffix)
  ) {
    return false;
  }
  const pullNumber = annotation.message.slice(prefix.length, -suffix.length);
  return /^[1-9]\d*$/.test(pullNumber);
}

export async function recoverLateTrustedGate({
  api,
  owner,
  repo,
  headSha,
  cleanAt,
  checkRuns,
}) {
  const candidate = await inspectTrustedGate({
    api,
    owner,
    repo,
    checkRuns,
    headSha,
  });
  if (candidate.outcome !== "trusted-gate-rerun-needed")
    return candidate.outcome;
  const annotations = await api.pages(
    `/repos/${owner}/${repo}/check-runs/${candidate.checkRunId}/annotations`,
  );
  if (
    !annotations.some((annotation) =>
      isExactLateReviewTimeoutAnnotation(annotation, repo, headSha),
    )
  ) {
    throw new Error(
      "LCV Trusted Gate failure is not an attributable late-review timeout",
    );
  }
  const { run } = candidate;
  const completedAt = timestamp(run.updated_at ?? run.completed_at);
  if (!Number.isFinite(cleanAt) || cleanAt <= 0 || completedAt <= 0) {
    throw new Error("LCV Trusted Gate has invalid recovery timestamps");
  }
  if (run.run_attempt > 1) {
    if (run.status !== "completed") return "trusted-gate-rerun-pending";
    if (run.conclusion === "success") return "trusted-gate-rerun-pending";
    throw new Error(
      "LCV Trusted Gate late-review recovery was already exhausted",
    );
  }
  if (run.run_attempt !== 1 || run.status !== "completed") {
    throw new Error(
      "LCV Trusted Gate Actions run is not eligible for recovery",
    );
  }
  await api.request(
    `/repos/${owner}/${repo}/actions/runs/${run.id}/rerun-failed-jobs`,
    { method: "POST" },
  );
  return "trusted-gate-rerun-requested";
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

async function reviewThreads(api, owner, repo, number) {
  const query = `
    query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: 100, after: $cursor) {
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
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }`;
  const result = [];
  let cursor = null;
  for (let page = 0; page < 10; page += 1) {
    const data = await api.graphql(query, { owner, repo, number, cursor });
    const connection = data?.repository?.pullRequest?.reviewThreads;
    if (!connection)
      throw new Error(`#${number}: review threads were unavailable`);
    for (const thread of connection.nodes ?? []) {
      if (thread.comments?.pageInfo?.hasNextPage) {
        throw new Error(`#${number}: a review thread exceeded 100 comments`);
      }
      result.push({
        ...thread,
        comments: (thread.comments?.nodes ?? []).map((comment) => ({
          ...comment,
          reviewId: comment.pullRequestReview?.databaseId ?? null,
          reviewCommit: comment.pullRequestReview?.commit ?? null,
        })),
      });
    }
    if (!connection.pageInfo?.hasNextPage) return result;
    cursor = connection.pageInfo.endCursor;
  }
  throw new Error(`#${number}: review threads exceeded 1000 records`);
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

export async function readPullFiles({ api, owner, repo, number }) {
  return api.pages(`/repos/${owner}/${repo}/pulls/${number}/files`, {
    maxPages: 30,
  });
}

async function readPullEvidence(api, owner, repo, number, policy) {
  const [pullRequest, issueComments, reviews, threads, commits, files] =
    await Promise.all([
      api.request(`/repos/${owner}/${repo}/pulls/${number}`),
      api.pages(`/repos/${owner}/${repo}/issues/${number}/comments`),
      api.pages(`/repos/${owner}/${repo}/pulls/${number}/reviews`),
      reviewThreads(api, owner, repo, number),
      api.pages(`/repos/${owner}/${repo}/pulls/${number}/commits`),
      readPullFiles({ api, owner, repo, number }),
    ]);
  const [resolvedReviewCommits, requestReactions] = await Promise.all([
    resolveConnectorReviewCommits({
      api,
      owner,
      repo,
      headSha: pullRequest.head.sha,
      issueComments,
    }),
    readRequestReactions({
      api,
      owner,
      repo,
      headSha: pullRequest.head.sha,
      issueComments,
      policy,
    }),
  ]);
  return {
    pullRequest,
    issueComments,
    reviews,
    threads,
    commits,
    files,
    resolvedReviewCommits,
    requestReactions,
  };
}

async function currentMain(api, owner, repo) {
  const branch = await api.request(`/repos/${owner}/${repo}/branches/main`);
  if (!validSha(branch?.commit?.sha))
    throw new Error(`${repo}: main SHA unavailable`);
  return branch.commit.sha;
}

async function assessPullCore({
  api,
  owner,
  repo,
  number,
  policy,
  evidenceMayBePending = false,
}) {
  const fullRepository = `${owner}/${repo}`;
  const evidence = await readPullEvidence(api, owner, repo, number, policy);
  const trusted = isTrustedPullRequest(
    evidence.pullRequest,
    fullRepository,
    policy,
  );
  if (!trusted.ok) throw new Error(`${repo}#${number}: ${trusted.reason}`);

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
    resolvedReviewCommits: evidence.resolvedReviewCommits,
    requestReactions: evidence.requestReactions,
    policy,
  });
  let connectorPending;
  if (!connector.ok) {
    if (
      evidenceMayBePending &&
      connectorFailureCanSettleWithoutHeadChange(connector.reason)
    ) {
      connectorPending = connector.reason;
    } else {
      throw new Error(`${repo}#${number}: ${connector.reason}`);
    }
  }
  const copilot = evaluateCopilotEvidence({
    headSha: evidence.pullRequest.head.sha,
    reviews: evidence.reviews,
    threads: evidence.threads,
    files: evidence.files,
    policy,
  });
  let copilotPending;
  if (!copilot.ok) {
    if (
      evidenceMayBePending &&
      copilotFailureCanSettleWithoutHeadChange(copilot.reason)
    ) {
      copilotPending = copilot.reason;
    } else {
      throw new Error(`${repo}#${number}: ${copilot.reason}`);
    }
  }
  return {
    ...evidence,
    mainSha,
    connectorCleanAt: connector.cleanAt,
    connectorPending,
    copilotPending,
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

export function lateReviewTimeoutCommand({ repo, number, headSha }) {
  if (!repo || !Number.isInteger(number) || !validSha(headSha)) {
    throw new Error("invalid late-review timeout annotation identity");
  }
  return `::error title=${LATE_REVIEW_TIMEOUT_ANNOTATION}::Exact-head bot review timed out for ${repo}#${number} at ${headSha}`;
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

export async function waitForPullCore(
  options,
  timing,
  assess = assessPullCore,
) {
  while (true) {
    try {
      const evidence = await assess({
        ...options,
        evidenceMayBePending: true,
      });
      if (evidence.connectorPending) {
        throw new PendingEvidenceError(
          `${options.repo}#${options.number}: ${evidence.connectorPending}`,
        );
      }
      if (evidence.copilotPending) {
        throw new PendingEvidenceError(
          `${options.repo}#${options.number}: ${evidence.copilotPending}`,
        );
      }
      return evidence;
    } catch (error) {
      if (!(error instanceof PendingEvidenceError)) throw error;
      if (Date.now() >= timing.deadline) {
        console.error(
          lateReviewTimeoutCommand({
            repo: options.repo,
            number: options.number,
            headSha: options.expectedHead,
          }),
        );
        throw error;
      }
      console.log(`${error.message}; waiting for exact-head bot reviews`);
      await new Promise((resolve) =>
        setTimeout(resolve, timing.pollSeconds * 1000),
      );
    }
  }
}

async function waitForGateEvidence({
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
  const evidence = await waitForPullCore(
    {
      api,
      owner,
      repo,
      number,
      policy,
      expectedHead: eventHead,
    },
    timing,
  );
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
    const evidence = await waitForPullCore(
      {
        api,
        owner,
        repo,
        number: pullRequest.number,
        policy,
        expectedHead: pullRequest.head.sha,
      },
      timing,
    );
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

async function assessForEnqueue({ api, owner, repo, pullRequest, policy }) {
  const evidence = await assessPullCore({
    api,
    owner,
    repo,
    number: pullRequest.number,
    policy,
    evidenceMayBePending: true,
  });
  if (evidence.pullRequest.head.sha !== pullRequest.head.sha) {
    throw new Error(`${repo}#${pullRequest.number}: listed head changed`);
  }
  if (
    evidence.pullRequest.mergeable === false ||
    evidence.pullRequest.mergeable_state === "dirty"
  ) {
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
      issueComments: evidence.issueComments,
      policy,
    });
    return { outcome };
  }
  if (evidence.connectorPending) {
    const disposition = controllerConnectorDisposition(
      evidence.connectorPending,
    );
    if (disposition !== "request-review") {
      return { outcome: disposition };
    }
    const outcome = await ensureConnectorReviewRequest({
      api,
      owner,
      repo,
      number: pullRequest.number,
      headSha: evidence.pullRequest.head.sha,
      issueComments: evidence.issueComments,
      policy,
    });
    return { outcome };
  }
  if (evidence.copilotPending) {
    const disposition = controllerCopilotDisposition(evidence.copilotPending);
    if (disposition === "request-review") {
      const outcome = await ensureCopilotReviewRequest({
        api,
        owner,
        repo,
        number: pullRequest.number,
        requestedReviewers: evidence.pullRequest.requested_reviewers,
        policy,
      });
      return { outcome };
    }
    return { outcome: disposition };
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
  const producerProvenance = inspectRequiredCheckProducerProvenance({
    checkRuns: checks.checkRuns,
    requiredChecks,
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
  const gateOutcome = await recoverLateTrustedGate({
    api,
    owner,
    repo,
    headSha: evidence.pullRequest.head.sha,
    cleanAt: evidence.connectorCleanAt,
    checkRuns: checks.checkRuns,
  });
  if (gateOutcome !== "trusted-gate-success") return { outcome: gateOutcome };

  const queueState = await pullQueueState(api, owner, repo, pullRequest.number);
  if (!queueState)
    throw new Error(`${repo}#${pullRequest.number}: GraphQL PR unavailable`);
  if (queueState.mergeQueueEntry) return { outcome: "already-enqueued" };
  if (!queueState.mergeQueue) return { outcome: "no-merge-queue" };
  if (
    queueState.state !== "OPEN" ||
    queueState.isDraft ||
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
      const finalProducerProvenance = inspectRequiredCheckProducerProvenance({
        checkRuns: finalChecks.checkRuns,
        requiredChecks,
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
    console.error(error instanceof AggregateError ? error.errors : error);
    process.exitCode = 1;
  });
}
