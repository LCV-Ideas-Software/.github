import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  classifyChecks,
  evaluateExactHeadReviews,
  findAnyConnectorReviewThreads,
  findBlockingConnectorReviewThreads,
  hasExpectedDependabotCommitShape,
  hasRecentAutomationRebaseRequest,
  hasTrustedDependabotWorkflowProvenance,
  isAllowedDependabotPath,
  isTrustedPullRequest,
  parseRequiredChecks,
  runController,
} from "./main.mjs";

const requiredChecks = [
  { name: "CI", app_id: 15368 },
  { name: "CodeQL", app_id: 15368 },
];
let nextId = 1;
const successful = (name, overrides = {}) => ({
  id: nextId++,
  name,
  status: "completed",
  conclusion: "success",
  app: { id: 15368, slug: "github-actions" },
  details_url: "https://github.test/actions/runs/10",
  ...overrides,
});

test("parses a unique, non-empty required-check list", () => {
  assert.deepEqual(
    parseRequiredChecks(
      '[{"name":"CI","app_id":15368},{"name":"CodeQL","app_id":15368}]',
    ),
    requiredChecks,
  );
  assert.throws(() => parseRequiredChecks("[]"), /non-empty/);
  assert.throws(() => parseRequiredChecks('["CI","CodeQL"]'), /object/);
  assert.throws(
    () =>
      parseRequiredChecks(
        '[{"name":"CI","app_id":1},{"name":"CI","app_id":2}]',
      ),
    /duplicate/,
  );
  assert.throws(
    () => parseRequiredChecks('[{"name":"CI","app_id":"15368"}]'),
    /positive safe integer/,
  );
});

test("accepts only same-repository Dependabot PRs targeting main", () => {
  const pull = {
    state: "open",
    draft: false,
    user: { id: 49699333, login: "dependabot[bot]" },
    head: {
      ref: "dependabot/npm_and_yarn/example-1.2.3",
      sha: "a".repeat(40),
      repo: { full_name: "owner/repo" },
    },
    base: { ref: "main", repo: { full_name: "owner/repo" } },
  };
  assert.equal(isTrustedPullRequest(pull, "owner/repo"), true);
  assert.equal(
    isTrustedPullRequest(
      { ...pull, user: { login: "attacker" } },
      "owner/repo",
    ),
    false,
  );
  assert.equal(
    isTrustedPullRequest(
      { ...pull, user: { id: 999, login: "dependabot[bot]" } },
      "owner/repo",
    ),
    false,
  );
  assert.equal(
    isTrustedPullRequest(
      { ...pull, head: { ...pull.head, repo: { full_name: "fork/repo" } } },
      "owner/repo",
    ),
    false,
  );
});

test("requires the expected single-commit Dependabot shape at the exact head", () => {
  const head = "a".repeat(40);
  const commit = {
    sha: head,
    author: { id: 49699333, login: "dependabot[bot]" },
    committer: { id: 19864447, login: "web-flow" },
    commit: {
      author: { email: "49699333+dependabot[bot]@users.noreply.github.com" },
      verification: { verified: true },
    },
    parents: [{ sha: "b".repeat(40) }],
  };
  assert.equal(hasExpectedDependabotCommitShape([commit], head), true);
  assert.equal(
    hasExpectedDependabotCommitShape(
      [{ ...commit, sha: "c".repeat(40) }],
      head,
    ),
    false,
  );
  assert.equal(hasExpectedDependabotCommitShape([commit, commit], head), false);
  assert.equal(
    hasExpectedDependabotCommitShape(
      [{ ...commit, author: { login: "attacker" } }],
      head,
    ),
    false,
  );
  assert.equal(
    hasExpectedDependabotCommitShape(
      [
        {
          ...commit,
          author: { id: 999, login: "dependabot[bot]" },
        },
      ],
      head,
    ),
    false,
  );
});

test("requires a required Actions check run initially triggered by Dependabot", () => {
  const head = "a".repeat(40);
  const checks = [
    successful("CI", { check_suite: { id: 101 } }),
    successful("CodeQL", {
      app: { id: 57789, slug: "github-advanced-security" },
      check_suite: { id: 202 },
    }),
  ];
  const trustedRun = {
    check_suite_id: 101,
    head_sha: head,
    event: "pull_request",
    actor: { id: 49699333, login: "dependabot[bot]" },
    triggering_actor: { login: "operator" },
    run_attempt: 2,
  };
  assert.equal(
    hasTrustedDependabotWorkflowProvenance({
      checkRuns: checks,
      workflowRuns: [trustedRun],
      requiredChecks,
      headSha: head,
    }),
    true,
    "a manual re-run remains bound to the actor and SHA of the original event",
  );
  assert.equal(
    hasTrustedDependabotWorkflowProvenance({
      checkRuns: checks,
      workflowRuns: [
        {
          ...trustedRun,
          actor: { id: 123, login: "collaborator" },
          run_attempt: 1,
        },
      ],
      requiredChecks,
      headSha: head,
    }),
    false,
    "forged commit metadata must not substitute for a bot-triggered workflow run",
  );
  assert.equal(
    hasTrustedDependabotWorkflowProvenance({
      checkRuns: checks,
      workflowRuns: [{ ...trustedRun, head_sha: "b".repeat(40) }],
      requiredChecks,
      headSha: head,
    }),
    false,
  );
  for (const untrustedRun of [
    { ...trustedRun, check_suite_id: 999 },
    { ...trustedRun, event: "push" },
    { ...trustedRun, event: "workflow_dispatch" },
    { ...trustedRun, event: "pull_request_target" },
    {
      ...trustedRun,
      actor: { id: 49699333, login: "lookalike-dependabot" },
    },
    {
      ...trustedRun,
      actor: { id: 123, login: "dependabot[bot]" },
    },
  ]) {
    assert.equal(
      hasTrustedDependabotWorkflowProvenance({
        checkRuns: checks,
        workflowRuns: [untrustedRun],
        requiredChecks,
        headSha: head,
      }),
      false,
      JSON.stringify(untrustedRun),
    );
  }

  const twoActionsChecks = [
    successful("CI", { check_suite: { id: 101 } }),
    successful("CodeQL", { check_suite: { id: 202 } }),
  ];
  assert.equal(
    hasTrustedDependabotWorkflowProvenance({
      checkRuns: twoActionsChecks,
      workflowRuns: [trustedRun],
      requiredChecks,
      headSha: head,
    }),
    false,
    "every required Actions check suite must have trusted provenance",
  );
  assert.equal(
    hasTrustedDependabotWorkflowProvenance({
      checkRuns: checks.map((check) => ({
        ...check,
        app: { id: 999, slug: "external-security-service" },
      })),
      workflowRuns: [trustedRun],
      requiredChecks,
      headSha: head,
    }),
    false,
    "an all-external required-check set must fail closed",
  );
});

