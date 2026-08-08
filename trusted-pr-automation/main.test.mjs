import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ACTIONS_APP_ID,
  CONNECTOR_APP_ID,
  CONNECTOR_ID,
  COPILOT_REVIEWER_ID,
  COPILOT_REVIEWER_NODE_ID,
  GitHubApi,
  TRUSTED_GATE_CHECK_NAME,
  allCommitsVerified,
  buildEnqueueInput,
  classifyChecks,
  connectorFailureCanSettleWithoutHeadChange,
  copilotFailureCanSettleWithoutHeadChange,
  controllerConnectorDisposition,
  controllerCheckOutcome,
  dependabotRebaseBody,
  ensureConnectorReviewRequest,
  ensureCopilotReviewRequest,
  ensureDependabotRebaseRequest,
  enqueueAfterFinalTrustAssessment,
  evaluateConnectorEvidence,
  evaluateCopilotEvidence,
  finalizePullTrustBoundary,
  hasReviewRequestForHead,
  isTrustedPullRequest,
  isCopilotReviewExcludedPath,
  lateReviewTimeoutCommand,
  recoverLateTrustedGate,
  readPullFiles,
  requiredChecksForPhase,
  resolveConnectorReviewCommits,
  reviewRequestBody,
  selectAssociatedPullRequests,
  validateMergeQueueEvidence,
  validatePolicy,
  verifyCodeScanningAfterChecks,
  waitForPullCore,
} from "./main.mjs";

const SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const OTHER_SHA = "c".repeat(40);

function actor(login = "lcv-leo", id = 268063598) {
  return { login, id };
}

function pull(overrides = {}) {
  return {
    number: 7,
    state: "open",
    draft: false,
    user: actor(),
    head: {
      sha: SHA,
      repo: { full_name: "LCV-Ideas-Software/example" },
    },
    base: {
      ref: "main",
      sha: BASE_SHA,
      repo: { full_name: "LCV-Ideas-Software/example" },
    },
    ...overrides,
  };
}

function policy() {
  return {
    schema_version: 1,
    organization: "LCV-Ideas-Software",
    allowed_actors: [actor(), actor("dependabot[bot]", 49699333)],
    copilot_reviewer: {
      database_id: COPILOT_REVIEWER_ID,
      node_id: COPILOT_REVIEWER_NODE_ID,
      rest_review_login: "copilot-pull-request-reviewer[bot]",
      graphql_login: "copilot-pull-request-reviewer",
      inline_alias_login: "Copilot",
    },
    repositories: {
      example: {
        required_checks: [
          { name: "Analyze actions", app_id: ACTIONS_APP_ID },
          { name: "CodeQL", app_id: 57789 },
          { name: "Run zizmor / Run zizmor", app_id: ACTIONS_APP_ID },
          { name: "zizmor", app_id: 57789 },
        ],
        merge_group_required_checks: [
          { name: "Synthetic integration", app_id: ACTIONS_APP_ID },
        ],
      },
    },
  };
}

function restCopilotActor(
  login = "copilot-pull-request-reviewer[bot]",
  id = COPILOT_REVIEWER_ID,
  nodeId = COPILOT_REVIEWER_NODE_ID,
) {
  return {
    login,
    id,
    node_id: nodeId,
    type: "Bot",
  };
}

function graphqlCopilotActor(
  login = "copilot-pull-request-reviewer",
  databaseId = COPILOT_REVIEWER_ID,
  nodeId = COPILOT_REVIEWER_NODE_ID,
) {
  return {
    login,
    databaseId,
    id: nodeId,
    __typename: "Bot",
  };
}

function copilotReview(commitId = SHA, overrides = {}) {
  return {
    id: 123,
    user: restCopilotActor(),
    state: "COMMENTED",
    commit_id: commitId,
    submitted_at: "2026-08-08T12:00:00Z",
    body: "Copilot reviewed this pull request.",
    ...overrides,
  };
}

function check(
  name,
  appId,
  status = "completed",
  conclusion = "success",
  id = 1,
) {
  return { id, name, status, conclusion, app: { id: appId } };
}

function connectorComment(body, createdAt = "2026-08-08T12:00:00Z") {
  return {
    user: actor("chatgpt-codex-connector[bot]", CONNECTOR_ID),
    performed_via_github_app: {
      id: CONNECTOR_APP_ID,
      slug: "chatgpt-codex-connector",
    },
    body,
    created_at: createdAt,
  };
}

function cleanComment(sha = SHA, createdAt) {
  return connectorComment(
    `Codex Review: Didn't find any major issues. Delightful!\n\n**Reviewed commit:** \`${sha.slice(0, 10)}\``,
    createdAt,
  );
}

function connectorEvidence({
  headSha = SHA,
  issueComments = [cleanComment(headSha)],
  reviews = [],
  threads = [],
  resolvedReviewCommits,
  requestReactions = new Map(),
} = {}) {
  const resolved = resolvedReviewCommits ?? new Map();
  if (!resolvedReviewCommits) {
    for (const comment of issueComments) {
      const prefix = comment.body?.match(
        /Reviewed commit:\*\*\s+`([0-9a-f]{10,40})`/i,
      )?.[1];
      if (prefix && SHA.startsWith(prefix)) resolved.set(prefix, SHA);
      if (prefix && OTHER_SHA.startsWith(prefix))
        resolved.set(prefix, OTHER_SHA);
    }
  }
  return {
    headSha,
    issueComments,
    reviews,
    threads,
    resolvedReviewCommits: resolved,
    requestReactions,
    policy: validatePolicy(policy()),
  };
}

test("validatePolicy accepts exact identities and executor plus GHAS checks", () => {
  const checked = validatePolicy(policy());
  assert.equal(checked.organization, "LCV-Ideas-Software");
  assert.equal(checked.copilot_reviewer.database_id, COPILOT_REVIEWER_ID);
  assert.equal(checked.copilot_reviewer.node_id, COPILOT_REVIEWER_NODE_ID);
});

test("validatePolicy rejects duplicate identities, duplicate checks, and self-gating", () => {
  const duplicateActor = policy();
  duplicateActor.allowed_actors.push(actor());
  assert.throws(
    () => validatePolicy(duplicateActor),
    /duplicate allowed actor/i,
  );

  const duplicateCheck = policy();
  duplicateCheck.repositories.example.merge_group_required_checks.push({
    name: "CodeQL",
    app_id: 57789,
  });
  assert.throws(
    () => validatePolicy(duplicateCheck),
    /duplicate required check/i,
  );

  const recursive = policy();
  recursive.repositories.example.merge_group_required_checks.push({
    name: TRUSTED_GATE_CHECK_NAME,
    app_id: ACTIONS_APP_ID,
  });
  assert.throws(() => validatePolicy(recursive), /must not require itself/i);

  const malformedPhase = policy();
  malformedPhase.repositories.example.merge_group_required_checks = {};
  assert.throws(
    () => validatePolicy(malformedPhase),
    /merge_group_required_checks must be an array/i,
  );

  for (const [field, value] of [
    ["database_id", 1],
    ["node_id", "BOT_spoof"],
    ["rest_review_login", "Copilot"],
    ["graphql_login", "copilot-pull-request-reviewer[bot]"],
    ["inline_alias_login", "copilot-pull-request-reviewer"],
  ]) {
    const malformedCopilot = policy();
    malformedCopilot.copilot_reviewer[field] = value;
    assert.throws(
      () => validatePolicy(malformedCopilot),
      /Copilot reviewer identity/i,
      field,
    );
  }
});

