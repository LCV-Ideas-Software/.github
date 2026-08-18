import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  loadOperationalConfig,
  parseOperationalConfig,
} from "../src/config.mjs";
import {
  createGithubAdapter,
  githubRepositoryResponseSchema,
} from "../src/adapters/github.mjs";
import { createLinearAdapter } from "../src/adapters/linear.mjs";
import { loadRuntimeDependencies } from "../src/cli.mjs";
import {
  ensureOwnedLocalProfile,
  WINDOWS_FULL_CONTROL_MASK,
} from "../src/local-profile.mjs";

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

const validConfig = {
  organization: "example-org",
  releaseRequiredAfter: "2030-01-02T03:04:05.000Z",
  commentGraceMinutes: 30,
  mappings: [
    { linearTeamKey: "ROOT", mode: "umbrella" },
    {
      linearTeamKey: "APP",
      mode: "github-backed",
      repository: "example-app",
      linearReleasePipelineId: "123e4567-e89b-42d3-a456-426614174000",
    },
    { linearTeamKey: "PRIVATE", mode: "linear-only" },
  ],
};

test("exemplo operacional documentado satisfaz o schema publicado", () => {
  const documentation = readFileSync(
    path.resolve(
      import.meta.dirname,
      "../../../docs/GITHUB_LINEAR_RECONCILIATION.md",
    ),
    "utf8",
  );
  const jsonBlock = /```json\r?\n([\s\S]*?)\r?\n```/u.exec(documentation)?.[1];
  assert.ok(jsonBlock, "a documentação deve conter o exemplo JSON");
  assert.doesNotThrow(() => parseOperationalConfig(JSON.parse(jsonBlock)));
});

test("config operacional e integral, obrigatoria e imutavel", () => {
  const config = parseOperationalConfig(validConfig);
  assert.deepEqual(config, validConfig);
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.mappings), true);
  const canonical = parseOperationalConfig({
    ...validConfig,
    organization: "Example-Org",
    mappings: validConfig.mappings.map((mapping) =>
      mapping.mode === "github-backed"
        ? {
            ...mapping,
            repository: "Example-App",
            linearReleasePipelineId: "123E4567-E89B-42D3-A456-426614174000",
          }
        : mapping,
    ),
  });
  assert.equal(canonical.organization, "example-org");
  assert.equal(canonical.mappings[1].repository, "example-app");
  assert.equal(
    canonical.mappings[1].linearReleasePipelineId,
    "123e4567-e89b-42d3-a456-426614174000",
  );
  assert.throws(() => parseOperationalConfig({}), /config/i);
  assert.throws(
    () => parseOperationalConfig({ ...validConfig, unexpected: true }),
    /config/i,
  );
});

test("config exige chaves e repositorios unicos e um unico umbrella", () => {
  assert.throws(
    () =>
      parseOperationalConfig({
        ...validConfig,
        mappings: [
          ...validConfig.mappings,
          { linearTeamKey: "APP", mode: "linear-only" },
        ],
      }),
    /linearTeamKey/i,
  );
  assert.throws(
    () =>
      parseOperationalConfig({
        ...validConfig,
        mappings: [
          ...validConfig.mappings,
          {
            linearTeamKey: "SECOND",
            mode: "github-backed",
            repository: "EXAMPLE-APP",
            linearReleasePipelineId: "223e4567-e89b-42d3-a456-426614174000",
          },
        ],
      }),
    /repository/i,
  );
  assert.throws(
    () =>
      parseOperationalConfig({
        ...validConfig,
        mappings: validConfig.mappings.filter(
          (mapping) => mapping.mode !== "umbrella",
        ),
      }),
    /umbrella/i,
  );
  assert.throws(
    () =>
      parseOperationalConfig({
        ...validConfig,
        mappings: validConfig.mappings.map((mapping) =>
          mapping.mode === "github-backed"
            ? { ...mapping, linearReleasePipelineId: "not-a-uuid" }
            : mapping,
        ),
      }),
    /linearReleasePipelineId/i,
  );
  assert.throws(
    () =>
      parseOperationalConfig({
        ...validConfig,
        mappings: [
          ...validConfig.mappings,
          {
            linearTeamKey: "SECOND",
            mode: "github-backed",
            repository: "second-app",
            linearReleasePipelineId: "123e4567-e89b-42d3-a456-426614174000",
          },
        ],
      }),
    /linearReleasePipelineId/i,
  );
});

