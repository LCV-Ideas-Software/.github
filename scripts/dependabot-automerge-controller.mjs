#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const API_ROOT = "https://api.github.com";
const API_VERSION = "2022-11-28";
const ALLOWED_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);

function log(message) {
  process.stdout.write(`${message}\n`);
}

function assertNonEmpty(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
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
  const checks = parsed.map((value) => assertNonEmpty(value, "required check"));
  if (new Set(checks).size !== checks.length) {
    throw new Error("REQUIRED_CHECKS_JSON must not contain duplicate names");
  }
  return checks;
}

export function isTrustedPullRequest(pull, repository) {
  return Boolean(
    pull &&
    pull.state === "open" &&
    pull.draft === false &&
    pull.user?.login === "dependabot[bot]" &&
    pull.head?.repo?.full_name === repository &&
    pull.base?.repo?.full_name === repository &&
    pull.base?.ref === "main" &&
    typeof pull.head?.ref === "string" &&
    pull.head.ref.startsWith("dependabot/") &&
    /^[0-9a-f]{40}$/i.test(pull.head?.sha ?? ""),
  );
}

export function hasTrustedDependabotCommitSet(commits, headSha) {
  if (!Array.isArray(commits) || commits.length !== 1) return false;
  const commit = commits[0];
  return Boolean(
    commit.sha === headSha &&
    commit.author?.login === "dependabot[bot]" &&
    ["dependabot[bot]", "web-flow"].includes(commit.committer?.login) &&
    commit.commit?.author?.email ===
      "49699333+dependabot[bot]@users.noreply.github.com" &&
    commit.commit?.verification?.verified === true &&
    Array.isArray(commit.parents) &&
    commit.parents.length === 1,
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
  if (
    /^(?:.+\/)?(?:pyproject\.toml|poetry\.lock|Pipfile(?:\.lock)?|uv\.lock|setup\.py|setup\.cfg)$/i.test(
      filename,
    )
  ) {
    return true;
  }
  return /^\.pre-commit-config\.ya?ml$/i.test(filename);
}

function isIgnoredCheck(check, currentRunId) {
  return (
    currentRunId &&
    typeof check.details_url === "string" &&
    check.details_url.includes(`/actions/runs/${currentRunId}`)
  );
}

export function classifyChecks({
  checkRuns,
  statuses = [],
  combinedStatusState = "pending",
  requiredChecks,
  currentRunId = "",
}) {
  const relevantRuns = checkRuns.filter(
    (check) => !isIgnoredCheck(check, currentRunId),
  );
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
    (required) => !relevantRuns.some((check) => check.name === required),
  );
  if (missing.length > 0) {
    return {
      state: "pending",
      reason: `required checks not attached: ${missing.join(", ")}`,
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
        check.name === required &&
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
      ...requiredNotSuccessful.map((name) => `${name}=required-not-successful`),
    ];
    return { state: "failure", reason: [...new Set(failures)].join(", ") };
  }

  return {
    state: "success",
    reason: "all required and attached checks are green",
  };
}

