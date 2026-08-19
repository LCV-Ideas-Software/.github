import assert from "node:assert/strict";
import test from "node:test";

import { determineExitCode, evaluate } from "../src/evaluate.mjs";

const NOW = new Date(10_000_000);
const COMMENT_GRACE_MINUTES = 30;
const ISSUE_KEY = "example-org/repo-a#1";
const PIPELINE_ID = "00000000-0000-4000-8000-000000000001";
const TEAM_IDS = Object.freeze({
  TEAM_A: "team-a-id",
  TEAM_LOCAL: "team-local-id",
  TEAM_ROOT: "team-root-id",
});

function nodeIdForKey(key) {
  return `node:${key}`;
}

function setNativeCounterparts(issue, keys) {
  issue.nativeCounterparts = keys.map((resourceKey) => ({
    resourceKey,
    externalId: nodeIdForKey(resourceKey),
  }));
  issue.nativeCounterpartKeys = [...keys];
}

function setReleaseEvidence(input, issue, releases) {
  const previousAssociations = input.linear.issueToReleases.filter(
    (association) => association.issueId === issue.id,
  );
  const previousReleaseIds = new Set(
    previousAssociations.map((association) => association.releaseId),
  );
  input.linear.issueToReleases = input.linear.issueToReleases.filter(
    (association) => association.issueId !== issue.id,
  );
  input.linear.releases = input.linear.releases.filter(
    (release) => !previousReleaseIds.has(release.id),
  );
  issue.releases = releases.map((release, index) => {
    const updatedAtMs =
      release.updatedAtMs ?? Math.max(release.completedAtMs ?? 0, 5_000);
    const issueToReleaseId = `${issue.id}-release-${index + 1}`;
    if (
      !input.linear.releasePipelines.some(
        (pipeline) => pipeline.id === release.pipelineId,
      )
    ) {
      input.linear.releasePipelines.push({
        id: release.pipelineId,
        type: release.pipelineType,
        createdAtMs: 0,
        updatedAtMs: 5_000,
      });
    }
    input.linear.releases.push({
      id: release.id,
      pipelineId: release.pipelineId,
      commitSha: release.commitSha,
      completedAtMs: release.completedAtMs,
      createdAtMs: 0,
      updatedAtMs,
    });
    input.linear.issueToReleases.push({
      id: issueToReleaseId,
      issueId: issue.id,
      releaseId: release.id,
      createdAtMs: 0,
      updatedAtMs: 5_000,
    });
    return {
      ...release,
      updatedAtMs,
      issueToReleaseId,
      issueToReleaseUpdatedAtMs: 5_000,
    };
  });
}

