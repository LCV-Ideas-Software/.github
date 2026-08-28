import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("Dependabot eligibility events trust the immutable PR author, not the event sender", () => {
  const workflow = readFileSync(
    join(repositoryRoot, ".github", "workflows", "dependabot-automerge.yml"),
    "utf8",
  );

  assert.match(workflow, /- ready_for_review/);
  assert.match(workflow, /- reopened/);
  assert.match(workflow, /github\.event\.pull_request\.user\.id == 49699333/);
  assert.doesNotMatch(workflow, /github\.event\.sender\.id/);
  assert.match(
    workflow,
    /github\.repository == github\.event\.pull_request\.head\.repo\.full_name/,
  );
  assert.match(workflow, /github\.event\.pull_request\.draft == false/);
  assert.match(workflow, /gh pr merge --auto --match-head-commit "\$HEAD_SHA"/);
});
