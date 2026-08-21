import assert from "node:assert/strict";
import test from "node:test";

import {
  decidePullAction,
  isCanonicalDependabotPull,
  isCanonicalGraphPull,
  processPullRequest,
  validateRepository,
} from "../dependabot-automerge/main.mjs";

const settings = {
  archived: false,
  allow_auto_merge: true,
  allow_update_branch: true,
  allow_squash_merge: true,
  allow_merge_commit: false,
  allow_rebase_merge: false,
};

const rules = [
  { type: "merge_queue" },
  {
    type: "required_status_checks",
    parameters: { required_status_checks: [{ context: "CI" }] },
  },
];

const restPull = {
  state: "open",
  draft: false,
  user: { login: "dependabot[bot]", id: 49699333 },
  base: { ref: "main" },
  head: {
    ref: "dependabot/npm_and_yarn/example-2.0.0",
    sha: "a".repeat(40),
    repo: { full_name: "LCV-Ideas-Software/example" },
  },
};

function graphPull(overrides = {}) {
  return {
    id: "PR_node",
    number: 42,
    state: "OPEN",
    isDraft: false,
    author: { login: "dependabot", databaseId: 49699333 },
    baseRefName: "main",
    headRefName: "dependabot/npm_and_yarn/example-2.0.0",
    headRepository: { nameWithOwner: "LCV-Ideas-Software/example" },
    headRefOid: "a".repeat(40),
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    autoMergeRequest: null,
    mergeQueueEntry: null,
    ...overrides,
  };
}

test("repository gate requires both native capabilities and effective queue checks", () => {
  assert.doesNotThrow(() => validateRepository(settings, rules));
  assert.throws(
    () => validateRepository({ ...settings, allow_auto_merge: false }, rules),
    /allow_auto_merge/,
  );
  assert.throws(
    () => validateRepository(settings, [{ type: "merge_queue" }]),
    /status check/,
  );
});

test("only an exact same-repository Dependabot PR is accepted", () => {
  assert.equal(
    isCanonicalDependabotPull(restPull, "LCV-Ideas-Software/example", "main"),
    true,
  );
  assert.equal(
    isCanonicalDependabotPull(
      { ...restPull, user: { login: "dependabot[bot]", id: 1 } },
      "LCV-Ideas-Software/example",
      "main",
    ),
    false,
  );
  assert.equal(
    isCanonicalDependabotPull(
      {
        ...restPull,
        head: { ...restPull.head, repo: { full_name: "fork/example" } },
      },
      "LCV-Ideas-Software/example",
      "main",
    ),
    false,
  );
});

test("the final GraphQL read revalidates identity, repository, branch, and base", () => {
  assert.equal(
    isCanonicalGraphPull(graphPull(), "LCV-Ideas-Software/example", "main"),
    true,
  );
  assert.equal(
    isCanonicalGraphPull(
      graphPull({ baseRefName: "preview" }),
      "LCV-Ideas-Software/example",
      "main",
    ),
    false,
  );
  assert.equal(
    isCanonicalGraphPull(
      graphPull({ author: { login: "dependabot", databaseId: 1 } }),
      "LCV-Ideas-Software/example",
      "main",
    ),
    false,
  );
});

test("decision is idempotent and fail-closed", () => {
  assert.equal(decidePullAction(graphPull()), "enqueue");
  assert.equal(
    decidePullAction(graphPull({ mergeStateStatus: "BEHIND" })),
    "update-branch",
  );
  assert.equal(
    decidePullAction(graphPull({ mergeStateStatus: "BLOCKED" })),
    "enable-auto-merge",
  );
  assert.equal(
    decidePullAction(graphPull({ mergeable: "CONFLICTING" })),
    "manual-conflict",
  );
  assert.equal(
    decidePullAction(graphPull({ autoMergeRequest: { enabledAt: "now" } })),
    "already-armed",
  );
});

test("behind branch is rebased with the exact old head and not armed in the same pass", async () => {
  const calls = [];
  const pull = graphPull({ mergeStateStatus: "BEHIND" });
  const api = {
    updateBranch: async (id, head) => {
      calls.push(["update", id, head]);
      return { headRefOid: "b".repeat(40) };
    },
    enqueue: async () => calls.push(["enqueue"]),
    enableAutoMerge: async () => calls.push(["auto"]),
  };
  const result = await processPullRequest(pull, api);
  assert.equal(result.action, "update-branch");
  assert.deepEqual(calls, [["update", "PR_node", "a".repeat(40)]]);
});

test("clean PR is queued and read back on the same head", async () => {
  const calls = [];
  const pull = graphPull();
  const api = {
    enqueue: async (id, head) => calls.push(["enqueue", id, head]),
    getPull: async () =>
      graphPull({ mergeQueueEntry: { position: 1, state: "QUEUED" } }),
  };
  const result = await processPullRequest(pull, api);
  assert.equal(result.action, "enqueue");
  assert.deepEqual(calls, [["enqueue", "PR_node", "a".repeat(40)]]);
});

test("blocked PR receives auto-merge and is read back on the same head", async () => {
  const calls = [];
  const pull = graphPull({ mergeStateStatus: "BLOCKED" });
  const api = {
    enableAutoMerge: async (id, head) => calls.push(["auto", id, head]),
    getPull: async () =>
      graphPull({
        mergeStateStatus: "BLOCKED",
        autoMergeRequest: { enabledAt: "now" },
      }),
  };
  const result = await processPullRequest(pull, api);
  assert.equal(result.action, "enable-auto-merge");
  assert.deepEqual(calls, [["auto", "PR_node", "a".repeat(40)]]);
});
