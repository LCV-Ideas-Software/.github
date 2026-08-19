import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectInstallationRepositories,
  createGithubAppBoundary,
  createGithubAdapter,
  loadGithubAppPrivateKey,
  readGithubSnapshot,
  validateGithubAppInstallation,
} from "../src/adapters/github.mjs";
import { loadOperationalConfig } from "../src/config.mjs";
import { parseCliArgs, runCli } from "../src/cli.mjs";
import {
  ensureOwnedLocalProfile,
  hardenCreatedPrivatePath,
  PROFILE_MARKER_NAME,
} from "../src/local-profile.mjs";
import { writeLocalReport } from "../src/report/local.mjs";

const CAPTURED_AT = "2030-01-02T04:00:00.000Z";

function installation(overrides = {}) {
  return {
    id: 123,
    app_id: 456,
    target_id: 789,
    target_type: "Organization",
    repository_selection: "all",
    suspended_at: null,
    account: { id: 789, login: "example-org", type: "Organization" },
    permissions: {
      metadata: "read",
      issues: "read",
      pull_requests: "read",
    },
    events: [],
    ...overrides,
  };
}

function app(overrides = {}) {
  return {
    id: 456,
    installations_count: 1,
    owner: { id: 789, login: "example-org", type: "Organization" },
    permissions: {
      metadata: "read",
      issues: "read",
      pull_requests: "read",
    },
    events: [],
    ...overrides,
  };
}

test("instalação GitHub App exige organização, abrangência e permissões exatas", () => {
  const valid = validateGithubAppInstallation({
    organization: "example-org",
    app: app(),
    installation: installation(),
  });
  assert.equal(valid.id, 123);

  assert.throws(
    () =>
      validateGithubAppInstallation({
        organization: "example-org",
        app: app({
          owner: { id: 999, login: "external-owner", type: "Organization" },
        }),
        installation: installation(),
      }),
    /instalação GitHub App inválida/u,
  );

  for (const invalid of [
    installation({ repository_selection: "selected" }),
    installation({ suspended_at: CAPTURED_AT }),
    installation({ events: ["issues"] }),
    installation({ permissions: { metadata: "read", issues: "read" } }),
    installation({
      permissions: {
        metadata: "read",
        issues: "write",
        pull_requests: "read",
      },
    }),
    installation({
      account: { id: 789, login: "other", type: "Organization" },
    }),
    installation({ app_id: 999 }),
  ]) {
    assert.throws(
      () =>
        validateGithubAppInstallation({
          organization: "example-org",
          app: app(),
          installation: invalid,
        }),
      /instalação GitHub App inválida/u,
    );
  }
});

test("inventário da instalação pagina até total_count e recusa lacunas ou duplicatas", async () => {
  const repositories = Array.from({ length: 101 }, (_, index) => ({
    id: index + 1,
    name: `repo-${index + 1}`,
    archived: false,
    has_issues: true,
    fork: false,
    owner: { id: 789, login: "example-org", type: "Organization" },
  }));
  const calls = [];
  const complete = await collectInstallationRepositories({
    organization: "example-org",
    organizationId: 789,
    request: async (_route, parameters) => {
      calls.push(parameters.page);
      return {
        data: {
          total_count: repositories.length,
          repositories: repositories.slice(
            (parameters.page - 1) * 100,
            parameters.page * 100,
          ),
        },
      };
    },
  });
  assert.equal(complete.length, 101);
  assert.deepEqual(calls, [1, 2]);

  await assert.rejects(
    collectInstallationRepositories({
      organization: "example-org",
      request: async () => ({
        data: { total_count: 2, repositories: [repositories[0]] },
      }),
    }),
    /inventário GitHub App incompleto/u,
  );
  await assert.rejects(
    collectInstallationRepositories({
      organization: "example-org",
      request: async () => ({
        data: {
          total_count: 2,
          repositories: [repositories[0], repositories[0]],
        },
      }),
    }),
    /duplicada/u,
  );
});

test("boundary oficial separa autenticação App da autenticação da instalação", async () => {
  const instances = [];
  class FakeOctokit {
    constructor(options) {
      this.options = options;
      this.paginate = { iterator: async function* () {} };
      instances.push(this);
    }

    async request(route) {
      if (route === "GET /app") return { data: app() };
      if (route === "GET /app/installations") {
        return { data: [installation()] };
      }
      if (route === "GET /installation/repositories") {
        return { data: { total_count: 0, repositories: [] } };
      }
      throw new Error(`rota inesperada: ${route}`);
    }
  }
  const authStrategy = () => {};
  const boundary = await createGithubAppBoundary({
    organization: "example-org",
    appId: "456",
    privateKeyPath: "C:\\private\\app.pem",
    OctokitClass: FakeOctokit,
    authStrategy,
    loadPrivateKey: async () => "synthetic-private-key",
  });
  assert.equal(instances.length, 2);
  assert.deepEqual(instances[0].options, {
    authStrategy,
    auth: { appId: 456, privateKey: "synthetic-private-key" },
  });
  assert.deepEqual(instances[1].options, {
    authStrategy,
    auth: {
      appId: 456,
      privateKey: "synthetic-private-key",
      installationId: 123,
    },
  });
  assert.deepEqual(boundary.repositories, []);
  assert.equal(boundary.installationClient, instances[1]);
});

