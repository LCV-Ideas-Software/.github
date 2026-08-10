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
  githubGetReviewSnapshot,
  githubListOpenPulls,
  hasRequiredNativeEnforcement,
  isEligiblePull,
  loadRequiredChecks,
  pullRequestTargetEventFromInputs,
  removeNativeMergePrivilege,
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
      actor: { id: 268063598 },
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
    INPUT_WORKFLOW_ACTOR_ID: String(event.workflow_run.actor.id),
    INPUT_WORKFLOW_PULL_REQUESTS: JSON.stringify(
      event.workflow_run.pull_requests,
    ),
  };
}

function pullRequestTargetInputEnv(overrides = {}) {
  return {
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_EVENT_NAME: "pull_request_target",
    INPUT_AUTOMATION_TOKEN: "pat-token",
    INPUT_EVENT_REPOSITORY: REPOSITORY,
    INPUT_EVENT_ACTION: "review_requested",
    INPUT_PULL_NUMBER: "81",
    INPUT_PULL_HEAD_SHA: HEAD_SHA,
    INPUT_PULL_HEAD_REPOSITORY: REPOSITORY,
    INPUT_PULL_BASE_REF: "main",
    INPUT_REQUESTED_REVIEWER_ID: "175728472",
    INPUT_TRIGGER_RUN_ID: "31336700000",
    ...overrides,
  };
}

