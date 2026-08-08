import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  extractCandidates,
  githubGetEffectiveRules,
  githubGetNativeState,
  githubGetPull,
  hasRequiredNativeEnforcement,
  isEligiblePull,
  loadRequiredChecks,
  runGhAutoMerge,
  runNativeAutoMerge,
} from "./main.mjs";

const REPOSITORY = "LCV-Ideas-Software/.github";
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const LCV_LEO = { login: "lcv-leo", id: 268063598 };
const DEPENDABOT = { login: "dependabot[bot]", id: 49699333 };
const POLICY_REQUIRED_CHECKS = [
  { name: "Dependency Review", app_id: 15368 },
  { name: "Check index.html formatting", app_id: 15368 },
  { name: "Analyze actions", app_id: 15368 },
  { name: "Analyze javascript-typescript", app_id: 15368 },
  { name: "Run zizmor", app_id: 15368 },
  { name: "OpenSSF Scorecard", app_id: 15368 },
  { name: "Build Pages artifact", app_id: 15368 },
  { name: "Verify relay and recovery controller", app_id: 15368 },
  { name: "Verify Slack workflow app", app_id: 15368 },
  { name: "Test native governance", app_id: 15368 },
  { name: "Test native auto-merge", app_id: 15368 },
];

function pull(overrides = {}) {
  return {
    number: 81,
    state: "open",
    draft: false,
    user: LCV_LEO,
    head: {
      sha: HEAD_SHA,
      ref: "agent/native-governance-redesign",
      repo: { full_name: REPOSITORY },
    },
    base: {
      ref: "main",
      repo: { full_name: REPOSITORY },
    },
    auto_merge: null,
    ...overrides,
  };
}

function workflowRunEvent(overrides = {}) {
  return {
    repository: { full_name: REPOSITORY },
    workflow_run: {
      name: "CodeQL",
      status: "completed",
      event: "pull_request",
      head_sha: HEAD_SHA,
      pull_requests: [
        {
          number: 81,
          head: { sha: HEAD_SHA },
          base: { ref: "main" },
        },
      ],
      ...overrides,
    },
  };
}

function effectiveRules() {
  return [
    { type: "deletion" },
    { type: "non_fast_forward" },
    { type: "required_signatures" },
    { type: "required_linear_history" },
    {
      type: "pull_request",
      parameters: {
        allowed_merge_methods: ["squash"],
        required_review_thread_resolution: true,
      },
    },
    {
      type: "code_scanning",
      parameters: {
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
      },
    },
    {
      type: "merge_queue",
      parameters: {
        grouping_strategy: "ALLGREEN",
        max_entries_to_build: 1,
        max_entries_to_merge: 1,
        merge_method: "SQUASH",
        min_entries_to_merge: 1,
      },
    },
    {
      type: "required_status_checks",
      parameters: {
        required_status_checks: POLICY_REQUIRED_CHECKS.map(
          ({ name, app_id: integrationId }) => ({
            context: name,
            integration_id: integrationId,
          }),
        ),
      },
    },
  ];
}

test("workflow_run yields exact-head candidates only for completed CodeQL pull request runs", () => {
  assert.deepEqual(
    extractCandidates("workflow_run", workflowRunEvent(), REPOSITORY),
    [{ number: 81, headSha: HEAD_SHA, source: "workflow_run" }],
  );

  for (const workflowRun of [
    { name: "CI" },
    { status: "in_progress" },
    { event: "push" },
    { head_sha: "f".repeat(40) },
    { pull_requests: [] },
    { pull_requests: [{ number: 81, head: { sha: "not-a-sha" } }] },
    {
      pull_requests: [
        {
          number: 81,
          head: { sha: HEAD_SHA },
          base: { ref: "main" },
        },
        {
          number: 82,
          head: { sha: HEAD_SHA },
          base: { ref: "main" },
        },
      ],
    },
  ]) {
    assert.deepEqual(
      extractCandidates(
        "workflow_run",
        workflowRunEvent(workflowRun),
        REPOSITORY,
      ),
      [],
    );
  }

  assert.deepEqual(
    extractCandidates(
      "workflow_run",
      {
        ...workflowRunEvent(),
        repository: { full_name: "attacker/fork" },
      },
      REPOSITORY,
    ),
    [],
  );
});

