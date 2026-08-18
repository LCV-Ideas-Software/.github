import assert from "node:assert/strict";
import test from "node:test";

import { determineExitCode, evaluate } from "../src/evaluate.mjs";

const NOW = new Date(10_000_000);
const COMMENT_GRACE_MINUTES = 30;
const ISSUE_KEY = "example-org/repo-a#1";
const PIPELINE_ID = "00000000-0000-4000-8000-000000000001";

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
      teams: [
        { key: "TEAM_A", active: true },
        { key: "TEAM_LOCAL", active: true },
        { key: "TEAM_ROOT", active: true },
      ],
      issues: [
        {
          id: "linear-1",
          identifier: "TEAM_A-1",
          teamKey: "TEAM_A",
          status: "active",
          nativeCounterpartKeys: [ISSUE_KEY],
          attachmentIssueKeys: [ISSUE_KEY],
          insecureGithubResourceKeys: [],
          carrierPullKeys: [],
          comments: [],
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
    },
    github: {
      complete: true,
      failures: [],
      repositories: [{ name: "repo-a" }],
      issues: [
        {
          key: ISSUE_KEY,
          repository: "repo-a",
          number: 1,
          status: "active",
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
    attachmentIssueKeys: [],
    insecureGithubResourceKeys: [],
    ...overrides,
  });
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
    code: "partial_page",
    scope: "issues",
  });
  assert.deepEqual(codes(evaluate(contradictory)), [
    "linear_snapshot_incomplete",
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
    mergedAtMs: null,
    mergeCommitSha: null,
  });
  assert.equal(evaluate(kindCollision).state, "incomplete");
});

test("counterparts aplicam cardinalidade nos dois sentidos", () => {
  const missingFromLinear = baseline();
  missingFromLinear.linear.issues[0].nativeCounterpartKeys = [];
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
  multipleFromLinear.linear.issues[0].nativeCounterpartKeys.push(secondKey);
  multipleFromLinear.linear.issues[0].attachmentIssueKeys.push(secondKey);
  multipleFromLinear.github.issues.push({
    key: secondKey,
    repository: "repo-a",
    number: 2,
    status: "active",
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
    repository: "repo-a",
    number: 2,
    status: "active",
    comments: [],
  });
  const linearOnlyCodes = codes(evaluate(linearOnly));
  assert.ok(linearOnlyCodes.includes("linear_only_github_counterpart"));
  assert.ok(linearOnlyCodes.includes("linear_only_github_attachment"));

  const linearOnlyEvidence = baseline();
  addLinearIssue(linearOnlyEvidence, {
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
      },
    ],
    releases: [
      {
        id: "release-local",
        pipelineId: PIPELINE_ID,
        pipelineType: "continuous",
        commitSha: "b".repeat(40),
        completedAtMs: 2_000,
      },
    ],
  });
  const evidenceCodes = codes(evaluate(linearOnlyEvidence));
  assert.ok(evidenceCodes.includes("linear_only_github_attachment"));
  assert.ok(evidenceCodes.includes("linear_only_github_comment"));
  assert.ok(evidenceCodes.includes("linear_only_github_release"));

  const unknownRepository = baseline();
  unknownRepository.github.repositories.push({ name: "repo-b" });
  unknownRepository.github.issues.push({
    key: "example-org/repo-b#1",
    repository: "repo-b",
    number: 1,
    status: "active",
    comments: [],
  });
  assert.ok(
    codes(evaluate(unknownRepository)).includes(
      "github_repository_mapping_missing",
    ),
  );

  const archivedRepository = baseline();
  archivedRepository.github.repositories.push({
    name: "repo-archived",
    archived: true,
  });
  assert.equal(evaluate(archivedRepository).state, "clean");
});

test("umbrella vazio cobre todas as classes finitas de work item", () => {
  const input = baseline();
  addLinearIssue(input, { teamKey: "TEAM_ROOT" });
  for (const collection of ["cycles", "projects", "initiatives", "documents"]) {
    input.linear[collection].push({
      id: `${collection}-1`,
      teamKey: "TEAM_ROOT",
    });
  }

  const result = evaluate(input);
  assert.equal(
    result.findings.filter(
      (finding) => finding.code === "umbrella_work_item_present",
    ).length,
    5,
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
  });
  matched.linear.issues[0].comments.push({
    id: "linear-comment-1",
    provenance: "github",
    resourceKey: ISSUE_KEY,
    externalId: "github-comment-1",
    threadId: ISSUE_KEY,
    connected: true,
    createdAtMs: 1_000,
  });
  assert.equal(evaluate(matched).state, "clean");

  const missingOnLinear = baseline();
  missingOnLinear.github.issues[0].comments.push({
    id: "github-comment-1",
    threadId: ISSUE_KEY,
    createdAtMs: 1_000,
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
  });
  assert.ok(
    codes(evaluate(missingOnGithub)).includes("comment_sync_gap_to_github"),
  );
});

