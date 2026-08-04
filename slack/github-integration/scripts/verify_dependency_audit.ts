const EXPECTED_ADVISORY = "GHSA-67mh-4wv8-2f99";
const EXPECTED_ESBUILD_VERSION = "0.24.2";
const EXPECTED_HOOK_TAG = "1.5.0";
const EXPECTED_TAG_OBJECT = "8f28d9314044f1c1533c609854c15460a095128a";
const EXPECTED_HOOK_COMMIT = "b6719c18a18a39ca44fa1b311c3bada28dc3df35";
const EXPECTED_SOURCE_HASH =
  "3d1dc26a0bacc50e31bdb5b90afa3e4229d07405e042f783aebd1235da5c761a";
const EXPECTED_PACKAGE_INTEGRITY =
  "sha512-+9egpBW8I3CD5XPe0n6BfT5fxLzxrlDzqydF3aviG+9ni1lDC/OvMHcxqEFV0+LANZG5R1bFMWfUrjVsdwxJvA==";
const EXCEPTION_EXPIRES_AT = Date.parse("2026-11-01T00:00:00Z");
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
  npm?: Record<string, { integrity?: string }>;
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

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_SEQUENCE, "");
}

export function verifyAuditOutput(output: string, exitCode: number): void {
  const plain = stripAnsi(output);
  invariant(
    exitCode === 1,
    `deno audit returned ${exitCode}; the expected single advisory must remain visible until upstream is patched`,
  );

  const totalMatch = plain.match(
    /Found\s+(\d+)\s+vulnerabilit(?:y|ies)/,
  );
  invariant(totalMatch, "could not parse deno audit's vulnerability total");
  invariant(
    Number(totalMatch[1]) === 1,
    `expected exactly one moderate-or-higher advisory, found ${totalMatch[1]}`,
  );

  const advisoryIds = [
    ...plain.matchAll(
      /^[^\S\r\n]*╰[^\S\r\n]+Info:[^\S\r\n]+https:\/\/github\.com\/advisories\/(GHSA-[0-9a-z-]+)[^\S\r\n]*$/gm,
    ),
  ].map((match) => match[1]);
  invariant(
    advisoryIds.length === 1 && advisoryIds[0] === EXPECTED_ADVISORY,
    `unexpected advisory set: ${advisoryIds.join(", ") || "none"}`,
  );
  invariant(
    /Severity:\s+moderate\b/.test(plain),
    "the allowlisted advisory no longer has the reviewed moderate severity",
  );
  invariant(
    /Package:\s+esbuild\s*(?:\r?\n|$)/.test(plain),
    "the allowlisted advisory no longer identifies esbuild",
  );
  invariant(
    /Vulnerable:\s+<=0\.24\.2\s*(?:\r?\n|$)/.test(plain),
    "the allowlisted advisory's vulnerable range changed",
  );
}

export function verifyLocalPins(hooksText: string, lockText: string): void {
  const hooks = JSON.parse(hooksText) as {
    hooks?: Record<string, string>;
  };
  invariant(
    hooks.hooks?.["get-hooks"] === EXPECTED_HOOK_COMMAND,
    `Slack get-hooks must remain pinned to deno_slack_hooks@${EXPECTED_HOOK_TAG}`,
  );

  const lock = JSON.parse(lockText) as Lockfile;
  const esbuildSpecifiers = Object.keys(lock.specifiers ?? {}).filter((key) =>
    key.startsWith("npm:esbuild@")
  );
  invariant(
    esbuildSpecifiers.length === 1 &&
      esbuildSpecifiers[0] === `npm:esbuild@${EXPECTED_ESBUILD_VERSION}` &&
      lock.specifiers?.[esbuildSpecifiers[0]] === EXPECTED_ESBUILD_VERSION,
    `the reviewed dependency must be exactly esbuild@${EXPECTED_ESBUILD_VERSION}`,
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
  invariant(
    lock.remote?.[EXPECTED_SOURCE_URL] === EXPECTED_SOURCE_HASH,
    "the reviewed deno_slack_hooks esbuild bundler lock hash changed",
  );
}

export function verifyEsbuildReachability(source: string): void {
  invariant(
    source.includes(
      `import * as esbuild from "npm:esbuild@${EXPECTED_ESBUILD_VERSION}";`,
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

export function verifyExceptionWindow(now = Date.now()): void {
  invariant(
    now < EXCEPTION_EXPIRES_AT,
    "the temporary esbuild advisory exception expired on 01/11/2026",
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

async function githubJson<T>(path: string): Promise<T> {
  const token = Deno.env.get("GITHUB_TOKEN");
  const headers = new Headers({
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  });
  if (token) headers.set("Authorization", `Bearer ${token}`);

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

async function verifyUpstreamPin(): Promise<void> {
  const reference = await githubJson<GitReference>(
    `/repos/${HOOK_REPOSITORY}/git/ref/tags/${EXPECTED_HOOK_TAG}`,
  );
  invariant(
    reference.object?.type === "tag" &&
      reference.object.sha === EXPECTED_TAG_OBJECT,
    "upstream deno_slack_hooks tag reference changed",
  );

  const tag = await githubJson<GitTag>(
    `/repos/${HOOK_REPOSITORY}/git/tags/${EXPECTED_TAG_OBJECT}`,
  );
  invariant(
    tag.object?.type === "commit" &&
      tag.object.sha === EXPECTED_HOOK_COMMIT,
    "upstream deno_slack_hooks tag no longer resolves to the reviewed commit",
  );

  const content = await githubJson<GitHubContent>(
    `/repos/${HOOK_REPOSITORY}/contents/src/bundler/esbuild_bundler.ts?ref=${EXPECTED_HOOK_COMMIT}`,
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
    args: ["audit", "--frozen", "--level=moderate"],
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

async function main(): Promise<void> {
  verifyExceptionWindow();
  const scriptDirectory = new URL(".", import.meta.url);
  const [hooksText, lockText] = await Promise.all([
    Deno.readTextFile(new URL("../.slack/hooks.json", scriptDirectory)),
    Deno.readTextFile(new URL("../deno.lock", scriptDirectory)),
  ]);
  verifyLocalPins(hooksText, lockText);
  await verifyUpstreamPin();

  const audit = await runAudit();
  verifyAuditOutput(audit.output, audit.code);
  console.log(
    `Dependency audit passed with the sole temporary exception ${EXPECTED_ADVISORY}; all reviewed pins and non-reachability assumptions remain exact.`,
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
