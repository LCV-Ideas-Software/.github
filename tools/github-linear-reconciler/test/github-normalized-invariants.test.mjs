import assert from "node:assert/strict";
import test from "node:test";

import { validateSnapshots } from "../src/domain/validate-snapshot.mjs";

const CAPTURED_AT_MS = 10_000;
const ORGANIZATION = "example-org";
const REPOSITORY = "example-app";
const SHA = "a".repeat(40);

function linearSnapshot() {
  return {
    complete: true,
    failures: [],
    captureStartedAtMs: CAPTURED_AT_MS,
    capturedAtMs: CAPTURED_AT_MS,
    teams: [],
    issues: [],
    cycles: [],
    projects: [],
    initiatives: [],
    documents: [],
    releasePipelines: [],
    releases: [],
    issueToReleases: [],
  };
}

function githubSnapshot({ issues = [], pulls = [] } = {}) {
  return {
    complete: true,
    failures: [],
    captureStartedAtMs: CAPTURED_AT_MS,
    capturedAtMs: CAPTURED_AT_MS,
    organization: ORGANIZATION,
    repositories: [
      {
        id: 1,
        name: REPOSITORY,
        archived: false,
        issuesEnabled: true,
        fork: false,
      },
    ],
    issues,
    pulls,
  };
}

function pull({ mergedAtMs, mergeCommitSha }) {
  return {
    key: `${ORGANIZATION}/${REPOSITORY}#1`,
    repository: REPOSITORY,
    number: 1,
    createdAtMs: 7_000,
    updatedAtMs: 9_000,
    mergedAtMs,
    mergeCommitSha,
  };
}

function issue(number, nodeId) {
  return {
    key: `${ORGANIZATION}/${REPOSITORY}#${number}`,
    nodeId,
    repository: REPOSITORY,
    number,
    status: "active",
    createdAtMs: 7_000,
    updatedAtMs: 9_000,
    comments: [],
  };
}

test("PR normalizado aceita SHA de teste sem merge e exige SHA depois do merge", () => {
  for (const candidate of [
    pull({ mergedAtMs: null, mergeCommitSha: null }),
    pull({ mergedAtMs: null, mergeCommitSha: SHA }),
    pull({ mergedAtMs: 8_000, mergeCommitSha: SHA }),
  ]) {
    assert.deepEqual(
      validateSnapshots(
        linearSnapshot(),
        githubSnapshot({ pulls: [candidate] }),
        ORGANIZATION,
        CAPTURED_AT_MS,
      ),
      [],
    );
  }

  const invalid = validateSnapshots(
    linearSnapshot(),
    githubSnapshot({
      pulls: [pull({ mergedAtMs: 8_000, mergeCommitSha: null })],
    }),
    ORGANIZATION,
    CAPTURED_AT_MS,
  );
  assert.equal(invalid.length, 1);
  assert.match(invalid[0].message, /github pulls are invalid/u);
});

test("nodeId de GitHub Issue e globalmente unico", () => {
  const findings = validateSnapshots(
    linearSnapshot(),
    githubSnapshot({
      issues: [issue(1, "I_kwDOSharedNode"), issue(2, "I_kwDOSharedNode")],
    }),
    ORGANIZATION,
    CAPTURED_AT_MS,
  );

  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /node identities are not globally unique/u);
});

test("snapshot GitHub normalizado exige createdAt e cronologia por entidade", () => {
  for (const mutate of [
    (github) => {
      delete github.issues[0].createdAtMs;
    },
    (github) => {
      github.issues[0].createdAtMs = github.issues[0].updatedAtMs + 1;
    },
    (github) => {
      delete github.pulls[0].createdAtMs;
    },
    (github) => {
      github.pulls[0].createdAtMs = github.pulls[0].updatedAtMs + 1;
    },
  ]) {
    const github = githubSnapshot({
      issues: [issue(2, "I_kwDOIssueNode")],
      pulls: [pull({ mergedAtMs: null, mergeCommitSha: null })],
    });
    mutate(github);
    const findings = validateSnapshots(
      linearSnapshot(),
      github,
      ORGANIZATION,
      CAPTURED_AT_MS,
    );
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /github (?:issues|pulls) are invalid/u);
  }
});