test("allows only dependency manifests, locks, pre-commit config and Actions workflows", () => {
  for (const path of [
    "package.json",
    "frontend/package-lock.json",
    "src-tauri/Cargo.toml",
    "Cargo.lock",
    "requirements-dev.txt",
    "pyproject.toml",
    ".pre-commit-config.yaml",
    ".github/workflows/ci.yml",
  ]) {
    assert.equal(isAllowedDependabotPath(path), true, path);
  }
  for (const path of [
    "src/index.ts",
    ".github/dependabot.yml",
    "README.md",
    "ci.yml",
  ]) {
    assert.equal(isAllowedDependabotPath(path), false, path);
  }
});

test("requires every named check to be attached and successful", () => {
  assert.equal(
    classifyChecks({ checkRuns: [successful("CI")], requiredChecks }).state,
    "pending",
  );
  assert.equal(
    classifyChecks({
      checkRuns: [
        successful("CI"),
        successful("CodeQL", { conclusion: "failure" }),
      ],
      requiredChecks,
    }).state,
    "failure",
  );
  assert.equal(
    classifyChecks({
      checkRuns: requiredChecks.map((check) =>
        successful(check.name, { app: { id: check.app_id } }),
      ),
      requiredChecks,
    }).state,
    "success",
  );
  assert.equal(
    classifyChecks({
      checkRuns: [
        successful("CI"),
        successful("CodeQL", {
          app: { id: 999, slug: "lookalike-security-producer" },
        }),
      ],
      requiredChecks,
    }).state,
    "pending",
    "a same-name check from the wrong immutable app id must not satisfy the gate",
  );
});

test("fails closed on attached optional failures", () => {
  const checkRuns = [
    ...requiredChecks.map((check) =>
      successful(check.name, { app: { id: check.app_id } }),
    ),
    successful("Security audit", { conclusion: "failure" }),
  ];
  assert.equal(classifyChecks({ checkRuns, requiredChecks }).state, "failure");
});

test("never ignores an attached check based on its run URL or suite", () => {
  const checkRuns = [
    ...requiredChecks.map((check) =>
      successful(check.name, { app: { id: check.app_id } }),
    ),
    successful("controller", {
      status: "in_progress",
      conclusion: null,
      check_suite: { id: 456 },
      details_url: "https://github.test/actions/runs/123/jobs/456",
    }),
  ];
  assert.equal(classifyChecks({ checkRuns, requiredChecks }).state, "pending");
  checkRuns[checkRuns.length - 1] = {
    ...checkRuns[checkRuns.length - 1],
    status: "completed",
    conclusion: "failure",
  };
  assert.equal(classifyChecks({ checkRuns, requiredChecks }).state, "failure");
  checkRuns[checkRuns.length - 1] = successful("external failure", {
    app: { id: 999, slug: "external" },
    conclusion: "failure",
    check_suite: { id: 456 },
    details_url: "https://github.test/actions/runs/1234/jobs/1",
  });
  assert.equal(classifyChecks({ checkRuns, requiredChecks }).state, "failure");
});

test("never hides an attached same-name failure", () => {
  const checkRuns = [
    successful("CI", { id: 1, conclusion: "failure" }),
    successful("CI", { id: 2 }),
    successful("CodeQL", { id: 3 }),
  ];
  assert.equal(classifyChecks({ checkRuns, requiredChecks }).state, "failure");
});

test("uses the latest legacy status context and requires combined success", () => {
  const checkRuns = requiredChecks.map((check) =>
    successful(check.name, { app: { id: check.app_id } }),
  );
  const statuses = [
    { id: 1, context: "legacy", state: "failure" },
    { id: 2, context: "legacy", state: "success" },
  ];
  assert.equal(
    classifyChecks({
      checkRuns,
      statuses,
      combinedStatusState: "success",
      requiredChecks,
    }).state,
    "success",
  );
  assert.equal(
    classifyChecks({
      checkRuns,
      statuses,
      combinedStatusState: "failure",
      requiredChecks,
    }).state,
    "failure",
  );
});