test("isTrustedPullRequest accepts only exact allowlisted same-repository main PRs", () => {
  const checked = validatePolicy(policy());
  assert.deepEqual(
    isTrustedPullRequest(pull(), "LCV-Ideas-Software/example", checked),
    { ok: true },
  );

  const cases = [
    [pull({ user: actor("lcv-leo", 1) }), /not allowlisted/i],
    [pull({ user: actor("lookalike", 268063598) }), /not allowlisted/i],
    [pull({ draft: true }), /draft/i],
    [pull({ state: "closed" }), /not open/i],
    [pull({ base: { ...pull().base, ref: "release" } }), /base main/i],
    [
      pull({
        head: { sha: SHA, repo: { full_name: "attacker/fork" } },
      }),
      /same repository/i,
    ],
    [pull({ head: { ...pull().head, sha: "not-a-sha" } }), /head sha/i],
  ];
  for (const [candidate, expected] of cases) {
    assert.match(
      isTrustedPullRequest(candidate, "LCV-Ideas-Software/example", checked)
        .reason,
      expected,
    );
  }
});

test("connector evidence requires a clean review of the exact head", () => {
  assert.equal(evaluateConnectorEvidence(connectorEvidence()).ok, true);

  assert.match(
    evaluateConnectorEvidence(
      connectorEvidence({ issueComments: [cleanComment(OTHER_SHA)] }),
    ).reason,
    /exact head/i,
  );

  const spoofedApp = cleanComment();
  spoofedApp.performed_via_github_app = { id: 1, slug: "lookalike" };
  assert.match(
    evaluateConnectorEvidence(
      connectorEvidence({ issueComments: [spoofedApp] }),
    ).reason,
    /exact head/i,
  );

  assert.match(
    evaluateConnectorEvidence(
      connectorEvidence({ resolvedReviewCommits: new Map() }),
    ).reason,
    /exact head/i,
  );
});

test("Copilot evidence requires exact Bot identity and COMMENTED review on the exact head", () => {
  const checked = validatePolicy(policy());
  assert.deepEqual(
    evaluateCopilotEvidence({
      headSha: SHA,
      reviews: [copilotReview(SHA)],
      threads: [],
      files: [{ filename: "src/app.js" }],
      policy: checked,
    }),
    { ok: true },
  );
  assert.deepEqual(
    evaluateCopilotEvidence({
      headSha: SHA,
      reviews: [
        copilotReview(SHA, {
          user: graphqlCopilotActor(),
        }),
      ],
      threads: [],
      files: [{ filename: "src/app.js" }],
      policy: checked,
    }),
    { ok: true },
  );

  for (const reviews of [
    [],
    [copilotReview(OTHER_SHA)],
    [
      copilotReview(SHA, {
        user: restCopilotActor("copilot-pull-request-reviewer[bot]", 1),
      }),
    ],
    [
      copilotReview(SHA, {
        user: restCopilotActor(
          "copilot-pull-request-reviewer[bot]",
          COPILOT_REVIEWER_ID,
          "BOT_spoof",
        ),
      }),
    ],
    [copilotReview(SHA, { user: restCopilotActor("lookalike") })],
  ]) {
    assert.match(
      evaluateCopilotEvidence({
        headSha: SHA,
        reviews,
        threads: [],
        policy: checked,
      }).reason,
      /Copilot review COMMENTED.*exact head/i,
    );
  }
  assert.match(
    evaluateCopilotEvidence({
      headSha: SHA,
      reviews: [copilotReview(SHA, { state: "APPROVED" })],
      threads: [],
      files: [{ filename: "src/app.js" }],
      policy: checked,
    }).reason,
    /unexpected state/i,
  );
  assert.match(
    evaluateCopilotEvidence({
      headSha: SHA,
      reviews: [copilotReview(SHA, { id: null })],
      threads: [],
      files: [{ filename: "src/app.js" }],
      policy: checked,
    }).reason,
    /no immutable identity/i,
  );
});

test("Copilot unreviewable completion is neutral only for explicitly excluded files", () => {
  const checked = validatePolicy(policy());
  const unreviewable = copilotReview(SHA, {
    body: "Copilot wasn't able to review any files in this pull request.",
  });
  for (const files of [
    [{ filename: "package-lock.json", status: "modified" }],
    [
      { filename: "Cargo.lock", status: "modified" },
      { filename: "assets/logo.svg", status: "added" },
      { filename: "logs/build.log", status: "removed" },
    ],
    [
      {
        filename: "dist/new-name.js",
        previous_filename: "dist/old-name.js",
        status: "renamed",
      },
    ],
  ]) {
    assert.deepEqual(
      evaluateCopilotEvidence({
        headSha: SHA,
        reviews: [unreviewable],
        threads: [],
        files,
        policy: checked,
      }),
      { ok: true },
    );
  }

  for (const files of [
    [],
    [{ filename: "src/app.js", status: "modified" }],
    [
      { filename: "package-lock.json", status: "modified" },
      { filename: "src/app.js", status: "modified" },
    ],
    [{ filename: "unknown.custom", status: "modified" }],
    [{ filename: "package-lock.json" }],
    [{ filename: "package-lock.json", status: "future-status" }],
    [
      {
        filename: "dist/app.js",
        previous_filename: "src/app.js",
        status: "renamed",
      },
    ],
    [
      {
        filename: "dist/app.js",
        status: "renamed",
      },
    ],
  ]) {
    assert.match(
      evaluateCopilotEvidence({
        headSha: SHA,
        reviews: [unreviewable],
        threads: [],
        files,
        policy: checked,
      }).reason,
      /could not review all changed files/i,
    );
  }
});

test("Copilot excluded-file matcher follows the official list and bin exceptions", () => {
  for (const filename of [
    ".gitignore",
    "package.json",
    "package-lock.json",
    "yarn.lock",
    "jest.config.js",
    "next.config.js",
    "tailwind.config.js",
    "tsconfig.json",
    "requirements.txt",
    "Pipfile.lock",
    "nested/Gemfile.lock",
    "composer.lock",
    "Cargo.lock",
    "go.sum",
    "paket.lock",
    "pubspec.lock",
    "stack.yaml",
    "elm.json",
    "Project.toml",
    "Manifest.toml",
    "renv.lock",
    "build.sbt",
    "Package.resolved",
    "deps.edn",
    "build.gradle",
    "mix.lock",
    "build.gradle.kts",
    "cpanfile",
    "Podfile.lock",
    "conanfile.txt",
    "info.rkt",
    "rockspec",
    "opam",
    "rebar.config",
    "nimble",
    "shard.yml",
    "dub.json",
    "dub.sdl",
    "GPR",
    "Mason.toml",
    "fpm.toml",
    "pack.pl",
    "baseline.st",
    "PacletInfo.m",
    "info.ss",
    "Jpkg",
    "box.json",
    "GNAVI.xml",
    "assets/icon.svg",
    "logs/build.log",
    "deps/custom.lock",
    "notebooks/output.ipynb.raw.html",
    "dist/app.js",
    "node_modules/pkg/index.js",
    "public/app.min.js",
    "src/generated/client.ts",
    "src/generated-sources/client.ts",
    "types/index.d.ts",
    "coverage/index.html",
    "public/app.bundle.js",
    "public/app.js.map",
    "out/result.txt",
    "vendor/library.js",
    "src/bin/tool",
  ]) {
    assert.equal(isCopilotReviewExcludedPath(filename), true, filename);
  }
  for (const filename of [
    "src/app.ts",
    "unknown.custom",
    "src/bin/main.rs",
    "platform/hybris/bin/custom/Extension.java",
    "platform/hybris/bin/custom/tool/bin/Extension.java",
    "../dist/app.js",
    "src\\dist\\app.js",
  ]) {
    assert.equal(isCopilotReviewExcludedPath(filename), false, filename);
  }
});

