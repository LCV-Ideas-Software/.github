import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  API_VERSION,
  assertConfigurationOnlyRequest,
  buildOrganizationRuleset,
  buildRepositoryQueueRuleset,
  buildRepositoryStatusRuleset,
  readConfiguration,
  reconcileNativeGovernance,
  validatePolicy,
} from "./github-native-governance.mjs";

const ORGANIZATION = "LCV-Ideas-Software";
const POLICY_URL = new URL("../native-governance/policy.json", import.meta.url);

async function policyFixture() {
  return validatePolicy(JSON.parse(await readFile(POLICY_URL, "utf8")));
}

function repository(
  name,
  {
    id = [...name].reduce(
      (total, character) => total + character.charCodeAt(0),
      1,
    ),
    archived = false,
    disabled = false,
    settings = {},
  } = {},
) {
  return {
    id,
    name,
    full_name: `${ORGANIZATION}/${name}`,
    owner: { login: ORGANIZATION },
    archived,
    disabled,
    default_branch: "main",
    has_pull_requests: false,
    pull_request_creation_policy: "all",
    allow_squash_merge: false,
    allow_merge_commit: true,
    allow_rebase_merge: true,
    allow_auto_merge: false,
    delete_branch_on_merge: false,
    ...settings,
  };
}

function response(status, body, headers = {}) {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function rulesetRecord(id, owner, payload, sourceType) {
  return {
    id,
    ...structuredClone(payload),
    source_type: sourceType,
    source: owner,
  };
}

function fakeGitHub({
  repositories,
  organizationRulesets = [],
  rulesets = {},
}) {
  const state = {
    repositories: new Map(
      repositories.map((candidate) => [
        candidate.name,
        structuredClone(candidate),
      ]),
    ),
    organizationRulesets: organizationRulesets.map((candidate) =>
      structuredClone(candidate),
    ),
    repositoryRulesets: new Map(
      Object.entries(rulesets).map(([name, candidates]) => [
        name,
        candidates.map((candidate) => structuredClone(candidate)),
      ]),
    ),
  };
  const requests = [];
  let nextRulesetId = 10_000;

  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const method = options.method ?? "GET";
    const body =
      options.body === undefined ? undefined : JSON.parse(options.body);
    requests.push({
      method,
      pathname: parsed.pathname,
      search: parsed.search,
      body,
    });

    if (parsed.pathname === `/orgs/${ORGANIZATION}/repos` && method === "GET") {
      const page = Number(parsed.searchParams.get("page"));
      return response(
        page === 1 ? 200 : 200,
        page === 1 ? [...state.repositories.values()] : [],
      );
    }

    if (parsed.pathname === `/orgs/${ORGANIZATION}/rulesets`) {
      if (method === "GET") {
        return response(
          200,
          state.organizationRulesets.map(
            ({ id, name, target, enforcement, source_type, source }) => ({
              id,
              name,
              target,
              enforcement,
              source_type,
              source,
            }),
          ),
        );
      }
      if (method === "POST") {
        const created = rulesetRecord(
          nextRulesetId++,
          ORGANIZATION,
          body,
          "Organization",
        );
        state.organizationRulesets.push(created);
        return response(201, created);
      }
    }

    const organizationRulesetMatch = parsed.pathname.match(
      new RegExp(`^/orgs/${ORGANIZATION}/rulesets/(\\d+)$`),
    );
    if (organizationRulesetMatch) {
      const id = Number(organizationRulesetMatch[1]);
      const index = state.organizationRulesets.findIndex(
        (candidate) => candidate.id === id,
      );
      if (index < 0) return response(404, { message: "not found" });
      if (method === "GET")
        return response(200, state.organizationRulesets[index]);
      if (method === "PUT") {
        state.organizationRulesets[index] = rulesetRecord(
          id,
          ORGANIZATION,
          body,
          "Organization",
        );
        return response(200, state.organizationRulesets[index]);
      }
    }

    const repositoryMatch = parsed.pathname.match(
      new RegExp(`^/repos/${ORGANIZATION}/([^/]+)$`),
    );
    if (repositoryMatch) {
      const name = decodeURIComponent(repositoryMatch[1]);
      const current = state.repositories.get(name);
      if (!current) return response(404, { message: "not found" });
      if (method === "GET") return response(200, current);
      if (method === "PATCH") {
        const updated = { ...current, ...body };
        state.repositories.set(name, updated);
        return response(200, updated);
      }
    }

    const rulesetsMatch = parsed.pathname.match(
      new RegExp(`^/repos/${ORGANIZATION}/([^/]+)/rulesets$`),
    );
    if (rulesetsMatch) {
      const name = decodeURIComponent(rulesetsMatch[1]);
      const candidates = state.repositoryRulesets.get(name) ?? [];
      if (method === "GET") {
        assert.equal(parsed.searchParams.get("includes_parents"), "false");
        return response(
          200,
          candidates.map(
            ({
              id,
              name: rulesetName,
              target,
              enforcement,
              source_type,
              source,
            }) => ({
              id,
              name: rulesetName,
              target,
              enforcement,
              source_type,
              source,
            }),
          ),
        );
      }
      if (method === "POST") {
        const created = rulesetRecord(
          nextRulesetId++,
          `${ORGANIZATION}/${name}`,
          body,
          "Repository",
        );
        state.repositoryRulesets.set(name, [...candidates, created]);
        return response(201, created);
      }
    }

    const rulesetMatch = parsed.pathname.match(
      new RegExp(`^/repos/${ORGANIZATION}/([^/]+)/rulesets/(\\d+)$`),
    );
    if (rulesetMatch) {
      const name = decodeURIComponent(rulesetMatch[1]);
      const id = Number(rulesetMatch[2]);
      const candidates = state.repositoryRulesets.get(name) ?? [];
      const index = candidates.findIndex((candidate) => candidate.id === id);
      if (index < 0) return response(404, { message: "not found" });
      if (method === "GET") return response(200, candidates[index]);
      if (method === "PUT") {
        candidates[index] = rulesetRecord(
          id,
          `${ORGANIZATION}/${name}`,
          body,
          "Repository",
        );
        state.repositoryRulesets.set(name, candidates);
        return response(200, candidates[index]);
      }
    }

    return response(500, {
      message: `unexpected ${method} ${parsed.pathname}`,
    });
  };

  return { fetchImpl, requests, state };
}

