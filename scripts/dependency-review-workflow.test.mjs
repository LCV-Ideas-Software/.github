import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(
  new URL("../.github/workflows/dependency-review.yml", import.meta.url),
  "utf8",
);

test("Dependency Review scans same-repository and fork pull requests", () => {
  assert.doesNotMatch(
    workflow,
    /^\s{4}if:\s.*pull_request\.head\.repo\.full_name/m,
    "the job must not skip fork pull requests",
  );
  assert.match(workflow, /^\s{2}pull_request:\s*$/m);
  assert.match(workflow, /^\s{2}merge_group:\s*$/m);
});

test("Dependency Review remains read-only and fail-closed at low severity", () => {
  assert.match(workflow, /^permissions:\s*\{\}\s*$/m);
  assert.match(workflow, /^\s{6}contents:\s*read\s*$/m);
  assert.equal((workflow.match(/fail-on-severity:\s*low/g) ?? []).length, 2);
  assert.equal(
    (workflow.match(/fail-on-scopes:\s*runtime, development, unknown/g) ?? [])
      .length,
    2,
  );
});