function baseline() {
  return {
    config: {
      organization: "example-org",
      releaseRequiredAfter: 1_000,
      commentGraceMinutes: COMMENT_GRACE_MINUTES,
      mappings: [
        {
          linearTeamKey: "TEAM_A",
          mode: "github-backed",
          repository: "repo-a",
          linearReleasePipelineId: PIPELINE_ID,
        },
        { linearTeamKey: "TEAM_LOCAL", mode: "linear-only" },
        { linearTeamKey: "TEAM_ROOT", mode: "umbrella" },
      ],
    },
    linear: {
      complete: true,
      failures: [],
      capturedAtMs: NOW.getTime(),
      teams: [
        {
          id: TEAM_IDS.TEAM_A,
          key: "TEAM_A",
          active: true,
          updatedAtMs: 5_000,
        },
        {
          id: TEAM_IDS.TEAM_LOCAL,
          key: "TEAM_LOCAL",
          active: true,
          updatedAtMs: 5_000,
        },
        {
          id: TEAM_IDS.TEAM_ROOT,
          key: "TEAM_ROOT",
          active: true,
          updatedAtMs: 5_000,
        },
      ],
      issues: [
        {
          id: "linear-1",
          identifier: "TEAM_A-1",
          teamId: TEAM_IDS.TEAM_A,
          teamKey: "TEAM_A",
          updatedAtMs: 5_000,
          status: "active",
          nativeCounterparts: [
            {
              resourceKey: ISSUE_KEY,
              externalId: nodeIdForKey(ISSUE_KEY),
            },
          ],
          nativeCounterpartKeys: [ISSUE_KEY],
          attachmentIssueKeys: [ISSUE_KEY],
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
      capturedAtMs: NOW.getTime(),
      organization: "example-org",
      repositories: [
        {
          id: 1,
          name: "repo-a",
          archived: false,
          issuesEnabled: true,
          fork: false,
        },
      ],
      issues: [
        {
          key: ISSUE_KEY,
          nodeId: nodeIdForKey(ISSUE_KEY),
          repository: "repo-a",
          number: 1,
          status: "active",
          updatedAtMs: 5_000,
          comments: [],
        },
      ],
      pulls: [],
    },
    now: NOW,
  };
}

function clone(value) {
  return structuredClone(value);
}

function codes(result) {
  return result.findings.map((finding) => finding.code);
}

function addLinearIssue(input, overrides) {
  const issue = clone(input.linear.issues[0]);
  Object.assign(issue, {
    id: "linear-2",
    identifier: "TEAM_A-2",
    nativeCounterpartKeys: [],
    nativeCounterparts: [],
    attachmentIssueKeys: [],
    insecureGithubResourceKeys: [],
    ...overrides,
  });
  if (overrides.nativeCounterparts === undefined) {
    setNativeCounterparts(issue, issue.nativeCounterpartKeys);
  }
  if (overrides.teamId === undefined) issue.teamId = TEAM_IDS[issue.teamKey];
  input.linear.issues.push(issue);
  return issue;
}

test("snapshot normalizado limpo produz resultado e exit determinísticos", () => {
  const result = evaluate(baseline());

  assert.deepEqual(result, {
    state: "clean",
    counts: { drift: 0, advisory: 0, incomplete: 0 },
    findings: [],
  });
  assert.equal(determineExitCode(result), 0);

  const caseVariant = baseline();
  caseVariant.config.organization = "Example-Org";
  caseVariant.config.mappings[0].repository = "Repo-A";
  assert.equal(evaluate(caseVariant).state, "clean");
});

test("mapping github-backed exige pipeline global continuous mesmo sem carrier", () => {
  const missing = baseline();
  missing.linear.releasePipelines = [];
  const missingResult = evaluate(missing);
  assert.equal(missingResult.state, "incomplete");
  assert.deepEqual(codes(missingResult), [
    "configured_release_pipeline_missing",
  ]);

  const scheduled = baseline();
  scheduled.linear.releasePipelines[0].type = "scheduled";
  const scheduledResult = evaluate(scheduled);
  assert.equal(scheduledResult.state, "incomplete");
  assert.deepEqual(codes(scheduledResult), [
    "configured_release_pipeline_not_continuous",
  ]);
});

test("configuração exige chaves/repos únicos e exatamente um umbrella", () => {
  const cases = [
    {
      name: "sem umbrella",
      mutate(input) {
        input.config.mappings = input.config.mappings.filter(
          (mapping) => mapping.mode !== "umbrella",
        );
      },
    },
    {
      name: "dois umbrellas",
      mutate(input) {
        input.config.mappings.push({
          linearTeamKey: "TEAM_ROOT_2",
          mode: "umbrella",
        });
      },
    },
    {
      name: "team key repetida",
      mutate(input) {
        input.config.mappings.push({
          linearTeamKey: "TEAM_A",
          mode: "linear-only",
        });
      },
    },
    {
      name: "repositório repetido",
      mutate(input) {
        input.config.mappings.push({
          linearTeamKey: "TEAM_B",
          mode: "github-backed",
          repository: "repo-a",
        });
      },
    },
  ];

  for (const scenario of cases) {
    const input = baseline();
    scenario.mutate(input);
    const result = evaluate(input);
    assert.equal(result.state, "incomplete", scenario.name);
    assert.equal(determineExitCode(result), 2, scenario.name);
    assert.ok(codes(result).includes("configuration_invalid"), scenario.name);
  }
});

test("snapshot parcial ou fora do contrato nunca executa regras como se fosse completo", () => {
  const partial = baseline();
  partial.github.complete = false;
  partial.github.failures = [
    { source: "github", code: "rate_limited", scope: "repositories" },
  ];
  partial.github.issues = [];

  const partialResult = evaluate(partial);
  assert.equal(partialResult.state, "incomplete");
  assert.deepEqual(codes(partialResult), ["github_snapshot_incomplete"]);

  const bothPartial = baseline();
  bothPartial.linear.complete = false;
  bothPartial.github.complete = false;
  assert.deepEqual(codes(evaluate(bothPartial)), [
    "github_snapshot_incomplete",
    "linear_snapshot_incomplete",
  ]);

  const contradictory = baseline();
  contradictory.linear.failures.push({
    source: "linear",
    code: "node_invalid",
    scope: "issues[4].comments[2]",
    reasonCodes: ["comment_github_sync_ambiguous"],
    message: "linear node normalization failed",
  });
  const contradictoryResult = evaluate(contradictory);
  assert.deepEqual(codes(contradictoryResult), ["linear_snapshot_incomplete"]);
  assert.deepEqual(contradictoryResult.findings[0].references, [
    "linear:node_invalid:issues[4].comments[2]:comment_github_sync_ambiguous",
  ]);

  const malformed = baseline();
  delete malformed.linear.issues[0].status;
  const malformedResult = evaluate(malformed);
  assert.equal(malformedResult.state, "incomplete");
  assert.ok(codes(malformedResult).includes("normalized_snapshot_invalid"));

  const inconsistentKey = baseline();
  inconsistentKey.github.issues[0].key = "example-org/repo-a#2";
  assert.equal(evaluate(inconsistentKey).state, "incomplete");

  const unresolvedRelation = baseline();
  unresolvedRelation.linear.issues[0].duplicateOf = "TEAM_A-404";
  assert.equal(evaluate(unresolvedRelation).state, "incomplete");

  const kindCollision = baseline();
  kindCollision.github.pulls.push({
    key: ISSUE_KEY,
    repository: "repo-a",
    number: 1,
    updatedAtMs: 5_000,
    mergedAtMs: null,
    mergeCommitSha: null,
  });
  assert.equal(evaluate(kindCollision).state, "incomplete");
});

test("counterparts aplicam cardinalidade nos dois sentidos", () => {
  const missingFromLinear = baseline();
  setNativeCounterparts(missingFromLinear.linear.issues[0], []);
  missingFromLinear.linear.issues[0].attachmentIssueKeys = [];
  assert.deepEqual(
    new Set(codes(evaluate(missingFromLinear))),
    new Set([
      "github_issue_without_linear_counterpart",
      "linear_issue_without_native_counterpart",
    ]),
  );

  const multipleFromLinear = baseline();
  const secondKey = "example-org/repo-a#2";
  setNativeCounterparts(multipleFromLinear.linear.issues[0], [
    ISSUE_KEY,
    secondKey,
  ]);
  multipleFromLinear.linear.issues[0].attachmentIssueKeys.push(secondKey);
  multipleFromLinear.github.issues.push({
    key: secondKey,
    nodeId: nodeIdForKey(secondKey),
    repository: "repo-a",
    number: 2,
    status: "active",
    updatedAtMs: 5_000,
    comments: [],
  });
  assert.ok(
    codes(evaluate(multipleFromLinear)).includes(
      "linear_issue_multiple_native_counterparts",
    ),
  );

  const multipleFromGithub = baseline();
  addLinearIssue(multipleFromGithub, {
    nativeCounterpartKeys: [ISSUE_KEY],
    attachmentIssueKeys: [ISSUE_KEY],
  });
  assert.ok(
    codes(evaluate(multipleFromGithub)).includes(
      "github_issue_multiple_linear_counterparts",
    ),
  );
});

test("fronteira normalizada fecha relogio, identidade composta e ciclos duplicateOf", () => {
  const divergentClock = baseline();
  divergentClock.github.capturedAtMs -= 1;
  assert.deepEqual(codes(evaluate(divergentClock)), [
    "normalized_snapshot_invalid",
  ]);

  const invertedNormalizedComment = baseline();
  invertedNormalizedComment.linear.issues[0].comments.push({
    id: "linear-comment-inverted",
    provenance: "linear",
    resourceKey: null,
    externalId: null,
    threadId: null,
    connected: true,
    createdAtMs: 2_000,
    updatedAtMs: 1_999,
  });
  assert.deepEqual(codes(evaluate(invertedNormalizedComment)), [
    "normalized_snapshot_invalid",
  ]);

  const mismatchedTeam = baseline();
  mismatchedTeam.linear.issues[0].teamId = TEAM_IDS.TEAM_LOCAL;
  assert.deepEqual(codes(evaluate(mismatchedTeam)), [
    "normalized_snapshot_invalid",
  ]);

  const cyclic = baseline();
  cyclic.linear.issues[0].duplicateOf = "TEAM_A-2";
  addLinearIssue(cyclic, { duplicateOf: "TEAM_A-1" });
  assert.ok(codes(evaluate(cyclic)).includes("normalized_snapshot_invalid"));

  const malformedResource = baseline();
  malformedResource.linear.issues[0].nativeCounterpartKeys = [
    "not-a-github-key",
  ];
  assert.deepEqual(codes(evaluate(malformedResource)), [
    "normalized_snapshot_invalid",
  ]);
});

test("mapeamento explícito distingue github-backed, linear-only e repositório desconhecido", () => {
  const linearOnly = baseline();
  const secondKey = "example-org/repo-a#2";
  addLinearIssue(linearOnly, {
    teamKey: "TEAM_LOCAL",
    nativeCounterpartKeys: [secondKey],
    attachmentIssueKeys: [secondKey],
  });
  linearOnly.github.issues.push({
    key: secondKey,
    nodeId: nodeIdForKey(secondKey),
    repository: "repo-a",
    number: 2,
    status: "active",
    updatedAtMs: 5_000,
    comments: [],
  });
  const linearOnlyCodes = codes(evaluate(linearOnly));
  assert.ok(linearOnlyCodes.includes("linear_only_github_counterpart"));
  assert.ok(linearOnlyCodes.includes("linear_only_github_attachment"));

  const linearOnlyEvidence = baseline();
  const localEvidenceIssue = addLinearIssue(linearOnlyEvidence, {
    teamKey: "TEAM_LOCAL",
    carrierPullKeys: [secondKey],
    comments: [
      {
        id: "linear-comment-local",
        provenance: "github",
        resourceKey: secondKey,
        externalId: "github-comment-local",
        threadId: secondKey,
        connected: true,
        createdAtMs: 1_000,
        updatedAtMs: 1_000,
      },
    ],
  });
  setReleaseEvidence(linearOnlyEvidence, localEvidenceIssue, [
    {
      id: "release-local",
      pipelineId: PIPELINE_ID,
      pipelineType: "continuous",
      commitSha: "b".repeat(40),
      completedAtMs: 2_000,
    },
  ]);
  const evidenceCodes = codes(evaluate(linearOnlyEvidence));
  assert.ok(evidenceCodes.includes("linear_only_github_attachment"));
  assert.ok(evidenceCodes.includes("linear_only_github_comment"));
  assert.ok(evidenceCodes.includes("linear_only_github_release"));

  const unknownRepository = baseline();
  unknownRepository.github.repositories.push({
    id: 2,
    name: "repo-b",
    archived: false,
    issuesEnabled: true,
    fork: false,
  });
  unknownRepository.github.issues.push({
    key: "example-org/repo-b#1",
    nodeId: nodeIdForKey("example-org/repo-b#1"),
    repository: "repo-b",
    number: 1,
    status: "active",
    updatedAtMs: 5_000,
    comments: [],
  });
  assert.ok(
    codes(evaluate(unknownRepository)).includes(
      "github_repository_mapping_missing",
    ),
  );

  const archivedRepository = baseline();
  archivedRepository.github.repositories.push({
    id: 2,
    name: "repo-archived",
    archived: true,
    issuesEnabled: true,
    fork: false,
  });
  assert.equal(evaluate(archivedRepository).state, "incomplete");
});

test("umbrella vazio cobre as classes residuais de work item", () => {
  const input = baseline();
  addLinearIssue(input, { teamKey: "TEAM_ROOT" });
  for (const collection of ["projects", "initiatives", "documents"]) {
    input.linear[collection].push({
      id: `${collection}-1`,
      teamId: TEAM_IDS.TEAM_ROOT,
      teamKey: "TEAM_ROOT",
      updatedAtMs: 5_000,
    });
  }

  const result = evaluate(input);
  assert.equal(
    result.findings.filter(
      (finding) => finding.code === "umbrella_work_item_present",
    ).length,
    4,
  );
  assert.equal(result.state, "drift");
});

test("status compara somente o par canônico", () => {
  const input = baseline();
  input.github.issues[0].status = "completed";

  const result = evaluate(input);
  assert.deepEqual(codes(result), ["status_divergence"]);
  assert.equal(result.state, "drift");
});

test("attachment precisa apontar ao counterpart exato", () => {
  const input = baseline();
  input.linear.issues[0].attachmentIssueKeys = ["example-org/repo-a#99"];

  const result = evaluate(input);
  assert.deepEqual(codes(result), [
    "github_attachment_target_missing",
    "missing_github_issue_attachment",
  ]);
});

test("comments pareiam somente por IDs e proveniência estruturada", () => {
  const matched = baseline();
  matched.github.issues[0].comments.push({
    id: "github-comment-1",
    threadId: ISSUE_KEY,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  });
  matched.linear.issues[0].comments.push({
    id: "linear-comment-1",
    provenance: "github",
    resourceKey: ISSUE_KEY,
    externalId: "github-comment-1",
    threadId: ISSUE_KEY,
    connected: true,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  });
  assert.equal(evaluate(matched).state, "clean");

  const missingOnLinear = baseline();
  missingOnLinear.github.issues[0].comments.push({
    id: "github-comment-1",
    threadId: ISSUE_KEY,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  });
  assert.ok(
    codes(evaluate(missingOnLinear)).includes("comment_sync_gap_to_linear"),
  );

  const missingOnGithub = baseline();
  missingOnGithub.linear.issues[0].comments.push({
    id: "linear-comment-1",
    provenance: "github",
    resourceKey: ISSUE_KEY,
    externalId: "github-comment-1",
    threadId: ISSUE_KEY,
    connected: true,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  });
  assert.ok(
    codes(evaluate(missingOnGithub)).includes("comment_sync_gap_to_github"),
  );
});

test("grace de comment usa createdAt e thread desconectada continua sendo drift", () => {
  const recent = baseline();
  recent.github.issues[0].comments.push({
    id: "github-comment-recent",
    threadId: ISSUE_KEY,
    createdAtMs: NOW.getTime() - COMMENT_GRACE_MINUTES * 60_000 + 1,
    updatedAtMs: NOW.getTime() - COMMENT_GRACE_MINUTES * 60_000 + 1,
  });
  assert.equal(evaluate(recent).state, "clean");

  const pendingFromLinear = baseline();
  pendingFromLinear.linear.issues[0].comments.push({
    id: "linear-comment-pending",
    provenance: "github",
    resourceKey: ISSUE_KEY,
    externalId: null,
    threadId: ISSUE_KEY,
    connected: true,
    createdAtMs: NOW.getTime() - COMMENT_GRACE_MINUTES * 60_000 + 1,
    updatedAtMs: NOW.getTime() - COMMENT_GRACE_MINUTES * 60_000 + 1,
  });
  assert.equal(evaluate(pendingFromLinear).state, "clean");

  pendingFromLinear.linear.issues[0].comments[0].createdAtMs = 1_000;
  assert.ok(
    codes(evaluate(pendingFromLinear)).includes(
      "comment_external_identity_missing",
    ),
  );

  const disconnected = baseline();
  disconnected.github.issues[0].comments.push({
    id: "github-comment-1",
    threadId: ISSUE_KEY,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  });
  disconnected.linear.issues[0].comments.push({
    id: "linear-comment-1",
    provenance: "github",
    resourceKey: ISSUE_KEY,
    externalId: "github-comment-1",
    threadId: ISSUE_KEY,
    connected: false,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  });
  assert.ok(
    codes(evaluate(disconnected)).includes("comment_sync_disconnected"),
  );
});

test("identidade global duplicada de comment invalida o snapshot", () => {
  const input = baseline();
  input.github.issues[0].comments.push(
    {
      id: "github-comment-1",
      threadId: ISSUE_KEY,
      createdAtMs: 1_000,
      updatedAtMs: 1_000,
    },
    {
      id: "github-comment-1",
      threadId: ISSUE_KEY,
      createdAtMs: 2_000,
      updatedAtMs: 2_000,
    },
  );

  const result = evaluate(input);
  assert.equal(result.state, "incomplete");
  assert.deepEqual(codes(result), ["normalized_snapshot_invalid"]);
  assert.equal(determineExitCode(result), 2);
});

test("release exige commit e pipeline exatos depois do corte", () => {
  const pullKey = "example-org/repo-a#2";
  const commitSha = "a".repeat(40);
  const clean = baseline();
  clean.linear.issues[0].carrierPullKeys = [pullKey];
  setReleaseEvidence(clean, clean.linear.issues[0], [
    {
      id: "release-1",
      pipelineId: PIPELINE_ID,
      pipelineType: "continuous",
      commitSha,
      completedAtMs: 3_000,
    },
  ]);
  clean.github.pulls.push({
    key: pullKey,
    repository: "repo-a",
    number: 2,
    updatedAtMs: 2_500,
    mergedAtMs: 2_000,
    mergeCommitSha: commitSha,
  });
  assert.equal(evaluate(clean).state, "clean");

  const missing = clone(clean);
  setReleaseEvidence(missing, missing.linear.issues[0], []);
  assert.ok(codes(evaluate(missing)).includes("missing_release"));

  const early = clone(clean);
  early.linear.issues[0].releases[0].completedAtMs = 1_999;
  early.linear.releases[0].completedAtMs = 1_999;
  const earlyResult = evaluate(early);
  assert.equal(earlyResult.state, "incomplete");
  assert.ok(codes(earlyResult).includes("release_chronology_invalid"));
});

test("pull ausente é drift quando o snapshot GitHub está completo", () => {
  const input = baseline();
  input.linear.issues[0].carrierPullKeys = ["example-org/repo-a#2"];

  assert.ok(codes(evaluate(input)).includes("carrier_pull_missing"));
});

test("duplicatas e similares são somente advisory e relações explícitas suprimem", () => {
  const duplicate = baseline();
  duplicate.linear.issues[0].teamKey = "TEAM_LOCAL";
  duplicate.linear.issues[0].teamId = TEAM_IDS.TEAM_LOCAL;
  setNativeCounterparts(duplicate.linear.issues[0], []);
  duplicate.linear.issues[0].attachmentIssueKeys = [];
  duplicate.github.issues = [];
  duplicate.linear.issues[0].duplicateKey = "scope-a:exact-a";
  addLinearIssue(duplicate, {
    teamKey: "TEAM_LOCAL",
    duplicateKey: "scope-a:exact-a",
    similarityKeys: [],
  });
  const duplicateResult = evaluate(duplicate);
  assert.equal(duplicateResult.state, "advisory");
  assert.deepEqual(codes(duplicateResult), ["duplicate_candidate"]);
  assert.equal(determineExitCode(duplicateResult), 1);

  const crossScope = baseline();
  crossScope.linear.issues[0].duplicateKey = "shared-title";
  addLinearIssue(crossScope, {
    teamKey: "TEAM_LOCAL",
    duplicateKey: "shared-title",
    similarityKeys: [],
  });
  assert.deepEqual(codes(evaluate(crossScope)), ["duplicate_candidate"]);

  const similar = baseline();
  similar.linear.issues[0].teamKey = "TEAM_LOCAL";
  similar.linear.issues[0].teamId = TEAM_IDS.TEAM_LOCAL;
  setNativeCounterparts(similar.linear.issues[0], []);
  similar.linear.issues[0].attachmentIssueKeys = [];
  similar.github.issues = [];
  similar.linear.issues[0].similarityKeys = ["scope-a:signal-a"];
  addLinearIssue(similar, {
    teamKey: "TEAM_LOCAL",
    duplicateKey: null,
    similarityKeys: ["scope-a:signal-a"],
  });
  assert.deepEqual(codes(evaluate(similar)), ["similar_issue_candidate"]);

  similar.linear.issues[0].relatedIdentifiers = ["TEAM_A-2"];
  assert.equal(evaluate(similar).state, "clean");
});

test("grupo duplicateOf transitivo suprime siblings sem varredura por pares", () => {
  const input = baseline();
  input.linear.issues[0].teamKey = "TEAM_LOCAL";
  input.linear.issues[0].teamId = TEAM_IDS.TEAM_LOCAL;
  setNativeCounterparts(input.linear.issues[0], []);
  input.linear.issues[0].attachmentIssueKeys = [];
  input.linear.issues[0].duplicateKey = "exact-group";
  input.github.issues = [];
  const second = addLinearIssue(input, {
    teamKey: "TEAM_LOCAL",
    duplicateKey: "exact-group",
    duplicateOf: "TEAM_A-1",
  });
  const third = clone(second);
  third.id = "linear-3";
  third.identifier = "TEAM_A-3";
  input.linear.issues.push(third);

  assert.equal(evaluate(input).state, "clean");
});

test("scan global agrupa milhares de candidatos sem materializar findings por par", () => {
  const input = baseline();
  input.linear.issues = [];
  input.github.issues = [];
  for (let index = 1; index <= 2_000; index += 1) {
    input.linear.issues.push({
      id: `linear-bulk-${index}`,
      identifier: `TEAM_LOCAL-${index}`,
      teamId: TEAM_IDS.TEAM_LOCAL,
      teamKey: "TEAM_LOCAL",
      updatedAtMs: 5_000,
      status: "active",
      nativeCounterparts: [],
      nativeCounterpartKeys: [],
      attachmentIssueKeys: [],
      insecureGithubResourceKeys: [],
      carrierPullKeys: [],
      comments: [],
      githubThreadControls: [],
      releases: [],
      duplicateOf: null,
      relatedIdentifiers: [],
      duplicateKey: "one-conservative-fingerprint",
      similarityKeys: [],
    });
  }

  const result = evaluate(input);
  assert.equal(result.state, "advisory");
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].references.length, 2_000);
});

