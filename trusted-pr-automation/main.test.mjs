import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ACTIONS_APP_ID,
  BOT_REVIEW_VETO_ANNOTATION_TITLE,
  BotReviewVetoError,
  CONNECTOR_ID,
  CONNECTOR_NODE_ID,
  COPILOT_REVIEWER_ID,
  COPILOT_REVIEWER_NODE_ID,
  GitHubApi,
  TRUSTED_GATE_CHECK_NAME,
  TRUSTED_GATE_SOURCE_REPOSITORY,
  TRUSTED_GATE_SOURCE_WORKFLOW_ID,
  TRUSTED_GATE_SOURCE_WORKFLOW_PATH,
  allCommitsVerified,
  assessPullCore,
  assessForEnqueue,
  buildEnqueueInput,
  botReviewVetoWorkflowCommand,
  checkEvidenceFingerprint,
  classifyPullRequestMergeability,
  classifyChecks,
  controllerCheckOutcome,
  dependabotRebaseBody,
  ensureDependabotRebaseRequest,
  enqueueAfterFinalTrustAssessment,
  evaluateConnectorEvidence,
  evaluateCopilotEvidence,
  finalizePullTrustBoundary,
  inspectTrustedGate,
  inspectRequiredCheckProducerProvenance,
  isRecoverableBotReviewVetoFailure,
  isTrustedPullRequest,
  readCheckEvidence,
  readBotReviewEvidence,
  readExactPullCore,
  requestResolvedBotReviewVetoRerun,
  requiredChecksForPhase,
  selectAssociatedPullRequests,
  selectCurrentTrustedGateRun,
  validateMergeQueueEvidence,
  validatePolicy,
  verifyCodeScanningAfterChecks,
  waitForGateEvidence,
} from "./main.mjs";

const SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const OTHER_SHA = "c".repeat(40);
const CANARY_RULESET_ID = 20591490;
const CANARY_REPOSITORY_ID = 1327548248;
const CANARY_REQUIRED_WORKFLOW_ID = 330131320;
const TRUSTED_GATE_SOURCE_REPOSITORY_ID = 1224096002;
const TRUSTED_GATE_SOURCE_SHA = "50fdb99aae9864da829d649e695ac3c4729f18b7";
const TRUSTED_GATE_SOURCE_BLOB = "3d61c1c7a3cc909537d34f824bdd9574ffeb285e";
const ZIZMOR_REUSABLE_SHA = "ac3d4ad22073ee419cb9b861c38fe7bfa93b132a";
const ZIZMOR_REUSABLE_BLOB = "a2679fe213abffdf527597df9a61d31cf2ee76f6";

function actor(login = "lcv-leo", id = 268063598) {
  return { login, id };
}

function pull(overrides = {}) {
  return {
    number: 7,
    state: "open",
    draft: false,
    user: actor(),
    head: {
      sha: SHA,
      repo: { full_name: "LCV-Ideas-Software/example" },
    },
    base: {
      ref: "main",
      sha: BASE_SHA,
      repo: { full_name: "LCV-Ideas-Software/example" },
    },
    ...overrides,
  };
}

function policy() {
  return {
    schema_version: 1,
    organization: "LCV-Ideas-Software",
    allowed_actors: [actor(), actor("dependabot[bot]", 49699333)],
    copilot_reviewer: {
      database_id: COPILOT_REVIEWER_ID,
      node_id: COPILOT_REVIEWER_NODE_ID,
      rest_review_login: "copilot-pull-request-reviewer[bot]",
      graphql_login: "copilot-pull-request-reviewer",
      inline_alias_login: "Copilot",
    },
    repositories: {
      example: {
        required_checks: [
          { name: "Analyze actions", app_id: ACTIONS_APP_ID },
          { name: "CodeQL", app_id: 57789 },
          { name: "Run zizmor / Run zizmor", app_id: ACTIONS_APP_ID },
          { name: "zizmor", app_id: 57789 },
        ],
        merge_group_required_checks: [
          { name: "Synthetic integration", app_id: ACTIONS_APP_ID },
        ],
      },
    },
  };
}

function restCopilotActor(
  login = "copilot-pull-request-reviewer[bot]",
  id = COPILOT_REVIEWER_ID,
  nodeId = COPILOT_REVIEWER_NODE_ID,
) {
  return {
    login,
    id,
    node_id: nodeId,
    type: "Bot",
  };
}

function graphqlCopilotActor(
  login = "copilot-pull-request-reviewer",
  databaseId = COPILOT_REVIEWER_ID,
  nodeId = COPILOT_REVIEWER_NODE_ID,
) {
  return {
    login,
    databaseId,
    id: nodeId,
    __typename: "Bot",
  };
}

function graphqlConnectorActor(
  login = "chatgpt-codex-connector",
  databaseId = CONNECTOR_ID,
  nodeId = CONNECTOR_NODE_ID,
) {
  return {
    login,
    databaseId,
    id: nodeId,
    __typename: "Bot",
  };
}

function copilotReview(commitId = SHA, overrides = {}) {
  return {
    id: 123,
    user: restCopilotActor(),
    state: "COMMENTED",
    commit_id: commitId,
    submitted_at: "2026-08-08T12:00:00Z",
    body: "Copilot reviewed 1 out of 1 changed file in this pull request and generated no comments.",
    ...overrides,
  };
}

function check(
  name,
  appId,
  status = "completed",
  conclusion = "success",
  id = 1,
  checkSuiteId = id + 100000,
) {
  return {
    id,
    name,
    status,
    conclusion,
    app: { id: appId },
    check_suite: { id: checkSuiteId },
  };
}

function trustedGateFixture({
  checkId = 93120160052,
  jobId = checkId + 1000,
  checkSuiteId = 84829903484,
  runId = 31264423091,
  status = "completed",
  conclusion = "success",
  runAttempt = 1,
  runOverrides = {},
  jobOverrides = {},
  workflowOverrides = {},
} = {}) {
  const fullRepository = "LCV-Ideas-Software/example";
  const runUrl = `https://api.github.com/repos/${fullRepository}/actions/runs/${runId}`;
  const workflowUrl = `https://api.github.com/repos/${TRUSTED_GATE_SOURCE_REPOSITORY}/actions/workflows/${TRUSTED_GATE_SOURCE_WORKFLOW_ID}`;
  return {
    checkRun: {
      ...check(
        TRUSTED_GATE_CHECK_NAME,
        ACTIONS_APP_ID,
        status,
        conclusion,
        checkId,
      ),
      check_suite: { id: checkSuiteId },
      completed_at: status === "completed" ? "2026-08-08T12:00:00Z" : null,
      details_url: `https://github.com/${fullRepository}/actions/runs/${runId}/job/${jobId}`,
    },
    job: {
      id: jobId,
      run_id: runId,
      run_url: runUrl,
      check_run_url: `https://api.github.com/repos/${fullRepository}/check-runs/${checkId}`,
      head_sha: SHA,
      name: TRUSTED_GATE_CHECK_NAME,
      workflow_name: TRUSTED_GATE_CHECK_NAME,
      run_attempt: runAttempt,
      status,
      conclusion,
      ...jobOverrides,
    },
    run: {
      id: runId,
      url: runUrl,
      check_suite_id: checkSuiteId,
      head_sha: SHA,
      event: "pull_request",
      name: TRUSTED_GATE_CHECK_NAME,
      path: TRUSTED_GATE_SOURCE_WORKFLOW_PATH,
      workflow_id: TRUSTED_GATE_SOURCE_WORKFLOW_ID,
      workflow_url: workflowUrl,
      repository: { full_name: fullRepository },
      head_repository: { full_name: fullRepository },
      status,
      conclusion,
      run_attempt: runAttempt,
      updated_at: "2026-08-08T12:00:00Z",
      ...runOverrides,
    },
    workflow: {
      id: TRUSTED_GATE_SOURCE_WORKFLOW_ID,
      name: TRUSTED_GATE_CHECK_NAME,
      path: TRUSTED_GATE_SOURCE_WORKFLOW_PATH,
      state: "active",
      url: workflowUrl,
      ...workflowOverrides,
    },
  };
}

function trustedGateApi(fixtures, { annotations = [] } = {}) {
  const list = Array.isArray(fixtures) ? fixtures : [fixtures];
  const calls = [];
  return {
    calls,
    pages: async (path) => {
      calls.push([path]);
      if (path.includes("/actions/runs?check_suite_id=")) {
        const suite = Number(
          new URL(`https://api.github.test${path}`).searchParams.get(
            "check_suite_id",
          ),
        );
        return list
          .filter(({ run }) => Number(run.check_suite_id) === suite)
          .map(({ run }) => run);
      }
      if (path.includes("/annotations")) return annotations;
      assert.fail(`unexpected paginated request: ${path}`);
    },
    request: async (path, options) => {
      calls.push([path, options]);
      const jobMatch = path.match(/\/actions\/jobs\/(\d+)$/);
      if (jobMatch) {
        return list.find(({ job }) => Number(job.id) === Number(jobMatch[1]))
          ?.job;
      }
      if (path.includes("/actions/workflows/")) {
        return list[0].workflow;
      }
      if (path.endsWith("/rerun-failed-jobs")) return null;
      assert.fail(`unexpected request: ${path}`);
    },
  };
}

function canaryRepositoryPolicy() {
  return {
    required_checks: [
      { name: "Governance configuration", app_id: ACTIONS_APP_ID },
      { name: "Analyze actions", app_id: ACTIONS_APP_ID },
      { name: "CodeQL", app_id: 57789 },
      { name: "Run zizmor / Run zizmor", app_id: ACTIONS_APP_ID },
      { name: "zizmor", app_id: 57789 },
    ],
    provenance: {
      trusted_gate: {
        ruleset_id: CANARY_RULESET_ID,
        repository_id: CANARY_REPOSITORY_ID,
        required_workflow_id: CANARY_REQUIRED_WORKFLOW_ID,
        source_repository_id: TRUSTED_GATE_SOURCE_REPOSITORY_ID,
        source_repository: TRUSTED_GATE_SOURCE_REPOSITORY,
        source_workflow_id: TRUSTED_GATE_SOURCE_WORKFLOW_ID,
        source_workflow_path: TRUSTED_GATE_SOURCE_WORKFLOW_PATH,
        source_sha: TRUSTED_GATE_SOURCE_SHA,
        source_blob_sha: TRUSTED_GATE_SOURCE_BLOB,
      },
      required_check_producers: [
        {
          check_name: "Governance configuration",
          app_id: ACTIONS_APP_ID,
          workflow_id: 329920424,
          workflow_name: "Enterprise governance validation",
          workflow_path:
            ".github/workflows/enterprise-governance-validation.yml",
          workflow_blob_sha: "62429f53521507f975dba58a61e50d22734420f6",
          referenced_workflows: [],
        },
        {
          check_name: "Analyze actions",
          app_id: ACTIONS_APP_ID,
          workflow_id: 329928478,
          workflow_name: "CodeQL",
          workflow_path: ".github/workflows/codeql.yml",
          workflow_blob_sha: "f6e0a120f9c221687bfb01d7fabc6fa18e371ca3",
          referenced_workflows: [],
        },
        {
          check_name: "Run zizmor / Run zizmor",
          app_id: ACTIONS_APP_ID,
          workflow_id: 329920427,
          workflow_name: "Zizmor",
          workflow_path: ".github/workflows/zizmor.yml",
          workflow_blob_sha: "fe39f2311cd46a3f639547fd70823d4db527fbd3",
          referenced_workflows: [
            {
              path: `LCV-Ideas-Software/.github/.github/workflows/zizmor.yml@${ZIZMOR_REUSABLE_SHA}`,
              sha: ZIZMOR_REUSABLE_SHA,
              repository: TRUSTED_GATE_SOURCE_REPOSITORY,
              workflow_path: ".github/workflows/zizmor.yml",
              blob_sha: ZIZMOR_REUSABLE_BLOB,
            },
          ],
        },
      ],
    },
  };
}

function canaryTrustedGateFixture({
  enforcement = "active",
  status = "completed",
  conclusion = "success",
  runAttempt = 1,
  graphSourceSha = TRUSTED_GATE_SOURCE_SHA,
  rulesetSourceSha = TRUSTED_GATE_SOURCE_SHA,
  sourceBlobSha = TRUSTED_GATE_SOURCE_BLOB,
} = {}) {
  const fullRepository = "LCV-Ideas-Software/.github-private";
  const checkId = 93146599203;
  const runId = 31274823213;
  const suiteId = 84854954363;
  const runUrl = `https://api.github.com/repos/${fullRepository}/actions/runs/${runId}`;
  const sourceWorkflowUrl = `https://api.github.com/repos/${TRUSTED_GATE_SOURCE_REPOSITORY}/actions/workflows/${TRUSTED_GATE_SOURCE_WORKFLOW_ID}`;
  const requiredWorkflowUrl = `https://api.github.com/repos/${fullRepository}/actions/required_workflows/${CANARY_REQUIRED_WORKFLOW_ID}`;
  return {
    checkRun: {
      ...check(
        TRUSTED_GATE_CHECK_NAME,
        ACTIONS_APP_ID,
        status,
        conclusion,
        checkId,
        suiteId,
      ),
      details_url: `https://github.com/${fullRepository}/actions/runs/${runId}/job/${checkId}`,
    },
    job: {
      id: checkId,
      run_id: runId,
      run_url: runUrl,
      check_run_url: `https://api.github.com/repos/${fullRepository}/check-runs/${checkId}`,
      head_sha: SHA,
      name: TRUSTED_GATE_CHECK_NAME,
      workflow_name: TRUSTED_GATE_CHECK_NAME,
      run_attempt: runAttempt,
      status,
      conclusion,
    },
    run: {
      id: runId,
      node_id: "WFR_canary_trusted_gate",
      url: runUrl,
      check_suite_id: suiteId,
      head_sha: SHA,
      event: "pull_request",
      name: TRUSTED_GATE_CHECK_NAME,
      path: TRUSTED_GATE_SOURCE_WORKFLOW_PATH,
      workflow_id: CANARY_REQUIRED_WORKFLOW_ID,
      workflow_url: requiredWorkflowUrl,
      repository: { id: CANARY_REPOSITORY_ID, full_name: fullRepository },
      head_repository: { id: CANARY_REPOSITORY_ID, full_name: fullRepository },
      referenced_workflows: [],
      status,
      conclusion,
      run_attempt: runAttempt,
    },
    graphRun: {
      databaseId: runId,
      event: "pull_request",
      runAttempt,
      url: `https://github.com/${fullRepository}/actions/runs/${runId}`,
      file: {
        id: "WFRF_canary_trusted_gate",
        path: TRUSTED_GATE_SOURCE_WORKFLOW_PATH,
        repositoryName: TRUSTED_GATE_SOURCE_REPOSITORY,
        repositoryFileUrl: `https://github.com/${TRUSTED_GATE_SOURCE_REPOSITORY}/blob/${graphSourceSha}/${TRUSTED_GATE_SOURCE_WORKFLOW_PATH}`,
        resourcePath: `/${fullRepository}/actions/runs/${runId}/workflow`,
        url: `https://github.com/${fullRepository}/actions/runs/${runId}/workflow`,
      },
      workflow: {
        databaseId: CANARY_REQUIRED_WORKFLOW_ID,
        name: TRUSTED_GATE_CHECK_NAME,
        state: "ACTIVE",
        resourcePath: `/${fullRepository}/actions/workflows/required/${TRUSTED_GATE_SOURCE_REPOSITORY}/${TRUSTED_GATE_SOURCE_WORKFLOW_PATH}`,
        url: `https://github.com/${fullRepository}/actions/workflows/required/${TRUSTED_GATE_SOURCE_REPOSITORY}/${TRUSTED_GATE_SOURCE_WORKFLOW_PATH}`,
      },
    },
    sourceWorkflow: {
      id: TRUSTED_GATE_SOURCE_WORKFLOW_ID,
      name: TRUSTED_GATE_CHECK_NAME,
      path: TRUSTED_GATE_SOURCE_WORKFLOW_PATH,
      state: "active",
      url: sourceWorkflowUrl,
    },
    sourceFile: {
      path: TRUSTED_GATE_SOURCE_WORKFLOW_PATH,
      sha: sourceBlobSha,
      html_url: `https://github.com/${TRUSTED_GATE_SOURCE_REPOSITORY}/blob/${TRUSTED_GATE_SOURCE_SHA}/${TRUSTED_GATE_SOURCE_WORKFLOW_PATH}`,
    },
    ruleset: {
      id: CANARY_RULESET_ID,
      name: "Canary: .github-private trusted workflow and Copilot",
      target: "branch",
      source_type: "Organization",
      source: "LCV-Ideas-Software",
      enforcement,
      bypass_actors: [],
      conditions: {
        repository_id: { repository_ids: [CANARY_REPOSITORY_ID] },
        ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] },
      },
      rules: [
        {
          type: "workflows",
          parameters: {
            do_not_enforce_on_create: false,
            workflows: [
              {
                repository_id: TRUSTED_GATE_SOURCE_REPOSITORY_ID,
                path: TRUSTED_GATE_SOURCE_WORKFLOW_PATH,
                sha: rulesetSourceSha,
              },
            ],
          },
        },
        {
          type: "copilot_code_review",
          parameters: {
            review_on_push: true,
            review_draft_pull_requests: false,
          },
        },
      ],
    },
  };
}