function configuration() {
  return { organizationName: ORGANIZATION, token: "secret-token" };
}

test("configuration is restricted to signed-main execution in the organization .github repository", () => {
  assert.deepEqual(
    readConfiguration({
      GITHUB_REF: "refs/heads/main",
      GITHUB_REPOSITORY: `${ORGANIZATION}/.github`,
      ORGANIZATION_NAME: ORGANIZATION,
      TOKEN: "secret-token",
    }),
    configuration(),
  );

  for (const environment of [
    {
      GITHUB_REF: "refs/pull/123/merge",
      GITHUB_REPOSITORY: `${ORGANIZATION}/.github`,
      ORGANIZATION_NAME: ORGANIZATION,
      TOKEN: "secret-token",
    },
    {
      GITHUB_REF: "refs/heads/main",
      GITHUB_REPOSITORY: `${ORGANIZATION}/another-repository`,
      ORGANIZATION_NAME: ORGANIZATION,
      TOKEN: "secret-token",
    },
  ]) {
    assert.throws(() => readConfiguration(environment), /restricted|must run/);
  }
});

test("policy renders a native organization zero-tolerance ruleset without a merge queue", async () => {
  const policy = await policyFixture();
  const payload = buildOrganizationRuleset(policy);

  assert.equal(payload.enforcement, "evaluate");
  assert.deepEqual(payload.bypass_actors, []);
  assert.deepEqual(payload.conditions, {
    repository_name: { include: ["~ALL"], exclude: [], protected: false },
    ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] },
  });
  assert.deepEqual(
    payload.rules.map(({ type }) => type),
    [
      "deletion",
      "required_linear_history",
      "required_signatures",
      "pull_request",
      "non_fast_forward",
      "code_scanning",
      "copilot_code_review",
    ],
  );
  assert.equal(
    payload.rules.some(({ type }) => type === "merge_queue"),
    false,
  );

  const pullRequest = payload.rules.find(({ type }) => type === "pull_request");
  assert.deepEqual(pullRequest.parameters.allowed_merge_methods, ["squash"]);
  assert.equal(pullRequest.parameters.required_approving_review_count, 0);
  assert.equal(pullRequest.parameters.required_review_thread_resolution, true);

  const codeScanning = payload.rules.find(
    ({ type }) => type === "code_scanning",
  );
  assert.deepEqual(codeScanning.parameters.code_scanning_tools, [
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
  ]);

  const copilot = payload.rules.find(
    ({ type }) => type === "copilot_code_review",
  );
  assert.deepEqual(copilot.parameters, {
    review_draft_pull_requests: false,
    review_on_push: true,
  });
});

