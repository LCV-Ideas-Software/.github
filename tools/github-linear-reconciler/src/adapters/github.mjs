import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/core";
import { paginateRest } from "@octokit/plugin-paginate-rest";
import { createPrivateKey } from "node:crypto";
import {
  lstat as nodeLstat,
  readFile as nodeReadFile,
  realpath as nodeRealpath,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import {
  assertOutsideGitWorktree,
  assertPrivateDirectoryPath,
  assertPrivateFilePath,
} from "../local-profile.mjs";
import { createCaptureWindow } from "../domain/capture-window.mjs";
import {
  buildGithubResourceKey,
  parseGithubOwner,
  parseGithubRepository,
} from "../domain/github-resource.mjs";

const PaginatingOctokit = Octokit.plugin(paginateRest);
const MAX_PAGES = 1_000;
const MAX_PRIVATE_KEY_BYTES = 64 * 1_024;
const pathSchema = z.string().regex(/^\/[A-Za-z0-9_{}./-]+$/u);

export const githubRepositoryResponseSchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  name: z.string().min(1),
  archived: z.boolean(),
  has_issues: z.boolean(),
  fork: z.boolean(),
});

const githubInstallationRepositorySchema =
  githubRepositoryResponseSchema.extend({
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    owner: z.object({
      id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      login: z.string().min(1),
      type: z.literal("Organization"),
    }),
  });

const githubAppResponseSchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  owner: z.object({
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    login: z.string().min(1),
    type: z.literal("Organization"),
  }),
  permissions: z.strictObject({
    metadata: z.literal("read"),
    issues: z.literal("read"),
    pull_requests: z.literal("read"),
  }),
  events: z.array(z.string()).length(0),
});

const githubAuthenticatedAppResponseSchema = githubAppResponseSchema.extend({
  installations_count: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
});

const githubInstallationResponseSchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  app_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  target_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  target_type: z.literal("Organization"),
  repository_selection: z.literal("all"),
  suspended_at: z.iso.datetime({ offset: true }).nullable(),
  account: z.object({
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    login: z.string().min(1),
    type: z.literal("Organization"),
  }),
  permissions: z.strictObject({
    metadata: z.literal("read"),
    issues: z.literal("read"),
    pull_requests: z.literal("read"),
  }),
  events: z.array(z.string()).length(0),
});

const githubInstallationsResponseSchema = z
  .array(githubInstallationResponseSchema)
  .max(2);

const githubInstallationRepositoriesResponseSchema = z.object({
  total_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  repositories: z.array(githubInstallationRepositorySchema).max(100),
});

const githubIssueResponseSchema = z.object({
  number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  node_id: z.string().min(1),
  state: z.enum(["open", "closed"]),
  state_reason: z.enum(["completed", "not_planned", "reopened"]).nullable(),
  pull_request: z.unknown().optional(),
  created_at: z.iso.datetime({ offset: true }).optional(),
  updated_at: z.iso.datetime({ offset: true }).optional(),
});

const githubCommentResponseSchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  node_id: z.string().min(1),
  body: z.string().nullable(),
  user: z.object({ login: z.string().min(1) }).nullable(),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }).optional(),
});

const githubPullResponseSchema = z
  .object({
    number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    merged_at: z.iso.datetime({ offset: true }).nullable(),
    merge_commit_sha: z
      .string()
      .regex(/^[0-9a-f]{40}$/iu)
      .nullable(),
    created_at: z.iso.datetime({ offset: true }).optional(),
    updated_at: z.iso.datetime({ offset: true }).optional(),
  })
  .superRefine((pull, context) => {
    if (pull.merged_at !== null && pull.merge_commit_sha === null) {
      context.addIssue({
        code: "custom",
        message: "PR mesclado exige merge_commit_sha",
        path: ["merge_commit_sha"],
      });
    }
  });

function decode(schema, value, scope) {
  if (!schema || typeof schema.safeParse !== "function")
    throw new Error(`${scope}: schema Zod obrigatorio`);
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`${scope}: payload GitHub invalido`);
  return result.data;
}

function invalidInstallation() {
  throw new Error("instalação GitHub App inválida");
}

