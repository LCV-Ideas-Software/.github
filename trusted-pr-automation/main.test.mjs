import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ACTIONS_APP_ID,
  CONNECTOR_APP_ID,
  CONNECTOR_ID,
  GitHubApi,
  TRUSTED_GATE_CHECK_NAME,
  allCommitsVerified,
  buildEnqueueInput,
  classifyChecks,
  controllerCheckOutcome,
  dependabotRebaseBody,
  ensureConnectorReviewRequest,
  ensureDependabotRebaseRequest,
  evaluateConnectorEvidence,
  hasReviewRequestForHead,
  isTrustedPullRequest,
  lateReviewTimeoutCommand,
  recoverLateTrustedGate,
  resolveConnectorReviewCommits,
  reviewRequestBody,
  selectAssociatedPullRequests,
  validateMergeQueueEvidence,
  validatePolicy,
  verifyCodeScanningAfterChecks,
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
    repositories: {
      example: {
        required_checks: [
          { name: "Analyze actions", app_id: ACTIONS_APP_ID },
          { name: "CodeQL", app_id: 57789 },
          { name: "Run zizmor / Run zizmor", app_id: ACTIONS_APP_ID },
          { name: "zizmor", app_id: 57789 },
        ],
      },
    },
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
});

test("validatePolicy rejects duplicate identities, duplicate checks, and self-gating", () => {
  const duplicateActor = policy();
  duplicateActor.allowed_actors.push(actor());
  assert.throws(
    () => validatePolicy(duplicateActor),
    /duplicate allowed actor/i,
  );

  const duplicateCheck = policy();
  duplicateCheck.repositories.example.required_checks.push({
    name: "CodeQL",
    app_id: 57789,
  });
  assert.throws(
    () => validatePolicy(duplicateCheck),
    /duplicate required check/i,
  );

  const recursive = policy();
  recursive.repositories.example.required_checks.push({
    name: TRUSTED_GATE_CHECK_NAME,
    app_id: ACTIONS_APP_ID,
  });
  assert.throws(() => validatePolicy(recursive), /must not require itself/i);
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

test("controller reruns a timed-out trusted gate once only after later clean evidence", async () => {
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

  await assert.rejects(
    recoverLateTrustedGate({
      api,
      owner: "LCV-Ideas-Software",
      repo: "example",
      headSha: SHA,
      cleanAt: Date.parse("2026-08-08T11:59:00Z"),
      checkRuns: [gateFailure],
    }),
    /failed after clean evidence/i,
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

test("checked-in policy covers every active repository and raw analyzer wrappers", async () => {
  const raw = JSON.parse(
    await readFile(new URL("./policy.json", import.meta.url), "utf8"),
  );
  const checked = validatePolicy(raw);
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
  const githubChecks = new Set(
    checked.repositories[".github"].required_checks.map(
      ({ name, app_id: appId }) => `${name}@${appId}`,
    ),
  );
  for (const name of [
    "Trusted PR controller tests",
    "Verify relay and recovery controller",
    "Test repository governance",
    "Verify Slack workflow app",
  ]) {
    assert.ok(githubChecks.has(`${name}@15368`), `.github: missing ${name}`);
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
  assert.doesNotMatch(
    engine,
    /\/pulls\/[^`"']*\/merge|mergePullRequest|enablePullRequestAutoMerge/,
  );
});