test("repository status and queue rulesets are independent and disabled initially", async () => {
  const policy = await policyFixture();
  const statusPayload = buildRepositoryStatusRuleset(policy, ".github");
  const queuePayload = buildRepositoryQueueRuleset(policy, ".github");

  assert.notEqual(statusPayload.name, queuePayload.name);
  assert.ok(
    Object.values(policy.repositories).every(
      ({ status_enforcement, queue_enforcement }) =>
        status_enforcement === "disabled" && queue_enforcement === "disabled",
    ),
  );
  assert.equal(statusPayload.enforcement, "disabled");
  assert.equal(queuePayload.enforcement, "disabled");
  assert.deepEqual(statusPayload.bypass_actors, []);
  assert.deepEqual(queuePayload.bypass_actors, []);
  assert.deepEqual(statusPayload.conditions, {
    ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] },
  });
  assert.deepEqual(queuePayload.conditions, statusPayload.conditions);
  assert.deepEqual(queuePayload.rules, [
    {
      type: "merge_queue",
      parameters: {
        check_response_timeout_minutes: 60,
        grouping_strategy: "ALLGREEN",
        max_entries_to_build: 1,
        max_entries_to_merge: 1,
        merge_method: "SQUASH",
        min_entries_to_merge: 1,
        min_entries_to_merge_wait_minutes: 0,
      },
    },
  ]);

  assert.equal(statusPayload.rules.length, 1);
  const statusRule = statusPayload.rules[0];
  assert.equal(statusRule.type, "required_status_checks");
  assert.equal(
    statusRule.parameters.strict_required_status_checks_policy,
    false,
  );
  assert.ok(
    statusRule.parameters.required_status_checks.some(
      ({ context, integration_id }) =>
        context === "Test native governance" && integration_id === 15368,
    ),
  );
  assert.ok(
    statusRule.parameters.required_status_checks.some(
      ({ context, integration_id }) =>
        context === "Test native auto-merge" && integration_id === 15368,
    ),
  );
  assert.ok(
    statusRule.parameters.required_status_checks.some(
      ({ context, integration_id }) =>
        context === "Analyze actions" && integration_id === 15368,
    ),
  );
  assert.ok(
    statusRule.parameters.required_status_checks.some(
      ({ context, integration_id }) =>
        context === "Run zizmor" && integration_id === 15368,
    ),
  );
  assert.equal(
    statusRule.parameters.required_status_checks.some(
      ({ integration_id }) => integration_id === 57789,
    ),
    false,
  );
  assert.equal(
    statusRule.parameters.required_status_checks.some(({ context }) =>
      /trusted|dependabot controller|copilot|chatgpt|provenance/i.test(context),
    ),
    false,
  );

  const stagedCandidate = structuredClone(policy);
  stagedCandidate.organization_ruleset.enforcement = "active";
  stagedCandidate.repositories[".github-private"].status_enforcement = "active";
  stagedCandidate.repositories[".github-private"].queue_enforcement = "active";
  const stagedPolicy = validatePolicy(stagedCandidate);
  assert.equal(
    buildRepositoryStatusRuleset(stagedPolicy, ".github-private").enforcement,
    "active",
  );
  assert.equal(
    buildRepositoryQueueRuleset(stagedPolicy, ".github-private").enforcement,
    "active",
  );
  assert.equal(
    buildRepositoryStatusRuleset(stagedPolicy, ".github").enforcement,
    "disabled",
  );
  assert.equal(
    buildRepositoryQueueRuleset(stagedPolicy, ".github").enforcement,
    "disabled",
  );
});