function canaryTrustedGateApi(fixture) {
  return {
    pages: async (path) => {
      if (path.includes("/actions/runs?check_suite_id=")) return [fixture.run];
      assert.fail(`unexpected paginated request: ${path}`);
    },
    request: async (path) => {
      if (path.endsWith(`/actions/jobs/${fixture.job.id}`)) return fixture.job;
      if (
        path.endsWith(`/actions/workflows/${TRUSTED_GATE_SOURCE_WORKFLOW_ID}`)
      )
        return fixture.sourceWorkflow;
      if (path.includes("/contents/") && path.includes("?ref="))
        return fixture.sourceFile;
      if (path === `/orgs/LCV-Ideas-Software/rulesets/${CANARY_RULESET_ID}`)
        return fixture.ruleset;
      assert.fail(`unexpected request: ${path}`);
    },
    graphql: async (_query, variables) => {
      assert.equal(variables.id, fixture.run.node_id);
      return { node: fixture.graphRun };
    },
  };
}

function canaryProducerFixtures() {
  const repository = "LCV-Ideas-Software/.github-private";
  const configs = canaryRepositoryPolicy().provenance.required_check_producers;
  const identities = [
    { checkId: 93146599292, suiteId: 84854954427, runId: 31274823248 },
    { checkId: 93146599301, suiteId: 84854954377, runId: 31274823227 },
    { checkId: 93146599963, suiteId: 84854955116, runId: 31274823552 },
  ];
  return configs.map((config, index) => {
    const { checkId, suiteId, runId } = identities[index];
    const runUrl = `https://api.github.com/repos/${repository}/actions/runs/${runId}`;
    const workflowUrl = `https://api.github.com/repos/${repository}/actions/workflows/${config.workflow_id}`;
    const htmlRunUrl = `https://github.com/${repository}/actions/runs/${runId}`;
    return {
      config,
      checkRun: {
        ...check(
          config.check_name,
          ACTIONS_APP_ID,
          "completed",
          "success",
          checkId,
          suiteId,
        ),
        details_url: `${htmlRunUrl}/job/${checkId}`,
      },
      job: {
        id: checkId,
        run_id: runId,
        run_url: runUrl,
        check_run_url: `https://api.github.com/repos/${repository}/check-runs/${checkId}`,
        head_sha: SHA,
        name: config.check_name,
        workflow_name: config.workflow_name,
        run_attempt: 1,
        status: "completed",
        conclusion: "success",
      },
      run: {
        id: runId,
        node_id: `WFR_producer_${index}`,
        url: runUrl,
        check_suite_id: suiteId,
        head_sha: SHA,
        event: "pull_request",
        name: config.workflow_name,
        path: config.workflow_path,
        workflow_id: config.workflow_id,
        workflow_url: workflowUrl,
        repository: { id: CANARY_REPOSITORY_ID, full_name: repository },
        head_repository: { id: CANARY_REPOSITORY_ID, full_name: repository },
        referenced_workflows: config.referenced_workflows.map(
          ({ path, sha }) => ({
            path,
            sha,
          }),
        ),
        status: "completed",
        conclusion: "success",
        run_attempt: 1,
      },
      graphRun: {
        databaseId: runId,
        event: "pull_request",
        runAttempt: 1,
        url: htmlRunUrl,
        file: {
          id: `WFRF_producer_${index}`,
          path: config.workflow_path,
          repositoryName: repository,
          repositoryFileUrl: `https://github.com/${repository}/blob/${SHA}/${config.workflow_path}`,
          resourcePath: `/${repository}/actions/runs/${runId}/workflow`,
          url: `${htmlRunUrl}/workflow`,
        },
        workflow: {
          databaseId: config.workflow_id,
          name: config.workflow_name,
          state: "ACTIVE",
          resourcePath: `/${repository}/actions/workflows/${config.workflow_path.split("/").at(-1)}`,
          url: `https://github.com/${repository}/actions/workflows/${config.workflow_path.split("/").at(-1)}`,
        },
      },
      workflow: {
        id: config.workflow_id,
        name: config.workflow_name,
        path: config.workflow_path,
        state: "active",
        url: workflowUrl,
      },
      sourceFile: {
        path: config.workflow_path,
        sha: config.workflow_blob_sha,
        html_url: `https://github.com/${repository}/blob/${SHA}/${config.workflow_path}`,
      },
    };
  });
}

function canaryProducerApi(fixtures) {
  return {
    pages: async (path) => {
      if (path.includes("/actions/runs?check_suite_id=")) {
        const suite = Number(
          new URL(`https://api.github.test${path}`).searchParams.get(
            "check_suite_id",
          ),
        );
        return fixtures
          .filter(({ run }) => run.check_suite_id === suite)
          .map(({ run }) => run);
      }
      assert.fail(`unexpected paginated request: ${path}`);
    },
    request: async (path) => {
      const jobMatch = path.match(/\/actions\/jobs\/(\d+)$/);
      if (jobMatch) {
        return fixtures.find(({ job }) => job.id === Number(jobMatch[1]))?.job;
      }
      const workflowMatch = path.match(/\/actions\/workflows\/(\d+)$/);
      if (workflowMatch) {
        return fixtures.find(
          ({ workflow }) => workflow.id === Number(workflowMatch[1]),
        )?.workflow;
      }
      if (path.includes("/contents/")) {
        const reusable =
          canaryRepositoryPolicy().provenance.required_check_producers[2]
            .referenced_workflows[0];
        if (
          path ===
          `/repos/${reusable.repository}/contents/${reusable.workflow_path}?ref=${reusable.sha}`
        ) {
          return {
            path: reusable.workflow_path,
            sha: reusable.blob_sha,
            html_url: `https://github.com/${reusable.repository}/blob/${reusable.sha}/${reusable.workflow_path}`,
          };
        }
        return fixtures.find(
          ({ sourceFile }) =>
            path ===
            `/repos/LCV-Ideas-Software/.github-private/contents/${sourceFile.path}?ref=${SHA}`,
        )?.sourceFile;
      }
      assert.fail(`unexpected request: ${path}`);
    },
    graphql: async (_query, variables) => ({
      node: fixtures.find(({ run }) => run.node_id === variables.id)?.graphRun,
    }),
  };
}

function connectorComment(body, createdAt = "2026-08-08T12:00:00Z") {
  return {
    user: graphqlConnectorActor(),
    body,
    created_at: createdAt,
  };
}

function cleanComment(sha = SHA, createdAt) {
  return connectorComment(
    `Codex Review: Didn't find any major issues. Delightful!\n\n**Reviewed commit:** \`${sha.slice(0, 10)}\``,
    createdAt,
  );
}

function connectorEvidence({
  headSha = SHA,
  issueComments = [cleanComment(headSha)],
  reviews = [],
  threads = [],
} = {}) {
  return {
    headSha,
    issueComments,
    reviews,
    threads,
    policy: validatePolicy(policy()),
  };
}

test("validatePolicy accepts exact identities and executor plus GHAS checks", () => {
  const checked = validatePolicy(policy());
  assert.equal(checked.organization, "LCV-Ideas-Software");
  assert.equal(checked.copilot_reviewer.database_id, COPILOT_REVIEWER_ID);
  assert.equal(checked.copilot_reviewer.node_id, COPILOT_REVIEWER_NODE_ID);
});

test("validatePolicy rejects duplicate identities, duplicate checks, and self-gating", () => {
  const duplicateActor = policy();
  duplicateActor.allowed_actors.push(actor());
  assert.throws(
    () => validatePolicy(duplicateActor),
    /duplicate allowed actor/i,
  );

  const duplicateCheck = policy();
  duplicateCheck.repositories.example.merge_group_required_checks.push({
    name: "CodeQL",
    app_id: 57789,
  });
  assert.throws(
    () => validatePolicy(duplicateCheck),
    /duplicate required check/i,
  );

  const recursive = policy();
  recursive.repositories.example.merge_group_required_checks.push({
    name: TRUSTED_GATE_CHECK_NAME,
    app_id: ACTIONS_APP_ID,
  });
  assert.throws(() => validatePolicy(recursive), /must not require itself/i);

  const malformedPhase = policy();
  malformedPhase.repositories.example.merge_group_required_checks = {};
  assert.throws(
    () => validatePolicy(malformedPhase),
    /merge_group_required_checks must be an array/i,
  );

  for (const [field, value] of [
    ["database_id", 1],
    ["node_id", "BOT_spoof"],
    ["rest_review_login", "Copilot"],
    ["graphql_login", "copilot-pull-request-reviewer[bot]"],
    ["inline_alias_login", "copilot-pull-request-reviewer"],
  ]) {
    const malformedCopilot = policy();
    malformedCopilot.copilot_reviewer[field] = value;
    assert.throws(
      () => validatePolicy(malformedCopilot),
      /Copilot reviewer identity/i,
      field,
    );
  }
});

test("validatePolicy admits provenance only for the complete .github-private canary", () => {
  const valid = policy();
  valid.repositories[".github-private"] = canaryRepositoryPolicy();
  assert.deepEqual(
    validatePolicy(valid).repositories[".github-private"].provenance,
    canaryRepositoryPolicy().provenance,
  );

  const wrongScope = policy();
  wrongScope.repositories.example.provenance =
    canaryRepositoryPolicy().provenance;
  assert.throws(
    () => validatePolicy(wrongScope),
    /example must not define provenance authority/i,
  );

  const incomplete = policy();
  incomplete.repositories[".github-private"] = canaryRepositoryPolicy();
  incomplete.repositories[
    ".github-private"
  ].provenance.required_check_producers.pop();
  assert.throws(() => validatePolicy(incomplete), /provenance is incomplete/i);

  const wrongPin = policy();
  wrongPin.repositories[".github-private"] = canaryRepositoryPolicy();
  wrongPin.repositories[".github-private"].provenance.trusted_gate.source_sha =
    "not-a-sha";
  assert.throws(() => validatePolicy(wrongPin), /source pin is invalid/i);

  const wrongReference = policy();
  wrongReference.repositories[".github-private"] = canaryRepositoryPolicy();
  wrongReference.repositories[
    ".github-private"
  ].provenance.required_check_producers[2].referenced_workflows[0].path =
    "LCV-Ideas-Software/.github/.github/workflows/spoof.yml@" +
    ZIZMOR_REUSABLE_SHA;
  assert.throws(
    () => validatePolicy(wrongReference),
    /referenced workflow pin is invalid/i,
  );
});

test("isTrustedPullRequest accepts only exact allowlisted same-repository main PRs", () => {
  const checked = validatePolicy(policy());
  const missingDraft = pull();
  delete missingDraft.draft;
  assert.deepEqual(
    isTrustedPullRequest(pull(), "LCV-Ideas-Software/example", checked),
    { ok: true },
  );
  const cases = [
    [pull({ user: actor("lcv-leo", 1) }), /not allowlisted/i],
    [pull({ user: actor("lookalike", 268063598) }), /not allowlisted/i],
    [pull({ draft: true }), /draft/i],
    [pull({ draft: null }), /draft/i],
    [pull({ draft: "false" }), /draft/i],
    [pull({ draft: 0 }), /draft/i],
    [missingDraft, /draft/i],
    [pull({ state: "closed" }), /not open/i],
    [pull({ base: { ...pull().base, ref: "release" } }), /base main/i],
    [
      pull({
        head: { sha: SHA, repo: { full_name: "attacker/fork" } },
      }),
      /same repository/i,
    ],
    [pull({ head: { ...pull().head, sha: "not-a-sha" } }), /head sha/i],
  ];
  for (const [candidate, expected] of cases) {
    assert.match(
      isTrustedPullRequest(candidate, "LCV-Ideas-Software/example", checked)
        .reason,
      expected,
    );
  }
});

