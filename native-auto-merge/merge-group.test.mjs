import test from "node:test";
import assert from "node:assert/strict";

import {
  githubGetRequestedReviewers,
  githubListPullsForCommit,
  mergeGroupEventFromInputs,
  readMergeGroupFeedbackState,
  runMergeGroupFeedbackGate,
  runNativeAutoMerge,
} from "./main.mjs";

const REPOSITORY = "LCV-Ideas-Software/.github";
const SYNTHETIC_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);

function mergeGroupEnv(overrides = {}) {
  return {
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_EVENT_NAME: "merge_group",
    GITHUB_SHA: SYNTHETIC_SHA,
    GITHUB_REF: "refs/heads/gh-readonly-queue/main/pr-108-deadbeef",
    INPUT_OPERATION: "merge-group-feedback-gate",
    INPUT_GITHUB_TOKEN: "github-token",
    INPUT_EVENT_REPOSITORY: REPOSITORY,
    INPUT_EVENT_ACTION: "checks_requested",
    INPUT_MERGE_GROUP_HEAD_SHA: SYNTHETIC_SHA,
    INPUT_MERGE_GROUP_BASE_REF: "refs/heads/main",
    INPUT_MERGE_GROUP_HEAD_REF:
      "refs/heads/gh-readonly-queue/main/pr-108-deadbeef",
    ...overrides,
  };
}

function pull(overrides = {}) {
  return {
    number: 108,
    state: "open",
    draft: false,
    head: {
      sha: HEAD_SHA,
      ref: "agent/enterprise-governance-v2",
      repo: { full_name: REPOSITORY },
    },
    base: {
      ref: "main",
      repo: { full_name: REPOSITORY },
    },
    ...overrides,
  };
}

function emptyReviewSnapshot() {
  const connection = { nodes: [], pageInfo: { hasNextPage: false } };
  return {
    id: "PR_test",
    headRefOid: HEAD_SHA,
    comments: connection,
    reviews: connection,
    reviewThreads: connection,
  };
}

test("merge-group inputs bind the exact synthetic event without a PAT", () => {
  assert.deepEqual(mergeGroupEventFromInputs(mergeGroupEnv()), {
    repository: REPOSITORY,
    action: "checks_requested",
    headSha: SYNTHETIC_SHA,
    baseRef: "refs/heads/main",
    headRef: "refs/heads/gh-readonly-queue/main/pr-108-deadbeef",
  });

  for (const override of [
    { INPUT_EVENT_REPOSITORY: "attacker/fork" },
    { INPUT_EVENT_ACTION: "destroyed" },
    { INPUT_MERGE_GROUP_HEAD_SHA: "a".repeat(39) },
    { INPUT_MERGE_GROUP_BASE_REF: "refs/heads/release" },
    { INPUT_MERGE_GROUP_HEAD_REF: "refs/heads/main" },
    { GITHUB_SHA: "f".repeat(40) },
    { GITHUB_REF: "refs/heads/gh-readonly-queue/main/pr-999-deadbeef" },
    { INPUT_AUTOMATION_TOKEN: "pat-must-not-enter-the-read-only-gate" },
  ]) {
    assert.throws(
      () => mergeGroupEventFromInputs(mergeGroupEnv(override)),
      /merge.group|automation.token|repository/i,
    );
  }
});

