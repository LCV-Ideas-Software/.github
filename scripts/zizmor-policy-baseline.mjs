import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const SHA = /^[0-9a-f]{40}$/u;
const MODES = new Set(["100644"]);
const KINDS = new Set(["config", "inline-ignore", "config-ignore-target"]);
const CONFIG_PATH = ".github/zizmor.yml";
const SHADOW_CONFIGS = new Set([
  ".github/zizmor.yaml",
  "zizmor.yml",
  "zizmor.yaml",
]);
const IGNORE = /# zizmor: ignore\[(.+)\](?:\s+.*)?$/u;
const COMMAND_ARGUMENTS = Object.freeze({
  resolve: Object.freeze([
    "--event-path",
    "--event",
    "--repository",
    "--sha",
    "--ref",
    "--output",
  ]),
  validate: Object.freeze([
    "--manifest",
    "--repository",
    "--base-dir",
    "--base-sha",
    "--candidate-dir",
    "--candidate-sha",
  ]),
});

function fail(message) {
  throw new Error(message);
}

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} has an unexpected schema`);
  }
}

function canonicalPath(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.normalize("NFC") ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    value
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    fail(`${label} is not a canonical repository path`);
  }
  return value;
}

export function validateManifest(value) {
  exactKeys(value, ["schema_version", "repositories"], "baseline manifest");
  if (value.schema_version !== 1 || !Array.isArray(value.repositories)) {
    fail("baseline manifest version or repositories is invalid");
  }
  const repositories = new Map();
  let previousRepository = "";
  for (const [repositoryIndex, entry] of value.repositories.entries()) {
    exactKeys(entry, ["repository", "files"], `repository ${repositoryIndex}`);
    if (
      typeof entry.repository !== "string" ||
      !/^LCV-Ideas-Software\/[a-z0-9._-]+$/u.test(entry.repository) ||
      entry.repository <= previousRepository ||
      !Array.isArray(entry.files)
    ) {
      fail(`repository ${repositoryIndex} is not canonical and sorted`);
    }
    previousRepository = entry.repository;
    const files = new Map();
    let previousPath = "";
    let configCount = 0;
    for (const [fileIndex, file] of entry.files.entries()) {
      exactKeys(
        file,
        ["path", "mode", "blob_shas", "kind"],
        `${entry.repository} file ${fileIndex}`,
      );
      const path = canonicalPath(file.path, `${entry.repository} file path`);
      if (
        path <= previousPath ||
        !MODES.has(file.mode) ||
        !KINDS.has(file.kind)
      ) {
        fail(`${entry.repository} file inventory is not canonical and sorted`);
      }
      previousPath = path;
      if (
        !Array.isArray(file.blob_shas) ||
        file.blob_shas.length === 0 ||
        file.blob_shas.some(
          (sha) => typeof sha !== "string" || !SHA.test(sha),
        ) ||
        new Set(file.blob_shas).size !== file.blob_shas.length ||
        file.blob_shas.some(
          (sha, index) => index > 0 && sha <= file.blob_shas[index - 1],
        )
      ) {
        fail(`${entry.repository}:${path} blob SHA inventory is invalid`);
      }
      if (file.kind === "config") {
        configCount += 1;
        if (path !== CONFIG_PATH)
          fail(`${entry.repository} has a noncanonical config`);
      }
      files.set(
        path,
        Object.freeze({ ...file, blob_shas: new Set(file.blob_shas) }),
      );
    }
    if (configCount !== 1)
      fail(`${entry.repository} must authorize one canonical config`);
    repositories.set(entry.repository, files);
  }
  if (repositories.size === 0) fail("baseline manifest has no repositories");
  return repositories;
}

function requireSha(value, label) {
  if (typeof value !== "string" || !SHA.test(value))
    fail(`${label} is not a full SHA`);
  return value;
}

export function resolveSnapshots(
  eventName,
  event,
  repository,
  runtimeSha,
  runtimeRef,
) {
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    fail("caller event payload must be an object");
  }
  if (!/^LCV-Ideas-Software\/[a-z0-9._-]+$/u.test(repository)) {
    fail("repository is outside the reviewed organization inventory");
  }
  const sha = requireSha(runtimeSha, "runtime SHA");
  let base;
  let candidate;
  if (eventName === "pull_request") {
    base = event?.pull_request?.base?.sha;
    candidate = sha;
  } else if (eventName === "merge_group") {
    base = event?.merge_group?.base_sha;
    candidate = event?.merge_group?.head_sha;
    if (candidate !== sha)
      fail("merge-group head does not match the runtime SHA");
  } else if (eventName === "push") {
    base = event?.before;
    candidate = event?.after;
    if (candidate !== sha) fail("push target does not match the runtime SHA");
    if (base === "0".repeat(40))
      fail("branch-creation pushes have no trusted base snapshot");
  } else if (eventName === "schedule" || eventName === "workflow_dispatch") {
    if (runtimeRef !== "refs/heads/main") {
      fail(`${eventName} must audit the reviewed default branch`);
    }
    base = sha;
    candidate = sha;
  } else {
    fail(`unsupported caller event: ${eventName}`);
  }
  return {
    baseSha: requireSha(base, "base SHA"),
    candidateSha: requireSha(candidate, "candidate SHA"),
  };
}

function git(directory, args, options = {}) {
  const result = spawnSync(
    "git",
    ["--no-replace-objects", "-C", directory, ...args],
    {
      encoding: options.buffer ? undefined : "utf8",
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0) {
    fail(`git ${args[0]} failed for ${directory}`);
  }
  return result.stdout;
}

function treeInventory(directory, expectedSha) {
  const root = resolve(directory);
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  if (head !== expectedSha)
    fail(`checkout HEAD ${head} does not match ${expectedSha}`);
  const raw = git(root, ["ls-tree", "-rz", "--full-tree", expectedSha], {
    buffer: true,
  });
  const entries = new Map();
  const folded = new Map();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const record of raw
    .subarray(0, Math.max(0, raw.length - 1))
    .toString("binary")
    .split("\0")) {
    if (record === "") continue;
    const bytes = Buffer.from(record, "binary");
    const separator = bytes.indexOf(0x09);
    if (separator < 0) fail("git tree record is malformed");
    const metadata = bytes.subarray(0, separator).toString("ascii").split(" ");
    const path = canonicalPath(
      decoder.decode(bytes.subarray(separator + 1)),
      "git tree path",
    );
    if (metadata.length !== 3 || !SHA.test(metadata[2]))
      fail("git tree metadata is malformed");
    const foldedPath = path.toLocaleLowerCase("en-US");
    if (folded.has(foldedPath)) fail(`case-colliding path detected: ${path}`);
    folded.set(foldedPath, path);
    entries.set(path, {
      mode: metadata[0],
      type: metadata[1],
      sha: metadata[2],
    });
  }
  return { root, entries };
}

function isAuditedYaml(path) {
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return (
    /^\.github\/workflows\/.+\.ya?ml$/u.test(path) ||
    /(?:^|\/)action\.ya?ml$/u.test(path) ||
    /^(?:dependabot|\.pre-commit-config|\.pre-commit-hooks)\.ya?ml$/u.test(
      basename,
    )
  );
}

function hasZizmorIgnore(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("audited YAML is not valid UTF-8");
  }
  return text
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .some((line) => IGNORE.test(line));
}

function validateSnapshot(directory, expectedSha, policy, label) {
  const { root, entries } = treeInventory(directory, expectedSha);
  const config = entries.get(CONFIG_PATH);
  if (!config) fail(`${label} is missing ${CONFIG_PATH}`);
  for (const shadow of SHADOW_CONFIGS) {
    if (entries.has(shadow))
      fail(`${label} contains shadow Zizmor config ${shadow}`);
  }
  for (const [path, authorization] of policy) {
    const entry = entries.get(path);
    if (!entry) {
      if (authorization.kind === "config")
        fail(`${label} is missing its authorized config`);
      continue;
    }
    if (
      entry.type !== "blob" ||
      entry.mode !== authorization.mode ||
      !authorization.blob_shas.has(entry.sha)
    ) {
      fail(`${label}:${path} does not match an authorized Git blob`);
    }
  }
  for (const [path, entry] of entries) {
    if (!isAuditedYaml(path)) continue;
    if (entry.type !== "blob" || entry.mode !== "100644") {
      fail(`${label}:${path} is not a regular non-executable Git blob`);
    }
    const bytes = git(root, ["cat-file", "blob", entry.sha], { buffer: true });
    if (hasZizmorIgnore(bytes) && policy.get(path)?.kind !== "inline-ignore") {
      fail(`${label}:${path} contains an unauthorized Zizmor ignore`);
    }
  }
}

export function validateBaseline({
  manifest,
  repository,
  baseDir,
  baseSha,
  candidateDir,
  candidateSha,
}) {
  const repositories = validateManifest(manifest);
  const policy = repositories.get(repository);
  if (!policy)
    fail(`repository is not present in the immutable baseline: ${repository}`);
  validateSnapshot(baseDir, requireSha(baseSha, "base SHA"), policy, "base");
  validateSnapshot(
    candidateDir,
    requireSha(candidateSha, "candidate SHA"),
    policy,
    "candidate",
  );
  return Object.freeze({ repository, baseSha, candidateSha });
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const expected = Object.hasOwn(COMMAND_ARGUMENTS, command)
    ? COMMAND_ARGUMENTS[command]
    : undefined;
  if (!expected) fail("expected resolve or validate command");
  const values = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined || values.has(key))
      fail("invalid CLI arguments");
    values.set(key, value);
  }
  if (
    values.size !== expected.length ||
    expected.some((key) => !values.has(key))
  ) {
    fail(`${command} requires its exact argument inventory`);
  }
  return { command, values };
}

async function main() {
  const { command, values } = parseArgs(process.argv.slice(2));
  if (command === "resolve") {
    const event = JSON.parse(
      await readFile(values.get("--event-path"), "utf8"),
    );
    const snapshots = resolveSnapshots(
      values.get("--event"),
      event,
      values.get("--repository"),
      values.get("--sha"),
      values.get("--ref"),
    );
    await appendFile(
      values.get("--output"),
      `base_sha=${snapshots.baseSha}\ncandidate_sha=${snapshots.candidateSha}\n`,
      "utf8",
    );
    console.log("Resolved immutable Zizmor policy snapshots.");
    return;
  }
  if (command === "validate") {
    const manifest = JSON.parse(
      await readFile(values.get("--manifest"), "utf8"),
    );
    const result = validateBaseline({
      manifest,
      repository: values.get("--repository"),
      baseDir: values.get("--base-dir"),
      baseSha: values.get("--base-sha"),
      candidateDir: values.get("--candidate-dir"),
      candidateSha: values.get("--candidate-sha"),
    });
    console.log(
      `Validated immutable Zizmor policy baseline for ${result.repository}.`,
    );
    return;
  }
  fail("expected resolve or validate command");
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(`Zizmor policy baseline validation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
