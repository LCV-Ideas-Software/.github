import { EXPECTED_HOOK_BUILD_URL } from "./verify_dependency_audit.ts";

export const EXPECTED_FUNCTION_SOURCES = [
  {
    functionId: "report_github_relay_progress",
    sourceFile: "functions/report_relay_progress.ts",
  },
  {
    functionId: "validate_github_relay_message",
    sourceFile: "functions/validate_relay_message.ts",
  },
] as const;
export const EXPECTED_FUNCTION_IDS = EXPECTED_FUNCTION_SOURCES.map(
  ({ functionId }) => functionId,
);

const EXPECTED_ARTIFACTS = [
  ...EXPECTED_FUNCTION_IDS.map((functionId) => `functions/${functionId}.js`),
  "manifest.json",
] as const;
const EXPECTED_FUNCTION_ARTIFACTS = EXPECTED_FUNCTION_IDS.map(
  (functionId) => `functions/${functionId}.js`,
);

export interface BuildArtifact {
  path: string;
  size: number;
}

export type BundleSyntaxRunner = (
  paths: readonly string[],
) => Promise<boolean>;
export type BundleHandlerRunner = (
  paths: readonly string[],
) => Promise<{ success: boolean; output: string }>;

export const BUNDLE_HANDLER_PROOF =
  "SLACK_BUNDLE_HANDLERS_VERIFIED_V1:report_github_relay_progress,validate_github_relay_message";

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function verifyBuildArtifacts(
  artifacts: readonly BuildArtifact[],
  manifestText: string,
): void {
  const actualPaths = artifacts.map(({ path }) => path).sort();
  const expectedPaths = [...EXPECTED_ARTIFACTS].sort();
  invariant(
    JSON.stringify(actualPaths) === JSON.stringify(expectedPaths),
    `Slack build artifact inventory changed: ${actualPaths.join(", ")}`,
  );
  const emptyArtifact = artifacts.find(({ size }) => size <= 0);
  invariant(
    !emptyArtifact,
    `Slack build produced an empty artifact: ${
      emptyArtifact?.path ?? "unknown"
    }`,
  );

  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw new Error("Slack build manifest is malformed");
  }
  invariant(
    manifest !== null && typeof manifest === "object" &&
      !Array.isArray(manifest),
    "Slack build manifest is malformed",
  );
  const functions = (manifest as { functions?: unknown }).functions;
  invariant(
    functions !== null && typeof functions === "object" &&
      !Array.isArray(functions),
    "Slack build manifest function inventory changed",
  );
  const actualFunctionIds = Object.keys(functions).sort();
  const expectedFunctionIds = [...EXPECTED_FUNCTION_IDS].sort();
  invariant(
    JSON.stringify(actualFunctionIds) === JSON.stringify(expectedFunctionIds),
    `Slack build manifest function inventory changed: ${
      actualFunctionIds.join(", ") || "none"
    }`,
  );
}

export function verifyFunctionBundleArtifacts(
  artifacts: readonly BuildArtifact[],
): void {
  const actualPaths = artifacts.map(({ path }) => path).sort();
  const expectedPaths = [...EXPECTED_FUNCTION_ARTIFACTS].sort();
  invariant(
    JSON.stringify(actualPaths) === JSON.stringify(expectedPaths),
    `Slack esbuild fallback artifact inventory changed: ${
      actualPaths.join(", ")
    }`,
  );
  const emptyArtifact = artifacts.find(({ size }) => size <= 0);
  invariant(
    !emptyArtifact,
    `Slack esbuild fallback produced an empty artifact: ${
      emptyArtifact?.path ?? "unknown"
    }`,
  );
}

async function runBundleSyntaxCheck(
  paths: readonly string[],
): Promise<boolean> {
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "check",
      "--no-config",
      "--no-lock",
      "--no-remote",
      "--no-npm",
      "--quiet",
      ...paths,
    ],
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  });
  return (await command.spawn().status).success;
}

export async function verifyBundleSyntax(
  outputDirectory: string,
  runner: BundleSyntaxRunner = runBundleSyntaxCheck,
): Promise<void> {
  const bundlePaths = EXPECTED_FUNCTION_IDS.map(
    (functionId) => `${outputDirectory}/functions/${functionId}.js`,
  );
  invariant(
    await runner(bundlePaths),
    "Slack generated function bundle is invalid",
  );
}

export function verifyBundleHandlerNamespaces(
  namespaces: readonly Record<string, unknown>[],
): void {
  invariant(
    namespaces.length === EXPECTED_FUNCTION_IDS.length &&
      namespaces.every((namespace) => typeof namespace.default === "function"),
    "Slack generated function bundle must expose a callable default handler",
  );
}

