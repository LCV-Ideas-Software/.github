import { createHash } from "node:crypto";

const UPSTREAM_ESBUILD_VERSION = "0.24.2";
const EXPECTED_ESBUILD_VERSION = "0.28.1";
export const EXPECTED_HOOK_TAG = "1.5.0";
export const EXPECTED_HOOK_BUILD_URL =
  `https://deno.land/x/deno_slack_hooks@${EXPECTED_HOOK_TAG}/build.ts`;
export const EXPECTED_HOOK_ESBUILD_URL =
  `https://deno.land/x/deno_slack_hooks@${EXPECTED_HOOK_TAG}/bundler/esbuild_bundler.ts`;
const EXPECTED_HOOK_REMOTE_HASHES: Record<string, string> = {
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
const EXPECTED_TAG_OBJECT = "8f28d9314044f1c1533c609854c15460a095128a";
const EXPECTED_HOOK_COMMIT = "b6719c18a18a39ca44fa1b311c3bada28dc3df35";
const EXPECTED_SOURCE_HASH =
  "3d1dc26a0bacc50e31bdb5b90afa3e4229d07405e042f783aebd1235da5c761a";
const EXPECTED_PACKAGE_INTEGRITY =
  "sha512-HrJrvZv5ayxBzPfwphOoNzkzOIIlifzk0KJrGK2c8R4+LKpMtpYLQeUdjnwjWv/LZlkH2laZk+4w78pi99D4Vw==";
const EXPECTED_IMPORTS = {
  "deno-slack-api/mod.ts": "jsr:@slack/api@2.9.3",
  "deno-slack-sdk/mod.ts": "jsr:@slack/sdk@2.15.2",
  "deno-slack-sdk/types.ts": "jsr:@slack/sdk@2.15.2/types.ts",
  [`npm:esbuild@${UPSTREAM_ESBUILD_VERSION}`]:
    `npm:esbuild@${EXPECTED_ESBUILD_VERSION}`,
} as const;
export const EXPECTED_ESBUILD_PLATFORM_INTEGRITIES = {
  "@esbuild/aix-ppc64":
    "sha512-Svl7tq8k/08+p6CXPpRjQ1fKX+1odH/BQbb48fV6fj3CWHhsoIOoY87w1oHXm0qEpkIK3ZfVgp0hed3XBXzXMQ==",
  "@esbuild/android-arm":
    "sha512-0k2F129Xdio1TdJfzJ8sy1Q47vUD2NnwdhiAf7drUN1EBTfPf4hsFCtmMgu/6m8JSzsBrlmVjudMBQqOfG8usQ==",
  "@esbuild/android-arm64":
    "sha512-34EGEbCIAgosYz6goLcopX6Mo7NyGv9tfwEM2/7Ce2VcVRk568iSvniGWcUXIy7wEDR1wzolcxcriFVrWYcwBg==",
  "@esbuild/android-x64":
    "sha512-dbwY7ltSMDWsRatcRpCnES4F+im88OCUgGZjy52shC7GqHRE/cYlxNbB4Z4UpJswpcc4Qxd2oE/ufM0p61IKng==",
  "@esbuild/darwin-arm64":
    "sha512-TZbWkQY7kvTAXbXUT7uVACR5cMHsDiSz9z7ZKAX/RTq/WJEk3QyRr0wZpNhBDX+/0CtdqUIJlOiodQcta6tY3Q==",
  "@esbuild/darwin-x64":
    "sha512-zfdzgK9ACBNZLI/CyHTOx81SyNbM6YXn7rxSgX97VjyiPl9W1i4Ka4fgKECEoFCKGpvBj5qArWIGgQjOwkgskQ==",
  "@esbuild/freebsd-arm64":
    "sha512-wG2EA8ENdEI0qhkSZMjfqrdY+ziCYCPMmtZjjIwOmXFjmyzEHn+UUxk5of+SYsjtfs3VpnlC7QLzSI5hY/rOAw==",
  "@esbuild/freebsd-x64":
    "sha512-i7dZ9vQgnvSCzi/rYCXNgtF/U+eKZNJBzu3eTQbRgHnM7tNSizLOkRFAl3qzVc/Op/u5YkHHa4pf/3DOYHthLQ==",
  "@esbuild/linux-arm":
    "sha512-qVXBOHQS+d5Y722GwJzJUtOLlX7km3CraOaGormF1pDtPd2C/l1SHRPgjLunLGe51Sh5YYWKMFDyV4SxgMQYTQ==",
  "@esbuild/linux-arm64":
    "sha512-yHs+0uc8+nvEAfAfxrWQKK5peSNzBc4PegcMO0EJ2hT71uA7vB8Ihg2e77R2P7SG5uYjPbHlLLmve4LLLRCf0g==",
  "@esbuild/linux-ia32":
    "sha512-d1z4ZuP0ajrfz/FhGT4vv278rX8KnPPJx8i5+AtK7TYbx9Le9F1hyzurZpkEyjkGa9dUGhQow4C1NmeGvqxN2w==",
  "@esbuild/linux-loong64":
    "sha512-M5sRjUVZrkm1OAPR3dlOYzNmN+loZKGVi1VUQGrwuqLcbR6qeAz+famMhjASeH3YVKvZz+zT1jlh/keC3Rj/lg==",
  "@esbuild/linux-mips64el":
    "sha512-mRObBZeHh2OxcBFPWE/FjylkRgZdYuiTR3vaTozquCGOH14iP9oN4x4Ge81CoIDYQrXmIxpFumJBu5MtZpnQJQ==",
  "@esbuild/linux-ppc64":
    "sha512-slScBsMAb3GFDcdrCgLwZtPYRoH2H/youv10QiZyRjmsP48fznoveWytSgCI/R0ZcUgpc0ZhIUEx6LHts8yrfQ==",
  "@esbuild/linux-riscv64":
    "sha512-kw0owk1o0GFETUJyW0jc0G4Yzs0BHZn0JDZ8JRT088vjJYX777BAs1fDGxAC+q831qOs2DTC96mNsG2opdfyyQ==",
  "@esbuild/linux-s390x":
    "sha512-/lAIjX8aYFRByhh6L5rYtPEDRqa9de/4V/juOXcta5frjvzXO4/sqEtyytse0g3zZFuWu5cDN0MkLz2qRDD2Ag==",
  "@esbuild/linux-x64":
    "sha512-u/anNYF2mmVOEDwLtnQ1wOr3EZ9sTNGLWrsYGYwHWzGA3Si84IOkHXlbWTD1NB+9/1lcnweYKO54uhxZydNzfA==",
  "@esbuild/netbsd-arm64":
    "sha512-oks0DYbLwWMmaakTsCb+zL4E+aHRVLom9IJZOAthMQEPiQmydXHkziYEsGYRx0uNV/IjEKGAV941JzH02pflqw==",
  "@esbuild/netbsd-x64":
    "sha512-aeL6lAnN89Hz43Mlh1G8ARasbuoYvSITDEx0tHh5b7jJnHcssqgjy9Yx430GDpmCa6OyrKoS0aNRjKundRizGg==",
  "@esbuild/openbsd-arm64":
    "sha512-MEFJe5C3R8pwXdZ5Y21oo6m7ePiS0d9pWucn99O/wvyJZChoIQKrQDxKrGeW8F5+T0okTHesAmDeiHDTIq0V/Q==",
  "@esbuild/openbsd-x64":
    "sha512-i/ZLIOafE0Z8cI/XANJAixoJL/uRAoS2xOA3rb0xN+KK0K177cMAsQYkzHtBrtMXAKuAc7HGgcWiZ/sRC1Nxgw==",
  "@esbuild/openharmony-arm64":
    "sha512-ge+Z7EXFNt2BO1oAMsVpiQ8EwndV9i1xXerAeTIK7AtPs3bKFXQM7nlRxDSIUIMeueR1CNXxqztLzdNeReKBJg==",
  "@esbuild/sunos-x64":
    "sha512-BEjgtECkL3vY+SaSQ6nzVfiALUeFxpawyp8Jmf5PtYhf1Ug40N1h/hxlhts+f1FvSvarEigdxS3BlSMI2PJLcQ==",
  "@esbuild/win32-arm64":
    "sha512-lCv9eK/H6ZJWbE7bh2nw54CZ9M2nupBxJcTsdk/QQnWkdSjKGuxmmH8/GWrlT1eMmZfn4dGcCjRte397WqfQXA==",
  "@esbuild/win32-ia32":
    "sha512-zvb/mB2bSCoJOpoCBgYKKpX6YM6mJBlBUVUtVj41DlZJVEB6/0CKlRYxP5wWl1C1ILiCoAU5wZZ4q1P3qeS6Eg==",
  "@esbuild/win32-x64":
    "sha512-bm4Mowrv+GXMlpWX++EcXw/iLyd1o3+bJkC2DkWXYVvgZCqD/bSj9ctZeAMC3cIxgjRVR2Dufaiu4YPxr5gW1A==",
} as const;
const EXPECTED_ESBUILD_PLATFORMS = Object.keys(
  EXPECTED_ESBUILD_PLATFORM_INTEGRITIES,
);
export const EXPECTED_DENO_TASKS = {
  audit:
    "deno run --allow-env=GITHUB_EVENT_NAME,GITHUB_TOKEN --allow-net=api.github.com --allow-read=.slack/hooks.json,package.json,deno.json,deno.jsonc,deno.lock,../package.json,../deno.json,../deno.jsonc,../../package.json,../../deno.json,../../deno.jsonc,../../.github/workflows/github-slack-integration.yml --allow-run=deno scripts/verify_dependency_audit.ts",
  "build:verify":
    "deno run --allow-read --allow-write --allow-run scripts/verify_build.ts",
  "hooks:verify":
    "deno check --frozen --quiet --config=deno.jsonc https://deno.land/x/deno_slack_hooks@1.5.0/mod.ts https://deno.land/x/deno_slack_hooks@1.5.0/get_manifest.ts https://deno.land/x/deno_slack_hooks@1.5.0/build.ts https://deno.land/x/deno_slack_hooks@1.5.0/get_trigger.ts",
  check:
    "deno fmt --check && deno lint && deno check manifest.ts functions/*.ts scripts/*.ts tests/*.ts triggers/*.ts workflows/*.ts && deno test --allow-read=README.md,package.json,deno.json,deno.jsonc,deno.lock,.slack/hooks.json,../package.json,../deno.json,../deno.jsonc,../../package.json,../../deno.json,../../deno.jsonc,../../.github/workflows/github-slack-integration.yml && deno task --frozen hooks:verify && deno task --frozen build:verify",
} as const;
const EXPECTED_DEPLOY_SLACK_JOB_SHA256 =
  "b5e4bb4097c85c02e07aed14a60833287099f13c12bce5e4402edc7324d8e1c9";
const HOOK_REPOSITORY = "slackapi/deno-slack-hooks";
const EXPECTED_HOOK_COMMAND =
  `deno run -q --allow-read --allow-net https://deno.land/x/deno_slack_hooks@${EXPECTED_HOOK_TAG}/mod.ts`;
const EXPECTED_SOURCE_URL =
  `https://deno.land/x/deno_slack_hooks@${EXPECTED_HOOK_TAG}/bundler/esbuild_bundler.ts`;
const ANSI_SEQUENCE = new RegExp(
  `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
  "g",
);

interface Lockfile {
  specifiers?: Record<string, string>;
  npm?: Record<
    string,
    { integrity?: string; optionalDependencies?: string[] }
  >;
  remote?: Record<string, string>;
}

interface GitReference {
  object?: { sha?: string; type?: string };
}

interface GitTag {
  object?: { sha?: string; type?: string };
}

interface GitHubContent {
  content?: string;
  encoding?: string;
}

interface GitHubRelease {
  tag_name?: string;
  draft?: boolean;
  prerelease?: boolean;
}

interface VerificationConfiguration {
  eventName: string;
  token: string | undefined;
  verifyUpstreamLive: boolean;
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_SEQUENCE, "");
}

export function readVerificationConfiguration(
  environment: Record<string, string | undefined>,
): Readonly<VerificationConfiguration> {
  const eventName = environment.GITHUB_EVENT_NAME?.trim();
  invariant(eventName, "GITHUB_EVENT_NAME is required");

  const token = environment.GITHUB_TOKEN;
  const candidateEvent = eventName === "pull_request" ||
    eventName === "merge_group";
  if (candidateEvent) {
    invariant(
      !token,
      `${eventName} candidate verification must not receive GITHUB_TOKEN`,
    );
    return Object.freeze({
      eventName,
      token: undefined,
      verifyUpstreamLive: false,
    });
  }

  invariant(
    eventName === "push" || eventName === "schedule" ||
      eventName === "workflow_dispatch",
    `unsupported GITHUB_EVENT_NAME: ${eventName}`,
  );
  invariant(token, `${eventName} trusted verification requires GITHUB_TOKEN`);
  invariant(
    token === token.trim(),
    `${eventName} trusted GITHUB_TOKEN has surrounding whitespace`,
  );
  return Object.freeze({
    eventName,
    token,
    verifyUpstreamLive: true,
  });
}

export function verifyAuditOutput(output: string, exitCode: number): void {
  const plain = stripAnsi(output);
  invariant(
    exitCode === 0,
    `deno audit returned ${exitCode}; the reviewed graph must be vulnerability-free`,
  );
  invariant(
    !/\bGHSA-[0-9a-z-]+\b/i.test(plain) &&
      !/Found\s+\d+\s+vulnerabilit(?:y|ies)/i.test(plain),
    "deno audit reported an advisory",
  );
  invariant(
    /No known vulnerabilities found/i.test(plain),
    "deno audit did not confirm a vulnerability-free graph",
  );
}

export function verifyLocalPins(
  hooksText: string,
  configText: string,
  lockText: string,
): void {
  const hooks = JSON.parse(hooksText) as {
    hooks?: Record<string, string>;
  };
  invariant(
    JSON.stringify(Object.keys(hooks).sort()) === JSON.stringify(["hooks"]) &&
      JSON.stringify(hooks.hooks) === JSON.stringify({
          "get-hooks": EXPECTED_HOOK_COMMAND,
        }),
    `Slack get-hooks must remain pinned to deno_slack_hooks@${EXPECTED_HOOK_TAG}`,
  );

  const config = JSON.parse(configText) as {
    [key: string]: unknown;
    imports?: Record<string, string>;
    lock?: unknown;
    scopes?: unknown;
    links?: unknown;
    importMap?: unknown;
    nodeModulesDir?: unknown;
    vendor?: unknown;
    tasks?: unknown;
  };
  invariant(
    config.lock !== null && typeof config.lock === "object" &&
      !Array.isArray(config.lock) &&
      JSON.stringify(config.lock) === JSON.stringify({ frozen: true }),
    "deno.jsonc must keep the production lock frozen",
  );
  invariant(
    config.nodeModulesDir === "none",
    'deno.jsonc must keep nodeModulesDir="none"',
  );
  invariant(
    config.vendor === false,
    "deno.jsonc must keep vendor=false",
  );
  invariant(
    config.scopes === undefined && config.links === undefined &&
      config.importMap === undefined &&
      JSON.stringify(
          Object.entries(config.imports ?? {}).sort(([left], [right]) =>
            left.localeCompare(right)
          ),
        ) ===
        JSON.stringify(
          Object.entries(EXPECTED_IMPORTS).sort(([left], [right]) =>
            left.localeCompare(right)
          ),
        ),
    "deno.jsonc must keep the exact reviewed import-map surface",
  );
  invariant(
    JSON.stringify(Object.keys(config).sort()) === JSON.stringify([
      "$schema",
      "fmt",
      "imports",
      "lint",
      "lock",
      "nodeModulesDir",
      "tasks",
      "vendor",
    ]),
    "deno.jsonc must keep the exact reviewed top-level configuration surface",
  );
  invariant(
    JSON.stringify(config.tasks) === JSON.stringify(EXPECTED_DENO_TASKS),
    "deno.jsonc must keep the exact reviewed task surface",
  );

  const lock = JSON.parse(lockText) as Lockfile;
  const esbuildSpecifiers = Object.keys(lock.specifiers ?? {}).filter((key) =>
    key.startsWith("npm:esbuild@")
  );
  invariant(
    esbuildSpecifiers.length === 1 &&
      esbuildSpecifiers[0] === `npm:esbuild@${EXPECTED_ESBUILD_VERSION}` &&
      lock.specifiers?.[esbuildSpecifiers[0]] === EXPECTED_ESBUILD_VERSION,
    "the lockfile contains an unexpected esbuild specifier set",
  );

  const esbuildPackages = Object.keys(lock.npm ?? {}).filter((key) =>
    /^esbuild@/.test(key)
  );
  invariant(
    esbuildPackages.length === 1 &&
      esbuildPackages[0] === `esbuild@${EXPECTED_ESBUILD_VERSION}`,
    "the lockfile contains an unexpected esbuild package set",
  );
  invariant(
    lock.npm?.[`esbuild@${EXPECTED_ESBUILD_VERSION}`]?.integrity ===
      EXPECTED_PACKAGE_INTEGRITY,
    "the reviewed esbuild artifact integrity changed",
  );
  const actualEsbuildPlatforms = Object.keys(lock.npm ?? {})
    .filter((key) => key.startsWith("@esbuild/"))
    .sort();
  const expectedEsbuildPlatforms = EXPECTED_ESBUILD_PLATFORMS
    .map((name) => `${name}@${EXPECTED_ESBUILD_VERSION}`)
    .sort();
  const optionalDependencies = lock.npm?.[`esbuild@${EXPECTED_ESBUILD_VERSION}`]
    ?.optionalDependencies;
  const actualPlatformIntegrities = Object.fromEntries(
    EXPECTED_ESBUILD_PLATFORMS.map((name) => [
      name,
      lock.npm?.[`${name}@${EXPECTED_ESBUILD_VERSION}`]?.integrity,
    ]),
  );
  invariant(
    JSON.stringify(actualEsbuildPlatforms) ===
        JSON.stringify(expectedEsbuildPlatforms) &&
      Array.isArray(optionalDependencies) &&
      JSON.stringify([...optionalDependencies].sort()) ===
        JSON.stringify([...EXPECTED_ESBUILD_PLATFORMS].sort()) &&
      JSON.stringify(actualPlatformIntegrities) ===
        JSON.stringify(EXPECTED_ESBUILD_PLATFORM_INTEGRITIES),
    "the lockfile contains an unexpected esbuild platform package set",
  );
  invariant(
    lock.remote?.[EXPECTED_SOURCE_URL] === EXPECTED_SOURCE_HASH,
    "the reviewed deno_slack_hooks esbuild bundler lock hash changed",
  );

  const hookPrefix =
    `https://deno.land/x/deno_slack_hooks@${EXPECTED_HOOK_TAG}/`;
  const actualHookGraph = Object.entries(lock.remote ?? {})
    .filter(([url]) => url.startsWith(hookPrefix))
    .sort(([left], [right]) => left.localeCompare(right));
  const expectedHookGraph = Object.entries(EXPECTED_HOOK_REMOTE_HASHES)
    .sort(([left], [right]) => left.localeCompare(right));
  invariant(
    JSON.stringify(actualHookGraph) === JSON.stringify(expectedHookGraph),
    "the reviewed deno_slack_hooks lock graph changed",
  );
}

export function verifyAncestorResolutionBoundary(
  rootPackageText: string,
  rootDenoText?: string,
  rootDenoCText?: string,
  slackPackageText?: string,
  slackDenoText?: string,
  slackDenoCText?: string,
  appPackageText?: string,
  appDenoText?: string,
): void {
  const rootPackage = JSON.parse(rootPackageText) as { workspaces?: unknown };
  const slackPackage = slackPackageText === undefined
    ? undefined
    : JSON.parse(slackPackageText) as { workspaces?: unknown };
  invariant(
    rootPackage.workspaces === undefined && rootDenoText === undefined &&
      rootDenoCText === undefined && slackPackage?.workspaces === undefined &&
      slackDenoText === undefined && slackDenoCText === undefined &&
      appPackageText === undefined && appDenoText === undefined,
    "the Slack app must remain outside every ancestor Deno or package workspace",
  );
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function verifySlackCliWorkflowContract(workflowText: string): void {
  const workflowLines = workflowText.split(/\r?\n/);
  const deploySlackStart = workflowText.indexOf("\n  deploy_slack:\n");
  invariant(
    deploySlackStart >= 0,
    "the Slack deployment job contract changed",
  );
  const deploySlackHeader = "  deploy_slack:\n";
  const deploySlackTail = workflowText.slice(deploySlackStart + 1);
  invariant(
    deploySlackTail.startsWith(deploySlackHeader),
    "the Slack deployment job contract changed",
  );
  const remainingJobs = deploySlackTail.slice(deploySlackHeader.length);
  // Any non-indented sibling at the exact jobs-map depth closes deploy_slack.
  // This avoids enumerating YAML key spellings (plain, quoted, anchored, or
  // commented) and therefore fails closed on future job syntax.
  const nextJob = /\r?\n\x20{2}[^\x20\r\n]/.exec(remainingJobs);
  const deploySlackJob = deploySlackHeader + remainingJobs.slice(
    0,
    nextJob?.index ?? remainingJobs.length,
  );
  const deploySlackLines = deploySlackJob.split(/\r?\n/);
  const jobEnvIndexes = deploySlackLines.flatMap((line, index) =>
    line === "    env:" ? [index] : []
  );
  invariant(
    (workflowText.match(/SLACK_SKIP_UPDATE:/g) ?? []).length === 1 &&
      jobEnvIndexes.length === 1 &&
      deploySlackLines[jobEnvIndexes[0] + 1] ===
        '      SLACK_SKIP_UPDATE: "1"' &&
      deploySlackLines[jobEnvIndexes[0] + 2] === "    steps:",
    "the Slack deployment job-level update suppression changed",
  );

  const stepBlock = (
    name: string,
  ): { lines: string[]; start: number; end: number } => {
    const header = `      - name: ${name}`;
    const indexes = deploySlackLines.flatMap((line, index) =>
      line === header ? [index] : []
    );
    invariant(
      indexes.length === 1,
      `the Slack deployment step contract changed: ${name}`,
    );
    const start = indexes[0];
    const relativeEnd = deploySlackLines.slice(start + 1).findIndex((line) =>
      /^\x20{6}-(?:\x20|$)/.test(line)
    );
    const end = relativeEnd < 0
      ? deploySlackLines.length
      : start + 1 + relativeEnd;
    return { lines: deploySlackLines.slice(start, end), start, end };
  };

  const installStep = stepBlock("Install verified Slack CLI 4.6.0");
  invariant(
    workflowLines.filter((line) =>
          line === "          SLACK_CLI_VERSION: 4.6.0"
        ).length === 1 &&
      installStep.lines.includes("          SLACK_CLI_VERSION: 4.6.0"),
    "the production Slack CLI version pin changed",
  );
  invariant(
    installStep.lines.filter((line) => line === "        id: install-slack-cli")
          .length === 1 &&
      workflowLines.filter((line) => line === "        id: install-slack-cli")
          .length === 1,
    "the verified Slack CLI output owner changed",
  );
  const exactAssetLines = [
    '          test -f "$install_root/bin/slack"',
    '          chmod 0755 "$install_root/bin/slack"',
    '          version_output=$("$install_root/bin/slack" version --skip-update)',
    '          printf \'slack_bin=%s\\n\' "$install_root/bin/slack" >> "$GITHUB_OUTPUT"',
  ];
  invariant(
    (workflowText.match(/\$install_root\/bin\/slack/g) ?? []).length === 4 &&
      exactAssetLines.every((line) => installStep.lines.includes(line)),
    "the verified Slack CLI asset contract changed",
  );
  const exactOutputBinding =
    "          SLACK_BIN: ${{ steps.install-slack-cli.outputs.slack_bin }}";
  const operationSteps = [
    stepBlock("Deploy without exposing webhook triggers"),
    stepBlock("Update the two protected production webhook triggers"),
    stepBlock("Verify the exact protected production trigger inventory"),
  ];
  const bindingLivesInStepEnv = ({ lines }: { lines: string[] }): boolean => {
    const envIndex = lines.indexOf("        env:");
    if (envIndex < 0) return false;
    const relativeEnd = lines.slice(envIndex + 1).findIndex((line) =>
      /^\x20{8}\S/.test(line)
    );
    const envEnd = relativeEnd < 0 ? lines.length : envIndex + 1 + relativeEnd;
    return lines.slice(envIndex + 1, envEnd).filter((line) =>
      line === exactOutputBinding
    ).length === 1;
  };
  invariant(
    (
          workflowText.match(
            /\$\{\{ steps\.install-slack-cli\.outputs\.slack_bin \}\}/g,
          ) ?? []
        ).length === 3 &&
      operationSteps.every(bindingLivesInStepEnv),
    "the Slack CLI output binding contract changed",
  );
  const slackBinExpansions = [
    ...deploySlackJob.matchAll(
      /\$(?:SLACK_BIN\b|\{[^}\r\n]*\bSLACK_BIN\b[^}\r\n]*\})/g,
    ),
  ];
  for (const expansion of slackBinExpansions) {
    const start = expansion.index ?? -1;
    invariant(
      expansion[0] === "$SLACK_BIN" && start > 0 &&
        deploySlackJob.slice(start - 1, start + expansion[0].length + 1) ===
          '"$SLACK_BIN"',
      'the production workflow must use only the canonical "$SLACK_BIN" expansion',
    );
  }
  invariant(
    slackBinExpansions.length === 4,
    `expected exactly four production Slack CLI expansions, found ${slackBinExpansions.length}`,
  );
  invariant(
    (workflowText.match(/\bSLACK_BIN\b/g) ?? []).length === 7,
    "the Slack CLI binding surface changed",
  );

  const invocationLineIndexes = deploySlackLines.flatMap((line, index) =>
    line.includes('"$SLACK_BIN"') ? [index] : []
  );
  invariant(
    invocationLineIndexes.length === 4,
    `expected exactly four production Slack CLI invocations, found ${invocationLineIndexes.length}`,
  );
  const invocations = invocationLineIndexes.map((firstIndex) => {
    const commandLines: string[] = [];
    let index = firstIndex;
    for (;;) {
      invariant(
        index < deploySlackLines.length,
        "a production Slack CLI invocation has an unterminated continuation",
      );
      const rawLine = deploySlackLines[index];
      invariant(
        !/[ \t]+$/.test(rawLine),
        "the production Slack CLI command contract changed",
      );
      const line = rawLine.replace(/^[ \t]+/, "");
      const continued = line.endsWith("\\");
      if (continued) {
        invariant(
          line.endsWith(" \\"),
          "the production Slack CLI command contract changed",
        );
      }
      commandLines.push(continued ? line.slice(0, -2) : line);
      if (!continued) break;
      index += 1;
    }
    return commandLines.join(" ");
  });

  for (const [index, command] of invocations.entries()) {
    invariant(
      (command.match(/(?:^|[ \t])--skip-update(?=[ \t]|$)/g) ?? []).length ===
        1,
      `production Slack CLI invocation ${
        index + 1
      } must keep exactly one --skip-update argument`,
    );
  }

  const expectedInvocations = [
    '"$SLACK_BIN" deploy --app "$SLACK_APP_ID" --team "$SLACK_TEAM_ID" --token "$SLACK_SERVICE_TOKEN" --hide-triggers --skip-update',
    'if ! "$SLACK_BIN" trigger update --trigger-id "$ACTIVITY_TRIGGER_ID" --trigger-def triggers/github_activity_webhook.ts --app "$SLACK_APP_ID" --team "$SLACK_TEAM_ID" --token "$SLACK_SERVICE_TOKEN" --no-color --skip-update >"$update_log" 2>&1; then',
    'if ! "$SLACK_BIN" trigger update --trigger-id "$ALERT_TRIGGER_ID" --trigger-def triggers/github_alert_webhook.ts --app "$SLACK_APP_ID" --team "$SLACK_TEAM_ID" --token "$SLACK_SERVICE_TOKEN" --no-color --skip-update >"$update_log" 2>&1; then',
    'if ! "$SLACK_BIN" api workflows.triggers.list --token "$SLACK_SERVICE_TOKEN" --json "$request_body" --no-color --skip-update 2>"$inventory_error" | deno run --allow-env=ACTIVITY_TRIGGER_ID,ALERT_TRIGGER_ID,SLACK_APP_ID scripts/verify_trigger_inventory.ts; then',
  ];
  invariant(
    JSON.stringify(invocations) === JSON.stringify(expectedInvocations),
    "the production Slack CLI command contract changed",
  );
  const expectedInvocationsPerStep = [1, 2, 1];
  invariant(
    operationSteps.every(({ start, end }, stepIndex) =>
      invocationLineIndexes.filter((lineIndex) =>
        lineIndex >= start && lineIndex < end
      ).length === expectedInvocationsPerStep[stepIndex]
    ),
    "the production Slack CLI step binding contract changed",
  );
  invariant(
    sha256Text(
      workflowText.slice(deploySlackStart + 1).replaceAll("\r\n", "\n"),
    ) ===
      EXPECTED_DEPLOY_SLACK_JOB_SHA256,
    "the exact production Slack deployment job changed",
  );
}

