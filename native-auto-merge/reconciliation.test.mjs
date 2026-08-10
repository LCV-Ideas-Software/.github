import test from "node:test";
import assert from "node:assert/strict";

import {
  assessRequiredCheckRuns,
  assessReviewSnapshot,
  readReviewReconciliationState as readReviewReconciliationStateProduction,
  ReviewSnapshotChangedError,
  waitForReviewReconciliation,
} from "./main.mjs";

const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const COPILOT_ID = 175728472;
const CODEX_ID = 199175422;
const COPILOT_QUOTA_UNAVAILABLE_BODY =
  "Copilot was unable to review this pull request because the user who requested the review has reached their quota limit.";
const REQUIRED_CHECKS = [
  { name: "Analyze actions", app_id: 15368 },
  { name: "Run zizmor", app_id: 15368 },
];
const CHECK_CONTEXT = {
  repository: "LCV-Ideas-Software/.github",
  number: 99,
  headSha: HEAD_SHA,
};

function pullAssociation(overrides = {}) {
  return {
    number: CHECK_CONTEXT.number,
    url: `https://api.github.com/repos/${CHECK_CONTEXT.repository}/pulls/${CHECK_CONTEXT.number}`,
    head: {
      ref: "feature/test",
      sha: HEAD_SHA,
      repo: {
        url: `https://api.github.com/repos/${CHECK_CONTEXT.repository}`,
      },
    },
    base: {
      ref: "main",
      sha: "f".repeat(40),
      repo: {
        url: `https://api.github.com/repos/${CHECK_CONTEXT.repository}`,
      },
    },
    ...overrides,
  };
}

function checkRun(overrides = {}) {
  return {
    id: 1,
    name: "Analyze actions",
    head_sha: HEAD_SHA,
    status: "completed",
    conclusion: "success",
    completed_at: "2026-08-09T18:00:00Z",
    app: { id: 15368 },
    pull_requests: [pullAssociation()],
    ...overrides,
  };
}

function actor(databaseId, overrides = {}) {
  return {
    __typename: "Bot",
    databaseId,
    login:
      databaseId === COPILOT_ID
        ? "copilot-pull-request-reviewer"
        : "chatgpt-codex-connector",
    ...overrides,
  };
}

function review(overrides = {}) {
  return {
    id: "PRR_test",
    author: actor(COPILOT_ID),
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
    createdAt: "2026-08-09T18:00:00Z",
    submittedAt: "2026-08-09T18:00:01Z",
    updatedAt: "2026-08-09T18:00:01Z",
    isMinimized: false,
    minimizedReason: null,
    ...overrides,
  };
}

function codexReviewBody(reviewedCommit = HEAD_SHA.slice(0, 10)) {
  return [
    "### 💡 Codex Review",
    "",
    "Here are some automated review suggestions for this pull request.",
    "",
    `**Reviewed commit:** \`${reviewedCommit}\``,
    "",
    "<details> <summary>ℹ️ About Codex in GitHub</summary>",
    "<br/>",
    "",
    "[Your team has set up Codex to review pull requests in this repo](https://chatgpt.com/codex/cloud/settings/general). Reviews are triggered when you",
    "- Open a pull request for review",
    "- Mark a draft as ready",
    '- Comment "@codex review".',
    "",
    "If Codex has suggestions, it will comment; otherwise it will react with 👍.",
    "",
    'Codex can also answer questions or update the PR. Try commenting "@codex address that feedback".',
    "",
    "</details>",
  ].join("\n");
}

function issueComment(overrides = {}) {
  return {
    id: "IC_test",
    author: actor(CODEX_ID),
    body: [
      "Codex Review: Didn't find any major issues. Breezy!",
      "",
      `**Reviewed commit:** \`${HEAD_SHA.slice(0, 10)}\``,
      "",
      "<details><summary>About Codex</summary><p>Review complete.</p></details>",
    ].join("\n"),
    createdAt: "2026-08-09T18:00:03Z",
    updatedAt: "2026-08-09T18:00:03Z",
    isMinimized: false,
    minimizedReason: null,
    ...overrides,
  };
}

function thread(overrides = {}) {
  return {
    id: "PRRT_test",
    isResolved: false,
    isOutdated: false,
    isCollapsed: false,
    comments: {
      nodes: [
        {
          id: "PRRC_test",
          author: actor(CODEX_ID),
          pullRequestReview: { id: "PRR_codex" },
          originalCommit: { oid: HEAD_SHA },
          createdAt: "2026-08-09T18:00:02Z",
          updatedAt: "2026-08-09T18:00:02Z",
          isMinimized: false,
          minimizedReason: null,
        },
      ],
      pageInfo: { hasNextPage: false },
    },
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    id: "PR_test",
    headRefOid: HEAD_SHA,
    comments: {
      nodes: [],
      pageInfo: { hasNextPage: false },
    },
    reviews: {
      nodes: [],
      pageInfo: { hasNextPage: false },
    },
    reviewThreads: {
      nodes: [],
      pageInfo: { hasNextPage: false },
    },
    ...overrides,
  };
}

function readReviewReconciliationState(request, runtime = {}) {
  return readReviewReconciliationStateProduction(request, {
    getRequestedReviewers: async () => ({ users: [], teams: [] }),
    ...runtime,
  });
}

