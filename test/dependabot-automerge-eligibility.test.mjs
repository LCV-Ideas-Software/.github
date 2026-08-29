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
const signalWorkflow = readFileSync(
  join(
    repositoryRoot,
    ".github",
    "workflows",
    "dependabot-automerge-signal.yml",
  ),
  "utf8",
);
const securityPolicy = readFileSync(join(repositoryRoot, "SECURITY.md"), "utf8");
const contributing = readFileSync(
  join(repositoryRoot, "CONTRIBUTING.md"),
  "utf8",
);

const normalizedJobCondition = (document, jobId) => {
  const condition = document.match(
    new RegExp(
      `\\n  ${jobId}:[\\s\\S]*?\\n    if: >-\\n(?<body>[\\s\\S]*?)\\n    runs-on:`,
    ),
  )?.groups?.body;
  assert.ok(condition, `the ${jobId} condition must exist`);
  return condition.replace(/\s+/g, " ").trim();
};

const assertOrderedWorkflowMarkers = (document, earlier, later) => {
  const earlierIndex = document.indexOf(earlier);
  const laterIndex = document.indexOf(later);
  assert.ok(earlierIndex >= 0, `workflow marker not found: ${earlier}`);
  assert.ok(laterIndex >= 0, `workflow marker not found: ${later}`);
  assert.ok(earlierIndex < laterIndex, `${earlier} must precede ${later}`);
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

test("the unprivileged signal is limited to canonical Dependabot events", () => {
  assert.equal(
    normalizedJobCondition(signalWorkflow, "signal"),
    "github.event.pull_request.user.id == 49699333 && github.event.pull_request.user.login == 'dependabot[bot]' && github.repository == github.event.pull_request.head.repo.full_name && startsWith(github.event.pull_request.head.ref, 'dependabot/') && github.event.pull_request.draft == false && github.event.sender.id == 49699333 && github.event.sender.login == 'dependabot[bot]' && (github.event.action == 'opened' || github.event.action == 'synchronize')",
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

test("the pull-request stage cannot receive credentials or execute an action", () => {
  assert.match(signalWorkflow, /^permissions: \{\}$/m);
  assert.match(signalWorkflow, /run: ":"/);
  assert.doesNotMatch(signalWorkflow, /^\s+uses:/m);
  assert.doesNotMatch(signalWorkflow, /\$\{\{\s*secrets\./);
  assert.doesNotMatch(signalWorkflow, /\$\{\{\s*github\.token\s*\}\}/);
  assert.doesNotMatch(signalWorkflow, /pull_request_target:/);
  assert.doesNotMatch(signalWorkflow, /workflow_run:/);
});

test("the exceptional path is a main-only first-attempt operator dispatch", () => {
  assert.equal(
    normalizedJobCondition(workflow, "enable-operator-dispatch"),
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

test("automatic mutation is loaded from main after the unprivileged signal", () => {
  assert.doesNotMatch(workflow, /pull_request_target:/);
  assert.doesNotMatch(workflow, /^\s+pull_request:/m);
  assert.doesNotMatch(workflow, /issue_comment:/);
  assert.match(
    workflow,
    /workflow_run:[\s\S]*?workflows:\n      - Dependabot admission signal[\s\S]*?types:\n      - completed\n  workflow_dispatch:/,
  );
  assert.equal(
    normalizedJobCondition(workflow, "enable-dependabot"),
    "github.repository == 'LCV-Ideas-Software/.github' && github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'pull_request' && github.event.workflow_run.run_attempt == 1 && github.event.workflow_run.actor.id == 49699333 && github.event.workflow_run.actor.login == 'dependabot[bot]' && github.event.workflow_run.head_repository.full_name == github.repository",
  );
  const provenanceMarker =
    "Verify trusted workflow run, pull request, and exact head";
  const tokenMarker = "Create the repository-scoped GitHub App token";
  assertOrderedWorkflowMarkers(workflow, provenanceMarker, tokenMarker);
  assert.throws(
    () =>
      assertOrderedWorkflowMarkers(
        workflow.replace(provenanceMarker, "Removed provenance step"),
        provenanceMarker,
        tokenMarker,
      ),
    /workflow marker not found/,
  );
  assert.match(
    workflow,
    /group: dependabot-automerge-\$\{\{ github\.event\.workflow_run\.id \|\| inputs\.pull_request_number \|\| github\.run_id \}\}-\$\{\{ github\.event\.workflow_run\.run_attempt \|\| github\.run_attempt \}\}/,
  );
  assert.doesNotMatch(
    workflow,
    /group: dependabot-automerge-\$\{\{ github\.event\.workflow_run\.head_sha/,
  );
});

test("the trusted automatic stage fails closed on provenance and workflow diffs", () => {
  assert.match(workflow, /actions\/workflows\/dependabot-automerge-signal\.yml/);
  assert.match(workflow, /\.workflow_id == \$workflow_id/);
  assert.match(workflow, /\.path == \$path/);
  assert.match(workflow, /\.triggering_actor\.id == 49699333/);
  assert.match(workflow, /commits\/\$\{source_head_sha\}\/pulls\?per_page=100/);
  assert.match(workflow, /\(\.pull_requests \| length\) == 0 or/);
  assert.match(workflow, /\(\.pull_requests \| length\) == 1/);
  assert.match(workflow, /jq -e 'length == 1' <<<"\$candidates_json"/);
  assert.match(workflow, /gh api --paginate --slurp/);
  assert.match(workflow, /\.changed_files <= 3000/);
  assert.match(workflow, /\.previous_filename/);
  assert.match(workflow, /startswith\("\.github\/workflows\/"\)/);
  assert.match(workflow, /\.committer\.id == 19864447/);
  assert.match(workflow, /\.commit\.verification\.verified == true/);
  assert.match(workflow, /\.commit\.verification\.reason == "valid"/);
});

test("automatic and dispatch paths retain exact-head native merge guards", () => {
  assert.equal(
    workflow.match(/gh api "repos\/\$\{REPOSITORY\}\/commits\/\$\{(?:source_head_sha|HEAD_SHA)\}"/g)
      ?.length,
    2,
  );
  assert.equal(
    workflow.match(/gh pr merge --auto --squash --match-head-commit "\$HEAD_SHA" "\$PR_URL"/g)
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
    assert.match(document, /`workflow_run`/);
    assert.match(document, /`workflow_dispatch`/);
    assert.doesNotMatch(document, /`pull_request_target`/);
  }
  assert.match(securityPolicy, /unprivileged signal/i);
  assert.match(securityPolicy, /`dependabot-automation`/);
  assert.match(contributing, /`dependabot-automation` Actions environment/);
});
