import {
  EXPECTED_DENO_TASKS,
  EXPECTED_ESBUILD_PLATFORM_INTEGRITIES,
  readVerificationConfiguration,
  verifyAncestorResolutionBoundary,
  verifyAuditOutput,
  verifyEsbuildReachability,
  verifyLatestHookRelease,
  verifyLocalPins,
  verifySlackCliWorkflowContract,
} from "../scripts/verify_dependency_audit.ts";

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

const CLEAN_AUDIT = "No known vulnerabilities found\n";

const HOOKS = JSON.stringify({
  hooks: {
    "get-hooks":
      "deno run -q --allow-read --allow-net https://deno.land/x/deno_slack_hooks@1.5.0/mod.ts",
  },
});

const CONFIG = JSON.stringify({
  $schema:
    "https://raw.githubusercontent.com/denoland/deno/main/cli/schemas/config-file.v1.json",
  fmt: {},
  lint: {},
  lock: { frozen: true },
  nodeModulesDir: "none",
  vendor: false,
  tasks: EXPECTED_DENO_TASKS,
  imports: {
    "npm:esbuild@0.24.2": "npm:esbuild@0.25.0",
    "deno-slack-sdk/mod.ts": "jsr:@slack/sdk@2.15.2",
    "deno-slack-sdk/types.ts": "jsr:@slack/sdk@2.15.2/types.ts",
    "deno-slack-api/mod.ts": "jsr:@slack/api@2.9.3",
  },
});

const REVIEWED_ESBUILD_PLATFORMS = Object.keys(
  EXPECTED_ESBUILD_PLATFORM_INTEGRITIES,
);

const REVIEWED_HOOK_REMOTE = {
  "https://deno.land/x/deno_slack_hooks@1.5.0/build.ts":
    "ec2509e60a7d370c3d2a653b727d01a7330f457c8b77ca7b44976b963c45a063",
  "https://deno.land/x/deno_slack_hooks@1.5.0/bundler/deno2_bundler.ts":
    "f80568d92b02c799cce7c2de62def483e8f132e5f87edbc1236a66adef871e14",
  "https://deno.land/x/deno_slack_hooks@1.5.0/bundler/deno_bundler.ts":
    "b1a23660250d8dbc9ffc8499f2a75dc6da4da3d56f57ef96dfdf8a94c541247c",
  "https://deno.land/x/deno_slack_hooks@1.5.0/bundler/esbuild_bundler.ts":
    "3d1dc26a0bacc50e31bdb5b90afa3e4229d07405e042f783aebd1235da5c761a",
  "https://deno.land/x/deno_slack_hooks@1.5.0/bundler/mods.ts":
    "6e627cc1924f90f4dadc689a2a920260cc46b30d42d964cfa188d28af287d149",
  "https://deno.land/x/deno_slack_hooks@1.5.0/errors.ts":
    "8effa8e4ca0f14978e99f366913e09fbebd3bd658ed88f2689fa0a049d375579",
  "https://deno.land/x/deno_slack_hooks@1.5.0/flags.ts":
    "46c5e4281aa3e3d1fd794bd77eaef2bd120d331abec8cb7924570e8fe2e7e59b",
  "https://deno.land/x/deno_slack_hooks@1.5.0/get_manifest.ts":
    "3fbdbd34ebc78007a8e528d6e5784b3a26b59dc96461d22376aa220e76dfd5de",
  "https://deno.land/x/deno_slack_hooks@1.5.0/get_trigger.ts":
    "5efb218a0ed30a06d41564e3d06c0dcb833c91abfcc8b9ec2531d081765c229c",
  "https://deno.land/x/deno_slack_hooks@1.5.0/libraries.ts":
    "8e8d49d42fcfb69e39c91cb44d1f6a1400741b694bebf39e6adab6e9459c1122",
  "https://deno.land/x/deno_slack_hooks@1.5.0/mod.ts":
    "44be92a67a85191d064048af08d8bf4854c0195eabfe72bffdd4ce4ada3cb84f",
  "https://deno.land/x/deno_slack_hooks@1.5.0/utilities.ts":
    "2227ab599f2e716940da6b0ab4d3628b66d63c95b05af56768045b0e126bbe29",
  "https://deno.land/x/deno_slack_hooks@1.5.0/version.ts":
    "5e84845fa9c8be90d9a404bce266cef1b2b06ac46fa872dc4c37e26fb6bef29c",
};