export function validateGithubAppInstallation({
  organization,
  expectedAppId,
  app,
  installation,
}) {
  const parsedOrganization = parseGithubOwner(organization);
  const parsedApp = githubAppResponseSchema.safeParse(app);
  const parsedInstallation =
    githubInstallationResponseSchema.safeParse(installation);
  if (
    parsedOrganization === null ||
    !parsedApp.success ||
    !parsedInstallation.success
  ) {
    invalidInstallation();
  }
  const value = parsedInstallation.data;
  if (
    value.app_id !== parsedApp.data.id ||
    (expectedAppId !== undefined && value.app_id !== expectedAppId) ||
    parsedApp.data.owner.id !== value.account.id ||
    parsedApp.data.owner.login.toLowerCase() !== parsedOrganization ||
    value.target_id !== value.account.id ||
    value.account.login.toLowerCase() !== parsedOrganization ||
    value.suspended_at !== null
  ) {
    invalidInstallation();
  }
  return Object.freeze(value);
}

export async function collectInstallationRepositories({
  organization,
  organizationId,
  request,
}) {
  if (typeof request !== "function") {
    throw new TypeError("request GitHub App obrigatória");
  }
  const normalizedOrganization = parseGithubOwner(organization);
  if (normalizedOrganization === null) {
    throw new TypeError("organização GitHub App obrigatória");
  }
  let expectedTotal = null;
  const repositories = [];
  const ids = new Set();
  const names = new Set();
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await request("GET /installation/repositories", {
      per_page: 100,
      page,
    });
    const decoded = decode(
      githubInstallationRepositoriesResponseSchema,
      response?.data,
      "GET /installation/repositories",
    );
    expectedTotal ??= decoded.total_count;
    if (decoded.total_count !== expectedTotal) {
      throw new Error("total_count do inventário GitHub App mudou");
    }
    for (const repository of decoded.repositories) {
      if (
        repository.owner.login.toLowerCase() !== normalizedOrganization ||
        repository.owner.type !== "Organization" ||
        (organizationId !== undefined && repository.owner.id !== organizationId)
      ) {
        throw new Error("repositório fora da organização GitHub App");
      }
      const normalizedName = parseGithubRepository(repository.name);
      if (
        normalizedName === null ||
        ids.has(repository.id) ||
        names.has(normalizedName)
      ) {
        throw new Error("identidade de repositório GitHub App duplicada");
      }
      ids.add(repository.id);
      names.add(normalizedName);
      repositories.push({
        id: repository.id,
        name: normalizedName,
        archived: repository.archived,
        has_issues: repository.has_issues,
        fork: repository.fork,
      });
    }
    if (repositories.length === expectedTotal) {
      return Object.freeze(repositories.map(Object.freeze));
    }
    if (
      repositories.length > expectedTotal ||
      decoded.repositories.length === 0 ||
      decoded.repositories.length < 100
    ) {
      throw new Error("inventário GitHub App incompleto");
    }
  }
  throw new Error("inventário GitHub App excedeu o limite de paginação");
}

