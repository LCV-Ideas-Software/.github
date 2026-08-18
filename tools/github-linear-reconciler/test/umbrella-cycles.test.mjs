import assert from "node:assert/strict";
import test from "node:test";

import { validateSnapshots } from "../src/domain/validate-snapshot.mjs";
import { evaluateUmbrella } from "../src/rules/umbrella.mjs";

const CAPTURED_AT_MS = 10_000;
const ORGANIZATION = "example-org";
const UMBRELLA_TEAM_ID = "umbrella-team-id";
const UMBRELLA_TEAM_KEY = "ROOT";

function topologyEntity(id) {
  return {
    id,
    teamId: UMBRELLA_TEAM_ID,
    teamKey: UMBRELLA_TEAM_KEY,
    updatedAtMs: 9_000,
  };
}

function umbrellaContext({
  issues = [],
  cycles = [],
  projects = [],
  initiatives = [],
  documents = [],
} = {}) {
  return {
    umbrellaTeamKey: UMBRELLA_TEAM_KEY,
    linear: { issues, cycles, projects, initiatives, documents },
  };
}

function linearSnapshot(cycles) {
  return {
    complete: true,
    failures: [],
    capturedAtMs: CAPTURED_AT_MS,
    teams: [
      {
        id: UMBRELLA_TEAM_ID,
        key: UMBRELLA_TEAM_KEY,
        active: true,
        updatedAtMs: 9_000,
      },
    ],
    issues: [],
    cycles,
    projects: [],
    initiatives: [],
    documents: [],
    releasePipelines: [],
    releases: [],
    issueToReleases: [],
  };
}

function githubSnapshot() {
  return {
    complete: true,
    failures: [],
    capturedAtMs: CAPTURED_AT_MS,
    organization: ORGANIZATION,
    repositories: [],
    issues: [],
    pulls: [],
  };
}

test("cycles herdados no umbrella nao sao trabalho residual", () => {
  const cycles = [
    topologyEntity("cycle-2026-08"),
    topologyEntity("cycle-2026-09"),
    topologyEntity("cycle-2026-10"),
  ];

  assert.deepEqual(evaluateUmbrella(umbrellaContext({ cycles })), []);
});

test("work items no umbrella continuam produzindo drift sem contar cycles", () => {
  const findings = evaluateUmbrella(
    umbrellaContext({
      issues: [{ ...topologyEntity("issue-1"), identifier: "ROOT-1" }],
      cycles: [topologyEntity("cycle-1")],
      projects: [topologyEntity("project-1")],
      initiatives: [topologyEntity("initiative-1")],
      documents: [topologyEntity("document-1")],
    }),
  );

  assert.equal(findings.length, 4);
  assert.deepEqual(
    findings.map(({ severity, code, entity }) => ({ severity, code, entity })),
    [
      {
        severity: "drift",
        code: "umbrella_work_item_present",
        entity: "ROOT-1",
      },
      {
        severity: "drift",
        code: "umbrella_work_item_present",
        entity: "project-1",
      },
      {
        severity: "drift",
        code: "umbrella_work_item_present",
        entity: "initiative-1",
      },
      {
        severity: "drift",
        code: "umbrella_work_item_present",
        entity: "document-1",
      },
    ],
  );
});

test("cycle malformado permanece fail-closed no validator", () => {
  const findings = validateSnapshots(
    linearSnapshot([
      {
        id: "cycle-without-team",
        teamId: null,
        teamKey: null,
        updatedAtMs: 9_000,
      },
    ]),
    githubSnapshot(),
    ORGANIZATION,
    CAPTURED_AT_MS,
  );

  assert.ok(
    findings.some(
      (finding) =>
        finding.severity === "incomplete" &&
        finding.code === "normalized_snapshot_invalid" &&
        /linear cycles are invalid or repeated/u.test(finding.message),
    ),
  );
});
