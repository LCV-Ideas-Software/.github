import assert from "node:assert/strict";
import test from "node:test";

import { createLinearAdapter } from "../src/adapters/linear.mjs";
import {
  buildGithubResourceKey,
  parseGithubRepository,
  parseGithubResourceKey,
  parseGithubResourceUrl,
} from "../src/domain/github-resource.mjs";

const CAPTURED_AT = "2030-01-02T04:00:00.000Z";
const PIPELINE_ID = "123e4567-e89b-42d3-a456-426614174000";

function connection(nodes = []) {
  return {
    nodes,
    pageInfo: { hasNextPage: false, endCursor: null },
  };
}

function team(overrides = {}) {
  return {
    id: "team-github",
    key: "EXAMPLE",
    name: ".github",
    archivedAt: null,
    retiredAt: null,
    updatedAt: "2030-01-02T03:00:00.000Z",
    ...overrides,
  };
}

function comment(overrides = {}) {
  return {
    id: "linear-comment-1",
    body: "Conteudo sem papel identitario.",
    createdAt: "2030-01-02T03:05:00.000Z",
    updatedAt: "2030-01-02T03:06:00.000Z",
    syncedWith: [],
    externalThread: null,
    botActor: null,
    userId: null,
    user: null,
    externalUserId: null,
    externalUser: null,
    parentId: null,
    ...overrides,
  };
}

function issue(overrides = {}) {
  return {
    id: "linear-issue-7",
    identifier: "EXAMPLE-7",
    title: "Reconciliar identidade do repositorio especial",
    description:
      "Descricao suficientemente informativa para o contrato de teste.",
    updatedAt: "2030-01-02T03:04:00.000Z",
    syncedWith: [
      {
        service: "github",
        id: "github-issue-node-7",
        metadata: { owner: "example-org", repo: ".github", number: 7 },
      },
    ],
    team: team(),
    state: { id: "state-started", name: "Started", type: "started" },
    duplicateOf: null,
    attachments: async () => connection(),
    comments: async () => connection(),
    relations: async () => connection(),
    inverseRelations: async () => connection(),
    ...overrides,
  };
}

function client(overrides = {}) {
  return {
    teams: async () => connection([team()]),
    issues: async () => connection([issue()]),
    cycles: async () => connection(),
    projects: async () => connection(),
    initiatives: async () => connection(),
    documents: async () => connection(),
    releasePipelines: async () => connection(),
    releases: async () => connection(),
    issueToReleases: async () => connection(),
    ...overrides,
  };
}

async function snapshot(clientOverrides = {}) {
  const adapter = createLinearAdapter({
    apiKey: "linear-read-token-for-test",
    clientFactory: () => client(clientOverrides),
  });
  return adapter.readWorkspaceSnapshot({ capturedAt: CAPTURED_AT });
}

function githubControl(overrides = {}) {
  return comment({
    botActor: {
      id: null,
      type: "integration",
      subType: "github",
      userDisplayName: null,
    },
    externalThread: {
      id: null,
      type: "integration",
      subType: "github",
      isConnected: false,
      isPersonalIntegrationRequired: true,
      isPersonalIntegrationConnected: false,
      url: null,
    },
    ...overrides,
  });
}

test("recurso GitHub compartilha uma gramatica sem ambiguidades", () => {
  for (const repository of [".github", ".github-private", "repo_a.b-c"]) {
    assert.equal(parseGithubRepository(repository), repository);
    const key = buildGithubResourceKey({
      owner: "Example-Org",
      repository,
      number: "7",
    });
    assert.equal(key, `example-org/${repository}#7`);
    assert.equal(parseGithubResourceKey(key)?.key, key);
  }
  for (const repository of [".", "..", "a/b", "a\\b", " a", "a ", "a%2fb"]) {
    assert.equal(parseGithubRepository(repository), null, repository);
  }
  for (const number of [0, -1, "0", "01", "9007199254740992"]) {
    assert.equal(
      buildGithubResourceKey({
        owner: "example-org",
        repository: ".github",
        number,
      }),
      null,
      String(number),
    );
  }
  assert.equal(
    parseGithubResourceUrl(
      "https://github.com/example-org/.github/issues/7#issuecomment-1",
      { role: "external-thread" },
    )?.key,
    "example-org/.github#7",
  );
  assert.equal(
    parseGithubResourceUrl(
      "https://github.com/example-org/.github/issues/7#issuecomment-1",
      { role: "attachment" },
    )?.secure,
    false,
  );
  for (const ambiguousUrl of [
    "https://github.com/example-org/.github/issues/7/../8",
    "https://github.com/example-org/%2egithub/issues/7",
    "https://github.com/example-org/.github/issues%2f7",
    "https://github.com/example-org/.github\\issues\\7",
    "https://github.com/example-org/.git hub/issues/7",
  ]) {
    assert.equal(
      parseGithubResourceUrl(ambiguousUrl, { role: "external-thread" }),
      null,
      ambiguousUrl,
    );
  }
  assert.equal(
    parseGithubResourceUrl(
      "https://github.com:443/example-org/.github/issues/7",
      { role: "external-thread" },
    )?.secure,
    false,
  );
});

