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

function workflowJobNames(source) {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const jobsStart = lines.indexOf("jobs:");
  assert.notEqual(jobsStart, -1, "jobs mapping must be present");
  const names = [];
  for (const line of lines.slice(jobsStart + 1)) {
    const visible = line.trim();
    if (visible === "" || visible.startsWith("#")) {
      continue;
    }
    const indentation = line.length - line.trimStart().length;
    if (indentation === 0) {
      break;
    }
    if (indentation === 2 && visible.endsWith(":")) {
      names.push(visible.slice(0, -1));
    }
  }
  return names;
}

function zizmorJobBlock(source) {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const jobsStart = lines.indexOf("jobs:");
  assert.notEqual(jobsStart, -1, "Zizmor jobs mapping must be present");
  const jobStart = lines.indexOf("  zizmor:", jobsStart + 1);
  assert.notEqual(jobStart, -1, "Zizmor job must be present");
  const block = [lines[jobStart]];
  for (const line of lines.slice(jobStart + 1)) {
    const visible = line.trim();
    if (visible === "" || visible.startsWith("#")) {
      continue;
    }
    const indentation = line.length - line.trimStart().length;
    if (indentation <= 2) {
      break;
    }
    block.push(line);
  }
  return block;
}

function zizmorJobPermissions(source) {
  const job = zizmorJobBlock(source);
  const starts = job.flatMap((line, index) =>
    line === "    permissions:" ? [index] : [],
  );
  assert.deepEqual(
    starts,
    [2],
    "Zizmor must have one permission map immediately after its name",
  );
  const block = [job[starts[0]]];
  for (const line of job.slice(starts[0] + 1)) {
    const indentation = line.length - line.trimStart().length;
    if (indentation <= 4) {
      break;
    }
    block.push(line);
  }
  return block.join("\n");
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
  assert.deepEqual(workflowJobNames(zizmorWorkflow), ["zizmor"]);
  assert.equal(
    zizmorJobBlock(zizmorWorkflow)[0],
    "  zizmor:",
    "the permission contract must stay anchored to the named Zizmor job",
  );
  const expectedPermissions = [
    "    permissions:",
    "      actions: read # CodeQL upload-sarif reads workflow-run metadata.",
    "      contents: read",
    "      security-events: write # Upload the SARIF to GitHub code scanning.",
  ].join("\n");
  assert.equal(zizmorJobPermissions(zizmorWorkflow), expectedPermissions);
  const overprivilegedAfterBlankLine = zizmorWorkflow.replace(
    "      security-events: write # Upload the SARIF to GitHub code scanning.\n",
    "      security-events: write # Upload the SARIF to GitHub code scanning.\n\n      id-token: write\n",
  );
  assert.notEqual(
    zizmorJobPermissions(overprivilegedAfterBlankLine),
    expectedPermissions,
    "a blank line must not hide an extra permission",
  );
  const precedingJob = zizmorWorkflow.replace(
    "jobs:\n  zizmor:",
    "jobs:\n  impostor:\n    permissions:\n      actions: read\n  zizmor:",
  );
  assert.notDeepEqual(
    workflowJobNames(precedingJob),
    ["zizmor"],
    "a preceding job must violate the exact job inventory",
  );
});
