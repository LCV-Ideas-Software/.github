import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  parseArgs,
  resolveSnapshots,
  validateBaseline,
  validateManifest,
} from "./zizmor-policy-baseline.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const REPOSITORY = "LCV-Ideas-Software/example";

function manifest(files) {
  return {
    schema_version: 1,
    repositories: [{ repository: REPOSITORY, files }],
  };
}

function run(cwd, args, options = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    input: options.input,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function repository(files) {
  const directory = await mkdtemp(join(tmpdir(), "zizmor-baseline-"));
  run(directory, ["init", "--quiet"]);
  run(directory, ["config", "user.name", "Test"]);
  run(directory, ["config", "user.email", "test@example.invalid"]);
  for (const [path, body] of Object.entries(files)) {
    const full = join(directory, ...path.split("/"));
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(join(full, ".."), { recursive: true }),
    );
    await writeFile(full, body, "utf8");
  }
  run(directory, ["add", "."]);
  run(directory, ["commit", "--quiet", "-m", "fixture"]);
  const sha = run(directory, ["rev-parse", "HEAD"]);
  const entries = Object.fromEntries(
    run(directory, ["ls-tree", "-r", "HEAD"])
      .split("\n")
      .map((line) => {
        const [, mode, type, blob, path] =
          /^(\d+) (\w+) ([0-9a-f]{40})\t(.+)$/u.exec(line);
        assert.equal(type, "blob");
        return [path, { mode, blob }];
      }),
  );
  return { directory, sha, entries };
}

test("snapshot resolution is exact and fail-closed for every caller event", () => {
  assert.deepEqual(
    resolveSnapshots(
      "pull_request",
      { pull_request: { base: { sha: A } } },
      REPOSITORY,
      B,
    ),
    { baseSha: A, candidateSha: B },
  );
  assert.deepEqual(
    resolveSnapshots(
      "merge_group",
      { merge_group: { base_sha: A, head_sha: B } },
      REPOSITORY,
      B,
    ),
    { baseSha: A, candidateSha: B },
  );
  assert.deepEqual(
    resolveSnapshots("push", { before: A, after: B }, REPOSITORY, B),
    {
      baseSha: A,
      candidateSha: B,
    },
  );
  for (const event of ["schedule", "workflow_dispatch"]) {
    assert.deepEqual(
      resolveSnapshots(event, {}, REPOSITORY, B, "refs/heads/main"),
      {
        baseSha: B,
        candidateSha: B,
      },
    );
  }
  for (const action of [
    () =>
      resolveSnapshots(
        "push",
        { before: "0".repeat(40), after: B },
        REPOSITORY,
        B,
      ),
    () =>
      resolveSnapshots(
        "merge_group",
        { merge_group: { base_sha: A, head_sha: A } },
        REPOSITORY,
        B,
      ),
    () => resolveSnapshots("unknown", {}, REPOSITORY, B),
    () => resolveSnapshots("push", { before: A, after: B }, "evil/example", B),
    () =>
      resolveSnapshots(
        "workflow_dispatch",
        {},
        REPOSITORY,
        B,
        "refs/heads/feature",
      ),
    () => resolveSnapshots("schedule", null, REPOSITORY, B, "refs/heads/main"),
    () =>
      resolveSnapshots(
        "workflow_dispatch",
        "invalid",
        REPOSITORY,
        B,
        "refs/heads/main",
      ),
  ]) {
    assert.throws(action);
  }
});

test("manifest schema, ordering, modes, kinds, and hashes are closed", () => {
  const valid = manifest([
    {
      path: ".github/workflows/safe.yml",
      mode: "100644",
      blob_shas: [A],
      kind: "inline-ignore",
    },
    {
      path: ".github/zizmor.yml",
      mode: "100644",
      blob_shas: [B],
      kind: "config",
    },
  ]);
  assert.doesNotThrow(() => validateManifest(valid));
  for (const mutation of [
    { ...valid, extra: true },
    manifest([...valid.repositories[0].files].reverse()),
    manifest([
      {
        path: ".github/zizmor.yml",
        mode: "120000",
        blob_shas: [B],
        kind: "config",
      },
    ]),
    manifest([
      {
        path: ".github/zizmor.yml",
        mode: "100644",
        blob_shas: ["bad"],
        kind: "config",
      },
    ]),
    manifest([
      {
        path: ".github/zizmor.yml",
        mode: "100644",
        blob_shas: [B],
        kind: "unknown",
      },
    ]),
    manifest([
      {
        path: ".github/zizmor.yml\u0007spoof",
        mode: "100644",
        blob_shas: [B],
        kind: "config",
      },
    ]),
  ]) {
    assert.throws(() => validateManifest(mutation));
  }
});