test("unsafe policy extensions, bypasses, and organization merge queues are rejected", async () => {
  const policy = structuredClone(await policyFixture());
  policy.provenance = {};
  assert.throws(() => validatePolicy(policy), /unknown key.*provenance/i);

  const protectedAllRepositories = structuredClone(await policyFixture());
  protectedAllRepositories.organization_ruleset.conditions.repository_name.protected = true;
  assert.throws(
    () => validatePolicy(protectedAllRepositories),
    /organization_ruleset\.conditions/i,
  );

  const bypass = structuredClone(await policyFixture());
  bypass.organization_ruleset.bypass_actors.push({
    actor_id: 1,
    actor_type: "OrganizationAdmin",
    bypass_mode: "always",
  });
  assert.throws(() => validatePolicy(bypass), /bypass/i);

  const queue = structuredClone(await policyFixture());
  queue.organization_ruleset.rules.push({
    type: "merge_queue",
    parameters: {},
  });
  assert.throws(() => validatePolicy(queue), /organization.*merge_queue/i);

  const bot = structuredClone(await policyFixture());
  bot.repositories[".github"].required_checks.push({
    name: "Copilot must review",
    app_id: 15368,
  });
  assert.throws(() => validatePolicy(bot), /bot.*required check/i);

  for (const legacyContext of [
    "LCV Trusted Gate",
    "Dependabot Automerge",
    "Codex Review",
  ]) {
    const legacy = structuredClone(await policyFixture());
    legacy.repositories[".github"].required_checks.push({
      name: legacyContext,
      app_id: 15368,
    });
    assert.throws(() => validatePolicy(legacy), /bot.*required check/i);
  }

  const ghas = structuredClone(await policyFixture());
  ghas.repositories[".github"].required_checks.push({
    name: "CodeQL",
    app_id: 57789,
  });
  assert.throws(() => validatePolicy(ghas), /GHAS summary check.*forbidden/i);

  const invalidEnforcement = structuredClone(await policyFixture());
  invalidEnforcement.repositories[".github-private"].status_enforcement =
    "observe";
  assert.throws(
    () => validatePolicy(invalidEnforcement),
    /repositories\..*status_enforcement is invalid/i,
  );

  const unsafePromotion = structuredClone(await policyFixture());
  unsafePromotion.repositories[".github-private"].queue_enforcement = "active";
  assert.throws(
    () => validatePolicy(unsafePromotion),
    /active queue requires an active status ruleset/i,
  );

  const activeStatusWithoutOrganization = structuredClone(
    await policyFixture(),
  );
  activeStatusWithoutOrganization.repositories[
    ".github-private"
  ].status_enforcement = "active";
  assert.throws(
    () => validatePolicy(activeStatusWithoutOrganization),
    /active repository ruleset requires the organization ruleset to be active/i,
  );

  const duplicateNames = structuredClone(await policyFixture());
  duplicateNames.repository_queue_ruleset.name =
    duplicateNames.repository_status_ruleset.name;
  assert.throws(
    () => validatePolicy(duplicateNames),
    /status and queue ruleset names must be distinct/i,
  );
});

test("the HTTP boundary rejects every pull-request and merge mutation", () => {
  for (const [method, pathname] of [
    ["PUT", `/repos/${ORGANIZATION}/example/pulls/1/merge`],
    ["POST", `/graphql`],
    ["DELETE", `/repos/${ORGANIZATION}/example/git/refs/heads/topic`],
  ]) {
    assert.throws(
      () =>
        assertConfigurationOnlyRequest(
          method,
          new URL(pathname, "https://api.github.com"),
        ),
      /outside the configuration-only boundary/,
    );
  }
});

