import assert from "node:assert/strict";
import test from "node:test";

import { evaluate } from "../src/evaluate.mjs";

const NOW = new Date(10_000_000);
const PIPELINE_ID = "00000000-0000-4000-8000-000000000001";

function resourceKey(repository = "repo-a", number = 1) {
  return `example-org/${repository}#${number}`;
}

function nodeId(key) {
  return `node:${key}`;
}

function githubIssue(key) {
  const [, , repository, number] = /^([^/]+)\/([^#]+)#(\d+)$/u.exec(key);
  return {
    key,
    nodeId: nodeId(key),
    repository,
    number: Number(number),
    status: "active",
    createdAtMs: 4_000,
    updatedAtMs: 5_000,
    comments: [],
  };
}

function baseline({ repository = "repo-a" } = {}) {
  const key = resourceKey(repository);
  return {
    config: {
      organization: "example-org",
      releaseRequiredAfter: 1_000,
      commentGraceMinutes: 30,
      mappings: [
        {
          linearTeamKey: "TEAM_A",
          mode: "github-backed",
          repository,
          linearReleasePipelineId: PIPELINE_ID,
        },
        { linearTeamKey: "TEAM_ROOT", mode: "umbrella" },
      ],
    },
    linear: {
      complete: true,
      failures: [],
      captureStartedAtMs: NOW.getTime(),
      capturedAtMs: NOW.getTime(),
      teams: [
        {
          id: "team-a-id",
          key: "TEAM_A",
          active: true,
          updatedAtMs: 5_000,
        },
        {
          id: "team-root-id",
          key: "TEAM_ROOT",
          active: true,
          updatedAtMs: 5_000,
        },
      ],
      issues: [
        {
          id: "linear-1",
          identifier: "TEAM_A-1",
          teamId: "team-a-id",
          teamKey: "TEAM_A",
          updatedAtMs: 5_000,
          status: "active",
          nativeCounterparts: [{ resourceKey: key, externalId: nodeId(key) }],
          nativeCounterpartKeys: [key],
          attachmentIssueKeys: [key],
          insecureGithubResourceKeys: [],
          carrierPullKeys: [],
          comments: [],
          githubThreadControls: [],
          releases: [],
          duplicateOf: null,
          relatedIdentifiers: [],
          duplicateKey: null,
          similarityKeys: [],
        },
      ],
      cycles: [],
      projects: [],
      initiatives: [],
      documents: [],
      releasePipelines: [
        {
          id: PIPELINE_ID,
          type: "continuous",
          createdAtMs: 0,
          updatedAtMs: 5_000,
        },
      ],
      releases: [],
      issueToReleases: [],
    },
    github: {
      complete: true,
      failures: [],
      captureStartedAtMs: NOW.getTime(),
      capturedAtMs: NOW.getTime(),
      organization: "example-org",
      repositories: [
        {
          id: 1,
          name: repository,
          archived: false,
          issuesEnabled: true,
          fork: false,
        },
      ],
      issues: [githubIssue(key)],
      pulls: [],
    },
    now: NOW,
  };
}

function clone(value) {
  return structuredClone(value);
}

function control(overrides = {}) {
  return {
    linearCommentId: "linear-control-1",
    connected: false,
    observedResourceKey: resourceKey(),
    urlState: "resource",
    ...overrides,
  };
}

function findingsByPrefix(result) {
  return result.findings.filter((finding) =>
    finding.code.startsWith("github_thread_control_"),
  );
}

function evaluateWithControl(controlValue, mutate = () => {}) {
  const input = baseline();
  input.linear.issues[0].githubThreadControls.push(controlValue);
  mutate(input);
  return evaluate(input);
}

test("controle desconectado e somente evidencia historica", () => {
  assert.deepEqual(
    findingsByPrefix(evaluateWithControl(control())),
    [],
    "resource coincidente nao deve gerar finding",
  );
  assert.deepEqual(
    findingsByPrefix(
      evaluateWithControl(
        control({ observedResourceKey: null, urlState: "absent" }),
      ),
    ),
    [],
    "URL ausente e legitima para controle desconectado",
  );

  const threadOnly = evaluateWithControl(control(), (input) => {
    input.linear.issues[0].nativeCounterparts = [];
    input.linear.issues[0].nativeCounterpartKeys = [];
  });
  assert.deepEqual(
    findingsByPrefix(threadOnly).map(({ severity, code }) => ({
      severity,
      code,
    })),
    [
      {
        severity: "advisory",
        code: "github_thread_control_historical_thread_only",
      },
    ],
  );

  const mismatch = evaluateWithControl(
    control({ observedResourceKey: resourceKey("repo-a", 2) }),
  );
  assert.deepEqual(
    findingsByPrefix(mismatch).map(({ severity, code }) => ({
      severity,
      code,
    })),
    [
      {
        severity: "advisory",
        code: "github_thread_control_historical_mismatch",
      },
    ],
  );

  const unparseable = evaluateWithControl(
    control({ observedResourceKey: null, urlState: "unparseable" }),
  );
  assert.deepEqual(
    findingsByPrefix(unparseable).map(({ severity, code }) => ({
      severity,
      code,
    })),
    [
      {
        severity: "advisory",
        code: "github_thread_control_historical_url_unparseable",
      },
    ],
  );
});

test("controle conectado exige uma unica identidade nativa coincidente", () => {
  assert.deepEqual(
    findingsByPrefix(evaluateWithControl(control({ connected: true }))),
    [],
  );

  const withoutNative = evaluateWithControl(
    control({ connected: true }),
    (input) => {
      input.linear.issues[0].nativeCounterparts = [];
      input.linear.issues[0].nativeCounterpartKeys = [];
    },
  );
  assert.ok(
    findingsByPrefix(withoutNative).some(
      ({ severity, code }) =>
        severity === "incomplete" &&
        code === "github_thread_control_native_counterpart_missing",
    ),
  );

  for (const [urlState, expectedCode] of [
    ["absent", "github_thread_control_active_url_absent"],
    ["unparseable", "github_thread_control_active_url_unparseable"],
  ]) {
    const result = evaluateWithControl(
      control({
        connected: true,
        observedResourceKey: null,
        urlState,
      }),
    );
    assert.ok(
      findingsByPrefix(result).some(
        ({ severity, code }) =>
          severity === "incomplete" && code === expectedCode,
      ),
    );
  }

  const mismatch = evaluateWithControl(
    control({
      connected: true,
      observedResourceKey: resourceKey("repo-a", 2),
    }),
  );
  assert.ok(
    findingsByPrefix(mismatch).some(
      ({ severity, code }) =>
        severity === "incomplete" &&
        code === "github_thread_control_active_resource_mismatch",
    ),
  );

  const ambiguous = evaluateWithControl(
    control({ connected: true }),
    (input) => {
      const secondKey = resourceKey("repo-a", 2);
      input.linear.issues[0].nativeCounterparts.push({
        resourceKey: secondKey,
        externalId: nodeId(secondKey),
      });
      input.linear.issues[0].nativeCounterpartKeys.push(secondKey);
      input.github.issues.push(githubIssue(secondKey));
    },
  );
  assert.ok(
    findingsByPrefix(ambiguous).some(
      ({ severity, code }) =>
        severity === "incomplete" &&
        code === "github_thread_control_native_counterpart_ambiguous",
    ),
  );
});

test("validator exige shape, identidade global e disjuncao de comments", () => {
  const valid = evaluate(baseline());
  assert.equal(valid.state, "clean", JSON.stringify(valid));

  const missingCollection = baseline();
  delete missingCollection.linear.issues[0].githubThreadControls;
  assert.equal(evaluate(missingCollection).state, "incomplete");

  for (const invalidControl of [
    control({ observedResourceKey: "example-org/../x#1" }),
    control({ observedResourceKey: null }),
    control({ observedResourceKey: resourceKey(), urlState: "absent" }),
    control({ urlState: "unknown" }),
  ]) {
    const input = baseline();
    input.linear.issues[0].githubThreadControls.push(invalidControl);
    assert.equal(evaluate(input).state, "incomplete");
    assert.deepEqual(
      evaluate(input).findings.map(({ code }) => code),
      ["normalized_snapshot_invalid"],
    );
  }

  const duplicate = baseline();
  duplicate.linear.issues.push({
    ...clone(duplicate.linear.issues[0]),
    id: "linear-2",
    identifier: "TEAM_A-2",
    nativeCounterparts: [],
    nativeCounterpartKeys: [],
    attachmentIssueKeys: [],
    githubThreadControls: [control()],
  });
  duplicate.linear.issues[0].githubThreadControls.push(control());
  assert.equal(evaluate(duplicate).state, "incomplete");

  const collidingComment = baseline();
  collidingComment.linear.issues[0].githubThreadControls.push(control());
  collidingComment.linear.issues[0].comments.push({
    id: "linear-control-1",
    provenance: "linear",
    resourceKey: null,
    externalId: null,
    threadId: null,
    connected: true,
    createdAtMs: 4_000,
    updatedAtMs: 5_000,
  });
  assert.equal(evaluate(collidingComment).state, "incomplete");
});

test("parser compartilhado aceita .github sem promover URL ou attachment a identidade", () => {
  const input = baseline({ repository: ".github" });
  input.linear.issues[0].githubThreadControls.push(
    control({
      connected: true,
      observedResourceKey: resourceKey(".github"),
    }),
  );
  assert.equal(evaluate(input).state, "clean");

  input.linear.issues[0].nativeCounterparts = [];
  input.linear.issues[0].nativeCounterpartKeys = [];
  const result = evaluate(input);
  assert.ok(
    findingsByPrefix(result).some(
      ({ severity, code }) =>
        severity === "incomplete" &&
        code === "github_thread_control_native_counterpart_missing",
    ),
  );
});