test("required checks aggregate exact-PR GitHub Actions suites without masking failures", () => {
  const successful = [checkRun(), checkRun({ id: 2, name: "Run zizmor" })];
  assert.deepEqual(
    assessRequiredCheckRuns(REQUIRED_CHECKS, successful, CHECK_CONTEXT).status,
    "success",
  );

  for (const [runs, expected] of [
    [successful.slice(0, 1), "pending"],
    [
      successful.map((run) => ({
        ...run,
        status: "in_progress",
        conclusion: null,
      })),
      "pending",
    ],
    [successful.map((run) => ({ ...run, conclusion: "failure" })), "failure"],
    [successful.map((run) => ({ ...run, app: { id: 57789 } })), "pending"],
    [
      successful.map((run) => ({ ...run, head_sha: "f".repeat(40) })),
      "pending",
    ],
  ]) {
    assert.equal(
      assessRequiredCheckRuns(REQUIRED_CHECKS, runs, CHECK_CONTEXT).status,
      expected,
    );
  }

  const repeatedAcrossLegitimateSuites = [
    checkRun({
      id: 3,
      pull_requests: [],
      completed_at: "2026-08-09T17:58:00Z",
    }),
    checkRun({ id: 4, completed_at: "2026-08-09T18:01:00Z" }),
    checkRun({ id: 5, completed_at: "2026-08-09T18:02:00Z" }),
    successful[1],
  ];
  assert.equal(
    assessRequiredCheckRuns(
      REQUIRED_CHECKS,
      repeatedAcrossLegitimateSuites,
      CHECK_CONTEXT,
    ).status,
    "success",
    "an exact-SHA dispatch without a PR association must not duplicate a PR gate",
  );
  assert.equal(
    assessRequiredCheckRuns(
      REQUIRED_CHECKS,
      repeatedAcrossLegitimateSuites,
      CHECK_CONTEXT,
    ).fingerprint,
    assessRequiredCheckRuns(
      REQUIRED_CHECKS,
      [...repeatedAcrossLegitimateSuites].reverse(),
      CHECK_CONTEXT,
    ).fingerprint,
    "check pagination order must not change the canonical fingerprint",
  );
  assert.equal(
    assessRequiredCheckRuns(
      REQUIRED_CHECKS,
      repeatedAcrossLegitimateSuites.map((run) =>
        run.id === 4 ? { ...run, conclusion: "failure" } : run,
      ),
      CHECK_CONTEXT,
    ).status,
    "failure",
    "a failed independent PR suite must not be hidden by a later success",
  );
  assert.equal(
    assessRequiredCheckRuns(
      REQUIRED_CHECKS,
      [
        ...repeatedAcrossLegitimateSuites,
        checkRun({
          id: 6,
          status: "in_progress",
          conclusion: null,
          completed_at: null,
        }),
      ],
      CHECK_CONTEXT,
    ).status,
    "pending",
    "an active duplicate must prevent an older success from arming the PR",
  );
  assert.equal(
    assessRequiredCheckRuns(
      REQUIRED_CHECKS,
      [
        checkRun({ id: 4, conclusion: "failure" }),
        checkRun({
          id: 6,
          status: "in_progress",
          conclusion: null,
          completed_at: null,
        }),
        successful[1],
      ],
      CHECK_CONTEXT,
    ).status,
    "failure",
    "a terminal failure must not be delayed by an active sibling suite",
  );
  assert.equal(
    assessRequiredCheckRuns(
      REQUIRED_CHECKS,
      [
        ...successful,
        checkRun({
          id: 7,
          conclusion: "skipped",
        }),
      ],
      CHECK_CONTEXT,
    ).status,
    "success",
    "a skipped sibling suite is accepted only when another exact suite succeeds",
  );
  assert.equal(
    assessRequiredCheckRuns(
      REQUIRED_CHECKS,
      [
        checkRun({ conclusion: "neutral" }),
        checkRun({ id: 7, conclusion: "skipped" }),
        successful[1],
      ],
      CHECK_CONTEXT,
    ).status,
    "failure",
    "every required pair still needs at least one exact success",
  );
  assert.equal(
    assessRequiredCheckRuns(
      REQUIRED_CHECKS,
      [
        checkRun({ pull_requests: [] }),
        checkRun({
          id: 7,
          pull_requests: [pullAssociation({ number: 100 })],
        }),
        successful[1],
      ],
      CHECK_CONTEXT,
    ).status,
    "pending",
    "unassociated and other-PR suites cannot satisfy the current PR",
  );
  assert.equal(
    assessRequiredCheckRuns(
      REQUIRED_CHECKS,
      [
        checkRun({
          status: "in_progress",
          conclusion: null,
          completed_at: null,
          pull_requests: [],
        }),
        checkRun({ id: 7 }),
        successful[1],
      ],
      CHECK_CONTEXT,
    ).status,
    "success",
    "an active unassociated pre-scan is outside the pull-request gate",
  );
  const otherRepositoryUrl =
    "https://api.github.com/repos/LCV-Ideas-Software/other";
  for (const association of [
    pullAssociation({
      url: `https://api.github.com/repos/${CHECK_CONTEXT.repository}/pulls/100`,
    }),
    pullAssociation({
      base: {
        ref: "release",
        sha: "f".repeat(40),
        repo: {
          url: `https://api.github.com/repos/${CHECK_CONTEXT.repository}`,
        },
      },
    }),
    pullAssociation({
      head: {
        ref: "feature/test",
        sha: HEAD_SHA,
        repo: { url: otherRepositoryUrl },
      },
    }),
    pullAssociation({
      base: {
        ref: "main",
        sha: "f".repeat(40),
        repo: { url: otherRepositoryUrl },
      },
    }),
  ]) {
    assert.equal(
      assessRequiredCheckRuns(
        REQUIRED_CHECKS,
        [checkRun({ pull_requests: [association] }), successful[1]],
        CHECK_CONTEXT,
      ).status,
      "pending",
      "foreign pull-request identity cannot satisfy the current PR",
    );
  }
  assert.throws(
    () =>
      assessRequiredCheckRuns(
        REQUIRED_CHECKS,
        [...successful, { ...successful[0] }],
        CHECK_CONTEXT,
      ),
    /malformed required check run/i,
  );
  assert.throws(
    () =>
      assessRequiredCheckRuns(
        REQUIRED_CHECKS,
        [
          { ...successful[0], status: "unknown", conclusion: null },
          successful[1],
        ],
        CHECK_CONTEXT,
      ),
    /malformed required check run/i,
  );
  assert.equal(
    assessRequiredCheckRuns(
      REQUIRED_CHECKS,
      [
        checkRun({
          pull_requests: [
            pullAssociation({
              head: {
                ref: "feature/test",
                sha: "e".repeat(40),
                repo: {
                  url: `https://api.github.com/repos/${CHECK_CONTEXT.repository}`,
                },
              },
            }),
          ],
        }),
        successful[1],
      ],
      CHECK_CONTEXT,
    ).status,
    "pending",
    "a stale association cannot satisfy the exact pull request",
  );
  assert.throws(
    () =>
      assessRequiredCheckRuns(
        REQUIRED_CHECKS,
        [checkRun({ pull_requests: [{ number: 99 }] }), successful[1]],
        CHECK_CONTEXT,
      ),
    /malformed required check run association/i,
  );
  assert.throws(
    () =>
      assessRequiredCheckRuns(
        REQUIRED_CHECKS,
        [
          checkRun({
            pull_requests: [pullAssociation(), { number: 99 }],
          }),
          successful[1],
        ],
        CHECK_CONTEXT,
      ),
    /malformed required check run association/i,
    "a valid first association cannot hide a later malformed entry",
  );
  assert.throws(
    () =>
      assessRequiredCheckRuns(
        REQUIRED_CHECKS,
        [
          checkRun({
            pull_requests: [pullAssociation(), pullAssociation({ url: "" })],
          }),
          successful[1],
        ],
        CHECK_CONTEXT,
      ),
    /malformed required check run association/i,
    "empty association identity fields are malformed",
  );
});