Deno.test("documents candidate and trusted audit invocations", async () => {
  const readme = await Deno.readTextFile(
    new URL("../README.md", import.meta.url),
  );
  for (
    const required of [
      "env -u GITHUB_TOKEN GITHUB_EVENT_NAME=merge_group deno task --config=deno.jsonc --frozen audit",
      "GITHUB_EVENT_NAME=workflow_dispatch deno task --config=deno.jsonc --frozen audit",
    ]
  ) {
    if (!readme.includes(required)) {
      throw new Error(
        `README is missing the exact audit invocation: ${required}`,
      );
    }
  }
});

const LOCK = JSON.stringify({
  specifiers: { "npm:esbuild@0.25.0": "0.25.0" },
  npm: {
    "esbuild@0.25.0": {
      integrity:
        "sha512-BXq5mqc8ltbaN34cDqWuYKyNhX8D/Z0J1xdtdQ8UcIIIyJyz+ZMKUt58tF3SrZ85jcfN/PZYhjR5uDQAYNVbuw==",
      optionalDependencies: REVIEWED_ESBUILD_PLATFORMS,
    },
    ...Object.fromEntries(
      REVIEWED_ESBUILD_PLATFORMS.map((name) => [
        `${name}@0.25.0`,
        {
          integrity: EXPECTED_ESBUILD_PLATFORM_INTEGRITIES[
            name as keyof typeof EXPECTED_ESBUILD_PLATFORM_INTEGRITIES
          ],
        },
      ]),
    ),
  },
  remote: REVIEWED_HOOK_REMOTE,
});

Deno.test("keeps candidate events tokenless and trusted events live", () => {
  for (const eventName of ["pull_request", "merge_group"]) {
    const configuration = readVerificationConfiguration({
      GITHUB_EVENT_NAME: eventName,
      GITHUB_TOKEN: "",
    });
    if (configuration.verifyUpstreamLive) {
      throw new Error(`${eventName} unexpectedly enabled live verification`);
    }
    assertThrows(
      () =>
        readVerificationConfiguration({
          GITHUB_EVENT_NAME: eventName,
          GITHUB_TOKEN: "candidate-must-not-receive-this-token",
        }),
      "must not receive GITHUB_TOKEN",
    );
  }

  for (
    const eventName of [
      "push",
      "schedule",
      "workflow_dispatch",
    ]
  ) {
    const configuration = readVerificationConfiguration({
      GITHUB_EVENT_NAME: eventName,
      GITHUB_TOKEN: "trusted-job-token",
    });
    if (!configuration.verifyUpstreamLive) {
      throw new Error(`${eventName} unexpectedly skipped live verification`);
    }
    assertThrows(
      () =>
        readVerificationConfiguration({
          GITHUB_EVENT_NAME: eventName,
          GITHUB_TOKEN: "",
        }),
      "requires GITHUB_TOKEN",
    );
  }

  assertThrows(
    () =>
      readVerificationConfiguration({
        GITHUB_EVENT_NAME: "workflow_run",
        GITHUB_TOKEN: "trusted-job-token",
      }),
    "unsupported GITHUB_EVENT_NAME",
  );

  assertThrows(
    () => readVerificationConfiguration({ GITHUB_TOKEN: "" }),
    "GITHUB_EVENT_NAME",
  );
});

Deno.test("requires a clean dependency audit", () => {
  verifyAuditOutput(CLEAN_AUDIT, 0);
});

Deno.test("rejects any advisory or nonzero audit exit", () => {
  assertThrows(
    () => verifyAuditOutput("Found 1 vulnerability\n", 1),
    "must be vulnerability-free",
  );
  assertThrows(
    () => verifyAuditOutput("GHSA-aaaa-bbbb-cccc\n", 0),
    "reported an advisory",
  );
});

