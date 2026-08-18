import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { renderRedactedStatus, writeLocalReport } from "./report/local.mjs";

const CI_ENVIRONMENT_MARKERS = Object.freeze([
  "APPVEYOR",
  "BITBUCKET_BUILD_NUMBER",
  "BUILDKITE",
  "CIRCLECI",
  "CODEBUILD_BUILD_ID",
  "DRONE",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "HUDSON_URL",
  "JENKINS_URL",
  "SEMAPHORE",
  "SYSTEM_TEAMFOUNDATIONCOLLECTIONURI",
  "TEAMCITY_VERSION",
  "TF_BUILD",
  "TRAVIS",
  "WERCKER",
]);

const FALSE_ENV_VALUES = new Set(["", "0", "false", "no", "off"]);

function cliError(message) {
  const error = new Error(message);
  error.name = "CliUsageError";
  return error;
}

export function parseCliArgs(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      tokens: true,
      options: {
        config: { type: "string" },
      },
    });
  } catch {
    throw cliError("argumento desconhecido ou inválido");
  }
  const configTokens = parsed.tokens.filter(
    (token) => token.kind === "option" && token.name === "config",
  );
  if (configTokens.length > 1)
    throw cliError("--config deve ser informado uma única vez");
  const configPath = parsed.values.config?.trim();
  if (!configPath) throw cliError("--config é obrigatório");
  return { configPath };
}

function requiredCredential(env, name) {
  const value = env[name]?.trim();
  if (!value) throw cliError(`${name} é obrigatório`);
  return value;
}

function environmentFlag(value) {
  if (value == null) return false;
  return !FALSE_ENV_VALUES.has(String(value).trim().toLowerCase());
}

function isContinuousIntegration(env) {
  if (environmentFlag(env.CI)) return true;
  return CI_ENVIRONMENT_MARKERS.some((name) => environmentFlag(env[name]));
}

export async function loadRuntimeDependencies() {
  const [configModule, linearModule, githubModule, evaluateModule] =
    await Promise.all([
      import("./config.mjs"),
      import("./adapters/linear.mjs"),
      import("./adapters/github.mjs"),
      import("./evaluate.mjs"),
    ]);
  return {
    loadConfig: configModule.loadConfig,
    readLinearSnapshot: linearModule.readLinearSnapshot,
    readGithubSnapshot: githubModule.readGithubSnapshot,
    evaluate: evaluateModule.evaluate,
    determineExitCode: evaluateModule.determineExitCode,
    writeLocalReport,
  };
}

function assertRuntimeDependencies(dependencies) {
  for (const name of [
    "loadConfig",
    "readLinearSnapshot",
    "readGithubSnapshot",
    "evaluate",
    "determineExitCode",
    "writeLocalReport",
  ]) {
    if (typeof dependencies?.[name] !== "function")
      throw new TypeError(`dependência runtime ausente: ${name}`);
  }
}

export async function runCli({
  argv = process.argv.slice(2),
  env = process.env,
  stdout = process.stdout,
  dependencies,
  now = new Date(),
  cwd = process.cwd(),
} = {}) {
  const { configPath } = parseCliArgs(argv);
  if (isContinuousIntegration(env))
    throw cliError("execução live é permitida somente em ambiente local");

  const linearToken = requiredCredential(env, "LINEAR_READ_KEY");
  const githubToken = requiredCredential(env, "LINEAR_GITHUB_READ_TOKEN");
  const runtime = dependencies ?? (await loadRuntimeDependencies());
  assertRuntimeDependencies(runtime);

  const absoluteConfigPath = path.resolve(cwd, configPath);
  const config = await runtime.loadConfig(absoluteConfigPath);
  const capturedAt = now.toISOString();
  const [linear, github] = await Promise.all([
    runtime.readLinearSnapshot({ config, token: linearToken, capturedAt }),
    runtime.readGithubSnapshot({ config, token: githubToken, capturedAt }),
  ]);
  const result = await runtime.evaluate({ config, linear, github, now });
  const exitCode = runtime.determineExitCode(result);
  if (![0, 1, 2].includes(exitCode))
    throw new TypeError("determineExitCode retornou código inválido");

  await runtime.writeLocalReport({ result, now, env });
  stdout.write(`${renderRedactedStatus(result)}\n`);
  return exitCode;
}

export async function main(options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  try {
    return await runCli({ ...options, stdout });
  } catch (error) {
    stdout.write(
      '{"state":"incomplete","counts":{"advisory":0,"drift":0,"incomplete":1}}\n',
    );
    const isUsageError =
      error instanceof Error && error.name === "CliUsageError";
    stderr.write(
      `github-linear-reconciler: ${
        isUsageError ? error.message : "execução inconclusiva"
      }\n`,
    );
    return 2;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main();
}
