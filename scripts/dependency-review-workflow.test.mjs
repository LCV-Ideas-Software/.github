import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(
  new URL("../.github/workflows/dependency-review.yml", import.meta.url),
  "utf8",
);
const zizmorWorkflow = await readFile(
  new URL("../.github/workflows/zizmor.yml", import.meta.url),
  "utf8",
);

function zizmorJobPermissions(source) {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const start = lines.indexOf("    permissions:");
  assert.notEqual(start, -1, "Zizmor job permissions must be present");
  let end = start + 1;
  while (end < lines.length && lines[end].startsWith("      ")) {
    end += 1;
  }
  return lines.slice(start, end).join("\n");
}

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

test("Dependency Review validates the GitHub Actions pin auditor", () => {
  assert.match(
    workflow,
    /^\s{6}- name: Test GitHub Actions pin auditor\n\s{8}run: node --test scripts\/github-actions-pin-audit\.test\.mjs$/m,
  );
});

test("reusable Zizmor grants the minimum metadata access required by SARIF upload", () => {
  assert.match(zizmorWorkflow, /^permissions:\s*\{\}\s*$/m);
  assert.doesNotMatch(zizmorWorkflow, /permissions:\s*write-all/);
  assert.equal(
    zizmorJobPermissions(zizmorWorkflow),
    [
      "    permissions:",
      "      actions: read # CodeQL upload-sarif reads workflow-run metadata.",
      "      contents: read",
      "      security-events: write # Upload the SARIF to GitHub code scanning.",
    ].join("\n"),
  );
});