export async function loadGithubAppPrivateKey(
  privateKeyPath,
  {
    profileRoot,
    env = process.env,
    platform = process.platform,
    lstatImpl = nodeLstat,
    readFileImpl = nodeReadFile,
    readWindowsAclImpl,
    realpathImpl = nodeRealpath,
    createPrivateKeyImpl = createPrivateKey,
  } = {},
) {
  if (typeof privateKeyPath !== "string" || !path.isAbsolute(privateKeyPath)) {
    throw new TypeError("caminho PEM da GitHub App deve ser absoluto");
  }
  const absolutePath = path.resolve(privateKeyPath);
  if (typeof profileRoot !== "string" || !path.isAbsolute(profileRoot)) {
    throw new TypeError("raiz do profile é obrigatória para validar a chave");
  }
  const absoluteProfileRoot = path.resolve(profileRoot);
  const profileMetadata = await lstatImpl(absoluteProfileRoot);
  await assertPrivateDirectoryPath(
    absoluteProfileRoot,
    profileMetadata,
    "raiz do profile",
    { env, platform, readWindowsAclImpl },
  );
  const canonicalProfileRoot = await realpathImpl(absoluteProfileRoot);
  const credentialsPath = path.join(canonicalProfileRoot, "credentials");
  const credentialsMetadata = await lstatImpl(credentialsPath);
  await assertPrivateDirectoryPath(
    credentialsPath,
    credentialsMetadata,
    "diretório de credenciais",
    { env, platform, readWindowsAclImpl },
  );
  const canonicalCredentialsPath = await realpathImpl(credentialsPath);
  if (
    path.relative(canonicalProfileRoot, canonicalCredentialsPath) !==
    "credentials"
  ) {
    throw new TypeError("diretório de credenciais possui destino inválido");
  }
  const lexicalRelativePath = path.relative(credentialsPath, absolutePath);
  if (
    lexicalRelativePath === "" ||
    lexicalRelativePath.includes(path.sep) ||
    path.isAbsolute(lexicalRelativePath) ||
    lexicalRelativePath === ".."
  ) {
    throw new TypeError(
      "chave privada GitHub App deve ser filha direta de credentials",
    );
  }
  const metadata = await lstatImpl(absolutePath);
  await assertPrivateFilePath(
    absolutePath,
    metadata,
    "chave privada GitHub App",
    { env, platform, readWindowsAclImpl },
  );
  if (metadata.size <= 0 || metadata.size > MAX_PRIVATE_KEY_BYTES) {
    throw new TypeError("chave privada GitHub App deve ter no máximo 64 KiB");
  }
  const canonicalPath = await realpathImpl(absolutePath);
  if (path.dirname(canonicalPath) !== canonicalCredentialsPath) {
    throw new TypeError(
      "chave privada GitHub App possui destino canônico fora de credentials",
    );
  }
  await assertOutsideGitWorktree(canonicalPath, {
    lstatImpl,
    realpathImpl,
  });
  const keyBytes = await readFileImpl(canonicalPath);
  if (
    !Buffer.isBuffer(keyBytes) ||
    keyBytes.byteLength > MAX_PRIVATE_KEY_BYTES
  ) {
    throw new TypeError("chave privada GitHub App inválida");
  }
  let parsedKey;
  try {
    parsedKey = createPrivateKeyImpl(keyBytes);
  } catch {
    keyBytes.fill(0);
    throw new TypeError("chave privada GitHub App não é PEM RSA válida");
  }
  if (parsedKey.asymmetricKeyType !== "rsa") {
    keyBytes.fill(0);
    throw new TypeError("chave privada GitHub App deve ser RSA");
  }
  const pem = keyBytes.toString("utf8");
  keyBytes.fill(0);
  return pem;
}

function parseAppId(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value.trim())) {
    throw new TypeError("LINEAR_GITHUB_APP_ID inválido");
  }
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError("LINEAR_GITHUB_APP_ID inválido");
  }
  return parsed;
}

export async function createGithubAppBoundary({
  organization,
  appId,
  privateKeyPath,
  profileRoot,
  env = process.env,
  OctokitClass = PaginatingOctokit,
  authStrategy = createAppAuth,
  loadPrivateKey = loadGithubAppPrivateKey,
} = {}) {
  const parsedAppId = parseAppId(String(appId ?? ""));
  const privateKey = await loadPrivateKey(privateKeyPath, {
    profileRoot,
    env,
  });
  const appClient = new OctokitClass({
    authStrategy,
    auth: { appId: parsedAppId, privateKey },
  });
  const [appResponse, installationsResponse] = await Promise.all([
    appClient.request("GET /app"),
    appClient.request("GET /app/installations", { per_page: 2 }),
  ]);
  const app = decode(
    githubAuthenticatedAppResponseSchema,
    appResponse?.data,
    "GET /app",
  );
  const installations = decode(
    githubInstallationsResponseSchema,
    installationsResponse?.data,
    "GET /app/installations",
  );
  if (installations.length !== 1 || app.installations_count !== 1) {
    invalidInstallation();
  }
  const installation = validateGithubAppInstallation({
    organization,
    expectedAppId: parsedAppId,
    app,
    installation: installations[0],
  });
  const installationClient = new OctokitClass({
    authStrategy,
    auth: {
      appId: parsedAppId,
      privateKey,
      installationId: installation.id,
    },
  });
  const repositories = await collectInstallationRepositories({
    organization,
    organizationId: installation.target_id,
    request: (route, parameters) =>
      installationClient.request(route, parameters),
  });
  return Object.freeze({ installationClient, repositories });
}