test("Copilot evidence reads every thread using the immutable review commit", () => {
  const checked = validatePolicy(policy());
  const reviews = [
    copilotReview(OTHER_SHA, { id: 122 }),
    copilotReview(SHA, { id: 123 }),
  ];
  const staleUnresolved = {
    isResolved: false,
    comments: [
      {
        author: actor("someone-else", 99),
        reviewCommit: { oid: SHA },
      },
      {
        author: graphqlCopilotActor(),
        reviewId: 122,
        commit: { oid: SHA },
        originalCommit: { oid: OTHER_SHA },
        reviewCommit: { oid: OTHER_SHA },
      },
    ],
  };
  assert.match(
    evaluateCopilotEvidence({
      headSha: SHA,
      reviews,
      threads: [staleUnresolved],
      files: [{ filename: "src/app.js" }],
      policy: checked,
    }).reason,
    /unresolved Copilot review thread/i,
  );

  for (const isResolved of [false, true]) {
    const currentFinding = structuredClone(staleUnresolved);
    currentFinding.isResolved = isResolved;
    currentFinding.comments[1].reviewCommit.oid = SHA;
    currentFinding.comments[1].reviewId = 123;
    assert.match(
      evaluateCopilotEvidence({
        headSha: SHA,
        reviews,
        threads: [currentFinding],
        files: [{ filename: "src/app.js" }],
        policy: checked,
      }).reason,
      /Copilot finding exists on the current head/i,
      String(isResolved),
    );
  }

  assert.deepEqual(
    evaluateCopilotEvidence({
      headSha: SHA,
      reviews,
      threads: [
        { ...staleUnresolved, isResolved: true },
        {
          isResolved: true,
          comments: [
            {
              author: restCopilotActor("Copilot"),
              reviewId: 122,
              reviewCommit: { oid: OTHER_SHA },
            },
          ],
        },
      ],
      files: [{ filename: "src/app.js" }],
      policy: checked,
    }),
    { ok: true },
  );

  const missingImmutableReview = structuredClone(staleUnresolved);
  missingImmutableReview.isResolved = true;
  delete missingImmutableReview.comments[1].reviewCommit;
  assert.match(
    evaluateCopilotEvidence({
      headSha: SHA,
      reviews,
      threads: [missingImmutableReview],
      files: [{ filename: "src/app.js" }],
      policy: checked,
    }).reason,
    /Copilot thread has no immutable review commit/i,
  );

  const mismatchedReview = structuredClone(staleUnresolved);
  mismatchedReview.isResolved = true;
  mismatchedReview.comments[1].reviewId = 999;
  assert.match(
    evaluateCopilotEvidence({
      headSha: SHA,
      reviews,
      threads: [mismatchedReview],
      files: [{ filename: "src/app.js" }],
      policy: checked,
    }).reason,
    /Copilot thread review identity is inconsistent/i,
  );
});

test("reviewed commit prefixes are resolved through GitHub and fail closed", async () => {
  const comment = cleanComment();
  const correct = await resolveConnectorReviewCommits({
    api: { request: async () => ({ sha: SHA }) },
    owner: "LCV-Ideas-Software",
    repo: "example",
    headSha: SHA,
    issueComments: [comment],
  });
  assert.equal(correct.get(SHA.slice(0, 10)), SHA);

  const stale = await resolveConnectorReviewCommits({
    api: {
      request: async () => assert.fail("stale prefix must not be resolved"),
    },
    owner: "LCV-Ideas-Software",
    repo: "example",
    headSha: SHA,
    issueComments: [cleanComment(OTHER_SHA)],
  });
  assert.equal(stale.size, 0);

  await assert.rejects(
    resolveConnectorReviewCommits({
      api: { request: async () => ({ sha: OTHER_SHA }) },
      owner: "LCV-Ideas-Software",
      repo: "example",
      headSha: SHA,
      issueComments: [comment],
    }),
    /did not resolve uniquely/i,
  );
  await assert.rejects(
    resolveConnectorReviewCommits({
      api: {
        request: async () => {
          throw new Error("lookup unavailable");
        },
      },
      owner: "LCV-Ideas-Software",
      repo: "example",
      headSha: SHA,
      issueComments: [comment],
    }),
    /lookup unavailable/i,
  );
});

test("only connector +1 on the exact marked request is a clean signal", () => {
  const request = { id: 99, user: actor(), body: reviewRequestBody(SHA) };
  const reaction = (
    content,
    user = actor("chatgpt-codex-connector[bot]", CONNECTOR_ID),
  ) => ({
    content,
    user,
    created_at: "2026-08-08T12:03:00Z",
  });
  assert.equal(
    evaluateConnectorEvidence(
      connectorEvidence({
        issueComments: [request],
        resolvedReviewCommits: new Map(),
        requestReactions: new Map([["99", [reaction("+1")]]]),
      }),
    ).ok,
    true,
  );
  for (const denied of [
    reaction("eyes"),
    reaction("+1", actor("lookalike", 1)),
  ]) {
    assert.match(
      evaluateConnectorEvidence(
        connectorEvidence({
          issueComments: [request],
          resolvedReviewCommits: new Map(),
          requestReactions: new Map([["99", [denied]]]),
        }),
      ).reason,
      /exact head/i,
    );
  }
});

test("review requests are exact-head, idempotent, and posted only by an allowlisted actor", () => {
  const checked = validatePolicy(policy());
  const body = reviewRequestBody(SHA);
  assert.match(body, /^@codex review/);
  assert.equal(
    hasReviewRequestForHead([{ id: 1, user: actor(), body }], SHA, checked),
    true,
  );
  assert.equal(
    hasReviewRequestForHead(
      [{ id: 1, user: actor(), body }],
      OTHER_SHA,
      checked,
    ),
    false,
  );
  assert.equal(
    hasReviewRequestForHead(
      [{ id: 1, user: actor("untrusted", 123), body }],
      SHA,
      checked,
    ),
    false,
  );
});

