import assert from "node:assert/strict";
import test from "node:test";

import { main, parseCliArgs, runCli } from "../src/cli.mjs";

const NOW = new Date("2026-08-18T15:00:00.000Z");

function dependencies(overrides = {}) {
  return {
    assertOwnedLocalProfile: async () => ({
      root: "C:\\profile",
      configPath: "C:\\profile\\config.json",
      reportsPath: "C:\\profile\\reports",
    }),
    loadConfig: async (configPath) => ({
      organization: "example-org",
      releaseRequiredAfter: "2026-08-17T12:00:00.000Z",
      commentGraceMinutes: 30,
      mappings: [],
      configPath,
    }),
    readLinearSnapshot: async ({ token }) => ({ complete: true, token }),
    readGithubSnapshot: async ({ appId, privateKeyPath }) => ({
      complete: true,
      appId,
      privateKeyPath,
    }),
    evaluate: ({ linear, github }) => ({
      state: "drift",
      counts: { drift: 1, advisory: 0, incomplete: 0 },
      findings: [
        {
          severity: "drift",
          code: "status_divergence",
          entity: `${linear.token}:${github.appId}:SYNTH-12`,
          message: "detalhe privado",
          references: [github.privateKeyPath],
        },
      ],
    }),
    determineExitCode: () => 1,
    writeLocalReport: async () => ({ path: "local-report.json", removed: [] }),
    ...overrides,
  };
}

function outputSink() {
  let value = "";
  return {
    write(chunk) {
      value += String(chunk);
    },
    value() {
      return value;
    },
  };
}

test("CLI aceita apenas audit sem argumentos ou init explícito", () => {
  assert.deepEqual(parseCliArgs([]), { mode: "audit" });
  assert.deepEqual(parseCliArgs(["--init-profile"]), {
    mode: "init-profile",
  });
  assert.throws(() => parseCliArgs(["--config", "audit.json"]), /argumento/u);
  assert.throws(() => parseCliArgs(["audit.json"]), /argumento/u);
});

test("recusa execução live em CI antes de carregar credenciais", async () => {
  for (const ciEnvironment of [
    { GITHUB_ACTIONS: "true" },
    { CI: "1" },
    { GITLAB_CI: "true" },
    { TF_BUILD: "True" },
  ]) {
    let loaded = false;
    await assert.rejects(
      runCli({
        argv: [],
        env: ciEnvironment,
        stdout: outputSink(),
        dependencies: dependencies({
          assertOwnedLocalProfile: async () => {
            loaded = true;
          },
        }),
      }),
      /execução live é permitida somente em ambiente local/u,
      JSON.stringify(ciEnvironment),
    );
    assert.equal(loaded, false, JSON.stringify(ciEnvironment));
  }
});

test("credenciais App obrigatórias falham antes de adapters ou rede", async () => {
  let loaded = false;
  await assert.rejects(
    runCli({
      argv: [],
      env: {},
      dependencies: dependencies({
        assertOwnedLocalProfile: async () => {
          loaded = true;
        },
      }),
    }),
    /LINEAR_READ_KEY é obrigatório/u,
  );
  assert.equal(loaded, false);

  await assert.rejects(
    runCli({
      argv: [],
      env: {
        LINEAR_READ_KEY: "linear-secret",
        LINEAR_GITHUB_READ_TOKEN: "legacy-pat",
      },
      dependencies: dependencies(),
    }),
    /LINEAR_GITHUB_APP_ID é obrigatório/u,
  );
});

test("executa snapshots em paralelo, grava relatório local e redige stdout", async () => {
  const stdout = outputSink();
  const calls = [];
  const deps = dependencies({
    readLinearSnapshot: async (input) => {
      calls.push(["linear", input]);
      return { complete: true, token: input.token };
    },
    readGithubSnapshot: async (input) => {
      calls.push(["github", input]);
      return {
        complete: true,
        appId: input.appId,
        privateKeyPath: input.privateKeyPath,
      };
    },
    writeLocalReport: async (input) => {
      calls.push(["report", input]);
      return { path: "local-report.json", removed: [] };
    },
  });

  const exitCode = await runCli({
    argv: [],
    env: {
      CI: "false",
      SystemRoot: "C:\\Windows",
      LINEAR_READ_KEY: "linear-secret",
      LINEAR_GITHUB_APP_ID: "456",
      LINEAR_GITHUB_APP_PRIVATE_KEY_PATH: "C:\\private\\app.pem",
      LINEAR_GITHUB_READ_TOKEN: "must-not-be-used",
    },
    stdout,
    dependencies: deps,
    now: NOW,
  });

  assert.equal(exitCode, 1);
  assert.equal(
    stdout.value(),
    '{"state":"drift","counts":{"advisory":0,"drift":1,"incomplete":0}}\n',
  );
  assert.doesNotMatch(
    stdout.value(),
    /linear-secret|must-not-be-used|SYNTH-12|private|status_divergence/u,
  );
  assert.equal(calls[0][0], "linear");
  assert.equal(calls[1][0], "github");
  assert.equal(calls[0][1].token, "linear-secret");
  assert.equal(calls[1][1].appId, "456");
  assert.equal(calls[1][1].privateKeyPath, "C:\\private\\app.pem");
  assert.equal(calls[1][1].profileRoot, "C:\\profile");
  assert.deepEqual(calls[1][1].env, { SystemRoot: "C:\\Windows" });
  assert.equal(calls[2][0], "report");
  assert.equal(calls[2][1].directory, "C:\\profile");
  assert.equal(calls[2][1].now, NOW);
});

test("falha terminal também mantém stdout redigido e não ecoa segredo", async () => {
  const stdout = outputSink();
  const stderr = outputSink();
  const exitCode = await main({
    argv: [],
    env: {
      LINEAR_READ_KEY: "linear-secret",
      LINEAR_GITHUB_APP_ID: "456",
      LINEAR_GITHUB_APP_PRIVATE_KEY_PATH: "C:\\private\\app.pem",
    },
    stdout,
    stderr,
    dependencies: dependencies({
      readLinearSnapshot: async () => {
        throw new Error("upstream echoed linear-secret");
      },
    }),
  });

  assert.equal(exitCode, 2);
  assert.equal(
    stdout.value(),
    '{"state":"incomplete","counts":{"advisory":0,"drift":0,"incomplete":1}}\n',
  );
  assert.equal(
    stderr.value(),
    "github-linear-reconciler: execução inconclusiva\n",
  );
  assert.doesNotMatch(`${stdout.value()}${stderr.value()}`, /linear-secret/u);
});