test("loader usa somente o config.json fixo do profile tool-owned", async (context) => {
  await assert.rejects(
    loadOperationalConfig("relative/config.json", {
      readFile: async () => JSON.stringify(validConfig),
    }),
    /absoluto/i,
  );
  const parent = await mkdtemp(path.join(tmpdir(), "reconciler-config-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const profile = await ensureOwnedLocalProfile({
    root: path.join(parent, "profile"),
    readWindowsAclImpl: readValidWindowsAcl,
    setWindowsAclImpl: async () => {},
  });
  await writeFile(profile.configPath, JSON.stringify(validConfig), {
    encoding: "utf8",
    mode: 0o600,
  });
  const loaded = await loadOperationalConfig(profile.configPath, {
    profileRoot: profile.root,
    readWindowsAclImpl: readValidWindowsAcl,
  });
  assert.deepEqual(loaded, validConfig);
});

function pagedConnection(pages) {
  let index = 0;
  return {
    nodes: pages[0],
    pageInfo: {
      hasNextPage: pages.length > 1,
      endCursor: pages.length > 1 ? "cursor-1" : null,
    },
    async fetchNext() {
      index += 1;
      return {
        nodes: pages[index],
        pageInfo: {
          hasNextPage: index < pages.length - 1,
          endCursor: index < pages.length - 1 ? `cursor-${index + 1}` : null,
        },
        fetchNext: this.fetchNext,
      };
    },
  };
}

const emptyConnection = () => pagedConnection([[]]);

test("Linear usa SDK oficial, pagina integralmente e normaliza epoch", async () => {
  const client = {
    teams: async () =>
      pagedConnection([
        [
          {
            id: "team-1",
            key: "ROOT",
            name: "Root",
            archivedAt: null,
            retiredAt: null,
            updatedAt: "2030-01-02T03:00:00.000Z",
          },
        ],
        [
          {
            id: "team-2",
            key: "APP",
            name: "App",
            archivedAt: null,
            retiredAt: null,
            updatedAt: "2030-01-02T03:00:00.000Z",
          },
        ],
      ]),
    issues: async () =>
      pagedConnection([
        [
          {
            id: "issue-1",
            identifier: "APP-1",
            title: "Synthetic issue",
            updatedAt: "2030-01-02T03:04:05.000Z",
            team: { id: "team-2", key: "APP", name: "App" },
            state: { id: "state-1", type: "started", name: "Started" },
            syncedWith: [],
            attachments: async () => emptyConnection(),
            comments: async () => emptyConnection(),
            relations: async () => emptyConnection(),
            inverseRelations: async () => emptyConnection(),
            releases: async () => emptyConnection(),
          },
        ],
      ]),
    cycles: async () => emptyConnection(),
    projects: async () => emptyConnection(),
    initiatives: async () => emptyConnection(),
    documents: async () => emptyConnection(),
    releasePipelines: async () => emptyConnection(),
    releases: async () => emptyConnection(),
    issueToReleases: async () => emptyConnection(),
  };
  const adapter = createLinearAdapter({
    apiKey: "linear-test-token",
    clientFactory: () => client,
  });
  assert.deepEqual(Object.keys(adapter).sort(), ["readWorkspaceSnapshot"]);
  const snapshot = await adapter.readWorkspaceSnapshot({
    capturedAt: "2030-01-02T04:00:00.000Z",
  });
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.failures.length, 0);
  assert.deepEqual(
    snapshot.teams.map(({ key }) => ({ key })),
    [{ key: "ROOT" }, { key: "APP" }],
  );
  assert.equal(snapshot.issues[0].teamKey, "APP");
  assert.equal(snapshot.issues[0].status, "active");
  assert.deepEqual(snapshot.issues[0].nativeCounterpartKeys, []);
  assert.deepEqual(snapshot.issues[0].attachmentIssueKeys, []);
  assert.deepEqual(snapshot.issues[0].insecureGithubResourceKeys, []);
});