test("controller requests connector review once per exact head", async () => {
  const requests = [];
  const api = {
    request: async (...args) => {
      requests.push(args);
      return {};
    },
  };
  const checked = validatePolicy(policy());
  const requested = await ensureConnectorReviewRequest({
    api,
    owner: "LCV-Ideas-Software",
    repo: "example",
    number: 7,
    headSha: SHA,
    issueComments: [],
    policy: checked,
  });
  assert.equal(requested, "connector-review-requested");
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0][0],
    "/repos/LCV-Ideas-Software/example/issues/7/comments",
  );
  assert.deepEqual(requests[0][1], {
    method: "POST",
    body: { body: reviewRequestBody(SHA) },
  });

  const pending = await ensureConnectorReviewRequest({
    api,
    owner: "LCV-Ideas-Software",
    repo: "example",
    number: 7,
    headSha: SHA,
    issueComments: [{ id: 1, user: actor(), body: reviewRequestBody(SHA) }],
    policy: checked,
  });
  assert.equal(pending, "connector-review-pending");
  assert.equal(requests.length, 1);

  await ensureConnectorReviewRequest({
    api,
    owner: "LCV-Ideas-Software",
    repo: "example",
    number: 7,
    headSha: OTHER_SHA,
    issueComments: [{ id: 1, user: actor(), body: reviewRequestBody(SHA) }],
    policy: checked,
  });
  assert.equal(requests.length, 2);
});

test("controller requests the exact Copilot reviewer idempotently", async () => {
  const requests = [];
  const api = {
    request: async (...args) => {
      requests.push(args);
      return {};
    },
  };
  const checked = validatePolicy(policy());
  assert.equal(
    await ensureCopilotReviewRequest({
      api,
      owner: "LCV-Ideas-Software",
      repo: "example",
      number: 7,
      requestedReviewers: [],
      policy: checked,
    }),
    "copilot-review-requested",
  );
  assert.deepEqual(requests[0], [
    "/repos/LCV-Ideas-Software/example/pulls/7/requested_reviewers",
    {
      method: "POST",
      body: { reviewers: ["copilot-pull-request-reviewer[bot]"] },
    },
  ]);

  assert.equal(
    await ensureCopilotReviewRequest({
      api,
      owner: "LCV-Ideas-Software",
      repo: "example",
      number: 7,
      requestedReviewers: [restCopilotActor()],
      policy: checked,
    }),
    "copilot-review-pending",
  );
  assert.equal(requests.length, 1);

  await ensureCopilotReviewRequest({
    api,
    owner: "LCV-Ideas-Software",
    repo: "example",
    number: 7,
    requestedReviewers: [restCopilotActor("lookalike")],
    policy: checked,
  });
  assert.equal(requests.length, 2);
});

test("Dependabot conflict rebase requests are idempotent per exact head", async () => {
  const requests = [];
  const api = {
    request: async (...args) => {
      requests.push(args);
      return {};
    },
  };
  const checked = validatePolicy(policy());
  assert.equal(
    await ensureDependabotRebaseRequest({
      api,
      owner: "LCV-Ideas-Software",
      repo: "example",
      number: 7,
      headSha: SHA,
      issueComments: [],
      policy: checked,
    }),
    "dependabot-rebase-requested",
  );
  assert.deepEqual(requests[0][1], {
    method: "POST",
    body: { body: dependabotRebaseBody(SHA) },
  });
  assert.equal(
    await ensureDependabotRebaseRequest({
      api,
      owner: "LCV-Ideas-Software",
      repo: "example",
      number: 7,
      headSha: SHA,
      issueComments: [
        { id: 1, user: actor(), body: dependabotRebaseBody(SHA) },
      ],
      policy: checked,
    }),
    "dependabot-rebase-pending",
  );
  assert.equal(requests.length, 1);
});

test("connector evidence blocks unresolved findings and later current-head findings", () => {
  const unresolved = evaluateConnectorEvidence(
    connectorEvidence({
      threads: [
        {
          isResolved: false,
          isOutdated: false,
          comments: [
            {
              author: actor("chatgpt-codex-connector", CONNECTOR_ID),
              body: "P1: actionable finding",
              commit: { oid: SHA },
              reviewCommit: { oid: SHA },
              createdAt: "2026-08-08T12:01:00Z",
            },
          ],
        },
      ],
    }),
  );
  assert.match(unresolved.reason, /unresolved connector thread/i);

  const laterFinding = evaluateConnectorEvidence(
    connectorEvidence({
      issueComments: [cleanComment(SHA, "2026-08-08T12:00:00Z")],
      reviews: [
        {
          user: actor("chatgpt-codex-connector[bot]", CONNECTOR_ID),
          state: "COMMENTED",
          commit_id: SHA,
          body: "Found an issue",
          submitted_at: "2026-08-08T12:02:00Z",
        },
      ],
    }),
  );
  assert.match(laterFinding.reason, /after the latest connector finding/i);
});

test("connector evidence allows resolved stale threads but blocks current change requests", () => {
  const resolved = evaluateConnectorEvidence(
    connectorEvidence({
      issueComments: [cleanComment(SHA, "2026-08-08T12:02:00Z")],
      threads: [
        {
          isResolved: true,
          isOutdated: true,
          comments: [
            {
              author: actor("chatgpt-codex-connector", CONNECTOR_ID),
              body: "P2: fixed",
              commit: { oid: SHA },
              reviewCommit: { oid: OTHER_SHA },
              createdAt: "2026-08-08T11:00:00Z",
            },
          ],
        },
      ],
    }),
  );
  assert.equal(resolved.ok, true);

  assert.match(
    evaluateConnectorEvidence(
      connectorEvidence({
        threads: [
          {
            isResolved: false,
            isOutdated: true,
            comments: [
              {
                author: actor("chatgpt-codex-connector", CONNECTOR_ID),
                reviewCommit: { oid: OTHER_SHA },
                createdAt: "2026-08-08T11:00:00Z",
              },
            ],
          },
        ],
      }),
    ).reason,
    /unresolved connector thread/i,
  );

  const resolvedCurrentFinding = {
    isResolved: true,
    isOutdated: false,
    comments: [
      {
        author: actor("chatgpt-codex-connector", CONNECTOR_ID),
        body: "P2: fixed",
        commit: { oid: SHA },
        reviewCommit: { oid: SHA },
        createdAt: "2026-08-08T12:03:00Z",
      },
    ],
  };
  assert.match(
    evaluateConnectorEvidence(
      connectorEvidence({
        issueComments: [cleanComment(SHA, "2026-08-08T12:02:00Z")],
        threads: [resolvedCurrentFinding],
      }),
    ).reason,
    /after the latest connector finding/i,
  );
  assert.match(
    evaluateConnectorEvidence(
      connectorEvidence({
        issueComments: [cleanComment(SHA, "2026-08-08T12:03:00Z")],
        threads: [resolvedCurrentFinding],
      }),
    ).reason,
    /after the latest connector finding/i,
  );
  assert.equal(
    evaluateConnectorEvidence(
      connectorEvidence({
        issueComments: [cleanComment(SHA, "2026-08-08T12:04:00Z")],
        threads: [resolvedCurrentFinding],
      }),
    ).ok,
    true,
  );

  const changesRequested = evaluateConnectorEvidence(
    connectorEvidence({
      reviews: [
        {
          user: actor("lcv-leo", 268063598),
          state: "CHANGES_REQUESTED",
          commit_id: SHA,
          body: "fix it",
          submitted_at: "2026-08-08T12:01:00Z",
        },
      ],
    }),
  );
  assert.match(changesRequested.reason, /changes requested/i);

  assert.equal(
    evaluateConnectorEvidence(
      connectorEvidence({
        reviews: [
          {
            id: 1,
            user: actor(),
            state: "CHANGES_REQUESTED",
            commit_id: SHA,
            submitted_at: "2026-08-08T12:01:00Z",
          },
          {
            id: 2,
            user: actor(),
            state: "APPROVED",
            commit_id: SHA,
            submitted_at: "2026-08-08T12:02:00Z",
          },
        ],
      }),
    ).ok,
    true,
  );
});

