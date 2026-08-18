import { pathToFileURL } from "node:url";

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
  if (!Array.isArray(argv)) {
    throw cliError("argumento desconhecido ou inválido");
  }
  if (argv.length === 0) return { mode: "audit" };
  if (argv.length === 1 && argv[0] === "--init-profile") {
    return { mode: "init-profile" };
  }
  throw cliError("argumento desconhecido ou inválido");
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

function localProfileEnvironment(env) {
  return Object.fromEntries(
    ["GITHUB_LINEAR_RECONCILER_PROFILE_DIR", "LOCALAPPDATA", "XDG_STATE_HOME"]
      .filter((name) => typeof env[name] === "string")
      .map((name) => [name, env[name]]),
  );
}

export async function loadRuntimeDependencies() {
  const [
    configModule,
    linearModule,
    githubModule,
    evaluateModule,
    profileModule,
  ] = await Promise.all([
    import("./config.mjs"),
    import("./adapters/linear.mjs"),
    import("./adapters/github.mjs"),
    import("./evaluate.mjs"),
    import("./local-profile.mjs"),
  ]);
  return {
    loadConfig: configModule.loadConfig,
    readLinearSnapshot: linearModule.readLinearSnapshot,
    readGithubSnapshot: githubModule.readGithubSnapshot,
    evaluate: evaluateModule.evaluate,
    determineExitCode: evaluateModule.determineExitCode,
    assertOwnedLocalProfile: profileModule.assertOwnedLocalProfile,
    ensureOwnedLocalProfile: profileModule.ensureOwnedLocalProfile,
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
    "assertOwnedLocalProfile",
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
} = {}) {
  const { mode } = parseCliArgs(argv);
  if (isContinuousIntegration(env))
    throw cliError("execução live é permitida somente em ambiente local");

  const runtime = dependencies ?? (await loadRuntimeDependencies());
  const profileEnv = localProfileEnvironment(env);
  if (mode === "init-profile") {
    if (typeof runtime?.ensureOwnedLocalProfile !== "function") {
      throw new TypeError(
        "dependência runtime ausente: ensureOwnedLocalProfile",
      );
    }
    await runtime.ensureOwnedLocalProfile({ env: profileEnv });
    stdout.write('{"profile":"initialized"}\n');
    return 0;
  }

  const linearToken = requiredCredential(env, "LINEAR_READ_KEY");
  const githubAppId = requiredCredential(env, "LINEAR_GITHUB_APP_ID");
  const githubPrivateKeyPath = requiredCredential(
    env,
    "LINEAR_GITHUB_APP_PRIVATE_KEY_PATH",
  );
  assertRuntimeDependencies(runtime);

  const profile = await runtime.assertOwnedLocalProfile({ env: profileEnv });
  const config = await runtime.loadConfig(profile.configPath, {
    profileRoot: profile.root,
    env: profileEnv,
  });
  const capturedAt = now.toISOString();
  const [linear, github] = await Promise.all([
    runtime.readLinearSnapshot({ config, token: linearToken, capturedAt }),
    runtime.readGithubSnapshot({
      config,
      appId: githubAppId,
      privateKeyPath: githubPrivateKeyPath,
      capturedAt,
    }),
  ]);
  const result = await runtime.evaluate({ config, linear, github, now });
  const exitCode = runtime.determineExitCode(result);
  if (![0, 1, 2].includes(exitCode))
    throw new TypeError("determineExitCode retornou código inválido");

  await runtime.writeLocalReport({
    result,
    now,
    env: profileEnv,
    directory: profile.root,
  });
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