test("Linear torna pagina ou node parcial inconclusivo", async () => {
  const adapter = createLinearAdapter({
    apiKey: "linear-test-token",
    clientFactory: () => ({
      teams: async () => pagedConnection([[{ id: "team-1", key: "ROOT" }]]),
      issues: async () => pagedConnection([[]]),
      cycles: async () => emptyConnection(),
      projects: async () => emptyConnection(),
      initiatives: async () => emptyConnection(),
      documents: async () => emptyConnection(),
    }),
  });
  const snapshot = await adapter.readWorkspaceSnapshot({
    capturedAt: "2030-01-02T04:00:00.000Z",
  });
  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.failures[0].source, "linear");
  assert.equal(snapshot.failures[0].code, "boundary_invalid");
  assert.deepEqual(snapshot.teams, []);
});

test("GitHub facade expoe somente GET, paginate e snapshot", async () => {
  const calls = [];
  const adapter = createGithubAdapter({
    request: async (route, parameters) => {
      calls.push({ route, parameters });
      return {
        data: {
          name: "example-app",
          archived: false,
          has_issues: true,
          fork: false,
        },
      };
    },
    paginateIterator: async function* () {},
    repositoryInventory: [],
  });
  assert.deepEqual(Object.keys(adapter).sort(), [
    "get",
    "paginate",
    "readOrganizationSnapshot",
  ]);
  const repo = await adapter.get({
    path: "/repos/{owner}/{repo}",
    parameters: { owner: "example-org", repo: "example-app" },
    schema: githubRepositoryResponseSchema,
  });
  assert.equal(repo.name, "example-app");
  assert.equal(calls[0].route, "GET /repos/{owner}/{repo}");
  await assert.rejects(
    adapter.get({
      path: "DELETE /repos/x/y",
      schema: githubRepositoryResponseSchema,
    }),
    /path/i,
  );
});

test("GitHub pagina por iterator oficial e recusa identidade duplicada", async () => {
  const adapter = createGithubAdapter({
    request: async () => ({ data: {} }),
    paginateIterator: async function* () {
      yield {
        data: [{ name: "one", archived: false, has_issues: true, fork: false }],
      };
      yield {
        data: [{ name: "one", archived: false, has_issues: true, fork: false }],
      };
    },
    repositoryInventory: [],
  });
  await assert.rejects(
    adapter.paginate({
      path: "/orgs/{org}/repos",
      parameters: { org: "example-org" },
      itemSchema: githubRepositoryResponseSchema,
      identity: (repo) => repo.name.toLowerCase(),
    }),
    /duplicada/i,
  );
});