test("the gate polls only connector blockers that can settle on the same head", () => {
  for (const reason of [
    "no clean connector review exists for the exact head",
    "no clean connector review exists after the latest connector finding",
    "unresolved connector thread remains",
  ]) {
    assert.equal(
      connectorFailureCanSettleWithoutHeadChange(reason),
      true,
      reason,
    );
  }
  for (const reason of [
    "invalid connector evidence head SHA",
    "connector thread has no immutable review commit",
    "changes requested on the current head",
    "unrecognized connector state",
  ]) {
    assert.equal(
      connectorFailureCanSettleWithoutHeadChange(reason),
      false,
      reason,
    );
  }
  assert.equal(
    controllerConnectorDisposition(
      "no clean connector review exists for the exact head",
    ),
    "request-review",
  );
  assert.match(
    controllerConnectorDisposition("unresolved connector thread remains"),
    /^connector-blocked:/,
  );
  assert.throws(
    () =>
      controllerConnectorDisposition(
        "connector thread has no immutable review commit",
      ),
    /not safely observable/i,
  );
});

test("the gate polls a mutable connector blocker but propagates terminal evidence", async () => {
  const options = {
    repo: "example",
    number: 7,
    expectedHead: SHA,
  };
  const timing = { deadline: Date.now() + 1_000, pollSeconds: 0 };
  let calls = 0;
  const settled = await waitForPullCore(options, timing, async () => {
    calls += 1;
    if (calls === 1) {
      return { connectorPending: "unresolved connector thread remains" };
    }
    return { pullRequest: { head: { sha: SHA } } };
  });
  assert.equal(calls, 2);
  assert.equal(settled.pullRequest.head.sha, SHA);

  calls = 0;
  await assert.rejects(
    waitForPullCore(options, timing, async () => {
      calls += 1;
      throw new Error("connector thread has no immutable review commit");
    }),
    /no immutable review commit/i,
  );
  assert.equal(calls, 1);
});

test("the gate polls mutable Copilot review evidence but rejects malformed identity evidence", async () => {
  const options = {
    repo: "example",
    number: 7,
    expectedHead: SHA,
  };
  const timing = { deadline: Date.now() + 1_000, pollSeconds: 0 };
  let calls = 0;
  const settled = await waitForPullCore(options, timing, async () => {
    calls += 1;
    if (calls === 1) {
      return {
        copilotPending: "no Copilot review COMMENTED exists for the exact head",
      };
    }
    return { pullRequest: { head: { sha: SHA } } };
  });
  assert.equal(calls, 2);
  assert.equal(settled.pullRequest.head.sha, SHA);

  assert.equal(
    copilotFailureCanSettleWithoutHeadChange(
      "unresolved Copilot review thread remains",
    ),
    true,
  );
  assert.equal(
    copilotFailureCanSettleWithoutHeadChange(
      "Copilot thread has no immutable review commit",
    ),
    false,
  );
  assert.equal(
    copilotFailureCanSettleWithoutHeadChange(
      "Copilot finding exists on the current head",
    ),
    false,
  );
});

test("classifyChecks requires exact executor and GHAS identities and all observed checks green", () => {
  const required = policy().repositories.example.required_checks;
  const runs = required.map((entry, index) =>
    check(entry.name, entry.app_id, "completed", "success", index + 1),
  );
  runs.push(
    check(TRUSTED_GATE_CHECK_NAME, ACTIONS_APP_ID, "in_progress", null, 50),
  );
  assert.deepEqual(
    classifyChecks({ checkRuns: runs, statuses: [], requiredChecks: required }),
    {
      state: "success",
      reasons: [],
    },
  );

  assert.equal(
    classifyChecks({
      checkRuns: runs.slice(1),
      statuses: [],
      requiredChecks: required,
    }).state,
    "pending",
  );
  assert.equal(
    classifyChecks({
      checkRuns: [
        ...runs,
        check("Unexpected audit", ACTIONS_APP_ID, "completed", "failure", 99),
      ],
      statuses: [],
      requiredChecks: required,
    }).state,
    "failure",
  );
  assert.equal(
    classifyChecks({
      checkRuns: [
        ...runs,
        check("Optional deploy", ACTIONS_APP_ID, "completed", "skipped", 101),
        check("Optional advisory", ACTIONS_APP_ID, "completed", "neutral", 102),
      ],
      statuses: [],
      requiredChecks: required,
    }).state,
    "success",
  );
  assert.equal(
    classifyChecks({
      checkRuns: runs.map((run) =>
        run.name === "Analyze actions"
          ? { ...run, conclusion: "skipped" }
          : run,
      ),
      statuses: [],
      requiredChecks: required,
    }).state,
    "failure",
  );
  const withoutAnalyzeActions = runs.filter(
    (run) => run.name !== "Analyze actions",
  );
  assert.equal(
    classifyChecks({
      checkRuns: [
        ...withoutAnalyzeActions,
        check("Analyze actions", ACTIONS_APP_ID, "completed", "success", 100),
        check("Analyze actions", ACTIONS_APP_ID, "in_progress", null, 101),
      ],
      statuses: [],
      requiredChecks: required,
    }).state,
    "pending",
  );
  assert.equal(
    classifyChecks({
      checkRuns: [
        ...withoutAnalyzeActions,
        check("Analyze actions", ACTIONS_APP_ID, "completed", "success", 100),
        check("Analyze actions", ACTIONS_APP_ID, "completed", "failure", 101),
      ],
      statuses: [],
      requiredChecks: required,
    }).state,
    "failure",
  );
  assert.equal(
    classifyChecks({
      checkRuns: runs.map((run) =>
        run.name === "Analyze actions"
          ? { ...run, conclusion: "failure" }
          : run,
      ),
      statuses: [],
      requiredChecks: required,
    }).state,
    "failure",
  );
  assert.equal(
    classifyChecks({
      checkRuns: runs,
      statuses: [{ context: "legacy-ci", state: "failure", id: 1 }],
      requiredChecks: required,
    }).state,
    "failure",
  );
});

