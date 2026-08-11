import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const WORKFLOW_URL = new URL(
  "../.github/workflows/scorecard.yml",
  import.meta.url,
);

const APPROVED_ANALYSIS_ACTIONS = [
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  "ossf/scorecard-action@2d1146689b8cda280b9bc96326124645441f03bc",
  "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  "github/codeql-action/upload-sarif@5595ccaf912efad79be6eef63a5619ff05969be3",
];

function namedJob(workflow, id) {
  const lines = workflow.split(/\r?\n/);
  const start = lines.indexOf(`  ${id}:`);
  assert.notEqual(start, -1, `missing workflow job: ${id}`);

  let end = start + 1;
  while (end < lines.length && !/^  [a-zA-Z0-9_-]+:$/.test(lines[end])) {
    end += 1;
  }
  return lines.slice(start, end).join("\n");
}

function namedStep(job, name) {
  const lines = job.split(/\r?\n/);
  const start = lines.indexOf(`      - name: ${name}`);
  assert.notEqual(start, -1, `missing workflow step: ${name}`);

  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith("      - ")) end += 1;
  return lines.slice(start, end).join("\n");
}

function usedActions(job) {
  return [...job.matchAll(/^\s+uses:\s+([^\s#]+)/gm)].map(
    ([, action]) => action,
  );
}

test("Scorecard runs only on supported default-branch events", async () => {
  const workflow = await readFile(WORKFLOW_URL, "utf8");

  assert.match(workflow, /\n  push:\n(?:    #.*\n)*    branches: \["main"\]/);
  assert.match(workflow, /\n  schedule:\n[\s\S]*?- cron: "37 8 \* \* \*"/);
  for (const unsupported of [
    "pull_request",
    "pull_request_target",
    "merge_group",
    "workflow_dispatch",
    "workflow_call",
  ]) {
    assert.doesNotMatch(workflow, new RegExp(`^  ${unsupported}:`, "m"));
  }
  assert.doesNotMatch(workflow, /^\s{4}paths:/m);
});

test("the publishing job satisfies OpenSSF's OIDC workflow restrictions", async () => {
  const workflow = await readFile(WORKFLOW_URL, "utf8");
  const analysis = namedJob(workflow, "analysis");

  assert.match(workflow, /^permissions: \{\}$/m);
  assert.doesNotMatch(workflow, /^(env|defaults):/m);
  assert.doesNotMatch(workflow, /permissions:\s*write-all/);
  assert.match(
    analysis,
    /\n    permissions:\n      contents: read\n      security-events: write # Upload the SARIF to GitHub code scanning\.\n      id-token: write # Authenticate publication to api\.scorecard\.dev via OIDC\.\n/,
  );
  assert.doesNotMatch(analysis, /^    (env|defaults|container|services):/m);
  assert.doesNotMatch(analysis, /^\s+run:/m);
  assert.deepEqual(usedActions(analysis), APPROVED_ANALYSIS_ACTIONS);

  const scorecard = namedStep(analysis, "Run OpenSSF Scorecard");
  assert.match(
    scorecard,
    /uses: ossf\/scorecard-action@2d1146689b8cda280b9bc96326124645441f03bc # v2\.4\.4/,
  );
  assert.match(scorecard, /results_file: scorecard-results\.sarif/);
  assert.match(scorecard, /results_format: sarif/);
  assert.match(scorecard, /publish_results: true/);
  assert.doesNotMatch(scorecard, /continue-on-error:/);

  assert.equal(
    workflow.match(/^      id-token: write(?: #.*)?$/gm)?.length,
    1,
    "only the publishing job may request an OIDC token",
  );
  assert.doesNotMatch(workflow, /publish_results:\s*false/);
  assert.doesNotMatch(workflow, /^.*ghcr\.io\/ossf\/scorecard-action.*$/m);
});

test("policy enforcement is isolated from the OIDC publisher", async () => {
  const workflow = await readFile(WORKFLOW_URL, "utf8");
  const policy = namedJob(workflow, "policy");

  assert.match(policy, /\n    needs: analysis\n/);
  assert.match(policy, /\n    permissions:\n      contents: read\n/);
  assert.doesNotMatch(policy, /id-token:|security-events:|write-all/);
  assert.deepEqual(usedActions(policy), [
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
  ]);

  const download = namedStep(policy, "Download Scorecard SARIF");
  assert.match(download, /name: scorecard-results/);
  assert.match(download, /path: \./);

  const regression = namedStep(policy, "Test Scorecard policy contracts");
  assert.match(
    regression,
    /node --test\s+scripts\/scorecard-workflow\.test\.mjs\s+scripts\/scorecard-policy\.test\.mjs/,
  );
  assert.doesNotMatch(regression, /continue-on-error:/);

  const requireSarif = namedStep(policy, "Require Scorecard SARIF");
  assert.match(requireSarif, /test -s scorecard-results\.sarif/);

  const enforcement = namedStep(
    policy,
    "Enforce the approved Scorecard policy",
  );
  assert.match(
    enforcement,
    /jq -e --arg event "\$GITHUB_EVENT_NAME"\s+-f scripts\/scorecard-policy\.jq scorecard-results\.sarif/,
  );
  assert.doesNotMatch(enforcement, /continue-on-error:/);
});
