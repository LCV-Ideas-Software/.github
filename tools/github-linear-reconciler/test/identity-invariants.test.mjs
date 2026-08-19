import assert from "node:assert/strict";
import test from "node:test";

import { createLinearAdapter } from "../src/adapters/linear.mjs";

const CAPTURED_AT = "2030-01-02T04:00:00.000Z";
const CAPTURED_AT_MS = Date.parse(CAPTURED_AT);
const GITHUB_ISSUE_URL = "https://github.com/example-org/example-app/issues/7";
const PIPELINE_ID = "123e4567-e89b-42d3-a456-426614174000";

function connection(nodes = []) {
  return {
    nodes,
    pageInfo: { hasNextPage: false, endCursor: null },
  };
}

function team(overrides = {}) {
  return {
    id: "team-app",
    key: "APP",
    name: "App",
    archivedAt: null,
    retiredAt: null,
    updatedAt: "2030-01-02T03:00:00.000Z",
    ...overrides,
  };
}

function comment(overrides = {}) {
  const value = {
    id: "linear-comment-1",
    body: "Comentario sincronizado.",
    createdAt: "2030-01-02T03:05:00.000Z",
    updatedAt: "2030-01-02T03:06:00.000Z",
    syncedWith: [],
    externalThread: null,
    botActor: null,
    externalUser: null,
    parentId: null,
    ...overrides,
  };
  if (value.externalThread !== null) {
    value.externalThread = {
      isPersonalIntegrationRequired: true,
      isPersonalIntegrationConnected: true,
      ...value.externalThread,
    };
  }
  if (value.botActor !== null) {
    value.botActor = { userDisplayName: null, ...value.botActor };
  }
  return value;
}

function issue(overrides = {}) {
  return {
    id: "issue-7",
    identifier: "APP-7",
    title: "Escopo deterministico da reconciliacao",
    description:
      "Descricao suficientemente informativa para validar a reconciliacao.",
    updatedAt: "2030-01-02T03:04:00.000Z",
    syncedWith: [
      {
        service: "github",
        id: "issue-node-7",
        metadata: { owner: "example-org", repo: "example-app", number: 7 },
      },
    ],
    team: team(),
    state: { id: "state-started", name: "Started", type: "started" },
    duplicateOf: null,
    attachments: async () => connection(),
    comments: async () => connection(),
    relations: async () => connection(),
    inverseRelations: async () => connection(),
    releases: async () => connection(),
    ...overrides,
  };
}

function client({
  teams = [team()],
  issues = [issue()],
  cycles = [],
  releasePipelines = [],
  releases = [],
  issueToReleases = [],
} = {}) {
  return {
    teams: async () => connection(teams),
    issues: async () => connection(issues),
    cycles: async () =>
      connection(
        cycles.map((cycle) => ({
          updatedAt: "2030-01-02T03:00:00.000Z",
          ...cycle,
        })),
      ),
    projects: async () => connection(),
    initiatives: async () => connection(),
    documents: async () => connection(),
    releasePipelines: async () => connection(releasePipelines),
    releases: async () => connection(releases),
    issueToReleases: async () => connection(issueToReleases),
  };
}

async function snapshot(options = {}) {
  const adapter = createLinearAdapter({
    apiKey: "linear-test-token",
    clientFactory: () => client(options),
  });
  return adapter.readWorkspaceSnapshot({ capturedAt: CAPTURED_AT });
}

