import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  extractCandidates,
  githubDequeuePullRequest,
  githubDisablePullRequestAutoMerge,
  githubGetEffectiveRules,
  githubGetNativeState,
  githubGetPull,
  githubListOpenPulls,
  hasRequiredNativeEnforcement,
  isEligiblePull,
  loadRequiredChecks,
  runGhAutoMerge,
  runNativeAutoMerge,
  workflowRunEventFromInputs,
} from "./main.mjs";

const REPOSITORY = "LCV-Ideas-Software/.github";
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const LCV_LEO = { login: "lcv-leo", id: 268063598, type: "User" };
const DEPENDABOT = { login: "dependabot[bot]", id: 49699333, type: "Bot" };
const COPILOT_SWE = { login: "Copilot", id: 198982749, type: "Bot" };
const CLEAR_FEEDBACK = { status: "clear", fingerprint: "feedback-v1" };
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

function feedbackRuntime(overrides = {}) {
  return {
    waitForReviewReconciliation: async () => CLEAR_FEEDBACK,
    readReviewReconciliationState: async () => CLEAR_FEEDBACK,
    ...overrides,
  };
}

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
      path: ".github/workflows/codeql.yml",
      display_title: "CodeQL",
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

function workflowRunInputEnv(event = workflowRunEvent()) {
  return {
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_EVENT_NAME: "workflow_run",
    INPUT_EVENT_REPOSITORY: event.repository.full_name,
    INPUT_WORKFLOW_NAME: event.workflow_run.name,
    INPUT_WORKFLOW_PATH: event.workflow_run.path,
    INPUT_WORKFLOW_DISPLAY_TITLE: event.workflow_run.display_title,
    INPUT_WORKFLOW_STATUS: event.workflow_run.status,
    INPUT_WORKFLOW_EVENT: event.workflow_run.event,
    INPUT_WORKFLOW_HEAD_SHA: event.workflow_run.head_sha,
    INPUT_WORKFLOW_PULL_REQUESTS: JSON.stringify(
      event.workflow_run.pull_requests,
    ),
  };
}