function githubStatus(issue) {
  if (issue.state === "open") {
    if (issue.state_reason !== null && issue.state_reason !== "reopened")
      throw new Error("combinacao state/state_reason GitHub invalida");
    return "active";
  }
  if (!new Set(["completed", "not_planned"]).has(issue.state_reason))
    throw new Error("combinacao state/state_reason GitHub invalida");
  return issue.state_reason === "not_planned" ? "canceled" : "completed";
}

function captureCeilingMs(captureBoundary) {
  return typeof captureBoundary?.currentCeilingMs === "function"
    ? captureBoundary.currentCeilingMs()
    : captureBoundary;
}

function closeCaptureWindowSafely(captureWindow, fallbackMs) {
  if (typeof captureWindow?.closeMs !== "function") return fallbackMs;
  try {
    return captureWindow.closeMs();
  } catch {
    return captureWindow.lastCeilingMs();
  }
}

function boundedTimestamp(value, captureBoundary, label) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed > captureCeilingMs(captureBoundary)) {
    throw new Error(`${label} posterior a capturedAt`);
  }
  return parsed;
}

function validateTemporalEntity(
  entity,
  capturedAtMs,
  label,
  { requireMerged = false } = {},
) {
  if (typeof entity.created_at !== "string") {
    throw new Error(`${label}.created_at ausente`);
  }
  if (typeof entity.updated_at !== "string") {
    throw new Error(`${label}.updated_at ausente`);
  }
  const createdAtMs = boundedTimestamp(
    entity.created_at,
    capturedAtMs,
    `${label}.created_at`,
  );
  const updatedAtMs = boundedTimestamp(
    entity.updated_at,
    capturedAtMs,
    `${label}.updated_at`,
  );
  if (createdAtMs > updatedAtMs) {
    throw new Error(`${label}.created_at posterior a updated_at`);
  }
  if (requireMerged && entity.merged_at !== null) {
    const mergedAtMs = boundedTimestamp(
      entity.merged_at,
      capturedAtMs,
      `${label}.merged_at`,
    );
    if (createdAtMs > mergedAtMs || mergedAtMs > updatedAtMs) {
      throw new Error(`${label}.merged_at fora do ciclo temporal`);
    }
  }
}

function resourceKey(organization, repository, number) {
  const key = buildGithubResourceKey({
    owner: organization,
    repository,
    number,
  });
  if (key === null) throw new Error("identidade de recurso GitHub inválida");
  return key;
}

function isLinearLinkbackControl(comment) {
  return (
    new Set(["linear[bot]", "linear-code[bot]"]).has(
      comment.user?.login.toLowerCase(),
    ) && comment.body?.trimStart().startsWith("<!-- linear-linkback -->")
  );
}

function freezeSnapshot(snapshot) {
  for (const value of Object.values(snapshot)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item.comments) Object.freeze(item.comments);
        Object.freeze(item);
      }
      Object.freeze(value);
    }
  }
  return Object.freeze(snapshot);
}

/**
 * @typedef {object} GithubBoundarySnapshot
 * @property {boolean} complete
 * @property {ReadonlyArray<{source:"github",code:string,scope:string,message:string}>} failures
 * @property {number} captureStartedAtMs
 * @property {number} capturedAtMs
 * @property {string} organization
 * @property {ReadonlyArray<{id:number,name:string,archived:boolean,issuesEnabled:boolean,fork:boolean}>} repositories
 * @property {ReadonlyArray<{key:string,nodeId:string,repository:string,number:number,status:"active"|"completed"|"canceled",createdAtMs:number,updatedAtMs:number,comments:ReadonlyArray<object>}>} issues
 * @property {ReadonlyArray<{key:string,repository:string,number:number,createdAtMs:number,updatedAtMs:number,mergedAtMs:number|null,mergeCommitSha:string|null}>} pulls
 */