test("the command line accepts only the two exact reviewed argument inventories", () => {
  const resolve = [
    "resolve",
    "--event-path",
    "event.json",
    "--event",
    "pull_request",
    "--repository",
    REPOSITORY,
    "--sha",
    A,
    "--ref",
    "refs/pull/1/merge",
    "--output",
    "output.txt",
  ];
  const validate = [
    "validate",
    "--manifest",
    "manifest.json",
    "--repository",
    REPOSITORY,
    "--base-dir",
    "base",
    "--base-sha",
    A,
    "--candidate-dir",
    "candidate",
    "--candidate-sha",
    B,
  ];
  assert.doesNotThrow(() => parseArgs(resolve));
  assert.doesNotThrow(() => parseArgs(validate));
  for (const mutation of [
    [...resolve, "--unexpected", "accepted"],
    resolve.slice(0, -2),
    [...validate, "--unexpected", "accepted"],
    validate.slice(0, -2),
    ["unknown", ...resolve.slice(1)],
    ["__proto__", ...resolve.slice(1)],
  ]) {
    assert.throws(() => parseArgs(mutation));
  }
});

test("baseline accepts only reviewed Git blobs and rejects new ignore directives", async () => {
  const base = await repository({
    ".github/zizmor.yml": "rules: {}\n",
    ".github/workflows/accepted.yml":
      "name: accepted # zizmor: ignore[adhoc-packages]\n",
    ".github/workflows/plain.yml": "name: plain\n",
  });
  const files = [
    {
      path: ".github/workflows/accepted.yml",
      mode: "100644",
      blob_shas: [base.entries[".github/workflows/accepted.yml"].blob],
      kind: "inline-ignore",
    },
    {
      path: ".github/zizmor.yml",
      mode: "100644",
      blob_shas: [base.entries[".github/zizmor.yml"].blob],
      kind: "config",
    },
  ];
  assert.doesNotThrow(() =>
    validateBaseline({
      manifest: manifest(files),
      repository: REPOSITORY,
      baseDir: base.directory,
      baseSha: base.sha,
      candidateDir: base.directory,
      candidateSha: base.sha,
    }),
  );

  const changed = await repository({
    ".github/zizmor.yml": "rules: {}\n",
    ".github/workflows/accepted.yml":
      "name: changed # zizmor: ignore[adhoc-packages]\n",
  });
  assert.throws(() =>
    validateBaseline({
      manifest: manifest(files),
      repository: REPOSITORY,
      baseDir: base.directory,
      baseSha: base.sha,
      candidateDir: changed.directory,
      candidateSha: changed.sha,
    }),
  );

  const added = await repository({
    ".github/zizmor.yml": "rules: {}\n",
    ".github/workflows/accepted.yml":
      "name: accepted # zizmor: ignore[adhoc-packages]\n",
    ".github/workflows/new.yml":
      "name: new # zizmor: ignore[github-env] explanation\n",
  });
  assert.throws(() =>
    validateBaseline({
      manifest: manifest(files),
      repository: REPOSITORY,
      baseDir: base.directory,
      baseSha: base.sha,
      candidateDir: added.directory,
      candidateSha: added.sha,
    }),
  );
  await Promise.all(
    [base, changed, added].map(({ directory }) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

test("all shadow configuration names and wrong checkout SHAs are rejected", async () => {
  const fixture = await repository({
    ".github/zizmor.yml": "rules: {}\n",
    ".github/zizmor.yaml": "rules: {}\n",
    "zizmor.yml": "rules: {}\n",
    "zizmor.yaml": "rules: {}\n",
  });
  const policy = manifest([
    {
      path: ".github/zizmor.yml",
      mode: "100644",
      blob_shas: [fixture.entries[".github/zizmor.yml"].blob],
      kind: "config",
    },
  ]);
  for (const candidateSha of [fixture.sha, A]) {
    assert.throws(() =>
      validateBaseline({
        manifest: policy,
        repository: REPOSITORY,
        baseDir: fixture.directory,
        baseSha: fixture.sha,
        candidateDir: fixture.directory,
        candidateSha,
      }),
    );
  }
  await rm(fixture.directory, { recursive: true, force: true });
});

test("every audited YAML path must remain a regular non-executable Git blob", async () => {
  const fixture = await repository({
    ".github/zizmor.yml": "rules: {}\n",
    ".github/workflows/plain.yml": "name: plain\n",
  });
  run(fixture.directory, [
    "update-index",
    "--chmod=+x",
    ".github/workflows/plain.yml",
  ]);
  run(fixture.directory, ["commit", "--quiet", "-m", "executable workflow"]);
  const executableSha = run(fixture.directory, ["rev-parse", "HEAD"]);
  const policy = manifest([
    {
      path: ".github/zizmor.yml",
      mode: "100644",
      blob_shas: [fixture.entries[".github/zizmor.yml"].blob],
      kind: "config",
    },
  ]);
  assert.throws(() =>
    validateBaseline({
      manifest: policy,
      repository: REPOSITORY,
      baseDir: fixture.directory,
      baseSha: executableSha,
      candidateDir: fixture.directory,
      candidateSha: executableSha,
    }),
  );
  await rm(fixture.directory, { recursive: true, force: true });
});

test("nested Dependabot and pre-commit inputs cannot introduce an unreviewed ignore", async () => {
  const fixture = await repository({
    ".github/zizmor.yml": "rules: {}\n",
    "nested/.pre-commit-hooks.yml":
      "- id: unsafe # zizmor: ignore[template-injection]\n",
    "nested/.pre-commit-config.yaml":
      "repos: [] # zizmor: ignore[template-injection]\n",
    "nested/dependabot.yml":
      "version: 2 # zizmor: ignore[dependabot-cooldown]\n",
  });
  const policy = manifest([
    {
      path: ".github/zizmor.yml",
      mode: "100644",
      blob_shas: [fixture.entries[".github/zizmor.yml"].blob],
      kind: "config",
    },
  ]);
  assert.throws(() =>
    validateBaseline({
      manifest: policy,
      repository: REPOSITORY,
      baseDir: fixture.directory,
      baseSha: fixture.sha,
      candidateDir: fixture.directory,
      candidateSha: fixture.sha,
    }),
  );
  await rm(fixture.directory, { recursive: true, force: true });
});

test("symlinks and Git replace refs cannot redirect an audited snapshot", async () => {
  const fixture = await repository({
    ".github/zizmor.yml": "rules: {}\n",
    ".github/workflows/safe.yml": "name: safe\n",
  });
  const originalSha = fixture.sha;
  const policy = manifest([
    {
      path: ".github/zizmor.yml",
      mode: "100644",
      blob_shas: [fixture.entries[".github/zizmor.yml"].blob],
      kind: "config",
    },
  ]);

  await writeFile(
    join(fixture.directory, ".github/workflows/safe.yml"),
    "name: unsafe # zizmor: ignore[template-injection]\n",
    "utf8",
  );
  run(fixture.directory, ["add", ".github/workflows/safe.yml"]);
  run(fixture.directory, ["commit", "--quiet", "-m", "replacement tree"]);
  const replacementSha = run(fixture.directory, ["rev-parse", "HEAD"]);
  run(fixture.directory, ["reset", "--quiet", "--hard", originalSha]);
  run(fixture.directory, ["replace", originalSha, replacementSha]);
  assert.doesNotThrow(() =>
    validateBaseline({
      manifest: policy,
      repository: REPOSITORY,
      baseDir: fixture.directory,
      baseSha: originalSha,
      candidateDir: fixture.directory,
      candidateSha: originalSha,
    }),
  );

  const linkBlob = run(fixture.directory, ["hash-object", "-w", "--stdin"], {
    input: "../../payload.yml\n",
  });
  run(fixture.directory, [
    "update-index",
    "--add",
    "--cacheinfo",
    `120000,${linkBlob},.github/workflows/link.yml`,
  ]);
  run(fixture.directory, ["commit", "--quiet", "-m", "symlink workflow"]);
  const linkSha = run(fixture.directory, ["rev-parse", "HEAD"]);
  assert.throws(() =>
    validateBaseline({
      manifest: policy,
      repository: REPOSITORY,
      baseDir: fixture.directory,
      baseSha: linkSha,
      candidateDir: fixture.directory,
      candidateSha: linkSha,
    }),
  );
  await rm(fixture.directory, { recursive: true, force: true });
});

test("both base and candidate must independently match reviewed blobs", async () => {
  const reviewed = await repository({
    ".github/zizmor.yml": "rules: {}\n",
    ".github/workflows/accepted.yml":
      "name: accepted # zizmor: ignore[adhoc-packages]\n",
  });
  const unreviewed = await repository({
    ".github/zizmor.yml": "rules: {}\n",
    ".github/workflows/accepted.yml":
      "name: changed # zizmor: ignore[adhoc-packages]\n",
  });
  const policy = manifest([
    {
      path: ".github/workflows/accepted.yml",
      mode: "100644",
      blob_shas: [reviewed.entries[".github/workflows/accepted.yml"].blob],
      kind: "inline-ignore",
    },
    {
      path: ".github/zizmor.yml",
      mode: "100644",
      blob_shas: [reviewed.entries[".github/zizmor.yml"].blob],
      kind: "config",
    },
  ]);
  for (const [base, candidate] of [
    [unreviewed, reviewed],
    [reviewed, unreviewed],
  ]) {
    assert.throws(() =>
      validateBaseline({
        manifest: policy,
        repository: REPOSITORY,
        baseDir: base.directory,
        baseSha: base.sha,
        candidateDir: candidate.directory,
        candidateSha: candidate.sha,
      }),
    );
  }
  await Promise.all(
    [reviewed, unreviewed].map(({ directory }) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});