Deno.test("validates the exact local hook, override, and clean lockfile", () => {
  verifyLocalPins(HOOKS, CONFIG, LOCK);
  for (
    const mutation of [
      {
        scopes: {
          "https://deno.land/x/deno_slack_hooks@1.5.0/": {
            "npm:esbuild@0.24.2": "./shim.ts",
          },
        },
      },
      {
        imports: {
          ...JSON.parse(CONFIG).imports,
          "https://deno.land/x/deno_slack_hooks@1.5.0/bundler/esbuild_bundler.ts":
            "./shim.ts",
        },
      },
      {
        imports: {
          ...JSON.parse(CONFIG).imports,
          "https://deno.land/x/deno_slack_hooks@1.5.0/": "./fake-hooks/",
        },
      },
      {
        imports: {
          ...JSON.parse(CONFIG).imports,
          "deno-slack-sdk/mod.ts": "./fake-sdk.ts",
        },
      },
      {
        imports: {
          ...JSON.parse(CONFIG).imports,
          "deno-slack-sdk/types.ts": "./fake-types.ts",
        },
      },
      {
        imports: {
          ...JSON.parse(CONFIG).imports,
          "deno-slack-api/mod.ts": "./fake-api.ts",
        },
      },
      { links: ["./local-esbuild"] },
      { importMap: "./alternate-import-map.json" },
    ]
  ) {
    assertThrows(
      () =>
        verifyLocalPins(
          HOOKS,
          JSON.stringify({ ...JSON.parse(CONFIG), ...mutation }),
          LOCK,
        ),
      "exact reviewed import-map surface",
    );
  }
  for (const nodeModulesDir of ["manual", "auto"]) {
    assertThrows(
      () =>
        verifyLocalPins(
          HOOKS,
          JSON.stringify({ ...JSON.parse(CONFIG), nodeModulesDir }),
          LOCK,
        ),
      'nodeModulesDir="none"',
    );
  }
  const implicitNodeModules = JSON.parse(CONFIG);
  delete implicitNodeModules.nodeModulesDir;
  assertThrows(
    () => verifyLocalPins(HOOKS, JSON.stringify(implicitNodeModules), LOCK),
    'nodeModulesDir="none"',
  );
  for (const vendor of [true, "./vendor"] as const) {
    assertThrows(
      () =>
        verifyLocalPins(
          HOOKS,
          JSON.stringify({ ...JSON.parse(CONFIG), vendor }),
          LOCK,
        ),
      "vendor=false",
    );
  }
  const implicitVendor = JSON.parse(CONFIG);
  delete implicitVendor.vendor;
  assertThrows(
    () => verifyLocalPins(HOOKS, JSON.stringify(implicitVendor), LOCK),
    "vendor=false",
  );
  for (
    const mutation of [
      { workspace: ["./fake-workspace"] },
      {
        name: "@slack/sdk",
        version: "2.15.2",
        exports: { ".": "./fake-sdk.ts" },
      },
      { unexpectedResolutionSurface: true },
    ]
  ) {
    assertThrows(
      () =>
        verifyLocalPins(
          HOOKS,
          JSON.stringify({ ...JSON.parse(CONFIG), ...mutation }),
          LOCK,
        ),
      "exact reviewed top-level configuration surface",
    );
  }
  assertThrows(
    () =>
      verifyLocalPins(
        JSON.stringify({
          hooks: {
            ...JSON.parse(HOOKS).hooks,
            build: "deno run ./scripts/alternate_build.ts",
          },
        }),
        CONFIG,
        LOCK,
      ),
    "must remain pinned",
  );
  assertThrows(
    () =>
      verifyLocalPins(
        JSON.stringify({ ...JSON.parse(HOOKS), unexpected: true }),
        CONFIG,
        LOCK,
      ),
    "must remain pinned",
  );
  assertThrows(
    () =>
      verifyLocalPins(
        HOOKS,
        JSON.stringify({
          lock: { frozen: true, path: "./alternate.lock" },
          imports: JSON.parse(CONFIG).imports,
        }),
        LOCK,
      ),
    "production lock frozen",
  );
  assertThrows(
    () =>
      verifyLocalPins(
        HOOKS.replace("@1.5.0", "@1.5.1"),
        CONFIG,
        LOCK,
      ),
    "must remain pinned",
  );
  assertThrows(
    () => verifyLocalPins(HOOKS, JSON.stringify({ imports: {} }), LOCK),
    "production lock frozen",
  );
  assertThrows(
    () =>
      verifyLocalPins(
        HOOKS,
        JSON.stringify({ lock: true, imports: JSON.parse(CONFIG).imports }),
        LOCK,
      ),
    "production lock frozen",
  );
  assertThrows(
    () =>
      verifyLocalPins(
        HOOKS,
        JSON.stringify({
          lock: { frozen: true },
          nodeModulesDir: "none",
          vendor: false,
          imports: {},
        }),
        LOCK,
      ),
    "exact reviewed import-map surface",
  );
  assertThrows(
    () =>
      verifyLocalPins(
        HOOKS,
        CONFIG.replace("npm:esbuild@0.25.0", "npm:esbuild@^0.25.0"),
        LOCK,
      ),
    "exact reviewed import-map surface",
  );
  assertThrows(
    () =>
      verifyLocalPins(
        HOOKS,
        CONFIG,
        LOCK.replace(
          '"npm:esbuild@0.25.0":"0.25.0"',
          '"npm:esbuild@0.24.2":"0.24.2","npm:esbuild@0.25.0":"0.25.0"',
        ),
      ),
    "unexpected esbuild specifier set",
  );
  const stalePlatform = JSON.parse(LOCK);
  stalePlatform.npm["@esbuild/linux-x64@0.24.2"] = { integrity: "stale" };
  assertThrows(
    () => verifyLocalPins(HOOKS, CONFIG, JSON.stringify(stalePlatform)),
    "unexpected esbuild platform package set",
  );
  const changedPlatformIntegrity = JSON.parse(LOCK);
  changedPlatformIntegrity.npm["@esbuild/linux-x64@0.25.0"].integrity =
    "sha512-unreviewed";
  assertThrows(
    () =>
      verifyLocalPins(
        HOOKS,
        CONFIG,
        JSON.stringify(changedPlatformIntegrity),
      ),
    "unexpected esbuild platform package set",
  );
  for (const task of ["audit", "check"] as const) {
    const changedTasks = JSON.parse(CONFIG);
    changedTasks.tasks[task] = "echo skipped";
    assertThrows(
      () => verifyLocalPins(HOOKS, JSON.stringify(changedTasks), LOCK),
      "exact reviewed task surface",
    );
  }
});

