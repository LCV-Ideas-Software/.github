import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  classifyChecks,
  evaluateExactHeadReviews,
  hasRecentAutomationRebaseRequest,
  hasTrustedDependabotCommitSet,
  isAllowedDependabotPath,
  isTrustedPullRequest,
  parseRequiredChecks,
} from "./dependabot-automerge-controller.mjs";

const requiredChecks = ["CI", "CodeQL"];
let nextId = 1;
const successful = (name, overrides = {}) => ({
  id: nextId++,
  name,
  status: "completed",
  conclusion: "success",
  app: { slug: "github-actions" },
  details_url: "https://github.test/actions/runs/10",
  ...overrides,
});

test("parses a unique, non-empty required-check list", () => {
  assert.deepEqual(parseRequiredChecks('["CI","CodeQL"]'), requiredChecks);
  assert.throws(() => parseRequiredChecks("[]"), /non-empty/);
  assert.throws(() => parseRequiredChecks('["CI","CI"]'), /duplicate/);
});

test("accepts only same-repository Dependabot PRs targeting main", () => {
  const pull = {
    state: "open",
    draft: false,
    user: { login: "dependabot[bot]" },
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
      { ...pull, head: { ...pull.head, repo: { full_name: "fork/repo" } } },
      "owner/repo",
    ),
    false,
  );
});

test("requires one verified Dependabot-authored commit at the exact head", () => {
  const head = "a".repeat(40);
  const commit = {
    sha: head,
    author: { login: "dependabot[bot]" },
    committer: { login: "web-flow" },
    commit: {
      author: { email: "49699333+dependabot[bot]@users.noreply.github.com" },
      verification: { verified: true },
    },
    parents: [{ sha: "b".repeat(40) }],
  };
  assert.equal(hasTrustedDependabotCommitSet([commit], head), true);
  assert.equal(
    hasTrustedDependabotCommitSet([{ ...commit, sha: "c".repeat(40) }], head),
    false,
  );
  assert.equal(hasTrustedDependabotCommitSet([commit, commit], head), false);
  assert.equal(
    hasTrustedDependabotCommitSet(
      [{ ...commit, author: { login: "attacker" } }],
      head,
    ),
    false,
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
      checkRuns: requiredChecks.map((name) => successful(name)),
      requiredChecks,
    }).state,
    "success",
  );
});

test("fails closed on attached optional failures", () => {
  const checkRuns = [
    ...requiredChecks.map((name) => successful(name)),
    successful("Security audit", { conclusion: "failure" }),
  ];
  assert.equal(classifyChecks({ checkRuns, requiredChecks }).state, "failure");
});

test("ignores only the current controller run and blocks legacy or security failures", () => {
  const checkRuns = [
    ...requiredChecks.map((name) => successful(name)),
    successful("controller", {
      status: "in_progress",
      conclusion: null,
      details_url: "https://github.test/actions/runs/123/jobs/456",
    }),
  ];
  assert.equal(
    classifyChecks({ checkRuns, requiredChecks, currentRunId: "123" }).state,
    "success",
  );
  checkRuns.push(successful("enable-automerge", { conclusion: "failure" }));
  assert.equal(
    classifyChecks({ checkRuns, requiredChecks, currentRunId: "123" }).state,
    "failure",
  );
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
  const checkRuns = requiredChecks.map((name) => successful(name));
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

test("the controller never rewrites or deletes Dependabot refs directly", async () => {
  const source = await readFile(
    new URL("./dependabot-automerge-controller.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /\/update-branch/);
  assert.doesNotMatch(source, /method:\s*["']DELETE["']/);
});
