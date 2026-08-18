import assert from "node:assert/strict";
import test from "node:test";

import { findDuplicateOfCycles } from "../src/domain/duplicate-graph.mjs";
import { evaluateAttachments } from "../src/rules/attachments.mjs";
import { evaluateReleases } from "../src/rules/releases.mjs";

const PIPELINE_A = "00000000-0000-4000-8000-000000000001";
const PIPELINE_B = "00000000-0000-4000-8000-000000000002";
const PULL_KEY = "example-org/repo-b#7";
const COMMIT_SHA = "a".repeat(40);

function releaseContext({
  pullRepository = "repo-a",
  mergedAtMs = 2_000,
  completedAtMs = 3_000,
} = {}) {
  const pullKey = `example-org/${pullRepository}#7`;
  return {
    linear: {
      releasePipelines: [
        {
          id: PIPELINE_A,
          type: "continuous",
        },
        {
          id: PIPELINE_B,
          type: "continuous",
        },
      ],
      issues: [
        {
          identifier: "TEAM_A-1",
          teamKey: "TEAM_A",
          carrierPullKeys: [pullKey],
          releases: [
            {
              id: "release-1",
              pipelineId: pullRepository === "repo-a" ? PIPELINE_A : PIPELINE_B,
              pipelineType: "continuous",
              commitSha: COMMIT_SHA,
              completedAtMs,
            },
          ],
        },
      ],
    },
    mappingByTeam: new Map([
      [
        "TEAM_A",
        {
          mode: "github-backed",
          repository: "repo-a",
          linearReleasePipelineId: PIPELINE_A,
        },
      ],
    ]),
    mappingByRepository: new Map([
      [
        "repo-a",
        {
          mode: "github-backed",
          repository: "repo-a",
          linearReleasePipelineId: PIPELINE_A,
        },
      ],
      [
        "repo-b",
        {
          mode: "github-backed",
          repository: "repo-b",
          linearReleasePipelineId: PIPELINE_B,
        },
      ],
    ]),
    githubPullByKey: new Map([
      [
        pullKey,
        {
          key: pullKey,
          repository: pullRepository,
          mergedAtMs,
          mergeCommitSha: mergedAtMs === null ? null : COMMIT_SHA,
        },
      ],
    ]),
    releaseRequiredAfterMs: 1_000,
  };
}

function findingCodes(findings) {
  return findings.map((item) => item.code);
}

test("o mapping do team, e nao o repositorio do carrier, governa a pipeline", () => {
  const findings = evaluateReleases(
    releaseContext({ pullRepository: "repo-b" }),
  );

  assert.deepEqual(findingCodes(findings), ["carrier_repository_mismatch"]);
  assert.deepEqual(findings[0].references, [PULL_KEY, "repo-a", "repo-b"]);

  for (const mergedAtMs of [null, 500]) {
    assert.deepEqual(
      findingCodes(
        evaluateReleases(
          releaseContext({ pullRepository: "repo-b", mergedAtMs }),
        ),
      ),
      ["carrier_repository_mismatch"],
    );
  }
});

test("release sem completedAt nunca prova um carrier mesclado", () => {
  const findings = evaluateReleases(releaseContext({ completedAtMs: null }));

  assert.deepEqual(findingCodes(findings), ["missing_release"]);
});

test("release válida pós-merge prevalece sobre matches anteriores", () => {
  const context = releaseContext();
  context.linear.issues[0].releases.unshift({
    ...context.linear.issues[0].releases[0],
    id: "release-early",
    completedAtMs: 1_999,
  });

  assert.deepEqual(evaluateReleases(context), []);
});

test("attachment adicional existente permanece permitido", () => {
  const canonicalKey = "example-org/repo-a#1";
  const additionalKey = "example-org/repo-a#2";
  const findings = evaluateAttachments({
    linear: {
      issues: [
        {
          identifier: "TEAM_A-1",
          teamKey: "TEAM_A",
          nativeCounterpartKeys: [canonicalKey],
          attachmentIssueKeys: [canonicalKey, additionalKey],
          carrierPullKeys: [],
          insecureGithubResourceKeys: [],
        },
      ],
    },
    mappingByTeam: new Map([["TEAM_A", { mode: "github-backed" }]]),
    githubIssueByKey: new Map([
      [canonicalKey, {}],
      [additionalKey, {}],
    ]),
  });

  assert.deepEqual(findings, []);
});

test("duplicateOf detecta somente os nos dos ciclos dirigidos", () => {
  const issues = [
    { identifier: "TAIL", duplicateOf: "A" },
    { identifier: "A", duplicateOf: "B" },
    { identifier: "B", duplicateOf: "C" },
    { identifier: "C", duplicateOf: "A" },
    { identifier: "D", duplicateOf: "E" },
    { identifier: "E", duplicateOf: "D" },
    { identifier: "FREE", duplicateOf: null },
  ];

  assert.deepEqual(findDuplicateOfCycles(issues), [
    ["A", "B", "C"],
    ["D", "E"],
  ]);
  assert.deepEqual(
    findDuplicateOfCycles([
      { identifier: "A", duplicateOf: "B" },
      { identifier: "B", duplicateOf: null },
    ]),
    [],
  );
});

test("duplicateOf percorre cadeia longa sem recursao", () => {
  const issues = Array.from({ length: 20_000 }, (_, index) => ({
    identifier: `ISSUE-${index}`,
    duplicateOf: index === 19_999 ? null : `ISSUE-${index + 1}`,
  }));

  assert.deepEqual(findDuplicateOfCycles(issues), []);
});