test("the required governance check also protects both organization auditors", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/native-governance.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /\n\s+name: Test native governance\n/);
  for (const script of [
    "github-native-governance",
    "github-actions-pin-audit",
    "oss-advisory-watch",
  ]) {
    assert.match(workflow, new RegExp(`node --check scripts/${script}\\.mjs`));
    assert.match(workflow, new RegExp(`scripts/${script}\\.test\\.mjs`));
  }
  assert.match(workflow, /environment: github-administration/);
  assert.doesNotMatch(
    workflow,
    /gh pr merge|enqueuePullRequest|enablePullRequestAutoMerge|\/pulls\/.*\/merge/,
  );
});

test("manual onboarding copies the automation token only into a policy repository with an exact protected environment", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/native-governance.yml", import.meta.url),
    "utf8",
  );

  assert.match(workflow, /bootstrap_repository:/);
  assert.match(
    workflow,
    /github\.event_name == 'workflow_dispatch'[\s\S]*inputs\.bootstrap_repository != ''/,
  );
  assert.match(workflow, /github\.actor_id == '268063598'/);
  assert.match(workflow, /environment: github-administration/);
  assert.match(workflow, /native-governance\/policy\.json/);
  assert.match(workflow, /deployment-branch-policies/);
  assert.match(
    workflow,
    /printf '%s' "\$AUTOMATION_TOKEN" \| gh secret set LCV_AUTOMATION_TOKEN/,
  );
  assert.match(workflow, /--env dependabot-automation/);
  assert.doesNotMatch(workflow, /gh secret set[^\n]*--body/);
  assert.match(
    workflow,
    /github\.event_name == 'schedule' \|\|[\s\S]*inputs\.bootstrap_repository == ''/,
  );
});

test("an unknown active repository fails closed before any mutation", async () => {
  const policy = await policyFixture();
  const api = fakeGitHub({ repositories: [repository("not-in-policy")] });

  await assert.rejects(
    reconcileNativeGovernance(configuration(), policy, {
      fetchImpl: api.fetchImpl,
    }),
    /active repositories absent from policy: not-in-policy/i,
  );
  assert.deepEqual(
    api.requests.map(({ method, pathname }) => `${method} ${pathname}`),
    [`GET /orgs/${ORGANIZATION}/repos`],
  );
});

test("a policy-covered repository without main as default fails before mutation", async () => {
  const policy = await policyFixture();
  const api = fakeGitHub({
    repositories: [
      repository(".github", { settings: { default_branch: "develop" } }),
    ],
  });

  await assert.rejects(
    reconcileNativeGovernance(configuration(), policy, {
      fetchImpl: api.fetchImpl,
    }),
    /without main as default branch: \.github/i,
  );
  assert.equal(
    api.requests.some(({ method }) => method !== "GET"),
    false,
  );
});

