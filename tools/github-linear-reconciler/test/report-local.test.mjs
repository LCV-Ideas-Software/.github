import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildLocalReport,
  renderRedactedStatus,
  resolveLocalReportDirectory,
  writeLocalReport,
} from "../src/report/local.mjs";
import {
  ensureOwnedLocalProfile,
  WINDOWS_FULL_CONTROL_MASK,
} from "../src/local-profile.mjs";

const NOW = new Date("2026-08-18T15:00:00.000Z");
const TEST_OPERATOR_SID = "S-1-5-21-1000-1000-1000-1001";
const readValidWindowsAcl = async (_candidate, { kind = "file" } = {}) => {
  const inheritanceFlags = kind === "directory" ? 3 : 0;
  return {
    currentSid: TEST_OPERATOR_SID,
    ownerSid: TEST_OPERATOR_SID,
    accessRulesProtected: true,
    accessRules: [
      {
        sid: TEST_OPERATOR_SID,
        type: "Allow",
        rights: WINDOWS_FULL_CONTROL_MASK,
        inherited: false,
        inheritanceFlags,
        propagationFlags: 0,
      },
      {
        sid: "S-1-5-18",
        type: "Allow",
        rights: WINDOWS_FULL_CONTROL_MASK,
        inherited: false,
        inheritanceFlags,
        propagationFlags: 0,
      },
    ],
  };
};

function resultFixture() {
  return {
    state: "drift",
    counts: { drift: 1, advisory: 2, incomplete: 0 },
    findings: [
      {
        severity: "drift",
        code: "status_divergence",
        entity: "SYNTH-12",
        message: "estado diverge do gêmeo GitHub",
        references: ["https://example.invalid/private/SYNTH-12"],
        rawSnapshot: { secret: "never persist this" },
      },
    ],
    linear: { raw: "never persist this" },
    github: { raw: "never persist this" },
    token: "never persist this",
  };
}

test("relatório detalhado persiste somente o resultado derivado permitido", () => {
  const report = buildLocalReport(resultFixture(), { generatedAt: NOW });

  assert.deepEqual(report, {
    schemaVersion: 1,
    generatedAt: NOW.toISOString(),
    state: "drift",
    counts: { advisory: 2, drift: 1, incomplete: 0 },
    findings: [
      {
        severity: "drift",
        code: "status_divergence",
        entity: "SYNTH-12",
        message: "estado diverge do gêmeo GitHub",
        references: ["https://example.invalid/private/SYNTH-12"],
      },
    ],
  });
  assert.doesNotMatch(JSON.stringify(report), /never persist this/u);
  assert.equal(Object.hasOwn(report, "linear"), false);
  assert.equal(Object.hasOwn(report, "github"), false);
});

test("stdout contém somente estado e contagens redigidas", () => {
  const output = renderRedactedStatus(resultFixture());

  assert.equal(
    output,
    '{"state":"drift","counts":{"advisory":2,"drift":1,"incomplete":0}}',
  );
  assert.doesNotMatch(output, /SYNTH-12|example\.invalid|status_divergence/u);
});

test("diretório padrão fica fora do checkout e dentro do perfil local", () => {
  assert.equal(
    resolveLocalReportDirectory({
      env: { LOCALAPPDATA: "C:\\Users\\leo\\AppData\\Local" },
      homedir: "C:\\Users\\leo",
      platform: "win32",
    }),
    path.join(
      "C:\\Users\\leo\\AppData\\Local",
      "github-linear-reconciler",
      "reports",
    ),
  );
  assert.equal(
    resolveLocalReportDirectory({
      env: { XDG_STATE_HOME: "/srv/private-state" },
      homedir: "/home/leo",
      platform: "linux",
    }),
    path.join("/srv/private-state", "github-linear-reconciler", "reports"),
  );
  assert.throws(
    () =>
      resolveLocalReportDirectory({
        env: { GITHUB_LINEAR_RECONCILER_PROFILE_DIR: ".\\reports" },
      }),
    /deve ser absoluto/u,
  );
});