test("GitHub exclui somente linkbacks nativos e normaliza comments e pulls sem suposicoes", async () => {
  const adapter = createGithubAdapter({
    request: async () => ({ data: {} }),
    paginateIterator: async function* (route) {
      if (route === "GET /repos/{owner}/{repo}/issues") {
        yield {
          data: [
            {
              number: 7,
              node_id: "I_kwDOBoundaryIssue7",
              state: "open",
              state_reason: null,
              created_at: "2030-01-02T02:00:00.000Z",
              updated_at: "2030-01-02T03:40:00.000Z",
            },
          ],
        };
        return;
      }
      if (
        route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments"
      ) {
        yield {
          data: [
            {
              id: 1,
              node_id: "IC_linkback_code",
              body: "  <!-- linear-linkback -->\n<a>APP-7</a>",
              user: { login: "linear-code[bot]" },
              created_at: "2030-01-02T03:00:00.000Z",
              updated_at: "2030-01-02T03:00:00.000Z",
            },
            {
              id: 2,
              node_id: "IC_linkback_linear",
              body: "<!-- linear-linkback -->\n<a>APP-7</a>",
              user: { login: "linear[bot]" },
              created_at: "2030-01-02T03:01:00.000Z",
              updated_at: "2030-01-02T03:01:00.000Z",
            },
            {
              id: 3,
              node_id: "IC_human_marker",
              body: "<!-- linear-linkback --> user-authored text",
              user: { login: "human" },
              created_at: "2030-01-02T03:02:00.000Z",
              updated_at: "2030-01-02T03:02:00.000Z",
            },
            {
              id: 4,
              node_id: "IC_bot_without_marker",
              body: "ordinary bot comment",
              user: { login: "linear-code[bot]" },
              created_at: "2030-01-02T03:03:00.000Z",
              updated_at: "2030-01-02T03:03:00.000Z",
            },
          ],
        };
        return;
      }
      if (route === "GET /repos/{owner}/{repo}/pulls") {
        yield {
          data: [
            {
              number: 8,
              created_at: "2030-01-02T02:00:00.000Z",
              updated_at: "2030-01-02T03:40:00.000Z",
              merged_at: "2030-01-02T03:30:00.000Z",
              merge_commit_sha: "a".repeat(40),
            },
          ],
        };
        return;
      }
      throw new Error(`rota inesperada: ${route}`);
    },
    repositoryInventory: [
      {
        id: 101,
        name: "example-app",
        archived: false,
        has_issues: true,
        fork: false,
      },
    ],
  });

  const snapshot = await adapter.readOrganizationSnapshot({
    organization: "example-org",
    capturedAt: "2030-01-02T04:00:00.000Z",
  });
  assert.equal(snapshot.complete, true);
  assert.deepEqual(
    snapshot.issues[0].comments.map((comment) => comment.id),
    ["IC_human_marker", "IC_bot_without_marker"],
  );
  assert.equal("syncExpected" in snapshot.issues[0].comments[0], false);
  assert.equal("pipelineKey" in snapshot.pulls[0], false);
});

function syntheticLinearClient({
  team,
  issue,
  issues = [issue],
  projects = [],
  releasePipelines = [],
  releases = [],
  issueToReleases = [],
}) {
  return {
    teams: async () =>
      pagedConnection([[{ updatedAt: "2030-01-02T03:00:00.000Z", ...team }]]),
    issues: async () => pagedConnection([issues]),
    cycles: async () => emptyConnection(),
    projects: async () =>
      pagedConnection([
        projects.map((project) => ({
          updatedAt: "2030-01-02T03:00:00.000Z",
          ...project,
        })),
      ]),
    initiatives: async () => emptyConnection(),
    documents: async () => emptyConnection(),
    releasePipelines: async () => pagedConnection([releasePipelines]),
    releases: async () => pagedConnection([releases]),
    issueToReleases: async () => pagedConnection([issueToReleases]),
  };
}

function syntheticIssue(overrides = {}) {
  const githubUrl = "https://github.com/example-org/example-app/issues/7";
  return {
    id: "issue-7",
    identifier: "APP-7",
    title: "Synthetic issue",
    description: "Synthetic detailed scope for one deterministic issue.",
    updatedAt: "2030-01-02T03:04:05.000Z",
    syncedWith: [
      {
        service: "github",
        id: "issue-node-7",
        metadata: { owner: "example-org", repo: "example-app", number: 7 },
      },
    ],
    team: { id: "team-app", key: "APP", name: "App" },
    state: { id: "state-1", type: "started", name: "Started" },
    duplicateOf: null,
    attachments: async () =>
      pagedConnection([
        [{ id: "attachment-1", title: "GitHub", url: githubUrl }],
      ]),
    comments: async () =>
      pagedConnection([
        [
          {
            id: "linear-comment-1",
            body: "Synthetic synchronized comment.",
            createdAt: "2030-01-02T03:05:00.000Z",
            updatedAt: "2030-01-02T03:05:00.000Z",
            syncedWith: [{ service: "github", id: "github-comment-node-1" }],
            externalThread: {
              id: "provider-specific-thread-id",
              url: githubUrl,
              isConnected: true,
            },
          },
          {
            id: "linear-comment-2",
            body: "Synthetic local comment.",
            createdAt: "2030-01-02T03:06:00.000Z",
            updatedAt: "2030-01-02T03:06:00.000Z",
            syncedWith: [],
            externalThread: {
              id: "jira-thread",
              url: "https://example.invalid/tickets/8",
              isConnected: true,
            },
          },
          {
            id: "linear-comment-anchor",
            body: "This comment thread is synced to a corresponding [GitHub issue](https://github.com/example-org/example-app/issues/7). All replies are shared in both locations.",
            createdAt: "2030-01-02T03:07:00.000Z",
            updatedAt: "2030-01-02T03:07:00.000Z",
            syncedWith: [],
            externalThread: {
              id: "github-anchor-thread",
              type: "integration",
              subType: "github",
              url: githubUrl,
              isConnected: true,
            },
            botActor: {
              id: "github-bot",
              type: "integration",
              subType: "github",
            },
            externalUser: null,
            parentId: null,
          },
        ],
      ]),
    relations: async () => emptyConnection(),
    inverseRelations: async () => emptyConnection(),
    releases: async () => emptyConnection(),
    ...overrides,
  };
}

