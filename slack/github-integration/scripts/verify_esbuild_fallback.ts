import SlackManifest from "../manifest.ts";
import { EXPECTED_FUNCTION_SOURCES } from "./verify_build.ts";
import { EXPECTED_HOOK_ESBUILD_URL } from "./verify_dependency_audit.ts";

export interface EsbuildFallbackOptions {
  entrypoint: string;
  configPath: string;
  absWorkingDir: string;
}

export type EsbuildFallbackRunner = (
  options: EsbuildFallbackOptions,
) => Promise<Uint8Array>;

export interface EsbuildFallbackBundle {
  functionId: string;
  contents: Uint8Array;
}

function joinPath(base: string, ...parts: string[]): string {
  return [base.replace(/[\\/]+$/, ""), ...parts].join("/");
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function runOfficialEsbuildFallback(
  options: EsbuildFallbackOptions,
): Promise<Uint8Array> {
  const { EsbuildBundler } = await import(EXPECTED_HOOK_ESBUILD_URL);
  return EsbuildBundler.bundle(options);
}

export function resolveManifestFunctionSources(
  manifest: unknown,
): readonly { functionId: string; sourceFile: string }[] {
  invariant(
    manifest !== null && typeof manifest === "object" &&
      !Array.isArray(manifest),
    "Slack manifest function source contract changed",
  );
  const functions = (manifest as { functions?: unknown }).functions;
  invariant(
    functions !== null && typeof functions === "object" &&
      !Array.isArray(functions),
    "Slack manifest function source contract changed",
  );
  const actualIds = Object.keys(functions as Record<string, unknown>).sort();
  const expectedIds = EXPECTED_FUNCTION_SOURCES.map(({ functionId }) =>
    functionId
  ).sort();
  invariant(
    JSON.stringify(actualIds) === JSON.stringify(expectedIds),
    "Slack manifest function source contract changed",
  );
  return EXPECTED_FUNCTION_SOURCES.map(({ functionId, sourceFile }) => {
    const definition = (functions as Record<string, unknown>)[functionId];
    invariant(
      definition !== null && typeof definition === "object" &&
        !Array.isArray(definition) &&
        (definition as { source_file?: unknown }).source_file === sourceFile,
      `Slack manifest source_file changed: ${functionId}`,
    );
    return { functionId, sourceFile };
  });
}

export async function bundleWithEsbuildFallback(
  appRoot: string,
  runner: EsbuildFallbackRunner = runOfficialEsbuildFallback,
  manifest: unknown = SlackManifest,
): Promise<readonly EsbuildFallbackBundle[]> {
  const configPath = joinPath(appRoot, "deno.jsonc");
  const bundles: EsbuildFallbackBundle[] = [];
  for (
    const { functionId, sourceFile } of resolveManifestFunctionSources(manifest)
  ) {
    const contents = await runner({
      entrypoint: sourceFile,
      configPath,
      absWorkingDir: appRoot,
    });
    invariant(
      contents instanceof Uint8Array && contents.byteLength > 0,
      `Slack official esbuild fallback produced an empty bundle: ${functionId}`,
    );
    bundles.push({ functionId, contents });
  }
  return bundles;
}

async function main(): Promise<void> {
  invariant(
    Deno.args.length === 2,
    "Expected exact app-root and output-directory arguments",
  );
  const [appRoot, outputDirectory] = Deno.args;
  const bundles = await bundleWithEsbuildFallback(appRoot);
  const functionsDirectory = joinPath(outputDirectory, "functions");
  await Deno.mkdir(functionsDirectory, { recursive: true });
  for (const { functionId, contents } of bundles) {
    await Deno.writeFile(
      joinPath(functionsDirectory, `${functionId}.js`),
      contents,
    );
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Slack esbuild fallback proof failed closed: ${message}`);
    Deno.exit(1);
  }
}
