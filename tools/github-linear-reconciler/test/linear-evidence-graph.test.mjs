import assert from "node:assert/strict";
import test from "node:test";

import { createLinearAdapter } from "../src/adapters/linear.mjs";
import { validateSnapshots } from "../src/domain/validate-snapshot.mjs";

const CAPTURED_AT = "2030-01-02T04:00:00.000Z";
const CAPTURED_AT_MS = Date.parse(CAPTURED_AT);
const BEFORE_CAPTURE = "2030-01-02T03:00:00.000Z";
const AFTER_CAPTURE = "2030-01-02T04:00:00.001Z";
const PIPELINE_ID = "123e4567-e89b-42d3-a456-426614174000";
const SHA = "a".repeat(40);

function connection(nodes = []) {
  return {
    nodes,
    pageInfo: { hasNextPage: false, endCursor: null },
  };
}

function pagedConnection(pages, index = 0) {
  return {
    nodes: pages[index],
    pageInfo: {
      hasNextPage: index < pages.length - 1,
      endCursor: index < pages.length - 1 ? `cursor-${index + 1}` : null,
    },
    fetchNext: async () => pagedConnection(pages, index + 1),
  };
}

function team(overrides = {}) {
  return {
    id: "team-app",
    key: "APP",
    name: "App",
    archivedAt: null,
    retiredAt: null,
    updatedAt: BEFORE_CAPTURE,
    ...overrides,
  };
}