test("reconciliation stages each repository independently and remains idempotent", async () => {
  const candidate = structuredClone(await policyFixture());
  candidate.organization_ruleset.enforcement = "active";
  candidate.repositories[".github-private"].status_enforcement = "active";
  candidate.repositories[".github-private"].queue_enforcement = "active";
  const policy = validatePolicy(candidate);
  const api = fakeGitHub({
    repositories: [repository(".github"), repository(".github-private")],
  });

  const result = await reconcileNativeGovernance(configuration(), policy, {
    fetchImpl: api.fetchImpl,
  });

  assert.equal(result.activeRepositoryCount, 2);
  assert.equal(result.organizationRulesetOutcome, "created");
  assert.deepEqual(result.repositories, [
    {
      name: ".github",
      settings: "updated",
      statusRuleset: "created",
      queueRuleset: "created",
    },
    {
      name: ".github-private",
      settings: "updated",
      statusRuleset: "created",
      queueRuleset: "created",
    },
  ]);

  const writes = api.requests.filter(({ method }) => method !== "GET");
  assert.deepEqual(
    writes.map(({ method, pathname }) => `${method} ${pathname}`),
    [
      `POST /orgs/${ORGANIZATION}/rulesets`,
      `POST /repos/${ORGANIZATION}/.github/rulesets`,
      `POST /repos/${ORGANIZATION}/.github/rulesets`,
      `POST /repos/${ORGANIZATION}/.github-private/rulesets`,
      `POST /repos/${ORGANIZATION}/.github-private/rulesets`,
      `PATCH /repos/${ORGANIZATION}/.github`,
      `PATCH /repos/${ORGANIZATION}/.github-private`,
    ],
  );
  assert.equal(writes[0].body.enforcement, "active");
  assert.equal(writes[1].body.enforcement, "disabled");
  assert.equal(writes[1].body.rules[0].type, "merge_queue");
  assert.equal(writes[2].body.enforcement, "disabled");
  assert.equal(writes[3].body.enforcement, "active");
  assert.equal(writes[2].body.rules[0].type, "required_status_checks");
  assert.equal(writes[3].body.rules[0].type, "required_status_checks");
  assert.equal(writes[4].body.enforcement, "active");
  assert.equal(writes[4].body.rules[0].type, "merge_queue");
  assert.deepEqual(writes[5].body, {
    has_pull_requests: true,
    pull_request_creation_policy: "collaborators_only",
    allow_squash_merge: true,
    allow_merge_commit: false,
    allow_rebase_merge: false,
    allow_auto_merge: true,
    delete_branch_on_merge: true,
  });
  assert.deepEqual(writes[6].body, writes[5].body);

  api.requests.length = 0;
  const second = await reconcileNativeGovernance(configuration(), policy, {
    fetchImpl: api.fetchImpl,
  });
  assert.equal(second.organizationRulesetOutcome, "unchanged");
  assert.deepEqual(second.repositories, [
    {
      name: ".github",
      settings: "unchanged",
      statusRuleset: "unchanged",
      queueRuleset: "unchanged",
    },
    {
      name: ".github-private",
      settings: "unchanged",
      statusRuleset: "unchanged",
      queueRuleset: "unchanged",
    },
  ]);
  assert.equal(
    api.requests.some(({ method }) => method !== "GET"),
    false,
  );
});

test("queue rollback preserves an active status ruleset", async () => {
  const candidate = structuredClone(await policyFixture());
  candidate.organization_ruleset.enforcement = "active";
  candidate.repositories[".github-private"].status_enforcement = "active";
  candidate.repositories[".github-private"].queue_enforcement = "disabled";
  const policy = validatePolicy(candidate);
  const desiredOrganization = buildOrganizationRuleset(policy);
  const desiredStatus = buildRepositoryStatusRuleset(policy, ".github-private");
  const desiredQueue = buildRepositoryQueueRuleset(policy, ".github-private");
  const api = fakeGitHub({
    repositories: [
      repository(".github-private", { settings: policy.repository_settings }),
    ],
    organizationRulesets: [
      rulesetRecord(1, ORGANIZATION, desiredOrganization, "Organization"),
    ],
    rulesets: {
      ".github-private": [
        rulesetRecord(
          2,
          `${ORGANIZATION}/.github-private`,
          desiredStatus,
          "Repository",
        ),
        rulesetRecord(
          3,
          `${ORGANIZATION}/.github-private`,
          { ...desiredQueue, enforcement: "active" },
          "Repository",
        ),
      ],
    },
  });

  const result = await reconcileNativeGovernance(configuration(), policy, {
    fetchImpl: api.fetchImpl,
  });
  assert.deepEqual(result.repositories, [
    {
      name: ".github-private",
      settings: "unchanged",
      statusRuleset: "unchanged",
      queueRuleset: "updated",
    },
  ]);
  const writes = api.requests.filter(({ method }) => method !== "GET");
  assert.deepEqual(
    writes.map(({ method, pathname, body }) => ({
      method,
      pathname,
      name: body.name,
      enforcement: body.enforcement,
    })),
    [
      {
        method: "PUT",
        pathname: `/repos/${ORGANIZATION}/.github-private/rulesets/3`,
        name: desiredQueue.name,
        enforcement: "disabled",
      },
    ],
  );
  const liveRulesets = api.state.repositoryRulesets.get(".github-private");
  assert.equal(
    liveRulesets.find(({ name }) => name === desiredStatus.name).enforcement,
    "active",
  );
  assert.equal(
    liveRulesets.find(({ name }) => name === desiredQueue.name).enforcement,
    "disabled",
  );
});