test("gramatica unica preserva .github em metadata, attachments e externalThread", async () => {
  const result = await snapshot({
    issues: async () =>
      connection([
        issue({
          attachments: async () =>
            connection([
              {
                id: "attachment-issue",
                title: "Issue",
                url: "https://github.com/example-org/.github/issues/7",
              },
              {
                id: "attachment-pull",
                title: "Pull request",
                url: "https://github.com/example-org/.github/pull/251",
              },
              {
                id: "attachment-linear-document",
                title: "Documento",
                url: "https://linear.app/example/document/one",
              },
            ]),
          comments: async () =>
            connection([
              githubControl({ id: "control-without-url" }),
              githubControl({
                id: "control-with-dot-repository",
                externalThread: {
                  id: null,
                  type: "integration",
                  subType: "github",
                  isConnected: false,
                  isPersonalIntegrationRequired: true,
                  isPersonalIntegrationConnected: false,
                  url: "https://github.com/example-org/.github/issues/7",
                },
              }),
            ]),
        }),
      ]),
  });

  assert.equal(result.complete, true);
  assert.deepEqual(result.issues[0].nativeCounterpartKeys, [
    "example-org/.github#7",
  ]);
  assert.deepEqual(result.issues[0].attachmentIssueKeys, [
    "example-org/.github#7",
  ]);
  assert.deepEqual(result.issues[0].carrierPullKeys, [
    "example-org/.github#251",
  ]);
  assert.deepEqual(result.issues[0].comments, []);
  assert.deepEqual(result.issues[0].githubThreadControls, [
    {
      linearCommentId: "control-without-url",
      connected: false,
      observedResourceKey: null,
      urlState: "absent",
    },
    {
      linearCommentId: "control-with-dot-repository",
      connected: false,
      observedResourceKey: "example-org/.github#7",
      urlState: "resource",
    },
  ]);
});

test("Comment.syncedWith e a unica identidade externa de comentario", async () => {
  const result = await snapshot({
    issues: async () =>
      connection([
        issue({
          comments: async () =>
            connection([
              comment({
                syncedWith: [
                  { service: "github", id: "github-comment-node-1" },
                ],
                externalThread: {
                  id: "thread-id-is-not-comment-id",
                  type: "integration",
                  subType: "github",
                  isConnected: true,
                  isPersonalIntegrationRequired: true,
                  isPersonalIntegrationConnected: true,
                  url: "https://github.com/example-org/.github/issues/7",
                },
              }),
            ]),
        }),
      ]),
  });

  assert.equal(result.complete, true);
  assert.deepEqual(result.issues[0].comments, [
    {
      id: "linear-comment-1",
      provenance: "github",
      resourceKey: "example-org/.github#7",
      externalId: "github-comment-node-1",
      threadId: "example-org/.github#7",
      connected: true,
      createdAtMs: Date.parse("2030-01-02T03:05:00.000Z"),
      updatedAtMs: Date.parse("2030-01-02T03:06:00.000Z"),
    },
  ]);
});

test("comentario humano retransmitido nao e removido nem ganha identidade por URL", async () => {
  const relayedComment = githubControl({
    id: "human-relayed-comment",
    botActor: {
      id: "github-integration",
      type: "integration",
      subType: "github",
      userDisplayName: "Pessoa no GitHub",
    },
    externalThread: {
      id: null,
      type: "integration",
      subType: "github",
      isConnected: true,
      isPersonalIntegrationRequired: true,
      isPersonalIntegrationConnected: true,
      url: "https://github.com/example-org/.github/issues/7",
    },
  });
  for (const property of ["user", "externalUser"]) {
    Object.defineProperty(relayedComment, property, {
      configurable: true,
      get() {
        throw new Error(`${property} getter nao deve ser consultado`);
      },
    });
  }
  const result = await snapshot({
    issues: async () =>
      connection([
        issue({
          comments: async () => connection([relayedComment]),
        }),
      ]),
  });

  assert.equal(result.complete, true);
  assert.deepEqual(result.issues[0].githubThreadControls, []);
  assert.equal(result.issues[0].comments.length, 1);
  assert.equal(result.issues[0].comments[0].provenance, "linear");
  assert.equal(result.issues[0].comments[0].externalId, null);
  assert.equal(result.issues[0].comments[0].resourceKey, null);
});