test("Copilot dynamic review completion is part of reconciliation readiness", async () => {
  const successfulChecks = [
    checkRun(),
    checkRun({ id: 2, name: "Run zizmor" }),
  ];
  const copilotRun = (overrides = {}) => ({
    id: 31336525189,
    name: "Running Copilot Code Review",
    path: "dynamic/agents/copilot-pull-request-reviewer",
    event: "dynamic",
    head_sha: HEAD_SHA,
    status: "in_progress",
    conclusion: null,
    created_at: "2026-08-09T18:00:00Z",
    run_attempt: 1,
    run_started_at: "2026-08-09T18:00:00Z",
    updated_at: "2026-08-09T18:00:01Z",
    actor: { id: COPILOT_ID, login: "Copilot", type: "Bot" },
    pull_requests: [
      {
        number: 99,
        head: { sha: HEAD_SHA },
        base: { ref: "main" },
      },
    ],
    ...overrides,
  });
  let reviewReads = 0;
  const request = {
    repository: "LCV-Ideas-Software/.github",
    number: 99,
    headSha: HEAD_SHA,
    requiredChecks: REQUIRED_CHECKS,
    token: "pat-token",
  };

  for (const malformedAttempt of [
    { run_attempt: 0 },
    { run_started_at: null },
    { run_started_at: "2026-08-09T17:59:59Z" },
    { run_started_at: "2026-08-09T18:00:02Z" },
  ]) {
    await assert.rejects(
      readReviewReconciliationState(request, {
        listCheckRuns: async () => successfulChecks,
        listCopilotReviewRuns: async () => [copilotRun(malformedAttempt)],
        getReviewSnapshot: async () =>
          assert.fail("malformed run attempts cannot reach review reads"),
      }),
      /malformed dynamic workflow run|timestamps are inconsistent/i,
    );
  }

  const outstandingRequestedReviewer = await readReviewReconciliationState(
    request,
    {
      listCheckRuns: async () => successfulChecks,
      getRequestedReviewers: async () => ({
        users: [
          {
            id: COPILOT_ID,
            login: "copilot-pull-request-reviewer[bot]",
            type: "Bot",
          },
        ],
        teams: [],
      }),
      listCopilotReviewRuns: async () => [],
      getReviewSnapshot: async () =>
        assert.fail("an outstanding request must block before review reads"),
    },
  );
  assert.equal(outstandingRequestedReviewer.status, "pending");

  const requestedButAbsent = await readReviewReconciliationState(
    { ...request, requireCopilotReviewRun: true },
    {
      listCheckRuns: async () => successfulChecks,
      listCopilotReviewRuns: async () => [],
      getReviewSnapshot: async () => {
        reviewReads += 1;
        return snapshot();
      },
    },
  );
  assert.equal(requestedButAbsent.status, "pending");
  assert.equal(reviewReads, 0);

  const freshReviewWithoutRun = await readReviewReconciliationState(
    {
      ...request,
      requireCopilotReviewRun: true,
      copilotReviewRequestedAt: "2026-08-09T18:00:05Z",
    },
    {
      listCheckRuns: async () => successfulChecks,
      listCopilotReviewRuns: async () => [],
      getReviewSnapshot: async () =>
        snapshot({
          reviews: {
            nodes: [
              review({
                createdAt: "2026-08-09T18:00:06Z",
                submittedAt: "2026-08-09T18:00:06Z",
                updatedAt: "2026-08-09T18:00:06Z",
              }),
            ],
            pageInfo: { hasNextPage: false },
          },
        }),
    },
  );
  assert.equal(freshReviewWithoutRun.status, "clear");

  const sameSecondReviewDoesNotCompleteRequest =
    await readReviewReconciliationState(
      {
        ...request,
        requireCopilotReviewRun: true,
        copilotReviewRequestedAt: "2026-08-09T18:00:05Z",
      },
      {
        listCheckRuns: async () => successfulChecks,
        listCopilotReviewRuns: async () => [],
        getReviewSnapshot: async () =>
          snapshot({
            reviews: {
              nodes: [
                review({
                  createdAt: "2026-08-09T18:00:04Z",
                  submittedAt: "2026-08-09T18:00:05Z",
                  updatedAt: "2026-08-09T18:00:05Z",
                }),
              ],
              pageInfo: { hasNextPage: false },
            },
          }),
      },
    );
  assert.equal(sameSecondReviewDoesNotCompleteRequest.status, "pending");

  const pendingReviewDoesNotCompleteRequest =
    await readReviewReconciliationState(
      {
        ...request,
        requireCopilotReviewRun: true,
        copilotReviewRequestedAt: "2026-08-09T18:00:05Z",
      },
      {
        listCheckRuns: async () => successfulChecks,
        listCopilotReviewRuns: async () => [],
        getReviewSnapshot: async () =>
          snapshot({
            reviews: {
              nodes: [
                review({
                  state: "PENDING",
                  createdAt: "2026-08-09T18:00:06Z",
                  submittedAt: null,
                  updatedAt: "2026-08-09T18:00:06Z",
                }),
              ],
              pageInfo: { hasNextPage: false },
            },
          }),
      },
    );
  assert.equal(pendingReviewDoesNotCompleteRequest.status, "pending");

  const freshReviewIsCanonicalWhenTheDynamicRunFails =
    await readReviewReconciliationState(
      {
        ...request,
        requireCopilotReviewRun: true,
        copilotReviewRequestedAt: "2026-08-09T18:00:05Z",
      },
      {
        listCheckRuns: async () => successfulChecks,
        listCopilotReviewRuns: async () => [
          copilotRun({
            status: "completed",
            conclusion: "failure",
            created_at: "2026-08-09T18:00:05Z",
            run_started_at: "2026-08-09T18:00:05Z",
            updated_at: "2026-08-09T18:00:06Z",
          }),
        ],
        getReviewSnapshot: async () =>
          snapshot({
            reviews: {
              nodes: [
                review({
                  createdAt: "2026-08-09T18:00:06Z",
                  submittedAt: "2026-08-09T18:00:06Z",
                  updatedAt: "2026-08-09T18:00:06Z",
                }),
              ],
              pageInfo: { hasNextPage: false },
            },
          }),
      },
    );
  assert.equal(freshReviewIsCanonicalWhenTheDynamicRunFails.status, "clear");

  const ordinaryWakeAcceptsTheLaterCanonicalFallbackReview =
    await readReviewReconciliationState(request, {
      listCheckRuns: async () => successfulChecks,
      listCopilotReviewRuns: async () => [
        copilotRun({
          status: "completed",
          conclusion: "failure",
          created_at: "2026-08-09T18:00:00Z",
          updated_at: "2026-08-09T18:00:01Z",
        }),
      ],
      getReviewSnapshot: async () =>
        snapshot({
          reviews: {
            nodes: [
              review({
                createdAt: "2026-08-09T18:00:01Z",
                submittedAt: "2026-08-09T18:00:02Z",
                updatedAt: "2026-08-09T18:00:02Z",
              }),
            ],
            pageInfo: { hasNextPage: false },
          },
        }),
    });
  assert.equal(
    ordinaryWakeAcceptsTheLaterCanonicalFallbackReview.status,
    "clear",
  );

  const ordinaryWakeRejectsAReviewOlderThanTheFailedDynamicRun =
    await readReviewReconciliationState(request, {
      listCheckRuns: async () => successfulChecks,
      listCopilotReviewRuns: async () => [
        copilotRun({
          status: "completed",
          conclusion: "failure",
          created_at: "2026-08-09T18:00:02Z",
          run_started_at: "2026-08-09T18:00:02Z",
          updated_at: "2026-08-09T18:00:03Z",
        }),
      ],
      getReviewSnapshot: async () =>
        snapshot({
          reviews: {
            nodes: [review()],
            pageInfo: { hasNextPage: false },
          },
        }),
    });
  assert.equal(
    ordinaryWakeRejectsAReviewOlderThanTheFailedDynamicRun.status,
    "failure",
  );

  const ordinaryWakeRejectsAReviewOlderThanTheFailedRerun =
    await readReviewReconciliationState(request, {
      listCheckRuns: async () => successfulChecks,
      listCopilotReviewRuns: async () => [
        copilotRun({
          status: "completed",
          conclusion: "failure",
          run_attempt: 2,
          run_started_at: "2026-08-09T18:10:00Z",
          updated_at: "2026-08-09T18:10:01Z",
        }),
      ],
      getReviewSnapshot: async () =>
        snapshot({
          reviews: {
            nodes: [
              review({
                createdAt: "2026-08-09T18:05:00Z",
                submittedAt: "2026-08-09T18:05:01Z",
                updatedAt: "2026-08-09T18:05:01Z",
              }),
            ],
            pageInfo: { hasNextPage: false },
          },
        }),
    });
  assert.equal(
    ordinaryWakeRejectsAReviewOlderThanTheFailedRerun.status,
    "failure",
  );

  const ordinaryWakeRejectsAReviewAtTheFailedRerunStart =
    await readReviewReconciliationState(request, {
      listCheckRuns: async () => successfulChecks,
      listCopilotReviewRuns: async () => [
        copilotRun({
          status: "completed",
          conclusion: "failure",
          run_attempt: 2,
          run_started_at: "2026-08-09T18:10:00Z",
          updated_at: "2026-08-09T18:10:01Z",
        }),
      ],
      getReviewSnapshot: async () =>
        snapshot({
          reviews: {
            nodes: [
              review({
                createdAt: "2026-08-09T18:09:59Z",
                submittedAt: "2026-08-09T18:10:00Z",
                updatedAt: "2026-08-09T18:10:00Z",
              }),
            ],
            pageInfo: { hasNextPage: false },
          },
        }),
    });
  assert.equal(
    ordinaryWakeRejectsAReviewAtTheFailedRerunStart.status,
    "failure",
  );

  const requestedRerunInProgressRemainsPending =
    await readReviewReconciliationState(
      {
        ...request,
        requireCopilotReviewRun: true,
        copilotReviewRequestedAt: "2026-08-09T18:10:00Z",
      },
      {
        listCheckRuns: async () => successfulChecks,
        listCopilotReviewRuns: async () => [
          copilotRun({
            run_attempt: 2,
            run_started_at: "2026-08-09T18:11:00Z",
            updated_at: "2026-08-09T18:11:01Z",
          }),
        ],
        getReviewSnapshot: async () =>
          snapshot({
            reviews: {
              nodes: [
                review({
                  createdAt: "2026-08-09T18:12:00Z",
                  submittedAt: "2026-08-09T18:12:01Z",
                  updatedAt: "2026-08-09T18:12:01Z",
                }),
              ],
              pageInfo: { hasNextPage: false },
            },
          }),
      },
    );
  assert.equal(requestedRerunInProgressRemainsPending.status, "pending");

  const staleActiveRunDoesNotBlockFreshReview =
    await readReviewReconciliationState(
      {
        ...request,
        requireCopilotReviewRun: true,
        copilotReviewRequestedAt: "2026-08-09T18:00:05Z",
      },
      {
        listCheckRuns: async () => successfulChecks,
        listCopilotReviewRuns: async () => [copilotRun()],
        getReviewSnapshot: async () =>
          snapshot({
            reviews: {
              nodes: [
                review({
                  createdAt: "2026-08-09T18:00:06Z",
                  submittedAt: "2026-08-09T18:00:06Z",
                  updatedAt: "2026-08-09T18:00:06Z",
                }),
              ],
              pageInfo: { hasNextPage: false },
            },
          }),
      },
    );
  assert.equal(staleActiveRunDoesNotBlockFreshReview.status, "clear");

  const staleReviewWithoutRun = await readReviewReconciliationState(
    {
      ...request,
      requireCopilotReviewRun: true,
      copilotReviewRequestedAt: "2026-08-09T18:00:05Z",
    },
    {
      listCheckRuns: async () => successfulChecks,
      listCopilotReviewRuns: async () => [],
      getReviewSnapshot: async () =>
        snapshot({
          reviews: {
            nodes: [review()],
            pageInfo: { hasNextPage: false },
          },
        }),
    },
  );
  assert.equal(staleReviewWithoutRun.status, "pending");

  const requestedAfterOldSuccess = await readReviewReconciliationState(
    {
      ...request,
      requireCopilotReviewRun: true,
      copilotReviewRequestedAt: "2026-08-09T18:00:05Z",
    },
    {
      listCheckRuns: async () => successfulChecks,
      listCopilotReviewRuns: async () => [
        copilotRun({ status: "completed", conclusion: "success" }),
      ],
      getReviewSnapshot: async () => {
        reviewReads += 1;
        return snapshot();
      },
    },
  );
  assert.equal(requestedAfterOldSuccess.status, "pending");
  assert.equal(reviewReads, 1);

  const requestedWithNewRun = await readReviewReconciliationState(
    {
      ...request,
      requireCopilotReviewRun: true,
      copilotReviewRequestedAt: "2026-08-09T18:00:05Z",
    },
    {
      listCheckRuns: async () => successfulChecks,
      listCopilotReviewRuns: async () => [
        copilotRun({ status: "completed", conclusion: "success" }),
        copilotRun({
          id: 31336525190,
          created_at: "2026-08-09T18:00:05Z",
          run_started_at: "2026-08-09T18:00:05Z",
          updated_at: "2026-08-09T18:00:06Z",
        }),
      ],
      getReviewSnapshot: async () => {
        reviewReads += 1;
        return snapshot();
      },
    },
  );
  assert.equal(requestedWithNewRun.status, "pending");
  assert.equal(reviewReads, 1);

  const requestedWithNewSuccess = await readReviewReconciliationState(
    {
      ...request,
      requireCopilotReviewRun: true,
      copilotReviewRequestedAt: "2026-08-09T18:00:05Z",
    },
    {
      listCheckRuns: async () => successfulChecks,
      listCopilotReviewRuns: async () => [
        copilotRun({ status: "completed", conclusion: "success" }),
        copilotRun({
          id: 31336525190,
          status: "completed",
          conclusion: "success",
          created_at: "2026-08-09T18:00:05Z",
          run_started_at: "2026-08-09T18:00:05Z",
          updated_at: "2026-08-09T18:00:06Z",
        }),
      ],
      getReviewSnapshot: async () => {
        reviewReads += 1;
        return snapshot();
      },
    },
  );
  assert.equal(requestedWithNewSuccess.status, "pending");
  assert.equal(reviewReads, 2);
  reviewReads = 0;

  const pending = await readReviewReconciliationState(request, {
    listCheckRuns: async () => successfulChecks,
    listCopilotReviewRuns: async () => [copilotRun()],
    getReviewSnapshot: async () => {
      reviewReads += 1;
      return snapshot();
    },
  });
  assert.equal(pending.status, "pending");
  assert.equal(reviewReads, 0);

  const outOfOrder = await readReviewReconciliationState(request, {
    listCheckRuns: async () => successfulChecks,
    listCopilotReviewRuns: async () => [
      copilotRun(),
      copilotRun({
        id: 31336525190,
        status: "completed",
        conclusion: "success",
        updated_at: "2026-08-09T18:00:02Z",
      }),
    ],
    getReviewSnapshot: async () => {
      reviewReads += 1;
      return snapshot();
    },
  });
  assert.equal(outOfOrder.status, "pending");
  assert.equal(reviewReads, 0);

  const chronologicalOutcome = await readReviewReconciliationState(request, {
    listCheckRuns: async () => successfulChecks,
    listCopilotReviewRuns: async () => [
      copilotRun({
        id: 31336525200,
        status: "completed",
        conclusion: "failure",
        created_at: "2026-08-09T18:00:00Z",
        updated_at: "2026-08-09T18:00:01Z",
      }),
      copilotRun({
        id: 31336525100,
        status: "completed",
        conclusion: "success",
        created_at: "2026-08-09T18:00:02Z",
        run_started_at: "2026-08-09T18:00:02Z",
        updated_at: "2026-08-09T18:00:03Z",
      }),
    ],
    getReviewSnapshot: async () => snapshot(),
  });
  assert.equal(chronologicalOutcome.status, "clear");

  const ambiguousLatestTimestamp = await readReviewReconciliationState(
    request,
    {
      listCheckRuns: async () => successfulChecks,
      listCopilotReviewRuns: async () => [
        copilotRun({
          id: 31336525100,
          status: "completed",
          conclusion: "success",
          updated_at: "2026-08-09T18:00:01Z",
        }),
        copilotRun({
          id: 31336525200,
          status: "completed",
          conclusion: "failure",
          updated_at: "2026-08-09T18:00:01Z",
        }),
      ],
      getReviewSnapshot: async () => snapshot(),
    },
  );
  assert.equal(ambiguousLatestTimestamp.status, "failure");

  const clear = await readReviewReconciliationState(request, {
    listCheckRuns: async () => successfulChecks,
    listCopilotReviewRuns: async () => [
      copilotRun({
        status: "completed",
        conclusion: "success",
        updated_at: "2026-08-09T18:00:02Z",
      }),
    ],
    getReviewSnapshot: async () => {
      reviewReads += 1;
      return snapshot();
    },
  });
  assert.equal(clear.status, "clear");
  assert.equal(reviewReads, 1);

  const failed = await readReviewReconciliationState(request, {
    listCheckRuns: async () => successfulChecks,
    listCopilotReviewRuns: async () => [
      copilotRun({
        status: "completed",
        conclusion: "failure",
        updated_at: "2026-08-09T18:00:02Z",
      }),
    ],
    getReviewSnapshot: async () => {
      reviewReads += 1;
      return snapshot();
    },
  });
  assert.equal(failed.status, "failure");
  assert.equal(reviewReads, 2);
});