function syntheticBareIssue({ id, identifier, ...overrides }) {
  return syntheticIssue({
    id,
    identifier,
    title: `Escopo informativo ${identifier}`,
    description: `Descrição suficientemente informativa para ${identifier}.`,
    syncedWith: [],
    duplicateOf: null,
    attachments: async () => emptyConnection(),
    comments: async () => emptyConnection(),
    relations: async () => emptyConnection(),
    inverseRelations: async () => emptyConnection(),
    releases: async () => emptyConnection(),
    ...overrides,
  });
}

test("Linear normaliza somente provenance GitHub e usa a chave do recurso como thread", async () => {
  const team = {
    id: "team-app",
    key: "APP",
    name: "App",
    archivedAt: null,
    retiredAt: null,
  };
  const adapter = createLinearAdapter({
    apiKey: "linear-test-token",
    clientFactory: () =>
      syntheticLinearClient({ team, issue: syntheticIssue() }),
  });
  const snapshot = await adapter.readWorkspaceSnapshot({
    capturedAt: "2030-01-02T04:00:00.000Z",
  });
  assert.equal(snapshot.complete, true);
  assert.deepEqual(snapshot.issues[0].comments, [
    {
      id: "linear-comment-1",
      provenance: "github",
      resourceKey: "example-org/example-app#7",
      externalId: "github-comment-node-1",
      threadId: "example-org/example-app#7",
      connected: true,
      createdAtMs: 1893553500000,
      updatedAtMs: 1893553500000,
    },
    {
      id: "linear-comment-2",
      provenance: "linear",
      resourceKey: null,
      externalId: null,
      threadId: null,
      connected: true,
      createdAtMs: 1893553560000,
      updatedAtMs: 1893553560000,
    },
  ]);
});

