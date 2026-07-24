import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  classifyChecks,
  evaluateExactHeadReviews,
  findBlockingConnectorReviewThreads,
  hasExpectedDependabotCommitShape,
  hasRecentAutomationRebaseRequest,
  hasTrustedDependabotAlreadyCurrentResponse,
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
      [
        {
          ...commit,
          committer: { id: 49699333, login: "dependabot[bot]" },
        },
      ],
      head,
    ),
    true,
    "Dependabot may be the authenticated committer of its own signed update",
  );
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
  assert.equal(
    hasExpectedDependabotCommitShape(
      [{ ...commit, parents: [{ sha: "not-a-commit-sha" }] }],
      head,
    ),
    false,
  );
  for (const committer of [
    { id: 49699333, login: "web-flow" },
    { id: 19864447, login: "dependabot[bot]" },
    { id: 1, login: "web-flow" },
    { id: 49699333, login: "attacker" },
  ]) {
    assert.equal(
      hasExpectedDependabotCommitShape([{ ...commit, committer }], head),
      false,
      `mismatched or untrusted committer must fail closed: ${JSON.stringify(committer)}`,
    );
  }
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
    "socketsecurity-requirements.in",
    "socketsecurity-requirements.txt",
    "python/socketsecurity-requirements.in",
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
    "socketsecurity-requirements-dev.txt",
    "attacker-socketsecurity-requirements.txt",
    "socketsecurity-requirements.in.js",
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
          body: `@dependabot rebase\n\n${marker}`,
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
        {
          user: automationActor,
          body: `prefix ${marker} suffix`,
          created_at: "2026-07-22T11:00:00Z",
        },
      ],
      marker,
      automationActor,
      now,
    ),
    false,
  );
});

test("only an exact later Dependabot no-op response unlocks guarded recovery", () => {
  const now = Date.parse("2026-07-24T12:00:00Z");
  const request = {
    id: 100,
    user: { id: 42, login: "operator" },
    body: "@dependabot rebase",
    created_at: "2026-07-24T11:00:00Z",
  };
  const canonicalResponse = {
    id: 101,
    user: { id: 49699333, login: "dependabot[bot]" },
    body: "Looks like this PR is already up-to-date with main! If you'd still like to recreate it from scratch, overwriting any edits, you can request `@dependabot recreate`.",
    created_at: "2026-07-24T11:00:03Z",
  };
  assert.equal(
    hasTrustedDependabotAlreadyCurrentResponse(
      [request, canonicalResponse],
      request,
      now,
    ),
    true,
  );
  for (const untrustedResponse of [
    {
      ...canonicalResponse,
      user: { id: 999, login: "dependabot[bot]" },
    },
    {
      ...canonicalResponse,
      user: { id: 49699333, login: "other-bot[bot]" },
    },
    {
      ...canonicalResponse,
      body: canonicalResponse.body.replace("main!", "main."),
    },
    { ...canonicalResponse, id: 99 },
    { ...canonicalResponse, created_at: "2026-07-24T10:59:59Z" },
    { ...canonicalResponse, created_at: "2026-07-24T12:00:01Z" },
  ]) {
    assert.equal(
      hasTrustedDependabotAlreadyCurrentResponse(
        [request, untrustedResponse],
        request,
        now,
      ),
      false,
    );
  }
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
});