test("the exact Copilot quota outcome is unavailable without becoming a review", async () => {
  const successfulChecks = [
    checkRun(),
    checkRun({ id: 2, name: "Run zizmor" }),
  ];
  const failedCopilotRun = {
    id: 31336525189,
    name: "Running Copilot Code Review",
    path: "dynamic/agents/copilot-pull-request-reviewer",
    event: "dynamic",
    head_sha: HEAD_SHA,
    status: "completed",
    conclusion: "failure",
    created_at: "2026-08-09T18:00:05Z",
    run_attempt: 1,
    run_started_at: "2026-08-09T18:00:05Z",
    updated_at: "2026-08-09T18:00:06Z",
    actor: { id: COPILOT_ID, login: "Copilot", type: "Bot" },
    pull_requests: [
      {
        number: 99,
        head: { sha: HEAD_SHA },
        base: { ref: "main" },
      },
    ],
  };
  const quotaReview = review({
    id: "PRR_quota_unavailable",
    body: COPILOT_QUOTA_UNAVAILABLE_BODY,
    createdAt: "2026-08-09T18:00:06Z",
    submittedAt: "2026-08-09T18:00:06Z",
    updatedAt: "2026-08-09T18:00:06Z",
  });
  const quotaSnapshot = snapshot({
    reviews: {
      nodes: [quotaReview],
      pageInfo: { hasNextPage: false },
    },
  });

  const assessed = assessReviewSnapshot(quotaSnapshot, HEAD_SHA);
  assert.equal(assessed.status, "clear");
  assert.equal(assessed.latestExactHeadCopilotState, "unavailable");
  assert.equal(assessed.latestExactHeadCopilotReviewAt, null);
  assert.equal(
    assessed.latestExactHeadCopilotUnavailableAt,
    "2026-08-09T18:00:06Z",
  );
  assert.deepEqual(assessed.copilotUnavailableReviewIds, [
    "PRR_quota_unavailable",
  ]);

  const request = {
    repository: "LCV-Ideas-Software/.github",
    number: 99,
    headSha: HEAD_SHA,
    requiredChecks: REQUIRED_CHECKS,
    token: "pat-token",
    requireCopilotReviewRun: true,
    copilotReviewRequestedAt: "2026-08-09T18:00:05Z",
  };
  const unavailable = await readReviewReconciliationState(request, {
    listCheckRuns: async () => successfulChecks,
    listCopilotReviewRuns: async () => [failedCopilotRun],
    getReviewSnapshot: async () => quotaSnapshot,
  });
  assert.equal(unavailable.status, "clear");
  assert.equal(unavailable.latestExactHeadCopilotState, "unavailable");
  assert.equal(unavailable.latestExactHeadCopilotReviewAt, null);
  assert.equal(
    unavailable.latestExactHeadCopilotUnavailableAt,
    "2026-08-09T18:00:06Z",
  );

  const staleUnavailable = await readReviewReconciliationState(request, {
    listCheckRuns: async () => successfulChecks,
    listCopilotReviewRuns: async () => [
      {
        ...failedCopilotRun,
        run_attempt: 2,
        run_started_at: "2026-08-09T18:10:00Z",
        updated_at: "2026-08-09T18:10:01Z",
      },
    ],
    getReviewSnapshot: async () => quotaSnapshot,
  });
  assert.equal(staleUnavailable.status, "failure");
});