test("connector clean, unknown, and lookalike signals are informational", () => {
  assert.equal(evaluateConnectorEvidence(connectorEvidence()).ok, true);
  const liveLikeClean = cleanComment();
  liveLikeClean.body += `

<details> <summary>ℹ️ About Codex in GitHub</summary>
<br/>

Codex can also answer questions or update the PR.
</details>`;
  assert.deepEqual(
    evaluateConnectorEvidence(
      connectorEvidence({ issueComments: [liveLikeClean] }),
    ),
    { ok: true },
  );
  assert.deepEqual(
    evaluateConnectorEvidence(
      connectorEvidence({ issueComments: [cleanComment(OTHER_SHA)] }),
    ),
    { ok: true },
  );

  for (const user of [
    graphqlConnectorActor("lookalike"),
    graphqlConnectorActor("chatgpt-codex-connector", 1),
    graphqlConnectorActor("chatgpt-codex-connector", CONNECTOR_ID, "BOT_spoof"),
    { ...graphqlConnectorActor(), __typename: "User" },
  ]) {
    const spoofed = cleanComment();
    spoofed.user = user;
    assert.deepEqual(
      evaluateConnectorEvidence(
        connectorEvidence({ issueComments: [spoofed] }),
      ),
      { ok: true },
    );
  }

  const unknownReview = (sha) =>
    connectorComment(
      `Codex Review: Found an issue.\n\n**Reviewed commit:** \`${sha.slice(0, 10)}\``,
    );
  assert.deepEqual(
    evaluateConnectorEvidence(
      connectorEvidence({ issueComments: [unknownReview(SHA)] }),
    ),
    { ok: true },
  );
  assert.deepEqual(
    evaluateConnectorEvidence(
      connectorEvidence({ issueComments: [unknownReview(OTHER_SHA)] }),
    ),
    { ok: true },
  );
  assert.deepEqual(
    evaluateConnectorEvidence(
      connectorEvidence({
        issueComments: [connectorComment("Codex Review: Found an issue")],
      }),
    ),
    { ok: true },
  );
  assert.deepEqual(
    evaluateConnectorEvidence(
      connectorEvidence({
        issueComments: [
          connectorComment(
            "Codex Review: Didn't find any major issues. Missing binding.",
          ),
        ],
      }),
    ),
    { ok: true },
  );
  assert.deepEqual(
    evaluateConnectorEvidence(
      connectorEvidence({
        issueComments: [connectorComment("Review is still in progress.")],
      }),
    ),
    { ok: true },
  );

  const explicitFinding = connectorComment(
    `### 💡 Codex Review\n\nA finding.\n\n**Reviewed commit:** \`${SHA.slice(0, 10)}\``,
  );
  assert.match(
    evaluateConnectorEvidence(
      connectorEvidence({ issueComments: [explicitFinding] }),
    ).reason,
    /reports a current-head finding/i,
  );
  for (const body of [
    `\`\`\`md\n### 💡 Codex Review\n\`\`\`\n\n**Reviewed commit:** \`${SHA.slice(0, 10)}\``,
    `> ### 💡 Codex Review\n\n**Reviewed commit:** \`${SHA.slice(0, 10)}\``,
  ]) {
    assert.deepEqual(
      evaluateConnectorEvidence(
        connectorEvidence({ issueComments: [connectorComment(body)] }),
      ),
      { ok: true },
      body,
    );
  }
});

test("bot reviews are optional and only observed negative signals veto", () => {
  const checked = validatePolicy(policy());
  assert.deepEqual(
    evaluateConnectorEvidence(connectorEvidence({ issueComments: [] })),
    { ok: true },
  );
  assert.deepEqual(
    evaluateConnectorEvidence(
      connectorEvidence({
        issueComments: [{ user: actor(), body: "@codex review" }],
      }),
    ),
    { ok: true },
  );
  assert.deepEqual(
    evaluateCopilotEvidence({
      headSha: SHA,
      reviews: [],
      threads: [],
      policy: checked,
    }),
    { ok: true },
  );

  for (const body of [
    "Copilot wasn't able to review any files in this pull request.",
    "Copilot encountered an error and was unable to review this pull request. You can try again by re-requesting a review.",
    "Copilot was unable to review this pull request because the user who requested the review has reached their quota limit.",
  ]) {
    assert.deepEqual(
      evaluateCopilotEvidence({
        headSha: SHA,
        reviews: [copilotReview(SHA, { body })],
        threads: [],
        policy: checked,
      }),
      { ok: true },
      body,
    );
  }

  assert.deepEqual(
    evaluateCopilotEvidence({
      headSha: SHA,
      reviews: [
        copilotReview(SHA, {
          body: "Copilot reviewed 6 out of 7 changed files in this pull request and generated no new comments.",
        }),
      ],
      threads: [],
      policy: checked,
    }),
    { ok: true },
  );
});

test("resolved bot threads dirime visible findings while unresolved or suppressed signals veto", () => {
  const checked = validatePolicy(policy());
  const findingReview = copilotReview(SHA, {
    id: 321,
    body: "Copilot reviewed 2 out of 2 changed files in this pull request and generated 2 comments.",
  });
  const findingThread = (resolved, suffix) => ({
    isResolved: resolved,
    comments: [
      {
        author: graphqlCopilotActor(),
        reviewId: 321,
        reviewCommit: { oid: SHA },
        body: `finding ${suffix}`,
      },
    ],
  });
  const resolvedThreads = [
    findingThread(true, "one"),
    findingThread(true, "two"),
  ];
  assert.deepEqual(
    evaluateCopilotEvidence({
      headSha: SHA,
      reviews: [findingReview],
      threads: resolvedThreads,
      policy: checked,
    }),
    { ok: true },
  );
  assert.match(
    evaluateCopilotEvidence({
      headSha: SHA,
      reviews: [findingReview],
      threads: [findingThread(true, "one"), findingThread(false, "two")],
      policy: checked,
    }).reason,
    /unresolved Copilot review thread/i,
  );
  const unresolvedFinding = findingThread(false, "one");
  assert.match(
    evaluateCopilotEvidence({
      headSha: SHA,
      reviews: [
        {
          ...findingReview,
          body: `${findingReview.body}\n<summary>Suppressed comments (1)</summary>`,
        },
      ],
      threads: [unresolvedFinding, findingThread(true, "two")],
      policy: checked,
    }).reason,
    /suppressed Copilot finding/i,
  );
  assert.match(
    evaluateCopilotEvidence({
      headSha: SHA,
      reviews: [{ ...findingReview, body: "unknown review body" }],
      threads: [unresolvedFinding, findingThread(true, "two")],
      policy: checked,
    }).reason,
    /unresolved Copilot review thread/i,
  );
  assert.deepEqual(
    evaluateCopilotEvidence({
      headSha: SHA,
      reviews: [findingReview],
      threads: [findingThread(true, "one")],
      policy: checked,
    }),
    { ok: true },
  );

  const suppressed = copilotReview(SHA, {
    id: 320,
    body: `${copilotReview().body}\n<summary>Suppressed comments (1)</summary>`,
  });
  assert.match(
    evaluateCopilotEvidence({
      headSha: SHA,
      reviews: [suppressed, copilotReview(SHA, { id: 321 })],
      threads: [],
      policy: checked,
    }).reason,
    /suppressed Copilot finding/i,
  );
  assert.match(
    evaluateCopilotEvidence({
      headSha: SHA,
      reviews: [copilotReview(SHA, { id: 320 }), { ...suppressed, id: 321 }],
      threads: [],
      policy: checked,
    }).reason,
    /suppressed Copilot finding/i,
  );
  assert.deepEqual(
    evaluateCopilotEvidence({
      headSha: SHA,
      reviews: [
        copilotReview(OTHER_SHA, { id: 320, body: suppressed.body }),
        copilotReview(SHA, { id: 321 }),
      ],
      threads: [],
      policy: checked,
    }),
    { ok: true },
  );

  const connectorThread = {
    isResolved: true,
    comments: [
      {
        author: graphqlConnectorActor(),
        reviewId: 444,
        reviewCommit: { oid: SHA },
      },
    ],
  };
  assert.deepEqual(
    evaluateConnectorEvidence(
      connectorEvidence({
        issueComments: [],
        reviews: [
          {
            id: 444,
            user: graphqlConnectorActor(),
            state: "COMMENTED",
            commit_id: SHA,
            body: "### 💡 Codex Review",
          },
        ],
        threads: [connectorThread],
      }),
    ),
    { ok: true },
  );
  assert.match(
    evaluateConnectorEvidence(
      connectorEvidence({
        issueComments: [],
        reviews: [
          {
            id: 444,
            user: graphqlConnectorActor(),
            state: "COMMENTED",
            commit_id: SHA,
          },
        ],
        threads: [{ ...connectorThread, isResolved: false }],
      }),
    ).reason,
    /unresolved connector thread/i,
  );
  assert.match(
    evaluateConnectorEvidence(
      connectorEvidence({
        issueComments: [],
        reviews: [
          {
            id: 444,
            user: graphqlConnectorActor(),
            state: "COMMENTED",
            commit_id: SHA,
            body: "### 💡 Codex Review",
          },
        ],
        threads: [],
      }),
    ).reason,
    /finding without a resolvable thread/i,
  );
  assert.match(
    evaluateConnectorEvidence(
      connectorEvidence({
        issueComments: [],
        reviews: [
          {
            id: 444,
            user: graphqlConnectorActor(),
            state: "COMMENTED",
            commit_id: SHA,
            body: "### 💡 Codex Review",
          },
        ],
        threads: [
          {
            ...connectorThread,
            comments: [
              {
                ...connectorThread.comments[0],
                reviewId: 999,
              },
            ],
          },
        ],
      }),
    ).reason,
    /finding without a resolvable thread/i,
  );
  assert.match(
    evaluateConnectorEvidence(
      connectorEvidence({
        issueComments: [],
        reviews: [
          {
            id: 444,
            user: graphqlConnectorActor(),
            state: "COMMENTED",
            commit_id: SHA,
            body: "unknown connector review body",
          },
        ],
        threads: [{ ...connectorThread, isResolved: false }],
      }),
    ).reason,
    /unresolved connector thread/i,
  );
});

test("Copilot evidence ignores lookalikes and does not require a review", () => {
  const checked = validatePolicy(policy());
  assert.deepEqual(
    evaluateCopilotEvidence({
      headSha: SHA,
      reviews: [copilotReview(SHA)],
      threads: [],
      policy: checked,
    }),
    { ok: true },
  );
  assert.deepEqual(
    evaluateCopilotEvidence({
      headSha: SHA,
      reviews: [
        copilotReview(SHA, {
          user: graphqlCopilotActor(),
        }),
      ],
      threads: [],
      policy: checked,
    }),
    { ok: true },
  );

  for (const reviews of [[], [copilotReview(OTHER_SHA)]]) {
    assert.deepEqual(
      evaluateCopilotEvidence({
        headSha: SHA,
        reviews,
        threads: [],
        policy: checked,
      }),
      { ok: true },
    );
  }
  for (const reviews of [
    [
      copilotReview(SHA, {
        user: restCopilotActor("copilot-pull-request-reviewer[bot]", 1),
      }),
    ],
    [
      copilotReview(SHA, {
        user: restCopilotActor(
          "copilot-pull-request-reviewer[bot]",
          COPILOT_REVIEWER_ID,
          "BOT_spoof",
        ),
      }),
    ],
    [
      copilotReview(SHA, {
        user: restCopilotActor("lookalike"),
      }),
    ],
    [
      copilotReview(SHA, {
        user: { ...restCopilotActor(), type: "User" },
      }),
    ],
  ]) {
    assert.deepEqual(
      evaluateCopilotEvidence({
        headSha: SHA,
        reviews,
        threads: [],
        policy: checked,
      }),
      { ok: true },
    );
  }
  assert.deepEqual(
    evaluateCopilotEvidence({
      headSha: SHA,
      reviews: [copilotReview(SHA, { state: "APPROVED" })],
      threads: [],
      policy: checked,
    }),
    { ok: true },
  );
  assert.deepEqual(
    evaluateCopilotEvidence({
      headSha: SHA,
      reviews: [copilotReview(SHA, { id: null })],
      threads: [],
      policy: checked,
    }),
    { ok: true },
  );
});

test("Copilot suppressed comments reject only the head on which they were emitted", () => {
  const checked = validatePolicy(policy());
  const cleanBody =
    "Copilot reviewed 1 out of 1 changed file in this pull request and generated no new comments.";
  const suppressedBody = `${cleanBody}\n\n<details>\n<summary>Suppressed comments (1)</summary>\n\nA hidden finding.\n</details>`;

  assert.match(
    evaluateCopilotEvidence({
      headSha: SHA,
      reviews: [
        copilotReview(SHA, { id: 122, body: suppressedBody }),
        copilotReview(SHA, { id: 123, body: cleanBody }),
      ],
      threads: [],
      policy: checked,
    }).reason,
    /suppressed Copilot finding.*current head/i,
  );
  assert.match(
    evaluateCopilotEvidence({
      headSha: SHA,
      reviews: [
        copilotReview(SHA, {
          body: `${cleanBody}\n  Comments suppressed due to low confidence ( 2 )  `,
        }),
      ],
      threads: [],
      policy: checked,
    }).reason,
    /suppressed Copilot finding.*current head/i,
  );
  assert.deepEqual(
    evaluateCopilotEvidence({
      headSha: SHA,
      reviews: [
        copilotReview(OTHER_SHA, { id: 122, body: suppressedBody }),
        copilotReview(SHA, { id: 123, body: cleanBody }),
      ],
      threads: [],
      policy: checked,
    }),
    { ok: true },
  );
  assert.deepEqual(
    evaluateCopilotEvidence({
      headSha: SHA,
      reviews: [
        copilotReview(SHA, {
          body: `${cleanBody}\n<summary>Suppressed comments (0)</summary>`,
        }),
      ],
      threads: [],
      policy: checked,
    }),
    { ok: true },
  );
  assert.deepEqual(
    evaluateCopilotEvidence({
      headSha: SHA,
      reviews: [
        copilotReview(SHA, {
          body: `${cleanBody}\n\nAdds suppressed comments detection.\nParses Comments suppressed due to low confidence metadata.`,
        }),
      ],
      threads: [],
      policy: checked,
    }),
    { ok: true },
  );

  for (const example of [
    "```html\n<summary>Suppressed comments (1)</summary>\n```",
    "````markdown\n```\nComments suppressed due to low confidence (2)\n```\n````",
    "    <summary>Suppressed comments (1)</summary>",
    "`Suppressed comments (1)`",
  ]) {
    assert.deepEqual(
      evaluateCopilotEvidence({
        headSha: SHA,
        reviews: [copilotReview(SHA, { body: `${cleanBody}\n${example}` })],
        threads: [],
        policy: checked,
      }),
      { ok: true },
      example,
    );
  }
  assert.deepEqual(
    evaluateCopilotEvidence({
      headSha: SHA,
      reviews: [
        copilotReview(SHA, {
          body: `${cleanBody}\n\`\`\`html\n<summary>Suppressed comments (1)</summary>`,
        }),
      ],
      threads: [],
      policy: checked,
    }),
    { ok: true },
  );

  for (const marker of [
    "<summary>Suppressed comments</summary>",
    "<summary>Suppressed comments (many)</summary>",
    "Suppressed comments",
    "Suppressed comments (many)",
    "Comments suppressed due to low confidence",
  ]) {
    assert.deepEqual(
      evaluateCopilotEvidence({
        headSha: SHA,
        reviews: [copilotReview(SHA, { body: `${cleanBody}\n${marker}` })],
        threads: [],
        policy: checked,
      }),
      { ok: true },
      marker,
    );
  }
});