test("repository demotion disables its queue before its status checks", async () => {
  const candidate = structuredClone(await policyFixture());
  candidate.organization_ruleset.enforcement = "active";
  const policy = validatePolicy(candidate);
  const desiredOrganization = buildOrganizationRuleset(policy);
  const desiredStatus = buildRepositoryStatusRuleset(policy, ".github-private");
  const desiredQueue = buildRepositoryQueueRuleset(policy, ".github-private");
  const api = fakeGitHub({
    repositories: [
      repository(".github-private", { settings: policy.repository_settings }),
    ],
    organizationRulesets: [
      rulesetRecord(1, ORGANIZATION, desiredOrganization, "Organization"),
    ],
    rulesets: {
      ".github-private": [
        rulesetRecord(
          2,
          `${ORGANIZATION}/.github-private`,
          { ...desiredStatus, enforcement: "active" },
          "Repository",
        ),
        rulesetRecord(
          3,
          `${ORGANIZATION}/.github-private`,
          { ...desiredQueue, enforcement: "active" },
          "Repository",
        ),
      ],
    },
  });

  await reconcileNativeGovernance(configuration(), policy, {
    fetchImpl: api.fetchImpl,
  });

  assert.deepEqual(
    api.requests
      .filter(({ method }) => method === "PUT")
      .map(({ pathname, body }) => ({
        pathname,
        name: body.name,
        enforcement: body.enforcement,
      })),
    [
      {
        pathname: `/repos/${ORGANIZATION}/.github-private/rulesets/3`,
        name: desiredQueue.name,
        enforcement: "disabled",
      },
      {
        pathname: `/repos/${ORGANIZATION}/.github-private/rulesets/2`,
        name: desiredStatus.name,
        enforcement: "disabled",
      },
    ],
  );
});

test("organization demotion disables queues, then statuses, then the organization", async () => {
  const policy = await policyFixture();
  const desiredOrganization = buildOrganizationRuleset(policy);
  const desiredStatus = buildRepositoryStatusRuleset(policy, ".github");
  const desiredQueue = buildRepositoryQueueRuleset(policy, ".github");
  const api = fakeGitHub({
    repositories: [
      repository(".github", { settings: policy.repository_settings }),
    ],
    organizationRulesets: [
      rulesetRecord(
        1,
        ORGANIZATION,
        { ...desiredOrganization, enforcement: "active" },
        "Organization",
      ),
    ],
    rulesets: {
      ".github": [
        rulesetRecord(
          2,
          `${ORGANIZATION}/.github`,
          { ...desiredStatus, enforcement: "active" },
          "Repository",
        ),
        rulesetRecord(
          3,
          `${ORGANIZATION}/.github`,
          { ...desiredQueue, enforcement: "active" },
          "Repository",
        ),
      ],
    },
  });

  const result = await reconcileNativeGovernance(configuration(), policy, {
    fetchImpl: api.fetchImpl,
  });
  assert.equal(result.organizationRulesetOutcome, "updated");
  assert.deepEqual(result.repositories, [
    {
      name: ".github",
      settings: "unchanged",
      statusRuleset: "updated",
      queueRuleset: "updated",
    },
  ]);
  assert.deepEqual(
    api.requests
      .filter(({ method }) => method === "PUT")
      .map(({ pathname, body }) => ({
        pathname,
        name: body.name,
        enforcement: body.enforcement,
      })),
    [
      {
        pathname: `/repos/${ORGANIZATION}/.github/rulesets/3`,
        name: desiredQueue.name,
        enforcement: "disabled",
      },
      {
        pathname: `/repos/${ORGANIZATION}/.github/rulesets/2`,
        name: desiredStatus.name,
        enforcement: "disabled",
      },
      {
        pathname: `/orgs/${ORGANIZATION}/rulesets/1`,
        name: desiredOrganization.name,
        enforcement: "evaluate",
      },
    ],
  );
});