test("facade converte falha de autenticação em snapshot incompleto redigido", async () => {
  const captureEndedAt = "2030-01-02T04:00:05.000Z";
  let clockMs = Date.parse(CAPTURED_AT);
  const snapshot = await readGithubSnapshot({
    config: { organization: "example-org" },
    appId: "456",
    privateKeyPath: "C:\\private\\app.pem",
    capturedAt: CAPTURED_AT,
    clock: () => clockMs,
    createBoundary: async () => {
      clockMs = Date.parse(captureEndedAt);
      throw new Error("private-key-material-must-not-leak");
    },
  });
  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.captureStartedAtMs, Date.parse(CAPTURED_AT));
  assert.equal(snapshot.capturedAtMs, Date.parse(captureEndedAt));
  assert.equal(snapshot.failures[0].code, "boundary_invalid");
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /private-key-material-must-not-leak/u,
  );
});

test("chave GitHub App deve ser PEM RSA regular, canônica e privada", async (context) => {
  const parent = await mkdtemp(path.join(tmpdir(), "reconciler-key-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const profile = await ensureOwnedLocalProfile({
    root: path.join(parent, "profile"),
  });
  const keyPath = path.join(profile.credentialsPath, "app.pem");
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  await writeFile(keyPath, privateKey, { mode: 0o600 });
  if (process.platform === "win32") {
    await hardenCreatedPrivatePath(keyPath, {
      kind: "file",
      label: "chave de teste",
    });
  } else {
    await chmod(keyPath, 0o600);
  }
  assert.match(
    await loadGithubAppPrivateKey(keyPath, { profileRoot: profile.root }),
    /BEGIN PRIVATE KEY/u,
  );
  await assert.rejects(
    loadGithubAppPrivateKey(path.join(parent, "outside.pem"), {
      profileRoot: profile.root,
    }),
    /filha direta de credentials/u,
  );

  if (process.platform !== "win32") {
    await chmod(keyPath, 0o640);
    await assert.rejects(
      loadGithubAppPrivateKey(keyPath, {
        platform: "linux",
        profileRoot: profile.root,
      }),
      /modo 0600/u,
    );
    await chmod(keyPath, 0o600);
  }
  if (process.platform !== "win32") {
    const link = path.join(profile.credentialsPath, "link.pem");
    await symlink(keyPath, link);
    await assert.rejects(
      loadGithubAppPrivateKey(link, { profileRoot: profile.root }),
      /link simbólico/u,
    );
  }
});

test("config recusa caminho lexical ou canônico dentro de worktree Git", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "reconciler-config-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".git"));
  const configPath = path.join(root, "config.json");
  await writeFile(configPath, "{}\n", "utf8");
  await assert.rejects(
    loadOperationalConfig(configPath, { profileRoot: root }),
    /worktree Git/u,
  );
});

