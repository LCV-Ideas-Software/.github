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
    if (indentation === 2) {
      const separator = visible.indexOf(":");
      assert.notEqual(separator, -1, "every job entry must contain a colon");
      names.push(visible.slice(0, separator));
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

function literalRunBlocks(source) {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)run:\s*\|\s*$/u.exec(lines[index]);
    if (!match) continue;
    const indentation = match[1].length;
    const block = [];
    for (const line of lines.slice(index + 1)) {
      if (
        line.trim() !== "" &&
        line.length - line.trimStart().length <= indentation
      ) {
        break;
      }
      block.push(line);
    }
    blocks.push(block.join("\n"));
  }
  return blocks;
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
  const inlineJob = zizmorWorkflow.replace(
    "jobs:\n  zizmor:",
    "jobs:\n  impostor: { runs-on: ubuntu-latest, steps: [] }\n  zizmor:",
  );
  assert.notDeepEqual(
    workflowJobNames(inlineJob),
    ["zizmor"],
    "an inline job must violate the exact job inventory",
  );
});

test("reusable Zizmor validates immutable policy snapshots before analysis", () => {
  assert.match(zizmorWorkflow, /^  workflow_call:\s*\n  push:/mu);
  const tooling = [
    ".github/zizmor/Dockerfile",
    ".github/zizmor/policy-baselines.v1.json",
    "scripts/zizmor-policy-baseline.mjs",
  ];
  for (const path of tooling) {
    assert.match(
      zizmorWorkflow,
      new RegExp(`^\\s{12}${path.replaceAll(".", "\\.")}$`, "m"),
    );
  }

  const resolve = zizmorWorkflow.indexOf(
    "      - name: Resolve immutable Zizmor policy snapshots",
  );
  const candidate = zizmorWorkflow.indexOf(
    "      - name: Checkout candidate repository snapshot",
  );
  const base = zizmorWorkflow.indexOf(
    "      - name: Checkout base repository snapshot",
  );
  const validate = zizmorWorkflow.indexOf(
    "      - name: Validate immutable Zizmor policy baseline",
  );
  const build = zizmorWorkflow.indexOf(
    "      - name: Build the digest-pinned zizmor runtime",
  );
  assert.ok(
    0 <= resolve && resolve < candidate && candidate < base && base < validate,
    "snapshot resolution, explicit checkouts, and validation must remain ordered",
  );
  assert.ok(
    validate < build,
    "the baseline must be validated before tool execution",
  );

  assert.match(
    zizmorWorkflow,
    /node \.lcv-zizmor-tooling\/scripts\/zizmor-policy-baseline\.mjs resolve \\\n\s+--event-path "\$GITHUB_EVENT_PATH" \\\n\s+--event "\$GITHUB_EVENT_NAME" \\\n\s+--repository "\$GITHUB_REPOSITORY" \\\n\s+--sha "\$GITHUB_SHA" \\\n\s+--ref "\$GITHUB_REF" \\\n\s+--output "\$GITHUB_OUTPUT"/u,
  );
  assert.match(
    zizmorWorkflow,
    /node \.lcv-zizmor-tooling\/scripts\/zizmor-policy-baseline\.mjs validate \\\n\s+--manifest \.lcv-zizmor-tooling\/\.github\/zizmor\/policy-baselines\.v1\.json \\\n\s+--repository "\$GITHUB_REPOSITORY" \\\n\s+--base-dir \.lcv-audit-base \\\n\s+--base-sha "\$BASE_SHA" \\\n\s+--candidate-dir \.lcv-audit-target \\\n\s+--candidate-sha "\$CANDIDATE_SHA"/u,
  );
  assert.doesNotMatch(zizmorWorkflow, /--no-ignores|--config(?:=|\s)/u);
  assert.doesNotMatch(
    zizmorWorkflow,
    /(?:^|\s)node\s+\.lcv-audit-(?:base|target)\//mu,
    "the reusable workflow must never execute code from either audited snapshot",
  );
  for (const run of literalRunBlocks(zizmorWorkflow)) {
    assert.doesNotMatch(
      run,
      /\$\{\{/u,
      "GitHub contexts must cross into shell only through fixed environment variables",
    );
  }
});
