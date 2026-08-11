import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  githubGetMergeQueueSnapshot,
  githubGetRequestedReviewers,
  mergeGroupEventFromInputs,
  readMergeGroupFeedbackState,
  runMergeGroupFeedbackGate,
  runNativeAutoMerge,
} from "./main.mjs";

const REPOSITORY = "LCV-Ideas-Software/.github";
const SYNTHETIC_SHA = "a".repeat(40);
const BASE_SHA = "c".repeat(40);
const HEAD_SHA = "b".repeat(40);
const COPILOT_QUOTA_UNAVAILABLE_BODY =
  "Copilot was unable to review this pull request because the user who requested the review has reached their quota limit.";

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
    INPUT_MERGE_GROUP_BASE_SHA: BASE_SHA,
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

function mergeQueueSnapshot(overrides = {}) {
  return {
    identity: "queue-snapshot-v1",
    repositoryId: "R_test",
    queueId: "MQ_test",
    refId: "REF_test",
    configuration: {
      checkResponseTimeout: 3600,
      maximumEntriesToBuild: 1,
      maximumEntriesToMerge: 1,
      mergeMethod: "SQUASH",
      mergingStrategy: "ALLGREEN",
      minimumEntriesToMerge: 1,
      minimumEntriesToMergeWaitTime: 0,
    },
    entries: [
      {
        id: "MQE_test",
        state: "AWAITING_CHECKS",
        position: 1,
        mergeQueueId: "MQ_test",
        baseSha: BASE_SHA,
        syntheticHeadSha: SYNTHETIC_SHA,
        pull: {
          id: "PR_test",
          number: 108,
          state: "OPEN",
          isDraft: false,
          isInMergeQueue: true,
          headSha: HEAD_SHA,
          headRef: "agent/enterprise-governance-v2",
          baseRef: "main",
          headRepository: { id: "R_test", nameWithOwner: REPOSITORY },
          baseRepository: { id: "R_test", nameWithOwner: REPOSITORY },
          mergeQueueEntryId: "MQE_test",
        },
      },
    ],
    ...overrides,
  };
}

function mergeQueueSnapshotForPull(pullShape) {
  const snapshot = mergeQueueSnapshot();
  return {
    ...snapshot,
    entries: [
      {
        ...snapshot.entries[0],
        pull: {
          ...snapshot.entries[0].pull,
          id: `PR_${pullShape.number}`,
          number: pullShape.number,
          headSha: pullShape.head.sha,
          headRef: pullShape.head.ref,
        },
      },
    ],
  };
}

function rawMergeQueueEntry(overrides = {}) {
  return {
    id: "MQE_test",
    state: "AWAITING_CHECKS",
    position: 1,
    baseCommit: { oid: BASE_SHA },
    headCommit: { oid: SYNTHETIC_SHA },
    mergeQueue: { id: "MQ_test" },
    pullRequest: {
      id: "PR_test",
      number: 108,
      state: "OPEN",
      isDraft: false,
      isInMergeQueue: true,
      headRefOid: HEAD_SHA,
      headRefName: "agent/enterprise-governance-v2",
      baseRefName: "main",
      headRepository: { id: "R_test", nameWithOwner: REPOSITORY },
      baseRepository: { id: "R_test", nameWithOwner: REPOSITORY },
      mergeQueueEntry: { id: "MQE_test" },
    },
    ...overrides,
  };
}

function mergeQueuePage(
  nodes,
  { totalCount = nodes.length, hasNextPage = false, endCursor = null } = {},
) {
  return {
    data: {
      repository: {
        id: "R_test",
        nameWithOwner: REPOSITORY,
        ref: {
          id: "REF_test",
          name: "gh-readonly-queue/main/pr-108-deadbeef",
          prefix: "refs/heads/",
          target: { __typename: "Commit", oid: SYNTHETIC_SHA },
        },
        mergeQueue: {
          id: "MQ_test",
          configuration: mergeQueueSnapshot().configuration,
          entries: {
            totalCount,
            nodes,
            pageInfo: { hasNextPage, endCursor },
          },
        },
      },
    },
  };
}