test("eligibility binds login plus immutable actor ID and the exact same-repository head", () => {
  const candidate = {
    number: 81,
    headSha: HEAD_SHA,
    source: "workflow_run",
  };
  assert.equal(isEligiblePull(pull(), candidate, REPOSITORY), true);
  assert.equal(
    isEligiblePull(pull({ user: DEPENDABOT }), candidate, REPOSITORY),
    true,
  );

  const rejected = [
    pull({ state: "closed" }),
    pull({ draft: true }),
    pull({ number: 82 }),
    pull({ user: { login: "lcv-leo", id: 1 } }),
    pull({ user: { login: "lookalike", id: 268063598 } }),
    pull({ user: { login: "dependabot[bot]", id: 1 } }),
    pull({ head: { ...pull().head, sha: "f".repeat(40) } }),
    pull({ head: { ...pull().head, repo: { full_name: "attacker/fork" } } }),
    pull({ base: { ...pull().base, ref: "release" } }),
    pull({ base: { ...pull().base, repo: { full_name: "attacker/fork" } } }),
  ];
  for (const value of rejected) {
    assert.equal(isEligiblePull(value, candidate, REPOSITORY), false);
  }
});

test("GitHub REST reads use the automation PAT", async () => {
  const calls = [];
  const timeoutSignal = AbortSignal.timeout(1_000);
  const result = await githubGetPull(REPOSITORY, 81, "pat-token", {
    timeoutSignal,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify(pull()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(result.number, 81);
  assert.equal(
    calls[0].url,
    "https://api.github.com/repos/LCV-Ideas-Software/.github/pulls/81",
  );
  assert.equal(calls[0].options.headers.authorization, "Bearer pat-token");
  assert.equal(calls[0].options.headers["x-github-api-version"], "2026-03-10");
  assert.equal(
    calls[0].options.headers["user-agent"],
    "LCV-Native-Auto-Merge/1.0",
  );
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.signal, timeoutSignal);
});

test("native idempotency state reads autoMergeRequest and mergeQueueEntry", async () => {
  const calls = [];
  const state = await githubGetNativeState(REPOSITORY, 81, "pat-token", {
    fetch: async (url, options) => {
      calls.push({ url, options });
      return new Response(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                autoMergeRequest: null,
                mergeQueueEntry: { id: "MQE_test" },
              },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  assert.deepEqual(state, {
    autoMergeRequest: null,
    mergeQueueEntry: { id: "MQE_test" },
  });
  assert.equal(calls[0].url, "https://api.github.com/graphql");
  assert.equal(calls[0].options.headers.authorization, "Bearer pat-token");
  const body = JSON.parse(calls[0].options.body);
  assert.match(body.query, /autoMergeRequest/);
  assert.match(body.query, /mergeQueueEntry/);
  assert.deepEqual(body.variables, {
    owner: "LCV-Ideas-Software",
    repo: ".github",
    number: 81,
  });
});

test("effective branch rules are read with the automation PAT", async () => {
  const calls = [];
  const rules = await githubGetEffectiveRules(REPOSITORY, "pat-token", {
    fetch: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify(effectiveRules()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(rules.length, 8);
  assert.equal(
    calls[0].url,
    "https://api.github.com/repos/LCV-Ideas-Software/.github/rules/branches/main",
  );
  assert.equal(calls[0].options.headers.authorization, "Bearer pat-token");
  assert.equal(calls[0].options.headers["x-github-api-version"], "2026-03-10");
});

test("required checks are loaded from the policy pinned beside the action", async () => {
  const reads = [];
  const policy = {
    schema_version: 1,
    organization: "LCV-Ideas-Software",
    repositories: {
      ".github": { required_checks: POLICY_REQUIRED_CHECKS },
    },
  };
  const checks = await loadRequiredChecks(REPOSITORY, {
    readFile: async (source, encoding) => {
      reads.push({ source, encoding });
      return JSON.stringify(policy);
    },
  });

  assert.deepEqual(checks, POLICY_REQUIRED_CHECKS);
  assert.equal(reads[0].source instanceof URL, true);
  assert.match(
    reads[0].source.pathname.replaceAll("\\", "/"),
    /\/native-governance\/policy\.json$/,
  );
  assert.equal(reads[0].encoding, "utf8");
  assert.equal(
    await loadRequiredChecks("LCV-Ideas-Software/unknown", {
      readFile: async () => JSON.stringify(policy),
    }),
    null,
  );
});

test("effective enforcement requires every active native zero-tolerance rule", () => {
  assert.equal(
    hasRequiredNativeEnforcement(effectiveRules(), POLICY_REQUIRED_CHECKS),
    true,
  );

  const cases = [
    effectiveRules().filter(({ type }) => type !== "deletion"),
    effectiveRules().filter(({ type }) => type !== "non_fast_forward"),
    effectiveRules().filter(({ type }) => type !== "required_signatures"),
    effectiveRules().filter(({ type }) => type !== "required_linear_history"),
    effectiveRules().map((rule) =>
      rule.type === "pull_request"
        ? {
            ...rule,
            parameters: {
              ...rule.parameters,
              allowed_merge_methods: ["squash", "merge"],
            },
          }
        : rule,
    ),
    effectiveRules().map((rule) =>
      rule.type === "pull_request"
        ? {
            ...rule,
            parameters: {
              ...rule.parameters,
              required_review_thread_resolution: false,
            },
          }
        : rule,
    ),
    effectiveRules().map((rule) =>
      rule.type === "code_scanning"
        ? {
            ...rule,
            parameters: {
              code_scanning_tools: rule.parameters.code_scanning_tools.filter(
                ({ tool }) => tool !== "zizmor",
              ),
            },
          }
        : rule,
    ),
    effectiveRules().map((rule) =>
      rule.type === "code_scanning"
        ? {
            ...rule,
            parameters: {
              code_scanning_tools: rule.parameters.code_scanning_tools.map(
                (tool) =>
                  tool.tool === "CodeQL"
                    ? { ...tool, security_alerts_threshold: "high_or_higher" }
                    : tool,
              ),
            },
          }
        : rule,
    ),
    effectiveRules().map((rule) =>
      rule.type === "merge_queue"
        ? {
            ...rule,
            parameters: { ...rule.parameters, merge_method: "MERGE" },
          }
        : rule,
    ),
    effectiveRules().map((rule) =>
      rule.type === "merge_queue"
        ? {
            ...rule,
            parameters: { ...rule.parameters, max_entries_to_build: 2 },
          }
        : rule,
    ),
    effectiveRules().map((rule) =>
      rule.type === "required_status_checks"
        ? { ...rule, parameters: { required_status_checks: [] } }
        : rule,
    ),
    effectiveRules().map((rule) =>
      rule.type === "required_status_checks"
        ? {
            ...rule,
            parameters: {
              required_status_checks: [
                { context: "Analyze actions", integration_id: null },
              ],
            },
          }
        : rule,
    ),
    effectiveRules().map((rule) =>
      rule.type === "required_status_checks"
        ? {
            ...rule,
            parameters: {
              required_status_checks:
                rule.parameters.required_status_checks.filter(
                  ({ context }) => !context.startsWith("Analyze "),
                ),
            },
          }
        : rule,
    ),
    effectiveRules().map((rule) =>
      rule.type === "required_status_checks"
        ? {
            ...rule,
            parameters: {
              required_status_checks:
                rule.parameters.required_status_checks.map((check) =>
                  check.context.startsWith("Analyze ")
                    ? { ...check, integration_id: 57789 }
                    : check,
                ),
            },
          }
        : rule,
    ),
    effectiveRules().map((rule) =>
      rule.type === "required_status_checks"
        ? {
            ...rule,
            parameters: {
              required_status_checks:
                rule.parameters.required_status_checks.filter(
                  ({ context }) => context !== "Run zizmor",
                ),
            },
          }
        : rule,
    ),
    effectiveRules().map((rule) =>
      rule.type === "required_status_checks"
        ? {
            ...rule,
            parameters: {
              required_status_checks:
                rule.parameters.required_status_checks.map((check) =>
                  check.context === "Run zizmor"
                    ? { ...check, integration_id: 57789 }
                    : check,
                ),
            },
          }
        : rule,
    ),
  ];

  for (const rules of cases) {
    assert.equal(
      hasRequiredNativeEnforcement(rules, POLICY_REQUIRED_CHECKS),
      false,
    );
  }

  const reusableZizmor = effectiveRules().map((rule) =>
    rule.type === "required_status_checks"
      ? {
          ...rule,
          parameters: {
            required_status_checks: rule.parameters.required_status_checks.map(
              (check) =>
                check.context === "Run zizmor"
                  ? { ...check, context: "Run zizmor / Run zizmor" }
                  : check,
            ),
          },
        }
      : rule,
  );
  const reusableZizmorPolicy = POLICY_REQUIRED_CHECKS.map((check) =>
    check.name === "Run zizmor"
      ? { ...check, name: "Run zizmor / Run zizmor" }
      : check,
  );
  assert.equal(
    hasRequiredNativeEnforcement(reusableZizmor, reusableZizmorPolicy),
    true,
  );
});

test("effective status checks must contain every exact policy name and app ID", () => {
  const rewriteChecks = (rewrite) =>
    effectiveRules().map((rule) =>
      rule.type === "required_status_checks"
        ? {
            ...rule,
            parameters: {
              ...rule.parameters,
              required_status_checks: rewrite(
                rule.parameters.required_status_checks,
              ),
            },
          }
        : rule,
    );
  const missing = rewriteChecks((checks) =>
    checks.filter(({ context }) => context !== "Dependency Review"),
  );
  const wrongApp = rewriteChecks((checks) =>
    checks.map((check) =>
      check.context === "Dependency Review"
        ? { ...check, integration_id: 57789 }
        : check,
    ),
  );
  const wrongContext = rewriteChecks((checks) =>
    checks.map((check) =>
      check.context === "Dependency Review"
        ? { ...check, context: "Dependency Review spoof" }
        : check,
    ),
  );
  for (const rules of [missing, wrongApp, wrongContext]) {
    assert.equal(
      hasRequiredNativeEnforcement(rules, POLICY_REQUIRED_CHECKS),
      false,
    );
  }

  const withExtra = rewriteChecks((checks) => [
    ...checks,
    { context: "Additional hardening", integration_id: 15368 },
  ]);
  assert.equal(
    hasRequiredNativeEnforcement(withExtra, POLICY_REQUIRED_CHECKS),
    true,
  );
});

test("malformed effective-rules payloads fail closed", () => {
  for (const malformed of [
    null,
    {},
    [null],
    [{ type: 7 }],
    [
      ...effectiveRules().filter(({ type }) => type !== "pull_request"),
      { type: "pull_request", parameters: null },
    ],
    [
      ...effectiveRules().filter(
        ({ type }) => type !== "required_status_checks",
      ),
      {
        type: "required_status_checks",
        parameters: {
          required_status_checks: [{ context: 7, integration_id: "not-an-id" }],
        },
      },
    ],
  ]) {
    assert.throws(
      () => hasRequiredNativeEnforcement(malformed, POLICY_REQUIRED_CHECKS),
      /effective branch rules/i,
    );
  }
});

test("the mutation delegates only to native auto-merge with an atomic head guard", async () => {
  const calls = [];
  await runGhAutoMerge(REPOSITORY, 81, HEAD_SHA, "pat-token", {
    processEnv: {
      GITHUB_TOKEN: "ephemeral-token",
      GH_TOKEN: "stale-token",
      INPUT_AUTOMATION_TOKEN: "duplicate-input-token",
      PATH: "test-path",
    },
    execFile: async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: "", stderr: "" };
    },
  });

  assert.equal(calls[0].file, "gh");
  assert.deepEqual(calls[0].args, [
    "pr",
    "merge",
    "81",
    "--repo",
    REPOSITORY,
    "--auto",
    "--match-head-commit",
    HEAD_SHA,
  ]);
  assert.equal(calls[0].options.env.GH_TOKEN, "pat-token");
  assert.equal(calls[0].options.env.GITHUB_TOKEN, undefined);
  assert.equal(calls[0].options.env.INPUT_AUTOMATION_TOKEN, undefined);
  assert.equal(calls[0].options.env.GH_HOST, "github.com");
  assert.equal(calls[0].options.env.PATH, "test-path");
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.timeout, 60_000);
  for (const forbidden of ["--admin", "--squash", "--merge", "--rebase"]) {
    assert.equal(calls[0].args.includes(forbidden), false, forbidden);
  }
});

test("controller refetches exact state and enables native auto-merge once", async () => {
  let pullReads = 0;
  let policyReads = 0;
  const trace = [];
  const mutations = [];
  const result = await runNativeAutoMerge(
    {
      GITHUB_REPOSITORY: REPOSITORY,
      GITHUB_EVENT_NAME: "workflow_run",
      GITHUB_EVENT_PATH: "event.json",
      INPUT_AUTOMATION_TOKEN: "pat-token",
      GITHUB_TOKEN: "must-not-be-used",
    },
    {
      readFile: async () => JSON.stringify(workflowRunEvent()),
      getPull: async () => {
        trace.push("pull");
        pullReads += 1;
        return pull({ user: DEPENDABOT });
      },
      loadRequiredChecks: async () => {
        trace.push("policy");
        policyReads += 1;
        return POLICY_REQUIRED_CHECKS;
      },
      getEffectiveRules: async () => {
        trace.push("rules");
        return effectiveRules();
      },
      getNativeState: async () => {
        trace.push("state");
        return {
          autoMergeRequest: null,
          mergeQueueEntry: null,
        };
      },
      enableAutoMerge: async (...args) => {
        trace.push("gh");
        mutations.push(args);
      },
    },
  );

  assert.deepEqual(result, {
    action: "enabled",
    pull: 81,
    head: HEAD_SHA,
  });
  assert.equal(pullReads, 2);
  assert.equal(policyReads, 1);
  assert.deepEqual(trace, [
    "pull",
    "policy",
    "rules",
    "state",
    "rules",
    "pull",
    "gh",
  ]);
  assert.deepEqual(mutations, [[REPOSITORY, 81, HEAD_SHA, "pat-token"]]);
});

test("controller is idempotent for native auto-merge and merge queue state", async () => {
  for (const [state, expectedAction] of [
    [
      {
        autoMergeRequest: { enabledAt: "2026-08-08T00:00:00Z" },
        mergeQueueEntry: null,
      },
      "already-enabled",
    ],
    [
      { autoMergeRequest: null, mergeQueueEntry: { id: "MQE_test" } },
      "already-queued",
    ],
  ]) {
    let mutations = 0;
    const result = await runNativeAutoMerge(
      {
        GITHUB_REPOSITORY: REPOSITORY,
        GITHUB_EVENT_NAME: "workflow_run",
        GITHUB_EVENT_PATH: "event.json",
        INPUT_AUTOMATION_TOKEN: "pat-token",
      },
      {
        readFile: async () => JSON.stringify(workflowRunEvent()),
        getPull: async () => pull(),
        getEffectiveRules: async () => effectiveRules(),
        getNativeState: async () => state,
        enableAutoMerge: async () => {
          mutations += 1;
        },
      },
    );

    assert.deepEqual(result, { action: expectedAction, pull: 81 });
    assert.equal(mutations, 0);
  }
});

test("controller cannot arm auto-merge before all effective rules are active", async () => {
  let nativeStateReads = 0;
  let mutations = 0;
  const result = await runNativeAutoMerge(
    {
      GITHUB_REPOSITORY: REPOSITORY,
      GITHUB_EVENT_NAME: "workflow_run",
      GITHUB_EVENT_PATH: "event.json",
      INPUT_AUTOMATION_TOKEN: "pat-token",
    },
    {
      readFile: async () => JSON.stringify(workflowRunEvent()),
      getPull: async () => pull(),
      getEffectiveRules: async () =>
        effectiveRules().filter(({ type }) => type !== "merge_queue"),
      getNativeState: async () => {
        nativeStateReads += 1;
        return { autoMergeRequest: null, mergeQueueEntry: null };
      },
      enableAutoMerge: async () => {
        mutations += 1;
      },
    },
  );

  assert.deepEqual(result, {
    action: "skipped",
    reason: "native-enforcement-inactive",
  });
  assert.equal(nativeStateReads, 0);
  assert.equal(mutations, 0);
});

test("controller skips an unknown policy repository before GraphQL and gh", async () => {
  let nativeStateReads = 0;
  let mutations = 0;
  const result = await runNativeAutoMerge(
    {
      GITHUB_REPOSITORY: REPOSITORY,
      GITHUB_EVENT_NAME: "workflow_run",
      GITHUB_EVENT_PATH: "event.json",
      INPUT_AUTOMATION_TOKEN: "pat-token",
    },
    {
      readFile: async () => JSON.stringify(workflowRunEvent()),
      getPull: async () => pull(),
      loadRequiredChecks: async () => null,
      getNativeState: async () => {
        nativeStateReads += 1;
        return { autoMergeRequest: null, mergeQueueEntry: null };
      },
      enableAutoMerge: async () => {
        mutations += 1;
      },
    },
  );

  assert.deepEqual(result, {
    action: "skipped",
    reason: "repository-not-in-policy",
  });
  assert.equal(nativeStateReads, 0);
  assert.equal(mutations, 0);
});

test("policy check absence or identity drift blocks before GraphQL and gh", async () => {
  const rewriteChecks = (rewrite) =>
    effectiveRules().map((rule) =>
      rule.type === "required_status_checks"
        ? {
            ...rule,
            parameters: {
              ...rule.parameters,
              required_status_checks: rewrite(
                rule.parameters.required_status_checks,
              ),
            },
          }
        : rule,
    );
  const variants = [
    rewriteChecks((checks) =>
      checks.filter(({ context }) => context !== "Dependency Review"),
    ),
    rewriteChecks((checks) =>
      checks.map((check) =>
        check.context === "Dependency Review"
          ? { ...check, integration_id: 57789 }
          : check,
      ),
    ),
    rewriteChecks((checks) =>
      checks.map((check) =>
        check.context === "Dependency Review"
          ? { ...check, context: "Dependency Review spoof" }
          : check,
      ),
    ),
  ];

  for (const rules of variants) {
    let nativeStateReads = 0;
    let mutations = 0;
    const result = await runNativeAutoMerge(
      {
        GITHUB_REPOSITORY: REPOSITORY,
        GITHUB_EVENT_NAME: "workflow_run",
        GITHUB_EVENT_PATH: "event.json",
        INPUT_AUTOMATION_TOKEN: "pat-token",
      },
      {
        readFile: async () => JSON.stringify(workflowRunEvent()),
        getPull: async () => pull(),
        loadRequiredChecks: async () => POLICY_REQUIRED_CHECKS,
        getEffectiveRules: async () => rules,
        getNativeState: async () => {
          nativeStateReads += 1;
          return { autoMergeRequest: null, mergeQueueEntry: null };
        },
        enableAutoMerge: async () => {
          mutations += 1;
        },
      },
    );

    assert.deepEqual(result, {
      action: "skipped",
      reason: "native-enforcement-inactive",
    });
    assert.equal(nativeStateReads, 0);
    assert.equal(mutations, 0);
  }
});

test("controller revalidates effective enforcement after GraphQL and before gh", async () => {
  let enforcementReads = 0;
  let mutations = 0;
  const result = await runNativeAutoMerge(
    {
      GITHUB_REPOSITORY: REPOSITORY,
      GITHUB_EVENT_NAME: "workflow_run",
      GITHUB_EVENT_PATH: "event.json",
      INPUT_AUTOMATION_TOKEN: "pat-token",
    },
    {
      readFile: async () => JSON.stringify(workflowRunEvent()),
      getPull: async () => pull(),
      getEffectiveRules: async () => {
        enforcementReads += 1;
        return enforcementReads === 1
          ? effectiveRules()
          : effectiveRules().filter(({ type }) => type !== "merge_queue");
      },
      getNativeState: async () => ({
        autoMergeRequest: null,
        mergeQueueEntry: null,
      }),
      enableAutoMerge: async () => {
        mutations += 1;
      },
    },
  );

  assert.deepEqual(result, {
    action: "skipped",
    reason: "native-enforcement-inactive",
  });
  assert.equal(enforcementReads, 2);
  assert.equal(mutations, 0);
});

test("controller refetches and revalidates the PR immediately before gh", async () => {
  const changedPulls = [
    pull({ base: { ...pull().base, ref: "release" } }),
    pull({ draft: true }),
    pull({ state: "closed" }),
    pull({ user: { login: "attacker", id: 268063598 } }),
    pull({ user: { login: "lcv-leo", id: 1 } }),
    pull({ head: { ...pull().head, repo: { full_name: "attacker/fork" } } }),
    pull({ base: { ...pull().base, repo: { full_name: "attacker/fork" } } }),
    pull({ head: { ...pull().head, sha: "f".repeat(40) } }),
  ];

  for (const changedPull of changedPulls) {
    let pullReads = 0;
    let enforcementReads = 0;
    let mutations = 0;
    const result = await runNativeAutoMerge(
      {
        GITHUB_REPOSITORY: REPOSITORY,
        GITHUB_EVENT_NAME: "workflow_run",
        GITHUB_EVENT_PATH: "event.json",
        INPUT_AUTOMATION_TOKEN: "pat-token",
      },
      {
        readFile: async () => JSON.stringify(workflowRunEvent()),
        getPull: async () => {
          pullReads += 1;
          return pullReads === 1 ? pull() : changedPull;
        },
        getEffectiveRules: async () => {
          enforcementReads += 1;
          return effectiveRules();
        },
        getNativeState: async () => ({
          autoMergeRequest: null,
          mergeQueueEntry: null,
        }),
        enableAutoMerge: async () => {
          mutations += 1;
        },
      },
    );

    assert.deepEqual(result, { action: "skipped", reason: "ineligible" });
    assert.equal(pullReads, 2);
    assert.equal(enforcementReads, 2);
    assert.equal(mutations, 0);
  }
});

test("controller fails before GraphQL and gh on malformed effective rules", async () => {
  let nativeStateReads = 0;
  let mutations = 0;
  await assert.rejects(
    runNativeAutoMerge(
      {
        GITHUB_REPOSITORY: REPOSITORY,
        GITHUB_EVENT_NAME: "workflow_run",
        GITHUB_EVENT_PATH: "event.json",
        INPUT_AUTOMATION_TOKEN: "pat-token",
      },
      {
        readFile: async () => JSON.stringify(workflowRunEvent()),
        getPull: async () => pull(),
        getEffectiveRules: async () => ({ rules: effectiveRules() }),
        getNativeState: async () => {
          nativeStateReads += 1;
          return { autoMergeRequest: null, mergeQueueEntry: null };
        },
        enableAutoMerge: async () => {
          mutations += 1;
        },
      },
    ),
    /malformed effective branch rules payload/i,
  );
  assert.equal(nativeStateReads, 0);
  assert.equal(mutations, 0);
});

test("controller fails closed on a stale event head", async () => {
  let mutations = 0;
  const result = await runNativeAutoMerge(
    {
      GITHUB_REPOSITORY: REPOSITORY,
      GITHUB_EVENT_NAME: "workflow_run",
      GITHUB_EVENT_PATH: "event.json",
      INPUT_AUTOMATION_TOKEN: "pat-token",
    },
    {
      readFile: async () => JSON.stringify(workflowRunEvent()),
      getPull: async () =>
        pull({ head: { ...pull().head, sha: "f".repeat(40) } }),
      getNativeState: async () => ({
        autoMergeRequest: null,
        mergeQueueEntry: null,
      }),
      enableAutoMerge: async () => {
        mutations += 1;
      },
    },
  );

  assert.deepEqual(result, { action: "skipped", reason: "ineligible" });
  assert.equal(mutations, 0);
});

test("controller never falls back to GITHUB_TOKEN", async () => {
  await assert.rejects(
    runNativeAutoMerge(
      {
        GITHUB_REPOSITORY: REPOSITORY,
        GITHUB_EVENT_NAME: "workflow_run",
        GITHUB_EVENT_PATH: "event.json",
        GITHUB_TOKEN: "ephemeral-token",
      },
      {
        readFile: async () => JSON.stringify(workflowRunEvent()),
      },
    ),
    /automation_token input must be a non-empty string/,
  );
});

test("action and consumer workflow keep the credential and execution boundary narrow", async () => {
  const action = await readFile(
    new URL("./action.yml", import.meta.url),
    "utf8",
  );
  const workflow = await readFile(
    new URL("../.github/workflows/native-auto-merge.yml", import.meta.url),
    "utf8",
  );

  assert.match(action, /automation_token:/);
  assert.doesNotMatch(action, /github_token:/);
  assert.match(action, /using:\s*node24/);

  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /- CodeQL/);
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /merge_group:/);
  assert.doesNotMatch(workflow, /pull_request_target:/);
  assert.equal((workflow.match(/permissions:\s*write-all/g) ?? []).length, 3);
  assert.match(workflow, /name:\s*Test native auto-merge/);
  assert.match(workflow, /node --check native-auto-merge\/main\.mjs/);
  assert.match(workflow, /node --test native-auto-merge\/main\.test\.mjs/);
  assert.match(
    workflow,
    /github\.event_name == 'workflow_run'.*github\.event\.workflow_run\.event == 'pull_request'/s,
  );
  assert.match(workflow, /environment:\s*dependabot-automation/);
  assert.match(
    workflow,
    /group:\s*native-auto-merge-\$\{\{ github\.repository \}\}-\$\{\{ github\.event\.workflow_run\.head_sha \|\| github\.sha \}\}/,
  );
  assert.match(workflow, /cancel-in-progress:\s*false/);
  assert.match(
    workflow,
    /automation_token:\s*\$\{\{ secrets\.LCV_AUTOMATION_TOKEN \}\}/,
  );
  assert.match(workflow, /ref:\s*\$\{\{ github\.workflow_sha \}\}/);
  assert.doesNotMatch(workflow, /github\.token|GITHUB_TOKEN/);
  assert.doesNotMatch(workflow, /download-artifact|pull_request\.head\.sha/);
});