test("the Copilot quota exception is exact, head-bound, and cumulative", () => {
  const quotaReview = review({
    id: "PRR_quota_unavailable",
    body: COPILOT_QUOTA_UNAVAILABLE_BODY,
    createdAt: "2026-08-09T18:00:04Z",
    submittedAt: "2026-08-09T18:00:04Z",
    updatedAt: "2026-08-09T18:00:04Z",
  });

  for (const body of [
    `${COPILOT_QUOTA_UNAVAILABLE_BODY}\n`,
    ` ${COPILOT_QUOTA_UNAVAILABLE_BODY}`,
    COPILOT_QUOTA_UNAVAILABLE_BODY.replace("quota limit.", "quota limit"),
    COPILOT_QUOTA_UNAVAILABLE_BODY.replace("their", "the"),
  ]) {
    assert.throws(
      () =>
        assessReviewSnapshot(
          snapshot({
            reviews: {
              nodes: [review({ body })],
              pageInfo: { hasNextPage: false },
            },
          }),
          HEAD_SHA,
        ),
      /Copilot review body.*malformed/i,
    );
  }

  const stale = assessReviewSnapshot(
    snapshot({
      reviews: {
        nodes: [
          {
            ...quotaReview,
            commit: { oid: "f".repeat(40) },
          },
        ],
        pageInfo: { hasNextPage: false },
      },
    }),
    HEAD_SHA,
  );
  assert.equal(stale.status, "clear");
  assert.equal(stale.latestExactHeadCopilotState, null);
  assert.equal(stale.latestExactHeadCopilotUnavailableAt, null);
  assert.deepEqual(stale.copilotUnavailableReviewIds, []);

  const suppressedBody = [
    "## Pull request overview",
    "",
    "Copilot reviewed 1 out of 1 changed file in this pull request and generated no new comments.",
    "",
    "<details>",
    "<summary>Suppressed comments (2)</summary>",
    "two earlier findings",
    "</details>",
  ].join("\n");
  const cumulative = assessReviewSnapshot(
    snapshot({
      reviews: {
        nodes: [
          review({
            id: "PRR_earlier_suppressed",
            body: suppressedBody,
            createdAt: "2026-08-09T18:00:01Z",
            submittedAt: "2026-08-09T18:00:01Z",
            updatedAt: "2026-08-09T18:00:01Z",
          }),
          quotaReview,
        ],
        pageInfo: { hasNextPage: false },
      },
      reviewThreads: {
        nodes: [thread({ id: "PRRT_earlier_finding" })],
        pageInfo: { hasNextPage: false },
      },
    }),
    HEAD_SHA,
  );
  assert.equal(cumulative.status, "blocked");
  assert.equal(cumulative.suppressedCommentCount, 2);
  assert.deepEqual(cumulative.unresolvedBotThreadIds, ["PRRT_earlier_finding"]);
  assert.equal(
    cumulative.latestExactHeadCopilotReviewAt,
    "2026-08-09T18:00:01Z",
  );
  assert.equal(cumulative.latestExactHeadCopilotState, "unavailable");
  assert.equal(
    cumulative.latestExactHeadCopilotUnavailableAt,
    "2026-08-09T18:00:04Z",
  );
});