function issue(overrides = {}) {
  return {
    id: "issue-7",
    identifier: "APP-7",
    title: "Evidencia deterministica da integracao",
    description:
      "Descricao suficientemente informativa para a evidencia de integracao.",
    updatedAt: BEFORE_CAPTURE,
    syncedWith: [
      {
        service: "github",
        id: "I_kwDOCaseSensitive",
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

function pipeline(overrides = {}) {
  return {
    id: PIPELINE_ID,
    type: "continuous",
    createdAt: BEFORE_CAPTURE,
    updatedAt: BEFORE_CAPTURE,
    ...overrides,
  };
}

function release(overrides = {}) {
  return {
    id: "release-1",
    commitSha: SHA,
    completedAt: null,
    createdAt: BEFORE_CAPTURE,
    updatedAt: BEFORE_CAPTURE,
    pipelineId: PIPELINE_ID,
    ...overrides,
  };
}

function issueToRelease(overrides = {}) {
  return {
    id: "issue-release-1",
    issueId: "issue-7",
    releaseId: "release-1",
    createdAt: BEFORE_CAPTURE,
    updatedAt: BEFORE_CAPTURE,
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
    releasePipelines: async () => connection([pipeline()]),
    releases: async () => connection([release()]),
    issueToReleases: async () => connection([issueToRelease()]),
    ...overrides,
  };
}

async function read(clientValue) {
  return createLinearAdapter({
    apiKey: "linear-test-token",
    clientFactory: () => clientValue,
  }).readWorkspaceSnapshot({ capturedAt: CAPTURED_AT });
}

function validGithub(nodeId = "I_kwDOCaseSensitive") {
  return {
    complete: true,
    failures: [],
    capturedAtMs: CAPTURED_AT_MS,
    organization: "example-org",
    repositories: [
      {
        id: 1,
        name: "example-app",
        archived: false,
        issuesEnabled: true,
        fork: false,
      },
    ],
    issues: [
      {
        key: "example-org/example-app#7",
        nodeId,
        repository: "example-app",
        number: 7,
        status: "active",
        updatedAtMs: Date.parse(BEFORE_CAPTURE),
        comments: [],
      },
    ],
    pulls: [],
  };
}

test("r5525: contraparte nativa preserva o externalId opaco e resolve o nodeId exato", async () => {
  const linear = await read(client());
  assert.equal(linear.complete, true);
  assert.deepEqual(linear.issues[0].nativeCounterparts, [
    {
      resourceKey: "example-org/example-app#7",
      externalId: "I_kwDOCaseSensitive",
    },
  ]);
  assert.deepEqual(linear.issues[0].nativeCounterpartKeys, [
    "example-org/example-app#7",
  ]);
  assert.deepEqual(
    validateSnapshots(linear, validGithub(), "example-org", CAPTURED_AT_MS),
    [],
  );
  const divergentProjection = structuredClone(linear);
  divergentProjection.issues[0].nativeCounterpartKeys = [];
  assert.match(
    validateSnapshots(
      divergentProjection,
      validGithub(),
      "example-org",
      CAPTURED_AT_MS,
    )[0]?.message ?? "",
    /linear issues/i,
  );
  assert.match(
    validateSnapshots(
      linear,
      validGithub("i_kwdocasesensitive"),
      "example-org",
      CAPTURED_AT_MS,
    )[0]?.message ?? "",
    /counterpart|node/i,
  );
});

test("r5530: teams e toda topologia validam updatedAt antes de filtrar", async () => {
  const futureTeam = await read(
    client({
      teams: async () => connection([team({ updatedAt: AFTER_CAPTURE })]),
    }),
  );
  assert.equal(futureTeam.complete, false);
  assert.equal(futureTeam.failures[0].scope, "teams[0]");

  for (const method of ["cycles", "projects", "initiatives", "documents"]) {
    const entity = {
      id: `${method}-future`,
      updatedAt: AFTER_CAPTURE,
      team: null,
      leadTeam: null,
      teams: async () => connection(),
    };
    const result = await read(
      client({ [method]: async () => connection([entity]) }),
    );
    assert.equal(result.complete, false, method);
    assert.equal(result.failures[0].scope, `${method}[0]`, method);
  }
});

test("r5535: grafo global pagina e valida release, pipeline e associacao antes da projecao", async () => {
  const sourceIssue = issue({ releases: undefined });
  const linear = await read(
    client({
      issues: async () => connection([sourceIssue]),
      releases: async () =>
        pagedConnection([
          [release()],
          [
            release({
              id: "release-without-sha",
              commitSha: null,
              completedAt: BEFORE_CAPTURE,
            }),
          ],
        ]),
      issueToReleases: async () =>
        pagedConnection([
          [issueToRelease()],
          [
            issueToRelease({
              id: "issue-release-2",
              releaseId: "release-without-sha",
            }),
          ],
        ]),
    }),
  );
  assert.equal(linear.complete, true);
  assert.equal(linear.releasePipelines.length, 1);
  assert.equal(linear.releases.length, 2);
  assert.equal(linear.issueToReleases.length, 2);
  assert.deepEqual(linear.issues[0].releases, [
    {
      id: "release-1",
      pipelineId: PIPELINE_ID,
      pipelineType: "continuous",
      commitSha: SHA,
      completedAtMs: null,
      updatedAtMs: Date.parse(BEFORE_CAPTURE),
      issueToReleaseId: "issue-release-1",
      issueToReleaseUpdatedAtMs: Date.parse(BEFORE_CAPTURE),
    },
  ]);

  for (const [failingClient, expectedCode, expectedReasonCode] of [
    [
      client({
        releases: async () =>
          connection([release({ updatedAt: AFTER_CAPTURE })]),
      }),
      "node_invalid",
      "timestamp_outside_capture_window",
    ],
    [
      client({
        releases: async () =>
          connection([
            release({
              id: "release-without-sha-future",
              commitSha: null,
              updatedAt: AFTER_CAPTURE,
            }),
          ]),
        issueToReleases: async () =>
          connection([
            issueToRelease({
              releaseId: "release-without-sha-future",
            }),
          ]),
      }),
      "node_invalid",
      "timestamp_outside_capture_window",
    ],
    [
      client({
        issueToReleases: async () =>
          connection([issueToRelease({ updatedAt: AFTER_CAPTURE })]),
      }),
      "node_invalid",
      "timestamp_outside_capture_window",
    ],
    [
      client({
        issueToReleases: async () =>
          connection([issueToRelease({ releaseId: "missing-release" })]),
      }),
      "boundary_invalid",
      "issue_release_release_unresolved",
    ],
    [
      client({
        issueToReleases: async () =>
          connection([
            issueToRelease(),
            issueToRelease({ id: "issue-release-duplicate-pair" }),
          ]),
      }),
      "boundary_invalid",
      "issue_release_association_duplicate",
    ],
  ]) {
    const result = await read(failingClient);
    assert.equal(result.complete, false);
    assert.equal(result.failures[0].code, expectedCode);
    assert.deepEqual(result.failures[0].reasonCodes, [expectedReasonCode]);
  }
});

test("r5554: release com SHA e pipeline nula falha fechado", async () => {
  const result = await read(
    client({
      releases: async () => connection([release({ pipelineId: null })]),
    }),
  );
  assert.equal(result.complete, false);
  assert.equal(result.failures[0].scope, "releases[0]");
});

test("grafo global rejeita cronologia impossível no adapter e no validator", async () => {
  const releaseCreatedAt = Date.parse(BEFORE_CAPTURE);
  const beforeRelease = new Date(releaseCreatedAt - 1).toISOString();
  const afterRelease = new Date(releaseCreatedAt + 1).toISOString();

  const invalidClients = [
    [
      client({
        releasePipelines: async () =>
          connection([pipeline({ updatedAt: beforeRelease })]),
      }),
      "node_invalid",
      "entity_chronology_invalid",
    ],
    [
      client({
        releases: async () =>
          connection([release({ updatedAt: beforeRelease })]),
      }),
      "node_invalid",
      "entity_chronology_invalid",
    ],
    [
      client({
        issueToReleases: async () =>
          connection([issueToRelease({ updatedAt: beforeRelease })]),
      }),
      "node_invalid",
      "entity_chronology_invalid",
    ],
    [
      client({
        releases: async () =>
          connection([release({ completedAt: beforeRelease })]),
      }),
      "node_invalid",
      "release_completion_chronology_invalid",
    ],
    [
      client({
        releasePipelines: async () =>
          connection([
            pipeline({ createdAt: afterRelease, updatedAt: afterRelease }),
          ]),
      }),
      "boundary_invalid",
      "release_pipeline_precedes_release",
    ],
    [
      client({
        issueToReleases: async () =>
          connection([
            issueToRelease({
              createdAt: beforeRelease,
              updatedAt: beforeRelease,
            }),
          ]),
      }),
      "boundary_invalid",
      "issue_release_precedes_release",
    ],
  ];
  for (const [
    invalidClient,
    expectedCode,
    expectedReasonCode,
  ] of invalidClients) {
    const result = await read(invalidClient);
    assert.equal(result.complete, false);
    assert.equal(result.failures[0].code, expectedCode);
    assert.deepEqual(result.failures[0].reasonCodes, [expectedReasonCode]);
  }

  const valid = await read(client());
  assert.equal(valid.complete, true);
  const invalidSnapshots = [
    (snapshot) => {
      snapshot.releases[0].completedAtMs = releaseCreatedAt - 1;
      snapshot.issues[0].releases[0].completedAtMs = releaseCreatedAt - 1;
    },
    (snapshot) => {
      snapshot.releasePipelines[0].createdAtMs = releaseCreatedAt + 1;
      snapshot.releasePipelines[0].updatedAtMs = releaseCreatedAt + 1;
    },
    (snapshot) => {
      snapshot.issueToReleases[0].createdAtMs = releaseCreatedAt - 1;
      snapshot.issueToReleases[0].updatedAtMs = releaseCreatedAt - 1;
      snapshot.issues[0].releases[0].issueToReleaseUpdatedAtMs =
        releaseCreatedAt - 1;
    },
  ];
  for (const mutate of invalidSnapshots) {
    const invalid = structuredClone(valid);
    mutate(invalid);
    assert.match(
      validateSnapshots(
        invalid,
        validGithub(),
        "example-org",
        CAPTURED_AT_MS,
      )[0]?.message ?? "",
      /release|pipeline|association/i,
    );
  }
});
