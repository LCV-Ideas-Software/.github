import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadOperationalConfig } from "../src/config.mjs";
import {
  assertPrivateFilePath,
  assertWindowsAclPolicy,
  createPrivateWindowsDirectory,
  ensureOwnedLocalProfile,
  PROFILE_MARKER_NAME,
  readWindowsAcl,
  WINDOWS_FULL_CONTROL_MASK,
} from "../src/local-profile.mjs";
import { writeLocalReport } from "../src/report/local.mjs";
import { createDuplicateComponents } from "../src/rules/duplicates.mjs";

const CURRENT_SID = "S-1-5-21-1000-1000-1000-1001";
const SYSTEM_SID = "S-1-5-18";
const VALID_CONFIG = Object.freeze({
  organization: "example-org",
  releaseRequiredAfter: "2030-01-02T03:04:05.000Z",
  commentGraceMinutes: 30,
  mappings: [
    { linearTeamKey: "ROOT", mode: "umbrella" },
    { linearTeamKey: "LOCAL", mode: "linear-only" },
  ],
});

function validAcl(kind = "file") {
  const inheritanceFlags = kind === "directory" ? 3 : 0;
  return {
    currentSid: CURRENT_SID,
    ownerSid: CURRENT_SID,
    accessRulesProtected: true,
    accessRules: [
      {
        sid: CURRENT_SID,
        type: "Allow",
        rights: WINDOWS_FULL_CONTROL_MASK,
        inherited: false,
        inheritanceFlags,
        propagationFlags: 0,
      },
      {
        sid: SYSTEM_SID,
        type: "Allow",
        rights: WINDOWS_FULL_CONTROL_MASK,
        inherited: false,
        inheritanceFlags,
        propagationFlags: 0,
      },
    ],
  };
}

test("policy ACL Windows exige owner, DACL protegida, principals, direitos e flags por kind", () => {
  assert.doesNotThrow(() =>
    assertWindowsAclPolicy(validAcl(), "arquivo privado", "file"),
  );
  assert.doesNotThrow(() =>
    assertWindowsAclPolicy(
      validAcl("directory"),
      "diretório privado",
      "directory",
    ),
  );

  const invalidCases = [
    [
      { ...validAcl(), ownerSid: SYSTEM_SID },
      /owner deve ser o operador atual/u,
    ],
    [
      { ...validAcl(), accessRulesProtected: false },
      /DACL deve estar protegida/u,
    ],
    [
      {
        ...validAcl(),
        accessRules: [
          ...validAcl().accessRules,
          {
            sid: "S-1-5-32-545",
            type: "Allow",
            rights: WINDOWS_FULL_CONTROL_MASK,
            inherited: false,
            inheritanceFlags: 0,
            propagationFlags: 0,
          },
        ],
      },
      /principal não autorizado/u,
    ],
    [
      {
        ...validAcl(),
        accessRules: validAcl().accessRules.map((rule, index) =>
          index === 0 ? { ...rule, type: "Deny" } : rule,
        ),
      },
      /somente regras Allow/u,
    ],
    [
      {
        ...validAcl(),
        accessRules: validAcl().accessRules.map((rule, index) =>
          index === 0 ? { ...rule, rights: 1 } : rule,
        ),
      },
      /direitos insuficientes/u,
    ],
    [
      {
        ...validAcl("directory"),
        accessRules: validAcl("directory").accessRules.map((rule) => ({
          ...rule,
          inheritanceFlags: 0,
        })),
      },
      /inheritanceFlags inválidas/u,
      "directory",
    ],
    [
      {
        ...validAcl(),
        accessRules: validAcl().accessRules.map((rule) => ({
          ...rule,
          inheritanceFlags: 3,
        })),
      },
      /inheritanceFlags inválidas/u,
      "file",
    ],
    [
      {
        ...validAcl(),
        accessRules: validAcl().accessRules.map((rule) => ({
          ...rule,
          propagationFlags: 1,
        })),
      },
      /propagationFlags inválidas/u,
      "file",
    ],
  ];

  for (const [acl, expected, kind = "file"] of invalidCases) {
    assert.throws(
      () => assertWindowsAclPolicy(acl, "arquivo privado", kind),
      expected,
    );
  }
});