test("current-head Codex issue comments are clean only under the exact known contract", () => {
  const clean = assessReviewSnapshot(
    snapshot({
      comments: {
        nodes: [issueComment()],
        pageInfo: { hasNextPage: false },
      },
    }),
    HEAD_SHA,
  );
  assert.equal(clean.status, "clear");

  const knownCleanVariant = assessReviewSnapshot(
    snapshot({
      comments: {
        nodes: [
          issueComment({
            body: [
              "Codex Review: Didn't find any major issues. Nice work!",
              "",
              `**Reviewed commit:** \`${HEAD_SHA.slice(0, 10)}\``,
            ].join("\n"),
          }),
        ],
        pageInfo: { hasNextPage: false },
      },
    }),
    HEAD_SHA,
  );
  assert.equal(knownCleanVariant.status, "clear");

  const finding = issueComment({
    body: [
      "Codex Review: Found a high-confidence issue.",
      "",
      `**Reviewed commit:** \`${HEAD_SHA.slice(0, 10)}\``,
    ].join("\n"),
  });
  const blocked = assessReviewSnapshot(
    snapshot({
      comments: {
        nodes: [finding],
        pageInfo: { hasNextPage: false },
      },
    }),
    HEAD_SHA,
  );
  assert.equal(blocked.status, "blocked");
  assert.deepEqual(blocked.blockingCodexCommentIds, ["IC_test"]);

  const ambiguousCleanSuffix = assessReviewSnapshot(
    snapshot({
      comments: {
        nodes: [
          issueComment({
            body: [
              "Codex Review: Didn't find any major issues. Hidden blocker remains.",
              "",
              `**Reviewed commit:** \`${HEAD_SHA.slice(0, 10)}\``,
            ].join("\n"),
          }),
        ],
        pageInfo: { hasNextPage: false },
      },
    }),
    HEAD_SHA,
  );
  assert.equal(ambiguousCleanSuffix.status, "blocked");
  assert.deepEqual(ambiguousCleanSuffix.blockingCodexCommentIds, ["IC_test"]);

  assert.throws(
    () =>
      assessReviewSnapshot(
        snapshot({
          comments: {
            nodes: [issueComment({ body: "Codex response format drift" })],
            pageInfo: { hasNextPage: false },
          },
        }),
        HEAD_SHA,
      ),
    /Codex.*malformed/i,
  );
});

