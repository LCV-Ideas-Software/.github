import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const workflow = readFileSync(
  join(repositoryRoot, ".github", "workflows", "dependabot-automerge.yml"),
  "utf8",
);

const condition = workflow.match(/\n    if: >-\n(?<body>[\s\S]*?)\n    runs-on:/)?.groups
  ?.body;
assert.ok(condition, "the workflow job condition must exist");

const normalizedCondition = condition.replace(/\s+/g, " ").trim();

const isEligible = ({
  action,
  author = 49699333,
  sender = 49699333,
  repository = "LCV-Ideas-Software/.github",
  headRepository = repository,
  draft = false,
}) =>
  author === 49699333 &&
  repository === headRepository &&
  draft === false &&
  (action === "ready_for_review" ||
    action === "reopened" ||
    ((action === "opened" || action === "synchronize") &&
      sender === 49699333));

test("the workflow condition matches the reviewed eligibility policy", () => {
  assert.equal(
    normalizedCondition,
    "github.event.pull_request.user.id == 49699333 && github.repository == github.event.pull_request.head.repo.full_name && github.event.pull_request.draft == false && ( github.event.action == 'ready_for_review' || github.event.action == 'reopened' || ( (github.event.action == 'opened' || github.event.action == 'synchronize') && github.event.sender.id == 49699333 ) )",
  );
});

test("maintainer eligibility transitions are admitted for Dependabot PRs", () => {
  assert.equal(
    isEligible({ action: "ready_for_review", sender: 1 }),
    true,
  );
  assert.equal(
    isEligible({ action: "reopened", sender: 1 }),
    true,
  );
});

test("code-changing events still require Dependabot as the sender", () => {
  for (const action of ["opened", "synchronize"]) {
    assert.equal(isEligible({ action }), true);
    assert.equal(
      isEligible({ action, sender: 1 }),
      false,
    );
  }
});

test("all events preserve author, origin, draft, action, and exact-head guards", () => {
  assert.equal(
    isEligible({ action: "reopened", author: 1 }),
    false,
  );
  assert.equal(
    isEligible(
      {
        action: "reopened",
        headRepository: "attacker/fork",
      },
    ),
    false,
  );
  assert.equal(
    isEligible({ action: "reopened", draft: true }),
    false,
  );
  assert.equal(isEligible({ action: "edited" }), false);
  assert.match(workflow, /gh pr merge --auto --match-head-commit "\$HEAD_SHA"/);
});