test("managed ruleset drift is updated, while duplicate ownership fails closed", async () => {
  const policy = await policyFixture();
  const desiredOrganization = buildOrganizationRuleset(policy);
  const desiredStatus = buildRepositoryStatusRuleset(policy, ".github");
  const desiredQueue = buildRepositoryQueueRuleset(policy, ".github");
  const active = repository(".github", {
    settings: policy.repository_settings,
  });
  const driftedOrganization = rulesetRecord(
    1,
    ORGANIZATION,
    { ...desiredOrganization, enforcement: "disabled" },
    "Organization",
  );
  const driftedStatus = rulesetRecord(
    2,
    `${ORGANIZATION}/.github`,
    { ...desiredStatus, enforcement: "evaluate" },
    "Repository",
  );
  const driftedQueue = rulesetRecord(
    3,
    `${ORGANIZATION}/.github`,
    { ...desiredQueue, enforcement: "evaluate" },
    "Repository",
  );
  const api = fakeGitHub({
    repositories: [active],
    organizationRulesets: [driftedOrganization],
    rulesets: { ".github": [driftedStatus, driftedQueue] },
  });

  const result = await reconcileNativeGovernance(configuration(), policy, {
    fetchImpl: api.fetchImpl,
  });
  assert.equal(result.organizationRulesetOutcome, "updated");
  assert.equal(result.repositories[0].statusRuleset, "updated");
  assert.equal(result.repositories[0].queueRuleset, "updated");
  assert.equal(api.requests.filter(({ method }) => method === "PUT").length, 3);

  const duplicate = fakeGitHub({
    repositories: [active],
    organizationRulesets: [
      rulesetRecord(10, ORGANIZATION, desiredOrganization, "Organization"),
      rulesetRecord(11, ORGANIZATION, desiredOrganization, "Organization"),
    ],
  });
  await assert.rejects(
    reconcileNativeGovernance(configuration(), policy, {
      fetchImpl: duplicate.fetchImpl,
    }),
    /duplicate managed organization rulesets/i,
  );
  assert.equal(
    duplicate.requests.some(({ method }) => method !== "GET"),
    false,
  );

  for (const duplicatedPayload of [desiredStatus, desiredQueue]) {
    const otherPayload =
      duplicatedPayload === desiredStatus ? desiredQueue : desiredStatus;
    const duplicateRepositoryRuleset = fakeGitHub({
      repositories: [active],
      organizationRulesets: [
        rulesetRecord(20, ORGANIZATION, desiredOrganization, "Organization"),
      ],
      rulesets: {
        ".github": [
          rulesetRecord(
            21,
            `${ORGANIZATION}/.github`,
            duplicatedPayload,
            "Repository",
          ),
          rulesetRecord(
            22,
            `${ORGANIZATION}/.github`,
            duplicatedPayload,
            "Repository",
          ),
          rulesetRecord(
            23,
            `${ORGANIZATION}/.github`,
            otherPayload,
            "Repository",
          ),
        ],
      },
    });
    await assert.rejects(
      reconcileNativeGovernance(configuration(), policy, {
        fetchImpl: duplicateRepositoryRuleset.fetchImpl,
      }),
      /duplicate managed repository rulesets/i,
    );
    assert.equal(
      duplicateRepositoryRuleset.requests.some(
        ({ method }) => method !== "GET",
      ),
      false,
    );
  }
});

test("API failures retain diagnostics without exposing the token", async () => {
  const policy = await policyFixture();
  const fetchImpl = async () =>
    response(403, { message: "forbidden" }, { "x-github-sso": "required" });

  await assert.rejects(
    reconcileNativeGovernance(configuration(), policy, { fetchImpl }),
    (error) => {
      assert.match(error.message, /HTTP 403/);
      assert.match(error.message, /sso-authorization=required/);
      assert.doesNotMatch(error.message, /secret-token/);
      return true;
    },
  );
});

test("all requests use the current API version and never expose credentials in URLs", async () => {
  const policy = await policyFixture();
  const api = fakeGitHub({ repositories: [repository(".github")] });
  const wrappedFetch = async (url, options) => {
    assert.equal(options.headers["X-GitHub-Api-Version"], API_VERSION);
    assert.equal(options.headers.Authorization, "Bearer secret-token");
    assert.doesNotMatch(String(url), /secret-token/);
    return api.fetchImpl(url, options);
  };

  await reconcileNativeGovernance(configuration(), policy, {
    fetchImpl: wrappedFetch,
  });
});