test("current-head Codex reviews require the known body and an associated inline comment", () => {
  const codexReview = review({
    id: "PRR_codex",
    author: actor(CODEX_ID),
    body: codexReviewBody(),
  });
  const resolvedThread = thread({ isResolved: true });
  const clear = assessReviewSnapshot(
    snapshot({
      reviews: {
        nodes: [codexReview],
        pageInfo: { hasNextPage: false },
      },
      reviewThreads: {
        nodes: [resolvedThread],
        pageInfo: { hasNextPage: false },
      },
    }),
    HEAD_SHA,
  );
  assert.equal(clear.status, "clear");
  assert.deepEqual(clear.blockingCodexReviewIds, []);

  for (const body of [
    codexReviewBody(),
    "### 💡 Codex Review\n\nA standalone P1 blocking finding.",
  ]) {
    const blocked = assessReviewSnapshot(
      snapshot({
        reviews: {
          nodes: [review({ ...codexReview, body })],
          pageInfo: { hasNextPage: false },
        },
      }),
      HEAD_SHA,
    );
    assert.equal(blocked.status, "blocked");
    assert.deepEqual(blocked.blockingCodexReviewIds, ["PRR_codex"]);
  }

  const mismatchedCommit = assessReviewSnapshot(
    snapshot({
      reviews: {
        nodes: [
          review({
            ...codexReview,
            body: codexReviewBody("f".repeat(10)),
          }),
        ],
        pageInfo: { hasNextPage: false },
      },
      reviewThreads: {
        nodes: [resolvedThread],
        pageInfo: { hasNextPage: false },
      },
    }),
    HEAD_SHA,
  );
  assert.equal(mismatchedCommit.status, "blocked");
  assert.deepEqual(mismatchedCommit.blockingCodexReviewIds, ["PRR_codex"]);
});

test("current-head Copilot Suppressed comments block and malformed markers fail closed", () => {
  const suppressedBody = [
    "## Pull request overview",
    "",
    "Copilot reviewed 1 out of 1 changed file in this pull request and generated no new comments.",
    "",
    "<details>",
    "<summary>Suppressed comments (2)</summary>",
    "two findings",
    "</details>",
  ].join("\n");
  const blocked = assessReviewSnapshot(
    snapshot({
      reviews: {
        nodes: [review({ body: suppressedBody })],
        pageInfo: { hasNextPage: false },
      },
    }),
    HEAD_SHA,
  );
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.suppressedCommentCount, 2);

  const earlierSuppressed = assessReviewSnapshot(
    snapshot({
      reviews: {
        nodes: [
          review({
            id: "PRR_suppressed",
            body: suppressedBody,
            submittedAt: "2026-08-09T18:00:00Z",
            updatedAt: "2026-08-09T18:00:00Z",
          }),
          review({
            id: "PRR_later_clean",
            submittedAt: "2026-08-09T18:00:01Z",
            updatedAt: "2026-08-09T18:00:01Z",
          }),
        ],
        pageInfo: { hasNextPage: false },
      },
    }),
    HEAD_SHA,
  );
  assert.equal(earlierSuppressed.status, "blocked");
  assert.equal(earlierSuppressed.suppressedCommentCount, 2);

  const stale = assessReviewSnapshot(
    snapshot({
      reviews: {
        nodes: [
          review({ body: suppressedBody, commit: { oid: "f".repeat(40) } }),
        ],
        pageInfo: { hasNextPage: false },
      },
    }),
    HEAD_SHA,
  );
  assert.equal(stale.status, "clear");

  assert.throws(
    () =>
      assessReviewSnapshot(
        snapshot({
          reviews: {
            nodes: [
              review({
                body: [
                  "## Pull request overview",
                  "",
                  "Copilot reviewed 1 out of 1 changed file in this pull request and generated no comments.",
                  "",
                  "Suppressed comments: maybe",
                ].join("\n"),
              }),
            ],
            pageInfo: { hasNextPage: false },
          },
        }),
        HEAD_SHA,
      ),
    /suppressed comments.*malformed/i,
  );

  assert.throws(
    () =>
      assessReviewSnapshot(
        snapshot({
          reviews: {
            nodes: [
              review({
                body: "Copilot changed its format: two hidden high-confidence findings.",
              }),
            ],
            pageInfo: { hasNextPage: false },
          },
        }),
        HEAD_SHA,
      ),
    /Copilot review body.*malformed/i,
  );

  const overviewOnly = assessReviewSnapshot(
    snapshot({
      reviews: {
        nodes: [
          review({
            body: [
              "## Pull request overview",
              "",
              "Adds a regression test with no separately reviewable summary.",
              "",
              "---",
              "",
              '💡 <a href="/LCV-Ideas-Software/.github/new/main?filename=.github/skills/code-review/SKILL.md">Add a code-review agent skill</a> and <a href="https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/use-code-review#mcp-servers-and-agent-skills">learn more</a>.',
            ].join("\n"),
          }),
        ],
        pageInfo: { hasNextPage: false },
      },
    }),
    HEAD_SHA,
  );
  assert.equal(overviewOnly.status, "clear");
});

test("exact-head bot reviews are never clear unless their state is COMMENTED", () => {
  for (const state of [
    "PENDING",
    "APPROVED",
    "CHANGES_REQUESTED",
    "DISMISSED",
    "UNKNOWN",
  ]) {
    const assessed = assessReviewSnapshot(
      snapshot({
        reviews: {
          nodes: [
            review({
              state,
              body: state === "PENDING" ? "" : review().body,
              submittedAt: state === "PENDING" ? null : "2026-08-09T18:00:01Z",
            }),
          ],
          pageInfo: { hasNextPage: false },
        },
      }),
      HEAD_SHA,
    );
    if (state === "PENDING") {
      assert.equal(assessed.status, "pending", state);
      assert.deepEqual(assessed.pendingBotReviewStateIds, ["PRR_test"], state);
      assert.deepEqual(assessed.blockingBotReviewStateIds, [], state);
    } else {
      assert.equal(assessed.status, "blocked", state);
      assert.deepEqual(assessed.blockingBotReviewStateIds, ["PRR_test"], state);
      assert.deepEqual(assessed.pendingBotReviewStateIds, [], state);
    }
  }

  const pendingCodex = assessReviewSnapshot(
    snapshot({
      reviews: {
        nodes: [
          review({
            id: "PRR_codex_pending",
            author: actor(CODEX_ID),
            body: "",
            state: "PENDING",
            submittedAt: null,
          }),
        ],
        pageInfo: { hasNextPage: false },
      },
    }),
    HEAD_SHA,
  );
  assert.equal(pendingCodex.status, "pending");
  assert.deepEqual(pendingCodex.pendingBotReviewStateIds, [
    "PRR_codex_pending",
  ]);
  assert.deepEqual(pendingCodex.blockingCodexReviewIds, []);
});