export function hasRecentAutomationRebaseRequest(
  comments,
  marker,
  automationActor,
  now = Date.now(),
) {
  const retryWindowMs = 6 * 60 * 60 * 1000;
  return comments.some((comment) => {
    const createdAt = Date.parse(comment.created_at ?? "");
    return (
      comment.user?.id === automationActor.id &&
      comment.user?.login === automationActor.login &&
      comment.body?.includes(marker) &&
      Number.isFinite(createdAt) &&
      now - createdAt >= 0 &&
      now - createdAt < retryWindowMs
    );
  });
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

async function readChecks(owner, repo, sha, token, currentRunId) {
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
  return {
    checkRuns,
    statuses,
    combinedStatusState: combinedStatus?.state ?? "pending",
    currentRunId,
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

async function requestDependabotRebase(
  owner,
  repo,
  number,
  headSha,
  mainSha,
  readToken,
  automationToken,
) {
  const marker = `<!-- lcv-dependabot-rebase:${headSha}:${mainSha} -->`;
  const { payload: automationActor } = await github("/user", {
    token: automationToken,
  });
  if (
    !Number.isSafeInteger(automationActor?.id) ||
    typeof automationActor?.login !== "string"
  ) {
    throw new Error("Unable to resolve the automation token identity");
  }
  const comments = await paginated(
    `/repos/${owner}/${repo}/issues/${number}/comments`,
    readToken,
  );
  const alreadyRequested = hasRecentAutomationRebaseRequest(
    comments,
    marker,
    automationActor,
  );
  if (alreadyRequested) {
    log(
      `PR #${number}: waiting for Dependabot to process the existing guarded rebase request.`,
    );
    return false;
  }
  await github(`/repos/${owner}/${repo}/issues/${number}/comments`, {
    token: automationToken,
    method: "POST",
    body: { body: `@dependabot rebase\n\n${marker}` },
  });
  return true;
}

async function inspectPullProvenance(owner, repo, pull, token) {
  const commits = await paginated(
    `/repos/${owner}/${repo}/pulls/${pull.number}/commits`,
    token,
  );
  if (!hasTrustedDependabotCommitSet(commits, pull.head.sha)) {
    return {
      trusted: false,
      reason: "commit set is not a single verified Dependabot-authored commit",
    };
  }

  const files = await paginated(
    `/repos/${owner}/${repo}/pulls/${pull.number}/files`,
    token,
  );
  if (files.length === 0) {
    return { trusted: false, reason: "pull request has no changed files" };
  }
  const unexpected = files
    .map((file) => file.filename)
    .filter((filename) => !isAllowedDependabotPath(filename));
  if (unexpected.length > 0) {
    return {
      trusted: false,
      reason: `unexpected changed paths: ${unexpected.join(", ")}`,
    };
  }
  return {
    trusted: true,
    reason: "verified Dependabot commit and dependency-only paths",
  };
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

export async function runController(env = process.env) {
  const repository = assertNonEmpty(env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY");
  const [owner, repo, extra] = repository.split("/");
  if (!owner || !repo || extra)
    throw new Error("GITHUB_REPOSITORY must be owner/repo");

  const githubToken = assertNonEmpty(env.GITHUB_TOKEN, "GITHUB_TOKEN");
  const automationToken = assertNonEmpty(
    env.LCV_AUTOMATION_TOKEN,
    "LCV_AUTOMATION_TOKEN",
  );
  const requiredChecks = parseRequiredChecks(env.REQUIRED_CHECKS_JSON);
  const currentRunId = env.GITHUB_RUN_ID ?? "";
  const dryRun = env.DRY_RUN === "true";

  const pulls = await paginated(
    `/repos/${owner}/${repo}/pulls?state=open&base=main&sort=created&direction=asc`,
    githubToken,
  );
  const dependabotPulls = pulls.filter((pull) =>
    isTrustedPullRequest(pull, repository),
  );
  log(
    `${repository}: ${dependabotPulls.length} trusted open Dependabot PR(s).`,
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

    const provenance = await inspectPullProvenance(
      owner,
      repo,
      pull,
      githubToken,
    );
    if (!provenance.trusted) {
      log(
        `PR #${pull.number}: untrusted provenance (${provenance.reason}); skipped.`,
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
    if (Number(comparison?.behind_by ?? 0) > 0) {
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
      const requested = await requestDependabotRebase(
        owner,
        repo,
        pull.number,
        pull.head.sha,
        mainSha,
        githubToken,
        automationToken,
      );
      if (requested) {
        return {
          action: "requested-rebase",
          pull: pull.number,
          head: pull.head.sha,
        };
      }
      continue;
    }

    const checks = await readChecks(
      owner,
      repo,
      pull.head.sha,
      githubToken,
      currentRunId,
    );
    const verdict = classifyChecks({ ...checks, requiredChecks });
    log(`PR #${pull.number}: checks=${verdict.state} (${verdict.reason}).`);
    if (verdict.state !== "success") continue;

    if (pull.mergeable === false || pull.mergeable_state === "dirty") {
      log(`PR #${pull.number}: GitHub reports merge conflicts; skipped.`);
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
      postApprovalPull.head.sha !== pull.head.sha
    ) {
      log(
        `PR #${pull.number}: head or main changed during approval; merge deferred.`,
      );
      return { action: "deferred", pull: pull.number, head: pull.head.sha };
    }
    const postApprovalChecks = classifyChecks({
      ...(await readChecks(
        owner,
        repo,
        pull.head.sha,
        githubToken,
        currentRunId,
      )),
      requiredChecks,
    });
    if (postApprovalChecks.state !== "success") {
      log(
        `PR #${pull.number}: checks changed during approval; merge deferred.`,
      );
      return { action: "deferred", pull: pull.number, head: pull.head.sha };
    }

    await mergeSquash(owner, repo, postApprovalPull, automationToken);
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
