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

const automaticEventIsEligible = ({
  action,
  author = 49699333,
  sender = 49699333,
  repository = "LCV-Ideas-Software/.github",
  headRepository = repository,
  headRef = "dependabot/npm_and_yarn/example-1.2.3",
  draft = false,
}) =>
  author === 49699333 &&
  repository === headRepository &&
  headRef.startsWith("dependabot/") &&
  draft === false &&
  sender === 49699333 &&
  ["opened", "synchronize"].includes(action);

test("the automatic path is limited to canonical Dependabot events", () => {
  assert.equal(
    normalizedJobCondition("enable-dependabot"),
    "github.event.pull_request.user.id == 49699333 && github.repository == github.event.pull_request.head.repo.full_name && startsWith(github.event.pull_request.head.ref, 'dependabot/') && github.event.pull_request.draft == false && github.event_name == 'pull_request' && github.event.sender.id == 49699333 && ( github.event.action == 'opened' || github.event.action == 'synchronize' )",
  );
  for (const action of ["opened", "synchronize"]) {
    assert.equal(automaticEventIsEligible({ action }), true);
  }
  assert.equal(automaticEventIsEligible({ action: "reopened" }), false);
  assert.equal(automaticEventIsEligible({ action: "ready_for_review" }), false);
  assert.equal(automaticEventIsEligible({ action: "opened", author: 1 }), false);
  assert.equal(automaticEventIsEligible({ action: "opened", sender: 1 }), false);
  assert.equal(
    automaticEventIsEligible({ action: "opened", headRepository: "attacker/fork" }),
    false,
  );
  assert.equal(
    automaticEventIsEligible({ action: "opened", headRef: "feature/example" }),
    false,
  );
  assert.equal(automaticEventIsEligible({ action: "opened", draft: true }), false);
});

test("the exceptional path is a main-only first-attempt operator dispatch", () => {
  assert.equal(
    normalizedJobCondition("enable-operator-dispatch"),
    "github.event_name == 'workflow_dispatch' && github.actor_id == '268063598' && github.actor == 'lcv-leo' && github.triggering_actor == github.actor && github.run_attempt == 1 && github.ref == 'refs/heads/main'",
  );
  assert.match(workflow, /workflow_dispatch:\n    inputs:\n      pull_request_number:/);
  assert.match(workflow, /name: dependabot-automation\n      deployment: false/);
  assert.match(workflow, /\[\[ "\$PR_NUMBER" =~ \^\[1-9\]\[0-9\]\*\$ \]\]/);
  assert.match(workflow, /\.state == "open"/);
  assert.match(workflow, /\.draft == false/);
  assert.match(workflow, /\.base\.ref == "main"/);
  assert.match(workflow, /\.head\.repo\.full_name == \$repository/);
  assert.match(workflow, /\.head\.ref \| startswith\("dependabot\/"\)/);
  assert.match(workflow, /\.user\.id == 49699333/);
  assert.match(workflow, /\.user\.login == "dependabot\[bot\]"/);
});

test("no privileged pull-request trigger remains", () => {
  assert.doesNotMatch(workflow, /pull_request_target:/);
  assert.doesNotMatch(workflow, /workflow_run:/);
  assert.doesNotMatch(workflow, /issue_comment:/);
  assert.match(
    workflow,
    /pull_request:\n    branches:[\s\S]*?types:\n      - opened\n      - synchronize\n  workflow_dispatch:/,
  );
});

test("both paths retain exact-head provenance and native merge guards", () => {
  assert.equal(
    workflow.match(/gh api "repos\/\$\{REPOSITORY\}\/commits\/\$\{HEAD_SHA\}"/g)
      ?.length,
    2,
  );
  assert.equal(
    workflow.match(/gh pr merge --auto --match-head-commit "\$HEAD_SHA" "\$PR_URL"/g)
      ?.length,
    2,
  );
  assert.match(workflow, /\.author\.id == 49699333/);
  assert.match(workflow, /\.author\.login == "dependabot\[bot\]"/);
  assert.match(workflow, /\.committer\.login == "web-flow"/);
  assert.match(workflow, /\.commit\.verification\.verified == true/);
  assert.match(workflow, /\.commit\.verification\.reason == "valid"/);
});

test("policy documents the automatic path and trusted manual fallback", () => {
  for (const document of [securityPolicy, contributing]) {
    assert.match(document, /`pull_request`/);
    assert.match(document, /`workflow_dispatch`/);
    assert.doesNotMatch(document, /`pull_request_target`/);
  }
  assert.match(securityPolicy, /Actions and Dependabot stores/);
  assert.match(securityPolicy, /`dependabot-automation`/);
  assert.match(contributing, /`dependabot-automation` environment/);
});