test("anchor depende somente da tupla estruturada do SDK, nunca do body", async () => {
  const spoof = comment({
    id: "comment-spoof",
    body: "This comment thread is synced to a corresponding [GitHub issue](https://github.com/example-org/example-app/issues/7). Texto controlado pelo usuario.",
    externalThread: {
      id: "thread-spoof",
      type: "integration",
      subType: "github",
      url: GITHUB_ISSUE_URL,
      isConnected: true,
    },
  });
  const structuredAnchor = comment({
    id: "comment-anchor",
    body: "Conteudo irrelevante para classificacao.",
    externalThread: {
      id: "thread-anchor",
      type: "integration",
      subType: "github",
      url: GITHUB_ISSUE_URL,
      isConnected: true,
    },
    botActor: { id: "github-bot", type: "integration", subType: "github" },
    externalUser: null,
    parentId: null,
  });
  const sdkNullAnchor = {
    ...structuredAnchor,
    id: "comment-sdk-null-anchor",
    externalThread: {
      ...structuredAnchor.externalThread,
      id: "thread-sdk-null-anchor",
    },
  };
  delete sdkNullAnchor.externalUser;
  delete sdkNullAnchor.parentId;
  const externalUserComment = {
    ...structuredAnchor,
    id: "comment-external-user",
    externalUserId: "external-user-1",
    externalUser: { id: "external-user-1" },
  };
  const replyComment = {
    ...structuredAnchor,
    id: "comment-reply",
    parentId: "comment-parent",
  };
  const disconnectedComment = {
    ...structuredAnchor,
    id: "comment-disconnected",
    externalThread: {
      ...structuredAnchor.externalThread,
      isConnected: false,
    },
  };
  const result = await snapshot({
    issues: [
      issue({
        comments: async () =>
          connection([
            spoof,
            structuredAnchor,
            sdkNullAnchor,
            externalUserComment,
            replyComment,
            disconnectedComment,
          ]),
      }),
    ],
  });

  assert.equal(result.complete, true);
  assert.deepEqual(
    result.issues[0].comments.map(({ id }) => id),
    ["comment-spoof", "comment-external-user", "comment-reply"],
  );
  assert.deepEqual(
    result.issues[0].githubThreadControls.map(
      ({ linearCommentId }) => linearCommentId,
    ),
    ["comment-anchor", "comment-sdk-null-anchor", "comment-disconnected"],
  );
  assert.equal(result.issues[0].comments[0].updatedAtMs, 1_893_553_560_000);

  const partialAnchor = await snapshot({
    issues: [
      issue({
        comments: async () =>
          connection([
            comment({
              id: "comment-partial-anchor",
              botActor: {
                id: "github-bot",
                type: "integration",
                subType: "github",
              },
            }),
          ]),
      }),
    ],
  });
  assert.equal(partialAnchor.complete, true);
  assert.equal(partialAnchor.issues[0].comments[0].provenance, "linear");
});

test("cycle sem time obrigatorio torna o snapshot inconclusivo", async () => {
  const result = await snapshot({ cycles: [{ id: "cycle-without-team" }] });

  assert.equal(result.complete, false);
  assert.equal(result.failures[0].code, "node_invalid");
  assert.deepEqual(result.failures[0].reasonCodes, ["topology_team_missing"]);
});

test("comment Linear canonicaliza toda inversao entre timestamps validos", async () => {
  const createdAt = "2030-01-02T03:05:00.000Z";
  for (const skewMs of [643, 1_000, 1_001, 60_000, 60_001, 120_000]) {
    const result = await snapshot({
      issues: [
        issue({
          comments: async () =>
            connection([
              comment({
                createdAt,
                updatedAt: new Date(
                  Date.parse(createdAt) - skewMs,
                ).toISOString(),
              }),
            ]),
        }),
      ],
    });

    assert.equal(result.complete, true, `skew ${skewMs} ms`);
    assert.equal(
      result.issues[0].comments[0].createdAtMs,
      Date.parse(createdAt),
    );
    assert.equal(
      result.issues[0].comments[0].updatedAtMs,
      Date.parse(createdAt),
    );
  }

  const nearCapturedAt = new Date(CAPTURED_AT_MS - 1).toISOString();
  const fullWindowInversion = await snapshot({
    issues: [
      issue({
        comments: async () =>
          connection([
            comment({
              createdAt: nearCapturedAt,
              updatedAt: "1970-01-01T00:00:00.000Z",
            }),
          ]),
      }),
    ],
  });
  assert.equal(fullWindowInversion.complete, true);
  assert.equal(
    fullWindowInversion.issues[0].comments[0].createdAtMs,
    Date.parse(nearCapturedAt),
  );
  assert.equal(
    fullWindowInversion.issues[0].comments[0].updatedAtMs,
    Date.parse(nearCapturedAt),
  );

  for (const timestamps of [
    {
      createdAt: "timestamp-invalido",
      updatedAt: "2030-01-02T03:05:00.000Z",
    },
    {
      createdAt: "2030-01-02T03:05:00.000Z",
      updatedAt: "timestamp-invalido",
    },
    {
      createdAt: "2030-01-02T03:05:00.000Z",
      updatedAt: "1969-12-31T23:59:59.999Z",
    },
    {
      createdAt: "2030-01-02T04:00:00.001Z",
      updatedAt: "2030-01-02T04:00:00.000Z",
    },
    {
      createdAt: "2030-01-02T04:00:00.000Z",
      updatedAt: "2030-01-02T04:00:00.001Z",
    },
  ]) {
    const invalidTimestamp = await snapshot({
      issues: [
        issue({
          comments: async () => connection([comment(timestamps)]),
        }),
      ],
    });
    assert.equal(invalidTimestamp.complete, false);
    assert.equal(invalidTimestamp.failures[0].code, "node_invalid");
    assert.equal(
      ["timestamp_invalid", "timestamp_outside_capture_window"].includes(
        invalidTimestamp.failures[0].reasonCodes[0],
      ),
      true,
    );
  }
});