test("only the exact automation identity can suppress duplicate rebase requests", () => {
  const now = Date.parse("2026-07-22T12:00:00Z");
  const marker = "<!-- lcv-dependabot-rebase:head:base -->";
  const automationActor = { id: 123, login: "lcv-leo" };
  assert.equal(
    hasRecentAutomationRebaseRequest(
      [
        {
          author_association: "MEMBER",
          user: automationActor,
          body: `@dependabot rebase\n${marker}`,
          created_at: "2026-07-22T11:00:00Z",
        },
      ],
      marker,
      automationActor,
      now,
    ),
    true,
  );
  assert.equal(
    hasRecentAutomationRebaseRequest(
      [
        {
          user: { id: 999, login: "other-member" },
          body: marker,
          created_at: "2026-07-22T11:00:00Z",
        },
        {
          user: automationActor,
          body: marker,
          created_at: "2026-07-22T05:00:00Z",
        },
      ],
      marker,
      automationActor,
      now,
    ),
    false,
  );
});

test("the latest decisive review per reviewer preserves a changes-requested veto", () => {
  const head = "a".repeat(40);
  const oldHead = "b".repeat(40);
  const reviews = [
    { id: 1, user: { id: 10 }, commit_id: head, state: "APPROVED" },
    { id: 2, user: { id: 20 }, commit_id: head, state: "APPROVED" },
    { id: 3, user: { id: 10 }, commit_id: head, state: "CHANGES_REQUESTED" },
    {
      id: 4,
      user: { id: 30 },
      commit_id: oldHead,
      state: "CHANGES_REQUESTED",
    },
  ];
  assert.deepEqual(evaluateExactHeadReviews(reviews, head), {
    vetoed: true,
    approved: true,
  });
  reviews.push({
    id: 5,
    user: { id: 10 },
    commit_id: head,
    state: "DISMISSED",
  });
  reviews.push({
    id: 6,
    user: { id: 30 },
    commit_id: oldHead,
    state: "DISMISSED",
  });
  assert.deepEqual(evaluateExactHeadReviews(reviews, head), {
    vetoed: false,
    approved: true,
  });
  reviews.push({
    id: 7,
    user: { id: 20 },
    commit_id: oldHead,
    state: "APPROVED",
  });
  assert.deepEqual(evaluateExactHeadReviews(reviews, head), {
    vetoed: false,
    approved: false,
  });
});

test("unresolved connector inline feedback blocks automation even after becoming outdated", () => {
  const threads = [
    {
      isResolved: false,
      isOutdated: false,
      comments: {
        nodes: [
          {
            author: {
              databaseId: 199175422,
              login: "chatgpt-codex-connector",
            },
            url: "https://github.test/discussions/1",
          },
        ],
      },
    },
    {
      isResolved: true,
      isOutdated: false,
      comments: {
        nodes: [
          {
            author: {
              databaseId: 199175422,
              login: "chatgpt-codex-connector",
            },
            url: "https://github.test/discussions/2",
          },
        ],
      },
    },
    {
      isResolved: false,
      isOutdated: true,
      comments: {
        nodes: [
          {
            author: {
              databaseId: 199175422,
              login: "chatgpt-codex-connector[bot]",
            },
            url: "https://github.test/discussions/3",
          },
        ],
      },
    },
    {
      isResolved: false,
      isOutdated: false,
      comments: {
        nodes: [
          {
            author: {
              databaseId: 999,
              login: "chatgpt-codex-connector",
            },
            url: "https://github.test/discussions/lookalike",
          },
        ],
      },
    },
    {
      isResolved: false,
      isOutdated: false,
      comments: {
        nodes: [
          {
            author: { login: "human-reviewer" },
            url: "https://github.test/discussions/4",
          },
        ],
      },
    },
  ];

  assert.deepEqual(findBlockingConnectorReviewThreads(threads), [
    "https://github.test/discussions/1",
    "https://github.test/discussions/3",
  ]);
  assert.deepEqual(findAnyConnectorReviewThreads(threads), [
    "https://github.test/discussions/1",
    "https://github.test/discussions/2",
    "https://github.test/discussions/3",
  ]);
});

