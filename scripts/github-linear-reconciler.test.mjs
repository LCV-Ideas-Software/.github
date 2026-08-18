import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertReadOnlyGraphql,
  canonicalizeCommentBody,
  collectGithubLinks,
  determineExitCode,
  graphqlQuery,
  githubGet,
  isGithubSyncedComment,
  parseLinearOnlyTeamKeys,
  publishTerminalResult,
  readGithubRepositoryInventory,
  readLinearIssues,
  readLinearTopology,
  reconcileSnapshots,
  renderJson,
  renderMarkdown,
  writeIncompleteSummary,
} from "./github-linear-reconciler.mjs";

const NOW = new Date("2026-08-18T03:00:00.000Z");

function linearIssue(overrides = {}) {
  return {
    identifier: "GITHORG-70",
    title: "Reconciliar GitHub e Linear",
    description: "",
    team: { key: "GITHORG", name: ".github-org" },
    state: { type: "started", name: "Em andamento" },
    syncedWith: [],
    attachments: { nodes: [] },
    comments: { nodes: [] },
    relations: { nodes: [] },
    inverseRelations: { nodes: [] },
    releases: { nodes: [] },
    ...overrides,
  };
}

function githubIssue(overrides = {}) {
  return {
    kind: "issue",
    url: "https://github.com/LCV-Ideas-Software/.github/issues/260",
    state: "open",
    state_reason: null,
    comments: [],
    ...overrides,
  };
}

test("recusa qualquer operação GraphQL mutadora", () => {
  assert.doesNotThrow(() =>
    assertReadOnlyGraphql("query Audit { viewer { id } }"),
  );
  assert.doesNotThrow(() => assertReadOnlyGraphql("{ viewer { id } }"));
  assert.throws(
    () =>
      assertReadOnlyGraphql(
        'mutation IssueUpdate { issueUpdate(id: "x") { success } }',
      ),
    /somente consultas GraphQL/i,
  );
  assert.throws(
    () =>
      assertReadOnlyGraphql(
        'query Audit { search(contains: "#") } mutation Hidden { issueDelete(id: "x") { success } }',
      ),
    /mutation foi recusada/u,
  );
  const escapedTripleQuotes = (backslashes) => `${"\\".repeat(backslashes)}"""`;
  const blockString = (content) => `"""${content}"""`;
  assert.throws(
    () =>
      assertReadOnlyGraphql(
        `query Q { q(a: ${blockString(escapedTripleQuotes(2))}) } ` +
          `mutation M { m(a: ${blockString(escapedTripleQuotes(1))}) }`,
      ),
    /mutation foi recusada/u,
  );
  assert.throws(
    () => assertReadOnlyGraphql("subscription Events { issueUpdated { id } }"),
    /subscription foi recusada/u,
  );
  assert.throws(
    () => assertReadOnlyGraphql("fragment Fields on Issue { id }"),
    /contenham uma consulta/u,
  );
  assert.doesNotThrow(() =>
    assertReadOnlyGraphql(`
      # mutation Ignored { issueDelete(id: "x") { success } }
      query mutation($filter: Filter = { text: "# mutation" }) {
        mutation
        search(filter: $filter, block: """mutation # dentro do bloco""")
      }
      fragment mutation on Issue { id }
    `),
  );
  assert.throws(
    () =>
      assertReadOnlyGraphql({
        toString: () => "query Safe { viewer { id } }",
        toJSON: () => 'mutation Escaped { issueDelete(id: "x") { success } }',
      }),
    /deve ser fornecida como string/u,
  );
});

test("cliente GraphQL não valida e envia representações diferentes", async () => {
  let fetched = false;
  await assert.rejects(
    () =>
      graphqlQuery({
        token: "linear-read-only",
        query: {
          toString: () => "query Safe { viewer { id } }",
          toJSON: () => 'mutation Escaped { issueDelete(id: "x") { success } }',
        },
        fetchImpl: async () => {
          fetched = true;
          return new Response(JSON.stringify({ data: {} }), { status: 200 });
        },
      }),
    /deve ser fornecida como string/u,
  );
  assert.equal(fetched, false);
});

test("recusa configurações temporais fail-open", () => {
  const input = { linearIssues: [], githubByUrl: new Map(), now: NOW };
  assert.throws(
    () =>
      reconcileSnapshots({
        ...input,
        commentGraceMs: Number.POSITIVE_INFINITY,
      }),
    /finito e não negativo/u,
  );
  assert.throws(
    () =>
      reconcileSnapshots({
        ...input,
        releaseRequiredAfter: new Date("inválida"),
      }),
    /data válida/u,
  );
});

test("parseia somente chaves Linear-only explícitas e estáveis", () => {
  assert.deepEqual(parseLinearOnlyTeamKeys("PANDROID,ASTANDROID"), [
    "PANDROID",
    "ASTANDROID",
  ]);
  assert.throws(
    () => parseLinearOnlyTeamKeys("PANDROID,,ASTANDROID"),
    /entrada vazia/u,
  );
  assert.throws(
    () => parseLinearOnlyTeamKeys("PANDROID,PANDROID"),
    /duplicada/u,
  );
  assert.throws(() => parseLinearOnlyTeamKeys("LCV"), /guarda-chuva/u);
});

test("GraphQL HTTP 200 com errors nunca é aceito como snapshot", async () => {
  await assert.rejects(
    () =>
      graphqlQuery({
        token: "linear-read-only",
        query: "query Audit { viewer { id } }",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              data: { viewer: null },
              errors: [{ message: "complexity limit" }],
            }),
            { status: 200 },
          ),
      }),
    /complexity limit/u,
  );
});

test("GraphQL HTTP 400 preserva código e causa sem expor credenciais", async () => {
  await assert.rejects(
    () =>
      graphqlQuery({
        token: "linear-read-only-secret",
        query: "query Audit { viewer { id } }",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              errors: [
                {
                  message: "Query complexity limit exceeded",
                  extensions: { code: "RATELIMITED" },
                },
              ],
            }),
            { status: 400 },
          ),
      }),
    (error) => {
      assert.match(error.message, /HTTP 400/u);
      assert.match(error.message, /RATELIMITED/u);
      assert.match(error.message, /complexity limit/u);
      assert.doesNotMatch(error.message, /linear-read-only-secret/u);
      return true;
    },
  );
});

test("GraphQL HTTP 200 sem JSON falha com diagnóstico explícito", async () => {
  await assert.rejects(
    () =>
      graphqlQuery({
        token: "linear-read-only",
        query: "query Audit { viewer { id } }",
        fetchImpl: async () => new Response("not-json", { status: 200 }),
      }),
    /JSON inválido ou resposta parcial sem data/u,
  );
});