Deno.test("rejects every repository-root workspace that can override member resolution", () => {
  verifyAncestorResolutionBoundary('{"private":true}');
  for (
    const packageText of [
      '{"private":true,"workspaces":["slack/github-integration"]}',
      '{"private":true,"workspaces":{"packages":["slack/*"]}}',
    ]
  ) {
    assertThrows(
      () => verifyAncestorResolutionBoundary(packageText),
      "outside every ancestor",
    );
  }
  assertThrows(
    () => verifyAncestorResolutionBoundary('{"private":true}', "{}"),
    "outside every ancestor",
  );
  assertThrows(
    () => verifyAncestorResolutionBoundary('{"private":true}', undefined, "{}"),
    "outside every ancestor",
  );
  assertThrows(
    () =>
      verifyAncestorResolutionBoundary(
        '{"private":true}',
        undefined,
        undefined,
        '{"workspaces":["github-integration"]}',
      ),
    "outside every ancestor",
  );
  assertThrows(
    () =>
      verifyAncestorResolutionBoundary(
        '{"private":true}',
        undefined,
        undefined,
        undefined,
        "{}",
      ),
    "outside every ancestor",
  );
  assertThrows(
    () =>
      verifyAncestorResolutionBoundary(
        '{"private":true}',
        undefined,
        undefined,
        undefined,
        undefined,
        "{}",
      ),
    "outside every ancestor",
  );
  assertThrows(
    () =>
      verifyAncestorResolutionBoundary(
        '{"private":true}',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        '{"workspaces":["."]}',
      ),
    "outside every ancestor",
  );
  assertThrows(
    () =>
      verifyAncestorResolutionBoundary(
        '{"private":true}',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "{}",
      ),
    "outside every ancestor",
  );
});