export function verifyEsbuildReachability(source: string): void {
  invariant(
    source.includes(
      `import * as esbuild from "npm:esbuild@${UPSTREAM_ESBUILD_VERSION}";`,
    ),
    "the hook's exact esbuild import changed",
  );
  const methods = [...source.matchAll(/\besbuild\.([A-Za-z_$][\w$]*)\s*\(/g)]
    .map((match) => match[1]);
  invariant(
    methods.length === 2 && methods[0] === "build" && methods[1] === "stop",
    `the hook's reviewed esbuild call set changed: ${methods.join(", ")}`,
  );
  invariant(
    !/\b(?:serve|listen|context)\b/i.test(source),
    "the hook now contains a development-server reachability marker",
  );
}

export function verifyLatestHookRelease(release: unknown): void {
  invariant(
    release && typeof release === "object",
    "GitHub returned no latest deno_slack_hooks release",
  );
  const candidate = release as GitHubRelease;
  invariant(
    candidate.draft === false && candidate.prerelease === false,
    "GitHub returned a draft or prerelease as the latest stable deno_slack_hooks release",
  );
  invariant(
    candidate.tag_name === EXPECTED_HOOK_TAG,
    `deno_slack_hooks ${
      candidate.tag_name ?? "unknown"
    } is the latest stable release; update the reviewed hook pin`,
  );
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function githubJson<T>(path: string, token: string): Promise<T> {
  const headers = new Headers({
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2026-03-10",
  });

  const response = await fetch(`https://api.github.com${path}`, { headers });
  invariant(
    response.ok,
    `GitHub API verification failed with HTTP ${response.status}`,
  );
  return await response.json() as T;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/\s/g, ""));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function verifyUpstreamPin(token: string): Promise<void> {
  const latestRelease = await githubJson<GitHubRelease>(
    `/repos/${HOOK_REPOSITORY}/releases/latest`,
    token,
  );
  verifyLatestHookRelease(latestRelease);

  const reference = await githubJson<GitReference>(
    `/repos/${HOOK_REPOSITORY}/git/ref/tags/${EXPECTED_HOOK_TAG}`,
    token,
  );
  invariant(
    reference.object?.type === "tag" &&
      reference.object.sha === EXPECTED_TAG_OBJECT,
    "upstream deno_slack_hooks tag reference changed",
  );

  const tag = await githubJson<GitTag>(
    `/repos/${HOOK_REPOSITORY}/git/tags/${EXPECTED_TAG_OBJECT}`,
    token,
  );
  invariant(
    tag.object?.type === "commit" &&
      tag.object.sha === EXPECTED_HOOK_COMMIT,
    "upstream deno_slack_hooks tag no longer resolves to the reviewed commit",
  );

  const content = await githubJson<GitHubContent>(
    `/repos/${HOOK_REPOSITORY}/contents/src/bundler/esbuild_bundler.ts?ref=${EXPECTED_HOOK_COMMIT}`,
    token,
  );
  invariant(
    content.encoding === "base64" && typeof content.content === "string",
    "GitHub returned an unexpected hook source representation",
  );
  const bytes = decodeBase64(content.content);
  invariant(
    await sha256(bytes) === EXPECTED_SOURCE_HASH,
    "the reviewed upstream hook source hash changed",
  );
  verifyEsbuildReachability(new TextDecoder().decode(bytes));
}

async function runAudit(): Promise<{ code: number; output: string }> {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["audit", "--frozen", "--level=low"],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await command.output();
  const decoder = new TextDecoder();
  return {
    code: result.code,
    output: `${decoder.decode(result.stdout)}\n${
      decoder.decode(result.stderr)
    }`,
  };
}

async function readOptionalText(url: URL): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(url);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

async function main(): Promise<void> {
  const configuration = readVerificationConfiguration({
    GITHUB_EVENT_NAME: Deno.env.get("GITHUB_EVENT_NAME"),
    GITHUB_TOKEN: Deno.env.get("GITHUB_TOKEN"),
  });
  const scriptDirectory = new URL(".", import.meta.url);
  const [
    hooksText,
    configText,
    lockText,
    workflowText,
    rootPackageText,
    rootDenoText,
    rootDenoCText,
    slackPackageText,
    slackDenoText,
    slackDenoCText,
    appPackageText,
    appDenoText,
  ] = await Promise.all([
    Deno.readTextFile(new URL("../.slack/hooks.json", scriptDirectory)),
    Deno.readTextFile(new URL("../deno.jsonc", scriptDirectory)),
    Deno.readTextFile(new URL("../deno.lock", scriptDirectory)),
    Deno.readTextFile(
      new URL(
        "../../../.github/workflows/github-slack-integration.yml",
        scriptDirectory,
      ),
    ),
    Deno.readTextFile(new URL("../../../package.json", scriptDirectory)),
    readOptionalText(new URL("../../../deno.json", scriptDirectory)),
    readOptionalText(new URL("../../../deno.jsonc", scriptDirectory)),
    readOptionalText(new URL("../../package.json", scriptDirectory)),
    readOptionalText(new URL("../../deno.json", scriptDirectory)),
    readOptionalText(new URL("../../deno.jsonc", scriptDirectory)),
    readOptionalText(new URL("../package.json", scriptDirectory)),
    readOptionalText(new URL("../deno.json", scriptDirectory)),
  ]);
  verifyLocalPins(hooksText, configText, lockText);
  verifyAncestorResolutionBoundary(
    rootPackageText,
    rootDenoText,
    rootDenoCText,
    slackPackageText,
    slackDenoText,
    slackDenoCText,
    appPackageText,
    appDenoText,
  );
  verifySlackCliWorkflowContract(workflowText);
  if (configuration.verifyUpstreamLive) {
    await verifyUpstreamPin(configuration.token!);
  }

  const audit = await runAudit();
  verifyAuditOutput(audit.output, audit.code);
  const upstreamScope = configuration.verifyUpstreamLive
    ? "live release, tag, commit, and source"
    : "candidate-local pin, integrity, and source hash";
  console.log(
    `Dependency audit passed with zero advisories; the exact esbuild security override, ${upstreamScope} verification, and all non-reachability assumptions remain exact.`,
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Dependency audit failed closed: ${message}`);
    Deno.exit(1);
  }
}
