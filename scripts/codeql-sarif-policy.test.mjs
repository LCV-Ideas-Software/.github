import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const POLICY_URL = new URL("./codeql-sarif-policy.jq", import.meta.url);
const WORKFLOW_URL = new URL(
  "../.github/workflows/codeql.yml",
  import.meta.url,
);

function sarif(run = {}) {
  return {
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "CodeQL" } },
        ...run,
      },
    ],
  };
}

function evaluate(...documents) {
  return spawnSync("jq", ["-ce", "-s", "-f", fileURLToPath(POLICY_URL)], {
    encoding: "utf8",
    input: documents.map((document) => JSON.stringify(document)).join("\n"),
  });
}

function assertAccepted(documents, expected = []) {
  const result = evaluate(...documents);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), expected);
}

function assertRejected(...documents) {
  const result = evaluate(...documents);
  assert.notEqual(result.status, 0, "Malformed SARIF was accepted.");
}

test("valid CodeQL SARIF with no inline results is accepted", () => {
  assertAccepted([sarif({ results: [] })]);
  assertAccepted([{ ...sarif({ results: [] }), inlineExternalProperties: [] }]);
  assertAccepted([sarif({ results: [], externalPropertyFileReferences: {} })]);
  assertAccepted([sarif({ results: [], invocations: [] })]);
  assertAccepted([
    sarif({
      results: [],
      invocations: [
        {
          executionSuccessful: true,
          toolExecutionNotifications: [{ level: "warning" }],
          toolConfigurationNotifications: [{ level: "note" }],
        },
      ],
    }),
  ]);
});

test("malformed or empty SARIF shapes fail closed", () => {
  for (const invalid of [
    null,
    false,
    0,
    "",
    [],
    {},
    { version: "2.1.0" },
    { version: "2.1.0", runs: null },
    { version: "2.1.0", runs: [] },
    { version: "2.2.0", runs: [] },
    { version: "2.1.0", runs: [null] },
    { version: "2.1.0", runs: [{}] },
    sarif(),
    sarif({ results: null }),
    sarif({ results: {} }),
    sarif({ results: [null] }),
    sarif({
      results: [],
      tool: { driver: { name: "Another analyzer" } },
    }),
    sarif({
      results: [],
      conversion: {
        tool: { driver: { name: "SARIF converter" } },
        invocation: {
          executionSuccessful: false,
          toolExecutionNotifications: [{ level: "error" }],
        },
      },
    }),
    sarif({
      results: [],
      conversion: {
        tool: { driver: { name: "GitHub Code Scanning" } },
      },
    }),
    sarif({ results: [], invocations: null }),
    sarif({ results: [], invocations: [null] }),
    sarif({ results: [], invocations: [{}] }),
    sarif({ results: [], invocations: [{ executionSuccessful: false }] }),
    sarif({
      results: [],
      invocations: [
        {
          executionSuccessful: true,
          processStartFailureMessage: "CodeQL did not start",
        },
      ],
    }),
    sarif({
      results: [],
      invocations: [
        { executionSuccessful: true, toolExecutionNotifications: null },
      ],
    }),
    sarif({
      results: [],
      invocations: [
        { executionSuccessful: true, toolExecutionNotifications: [null] },
      ],
    }),
    sarif({
      results: [],
      invocations: [
        {
          executionSuccessful: true,
          toolExecutionNotifications: [{ level: "fatal" }],
        },
      ],
    }),
    sarif({
      results: [],
      invocations: [
        {
          executionSuccessful: true,
          toolExecutionNotifications: [{ level: "error" }],
        },
      ],
    }),
    sarif({
      results: [],
      invocations: [
        { executionSuccessful: true, toolConfigurationNotifications: null },
      ],
    }),
    sarif({
      results: [],
      invocations: [
        {
          executionSuccessful: true,
          toolConfigurationNotifications: [{ level: "error" }],
        },
      ],
    }),
    sarif({ externalPropertyFileReferences: null }),
    sarif({ externalPropertyFileReferences: { results: [{}] } }),
    sarif({
      results: [],
      externalPropertyFileReferences: { invocations: [{}] },
    }),
    { ...sarif({ results: [] }), inlineExternalProperties: null },
    { ...sarif({ results: [] }), inlineExternalProperties: {} },
    {
      ...sarif({ results: [] }),
      inlineExternalProperties: [{ results: [{ ruleId: "hidden" }] }],
    },
  ]) {
    assertRejected(invalid);
  }
  assertRejected();
  assertRejected(sarif({ results: [] }), sarif({ results: [] }));
});

test("valid findings are normalized without hiding their identity", () => {
  const finding = {
    ruleId: "js/example",
    level: "error",
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: "src/example.js" },
          region: { startLine: 7 },
        },
      },
    ],
  };
  assertAccepted(
    [sarif({ results: [finding] })],
    [
      {
        ruleId: "js/example",
        level: "error",
        path: "src/example.js",
        line: 7,
      },
    ],
  );
});

test("the CodeQL workflow executes the reviewed policy", async () => {
  const workflow = await readFile(WORKFLOW_URL, "utf8");
  assert.match(workflow, /node --test scripts\/codeql-sarif-policy\.test\.mjs/);
  assert.match(workflow, /for sarif_file in "\$\{sarif_files\[@\]\}"; do/);
  assert.match(
    workflow,
    /jq -ce -s -f scripts\/codeql-sarif-policy\.jq "\$sarif_file"/,
  );
});