test("comment recente respeita grace e thread desconectada continua sendo drift", () => {
  const recent = baseline();
  recent.github.issues[0].comments.push({
    id: "github-comment-recent",
    threadId: ISSUE_KEY,
    createdAtMs: NOW.getTime() - COMMENT_GRACE_MINUTES * 60_000 + 1,
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
  });
  disconnected.linear.issues[0].comments.push({
    id: "linear-comment-1",
    provenance: "github",
    resourceKey: ISSUE_KEY,
    externalId: "github-comment-1",
    threadId: ISSUE_KEY,
    connected: false,
    createdAtMs: 1_000,
  });
  assert.ok(
    codes(evaluate(disconnected)).includes("comment_sync_disconnected"),
  );
});

test("identidade duplicada de comment torna o resultado inconclusivo", () => {
  const input = baseline();
  input.github.issues[0].comments.push(
    {
      id: "github-comment-1",
      threadId: ISSUE_KEY,
      createdAtMs: 1_000,
    },
    {
      id: "github-comment-1",
      threadId: ISSUE_KEY,
      createdAtMs: 2_000,
    },
  );

  const result = evaluate(input);
  assert.equal(result.state, "incomplete");
  assert.ok(codes(result).includes("comment_identity_ambiguous"));
  assert.equal(determineExitCode(result), 2);
});

test("release exige commit e pipeline exatos depois do corte", () => {
  const pullKey = "example-org/repo-a#2";
  const commitSha = "a".repeat(40);
  const clean = baseline();
  clean.linear.issues[0].carrierPullKeys = [pullKey];
  clean.linear.issues[0].releases = [
    {
      id: "release-1",
      pipelineId: PIPELINE_ID,
      pipelineType: "continuous",
      commitSha,
      completedAtMs: 3_000,
    },
  ];
  clean.github.pulls.push({
    key: pullKey,
    repository: "repo-a",
    number: 2,
    mergedAtMs: 2_000,
    mergeCommitSha: commitSha,
  });
  assert.equal(evaluate(clean).state, "clean");

  const missing = clone(clean);
  missing.linear.issues[0].releases = [];
  assert.ok(codes(evaluate(missing)).includes("missing_release"));

  const early = clone(clean);
  early.linear.issues[0].releases[0].completedAtMs = 1_999;
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
  duplicate.linear.issues[0].nativeCounterpartKeys = [];
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
  similar.linear.issues[0].nativeCounterpartKeys = [];
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
  input.linear.issues[0].nativeCounterpartKeys = [];
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
      teamKey: "TEAM_LOCAL",
      status: "active",
      nativeCounterpartKeys: [],
      attachmentIssueKeys: [],
      insecureGithubResourceKeys: [],
      carrierPullKeys: [],
      comments: [],
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
  historical.linear.teams.push({ key: "HISTORICAL", active: false });
  assert.equal(evaluate(historical).state, "clean");

  const attachmentOnly = baseline();
  attachmentOnly.linear.issues[0].nativeCounterpartKeys = [];
  attachmentOnly.github.issues[0].comments.push({
    id: "github-comment-without-sync",
    threadId: ISSUE_KEY,
    createdAtMs: 1_000,
  });
  const result = evaluate(attachmentOnly);
  assert.ok(codes(result).includes("linear_issue_without_native_counterpart"));
  assert.equal(codes(result).includes("comment_sync_gap_to_linear"), false);
});

test("pipeline usa ID estável e somente release continuous concluída prova carrier", () => {
  const input = baseline();
  const pullKey = "example-org/repo-a#2";
  const commitSha = "c".repeat(40);
  input.linear.issues[0].carrierPullKeys = [pullKey];
  input.linear.issues[0].releases = [
    {
      id: "release-scheduled",
      pipelineId: PIPELINE_ID,
      pipelineType: "scheduled",
      commitSha,
      completedAtMs: 3_000,
    },
  ];
  input.github.pulls.push({
    key: pullKey,
    repository: "repo-a",
    number: 2,
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
    },
    {
      id: "duplicate-comment",
      threadId: ISSUE_KEY,
      createdAtMs: 2_000,
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
