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
const securityPolicy = readFileSync(join(repositoryRoot, "SECURITY.md"), "utf8");
const contributing = readFileSync(
  join(repositoryRoot, "CONTRIBUTING.md"),
  "utf8",
);

const normalizedJobCondition = (jobId) => {
  const condition = workflow.match(
    new RegExp(
      `\\n  ${jobId}:[\\s\\S]*?\\n    if: >-\\n(?<body>[\\s\\S]*?)\\n    runs-on:`,
    ),
  )?.groups?.body;
  assert.ok(condition, `the ${jobId} condition must exist`);
  return condition.replace(/\s+/g, " ").trim();
};

const isEligible = ({
  action,
  actor = "dependabot[bot]",
  author = 49699333,
  eventName = "pull_request",
  sender = 49699333,
  repository = "LCV-Ideas-Software/.github",
  headRepository = repository,
  draft = false,
}) =>
  author === 49699333 &&
  repository === headRepository &&
  draft === false &&
  ((eventName === "pull_request" &&
    sender === 49699333 &&
    ["opened", "synchronize"].includes(action)) ||
    (eventName === "pull_request_target" &&
      sender === 268063598 &&
      actor === "lcv-leo" &&
      ["ready_for_review", "reopened"].includes(action)));

test("each event context has a fail-closed eligibility condition", () => {
  assert.equal(
    normalizedJobCondition("enable-dependabot"),
    "github.event.pull_request.user.id == 49699333 && github.repository == github.event.pull_request.head.repo.full_name && github.event.pull_request.draft == false && github.event_name == 'pull_request' && github.event.sender.id == 49699333 && ( github.event.action == 'opened' || github.event.action == 'synchronize' )",
  );
  assert.equal(
    normalizedJobCondition("enable-maintainer-transition"),
    "github.event.pull_request.user.id == 49699333 && github.repository == github.event.pull_request.head.repo.full_name && github.event.pull_request.draft == false && github.event_name == 'pull_request_target' && github.event.sender.id == 268063598 && github.actor == 'lcv-leo' && (github.event.action == 'ready_for_review' || github.event.action == 'reopened')",
  );
});

test("maintainer eligibility transitions are admitted for Dependabot PRs", () => {
  assert.equal(
    isEligible({
      action: "ready_for_review",
      actor: "lcv-leo",
      eventName: "pull_request_target",
      sender: 268063598,
    }),
    true,
  );
  assert.equal(
    isEligible({
      action: "reopened",
      actor: "lcv-leo",
      eventName: "pull_request_target",
      sender: 268063598,
    }),
    true,
  );
});

test("code-changing events still require Dependabot as the sender", () => {
  for (const action of ["opened", "synchronize"]) {
    assert.equal(isEligible({ action }), true);
    assert.equal(isEligible({ action, sender: 1 }), false);
  }
});

test("event triggers are disjoint and maintainer transitions use an exact allowlist", () => {
  for (const action of ["ready_for_review", "reopened"]) {
    assert.equal(isEligible({ action }), false);
    assert.equal(isEligible({ action, sender: 1 }), false);
    assert.equal(
      isEligible({
        action,
        actor: "lcv-leo",
        eventName: "pull_request_target",
        sender: 268063598,
      }),
      true,
    );
    assert.equal(
      isEligible({
        action,
        actor: "someone-else",
        eventName: "pull_request_target",
        sender: 268063598,
      }),
      false,
    );
  }
  assert.match(workflow, /pull_request:\n    branches:[\s\S]*?types:\n      - opened\n      - synchronize\n  pull_request_target:/);
  assert.match(workflow, /pull_request_target:\n    branches:[\s\S]*?types:\n      - ready_for_review\n      - reopened\n/);
  assert.match(
    workflow,
    /group: dependabot-automerge-\$\{\{ github\.event\.pull_request\.number \}\}\n/,
  );
});

test("all events preserve author, origin, draft, action, and exact-head guards", () => {
  assert.equal(
    isEligible({
      action: "reopened",
      actor: "lcv-leo",
      author: 1,
      eventName: "pull_request_target",
      sender: 268063598,
    }),
    false,
  );
  assert.equal(
    isEligible(
      {
        action: "reopened",
        actor: "lcv-leo",
        eventName: "pull_request_target",
        headRepository: "attacker/fork",
        sender: 268063598,
      },
    ),
    false,
  );
  assert.equal(
    isEligible({
      action: "reopened",
      actor: "lcv-leo",
      draft: true,
      eventName: "pull_request_target",
      sender: 268063598,
    }),
    false,
  );
  assert.equal(isEligible({ action: "edited" }), false);
  assert.match(workflow, /gh pr merge --auto --match-head-commit "\$HEAD_SHA"/);
});

test("the exact head must retain GitHub-verified Dependabot provenance", () => {
  assert.equal(
    workflow.match(/gh api "repos\/\$\{REPOSITORY\}\/commits\/\$\{HEAD_SHA\}"/g)
      ?.length,
    2,
  );
  assert.match(workflow, /\.author\.id == 49699333/);
  assert.match(workflow, /\.author\.login == "dependabot\[bot\]"/);
  assert.match(workflow, /\.committer\.login == "web-flow"/);
  assert.match(workflow, /\.commit\.verification\.verified == true/);
  assert.match(workflow, /\.commit\.verification\.reason == "valid"/);
});

test("policy documents the action-specific sender and dual-secret topology", () => {
  for (const document of [securityPolicy, contributing]) {
    assert.match(document, /Dependabot-emitted events|Dependabot-emitted `pull_request` runs/);
    assert.match(document, /`ready_for_review` and `reopened`/);
    assert.match(document, /`pull_request_target`/);
  }
  assert.match(securityPolicy, /Actions and Dependabot stores/);
  assert.match(securityPolicy, /`dependabot-automation`/);
  assert.match(contributing, /`dependabot-automation` environment/);
  assert.match(workflow, /name: dependabot-automation\n      deployment: false/);
  assert.match(workflow, /pull_request_target:/);
});