test("Copilot explicit finding without a resolvable thread vetoes", () => {
  const checked = validatePolicy(policy());
  assert.match(
    evaluateCopilotEvidence({
      headSha: SHA,
      reviews: [
        copilotReview(SHA, {
          id: 122,
          body: "Copilot reviewed 1 out of 1 changed file in this pull request and generated 1 comment.",
        }),
        copilotReview(SHA, { id: 123 }),
      ],
      threads: [],
      policy: checked,
    }).reason,
    /finding without a resolvable thread/i,
  );
  for (const body of [
    "This change parses generated 1 comment summaries.",
    "```text\nCopilot reviewed 1 out of 1 changed file in this pull request and generated 1 comment.\n```",
    "> Copilot reviewed 1 out of 1 changed file in this pull request and generated 1 comment.",
  ]) {
    assert.deepEqual(
      evaluateCopilotEvidence({
        headSha: SHA,
        reviews: [copilotReview(SHA, { body })],
        threads: [],
        policy: checked,
      }),
      { ok: true },
      body,
    );
  }
});

test("Copilot service, quota, and unreviewable outcomes are neutral", () => {
  const checked = validatePolicy(policy());
  const errorBody =
    "Copilot encountered an error and was unable to review this pull request. You can try again by re-requesting a review.";
  assert.deepEqual(
    evaluateCopilotEvidence({
      headSha: SHA,
      reviews: [copilotReview(SHA, { body: errorBody })],
      threads: [],
      policy: checked,
    }),
    { ok: true },
  );
  assert.deepEqual(
    evaluateCopilotEvidence({
      headSha: SHA,
      reviews: [
        copilotReview(SHA, { id: 122, body: errorBody }),
        copilotReview(SHA, { id: 123 }),
      ],
      threads: [],
      policy: checked,
    }),
    { ok: true },
  );

  const quotaBody =
    "Copilot was unable to review this pull request because the user who requested the review has reached their quota limit.";
  assert.deepEqual(
    evaluateCopilotEvidence({
      headSha: SHA,
      reviews: [copilotReview(SHA, { body: quotaBody })],
      threads: [],
      policy: checked,
    }),
    { ok: true },
  );
});

test("Copilot evidence reads every thread using the immutable review commit", () => {
  const checked = validatePolicy(policy());
  const reviews = [
    copilotReview(OTHER_SHA, { id: 122 }),
    copilotReview(SHA, { id: 123 }),
  ];
  const staleUnresolved = {
    isResolved: false,
    comments: [
      {
        author: actor("someone-else", 99),
        reviewCommit: { oid: SHA },
      },
      {
        author: graphqlCopilotActor(),
        reviewId: 122,
        commit: { oid: SHA },
        originalCommit: { oid: OTHER_SHA },
        reviewCommit: { oid: OTHER_SHA },
      },
    ],
  };
  assert.match(
    evaluateCopilotEvidence({
      headSha: SHA,
      reviews,
      threads: [staleUnresolved],
      policy: checked,
    }).reason,
    /unresolved Copilot review thread/i,
  );

  const currentFinding = structuredClone(staleUnresolved);
  currentFinding.comments[1].reviewCommit.oid = SHA;
  currentFinding.comments[1].reviewId = 123;
  const currentReviews = [
    reviews[0],
    copilotReview(SHA, {
      id: 123,
      body: "Copilot reviewed 1 out of 1 changed file in this pull request and generated 1 comment.",
    }),
  ];
  currentFinding.isResolved = false;
  assert.match(
    evaluateCopilotEvidence({
      headSha: SHA,
      reviews: currentReviews,
      threads: [currentFinding],
      policy: checked,
    }).reason,
    /unresolved Copilot review thread/i,
  );
  currentFinding.isResolved = true;
  assert.deepEqual(
    evaluateCopilotEvidence({
      headSha: SHA,
      reviews: currentReviews,
      threads: [currentFinding],
      policy: checked,
    }),
    { ok: true },
  );

  assert.deepEqual(
    evaluateCopilotEvidence({
      headSha: SHA,
      reviews,
      threads: [
        { ...staleUnresolved, isResolved: true },
        {
          isResolved: true,
          comments: [
            {
              author: restCopilotActor("Copilot"),
              reviewId: 122,
              reviewCommit: { oid: OTHER_SHA },
            },
          ],
        },
      ],
      policy: checked,
    }),
    { ok: true },
  );

  const missingImmutableReview = structuredClone(staleUnresolved);
  missingImmutableReview.isResolved = true;
  delete missingImmutableReview.comments[1].reviewCommit;
  assert.deepEqual(
    evaluateCopilotEvidence({
      headSha: SHA,
      reviews,
      threads: [missingImmutableReview],
      policy: checked,
    }),
    { ok: true },
  );

  const mismatchedReview = structuredClone(staleUnresolved);
  mismatchedReview.isResolved = true;
  mismatchedReview.comments[1].reviewId = 999;
  assert.deepEqual(
    evaluateCopilotEvidence({
      headSha: SHA,
      reviews,
      threads: [mismatchedReview],
      policy: checked,
    }),
    { ok: true },
  );

  assert.match(
    evaluateCopilotEvidence({
      headSha: SHA,
      reviews: currentReviews,
      threads: [
        {
          ...mismatchedReview,
          comments: [
            {
              ...mismatchedReview.comments[1],
              reviewCommit: { oid: SHA },
            },
          ],
        },
      ],
      policy: checked,
    }).reason,
    /finding without a resolvable thread/i,
  );
});

test("bot reviews and threads come from one fail-closed GraphQL snapshot", async () => {
  const calls = [];
  const review = {
    databaseId: 123,
    author: graphqlCopilotActor(),
    state: "COMMENTED",
    commit: { oid: SHA },
    body: copilotReview().body,
    submittedAt: "2026-08-08T12:00:00Z",
  };
  const thread = {
    isResolved: true,
    comments: {
      nodes: [
        {
          author: graphqlCopilotActor(),
          body: "handled",
          pullRequestReview: { databaseId: 123, commit: { oid: SHA } },
        },
      ],
      pageInfo: { hasNextPage: false },
    },
  };
  const payload = (overrides = {}) => ({
    repository: {
      pullRequest: {
        number: 7,
        state: "OPEN",
        isDraft: false,
        headRefOid: SHA,
        baseRefOid: BASE_SHA,
        baseRefName: "main",
        comments: {
          nodes: [
            {
              databaseId: 99,
              author: graphqlConnectorActor(),
              body: cleanComment().body,
              createdAt: "2026-08-08T12:00:00Z",
              updatedAt: "2026-08-08T12:00:00Z",
            },
          ],
          pageInfo: { hasNextPage: false },
          ...overrides.comments,
        },
        reviews: {
          nodes: [review],
          pageInfo: { hasNextPage: false },
          ...overrides.reviews,
        },
        reviewThreads: {
          nodes: [thread],
          pageInfo: { hasNextPage: false },
          ...overrides.reviewThreads,
        },
      },
    },
  });
  const evidence = await readBotReviewEvidence(
    {
      graphql: async (query, variables) => {
        calls.push([query, variables]);
        return payload();
      },
    },
    "LCV-Ideas-Software",
    "example",
    7,
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /comments\(first: 100\)/);
  assert.match(calls[0][0], /reviews\(first: 100\)/);
  assert.match(calls[0][0], /reviewThreads\(first: 100\)/);
  assert.equal(evidence.reviews[0].id, 123);
  assert.equal(evidence.reviews[0].commit_id, SHA);
  assert.equal(evidence.threads[0].comments[0].reviewId, 123);
  assert.equal(evidence.threads[0].comments[0].reviewCommit.oid, SHA);
  assert.equal(evidence.issueComments[0].user.id, CONNECTOR_NODE_ID);
  assert.equal(evidence.pullRequest.headRefOid, SHA);

  for (const truncated of [
    { comments: { pageInfo: { hasNextPage: true } } },
    { reviews: { pageInfo: { hasNextPage: true } } },
    { reviewThreads: { pageInfo: { hasNextPage: true } } },
    {
      reviewThreads: {
        nodes: [
          {
            ...thread,
            comments: {
              ...thread.comments,
              pageInfo: { hasNextPage: true },
            },
          },
        ],
      },
    },
  ]) {
    await assert.rejects(
      readBotReviewEvidence(
        { graphql: async () => payload(truncated) },
        "LCV-Ideas-Software",
        "example",
        7,
      ),
      /BOT_EVIDENCE_TRUNCATED/,
    );
  }

  for (const invalid of [
    { comments: { nodes: undefined } },
    { reviews: { pageInfo: {} } },
    { reviewThreads: { nodes: null } },
    {
      reviewThreads: {
        nodes: [{ ...thread, comments: { ...thread.comments, pageInfo: {} } }],
      },
    },
  ]) {
    await assert.rejects(
      readBotReviewEvidence(
        { graphql: async () => payload(invalid) },
        "LCV-Ideas-Software",
        "example",
        7,
      ),
      /BOT_EVIDENCE_INVALID/,
    );
  }
});