function pullRequestTargetWorkflowRun(overrides = {}) {
  return {
    id: 31336700000,
    path: ".github/workflows/native-auto-merge.yml",
    event: "pull_request_target",
    head_branch: "agent/native-governance-redesign",
    head_sha: HEAD_SHA,
    status: "in_progress",
    created_at: "2026-08-09T18:19:08Z",
    updated_at: "2026-08-09T18:19:15Z",
    repository: { full_name: REPOSITORY },
    ...overrides,
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
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_approving_review_count: 0,
        required_review_thread_resolution: true,
        required_reviewers: [],
      },
    },
    {
      type: "copilot_code_review",
      parameters: {
        review_draft_pull_requests: true,
        review_on_push: true,
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

test("Copilot dynamic workflow runs are not direct controller candidates", () => {
  const event = workflowRunEvent({
    name: "Running Copilot Code Review",
    path: "dynamic/agents/copilot-pull-request-reviewer",
    display_title: "Running Copilot Code Review",
    event: "dynamic",
    actor: { id: 175728472 },
  });
  assert.deepEqual(extractCandidates("workflow_run", event, REPOSITORY), []);
});

test("trusted Copilot review requests yield exact same-repository candidates", () => {
  const event = pullRequestTargetEventFromInputs(pullRequestTargetInputEnv());
  assert.deepEqual(
    extractCandidates("pull_request_target", event, REPOSITORY),
    [
      {
        number: 81,
        headSha: HEAD_SHA,
        source: "copilot-review-requested",
        triggerRunId: 31336700000,
      },
    ],
  );

  for (const overrides of [
    { INPUT_EVENT_ACTION: "opened" },
    { INPUT_REQUESTED_REVIEWER_ID: "268063598" },
    { INPUT_PULL_HEAD_REPOSITORY: "attacker/fork" },
    { INPUT_PULL_BASE_REF: "release" },
    { INPUT_PULL_HEAD_SHA: "f".repeat(39) },
  ]) {
    const candidateEvent = pullRequestTargetEventFromInputs(
      pullRequestTargetInputEnv(overrides),
    );
    assert.deepEqual(
      extractCandidates("pull_request_target", candidateEvent, REPOSITORY),
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

test("transient GitHub reads retry with fresh timeouts while mutations stay one-shot", async () => {
  const response = (body, status, headers = {}) =>
    new Response(body, {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  const signals = [];
  const waits = [];
  let getCalls = 0;
  const result = await githubGetPull(REPOSITORY, 81, "pat-token", {
    timeoutSignalFactory: () => {
      const signal = new AbortController().signal;
      signals.push(signal);
      return signal;
    },
    retrySleep: async (milliseconds) => waits.push(milliseconds),
    fetch: async () => {
      getCalls += 1;
      if (getCalls === 1) {
        return new Response("upstream unavailable", { status: 502 });
      }
      return response(JSON.stringify(pull()), 200);
    },
  });
  assert.equal(result.number, 81);
  assert.equal(getCalls, 2);
  assert.equal(signals.length, 2);
  assert.notEqual(signals[0], signals[1]);
  assert.deepEqual(waits, [250]);

  let rateLimitCalls = 0;
  const rateLimitWaits = [];
  await githubGetPull(REPOSITORY, 81, "pat-token", {
    retrySleep: async (milliseconds) => rateLimitWaits.push(milliseconds),
    fetch: async () => {
      rateLimitCalls += 1;
      return rateLimitCalls === 1
        ? response(JSON.stringify({ message: "rate limited" }), 429, {
            "retry-after": "2",
          })
        : response(JSON.stringify(pull()), 200);
    },
  });
  assert.equal(rateLimitCalls, 2);
  assert.deepEqual(rateLimitWaits, [2_000]);

  let networkCalls = 0;
  await githubGetPull(REPOSITORY, 81, "pat-token", {
    retrySleep: async () => {},
    fetch: async () => {
      networkCalls += 1;
      if (networkCalls === 1) throw new TypeError("connection reset");
      return response(JSON.stringify(pull()), 200);
    },
  });
  assert.equal(networkCalls, 2);

  let graphqlCalls = 0;
  const graphqlState = await githubGetNativeState(REPOSITORY, 81, "pat-token", {
    retrySleep: async () => {},
    fetch: async () => {
      graphqlCalls += 1;
      if (graphqlCalls === 1) {
        return new Response("gateway unavailable", { status: 503 });
      }
      return response(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                id: "PR_test",
                autoMergeRequest: null,
                mergeQueueEntry: null,
              },
            },
          },
        }),
        200,
      );
    },
  });
  assert.equal(graphqlCalls, 2);
  assert.equal(graphqlState.id, "PR_test");

  const nativeStatePayload = {
    data: {
      repository: {
        pullRequest: {
          id: "PR_test",
          autoMergeRequest: null,
          mergeQueueEntry: null,
        },
      },
    },
  };
  for (const rateLimitCase of [
    {
      name: "primary GraphQL limit",
      body: { errors: [{ message: "API rate limit exceeded" }] },
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "1001",
      },
      now: () => 1_000_000,
      expectedWait: 1_000,
    },
    {
      name: "secondary GraphQL limit",
      body: {
        errors: [{ message: "You have exceeded a secondary rate limit" }],
      },
      headers: { "retry-after": "2" },
      now: () => 1_000_000,
      expectedWait: 2_000,
    },
  ]) {
    let calls = 0;
    const waits = [];
    const state = await githubGetNativeState(REPOSITORY, 81, "pat-token", {
      now: rateLimitCase.now,
      retrySleep: async (milliseconds) => waits.push(milliseconds),
      fetch: async () => {
        calls += 1;
        return calls === 1
          ? response(
              JSON.stringify(rateLimitCase.body),
              200,
              rateLimitCase.headers,
            )
          : response(JSON.stringify(nativeStatePayload), 200);
      },
    });
    assert.equal(state.id, "PR_test", rateLimitCase.name);
    assert.equal(calls, 2, rateLimitCase.name);
    assert.deepEqual(waits, [rateLimitCase.expectedWait], rateLimitCase.name);
  }

  let graphqlValidationCalls = 0;
  await assert.rejects(
    githubGetNativeState(REPOSITORY, 81, "pat-token", {
      retrySleep: async () => assert.fail("validation errors cannot retry"),
      fetch: async () => {
        graphqlValidationCalls += 1;
        return response(
          JSON.stringify({
            errors: [
              {
                message: "Variable $number has an invalid value",
                type: "VALIDATION",
              },
            ],
          }),
          200,
        );
      },
    }),
    /GraphQL query failed/i,
  );
  assert.equal(graphqlValidationCalls, 1);

  let malformedSuccessCalls = 0;
  await assert.rejects(
    githubGetPull(REPOSITORY, 81, "pat-token", {
      retrySleep: async () => assert.fail("malformed success cannot retry"),
      fetch: async () => {
        malformedSuccessCalls += 1;
        return new Response("not-json", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    }),
    /non-JSON response/i,
  );
  assert.equal(malformedSuccessCalls, 1);

  let exhaustedCalls = 0;
  await assert.rejects(
    githubGetPull(REPOSITORY, 81, "pat-token", {
      retrySleep: async () => {},
      fetch: async () => {
        exhaustedCalls += 1;
        return new Response("unavailable", { status: 503 });
      },
    }),
    /503/,
  );
  assert.equal(exhaustedCalls, 3);

  let validationCalls = 0;
  await assert.rejects(
    githubGetPull(REPOSITORY, 81, "pat-token", {
      retrySleep: async () => {},
      fetch: async () => {
        validationCalls += 1;
        return response(JSON.stringify({ message: "invalid" }), 422);
      },
    }),
    /422/,
  );
  assert.equal(validationCalls, 1);

  let mutationCalls = 0;
  await assert.rejects(
    githubDisablePullRequestAutoMerge("PR_test", "pat-token", {
      retrySleep: async () => assert.fail("mutation cannot retry"),
      fetch: async () => {
        mutationCalls += 1;
        return new Response("unavailable", { status: 503 });
      },
    }),
    /503/,
  );
  assert.equal(mutationCalls, 1);

  let rateLimitedMutationCalls = 0;
  await assert.rejects(
    githubDisablePullRequestAutoMerge("PR_test", "pat-token", {
      retrySleep: async () => assert.fail("mutation cannot retry"),
      fetch: async () => {
        rateLimitedMutationCalls += 1;
        return response(
          JSON.stringify({
            errors: [{ message: "API rate limit exceeded" }],
          }),
          200,
          {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "1001",
          },
        );
      },
    }),
    /GraphQL mutation failed/i,
  );
  assert.equal(rateLimitedMutationCalls, 1);
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

test("review reconciliation fully paginates root connections and each thread independently", async () => {
  const calls = [];
  const updatedAt = "2026-08-09T18:00:00Z";
  const response = (payload) =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  const snapshot = await githubGetReviewSnapshot(REPOSITORY, 81, "pat-token", {
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      if (calls.length === 1) {
        return response({
          data: {
            repository: {
              pullRequest: {
                id: "PR_test",
                headRefOid: HEAD_SHA,
                updatedAt,
                comments: {
                  totalCount: 2,
                  nodes: [{ id: "IC_1" }],
                  pageInfo: { hasNextPage: true, endCursor: "comments-1" },
                },
                reviews: {
                  totalCount: 1,
                  nodes: [{ id: "PRR_1" }],
                  pageInfo: { hasNextPage: false, endCursor: "reviews-1" },
                },
                reviewThreads: {
                  totalCount: 2,
                  nodes: [
                    {
                      id: "PRRT_1",
                      isResolved: false,
                      isOutdated: false,
                      isCollapsed: false,
                      comments: {
                        totalCount: 2,
                        nodes: [{ id: "PRRC_1" }],
                        pageInfo: {
                          hasNextPage: true,
                          endCursor: "thread-comments-1",
                        },
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: true, endCursor: "threads-1" },
                },
              },
            },
          },
        });
      }
      if (calls.length === 2) {
        return response({
          data: {
            repository: {
              pullRequest: {
                id: "PR_test",
                headRefOid: HEAD_SHA,
                updatedAt,
                comments: {
                  totalCount: 2,
                  nodes: [{ id: "IC_2" }],
                  pageInfo: { hasNextPage: false, endCursor: "comments-2" },
                },
                reviewThreads: {
                  totalCount: 2,
                  nodes: [
                    {
                      id: "PRRT_2",
                      isResolved: true,
                      isOutdated: false,
                      isCollapsed: false,
                      comments: {
                        totalCount: 2,
                        nodes: [{ id: "PRRC_3" }],
                        pageInfo: {
                          hasNextPage: true,
                          endCursor: "thread-2-comments-1",
                        },
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: "threads-2" },
                },
              },
            },
          },
        });
      }
      if (calls.length === 3) {
        return response({
          data: {
            node: {
              __typename: "PullRequestReviewThread",
              id: "PRRT_1",
              isResolved: false,
              isOutdated: false,
              isCollapsed: false,
              pullRequest: {
                id: "PR_test",
                headRefOid: HEAD_SHA,
                updatedAt,
              },
              comments: {
                totalCount: 2,
                nodes: [{ id: "PRRC_2" }],
                pageInfo: {
                  hasNextPage: false,
                  endCursor: "thread-comments-2",
                },
              },
            },
          },
        });
      }
      return response({
        data: {
          node: {
            __typename: "PullRequestReviewThread",
            id: "PRRT_2",
            isResolved: true,
            isOutdated: false,
            isCollapsed: false,
            pullRequest: {
              id: "PR_test",
              headRefOid: HEAD_SHA,
              updatedAt,
            },
            comments: {
              totalCount: 2,
              nodes: [{ id: "PRRC_4" }],
              pageInfo: {
                hasNextPage: false,
                endCursor: "thread-2-comments-2",
              },
            },
          },
        },
      });
    },
  });

  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0].variables, {
    owner: "LCV-Ideas-Software",
    repo: ".github",
    number: 81,
    limit: 100,
    commentsAfter: null,
    reviewsAfter: null,
    threadsAfter: null,
    includeComments: true,
    includeReviews: true,
    includeThreads: true,
  });
  assert.deepEqual(calls[1].variables, {
    owner: "LCV-Ideas-Software",
    repo: ".github",
    number: 81,
    limit: 100,
    commentsAfter: "comments-1",
    reviewsAfter: "reviews-1",
    threadsAfter: "threads-1",
    includeComments: true,
    includeReviews: false,
    includeThreads: true,
  });
  assert.deepEqual(calls[2].variables, {
    threadId: "PRRT_1",
    limit: 100,
    after: "thread-comments-1",
  });
  assert.deepEqual(calls[3].variables, {
    threadId: "PRRT_2",
    limit: 100,
    after: "thread-2-comments-1",
  });
  assert.deepEqual(
    snapshot.comments.nodes.map(({ id }) => id),
    ["IC_1", "IC_2"],
  );
  assert.deepEqual(
    snapshot.reviews.nodes.map(({ id }) => id),
    ["PRR_1"],
  );
  assert.deepEqual(
    snapshot.reviewThreads.nodes.map(({ id }) => id),
    ["PRRT_1", "PRRT_2"],
  );
  assert.deepEqual(
    snapshot.reviewThreads.nodes[0].comments.nodes.map(({ id }) => id),
    ["PRRC_1", "PRRC_2"],
  );
  assert.deepEqual(
    snapshot.reviewThreads.nodes[1].comments.nodes.map(({ id }) => id),
    ["PRRC_3", "PRRC_4"],
  );
  assert.equal(snapshot.comments.pageInfo.hasNextPage, false);
  assert.equal(snapshot.reviews.pageInfo.hasNextPage, false);
  assert.equal(snapshot.reviewThreads.pageInfo.hasNextPage, false);
});

test("review reconciliation pagination fails closed when totalCount drifts", async () => {
  const response = (pullRequest) =>
    new Response(JSON.stringify({ data: { repository: { pullRequest } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  let call = 0;
  await assert.rejects(
    githubGetReviewSnapshot(REPOSITORY, 81, "pat-token", {
      fetch: async () => {
        call += 1;
        return response({
          id: "PR_test",
          headRefOid: HEAD_SHA,
          updatedAt: "2026-08-09T18:00:00Z",
          comments: {
            totalCount: call === 1 ? 3 : 4,
            nodes: [{ id: `IC_${call}` }],
            pageInfo: { hasNextPage: true, endCursor: "same-cursor" },
          },
          ...(call === 1
            ? {
                reviews: {
                  totalCount: 0,
                  nodes: [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
                reviewThreads: {
                  totalCount: 0,
                  nodes: [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              }
            : {}),
        });
      },
    }),
    /issue comment total count changed/i,
  );
});

test("review reconciliation pagination fails closed when a cursor repeats", async () => {
  const response = (pullRequest) =>
    new Response(JSON.stringify({ data: { repository: { pullRequest } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  let call = 0;
  await assert.rejects(
    githubGetReviewSnapshot(REPOSITORY, 81, "pat-token", {
      fetch: async () => {
        call += 1;
        return response({
          id: "PR_test",
          headRefOid: HEAD_SHA,
          updatedAt: "2026-08-09T18:00:00Z",
          comments: {
            totalCount: 3,
            nodes: [{ id: `IC_${call}` }],
            pageInfo: { hasNextPage: true, endCursor: "same-cursor" },
          },
          ...(call === 1
            ? {
                reviews: {
                  totalCount: 0,
                  nodes: [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
                reviewThreads: {
                  totalCount: 0,
                  nodes: [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              }
            : {}),
        });
      },
    }),
    /issue comment next page cursor repeated/i,
  );
});

test("review reconciliation rejects malformed pages and snapshot identity drift", async () => {
  const updatedAt = "2026-08-09T18:00:00Z";
  const empty = () => ({
    totalCount: 0,
    nodes: [],
    pageInfo: { hasNextPage: false, endCursor: null },
  });
  const response = (payload) =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const pullPage = (comments, overrides = {}) => ({
    id: "PR_test",
    headRefOid: HEAD_SHA,
    updatedAt,
    comments,
    reviews: empty(),
    reviewThreads: empty(),
    ...overrides,
  });
  const graphQl = (pullRequest) => ({
    data: { repository: { pullRequest } },
  });

  await assert.rejects(
    githubGetReviewSnapshot(REPOSITORY, 81, "pat-token", {
      fetch: async () =>
        response(
          graphQl(
            pullPage({
              totalCount: 2,
              nodes: [{ id: "IC_1" }],
              pageInfo: { hasNextPage: true, endCursor: null },
            }),
          ),
        ),
    }),
    /issue comment next page cursor is missing/i,
  );

  await assert.rejects(
    githubGetReviewSnapshot(REPOSITORY, 81, "pat-token", {
      fetch: async () =>
        response(
          graphQl(
            pullPage({
              totalCount: 2,
              nodes: [{ id: "IC_1" }],
              pageInfo: { hasNextPage: false, endCursor: "comments-1" },
            }),
          ),
        ),
    }),
    /issue comment ended before its declared total count/i,
  );

  let duplicatePage = 0;
  await assert.rejects(
    githubGetReviewSnapshot(REPOSITORY, 81, "pat-token", {
      fetch: async () => {
        duplicatePage += 1;
        const first = duplicatePage === 1;
        const pullRequest = pullPage({
          totalCount: 2,
          nodes: [{ id: "IC_1" }],
          pageInfo: {
            hasNextPage: first,
            endCursor: first ? "comments-1" : "comments-2",
          },
        });
        if (!first) {
          delete pullRequest.reviews;
          delete pullRequest.reviewThreads;
        }
        return response(graphQl(pullRequest));
      },
    }),
    /duplicate issue comment node IC_1/i,
  );

  let driftPage = 0;
  await assert.rejects(
    githubGetReviewSnapshot(REPOSITORY, 81, "pat-token", {
      fetch: async () => {
        driftPage += 1;
        const first = driftPage === 1;
        const pullRequest = pullPage(
          {
            totalCount: 2,
            nodes: [{ id: `IC_${driftPage}` }],
            pageInfo: {
              hasNextPage: first,
              endCursor: `comments-${driftPage}`,
            },
          },
          first ? {} : { headRefOid: "f".repeat(40) },
        );
        if (!first) {
          delete pullRequest.reviews;
          delete pullRequest.reviewThreads;
        }
        return response(graphQl(pullRequest));
      },
    }),
    /pull request changed during pagination/i,
  );

  await assert.rejects(
    githubGetReviewSnapshot(REPOSITORY, 81, "pat-token", {
      fetch: async () =>
        response({
          errors: [{ message: "partial failure" }],
          data: { repository: { pullRequest: pullPage(empty()) } },
        }),
    }),
    /GraphQL query failed: partial failure/i,
  );

  await assert.rejects(
    githubGetReviewSnapshot(REPOSITORY, 81, "pat-token", {
      fetch: async () =>
        response(
          graphQl(
            pullPage({
              totalCount: 100_001,
              nodes: [],
              pageInfo: { hasNextPage: true, endCursor: "comments-1" },
            }),
          ),
        ),
    }),
    /malformed issue comment connection page/i,
  );
});

test("review thread continuation validates state and pull request ownership", async () => {
  const updatedAt = "2026-08-09T18:00:00Z";
  const response = (payload) =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  let call = 0;
  await assert.rejects(
    githubGetReviewSnapshot(REPOSITORY, 81, "pat-token", {
      fetch: async () => {
        call += 1;
        if (call === 1) {
          return response({
            data: {
              repository: {
                pullRequest: {
                  id: "PR_test",
                  headRefOid: HEAD_SHA,
                  updatedAt,
                  comments: {
                    totalCount: 0,
                    nodes: [],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                  reviews: {
                    totalCount: 0,
                    nodes: [],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                  reviewThreads: {
                    totalCount: 1,
                    nodes: [
                      {
                        id: "PRRT_1",
                        isResolved: false,
                        isOutdated: false,
                        isCollapsed: false,
                        comments: {
                          totalCount: 2,
                          nodes: [{ id: "PRRC_1" }],
                          pageInfo: {
                            hasNextPage: true,
                            endCursor: "thread-comments-1",
                          },
                        },
                      },
                    ],
                    pageInfo: { hasNextPage: false, endCursor: "threads-1" },
                  },
                },
              },
            },
          });
        }
        return response({
          data: {
            node: {
              __typename: "PullRequestReviewThread",
              id: "PRRT_1",
              isResolved: true,
              isOutdated: false,
              isCollapsed: false,
              pullRequest: {
                id: "PR_test",
                headRefOid: HEAD_SHA,
                updatedAt,
              },
              comments: {
                totalCount: 2,
                nodes: [{ id: "PRRC_2" }],
                pageInfo: {
                  hasNextPage: false,
                  endCursor: "thread-comments-2",
                },
              },
            },
          },
        });
      },
    }),
    /review thread changed during comment pagination/i,
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

  assert.equal(rules.length, 9);
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
    ...Array.from({ length: 92 }, () => ({ type: "deletion" })),
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
    effectiveRules().filter(({ type }) => type !== "copilot_code_review"),
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
    ...[
      { required_approving_review_count: 5 },
      { require_code_owner_review: true },
      { require_last_push_approval: true },
      {
        required_reviewers: [
          {
            file_patterns: ["**"],
            minimum_approvals: 1,
            reviewer: { id: 1, type: "Team" },
          },
        ],
      },
    ].map((drift) =>
      effectiveRules().map((rule) =>
        rule.type === "pull_request"
          ? {
              ...rule,
              parameters: { ...rule.parameters, ...drift },
            }
          : rule,
      ),
    ),
    effectiveRules().map((rule) =>
      rule.type === "copilot_code_review"
        ? { ...rule, parameters: { ...rule.parameters, review_on_push: false } }
        : rule,
    ),
    [
      ...effectiveRules(),
      {
        type: "pull_request",
        parameters: {
          ...effectiveRules().find(({ type }) => type === "pull_request")
            .parameters,
          required_approving_review_count: 5,
        },
      },
    ],
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
      ...effectiveRules().filter(({ type }) => type !== "pull_request"),
      {
        type: "pull_request",
        parameters: {
          ...effectiveRules().find(({ type }) => type === "pull_request")
            .parameters,
          required_reviewers: {},
        },
      },
    ],
    [
      ...effectiveRules().filter(({ type }) => type !== "copilot_code_review"),
      { type: "copilot_code_review", parameters: { review_on_push: "yes" } },
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
        return finalFeedbackReads <= 2
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
    "feedback:2",
    "enable",
    "feedback:3",
    "state",
    "disable",
    "state",
  ]);
});

test("an ambiguous enable error is deprivileged before it escapes", async () => {
  let enabled = false;
  let disabled = false;
  let disableCalls = 0;
  await assert.rejects(
    runNativeAutoMerge(
      {
        ...workflowRunInputEnv(),
        INPUT_AUTOMATION_TOKEN: "pat-token",
      },
      {
        ...feedbackRuntime(),
        listOpenPulls: async () => [pull()],
        getPull: async () => pull(),
        getEffectiveRules: async () => effectiveRules(),
        getNativeState: async () => ({
          id: "PR_test",
          autoMergeRequest:
            enabled && !disabled ? { enabledAt: "2026-08-09T18:00:00Z" } : null,
          mergeQueueEntry: null,
        }),
        enableAutoMerge: async () => {
          enabled = true;
          throw new Error("enable response was lost");
        },
        disableAutoMerge: async () => {
          disableCalls += 1;
          disabled = true;
        },
        sleep: async () => {},
      },
    ),
    /enable response was lost/i,
  );

  assert.equal(enabled, true);
  assert.equal(disabled, true);
  assert.equal(disableCalls, 1);
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

test("native privilege removal handles auto-merge, queue, or both", async () => {
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
    const result = await removeNativeMergePrivilege(
      {
        repository: REPOSITORY,
        number: 81,
        token: "pat-token",
      },
      {
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
      },
      {},
    );

    assert.equal(result, true);
    assert.deepEqual(trace, ["state", ...expectedMutations, "state"]);
  }
});

test("ambiguous deprivileging mutations are reconciled from exact native state", async () => {
  let queued = true;
  let enabled = true;
  let dequeueCalls = 0;
  let disableCalls = 0;
  let sleeps = 0;
  const result = await removeNativeMergePrivilege(
    {
      repository: REPOSITORY,
      number: 81,
      token: "pat-token",
    },
    {
      getNativeState: async () => ({
        id: "PR_test",
        autoMergeRequest: enabled
          ? { enabledAt: "2026-08-09T18:00:00Z" }
          : null,
        mergeQueueEntry: queued ? { id: "MQE_test" } : null,
      }),
      dequeuePull: async () => {
        dequeueCalls += 1;
        queued = false;
        throw new Error("response lost after dequeue applied");
      },
      disableAutoMerge: async () => {
        disableCalls += 1;
        if (disableCalls === 1) {
          throw new Error("disable failed before applying");
        }
        enabled = false;
      },
    },
    { sleep: async () => (sleeps += 1) },
  );

  assert.equal(result, true);
  assert.equal(queued, false);
  assert.equal(enabled, false);
  assert.equal(dequeueCalls, 1);
  assert.equal(disableCalls, 2);
  assert.equal(sleeps, 1);
});

test("deprivileging fails closed when exact state remains privileged", async () => {
  let mutationCalls = 0;
  await assert.rejects(
    removeNativeMergePrivilege(
      {
        repository: REPOSITORY,
        number: 81,
        token: "pat-token",
      },
      {
        getNativeState: async () => ({
          id: "PR_test",
          autoMergeRequest: { enabledAt: "2026-08-09T18:00:00Z" },
          mergeQueueEntry: { id: "MQE_test" },
        }),
        dequeuePull: async () => {
          mutationCalls += 1;
          throw new Error("dequeue did not apply");
        },
        disableAutoMerge: async () => {
          mutationCalls += 1;
          throw new Error("disable did not apply");
        },
      },
      { sleep: async () => {} },
    ),
    /native merge privilege remained after late feedback/i,
  );
  assert.equal(mutationCalls, 8);
});

test("a Copilot review request removes existing merge privilege before waiting", async () => {
  const sequence = [];
  let nativeStateReads = 0;
  const result = await runNativeAutoMerge(pullRequestTargetInputEnv(), {
    listOpenPulls: async () => [pull()],
    getWorkflowRun: async () => pullRequestTargetWorkflowRun(),
    getNativeState: async () => {
      sequence.push("state");
      nativeStateReads += 1;
      if (nativeStateReads === 1) {
        return {
          id: "PR_test",
          autoMergeRequest: { enabledAt: "2026-08-09T18:00:00Z" },
          mergeQueueEntry: null,
        };
      }
      if (nativeStateReads === 3) {
        return {
          id: "PR_test",
          autoMergeRequest: null,
          mergeQueueEntry: { id: "MQE_test" },
        };
      }
      return {
        id: "PR_test",
        autoMergeRequest: null,
        mergeQueueEntry: null,
      };
    },
    disableAutoMerge: async () => {
      sequence.push("disable");
    },
    dequeuePull: async () => {
      sequence.push("dequeue");
    },
    loadRequiredChecks: async () => POLICY_REQUIRED_CHECKS,
    getEffectiveRules: async () => effectiveRules(),
    waitForReviewReconciliation: async (request, waitRuntime) => {
      sequence.push("wait");
      assert.equal(request.requireCopilotReviewRun, true);
      assert.equal(request.copilotReviewRequestedAt, "2026-08-09T18:19:08Z");
      assert.equal(typeof waitRuntime.beforeRead, "function");
      await waitRuntime.beforeRead(request, waitRuntime);
      return { status: "blocked", fingerprint: "copilot-finding" };
    },
    sleep: async () => {
      sequence.push("retry-sleep");
    },
    enableAutoMerge: async () => assert.fail("blocking review cannot arm"),
  });

  assert.deepEqual(result, {
    action: "skipped",
    reason: "review-feedback-blocking",
  });
  assert.deepEqual(sequence.slice(0, 3), ["state", "disable", "state"]);
  assert.equal(sequence.indexOf("dequeue") < sequence.indexOf("wait"), true);
  assert.equal(sequence.includes("dequeue"), true);
  assert.equal(sequence.includes("retry-sleep"), true);
});

test("a Copilot review request binds to its exact trusted workflow run", async () => {
  for (const override of [
    { id: 31336700001 },
    { path: ".github/workflows/spoof.yml" },
    { event: "pull_request" },
    { head_sha: "f".repeat(40) },
    { status: "completed" },
    { repository: { full_name: "attacker/fork" } },
  ]) {
    await assert.rejects(
      runNativeAutoMerge(pullRequestTargetInputEnv(), {
        listOpenPulls: async () => [pull()],
        getNativeState: async () => ({
          id: "PR_test",
          autoMergeRequest: null,
          mergeQueueEntry: null,
        }),
        getWorkflowRun: async () => pullRequestTargetWorkflowRun(override),
        loadRequiredChecks: async () =>
          assert.fail("untrusted trigger cannot read policy"),
        sleep: async () => {},
      }),
      /review-request workflow identity drifted/i,
    );
  }
});

test("a Copilot review request removes a concurrent arm after every setup failure or early exit", async () => {
  const cases = [
    {
      name: "workflow-run read failure",
      getWorkflowRun: async (arm) => {
        arm();
        throw new Error("setup workflow-run read failed");
      },
      expectedError: /setup workflow-run read failed/,
    },
    {
      name: "policy read failure",
      loadRequiredChecks: async (arm) => {
        arm();
        throw new Error("setup policy read failed");
      },
      expectedError: /setup policy read failed/,
    },
    {
      name: "repository absent from policy",
      loadRequiredChecks: async (arm) => {
        arm();
        return null;
      },
      expectedResult: {
        action: "skipped",
        reason: "repository-not-in-policy",
      },
    },
    {
      name: "effective-rules read failure",
      getEffectiveRules: async (arm) => {
        arm();
        throw new Error("setup effective-rules read failed");
      },
      expectedError: /setup effective-rules read failed/,
    },
    {
      name: "native enforcement inactive",
      getEffectiveRules: async (arm) => {
        arm();
        return [];
      },
      expectedResult: {
        action: "skipped",
        reason: "native-enforcement-inactive",
      },
    },
  ];

  for (const setupCase of cases) {
    let armed = false;
    let disables = 0;
    const arm = () => {
      armed = true;
    };
    const runtime = {
      listOpenPulls: async () => [pull()],
      getWorkflowRun: async () => pullRequestTargetWorkflowRun(),
      getNativeState: async () => ({
        id: "PR_test",
        autoMergeRequest: armed ? { enabledAt: "2026-08-09T18:20:00Z" } : null,
        mergeQueueEntry: null,
      }),
      disableAutoMerge: async () => {
        disables += 1;
        armed = false;
      },
      dequeuePull: async () => assert.fail("no queue entry was introduced"),
      loadRequiredChecks: async () => POLICY_REQUIRED_CHECKS,
      getEffectiveRules: async () => effectiveRules(),
      sleep: async () => {},
    };
    if (setupCase.getWorkflowRun) {
      runtime.getWorkflowRun = () => setupCase.getWorkflowRun(arm);
    }
    if (setupCase.loadRequiredChecks) {
      runtime.loadRequiredChecks = () => setupCase.loadRequiredChecks(arm);
    }
    if (setupCase.getEffectiveRules) {
      runtime.getEffectiveRules = () => setupCase.getEffectiveRules(arm);
    }

    if (setupCase.expectedError) {
      await assert.rejects(
        runNativeAutoMerge(pullRequestTargetInputEnv(), runtime),
        setupCase.expectedError,
        setupCase.name,
      );
    } else {
      assert.deepEqual(
        await runNativeAutoMerge(pullRequestTargetInputEnv(), runtime),
        setupCase.expectedResult,
        setupCase.name,
      );
    }
    assert.equal(armed, false, `${setupCase.name}: privilege must be absent`);
    assert.equal(disables, 1, `${setupCase.name}: concurrent arm is removed`);
  }
});

test("a Copilot review request holds native privilege before open-pull inventory", async () => {
  for (const inventoryCase of ["throws", "omits"]) {
    let armed = false;
    let disables = 0;
    const runtime = {
      listOpenPulls: async () => {
        armed = true;
        if (inventoryCase === "throws") {
          throw new Error("open-pull inventory failed after concurrent arm");
        }
        return [];
      },
      getNativeState: async () => ({
        id: "PR_test",
        autoMergeRequest: armed ? { enabledAt: "2026-08-09T18:20:00Z" } : null,
        mergeQueueEntry: null,
      }),
      disableAutoMerge: async () => {
        disables += 1;
        armed = false;
      },
      dequeuePull: async () => assert.fail("no queue entry was introduced"),
      sleep: async () => {},
    };

    if (inventoryCase === "throws") {
      await assert.rejects(
        runNativeAutoMerge(pullRequestTargetInputEnv(), runtime),
        /open-pull inventory failed/i,
      );
    } else {
      assert.deepEqual(
        await runNativeAutoMerge(pullRequestTargetInputEnv(), runtime),
        { action: "skipped", reason: "ineligible" },
      );
    }
    assert.equal(armed, false, inventoryCase);
    assert.equal(disables, 1, inventoryCase);
  }
});

test("a clear requested Copilot review is revalidated before rearming", async () => {
  let enables = 0;
  const result = await runNativeAutoMerge(pullRequestTargetInputEnv(), {
    listOpenPulls: async () => [pull()],
    getWorkflowRun: async () => pullRequestTargetWorkflowRun(),
    getNativeState: async () => ({
      id: "PR_test",
      autoMergeRequest: null,
      mergeQueueEntry: null,
    }),
    loadRequiredChecks: async () => POLICY_REQUIRED_CHECKS,
    getEffectiveRules: async () => effectiveRules(),
    waitForReviewReconciliation: async (request) => {
      assert.equal(request.requireCopilotReviewRun, true);
      assert.equal(request.copilotReviewRequestedAt, "2026-08-09T18:19:08Z");
      return CLEAR_FEEDBACK;
    },
    getPull: async () => pull(),
    readReviewReconciliationState: async (request) => {
      assert.equal(request.requireCopilotReviewRun, true);
      return CLEAR_FEEDBACK;
    },
    enableAutoMerge: async () => {
      enables += 1;
    },
  });

  assert.deepEqual(result, { action: "enabled", pull: 81, head: HEAD_SHA });
  assert.equal(enables, 1);
});

test("a concurrent arm after the Copilot wait is removed before final revalidation", async () => {
  let armed = false;
  let disables = 0;
  let enables = 0;
  const result = await runNativeAutoMerge(pullRequestTargetInputEnv(), {
    listOpenPulls: async () => [pull()],
    getWorkflowRun: async () => pullRequestTargetWorkflowRun(),
    getNativeState: async () => ({
      id: "PR_test",
      autoMergeRequest: armed ? { enabledAt: "2026-08-09T18:20:00Z" } : null,
      mergeQueueEntry: null,
    }),
    disableAutoMerge: async () => {
      disables += 1;
      armed = false;
    },
    dequeuePull: async () =>
      assert.fail("the race armed auto-merge, not queue"),
    loadRequiredChecks: async () => POLICY_REQUIRED_CHECKS,
    getEffectiveRules: async () => effectiveRules(),
    waitForReviewReconciliation: async () => {
      armed = true;
      return CLEAR_FEEDBACK;
    },
    getPull: async () => pull(),
    readReviewReconciliationState: async () => CLEAR_FEEDBACK,
    enableAutoMerge: async () => {
      enables += 1;
    },
    sleep: async () => {},
  });

  assert.deepEqual(result, { action: "enabled", pull: 81, head: HEAD_SHA });
  assert.equal(disables, 1);
  assert.equal(enables, 1);
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
  const zizmorConfig = await readFile(
    new URL("../.github/zizmor.yml", import.meta.url),
    "utf8",
  );
  await assert.rejects(
    readFile(
      new URL(
        "../.github/workflows/native-pr-feedback-signal.yml",
        import.meta.url,
      ),
      "utf8",
    ),
    { code: "ENOENT" },
  );

  assert.match(action, /operation:/);
  assert.match(action, /automation_token:/);
  assert.match(action, /github_token:/);
  assert.match(action, /using:\s*node24/);
  for (const input of [
    "event_repository",
    "workflow_name",
    "workflow_path",
    "workflow_display_title",
    "workflow_status",
    "workflow_event",
    "workflow_head_sha",
    "workflow_actor_id",
    "workflow_pull_requests",
    "event_action",
    "pull_number",
    "pull_head_sha",
    "pull_head_repository",
    "pull_base_ref",
    "requested_reviewer_id",
    "trigger_run_id",
  ]) {
    assert.match(action, new RegExp(`\\n  ${input}:`));
    assert.match(workflow, new RegExp(`\\n          ${input}:`));
  }
  assert.match(
    workflow,
    /workflow_pull_requests:\s*\$\{\{ toJSON\(github\.event\.workflow_run\.pull_requests\) \}\}/,
  );
  assert.match(workflow, /trigger_run_id:\s*\$\{\{ github\.run_id \}\}/);
  assert.doesNotMatch(implementation, /GITHUB_EVENT_PATH/);

  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /- CodeQL/);
  assert.doesNotMatch(workflow, /Native PR feedback signal/);
  assert.doesNotMatch(workflow, /- (?:Running Copilot Code Review|Copilot)/);
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /merge_group:/);
  assert.match(
    workflow,
    /pull_request_target:\s*\n\s+types:\s*\n\s+- review_requested/,
  );
  assert.match(workflow, /github\.event\.requested_reviewer\.id == 175728472/);
  assert.match(
    workflow,
    /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
  );
  assert.equal((workflow.match(/permissions:\s*write-all/g) ?? []).length, 3);
  assert.match(workflow, /name:\s*Test native auto-merge/);
  assert.match(workflow, /node --check native-auto-merge\/main\.mjs/);
  assert.match(
    workflow,
    /node --test native-auto-merge\/main\.test\.mjs native-auto-merge\/reconciliation\.test\.mjs native-auto-merge\/merge-group\.test\.mjs/,
  );
  assert.match(workflow, /timeout-minutes:\s*30/);
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
  assert.equal(
    (workflow.match(/github_token:\s*\$\{\{ github\.token \}\}/g) ?? []).length,
    0,
    "the bootstrap PR must not execute candidate-controlled gate code with a token",
  );
  assert.doesNotMatch(
    workflow,
    /uses:\s*\.\/native-auto-merge[\s\S]*operation:\s*merge-group-feedback-gate/,
    "merge-group activation must consume the published component by immutable SHA in a follow-up",
  );
  for (const input of [
    "merge_group_head_sha",
    "merge_group_base_ref",
    "merge_group_head_ref",
  ]) {
    assert.match(action, new RegExp(`\\n  ${input}:`));
    assert.doesNotMatch(workflow, new RegExp(`\\n          ${input}:`));
  }
  assert.doesNotMatch(
    workflow,
    /download-artifact|ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha/,
  );
  assert.match(
    zizmorConfig,
    /workflow_run and pull_request_target jobs consume only the trusted/,
  );
  assert.match(zizmorConfig, /never check out or\s+# download candidate-head/);
});