test("adapter preserva controles conectados para policy downstream", async () => {
  const candidates = [
    issue({
      syncedWith: [],
      comments: async () =>
        connection([
          githubControl({
            externalThread: {
              id: null,
              type: "integration",
              subType: "github",
              isConnected: true,
              isPersonalIntegrationRequired: true,
              isPersonalIntegrationConnected: true,
              url: "https://github.com/example-org/.github/issues/7",
            },
          }),
        ]),
    }),
    issue({
      comments: async () =>
        connection([
          githubControl({
            externalThread: {
              id: null,
              type: "integration",
              subType: "github",
              isConnected: true,
              isPersonalIntegrationRequired: true,
              isPersonalIntegrationConnected: true,
              url: "https://github.com/example-org/.github-private/issues/7",
            },
          }),
        ]),
    }),
  ];
  for (const candidate of candidates) {
    const result = await snapshot({
      issues: async () => connection([candidate]),
    });
    assert.equal(result.complete, true);
    assert.equal(result.issues[0].comments.length, 0);
    assert.equal(result.issues[0].githubThreadControls.length, 1);
    assert.equal(result.issues[0].githubThreadControls[0].connected, true);
    assert.equal(result.issues[0].githubThreadControls[0].urlState, "resource");
  }
});

test("attachment GitHub nao reconhecido falha fechado em vez de ser descartado", async () => {
  for (const sourceType of ["github", undefined]) {
    const result = await snapshot({
      issues: async () =>
        connection([
          issue({
            attachments: async () =>
              connection([
                {
                  id: `attachment-invalid-${sourceType ?? "host"}`,
                  title: "GitHub path fora do contrato",
                  url: "https://github.com/example-org/.github/actions",
                  ...(sourceType === undefined ? {} : { sourceType }),
                },
              ]),
          }),
        ]),
    });

    assert.equal(result.complete, false);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].scope, "issues[0].attachments[0]");
    assert.deepEqual(result.issues, []);
  }
});

test("duas entidades invalidas acumulam duas failures redigidas e nenhum dado parcial", async () => {
  const calls = [];
  const invalidIssue = (id, identifier, repo) =>
    issue({
      id,
      identifier,
      syncedWith: [
        {
          service: "github",
          id: `external-${id}`,
          metadata: { owner: "example-org", repo, number: 7 },
        },
      ],
    });
  const result = await snapshot({
    issues: async () =>
      connection([
        invalidIssue("raw-secret-id-one", "SECRET-1", "."),
        invalidIssue("raw-secret-id-two", "SECRET-2", ".."),
      ]),
    cycles: async () => {
      calls.push("cycles");
      return connection();
    },
    projects: async () => {
      calls.push("projects");
      return connection();
    },
    initiatives: async () => {
      calls.push("initiatives");
      return connection();
    },
    documents: async () => {
      calls.push("documents");
      return connection();
    },
    releasePipelines: async () => {
      calls.push("releasePipelines");
      return connection([
        {
          id: PIPELINE_ID,
          type: "continuous",
          createdAt: "2030-01-02T03:00:00.000Z",
          updatedAt: "2030-01-02T03:00:00.000Z",
        },
      ]);
    },
  });

  assert.equal(result.complete, false);
  assert.deepEqual(
    result.failures.map(({ source, code, scope, message }) => ({
      source,
      code,
      scope,
      message,
    })),
    [
      {
        source: "linear",
        code: "boundary_invalid",
        scope: "issues[0]",
        message: "issues[0]: entidade invalida",
      },
      {
        source: "linear",
        code: "boundary_invalid",
        scope: "issues[1]",
        message: "issues[1]: entidade invalida",
      },
    ],
  );
  assert.deepEqual(calls, ["cycles", "projects", "initiatives", "documents"]);
  for (const collection of [
    "teams",
    "issues",
    "cycles",
    "projects",
    "initiatives",
    "documents",
    "releasePipelines",
    "releases",
    "issueToReleases",
  ]) {
    assert.deepEqual(result[collection], [], collection);
  }
  assert.doesNotMatch(
    JSON.stringify(result.failures),
    /SECRET|raw-secret|external-/u,
  );
});

test("paginacao estrutural invalida aborta sem virar census parcial", async () => {
  let laterIssueRead = false;
  const result = await snapshot({
    issues: async () =>
      connection([
        issue({
          comments: async () => ({
            nodes: [comment()],
            pageInfo: null,
          }),
        }),
        issue({
          id: "issue-that-must-not-be-normalized",
          identifier: "EXAMPLE-8",
          comments: async () => {
            laterIssueRead = true;
            return connection();
          },
        }),
      ]),
  });

  assert.equal(result.complete, false);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].scope, "issues[0].comments");
  assert.match(result.failures[0].message, /pageInfo invalido/u);
  assert.equal(laterIssueRead, false);
  assert.deepEqual(result.issues, []);
});