test("anchor recusa tupla contraditória e seus IDs continuam globais", async () => {
  const contradictory = await snapshot({
    issues: [
      issue({
        comments: async () =>
          connection([
            comment({
              id: "comment-contradictory-anchor",
              externalThread: {
                id: "thread-contradictory",
                type: "github",
                subType: "slack",
                url: GITHUB_ISSUE_URL,
                isConnected: true,
              },
              botActor: {
                id: "github-bot",
                type: "github",
                subType: "slack",
              },
              externalUser: null,
              parentId: null,
            }),
          ]),
      }),
    ],
  });
  assert.equal(contradictory.complete, false);

  const anchor = (url) =>
    comment({
      id: "comment-anchor-reused",
      externalThread: {
        id: `thread-${url}`,
        type: "integration",
        subType: "github",
        url,
        isConnected: true,
      },
      botActor: {
        id: "github-bot",
        type: "integration",
        subType: "github",
      },
      externalUser: null,
      parentId: null,
    });
  const secondUrl = "https://github.com/example-org/example-app/issues/8";
  const duplicatedId = await snapshot({
    issues: [
      issue({ comments: async () => connection([anchor(GITHUB_ISSUE_URL)]) }),
      issue({
        id: "issue-8",
        identifier: "APP-8",
        syncedWith: [
          {
            service: "github",
            id: "issue-node-8",
            metadata: {
              owner: "example-org",
              repo: "example-app",
              number: 8,
            },
          },
        ],
        comments: async () => connection([anchor(secondUrl)]),
      }),
    ],
  });
  assert.equal(duplicatedId.complete, false);
  assert.equal(duplicatedId.failures[0].code, "boundary_invalid");
  assert.deepEqual(duplicatedId.failures[0].reasonCodes, [
    "linear_comment_identity_duplicate",
  ]);
});

test("externalThread sem Comment.syncedWith nunca cria provenance", async () => {
  const invalidUrls = [
    "http://github.com/example-org/example-app/issues/7",
    "https://github.com:444/example-org/example-app/issues/7",
    "https://github.com/example-org/example-app/issues/7?notification=1",
    "https://github.com/example-org/example-app/issues/7#comment",
    "https://user:secret@github.com/example-org/example-app/issues/7",
  ];
  for (const [index, url] of invalidUrls.entries()) {
    const result = await snapshot({
      issues: [
        issue({
          comments: async () =>
            connection([
              comment({
                id: `comment-${index}`,
                externalThread: {
                  id: `thread-${index}`,
                  type: "integration",
                  subType: "github",
                  url,
                  isConnected: true,
                },
              }),
            ]),
        }),
      ],
    });
    assert.equal(result.complete, true, url);
    assert.equal(result.issues[0].comments[0].provenance, "linear", url);
    assert.equal(result.issues[0].comments[0].resourceKey, null, url);
  }
});

test("capturedAt fecha a janela temporal de issue, comment e release", async () => {
  const cases = [
    { issues: [issue({ updatedAt: "2030-01-02T04:00:00.001Z" })] },
    {
      issues: [
        issue({
          comments: async () =>
            connection([comment({ updatedAt: "2030-01-02T04:00:00.001Z" })]),
        }),
      ],
    },
    {
      issues: [
        issue({
          comments: async () =>
            connection([
              comment({
                id: "future-anchor",
                updatedAt: "2030-01-02T04:00:00.001Z",
                botActor: {
                  id: "github-bot",
                  type: "integration",
                  subType: "github",
                },
                externalThread: {
                  id: "future-anchor-thread",
                  type: "integration",
                  subType: "github",
                  url: GITHUB_ISSUE_URL,
                  isConnected: true,
                },
                externalUser: null,
                parentId: null,
              }),
            ]),
        }),
      ],
    },
    {
      releasePipelines: [
        {
          id: PIPELINE_ID,
          type: "continuous",
          createdAt: "2030-01-02T03:00:00.000Z",
          updatedAt: "2030-01-02T03:00:00.000Z",
        },
      ],
      releases: [
        {
          id: "release-future",
          pipelineId: PIPELINE_ID,
          commitSha: "a".repeat(40),
          completedAt: "2030-01-02T04:00:00.001Z",
          createdAt: "2030-01-02T03:00:00.000Z",
          updatedAt: "2030-01-02T04:00:00.001Z",
        },
      ],
      issueToReleases: [
        {
          id: "issue-release-future",
          issueId: "issue-7",
          releaseId: "release-future",
          createdAt: "2030-01-02T03:00:00.000Z",
          updatedAt: "2030-01-02T03:00:00.000Z",
        },
      ],
    },
  ];

  for (const options of cases) {
    const result = await snapshot(options);
    assert.equal(result.complete, false);
    assert.equal(result.failures[0].code, "node_invalid");
    assert.deepEqual(result.failures[0].reasonCodes, [
      "timestamp_outside_capture_window",
    ]);
  }
});