test("bot change requests are typed end to end and human veto precedence is deterministic", async () => {
  const copilotChanges = {
    databaseId: 501,
    author: graphqlCopilotActor(),
    state: "CHANGES_REQUESTED",
    commit: { oid: SHA },
    body: "change this",
    submittedAt: "2026-08-08T12:00:00Z",
  };
  const graphqlPayload = (reviews, snapshotHead = SHA) => ({
    repository: {
      pullRequest: {
        number: 7,
        state: "OPEN",
        isDraft: false,
        headRefOid: snapshotHead,
        baseRefOid: BASE_SHA,
        baseRefName: "main",
        comments: { nodes: [], pageInfo: { hasNextPage: false } },
        reviews: { nodes: reviews, pageInfo: { hasNextPage: false } },
        reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
      },
    },
  });
  const apiFor = (reviews, snapshotHead = SHA) => ({
    graphql: async () => graphqlPayload(reviews, snapshotHead),
    pages: async (path) => {
      if (path.endsWith("/commits")) {
        return [{ sha: SHA, commit: { verification: { verified: true } } }];
      }
      assert.fail(`unexpected paginated request ${path}`);
    },
    request: async (path) => {
      if (path.endsWith("/pulls/7")) return pull();
      if (path.endsWith("/branches/main")) {
        return { commit: { sha: BASE_SHA } };
      }
      assert.fail(`unexpected request ${path}`);
    },
  });
  let veto;
  try {
    await assessPullCore({
      api: apiFor([copilotChanges]),
      owner: "LCV-Ideas-Software",
      repo: "example",
      number: 7,
      policy: validatePolicy(policy()),
    });
    assert.fail("Copilot change request must veto");
  } catch (error) {
    veto = error;
  }
  assert.ok(veto instanceof BotReviewVetoError);
  assert.equal(veto.recoveryCode, "COPILOT_CHANGES_REQUESTED");
  assert.match(
    botReviewVetoWorkflowCommand(veto),
    /BOT_REVIEW_VETO COPILOT_CHANGES_REQUESTED example#7@/,
  );

  const approved = {
    ...copilotChanges,
    databaseId: 502,
    state: "APPROVED",
    submittedAt: "2026-08-08T12:01:00Z",
  };
  assert.equal(
    (
      await assessPullCore({
        api: apiFor([copilotChanges, approved]),
        owner: "LCV-Ideas-Software",
        repo: "example",
        number: 7,
        policy: validatePolicy(policy()),
      })
    ).pullRequest.head.sha,
    SHA,
  );

  const humanChanges = {
    id: 601,
    user: actor(),
    state: "CHANGES_REQUESTED",
    commit_id: SHA,
  };
  const botChanges = {
    id: 602,
    user: graphqlConnectorActor(),
    state: "CHANGES_REQUESTED",
    commit_id: SHA,
  };
  for (const reviews of [
    [humanChanges, botChanges],
    [botChanges, humanChanges],
  ]) {
    const result = evaluateConnectorEvidence(
      connectorEvidence({ issueComments: [], reviews }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.botVeto, false);
    assert.equal(result.recoveryCode, undefined);
  }

  await assert.rejects(
    assessPullCore({
      api: apiFor([], OTHER_SHA),
      owner: "LCV-Ideas-Software",
      repo: "example",
      number: 7,
      policy: validatePolicy(policy()),
    }),
    /BOT_EVIDENCE_SNAPSHOT_MISMATCH/,
  );
});

test("Dependabot rebase mutation revalidates exact head, base, identity, conflict, and idempotency", async () => {
  const checked = validatePolicy(policy());
  function rebaseApi({
    currentPull = {},
    comments = [],
    mainSha = BASE_SHA,
  } = {}) {
    const calls = [];
    const api = {
      calls,
      pages: async (path) => {
        calls.push([path]);
        return comments;
      },
      request: async (path, options) => {
        calls.push([path, options]);
        if (path.endsWith("/pulls/7")) {
          return {
            ...pull({
              user: actor("dependabot[bot]", 49699333),
              mergeable: false,
              mergeable_state: "dirty",
            }),
            ...currentPull,
          };
        }
        if (path.endsWith("/branches/main")) {
          return { commit: { sha: mainSha } };
        }
        if (path.endsWith("/issues/7/comments") && options?.method === "POST") {
          return {};
        }
        throw new Error(`unexpected API request ${path}`);
      },
    };
    return api;
  }

  const api = rebaseApi();
  assert.equal(
    await ensureDependabotRebaseRequest({
      api,
      owner: "LCV-Ideas-Software",
      repo: "example",
      number: 7,
      headSha: SHA,
      expectedBase: BASE_SHA,
      policy: checked,
    }),
    "dependabot-rebase-requested",
  );
  assert.deepEqual(api.calls.at(-1)[1], {
    method: "POST",
    body: { body: dependabotRebaseBody(SHA) },
  });
  assert.match(api.calls.at(-2)[0], /\/pulls\/7$/);

  for (const [currentPull, expected] of [
    [{ head: { ...pull().head, sha: OTHER_SHA } }, "dependabot-rebase-stale"],
    [
      { mergeable: null, mergeable_state: "unknown" },
      "dependabot-rebase-mergeability-pending",
    ],
    [
      { mergeable: true, mergeable_state: "clean" },
      "dependabot-rebase-no-conflict",
    ],
    [{ user: actor() }, "dependabot-rebase-stale"],
    [{ draft: null }, "dependabot-rebase-stale"],
    [{ base: { ...pull().base, sha: OTHER_SHA } }, "dependabot-rebase-stale"],
  ]) {
    const candidate = rebaseApi({ currentPull });
    assert.equal(
      await ensureDependabotRebaseRequest({
        api: candidate,
        owner: "LCV-Ideas-Software",
        repo: "example",
        number: 7,
        headSha: SHA,
        expectedBase: BASE_SHA,
        policy: checked,
      }),
      expected,
    );
    assert.equal(
      candidate.calls.some(
        ([path, options]) =>
          path.endsWith("/issues/7/comments") && options?.method === "POST",
      ),
      false,
      expected,
    );
  }

  const changedMain = rebaseApi({ mainSha: OTHER_SHA });
  assert.equal(
    await ensureDependabotRebaseRequest({
      api: changedMain,
      owner: "LCV-Ideas-Software",
      repo: "example",
      number: 7,
      headSha: SHA,
      expectedBase: BASE_SHA,
      policy: checked,
    }),
    "dependabot-rebase-stale",
  );
  assert.equal(
    changedMain.calls.some(
      ([path, options]) =>
        path.endsWith("/issues/7/comments") && options?.method === "POST",
    ),
    false,
  );

  const idempotent = rebaseApi({
    comments: [{ id: 1, user: actor(), body: dependabotRebaseBody(SHA) }],
  });
  assert.equal(
    await ensureDependabotRebaseRequest({
      api: idempotent,
      owner: "LCV-Ideas-Software",
      repo: "example",
      number: 7,
      headSha: SHA,
      expectedBase: BASE_SHA,
      policy: checked,
    }),
    "dependabot-rebase-pending",
  );
  assert.equal(
    idempotent.calls.some(
      ([path, options]) =>
        path.endsWith("/issues/7/comments") && options?.method === "POST",
    ),
    false,
  );
});

test("connector evidence allows resolved stale threads but blocks current change requests", () => {
  const changesRequested = evaluateConnectorEvidence(
    connectorEvidence({
      reviews: [
        {
          user: actor("lcv-leo", 268063598),
          state: "CHANGES_REQUESTED",
          commit_id: SHA,
          body: "fix it",
          submitted_at: "2026-08-08T12:01:00Z",
        },
      ],
    }),
  );
  assert.match(changesRequested.reason, /changes requested/i);

  const changes = {
    id: 1,
    user: actor(),
    state: "CHANGES_REQUESTED",
    commit_id: SHA,
    submitted_at: "2026-08-08T12:01:00Z",
  };
  assert.match(
    evaluateConnectorEvidence(
      connectorEvidence({
        reviews: [
          changes,
          {
            ...changes,
            id: 2,
            state: "COMMENTED",
            submitted_at: "2026-08-08T12:02:00Z",
          },
        ],
      }),
    ).reason,
    /changes requested/i,
  );
  for (const clearingState of ["APPROVED", "DISMISSED"]) {
    assert.equal(
      evaluateConnectorEvidence(
        connectorEvidence({
          reviews: [
            changes,
            {
              ...changes,
              id: 2,
              state: clearingState,
              submitted_at: "2026-08-08T12:02:00Z",
            },
          ],
        }),
      ).ok,
      true,
      clearingState,
    );
  }
  assert.match(
    evaluateConnectorEvidence(
      connectorEvidence({
        reviews: [
          changes,
          {
            ...changes,
            id: 2,
            user: actor("other-reviewer", 99),
            state: "APPROVED",
            submitted_at: "2026-08-08T12:02:00Z",
          },
        ],
      }),
    ).reason,
    /changes requested/i,
  );
  assert.match(
    evaluateConnectorEvidence(
      connectorEvidence({
        reviews: [
          { ...changes, state: "APPROVED" },
          { ...changes, id: 2, submitted_at: "2026-08-08T12:02:00Z" },
        ],
      }),
    ).reason,
    /changes requested/i,
  );
});

test("the gate reads optional bot evidence once and still enforces exact head", async () => {
  const options = {
    repo: "example",
    number: 7,
    expectedHead: SHA,
  };
  let calls = 0;
  const settled = await readExactPullCore(options, async () => {
    calls += 1;
    return {
      pullRequest: { head: { sha: SHA } },
      connectorPending: "informational legacy field",
      copilotPending: "informational legacy field",
    };
  });
  assert.equal(calls, 1);
  assert.equal(settled.pullRequest.head.sha, SHA);

  calls = 0;
  await assert.rejects(
    readExactPullCore(options, async () => {
      calls += 1;
      throw new Error("connector thread has no immutable review commit");
    }),
    /no immutable review commit/i,
  );
  assert.equal(calls, 1);

  calls = 0;
  await assert.rejects(
    readExactPullCore(options, async () => {
      calls += 1;
      return {
        pullRequest: { head: { sha: OTHER_SHA } },
      };
    }),
    /head changed at exact-head evidence read/i,
  );
  assert.equal(calls, 1);
});

test("classifyChecks requires exact executor and GHAS identities and all observed checks green", () => {
  const required = policy().repositories.example.required_checks;
  const runs = required.map((entry, index) =>
    check(entry.name, entry.app_id, "completed", "success", index + 1),
  );
  runs.push(
    check(TRUSTED_GATE_CHECK_NAME, ACTIONS_APP_ID, "in_progress", null, 50),
  );
  assert.deepEqual(
    classifyChecks({ checkRuns: runs, statuses: [], requiredChecks: required }),
    {
      state: "success",
      reasons: [],
    },
  );

  assert.equal(
    classifyChecks({
      checkRuns: runs.slice(1),
      statuses: [],
      requiredChecks: required,
    }).state,
    "pending",
  );
  assert.equal(
    classifyChecks({
      checkRuns: [
        ...runs,
        check("Unexpected audit", ACTIONS_APP_ID, "completed", "failure", 99),
      ],
      statuses: [],
      requiredChecks: required,
    }).state,
    "failure",
  );
  const withoutAnalyzeActions = runs.filter(
    (run) => run.name !== "Analyze actions",
  );
  for (const genuine of [
    check("Analyze actions", ACTIONS_APP_ID, "in_progress", null, 200),
    check("Analyze actions", ACTIONS_APP_ID, "completed", "failure", 200),
  ]) {
    assert.notEqual(
      classifyChecks({
        checkRuns: [
          ...withoutAnalyzeActions,
          genuine,
          check("Analyze actions", ACTIONS_APP_ID, "completed", "success", 201),
        ],
        statuses: [],
        requiredChecks: required,
      }).state,
      "success",
    );
  }
  assert.equal(
    classifyChecks({
      checkRuns: [
        ...withoutAnalyzeActions,
        check(
          "Analyze actions",
          ACTIONS_APP_ID,
          "completed",
          "failure",
          200,
          777,
        ),
        check(
          "Analyze actions",
          ACTIONS_APP_ID,
          "completed",
          "success",
          201,
          777,
        ),
      ],
      statuses: [],
      requiredChecks: required,
    }).state,
    "success",
  );
  const invalidSuite = check(
    "Analyze actions",
    ACTIONS_APP_ID,
    "completed",
    "success",
    202,
  );
  invalidSuite.check_suite = null;
  assert.equal(
    classifyChecks({
      checkRuns: [...withoutAnalyzeActions, invalidSuite],
      statuses: [],
      requiredChecks: required,
    }).state,
    "failure",
  );
  assert.deepEqual(
    inspectRequiredCheckProducerProvenance({
      checkRuns: runs,
      requiredChecks: required,
    }),
    {
      outcome: "required-check-producer-provenance-unverified",
      producerProvenanceVerified: false,
    },
  );
  assert.equal(
    classifyChecks({
      checkRuns: [
        ...runs,
        check("Optional deploy", ACTIONS_APP_ID, "completed", "skipped", 101),
        check("Optional advisory", ACTIONS_APP_ID, "completed", "neutral", 102),
      ],
      statuses: [],
      requiredChecks: required,
    }).state,
    "success",
  );
  assert.equal(
    classifyChecks({
      checkRuns: runs.map((run) =>
        run.name === "Analyze actions"
          ? { ...run, conclusion: "skipped" }
          : run,
      ),
      statuses: [],
      requiredChecks: required,
    }).state,
    "pending",
  );
  assert.equal(
    classifyChecks({
      checkRuns: runs.map((run) =>
        run.name === "CodeQL" ? { ...run, conclusion: "neutral" } : run,
      ),
      statuses: [],
      requiredChecks: required,
    }).state,
    "pending",
  );
  assert.equal(
    classifyChecks({
      checkRuns: runs.map((run) => {
        if (run.name === "CodeQL") return { ...run, conclusion: "neutral" };
        if (run.name === "Analyze javascript-typescript") {
          return { ...run, status: "in_progress", conclusion: null };
        }
        return run;
      }),
      statuses: [],
      requiredChecks: required,
    }).state,
    "pending",
  );
  assert.equal(
    classifyChecks({
      checkRuns: runs.map((run) => {
        if (run.name === "CodeQL") return { ...run, conclusion: "failure" };
        if (run.name === "Analyze javascript-typescript") {
          return { ...run, status: "in_progress", conclusion: null };
        }
        return run;
      }),
      statuses: [],
      requiredChecks: required,
    }).state,
    "failure",
  );
  assert.equal(
    classifyChecks({
      checkRuns: runs,
      statuses: [],
      requiredChecks: required,
    }).state,
    "success",
  );
  assert.equal(
    classifyChecks({
      checkRuns: [
        ...withoutAnalyzeActions,
        check("Analyze actions", ACTIONS_APP_ID, "completed", "success", 100),
        check("Analyze actions", ACTIONS_APP_ID, "in_progress", null, 101),
      ],
      statuses: [],
      requiredChecks: required,
    }).state,
    "pending",
  );
  assert.equal(
    classifyChecks({
      checkRuns: [
        ...withoutAnalyzeActions,
        check("Analyze actions", ACTIONS_APP_ID, "completed", "success", 100),
        check("Analyze actions", ACTIONS_APP_ID, "completed", "failure", 101),
      ],
      statuses: [],
      requiredChecks: required,
    }).state,
    "failure",
  );
  assert.equal(
    classifyChecks({
      checkRuns: runs.map((run) =>
        run.name === "Analyze actions"
          ? { ...run, conclusion: "failure" }
          : run,
      ),
      statuses: [],
      requiredChecks: required,
    }).state,
    "failure",
  );
  assert.equal(
    classifyChecks({
      checkRuns: runs,
      statuses: [{ context: "legacy-ci", state: "failure", id: 1 }],
      requiredChecks: required,
    }).state,
    "failure",
  );
});

test("canary Actions producers bind every check to an approved workflow blob", async () => {
  const repositoryPolicy = canaryRepositoryPolicy();
  const fixtures = canaryProducerFixtures();
  assert.deepEqual(
    await inspectRequiredCheckProducerProvenance({
      api: canaryProducerApi(fixtures),
      owner: "LCV-Ideas-Software",
      repo: ".github-private",
      headSha: SHA,
      expectedEvent: "pull_request",
      checkRuns: fixtures.map(({ checkRun }) => checkRun),
      requiredChecks: repositoryPolicy.required_checks,
      repositoryPolicy,
    }),
    {
      outcome: "required-check-producer-provenance-verified",
      producerProvenanceVerified: true,
    },
  );
});

test("canary producer provenance rejects spoofed, duplicate, truncated, and changed sources", async () => {
  const repositoryPolicy = canaryRepositoryPolicy();
  const base = canaryProducerFixtures();
  const run = (fixtures, api = canaryProducerApi(fixtures)) =>
    inspectRequiredCheckProducerProvenance({
      api,
      owner: "LCV-Ideas-Software",
      repo: ".github-private",
      headSha: SHA,
      expectedEvent: "pull_request",
      checkRuns: fixtures.map(({ checkRun }) => checkRun),
      requiredChecks: repositoryPolicy.required_checks,
      repositoryPolicy,
    });

  const graphMismatch = structuredClone(base);
  graphMismatch[0].graphRun.file.repositoryFileUrl =
    "https://github.com/LCV-Ideas-Software/.github-private/blob/spoof/.github/workflows/enterprise-governance-validation.yml";
  await assert.rejects(run(graphMismatch), /GraphQL identity is inconsistent/i);

  const blobMismatch = structuredClone(base);
  blobMismatch[1].sourceFile.sha = OTHER_SHA;
  await assert.rejects(run(blobMismatch), /blob is inconsistent/i);

  const referenceMismatch = structuredClone(base);
  referenceMismatch[2].run.referenced_workflows[0].sha = OTHER_SHA;
  await assert.rejects(run(referenceMismatch), /run is inconsistent/i);

  const lookalike = structuredClone(base);
  const spoof = structuredClone(lookalike[0]);
  spoof.checkRun.id += 1000;
  lookalike.push(spoof);
  await assert.rejects(run(lookalike), /suite does not map to one run/i);

  const duplicateRunApi = canaryProducerApi(base);
  const originalPages = duplicateRunApi.pages;
  duplicateRunApi.pages = async (path, options) => {
    const values = await originalPages(path, options);
    return path.includes(`check_suite_id=${base[0].run.check_suite_id}`)
      ? [...values, ...values]
      : values;
  };
  await assert.rejects(run(base, duplicateRunApi), /does not map to one run/i);

  const truncatedApi = canaryProducerApi(base);
  truncatedApi.pages = async () => {
    throw new Error("paginated endpoint exceeded 1000 records");
  };
  await assert.rejects(run(base, truncatedApi), /exceeded 1000 records/i);
});

test("required neutral checks poll until success or timeout", async () => {
  const requiredChecks = [{ name: "CodeQL", app_id: 57789 }];
  const api = {
    pages: async (path) =>
      path.includes("/check-runs")
        ? [check("CodeQL", 57789, "completed", "neutral", 99)]
        : [],
  };
  await assert.rejects(
    waitForGateEvidence({
      api,
      owner: "LCV-Ideas-Software",
      repo: "example",
      sha: SHA,
      requiredChecks,
      timing: { deadline: Date.now() - 1, pollSeconds: 0.001 },
    }),
    /did not become green before timeout.*neutral/i,
  );
});

test("phase-specific checks are optional on PRs and fail closed on merge groups", () => {
  const checked = validatePolicy(policy());
  const repository = checked.repositories.example;
  const pullChecks = requiredChecksForPhase(repository, "pull_request");
  const mergeChecks = requiredChecksForPhase(repository, "merge_group");
  const commonRuns = pullChecks.map((entry, index) =>
    check(entry.name, entry.app_id, "completed", "success", index + 1),
  );

  assert.equal(
    classifyChecks({
      checkRuns: commonRuns,
      statuses: [],
      requiredChecks: pullChecks,
    }).state,
    "success",
  );
  assert.equal(
    classifyChecks({
      checkRuns: commonRuns,
      statuses: [],
      requiredChecks: mergeChecks,
    }).state,
    "pending",
  );
  assert.equal(
    classifyChecks({
      checkRuns: [
        ...commonRuns,
        check(
          "Synthetic integration",
          ACTIONS_APP_ID,
          "completed",
          "failure",
          99,
        ),
      ],
      statuses: [],
      requiredChecks: pullChecks,
    }).state,
    "failure",
  );
  assert.equal(
    classifyChecks({
      checkRuns: [
        ...commonRuns,
        check(
          "Synthetic integration",
          ACTIONS_APP_ID,
          "completed",
          "success",
          99,
        ),
      ],
      statuses: [],
      requiredChecks: mergeChecks,
    }).state,
    "success",
  );
  assert.throws(
    () => requiredChecksForPhase(repository, "push"),
    /unsupported check phase/i,
  );
});

test("controller treats normal pending checks as observation and terminal failures as errors", () => {
  assert.equal(
    controllerCheckOutcome({
      state: "pending",
      reasons: ["missing required check"],
    }),
    "checks-pending",
  );
  assert.equal(
    controllerCheckOutcome({ state: "success", reasons: [] }),
    "checks-success",
  );
  assert.throws(
    () =>
      controllerCheckOutcome({ state: "failure", reasons: ["CodeQL failed"] }),
    /CodeQL failed/,
  );
});

test("code-scanning alerts are refreshed only after exact-head checks are green", async () => {
  let calls = 0;
  const pendingApi = {
    pages: async () => {
      calls += 1;
      return [{ number: 1 }];
    },
  };
  assert.equal(
    await verifyCodeScanningAfterChecks({
      api: pendingApi,
      owner: "LCV-Ideas-Software",
      repo: "example",
      number: 7,
      checkState: "pending",
    }),
    "checks-pending",
  );
  assert.equal(calls, 0);

  assert.equal(
    await verifyCodeScanningAfterChecks({
      api: { pages: async () => [] },
      owner: "LCV-Ideas-Software",
      repo: "example",
      number: 7,
      checkState: "success",
    }),
    "code-scanning-success",
  );
  await assert.rejects(
    verifyCodeScanningAfterChecks({
      api: { pages: async () => [{ number: 1 }] },
      owner: "LCV-Ideas-Software",
      repo: "example",
      number: 7,
      checkState: "success",
    }),
    /1 open code-scanning alert/i,
  );
});

test("final trust boundary rereads evidence around code scanning", async () => {
  const trace = [];
  const trusted = {
    pullRequest: { head: { sha: SHA } },
    mainSha: BASE_SHA,
  };
  const result = await finalizePullTrustBoundary({
    expectedHead: SHA,
    expectedBase: BASE_SHA,
    label: "example#7",
    reassess: async () => {
      trace.push("reassess");
      return trusted;
    },
    scanCode: async () => trace.push("scan"),
    recheckChecks: async () => {
      trace.push("recheck");
      return "stable-inventory";
    },
  });
  assert.equal(result, trusted);
  assert.deepEqual(trace, [
    "reassess",
    "recheck",
    "scan",
    "reassess",
    "recheck",
  ]);

  let scanCalled = false;
  await assert.rejects(
    finalizePullTrustBoundary({
      expectedHead: SHA,
      label: "example#7",
      reassess: async () => ({ pullRequest: { head: { sha: OTHER_SHA } } }),
      scanCode: async () => {
        scanCalled = true;
      },
      recheckChecks: async () => "stable-inventory",
    }),
    /head changed at final trust boundary/i,
  );
  assert.equal(scanCalled, false);

  let assessment = 0;
  await assert.rejects(
    finalizePullTrustBoundary({
      expectedHead: SHA,
      label: "example#7",
      reassess: async () => {
        assessment += 1;
        if (assessment === 2) throw new Error("late connector finding");
        return trusted;
      },
      scanCode: async () => undefined,
      recheckChecks: async () => "stable-inventory",
    }),
    /late connector finding/i,
  );

  assessment = 0;
  await assert.rejects(
    finalizePullTrustBoundary({
      expectedHead: SHA,
      label: "example#7",
      reassess: async () => {
        assessment += 1;
        return {
          pullRequest: {
            head: { sha: assessment === 1 ? SHA : OTHER_SHA },
          },
        };
      },
      scanCode: async () => undefined,
      recheckChecks: async () => "stable-inventory",
    }),
    /head changed at final trust boundary/i,
  );

  await assert.rejects(
    finalizePullTrustBoundary({
      expectedHead: SHA,
      label: "example#7",
      reassess: async () => trusted,
      scanCode: async () => undefined,
      recheckChecks: async () => {
        throw new Error("final exact-SHA check inventory is pending");
      },
    }),
    /check inventory is pending/i,
  );

  let fingerprintRead = 0;
  await assert.rejects(
    finalizePullTrustBoundary({
      expectedHead: SHA,
      label: "example#7",
      reassess: async () => trusted,
      scanCode: async () => undefined,
      recheckChecks: async () => {
        fingerprintRead += 1;
        return fingerprintRead === 1 ? "inventory-a" : "inventory-b";
      },
    }),
    /check inventory changed while code scanning/i,
  );
});

test("check evidence fingerprint is order-independent and detects superseding evidence", () => {
  const first = {
    checkRuns: [
      check("Analyze actions", ACTIONS_APP_ID, "completed", "success", 1),
      check("CodeQL", 57789, "completed", "success", 2),
    ],
    statuses: [
      {
        id: 3,
        context: "legacy-ci",
        creator: { id: 4 },
        state: "success",
        target_url: "https://example.test/3",
      },
    ],
  };
  const reordered = {
    checkRuns: [...first.checkRuns].reverse(),
    statuses: [...first.statuses],
  };
  assert.equal(
    checkEvidenceFingerprint(first),
    checkEvidenceFingerprint(reordered),
  );
  assert.notEqual(
    checkEvidenceFingerprint(first),
    checkEvidenceFingerprint({
      ...first,
      checkRuns: [
        ...first.checkRuns,
        check("Analyze actions", ACTIONS_APP_ID, "in_progress", null, 4),
      ],
    }),
  );
  assert.notEqual(
    checkEvidenceFingerprint(first),
    checkEvidenceFingerprint({
      ...first,
      statuses: [{ ...first.statuses[0], id: 5, state: "pending" }],
    }),
  );
});

test("active canary ruleset binds the synthetic required workflow to the pinned source", async () => {
  const fixture = canaryTrustedGateFixture();
  assert.deepEqual(
    await inspectTrustedGate({
      api: canaryTrustedGateApi(fixture),
      owner: "LCV-Ideas-Software",
      repo: ".github-private",
      headSha: SHA,
      checkRuns: [fixture.checkRun],
      repositoryPolicy: canaryRepositoryPolicy(),
    }),
    { outcome: "trusted-gate-success" },
  );
});

test("canary source provenance is observational in evaluate and fails closed on every pin", async () => {
  const evaluated = canaryTrustedGateFixture({ enforcement: "evaluate" });
  assert.deepEqual(
    await inspectTrustedGate({
      api: canaryTrustedGateApi(evaluated),
      owner: "LCV-Ideas-Software",
      repo: ".github-private",
      headSha: SHA,
      checkRuns: [evaluated.checkRun],
      repositoryPolicy: canaryRepositoryPolicy(),
    }),
    { outcome: "trusted-gate-provenance-unverified" },
  );

  for (const [label, fixture, expected] of [
    [
      "GraphQL source SHA",
      canaryTrustedGateFixture({ graphSourceSha: OTHER_SHA }),
      /GraphQL source identity is inconsistent/i,
    ],
    [
      "ruleset source SHA",
      canaryTrustedGateFixture({ rulesetSourceSha: OTHER_SHA }),
      /ruleset identity is inconsistent/i,
    ],
    [
      "source blob",
      canaryTrustedGateFixture({ sourceBlobSha: OTHER_SHA }),
      /source blob identity is inconsistent/i,
    ],
  ]) {
    await assert.rejects(
      inspectTrustedGate({
        api: canaryTrustedGateApi(fixture),
        owner: "LCV-Ideas-Software",
        repo: ".github-private",
        headSha: SHA,
        checkRuns: [fixture.checkRun],
        repositoryPolicy: canaryRepositoryPolicy(),
      }),
      expected,
      label,
    );
  }
});

test("central workflow identity remains blocked without observable source revision provenance", async () => {
  const valid = trustedGateFixture();
  assert.deepEqual(
    await inspectTrustedGate({
      api: trustedGateApi(valid),
      owner: "LCV-Ideas-Software",
      repo: "example",
      headSha: SHA,
      checkRuns: [valid.checkRun],
    }),
    { outcome: "trusted-gate-provenance-unverified" },
  );
  const equalIdentifiers = trustedGateFixture({
    checkId: 93120160052,
    jobId: 93120160052,
  });
  assert.deepEqual(
    await inspectTrustedGate({
      api: trustedGateApi(equalIdentifiers),
      owner: "LCV-Ideas-Software",
      repo: "example",
      headSha: SHA,
      checkRuns: [equalIdentifiers.checkRun],
    }),
    { outcome: "trusted-gate-provenance-unverified" },
  );

  const inventedSuffix = trustedGateFixture({
    runOverrides: {
      path: `${TRUSTED_GATE_SOURCE_WORKFLOW_PATH}@${SHA}`,
    },
  });
  await assert.rejects(
    inspectTrustedGate({
      api: trustedGateApi(inventedSuffix),
      owner: "LCV-Ideas-Software",
      repo: "example",
      headSha: SHA,
      checkRuns: [inventedSuffix.checkRun],
    }),
    /workflow-run identity is inconsistent/i,
  );

  const inventedReference = trustedGateFixture({
    runOverrides: {
      referenced_workflows: [
        {
          path: TRUSTED_GATE_SOURCE_WORKFLOW_PATH,
          sha: SHA,
          ref: "refs/heads/main",
        },
      ],
    },
  });
  assert.deepEqual(
    await inspectTrustedGate({
      api: trustedGateApi(inventedReference),
      owner: "LCV-Ideas-Software",
      repo: "example",
      headSha: SHA,
      checkRuns: [inventedReference.checkRun],
    }),
    { outcome: "trusted-gate-provenance-unverified" },
  );
  assert.deepEqual(
    await inspectTrustedGate({
      api: { request: async () => assert.fail("no gate API request") },
      owner: "LCV-Ideas-Software",
      repo: "example",
      headSha: SHA,
      checkRuns: [],
    }),
    { outcome: "trusted-gate-pending" },
  );

  const pending = trustedGateFixture({
    status: "in_progress",
    conclusion: null,
  });
  assert.deepEqual(
    await inspectTrustedGate({
      api: trustedGateApi(pending),
      owner: "LCV-Ideas-Software",
      repo: "example",
      headSha: SHA,
      checkRuns: [pending.checkRun],
    }),
    { outcome: "trusted-gate-provenance-unverified" },
  );
});

test("a higher-id same-name Actions check cannot spoof the central gate", async () => {
  const centralPending = trustedGateFixture({
    status: "in_progress",
    conclusion: null,
  });
  const spoof = trustedGateFixture({
    checkId: 93120169999,
    checkSuiteId: 84829909999,
    runId: 31264429999,
    runOverrides: {
      workflow_id: 1,
      workflow_url:
        "https://api.github.com/repos/LCV-Ideas-Software/example/actions/workflows/1",
    },
  });
  await assert.rejects(
    inspectTrustedGate({
      api: trustedGateApi([centralPending, spoof]),
      owner: "LCV-Ideas-Software",
      repo: "example",
      headSha: SHA,
      checkRuns: [centralPending.checkRun, spoof.checkRun],
    }),
    /workflow-run identity is inconsistent/i,
  );

  const wrongSource = trustedGateFixture({
    workflowOverrides: { state: "disabled_manually" },
  });
  await assert.rejects(
    inspectTrustedGate({
      api: trustedGateApi(wrongSource),
      owner: "LCV-Ideas-Software",
      repo: "example",
      headSha: SHA,
      checkRuns: [wrongSource.checkRun],
    }),
    /source workflow identity is inconsistent/i,
  );

  const noSuite = trustedGateFixture();
  delete noSuite.checkRun.check_suite;
  await assert.rejects(
    inspectTrustedGate({
      api: trustedGateApi(noSuite),
      owner: "LCV-Ideas-Software",
      repo: "example",
      headSha: SHA,
      checkRuns: [noSuite.checkRun],
    }),
    /no check-suite identity/i,
  );
});

test("trusted gate outcome uses the latest authenticated run attempt", () => {
  const verified = ({
    checkId,
    runId,
    attempt,
    status = "completed",
    conclusion = "success",
  }) => ({
    checkRun: { id: checkId, status, conclusion },
    job: { run_attempt: attempt, status, conclusion },
    run: { id: runId, run_attempt: attempt, status, conclusion },
    sourceRevisionVerified: true,
  });
  const oldFailure = verified({
    checkId: 10,
    runId: 100,
    attempt: 1,
    conclusion: "failure",
  });
  const latestSuccess = verified({ checkId: 11, runId: 100, attempt: 2 });
  oldFailure.run = latestSuccess.run;
  assert.equal(
    selectCurrentTrustedGateRun([oldFailure, latestSuccess]),
    latestSuccess,
  );

  const newerRun = verified({
    checkId: 20,
    runId: 101,
    attempt: 1,
    status: "in_progress",
    conclusion: null,
  });
  assert.equal(
    selectCurrentTrustedGateRun([latestSuccess, newerRun]),
    newerRun,
  );
  assert.throws(
    () =>
      selectCurrentTrustedGateRun([
        latestSuccess,
        { ...latestSuccess, checkRun: { ...latestSuccess.checkRun, id: 12 } },
      ]),
    /multiple checks.*current run attempt/i,
  );
  assert.throws(
    () =>
      selectCurrentTrustedGateRun([
        {
          ...latestSuccess,
          job: { ...latestSuccess.job, run_attempt: 1 },
        },
      ]),
    /no check.*current run attempt/i,
  );
});

test("resolved bot-review veto reruns only the exact first gate attempt once", async () => {
  const fixture = trustedGateFixture({ conclusion: "failure", runAttempt: 1 });
  const current = { ...fixture, sourceRevisionVerified: true };
  const annotation = {
    annotation_level: "failure",
    title: BOT_REVIEW_VETO_ANNOTATION_TITLE,
    message: `BOT_REVIEW_VETO UNRESOLVED_COPILOT_THREAD example#7@${SHA}: unresolved Copilot review thread remains`,
  };
  const decision = {
    current,
    annotations: [annotation],
    owner: "LCV-Ideas-Software",
    repo: "example",
    number: 7,
    headSha: SHA,
  };
  assert.equal(isRecoverableBotReviewVetoFailure(decision), true);
  for (const override of [
    { annotations: [] },
    {
      annotations: [
        annotation,
        {
          ...annotation,
          message: `BOT_REVIEW_VETO NONRECOVERABLE example#7@${SHA}: malformed review`,
        },
      ],
    },
    { annotations: [{ ...annotation, title: "LCV_GATE_LATE_REVIEW_TIMEOUT" }] },
    {
      annotations: [
        {
          ...annotation,
          message: `BOT_REVIEW_VETO UNRESOLVED_COPILOT_THREAD example#7@${OTHER_SHA}: stale`,
        },
      ],
    },
    {
      annotations: [
        {
          ...annotation,
          message: `BOT_REVIEW_VETO NONRECOVERABLE example#7@${SHA}: suppressed finding`,
        },
      ],
    },
    { current: { ...current, sourceRevisionVerified: false } },
    {
      current: {
        ...current,
        run: { ...current.run, run_attempt: 2 },
        job: { ...current.job, run_attempt: 2 },
      },
    },
  ]) {
    assert.equal(
      isRecoverableBotReviewVetoFailure({ ...decision, ...override }),
      false,
    );
  }

  const calls = [];
  const api = {
    request: async (path, options) => {
      calls.push([path, options]);
      if (path === fixture.run.url) return fixture.run;
      if (path.endsWith("/rerun-failed-jobs") && options?.method === "POST") {
        return {};
      }
      assert.fail(`unexpected request ${path}`);
    },
  };
  const outcome = await requestResolvedBotReviewVetoRerun({
    api,
    owner: "LCV-Ideas-Software",
    repo: "example",
    number: 7,
    expectedHead: SHA,
    expectedBase: BASE_SHA,
    gate: {
      outcome: "trusted-gate-bot-veto-rerun-needed",
      run: fixture.run,
    },
    reassess: async () => ({
      pullRequest: { head: { sha: SHA } },
      mainSha: BASE_SHA,
    }),
  });
  assert.equal(outcome, "trusted-gate-bot-veto-rerun-requested");
  assert.deepEqual(calls.at(-2), [fixture.run.url, undefined]);
  assert.deepEqual(calls.at(-1), [
    `/repos/LCV-Ideas-Software/example/actions/runs/${fixture.run.id}/rerun-failed-jobs`,
    { method: "POST" },
  ]);

  let mutated = false;
  await assert.rejects(
    requestResolvedBotReviewVetoRerun({
      api: {
        request: async () => {
          mutated = true;
        },
      },
      owner: "LCV-Ideas-Software",
      repo: "example",
      number: 7,
      expectedHead: SHA,
      expectedBase: BASE_SHA,
      gate: {
        outcome: "trusted-gate-bot-veto-rerun-needed",
        run: fixture.run,
      },
      reassess: async () => {
        throw new BotReviewVetoError("veto still present");
      },
    }),
    /veto still present/i,
  );
  assert.equal(mutated, false);

  let reassessments = 0;
  const raceCalls = [];
  await assert.rejects(
    requestResolvedBotReviewVetoRerun({
      api: {
        request: async (path, options) => {
          raceCalls.push([path, options]);
          if (path === fixture.run.url) return fixture.run;
          assert.fail("rerun mutation must not follow a late head change");
        },
      },
      owner: "LCV-Ideas-Software",
      repo: "example",
      number: 7,
      expectedHead: SHA,
      expectedBase: BASE_SHA,
      gate: {
        outcome: "trusted-gate-bot-veto-rerun-needed",
        run: fixture.run,
      },
      reassess: async () => ({
        pullRequest: {
          head: { sha: reassessments++ === 0 ? SHA : OTHER_SHA },
        },
        mainSha: BASE_SHA,
      }),
    }),
    /head\/base changed/i,
  );
  assert.deepEqual(raceCalls, [[fixture.run.url, undefined]]);

  const command = botReviewVetoWorkflowCommand(
    new BotReviewVetoError(`example#7@${SHA}: unresolved bot thread`),
  );
  assert.equal(
    command,
    `::error title=${BOT_REVIEW_VETO_ANNOTATION_TITLE}::BOT_REVIEW_VETO NONRECOVERABLE example#7@${SHA}: unresolved bot thread`,
  );
  assert.equal(
    botReviewVetoWorkflowCommand(new Error("ordinary failure")),
    null,
  );
});

test("resolved bot-review veto accepts only the authenticated canary synthetic run", async () => {
  const fixture = canaryTrustedGateFixture({ conclusion: "failure" });
  const calls = [];
  const outcome = await requestResolvedBotReviewVetoRerun({
    api: {
      request: async (path, options) => {
        calls.push([path, options]);
        if (path === fixture.run.url) return fixture.run;
        if (path.endsWith("/rerun-failed-jobs") && options?.method === "POST") {
          return {};
        }
        assert.fail(`unexpected request ${path}`);
      },
    },
    owner: "LCV-Ideas-Software",
    repo: ".github-private",
    number: 5,
    expectedHead: SHA,
    expectedBase: BASE_SHA,
    gate: {
      outcome: "trusted-gate-bot-veto-rerun-needed",
      run: fixture.run,
    },
    repositoryPolicy: canaryRepositoryPolicy(),
    reassess: async () => ({
      pullRequest: { head: { sha: SHA } },
      mainSha: BASE_SHA,
    }),
  });
  assert.equal(outcome, "trusted-gate-bot-veto-rerun-requested");
  assert.equal(calls.at(-1)[0].endsWith("/rerun-failed-jobs"), true);

  const centralSpoof = {
    ...fixture.run,
    workflow_id: TRUSTED_GATE_SOURCE_WORKFLOW_ID,
    workflow_url: `https://api.github.com/repos/${TRUSTED_GATE_SOURCE_REPOSITORY}/actions/workflows/${TRUSTED_GATE_SOURCE_WORKFLOW_ID}`,
  };
  await assert.rejects(
    requestResolvedBotReviewVetoRerun({
      api: { request: async () => centralSpoof },
      owner: "LCV-Ideas-Software",
      repo: ".github-private",
      number: 5,
      expectedHead: SHA,
      expectedBase: BASE_SHA,
      gate: {
        outcome: "trusted-gate-bot-veto-rerun-needed",
        run: fixture.run,
      },
      repositoryPolicy: canaryRepositoryPolicy(),
      reassess: async () => ({
        pullRequest: { head: { sha: SHA } },
        mainSha: BASE_SHA,
      }),
    }),
    /rerun identity changed/i,
  );
});

test("trusted gate check, job, run, and source fields all fail closed", async () => {
  const cases = [
    [
      "noncanonical details URL",
      (fixture) => {
        fixture.checkRun.details_url = "https://example.test/spoof";
      },
      /details URL is not canonical/i,
    ],
    [
      "job check-run URL",
      (fixture) => {
        fixture.job.check_run_url = "https://api.github.com/spoof";
      },
      /job identity is inconsistent/i,
    ],
    [
      "job ID",
      (fixture) => {
        fixture.job.id += 1;
      },
      /job identity is inconsistent/i,
    ],
    [
      "job run back-reference",
      (fixture) => {
        fixture.job.run_id += 1;
      },
      /job identity is inconsistent/i,
    ],
    [
      "job head",
      (fixture) => {
        fixture.job.head_sha = OTHER_SHA;
      },
      /job identity is inconsistent/i,
    ],
    [
      "run event",
      (fixture) => {
        fixture.run.event = "workflow_dispatch";
      },
      /workflow-run identity is inconsistent/i,
    ],
    [
      "run repository",
      (fixture) => {
        fixture.run.repository.full_name = "LCV-Ideas-Software/spoof";
      },
      /workflow-run identity is inconsistent/i,
    ],
    [
      "run path",
      (fixture) => {
        fixture.run.path = ".github/workflows/spoof.yml";
      },
      /workflow-run identity is inconsistent/i,
    ],
    [
      "source workflow ID",
      (fixture) => {
        fixture.workflow.id = 1;
      },
      /source workflow identity is inconsistent/i,
    ],
  ];
  for (const [label, mutate, expected] of cases) {
    const fixture = trustedGateFixture();
    mutate(fixture);
    await assert.rejects(
      inspectTrustedGate({
        api: trustedGateApi(fixture),
        owner: "LCV-Ideas-Software",
        repo: "example",
        headSha: SHA,
        checkRuns: [fixture.checkRun],
      }),
      expected,
      label,
    );
  }

  for (const details of [
    "https://github.com/LCV-Ideas-Software/example/actions/runs/0/job/1",
    "https://github.com/LCV-Ideas-Software/example/actions/runs/1/job/9007199254740992",
    "https://github.com/LCV-Ideas-Software/example/actions/runs/1/job/not-a-number",
  ]) {
    const malformed = trustedGateFixture();
    malformed.checkRun.details_url = details;
    await assert.rejects(
      inspectTrustedGate({
        api: trustedGateApi(malformed),
        owner: "LCV-Ideas-Software",
        repo: "example",
        headSha: SHA,
        checkRuns: [malformed.checkRun],
      }),
      /details URL is not canonical/i,
      details,
    );
  }

  const first = trustedGateFixture();
  const duplicate = trustedGateFixture({ runId: 31264423092 });
  duplicate.run.check_suite_id = first.run.check_suite_id;
  await assert.rejects(
    inspectTrustedGate({
      api: trustedGateApi([first, duplicate]),
      owner: "LCV-Ideas-Software",
      repo: "example",
      headSha: SHA,
      checkRuns: [first.checkRun],
    }),
    /does not map to exactly one workflow run/i,
  );
});

test("allCommitsVerified is exact-head, nonempty, and fail-closed", () => {
  const verified = [
    { sha: OTHER_SHA, commit: { verification: { verified: true } } },
    { sha: SHA, commit: { verification: { verified: true } } },
  ];
  assert.deepEqual(allCommitsVerified(verified, SHA), { ok: true });
  assert.match(allCommitsVerified([], SHA).reason, /no commits/i);
  assert.match(
    allCommitsVerified(
      [{ sha: SHA, commit: { verification: { verified: false } } }],
      SHA,
    ).reason,
    /not verified/i,
  );
  assert.match(allCommitsVerified(verified, BASE_SHA).reason, /last commit/i);
});

test("GitHub API pagination reads every status page and fails on truncation", async () => {
  const urls = [];
  const api = new GitHubApi("redacted", async (url) => {
    urls.push(url);
    const page = Number(new URL(url).searchParams.get("page"));
    const payload =
      page === 1
        ? Array.from({ length: 100 }, (_, id) => ({ id }))
        : [{ id: 100 }];
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  });
  assert.equal(
    (await api.pages("/repos/o/r/commits/sha/statuses")).length,
    101,
  );
  assert.equal(urls.length, 2);

  const truncated = new GitHubApi("redacted", async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify(Array.from({ length: 100 }, (_, id) => ({ id }))),
  }));
  await assert.rejects(
    truncated.pages("/statuses", { maxPages: 1 }),
    /exceeded 100 records/i,
  );
});