test("leitor ACL usa PowerShell nativo absoluto e JSON estruturado", async () => {
  const calls = [];
  const acl = validAcl();
  const result = await readWindowsAcl("C:\\private\\config.json", {
    env: { SystemRoot: "C:\\Windows" },
    execFileImpl: async (...parameters) => {
      calls.push(parameters);
      return { stdout: JSON.stringify(acl), stderr: "" };
    },
  });

  assert.deepEqual(result, acl);
  assert.equal(
    calls[0][0],
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  assert.deepEqual(calls[0][1].slice(0, 3), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
  ]);
  assert.equal(calls[0][1].includes("-EncodedCommand"), true);
  assert.equal(
    calls[0][2].env.GITHUB_LINEAR_RECONCILER_ACL_PATH,
    "C:\\private\\config.json",
  );

  await assert.rejects(
    readWindowsAcl("C:\\private\\config.json", {
      env: { SystemRoot: "C:\\Windows" },
      execFileImpl: async () => ({ stdout: "not-json", stderr: "" }),
    }),
    /não foi possível inspecionar ACL Windows/u,
  );
});

test("criador Windows entrega DirectorySecurity na criação e não usa Set-Acl posterior", async () => {
  const calls = [];
  await createPrivateWindowsDirectory("C:\\private\\staging", {
    env: { SystemRoot: "C:\\Windows" },
    execFileImpl: async (...parameters) => {
      calls.push(parameters);
      return { stdout: "", stderr: "" };
    },
  });

  assert.equal(calls.length, 1);
  const encodedIndex = calls[0][1].indexOf("-EncodedCommand");
  const script = Buffer.from(calls[0][1][encodedIndex + 1], "base64").toString(
    "utf16le",
  );
  assert.match(
    script,
    /\[System\.IO\.Directory\]::CreateDirectory\(\$targetPath, \$acl\)/u,
  );
  assert.doesNotMatch(script, /Set-Acl|New-Item/u);
});

test("arquivo Windows nunca pula validação ACL", async () => {
  const metadata = {
    isSymbolicLink: () => false,
    isFile: () => true,
  };
  let reads = 0;
  await assertPrivateFilePath("C:\\private\\config.json", metadata, "config", {
    platform: "win32",
    readWindowsAclImpl: async () => {
      reads += 1;
      return validAcl();
    },
  });
  assert.equal(reads, 1);

  await assert.rejects(
    assertPrivateFilePath("C:\\private\\config.json", metadata, "config", {
      platform: "win32",
      readWindowsAclImpl: async () => ({
        ...validAcl(),
        accessRulesProtected: false,
      }),
    }),
    /DACL deve estar protegida/u,
  );
});

