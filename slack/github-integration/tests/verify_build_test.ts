import {
  verifyBuildArtifacts,
  verifyBundleHandlerNamespaces,
  verifyBundleHandlers,
  verifyBundleSyntax,
} from "../scripts/verify_build.ts";
import {
  bundleWithEsbuildFallback,
  resolveManifestFunctionSources,
} from "../scripts/verify_esbuild_fallback.ts";
import { EXPECTED_DENO_TASKS } from "../scripts/verify_dependency_audit.ts";

function assertThrows(action: () => void, expected: string): void {
  try {
    action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(expected)) return;
    throw new Error(
      `Expected error containing "${expected}", received "${message}"`,
    );
  }
  throw new Error(`Expected action to throw "${expected}"`);
}

const COMPLETE_BUILD = [
  { path: "functions/report_github_relay_progress.js", size: 1 },
  { path: "functions/validate_github_relay_message.js", size: 1 },
  { path: "manifest.json", size: 1 },
];

const COMPLETE_MANIFEST = JSON.stringify({
  functions: {
    report_github_relay_progress: {
      source_file: "functions/report_relay_progress.ts",
    },
    validate_github_relay_message: {
      source_file: "functions/validate_relay_message.ts",
    },
  },
});

Deno.test("keeps the full Slack build proof in the candidate check gate", async () => {
  const config = JSON.parse(
    await Deno.readTextFile(new URL("../deno.jsonc", import.meta.url)),
  ) as { tasks?: Record<string, string> };
  if (JSON.stringify(config.tasks) !== JSON.stringify(EXPECTED_DENO_TASKS)) {
    throw new Error("the exact reviewed candidate task surface changed");
  }
});

Deno.test("requires an exact, nonempty Slack build artifact inventory", () => {
  verifyBuildArtifacts(COMPLETE_BUILD, COMPLETE_MANIFEST);

  assertThrows(
    () => verifyBuildArtifacts(COMPLETE_BUILD.slice(1), "{}"),
    "artifact inventory changed",
  );
  assertThrows(
    () =>
      verifyBuildArtifacts(
        [...COMPLETE_BUILD, { path: "unexpected.js", size: 1 }],
        "{}",
      ),
    "artifact inventory changed",
  );
  assertThrows(
    () =>
      verifyBuildArtifacts(
        COMPLETE_BUILD.map((artifact) =>
          artifact.path === "manifest.json"
            ? { ...artifact, size: 0 }
            : artifact
        ),
        "{}",
      ),
    "empty artifact",
  );
  assertThrows(
    () => verifyBuildArtifacts(COMPLETE_BUILD, "[]"),
    "manifest is malformed",
  );
});

Deno.test("requires exact manifest functions matching the emitted bundles", () => {
  for (
    const manifest of [
      {},
      { functions: null },
      { functions: [] },
      { functions: { report_github_relay_progress: {} } },
      {
        functions: {
          report_github_relay_progress: {},
          validate_github_relay_message: {},
          unexpected: {},
        },
      },
    ]
  ) {
    assertThrows(
      () => verifyBuildArtifacts(COMPLETE_BUILD, JSON.stringify(manifest)),
      "manifest function inventory changed",
    );
  }
});

Deno.test("checks the exact generated function bundles and rejects invalid syntax", async () => {
  let checkedPaths: readonly string[] = [];
  await verifyBundleSyntax("C:/tmp/slack-build", (paths) => {
    checkedPaths = paths;
    return Promise.resolve(true);
  });
  const normalized = checkedPaths.map((path) => path.replaceAll("\\", "/"));
  if (
    JSON.stringify(normalized) !== JSON.stringify([
      "C:/tmp/slack-build/functions/report_github_relay_progress.js",
      "C:/tmp/slack-build/functions/validate_github_relay_message.js",
    ])
  ) {
    throw new Error(`Unexpected bundle syntax paths: ${normalized.join(", ")}`);
  }

  await assertRejects(
    () =>
      verifyBundleSyntax("C:/tmp/slack-build", () => Promise.resolve(false)),
    "generated function bundle is invalid",
  );
});

Deno.test("requires a callable default handler from every generated function bundle", async () => {
  verifyBundleHandlerNamespaces([
    { default: () => undefined },
    { default: () => undefined },
  ]);
  assertThrows(
    () => verifyBundleHandlerNamespaces([{}, {}]),
    "callable default handler",
  );

  await verifyBundleHandlers("C:/tmp/slack-build", (paths) => {
    if (paths.length !== 2) throw new Error("Unexpected handler path count");
    return Promise.resolve({
      success: true,
      output:
        "SLACK_BUNDLE_HANDLERS_VERIFIED_V1:report_github_relay_progress,validate_github_relay_message\n",
    });
  });

  await assertRejects(
    () =>
      verifyBundleHandlers(
        "C:/tmp/slack-build",
        () => Promise.resolve({ success: false, output: "" }),
      ),
    "callable default handler",
  );
  await assertRejects(
    () =>
      verifyBundleHandlers(
        "C:/tmp/slack-build",
        () => Promise.resolve({ success: true, output: "" }),
      ),
    "callable default handler",
  );
});

Deno.test("executes the official esbuild fallback for both reviewed function sources", async () => {
  const calls: Array<{
    entrypoint: string;
    configPath: string;
    absWorkingDir: string;
  }> = [];
  const appRoot = Deno.build.os === "windows"
    ? "C:/reviewed-app"
    : "/reviewed-app";
  const bundles = await bundleWithEsbuildFallback(
    appRoot,
    (options) => {
      calls.push(options);
      return Promise.resolve(
        new TextEncoder().encode("export default () => {};"),
      );
    },
  );
  const normalizedCalls = calls.map((call) => ({
    ...call,
    entrypoint: call.entrypoint.replaceAll("\\", "/"),
    configPath: call.configPath.replaceAll("\\", "/"),
    absWorkingDir: call.absWorkingDir.replaceAll("\\", "/"),
  }));
  if (
    JSON.stringify(normalizedCalls) !== JSON.stringify([
        {
          entrypoint: "functions/report_relay_progress.ts",
          configPath: `${appRoot}/deno.jsonc`,
          absWorkingDir: appRoot,
        },
        {
          entrypoint: "functions/validate_relay_message.ts",
          configPath: `${appRoot}/deno.jsonc`,
          absWorkingDir: appRoot,
        },
      ]) || bundles.length !== 2
  ) {
    throw new Error("The official esbuild fallback call contract changed");
  }

  await assertRejects(
    () =>
      bundleWithEsbuildFallback(
        appRoot,
        () => Promise.resolve(new Uint8Array()),
      ),
    "empty bundle",
  );

  const swappedManifest = {
    functions: {
      report_github_relay_progress: {
        source_file: "functions/validate_relay_message.ts",
      },
      validate_github_relay_message: {
        source_file: "functions/report_relay_progress.ts",
      },
    },
  };
  assertThrows(
    () => resolveManifestFunctionSources(swappedManifest),
    "manifest source_file changed",
  );
  await assertRejects(
    () =>
      bundleWithEsbuildFallback(
        appRoot,
        () => Promise.resolve(new Uint8Array([1])),
        swappedManifest,
      ),
    "manifest source_file changed",
  );
});

async function assertRejects(
  action: () => Promise<unknown>,
  expected: string,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(expected)) return;
    throw new Error(
      `Expected rejection containing "${expected}", received "${message}"`,
    );
  }
  throw new Error(`Expected action to reject "${expected}"`);
}