test("check evidence enumerates every check-run instance and legacy status page", async () => {
  const calls = [];
  const evidence = await readCheckEvidence(
    {
      pages: async (...args) => {
        calls.push(args);
        return args[0].includes("check-runs")
          ? [{ id: 1 }, { id: 2 }]
          : [{ id: 3 }];
      },
    },
    "LCV-Ideas-Software",
    "example",
    SHA,
  );
  assert.deepEqual(evidence, {
    checkRuns: [{ id: 1 }, { id: 2 }],
    statuses: [{ id: 3 }],
  });
  assert.deepEqual(calls, [
    [
      `/repos/LCV-Ideas-Software/example/commits/${SHA}/check-runs?filter=all`,
      { extract: calls[0][1].extract },
    ],
    [`/repos/LCV-Ideas-Software/example/commits/${SHA}/statuses`],
  ]);
  assert.deepEqual(calls[0][1].extract({ check_runs: ["all"] }), ["all"]);
});

test("GitHub API retries reads but never retries mutations", async () => {
  let readCalls = 0;
  const readApi = new GitHubApi("redacted", async () => {
    readCalls += 1;
    if (readCalls === 1) throw new Error("transient");
    return { ok: true, status: 200, text: async () => "{}" };
  });
  assert.deepEqual(await readApi.request("/read"), {});
  assert.equal(readCalls, 2);

  let mutationCalls = 0;
  const mutationApi = new GitHubApi("redacted", async () => {
    mutationCalls += 1;
    throw new Error("ambiguous mutation");
  });
  await assert.rejects(
    mutationApi.graphql("mutation { noop }", {}),
    /transport failure/i,
  );
  assert.equal(mutationCalls, 1);
});