function feedbackWorkflowInputEnv(overrides = {}) {
  return workflowRunInputEnv(
    workflowRunEvent({
      name: "Native PR feedback signal",
      path: ".github/workflows/native-pr-feedback-signal.yml",
      display_title: "Native PR feedback PR #81 sender #175728472",
      event: "pull_request_review",
      head_sha: "f".repeat(40),
      pull_requests: [],
      ...overrides,
    }),
  );
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
    { path: ".github/workflows/not-codeql.yml" },
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

test("trusted feedback workflow runs yield deprivileging-only PR candidates", () => {
  const event = workflowRunEvent({
    name: "Native PR feedback signal",
    path: ".github/workflows/native-pr-feedback-signal.yml",
    display_title: "Native PR feedback PR #81 sender #175728472",
    event: "pull_request_review",
    head_sha: "f".repeat(40),
    pull_requests: [],
  });
  assert.deepEqual(extractCandidates("workflow_run", event, REPOSITORY), [
    { number: 81, source: "feedback-workflow-run" },
  ]);

  for (const overrides of [
    { name: "Native PR feedback signal spoof" },
    { path: ".github/workflows/spoof.yml" },
    { display_title: "Native PR feedback PR #81 sender #268063598" },
    { display_title: "Native PR feedback PR #0 sender #175728472" },
    { event: "push" },
    { status: "in_progress" },
  ]) {
    assert.deepEqual(
      extractCandidates(
        "workflow_run",
        {
          ...event,
          workflow_run: { ...event.workflow_run, ...overrides },
        },
        REPOSITORY,
      ),
      [],
    );
  }
});

test("explicit workflow inputs reconstruct only the candidate fields used by the controller", () => {
  assert.deepEqual(
    workflowRunEventFromInputs(workflowRunInputEnv()),
    workflowRunEvent(),
  );

  for (const value of [undefined, "", "{", "{}", "null"]) {
    assert.throws(
      () =>
        workflowRunEventFromInputs({
          ...workflowRunInputEnv(),
          INPUT_WORKFLOW_PULL_REQUESTS: value,
        }),
      /workflow_pull_requests input/i,
    );
  }
});

test("eligibility accepts every well-formed GitHub actor on an exact same-repository head", () => {
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
  assert.equal(
    isEligiblePull(pull({ user: COPILOT_SWE }), candidate, REPOSITORY),
    true,
  );
  assert.equal(
    isEligiblePull(
      pull({
        user: {
          login: "future-trusted-automation[bot]",
          id: 987654321,
          type: "Bot",
        },
      }),
      candidate,
      REPOSITORY,
    ),
    true,
  );

  const rejected = [
    pull({ state: "closed" }),
    pull({ draft: true }),
    pull({ number: 82 }),
    pull({ user: null }),
    pull({ user: { login: "", id: 1, type: "User" } }),
    pull({ user: { login: "bot", id: 0, type: "Bot" } }),
    pull({ user: { login: "bot", id: 1, type: "Organization" } }),
    pull({ user: { login: "bot", id: 1 } }),
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

test("open pull inventory uses fixed pagination before event candidate matching", async () => {
  const calls = [];
  const firstPage = Array.from({ length: 100 }, () => pull());
  const pulls = await githubListOpenPulls(REPOSITORY, "pat-token", {
    fetch: async (url, options) => {
      calls.push({ url, options });
      const payload = calls.length === 1 ? firstPage : [pull()];
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(pulls.length, 101);
  assert.deepEqual(
    calls.map(({ url }) => url),
    [
      "https://api.github.com/repos/LCV-Ideas-Software/.github/pulls?state=open&base=main&per_page=100&page=1",
      "https://api.github.com/repos/LCV-Ideas-Software/.github/pulls?state=open&base=main&per_page=100&page=2",
    ],
  );
  assert.equal(
    calls.every(({ url }) => !url.includes("/pulls/81")),
    true,
  );
  assert.equal(
    calls.every(
      ({ options }) => options.headers.authorization === "Bearer pat-token",
    ),
    true,
  );
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
                id: "PR_test",
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
    id: "PR_test",
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

  await assert.rejects(
    githubGetNativeState(REPOSITORY, 81, "pat-token", {
      fetch: async () =>
        new Response(
          JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  autoMergeRequest: null,
                  mergeQueueEntry: null,
                },
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    }),
    /did not return the pull request/i,
  );
});

test("late-feedback mutations only remove existing native merge privileges", async () => {
  const calls = [];
  const fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return new Response(
      JSON.stringify({
        data: {
          disablePullRequestAutoMerge: {
            pullRequest: { id: "PR_test" },
          },
          dequeuePullRequest: {
            mergeQueueEntry: { id: "MQE_test" },
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  await githubDisablePullRequestAutoMerge("PR_test", "pat-token", { fetch });
  await githubDequeuePullRequest("PR_test", "MQE_test", "pat-token", { fetch });
  assert.equal(calls.length, 2);
  assert.match(calls[0].query, /disablePullRequestAutoMerge/);
  assert.deepEqual(calls[0].variables, { pullRequestId: "PR_test" });
  assert.match(calls[1].query, /dequeuePullRequest/);
  assert.deepEqual(calls[1].variables, { pullRequestId: "PR_test" });

  await assert.rejects(
    githubDisablePullRequestAutoMerge("PR_test", "pat-token", {
      fetch: async () =>
        new Response(
          JSON.stringify({
            data: {
              disablePullRequestAutoMerge: {
                pullRequest: { id: "PR_spoof" },
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    }),
    /did not confirm the native state mutation/i,
  );
  await assert.rejects(
    githubDequeuePullRequest("PR_test", "MQE_test", "pat-token", {
      fetch: async () =>
        new Response(JSON.stringify({ errors: [{ message: "denied" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    }),
    /GraphQL mutation failed: denied/i,
  );
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
    "https://api.github.com/repos/LCV-Ideas-Software/.github/rules/branches/main?per_page=100&page=1",
  );
  assert.equal(calls[0].options.headers.authorization, "Bearer pat-token");
  assert.equal(calls[0].options.headers["x-github-api-version"], "2026-03-10");
});

test("effective branch rules are fully paginated before enforcement checks", async () => {
  const calls = [];
  const statusRule = effectiveRules().find(
    ({ type }) => type === "required_status_checks",
  );
  const firstPage = [
    ...effectiveRules().filter(({ type }) => type !== "required_status_checks"),
    ...Array.from({ length: 93 }, () => ({ type: "deletion" })),
  ];
  assert.equal(firstPage.length, 100);

  const rules = await githubGetEffectiveRules(REPOSITORY, "pat-token", {
    fetch: async (url, options) => {
      calls.push({ url, options });
      const page = new URL(url).searchParams.get("page");
      return new Response(
        JSON.stringify(page === "1" ? firstPage : [statusRule]),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
  });

  assert.equal(rules.length, 101);
  assert.equal(
    hasRequiredNativeEnforcement(rules, POLICY_REQUIRED_CHECKS),
    true,
  );
  assert.deepEqual(
    calls.map(({ url }) => url),
    [
      "https://api.github.com/repos/LCV-Ideas-Software/.github/rules/branches/main?per_page=100&page=1",
      "https://api.github.com/repos/LCV-Ideas-Software/.github/rules/branches/main?per_page=100&page=2",
    ],
  );
});

test("effective branch rule pagination fails closed", async () => {
  await assert.rejects(
    githubGetEffectiveRules(REPOSITORY, "pat-token", {
      fetch: async () =>
        new Response(JSON.stringify({ rules: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    }),
    /effective branch rules.*page 1 must be an array/i,
  );

  await assert.rejects(
    githubGetEffectiveRules(REPOSITORY, "pat-token", {
      fetch: async () =>
        new Response(
          JSON.stringify(
            Array.from({ length: 101 }, () => ({ type: "deletion" })),
          ),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    }),
    /effective branch rules.*page 1 exceeds the requested page size/i,
  );

  let calls = 0;
  await assert.rejects(
    githubGetEffectiveRules(REPOSITORY, "pat-token", {
      fetch: async () => {
        calls += 1;
        return new Response(
          JSON.stringify(
            Array.from({ length: 100 }, () => ({ type: "deletion" })),
          ),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    }),
    /effective branch rules.*pagination exceeded the safety limit/i,
  );
  assert.equal(calls, 100);
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
    "--squash",
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
  for (const forbidden of ["--admin", "--merge", "--rebase"]) {
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
      ...workflowRunInputEnv(),
      INPUT_AUTOMATION_TOKEN: "pat-token",
      GITHUB_TOKEN: "must-not-be-used",
    },
    {
      ...feedbackRuntime(),
      listOpenPulls: async () => {
        trace.push("pull-list");
        return [pull({ user: DEPENDABOT })];
      },
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
  assert.equal(pullReads, 1);
  assert.equal(policyReads, 1);
  assert.deepEqual(trace, [
    "pull-list",
    "policy",
    "rules",
    "state",
    "rules",
    "pull",
    "gh",
  ]);
  assert.deepEqual(mutations, [[REPOSITORY, 81, HEAD_SHA, "pat-token"]]);
});

test("feedback appearing between the final read and arm is removed after the mutation", async () => {
  const trace = [];
  let finalFeedbackReads = 0;
  let armed = false;
  let disabled = false;
  const result = await runNativeAutoMerge(
    {
      ...workflowRunInputEnv(),
      INPUT_AUTOMATION_TOKEN: "pat-token",
    },
    {
      waitForReviewReconciliation: async () => CLEAR_FEEDBACK,
      readReviewReconciliationState: async () => {
        finalFeedbackReads += 1;
        trace.push(`feedback:${finalFeedbackReads}`);
        return finalFeedbackReads === 1
          ? CLEAR_FEEDBACK
          : { status: "blocked", fingerprint: "late-copilot-finding" };
      },
      listOpenPulls: async () => [pull()],
      getPull: async () => pull(),
      getEffectiveRules: async () => effectiveRules(),
      getNativeState: async () => {
        trace.push("state");
        return {
          id: "PR_test",
          autoMergeRequest:
            armed && !disabled ? { enabledAt: "2026-08-09T18:00:00Z" } : null,
          mergeQueueEntry: null,
        };
      },
      enableAutoMerge: async () => {
        trace.push("enable");
        armed = true;
      },
      disableAutoMerge: async (id, token) => {
        trace.push("disable");
        assert.equal(id, "PR_test");
        assert.equal(token, "pat-token");
        disabled = true;
      },
    },
  );

  assert.deepEqual(result, {
    action: "deprivileged",
    pull: 81,
    reason: "review-state-changed-after-arm",
  });
  assert.equal(armed, true);
  assert.equal(disabled, true);
  assert.deepEqual(trace, [
    "state",
    "feedback:1",
    "enable",
    "feedback:2",
    "state",
    "disable",
    "state",
  ]);
});

test("a signal that sees no privilege cannot be followed by an unchecked arm", async () => {
  let armed = false;
  let disabled = false;
  let feedbackReads = 0;
  let signalResult = null;
  const nativeState = async () => ({
    id: "PR_test",
    autoMergeRequest:
      armed && !disabled ? { enabledAt: "2026-08-09T18:00:00Z" } : null,
    mergeQueueEntry: null,
  });
  const disableAutoMerge = async () => {
    disabled = true;
  };

  const result = await runNativeAutoMerge(
    {
      ...workflowRunInputEnv(),
      INPUT_AUTOMATION_TOKEN: "pat-token",
    },
    {
      waitForReviewReconciliation: async () => CLEAR_FEEDBACK,
      readReviewReconciliationState: async () => {
        feedbackReads += 1;
        if (feedbackReads === 1) {
          const capturedBeforeSignal = CLEAR_FEEDBACK;
          signalResult = await runNativeAutoMerge(
            {
              ...feedbackWorkflowInputEnv(),
              INPUT_AUTOMATION_TOKEN: "pat-token",
            },
            {
              listOpenPulls: async () => [pull()],
              readReviewFeedbackState: async () => ({
                status: "blocked",
                fingerprint: "late-finding",
              }),
              getNativeState: nativeState,
              disableAutoMerge,
              sleep: async () => {},
              enableAutoMerge: async () => assert.fail("signal cannot arm"),
            },
          );
          return capturedBeforeSignal;
        }
        return { status: "blocked", fingerprint: "late-finding" };
      },
      listOpenPulls: async () => [pull()],
      getPull: async () => pull(),
      getEffectiveRules: async () => effectiveRules(),
      getNativeState: nativeState,
      enableAutoMerge: async () => {
        armed = true;
      },
      disableAutoMerge,
    },
  );

  assert.deepEqual(signalResult, {
    action: "none",
    reason: "feedback-blocking-no-privilege",
  });
  assert.deepEqual(result, {
    action: "deprivileged",
    pull: 81,
    reason: "review-state-changed-after-arm",
  });
  assert.equal(armed, true);
  assert.equal(disabled, true);
});

test("controller binds workflow candidates to a fixed open-pull inventory before targeted requests", async () => {
  const trace = [];
  let pullReads = 0;
  const result = await runNativeAutoMerge(
    {
      ...workflowRunInputEnv(),
      INPUT_AUTOMATION_TOKEN: "pat-token",
    },
    {
      ...feedbackRuntime(),
      listOpenPulls: async () => {
        trace.push("pull-list");
        return [pull()];
      },
      getPull: async () => {
        assert.equal(
          trace.includes("pull-list"),
          true,
          "an input-derived pull number reached a targeted request",
        );
        trace.push("pull");
        pullReads += 1;
        return pull();
      },
      loadRequiredChecks: async () => {
        trace.push("policy");
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
      enableAutoMerge: async () => {
        trace.push("gh");
      },
    },
  );

  assert.deepEqual(result, {
    action: "enabled",
    pull: 81,
    head: HEAD_SHA,
  });
  assert.equal(pullReads, 1);
  assert.deepEqual(trace, [
    "pull-list",
    "policy",
    "rules",
    "state",
    "rules",
    "pull",
    "gh",
  ]);
});

test("controller consumes explicit workflow inputs without reading GITHUB_EVENT_PATH", async () => {
  const result = await runNativeAutoMerge(
    {
      ...workflowRunInputEnv(),
      INPUT_AUTOMATION_TOKEN: "pat-token",
    },
    {
      ...feedbackRuntime(),
      readFile: async () => {
        assert.fail("the workflow event file must not be read");
      },
      listOpenPulls: async () => [pull()],
      getPull: async () => pull(),
      getEffectiveRules: async () => effectiveRules(),
      getNativeState: async () => ({
        autoMergeRequest: null,
        mergeQueueEntry: null,
      }),
      enableAutoMerge: async () => {},
    },
  );

  assert.deepEqual(result, {
    action: "enabled",
    pull: 81,
    head: HEAD_SHA,
  });
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
        ...workflowRunInputEnv(),
        INPUT_AUTOMATION_TOKEN: "pat-token",
      },
      {
        ...feedbackRuntime(),
        listOpenPulls: async () => [pull()],
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

test("trusted late-feedback runs can only remove existing native merge privilege", async () => {
  for (const [initialState, expectedMutations] of [
    [
      {
        id: "PR_test",
        autoMergeRequest: { enabledAt: "2026-08-09T18:00:00Z" },
        mergeQueueEntry: null,
      },
      ["disable:PR_test"],
    ],
    [
      {
        id: "PR_test",
        autoMergeRequest: null,
        mergeQueueEntry: { id: "MQE_test" },
      },
      ["dequeue:PR_test:MQE_test"],
    ],
    [
      {
        id: "PR_test",
        autoMergeRequest: { enabledAt: "2026-08-09T18:00:00Z" },
        mergeQueueEntry: { id: "MQE_test" },
      },
      ["dequeue:PR_test:MQE_test", "disable:PR_test"],
    ],
  ]) {
    const trace = [];
    let stateReads = 0;
    const result = await runNativeAutoMerge(
      {
        ...feedbackWorkflowInputEnv(),
        INPUT_AUTOMATION_TOKEN: "pat-token",
      },
      {
        listOpenPulls: async () => {
          trace.push("pull-list");
          return [pull()];
        },
        readReviewFeedbackState: async () => {
          trace.push("feedback");
          return { status: "blocked", fingerprint: "late-finding" };
        },
        getNativeState: async () => {
          trace.push("state");
          stateReads += 1;
          return stateReads === 1
            ? initialState
            : {
                id: "PR_test",
                autoMergeRequest: null,
                mergeQueueEntry: null,
              };
        },
        disableAutoMerge: async (id, token) => {
          assert.equal(token, "pat-token");
          trace.push(`disable:${id}`);
        },
        dequeuePull: async (pullId, entryId, token) => {
          assert.equal(token, "pat-token");
          trace.push(`dequeue:${pullId}:${entryId}`);
        },
        loadRequiredChecks: async () => assert.fail("feedback cannot arm"),
        getEffectiveRules: async () => assert.fail("feedback cannot arm"),
        waitForReviewReconciliation: async () =>
          assert.fail("feedback cannot arm"),
        enableAutoMerge: async () => assert.fail("feedback cannot arm"),
      },
    );

    assert.deepEqual(result, { action: "deprivileged", pull: 81 });
    assert.deepEqual(trace, [
      "pull-list",
      "feedback",
      "state",
      ...expectedMutations,
      "state",
    ]);
  }
});

test("trusted late-feedback runs never grant privilege when feedback is clear", async () => {
  let stateReads = 0;
  let mutations = 0;
  const result = await runNativeAutoMerge(
    {
      ...feedbackWorkflowInputEnv({
        event: "issue_comment",
        display_title: "Native PR feedback PR #81 sender #199175422",
      }),
      INPUT_AUTOMATION_TOKEN: "pat-token",
    },
    {
      listOpenPulls: async () => [pull()],
      readReviewFeedbackState: async () => ({
        status: "clear",
        fingerprint: "clean-review",
      }),
      getNativeState: async () => {
        stateReads += 1;
      },
      disableAutoMerge: async () => {
        mutations += 1;
      },
      dequeuePull: async () => {
        mutations += 1;
      },
      enableAutoMerge: async () => {
        mutations += 1;
      },
    },
  );

  assert.deepEqual(result, { action: "none", reason: "feedback-clear" });
  assert.equal(stateReads, 0);
  assert.equal(mutations, 0);
});

test("late-feedback format or API uncertainty removes rather than grants privilege", async () => {
  let stateReads = 0;
  let disableCalls = 0;
  const result = await runNativeAutoMerge(
    {
      ...feedbackWorkflowInputEnv(),
      INPUT_AUTOMATION_TOKEN: "pat-token",
    },
    {
      listOpenPulls: async () => [pull()],
      readReviewFeedbackState: async () => {
        throw new Error("review parser drift");
      },
      getNativeState: async () => {
        stateReads += 1;
        return stateReads === 1
          ? {
              id: "PR_test",
              autoMergeRequest: { enabledAt: "2026-08-09T18:00:00Z" },
              mergeQueueEntry: null,
            }
          : {
              id: "PR_test",
              autoMergeRequest: null,
              mergeQueueEntry: null,
            };
      },
      disableAutoMerge: async (id, token) => {
        disableCalls += 1;
        assert.equal(id, "PR_test");
        assert.equal(token, "pat-token");
      },
      enableAutoMerge: async () => assert.fail("feedback cannot arm"),
    },
  );

  assert.deepEqual(result, { action: "deprivileged", pull: 81 });
  assert.equal(disableCalls, 1);
  assert.equal(stateReads, 2);
});

test("a blocking signal briefly retries when arm state is not visible yet", async () => {
  let stateReads = 0;
  let sleeps = 0;
  let disabled = false;
  const result = await runNativeAutoMerge(
    {
      ...feedbackWorkflowInputEnv(),
      INPUT_AUTOMATION_TOKEN: "pat-token",
    },
    {
      listOpenPulls: async () => [pull()],
      readReviewFeedbackState: async () => ({
        status: "blocked",
        fingerprint: "late-finding",
      }),
      sleep: async (milliseconds) => {
        sleeps += 1;
        assert.equal(milliseconds, 5_000);
      },
      getNativeState: async () => {
        stateReads += 1;
        if (stateReads < 3) {
          return {
            id: "PR_test",
            autoMergeRequest: null,
            mergeQueueEntry: null,
          };
        }
        return {
          id: "PR_test",
          autoMergeRequest:
            stateReads === 3 && !disabled
              ? { enabledAt: "2026-08-09T18:00:00Z" }
              : null,
          mergeQueueEntry: null,
        };
      },
      disableAutoMerge: async () => {
        disabled = true;
      },
      enableAutoMerge: async () => assert.fail("feedback cannot arm"),
    },
  );

  assert.deepEqual(result, { action: "deprivileged", pull: 81 });
  assert.equal(sleeps, 2);
  assert.equal(stateReads, 4);
  assert.equal(disabled, true);
});

test("controller cannot arm auto-merge before all effective rules are active", async () => {
  let nativeStateReads = 0;
  let mutations = 0;
  const result = await runNativeAutoMerge(
    {
      ...workflowRunInputEnv(),
      INPUT_AUTOMATION_TOKEN: "pat-token",
    },
    {
      listOpenPulls: async () => [pull()],
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
      ...workflowRunInputEnv(),
      INPUT_AUTOMATION_TOKEN: "pat-token",
    },
    {
      listOpenPulls: async () => [pull()],
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
        ...workflowRunInputEnv(),
        INPUT_AUTOMATION_TOKEN: "pat-token",
      },
      {
        listOpenPulls: async () => [pull()],
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
      ...workflowRunInputEnv(),
      INPUT_AUTOMATION_TOKEN: "pat-token",
    },
    {
      ...feedbackRuntime(),
      listOpenPulls: async () => [pull()],
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
        ...workflowRunInputEnv(),
        INPUT_AUTOMATION_TOKEN: "pat-token",
      },
      {
        ...feedbackRuntime(),
        listOpenPulls: async () => [pull()],
        getPull: async () => {
          pullReads += 1;
          return changedPull;
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
    assert.equal(pullReads, 1);
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
        ...workflowRunInputEnv(),
        INPUT_AUTOMATION_TOKEN: "pat-token",
      },
      {
        listOpenPulls: async () => [pull()],
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
      ...workflowRunInputEnv(),
      INPUT_AUTOMATION_TOKEN: "pat-token",
    },
    {
      listOpenPulls: async () => [
        pull({ head: { ...pull().head, sha: "f".repeat(40) } }),
      ],
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
        ...workflowRunInputEnv(),
        GITHUB_TOKEN: "ephemeral-token",
      },
      {},
    ),
    /automation_token input must be a non-empty string/,
  );
});

test("action and consumer workflow keep the credential and execution boundary narrow", async () => {
  const action = await readFile(
    new URL("./action.yml", import.meta.url),
    "utf8",
  );
  const implementation = await readFile(
    new URL("./main.mjs", import.meta.url),
    "utf8",
  );
  const workflow = await readFile(
    new URL("../.github/workflows/native-auto-merge.yml", import.meta.url),
    "utf8",
  );
  const signalWorkflow = await readFile(
    new URL(
      "../.github/workflows/native-pr-feedback-signal.yml",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(action, /automation_token:/);
  assert.doesNotMatch(action, /github_token:/);
  assert.match(action, /using:\s*node24/);
  for (const input of [
    "event_repository",
    "workflow_name",
    "workflow_path",
    "workflow_display_title",
    "workflow_status",
    "workflow_event",
    "workflow_head_sha",
    "workflow_pull_requests",
  ]) {
    assert.match(action, new RegExp(`\\n  ${input}:`));
    assert.match(workflow, new RegExp(`\\n          ${input}:`));
  }
  assert.match(
    workflow,
    /workflow_pull_requests:\s*\$\{\{ toJSON\(github\.event\.workflow_run\.pull_requests\) \}\}/,
  );
  assert.doesNotMatch(implementation, /GITHUB_EVENT_PATH/);

  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /- CodeQL/);
  assert.match(workflow, /- Native PR feedback signal/);
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /merge_group:/);
  assert.doesNotMatch(workflow, /pull_request_target:/);
  assert.equal((workflow.match(/permissions:\s*write-all/g) ?? []).length, 3);
  assert.match(workflow, /name:\s*Test native auto-merge/);
  assert.match(workflow, /node --check native-auto-merge\/main\.mjs/);
  assert.match(
    workflow,
    /node --test native-auto-merge\/main\.test\.mjs native-auto-merge\/reconciliation\.test\.mjs/,
  );
  assert.match(workflow, /timeout-minutes:\s*15/);
  assert.match(
    workflow,
    /github\.event_name == 'workflow_run'.*github\.event\.workflow_run\.event == 'pull_request'/s,
  );
  assert.match(workflow, /environment:\s*dependabot-automation/);
  assert.match(
    workflow,
    /group:\s*native-auto-merge-\$\{\{ github\.repository \}\}-\$\{\{ github\.event\.workflow_run\.id \|\| github\.run_id \}\}/,
  );
  assert.match(workflow, /cancel-in-progress:\s*false/);
  assert.match(
    workflow,
    /automation_token:\s*\$\{\{ secrets\.LCV_AUTOMATION_TOKEN \}\}/,
  );
  assert.match(workflow, /ref:\s*\$\{\{ github\.workflow_sha \}\}/);
  assert.doesNotMatch(workflow, /github\.token|GITHUB_TOKEN/);
  assert.doesNotMatch(workflow, /download-artifact|pull_request\.head\.sha/);
  assert.match(signalWorkflow, /pull_request_review:/);
  assert.match(signalWorkflow, /pull_request_review_comment:/);
  assert.match(signalWorkflow, /issue_comment:/);
  assert.match(
    signalWorkflow,
    /Native PR feedback PR #\$\{\{.*\}\} sender #\$\{\{ github\.event\.sender\.id \}\}/s,
  );
  assert.doesNotMatch(
    signalWorkflow,
    /checkout|LCV_AUTOMATION_TOKEN|secrets\./,
  );
  assert.match(
    signalWorkflow,
    /group:\s*native-pr-feedback-signal-\$\{\{ github\.repository \}\}-\$\{\{ github\.event\.pull_request\.number \|\| github\.event\.issue\.number \}\}/,
  );
  assert.match(signalWorkflow, /cancel-in-progress:\s*false/);
});