test("times históricos não exigem mapping e sync nativo não se confunde com attachment", () => {
  const historical = baseline();
  historical.linear.teams.push({
    id: "historical-team-id",
    key: "HISTORICAL",
    active: false,
    updatedAtMs: 5_000,
  });
  assert.equal(evaluate(historical).state, "clean");

  const attachmentOnly = baseline();
  setNativeCounterparts(attachmentOnly.linear.issues[0], []);
  attachmentOnly.github.issues[0].comments.push({
    id: "github-comment-without-sync",
    threadId: ISSUE_KEY,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  });
  const result = evaluate(attachmentOnly);
  assert.ok(codes(result).includes("linear_issue_without_native_counterpart"));
  assert.equal(codes(result).includes("comment_sync_gap_to_linear"), false);
});

test("pipeline usa ID estável e somente release continuous concluída prova carrier", () => {
  const input = baseline();
  const pullKey = "example-org/repo-a#2";
  const commitSha = "c".repeat(40);
  const scheduledPipelineId = "00000000-0000-4000-8000-000000000002";
  input.linear.issues[0].carrierPullKeys = [pullKey];
  setReleaseEvidence(input, input.linear.issues[0], [
    {
      id: "release-scheduled",
      pipelineId: scheduledPipelineId,
      pipelineType: "scheduled",
      commitSha,
      completedAtMs: 3_000,
    },
  ]);
  input.github.pulls.push({
    key: pullKey,
    repository: "repo-a",
    number: 2,
    updatedAtMs: 2_500,
    mergedAtMs: 2_000,
    mergeCommitSha: commitSha,
  });

  assert.ok(codes(evaluate(input)).includes("missing_release"));
});

