import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  createGithubAdapter,
  createGithubAppBoundary,
} from "../src/adapters/github.mjs";

const CAPTURED_AT = "2030-01-02T04:00:00.000Z";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function app(overrides = {}) {
  return {
    id: 456,
    owner: { id: 789, login: "example-org", type: "Organization" },
    permissions: {
      metadata: "read",
      issues: "read",
      pull_requests: "read",
    },
    events: [],
    installations_count: 1,
    ...overrides,
  };
}

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

function octokitFor({
  appPayload = app(),
  installations = [installation()],
} = {}) {
  const calls = [];
  const instances = [];
  class FakeOctokit {
    constructor(options) {
      this.options = options;
      this.paginate = { iterator: async function* () {} };
      instances.push(this);
    }

    async request(route, parameters = {}) {
      calls.push({ route, parameters });
      if (route === "GET /app") return { data: appPayload };
      if (route === "GET /app/installations") {
        return { data: installations };
      }
      if (route === "GET /installation/repositories") {
        return { data: { total_count: 0, repositories: [] } };
      }
      throw new Error(`rota inesperada: ${route}`);
    }
  }
  return { FakeOctokit, calls, instances };
}

async function createBoundary(synthetic) {
  return createGithubAppBoundary({
    organization: "example-org",
    appId: "456",
    privateKeyPath: "C:\\private\\app.pem",
    OctokitClass: synthetic.FakeOctokit,
    authStrategy: () => {},
    loadPrivateKey: async () => "synthetic-private-key",
  });
}

test("App JWT prova uma unica instalacao global antes de criar o cliente local", async () => {
  const synthetic = octokitFor();
  const boundary = await createBoundary(synthetic);

  assert.equal(boundary.installationClient, synthetic.instances[1]);
  assert.deepEqual(synthetic.calls.slice(0, 2), [
    { route: "GET /app", parameters: {} },
    { route: "GET /app/installations", parameters: { per_page: 2 } },
  ]);
  assert.equal(
    synthetic.calls.some(
      ({ route }) => route === "GET /orgs/{org}/installation",
    ),
    false,
  );
});

test("boundary recusa zero, multiplas ou contagem contraditoria de instalacoes", async () => {
  for (const synthetic of [
    octokitFor({ installations: [] }),
    octokitFor({
      appPayload: app({ installations_count: 2 }),
      installations: [installation(), installation({ id: 124 })],
    }),
    octokitFor({ appPayload: app({ installations_count: 2 }) }),
  ]) {
    await assert.rejects(
      createBoundary(synthetic),
      /instalação GitHub App inválida/u,
    );
  }
});

function githubAdapter({ issue, pulls }) {
  return createGithubAdapter({
    request: async () => ({ data: {} }),
    paginateIterator: async function* (route) {
      if (route === "GET /repos/{owner}/{repo}/issues") {
        yield { data: [issue] };
        return;
      }
      if (
        route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments"
      ) {
        yield { data: [] };
        return;
      }
      if (route === "GET /repos/{owner}/{repo}/pulls") {
        yield { data: pulls };
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
}

function issue(overrides = {}) {
  return {
    number: 7,
    node_id: "I_kwDOIssueNode7",
    state: "open",
    state_reason: null,
    created_at: "2030-01-02T02:00:00.000Z",
    updated_at: "2030-01-02T03:40:00.000Z",
    ...overrides,
  };
}

function pull(number, overrides = {}) {
  return {
    number,
    created_at: "2030-01-02T02:00:00.000Z",
    updated_at: "2030-01-02T03:40:00.000Z",
    merged_at: null,
    merge_commit_sha: null,
    ...overrides,
  };
}

test("snapshot exige e preserva node_id da issue e SHA de PR nao mesclado", async () => {
  const snapshot = await githubAdapter({
    issue: issue(),
    pulls: [
      pull(8),
      pull(9, { merge_commit_sha: SHA_A }),
      pull(10, {
        merged_at: "2030-01-02T03:30:00.000Z",
        merge_commit_sha: SHA_B,
      }),
    ],
  }).readOrganizationSnapshot({
    organization: "example-org",
    capturedAt: CAPTURED_AT,
  });

  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.issues[0].nodeId, "I_kwDOIssueNode7");
  assert.deepEqual(
    snapshot.pulls.map(({ mergeCommitSha }) => mergeCommitSha),
    [null, SHA_A, SHA_B],
  );

  const missingNode = await githubAdapter({
    issue: issue({ node_id: undefined }),
    pulls: [],
  }).readOrganizationSnapshot({
    organization: "example-org",
    capturedAt: CAPTURED_AT,
  });
  assert.equal(missingNode.complete, false);
});

test("PR mesclado exige merge_commit_sha SHA-40", async () => {
  const snapshot = await githubAdapter({
    issue: issue(),
    pulls: [
      pull(10, {
        merged_at: "2030-01-02T03:30:00.000Z",
        merge_commit_sha: null,
      }),
    ],
  }).readOrganizationSnapshot({
    organization: "example-org",
    capturedAt: CAPTURED_AT,
  });

  assert.equal(snapshot.complete, false);
});

test("workflow usa runner Ubuntu versionado sem alegar imagem imutavel", () => {
  const workflow = readFileSync(
    path.resolve(
      import.meta.dirname,
      "../../../.github/workflows/github-linear-reconciliation.yml",
    ),
    "utf8",
  );
  assert.match(workflow, /^\s*?runs-on:\s+ubuntu-24\.04\s*$/mu);
  assert.doesNotMatch(workflow, /(?:runner|imagem)[^\n]*imut[aá]vel/iu);
});