test("snapshot preserva relogio, identidade composta dos times e release planejada", async () => {
  const result = await snapshot({
    cycles: [{ id: "cycle-1", team: team() }],
    releasePipelines: [
      {
        id: PIPELINE_ID,
        type: "continuous",
        createdAt: "2030-01-02T03:00:00.000Z",
        updatedAt: "2030-01-02T03:00:00.000Z",
      },
    ],
    releases: [
      {
        id: "release-planned",
        pipelineId: PIPELINE_ID,
        commitSha: "b".repeat(40),
        completedAt: null,
        createdAt: "2030-01-02T03:00:00.000Z",
        updatedAt: "2030-01-02T03:00:00.000Z",
      },
    ],
    issueToReleases: [
      {
        id: "issue-release-planned",
        issueId: "issue-7",
        releaseId: "release-planned",
        createdAt: "2030-01-02T03:00:00.000Z",
        updatedAt: "2030-01-02T03:00:00.000Z",
      },
    ],
  });

  assert.equal(result.complete, true);
  assert.equal(result.capturedAtMs, CAPTURED_AT_MS);
  assert.deepEqual(result.teams, [
    {
      id: "team-app",
      key: "APP",
      active: true,
      updatedAtMs: 1_893_553_200_000,
    },
  ]);
  assert.equal(result.issues[0].teamId, "team-app");
  assert.equal(result.issues[0].updatedAtMs, 1_893_553_440_000);
  assert.deepEqual(result.cycles, [
    {
      id: "cycle-1",
      teamId: "team-app",
      teamKey: "APP",
      updatedAtMs: 1_893_553_200_000,
    },
  ]);
  assert.deepEqual(result.issues[0].releases, [
    {
      id: "release-planned",
      pipelineId: PIPELINE_ID,
      pipelineType: "continuous",
      commitSha: "b".repeat(40),
      completedAtMs: null,
      updatedAtMs: 1_893_553_200_000,
      issueToReleaseId: "issue-release-planned",
      issueToReleaseUpdatedAtMs: 1_893_553_200_000,
    },
  ]);
});

test("team id e key devem resolver juntos contra o inventario global", async () => {
  const mismatchedIssue = await snapshot({
    issues: [issue({ team: team({ id: "team-other" }) })],
  });
  assert.equal(mismatchedIssue.complete, false);

  const mismatchedTopology = await snapshot({
    cycles: [{ id: "cycle-1", team: team({ id: "team-other" }) }],
  });
  assert.equal(mismatchedTopology.complete, false);
});

test("externalId de comment GitHub e unico em todo o snapshot", async () => {
  const githubComment = (id, url = GITHUB_ISSUE_URL) =>
    comment({
      id,
      syncedWith: [{ service: "github", id: "github-comment-node-1" }],
      externalThread: {
        id: `thread-${id}`,
        type: "integration",
        subType: "github",
        url,
        isConnected: true,
      },
    });
  const result = await snapshot({
    issues: [
      issue({
        comments: async () => connection([githubComment("comment-a")]),
      }),
      issue({
        id: "issue-8",
        identifier: "APP-8",
        syncedWith: [
          {
            service: "github",
            id: "issue-node-8",
            metadata: {
              owner: "example-org",
              repo: "example-app",
              number: 8,
            },
          },
        ],
        comments: async () =>
          connection([
            githubComment(
              "comment-b",
              "https://github.com/example-org/example-app/issues/8",
            ),
          ]),
      }),
    ],
  });

  assert.equal(result.complete, false);
  assert.equal(result.failures[0].code, "boundary_invalid");
  assert.deepEqual(result.failures[0].reasonCodes, [
    "github_comment_identity_duplicate",
  ]);
});
