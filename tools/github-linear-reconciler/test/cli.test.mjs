import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { main, parseCliArgs, runCli } from "../src/cli.mjs";

const NOW = new Date("2026-08-18T15:00:00.000Z");

function dependencies(overrides = {}) {
  return {
    loadConfig: async (configPath) => ({
      organization: "example-org",
      releaseRequiredAfter: "2026-08-17T12:00:00.000Z",
      commentGraceMinutes: 30,
      mappings: [],
      configPath,
    }),
    readLinearSnapshot: async ({ token }) => ({ complete: true, token }),
    readGithubSnapshot: async ({ token }) => ({ complete: true, token }),
    evaluate: ({ linear, github }) => ({
      state: "drift",
      counts: { drift: 1, advisory: 0, incomplete: 0 },
      findings: [
        {
          severity: "drift",
          code: "status_divergence",
          entity: `${linear.token}:${github.token}:SYNTH-12`,
          message: "detalhe privado",
          references: ["https://example.invalid/private/SYNTH-12"],
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

test("aceita somente um --config explícito", () => {
  assert.deepEqual(parseCliArgs(["--config", "audit.json"]), {
    configPath: "audit.json",
  });
  assert.deepEqual(parseCliArgs(["--config=audit.json"]), {
    configPath: "audit.json",
  });
  assert.throws(() => parseCliArgs([]), /--config é obrigatório/u);
  assert.throws(() => parseCliArgs(["audit.json"]), /argumento desconhecido/u);
  assert.throws(
    () => parseCliArgs(["--config", "a.json", "--config", "b.json"]),
    /--config deve ser informado uma única vez/u,
  );
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
        argv: ["--config", "audit.json"],
        env: {
          ...ciEnvironment,
          LINEAR_READ_KEY: "linear-secret",
          LINEAR_GITHUB_READ_TOKEN: "github-secret",
        },
        stdout: outputSink(),
        dependencies: dependencies({
          loadConfig: async () => {
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

test("credenciais obrigatórias falham antes de adapters ou rede", async () => {
  let loaded = false;
  await assert.rejects(
    runCli({
      argv: ["--config", "audit.json"],
      env: {},
      dependencies: dependencies({
        loadConfig: async () => {
          loaded = true;
        },
      }),
    }),
    /LINEAR_READ_KEY é obrigatório/u,
  );
  assert.equal(loaded, false);
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
      return { complete: true, token: input.token };
    },
    writeLocalReport: async (input) => {
      calls.push(["report", input]);
      return { path: "local-report.json", removed: [] };
    },
  });

  const exitCode = await runCli({
    argv: ["--config", ".\\audit.json"],
    env: {
      CI: "false",
      LINEAR_READ_KEY: "linear-secret",
      LINEAR_GITHUB_READ_TOKEN: "github-secret",
    },
    stdout,
    dependencies: deps,
    now: NOW,
    cwd: "C:\\audit-root",
  });

  assert.equal(exitCode, 1);
  assert.equal(
    stdout.value(),
    '{"state":"drift","counts":{"advisory":0,"drift":1,"incomplete":0}}\n',
  );
  assert.doesNotMatch(
    stdout.value(),
    /linear-secret|github-secret|SYNTH-12|example\.invalid|status_divergence/u,
  );
  assert.equal(calls[0][0], "linear");
  assert.equal(calls[1][0], "github");
  assert.equal(calls[0][1].token, "linear-secret");
  assert.equal(calls[1][1].token, "github-secret");
  assert.equal(
    calls[0][1].config.configPath,
    path.resolve("C:\\audit-root", ".\\audit.json"),
  );
  assert.equal(calls[2][0], "report");
  assert.equal(calls[2][1].now, NOW);
});

test("falha terminal também mantém stdout redigido e não ecoa segredo", async () => {
  const stdout = outputSink();
  const stderr = outputSink();
  const exitCode = await main({
    argv: ["--config", "audit.json"],
    env: {
      LINEAR_READ_KEY: "linear-secret",
      LINEAR_GITHUB_READ_TOKEN: "github-secret",
    },
    stdout,
    stderr,
    dependencies: dependencies({
      readLinearSnapshot: async () => {
        throw new Error("upstream echoed github-secret");
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
  assert.doesNotMatch(`${stdout.value()}${stderr.value()}`, /github-secret/u);
});
