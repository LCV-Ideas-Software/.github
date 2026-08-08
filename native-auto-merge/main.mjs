#!/usr/bin/env node

import { execFile as nodeExecFile } from "node:child_process";
import { readFile as nodeReadFile } from "node:fs/promises";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const API_ROOT = "https://api.github.com";
const API_VERSION = "2026-03-10";
const API_TIMEOUT_MILLISECONDS = 15_000;
const GH_TIMEOUT_MILLISECONDS = 60_000;
const GITHUB_ACTIONS_APP_ID = 15368;
const POLICY_URL = new URL("../native-governance/policy.json", import.meta.url);
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const ALLOWED_ACTORS = new Map([
  ["lcv-leo", 268063598],
  ["dependabot[bot]", 49699333],
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
  if (
    run?.name !== "CodeQL" ||
    run.status !== "completed" ||
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

export function isEligiblePull(pull, candidate, repository) {
  const expectedActorId = ALLOWED_ACTORS.get(pull?.user?.login);
  return Boolean(
    positivePullNumber(candidate?.number) &&
    pull?.number === candidate.number &&
    pull.state === "open" &&
    pull.draft === false &&
    expectedActorId !== undefined &&
    pull.user.id === expectedActorId &&
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

export async function githubGetEffectiveRules(repository, token, runtime = {}) {
  parseRepository(repository);
  nonEmpty(token, "automation_token input");
  const payload = await githubRequest(
    `/repos/${repository}/rules/branches/main`,
    { method: "GET", token },
    runtime,
  );
  if (!Array.isArray(payload)) {
    malformedEffectiveRules("GitHub API root must be an array");
  }
  return payload;
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
  if (!pull) {
    throw new Error("GitHub GraphQL did not return the pull request");
  }
  return {
    autoMergeRequest: pull.autoMergeRequest ?? null,
    mergeQueueEntry: pull.mergeQueueEntry ?? null,
  };
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
  const eventPath = nonEmpty(env.GITHUB_EVENT_PATH, "GITHUB_EVENT_PATH");
  const token = nonEmpty(env.INPUT_AUTOMATION_TOKEN, "automation_token input");
  const readFile = runtime.readFile ?? nodeReadFile;
  const event = JSON.parse(await readFile(eventPath, "utf8"));
  const candidates = extractCandidates(eventName, event, repository);
  if (candidates.length === 0) {
    log("No completed CodeQL pull-request run with an exact head was found.");
    return { action: "none" };
  }

  const getPull = runtime.getPull ?? githubGetPull;
  const loadPolicyChecks = runtime.loadRequiredChecks ?? loadRequiredChecks;
  const getEffectiveRules =
    runtime.getEffectiveRules ?? githubGetEffectiveRules;
  const getNativeState = runtime.getNativeState ?? githubGetNativeState;
  const enableAutoMerge = runtime.enableAutoMerge ?? runGhAutoMerge;
  const candidate = candidates[0];
  const currentPull = await getPull(repository, candidate.number, token);
  if (!isEligiblePull(currentPull, candidate, repository)) {
    log(
      `PR #${candidate.number}: current identity, state, base or exact head is ineligible.`,
    );
    return { action: "skipped", reason: "ineligible" };
  }

  const requiredChecks = await loadPolicyChecks(repository);
  if (requiredChecks === null) {
    log(`PR #${candidate.number}: repository is absent from pinned policy.`);
    return {
      action: "skipped",
      reason: "repository-not-in-policy",
    };
  }

  const effectiveRules = await getEffectiveRules(repository, token);
  if (!hasRequiredNativeEnforcement(effectiveRules, requiredChecks)) {
    log(
      `PR #${candidate.number}: required native enforcement is not fully active on main.`,
    );
    return {
      action: "skipped",
      reason: "native-enforcement-inactive",
    };
  }

  const state = await getNativeState(repository, candidate.number, token);
  if (state.mergeQueueEntry) {
    log(`PR #${candidate.number}: already in the native merge queue.`);
    return { action: "already-queued", pull: candidate.number };
  }
  if (state.autoMergeRequest) {
    log(`PR #${candidate.number}: native auto-merge is already enabled.`);
    return { action: "already-enabled", pull: candidate.number };
  }

  const finalEffectiveRules = await getEffectiveRules(repository, token);
  if (!hasRequiredNativeEnforcement(finalEffectiveRules, requiredChecks)) {
    log(
      `PR #${candidate.number}: required native enforcement changed before the mutation.`,
    );
    return {
      action: "skipped",
      reason: "native-enforcement-inactive",
    };
  }

  const finalPull = await getPull(repository, candidate.number, token);
  if (!isEligiblePull(finalPull, candidate, repository)) {
    log(
      `PR #${candidate.number}: pull request identity, state, base or exact head changed before the mutation.`,
    );
    return { action: "skipped", reason: "ineligible" };
  }

  await enableAutoMerge(repository, candidate.number, candidate.headSha, token);
  log(
    `PR #${candidate.number}: native auto-merge enabled for exact head ${candidate.headSha}.`,
  );
  return {
    action: "enabled",
    pull: candidate.number,
    head: candidate.headSha,
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