async function snapshotFromPages(pages) {
  const remaining = [...pages];
  return githubGetMergeQueueSnapshot(
    REPOSITORY,
    { headSha: SYNTHETIC_SHA, headRef: mergeGroupEnv().GITHUB_REF },
    "github-token",
    {
      fetch: async () =>
        new Response(JSON.stringify(remaining.shift()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    },
  );
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

function copilotRun(overrides = {}) {
  return {
    id: 31336525189,
    name: "Running Copilot Code Review",
    path: "dynamic/agents/copilot-pull-request-reviewer",
    event: "dynamic",
    head_sha: HEAD_SHA,
    status: "completed",
    conclusion: "failure",
    created_at: "2026-08-09T18:00:00Z",
    run_attempt: 1,
    run_started_at: "2026-08-09T18:00:00Z",
    updated_at: "2026-08-09T18:00:01Z",
    actor: { id: 175728472, login: "Copilot", type: "Bot" },
    pull_requests: [
      {
        number: 108,
        head: { sha: HEAD_SHA },
        base: { ref: "main" },
      },
    ],
    ...overrides,
  };
}

function copilotReviewSnapshot(submittedAt) {
  return {
    ...emptyReviewSnapshot(),
    reviews: {
      nodes: [
        {
          id: "PRR_copilot",
          author: {
            __typename: "Bot",
            databaseId: 175728472,
            login: "copilot-pull-request-reviewer",
          },
          body: [
            "## Pull request overview",
            "",
            "Adds deterministic governance coverage.",
            "",
            "### Reviewed changes",
            "",
            "Copilot reviewed 1 out of 1 changed file in this pull request and generated no comments.",
          ].join("\n"),
          state: "COMMENTED",
          commit: { oid: HEAD_SHA },
          createdAt: submittedAt,
          submittedAt,
          updatedAt: submittedAt,
          isMinimized: false,
          minimizedReason: null,
        },
      ],
      pageInfo: { hasNextPage: false },
    },
  };
}

function copilotQuotaUnavailableSnapshot(submittedAt, overrides = {}) {
  const review = copilotReviewSnapshot(submittedAt).reviews.nodes[0];
  return {
    ...emptyReviewSnapshot(),
    ...overrides,
    reviews: {
      nodes: [
        {
          ...review,
          id: "PRR_copilot_quota_unavailable",
          body: COPILOT_QUOTA_UNAVAILABLE_BODY,
        },
      ],
      pageInfo: { hasNextPage: false },
    },
  };
}

test("merge-group inputs bind the exact synthetic event without a PAT", () => {
  assert.deepEqual(mergeGroupEventFromInputs(mergeGroupEnv()), {
    repository: REPOSITORY,
    action: "checks_requested",
    headSha: SYNTHETIC_SHA,
    baseSha: BASE_SHA,
    baseRef: "refs/heads/main",
    headRef: "refs/heads/gh-readonly-queue/main/pr-108-deadbeef",
  });

  for (const override of [
    { INPUT_EVENT_REPOSITORY: "attacker/fork" },
    { INPUT_EVENT_ACTION: "destroyed" },
    { INPUT_MERGE_GROUP_HEAD_SHA: "a".repeat(39) },
    { INPUT_MERGE_GROUP_BASE_SHA: "c".repeat(39) },
    { INPUT_MERGE_GROUP_BASE_SHA: SYNTHETIC_SHA },
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

test("merge-queue association paginates the official GraphQL connection", async () => {
  const calls = [];
  const otherPull = {
    ...rawMergeQueueEntry().pullRequest,
    id: "PR_other",
    number: 109,
    headRefOid: "d".repeat(40),
    headRefName: "agent/other",
    mergeQueueEntry: { id: "MQE_other" },
  };
  const pages = [
    mergeQueuePage(
      [
        rawMergeQueueEntry({
          id: "MQE_other",
          position: 2,
          baseCommit: { oid: "e".repeat(40) },
          headCommit: { oid: "f".repeat(40) },
          pullRequest: otherPull,
        }),
      ],
      { totalCount: 2, hasNextPage: true, endCursor: "cursor-1" },
    ),
    mergeQueuePage([rawMergeQueueEntry()], { totalCount: 2 }),
  ];
  const snapshot = await githubGetMergeQueueSnapshot(
    REPOSITORY,
    { headSha: SYNTHETIC_SHA, headRef: mergeGroupEnv().GITHUB_REF },
    "github-token",
    {
      fetch: async (url, options) => {
        calls.push({ url, options, body: JSON.parse(options.body) });
        return new Response(JSON.stringify(pages.shift()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  );

  assert.equal(snapshot.entries.length, 2);
  assert.equal(snapshot.entries[1].syntheticHeadSha, SYNTHETIC_SHA);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/graphql$/);
  assert.equal(calls[0].options.headers.authorization, "Bearer github-token");
  assert.equal(calls[0].body.variables.after, null);
  assert.equal(calls[1].body.variables.after, "cursor-1");
  assert.doesNotMatch(calls[0].body.query, /mutation/i);
});

test("merge-queue association preserves nullable metadata on unrelated entries", async () => {
  const nullableSibling = rawMergeQueueEntry({
    id: "MQE_null",
    state: "QUEUED",
    position: 2,
    baseCommit: null,
    headCommit: null,
    mergeQueue: null,
    pullRequest: null,
  });
  const partialSibling = rawMergeQueueEntry({
    id: "MQE_partial",
    state: "QUEUED",
    position: 3,
    baseCommit: { oid: "d".repeat(40) },
    headCommit: null,
    mergeQueue: null,
    pullRequest: {
      ...rawMergeQueueEntry().pullRequest,
      id: "PR_partial",
      number: 109,
      headRefOid: "e".repeat(40),
      headRefName: "agent/partial",
      headRepository: null,
      baseRepository: null,
      mergeQueueEntry: null,
    },
  });
  const snapshot = await snapshotFromPages([
    mergeQueuePage([nullableSibling, partialSibling], {
      totalCount: 3,
      hasNextPage: true,
      endCursor: "nullable-cursor",
    }),
    mergeQueuePage([rawMergeQueueEntry()], { totalCount: 3 }),
  ]);

  assert.equal(snapshot.entries.length, 3);
  assert.deepEqual(snapshot.entries[0], {
    id: "MQE_null",
    state: "QUEUED",
    position: 2,
    mergeQueueId: null,
    baseSha: null,
    syntheticHeadSha: null,
    pull: null,
  });
  assert.equal(snapshot.entries[1].baseSha, "d".repeat(40));
  assert.equal(snapshot.entries[1].syntheticHeadSha, null);
  assert.equal(snapshot.entries[1].pull.headRepository, null);
  assert.equal(snapshot.entries[1].pull.baseRepository, null);
  assert.equal(snapshot.entries[1].pull.mergeQueueEntryId, null);
  assert.equal(snapshot.entries[2].syntheticHeadSha, SYNTHETIC_SHA);
});

test("merge-queue association rejects ref, policy, and malformed entries", async () => {
  const wrongRef = mergeQueuePage([rawMergeQueueEntry()]);
  wrongRef.data.repository.ref.target.oid = "d".repeat(40);

  const wrongPolicy = mergeQueuePage([rawMergeQueueEntry()]);
  wrongPolicy.data.repository.mergeQueue.configuration.maximumEntriesToMerge = 2;

  const malformedRepository = mergeQueuePage([
    rawMergeQueueEntry({
      pullRequest: {
        ...rawMergeQueueEntry().pullRequest,
        headRepository: { id: "", nameWithOwner: REPOSITORY },
      },
    }),
  ]);

  const malformedEntries = [
    null,
    rawMergeQueueEntry({ baseCommit: undefined }),
    rawMergeQueueEntry({ headCommit: { oid: "not-a-sha" } }),
    rawMergeQueueEntry({ pullRequest: undefined }),
  ];

  for (const [payload, expected] of [
    [wrongRef, /malformed merge queue association/i],
    [wrongPolicy, /one-entry policy/i],
    [malformedRepository, /malformed merge queue entry/i],
  ]) {
    await assert.rejects(snapshotFromPages([payload]), expected);
  }
  for (const entry of malformedEntries) {
    await assert.rejects(
      snapshotFromPages([mergeQueuePage([entry])]),
      /malformed merge queue entry/i,
    );
  }
});

test("merge-queue association rejects pagination drift and duplicate identities", async () => {
  const firstPage = mergeQueuePage([rawMergeQueueEntry()], {
    totalCount: 2,
    hasNextPage: true,
    endCursor: "cursor-1",
  });
  const changedCount = mergeQueuePage(
    [
      rawMergeQueueEntry({
        id: "MQE_other",
        position: 2,
        baseCommit: { oid: "d".repeat(40) },
        headCommit: { oid: "e".repeat(40) },
        pullRequest: {
          ...rawMergeQueueEntry().pullRequest,
          id: "PR_other",
          number: 109,
          headRefOid: "f".repeat(40),
          headRefName: "agent/other",
          mergeQueueEntry: { id: "MQE_other" },
        },
      }),
    ],
    { totalCount: 3 },
  );
  await assert.rejects(
    snapshotFromPages([firstPage, changedCount]),
    /total count changed/i,
  );

  const repeatedCursorPage = mergeQueuePage(
    [
      rawMergeQueueEntry({
        id: "MQE_other",
        position: 2,
        baseCommit: { oid: "d".repeat(40) },
        headCommit: { oid: "e".repeat(40) },
        pullRequest: {
          ...rawMergeQueueEntry().pullRequest,
          id: "PR_other",
          number: 109,
          headRefOid: "f".repeat(40),
          headRefName: "agent/other",
          mergeQueueEntry: { id: "MQE_other" },
        },
      }),
    ],
    { totalCount: 2, hasNextPage: true, endCursor: "cursor-1" },
  );
  await assert.rejects(
    snapshotFromPages([firstPage, repeatedCursorPage]),
    /pagination cursor/i,
  );

  const duplicatePage = mergeQueuePage([rawMergeQueueEntry()], {
    totalCount: 2,
  });
  await assert.rejects(
    snapshotFromPages([firstPage, duplicatePage]),
    /duplicate merge queue entry/i,
  );

  await assert.rejects(
    snapshotFromPages([
      mergeQueuePage([rawMergeQueueEntry()], { totalCount: 2 }),
    ]),
    /ended before/i,
  );
});

test("merge-group mapping requires one exact awaiting synthetic entry", async () => {
  const exactEntry = mergeQueueSnapshot().entries[0];
  const variants = [
    mergeQueueSnapshot({ entries: [] }),
    mergeQueueSnapshot({
      entries: [
        exactEntry,
        {
          ...exactEntry,
          id: "MQE_duplicate",
          position: 2,
          pull: { ...exactEntry.pull, id: "PR_duplicate", number: 109 },
        },
      ],
    }),
    mergeQueueSnapshot({
      entries: [{ ...exactEntry, baseSha: "d".repeat(40) }],
    }),
    mergeQueueSnapshot({
      entries: [{ ...exactEntry, baseSha: null }],
    }),
    mergeQueueSnapshot({
      entries: [{ ...exactEntry, syntheticHeadSha: "d".repeat(40) }],
    }),
    mergeQueueSnapshot({
      entries: [{ ...exactEntry, syntheticHeadSha: null }],
    }),
    mergeQueueSnapshot({
      entries: [{ ...exactEntry, state: "QUEUED" }],
    }),
    mergeQueueSnapshot({
      entries: [{ ...exactEntry, position: 2 }],
    }),
  ];

  for (const snapshot of variants) {
    await assert.rejects(
      runMergeGroupFeedbackGate(mergeGroupEnv(), {
        getMergeQueueSnapshot: async () => snapshot,
        getPull: async () => pull(),
      }),
      /exactly one matching|base sha|awaiting checks/i,
    );
  }

  const mismatchedRef = "refs/heads/gh-readonly-queue/main/pr-999-deadbeef";
  await assert.rejects(
    runMergeGroupFeedbackGate(
      mergeGroupEnv({
        GITHUB_REF: mismatchedRef,
        INPUT_MERGE_GROUP_HEAD_REF: mismatchedRef,
      }),
      {
        getMergeQueueSnapshot: async () => mergeQueueSnapshot(),
        getPull: async () => pull(),
      },
    ),
    /queue ref and entry pull request disagree/i,
  );
});

test("merge-group mapping ignores nullable siblings but never a matching head", async () => {
  const exactEntry = mergeQueueSnapshot().entries[0];
  const nullableSibling = {
    id: "MQE_null",
    state: "QUEUED",
    position: 2,
    mergeQueueId: null,
    baseSha: null,
    syntheticHeadSha: null,
    pull: null,
  };
  const result = await runMergeGroupFeedbackGate(mergeGroupEnv(), {
    getMergeQueueSnapshot: async () =>
      mergeQueueSnapshot({ entries: [exactEntry, nullableSibling] }),
    getPull: async () => pull(),
    waitForReviewReconciliation: async () => ({
      status: "clear",
      fingerprint: "feedback-v1",
    }),
    readMergeGroupFeedbackState: async () => ({
      status: "clear",
      fingerprint: "feedback-v1",
    }),
  });
  assert.equal(result.action, "merge-group-feedback-clear");

  await assert.rejects(
    runMergeGroupFeedbackGate(mergeGroupEnv(), {
      getMergeQueueSnapshot: async () =>
        mergeQueueSnapshot({
          entries: [
            exactEntry,
            {
              ...nullableSibling,
              syntheticHeadSha: SYNTHETIC_SHA,
            },
          ],
        }),
      getPull: async () => pull(),
    }),
    /matching head|base sha/i,
  );

  await assert.rejects(
    runMergeGroupFeedbackGate(mergeGroupEnv(), {
      getMergeQueueSnapshot: async () =>
        mergeQueueSnapshot({ entries: [{ ...exactEntry, pull: null }] }),
      getPull: async () => pull(),
    }),
    /matching.*identity|pull request/i,
  );

  for (const changedEntry of [
    { ...exactEntry, mergeQueueId: null },
    {
      ...exactEntry,
      pull: { ...exactEntry.pull, state: "CLOSED" },
    },
    {
      ...exactEntry,
      pull: { ...exactEntry.pull, isDraft: true },
    },
    {
      ...exactEntry,
      pull: { ...exactEntry.pull, isInMergeQueue: false },
    },
    {
      ...exactEntry,
      pull: { ...exactEntry.pull, baseRef: "release" },
    },
    {
      ...exactEntry,
      pull: { ...exactEntry.pull, headRepository: null },
    },
    {
      ...exactEntry,
      pull: { ...exactEntry.pull, baseRepository: null },
    },
    {
      ...exactEntry,
      pull: { ...exactEntry.pull, mergeQueueEntryId: null },
    },
  ]) {
    await assert.rejects(
      runMergeGroupFeedbackGate(mergeGroupEnv(), {
        getMergeQueueSnapshot: async () =>
          mergeQueueSnapshot({ entries: [changedEntry] }),
        getPull: async () => pull(),
      }),
      /matching.*identity/i,
    );
  }
});

test("the live merge-group shape maps through the queue without commit association", async () => {
  const result = await runMergeGroupFeedbackGate(mergeGroupEnv(), {
    listPullsForCommit: async () =>
      assert.fail("commit association is not a merge-queue contract"),
    getMergeQueueSnapshot: async () => mergeQueueSnapshot(),
    getPull: async () => pull(),
    waitForReviewReconciliation: async () => ({
      status: "clear",
      fingerprint: "feedback-v1",
    }),
    readMergeGroupFeedbackState: async () => ({
      status: "clear",
      fingerprint: "feedback-v1",
    }),
  });

  assert.deepEqual(result, {
    action: "merge-group-feedback-clear",
    head: SYNTHETIC_SHA,
    pulls: [108],
  });
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
        getMergeQueueSnapshot: async () => mergeQueueSnapshot(),
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

  const failedWithoutFallbackReview = await readMergeGroupFeedbackState(
    {
      repository: REPOSITORY,
      number: 108,
      headSha: HEAD_SHA,
      token: "github-token",
    },
    {
      getRequestedReviewers: async () => ({ users: [], teams: [] }),
      listCopilotReviewRuns: async () => [copilotRun()],
      getReviewSnapshot: async () => emptyReviewSnapshot(),
    },
  );
  assert.equal(failedWithoutFallbackReview.status, "failure");

  const laterCanonicalFallbackReview = await readMergeGroupFeedbackState(
    {
      repository: REPOSITORY,
      number: 108,
      headSha: HEAD_SHA,
      token: "github-token",
    },
    {
      getRequestedReviewers: async () => ({ users: [], teams: [] }),
      listCopilotReviewRuns: async () => [copilotRun()],
      getReviewSnapshot: async () =>
        copilotReviewSnapshot("2026-08-09T18:00:02Z"),
    },
  );
  assert.equal(laterCanonicalFallbackReview.status, "clear");

  const laterQuotaUnavailableOutcome = await readMergeGroupFeedbackState(
    {
      repository: REPOSITORY,
      number: 108,
      headSha: HEAD_SHA,
      token: "github-token",
    },
    {
      getRequestedReviewers: async () => ({ users: [], teams: [] }),
      listCopilotReviewRuns: async () => [copilotRun()],
      getReviewSnapshot: async () =>
        copilotQuotaUnavailableSnapshot("2026-08-09T18:00:02Z"),
    },
  );
  assert.equal(laterQuotaUnavailableOutcome.status, "clear");
  assert.equal(
    laterQuotaUnavailableOutcome.latestExactHeadCopilotState,
    "unavailable",
  );
  assert.equal(
    laterQuotaUnavailableOutcome.latestExactHeadCopilotReviewAt,
    null,
  );

  const detachedRunFromClosedPull = copilotRun({
    id: 31336525000,
    created_at: "2026-08-09T17:59:00Z",
    run_started_at: "2026-08-09T17:59:00Z",
    updated_at: "2026-08-09T17:59:01Z",
    pull_requests: [],
  });
  const sharedHeadAcrossClosedAndCurrentPulls =
    await readMergeGroupFeedbackState(
      {
        repository: REPOSITORY,
        number: 108,
        headSha: HEAD_SHA,
        token: "github-token",
      },
      {
        getRequestedReviewers: async () => ({ users: [], teams: [] }),
        listCopilotReviewRuns: async () => [
          detachedRunFromClosedPull,
          copilotRun(),
        ],
        getReviewSnapshot: async () =>
          copilotQuotaUnavailableSnapshot("2026-08-09T18:00:02Z"),
      },
    );
  assert.equal(sharedHeadAcrossClosedAndCurrentPulls.status, "clear");

  const detachedRunCannotAuthorizeMergeGroupQuota =
    await readMergeGroupFeedbackState(
      {
        repository: REPOSITORY,
        number: 108,
        headSha: HEAD_SHA,
        token: "github-token",
      },
      {
        getRequestedReviewers: async () => ({ users: [], teams: [] }),
        listCopilotReviewRuns: async () => [detachedRunFromClosedPull],
        getReviewSnapshot: async () =>
          copilotQuotaUnavailableSnapshot("2026-08-09T18:00:02Z"),
      },
    );
  assert.equal(detachedRunCannotAuthorizeMergeGroupQuota.status, "failure");

  const unassociatedQuotaUnavailableOutcome = await readMergeGroupFeedbackState(
    {
      repository: REPOSITORY,
      number: 108,
      headSha: HEAD_SHA,
      token: "github-token",
    },
    {
      getRequestedReviewers: async () => ({ users: [], teams: [] }),
      listCopilotReviewRuns: async () => [],
      getReviewSnapshot: async () =>
        copilotQuotaUnavailableSnapshot("2026-08-09T18:00:02Z"),
    },
  );
  assert.equal(unassociatedQuotaUnavailableOutcome.status, "failure");

  const canonicalReviewAfterQuotaUnavailableOutcome =
    await readMergeGroupFeedbackState(
      {
        repository: REPOSITORY,
        number: 108,
        headSha: HEAD_SHA,
        token: "github-token",
      },
      {
        getRequestedReviewers: async () => ({ users: [], teams: [] }),
        listCopilotReviewRuns: async () => [],
        getReviewSnapshot: async () => {
          const quota = copilotQuotaUnavailableSnapshot("2026-08-09T18:00:02Z");
          return {
            ...quota,
            reviews: {
              nodes: [
                ...quota.reviews.nodes,
                copilotReviewSnapshot("2026-08-09T18:00:03Z").reviews.nodes[0],
              ],
              pageInfo: { hasNextPage: false },
            },
          };
        },
      },
    );
  assert.equal(canonicalReviewAfterQuotaUnavailableOutcome.status, "clear");
  assert.equal(
    canonicalReviewAfterQuotaUnavailableOutcome.latestExactHeadCopilotState,
    "reviewed",
  );

  const quotaUnavailableBeforeSuccessfulRerun =
    await readMergeGroupFeedbackState(
      {
        repository: REPOSITORY,
        number: 108,
        headSha: HEAD_SHA,
        token: "github-token",
      },
      {
        getRequestedReviewers: async () => ({ users: [], teams: [] }),
        listCopilotReviewRuns: async () => [
          copilotRun({
            run_attempt: 2,
            run_started_at: "2026-08-09T18:10:00Z",
            updated_at: "2026-08-09T18:10:01Z",
            conclusion: "success",
          }),
        ],
        getReviewSnapshot: async () =>
          copilotQuotaUnavailableSnapshot("2026-08-09T18:00:02Z"),
      },
    );
  assert.equal(quotaUnavailableBeforeSuccessfulRerun.status, "failure");

  const quotaUnavailableDoesNotEraseFindings =
    await readMergeGroupFeedbackState(
      {
        repository: REPOSITORY,
        number: 108,
        headSha: HEAD_SHA,
        token: "github-token",
      },
      {
        getRequestedReviewers: async () => ({ users: [], teams: [] }),
        listCopilotReviewRuns: async () => [copilotRun()],
        getReviewSnapshot: async () => {
          const quota = copilotQuotaUnavailableSnapshot("2026-08-09T18:00:02Z");
          return {
            ...quota,
            reviewThreads: {
              nodes: [
                {
                  id: "PRRT_existing_finding",
                  isResolved: false,
                  isOutdated: false,
                  isCollapsed: false,
                  comments: {
                    nodes: [
                      {
                        id: "PRRC_existing_finding",
                        author: {
                          __typename: "Bot",
                          databaseId: 175728472,
                          login: "copilot-pull-request-reviewer",
                        },
                        originalCommit: { oid: HEAD_SHA },
                        pullRequestReview: { id: "PRR_existing_finding" },
                        createdAt: "2026-08-09T17:59:59Z",
                        updatedAt: "2026-08-09T17:59:59Z",
                        isMinimized: false,
                        minimizedReason: null,
                      },
                    ],
                    pageInfo: { hasNextPage: false },
                  },
                },
              ],
              pageInfo: { hasNextPage: false },
            },
          };
        },
      },
    );
  assert.equal(quotaUnavailableDoesNotEraseFindings.status, "blocked");
  assert.deepEqual(
    quotaUnavailableDoesNotEraseFindings.unresolvedBotThreadIds,
    ["PRRT_existing_finding"],
  );

  const reviewOlderThanFailedRerun = await readMergeGroupFeedbackState(
    {
      repository: REPOSITORY,
      number: 108,
      headSha: HEAD_SHA,
      token: "github-token",
    },
    {
      getRequestedReviewers: async () => ({ users: [], teams: [] }),
      listCopilotReviewRuns: async () => [
        copilotRun({
          run_attempt: 2,
          run_started_at: "2026-08-09T18:10:00Z",
          updated_at: "2026-08-09T18:10:01Z",
        }),
      ],
      getReviewSnapshot: async () =>
        copilotReviewSnapshot("2026-08-09T18:05:00Z"),
    },
  );
  assert.equal(reviewOlderThanFailedRerun.status, "failure");
});

test("merge-group gate revalidates association and feedback without mutations", async () => {
  let mappingReads = 0;
  let pullReads = 0;
  let feedbackReads = 0;
  const result = await runNativeAutoMerge(mergeGroupEnv(), {
    getMergeQueueSnapshot: async () => {
      mappingReads += 1;
      return mergeQueueSnapshot();
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
      getMergeQueueSnapshot: async () => {
        mappingReads += 1;
        return mergeQueueSnapshot();
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
      getMergeQueueSnapshot: async () => mergeQueueSnapshot(),
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
        getMergeQueueSnapshot: async () => mergeQueueSnapshot(),
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
        getMergeQueueSnapshot: async () => {
          associationReads += 1;
          return mergeQueueSnapshotForPull(
            associationReads === 1 ? pull() : changedPull,
          );
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
      /association changed|identity changed|queue ref.*disagree/i,
    );
  }
});

test("a successful Copilot run with no reviewable files clears the merge-group gate", async () => {
  // Regression for #134 through the FULL reconciliation path, not assessReviewSnapshot
  // alone. The captured fixture is the verbatim body Copilot posted on
  // LCV-Ideas-Software/.github#133, so neither an invented shape nor a wording drift in
  // the implementation can keep this green while production breaks.
  const CAPTURED = readFileSync(
    new URL("./fixtures/copilot-no-reviewable-files.txt", import.meta.url),
    "utf8",
  );
  const VERDICT = "Copilot wasn't able to review any files in this pull request.";
  assert.ok(CAPTURED.startsWith(VERDICT));
  const snapshotWith = (body) => ({
    id: "PR_test",
    headRefOid: HEAD_SHA,
    comments: { nodes: [], pageInfo: { hasNextPage: false } },
    reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
    reviews: {
      nodes: [
        {
          id: "PRR_nf",
          author: { __typename: "Bot", databaseId: 175728472, login: "copilot-pull-request-reviewer" },
          body,
          state: "COMMENTED",
          commit: { oid: HEAD_SHA },
          createdAt: "2026-08-09T18:00:05Z",
          submittedAt: "2026-08-09T18:00:05Z",
          updatedAt: "2026-08-09T18:00:05Z",
          isMinimized: false,
          minimizedReason: null,
        },
      ],
      pageInfo: { hasNextPage: false },
    },
  });

  for (const body of [VERDICT, VERDICT + "\n\n\n\n\n", CAPTURED]) {
    const state = await readMergeGroupFeedbackState(
      { repository: REPOSITORY, number: 108, headSha: HEAD_SHA, token: "github-token" },
      {
        getRequestedReviewers: async () => ({ users: [], teams: [] }),
        listCopilotReviewRuns: async () => [copilotRun({ conclusion: "success" })],
        getReviewSnapshot: async () => snapshotWith(body),
      },
    );
    assert.equal(state.status, "clear");
    assert.match(state.fingerprint, /^[0-9a-f]{64}$/);
  }
});