Deno.test("the checked-in production hook graph satisfies the exact local contract", async () => {
  const [hooks, config, lock, rootPackage] = await Promise.all([
    Deno.readTextFile(new URL("../.slack/hooks.json", import.meta.url)),
    Deno.readTextFile(new URL("../deno.jsonc", import.meta.url)),
    Deno.readTextFile(new URL("../deno.lock", import.meta.url)),
    Deno.readTextFile(new URL("../../../package.json", import.meta.url)),
  ]);
  verifyLocalPins(hooks, config, lock);
  verifyAncestorResolutionBoundary(rootPackage);
});

Deno.test("production keeps all Slack CLI calls on the pinned no-update path", async () => {
  const workflow = await Deno.readTextFile(
    new URL(
      "../../../.github/workflows/github-slack-integration.yml",
      import.meta.url,
    ),
  );
  verifySlackCliWorkflowContract(workflow);

  assertThrows(
    () =>
      verifySlackCliWorkflowContract(
        workflow.replace('SLACK_SKIP_UPDATE: "1"', 'SLACK_SKIP_UPDATE: "0"'),
      ),
    "job-level update suppression",
  );
  assertThrows(
    () =>
      verifySlackCliWorkflowContract(
        workflow.replace('      SLACK_SKIP_UPDATE: "1"\n', "").replace(
          "      - name: Checkout verified revision without persisted credentials\n",
          '      - name: Checkout verified revision without persisted credentials\n        env:\n          SLACK_SKIP_UPDATE: "1"\n',
        ),
      ),
    "job-level update suppression",
  );
  assertThrows(
    () =>
      verifySlackCliWorkflowContract(
        workflow.replace(
          "          SLACK_CLI_VERSION: 4.6.0",
          "          # SLACK_CLI_VERSION: 4.6.0",
        ),
      ),
    "version pin changed",
  );
  assertThrows(
    () =>
      verifySlackCliWorkflowContract(
        workflow.replace('      SLACK_SKIP_UPDATE: "1"\n', "").replace(
          "  verify:\n",
          '  verify:\n    env:\n      SLACK_SKIP_UPDATE: "1"\n',
        ),
      ),
    "job-level update suppression",
  );
  assertThrows(
    () =>
      verifySlackCliWorkflowContract(
        workflow.replace('      SLACK_SKIP_UPDATE: "1"\n', "") +
          '\n  later_job:\n    env:\n      SLACK_SKIP_UPDATE: "1"\n    runs-on: ubuntu-latest\n',
      ),
    "job-level update suppression",
  );
  assertThrows(
    () =>
      verifySlackCliWorkflowContract(
        workflow.replace('      SLACK_SKIP_UPDATE: "1"\n', "") +
          '\n  "quoted_job":\n    env:\n      SLACK_SKIP_UPDATE: "1"\n    steps:\n      - run: echo noop\n    runs-on: ubuntu-latest\n',
      ),
    "job-level update suppression",
  );
  assertThrows(
    () =>
      verifySlackCliWorkflowContract(
        workflow.replace('      SLACK_SKIP_UPDATE: "1"\n', "") +
          '\n  later_job: # valid YAML comment\n    env:\n      SLACK_SKIP_UPDATE: "1"\n    steps:\n      - run: echo noop\n    runs-on: ubuntu-latest\n',
      ),
    "job-level update suppression",
  );
  assertThrows(
    () =>
      verifySlackCliWorkflowContract(
        workflow.replace('      SLACK_SKIP_UPDATE: "1"\n', "") +
          '\n  ? later_job\n  :\n    env:\n      SLACK_SKIP_UPDATE: "1"\n    steps:\n      - run: echo noop\n    runs-on: ubuntu-latest\n',
      ),
    "job-level update suppression",
  );
  assertThrows(
    () =>
      verifySlackCliWorkflowContract(
        workflow.replace(" version --skip-update)", " version)"),
      ),
    "verified Slack CLI asset contract",
  );
  assertThrows(
    () =>
      verifySlackCliWorkflowContract(
        workflow.replace("        id: install-slack-cli\n", "").replace(
          "      - name: Stage the new relay signer as Slack NEXT\n",
          "      - name: Stage the new relay signer as Slack NEXT\n        id: install-slack-cli\n",
        ),
      ),
    "verified Slack CLI output owner changed",
  );
  assertThrows(
    () =>
      verifySlackCliWorkflowContract(
        workflow.replace(
          '          set -euo pipefail\n          : "${SLACK_APP_ID:?Missing SLACK_GITHUB_INTEGRATION_APP_ID}"',
          '          set -euo pipefail\n          exit 0\n          : "${SLACK_APP_ID:?Missing SLACK_GITHUB_INTEGRATION_APP_ID}"',
        ),
      ),
    "exact production Slack deployment job changed",
  );
  assertThrows(
    () =>
      verifySlackCliWorkflowContract(
        workflow
          .replace(
            '          test -f "$install_root/bin/slack"',
            '          # test -f "$install_root/bin/slack"',
          )
          .replace(
            '          chmod 0755 "$install_root/bin/slack"',
            '          # chmod 0755 "$install_root/bin/slack"',
          )
          .replace(
            '          version_output=$("$install_root/bin/slack" version --skip-update)',
            '          # version_output=$("$install_root/bin/slack" version --skip-update)',
          )
          .replace(
            '          printf \'slack_bin=%s\\n\' "$install_root/bin/slack" >> "$GITHUB_OUTPUT"',
            '          # printf \'slack_bin=%s\\n\' "$install_root/bin/slack" >> "$GITHUB_OUTPUT"',
          ),
      ),
    "verified Slack CLI asset contract",
  );
  assertThrows(
    () =>
      verifySlackCliWorkflowContract(
        workflow + '\n          "$install_root/bin/slack" doctor\n',
      ),
    "verified Slack CLI asset contract",
  );
  assertThrows(
    () =>
      verifySlackCliWorkflowContract(
        workflow.replace(
          '          test -f "$install_root/bin/slack"',
          '          test -d "$install_root/bin"',
        ).replace(
          '          chmod 0755 "$install_root/bin/slack"',
          '          "$install_root/bin/slack" doctor --skip-update',
        ),
      ),
    "verified Slack CLI asset contract",
  );
  assertThrows(
    () =>
      verifySlackCliWorkflowContract(
        workflow +
          '\n          SLACK_ALT="${{ steps.install-slack-cli.outputs.slack_bin }}"\n',
      ),
    "Slack CLI output binding contract",
  );
  const binding =
    "          SLACK_BIN: ${{ steps.install-slack-cli.outputs.slack_bin }}";
  assertThrows(
    () =>
      verifySlackCliWorkflowContract(
        workflow.replace(`${binding}\n`, "").replace(
          '          set -euo pipefail\n          : "${SLACK_APP_ID:?Missing SLACK_GITHUB_INTEGRATION_APP_ID}"',
          binding +
            '\n          set -euo pipefail\n          : "${SLACK_APP_ID:?Missing SLACK_GITHUB_INTEGRATION_APP_ID}"',
        ),
      ),
    "Slack CLI output binding contract",
  );
  assertThrows(
    () =>
      verifySlackCliWorkflowContract(
        workflow.replace(`${binding}\n`, "").replace(
          "      - name: Update the two protected production webhook triggers",
          `      - run: echo noop\n        env:\n${binding}\n\n      - name: Update the two protected production webhook triggers`,
        ),
      ),
    "Slack CLI output binding contract",
  );
  assertThrows(
    () =>
      verifySlackCliWorkflowContract(
        workflow.replace(`${binding}\n`, "").replace(
          "      - name: Update the two protected production webhook triggers",
          `      -\n        env:\n${binding}\n        run: echo noop\n\n      - name: Update the two protected production webhook triggers`,
        ),
      ),
    "Slack CLI output binding contract",
  );
  assertThrows(
    () =>
      verifySlackCliWorkflowContract(
        workflow.replace(`${binding}\n`, "").replace(
          "          SLACK_RELAY_SIGNING_SECRET: ${{ secrets.SLACK_RELAY_SIGNING_SECRET }}",
          binding +
            "\n          SLACK_RELAY_SIGNING_SECRET: ${{ secrets.SLACK_RELAY_SIGNING_SECRET }}",
        ),
      ),
    "Slack CLI output binding contract",
  );
  assertThrows(
    () =>
      verifySlackCliWorkflowContract(
        workflow.replace(
          '          "$SLACK_BIN" deploy',
          '          SLACK_BIN=/tmp/unverified-slack\n          "$SLACK_BIN" deploy',
        ),
      ),
    "Slack CLI binding surface changed",
  );
  assertThrows(
    () =>
      verifySlackCliWorkflowContract(
        workflow.replaceAll(
          "          SLACK_BIN: ${{ steps.install-slack-cli.outputs.slack_bin }}",
          "          # SLACK_BIN: ${{ steps.install-slack-cli.outputs.slack_bin }}",
        ),
      ),
    "Slack CLI output binding contract",
  );
  assertThrows(
    () =>
      verifySlackCliWorkflowContract(
        workflow.replace(
          "          SLACK_BIN: ${{ steps.install-slack-cli.outputs.slack_bin }}",
          "          SLACK_ALT: ${{ steps.install-slack-cli.outputs.slack_bin }}",
        ),
      ),
    "Slack CLI output binding contract",
  );

  for (let index = 0; index < 5; index += 1) {
    let seen = -1;
    const withoutOneSkip = workflow.replace(
      /\s+--skip-update/g,
      (match) => ++seen === index ? "" : match,
    );
    assertThrows(
      () => verifySlackCliWorkflowContract(withoutOneSkip),
      index === 0
        ? "verified Slack CLI asset contract"
        : "must keep exactly one --skip-update",
    );
  }

  assertThrows(
    () =>
      verifySlackCliWorkflowContract(
        workflow.replace('"$SLACK_BIN" deploy', '"$SLACK_BIN" doctor'),
      ),
    "command contract changed",
  );
  assertThrows(
    () =>
      verifySlackCliWorkflowContract(
        workflow.replace("api workflows.triggers.list", "doctor"),
      ),
    "command contract changed",
  );
  assertThrows(
    () =>
      verifySlackCliWorkflowContract(
        workflow + '\n          "${SLACK_BIN}" doctor --skip-update\n',
      ),
    "canonical",
  );
  assertThrows(
    () =>
      verifySlackCliWorkflowContract(
        workflow.replace(
          "            --skip-update\n",
          "            # --skip-update is not an argument\n",
        ),
      ),
    "command contract changed",
  );
  assertThrows(
    () =>
      verifySlackCliWorkflowContract(
        workflow.replace(
          "            --skip-update\n",
          "            ; echo --skip-update\n",
        ),
      ),
    "command contract changed",
  );
  assertThrows(
    () =>
      verifySlackCliWorkflowContract(
        workflow +
          '\n          "${SLACK_BIN:?missing}" doctor --skip-update\n',
      ),
    "canonical",
  );

  for (
    const replacement of [
      '"${SLACK_BIN}" deploy',
      "$SLACK_BIN deploy",
      'true; "$SLACK_BIN" deploy',
    ]
  ) {
    assertThrows(
      () =>
        verifySlackCliWorkflowContract(
          workflow.replace('"$SLACK_BIN" deploy', replacement),
        ),
      replacement.startsWith("true;")
        ? "command contract changed"
        : "canonical",
    );
  }

  for (
    const injected of [
      "| echo",
      "&& echo",
      ">unexpected.log",
      "$(echo unexpected)",
      "`echo unexpected`",
    ]
  ) {
    assertThrows(
      () =>
        verifySlackCliWorkflowContract(
          workflow.replace(
            "            --hide-triggers \\\n            --skip-update",
            `            --hide-triggers ${injected} \\\n            --skip-update`,
          ),
        ),
      "command contract changed",
    );
  }

  assertThrows(
    () =>
      verifySlackCliWorkflowContract(
        workflow.replace(
          "            --skip-update\n",
          '            --skip-update || "$SLACK_BIN" doctor\n',
        ),
      ),
    "exactly four",
  );
  assertThrows(
    () =>
      verifySlackCliWorkflowContract(
        workflow.replace(
          "            --skip-update\n",
          "            --skip-update --skip-update=false\n",
        ),
      ),
    "command contract changed",
  );

  for (const trailingWhitespace of ["   ", "\t"]) {
    assertThrows(
      () =>
        verifySlackCliWorkflowContract(
          workflow.replace(
            /(--hide-triggers \\)(\r?\n)/,
            `$1${trailingWhitespace}$2`,
          ),
        ),
      "command contract changed",
    );
  }

  for (const unicodeWhitespace of ["\u00a0", "\u2003"]) {
    assertThrows(
      () =>
        verifySlackCliWorkflowContract(
          workflow.replace(
            "            --skip-update\n",
            `            ${unicodeWhitespace}--skip-update\n`,
          ),
        ),
      "must keep exactly one --skip-update",
    );
  }
  assertThrows(
    () =>
      verifySlackCliWorkflowContract(
        workflow.replace("--hide-triggers \\", "--hide-triggers\u00a0\\"),
      ),
    "command contract changed",
  );
});