test("pagina conexão Linear aninhada antes de concluir", async () => {
  const requests = [];
  const fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    if (request.query.includes("GitHubLinearReconciliation")) {
      return new Response(
        JSON.stringify({
          data: {
            issues: {
              nodes: [
                {
                  id: "issue-id",
                  identifier: "GITHORG-70",
                  title: "Audit",
                  description: "",
                  team: { key: "GITHORG" },
                  state: { type: "started" },
                  syncedWith: [],
                  attachments: {
                    nodes: [
                      { id: "a1", title: "1", url: "https://example.com/1" },
                    ],
                    pageInfo: { hasNextPage: true, endCursor: "cursor-a" },
                  },
                  relations: { nodes: [], pageInfo: { hasNextPage: false } },
                  inverseRelations: {
                    nodes: [],
                    pageInfo: { hasNextPage: false },
                  },
                  releases: { nodes: [], pageInfo: { hasNextPage: false } },
                  comments: { nodes: [], pageInfo: { hasNextPage: false } },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
        { status: 200 },
      );
    }
    assert.match(request.query, /attachments\(first: 50/u);
    assert.equal(request.variables.after, "cursor-a");
    return new Response(
      JSON.stringify({
        data: {
          issue: {
            attachments: {
              nodes: [{ id: "a2", title: "2", url: "https://example.com/2" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      }),
      { status: 200 },
    );
  };

  const issues = await readLinearIssues({
    token: "linear-read-only",
    fetchImpl,
  });
  assert.equal(issues[0].attachments.nodes.length, 2);
  assert.equal(requests.length, 2);
  assert.equal(
    requests.every((request) => !/\bmutation\b/iu.test(request.query)),
    true,
  );
});

test("carrega comments inline sem syncedWith para descobrir externalThread GitHub", async () => {
  const requests = [];
  const fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    if (request.query.includes("GitHubLinearReconciliation")) {
      return new Response(
        JSON.stringify({
          data: {
            issues: {
              nodes: [
                {
                  ...linearIssue({
                    id: "linear-with-thread",
                    identifier: "GITHORG-71",
                    syncedWith: [],
                  }),
                  attachments: {
                    nodes: [],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                  relations: {
                    nodes: [],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                  inverseRelations: {
                    nodes: [],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                  releases: {
                    nodes: [],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                  comments: {
                    nodes: [
                      {
                        id: "comment-with-thread",
                        body: "checkpoint",
                        externalThread: {
                          id: "thread-github",
                          isConnected: false,
                          subType: "github",
                          type: "integration",
                        },
                        syncedWith: [],
                      },
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
        { status: 200 },
      );
    }
    throw new Error("não deveria executar uma consulta N+1 de comments");
  };

  const issues = await readLinearIssues({
    token: "linear-read-only",
    fetchImpl,
  });

  assert.equal(requests.length, 1);
  assert.equal(issues[0].comments.nodes.length, 1);
  assert.equal(issues[0].comments.nodes[0].externalThread.subType, "github");
});

test("pagina somente comments truncados a partir do lote inline", async () => {
  const requests = [];
  const fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    if (request.query.includes("GitHubLinearReconciliation")) {
      assert.match(request.query, /comments\(first: 10, orderBy: createdAt\)/u);
      return new Response(
        JSON.stringify({
          data: {
            issues: {
              nodes: [
                {
                  ...linearIssue({ id: "linear-comments-paged" }),
                  attachments: {
                    nodes: [],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                  relations: {
                    nodes: [],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                  inverseRelations: {
                    nodes: [],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                  releases: {
                    nodes: [],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                  comments: {
                    nodes: [{ id: "comment-1", body: "primeiro" }],
                    pageInfo: {
                      hasNextPage: true,
                      endCursor: "comments-cursor",
                    },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
        { status: 200 },
      );
    }
    assert.match(
      request.query,
      /comments\(first: 50, after: \$after, orderBy: createdAt\)/u,
    );
    assert.equal(request.variables.after, "comments-cursor");
    return new Response(
      JSON.stringify({
        data: {
          issue: {
            comments: {
              nodes: [{ id: "comment-2", body: "segundo" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      }),
      { status: 200 },
    );
  };

  const issues = await readLinearIssues({
    token: "linear-read-only",
    fetchImpl,
  });

  assert.equal(requests.length, 2);
  assert.deepEqual(
    issues[0].comments.nodes.map((comment) => comment.id),
    ["comment-1", "comment-2"],
  );
});

test("200 issues sem comments usam somente as páginas principais", async () => {
  const requests = [];
  const fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    assert.match(request.query, /GitHubLinearReconciliation/u);
    const page = request.variables.after
      ? Number(request.variables.after.slice(1))
      : 0;
    const nodes = Array.from({ length: 50 }, (_, offset) => {
      const index = page * 50 + offset;
      return {
        ...linearIssue({
          id: `linear-${index}`,
          identifier: `BULK-${index}`,
        }),
        attachments: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
        relations: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
        inverseRelations: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
        releases: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
        comments: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      };
    });
    return new Response(
      JSON.stringify({
        data: {
          issues: {
            nodes,
            pageInfo: {
              hasNextPage: page < 3,
              endCursor: page < 3 ? `p${page + 1}` : null,
            },
          },
        },
      }),
      { status: 200 },
    );
  };

  const issues = await readLinearIssues({
    token: "linear-read-only",
    fetchImpl,
  });

  assert.equal(issues.length, 200);
  assert.equal(requests.length, 4);
});

test("paginação Linear recusa cursor repetido", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      readLinearIssues({
        token: "linear-read-only",
        fetchImpl: async () => {
          calls += 1;
          return new Response(
            JSON.stringify({
              data: {
                issues: {
                  nodes: [],
                  pageInfo: { hasNextPage: true, endCursor: "repetido" },
                },
              },
            }),
            { status: 200 },
          );
        },
      }),
    /cursor repetido/u,
  );
  assert.equal(calls, 2);
});

test("inventaria topologia completa do time LCV", async () => {
  const fetchImpl = async (_url, options) => {
    const { query } = JSON.parse(options.body);
    assert.match(query, /includeArchived:\s*true/u);
    if (query.includes("GitHubLinearTeams")) {
      return new Response(
        JSON.stringify({
          data: {
            teams: {
              nodes: [
                { id: "team-lcv", key: "LCV", name: "LCV" },
                {
                  id: "team-child",
                  key: "CHILD",
                  name: "child",
                  parent: { id: "team-lcv", key: "LCV", name: "LCV" },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
        { status: 200 },
      );
    }
    if (query.includes("GitHubLinearUmbrellaCycles")) {
      return new Response(
        JSON.stringify({
          data: {
            team: {
              cycles: {
                nodes: [{ id: "cycle-1", name: "C1", number: 1 }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        }),
        { status: 200 },
      );
    }
    if (query.includes("GitHubLinearUmbrellaProjects")) {
      return new Response(
        JSON.stringify({
          data: {
            team: {
              projects: {
                nodes: [{ id: "project-1", name: "Legacy", archivedAt: null }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        }),
        { status: 200 },
      );
    }
    if (query.includes("GitHubLinearUmbrellaDocuments")) {
      assert.match(query, /filter:\s*\{\s*team:/u);
      return new Response(
        JSON.stringify({
          data: {
            documents: {
              nodes: [
                {
                  id: "document-1",
                  title: "Legacy document",
                  slugId: "legacy-document",
                  archivedAt: null,
                  team: { id: "team-lcv", key: "LCV", name: "LCV" },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
        { status: 200 },
      );
    }
    assert.match(query, /leadTeam:\s*\{\s*id:\s*\{\s*eq:\s*\$teamId/u);
    return new Response(
      JSON.stringify({
        data: {
          initiatives: {
            nodes: [
              {
                id: "initiative-1",
                name: "Legacy initiative",
                archivedAt: null,
                leadTeam: { id: "team-lcv", key: "LCV", name: "LCV" },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
      { status: 200 },
    );
  };
  const topology = await readLinearTopology({
    token: "linear-read-only",
    fetchImpl,
  });
  assert.equal(topology.cycles.length, 1);
  assert.equal(topology.projects.length, 1);
  assert.equal(topology.initiatives.length, 1);
  assert.equal(topology.documents.length, 1);
  assert.equal(topology.subteams.length, 1);
});

test("topologia falha fechada quando o LCV inexiste ou está inativo", async () => {
  for (const teams of [
    [],
    [
      {
        id: "team-lcv",
        key: "LCV",
        name: "LCV",
        retiredAt: "2026-08-18T00:00:00Z",
      },
    ],
  ]) {
    const topology = await readLinearTopology({
      token: "linear-read-only",
      fetchImpl: async (_url, options) => {
        const { query } = JSON.parse(options.body);
        assert.match(query, /GitHubLinearTeams/u);
        return new Response(
          JSON.stringify({
            data: {
              teams: {
                nodes: teams,
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
          { status: 200 },
        );
      },
    });
    const result = reconcileSnapshots({
      linearIssues: [],
      githubByUrl: new Map(),
      linearTopology: topology,
      now: NOW,
      requireGithubIssueAttachment: false,
    });
    assert.match(topology.auditFailure, /^umbrella_team_/u);
    assert.equal(determineExitCode(result), 2);
  }
});

test("extrai somente links GitHub de issues e PRs da organização", () => {
  const links = collectGithubLinks({
    description:
      "Issue https://github.com/LCV-Ideas-Software/.github/issues/260 e " +
      "PR https://github.com/LCV-Ideas-Software/admin-app/pull/501; " +
      "ignorar https://github.com/outro/repo/issues/1",
    attachments: {
      nodes: [
        { url: "https://github.com/LCV-Ideas-Software/.github/issues/260" },
      ],
    },
    comments: { nodes: [] },
  });

  assert.deepEqual(links, [
    {
      kind: "issue",
      number: 260,
      owner: "LCV-Ideas-Software",
      repo: ".github",
      url: "https://github.com/LCV-Ideas-Software/.github/issues/260",
    },
    {
      kind: "pull",
      number: 501,
      owner: "LCV-Ideas-Software",
      repo: "admin-app",
      url: "https://github.com/LCV-Ideas-Software/admin-app/pull/501",
    },
  ]);
});

test("extrai links da organização configurada sem aceitar prefixos inválidos", () => {
  const links = collectGithubLinks(
    {
      description:
        "(https://github.com/Example-Org/service-api/issues/42), " +
        "https://github.com/LCV-Ideas-Software/service-api/issues/43 e " +
        "https://github.com/Example-Org/service-api/issues/44abc e " +
        "https://github.com:444/Example-Org/service-api/issues/45",
      attachments: { nodes: [] },
      comments: { nodes: [] },
      syncedWith: [],
    },
    "Example-Org",
  );

  assert.deepEqual(links, [
    {
      kind: "issue",
      number: 42,
      owner: "Example-Org",
      repo: "service-api",
      url: "https://github.com/Example-Org/service-api/issues/42",
    },
  ]);
});

test("extrai o gêmeo GitHub nativo de syncedWith", () => {
  const links = collectGithubLinks({
    description: "",
    attachments: { nodes: [] },
    comments: { nodes: [] },
    syncedWith: [
      {
        id: "I_kwDOSPY5As8AAAABNF2aNA",
        service: "github",
        metadata: {
          __typename: "ExternalEntityInfoGithubMetadata",
          owner: "LCV-Ideas-Software",
          repo: ".github",
          number: 244,
        },
      },
    ],
  });

  assert.equal(links.length, 1);
  assert.equal(
    links[0].url,
    "https://github.com/LCV-Ideas-Software/.github/issues/244",
  );
});

test("ignora syncedWith GitHub sem número positivo", () => {
  const links = collectGithubLinks({
    description: "",
    attachments: { nodes: [] },
    comments: { nodes: [] },
    syncedWith: [
      {
        id: "sem-numero",
        service: "github",
        metadata: {
          owner: "LCV-Ideas-Software",
          repo: ".github",
          number: null,
        },
      },
    ],
  });

  assert.deepEqual(links, []);
});

test("metadado nativo GitHub inválido torna o snapshot inconclusivo", () => {
  const url = "https://github.com/LCV-Ideas-Software/.github/issues/260";
  const result = reconcileSnapshots({
    linearIssues: [
      linearIssue({
        syncedWith: [
          {
            id: "sem-numero",
            service: "github",
            metadata: {
              owner: "LCV-Ideas-Software",
              repo: ".github",
              number: null,
            },
          },
          { id: "sem-metadata", service: "github", metadata: null },
          {
            id: "numero-booleano",
            service: "github",
            metadata: {
              owner: "LCV-Ideas-Software",
              repo: ".github",
              number: true,
            },
          },
          {
            id: "numero-nao-canonico",
            service: "github",
            metadata: {
              owner: "LCV-Ideas-Software",
              repo: ".github",
              number: "0260",
            },
          },
          {
            id: "repo-com-caminho",
            service: "github",
            metadata: {
              owner: "LCV-Ideas-Software",
              repo: ".github/../evil",
              number: 260,
            },
          },
          {
            id: "owner-externo",
            service: "github",
            metadata: { owner: "Other-Org", repo: ".github", number: 260 },
          },
        ],
        attachments: { nodes: [{ url }] },
      }),
    ],
    githubByUrl: new Map([[url, githubIssue({ url })]]),
    now: NOW,
  });

  assert.equal(
    result.findings.filter(
      (finding) => finding.code === "native_github_sync_metadata_invalid",
    ).length,
    6,
  );
  assert.equal(determineExitCode(result), 2);
});

test("metadado nativo GitHub válido não gera finding inconclusivo", () => {
  const url = "https://github.com/LCV-Ideas-Software/.github/issues/260";
  const result = reconcileSnapshots({
    linearIssues: [
      linearIssue({
        syncedWith: [
          {
            id: "I_native",
            service: "github",
            metadata: {
              owner: "LCV-Ideas-Software",
              repo: ".github",
              number: 260,
            },
          },
        ],
        attachments: { nodes: [{ url }] },
      }),
    ],
    githubByUrl: new Map([[url, githubIssue({ url })]]),
    now: NOW,
  });

  assert.equal(
    result.findings.some(
      (finding) => finding.code === "native_github_sync_metadata_invalid",
    ),
    false,
  );
});

test("detecta divergência de estado e ausência de attachment GitHub", () => {
  const linked = linearIssue({
    state: { type: "completed", name: "Concluido" },
    attachments: {
      nodes: [
        { url: "https://github.com/LCV-Ideas-Software/.github/issues/260" },
      ],
    },
  });
  const missing = linearIssue({
    identifier: "GITHORG-71",
    title: "Outro trabalho sem attachment",
  });
  const result = reconcileSnapshots({
    linearIssues: [linked, missing],
    githubByUrl: new Map([[githubIssue().url, githubIssue()]]),
    now: NOW,
  });

  assert.deepEqual(result.findings.map((finding) => finding.code).sort(), [
    "missing_github_issue_attachment",
    "status_divergence",
  ]);
});

test("estado Linear duplicate corresponde a GitHub fechado not_planned", () => {
  const url = "https://github.com/LCV-Ideas-Software/.github/issues/260";
  const issue = linearIssue({
    state: { type: "duplicate", name: "Duplicate" },
    attachments: { nodes: [{ url }] },
  });
  const result = reconcileSnapshots({
    linearIssues: [issue],
    githubByUrl: new Map([
      [url, githubIssue({ url, state: "closed", state_reason: "not_planned" })],
    ]),
    now: NOW,
  });
  assert.equal(
    result.findings.some((finding) => finding.code === "status_divergence"),
    false,
  );
});

test("attachment de outro repositório não satisfaz o gêmeo do time", () => {
  const foreignUrl =
    "https://github.com/LCV-Ideas-Software/admin-app/issues/501";
  const issue = linearIssue({
    attachments: { nodes: [{ url: foreignUrl }] },
  });
  const result = reconcileSnapshots({
    linearIssues: [issue],
    githubByUrl: new Map([[foreignUrl, githubIssue({ url: foreignUrl })]]),
    now: NOW,
  });
  assert.equal(
    result.findings.filter(
      (finding) => finding.code === "missing_github_issue_attachment",
    ).length,
    1,
  );
});

test("attachment suplementar não substitui o attachment do gêmeo nativo", () => {
  const nativeUrl = "https://github.com/LCV-Ideas-Software/.github/issues/260";
  const supplementaryUrl =
    "https://github.com/LCV-Ideas-Software/.github/issues/261";
  const issue = linearIssue({
    syncedWith: [
      {
        id: "I_native",
        service: "github",
        metadata: {
          owner: "LCV-Ideas-Software",
          repo: ".github",
          number: 260,
        },
      },
    ],
    attachments: { nodes: [{ url: supplementaryUrl }] },
  });
  const result = reconcileSnapshots({
    linearIssues: [issue],
    githubByUrl: new Map([
      [nativeUrl, githubIssue({ url: nativeUrl })],
      [supplementaryUrl, githubIssue({ url: supplementaryUrl })],
    ]),
    now: NOW,
  });

  assert.equal(
    result.findings.filter(
      (finding) => finding.code === "missing_github_issue_attachment",
    ).length,
    1,
  );
});

test("link suplementar não é tratado como gêmeo canônico de estado", () => {
  const canonicalUrl =
    "https://github.com/LCV-Ideas-Software/.github/issues/260";
  const historicalUrl =
    "https://github.com/LCV-Ideas-Software/.github/issues/200";
  const issue = linearIssue({
    description: `Histórico: ${historicalUrl}`,
    attachments: { nodes: [{ url: canonicalUrl }] },
  });
  const result = reconcileSnapshots({
    linearIssues: [issue],
    githubByUrl: new Map([
      [canonicalUrl, githubIssue({ url: canonicalUrl })],
      [
        historicalUrl,
        githubIssue({
          url: historicalUrl,
          state: "closed",
          state_reason: "completed",
        }),
      ],
    ]),
    now: NOW,
  });
  assert.equal(
    result.findings.some((finding) => finding.code === "status_divergence"),
    false,
  );
});

test("detecta release ausente para PR mergeado após o corte", () => {
  const pullUrl = "https://github.com/LCV-Ideas-Software/.github/pull/260";
  const issue = linearIssue({
    state: { type: "completed", name: "Concluido" },
    attachments: {
      nodes: [
        { url: "https://github.com/LCV-Ideas-Software/.github/issues/259" },
        { url: pullUrl },
      ],
    },
  });
  const result = reconcileSnapshots({
    linearIssues: [issue],
    githubByUrl: new Map([
      [
        "https://github.com/LCV-Ideas-Software/.github/issues/259",
        githubIssue({
          url: "https://github.com/LCV-Ideas-Software/.github/issues/259",
          state: "closed",
          state_reason: "completed",
        }),
      ],
      [
        pullUrl,
        {
          kind: "pull",
          url: pullUrl,
          merged: true,
          merged_at: "2026-08-18T01:00:00Z",
          merge_commit_sha: "0123456789abcdef0123456789abcdef01234567",
          comments: [],
        },
      ],
    ]),
    now: NOW,
    releaseRequiredAfter: new Date("2026-08-17T12:00:00Z"),
  });

  assert.equal(
    result.findings.filter((finding) => finding.code === "missing_release")
      .length,
    1,
  );
});

test("link suplementar de PR não é tratado como carrier de release", () => {
  const issueUrl = "https://github.com/LCV-Ideas-Software/.github/issues/259";
  const pullUrl = "https://github.com/LCV-Ideas-Software/.github/pull/260";
  const issue = linearIssue({
    description: `Referência histórica: ${pullUrl}`,
    attachments: { nodes: [{ url: issueUrl }] },
  });
  const result = reconcileSnapshots({
    linearIssues: [issue],
    githubByUrl: new Map([
      [issueUrl, githubIssue({ url: issueUrl })],
      [
        pullUrl,
        {
          kind: "pull",
          url: pullUrl,
          merged: true,
          merged_at: "2026-08-18T01:00:00Z",
          merge_commit_sha: "0123456789abcdef0123456789abcdef01234567",
          comments: [],
        },
      ],
    ]),
    now: NOW,
    releaseRequiredAfter: new Date("2026-08-17T12:00:00Z"),
  });

  assert.equal(
    result.findings.some((finding) => finding.code === "missing_release"),
    false,
  );
});

test("aceita release associada pelo commit exato ou versão curta", () => {
  const pullUrl = "https://github.com/LCV-Ideas-Software/.github/pull/260";
  const attachmentPullUrl =
    "https://github.com/LCV-Ideas-Software/.GITHUB/pull/260";
  const issue = linearIssue({
    state: { type: "completed", name: "Concluido" },
    attachments: {
      nodes: [
        { url: "https://github.com/LCV-Ideas-Software/.github/issues/259" },
        { url: attachmentPullUrl },
      ],
    },
    comments: { nodes: [{ body: `Carrier ${pullUrl}` }] },
    releases: {
      nodes: [
        {
          version: "0123456",
          commitSha: null,
          completedAt: "2026-08-18T01:01:00Z",
          pipeline: { name: ".github-org", type: "continuous" },
        },
      ],
    },
  });
  const result = reconcileSnapshots({
    linearIssues: [issue],
    githubByUrl: new Map([
      [
        "https://github.com/LCV-Ideas-Software/.github/issues/259",
        githubIssue({
          url: "https://github.com/LCV-Ideas-Software/.github/issues/259",
          state: "closed",
          state_reason: "completed",
        }),
      ],
      [
        pullUrl,
        {
          kind: "pull",
          url: pullUrl,
          merged: true,
          merged_at: "2026-08-18T01:00:00Z",
          merge_commit_sha: "0123456789abcdef0123456789abcdef01234567",
          comments: [],
        },
      ],
    ]),
    now: NOW,
    releaseRequiredAfter: new Date("2026-08-17T12:00:00Z"),
  });

  assert.equal(
    result.findings.some((finding) => finding.code === "missing_release"),
    false,
  );
});

test("release incompleta ou de pipeline scheduled não satisfaz o PR", () => {
  const pullUrl = "https://github.com/LCV-Ideas-Software/.github/pull/260";
  const commit = "0123456789abcdef0123456789abcdef01234567";
  const issue = linearIssue({
    state: { type: "completed", name: "Concluido" },
    attachments: {
      nodes: [
        { url: "https://github.com/LCV-Ideas-Software/.github/issues/259" },
        { url: pullUrl },
      ],
    },
    releases: {
      nodes: [
        {
          commitSha: commit,
          completedAt: "2026-08-18T01:01:00Z",
          pipeline: { name: ".github-org", type: "scheduled" },
        },
        {
          commitSha: commit,
          completedAt: null,
          pipeline: { name: ".github-org", type: "continuous" },
        },
      ],
    },
  });
  const result = reconcileSnapshots({
    linearIssues: [issue],
    githubByUrl: new Map([
      [
        "https://github.com/LCV-Ideas-Software/.github/issues/259",
        githubIssue({
          url: "https://github.com/LCV-Ideas-Software/.github/issues/259",
          state: "closed",
          state_reason: "completed",
        }),
      ],
      [
        pullUrl,
        {
          kind: "pull",
          url: pullUrl,
          merged: true,
          merged_at: "2026-08-18T01:00:00Z",
          merge_commit_sha: commit,
          comments: [],
        },
      ],
    ]),
    now: NOW,
    releaseRequiredAfter: new Date("2026-08-17T12:00:00Z"),
  });

  assert.equal(
    result.findings.filter((finding) => finding.code === "missing_release")
      .length,
    1,
  );
});

test("release de outra pipeline não satisfaz o PR", () => {
  const pullUrl = "https://github.com/LCV-Ideas-Software/.github/pull/260";
  const issue = linearIssue({
    state: { type: "completed", name: "Concluido" },
    attachments: {
      nodes: [
        { url: "https://github.com/LCV-Ideas-Software/.github/issues/259" },
        { url: pullUrl },
      ],
    },
    releases: {
      nodes: [
        {
          commitSha: "0123456789abcdef0123456789abcdef01234567",
          pipeline: { name: "admin-app" },
        },
      ],
    },
  });
  const result = reconcileSnapshots({
    linearIssues: [issue],
    githubByUrl: new Map([
      [
        "https://github.com/LCV-Ideas-Software/.github/issues/259",
        githubIssue({
          url: "https://github.com/LCV-Ideas-Software/.github/issues/259",
          state: "closed",
          state_reason: "completed",
        }),
      ],
      [
        pullUrl,
        {
          kind: "pull",
          url: pullUrl,
          merged: true,
          merged_at: "2026-08-18T01:00:00Z",
          merge_commit_sha: "0123456789abcdef0123456789abcdef01234567",
        },
      ],
    ]),
    now: NOW,
  });

  assert.equal(
    result.findings.filter((finding) => finding.code === "missing_release")
      .length,
    1,
  );
});

test("detecta comentário GitHub não sincronizado após a tolerância", () => {
  const url = "https://github.com/LCV-Ideas-Software/.github/issues/260";
  const issue = linearIssue({
    attachments: { nodes: [{ url }] },
    syncedWith: [{ id: "I_issue", service: "github" }],
    comments: {
      nodes: [{ body: "comentário antigo", createdAt: "2026-08-18T00:00:00Z" }],
    },
  });
  const gh = githubIssue({
    url,
    comments: [
      { body: "checkpoint terminal novo", created_at: "2026-08-18T02:00:00Z" },
    ],
  });
  const result = reconcileSnapshots({
    linearIssues: [issue],
    githubByUrl: new Map([[url, gh]]),
    now: NOW,
    commentGraceMs: 15 * 60 * 1000,
  });

  assert.equal(
    result.findings.filter((finding) => finding.code === "comment_sync_gap")
      .length,
    1,
  );
  assert.match(
    result.findings.find((finding) => finding.code === "comment_sync_gap")
      .message,
    /17\/08\/2026 23:00:00/,
  );
});

test("pareamento de comentários é um para um", () => {
  const url = "https://github.com/LCV-Ideas-Software/.github/issues/260";
  const createdAt = "2026-08-18T01:00:00Z";
  const issue = linearIssue({
    attachments: { nodes: [{ url }] },
    syncedWith: [{ id: "I_issue", service: "github" }],
    comments: {
      nodes: [
        {
          id: "linear-1",
          body: "Mesmo comentário",
          createdAt,
          updatedAt: createdAt,
          syncedWith: [{ id: "GH1", service: "github" }],
        },
      ],
    },
  });
  const result = reconcileSnapshots({
    linearIssues: [issue],
    githubByUrl: new Map([
      [
        url,
        githubIssue({
          url,
          comments: [
            {
              node_id: "GH1",
              body: "Mesmo comentário",
              created_at: createdAt,
              updated_at: createdAt,
            },
            {
              node_id: "GH2",
              body: "Mesmo comentário",
              created_at: createdAt,
              updated_at: createdAt,
            },
          ],
        }),
      ],
    ]),
    now: NOW,
  });

  assert.equal(
    result.findings.filter((finding) => finding.code === "comment_sync_gap")
      .length,
    1,
  );
});

test("detecta comentário do thread Linear ausente no GitHub", () => {
  const url = "https://github.com/LCV-Ideas-Software/.github/issues/260";
  const issue = linearIssue({
    attachments: { nodes: [{ url }] },
    syncedWith: [{ id: "I_issue", service: "github" }],
    comments: {
      nodes: [
        {
          id: "linear-comment",
          body: "Comentário criado no Linear",
          createdAt: "2026-08-18T01:00:00Z",
          syncedWith: [],
          externalThread: {
            isConnected: true,
            subType: "github",
            type: "integration",
          },
        },
      ],
    },
  });
  const result = reconcileSnapshots({
    linearIssues: [issue],
    githubByUrl: new Map([[url, githubIssue({ url, comments: [] })]]),
    now: NOW,
  });

  assert.equal(
    result.findings.filter(
      (finding) => finding.code === "comment_sync_gap_to_github",
    ).length,
    1,
  );
});

test("syncedWith GitHub ausente no destino detecta gap mesmo sem externalThread", () => {
  const url = "https://github.com/LCV-Ideas-Software/.github/issues/260";
  const issue = linearIssue({
    attachments: { nodes: [{ url }] },
    syncedWith: [{ id: "I_issue", service: "github" }],
    comments: {
      nodes: [
        {
          id: "linear-comment-deleted-on-github",
          body: "Comentário cujo original não está mais no GitHub",
          createdAt: "2026-08-18T01:00:00Z",
          updatedAt: "2026-08-18T01:00:00Z",
          syncedWith: [{ id: "IC_deleted", service: "github" }],
          externalThread: null,
        },
      ],
    },
  });
  const result = reconcileSnapshots({
    linearIssues: [issue],
    githubByUrl: new Map([[url, githubIssue({ url, comments: [] })]]),
    now: NOW,
  });

  assert.equal(
    result.findings.filter(
      (finding) => finding.code === "comment_sync_gap_to_github",
    ).length,
    1,
  );
});

test("transformações normais do Markdown por node_id não parecem stale", () => {
  const url = "https://github.com/LCV-Ideas-Software/.github/issues/260";
  const issue = linearIssue({
    attachments: { nodes: [{ url }] },
    syncedWith: [{ id: "I_issue", service: "github" }],
    comments: {
      nodes: [
        {
          id: "linear-rich-reference",
          body: "[LCV-Ideas-Software/.github#250](https://linear.app/lcv-ideas-software/review/250)\nProject [#22](<https://github.com/LCV-Ideas-Software/.github/issues/22>)",
          createdAt: "2026-08-18T01:00:00Z",
          updatedAt: "2026-08-18T01:00:03Z",
          syncedWith: [{ id: "IC_rich_reference", service: "github" }],
          externalThread: null,
        },
      ],
    },
  });
  const result = reconcileSnapshots({
    linearIssues: [issue],
    githubByUrl: new Map([
      [
        url,
        githubIssue({
          url,
          comments: [
            {
              node_id: "IC_rich_reference",
              body: "#250\nProject #22",
              created_at: "2026-08-18T01:00:00Z",
              updated_at: "2026-08-18T01:00:00Z",
            },
          ],
        }),
      ],
    ]),
    now: NOW,
  });

  assert.equal(
    result.findings.some((finding) =>
      ["comment_sync_stale", "comment_sync_stale_to_github"].includes(
        finding.code,
      ),
    ),
    false,
  );
});

test("canonicalização preserva destino genérico e identidade cross-repo", () => {
  assert.notEqual(
    canonicalizeCommentBody("[docs](https://good.example/a)"),
    canonicalizeCommentBody("[docs](https://evil.example/a)"),
  );
  assert.notEqual(
    canonicalizeCommentBody("LCV-Ideas-Software/repo-a#7"),
    canonicalizeCommentBody("LCV-Ideas-Software/repo-b#7"),
  );
  assert.equal(
    canonicalizeCommentBody(
      "[LCV-Ideas-Software/.github#250](https://linear.app/lcv-ideas-software/review/abc)",
      { organization: "LCV-Ideas-Software", repository: ".github" },
    ),
    "#250",
  );
  assert.equal(
    canonicalizeCommentBody(
      "[#22](<https://github.com/LCV-Ideas-Software/.github/issues/22>)",
      { organization: "LCV-Ideas-Software", repository: ".github" },
    ),
    "#22",
  );
  assert.notEqual(
    canonicalizeCommentBody(
      "[LCV-Ideas-Software/.github#250](http://linear.app/lcv-ideas-software/review/abc)",
      { organization: "LCV-Ideas-Software", repository: ".github" },
    ),
    "#250",
  );
});

test("âncora Linear e linkback GitHub não são tratados como conteúdo divergente", () => {
  const url = "https://github.com/LCV-Ideas-Software/.github/issues/249";
  const issue = linearIssue({
    url: "https://linear.app/lcv-ideas-software/issue/GITHORG-70/reconciliar-github-e-linear",
    attachments: { nodes: [{ url }] },
    comments: {
      nodes: [
        {
          body: "This comment thread is synced to a corresponding [GitHub issue](https://github.com/LCV-Ideas-Software/.github/issues/249). All replies are synchronized.",
          createdAt: "2026-08-18T01:00:00.000Z",
          updatedAt: "2026-08-18T01:00:00.000Z",
          syncedWith: [],
          externalThread: {
            isConnected: true,
            name: "GitHub",
            subType: "github",
            url,
          },
        },
      ],
    },
  });
  const result = reconcileSnapshots({
    linearIssues: [issue],
    githubByUrl: new Map([
      [
        url,
        githubIssue({
          url,
          comments: [
            {
              node_id: "IC_linear_linkback",
              body: '<!-- linear-linkback --><p><a href="https://linear.app/lcv-ideas-software/issue/GITHORG-70">GITHORG-70</a></p>',
              created_at: "2026-08-18T01:00:00.500Z",
              updated_at: "2026-08-18T01:00:00.500Z",
            },
          ],
        }),
      ],
    ]),
    now: NOW,
  });

  assert.equal(
    result.findings.some((finding) =>
      [
        "comment_sync_gap",
        "comment_sync_gap_to_github",
        "comment_sync_stale",
        "comment_sync_stale_to_github",
        "comment_sync_content_divergence",
      ].includes(finding.code),
    ),
    false,
  );
  assert.equal(
    result.findings.some(
      (finding) => finding.code === "integration_linkback_mismatch",
    ),
    false,
  );
});

test("âncora ou linkback apontando outro gêmeo falha explicitamente", () => {
  const url = "https://github.com/LCV-Ideas-Software/.github/issues/249";
  const issue = linearIssue({
    identifier: "GITHORG-70",
    url: "https://linear.app/lcv-ideas-software/issue/GITHORG-70/reconciliar-github-e-linear",
    attachments: { nodes: [{ url }] },
    comments: {
      nodes: [
        {
          body: "This comment thread is synced to a corresponding [GitHub issue](https://github.com/LCV-Ideas-Software/.github/issues/999). All replies are synchronized.",
          createdAt: "2026-08-18T01:00:00.000Z",
          updatedAt: "2026-08-18T01:00:00.000Z",
          syncedWith: [],
          externalThread: {
            isConnected: true,
            name: "GitHub",
            subType: "github",
            url,
          },
        },
      ],
    },
  });
  const result = reconcileSnapshots({
    linearIssues: [issue],
    githubByUrl: new Map([
      [
        url,
        githubIssue({
          url,
          comments: [
            {
              node_id: "IC_linear_linkback_wrong",
              body: '<!-- linear-linkback --><p><a href="https://linear.app/lcv-ideas-software/issue/GITHORG-999">GITHORG-999</a></p>',
              created_at: "2026-08-18T01:00:00.500Z",
              updated_at: "2026-08-18T01:00:00.500Z",
            },
          ],
        }),
      ],
    ]),
    now: NOW,
  });

  assert.equal(
    result.findings.filter(
      (finding) => finding.code === "integration_linkback_mismatch",
    ).length,
    1,
  );

  const validAnchorIssue = {
    ...issue,
    comments: {
      nodes: [
        {
          ...issue.comments.nodes[0],
          body: "This comment thread is synced to a corresponding [GitHub issue](https://github.com/LCV-Ideas-Software/.github/issues/249). All replies are synchronized.",
        },
      ],
    },
  };
  const wrongWorkspace = reconcileSnapshots({
    linearIssues: [validAnchorIssue],
    githubByUrl: new Map([
      [
        url,
        githubIssue({
          url,
          comments: [
            {
              node_id: "IC_linear_linkback_other_workspace",
              body: '<!-- linear-linkback --><p><a href="https://linear.app/outro-workspace/issue/GITHORG-70">GITHORG-70</a></p>',
              created_at: "2026-08-18T01:00:00.500Z",
              updated_at: "2026-08-18T01:00:00.500Z",
            },
          ],
        }),
      ],
    ]),
    now: NOW,
  });
  assert.equal(
    wrongWorkspace.findings.filter(
      (finding) => finding.code === "integration_linkback_mismatch",
    ).length,
    1,
  );
});

test("linkback Linear recusa downgrade HTTP", () => {
  const url = "https://github.com/LCV-Ideas-Software/.github/issues/249";
  const issue = linearIssue({
    identifier: "GITHORG-70",
    url: "https://linear.app/lcv-ideas-software/issue/GITHORG-70/reconciliar-github-e-linear",
    attachments: { nodes: [{ url }] },
    comments: {
      nodes: [
        {
          body: "This comment thread is synced to a corresponding [GitHub issue](https://github.com/LCV-Ideas-Software/.github/issues/249). All replies are synchronized.",
          createdAt: "2026-08-18T01:00:00.000Z",
          updatedAt: "2026-08-18T01:00:00.000Z",
          syncedWith: [],
          externalThread: { isConnected: true, subType: "github", url },
        },
      ],
    },
  });
  const result = reconcileSnapshots({
    linearIssues: [issue],
    githubByUrl: new Map([
      [
        url,
        githubIssue({
          url,
          comments: [
            {
              node_id: "IC_linear_linkback_http",
              body: '<!-- linear-linkback --><p><a href="http://linear.app/lcv-ideas-software/issue/GITHORG-70">GITHORG-70</a></p>',
              created_at: "2026-08-18T01:00:00.500Z",
              updated_at: "2026-08-18T01:00:00.500Z",
            },
          ],
        }),
      ],
    ]),
    now: NOW,
  });

  assert.equal(
    result.findings.filter(
      (finding) => finding.code === "integration_linkback_mismatch",
    ).length,
    1,
  );
});

test("detecta atraso de edição em cada direção depois da tolerância", () => {
  const url = "https://github.com/LCV-Ideas-Software/.github/issues/260";
  const run = ({ linearUpdatedAt, githubUpdatedAt, linearBody, githubBody }) =>
    reconcileSnapshots({
      linearIssues: [
        linearIssue({
          attachments: { nodes: [{ url }] },
          syncedWith: [{ id: "I_issue", service: "github" }],
          comments: {
            nodes: [
              {
                body: linearBody,
                createdAt: "2026-08-18T01:00:00Z",
                updatedAt: linearUpdatedAt,
                syncedWith: [{ id: "IC_stale", service: "github" }],
                externalThread: null,
              },
            ],
          },
        }),
      ],
      githubByUrl: new Map([
        [
          url,
          githubIssue({
            url,
            comments: [
              {
                node_id: "IC_stale",
                body: githubBody,
                created_at: "2026-08-18T01:00:00Z",
                updated_at: githubUpdatedAt,
              },
            ],
          }),
        ],
      ]),
      now: NOW,
    });

  const linearBehind = run({
    linearUpdatedAt: "2026-08-18T01:00:00Z",
    githubUpdatedAt: "2026-08-18T02:00:00Z",
    linearBody: "Conteúdo original",
    githubBody: "Conteúdo editado no GitHub",
  });
  assert.equal(
    linearBehind.findings.filter(
      (finding) => finding.code === "comment_sync_stale",
    ).length,
    1,
  );

  const githubBehind = run({
    linearUpdatedAt: "2026-08-18T02:00:00Z",
    githubUpdatedAt: "2026-08-18T01:00:00Z",
    linearBody: "Conteúdo editado no Linear",
    githubBody: "Conteúdo original",
  });
  assert.equal(
    githubBehind.findings.filter(
      (finding) => finding.code === "comment_sync_stale_to_github",
    ).length,
    1,
  );

  const sameContent = run({
    linearUpdatedAt: "2026-08-18T01:00:00Z",
    githubUpdatedAt: "2026-08-18T02:00:00Z",
    linearBody: "Mesmo conteúdo semântico",
    githubBody: "Mesmo conteúdo semântico",
  });
  assert.equal(
    sameContent.findings.some((finding) =>
      ["comment_sync_stale", "comment_sync_stale_to_github"].includes(
        finding.code,
      ),
    ),
    false,
  );
});

test("pareia edição por thread e createdAt mesmo sem external ID", () => {
  const url = "https://github.com/LCV-Ideas-Software/.github/issues/260";
  const issue = linearIssue({
    attachments: { nodes: [{ url }] },
    comments: {
      nodes: [
        {
          body: "Conteúdo original",
          createdAt: "2026-08-18T00:00:00Z",
          updatedAt: "2026-08-18T00:00:00Z",
          syncedWith: [],
          externalThread: {
            isConnected: true,
            name: null,
            subType: null,
            type: "integration",
            url,
          },
        },
      ],
    },
  });
  const result = reconcileSnapshots({
    linearIssues: [issue],
    githubByUrl: new Map([
      [
        url,
        githubIssue({
          url,
          comments: [
            {
              node_id: "IC_edited_without_linear_id",
              body: "Conteúdo editado",
              created_at: "2026-08-18T00:00:00Z",
              updated_at: "2026-08-18T02:00:00Z",
            },
          ],
        }),
      ],
    ]),
    now: NOW,
  });

  assert.equal(
    result.findings.filter((finding) => finding.code === "comment_sync_stale")
      .length,
    1,
  );
  assert.equal(
    result.findings.some((finding) =>
      ["comment_sync_gap", "comment_sync_gap_to_github"].includes(finding.code),
    ),
    false,
  );
});

test("reconhece comentário sincronizado por node_id mesmo com Markdown transformado", () => {
  const github = {
    node_id: "IC_kwDOAA",
    body: "- Item\n\nhttps://example.com/x",
    created_at: "2026-08-18T02:00:00.000Z",
    updated_at: "2026-08-18T02:00:00.000Z",
  };
  const linear = {
    body: "* Item\n\n<https://example.com/x>",
    createdAt: "2026-08-18T02:00:00.000Z",
    updatedAt: "2026-08-18T02:00:00.000Z",
    syncedWith: [{ id: "IC_kwDOAA", service: "github" }],
  };

  assert.equal(isGithubSyncedComment(linear, github), true);
  assert.equal(
    canonicalizeCommentBody(linear.body),
    canonicalizeCommentBody(github.body),
  );
});

test("reconhece comentário sincronizado pelo id numérico externo", () => {
  assert.equal(
    isGithubSyncedComment(
      {
        body: "Conteúdo Linear transformado",
        createdAt: "2026-08-18T01:00:00Z",
        syncedWith: [{ id: "123456", service: "github" }],
      },
      {
        id: 123456,
        node_id: "IC_node_diferente",
        body: "Conteúdo GitHub",
        created_at: "2026-08-18T02:00:00Z",
      },
    ),
    true,
  );
});

test("external ID GitHub contraditório nunca cai no pareamento heurístico", () => {
  const url = "https://github.com/LCV-Ideas-Software/.github/issues/260";
  const createdAt = "2026-08-18T01:00:00Z";
  const issue = linearIssue({
    attachments: { nodes: [{ url }] },
    comments: {
      nodes: [
        {
          body: "Mesmo corpo e horário",
          createdAt,
          updatedAt: createdAt,
          syncedWith: [{ id: "NODE_A", service: "github" }],
          externalThread: {
            isConnected: true,
            subType: "github",
            url,
          },
        },
      ],
    },
  });
  const result = reconcileSnapshots({
    linearIssues: [issue],
    githubByUrl: new Map([
      [
        url,
        githubIssue({
          url,
          comments: [
            {
              node_id: "NODE_B",
              body: "Mesmo corpo e horário",
              created_at: createdAt,
              updated_at: createdAt,
            },
          ],
        }),
      ],
    ]),
    now: NOW,
  });

  assert.equal(
    result.findings.filter((finding) => finding.code === "comment_sync_gap")
      .length,
    1,
  );
  assert.equal(
    result.findings.filter(
      (finding) => finding.code === "comment_sync_gap_to_github",
    ).length,
    1,
  );
});

test("usa data e corpo canonicalizado como fallback do comentário", () => {
  const github = {
    node_id: "IC_kwDOAA",
    body: "- Item\nhttps://example.com/x",
    created_at: "2026-08-18T02:00:00.000Z",
  };
  const linear = {
    body: "* Item\n<https://example.com/x>",
    createdAt: "2026-08-18T02:00:00.700Z",
    syncedWith: [],
  };
  assert.equal(isGithubSyncedComment(linear, github), true);
});

test("comentário Linear local coincidente não satisfaz o sync GitHub", () => {
  const url = "https://github.com/LCV-Ideas-Software/.github/issues/260";
  const createdAt = "2026-08-18T01:00:00.000Z";
  const issue = linearIssue({
    attachments: { nodes: [{ url }] },
    syncedWith: [{ id: "I_issue", service: "github" }],
    comments: {
      nodes: [
        {
          body: "coincidente",
          createdAt,
          updatedAt: createdAt,
          syncedWith: [],
          externalThread: null,
        },
      ],
    },
  });
  const result = reconcileSnapshots({
    linearIssues: [issue],
    githubByUrl: new Map([
      [
        url,
        githubIssue({
          url,
          comments: [
            {
              node_id: "GH1",
              body: "coincidente",
              created_at: createdAt,
              updated_at: createdAt,
            },
          ],
        }),
      ],
    ]),
    now: NOW,
  });

  assert.equal(
    result.findings.filter((finding) => finding.code === "comment_sync_gap")
      .length,
    1,
  );
});

test("detecta thread GitHub desconectada no Linear", () => {
  const url = "https://github.com/LCV-Ideas-Software/.github/issues/260";
  const issue = linearIssue({
    attachments: { nodes: [{ url }] },
    syncedWith: [{ id: "I_issue", service: "github" }],
    comments: {
      nodes: [
        {
          body: "checkpoint",
          externalThread: {
            isConnected: false,
            subType: "github",
            type: "integration",
          },
        },
      ],
    },
  });
  const result = reconcileSnapshots({
    linearIssues: [issue],
    githubByUrl: new Map([[url, githubIssue({ url })]]),
    now: NOW,
  });
  assert.equal(
    result.findings.filter(
      (finding) => finding.code === "comment_sync_disconnected",
    ).length,
    1,
  );
});

test("externalThread.url suplementar audita comentários sem virar gêmeo canônico", () => {
  const url = "https://github.com/LCV-Ideas-Software/.github/issues/271";
  const issue = linearIssue({
    identifier: "GITHORG-71",
    title: "Auditar thread suplementar",
    attachments: { nodes: [] },
    syncedWith: [],
    comments: {
      nodes: [
        {
          id: "linear-thread-root",
          body: "Thread sincronizada",
          createdAt: "2026-08-18T01:00:00Z",
          updatedAt: "2026-08-18T01:00:00Z",
          syncedWith: [],
          externalThread: {
            id: "github-thread",
            isConnected: true,
            subType: "github",
            type: "integration",
            url,
          },
        },
      ],
    },
  });
  const result = reconcileSnapshots({
    linearIssues: [issue],
    githubByUrl: new Map([
      [
        url,
        githubIssue({
          url,
          state: "closed",
          comments: [
            {
              node_id: "IC_missing",
              body: "Comentário GitHub antigo ausente",
              created_at: "2026-08-17T23:00:00Z",
              updated_at: "2026-08-17T23:00:00Z",
            },
          ],
        }),
      ],
    ]),
    now: NOW,
  });

  assert.equal(result.auditedGithubLinks, 1);
  assert.equal(
    result.findings.some((finding) => finding.code === "comment_sync_gap"),
    true,
  );
  assert.equal(
    result.findings.some(
      (finding) => finding.code === "missing_github_issue_attachment",
    ),
    true,
  );
  assert.equal(
    result.findings.some((finding) => finding.code === "status_divergence"),
    false,
  );
});

test("thread suplementar não contamina a auditoria do gêmeo canônico", () => {
  const canonicalUrl =
    "https://github.com/LCV-Ideas-Software/.github/issues/272";
  const supplementaryUrl =
    "https://github.com/LCV-Ideas-Software/.github/issues/273";
  const issue = linearIssue({
    identifier: "GITHORG-72",
    attachments: { nodes: [{ url: canonicalUrl }] },
    comments: {
      nodes: [
        {
          id: "linear-supplementary-comment",
          body: "Comentário do thread suplementar",
          createdAt: "2026-08-17T23:00:00Z",
          updatedAt: "2026-08-17T23:00:00Z",
          syncedWith: [{ id: "IC_supplementary", service: "github" }],
          externalThread: {
            id: "supplementary-thread",
            isConnected: true,
            subType: "github",
            type: "integration",
            url: supplementaryUrl,
          },
        },
      ],
    },
  });
  const result = reconcileSnapshots({
    linearIssues: [issue],
    githubByUrl: new Map([
      [canonicalUrl, githubIssue({ url: canonicalUrl, comments: [] })],
      [
        supplementaryUrl,
        githubIssue({
          url: supplementaryUrl,
          comments: [
            {
              node_id: "IC_supplementary",
              body: "Comentário do thread suplementar",
              created_at: "2026-08-17T23:00:00Z",
              updated_at: "2026-08-17T23:00:00Z",
            },
          ],
        }),
      ],
    ]),
    now: NOW,
  });

  assert.equal(
    result.findings.some((finding) =>
      ["comment_sync_gap", "comment_sync_gap_to_github"].includes(finding.code),
    ),
    false,
  );
});

test("externalThread GitHub fora da organização falha explicitamente", () => {
  const canonicalUrl =
    "https://github.com/LCV-Ideas-Software/.github/issues/274";
  const issue = linearIssue({
    identifier: "GITHORG-73",
    attachments: { nodes: [{ url: canonicalUrl }] },
    comments: {
      nodes: [
        {
          id: "out-of-scope-thread",
          body: "Thread externa",
          createdAt: "2026-08-17T23:00:00Z",
          syncedWith: [],
          externalThread: {
            id: "other-org-thread",
            isConnected: true,
            subType: null,
            name: null,
            type: "integration",
            url: "https://github.com/Other-Org/other/issues/9",
          },
        },
      ],
    },
  });
  const result = reconcileSnapshots({
    linearIssues: [issue],
    githubByUrl: new Map([
      [canonicalUrl, githubIssue({ url: canonicalUrl, comments: [] })],
    ]),
    now: NOW,
  });

  assert.equal(
    result.findings.filter(
      (finding) =>
        finding.code === "external_thread_url_invalid_or_out_of_scope",
    ).length,
    1,
  );
});

test("externalThread identificado somente pela URL ainda ativa auditoria", () => {
  const url = "https://github.com/LCV-Ideas-Software/.github/issues/311";
  const issue = linearIssue({
    identifier: "GITHORG-74",
    attachments: { nodes: [{ url }] },
    comments: {
      nodes: [
        {
          id: "url-only-thread",
          body: "Comentário recente no Linear",
          createdAt: "2026-08-18T02:50:00Z",
          updatedAt: "2026-08-18T02:50:00Z",
          syncedWith: [],
          externalThread: {
            isConnected: true,
            name: null,
            subType: null,
            type: "integration",
            url,
          },
        },
      ],
    },
  });
  const result = reconcileSnapshots({
    linearIssues: [issue],
    githubByUrl: new Map([
      [
        url,
        githubIssue({
          url,
          comments: [
            {
              node_id: "IC_missing",
              body: "Comentário GitHub antigo ainda não sincronizado",
              created_at: "2026-08-18T01:00:00Z",
              updated_at: "2026-08-18T01:00:00Z",
            },
          ],
        }),
      ],
    ]),
    now: NOW,
  });

  assert.equal(
    result.findings.filter((finding) => finding.code === "comment_sync_gap")
      .length,
    1,
  );
});

test("classifica duplicata forte e similaridade sem vínculo", () => {
  const commonDescription =
    "Mesmo escopo funcional, mesmo repositório, mesmo carrier e mesma entrega auditável.";
  const umbrella = linearIssue({
    identifier: "LCV-16",
    title:
      "Governança: registrar todo trabalho em Projects, Issues e Discussions",
    description: commonDescription,
    team: { key: "LCV", name: "LCV Ideas & Software" },
    attachments: {
      nodes: [
        {
          url: "https://github.com/LCV-Ideas-Software/astrologo-app/issues/304",
        },
      ],
    },
  });
  const duplicate = linearIssue({
    identifier: "ASTROLO-8",
    title: umbrella.title,
    description: commonDescription,
    team: { key: "ASTROLO", name: "astrologo-app" },
    attachments: {
      nodes: [
        {
          url: "https://github.com/LCV-Ideas-Software/astrologo-app/issues/305",
        },
      ],
    },
  });
  const result = reconcileSnapshots({
    linearIssues: [umbrella, duplicate],
    githubByUrl: new Map([
      [
        umbrella.attachments.nodes[0].url,
        githubIssue({ url: umbrella.attachments.nodes[0].url }),
      ],
      [
        duplicate.attachments.nodes[0].url,
        githubIssue({ url: duplicate.attachments.nodes[0].url }),
      ],
    ]),
    now: NOW,
  });

  assert.equal(
    result.findings.filter((finding) => finding.code === "duplicate_candidate")
      .length,
    1,
  );
});

test("detecta títulos parafraseados com descrição equivalente no mesmo repositório", () => {
  const description =
    "O login rejeita credenciais válidas depois que a sessão expira no aplicativo.";
  const first = linearIssue({
    identifier: "ASTROLO-18",
    title: "Corrigir autenticação no login",
    description,
    team: { key: "ASTROLO", name: "astrologo-app" },
    attachments: {
      nodes: [
        {
          url: "https://github.com/LCV-Ideas-Software/ASTROLOGO-APP/issues/318",
        },
      ],
    },
  });
  const second = linearIssue({
    identifier: "ASTROLO-19",
    title: "Erro de autenticação ao fazer login",
    description:
      "Depois que a sessão expira no aplicativo, o login rejeita credenciais válidas.",
    team: first.team,
    attachments: {
      nodes: [
        {
          url: "https://github.com/LCV-Ideas-Software/astrologo-app/issues/319",
        },
      ],
    },
  });
  const result = reconcileSnapshots({
    linearIssues: [first, second],
    githubByUrl: new Map([
      [first.attachments.nodes[0].url, githubIssue()],
      [second.attachments.nodes[0].url, githubIssue()],
    ]),
    now: NOW,
  });

  assert.equal(
    result.findings.filter(
      (finding) => finding.code === "similar_issue_unlinked",
    ).length,
    1,
  );
  assert.equal(
    result.findings.some((finding) => finding.code === "duplicate_candidate"),
    false,
  );
});

test("detecta duplicata com título e descrição em alfabeto não latino", () => {
  const description =
    "Одинаковая область работы использует тот же репозиторий и результат";
  const firstUrl =
    "https://github.com/LCV-Ideas-Software/astrologo-app/issues/336";
  const secondUrl =
    "https://github.com/LCV-Ideas-Software/astrologo-app/issues/337";
  const result = reconcileSnapshots({
    linearIssues: [
      linearIssue({
        identifier: "ASTROLO-36",
        title: "Ошибка авторизации",
        description,
        attachments: { nodes: [{ url: firstUrl }] },
      }),
      linearIssue({
        identifier: "ASTROLO-37",
        title: "Ошибка авторизации",
        description,
        attachments: { nodes: [{ url: secondUrl }] },
      }),
    ],
    githubByUrl: new Map([
      [firstUrl, githubIssue({ url: firstUrl })],
      [secondUrl, githubIssue({ url: secondUrl })],
    ]),
    now: NOW,
  });

  assert.equal(
    result.findings.filter((finding) => finding.code === "duplicate_candidate")
      .length,
    1,
  );
});

test("não colide marcas semânticas de alfabetos não latinos", () => {
  const description =
    "Mesmo escopo funcional com entrega auditável no repositório compartilhado";
  const firstUrl =
    "https://github.com/LCV-Ideas-Software/astrologo-app/issues/338";
  const secondUrl =
    "https://github.com/LCV-Ideas-Software/astrologo-app/issues/339";
  const result = reconcileSnapshots({
    linearIssues: [
      linearIssue({
        identifier: "ASTROLO-38",
        title: "が",
        description,
        attachments: { nodes: [{ url: firstUrl }] },
      }),
      linearIssue({
        identifier: "ASTROLO-39",
        title: "か",
        description,
        attachments: { nodes: [{ url: secondUrl }] },
      }),
    ],
    githubByUrl: new Map([
      [firstUrl, githubIssue({ url: firstUrl })],
      [secondUrl, githubIssue({ url: secondUrl })],
    ]),
    now: NOW,
  });

  assert.equal(
    result.findings.some((finding) =>
      ["duplicate_candidate", "similar_issue_unlinked"].includes(finding.code),
    ),
    false,
  );
});

test("não aproxima paráfrases sem repositório comum ou descrição informativa", () => {
  const richDescription =
    "O login rejeita credenciais válidas depois que a sessão expira no aplicativo.";
  const scenarios = [
    {
      leftRepo: "astrologo-app",
      rightRepo: "maestro-app",
      leftDescription: richDescription,
      rightDescription: richDescription,
    },
    {
      leftRepo: "astrologo-app",
      rightRepo: "astrologo-app",
      leftDescription: "Erro no login.",
      rightDescription: "Erro no login.",
    },
    {
      leftRepo: "astrologo-app",
      rightRepo: "astrologo-app",
      leftDescription: richDescription,
      rightDescription:
        "A página de perfil perde o avatar salvo quando o usuário troca o idioma.",
    },
  ];

  for (const [index, scenario] of scenarios.entries()) {
    const leftUrl = `https://github.com/LCV-Ideas-Software/${scenario.leftRepo}/issues/${330 + index * 2}`;
    const rightUrl = `https://github.com/LCV-Ideas-Software/${scenario.rightRepo}/issues/${331 + index * 2}`;
    const result = reconcileSnapshots({
      linearIssues: [
        linearIssue({
          identifier: `LEFT-${index + 1}`,
          title: "Corrigir autenticação no login",
          description: scenario.leftDescription,
          attachments: { nodes: [{ url: leftUrl }] },
        }),
        linearIssue({
          identifier: `RIGHT-${index + 1}`,
          title: "Erro de autenticação ao fazer login",
          description: scenario.rightDescription,
          attachments: { nodes: [{ url: rightUrl }] },
        }),
      ],
      githubByUrl: new Map([
        [leftUrl, githubIssue({ url: leftUrl })],
        [rightUrl, githubIssue({ url: rightUrl })],
      ]),
      now: NOW,
    });

    assert.equal(
      result.findings.some((finding) =>
        ["duplicate_candidate", "similar_issue_unlinked"].includes(
          finding.code,
        ),
      ),
      false,
    );
  }
});

test("descrições vazias não sustentam duplicata forte", () => {
  const firstUrl =
    "https://github.com/LCV-Ideas-Software/astrologo-app/issues/338";
  const secondUrl =
    "https://github.com/LCV-Ideas-Software/astrologo-app/issues/339";
  const result = reconcileSnapshots({
    linearIssues: [
      linearIssue({
        identifier: "ASTROLO-38",
        title: "Corrigir problema no login",
        description: "",
        attachments: { nodes: [{ url: firstUrl }] },
      }),
      linearIssue({
        identifier: "ASTROLO-39",
        title: "Corrigir problema no login",
        description: "",
        attachments: { nodes: [{ url: secondUrl }] },
      }),
    ],
    githubByUrl: new Map([
      [firstUrl, githubIssue({ url: firstUrl })],
      [secondUrl, githubIssue({ url: secondUrl })],
    ]),
    now: NOW,
  });

  assert.equal(
    result.findings.some((finding) => finding.code === "duplicate_candidate"),
    false,
  );
  assert.equal(
    result.findings.some(
      (finding) => finding.code === "similar_issue_unlinked",
    ),
    false,
  );

  const largeEmptySet = reconcileSnapshots({
    linearIssues: Array.from({ length: 400 }, (_, index) =>
      linearIssue({
        identifier: `EMPTY-${index + 1}`,
        title: "Título repetido sem descrição",
        description: "",
      }),
    ),
    githubByUrl: new Map(),
    now: NOW,
    requireGithubIssueAttachment: false,
  });
  assert.equal(
    largeEmptySet.findings.some(
      (finding) => finding.code === "duplicate_scan_incomplete",
    ),
    false,
  );
});

test("pré-computa features e evita comparar títulos de todos os pares", () => {
  let titleReads = 0;
  const issues = Array.from({ length: 80 }, (_, index) => {
    const issue = linearIssue({
      identifier: `PERF-${index + 1}`,
      description: `Escopo exclusivo número ${index} sem relação com os demais registros`,
      team: { key: "PERF", name: "performance-only" },
    });
    Object.defineProperty(issue, "title", {
      enumerable: true,
      get() {
        titleReads += 1;
        return `Título exclusivo ${index}`;
      },
    });
    return issue;
  });

  reconcileSnapshots({
    linearIssues: issues,
    githubByUrl: new Map(),
    now: NOW,
    requireGithubIssueAttachment: false,
  });

  assert.ok(
    titleReads <= issues.length * 3,
    `leituras de título: ${titleReads}`,
  );
});

test("limita streaming de candidatos sem materializar milhões de pares", () => {
  const githubByUrl = new Map();
  const issues = Array.from({ length: 2_000 }, (_, index) => {
    const url = `https://github.com/LCV-Ideas-Software/.github/issues/${10_000 + index}`;
    githubByUrl.set(url, githubIssue({ url }));
    return linearIssue({
      identifier: `SCALE-${index + 1}`,
      title: `Autenticação login módulo${index}`,
      description: `alpha${index} beta${index} gamma${index} delta${index} epsilon${index}`,
      team: { key: "SCALE", name: "linear-scale-only" },
      attachments: { nodes: [{ url }] },
    });
  });
  const startedAt = performance.now();
  const result = reconcileSnapshots({
    linearIssues: issues,
    githubByUrl,
    now: NOW,
    requireGithubIssueAttachment: false,
  });
  const elapsedMs = performance.now() - startedAt;

  assert.equal(
    result.findings.some(
      (finding) =>
        finding.severity === "incomplete" &&
        finding.code === "duplicate_scan_incomplete",
    ),
    true,
  );
  assert.equal(
    result.findings.some((finding) =>
      ["duplicate_candidate", "similar_issue_unlinked"].includes(finding.code),
    ),
    false,
  );
  assert.equal(determineExitCode(result), 2);
  assert.ok(elapsedMs < 2_000, `varredura levou ${Math.round(elapsedMs)} ms`);
});

test("detecta duplicata forte dentro do mesmo time individual", () => {
  const description =
    "Mesmo escopo funcional, mesmo carrier e mesma entrega auditável no repositório.";
  const first = linearIssue({
    identifier: "ASTROLO-20",
    title: "Corrigir o mesmo problema",
    description,
    team: { key: "ASTROLO", name: "astrologo-app" },
    attachments: {
      nodes: [
        {
          url: "https://github.com/LCV-Ideas-Software/astrologo-app/issues/320",
        },
      ],
    },
  });
  const second = linearIssue({
    identifier: "ASTROLO-21",
    title: first.title,
    description,
    team: first.team,
    attachments: {
      nodes: [
        {
          url: "https://github.com/LCV-Ideas-Software/astrologo-app/issues/321",
        },
      ],
    },
  });
  const result = reconcileSnapshots({
    linearIssues: [first, second],
    githubByUrl: new Map([
      [first.attachments.nodes[0].url, githubIssue()],
      [second.attachments.nodes[0].url, githubIssue()],
    ]),
    now: NOW,
  });

  assert.equal(
    result.findings.filter((finding) => finding.code === "duplicate_candidate")
      .length,
    1,
  );
});

test("não repete finding quando a duplicata já está explicitamente reconciliada", () => {
  const description =
    "Mesmo escopo funcional, mesmo repositório, mesma entrega e mesmo resultado.";
  const umbrella = linearIssue({
    identifier: "LCV-16",
    title: "Mesmo título",
    description,
    team: { key: "LCV", name: "LCV Ideas & Software" },
    relations: {
      nodes: [
        {
          type: "duplicate",
          issue: { identifier: "LCV-16" },
          relatedIssue: { identifier: "ASTROLO-8" },
        },
      ],
    },
  });
  const specific = linearIssue({
    identifier: "ASTROLO-8",
    title: "Mesmo título",
    description,
    team: { key: "ASTROLO", name: "astrologo-app" },
  });
  const result = reconcileSnapshots({
    linearIssues: [umbrella, specific],
    githubByUrl: new Map(),
    now: NOW,
    requireGithubIssueAttachment: false,
  });

  assert.equal(
    result.findings.some((finding) => finding.code === "duplicate_candidate"),
    false,
  );
});

test("duplicatas da mesma canônica pertencem ao mesmo grupo reconciliado", () => {
  const description =
    "Mesmo escopo funcional, mesmo repositório, mesma entrega e mesmo resultado.";
  const makeIssue = (identifier, number, relatedIssue) => {
    const url = `https://github.com/LCV-Ideas-Software/astrologo-app/issues/${number}`;
    return linearIssue({
      identifier,
      title: "Corrigir o mesmo comportamento",
      description,
      team: { key: "ASTROLO", name: "astrologo-app" },
      attachments: { nodes: [{ url }] },
      relations: relatedIssue
        ? {
            nodes: [
              {
                type: "duplicate",
                issue: { identifier },
                relatedIssue: { identifier: relatedIssue },
              },
            ],
          }
        : { nodes: [] },
    });
  };
  const canonical = makeIssue("ASTROLO-30", 330);
  const firstDuplicate = makeIssue("ASTROLO-31", 331, canonical.identifier);
  const secondDuplicate = makeIssue("ASTROLO-32", 332, canonical.identifier);
  const issues = [canonical, firstDuplicate, secondDuplicate];
  const result = reconcileSnapshots({
    linearIssues: issues,
    githubByUrl: new Map(
      issues.map((issue) => {
        const url = issue.attachments.nodes[0].url;
        return [url, githubIssue({ url })];
      }),
    ),
    now: NOW,
  });

  assert.equal(
    result.findings.some((finding) =>
      ["duplicate_candidate", "similar_issue_unlinked"].includes(finding.code),
    ),
    false,
  );
});

test("grupo grande de duplicatas reconciliadas não consome o teto", () => {
  const description =
    "Mesmo escopo funcional, mesmo repositório, mesma entrega e mesmo resultado.";
  const githubByUrl = new Map();
  const issues = Array.from({ length: 400 }, (_, index) => {
    const identifier = `GROUP-${index + 1}`;
    const url = `https://github.com/LCV-Ideas-Software/astrologo-app/issues/${20_000 + index}`;
    githubByUrl.set(url, githubIssue({ url }));
    return linearIssue({
      identifier,
      title: "Corrigir comportamento já reconciliado",
      description,
      team: { key: "ASTROLO", name: "astrologo-app" },
      attachments: { nodes: [{ url }] },
      relations:
        index === 0
          ? { nodes: [] }
          : {
              nodes: [
                {
                  type: "duplicate",
                  issue: { identifier },
                  relatedIssue: { identifier: "GROUP-1" },
                },
              ],
            },
    });
  });
  const result = reconcileSnapshots({
    linearIssues: issues,
    githubByUrl,
    now: NOW,
  });

  assert.equal(
    result.findings.some(
      (finding) => finding.code === "duplicate_scan_incomplete",
    ),
    false,
  );
  assert.equal(
    result.findings.some((finding) =>
      ["duplicate_candidate", "similar_issue_unlinked"].includes(finding.code),
    ),
    false,
  );
});

test("relações não equivalentes só suprimem o par diretamente relacionado", () => {
  const description =
    "Mesmo escopo funcional, mesmo repositório, mesma entrega e mesmo resultado.";
  const makeIssue = (identifier, number, relatedIssue) => {
    const url = `https://github.com/LCV-Ideas-Software/astrologo-app/issues/${number}`;
    return linearIssue({
      identifier,
      title: "Revisar a mesma fronteira funcional",
      description,
      team: { key: "ASTROLO", name: "astrologo-app" },
      attachments: { nodes: [{ url }] },
      relations: relatedIssue
        ? {
            nodes: [
              {
                type: "related",
                issue: { identifier },
                relatedIssue: { identifier: relatedIssue },
              },
            ],
          }
        : { nodes: [] },
    });
  };
  const first = makeIssue("ASTROLO-33", 333, "ASTROLO-34");
  const middle = makeIssue("ASTROLO-34", 334, "ASTROLO-35");
  const last = makeIssue("ASTROLO-35", 335);
  const issues = [first, middle, last];
  const result = reconcileSnapshots({
    linearIssues: issues,
    githubByUrl: new Map(
      issues.map((issue) => {
        const url = issue.attachments.nodes[0].url;
        return [url, githubIssue({ url })];
      }),
    ),
    now: NOW,
  });

  assert.deepEqual(
    result.findings
      .filter((finding) => finding.code === "duplicate_candidate")
      .map((finding) => finding.issue),
    ["ASTROLO-33, ASTROLO-35"],
  );
});

test("não exige gêmeo GitHub de time que não mapeia um repositório", () => {
  const result = reconcileSnapshots({
    linearIssues: [
      linearIssue({
        identifier: "OPS-1",
        team: { key: "OPS", name: "Operações" },
      }),
    ],
    githubByUrl: new Map(),
    now: NOW,
  });
  assert.equal(
    result.findings.some(
      (finding) => finding.code === "missing_github_issue_attachment",
    ),
    false,
  );
});

test("inventário de times independe de existirem issues no time", () => {
  const result = reconcileSnapshots({
    linearIssues: [],
    githubByUrl: new Map(),
    linearTopology: {
      teams: [
        { key: "GITHORG", name: ".github-org", archivedAt: null },
        { key: "EMPTY", name: "empty-repo", archivedAt: null },
      ],
      cycles: [],
      projects: [],
      initiatives: [],
    },
    repositoryInventory: { active: [".github", "empty-repo"] },
    teamRepositories: { GITHORG: ".github", EMPTY: "empty-repo" },
    now: NOW,
  });

  assert.deepEqual(result.findings, []);
});

test("comparação de time e repositório ignora caixa", () => {
  const result = reconcileSnapshots({
    linearIssues: [],
    githubByUrl: new Map(),
    linearTopology: {
      teams: [{ key: "ASTROLO", name: "Astrologo-App", archivedAt: null }],
      cycles: [],
      projects: [],
      initiatives: [],
      documents: [],
      subteams: [],
    },
    repositoryInventory: {
      active: ["astrologo-app"],
      issues: [],
      issueAuditFailures: {},
    },
    teamRepositories: {},
    now: NOW,
  });

  assert.deepEqual(result.findings, []);
});

test("detecta time Linear individual sem repositório ativo", () => {
  const result = reconcileSnapshots({
    linearIssues: [],
    githubByUrl: new Map(),
    linearTopology: {
      teams: [
        { key: "GITHORG", name: ".github-org", archivedAt: null },
        { key: "ORPHAN", name: "repo-inexistente", archivedAt: null },
      ],
      cycles: [],
      projects: [],
      initiatives: [],
    },
    repositoryInventory: { active: [".github"] },
    teamRepositories: { GITHORG: ".github" },
    now: NOW,
  });

  assert.equal(
    result.findings.some(
      (finding) => finding.code === "linear_team_without_active_repository",
    ),
    true,
  );
});

test("time Linear-only declarado não exige repositório, mas aparece no resultado", () => {
  const result = reconcileSnapshots({
    linearIssues: [],
    githubByUrl: new Map(),
    linearTopology: {
      teams: [
        { key: "GITHORG", name: ".github-org", archivedAt: null },
        { key: "PANDROID", name: "programa-android", archivedAt: null },
      ],
      cycles: [],
      projects: [],
      initiatives: [],
      documents: [],
      subteams: [],
    },
    repositoryInventory: {
      active: [".github"],
      issues: [],
      issueAuditFailures: {},
    },
    teamRepositories: { GITHORG: ".github" },
    linearOnlyTeamKeys: ["PANDROID"],
    now: NOW,
  });

  assert.equal(
    result.findings.some(
      (finding) => finding.code === "linear_team_without_active_repository",
    ),
    false,
  );
  assert.deepEqual(result.linearOnlyTeamKeys, ["PANDROID"]);
});

test("time Linear-only não pode colidir com repo nem manter sync GitHub", () => {
  const url = "https://github.com/LCV-Ideas-Software/programa-android/issues/1";
  const result = reconcileSnapshots({
    linearIssues: [
      linearIssue({
        identifier: "PANDROID-1",
        team: { key: "PANDROID", name: "programa-android" },
        syncedWith: [
          {
            id: "native",
            service: "github",
            metadata: {
              owner: "LCV-Ideas-Software",
              repo: "programa-android",
              number: 1,
            },
          },
        ],
      }),
    ],
    githubByUrl: new Map([[url, githubIssue({ url })]]),
    linearTopology: {
      teams: [{ key: "PANDROID", name: "programa-android", archivedAt: null }],
      cycles: [],
      projects: [],
      initiatives: [],
      documents: [],
      subteams: [],
    },
    repositoryInventory: {
      active: ["programa-android"],
      issues: [{ repo: "programa-android", number: 1, url }],
      issueAuditFailures: {},
    },
    teamRepositories: {},
    linearOnlyTeamKeys: ["PANDROID"],
    now: NOW,
  });

  const codes = result.findings.map((finding) => finding.code);
  assert.ok(codes.includes("linear_only_team_repository_collision"));
  assert.ok(codes.includes("linear_only_team_github_sync"));
  assert.ok(codes.includes("linear_only_team_live_github_link"));
});

test("404 de repo privado ausente do inventário não é aceito como tombstone Linear-only", () => {
  const url = "https://github.com/LCV-Ideas-Software/private-mobile/issues/1";
  const result = reconcileSnapshots({
    linearIssues: [
      linearIssue({
        identifier: "PANDROID-1",
        team: { key: "PANDROID", name: "programa-android" },
        attachments: { nodes: [{ url }] },
      }),
    ],
    githubByUrl: new Map([[url, { auditFailure: "not_found", status: 404 }]]),
    linearTopology: {
      teams: [
        { key: "GITHORG", name: ".github-org", archivedAt: null },
        { key: "PANDROID", name: "programa-android", archivedAt: null },
      ],
      cycles: [],
      projects: [],
      initiatives: [],
      documents: [],
      subteams: [],
    },
    repositoryInventory: {
      active: [".github"],
      issues: [],
      issueAuditFailures: {},
    },
    teamRepositories: {},
    linearOnlyTeamKeys: ["PANDROID"],
    now: NOW,
  });

  assert.equal(
    result.findings.some(
      (finding) =>
        finding.code === "github_link_unreadable" &&
        finding.severity === "incomplete",
    ),
    true,
  );
  assert.equal(determineExitCode(result), 2);
});

test("410 confirmado é aceito como tombstone em time Linear-only", () => {
  const url = "https://github.com/LCV-Ideas-Software/ultrabrain-mcp/issues/119";
  const result = reconcileSnapshots({
    linearIssues: [
      linearIssue({
        identifier: "PANDROID-1",
        team: { key: "PANDROID", name: "programa-android" },
        attachments: { nodes: [{ url }] },
      }),
    ],
    githubByUrl: new Map([[url, { auditFailure: "gone", status: 410 }]]),
    linearTopology: {
      teams: [
        { key: "GITHORG", name: ".github-org", archivedAt: null },
        { key: "ULTRABR", name: "ultrabrain-mcp", archivedAt: null },
        { key: "PANDROID", name: "programa-android", archivedAt: null },
      ],
      cycles: [],
      projects: [],
      initiatives: [],
      documents: [],
      subteams: [],
    },
    repositoryInventory: {
      active: [".github", "ultrabrain-mcp"],
      issues: [],
      issueAuditFailures: {},
    },
    teamRepositories: {},
    linearOnlyTeamKeys: ["PANDROID"],
    now: NOW,
  });

  assert.deepEqual(result.findings, []);
});

test("exceção Linear-only desconhecida falha", () => {
  const result = reconcileSnapshots({
    linearIssues: [],
    githubByUrl: new Map(),
    linearTopology: {
      teams: [{ key: "GITHORG", name: ".github-org", archivedAt: null }],
      cycles: [],
      projects: [],
      initiatives: [],
      documents: [],
      subteams: [],
    },
    repositoryInventory: {
      active: [".github"],
      issues: [],
      issueAuditFailures: {},
    },
    teamRepositories: { GITHORG: ".github" },
    linearOnlyTeamKeys: ["PANDROID"],
    now: NOW,
  });

  assert.equal(
    result.findings.some(
      (finding) => finding.code === "linear_only_team_unknown",
    ),
    true,
  );
});

test("time Linear retired não satisfaz repositório ativo", () => {
  const result = reconcileSnapshots({
    linearIssues: [],
    githubByUrl: new Map(),
    linearTopology: {
      teams: [
        {
          key: "GITHORG",
          name: ".github-org",
          archivedAt: null,
          retiredAt: "2026-08-18T00:00:00Z",
        },
      ],
      cycles: [],
      projects: [],
      initiatives: [],
    },
    repositoryInventory: { active: [".github"] },
    teamRepositories: { GITHORG: ".github" },
    now: NOW,
  });

  assert.equal(
    result.findings.some((finding) => finding.code === "missing_linear_team"),
    true,
  );
});

test("exige que o time guarda-chuva LCV não contenha nenhuma issue", () => {
  const openUmbrella = linearIssue({
    identifier: "LCV-16",
    team: { key: "LCV", name: "LCV Ideas & Software" },
  });
  const closedUmbrella = linearIssue({
    identifier: "LCV-17",
    team: { key: "LCV", name: "LCV Ideas & Software" },
    state: { type: "completed", name: "Concluido" },
  });
  const result = reconcileSnapshots({
    linearIssues: [openUmbrella, closedUmbrella],
    githubByUrl: new Map(),
    now: NOW,
    requireGithubIssueAttachment: false,
  });
  assert.deepEqual(
    result.findings
      .filter((finding) => finding.code === "umbrella_issue_present")
      .map((finding) => finding.issue),
    ["LCV-16", "LCV-17"],
  );
});

test("detecta entidades de trabalho no LCV, mas permite seus sub-times", () => {
  const result = reconcileSnapshots({
    linearIssues: [],
    githubByUrl: new Map(),
    linearTopology: {
      cycles: [{ id: "cycle-1", name: "Ciclo legado" }],
      projects: [{ id: "project-1", name: "Projeto legado" }],
      initiatives: [{ id: "initiative-1", name: "Iniciativa legada" }],
      documents: [{ id: "document-1", name: "Documento legado" }],
      subteams: [{ id: "team-1", name: "Subtime legado" }],
    },
    now: NOW,
  });
  assert.deepEqual(result.findings.map((finding) => finding.code).sort(), [
    "umbrella_cycle_present",
    "umbrella_document_present",
    "umbrella_initiative_present",
    "umbrella_project_present",
  ]);
});

test("detecta Issue GitHub sem gêmeo Linear", () => {
  const url = "https://github.com/LCV-Ideas-Software/.github/issues/999";
  const result = reconcileSnapshots({
    linearIssues: [],
    githubByUrl: new Map(),
    repositoryInventory: {
      active: [],
      issues: [{ repo: ".github", number: 999, url }],
      issueAuditFailures: {},
    },
    now: NOW,
    teamRepositories: {},
  });

  assert.equal(
    result.findings.some(
      (finding) => finding.code === "github_issue_without_linear_twin",
    ),
    true,
  );
});

test("detecta dois gêmeos Linear para o mesmo Issue GitHub", () => {
  const url = "https://github.com/LCV-Ideas-Software/.github/issues/260";
  const first = linearIssue({
    identifier: "GITHORG-70",
    title: "Primeiro tracker",
    attachments: { nodes: [{ url }] },
  });
  const second = linearIssue({
    identifier: "GITHORG-71",
    title: "Segundo tracker",
    attachments: { nodes: [{ url }] },
  });
  const result = reconcileSnapshots({
    linearIssues: [first, second],
    githubByUrl: new Map([[url, githubIssue({ url })]]),
    repositoryInventory: {
      active: [],
      issues: [{ repo: ".github", number: 260, url }],
      issueAuditFailures: {},
    },
    now: NOW,
  });

  assert.equal(
    result.findings.filter(
      (finding) => finding.code === "github_issue_multiple_linear_twins",
    ).length,
    1,
  );
});

test("repo inacessível torna a auditoria inconclusiva e usa exit code 2", () => {
  const url = "https://github.com/LCV-Ideas-Software/.github-private/issues/41";
  const result = reconcileSnapshots({
    linearIssues: [
      linearIssue({
        team: { key: "GITPRIV", name: ".github-private" },
        attachments: { nodes: [{ url }] },
      }),
    ],
    githubByUrl: new Map([[url, { auditFailure: "forbidden", status: 403 }]]),
    now: NOW,
  });
  assert.equal(result.findings[0].severity, "incomplete");
  assert.equal(determineExitCode(result), 2);
});

test("404 permanece inconclusivo quando o inventário de Issues também falhou", () => {
  const url = "https://github.com/LCV-Ideas-Software/.github-private/issues/41";
  const issue = linearIssue({
    team: { key: "GITPRIV", name: ".github-private" },
    attachments: { nodes: [{ url }] },
  });
  const hidden = reconcileSnapshots({
    linearIssues: [issue],
    githubByUrl: new Map([[url, { auditFailure: "not_found", status: 404 }]]),
    repositoryInventory: {
      active: [".github", ".github-private"],
      issues: [],
      issueAuditFailures: {
        ".github-private": { kind: "forbidden", status: 403 },
      },
    },
    now: NOW,
  });
  assert.equal(
    hidden.findings.some(
      (finding) =>
        finding.code === "github_link_unreadable" &&
        finding.severity === "incomplete",
    ),
    true,
  );
});

test("404 permanece inconclusivo quando o inventário organizacional falhou", () => {
  const url = "https://github.com/LCV-Ideas-Software/.github/issues/999";
  const issue = linearIssue({ attachments: { nodes: [{ url }] } });
  const result = reconcileSnapshots({
    linearIssues: [issue],
    githubByUrl: new Map([[url, { auditFailure: "not_found", status: 404 }]]),
    repositoryInventory: {
      auditFailure: "forbidden",
      status: 403,
      active: [".github"],
      issues: [],
      issueAuditFailures: {},
    },
    now: NOW,
  });

  assert.equal(
    result.findings.some((finding) => finding.code === "github_link_missing"),
    false,
  );
  assert.equal(determineExitCode(result), 2);
});

test("404 é link removido quando o inventário completo prova ausência", () => {
  const url = "https://github.com/LCV-Ideas-Software/.github/issues/999";
  const issue = linearIssue({ attachments: { nodes: [{ url }] } });
  const result = reconcileSnapshots({
    linearIssues: [issue],
    githubByUrl: new Map([[url, { auditFailure: "not_found", status: 404 }]]),
    repositoryInventory: {
      active: [".github"],
      issues: [],
      issueAuditFailures: {},
    },
    linearTopology: {
      teams: [{ key: "GITHORG", name: ".github-org" }],
      cycles: [],
      projects: [],
      initiatives: [],
      documents: [],
      subteams: [],
    },
    now: NOW,
  });

  assert.equal(
    result.findings.some(
      (finding) =>
        finding.code === "github_link_missing" && finding.severity === "error",
    ),
    true,
  );
});

test("comparação de gêmeos GitHub ignora caixa do repositório", () => {
  const linearUrl =
    "https://github.com/LCV-Ideas-Software/ASTROLOGO-APP/issues/320";
  const inventoryUrl =
    "https://github.com/LCV-Ideas-Software/astrologo-app/issues/320";
  const issue = linearIssue({
    identifier: "ASTROLO-20",
    team: { key: "ASTROLO", name: "astrologo-app" },
    attachments: { nodes: [{ url: linearUrl }] },
  });
  const result = reconcileSnapshots({
    linearIssues: [issue],
    githubByUrl: new Map([[linearUrl, githubIssue({ url: linearUrl })]]),
    repositoryInventory: {
      active: ["astrologo-app"],
      issues: [{ repo: "astrologo-app", number: 320, url: inventoryUrl }],
      issueAuditFailures: {},
    },
    linearTopology: {
      teams: [{ key: "ASTROLO", name: "astrologo-app" }],
      cycles: [],
      projects: [],
      initiatives: [],
      documents: [],
      subteams: [],
    },
    now: NOW,
  });

  assert.equal(
    result.findings.some(
      (finding) => finding.code === "github_issue_without_linear_twin",
    ),
    false,
  );
});

test("cliente GitHub recusa qualquer método diferente de GET", async () => {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    calls.push(options.method);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  await githubGet("/rate_limit", "token", fetchImpl);
  assert.deepEqual(calls, ["GET"]);
  await assert.rejects(
    () => githubGet("/rate_limit", "token", fetchImpl, { method: "POST" }),
    /somente GET/i,
  );
});

test("inventário GitHub inclui fork ativo e exclui somente arquivado", async () => {
  const inventory = await readGithubRepositoryInventory({
    organization: "LCV-Ideas-Software",
    token: "read-only",
    fetchImpl: async (url) => {
      if (url.includes("/orgs/")) {
        return new Response(
          JSON.stringify([
            {
              name: "fork-ativo",
              archived: false,
              fork: true,
              has_issues: true,
            },
            {
              name: "repo-ativo",
              archived: false,
              fork: false,
              has_issues: false,
            },
            {
              name: "repo-arquivado",
              archived: true,
              fork: false,
              has_issues: true,
            },
          ]),
          { status: 200 },
        );
      }
      assert.match(url, /repos\/LCV-Ideas-Software\/fork-ativo\/issues/u);
      return new Response(
        JSON.stringify([
          { number: 1, state: "open", state_reason: null },
          { number: 2, pull_request: { url: "pull" } },
        ]),
        { status: 200 },
      );
    },
  });

  assert.deepEqual(inventory.active, ["fork-ativo", "repo-ativo"]);
  assert.deepEqual(
    inventory.issues.map((issue) => issue.url),
    ["https://github.com/LCV-Ideas-Software/fork-ativo/issues/1"],
  );
});

test("workflow agendado não concede permissões de escrita", async () => {
  const workflow = await readFile(
    new URL(
      "../.github/workflows/github-linear-reconciliation.yml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(workflow, /^permissions: \{\}$/mu);
  assert.doesNotMatch(workflow, /^\s+[a-z-]+:\s*write\s*$/gmu);
  assert.match(
    workflow,
    /GH_TOKEN: \$\{\{ secrets\.LINEAR_GITHUB_READ_TOKEN \}\}/u,
  );
  assert.doesNotMatch(workflow, /\|\|\s*github\.token/u);
  assert.match(workflow, /node scripts\/github-linear-reconciler\.mjs/u);
  assert.match(workflow, /RECONCILIATION_JSON_STDOUT:\s*"true"/u);
  assert.match(workflow, /> github-linear-reconciliation\.json/u);
  assert.match(
    workflow,
    /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/u,
  );
  assert.match(workflow, /if:\s*always\(\)/u);
});

test("relatório Markdown contém contagens e detalhes acionáveis", () => {
  const markdown = renderMarkdown({
    auditedIssues: 2,
    auditedGithubLinks: 1,
    findings: [
      {
        severity: "error",
        code: "status_divergence",
        issue: "GITHORG-70",
        message: "estados divergem",
      },
    ],
  });

  assert.match(markdown, /2 issues Linear/);
  assert.match(markdown, /status_divergence/);
  assert.match(markdown, /GITHORG-70/);
});

test("relatório Markdown trunca detalhes deterministicamente abaixo do limite", () => {
  const result = {
    auditedIssues: 1_000,
    auditedGithubLinks: 1_000,
    linearOnlyTeamKeys: [],
    findings: Array.from({ length: 1_000 }, (_, index) => ({
      severity: "warning",
      code: `similar_issue_unlinked_${index}`,
      issue: `GITHORG-${index}`,
      message: `Evidência ${index} ${"muito detalhada ".repeat(300)}`,
    })),
  };

  const first = renderMarkdown(result);
  const second = renderMarkdown(result);
  assert.equal(first, second);
  assert.ok(Buffer.byteLength(first, "utf8") < 900 * 1024);
  assert.match(first, /1000 avisos/u);
  assert.match(first, /Detalhes truncados: exibindo \d+ de 1000/u);
  assert.doesNotMatch(first, /similar_issue_unlinked_999/u);
});

test("falha fatal escreve finding inconclusivo no step summary", async () => {
  let appended = null;
  const output = await writeIncompleteSummary(new Error("complexity limit"), {
    summaryPath: "step-summary.md",
    appendFileImpl: async (path, content, encoding) => {
      appended = { path, content, encoding };
    },
  });

  assert.equal(output.result.findings[0].severity, "incomplete");
  assert.equal(output.result.findings[0].code, "reconciliation_aborted");
  assert.equal(appended.path, "step-summary.md");
  assert.equal(appended.encoding, "utf8");
  assert.match(appended.content, /reconciliation_aborted/u);
  assert.match(appended.content, /complexity limit/u);
  const json = renderJson(output.result);
  assert.equal(JSON.parse(json).findings[0].code, "reconciliation_aborted");
});

test("publicação emite exatamente um JSON terminal se o summary falhar", async () => {
  const clean = {
    auditedIssues: 1,
    auditedGithubLinks: 1,
    linearOnlyTeamKeys: [],
    findings: [],
  };
  const strictOutput = [];
  await assert.rejects(
    () =>
      publishTerminalResult(clean, {
        summaryPath: "step-summary.md",
        jsonStdout: true,
        appendFileImpl: async () => {
          throw new Error("summary indisponível");
        },
        writeOutputImpl: (content) => strictOutput.push(content),
      }),
    /summary indisponível/u,
  );
  assert.deepEqual(strictOutput, []);

  const { result: aborted } = await writeIncompleteSummary(
    new Error("summary indisponível"),
    { summaryPath: "" },
  );
  const terminalOutput = [];
  const published = await publishTerminalResult(aborted, {
    summaryPath: "step-summary.md",
    jsonStdout: true,
    bestEffortSummary: true,
    appendFileImpl: async () => {
      throw new Error("summary ainda indisponível");
    },
    writeOutputImpl: (content) => terminalOutput.push(content),
  });

  assert.equal(terminalOutput.length, 1);
  assert.equal(
    JSON.parse(terminalOutput[0]).findings[0].code,
    "reconciliation_aborted",
  );
  assert.match(published.summaryError.message, /ainda indisponível/u);
});