export function createGithubAdapter({
  request,
  paginateIterator,
  repositoryInventory,
  clock,
} = {}) {
  if (typeof request !== "function" || typeof paginateIterator !== "function") {
    throw new Error("cliente de instalação GitHub App obrigatório");
  }
  if (!Array.isArray(repositoryInventory)) {
    throw new Error("inventário da instalação GitHub App obrigatório");
  }
  const requestImpl = request;
  const iteratorImpl = paginateIterator;

  async function get({ path, parameters = {}, schema }) {
    const parsedPath = pathSchema.safeParse(path);
    if (!parsedPath.success) throw new Error("path GitHub GET invalido");
    const response = await requestImpl(`GET ${parsedPath.data}`, parameters);
    return decode(schema, response?.data, `GET ${parsedPath.data}`);
  }

  async function paginate({ path, parameters = {}, itemSchema, identity }) {
    const parsedPath = pathSchema.safeParse(path);
    if (!parsedPath.success) throw new Error("path GitHub paginate invalido");
    if (typeof identity !== "function")
      throw new Error("paginate exige identidade estavel");
    const output = [];
    const identities = new Set();
    let pages = 0;
    for await (const response of iteratorImpl(
      `GET ${parsedPath.data}`,
      parameters,
    )) {
      pages += 1;
      if (pages > MAX_PAGES)
        throw new Error("paginacao GitHub excedeu o limite");
      if (!Array.isArray(response?.data))
        throw new Error("pagina GitHub nao retornou array");
      for (const raw of response.data) {
        const item = decode(itemSchema, raw, `GET ${parsedPath.data}`);
        const key = identity(item);
        if (typeof key !== "string" || key === "")
          throw new Error("identidade GitHub invalida");
        if (identities.has(key))
          throw new Error(`identidade GitHub duplicada: ${key}`);
        identities.add(key);
        output.push(item);
      }
    }
    return Object.freeze(output);
  }

  async function readOrganizationSnapshot({ organization, capturedAt }) {
    let captureWindow;
    try {
      const canonicalOrganization = parseGithubOwner(organization);
      if (canonicalOrganization === null)
        throw new Error("organização GitHub inválida");
      captureWindow = createCaptureWindow({ startedAt: capturedAt, clock });
      const capturedAtMs = captureWindow;
      const repositoriesRaw = repositoryInventory;
      if (!Array.isArray(repositoriesRaw)) {
        throw new Error("inventário GitHub App inválido");
      }
      const repositoryIds = new Set();
      const repositoryNames = new Set();
      for (const repository of repositoriesRaw) {
        const name = parseGithubRepository(repository?.name);
        if (!name || repositoryNames.has(name)) {
          throw new Error("identidade de repositório GitHub duplicada");
        }
        repositoryNames.add(name);
        if (
          !Number.isSafeInteger(repository.id) ||
          repository.id <= 0 ||
          repositoryIds.has(repository.id)
        ) {
          throw new Error("ID de repositório GitHub inválido ou duplicado");
        }
        repositoryIds.add(repository.id);
      }
      const repositories = repositoriesRaw
        .filter((repository) => !repository.archived)
        .map((repository) => ({
          id: repository.id,
          name: parseGithubRepository(repository.name),
          archived: false,
          issuesEnabled: repository.has_issues,
          fork: repository.fork,
        }));
      const issues = [];
      const pulls = [];
      for (const repository of repositories) {
        if (repository.issuesEnabled) {
          const rawIssues = await paginate({
            path: "/repos/{owner}/{repo}/issues",
            parameters: {
              owner: canonicalOrganization,
              repo: repository.name,
              state: "all",
              per_page: 100,
            },
            itemSchema: githubIssueResponseSchema,
            identity: (issue) => String(issue.number),
          });
          for (const issue of rawIssues.filter((item) => !item.pull_request)) {
            validateTemporalEntity(
              issue,
              capturedAtMs,
              `issue ${repository.name}#${issue.number}`,
            );
            const comments = await paginate({
              path: "/repos/{owner}/{repo}/issues/{issue_number}/comments",
              parameters: {
                owner: canonicalOrganization,
                repo: repository.name,
                issue_number: issue.number,
                per_page: 100,
              },
              itemSchema: githubCommentResponseSchema,
              identity: (comment) => comment.node_id,
            });
            const key = resourceKey(
              canonicalOrganization,
              repository.name,
              issue.number,
            );
            const normalizedComments = comments.map((comment) => {
              validateTemporalEntity(
                comment,
                capturedAtMs,
                `comment ${comment.node_id}`,
              );
              return comment;
            });
            issues.push({
              key,
              nodeId: issue.node_id,
              repository: repository.name,
              number: issue.number,
              status: githubStatus(issue),
              createdAtMs: Date.parse(issue.created_at),
              updatedAtMs: Date.parse(issue.updated_at),
              comments: normalizedComments
                .filter((comment) => !isLinearLinkbackControl(comment))
                .map((comment) => ({
                  id: comment.node_id,
                  threadId: key,
                  createdAtMs: Date.parse(comment.created_at),
                  updatedAtMs: Date.parse(comment.updated_at),
                })),
            });
          }
        }
        const rawPulls = await paginate({
          path: "/repos/{owner}/{repo}/pulls",
          parameters: {
            owner: canonicalOrganization,
            repo: repository.name,
            state: "all",
            per_page: 100,
          },
          itemSchema: githubPullResponseSchema,
          identity: (pull) => String(pull.number),
        });
        for (const pull of rawPulls) {
          validateTemporalEntity(
            pull,
            capturedAtMs,
            `pull ${repository.name}#${pull.number}`,
            { requireMerged: true },
          );
          pulls.push({
            key: resourceKey(
              canonicalOrganization,
              repository.name,
              pull.number,
            ),
            repository: repository.name,
            number: pull.number,
            mergedAtMs: pull.merged_at ? Date.parse(pull.merged_at) : null,
            mergeCommitSha: pull.merge_commit_sha?.toLowerCase() ?? null,
            createdAtMs: Date.parse(pull.created_at),
            updatedAtMs: Date.parse(pull.updated_at),
          });
        }
      }
      return freezeSnapshot({
        complete: true,
        failures: [],
        captureStartedAtMs: captureWindow.captureStartedAtMs,
        capturedAtMs: captureWindow.closeMs(),
        organization: canonicalOrganization,
        repositories,
        issues,
        pulls,
      });
    } catch (error) {
      const fallbackCapturedAtMs = Number.isFinite(Date.parse(capturedAt))
        ? Date.parse(capturedAt)
        : 0;
      return freezeSnapshot({
        complete: false,
        failures: [
          {
            source: "github",
            code: "boundary_invalid",
            scope: "organization",
            message: error instanceof Error ? error.message : String(error),
          },
        ],
        captureStartedAtMs:
          captureWindow?.captureStartedAtMs ?? fallbackCapturedAtMs,
        capturedAtMs: closeCaptureWindowSafely(
          captureWindow,
          fallbackCapturedAtMs,
        ),
        organization: String(organization ?? "").toLowerCase(),
        repositories: [],
        issues: [],
        pulls: [],
      });
    }
  }

  return Object.freeze({ get, paginate, readOrganizationSnapshot });
}