test("the controller has no branch-update or destructive-recreation primitive", async () => {
  const source = await readFile(new URL("./main.mjs", import.meta.url), "utf8");
  const forbiddenMutationPrimitives = [
    /\/update-branch/,
    /body:\s*["'`]@dependabot\s+recreate/i,
    /\/git\/refs\b/,
    /method:\s*["'](?:PATCH|DELETE)["']/,
    /\bgit\s+(?:push|update-ref|branch\s+-[fF])\b/i,
  ];
  for (const pattern of forbiddenMutationPrimitives) {
    assert.doesNotMatch(source, pattern);
  }
});

test("dedicated controller CI enforces syntax and tests with pinned actions and write-all", async () => {
  const workflow = await readFile(
    new URL(
      "../.github/workflows/dependabot-controller-ci.yml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(workflow, /^name: Dependabot Controller CI$/m);
  assert.match(workflow, /^\s+pull_request:$/m);
  assert.match(workflow, /^\s+push:$/m);
  assert.equal(
    [...workflow.matchAll(/^\s*permissions:\s*write-all$/gm)].length,
    2,
  );
  assert.match(workflow, /node --check dependabot-automerge\/main\.mjs/);
  assert.match(workflow, /node --test dependabot-automerge\/main\.test\.mjs/);
  const actionReferences = [...workflow.matchAll(/^\s*uses:\s*(\S+)/gm)].map(
    (match) => match[1],
  );
  assert.ok(actionReferences.length > 0);
  for (const reference of actionReferences) {
    assert.match(reference, /@[0-9a-f]{40}$/i);
  }
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
  const pullSummary = {
    number: pull.number,
    state: pull.state,
    draft: pull.draft,
    title: pull.title,
    user: pull.user,
    head: pull.head,
    base: pull.base,
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
      payload = [pullSummary];
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
      payload = {
        behind_by: 0,
        status: "ahead",
        merge_base_commit: { sha: main },
      };
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
  const pullSummary = {
    number: pull.number,
    state: pull.state,
    draft: pull.draft,
    title: pull.title,
    user: pull.user,
    head: pull.head,
    base: pull.base,
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
        : [pullSummary];
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
      payload = options.files ?? [{ filename: "package.json" }];
    } else if (
      url.pathname.startsWith("/repos/owner/repo/compare/") &&
      method === "GET"
    ) {
      compareReads += 1;
      payload = options.comparisonForRead
        ? options.comparisonForRead(compareReads, { head, main })
        : {
            behind_by: options.behindBy ?? 0,
            status: options.behindBy > 0 ? "diverged" : "ahead",
            merge_base_commit: { sha: main },
          };
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
    pullSummary,
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
    },
  };
}

function controllerEnvironment(repository = "owner/repo") {
  return {
    GITHUB_REPOSITORY: repository,
    GITHUB_TOKEN: "github-token",
    LCV_AUTOMATION_TOKEN: "automation-token",
    REQUIRED_CHECKS_JSON: JSON.stringify(requiredChecks),
  };
}

function signedOperatorMergeChain(seed) {
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
  return [original, merge];
}

function assertNoControllerMutation(harness) {
  const mutation = harness.requests.find(
    (request) =>
      (request.method === "POST" &&
        (request.pathname === "/repos/owner/repo/git/refs" ||
          request.pathname === "/repos/owner/repo/issues/7/comments" ||
          request.pathname === "/repos/owner/repo/pulls/7/reviews")) ||
      (request.method === "PUT" &&
        request.pathname === "/repos/owner/repo/pulls/7/merge"),
  );
  assert.equal(mutation, undefined);
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

test("canonical Socket Security manifests reach guarded approval and squash merge", async () => {
  const harness = createControllerHarness({
    files: [
      { filename: "socketsecurity-requirements.in" },
      { filename: "socketsecurity-requirements.txt" },
    ],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.fetch;
  try {
    assert.deepEqual(
      await runController(controllerEnvironment(harness.repository)),
      {
        action: "merged",
        pull: 7,
        head: harness.head,
      },
    );
    assert.ok(
      harness.requests.some(
        (request) =>
          request.method === "POST" &&
          request.pathname === "/repos/owner/repo/pulls/7/reviews" &&
          request.body?.commit_id === harness.head &&
          request.body?.event === "APPROVE",
      ),
    );
    assert.ok(
      harness.requests.some(
        (request) =>
          request.method === "PUT" &&
          request.pathname === "/repos/owner/repo/pulls/7/merge" &&
          request.body?.sha === harness.head &&
          request.body?.merge_method === "squash",
      ),
    );
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
    const commentWrites = harness.requests.filter(
      (request) =>
        request.method === "POST" &&
        request.pathname === "/repos/owner/repo/issues/7/comments",
    );
    assert.equal(commentWrites.length, 1);
    const [commentWrite] = commentWrites;
    assert.equal(commentWrite?.authorization, "Bearer automation-token");
    assert.deepEqual(commentWrite?.body, {
      body: `@dependabot rebase\n\n<!-- lcv-dependabot-rebase:${harness.head}:${harness.main} -->`,
    });
    assert.equal(
      harness.requests.some(
        (request) =>
          request.pathname === "/repos/owner/repo/git/refs" ||
          request.pathname === "/repos/owner/repo/pulls/7/reviews" ||
          request.pathname === "/repos/owner/repo/pulls/7/merge",
      ),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an exact Dependabot no-op response triggers one guarded rebase retry", async () => {
  const now = Date.now();
  const head = "a".repeat(40);
  const main = "b".repeat(40);
  const harness = createControllerHarness({
    behindBy: 1,
    issueComments: [
      {
        id: 100,
        user: { id: 42, login: "operator" },
        body: `@dependabot rebase\n\n<!-- lcv-dependabot-rebase:${head}:${main} -->`,
        created_at: new Date(now - 60_000).toISOString(),
      },
      {
        id: 101,
        user: { id: 49699333, login: "dependabot[bot]" },
        body: "Looks like this PR is already up-to-date with main! If you'd still like to recreate it from scratch, overwriting any edits, you can request `@dependabot recreate`.",
        created_at: new Date(now - 30_000).toISOString(),
      },
    ],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.fetch;
  try {
    assert.deepEqual(
      await runController(controllerEnvironment(harness.repository)),
      {
        action: "requested-retry",
        pull: 7,
        head: harness.head,
      },
    );
    const commentWrites = harness.requests.filter(
      (request) =>
        request.method === "POST" &&
        request.pathname === "/repos/owner/repo/issues/7/comments",
    );
    assert.deepEqual(commentWrites.map((request) => request.body), [
      {
        body: `@dependabot rebase\n\n<!-- lcv-dependabot-rebase-retry:${harness.head}:${harness.main} -->`,
      },
    ]);
    assert.equal(commentWrites[0]?.authorization, "Bearer automation-token");
    assert.equal(
      harness.requests.some(
        (request) =>
          request.pathname === "/repos/owner/repo/git/refs" ||
          request.pathname === "/repos/owner/repo/pulls/7/reviews" ||
          request.pathname === "/repos/owner/repo/pulls/7/merge",
      ),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a recent guarded rebase retry suppresses duplicate recovery while pending", async () => {
  const now = Date.now();
  const head = "a".repeat(40);
  const main = "b".repeat(40);
  const harness = createControllerHarness({
    behindBy: 1,
    issueComments: [
      {
        id: 100,
        user: { id: 42, login: "operator" },
        body: `@dependabot rebase\n\n<!-- lcv-dependabot-rebase:${head}:${main} -->`,
        created_at: new Date(now - 90_000).toISOString(),
      },
      {
        id: 101,
        user: { id: 49699333, login: "dependabot[bot]" },
        body: "Looks like this PR is already up-to-date with main! If you'd still like to recreate it from scratch, overwriting any edits, you can request `@dependabot recreate`.",
        created_at: new Date(now - 60_000).toISOString(),
      },
      {
        id: 102,
        user: { id: 42, login: "operator" },
        body: `@dependabot rebase\n\n<!-- lcv-dependabot-rebase-retry:${head}:${main} -->`,
        created_at: new Date(now - 30_000).toISOString(),
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

test("an old second exact Dependabot no-op remains a durable visible failure", async () => {
  const now = Date.now();
  const head = "a".repeat(40);
  const main = "b".repeat(40);
  const canonicalResponse =
    "Looks like this PR is already up-to-date with main! If you'd still like to recreate it from scratch, overwriting any edits, you can request `@dependabot recreate`.";
  const harness = createControllerHarness({
    behindBy: 1,
    issueComments: [
      {
        id: 100,
        user: { id: 42, login: "operator" },
        body: `@dependabot rebase\n\n<!-- lcv-dependabot-rebase:${head}:${main} -->`,
        created_at: new Date(now - 9 * 60 * 60 * 1000).toISOString(),
      },
      {
        id: 101,
        user: { id: 49699333, login: "dependabot[bot]" },
        body: canonicalResponse,
        created_at: new Date(now - 8.5 * 60 * 60 * 1000).toISOString(),
      },
      {
        id: 102,
        user: { id: 42, login: "operator" },
        body: `@dependabot rebase\n\n<!-- lcv-dependabot-rebase-retry:${head}:${main} -->`,
        created_at: new Date(now - 8 * 60 * 60 * 1000).toISOString(),
      },
      {
        id: 103,
        user: { id: 49699333, login: "dependabot[bot]" },
        body: canonicalResponse,
        created_at: new Date(now - 7.5 * 60 * 60 * 1000).toISOString(),
      },
    ],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.fetch;
  try {
    await assert.rejects(
      runController(controllerEnvironment(harness.repository)),
      /twice reported a still-behind head as current/,
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

test("an old unprocessed rebase request fails instead of starting another cycle", async () => {
  const now = Date.now();
  const head = "a".repeat(40);
  const main = "b".repeat(40);
  const harness = createControllerHarness({
    behindBy: 1,
    issueComments: [
      {
        id: 100,
        user: { id: 42, login: "operator" },
        body: `@dependabot rebase\n\n<!-- lcv-dependabot-rebase:${head}:${main} -->`,
        created_at: new Date(now - 7 * 60 * 60 * 1000).toISOString(),
      },
    ],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.fetch;
  try {
    await assert.rejects(
      runController(controllerEnvironment(harness.repository)),
      /did not process the guarded rebase request within six hours/,
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

test("a head change while resolving rebase identity and comments blocks the POST", async () => {
  const changedHead = "e".repeat(40);
  const harness = createControllerHarness({
    behindBy: 2,
    pullForRead: (read, pull) =>
      read === 1 ? pull : { ...pull, head: { ...pull.head, sha: changedHead } },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.fetch;
  try {
    const result = await runController(
      controllerEnvironment(harness.repository),
    );
    assert.equal(result.action, "deferred");
    const commentReadIndex = harness.requests.findIndex(
      (request) =>
        request.method === "GET" &&
        request.pathname === "/repos/owner/repo/issues/7/comments",
    );
    const finalPullReadIndex = harness.requests.findLastIndex(
      (request) =>
        request.method === "GET" &&
        request.pathname === "/repos/owner/repo/pulls/7",
    );
    assert.ok(commentReadIndex >= 0 && finalPullReadIndex > commentReadIndex);
    assertNoControllerMutation(harness);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a main advance at the final rebase POST boundary blocks the comment", async () => {
  const harness = createControllerHarness({
    behindBy: 2,
    mainShaForRead: (read, refs) => (read <= 2 ? refs.main : refs.advancedMain),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.fetch;
  try {
    const result = await runController(
      controllerEnvironment(harness.repository),
    );
    assert.equal(result.action, "deferred");
    assert.ok(harness.state.mainReads >= 3);
    assertNoControllerMutation(harness);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an unknown mergeability result defers before approval", async () => {
  const harness = createControllerHarness({
    pullForRead: (_read, pull) => ({ ...pull, mergeable: null }),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.fetch;
  try {
    const result = await runController(
      controllerEnvironment(harness.repository),
    );
    assert.equal(result.action, "deferred");
    assertNoControllerMutation(harness);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an unknown mergeability state defers even when mergeable is true", async () => {
  const harness = createControllerHarness({
    pullForRead: (_read, pull) => ({
      ...pull,
      mergeable: true,
      mergeable_state: "unknown",
    }),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.fetch;
  try {
    const result = await runController(
      controllerEnvironment(harness.repository),
    );
    assert.equal(result.action, "deferred");
    assertNoControllerMutation(harness);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a definitive merge conflict is skipped without mutating the queue", async () => {
  const harness = createControllerHarness({
    pullForRead: (_read, pull) => ({
      ...pull,
      mergeable: false,
      mergeable_state: "dirty",
    }),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.fetch;
  try {
    assert.deepEqual(
      await runController(controllerEnvironment(harness.repository)),
      { action: "none" },
    );
    assertNoControllerMutation(harness);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("mergeable true with blocked state remains eligible for approval", async () => {
  const harness = createControllerHarness({
    pullForRead: (_read, pull) => ({
      ...pull,
      mergeable: true,
      mergeable_state: "blocked",
    }),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.fetch;
  try {
    assert.equal(
      (await runController(controllerEnvironment(harness.repository))).action,
      "merged",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("list payloads without mergeability still use a mergeable detail response", async () => {
  const harness = createControllerHarness({
    pullForRead: (_read, pull) => ({
      ...pull,
      mergeable: true,
      mergeable_state: "blocked",
    }),
  });
  assert.equal(Object.hasOwn(harness.pullSummary, "mergeable"), false);
  assert.equal(Object.hasOwn(harness.pullSummary, "mergeable_state"), false);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.fetch;
  try {
    assert.equal(
      (await runController(controllerEnvironment(harness.repository))).action,
      "merged",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a fresh detail read may resolve initially unknown mergeability", async () => {
  const harness = createControllerHarness({
    pullForRead: (read, pull) =>
      read === 1
        ? { ...pull, mergeable: null, mergeable_state: "unknown" }
        : { ...pull, mergeable: true, mergeable_state: "blocked" },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.fetch;
  try {
    assert.equal(
      (await runController(controllerEnvironment(harness.repository))).action,
      "merged",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("merge gating rejects an incoherent comparison status or merge base", async (t) => {
  const seed = createControllerHarness();
  const cases = [
    {
      name: "zero behind but diverged",
      comparison: {
        behind_by: 0,
        status: "diverged",
        merge_base_commit: { sha: seed.main },
      },
    },
    {
      name: "wrong merge base",
      comparison: {
        behind_by: 0,
        status: "ahead",
        merge_base_commit: { sha: "f".repeat(40) },
      },
    },
    {
      name: "positive behind count but ahead status",
      comparison: {
        behind_by: 2,
        status: "ahead",
        merge_base_commit: { sha: seed.main },
      },
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const harness = createControllerHarness({
        comparisonForRead: () => fixture.comparison,
      });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = harness.fetch;
      try {
        const result = await runController(
          controllerEnvironment(harness.repository),
        );
        assert.equal(result.action, "deferred");
        assertNoControllerMutation(harness);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }
});

test("a rebase request requires a coherent merge base at the final boundary", async () => {
  const harness = createControllerHarness({
    comparisonForRead: (read, refs) =>
      read === 1
        ? {
            behind_by: 2,
            status: "diverged",
            merge_base_commit: { sha: refs.main },
          }
        : {
            behind_by: 2,
            status: "diverged",
            merge_base_commit: { sha: "f".repeat(40) },
          },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.fetch;
  try {
    const result = await runController(
      controllerEnvironment(harness.repository),
    );
    assert.equal(result.action, "deferred");
    assertNoControllerMutation(harness);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the final merge comparison revalidates status and merge base", async () => {
  const harness = createControllerHarness({
    comparisonForRead: (read, refs) =>
      read === 1
        ? {
            behind_by: 0,
            status: "ahead",
            merge_base_commit: { sha: refs.main },
          }
        : {
            behind_by: 0,
            status: "diverged",
            merge_base_commit: { sha: refs.main },
          },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.fetch;
  try {
    const result = await runController(
      controllerEnvironment(harness.repository),
    );
    assert.equal(result.action, "deferred");
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

test("the final merge comparison rejects a changed merge base", async () => {
  const harness = createControllerHarness({
    comparisonForRead: (read, refs) => ({
      behind_by: 0,
      status: "ahead",
      merge_base_commit: {
        sha: read === 1 ? refs.main : "f".repeat(40),
      },
    }),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.fetch;
  try {
    const result = await runController(
      controllerEnvironment(harness.repository),
    );
    assert.equal(result.action, "deferred");
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

test("a GitHub-signed merge by the automation operator never authorizes destructive recovery", async () => {
  const seed = createControllerHarness();
  const harness = createControllerHarness({
    commits: signedOperatorMergeChain(seed),
    files: [{ filename: ".github/workflows/ci.yml" }],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.fetch;
  try {
    const result = await runController(
      controllerEnvironment(harness.repository),
    );
    assert.deepEqual(result, { action: "none" });
    assertNoControllerMutation(harness);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a noncanonical manual commit set fails closed without any mutation", async () => {
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
    assertNoControllerMutation(harness);
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