test("phase-specific checks are optional on PRs and fail closed on merge groups", () => {
  const checked = validatePolicy(policy());
  const repository = checked.repositories.example;
  const pullChecks = requiredChecksForPhase(repository, "pull_request");
  const mergeChecks = requiredChecksForPhase(repository, "merge_group");
  const commonRuns = pullChecks.map((entry, index) =>
    check(entry.name, entry.app_id, "completed", "success", index + 1),
  );

  assert.equal(
    classifyChecks({
      checkRuns: commonRuns,
      statuses: [],
      requiredChecks: pullChecks,
    }).state,
    "success",
  );
  assert.equal(
    classifyChecks({
      checkRuns: commonRuns,
      statuses: [],
      requiredChecks: mergeChecks,
    }).state,
    "pending",
  );
  assert.equal(
    classifyChecks({
      checkRuns: [
        ...commonRuns,
        check(
          "Synthetic integration",
          ACTIONS_APP_ID,
          "completed",
          "failure",
          99,
        ),
      ],
      statuses: [],
      requiredChecks: pullChecks,
    }).state,
    "failure",
  );
  assert.equal(
    classifyChecks({
      checkRuns: [
        ...commonRuns,
        check(
          "Synthetic integration",
          ACTIONS_APP_ID,
          "completed",
          "success",
          99,
        ),
      ],
      statuses: [],
      requiredChecks: mergeChecks,
    }).state,
    "success",
  );
  assert.throws(
    () => requiredChecksForPhase(repository, "push"),
    /unsupported check phase/i,
  );
});

test("controller treats normal pending checks as observation and terminal failures as errors", () => {
  assert.equal(
    controllerCheckOutcome({
      state: "pending",
      reasons: ["missing required check"],
    }),
    "checks-pending",
  );
  assert.equal(
    controllerCheckOutcome({ state: "success", reasons: [] }),
    "checks-success",
  );
  assert.throws(
    () =>
      controllerCheckOutcome({ state: "failure", reasons: ["CodeQL failed"] }),
    /CodeQL failed/,
  );
});

test("code-scanning alerts are refreshed only after exact-head checks are green", async () => {
  let calls = 0;
  const pendingApi = {
    pages: async () => {
      calls += 1;
      return [{ number: 1 }];
    },
  };
  assert.equal(
    await verifyCodeScanningAfterChecks({
      api: pendingApi,
      owner: "LCV-Ideas-Software",
      repo: "example",
      number: 7,
      checkState: "pending",
    }),
    "checks-pending",
  );
  assert.equal(calls, 0);

  assert.equal(
    await verifyCodeScanningAfterChecks({
      api: { pages: async () => [] },
      owner: "LCV-Ideas-Software",
      repo: "example",
      number: 7,
      checkState: "success",
    }),
    "code-scanning-success",
  );
  await assert.rejects(
    verifyCodeScanningAfterChecks({
      api: { pages: async () => [{ number: 1 }] },
      owner: "LCV-Ideas-Software",
      repo: "example",
      number: 7,
      checkState: "success",
    }),
    /1 open code-scanning alert/i,
  );
});

test("final trust boundary rereads evidence around code scanning", async () => {
  const trace = [];
  const trusted = {
    pullRequest: { head: { sha: SHA } },
    mainSha: BASE_SHA,
  };
  const result = await finalizePullTrustBoundary({
    expectedHead: SHA,
    expectedBase: BASE_SHA,
    label: "example#7",
    reassess: async () => {
      trace.push("reassess");
      return trusted;
    },
    scanCode: async () => trace.push("scan"),
    recheckChecks: async () => trace.push("recheck"),
  });
  assert.equal(result, trusted);
  assert.deepEqual(trace, ["reassess", "scan", "reassess", "recheck"]);

  let scanCalled = false;
  await assert.rejects(
    finalizePullTrustBoundary({
      expectedHead: SHA,
      label: "example#7",
      reassess: async () => ({ pullRequest: { head: { sha: OTHER_SHA } } }),
      scanCode: async () => {
        scanCalled = true;
      },
      recheckChecks: async () => undefined,
    }),
    /head changed at final trust boundary/i,
  );
  assert.equal(scanCalled, false);

  let assessment = 0;
  await assert.rejects(
    finalizePullTrustBoundary({
      expectedHead: SHA,
      label: "example#7",
      reassess: async () => {
        assessment += 1;
        if (assessment === 2) throw new Error("late connector finding");
        return trusted;
      },
      scanCode: async () => undefined,
      recheckChecks: async () => undefined,
    }),
    /late connector finding/i,
  );

  assessment = 0;
  await assert.rejects(
    finalizePullTrustBoundary({
      expectedHead: SHA,
      label: "example#7",
      reassess: async () => {
        assessment += 1;
        return {
          pullRequest: {
            head: { sha: assessment === 1 ? SHA : OTHER_SHA },
          },
        };
      },
      scanCode: async () => undefined,
      recheckChecks: async () => undefined,
    }),
    /head changed at final trust boundary/i,
  );

  await assert.rejects(
    finalizePullTrustBoundary({
      expectedHead: SHA,
      label: "example#7",
      reassess: async () => trusted,
      scanCode: async () => undefined,
      recheckChecks: async () => {
        throw new Error("final exact-SHA check inventory is pending");
      },
    }),
    /check inventory is pending/i,
  );
});

test("controller reruns once only for an attributable timeout with current clean evidence", async () => {
  assert.match(
    lateReviewTimeoutCommand({ repo: "example", number: 7, headSha: SHA }),
    new RegExp(SHA),
  );
  const gateFailure = {
    ...check(
      TRUSTED_GATE_CHECK_NAME,
      ACTIONS_APP_ID,
      "completed",
      "failure",
      90,
    ),
    completed_at: "2026-08-08T12:00:00Z",
    details_url:
      "https://github.com/LCV-Ideas-Software/example/actions/runs/123/job/456",
  };
  const calls = [];
  const api = {
    pages: async () => [
      {
        title: "LCV_GATE_LATE_REVIEW_TIMEOUT",
        message: `timed out at ${SHA}`,
      },
    ],
    request: async (path, options) => {
      calls.push([path, options]);
      if (path.endsWith("/actions/runs/123")) {
        return { id: 123, head_sha: SHA, run_attempt: 1, status: "completed" };
      }
      return null;
    },
  };
  assert.equal(
    await recoverLateTrustedGate({
      api,
      owner: "LCV-Ideas-Software",
      repo: "example",
      headSha: SHA,
      cleanAt: Date.parse("2026-08-08T12:01:00Z"),
      checkRuns: [gateFailure],
    }),
    "trusted-gate-rerun-requested",
  );
  assert.deepEqual(calls.at(-1), [
    "/repos/LCV-Ideas-Software/example/actions/runs/123/rerun-failed-jobs",
    { method: "POST" },
  ]);

  assert.equal(
    await recoverLateTrustedGate({
      api,
      owner: "LCV-Ideas-Software",
      repo: "example",
      headSha: SHA,
      cleanAt: Date.parse("2026-08-08T11:59:00Z"),
      checkRuns: [gateFailure],
    }),
    "trusted-gate-rerun-requested",
  );

  await assert.rejects(
    recoverLateTrustedGate({
      api,
      owner: "LCV-Ideas-Software",
      repo: "example",
      headSha: SHA,
      cleanAt: 0,
      checkRuns: [gateFailure],
    }),
    /invalid recovery timestamps/i,
  );

  await assert.rejects(
    recoverLateTrustedGate({
      api: {
        pages: async () => [],
        request: async () => assert.fail("no rerun"),
      },
      owner: "LCV-Ideas-Software",
      repo: "example",
      headSha: SHA,
      cleanAt: Date.parse("2026-08-08T12:01:00Z"),
      checkRuns: [gateFailure],
    }),
    /not an attributable late-review timeout/i,
  );

  const exhaustedApi = {
    pages: async () => [
      {
        title: "LCV_GATE_LATE_REVIEW_TIMEOUT",
        message: `timed out at ${SHA}`,
      },
    ],
    request: async () => ({
      id: 123,
      head_sha: SHA,
      run_attempt: 2,
      status: "completed",
    }),
  };
  await assert.rejects(
    recoverLateTrustedGate({
      api: exhaustedApi,
      owner: "LCV-Ideas-Software",
      repo: "example",
      headSha: SHA,
      cleanAt: Date.parse("2026-08-08T12:01:00Z"),
      checkRuns: [gateFailure],
    }),
    /already exhausted/i,
  );
});