export async function readGithubSnapshot({
  config,
  appId,
  privateKeyPath,
  profileRoot,
  env = process.env,
  capturedAt = new Date().toISOString(),
  clock,
  createBoundary = createGithubAppBoundary,
} = {}) {
  let captureWindow;
  try {
    captureWindow = createCaptureWindow({ startedAt: capturedAt, clock });
    const boundary = await createBoundary({
      organization: config?.organization,
      appId,
      privateKeyPath,
      profileRoot,
      env,
    });
    const client = boundary.installationClient;
    const adapter = createGithubAdapter({
      request: (route, parameters) => client.request(route, parameters),
      paginateIterator: (route, parameters) =>
        client.paginate.iterator(route, parameters),
      repositoryInventory: boundary.repositories,
      clock: () => captureWindow.currentCeilingMs(),
    });
    return adapter.readOrganizationSnapshot({
      organization: config?.organization,
      capturedAt,
    });
  } catch {
    const fallbackCapturedAtMs = Number.isFinite(Date.parse(capturedAt))
      ? Date.parse(capturedAt)
      : 0;
    return freezeSnapshot({
      complete: false,
      failures: [
        {
          source: "github",
          code: "boundary_invalid",
          scope: "organization",
          message: "autenticação ou instalação GitHub App inválida",
        },
      ],
      captureStartedAtMs:
        captureWindow?.captureStartedAtMs ?? fallbackCapturedAtMs,
      capturedAtMs: closeCaptureWindowSafely(
        captureWindow,
        fallbackCapturedAtMs,
      ),
      organization: String(config?.organization ?? "").toLowerCase(),
      repositories: [],
      issues: [],
      pulls: [],
    });
  }
}