test("link GitHub inseguro é drift explícito sem virar contraparte", () => {
  const input = baseline();
  input.linear.issues[0].insecureGithubResourceKeys = [ISSUE_KEY];

  assert.ok(codes(evaluate(input)).includes("insecure_github_attachment"));
});

test("incomplete prevalece sobre drift e advisory; findings têm ordem estável", () => {
  const input = baseline();
  input.github.issues[0].status = "completed";
  input.linear.issues[0].duplicateKey = "scope-a:exact-a";
  addLinearIssue(input, {
    duplicateKey: "scope-a:exact-a",
    similarityKeys: [],
  });
  input.github.issues[0].comments.push(
    {
      id: "duplicate-comment",
      threadId: ISSUE_KEY,
      createdAtMs: 1_000,
      updatedAtMs: 1_000,
    },
    {
      id: "duplicate-comment",
      threadId: ISSUE_KEY,
      createdAtMs: 2_000,
      updatedAtMs: 2_000,
    },
  );

  const first = evaluate(input);
  const second = evaluate(clone(input));
  assert.deepEqual(first, second);
  assert.equal(first.state, "incomplete");
  assert.equal(determineExitCode(first), 2);
  assert.deepEqual(
    first.findings,
    [...first.findings].sort((left, right) =>
      `${left.severity}:${left.code}:${left.entity}:${left.references.join(",")}`.localeCompare(
        `${right.severity}:${right.code}:${right.entity}:${right.references.join(",")}`,
        "en",
      ),
    ),
  );
});