test("allCommitsVerified is exact-head, nonempty, and fail-closed", () => {
  const verified = [
    { sha: OTHER_SHA, commit: { verification: { verified: true } } },
    { sha: SHA, commit: { verification: { verified: true } } },
  ];
  assert.deepEqual(allCommitsVerified(verified, SHA), { ok: true });
  assert.match(allCommitsVerified([], SHA).reason, /no commits/i);
  assert.match(
    allCommitsVerified(
      [{ sha: SHA, commit: { verification: { verified: false } } }],
      SHA,
    ).reason,
    /not verified/i,
  );
  assert.match(allCommitsVerified(verified, BASE_SHA).reason, /last commit/i);
});

test("GitHub API pagination reads every status page and fails on truncation", async () => {
  const urls = [];
  const api = new GitHubApi("redacted", async (url) => {
    urls.push(url);
    const page = Number(new URL(url).searchParams.get("page"));
    const payload =
      page === 1
        ? Array.from({ length: 100 }, (_, id) => ({ id }))
        : [{ id: 100 }];
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  });
  assert.equal(
    (await api.pages("/repos/o/r/commits/sha/statuses")).length,
    101,
  );
  assert.equal(urls.length, 2);

  const truncated = new GitHubApi("redacted", async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify(Array.from({ length: 100 }, (_, id) => ({ id }))),
  }));
  await assert.rejects(
    truncated.pages("/statuses", { maxPages: 1 }),
    /exceeded 100 records/i,
  );
});

test("pull-file evidence requests every GitHub page up to the documented cap", async () => {
  const calls = [];
  const files = await readPullFiles({
    api: {
      pages: async (...args) => {
        calls.push(args);
        return [{ filename: "package-lock.json", status: "modified" }];
      },
    },
    owner: "LCV-Ideas-Software",
    repo: "example",
    number: 7,
  });
  assert.deepEqual(files, [
    { filename: "package-lock.json", status: "modified" },
  ]);
  assert.deepEqual(calls, [
    ["/repos/LCV-Ideas-Software/example/pulls/7/files", { maxPages: 30 }],
  ]);
});

test("GitHub API retries reads but never retries mutations", async () => {
  let readCalls = 0;
  const readApi = new GitHubApi("redacted", async () => {
    readCalls += 1;
    if (readCalls === 1) throw new Error("transient");
    return { ok: true, status: 200, text: async () => "{}" };
  });
  assert.deepEqual(await readApi.request("/read"), {});
  assert.equal(readCalls, 2);

  let mutationCalls = 0;
  const mutationApi = new GitHubApi("redacted", async () => {
    mutationCalls += 1;
    throw new Error("ambiguous mutation");
  });
  await assert.rejects(
    mutationApi.graphql("mutation { noop }", {}),
    /transport failure/i,
  );
  assert.equal(mutationCalls, 1);
});

test("GitHub API labels JSON request bodies without mislabeling bodyless reads", async () => {
  const requests = [];
  const api = new GitHubApi("redacted", async (url, init) => {
    requests.push({ url, init });
    return { ok: true, status: 200, text: async () => "{}" };
  });
  await api.request("/bodyless");
  await api.graphql("query { viewer { login } }", {});

  assert.equal(requests[0].init.headers["Content-Type"], undefined);
  assert.equal(requests[0].init.body, undefined);
  assert.equal(requests[1].init.headers["Content-Type"], "application/json");
  assert.equal(typeof requests[1].init.body, "string");
});

test("merge-group association is nonempty, unique, and exact repository/main", () => {
  const checked = validatePolicy(policy());
  assert.equal(
    selectAssociatedPullRequests(
      [pull()],
      "LCV-Ideas-Software/example",
      checked,
    ).length,
    1,
  );
  assert.throws(
    () =>
      selectAssociatedPullRequests([], "LCV-Ideas-Software/example", checked),
    /no associated pull request/i,
  );
  assert.throws(
    () =>
      selectAssociatedPullRequests(
        [pull(), pull()],
        "LCV-Ideas-Software/example",
        checked,
      ),
    /duplicate/i,
  );
});

test("merge-group identity requires a one-at-a-time queue and exact entry", () => {
  const candidate = pull();
  const queue = {
    configuration: { maximumEntriesToBuild: 1, maximumEntriesToMerge: 1 },
    entries: {
      nodes: [
        {
          state: "AWAITING_CHECKS",
          baseCommit: { oid: BASE_SHA },
          headCommit: { oid: OTHER_SHA },
          pullRequest: {
            number: 7,
            headRefOid: SHA,
            baseRefOid: BASE_SHA,
            baseRefName: "main",
          },
        },
      ],
    },
  };
  assert.equal(
    validateMergeQueueEvidence({
      queue,
      pulls: [candidate],
      groupHead: OTHER_SHA,
      groupBase: BASE_SHA,
    }).pullRequest.number,
    7,
  );
  assert.throws(
    () =>
      validateMergeQueueEvidence({
        queue: {
          ...queue,
          configuration: { maximumEntriesToBuild: 2, maximumEntriesToMerge: 1 },
        },
        pulls: [candidate],
        groupHead: OTHER_SHA,
        groupBase: BASE_SHA,
      }),
    /maximumEntriesToBuild=1/i,
  );
  assert.throws(
    () =>
      validateMergeQueueEvidence({
        queue,
        pulls: [candidate, { ...candidate, number: 8 }],
        groupHead: OTHER_SHA,
        groupBase: BASE_SHA,
      }),
    /exactly one pull request/i,
  );
});

test("enqueue input pins expectedHeadOid and never jumps the queue", () => {
  assert.deepEqual(buildEnqueueInput("PR_node", SHA), {
    pullRequestId: "PR_node",
    expectedHeadOid: SHA,
    jump: false,
  });
  assert.throws(() => buildEnqueueInput("PR_node", "bad"), /head sha/i);
});