test("Linear separa evidencias nativas, attachments seguros, links inseguros e releases completas", async () => {
  const team = {
    id: "team-app",
    key: "APP",
    name: "App",
    archivedAt: null,
    retiredAt: null,
  };
  const issue = syntheticIssue({
    title: "Falha determinística no login administrativo",
    description:
      "O login administrativo falha de forma reproduzível depois da rotação de credenciais.",
    attachments: async () =>
      pagedConnection([
        [
          {
            id: "attachment-secure-issue",
            title: "GitHub issue",
            url: "https://github.com/example-org/example-app/issues/8",
          },
          {
            id: "attachment-secure-pull",
            title: "GitHub pull",
            url: "https://github.com/example-org/example-app/pull/9",
          },
          {
            id: "attachment-insecure-issue",
            title: "GitHub issue insegura",
            url: "http://github.com/example-org/example-app/issues/10",
          },
          {
            id: "attachment-insecure-pull",
            title: "GitHub pull inseguro",
            url: "http://github.com/example-org/example-app/pull/11",
          },
          {
            id: "attachment-noncanonical-port",
            title: "GitHub issue em porta não canônica",
            url: "https://github.com:444/example-org/example-app/issues/12",
          },
        ],
      ]),
  });
  const pipelineId = "123e4567-e89b-42d3-a456-426614174000";
  const releasePipelines = [
    {
      id: pipelineId,
      type: "continuous",
      createdAt: "2030-01-02T03:00:00.000Z",
      updatedAt: "2030-01-02T03:00:00.000Z",
    },
  ];
  const releases = [
    {
      id: "release-planned-with-sha",
      pipelineId,
      commitSha: "b".repeat(40),
      completedAt: null,
      createdAt: "2030-01-02T03:00:00.000Z",
      updatedAt: "2030-01-02T03:00:00.000Z",
    },
    {
      id: "release-completed-without-sha",
      pipelineId,
      commitSha: null,
      completedAt: "2030-01-02T03:10:00.000Z",
      createdAt: "2030-01-02T03:00:00.000Z",
      updatedAt: "2030-01-02T03:10:00.000Z",
    },
    {
      id: "release-complete",
      pipelineId,
      commitSha: "c".repeat(40),
      completedAt: "2030-01-02T03:20:00.000Z",
      createdAt: "2030-01-02T03:00:00.000Z",
      updatedAt: "2030-01-02T03:20:00.000Z",
    },
  ];
  const issueToReleases = releases.map((release, index) => ({
    id: `issue-release-${index + 1}`,
    issueId: "issue-7",
    releaseId: release.id,
    createdAt: "2030-01-02T03:00:00.000Z",
    updatedAt: "2030-01-02T03:20:00.000Z",
  }));
  const adapter = createLinearAdapter({
    apiKey: "linear-test-token",
    clientFactory: () =>
      syntheticLinearClient({
        team,
        issue,
        releasePipelines,
        releases,
        issueToReleases,
      }),
  });

  const snapshot = await adapter.readWorkspaceSnapshot({
    capturedAt: "2030-01-02T04:00:00.000Z",
  });
  assert.equal(snapshot.complete, true);
  const normalized = snapshot.issues[0];
  assert.deepEqual(normalized.nativeCounterpartKeys, [
    "example-org/example-app#7",
  ]);
  assert.deepEqual(normalized.attachmentIssueKeys, [
    "example-org/example-app#8",
  ]);
  assert.deepEqual(normalized.carrierPullKeys, ["example-org/example-app#9"]);
  assert.deepEqual(normalized.insecureGithubResourceKeys, [
    "example-org/example-app#10",
    "example-org/example-app#11",
    "example-org/example-app#12",
  ]);
  assert.equal("counterpartKeys" in normalized, false);
  assert.equal("attachmentKeys" in normalized, false);
  assert.deepEqual(normalized.releases, [
    {
      id: "release-complete",
      pipelineId: "123e4567-e89b-42d3-a456-426614174000",
      pipelineType: "continuous",
      commitSha: "c".repeat(40),
      completedAtMs: 1893554400000,
      updatedAtMs: 1893554400000,
      issueToReleaseId: "issue-release-3",
      issueToReleaseUpdatedAtMs: 1893554400000,
    },
    {
      id: "release-planned-with-sha",
      pipelineId: "123e4567-e89b-42d3-a456-426614174000",
      pipelineType: "continuous",
      commitSha: "b".repeat(40),
      completedAtMs: null,
      updatedAtMs: 1893553200000,
      issueToReleaseId: "issue-release-1",
      issueToReleaseUpdatedAtMs: 1893554400000,
    },
  ]);
  assert.match(normalized.duplicateKey, /^exact:[0-9a-f]{64}$/u);
  assert.ok(
    normalized.similarityKeys.every((signal) =>
      /^(?:description|title-tokens):[0-9a-f]{64}$/u.test(signal),
    ),
  );
  assert.equal(
    JSON.stringify([
      normalized.duplicateKey,
      ...normalized.similarityKeys,
    ]).includes("login administrativo"),
    false,
  );
});