Deno.test("rejects a partial or changed reviewed Slack hook lock graph", () => {
  const missingGetTrigger = JSON.parse(LOCK);
  delete missingGetTrigger.remote[
    "https://deno.land/x/deno_slack_hooks@1.5.0/get_trigger.ts"
  ];
  assertThrows(
    () => verifyLocalPins(HOOKS, CONFIG, JSON.stringify(missingGetTrigger)),
    "reviewed deno_slack_hooks lock graph changed",
  );

  const changedHash = JSON.parse(LOCK);
  changedHash.remote[
    "https://deno.land/x/deno_slack_hooks@1.5.0/get_trigger.ts"
  ] = "0".repeat(64);
  assertThrows(
    () => verifyLocalPins(HOOKS, CONFIG, JSON.stringify(changedHash)),
    "reviewed deno_slack_hooks lock graph changed",
  );
});

Deno.test("allows only build and stop in the reviewed hook", () => {
  verifyEsbuildReachability(`
    import * as esbuild from "npm:esbuild@0.24.2";
    await esbuild.build({ write: false });
    esbuild.stop();
  `);
  assertThrows(
    () =>
      verifyEsbuildReachability(`
        import * as esbuild from "npm:esbuild@0.24.2";
        const context = await esbuild.context({});
        await context.serve();
        esbuild.stop();
      `),
    "call set changed",
  );
});

Deno.test("accepts only the reviewed latest stable hook release", () => {
  verifyLatestHookRelease({
    tag_name: "1.5.0",
    draft: false,
    prerelease: false,
  });
  assertThrows(
    () =>
      verifyLatestHookRelease({
        tag_name: "1.5.1",
        draft: false,
        prerelease: false,
      }),
    "1.5.1 is the latest stable release",
  );
  assertThrows(
    () =>
      verifyLatestHookRelease({
        tag_name: "1.5.0",
        draft: true,
        prerelease: false,
      }),
    "draft or prerelease",
  );
  assertThrows(
    () =>
      verifyLatestHookRelease({
        tag_name: "1.5.0",
        draft: false,
        prerelease: true,
      }),
    "draft or prerelease",
  );
  assertThrows(
    () => verifyLatestHookRelease(null),
    "no latest deno_slack_hooks release",
  );
});