test("enqueue mutation is preceded by a final exact-head trust assessment", async () => {
  const trace = [];
  const outcome = await enqueueAfterFinalTrustAssessment({
    expectedHead: SHA,
    expectedBase: BASE_SHA,
    reassess: async () => {
      trace.push("reassess");
      return {
        pullRequest: { head: { sha: SHA } },
        mainSha: BASE_SHA,
      };
    },
    recheckChecks: async () => trace.push("recheck-checks"),
    scanCode: async () => trace.push("scan-code"),
    enqueueMutation: async () => {
      trace.push("enqueue");
      return "queued";
    },
  });
  assert.equal(outcome, "queued");
  assert.deepEqual(trace, [
    "reassess",
    "recheck-checks",
    "scan-code",
    "reassess",
    "recheck-checks",
    "enqueue",
  ]);

  let mutated = false;
  await assert.rejects(
    enqueueAfterFinalTrustAssessment({
      expectedHead: SHA,
      expectedBase: BASE_SHA,
      reassess: async () => {
        throw new Error("late connector finding");
      },
      recheckChecks: async () => undefined,
      scanCode: async () => undefined,
      enqueueMutation: async () => {
        mutated = true;
      },
    }),
    /late connector finding/i,
  );
  assert.equal(mutated, false);

  for (const evidence of [
    { pullRequest: { head: { sha: OTHER_SHA } }, mainSha: BASE_SHA },
    { pullRequest: { head: { sha: SHA } }, mainSha: OTHER_SHA },
  ]) {
    await assert.rejects(
      enqueueAfterFinalTrustAssessment({
        expectedHead: SHA,
        expectedBase: BASE_SHA,
        reassess: async () => evidence,
        recheckChecks: async () => undefined,
        scanCode: async () => undefined,
        enqueueMutation: async () => {
          mutated = true;
        },
      }),
      /changed at final enqueue boundary/i,
    );
  }
  assert.equal(mutated, false);

  let rechecks = 0;
  await assert.rejects(
    enqueueAfterFinalTrustAssessment({
      expectedHead: SHA,
      expectedBase: BASE_SHA,
      reassess: async () => ({
        pullRequest: { head: { sha: SHA } },
        mainSha: BASE_SHA,
      }),
      recheckChecks: async () => {
        rechecks += 1;
        if (rechecks === 2)
          throw new Error("final exact-SHA check inventory is pending");
      },
      scanCode: async () => undefined,
      enqueueMutation: async () => {
        mutated = true;
      },
    }),
    /check inventory is pending/i,
  );
  assert.equal(mutated, false);

  await assert.rejects(
    enqueueAfterFinalTrustAssessment({
      expectedHead: SHA,
      expectedBase: BASE_SHA,
      reassess: async () => ({
        pullRequest: { head: { sha: SHA } },
        mainSha: BASE_SHA,
      }),
      recheckChecks: async () => undefined,
      scanCode: async () => {
        throw new Error("late code-scanning alert");
      },
      enqueueMutation: async () => {
        mutated = true;
      },
    }),
    /late code-scanning alert/i,
  );
  assert.equal(mutated, false);
});

test("checked-in policy covers every active repository and raw analyzer wrappers", async () => {
  const raw = JSON.parse(
    await readFile(new URL("./policy.json", import.meta.url), "utf8"),
  );
  const checked = validatePolicy(raw);
  assert.deepEqual(checked.copilot_reviewer, {
    database_id: COPILOT_REVIEWER_ID,
    node_id: COPILOT_REVIEWER_NODE_ID,
    rest_review_login: "copilot-pull-request-reviewer[bot]",
    graphql_login: "copilot-pull-request-reviewer",
    inline_alias_login: "Copilot",
  });
  assert.deepEqual(Object.keys(checked.repositories).sort(), [
    ".github",
    ".github-private",
    "admin-app",
    "astrologo-app",
    "calculadora-app",
    "cross-review",
    "maestro-app",
    "mainsite-app",
    "mtasts-motor",
    "oraculo-financeiro",
    "sponsor-motor",
    "ultrabrain-mcp",
  ]);
  for (const [repo, config] of Object.entries(checked.repositories)) {
    const identities = new Set(
      config.required_checks.map(
        ({ name, app_id: appId }) => `${name}@${appId}`,
      ),
    );
    assert.ok(
      identities.has("CodeQL@57789"),
      `${repo}: missing GHAS CodeQL check`,
    );
    assert.ok(
      [...identities].some((identity) =>
        identity.startsWith("Analyze actions@15368"),
      ),
      `${repo}: missing raw CodeQL executor`,
    );
    assert.ok(
      identities.has("zizmor@57789"),
      `${repo}: missing GHAS zizmor check`,
    );
    assert.ok(
      [...identities].some((identity) => identity.startsWith("Run zizmor")),
      `${repo}: missing raw zizmor executor`,
    );
  }
  const githubPullChecks = new Set(
    requiredChecksForPhase(checked.repositories[".github"], "pull_request").map(
      ({ name, app_id: appId }) => `${name}@${appId}`,
    ),
  );
  const githubMergeChecks = new Set(
    requiredChecksForPhase(checked.repositories[".github"], "merge_group").map(
      ({ name, app_id: appId }) => `${name}@${appId}`,
    ),
  );
  assert.ok(
    githubPullChecks.has("Trusted PR controller tests@15368"),
    ".github PR phase: missing Trusted PR controller tests",
  );
  for (const name of [
    "Verify relay and recovery controller",
    "Test repository governance",
    "Verify Slack workflow app",
  ]) {
    assert.equal(
      githubPullChecks.has(`${name}@15368`),
      false,
      `.github PR phase must not require path-filtered ${name}`,
    );
    assert.ok(
      githubMergeChecks.has(`${name}@15368`),
      `.github merge-group phase: missing ${name}`,
    );
  }
});

test("workflow contracts isolate the PAT and preserve write-all", async () => {
  const engine = await readFile(new URL("./main.mjs", import.meta.url), "utf8");
  const gate = await readFile(
    new URL("../.github/workflows/trusted-pr-gate.yml", import.meta.url),
    "utf8",
  );
  const controller = await readFile(
    new URL("../.github/workflows/trusted-pr-controller.yml", import.meta.url),
    "utf8",
  );
  const controllerCi = await readFile(
    new URL(
      "../.github/workflows/trusted-pr-controller-ci.yml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(gate, /pull_request:/);
  assert.match(gate, /ready_for_review/);
  assert.doesNotMatch(gate, /\bedited\b/);
  assert.match(gate, /merge_group:/);
  assert.match(gate, /permissions:\s+write-all/);
  assert.match(gate, /repository:\s+\$\{\{ job\.workflow_repository \}\}/);
  assert.match(gate, /ref:\s+\$\{\{ job\.workflow_sha \}\}/);
  assert.doesNotMatch(gate, /LCV_AUTOMATION_TOKEN|github-administration/);

  assert.match(controller, /permissions:\s+write-all/);
  assert.match(controller, /environment:\s+github-administration/);
  assert.match(controller, /secrets\.LCV_AUTOMATION_TOKEN/);
  assert.match(controller, /schedule:/);

  assert.match(controllerCi, /pull_request:/);
  assert.match(controllerCi, /merge_group:/);
  assert.match(controllerCi, /permissions:\s+write-all/);
  assert.doesNotMatch(
    controllerCi,
    /LCV_AUTOMATION_TOKEN|github-administration/,
  );

  assert.match(engine, /enqueuePullRequest/);
  assert.match(engine, /expectedHeadOid/);
  assert.match(engine, /pullRequestReview \{ databaseId commit \{ oid \} \}/);
  assert.match(engine, /\/requested_reviewers/);
  assert.match(engine, /recheckChecks/);
  assert.match(engine, /scanCode/);
  assert.doesNotMatch(
    engine,
    /\/pulls\/[^`"']*\/merge|mergePullRequest|enablePullRequestAutoMerge/,
  );
});