test("Linear falha fechado quando entidades nativas duplicam identidade ou recurso", async () => {
  const team = {
    id: "team-app",
    key: "APP",
    name: "App",
    archivedAt: null,
    retiredAt: null,
  };
  const cases = [
    [
      {
        service: "github",
        id: "same-external-id",
        metadata: { owner: "example-org", repo: "example-app", number: 7 },
      },
      {
        service: "github",
        id: "same-external-id",
        metadata: { owner: "example-org", repo: "example-app", number: 8 },
      },
    ],
    [
      {
        service: "github",
        id: "external-id-1",
        metadata: { owner: "example-org", repo: "example-app", number: 7 },
      },
      {
        service: "github",
        id: "external-id-2",
        metadata: { owner: "example-org", repo: "example-app", number: 7 },
      },
    ],
  ];
  for (const syncedWith of cases) {
    const adapter = createLinearAdapter({
      apiKey: "linear-test-token",
      clientFactory: () =>
        syntheticLinearClient({
          team,
          issue: syntheticIssue({ syncedWith }),
        }),
    });
    const snapshot = await adapter.readWorkspaceSnapshot({
      capturedAt: "2030-01-02T04:00:00.000Z",
    });
    assert.equal(snapshot.complete, false);
    assert.equal(snapshot.failures[0].code, "boundary_invalid");
  }
});

test("Linear aceita project sem teams e limita exact title-only a titulo informativo", async () => {
  const team = {
    id: "team-app",
    key: "APP",
    name: "App",
    archivedAt: null,
    retiredAt: null,
  };
  const informative = syntheticBareIssue({
    id: "issue-informative",
    identifier: "APP-20",
    title: "Falha determinística no login administrativo",
    description: null,
  });
  const generic = syntheticBareIssue({
    id: "issue-generic",
    identifier: "APP-21",
    title: "Bug",
    description: null,
  });
  const project = {
    id: "project-without-teams",
    teams: async () => emptyConnection(),
  };
  const adapter = createLinearAdapter({
    apiKey: "linear-test-token",
    clientFactory: () =>
      syntheticLinearClient({
        team,
        issue: informative,
        issues: [informative, generic],
        projects: [project],
      }),
  });

  const snapshot = await adapter.readWorkspaceSnapshot({
    capturedAt: "2030-01-02T04:00:00.000Z",
  });
  assert.equal(snapshot.complete, true);
  assert.deepEqual(snapshot.projects, []);
  assert.match(snapshot.issues[0].duplicateKey, /^exact:[0-9a-f]{64}$/u);
  assert.equal(snapshot.issues[1].duplicateKey, null);
});

test("Linear preserva lifecycle dos times e duplicateOf autoritativo", async () => {
  const team = {
    id: "team-app",
    key: "APP",
    name: "App",
    archivedAt: "2030-01-02T03:30:00.000Z",
    retiredAt: null,
  };
  const target = syntheticBareIssue({ id: "issue-1", identifier: "APP-1" });
  const issue = syntheticIssue({
    duplicateOf: { id: "issue-1", identifier: "APP-1" },
  });
  const adapter = createLinearAdapter({
    apiKey: "linear-test-token",
    clientFactory: () =>
      syntheticLinearClient({ team, issue, issues: [target, issue] }),
  });
  const snapshot = await adapter.readWorkspaceSnapshot({
    capturedAt: "2030-01-02T04:00:00.000Z",
  });
  assert.equal(snapshot.complete, true);
  assert.deepEqual(snapshot.teams, [
    {
      id: "team-app",
      key: "APP",
      active: false,
      updatedAtMs: 1893553200000,
    },
  ]);
  assert.equal(
    snapshot.issues.find((candidate) => candidate.identifier === "APP-7")
      .duplicateOf,
    "APP-1",
  );
});

