import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ACTION_DIRECTORY_URL = new URL("../codeql-sarif-gate/", import.meta.url);
const ACTION_URL = new URL("action.yml", ACTION_DIRECTORY_URL);
const SHELL_URL = new URL("enforce.sh", ACTION_DIRECTORY_URL);
const POLICY_URL = new URL("policy.jq", ACTION_DIRECTORY_URL);
const WORKFLOW_URL = new URL(
  "../.github/workflows/codeql.yml",
  import.meta.url,
);

function bashPath(path) {
  return path.replaceAll("\\", "/");
}

function sarif(run = {}) {
  return {
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "CodeQL" } },
        results: [],
        ...run,
      },
    ],
  };
}

function successfulInvocation(overrides = {}) {
  return {
    executionSuccessful: true,
    ...overrides,
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

function executeGate({
  inputDirectory = "",
  environmentDirectory = "",
  additionalEnvironment = {},
}) {
  return spawnSync("bash", [bashPath(fileURLToPath(SHELL_URL))], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...additionalEnvironment,
      CODEQL_RESULTS: bashPath(environmentDirectory),
      GITHUB_ACTION_PATH: bashPath(fileURLToPath(ACTION_DIRECTORY_URL)),
      SARIF_DIRECTORY_INPUT: bashPath(inputDirectory),
    },
  });
}