test("init do profile cria raiz, marker e credentials versionados", async (context) => {
  const parent = await mkdtemp(path.join(tmpdir(), "reconciler-profile-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "profile");
  const profile = await ensureOwnedLocalProfile({ root });
  const canonicalRoot = await realpath(root);
  assert.equal(profile.root, canonicalRoot);
  assert.equal(profile.configPath, path.join(canonicalRoot, "config.json"));
  assert.equal(profile.reportsPath, path.join(canonicalRoot, "reports"));
  assert.equal(
    profile.credentialsPath,
    path.join(canonicalRoot, "credentials"),
  );
  assert.deepEqual(
    JSON.parse(await readFile(path.join(root, PROFILE_MARKER_NAME), "utf8")),
    { schemaVersion: 1, application: "github-linear-reconciler" },
  );
  assert.equal((await stat(profile.credentialsPath)).isDirectory(), true);
  assert.equal(await stat(profile.reportsPath).catch(() => null), null);

  await rm(profile.credentialsPath, { recursive: true, force: true });
  const migrated = await ensureOwnedLocalProfile({ root });
  assert.equal((await stat(migrated.credentialsPath)).isDirectory(), true);

  const missingParent = path.join(parent, "missing", "profile");
  await assert.rejects(ensureOwnedLocalProfile({ root: missingParent }), {
    code: "ENOENT",
  });
  assert.equal(await stat(path.dirname(missingParent)).catch(() => null), null);

  const failedRoot = path.join(parent, "failed-profile");
  await assert.rejects(
    ensureOwnedLocalProfile({
      root: failedRoot,
      openImpl: async () => {
        throw new Error("synthetic marker failure");
      },
    }),
    /synthetic marker failure/u,
  );
  assert.equal(await stat(failedRoot).catch(() => null), null);
});

test("snapshot GitHub falha fechado para timestamps posteriores à captura", async () => {
  assert.throws(
    () => createGithubAdapter({ token: "legacy-pat" }),
    /instalação GitHub App/u,
  );
  const adapter = createGithubAdapter({
    repositoryInventory: [
      {
        id: 1,
        name: "example-app",
        archived: false,
        has_issues: true,
        fork: false,
      },
    ],
    paginateIterator: async function* (route) {
      if (route === "GET /repos/{owner}/{repo}/issues") {
        yield {
          data: [
            {
              number: 1,
              node_id: "I_kwDOFutureIssue",
              state: "open",
              state_reason: null,
              created_at: "2030-01-02T03:00:00.000Z",
              updated_at: "2030-01-02T05:00:00.000Z",
            },
          ],
        };
      } else if (route === "GET /repos/{owner}/{repo}/pulls") {
        yield { data: [] };
      } else {
        yield { data: [] };
      }
    },
    request: async () => ({ data: {} }),
  });
  const snapshot = await adapter.readOrganizationSnapshot({
    organization: "example-org",
    capturedAt: CAPTURED_AT,
  });
  assert.equal(snapshot.complete, false);
  assert.match(snapshot.failures[0].message, /capturedAt/u);
});

test("relatório não altera diretório preexistente sem marker da ferramenta", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "reconciler-foreign-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  let chmodCalls = 0;
  await assert.rejects(
    writeLocalReport({
      result: { state: "clean", counts: {}, findings: [] },
      directory: root,
      chmodImpl: async () => {
        chmodCalls += 1;
      },
    }),
    /marker/u,
  );
  assert.equal(chmodCalls, 0);
  assert.deepEqual(
    await readFile(path.join(root, ".github-linear-reconciler"), "utf8").catch(
      () => null,
    ),
    null,
  );
});

test("CLI usa somente profile fixo e credenciais da GitHub App", async () => {
  assert.deepEqual(parseCliArgs([]), { mode: "audit" });
  assert.deepEqual(parseCliArgs(["--init-profile"]), {
    mode: "init-profile",
  });
  assert.throws(() => parseCliArgs(["--config", "other.json"]), /argumento/u);
  const calls = [];
  let stdout = "";
  const exitCode = await runCli({
    argv: [],
    env: {
      LINEAR_READ_KEY: "linear-secret",
      LINEAR_GITHUB_APP_ID: "456",
      LINEAR_GITHUB_APP_PRIVATE_KEY_PATH: "C:\\private\\app.pem",
      LINEAR_GITHUB_READ_TOKEN: "must-not-be-used",
    },
    stdout: { write: (chunk) => (stdout += String(chunk)) },
    now: new Date(CAPTURED_AT),
    dependencies: {
      assertOwnedLocalProfile: async () => ({
        root: "C:\\profile",
        configPath: "C:\\profile\\config.json",
        reportsPath: "C:\\profile\\reports",
      }),
      loadConfig: async (configPath) => {
        calls.push(["config", configPath]);
        return { organization: "example-org" };
      },
      readLinearSnapshot: async ({ token }) => {
        calls.push(["linear", token]);
        return { complete: true };
      },
      readGithubSnapshot: async (input) => {
        calls.push(["github", input]);
        return { complete: true };
      },
      evaluate: async () => ({ state: "clean", counts: {}, findings: [] }),
      determineExitCode: () => 0,
      writeLocalReport: async (input) => calls.push(["report", input]),
    },
  });
  assert.equal(exitCode, 0);
  assert.equal(stdout, '{"state":"clean","counts":{}}\n');
  assert.deepEqual(calls[0], ["config", "C:\\profile\\config.json"]);
  assert.deepEqual(calls[1], ["linear", "linear-secret"]);
  assert.equal(calls[2][0], "github");
  assert.equal(calls[2][1].appId, "456");
  assert.equal(calls[2][1].privateKeyPath, "C:\\private\\app.pem");
  assert.equal(JSON.stringify(calls).includes("must-not-be-used"), false);
  assert.equal(calls[3][1].directory, "C:\\profile");

  await assert.rejects(
    runCli({
      argv: [],
      env: {
        LINEAR_READ_KEY: "linear-secret",
        LINEAR_GITHUB_READ_TOKEN: "legacy-pat",
      },
      dependencies: {},
    }),
    /LINEAR_GITHUB_APP_ID/u,
  );
});

test("--init-profile não lê credenciais, config ou rede", async () => {
  const calls = [];
  let stdout = "";
  const exitCode = await runCli({
    argv: ["--init-profile"],
    env: { LOCALAPPDATA: "C:\\state" },
    stdout: { write: (chunk) => (stdout += String(chunk)) },
    dependencies: {
      ensureOwnedLocalProfile: async (input) => calls.push(input),
    },
  });
  assert.equal(exitCode, 0);
  assert.equal(stdout, '{"profile":"initialized"}\n');
  assert.deepEqual(calls, [{ env: { LOCALAPPDATA: "C:\\state" } }]);
});