test("profile preexistente somente verifica ACL; profile novo endurece staging e marker", async (context) => {
  const parent = await mkdtemp(path.join(tmpdir(), "reconciler-win-acl-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const existingRoot = path.join(parent, "existing");
  const writes = [];
  const atomicCreates = [];
  const reader = async (_candidate, { kind }) => validAcl(kind);
  const writer = async (candidate, options) => {
    writes.push([candidate, options.kind]);
  };
  const createWindowsDirectoryImpl = async (candidate) => {
    atomicCreates.push(candidate);
    await mkdir(candidate);
  };

  const nativeProfile = await ensureOwnedLocalProfile({
    root: existingRoot,
    platform: "win32",
    createWindowsDirectoryImpl,
    readWindowsAclImpl: reader,
    setWindowsAclImpl: writer,
  });
  writes.length = 0;
  atomicCreates.length = 0;
  await ensureOwnedLocalProfile({
    root: nativeProfile.root,
    platform: "win32",
    createWindowsDirectoryImpl,
    readWindowsAclImpl: reader,
    setWindowsAclImpl: writer,
  });
  assert.deepEqual(writes, []);
  assert.deepEqual(atomicCreates, []);

  const newRoot = path.join(parent, "new-profile");
  await ensureOwnedLocalProfile({
    root: newRoot,
    platform: "win32",
    createWindowsDirectoryImpl,
    readWindowsAclImpl: reader,
    setWindowsAclImpl: writer,
  });
  assert.equal(atomicCreates.length, 1);
  assert.notEqual(atomicCreates[0], newRoot);
  assert.equal(writes.length, 2);
  assert.equal(path.basename(writes[0][0]), "credentials");
  assert.equal(path.basename(writes[1][0]), PROFILE_MARKER_NAME);
  assert.equal(
    writes.some(([candidate]) => candidate === atomicCreates[0]),
    false,
  );

  const failedRoot = path.join(parent, "failed-profile");
  await assert.rejects(
    ensureOwnedLocalProfile({
      root: failedRoot,
      platform: "win32",
      createWindowsDirectoryImpl,
      readWindowsAclImpl: reader,
      setWindowsAclImpl: async (_candidate, { kind }) => {
        if (kind === "file") throw new Error("synthetic ACL failure");
      },
      idFactory: () => "rollback-case",
    }),
    /synthetic ACL failure/u,
  );
  assert.equal(await stat(failedRoot).catch(() => null), null);
  assert.equal(
    (await readdir(parent)).some((entry) => entry.includes("rollback-case")),
    false,
  );
});

test("config verifica e relatório protege reports, temp e final sem mutar preexistentes", async (context) => {
  const parent = await mkdtemp(path.join(tmpdir(), "reconciler-win-paths-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const aclWrites = [];
  const aclReads = [];
  const reader = async (candidate, { kind }) => {
    aclReads.push(candidate);
    return validAcl(kind);
  };
  const writer = async (candidate, options) => {
    aclWrites.push([candidate, options.kind]);
  };
  const createWindowsDirectoryImpl = async (candidate) => mkdir(candidate);
  const profile = await ensureOwnedLocalProfile({
    root: path.join(parent, "profile"),
    platform: "win32",
    createWindowsDirectoryImpl,
    readWindowsAclImpl: reader,
    setWindowsAclImpl: writer,
  });
  aclReads.length = 0;
  aclWrites.length = 0;

  await writeFile(profile.configPath, `${JSON.stringify(VALID_CONFIG)}\n`);
  await assert.rejects(
    loadOperationalConfig(profile.configPath, {
      platform: "win32",
      profileRoot: profile.root,
      readWindowsAclImpl: async (candidate, { kind }) =>
        candidate === profile.configPath
          ? { ...validAcl(), accessRulesProtected: false }
          : validAcl(kind),
    }),
    /config operacional: DACL deve estar protegida/u,
  );
  assert.deepEqual(aclWrites, []);

  const written = await writeLocalReport({
    result: { state: "clean", counts: {}, findings: [] },
    now: new Date("2026-08-18T15:00:00.000Z"),
    directory: profile.root,
    idFactory: () => "acl-test",
    platform: "win32",
    readWindowsAclImpl: reader,
    setWindowsAclImpl: writer,
    stagingIdFactory: () => "reports-stage",
  });

  assert.deepEqual(
    aclWrites.map(([, kind]) => kind),
    ["directory", "file"],
  );
  assert.equal(aclWrites[0][0].includes("reports-stage"), true);
  assert.notEqual(aclWrites[0][0], profile.reportsPath);
  assert.equal(path.basename(aclWrites[1][0]).startsWith("."), true);
  assert.equal(aclReads.includes(profile.reportsPath), true);
  assert.equal(aclReads.includes(written.path), true);
});

test("union-find comprime iterativamente uma árvore adversarial de 40 mil nós", () => {
  const size = 40_000;
  const identifier = (index) => `SCALE-${String(index).padStart(5, "0")}`;
  const issues = [];
  for (let index = size - 2; index >= 0; index -= 1) {
    issues.push({
      identifier: identifier(index),
      duplicateOf: identifier(index + 1),
    });
  }
  issues.push({ identifier: identifier(size - 1), duplicateOf: null });

  const find = createDuplicateComponents(issues);
  assert.equal(find(identifier(size - 1)), identifier(0));
  assert.equal(find(identifier(size - 2)), identifier(0));
});

test(
  "integração Windows cria profile com ACL verificável",
  { skip: process.platform !== "win32" },
  async (context) => {
    const parent = await mkdtemp(path.join(tmpdir(), "reconciler-win-native-"));
    context.after(() => rm(parent, { recursive: true, force: true }));
    const profile = await ensureOwnedLocalProfile({
      root: path.join(parent, "profile"),
    });
    assertWindowsAclPolicy(
      await readWindowsAcl(profile.root, {
        env: { SystemRoot: process.env.SystemRoot },
      }),
      "profile com env mínima",
      "directory",
    );
    assert.equal(profile.root, path.join(parent, "profile"));
    assert.equal(
      JSON.parse(
        await readFile(path.join(profile.root, PROFILE_MARKER_NAME), "utf8"),
      ).application,
      "github-linear-reconciler",
    );
  },
);