test("unresolved bot threads block regardless of outdated or collapsed state", () => {
  for (const candidate of [
    thread(),
    thread({ isOutdated: true }),
    thread({ isCollapsed: true }),
  ]) {
    const result = assessReviewSnapshot(
      snapshot({
        reviewThreads: {
          nodes: [candidate],
          pageInfo: { hasNextPage: false },
        },
      }),
      HEAD_SHA,
    );
    assert.equal(result.status, "blocked");
    assert.deepEqual(result.unresolvedBotThreadIds, ["PRRT_test"]);
  }

  const resolved = assessReviewSnapshot(
    snapshot({
      reviewThreads: {
        nodes: [thread({ isResolved: true })],
        pageInfo: { hasNextPage: false },
      },
    }),
    HEAD_SHA,
  );
  assert.equal(resolved.status, "clear");

  const spoof = thread();
  spoof.comments.nodes[0].author = actor(CODEX_ID, {
    __typename: "User",
    databaseId: 1,
    login: "chatgpt-codex-connector",
  });
  assert.equal(
    assessReviewSnapshot(
      snapshot({
        reviewThreads: {
          nodes: [spoof],
          pageInfo: { hasNextPage: false },
        },
      }),
      HEAD_SHA,
    ).status,
    "clear",
  );
});

test("review collections and thread comments cannot be silently truncated", () => {
  assert.throws(
    () =>
      assessReviewSnapshot(
        snapshot({ comments: { nodes: [], pageInfo: { hasNextPage: true } } }),
        HEAD_SHA,
      ),
    /truncated.*comment/i,
  );
  assert.throws(
    () =>
      assessReviewSnapshot(
        snapshot({ reviews: { nodes: [], pageInfo: { hasNextPage: true } } }),
        HEAD_SHA,
      ),
    /truncated review/i,
  );
  assert.throws(
    () =>
      assessReviewSnapshot(
        snapshot({
          reviewThreads: {
            nodes: [
              thread({
                comments: { nodes: [], pageInfo: { hasNextPage: true } },
              }),
            ],
            pageInfo: { hasNextPage: false },
          },
        }),
        HEAD_SHA,
      ),
    /truncated review/i,
  );
});

test("a finding arriving inside the quiet window prevents a clear result", async () => {
  let now = 0;
  let reads = 0;
  const result = await waitForReviewReconciliation(
    {
      repository: "LCV-Ideas-Software/.github",
      number: 99,
      headSha: HEAD_SHA,
      requiredChecks: REQUIRED_CHECKS,
      token: "pat-token",
    },
    {
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      pollMilliseconds: 15,
      quietMilliseconds: 30,
      timeoutMilliseconds: 45,
      readState: async () => {
        reads += 1;
        return reads === 1
          ? { status: "clear", fingerprint: "before-review" }
          : { status: "blocked", fingerprint: "copilot-finding" };
      },
    },
  );

  assert.equal(result.status, "blocked");
  assert.equal(now, 45);
  assert.equal(reads, 4);
});

test("a slow reconciliation read does not count toward the quiet window", async () => {
  let now = 0;
  let reads = 0;
  const result = await waitForReviewReconciliation(
    {
      repository: "LCV-Ideas-Software/.github",
      number: 99,
      headSha: HEAD_SHA,
      requiredChecks: REQUIRED_CHECKS,
      token: "pat-token",
    },
    {
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      pollMilliseconds: 10,
      quietMilliseconds: 30,
      timeoutMilliseconds: 100,
      readState: async () => {
        reads += 1;
        if (reads === 1) now += 30;
        return { status: "clear", fingerprint: "stable-after-read" };
      },
    },
  );

  assert.deepEqual(result, {
    status: "clear",
    fingerprint: "stable-after-read",
  });
  assert.equal(reads, 4);
  assert.equal(now, 60);
});

test("a concurrently changing review snapshot restarts the bounded quiet window", async () => {
  let now = 0;
  let reads = 0;
  const result = await waitForReviewReconciliation(
    {
      repository: "LCV-Ideas-Software/.github",
      number: 99,
      headSha: HEAD_SHA,
      requiredChecks: REQUIRED_CHECKS,
      token: "pat-token",
    },
    {
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      pollMilliseconds: 15,
      quietMilliseconds: 30,
      timeoutMilliseconds: 100,
      readState: async () => {
        reads += 1;
        if (reads === 1) {
          throw new ReviewSnapshotChangedError(
            "review changed during pagination",
          );
        }
        return { status: "clear", fingerprint: "stable-after-retry" };
      },
    },
  );

  assert.deepEqual(result, {
    status: "clear",
    fingerprint: "stable-after-retry",
  });
  assert.equal(reads, 4);
  assert.equal(now, 45);
});

test("quiet-window reconciliation is bounded, resets on drift, and keeps bot absence neutral", async () => {
  let now = 0;
  let reads = 0;
  const result = await waitForReviewReconciliation(
    {
      repository: "LCV-Ideas-Software/.github",
      number: 99,
      headSha: HEAD_SHA,
      requiredChecks: REQUIRED_CHECKS,
      token: "pat-token",
    },
    {
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      pollMilliseconds: 15,
      quietMilliseconds: 30,
      timeoutMilliseconds: 100,
      readState: async () => {
        reads += 1;
        return {
          status: "clear",
          fingerprint: reads === 1 ? "first" : "stable",
        };
      },
    },
  );

  assert.deepEqual(result, { status: "clear", fingerprint: "stable" });
  assert.equal(now, 45);
  assert.equal(reads, 4);

  await assert.rejects(
    waitForReviewReconciliation(
      {
        repository: "LCV-Ideas-Software/.github",
        number: 99,
        headSha: HEAD_SHA,
        requiredChecks: REQUIRED_CHECKS,
        token: "pat-token",
      },
      {
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
        pollMilliseconds: 15,
        quietMilliseconds: 30,
        timeoutMilliseconds: 20,
        readState: async () => ({ status: "pending", fingerprint: "pending" }),
      },
    ),
    /timed out/i,
  );
});