async function runBundleHandlerCheck(
  paths: readonly string[],
): Promise<{ success: boolean; output: string }> {
  const verifierUrl = new URL("./verify_bundle_handlers.ts", import.meta.url);
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-config",
      "--no-lock",
      "--no-remote",
      "--no-npm",
      `--allow-read=${paths.join(",")}`,
      "--quiet",
      verifierUrl.href,
      ...paths,
    ],
    stdin: "null",
    stdout: "piped",
    stderr: "inherit",
  });
  const result = await command.output();
  return {
    success: result.success,
    output: new TextDecoder().decode(result.stdout),
  };
}

export async function verifyBundleHandlers(
  outputDirectory: string,
  runner: BundleHandlerRunner = runBundleHandlerCheck,
): Promise<void> {
  const bundlePaths = EXPECTED_FUNCTION_IDS.map(
    (functionId) => `${outputDirectory}/functions/${functionId}.js`,
  );
  const result = await runner(bundlePaths);
  invariant(
    result.success && result.output === `${BUNDLE_HANDLER_PROOF}\n`,
    "Slack generated function bundle must expose a callable default handler",
  );
}

async function collectArtifacts(
  directory: string,
  prefix = "",
): Promise<BuildArtifact[]> {
  const artifacts: BuildArtifact[] = [];
  for await (const entry of Deno.readDir(directory)) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = `${directory}/${entry.name}`;
    if (entry.isDirectory) {
      artifacts.push(...await collectArtifacts(absolutePath, relativePath));
      continue;
    }
    invariant(entry.isFile, `Slack build emitted a non-file: ${relativePath}`);
    const metadata = await Deno.stat(absolutePath);
    artifacts.push({ path: relativePath, size: metadata.size });
  }
  return artifacts;
}

async function main(): Promise<void> {
  const appRoot = await Deno.realPath(new URL("../", import.meta.url));
  const proofDirectory = await Deno.makeTempDir({
    prefix: "slack-github-integration-build-",
  });
  const outputDirectory = `${proofDirectory}/official`;
  const esbuildOutputDirectory = `${proofDirectory}/esbuild`;

  try {
    const command = new Deno.Command(Deno.execPath(), {
      cwd: appRoot,
      args: [
        "run",
        "--frozen",
        "-q",
        "--config=deno.jsonc",
        "--allow-read",
        "--allow-write",
        "--allow-net",
        "--allow-run",
        "--allow-env",
        "--allow-sys=osRelease",
        EXPECTED_HOOK_BUILD_URL,
        "--source",
        ".",
        "--output",
        outputDirectory,
      ],
      stdin: "null",
      stdout: "inherit",
      stderr: "inherit",
    });
    const status = await command.spawn().status;
    invariant(
      status.success,
      `Slack build hook failed with exit code ${status.code}`,
    );

    const artifacts = await collectArtifacts(outputDirectory);
    const manifestText = await Deno.readTextFile(
      `${outputDirectory}/manifest.json`,
    );
    verifyBuildArtifacts(artifacts, manifestText);
    await verifyBundleSyntax(outputDirectory);
    await verifyBundleHandlers(outputDirectory);

    const fallbackVerifier = new URL(
      "./verify_esbuild_fallback.ts",
      import.meta.url,
    );
    const fallbackCommand = new Deno.Command(Deno.execPath(), {
      cwd: appRoot,
      args: [
        "run",
        "--frozen",
        "--cached-only",
        "-q",
        "--config=deno.jsonc",
        "--allow-read",
        `--allow-write=${esbuildOutputDirectory}`,
        "--allow-run",
        "--allow-env",
        fallbackVerifier.href,
        appRoot,
        esbuildOutputDirectory,
      ],
      stdin: "null",
      stdout: "inherit",
      stderr: "inherit",
      clearEnv: true,
    });
    const fallbackStatus = await fallbackCommand.spawn().status;
    invariant(
      fallbackStatus.success,
      `Slack esbuild fallback failed with exit code ${fallbackStatus.code}`,
    );
    const fallbackArtifacts = await collectArtifacts(esbuildOutputDirectory);
    verifyFunctionBundleArtifacts(fallbackArtifacts);
    await verifyBundleSyntax(esbuildOutputDirectory);
    await verifyBundleHandlers(esbuildOutputDirectory);
    console.log(
      "Slack build proof passed through the official build and direct esbuild fallback with exact inventories, syntax, and callable default handlers.",
    );
  } finally {
    await Deno.remove(proofDirectory, { recursive: true });
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Slack build proof failed closed: ${message}`);
    Deno.exit(1);
  }
}