test("the synthetic commit maps to exactly one current same-repository pull request", async () => {
  const calls = [];
  const pulls = await githubListPullsForCommit(
    REPOSITORY,
    SYNTHETIC_SHA,
    "github-token",
    {
      fetch: async (url, options) => {
        calls.push({ url, options });
        return new Response(JSON.stringify([pull()]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  );
  assert.equal(pulls.length, 1);
  assert.match(calls[0].url, /commits\/[a]{40}\/pulls\?per_page=100&page=1$/);
  assert.equal(calls[0].options.headers.authorization, "Bearer github-token");

  for (const payload of [[], [pull(), pull({ number: 109 })], {}]) {
    await assert.rejects(
      githubListPullsForCommit(REPOSITORY, SYNTHETIC_SHA, "github-token", {
        fetch: async () =>
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      }),
      /exactly one|malformed/i,
    );
  }
});

test("requested-reviewer inventory is exact, normalized, and fail-closed", async () => {
  const calls = [];
  const reviewers = await githubGetRequestedReviewers(
    REPOSITORY,
    108,
    "github-token",
    {
      fetch: async (url, options) => {
        calls.push({ url, options });
        return new Response(
          JSON.stringify({
            users: [
              { id: 175728472, login: "Copilot", type: "Bot" },
              { id: 7, login: "reviewer", type: "User" },
            ],
            teams: [{ id: 9, slug: "security" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    },
  );
  assert.deepEqual(reviewers, {
    users: [
      { id: 7, login: "reviewer", type: "User" },
      { id: 175728472, login: "Copilot", type: "Bot" },
    ],
    teams: [{ id: 9, slug: "security" }],
  });
  assert.match(calls[0].url, /pulls\/108\/requested_reviewers$/);
  assert.equal(calls[0].options.headers.authorization, "Bearer github-token");

  for (const payload of [
    {},
    { users: null, teams: [] },
    { users: [{ id: 0, login: "bad", type: "Bot" }], teams: [] },
    {
      users: [
        { id: 7, login: "duplicate", type: "User" },
        { id: 7, login: "duplicate", type: "User" },
      ],
      teams: [],
    },
  ]) {
    await assert.rejects(
      githubGetRequestedReviewers(REPOSITORY, 108, "github-token", {
        fetch: async () =>
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      }),
      /malformed requested/i,
    );
  }
});

test("merge-group association rejects every malformed or ineligible pull shape", async () => {
  const malformedPulls = [
    pull({ state: "closed" }),
    pull({ draft: true }),
    pull({ number: 0 }),
    pull({ head: { ...pull().head, sha: "not-a-sha" } }),
    pull({ head: { ...pull().head, ref: "" } }),
    pull({
      head: { ...pull().head, repo: { full_name: "attacker/fork" } },
    }),
    pull({ base: { ...pull().base, ref: "release" } }),
    pull({
      base: { ...pull().base, repo: { full_name: "attacker/fork" } },
    }),
  ];

  for (const malformed of malformedPulls) {
    await assert.rejects(
      runMergeGroupFeedbackGate(mergeGroupEnv(), {
        listPullsForCommit: async () => [malformed],
        getPull: async () => malformed,
      }),
      /identity is malformed/i,
    );
  }
});

test("merge-group feedback state is read-only and keeps bot absence neutral", async () => {
  const state = await readMergeGroupFeedbackState(
    {
      repository: REPOSITORY,
      number: 108,
      headSha: HEAD_SHA,
      token: "github-token",
    },
    {
      getRequestedReviewers: async () => ({ users: [], teams: [] }),
      listCopilotReviewRuns: async () => [],
      getReviewSnapshot: async () => emptyReviewSnapshot(),
    },
  );
  assert.equal(state.status, "clear");
  assert.match(state.fingerprint, /^[0-9a-f]{64}$/);

  const pending = await readMergeGroupFeedbackState(
    {
      repository: REPOSITORY,
      number: 108,
      headSha: HEAD_SHA,
      token: "github-token",
    },
    {
      getRequestedReviewers: async () => ({
        users: [
          {
            id: 175728472,
            login: "copilot-pull-request-reviewer[bot]",
            type: "Bot",
          },
        ],
        teams: [],
      }),
      listCopilotReviewRuns: async () => [],
      getReviewSnapshot: async () => emptyReviewSnapshot(),
    },
  );
  assert.equal(pending.status, "pending");
});

test("merge-group gate revalidates association and feedback without mutations", async () => {
  let mappingReads = 0;
  let pullReads = 0;
  let feedbackReads = 0;
  const result = await runNativeAutoMerge(mergeGroupEnv(), {
    listPullsForCommit: async () => {
      mappingReads += 1;
      return [pull()];
    },
    getPull: async () => {
      pullReads += 1;
      return pull();
    },
    waitForReviewReconciliation: async (_request, waitRuntime) => {
      assert.equal(typeof waitRuntime.readState, "function");
      return { status: "clear", fingerprint: "feedback-v1" };
    },
    readMergeGroupFeedbackState: async () => {
      feedbackReads += 1;
      return { status: "clear", fingerprint: "feedback-v1" };
    },
    getNativeState: async () => assert.fail("gate cannot read native state"),
    getEffectiveRules: async () => assert.fail("gate cannot read rules"),
    listCheckRuns: async () => assert.fail("gate cannot wait on itself"),
    enableAutoMerge: async () => assert.fail("gate cannot mutate"),
    disableAutoMerge: async () => assert.fail("gate cannot mutate"),
    dequeuePull: async () => assert.fail("gate cannot mutate"),
  });

  assert.deepEqual(result, {
    action: "merge-group-feedback-clear",
    head: SYNTHETIC_SHA,
    pulls: [108],
  });
  assert.equal(mappingReads, 2);
  assert.equal(pullReads, 2);
  assert.equal(feedbackReads, 1);
});

test("merge-group gate fails closed on association or feedback drift", async () => {
  let mappingReads = 0;
  await assert.rejects(
    runMergeGroupFeedbackGate(mergeGroupEnv(), {
      listPullsForCommit: async () => {
        mappingReads += 1;
        return [
          mappingReads === 1
            ? pull()
            : pull({ head: { ...pull().head, sha: "c".repeat(40) } }),
        ];
      },
      getPull: async (_repository, _number, _token, _runtime) =>
        mappingReads === 1
          ? pull()
          : pull({ head: { ...pull().head, sha: "c".repeat(40) } }),
      waitForReviewReconciliation: async () => ({
        status: "clear",
        fingerprint: "feedback-v1",
      }),
      readMergeGroupFeedbackState: async () => ({
        status: "clear",
        fingerprint: "feedback-v1",
      }),
    }),
    /association.*changed|identity/i,
  );

  await assert.rejects(
    runMergeGroupFeedbackGate(mergeGroupEnv(), {
      listPullsForCommit: async () => [pull()],
      getPull: async () => pull(),
      waitForReviewReconciliation: async () => ({
        status: "blocked",
        fingerprint: "finding",
      }),
    }),
    /feedback.*blocked/i,
  );

  for (const finalFeedback of [
    { status: "blocked", fingerprint: "finding" },
    { status: "clear", fingerprint: "feedback-v2" },
    {},
    null,
  ]) {
    await assert.rejects(
      runMergeGroupFeedbackGate(mergeGroupEnv(), {
        listPullsForCommit: async () => [pull()],
        getPull: async () => pull(),
        waitForReviewReconciliation: async () => ({
          status: "clear",
          fingerprint: "feedback-v1",
        }),
        readMergeGroupFeedbackState: async () => finalFeedback,
      }),
      /feedback changed/i,
    );
  }

  for (const changedPull of [
    pull({ number: 109 }),
    pull({ head: { ...pull().head, ref: "agent/changed-ref" } }),
  ]) {
    let associationReads = 0;
    await assert.rejects(
      runMergeGroupFeedbackGate(mergeGroupEnv(), {
        listPullsForCommit: async () => {
          associationReads += 1;
          return [associationReads === 1 ? pull() : changedPull];
        },
        getPull: async () => (associationReads === 1 ? pull() : changedPull),
        waitForReviewReconciliation: async () => ({
          status: "clear",
          fingerprint: "feedback-v1",
        }),
        readMergeGroupFeedbackState: async () => ({
          status: "clear",
          fingerprint: "feedback-v1",
        }),
      }),
      /association changed|identity changed/i,
    );
  }
});
