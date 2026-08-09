import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const API_VERSION = "2026-03-10";

const API_ORIGIN = "https://api.github.com";
const PAGE_SIZE = 100;
const MAX_PAGES = 1_000;
const REQUEST_TIMEOUT_MS = 30_000;
const USER_AGENT = "lcv-native-governance";
const DEFAULT_POLICY_URL = new URL(
  "../native-governance/policy.json",
  import.meta.url,
);

const ORGANIZATION_RULE_TYPES = [
  "deletion",
  "required_linear_history",
  "required_signatures",
  "pull_request",
  "non_fast_forward",
  "code_scanning",
  "copilot_code_review",
];

const REQUIRED_ORGANIZATION_CONDITIONS = {
  repository_name: { include: ["~ALL"], exclude: [], protected: false },
  ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] },
};

const REQUIRED_PULL_REQUEST_PARAMETERS = {
  allowed_merge_methods: ["squash"],
  dismiss_stale_reviews_on_push: false,
  require_code_owner_review: false,
  require_last_push_approval: false,
  required_approving_review_count: 0,
  required_review_thread_resolution: true,
  required_reviewers: [],
};

const REQUIRED_CODE_SCANNING_PARAMETERS = {
  code_scanning_tools: [
    {
      tool: "CodeQL",
      alerts_threshold: "all",
      security_alerts_threshold: "all",
    },
    {
      tool: "zizmor",
      alerts_threshold: "all",
      security_alerts_threshold: "all",
    },
  ],
};

const REQUIRED_COPILOT_PARAMETERS = {
  review_draft_pull_requests: false,
  review_on_push: true,
};

const REQUIRED_REPOSITORY_CONDITIONS = {
  ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] },
};

const REQUIRED_MERGE_QUEUE_PARAMETERS = {
  check_response_timeout_minutes: 60,
  grouping_strategy: "ALLGREEN",
  max_entries_to_build: 1,
  max_entries_to_merge: 1,
  merge_method: "SQUASH",
  min_entries_to_merge: 1,
  min_entries_to_merge_wait_minutes: 0,
};

const REQUIRED_REPOSITORY_SETTINGS = {
  has_pull_requests: true,
  pull_request_creation_policy: "collaborators_only",
  allow_squash_merge: true,
  allow_merge_commit: false,
  allow_rebase_merge: false,
  allow_auto_merge: true,
  delete_branch_on_merge: true,
};

const BOT_OR_PROVENANCE_CHECK =
  /(?:copilot|chatgpt|codex|trusted pr|trusted gate|dependabot controller|dependabot automerge|provenance)/i;

function assertObject(value, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function assertExactKeys(value, expectedKeys, label) {
  assertObject(value, label);
  const expected = new Set(expectedKeys);
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `${label} has unknown key(s): ${unknown.sort().join(", ")}.`,
    );
  }
  const missing = expectedKeys.filter(
    (key) => !Object.prototype.hasOwnProperty.call(value, key),
  );
  if (missing.length > 0) {
    throw new Error(`${label} is missing key(s): ${missing.join(", ")}.`);
  }
}

function assertNonemptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a nonempty string.`);
  }
  if (value !== value.trim()) {
    throw new Error(`${label} must not contain surrounding whitespace.`);
  }
}

function assertJsonEqual(actual, expected, label) {
  if (
    JSON.stringify(normalizeForComparison(actual)) !==
    JSON.stringify(normalizeForComparison(expected))
  ) {
    throw new Error(`${label} does not match the required native policy.`);
  }
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function clone(value) {
  return structuredClone(value);
}

function validateOrganizationRuleset(ruleset) {
  assertExactKeys(
    ruleset,
    ["name", "target", "enforcement", "bypass_actors", "conditions", "rules"],
    "organization_ruleset",
  );
  assertNonemptyString(ruleset.name, "organization_ruleset.name");
  if (ruleset.target !== "branch") {
    throw new Error("organization_ruleset.target must be branch.");
  }
  if (!["disabled", "evaluate", "active"].includes(ruleset.enforcement)) {
    throw new Error("organization_ruleset.enforcement is invalid.");
  }
  if (
    !Array.isArray(ruleset.bypass_actors) ||
    ruleset.bypass_actors.length > 0
  ) {
    throw new Error("The organization ruleset must have no bypass actors.");
  }
  assertJsonEqual(
    ruleset.conditions,
    REQUIRED_ORGANIZATION_CONDITIONS,
    "organization_ruleset.conditions",
  );
  if (!Array.isArray(ruleset.rules)) {
    throw new Error("organization_ruleset.rules must be an array.");
  }
  if (ruleset.rules.some((rule) => rule?.type === "merge_queue")) {
    throw new Error("The organization ruleset must not contain merge_queue.");
  }
  assertJsonEqual(
    ruleset.rules.map((rule) => rule?.type),
    ORGANIZATION_RULE_TYPES,
    "organization_ruleset rule order",
  );

  for (const type of [
    "deletion",
    "required_linear_history",
    "required_signatures",
    "non_fast_forward",
  ]) {
    assertJsonEqual(
      ruleset.rules.find((rule) => rule.type === type),
      { type },
      `organization_ruleset ${type} rule`,
    );
  }
  assertJsonEqual(
    ruleset.rules.find((rule) => rule.type === "pull_request"),
    { type: "pull_request", parameters: REQUIRED_PULL_REQUEST_PARAMETERS },
    "organization_ruleset pull_request rule",
  );
  assertJsonEqual(
    ruleset.rules.find((rule) => rule.type === "code_scanning"),
    { type: "code_scanning", parameters: REQUIRED_CODE_SCANNING_PARAMETERS },
    "organization_ruleset code_scanning rule",
  );
  assertJsonEqual(
    ruleset.rules.find((rule) => rule.type === "copilot_code_review"),
    { type: "copilot_code_review", parameters: REQUIRED_COPILOT_PARAMETERS },
    "organization_ruleset copilot_code_review rule",
  );
}

function validateRepositoryRulesetBase(ruleset, expectedKeys, label) {
  assertExactKeys(ruleset, expectedKeys, label);
  assertNonemptyString(ruleset.name, `${label}.name`);
  if (ruleset.target !== "branch") {
    throw new Error(`${label}.target must be branch.`);
  }
  if (
    !Array.isArray(ruleset.bypass_actors) ||
    ruleset.bypass_actors.length > 0
  ) {
    throw new Error("Repository rulesets must have no bypass actors.");
  }
  assertJsonEqual(
    ruleset.conditions,
    REQUIRED_REPOSITORY_CONDITIONS,
    `${label}.conditions`,
  );
}

function validateRepositoryStatusRuleset(ruleset) {
  validateRepositoryRulesetBase(
    ruleset,
    ["name", "target", "bypass_actors", "conditions"],
    "repository_status_ruleset",
  );
}

function validateRepositoryQueueRuleset(ruleset) {
  validateRepositoryRulesetBase(
    ruleset,
    ["name", "target", "bypass_actors", "conditions", "merge_queue"],
    "repository_queue_ruleset",
  );
  assertJsonEqual(
    ruleset.merge_queue,
    REQUIRED_MERGE_QUEUE_PARAMETERS,
    "repository_queue_ruleset.merge_queue",
  );
}

function validateRequiredChecks(repositories) {
  assertObject(repositories, "repositories");
  const entries = Object.entries(repositories);
  if (entries.length === 0) {
    throw new Error("repositories must not be empty.");
  }

  for (const [repositoryName, repositoryPolicy] of entries) {
    assertNonemptyString(repositoryName, "repository name");
    if (repositoryName.includes("/")) {
      throw new Error(
        `Repository policy key ${repositoryName} must be a name.`,
      );
    }
    assertExactKeys(
      repositoryPolicy,
      ["status_enforcement", "queue_enforcement", "required_checks"],
      `repositories.${repositoryName}`,
    );
    for (const field of ["status_enforcement", "queue_enforcement"]) {
      if (
        !["disabled", "evaluate", "active"].includes(repositoryPolicy[field])
      ) {
        throw new Error(`repositories.${repositoryName}.${field} is invalid.`);
      }
    }
    if (
      repositoryPolicy.queue_enforcement === "active" &&
      repositoryPolicy.status_enforcement !== "active"
    ) {
      throw new Error(
        `${repositoryName}: an active queue requires an active status ruleset.`,
      );
    }
    if (
      !Array.isArray(repositoryPolicy.required_checks) ||
      repositoryPolicy.required_checks.length === 0
    ) {
      throw new Error(`${repositoryName} required_checks must not be empty.`);
    }

    const names = new Set();
    for (const check of repositoryPolicy.required_checks) {
      assertExactKeys(
        check,
        ["name", "app_id"],
        `${repositoryName} required check`,
      );
      assertNonemptyString(check.name, `${repositoryName} required check name`);
      if (!Number.isSafeInteger(check.app_id) || check.app_id <= 0) {
        throw new Error(`${repositoryName} required check app_id is invalid.`);
      }
      if (names.has(check.name)) {
        throw new Error(
          `${repositoryName} has duplicate required check ${check.name}.`,
        );
      }
      names.add(check.name);
      if (BOT_OR_PROVENANCE_CHECK.test(check.name)) {
        throw new Error(
          `Bot or provenance required check ${check.name} is forbidden.`,
        );
      }
      if (check.app_id === 57789) {
        throw new Error(
          `GHAS summary check ${check.name} is forbidden in merge-queue required checks.`,
        );
      }
    }

    const hasZizmorWrapper = repositoryPolicy.required_checks.some(
      (check) =>
        check.app_id === 15368 &&
        (check.name === "Run zizmor" ||
          check.name === "Run zizmor / Run zizmor"),
    );
    const hasCodeQlWrapper = repositoryPolicy.required_checks.some(
      (check) => check.app_id === 15368 && check.name.startsWith("Analyze "),
    );
    if (!hasCodeQlWrapper) {
      throw new Error(`${repositoryName} must preserve its CodeQL wrapper.`);
    }
    if (!hasZizmorWrapper) {
      throw new Error(`${repositoryName} must preserve its zizmor wrapper.`);
    }
  }

  const organizationRepository = repositories[".github"];
  for (const context of [
    "Test native governance",
    "Test native auto-merge",
    "OpenSSF Scorecard",
    "Build Pages artifact",
    "Verify relay and recovery controller",
    "Verify Slack workflow app",
  ]) {
    if (
      !organizationRepository?.required_checks.some(
        (check) => check.name === context && check.app_id === 15368,
      )
    ) {
      throw new Error(`.github must require ${context} from GitHub Actions.`);
    }
  }
}

export function validatePolicy(candidate) {
  assertExactKeys(
    candidate,
    [
      "schema_version",
      "organization",
      "organization_ruleset",
      "repository_status_ruleset",
      "repository_queue_ruleset",
      "repository_settings",
      "repositories",
    ],
    "policy",
  );
  if (candidate.schema_version !== 1) {
    throw new Error("Unsupported native governance policy schema version.");
  }
  assertNonemptyString(candidate.organization, "organization");
  validateOrganizationRuleset(candidate.organization_ruleset);
  validateRepositoryStatusRuleset(candidate.repository_status_ruleset);
  validateRepositoryQueueRuleset(candidate.repository_queue_ruleset);
  if (
    candidate.repository_status_ruleset.name ===
    candidate.repository_queue_ruleset.name
  ) {
    throw new Error(
      "Repository status and queue ruleset names must be distinct.",
    );
  }
  assertJsonEqual(
    candidate.repository_settings,
    REQUIRED_REPOSITORY_SETTINGS,
    "repository_settings",
  );
  validateRequiredChecks(candidate.repositories);
  const hasActiveRepositoryRuleset = Object.values(candidate.repositories).some(
    ({ status_enforcement: status, queue_enforcement: queue }) =>
      status === "active" || queue === "active",
  );
  if (
    hasActiveRepositoryRuleset &&
    candidate.organization_ruleset.enforcement !== "active"
  ) {
    throw new Error(
      "An active repository ruleset requires the organization ruleset to be active.",
    );
  }
  return deepFreeze(clone(candidate));
}

export function buildOrganizationRuleset(policy) {
  return clone(policy.organization_ruleset);
}

export function buildRepositoryStatusRuleset(policy, repositoryName) {
  const repositoryPolicy = policy.repositories[repositoryName];
  if (!repositoryPolicy) {
    throw new Error(`Repository ${repositoryName} is absent from policy.`);
  }
  return {
    name: policy.repository_status_ruleset.name,
    target: policy.repository_status_ruleset.target,
    enforcement: repositoryPolicy.status_enforcement,
    bypass_actors: [],
    conditions: clone(policy.repository_status_ruleset.conditions),
    rules: [
      {
        type: "required_status_checks",
        parameters: {
          do_not_enforce_on_create: false,
          required_status_checks: repositoryPolicy.required_checks.map(
            ({ name, app_id: appId }) => ({
              context: name,
              integration_id: appId,
            }),
          ),
          strict_required_status_checks_policy: false,
        },
      },
    ],
  };
}

export function buildRepositoryQueueRuleset(policy, repositoryName) {
  const repositoryPolicy = policy.repositories[repositoryName];
  if (!repositoryPolicy) {
    throw new Error(`Repository ${repositoryName} is absent from policy.`);
  }
  return {
    name: policy.repository_queue_ruleset.name,
    target: policy.repository_queue_ruleset.target,
    enforcement: repositoryPolicy.queue_enforcement,
    bypass_actors: [],
    conditions: clone(policy.repository_queue_ruleset.conditions),
    rules: [
      {
        type: "merge_queue",
        parameters: clone(policy.repository_queue_ruleset.merge_queue),
      },
    ],
  };
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

export function readConfiguration(environment = process.env) {
  const organizationName = requiredEnvironmentValue(
    environment,
    "ORGANIZATION_NAME",
  );
  const repository = requiredEnvironmentValue(environment, "GITHUB_REPOSITORY");
  if (repository !== `${organizationName}/.github`) {
    throw new Error(
      "Native governance must run from the organization's .github repository.",
    );
  }
  if (
    requiredEnvironmentValue(environment, "GITHUB_REF") !== "refs/heads/main"
  ) {
    throw new Error("Native governance reconciliation is restricted to main.");
  }
  return Object.freeze({
    organizationName,
    token: requiredEnvironmentValue(environment, "TOKEN", { sensitive: true }),
  });
}

export function assertConfigurationOnlyRequest(method, url) {
  const normalizedMethod = method.toUpperCase();
  const pathname = url.pathname;
  const routes = [
    ["GET", /^\/orgs\/[^/]+\/repos$/],
    ["GET", /^\/orgs\/[^/]+\/rulesets$/],
    ["POST", /^\/orgs\/[^/]+\/rulesets$/],
    ["GET", /^\/orgs\/[^/]+\/rulesets\/\d+$/],
    ["PUT", /^\/orgs\/[^/]+\/rulesets\/\d+$/],
    ["GET", /^\/repos\/[^/]+\/[^/]+$/],
    ["PATCH", /^\/repos\/[^/]+\/[^/]+$/],
    ["GET", /^\/repos\/[^/]+\/[^/]+\/rulesets$/],
    ["POST", /^\/repos\/[^/]+\/[^/]+\/rulesets$/],
    ["GET", /^\/repos\/[^/]+\/[^/]+\/rulesets\/\d+$/],
    ["PUT", /^\/repos\/[^/]+\/[^/]+\/rulesets\/\d+$/],
  ];
  if (
    !routes.some(
      ([allowedMethod, pattern]) =>
        normalizedMethod === allowedMethod && pattern.test(pathname),
    )
  ) {
    throw new Error(
      `GitHub API ${normalizedMethod} ${pathname} is outside the configuration-only boundary.`,
    );
  }
}

function apiUrl(pathname, searchParams) {
  const url = new URL(pathname, API_ORIGIN);
  for (const [name, value] of Object.entries(searchParams ?? {})) {
    url.searchParams.set(name, String(value));
  }
  return url;
}

function apiError(response, method, pathname) {
  const requestId = response.headers.get("x-github-request-id");
  const sso = response.headers.get("x-github-sso");
  const remaining = response.headers.get("x-ratelimit-remaining");
  const context = [];
  if (requestId) context.push(`request-id=${requestId}`);
  if (sso) context.push("sso-authorization=required");
  if (
    response.status === 429 ||
    (response.status === 403 && remaining === "0")
  ) {
    context.push("rate-limit-reached");
  }
  const suffix = context.length > 0 ? ` (${context.join(", ")})` : "";
  return new Error(
    `GitHub API ${method} ${pathname} returned HTTP ${response.status}${suffix}.`,
  );
}

async function githubRequest({
  configuration,
  method = "GET",
  url,
  body,
  fetchImpl,
  expectedStatuses = [200],
}) {
  assertConfigurationOnlyRequest(method, url);
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${configuration.token}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": API_VERSION,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(
      `GitHub API ${method} ${url.pathname} could not be reached.`,
      { cause: error },
    );
  }
  if (!expectedStatuses.includes(response.status)) {
    throw apiError(response, method, url.pathname);
  }
  if (response.status === 204) return undefined;
  try {
    return await response.json();
  } catch (error) {
    throw new Error(
      `GitHub API ${method} ${url.pathname} returned malformed JSON.`,
      { cause: error },
    );
  }
}

function organizationPath(organizationName) {
  return `/orgs/${encodeURIComponent(organizationName)}`;
}

function repositoryPath(organizationName, repositoryName) {
  return `/repos/${encodeURIComponent(organizationName)}/${encodeURIComponent(repositoryName)}`;
}

async function listPaginated({
  configuration,
  pathname,
  searchParams,
  fetchImpl,
  label,
}) {
  const results = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await githubRequest({
      configuration,
      url: apiUrl(pathname, {
        ...searchParams,
        page,
        per_page: PAGE_SIZE,
      }),
      fetchImpl,
    });
    if (!Array.isArray(batch)) {
      throw new Error(`GitHub returned a malformed ${label}.`);
    }
    results.push(...batch);
    if (batch.length < PAGE_SIZE) return results;
  }
  throw new Error(`${label} pagination exceeded ${MAX_PAGES} pages.`);
}

function validateRepositorySummary(repository, organizationName) {
  if (
    repository === null ||
    typeof repository !== "object" ||
    !Number.isSafeInteger(repository.id) ||
    repository.id <= 0 ||
    typeof repository.name !== "string" ||
    repository.name === "" ||
    repository.full_name !== `${organizationName}/${repository.name}` ||
    repository.owner?.login !== organizationName ||
    typeof repository.archived !== "boolean" ||
    typeof repository.disabled !== "boolean" ||
    typeof repository.default_branch !== "string" ||
    repository.default_branch === ""
  ) {
    throw new Error("GitHub returned malformed repository metadata.");
  }
  return repository;
}

async function listRepositories(configuration, fetchImpl) {
  const candidates = await listPaginated({
    configuration,
    pathname: `${organizationPath(configuration.organizationName)}/repos`,
    searchParams: { type: "all" },
    fetchImpl,
    label: "repository inventory",
  });
  const ids = new Set();
  const names = new Set();
  return candidates.map((candidate) => {
    const repository = validateRepositorySummary(
      candidate,
      configuration.organizationName,
    );
    if (ids.has(repository.id) || names.has(repository.name)) {
      throw new Error("GitHub returned duplicate repository metadata.");
    }
    ids.add(repository.id);
    names.add(repository.name);
    return repository;
  });
}

function activeRepositories(inventory) {
  return inventory
    .filter((repository) => !repository.archived && !repository.disabled)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function assertInventoryCovered(inventory, policy) {
  const active = activeRepositories(inventory);
  const unknown = active
    .filter((repository) => !policy.repositories[repository.name])
    .map((repository) => repository.name);
  if (unknown.length > 0) {
    throw new Error(
      `Active repositories absent from policy: ${unknown.join(", ")}.`,
    );
  }
  const nonMain = active
    .filter((repository) => repository.default_branch !== "main")
    .map((repository) => repository.name);
  if (nonMain.length > 0) {
    throw new Error(
      `Active repositories without main as default branch: ${nonMain.join(", ")}.`,
    );
  }
}

function normalizeForComparison(value, key = "") {
  if (Array.isArray(value)) {
    const normalized = value.map((entry) => normalizeForComparison(entry));
    if (
      [
        "bypass_actors",
        "include",
        "exclude",
        "allowed_actors",
        "required_reviewers",
        "code_scanning_tools",
        "required_status_checks",
        "rules",
      ].includes(key)
    ) {
      normalized.sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      );
    }
    return normalized;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((childKey) => [
          childKey,
          normalizeForComparison(value[childKey], childKey),
        ]),
    );
  }
  return value;
}

function projectShape(actual, desired, key = "") {
  if (Array.isArray(desired)) {
    if (!Array.isArray(actual)) return actual;
    if (
      key === "rules" &&
      actual.length === desired.length &&
      desired.every((rule) => typeof rule?.type === "string")
    ) {
      return desired.map((desiredRule) =>
        projectShape(
          actual.find((actualRule) => actualRule?.type === desiredRule.type),
          desiredRule,
        ),
      );
    }
    return actual.map((entry, index) =>
      projectShape(entry, desired[index] ?? desired[0]),
    );
  }
  if (desired !== null && typeof desired === "object") {
    if (
      actual === null ||
      typeof actual !== "object" ||
      Array.isArray(actual)
    ) {
      return actual;
    }
    return Object.fromEntries(
      Object.keys(desired).map((key) => [
        key,
        projectShape(actual[key], desired[key], key),
      ]),
    );
  }
  return actual;
}

function dismissalRestrictionMatches(actual, desired) {
  if (!Array.isArray(desired?.rules)) return true;
  const desiredPullRequest = desired.rules.find(
    ({ type }) => type === "pull_request",
  );
  if (
    !desiredPullRequest ||
    Object.hasOwn(desiredPullRequest.parameters ?? {}, "dismissal_restriction")
  ) {
    return true;
  }
  const actualPullRequest = Array.isArray(actual?.rules)
    ? actual.rules.find(({ type }) => type === "pull_request")
    : undefined;
  const restriction = actualPullRequest?.parameters?.dismissal_restriction;
  if (restriction === undefined) return true;
  return (
    JSON.stringify(normalizeForComparison(restriction)) ===
    JSON.stringify(
      normalizeForComparison({ allowed_actors: [], enabled: false }),
    )
  );
}

function payloadMatches(actual, desired) {
  if (!dismissalRestrictionMatches(actual, desired)) return false;
  const projected = projectShape(actual, desired);
  return (
    JSON.stringify(normalizeForComparison(projected)) ===
    JSON.stringify(normalizeForComparison(desired))
  );
}

function normalizeRulesetSource(source) {
  if (typeof source === "string" && source.trim() !== "") {
    return source.toLowerCase();
  }
  if (source !== null && typeof source === "object") {
    for (const key of ["full_name", "name", "login"]) {
      const value = source[key];
      if (typeof value === "string" && value.trim() !== "") {
        return value.toLowerCase();
      }
    }
  }
  return null;
}

function rulesetSummaryMatchesSource(candidate, expectedSourceType, expectedSource) {
  if (typeof candidate.source_type !== "string") return false;
  if (candidate.source_type.toLowerCase() !== expectedSourceType.toLowerCase()) {
    return false;
  }
  const normalizedSource = normalizeRulesetSource(candidate.source);
  return (
    normalizedSource !== null &&
    normalizedSource === expectedSource.toLowerCase()
  );
}

function validateRulesetSummary(candidate) {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !Number.isSafeInteger(candidate.id) ||
    candidate.id <= 0 ||
    typeof candidate.name !== "string" ||
    candidate.name === ""
  ) {
    throw new Error("GitHub returned malformed managed ruleset metadata.");
  }
  return candidate;
}

async function findOrganizationRuleset(configuration, name, fetchImpl) {
  const pathname = `${organizationPath(configuration.organizationName)}/rulesets`;
  const candidates = await listPaginated({
    configuration,
    pathname,
    searchParams: { includes_parents: false, targets: "branch" },
    fetchImpl,
    label: "organization ruleset inventory",
  });
  const matches = candidates
    .map((candidate) => validateRulesetSummary(candidate))
    .filter(
      (candidate) =>
        candidate.name === name &&
        rulesetSummaryMatchesSource(
          candidate,
          "Organization",
          configuration.organizationName,
        ),
    );
  if (matches.length > 1) {
    throw new Error(`Duplicate managed organization rulesets named ${name}.`);
  }
  return matches[0];
}

async function findRepositoryRuleset(
  configuration,
  repositoryName,
  name,
  fetchImpl,
) {
  const pathname = `${repositoryPath(
    configuration.organizationName,
    repositoryName,
  )}/rulesets`;
  const candidates = await listPaginated({
    configuration,
    pathname,
    searchParams: { includes_parents: false, targets: "branch" },
    fetchImpl,
    label: `${repositoryName} ruleset inventory`,
  });
  const expectedSource = `${configuration.organizationName}/${repositoryName}`;
  const matches = candidates
    .map((candidate) => validateRulesetSummary(candidate))
    .filter(
      (candidate) =>
        candidate.name === name &&
        rulesetSummaryMatchesSource(candidate, "Repository", expectedSource),
    );
  if (matches.length > 1) {
    throw new Error(
      `Duplicate managed repository rulesets named ${name} in ${repositoryName}.`,
    );
  }
  return matches[0];
}

async function getOrganizationRuleset(configuration, id, fetchImpl) {
  return githubRequest({
    configuration,
    url: apiUrl(
      `${organizationPath(configuration.organizationName)}/rulesets/${id}`,
    ),
    fetchImpl,
  });
}

async function getRepositoryRuleset(
  configuration,
  repositoryName,
  id,
  fetchImpl,
) {
  return githubRequest({
    configuration,
    url: apiUrl(
      `${repositoryPath(
        configuration.organizationName,
        repositoryName,
      )}/rulesets/${id}`,
      { includes_parents: false },
    ),
    fetchImpl,
  });
}

async function verifyAfterAmbiguousMutation(mutationError, verify, label) {
  try {
    if (await verify()) return "reconciled";
  } catch (verificationError) {
    throw new AggregateError(
      [mutationError, verificationError],
      `${label} state is uncertain after a failed mutation.`,
    );
  }
  throw mutationError;
}

async function ensureOrganizationRuleset(configuration, desired, fetchImpl) {
  let summary = await findOrganizationRuleset(
    configuration,
    desired.name,
    fetchImpl,
  );
  if (!summary) {
    try {
      await githubRequest({
        configuration,
        method: "POST",
        url: apiUrl(
          `${organizationPath(configuration.organizationName)}/rulesets`,
        ),
        body: desired,
        fetchImpl,
        expectedStatuses: [201],
      });
    } catch (mutationError) {
      return verifyAfterAmbiguousMutation(
        mutationError,
        async () => {
          summary = await findOrganizationRuleset(
            configuration,
            desired.name,
            fetchImpl,
          );
          if (!summary) return false;
          return payloadMatches(
            await getOrganizationRuleset(configuration, summary.id, fetchImpl),
            desired,
          );
        },
        "Organization ruleset",
      );
    }
    summary = await findOrganizationRuleset(
      configuration,
      desired.name,
      fetchImpl,
    );
    if (
      !summary ||
      !payloadMatches(
        await getOrganizationRuleset(configuration, summary.id, fetchImpl),
        desired,
      )
    ) {
      throw new Error(
        "Created organization ruleset failed exact verification.",
      );
    }
    return "created";
  }

  const current = await getOrganizationRuleset(
    configuration,
    summary.id,
    fetchImpl,
  );
  if (payloadMatches(current, desired)) return "unchanged";
  try {
    await githubRequest({
      configuration,
      method: "PUT",
      url: apiUrl(
        `${organizationPath(configuration.organizationName)}/rulesets/${summary.id}`,
      ),
      body: desired,
      fetchImpl,
    });
  } catch (mutationError) {
    return verifyAfterAmbiguousMutation(
      mutationError,
      async () =>
        payloadMatches(
          await getOrganizationRuleset(configuration, summary.id, fetchImpl),
          desired,
        ),
      "Organization ruleset",
    );
  }
  if (
    !payloadMatches(
      await getOrganizationRuleset(configuration, summary.id, fetchImpl),
      desired,
    )
  ) {
    throw new Error("Updated organization ruleset failed exact verification.");
  }
  return "updated";
}

async function ensureRepositoryRuleset(
  configuration,
  repositoryName,
  desired,
  fetchImpl,
) {
  let summary = await findRepositoryRuleset(
    configuration,
    repositoryName,
    desired.name,
    fetchImpl,
  );
  if (!summary) {
    try {
      await githubRequest({
        configuration,
        method: "POST",
        url: apiUrl(
          `${repositoryPath(
            configuration.organizationName,
            repositoryName,
          )}/rulesets`,
        ),
        body: desired,
        fetchImpl,
        expectedStatuses: [201],
      });
    } catch (mutationError) {
      return verifyAfterAmbiguousMutation(
        mutationError,
        async () => {
          summary = await findRepositoryRuleset(
            configuration,
            repositoryName,
            desired.name,
            fetchImpl,
          );
          if (!summary) return false;
          return payloadMatches(
            await getRepositoryRuleset(
              configuration,
              repositoryName,
              summary.id,
              fetchImpl,
            ),
            desired,
          );
        },
        `${repositoryName} ruleset`,
      );
    }
    summary = await findRepositoryRuleset(
      configuration,
      repositoryName,
      desired.name,
      fetchImpl,
    );
    if (
      !summary ||
      !payloadMatches(
        await getRepositoryRuleset(
          configuration,
          repositoryName,
          summary.id,
          fetchImpl,
        ),
        desired,
      )
    ) {
      throw new Error(
        `Created repository ruleset for ${repositoryName} failed exact verification.`,
      );
    }
    return "created";
  }

  const current = await getRepositoryRuleset(
    configuration,
    repositoryName,
    summary.id,
    fetchImpl,
  );
  if (payloadMatches(current, desired)) return "unchanged";
  try {
    await githubRequest({
      configuration,
      method: "PUT",
      url: apiUrl(
        `${repositoryPath(
          configuration.organizationName,
          repositoryName,
        )}/rulesets/${summary.id}`,
      ),
      body: desired,
      fetchImpl,
    });
  } catch (mutationError) {
    return verifyAfterAmbiguousMutation(
      mutationError,
      async () =>
        payloadMatches(
          await getRepositoryRuleset(
            configuration,
            repositoryName,
            summary.id,
            fetchImpl,
          ),
          desired,
        ),
      `${repositoryName} ruleset`,
    );
  }
  if (
    !payloadMatches(
      await getRepositoryRuleset(
        configuration,
        repositoryName,
        summary.id,
        fetchImpl,
      ),
      desired,
    )
  ) {
    throw new Error(
      `Updated repository ruleset for ${repositoryName} failed exact verification.`,
    );
  }
  return "updated";
}

function validateRepositorySettings(repository, configuration, repositoryName) {
  validateRepositorySummary(repository, configuration.organizationName);
  if (
    repository.name !== repositoryName ||
    repository.full_name !==
      `${configuration.organizationName}/${repositoryName}` ||
    repository.default_branch !== "main"
  ) {
    throw new Error(
      `GitHub returned unexpected repository identity for ${repositoryName}.`,
    );
  }
  for (const [key, expectedValue] of Object.entries(
    REQUIRED_REPOSITORY_SETTINGS,
  )) {
    if (typeof repository[key] !== typeof expectedValue) {
      throw new Error(
        `GitHub returned malformed ${key} for ${repositoryName}.`,
      );
    }
  }
  return repository;
}

function repositorySettingsMatch(repository, desired) {
  return Object.entries(desired).every(
    ([key, value]) => repository[key] === value,
  );
}

async function getRepository(configuration, repositoryName, fetchImpl) {
  const repository = await githubRequest({
    configuration,
    url: apiUrl(repositoryPath(configuration.organizationName, repositoryName)),
    fetchImpl,
  });
  return validateRepositorySettings(repository, configuration, repositoryName);
}

async function ensureRepositorySettings(
  configuration,
  repositoryName,
  desired,
  fetchImpl,
) {
  const current = await getRepository(configuration, repositoryName, fetchImpl);
  if (repositorySettingsMatch(current, desired)) return "unchanged";
  try {
    await githubRequest({
      configuration,
      method: "PATCH",
      url: apiUrl(
        repositoryPath(configuration.organizationName, repositoryName),
      ),
      body: desired,
      fetchImpl,
    });
  } catch (mutationError) {
    return verifyAfterAmbiguousMutation(
      mutationError,
      async () =>
        repositorySettingsMatch(
          await getRepository(configuration, repositoryName, fetchImpl),
          desired,
        ),
      `${repositoryName} settings`,
    );
  }
  if (
    !repositorySettingsMatch(
      await getRepository(configuration, repositoryName, fetchImpl),
      desired,
    )
  ) {
    throw new Error(
      `Updated repository settings for ${repositoryName} failed exact verification.`,
    );
  }
  return "updated";
}

async function preflightManagedRulesetOwnership(
  configuration,
  policy,
  repositories,
  fetchImpl,
) {
  await findOrganizationRuleset(
    configuration,
    policy.organization_ruleset.name,
    fetchImpl,
  );
  for (const repository of repositories) {
    await findRepositoryRuleset(
      configuration,
      repository.name,
      policy.repository_status_ruleset.name,
      fetchImpl,
    );
    await findRepositoryRuleset(
      configuration,
      repository.name,
      policy.repository_queue_ruleset.name,
      fetchImpl,
    );
  }
}

export async function reconcileNativeGovernance(
  configuration,
  policyCandidate,
  { fetchImpl = fetch } = {},
) {
  const policy = validatePolicy(policyCandidate);
  if (configuration.organizationName !== policy.organization) {
    throw new Error(
      "Runtime organization does not match the native governance policy.",
    );
  }

  const initialInventory = await listRepositories(configuration, fetchImpl);
  assertInventoryCovered(initialInventory, policy);
  const active = activeRepositories(initialInventory);

  await preflightManagedRulesetOwnership(
    configuration,
    policy,
    active,
    fetchImpl,
  );

  let organizationRulesetOutcome;
  const outcomes = new Map();
  const reconcileOrganizationRuleset = async () => {
    organizationRulesetOutcome = await ensureOrganizationRuleset(
      configuration,
      buildOrganizationRuleset(policy),
      fetchImpl,
    );
  };
  const reconcileStatusRulesets = async () => {
    for (const repository of active) {
      const statusRuleset = await ensureRepositoryRuleset(
        configuration,
        repository.name,
        buildRepositoryStatusRuleset(policy, repository.name),
        fetchImpl,
      );
      outcomes.set(repository.name, {
        ...outcomes.get(repository.name),
        statusRuleset,
      });
    }
  };
  const reconcileQueueRulesets = async (predicate = () => true) => {
    for (const repository of active.filter(predicate)) {
      const queueRuleset = await ensureRepositoryRuleset(
        configuration,
        repository.name,
        buildRepositoryQueueRuleset(policy, repository.name),
        fetchImpl,
      );
      outcomes.set(repository.name, {
        ...outcomes.get(repository.name),
        queueRuleset,
      });
    }
  };

  if (policy.organization_ruleset.enforcement === "active") {
    await reconcileOrganizationRuleset();
    await reconcileQueueRulesets(
      (repository) =>
        policy.repositories[repository.name].queue_enforcement !== "active",
    );
    await reconcileStatusRulesets();
    await reconcileQueueRulesets(
      (repository) =>
        policy.repositories[repository.name].queue_enforcement === "active",
    );
  } else {
    await reconcileQueueRulesets();
    await reconcileStatusRulesets();
    await reconcileOrganizationRuleset();
  }

  for (const repository of active) {
    const settings = await ensureRepositorySettings(
      configuration,
      repository.name,
      policy.repository_settings,
      fetchImpl,
    );
    outcomes.set(repository.name, {
      name: repository.name,
      settings,
      statusRuleset: outcomes.get(repository.name).statusRuleset,
      queueRuleset: outcomes.get(repository.name).queueRuleset,
    });
  }

  const finalInventory = await listRepositories(configuration, fetchImpl);
  assertInventoryCovered(finalInventory, policy);
  const initialNames = active.map((repository) => repository.name);
  const finalNames = activeRepositories(finalInventory).map(
    (repository) => repository.name,
  );
  if (JSON.stringify(initialNames) !== JSON.stringify(finalNames)) {
    throw new Error(
      "Active repository inventory changed during native governance reconciliation.",
    );
  }

  return Object.freeze({
    activeRepositoryCount: active.length,
    organizationRulesetOutcome,
    repositories: Object.freeze(
      active.map((repository) => Object.freeze(outcomes.get(repository.name))),
    ),
  });
}

export async function loadPolicy(policyUrl = DEFAULT_POLICY_URL) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(policyUrl, "utf8"));
  } catch (error) {
    throw new Error("Native governance policy could not be loaded.", {
      cause: error,
    });
  }
  return validatePolicy(parsed);
}

async function main() {
  const configuration = readConfiguration();
  const policy = await loadPolicy();
  const result = await reconcileNativeGovernance(configuration, policy);
  console.log(JSON.stringify(result));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