test("the controller can only create durable recovery refs and never rewrites or deletes refs", async () => {
  const source = await readFile(new URL("./main.mjs", import.meta.url), "utf8");
  const forbiddenRefWritePrimitives = [
    /\/update-branch/,
    /method:\s*["'](?:PATCH|DELETE)["']/,
    /\bgit\s+(?:push|update-ref|branch\s+-[fF])\b/i,
  ];
  for (const pattern of forbiddenRefWritePrimitives) {
    assert.doesNotMatch(source, pattern);
  }

  assert.match(source, /refs\/heads\/dependabot-recovery\/pr-/);
  assert.match(source, /method:\s*["']POST["'][\s\S]*\/git\/refs/);
});

test("approval is pinned to the validated head and late connector feedback blocks merge", async () => {
  const repository = "owner/repo";
  const head = "a".repeat(40);
  const main = "b".repeat(40);
  const pull = {
    number: 7,
    state: "open",
    draft: false,
    title: "Bump a dependency",
    user: { id: 49699333, login: "dependabot[bot]" },
    head: {
      ref: "dependabot/npm_and_yarn/example-1.2.3",
      sha: head,
      repo: { full_name: repository },
    },
    base: { ref: "main", repo: { full_name: repository } },
    mergeable: true,
    mergeable_state: "clean",
  };
  const commit = {
    sha: head,
    author: { id: 49699333, login: "dependabot[bot]" },
    committer: { id: 19864447, login: "web-flow" },
    commit: {
      author: { email: "49699333+dependabot[bot]@users.noreply.github.com" },
      message: "chore(deps): bump example from 1.2.2 to 1.2.3",
      verification: { verified: true },
    },
    parents: [{ sha: main }],
  };
  const checkFixtures = requiredChecks.map((check, index) =>
    successful(check.name, {
      app: { id: check.app_id },
      check_suite: { id: 900 + index },
    }),
  );
  const requests = [];
  let reviewReads = 0;
  let reviewThreadReads = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, pathname: url.pathname, body });

    let payload;
    if (url.pathname === "/repos/owner/repo/pulls" && method === "GET") {
      payload = [pull];
    } else if (
      url.pathname === "/repos/owner/repo/git/ref/heads/main" &&
      method === "GET"
    ) {
      payload = { object: { sha: main } };
    } else if (
      url.pathname === "/repos/owner/repo/pulls/7" &&
      method === "GET"
    ) {
      payload = pull;
    } else if (
      url.pathname === "/repos/owner/repo/pulls/7/commits" &&
      method === "GET"
    ) {
      payload = [commit];
    } else if (
      url.pathname === "/repos/owner/repo/pulls/7/files" &&
      method === "GET"
    ) {
      payload = [{ filename: "package.json" }];
    } else if (
      url.pathname.startsWith("/repos/owner/repo/compare/") &&
      method === "GET"
    ) {
      payload = { behind_by: 0 };
    } else if (
      url.pathname === `/repos/owner/repo/commits/${head}/check-runs` &&
      method === "GET"
    ) {
      payload = { check_runs: checkFixtures };
    } else if (
      url.pathname === `/repos/owner/repo/commits/${head}/statuses` &&
      method === "GET"
    ) {
      payload = [];
    } else if (
      url.pathname === `/repos/owner/repo/commits/${head}/status` &&
      method === "GET"
    ) {
      payload = { state: "success" };
    } else if (
      url.pathname === "/repos/owner/repo/actions/runs" &&
      method === "GET"
    ) {
      payload = {
        workflow_runs: checkFixtures.map((check) => ({
          check_suite_id: check.check_suite.id,
          head_sha: head,
          event: "pull_request",
          actor: { id: 49699333, login: "dependabot[bot]" },
          triggering_actor: { login: "dependabot[bot]" },
          run_attempt: 1,
        })),
      };
    } else if (url.pathname === "/graphql" && method === "POST") {
      reviewThreadReads += 1;
      assert.deepEqual(body?.variables, {
        owner: "owner",
        repo: "repo",
        number: 7,
        after: null,
      });
      payload = {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes:
                  reviewThreadReads === 1
                    ? []
                    : [
                        {
                          isResolved: false,
                          isOutdated: false,
                          comments: {
                            nodes: [
                              {
                                author: {
                                  databaseId: 199175422,
                                  login: "chatgpt-codex-connector",
                                },
                                url: "https://github.test/discussions/late",
                              },
                            ],
                          },
                        },
                      ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      };
    } else if (
      url.pathname === "/repos/owner/repo/pulls/7/reviews" &&
      method === "GET"
    ) {
      reviewReads += 1;
      payload =
        reviewReads === 1
          ? []
          : [
              {
                id: 99,
                user: { id: 42 },
                commit_id: head,
                state: "APPROVED",
              },
            ];
    } else if (
      url.pathname === "/repos/owner/repo/pulls/7/reviews" &&
      method === "POST"
    ) {
      payload = { id: 100 };
    } else if (
      url.pathname === "/repos/owner/repo/pulls/7/merge" &&
      method === "PUT"
    ) {
      payload = { merged: true };
    } else {
      throw new Error(`unexpected request: ${method} ${url.pathname}`);
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const result = await runController({
      GITHUB_REPOSITORY: repository,
      GITHUB_TOKEN: "github-token",
      LCV_AUTOMATION_TOKEN: "automation-token",
      REQUIRED_CHECKS_JSON: JSON.stringify(requiredChecks),
    });
    const approval = requests.find(
      (request) =>
        request.method === "POST" &&
        request.pathname === "/repos/owner/repo/pulls/7/reviews",
    );
    assert.equal(approval?.body?.commit_id, head);
    assert.equal(
      reviewReads,
      2,
      "reviews must be refreshed immediately before merge",
    );
    assert.equal(
      reviewThreadReads,
      2,
      "connector review threads must be refreshed immediately before merge",
    );
    assert.equal(
      requests.some(
        (request) =>
          request.method === "PUT" &&
          request.pathname === "/repos/owner/repo/pulls/7/merge",
      ),
      false,
    );
    assert.equal(result.action, "deferred");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function createControllerHarness(options = {}) {
  const repository = "owner/repo";
  const head = "a".repeat(40);
  const main = "b".repeat(40);
  const advancedMain = "c".repeat(40);
  const pull = {
    number: 7,
    state: "open",
    draft: false,
    title: "Bump a dependency",
    user: { id: 49699333, login: "dependabot[bot]" },
    head: {
      ref: "dependabot/npm_and_yarn/example-1.2.3",
      sha: head,
      repo: { full_name: repository },
    },
    base: { ref: "main", repo: { full_name: repository } },
    mergeable: true,
    mergeable_state: "clean",
  };
  const commit = {
    sha: head,
    author: { id: 49699333, login: "dependabot[bot]" },
    committer: { id: 19864447, login: "web-flow" },
    commit: {
      author: { email: "49699333+dependabot[bot]@users.noreply.github.com" },
      verification: { verified: true },
    },
    parents: [{ sha: main }],
  };
  const checks = requiredChecks.map((check, index) =>
    successful(check.name, {
      app: { id: check.app_id },
      check_suite: { id: 1200 + index },
    }),
  );
  const requests = [];
  let approvalCreated = false;
  let mainReads = 0;
  let compareReads = 0;
  let reviewReads = 0;
  let threadReads = 0;
  let pullReads = 0;
  let recoveryRefSha = options.existingRecoveryRefSha ?? null;
  let recoveryRefReads = 0;

  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const authorization = new Headers(init.headers).get("authorization");
    requests.push({
      method,
      pathname: url.pathname,
      search: url.search,
      body,
      authorization,
    });

    let payload;
    let status = 200;
    if (url.pathname === "/repos/owner/repo/pulls" && method === "GET") {
      payload = options.pullPageResponder
        ? options.pullPageResponder(Number(url.searchParams.get("page")))
        : [pull];
    } else if (
      url.pathname === "/repos/owner/repo/git/ref/heads/main" &&
      method === "GET"
    ) {
      mainReads += 1;
      payload = {
        object: {
          sha: options.mainShaForRead
            ? options.mainShaForRead(mainReads, { main, advancedMain })
            : main,
        },
      };
    } else if (
      url.pathname === "/repos/owner/repo/pulls/7" &&
      method === "GET"
    ) {
      pullReads += 1;
      payload = options.pullForRead
        ? options.pullForRead(pullReads, pull)
        : pull;
    } else if (
      url.pathname === "/repos/owner/repo/pulls/7/commits" &&
      method === "GET"
    ) {
      payload = options.commitsForRead
        ? options.commitsForRead(pullReads, { commit, head, main })
        : (options.commits ?? [commit]);
    } else if (
      url.pathname === "/repos/owner/repo/pulls/7/files" &&
      method === "GET"
    ) {
      payload = [{ filename: "package.json" }];
    } else if (
      url.pathname.startsWith("/repos/owner/repo/compare/") &&
      method === "GET"
    ) {
      compareReads += 1;
      payload = options.comparisonForRead
        ? options.comparisonForRead(compareReads)
        : { behind_by: options.behindBy ?? 0, status: "ahead" };
    } else if (
      url.pathname === `/repos/owner/repo/commits/${head}/check-runs` &&
      method === "GET"
    ) {
      payload = { check_runs: checks };
    } else if (
      url.pathname === `/repos/owner/repo/commits/${head}/statuses` &&
      method === "GET"
    ) {
      payload = [];
    } else if (
      url.pathname === `/repos/owner/repo/commits/${head}/status` &&
      method === "GET"
    ) {
      payload = { state: "success" };
    } else if (
      url.pathname === "/repos/owner/repo/actions/runs" &&
      method === "GET"
    ) {
      payload = {
        workflow_runs: checks.map((check) => ({
          check_suite_id: check.check_suite.id,
          head_sha: head,
          event: "pull_request",
          actor: { id: 49699333, login: "dependabot[bot]" },
          triggering_actor: { id: 42, login: "operator" },
          run_attempt: 2,
        })),
      };
    } else if (url.pathname === "/graphql" && method === "POST") {
      threadReads += 1;
      payload = options.graphqlResponseForRead
        ? options.graphqlResponseForRead(threadReads, body)
        : {
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          };
    } else if (
      url.pathname === "/repos/owner/repo/pulls/7/reviews" &&
      method === "GET"
    ) {
      reviewReads += 1;
      payload = options.reviewsForRead
        ? options.reviewsForRead(reviewReads, approvalCreated)
        : approvalCreated
          ? [
              {
                id: 100,
                user: { id: 42, login: "github-actions[bot]" },
                commit_id: head,
                state: "APPROVED",
              },
            ]
          : [];
    } else if (
      url.pathname === "/repos/owner/repo/pulls/7/reviews" &&
      method === "POST"
    ) {
      approvalCreated = true;
      payload = { id: 100 };
    } else if (url.pathname === "/user" && method === "GET") {
      payload = { id: 42, login: "operator" };
    } else if (
      url.pathname.startsWith(
        "/repos/owner/repo/git/ref/heads/dependabot-recovery",
      ) &&
      method === "GET"
    ) {
      recoveryRefReads += 1;
      if (recoveryRefSha === null) {
        status = 404;
        payload = { message: "Not Found" };
      } else {
        payload = {
          ref: options.recoveryRefName,
          object: { sha: recoveryRefSha },
        };
      }
    } else if (
      url.pathname === "/repos/owner/repo/git/refs" &&
      method === "POST"
    ) {
      recoveryRefSha = body?.sha ?? null;
      payload = { ref: body?.ref, object: { sha: recoveryRefSha } };
    } else if (
      url.pathname === "/repos/owner/repo/issues/7/comments" &&
      method === "GET"
    ) {
      payload = options.issueComments ?? [];
    } else if (
      url.pathname === "/repos/owner/repo/issues/7/comments" &&
      method === "POST"
    ) {
      payload = { id: 500 };
    } else if (
      url.pathname === "/repos/owner/repo/pulls/7/merge" &&
      method === "PUT"
    ) {
      payload = { merged: true, sha: "d".repeat(40) };
    } else {
      throw new Error(
        `unexpected request: ${method} ${url.pathname}${url.search}`,
      );
    }

    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  };

  return {
    repository,
    head,
    main,
    advancedMain,
    pull,
    commit,
    requests,
    fetch,
    state: {
      get mainReads() {
        return mainReads;
      },
      get compareReads() {
        return compareReads;
      },
      get reviewReads() {
        return reviewReads;
      },
      get threadReads() {
        return threadReads;
      },
      get pullReads() {
        return pullReads;
      },
      get recoveryRefReads() {
        return recoveryRefReads;
      },
      get recoveryRefSha() {
        return recoveryRefSha;
      },
    },
  };
}

function controllerEnvironment(repository = "owner/repo") {
  return {
    GITHUB_REPOSITORY: repository,
    GITHUB_TOKEN: "github-token",
    LCV_AUTOMATION_TOKEN: "automation-token",
    REQUIRED_CHECKS_JSON: JSON.stringify(requiredChecks),
    RECREATE_POLL_ATTEMPTS: "1",
    RECREATE_POLL_INTERVAL_MS: "0",
  };
}

function recoverableMergeChain(seed, overrides = {}) {
  const original = {
    ...seed.commit,
    sha: "d".repeat(40),
  };
  const merge = {
    sha: seed.head,
    author: { id: 42, login: "operator" },
    committer: { id: 19864447, login: "web-flow" },
    commit: {
      author: { email: "operator@users.noreply.github.com" },
      message: `Merge branch 'main' into ${seed.pull.head.ref}`,
      verification: { verified: true },
    },
    parents: [{ sha: original.sha }, { sha: seed.main }],
  };
  return [original, { ...merge, ...overrides }];
}

test("the happy path approves and squash-merges only the exact head with separated tokens", async () => {
  const harness = createControllerHarness();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.fetch;
  try {
    const result = await runController(
      controllerEnvironment(harness.repository),
    );
    assert.deepEqual(result, {
      action: "merged",
      pull: 7,
      head: harness.head,
    });

    const approval = harness.requests.find(
      (request) =>
        request.method === "POST" &&
        request.pathname === "/repos/owner/repo/pulls/7/reviews",
    );
    assert.equal(approval?.authorization, "Bearer github-token");
    assert.deepEqual(approval?.body, {
      commit_id: harness.head,
      event: "APPROVE",
      body: `Auto-approved Dependabot update after all configured checks passed for ${harness.head}.`,
    });

    const merge = harness.requests.find(
      (request) =>
        request.method === "PUT" &&
        request.pathname === "/repos/owner/repo/pulls/7/merge",
    );
    assert.equal(merge?.authorization, "Bearer automation-token");
    assert.deepEqual(merge?.body, {
      merge_method: "squash",
      sha: harness.head,
      commit_title: "Bump a dependency (#7)",
    });
    assert.ok(harness.state.mainReads >= 4);
    assert.equal(harness.state.reviewReads, 2);
    assert.equal(harness.state.threadReads, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a base advance at the final merge boundary defers an unchecked integration", async () => {
  const harness = createControllerHarness({
    mainShaForRead: (read, refs) => (read <= 4 ? refs.main : refs.advancedMain),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.fetch;
  try {
    const result = await runController(
      controllerEnvironment(harness.repository),
    );
    assert.equal(result.action, "deferred");
    assert.equal(result.pull, 7);
    assert.ok(harness.state.mainReads >= 5);
    assert.equal(harness.state.compareReads, 2);
    assert.equal(
      harness.requests.some(
        (request) =>
          request.method === "PUT" &&
          request.pathname === "/repos/owner/repo/pulls/7/merge",
      ),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a behind PR gets one identity-bound Dependabot rebase command", async () => {
  const harness = createControllerHarness({ behindBy: 2 });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.fetch;
  try {
    const result = await runController(
      controllerEnvironment(harness.repository),
    );
    assert.deepEqual(result, {
      action: "requested-rebase",
      pull: 7,
      head: harness.head,
    });
    const identityRead = harness.requests.find(
      (request) => request.method === "GET" && request.pathname === "/user",
    );
    assert.equal(identityRead?.authorization, "Bearer automation-token");
    const commentRead = harness.requests.find(
      (request) =>
        request.method === "GET" &&
        request.pathname === "/repos/owner/repo/issues/7/comments",
    );
    assert.equal(commentRead?.authorization, "Bearer github-token");
    const commentWrite = harness.requests.find(
      (request) =>
        request.method === "POST" &&
        request.pathname === "/repos/owner/repo/issues/7/comments",
    );
    assert.equal(commentWrite?.authorization, "Bearer automation-token");
    assert.deepEqual(commentWrite?.body, {
      body: `@dependabot rebase\n\n<!-- lcv-dependabot-rebase:${harness.head}:${harness.main} -->`,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("extra commits trigger an identity-bound Dependabot recreation without approval or merge", async () => {
  const seed = createControllerHarness();
  const harness = createControllerHarness({
    commits: recoverableMergeChain(seed),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.fetch;
  try {
    const result = await runController(
      controllerEnvironment(harness.repository),
    );
    assert.deepEqual(result, {
      action: "requested-recreate",
      pull: 7,
      head: harness.head,
    });
    const commentWrite = harness.requests.find(
      (request) =>
        request.method === "POST" &&
        request.pathname === "/repos/owner/repo/issues/7/comments",
    );
    assert.equal(commentWrite?.authorization, "Bearer automation-token");
    assert.deepEqual(commentWrite?.body, {
      body: `@dependabot recreate\n\n<!-- lcv-dependabot-refresh:recreate:${harness.head} -->`,
    });
    const backupCreate = harness.requests.find(
      (request) =>
        request.method === "POST" &&
        request.pathname === "/repos/owner/repo/git/refs",
    );
    assert.equal(backupCreate?.authorization, "Bearer automation-token");
    assert.deepEqual(backupCreate?.body, {
      ref: `refs/heads/dependabot-recovery/pr-7-${harness.head.slice(0, 12)}`,
      sha: harness.head,
    });
    assert.equal(harness.state.recoveryRefSha, harness.head);
    const backupIndex = harness.requests.indexOf(backupCreate);
    const commentIndex = harness.requests.indexOf(commentWrite);
    assert.ok(backupIndex >= 0 && backupIndex < commentIndex);
    assert.equal(
      harness.requests.some(
        (request) =>
          request.method === "POST" &&
          request.pathname === "/repos/owner/repo/pulls/7/reviews",
      ),
      false,
    );
    assert.equal(
      harness.requests.some(
        (request) =>
          request.method === "PUT" &&
          request.pathname === "/repos/owner/repo/pulls/7/merge",
      ),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a manual one-parent commit is never classified as a recoverable main-merge chain", async () => {
  const seed = createControllerHarness();
  const original = { ...seed.commit, sha: "d".repeat(40) };
  const harness = createControllerHarness({
    commits: [
      original,
      {
        ...original,
        sha: seed.head,
        author: { id: 42, login: "operator" },
        commit: {
          ...original.commit,
          author: { email: "operator@users.noreply.github.com" },
          message: "fix: preserve a necessary lockfile correction",
        },
        parents: [{ sha: original.sha }],
      },
    ],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.fetch;
  try {
    assert.deepEqual(
      await runController(controllerEnvironment(harness.repository)),
      { action: "none" },
    );
    assert.equal(harness.state.recoveryRefSha, null);
    assert.equal(
      harness.requests.some(
        (request) =>
          request.method === "POST" &&
          request.pathname === "/repos/owner/repo/issues/7/comments",
      ),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("recreation rejects a wrong merge actor, message, parent chain, or main ancestry", async (t) => {
  const seed = createControllerHarness();
  const cases = [
    {
      name: "wrong actor",
      commits: recoverableMergeChain(seed, {
        author: { id: 999, login: "lookalike" },
      }),
    },
    {
      name: "wrong message",
      commits: recoverableMergeChain(seed, {
        commit: {
          author: { email: "operator@users.noreply.github.com" },
          message: "merge main and preserve manual changes",
          verification: { verified: true },
        },
      }),
    },
    {
      name: "wrong first parent",
      commits: recoverableMergeChain(seed, {
        parents: [{ sha: "e".repeat(40) }, { sha: seed.main }],
      }),
    },
  ];
  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const harness = createControllerHarness({ commits: fixture.commits });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = harness.fetch;
      try {
        assert.deepEqual(
          await runController(controllerEnvironment(harness.repository)),
          { action: "none" },
        );
        assert.equal(harness.state.recoveryRefSha, null);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }

  await t.test("second parent is not an ancestor of current main", async () => {
    const chain = recoverableMergeChain(seed);
    chain[0] = {
      ...chain[0],
      parents: [{ sha: "1".repeat(40) }],
    };
    chain[1] = {
      ...chain[1],
      parents: [{ sha: chain[0].sha }, { sha: "2".repeat(40) }],
    };
    const harness = createControllerHarness({
      commits: chain,
      comparisonForRead: () => ({ status: "diverged", behind_by: 1 }),
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = harness.fetch;
    try {
      assert.deepEqual(
        await runController(controllerEnvironment(harness.repository)),
        { action: "none" },
      );
      assert.equal(harness.state.recoveryRefSha, null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("any historical connector thread blocks destructive recreation, even when resolved and outdated", async () => {
  const seed = createControllerHarness();
  const harness = createControllerHarness({
    commits: recoverableMergeChain(seed),
    graphqlResponseForRead: () => ({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  isResolved: true,
                  isOutdated: true,
                  comments: {
                    nodes: [
                      {
                        author: {
                          databaseId: 199175422,
                          login: "chatgpt-codex-connector",
                        },
                        url: "https://github.test/discussions/resolved",
                      },
                    ],
                    pageInfo: { hasNextPage: false },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    }),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.fetch;
  try {
    assert.deepEqual(
      await runController(controllerEnvironment(harness.repository)),
      { action: "none" },
    );
    assert.equal(harness.state.recoveryRefSha, null);
    assert.equal(
      harness.requests.some(
        (request) =>
          request.method === "POST" &&
          request.pathname === "/repos/owner/repo/issues/7/comments",
      ),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a conflicting durable recovery ref fails closed before recreation", async () => {
  const seed = createControllerHarness();
  const harness = createControllerHarness({
    commits: recoverableMergeChain(seed),
    existingRecoveryRefSha: "f".repeat(40),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.fetch;
  try {
    await assert.rejects(
      runController(controllerEnvironment(harness.repository)),
      /recovery ref.*does not preserve the expected head/i,
    );
    assert.equal(
      harness.requests.some(
        (request) =>
          request.method === "POST" &&
          request.pathname === "/repos/owner/repo/issues/7/comments",
      ),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an active review veto blocks recreation of a noncanonical branch", async () => {
  const seed = createControllerHarness();
  const harness = createControllerHarness({
    commits: recoverableMergeChain(seed),
    reviewsForRead: () => [
      {
        id: 99,
        user: { id: 7, login: "reviewer" },
        commit_id: seed.head,
        state: "CHANGES_REQUESTED",
      },
    ],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.fetch;
  try {
    assert.deepEqual(
      await runController(controllerEnvironment(harness.repository)),
      { action: "none" },
    );
    assert.equal(
      harness.requests.some(
        (request) =>
          request.method === "POST" &&
          request.pathname === "/repos/owner/repo/issues/7/comments",
      ),
      false,
    );
    assert.equal(harness.state.threadReads, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a recent exact-identity recreate marker suppresses duplicate recreation", async () => {
  const seed = createControllerHarness();
  const marker = `<!-- lcv-dependabot-refresh:recreate:${seed.head} -->`;
  const harness = createControllerHarness({
    commits: recoverableMergeChain(seed),
    issueComments: [
      {
        user: { id: 42, login: "operator" },
        body: `@dependabot recreate\n\n${marker}`,
        created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      },
    ],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.fetch;
  try {
    assert.deepEqual(
      await runController(controllerEnvironment(harness.repository)),
      { action: "none" },
    );
    assert.equal(
      harness.requests.some(
        (request) =>
          request.method === "POST" &&
          request.pathname === "/repos/owner/repo/issues/7/comments",
      ),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a recreate marker for the same head suppresses destructive retries indefinitely", async () => {
  const seed = createControllerHarness();
  const marker = `<!-- lcv-dependabot-refresh:recreate:${seed.head} -->`;
  const harness = createControllerHarness({
    commits: recoverableMergeChain(seed),
    issueComments: [
      {
        user: { id: 42, login: "operator" },
        body: `@dependabot recreate\n\n${marker}`,
        created_at: "2025-01-01T00:00:00Z",
      },
    ],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.fetch;
  try {
    assert.deepEqual(
      await runController(controllerEnvironment(harness.repository)),
      { action: "none" },
    );
    assert.equal(
      harness.requests.some(
        (request) =>
          request.method === "POST" &&
          request.pathname === "/repos/owner/repo/issues/7/comments",
      ),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a head change at the recreation boundary defers without overwriting it", async () => {
  const seed = createControllerHarness();
  const harness = createControllerHarness({
    commits: recoverableMergeChain(seed),
    pullForRead: (read, pull) =>
      read < 4
        ? pull
        : {
            ...pull,
            head: { ...pull.head, sha: "e".repeat(40) },
          },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.fetch;
  try {
    assert.deepEqual(
      await runController(controllerEnvironment(harness.repository)),
      {
        action: "deferred",
        pull: 7,
        head: seed.head,
      },
    );
    assert.ok(harness.state.pullReads >= 4);
    assert.equal(harness.state.recoveryRefSha, seed.head);
    assert.equal(
      harness.requests.some(
        (request) =>
          request.method === "POST" &&
          request.pathname === "/repos/owner/repo/issues/7/comments",
      ),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a recent exact-identity rebase marker suppresses duplicate commands", async () => {
  const head = "a".repeat(40);
  const main = "b".repeat(40);
  const marker = `<!-- lcv-dependabot-rebase:${head}:${main} -->`;
  const harness = createControllerHarness({
    behindBy: 1,
    issueComments: [
      {
        user: { id: 42, login: "operator" },
        body: `@dependabot rebase\n\n${marker}`,
        created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      },
    ],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.fetch;
  try {
    const result = await runController(
      controllerEnvironment(harness.repository),
    );
    assert.deepEqual(result, { action: "none" });
    assert.equal(
      harness.requests.some(
        (request) =>
          request.method === "POST" &&
          request.pathname === "/repos/owner/repo/issues/7/comments",
      ),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("REST pagination refuses an incomplete second page", async () => {
  const pages = [];
  const harness = createControllerHarness({
    pullPageResponder: (page) => {
      pages.push(page);
      return page === 1 ? Array.from({ length: 100 }, () => ({})) : {};
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.fetch;
  try {
    await assert.rejects(
      runController(controllerEnvironment(harness.repository)),
      /Unexpected paginated response/,
    );
    assert.deepEqual(pages, [1, 2]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GraphQL review-thread pagination fails closed before approval", async () => {
  const harness = createControllerHarness({
    graphqlResponseForRead: () => ({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  isResolved: false,
                  isOutdated: false,
                  comments: {
                    nodes: [],
                    pageInfo: { hasNextPage: true },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    }),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.fetch;
  try {
    await assert.rejects(
      runController(controllerEnvironment(harness.repository)),
      /more than 100 comments; refusing to merge without a complete audit/,
    );
    assert.equal(
      harness.requests.some(
        (request) =>
          request.method === "POST" &&
          request.pathname === "/repos/owner/repo/pulls/7/reviews",
      ),
      false,
    );
    assert.equal(
      harness.requests.some(
        (request) =>
          request.method === "PUT" &&
          request.pathname === "/repos/owner/repo/pulls/7/merge",
      ),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
