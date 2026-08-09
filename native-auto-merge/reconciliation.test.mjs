import test from "node:test";
import assert from "node:assert/strict";

import {
  assessRequiredCheckRuns,
  assessReviewSnapshot,
  waitForReviewReconciliation,
} from "./main.mjs";

const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const COPILOT_ID = 175728472;
const CODEX_ID = 199175422;
const REQUIRED_CHECKS = [
  { name: "Analyze actions", app_id: 15368 },
  { name: "Run zizmor", app_id: 15368 },
];

function checkRun(overrides = {}) {
  return {
    id: 1,
    name: "Analyze actions",
    head_sha: HEAD_SHA,
    status: "completed",
    conclusion: "success",
    completed_at: "2026-08-09T18:00:00Z",
    app: { id: 15368 },
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

test("required checks demand one exact successful GitHub Actions run per policy pair", () => {
  const successful = [checkRun(), checkRun({ id: 2, name: "Run zizmor" })];
  assert.deepEqual(
    assessRequiredCheckRuns(REQUIRED_CHECKS, successful, HEAD_SHA).status,
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
      assessRequiredCheckRuns(REQUIRED_CHECKS, runs, HEAD_SHA).status,
      expected,
    );
  }

  assert.throws(
    () =>
      assessRequiredCheckRuns(
        REQUIRED_CHECKS,
        [...successful, { ...successful[0], id: 3 }],
        HEAD_SHA,
      ),
    /duplicate required check run/i,
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