async function createSarifDirectory(t, documentsByName) {
  const directory = await mkdtemp(join(tmpdir(), "codeql-sarif-gate-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  for (const [name, documents] of Object.entries(documentsByName)) {
    const content = documents
      .map((document) => JSON.stringify(document))
      .join("\n");
    await writeFile(join(directory, name), content, "utf8");
  }
  return directory;
}

test("composite metadata maps the optional directory input into a Bash step", async () => {
  const action = await readFile(ACTION_URL, "utf8");
  assert.match(action, /^name: LCV CodeQL SARIF Gate$/m);
  assert.match(action, /^description: .+$/m);
  assert.match(
    action,
    /inputs:\s*\n\s+sarif-directory:\s*\n\s+description: .+\n\s+required: false\n\s+default: ""/,
  );
  assert.match(action, /runs:\s*\n\s+using: composite\s*\n\s+steps:/);
  assert.match(action, /shell: bash/);
  assert.match(
    action,
    /SARIF_DIRECTORY_INPUT: \$\{\{ inputs\.sarif-directory \}\}/,
  );
  assert.match(action, /bash "\$GITHUB_ACTION_PATH\/enforce\.sh"/);
  assert.doesNotMatch(action, /continue-on-error:/);
});

test("gate shell is strict, path-safe, and delegates every file to the reviewed policy", async () => {
  const shell = await readFile(SHELL_URL, "utf8");
  assert.match(shell, /^#!\/usr\/bin\/env bash\nset -euo pipefail\n/);
  assert.match(
    shell,
    /sarif_directory="\$\{SARIF_DIRECTORY_INPUT:-\$\{CODEQL_RESULTS:-\}\}"/,
  );
  assert.match(
    shell,
    /find "\$sarif_directory" -type f -name '\*\.sarif' -print0/,
  );
  assert.match(shell, /if ! find .+ >"\$sarif_list"; then/);
  assert.match(shell, /while IFS= read -r -d '' sarif_file; do/);
  assert.match(
    shell,
    /jq -ce -s -f "\$GITHUB_ACTION_PATH\/policy\.jq" "\$sarif_file"/,
  );
  assert.match(shell, /CodeQL produced no SARIF file to enforce/);
  assert.match(shell, /Inventory: \$finding_inventory/);
  assert.doesNotMatch(
    shell,
    /\beval\b|\bsource\b|bash\s+-c|\bmapfile\b|<\s*<\(/,
  );
});

test("valid CodeQL SARIF with no inline results is accepted", () => {
  assertAccepted([sarif({ results: [] })]);
  assertAccepted([sarif()]);
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

test("successful invocations and non-error notifications are accepted", () => {
  assertAccepted([sarif({ invocations: [] })]);
  assertAccepted([
    sarif({
      invocations: [
        successfulInvocation({
          toolExecutionNotifications: [
            {},
            { level: "none" },
            { level: "note" },
            { level: "warning" },
          ],
          toolConfigurationNotifications: [{ level: "warning" }],
        }),
      ],
    }),
  ]);
});

test("unsuccessful or malformed invocations fail closed", () => {
  for (const invocations of [
    null,
    {},
    [null],
    [true],
    [[]],
    [{}],
    [{ executionSuccessful: null }],
    [{ executionSuccessful: 1 }],
    [{ executionSuccessful: "true" }],
    [{ executionSuccessful: false }],
    [successfulInvocation({ processStartFailureMessage: null })],
    [successfulInvocation({ processStartFailureMessage: "failed to start" })],
  ]) {
    assertRejected(sarif({ invocations }));
  }
});

test("error or malformed invocation notifications fail closed", () => {
  for (const property of [
    "toolExecutionNotifications",
    "toolConfigurationNotifications",
  ]) {
    for (const notifications of [
      null,
      {},
      [null],
      [false],
      [{ level: null }],
      [{ level: 1 }],
      [{ level: "error" }],
      [{ level: "fatal" }],
    ]) {
      assertRejected(
        sarif({
          invocations: [successfulInvocation({ [property]: notifications })],
        }),
      );
    }
  }
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
    {
      version: "2.1.0",
      runs: [{ tool: { driver: { name: "CodeQL" } } }],
    },
    sarif({ tool: { driver: { name: "CodeQL command-line toolchain" } } }),
    sarif({ tool: { driver: { name: "codeql" } } }),
    sarif({
      conversion: {
        tool: { driver: { name: "SARIF converter" } },
        invocation: {
          executionSuccessful: false,
          toolExecutionNotifications: [{ level: "error" }],
        },
      },
    }),
    sarif({
      conversion: {
        tool: { driver: { name: "GitHub Code Scanning" } },
      },
    }),
    sarif({ results: {} }),
    sarif({ results: null }),
    sarif({ results: [null] }),
    sarif({
      results: [],
      tool: { driver: { name: "Another analyzer" } },
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
    sarif({ externalPropertyFileReferences: { graphs: [] } }),
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

test("gate accepts the explicit input and the CODEQL_RESULTS fallback", async (t) => {
  const cleanDirectory = await createSarifDirectory(t, {
    "actions.sarif": [sarif({ results: [] })],
    "javascript.sarif": [sarif()],
  });
  const findingDirectory = await createSarifDirectory(t, {
    "finding.sarif": [sarif({ results: [{ ruleId: "must/not/run" }] })],
  });

  const explicit = executeGate({
    inputDirectory: cleanDirectory,
    environmentDirectory: findingDirectory,
  });
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.match(explicit.stdout, /CodeQL reported zero SARIF results/);

  const fallback = executeGate({ environmentDirectory: cleanDirectory });
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.match(fallback.stdout, /CodeQL reported zero SARIF results/);
});

test("gate fails closed for missing, malformed, or externally materialized SARIF", async (t) => {
  const emptyDirectory = await createSarifDirectory(t, {});
  const malformedDirectory = await createSarifDirectory(t, {
    "malformed.sarif": [{ version: "2.1.0", runs: [] }],
    "null-results.sarif": [sarif({ results: null })],
  });
  const externalDirectory = await createSarifDirectory(t, {
    "external.sarif": [
      sarif({ externalPropertyFileReferences: { results: [{}] } }),
    ],
  });
  const multipleDocumentsDirectory = await createSarifDirectory(t, {
    "multiple.sarif": [sarif({ results: [] }), sarif({ results: [] })],
  });

  for (const result of [
    executeGate({}),
    executeGate({ inputDirectory: join(emptyDirectory, "missing") }),
    executeGate({ inputDirectory: emptyDirectory }),
    executeGate({ inputDirectory: malformedDirectory }),
    executeGate({ inputDirectory: externalDirectory }),
    executeGate({ inputDirectory: multipleDocumentsDirectory }),
  ]) {
    assert.notEqual(result.status, 0, "Invalid SARIF input was accepted.");
  }
});

test("gate fails closed when SARIF discovery emits a partial list and then fails", async (t) => {
  const directory = await createSarifDirectory(t, {
    "clean.sarif": [sarif()],
  });
  const environmentDirectory = await mkdtemp(
    join(tmpdir(), "codeql-sarif-find-failure-"),
  );
  t.after(() => rm(environmentDirectory, { force: true, recursive: true }));
  const bashEnvironment = join(environmentDirectory, "bash-env.sh");
  await writeFile(
    bashEnvironment,
    `find() { printf '%s\\0' "$FAKE_FIND_FILE"; return 1; }\n`,
    "utf8",
  );

  const result = executeGate({
    inputDirectory: directory,
    additionalEnvironment: {
      BASH_ENV: bashPath(bashEnvironment),
      FAKE_FIND_FILE: bashPath(join(directory, "clean.sarif")),
    },
  });

  assert.notEqual(result.status, 0, "Partial SARIF discovery was accepted.");
  assert.match(result.stderr, /Could not enumerate every SARIF file/);
});

test("gate reports every finding with a normalized inventory", async (t) => {
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
  const directory = await createSarifDirectory(t, {
    "first.sarif": [sarif({ results: [finding] })],
    "second.sarif": [sarif({ results: [{ ruleId: "actions/other" }] })],
  });

  const result = executeGate({ inputDirectory: directory });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /::error::CodeQL reported 2 SARIF result\(s\); zero are allowed/,
  );
  assert.match(result.stderr, /"ruleId":"js\/example"/);
  assert.match(result.stderr, /"path":"src\/example\.js"/);
  assert.match(result.stderr, /"line":7/);
  assert.match(result.stderr, /"ruleId":"actions\/other"/);
});

test("the CodeQL workflow tests and exercises the local composite action", async () => {
  const workflow = await readFile(WORKFLOW_URL, "utf8");
  assert.doesNotMatch(
    workflow,
    /^\s+if:.*workflow_dispatch.*refs\/heads\/main.*$/m,
    "manual CodeQL dispatch must remain available for all protected refs",
  );
  assert.match(workflow, /node --test scripts\/codeql-sarif-policy\.test\.mjs/);
  assert.match(workflow, /uses: \.\/codeql-sarif-gate/);
  assert.match(
    workflow,
    /sarif-directory: \$\{\{ runner\.temp \}\}\/codeql-results/,
  );
  assert.doesNotMatch(
    workflow,
    /jq -ce -s -f scripts\/codeql-sarif-policy\.jq/,
  );
});