test("Linear falha fechado para metadata GitHub ou relação sem ownership", async () => {
  const team = {
    id: "team-app",
    key: "APP",
    name: "App",
    archivedAt: null,
    retiredAt: null,
  };
  const malformedSync = syntheticIssue({
    syncedWith: [{ service: "github", metadata: {} }],
  });
  const badRelation = {
    id: "relation-1",
    type: "duplicate",
    issue: { id: "other-1", identifier: "APP-1" },
    relatedIssue: { id: "other-2", identifier: "APP-2" },
  };
  const malformedRelation = syntheticIssue({
    relations: async () => pagedConnection([[badRelation]]),
  });
  for (const issue of [malformedSync, malformedRelation]) {
    const adapter = createLinearAdapter({
      apiKey: "linear-test-token",
      clientFactory: () => syntheticLinearClient({ team, issue }),
    });
    const snapshot = await adapter.readWorkspaceSnapshot({
      capturedAt: "2030-01-02T04:00:00.000Z",
    });
    assert.equal(snapshot.complete, false);
    assert.equal(snapshot.failures[0].code, "boundary_invalid");
  }
});

test("Linear valida identidade composta, enum de relacao e resolucao global", async () => {
  const team = {
    id: "team-app",
    key: "APP",
    name: "App",
    archivedAt: null,
    retiredAt: null,
  };
  const target = syntheticBareIssue({ id: "issue-2", identifier: "APP-2" });
  const relation = {
    id: "relation-1",
    type: "similar",
    issue: { id: "issue-1", identifier: "APP-1" },
    relatedIssue: { id: "issue-2", identifier: "APP-2" },
  };
  const source = syntheticBareIssue({
    id: "issue-1",
    identifier: "APP-1",
    relations: async () => pagedConnection([[relation]]),
  });
  const adapter = createLinearAdapter({
    apiKey: "linear-test-token",
    clientFactory: () =>
      syntheticLinearClient({ team, issue: source, issues: [source, target] }),
  });
  const valid = await adapter.readWorkspaceSnapshot({
    capturedAt: "2030-01-02T04:00:00.000Z",
  });
  assert.equal(valid.complete, true);
  assert.deepEqual(valid.issues[0].relatedIdentifiers, ["APP-2"]);

  const invalidCases = [
    {
      name: "owner identifier divergente",
      source: syntheticBareIssue({
        id: "issue-1",
        identifier: "APP-1",
        relations: async () =>
          pagedConnection([
            [
              {
                ...relation,
                issue: { id: "issue-1", identifier: "APP-999" },
              },
            ],
          ]),
      }),
    },
    {
      name: "target composto nao resolve",
      source: syntheticBareIssue({
        id: "issue-1",
        identifier: "APP-1",
        relations: async () =>
          pagedConnection([
            [
              {
                ...relation,
                relatedIssue: { id: "issue-2", identifier: "APP-404" },
              },
            ],
          ]),
      }),
    },
    {
      name: "tipo fora do enum",
      source: syntheticBareIssue({
        id: "issue-1",
        identifier: "APP-1",
        relations: async () =>
          pagedConnection([
            [
              {
                ...relation,
                type: "causes",
              },
            ],
          ]),
      }),
    },
    {
      name: "duplicateOf composto nao resolve",
      source: syntheticBareIssue({
        id: "issue-1",
        identifier: "APP-1",
        duplicateOf: { id: "issue-2", identifier: "APP-404" },
      }),
    },
  ];
  for (const scenario of invalidCases) {
    const invalidAdapter = createLinearAdapter({
      apiKey: "linear-test-token",
      clientFactory: () =>
        syntheticLinearClient({
          team,
          issue: scenario.source,
          issues: [scenario.source, target],
        }),
    });
    const invalid = await invalidAdapter.readWorkspaceSnapshot({
      capturedAt: "2030-01-02T04:00:00.000Z",
    });
    assert.equal(invalid.complete, false, scenario.name);
    assert.equal(invalid.failures[0].code, "boundary_invalid", scenario.name);
  }
});

test("CLI runtime carrega exatamente as interfaces oficiais integradas", async () => {
  const runtime = await loadRuntimeDependencies();
  for (const name of [
    "loadConfig",
    "readLinearSnapshot",
    "readGithubSnapshot",
    "evaluate",
    "determineExitCode",
    "writeLocalReport",
  ]) {
    assert.equal(typeof runtime[name], "function", name);
  }
});