test("GitHub API labels JSON request bodies without mislabeling bodyless reads", async () => {
  const requests = [];
  const api = new GitHubApi("redacted", async (url, init) => {
    requests.push({ url, init });
    return { ok: true, status: 200, text: async () => "{}" };
  });
  await api.request("/bodyless");
  await api.graphql("query { viewer { login } }", {});

  assert.equal(requests[0].init.headers["Content-Type"], undefined);
  assert.equal(requests[0].init.body, undefined);
  assert.equal(requests[1].init.headers["Content-Type"], "application/json");
  assert.equal(typeof requests[1].init.body, "string");
});

test("merge-group association is nonempty, unique, and exact repository/main", () => {
  const checked = validatePolicy(policy());
  assert.equal(
    selectAssociatedPullRequests(
      [pull()],
      "LCV-Ideas-Software/example",
      checked,
    ).length,
    1,
  );
  assert.throws(
    () =>
      selectAssociatedPullRequests([], "LCV-Ideas-Software/example", checked),
    /no associated pull request/i,
  );
  assert.throws(
    () =>
      selectAssociatedPullRequests(
        [pull(), pull()],
        "LCV-Ideas-Software/example",
        checked,
      ),
    /duplicate/i,
  );
});

test("merge-group identity requires a one-at-a-time queue and exact entry", () => {
  const candidate = pull();
  const queue = {
    configuration: { maximumEntriesToBuild: 1, maximumEntriesToMerge: 1 },
    entries: {
      nodes: [
        {
          state: "AWAITING_CHECKS",
          baseCommit: { oid: BASE_SHA },
          headCommit: { oid: OTHER_SHA },
          pullRequest: {
            number: 7,
            headRefOid: SHA,
            baseRefOid: BASE_SHA,
            baseRefName: "main",
          },
        },
      ],
    },
  };
  assert.equal(
    validateMergeQueueEvidence({
      queue,
      pulls: [candidate],
      groupHead: OTHER_SHA,
      groupBase: BASE_SHA,
    }).pullRequest.number,
    7,
  );
  assert.throws(
    () =>
      validateMergeQueueEvidence({
        queue: {
          ...queue,
          configuration: { maximumEntriesToBuild: 2, maximumEntriesToMerge: 1 },
        },
        pulls: [candidate],
        groupHead: OTHER_SHA,
        groupBase: BASE_SHA,
      }),
    /maximumEntriesToBuild=1/i,
  );
  assert.throws(
    () =>
      validateMergeQueueEvidence({
        queue,
        pulls: [candidate, { ...candidate, number: 8 }],
        groupHead: OTHER_SHA,
        groupBase: BASE_SHA,
      }),
    /exactly one pull request/i,
  );
});