test("não altera diretório preexistente que não pertença à ferramenta", async (context) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "github-linear-report-mode-test-"),
  );
  context.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];

  await assert.rejects(
    writeLocalReport({
      result: resultFixture(),
      now: NOW,
      directory,
      idFactory: () => "mode-test",
      chmodImpl: async (...parameters) => calls.push(parameters),
    }),
    /marker/u,
  );

  assert.deepEqual(calls, []);
});

test("recusa relatório sob marcador de worktree Git", async (context) => {
  for (const markerType of ["directory", "file"]) {
    const root = await mkdtemp(
      path.join(tmpdir(), `github-linear-report-git-${markerType}-`),
    );
    context.after(() => rm(root, { recursive: true, force: true }));
    const marker = path.join(root, ".git");
    if (markerType === "directory") {
      await mkdir(marker);
    } else {
      await writeFile(marker, "gitdir: C:/synthetic/worktree\n", "utf8");
    }
    const directory = path.join(root, "state", "reports");

    await assert.rejects(
      writeLocalReport({
        result: resultFixture(),
        now: NOW,
        directory,
        idFactory: () => `git-${markerType}`,
      }),
      /worktree Git/u,
    );
    await assert.rejects(access(directory), { code: "ENOENT" });
  }
});

test("grava atomicamente no perfil local e retém somente 14 dias", async (context) => {
  const parent = await mkdtemp(
    path.join(tmpdir(), "github-linear-report-test-"),
  );
  context.after(() => rm(parent, { recursive: true, force: true }));
  const profile = await ensureOwnedLocalProfile({
    root: path.join(parent, "profile"),
    readWindowsAclImpl: readValidWindowsAcl,
    setWindowsAclImpl: async () => {},
  });
  const directory = profile.reportsPath;
  await mkdir(directory, { mode: 0o700 });
  const oldReport = path.join(
    directory,
    "github-linear-reconciliation-2026-08-01T00-00-00-000Z-old.json",
  );
  const recentReport = path.join(
    directory,
    "github-linear-reconciliation-2026-08-10T00-00-00-000Z-recent.json",
  );
  const unrelated = path.join(directory, "unrelated-old.json");
  await Promise.all([
    writeFile(oldReport, "{}\n", { encoding: "utf8", mode: 0o600 }),
    writeFile(recentReport, "{}\n", { encoding: "utf8", mode: 0o600 }),
    writeFile(unrelated, "{}\n", "utf8"),
  ]);
  await utimes(
    oldReport,
    new Date("2026-08-01T00:00:00Z"),
    new Date("2026-08-01T00:00:00Z"),
  );
  await utimes(
    recentReport,
    new Date("2026-08-10T00:00:00Z"),
    new Date("2026-08-10T00:00:00Z"),
  );
  await utimes(
    unrelated,
    new Date("2026-08-01T00:00:00Z"),
    new Date("2026-08-01T00:00:00Z"),
  );

  const written = await writeLocalReport({
    result: resultFixture(),
    now: NOW,
    directory: profile.root,
    idFactory: () => "fixed-id",
    readWindowsAclImpl: readValidWindowsAcl,
    setWindowsAclImpl: async () => {},
  });

  const names = await readdir(directory);
  assert.equal(
    path.basename(written.path),
    "github-linear-reconciliation-2026-08-18T15-00-00-000Z-fixed-id.json",
  );
  assert.equal(names.includes(path.basename(oldReport)), false);
  assert.equal(names.includes(path.basename(recentReport)), true);
  assert.equal(names.includes(path.basename(unrelated)), true);
  assert.equal(
    names.some((name) => name.endsWith(".tmp")),
    false,
  );
  assert.deepEqual(
    JSON.parse(await readFile(written.path, "utf8")),
    buildLocalReport(resultFixture(), { generatedAt: NOW }),
  );
  assert.equal((await stat(written.path)).isFile(), true);
  assert.deepEqual(written.removed, [oldReport]);
});