test("enqueue input pins expectedHeadOid and never jumps the queue", () => {
  assert.deepEqual(buildEnqueueInput("PR_node", SHA), {
    pullRequestId: "PR_node",
    expectedHeadOid: SHA,
    jump: false,
  });
  assert.throws(() => buildEnqueueInput("PR_node", "bad"), /head sha/i);
});

test("enqueue mergeability follows the REST tri-state and a closed state allowlist", () => {
  for (const mergeableState of [
    "clean",
    "has_hooks",
    "blocked",
    "behind",
    "unstable",
  ]) {
    assert.equal(
      classifyPullRequestMergeability({
        mergeable: true,
        mergeable_state: mergeableState,
      }),
      "ready",
    );
  }
  for (const candidate of [
    { mergeable: null, mergeable_state: "unknown" },
    { mergeable: null, mergeable_state: "clean" },
    { mergeable: null, mergeable_state: "dirty" },
    { mergeable: undefined, mergeable_state: "unknown" },
    { mergeable: undefined, mergeable_state: "clean" },
    {},
    { mergeable: true },
    { mergeable: true, mergeable_state: "unknown" },
  ]) {
    assert.equal(classifyPullRequestMergeability(candidate), "pending");
  }
  for (const candidate of [
    { mergeable: false, mergeable_state: "unknown" },
    { mergeable: false, mergeable_state: "clean" },
    { mergeable: true, mergeable_state: "dirty" },
  ]) {
    assert.equal(classifyPullRequestMergeability(candidate), "conflict");
  }
  for (const candidate of [
    { mergeable: true, mergeable_state: "draft" },
    { mergeable: true, mergeable_state: "unexpected" },
    { mergeable: "true", mergeable_state: "clean" },
  ]) {
    assert.equal(classifyPullRequestMergeability(candidate), "invalid");
  }
});

test("controller observes unknown mergeability without touching a mutation path", async () => {
  let apiTouched = false;
  const result = await assessForEnqueue({
    api: new Proxy(
      {},
      {
        get() {
          apiTouched = true;
          throw new Error("API must not be touched after unknown mergeability");
        },
      },
    ),
    owner: "LCV-Ideas-Software",
    repo: "example",
    pullRequest: pull(),
    policy: policy(),
    assess: async () => ({
      pullRequest: {
        ...pull(),
        mergeable: null,
        mergeable_state: "unknown",
      },
    }),
  });
  assert.deepEqual(result, { outcome: "mergeability-pending" });
  assert.equal(apiTouched, false);

  await assert.rejects(
    assessForEnqueue({
      api: {},
      owner: "LCV-Ideas-Software",
      repo: "example",
      pullRequest: pull(),
      policy: policy(),
      assess: async () => ({
        pullRequest: {
          ...pull(),
          mergeable: "true",
          mergeable_state: "clean",
        },
      }),
    }),
    /mergeability is incoherent/i,
  );
});

test("blocked and unstable reach enqueue only through the full final fixed point", async () => {
  for (const finalState of ["blocked", "unstable"]) {
    const trace = [];
    let assessment = 0;
    const result = await enqueueAfterFinalTrustAssessment({
      expectedHead: SHA,
      expectedBase: BASE_SHA,
      reassess: async () => {
        const mergeableState = assessment++ === 0 ? "clean" : finalState;
        trace.push(`reassess:${mergeableState}`);
        return {
          pullRequest: {
            head: { sha: SHA },
            mergeable: true,
            mergeable_state: mergeableState,
          },
          mainSha: BASE_SHA,
        };
      },
      recheckChecks: async () => {
        trace.push("checks");
        return "stable-inventory";
      },
      scanCode: async () => trace.push("scan"),
      enqueueMutation: async () => {
        trace.push("enqueue");
        return "queued";
      },
    });
    assert.equal(result, "queued");
    assert.deepEqual(trace, [
      "reassess:clean",
      "checks",
      "scan",
      `reassess:${finalState}`,
      "checks",
      "enqueue",
    ]);
  }
});

test("enqueue mutation is preceded by a final exact-head trust assessment", async () => {
  const trace = [];
  const outcome = await enqueueAfterFinalTrustAssessment({
    expectedHead: SHA,
    expectedBase: BASE_SHA,
    reassess: async () => {
      trace.push("reassess");
      return {
        pullRequest: {
          head: { sha: SHA },
          mergeable: true,
          mergeable_state: "clean",
        },
        mainSha: BASE_SHA,
      };
    },
    recheckChecks: async () => {
      trace.push("recheck-checks");
      return "stable-inventory";
    },
    scanCode: async () => trace.push("scan-code"),
    enqueueMutation: async () => {
      trace.push("enqueue");
      return "queued";
    },
  });
  assert.equal(outcome, "queued");
  assert.deepEqual(trace, [
    "reassess",
    "recheck-checks",
    "scan-code",
    "reassess",
    "recheck-checks",
    "enqueue",
  ]);

  let mutated = false;
  await assert.rejects(
    enqueueAfterFinalTrustAssessment({
      expectedHead: SHA,
      expectedBase: BASE_SHA,
      reassess: async () => {
        throw new Error("late connector finding");
      },
      recheckChecks: async () => "stable-inventory",
      scanCode: async () => undefined,
      enqueueMutation: async () => {
        mutated = true;
      },
    }),
    /late connector finding/i,
  );
  assert.equal(mutated, false);

  for (const evidence of [
    { pullRequest: { head: { sha: OTHER_SHA } }, mainSha: BASE_SHA },
    { pullRequest: { head: { sha: SHA } }, mainSha: OTHER_SHA },
  ]) {
    await assert.rejects(
      enqueueAfterFinalTrustAssessment({
        expectedHead: SHA,
        expectedBase: BASE_SHA,
        reassess: async () => evidence,
        recheckChecks: async () => "stable-inventory",
        scanCode: async () => undefined,
        enqueueMutation: async () => {
          mutated = true;
        },
      }),
      /changed at final enqueue boundary/i,
    );
  }
  assert.equal(mutated, false);

  let rechecks = 0;
  await assert.rejects(
    enqueueAfterFinalTrustAssessment({
      expectedHead: SHA,
      expectedBase: BASE_SHA,
      reassess: async () => ({
        pullRequest: {
          head: { sha: SHA },
          mergeable: true,
          mergeable_state: "clean",
        },
        mainSha: BASE_SHA,
      }),
      recheckChecks: async () => {
        rechecks += 1;
        if (rechecks === 2)
          throw new Error("final exact-SHA check inventory is pending");
        return "stable-inventory";
      },
      scanCode: async () => undefined,
      enqueueMutation: async () => {
        mutated = true;
      },
    }),
    /check inventory is pending/i,
  );
  assert.equal(mutated, false);

  await assert.rejects(
    enqueueAfterFinalTrustAssessment({
      expectedHead: SHA,
      expectedBase: BASE_SHA,
      reassess: async () => ({
        pullRequest: {
          head: { sha: SHA },
          mergeable: true,
          mergeable_state: "clean",
        },
        mainSha: BASE_SHA,
      }),
      recheckChecks: async () => "stable-inventory",
      scanCode: async () => {
        throw new Error("late code-scanning alert");
      },
      enqueueMutation: async () => {
        mutated = true;
      },
    }),
    /late code-scanning alert/i,
  );
  assert.equal(mutated, false);

  let fingerprintRead = 0;
  await assert.rejects(
    enqueueAfterFinalTrustAssessment({
      expectedHead: SHA,
      expectedBase: BASE_SHA,
      reassess: async () => ({
        pullRequest: {
          head: { sha: SHA },
          mergeable: true,
          mergeable_state: "clean",
        },
        mainSha: BASE_SHA,
      }),
      recheckChecks: async () => {
        fingerprintRead += 1;
        return fingerprintRead === 1 ? "inventory-a" : "inventory-b";
      },
      scanCode: async () => undefined,
      enqueueMutation: async () => {
        mutated = true;
      },
    }),
    /check inventory changed while enqueue code scanning/i,
  );
  assert.equal(mutated, false);

  for (const mergeabilitySequence of [
    [{ mergeable: null, mergeable_state: "unknown" }],
    [
      { mergeable: true, mergeable_state: "clean" },
      { mergeable: null, mergeable_state: "unknown" },
    ],
  ]) {
    let assessment = 0;
    await assert.rejects(
      enqueueAfterFinalTrustAssessment({
        expectedHead: SHA,
        expectedBase: BASE_SHA,
        reassess: async () => ({
          pullRequest: {
            head: { sha: SHA },
            ...mergeabilitySequence[
              Math.min(assessment++, mergeabilitySequence.length - 1)
            ],
          },
          mainSha: BASE_SHA,
        }),
        recheckChecks: async () => "stable-inventory",
        scanCode: async () => undefined,
        enqueueMutation: async () => {
          mutated = true;
        },
      }),
      /mergeability is not ready/i,
    );
    assert.equal(mutated, false);
  }
});

test("checked-in policy covers every active repository and raw analyzer wrappers", async () => {
  const raw = JSON.parse(
    await readFile(new URL("./policy.json", import.meta.url), "utf8"),
  );
  const checked = validatePolicy(raw);
  assert.deepEqual(checked.copilot_reviewer, {
    database_id: COPILOT_REVIEWER_ID,
    node_id: COPILOT_REVIEWER_NODE_ID,
    rest_review_login: "copilot-pull-request-reviewer[bot]",
    graphql_login: "copilot-pull-request-reviewer",
    inline_alias_login: "Copilot",
  });
  assert.deepEqual(Object.keys(checked.repositories).sort(), [
    ".github",
    ".github-private",
    "admin-app",
    "astrologo-app",
    "calculadora-app",
    "cross-review",
    "maestro-app",
    "mainsite-app",
    "mtasts-motor",
    "oraculo-financeiro",
    "sponsor-motor",
    "ultrabrain-mcp",
  ]);
  for (const [repo, config] of Object.entries(checked.repositories)) {
    const identities = new Set(
      config.required_checks.map(
        ({ name, app_id: appId }) => `${name}@${appId}`,
      ),
    );
    assert.ok(
      identities.has("CodeQL@57789"),
      `${repo}: missing GHAS CodeQL check`,
    );
    assert.ok(
      [...identities].some((identity) =>
        identity.startsWith("Analyze actions@15368"),
      ),
      `${repo}: missing raw CodeQL executor`,
    );
    assert.ok(
      identities.has("zizmor@57789"),
      `${repo}: missing GHAS zizmor check`,
    );
    assert.ok(
      [...identities].some((identity) => identity.startsWith("Run zizmor")),
      `${repo}: missing raw zizmor executor`,
    );
    if (repo !== ".github-private") {
      assert.equal(
        config.provenance,
        undefined,
        `${repo}: unexpected authority`,
      );
    }
  }
  assert.deepEqual(
    checked.repositories[".github-private"].provenance,
    canaryRepositoryPolicy().provenance,
  );
  const githubPullChecks = new Set(
    requiredChecksForPhase(checked.repositories[".github"], "pull_request").map(
      ({ name, app_id: appId }) => `${name}@${appId}`,
    ),
  );
  const githubMergeChecks = new Set(
    requiredChecksForPhase(checked.repositories[".github"], "merge_group").map(
      ({ name, app_id: appId }) => `${name}@${appId}`,
    ),
  );
  assert.ok(
    githubPullChecks.has("Trusted PR controller tests@15368"),
    ".github PR phase: missing Trusted PR controller tests",
  );
  for (const name of [
    "Verify relay and recovery controller",
    "Test repository governance",
    "Verify Slack workflow app",
  ]) {
    assert.equal(
      githubPullChecks.has(`${name}@15368`),
      false,
      `.github PR phase must not require path-filtered ${name}`,
    );
    assert.ok(
      githubMergeChecks.has(`${name}@15368`),
      `.github merge-group phase: missing ${name}`,
    );
  }
});

test("workflow contracts isolate the PAT and preserve write-all", async () => {
  const engine = await readFile(new URL("./main.mjs", import.meta.url), "utf8");
  const gate = await readFile(
    new URL("../.github/workflows/trusted-pr-gate.yml", import.meta.url),
    "utf8",
  );
  const controller = await readFile(
    new URL("../.github/workflows/trusted-pr-controller.yml", import.meta.url),
    "utf8",
  );
  const controllerCi = await readFile(
    new URL(
      "../.github/workflows/trusted-pr-controller-ci.yml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(gate, /pull_request:/);
  assert.match(gate, /ready_for_review/);
  assert.doesNotMatch(gate, /\bedited\b/);
  assert.match(gate, /merge_group:/);
  assert.match(gate, /permissions:\s+write-all/);
  assert.match(gate, /repository:\s+\$\{\{ job\.workflow_repository \}\}/);
  assert.match(gate, /ref:\s+\$\{\{ job\.workflow_sha \}\}/);
  assert.doesNotMatch(gate, /LCV_AUTOMATION_TOKEN|github-administration/);

  assert.match(controller, /permissions:\s+write-all/);
  assert.match(controller, /environment:\s+github-administration/);
  assert.match(controller, /secrets\.LCV_AUTOMATION_TOKEN/);
  assert.match(controller, /schedule:/);

  assert.match(controllerCi, /pull_request:/);
  assert.match(controllerCi, /merge_group:/);
  assert.match(controllerCi, /permissions:\s+write-all/);
  assert.doesNotMatch(
    controllerCi,
    /LCV_AUTOMATION_TOKEN|github-administration/,
  );

  assert.match(engine, /enqueuePullRequest/);
  assert.match(engine, /expectedHeadOid/);
  assert.match(engine, /pullRequestReview \{ databaseId commit \{ oid \} \}/);
  assert.match(engine, /recheckChecks/);
  assert.match(engine, /scanCode/);
  assert.doesNotMatch(
    engine,
    /\/pulls\/[^`"']*\/merge|mergePullRequest|enablePullRequestAutoMerge/,
  );
});
