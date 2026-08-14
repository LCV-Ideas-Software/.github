import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { parseDocument } from "yaml";

const POLICY_STEP_NAME = "Validate all required context contracts";
const POLICY_COMMAND = "node scripts/required-contexts-policy.mjs";
const POLICY_TEST_STEP_NAME = "Test required context policy";
const POLICY_TEST_COMMAND =
  "node --test scripts/required-contexts-policy.test.mjs";
const SLACK_VERIFY_CONDITION =
  "github.event_name != 'schedule' || github.event.schedule == '17 7 * * *'";
const ZIZMOR_CONFIG_PATH = ".github/zizmor.yml";
const RELAY_CONFIG_PATH = "workers/github-slack-relay/wrangler.jsonc";
const D1_REAPER_WORKFLOW_PATH =
  ".github/workflows/slack-d1-disposable-reaper.yml";

// Each digest covers the YAML-parsed workflow env, defaults, and complete
// required job. Mapping keys are sorted; names, conditions, permissions,
// matrix, immutable Action references, steps, commands, inputs, and paths are
// all part of the digest and therefore fail closed on drift.
const WORKFLOW_SPECS = Object.freeze([
  {
    path: ".github/workflows/dependency-review.yml",
    workflowName: "Dependency Review",
    jobId: "dependency-review",
    jobIds: ["dependency-review"],
    jobName: "Dependency Review",
    eventIds: ["pull_request", "merge_group"],
    pullRequest: { branches: ["main"] },
    contexts: ["Dependency Review"],
    policyRunner: true,
    nodeOptions: undefined,
    digest: "0521ff840de65290c7477ad10cf2865bf9a53279fc7e0f114b9319375fbf1b7e",
  },
  {
    path: ".github/workflows/codeql.yml",
    workflowName: "CodeQL",
    jobId: "analyze",
    jobIds: ["analyze"],
    jobName: "Analyze ${{ matrix.language }}",
    eventIds: [
      "workflow_dispatch",
      "push",
      "pull_request",
      "merge_group",
      "schedule",
    ],
    pullRequest: {
      branches: ["main"],
      types: ["opened", "synchronize", "reopened", "ready_for_review"],
    },
    contexts: ["Analyze actions", "Analyze javascript-typescript"],
    policyRunner: true,
    nodeOptions: undefined,
    digest: "8ad694feac1001712602beb4cb04630dd5ae58d72470065fd5d89fdd33a6a844",
  },
  {
    path: ".github/workflows/zizmor.yml",
    workflowName: "Zizmor",
    jobId: "zizmor",
    jobIds: ["zizmor"],
    jobName: "Run zizmor",
    eventIds: [
      "workflow_call",
      "push",
      "pull_request",
      "merge_group",
      "schedule",
      "workflow_dispatch",
    ],
    workflowCall: null,
    pullRequest: { branches: ["main"] },
    contexts: ["Run zizmor"],
    policyRunner: false,
    nodeOptions: undefined,
    digest: "5582b7ccc7c0ef37d8cf12f333acdc8e5783859a3f62b845ff03d36c5a445499",
  },
  {
    path: ".github/workflows/pages.yml",
    workflowName: "Pages",
    jobId: "build",
    jobIds: ["build", "deploy"],
    jobName: "Build Pages artifact",
    eventIds: ["push", "pull_request", "merge_group", "workflow_dispatch"],
    pullRequest: { branches: ["main"] },
    contexts: ["Build Pages artifact"],
    policyRunner: false,
    nodeOptions: "--no-deprecation",
    digest: "8d51af3a16c8203d641dd6640379503eac9ab8826db17643bd91e0a4c6e612e2",
  },
  {
    path: ".github/workflows/github-slack-integration.yml",
    workflowName: "GitHub Slack Integration",
    jobId: "verify",
    jobIds: ["verify", "prove_remote_d1", "deploy", "deploy_slack"],
    jobName: "Verify GitHub Slack relay",
    eventIds: ["push", "pull_request", "merge_group", "workflow_dispatch"],
    pullRequest: { branches: ["main"] },
    contexts: ["Verify GitHub Slack relay"],
    policyRunner: false,
    nodeOptions: "--no-deprecation",
    digest: "eeae5799c77b922a2d89c1f9212bc5186808bd61fa3cdc03481f678a4a60b81c",
    privilegedJobIds: ["prove_remote_d1", "deploy", "deploy_slack"],
    privilegedDigest:
      "94a41f95942b9f80ce0eedd3b06ee38427e29f7053ed843e218cd4426a49ea8a",
  },
  {
    path: ".github/workflows/slack-github-integration.yml",
    workflowName: "Slack GitHub Integration",
    jobId: "verify",
    jobIds: ["verify", "monitor"],
    jobName: "Verify Slack workflow app",
    eventIds: [
      "push",
      "pull_request",
      "merge_group",
      "schedule",
      "workflow_dispatch",
    ],
    jobIf: SLACK_VERIFY_CONDITION,
    pullRequest: { branches: ["main"] },
    contexts: ["Verify Slack workflow app"],
    policyRunner: false,
    nodeOptions: undefined,
    digest: "ea3c7e7d5d89e5071df87fa01505542f6011629da95d67d65d5b55417c896477",
    privilegedJobIds: ["monitor"],
    privilegedDigest:
      "7675e2f907c110525f90ed116843016c73babf89f026c6031b780ee4f3030dd4",
  },
]);

const STANDALONE_PRIVILEGED_WORKFLOW_SPECS = Object.freeze([
  {
    path: D1_REAPER_WORKFLOW_PATH,
    jobIds: ["reap"],
    digest: "9bc6349e6e985e9bf88eb7029cc37b12ad8230fcb19c6e87a86ec1ca4a4dbabd",
  },
]);

const YAML_SOURCE_PATHS = Object.freeze([
  ...WORKFLOW_SPECS.map(({ path }) => path),
  ...STANDALONE_PRIVILEGED_WORKFLOW_SPECS.map(({ path }) => path),
  ZIZMOR_CONFIG_PATH,
]);
const ALL_SOURCE_PATHS = Object.freeze([
  ...YAML_SOURCE_PATHS,
  RELAY_CONFIG_PATH,
]);

function fail(message) {
  throw new Error(message);
}

function requirePolicy(condition, message) {
  if (!condition) fail(message);
}

function exact(actual, expected, label) {
  requirePolicy(
    isDeepStrictEqual(actual, expected),
    `${label} is not the canonical value`,
  );
}

function plainObject(value, label) {
  requirePolicy(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
    `${label} must be a plain mapping`,
  );
  return value;
}

function parseYaml(source, path) {
  requirePolicy(typeof source === "string", `${path} source is missing`);
  const document = parseDocument(source, {
    keepSourceTokens: false,
    prettyErrors: true,
    schema: "core",
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    fail(`${path} YAML is invalid: ${document.errors[0].message}`);
  }
  if (document.warnings.length > 0) {
    fail(`${path} YAML is ambiguous: ${document.warnings[0].message}`);
  }
  let value;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    fail(`${path} YAML aliases are forbidden: ${error.message}`);
  }
  return plainObject(value, path);
}

function rejectKey(value, forbidden, label) {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      rejectKey(item, forbidden, `${label}[${index}]`),
    );
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    requirePolicy(key !== forbidden, `${label} must not declare ${forbidden}`);
    rejectKey(nested, forbidden, `${label}.${key}`);
  }
}

function rejectFailureMasking(job, path) {
  for (const [index, step] of job.steps.entries()) {
    if (typeof step.run !== "string") continue;
    const run = step.run.replaceAll("\r\n", "\n");
    for (const pattern of [
      /\|\|\s*(?:true|:)(?:\s|$)/m,
      /(?:^|;)\s*exit\s+0(?:\s|$)/m,
      /&&\s*true(?:\s|$)/m,
    ]) {
      requirePolicy(
        !pattern.test(run),
        `${path} step ${index} contains failure masking`,
      );
    }
    const allowedCapture =
      path === ".github/workflows/zizmor.yml" &&
      step.name === "Analyze workflows and capture the enforcement result";
    requirePolicy(
      allowedCapture || !/^\s*set\s+\+e(?:\s|$)/m.test(run),
      `${path} step ${index} contains failure masking through set +e`,
    );
  }
}

function findNamedStep(job, name, path) {
  const matches = job.steps.filter((step) => step.name === name);
  requirePolicy(
    matches.length === 1,
    `${path} must contain exactly one ${name} step`,
  );
  return matches[0];
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((nestedKey) => [nestedKey, canonicalize(value[nestedKey])]),
    );
  }
  return value;
}

function requiredJobDigest(workflow, job) {
  const projection = canonicalize({
    env: workflow.env ?? null,
    defaults: workflow.defaults ?? null,
    job,
  });
  return createHash("sha256")
    .update(JSON.stringify(projection), "utf8")
    .digest("hex");
}

function privilegedWorkflowDigest(workflow, jobs, jobIds) {
  const privilegedJobs = Object.fromEntries(
    jobIds.map((jobId) => [
      jobId,
      plainObject(jobs[jobId], `privileged job ${jobId}`),
    ]),
  );
  const projection = canonicalize({
    name: workflow.name,
    on: workflow.on,
    permissions: workflow.permissions,
    env: workflow.env ?? null,
    defaults: workflow.defaults ?? null,
    concurrency: workflow.concurrency ?? null,
    jobs: privilegedJobs,
  });
  return createHash("sha256")
    .update(JSON.stringify(projection), "utf8")
    .digest("hex");
}

function standalonePrivilegedWorkflowDigest(workflow) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(workflow)), "utf8")
    .digest("hex");
}

function validateStandalonePrivilegedWorkflow(workflow, spec) {
  const jobs = plainObject(workflow.jobs, `${spec.path}.jobs`);
  exact(Object.keys(jobs), spec.jobIds, `${spec.path} job inventory`);
  for (const jobId of spec.jobIds) {
    const job = plainObject(jobs[jobId], `${spec.path}.jobs.${jobId}`);
    requirePolicy(
      Array.isArray(job.steps),
      `${spec.path}.jobs.${jobId} steps are missing`,
    );
    rejectKey(job, "continue-on-error", `${spec.path}.jobs.${jobId}`);
    rejectFailureMasking(job, spec.path);
  }
  exact(
    standalonePrivilegedWorkflowDigest(workflow),
    spec.digest,
    `${spec.path} canonical standalone privileged-workflow digest`,
  );
}

function validateWorkflow(workflow, spec) {
  exact(workflow.name, spec.workflowName, `${spec.path} workflow name`);
  exact(workflow.permissions, {}, `${spec.path} workflow permissions`);
  const events = plainObject(workflow.on, `${spec.path}.on`);
  exact(Object.keys(events), spec.eventIds, `${spec.path} event inventory`);
  if (Object.hasOwn(spec, "workflowCall")) {
    exact(
      events.workflow_call,
      spec.workflowCall,
      `${spec.path} workflow_call contract`,
    );
  }
  exact(
    events.pull_request,
    spec.pullRequest,
    `${spec.path} pull_request trigger`,
  );
  exact(
    events.merge_group,
    { types: ["checks_requested"] },
    `${spec.path} merge_group trigger`,
  );
  const jobs = plainObject(workflow.jobs, `${spec.path}.jobs`);
  exact(Object.keys(jobs), spec.jobIds, `${spec.path} job inventory`);
  const job = plainObject(jobs[spec.jobId], `${spec.path}.jobs.${spec.jobId}`);
  exact(job.name, spec.jobName, `${spec.path} required job name`);
  if (spec.jobIf === undefined) {
    requirePolicy(
      job.if === undefined,
      `${spec.path} required job condition (if) must be absent`,
    );
  } else {
    exact(job.if, spec.jobIf, `${spec.path} required job condition (if)`);
  }
  requirePolicy(
    Array.isArray(job.steps),
    `${spec.path} required job steps are missing`,
  );
  rejectKey(job, "continue-on-error", `${spec.path}.jobs.${spec.jobId}`);
  rejectFailureMasking(job, spec.path);

  exact(
    workflow.env?.NODE_OPTIONS,
    spec.nodeOptions,
    `${spec.path} NODE_OPTIONS`,
  );
  requirePolicy(
    job.env?.NODE_OPTIONS === undefined,
    `${spec.path} job NODE_OPTIONS must be absent`,
  );
  for (const [index, step] of job.steps.entries()) {
    requirePolicy(
      step.env?.NODE_OPTIONS === undefined,
      `${spec.path} step ${index} NODE_OPTIONS must be absent`,
    );
  }

  if (spec.policyRunner) {
    const tests = findNamedStep(job, POLICY_TEST_STEP_NAME, spec.path);
    exact(tests.run?.trim(), POLICY_TEST_COMMAND, `${spec.path} policy tests`);
    const invocation = findNamedStep(job, POLICY_STEP_NAME, spec.path);
    exact(
      invocation.run?.trim(),
      POLICY_COMMAND,
      `${spec.path} policy invocation`,
    );
  }

  exact(
    requiredJobDigest(workflow, job),
    spec.digest,
    `${spec.path} canonical required-job digest`,
  );
  if (spec.privilegedJobIds !== undefined) {
    exact(
      privilegedWorkflowDigest(workflow, jobs, spec.privilegedJobIds),
      spec.privilegedDigest,
      `${spec.path} canonical privileged-DAG digest`,
    );
  }
  return spec.contexts;
}

function validateZizmorConfig(config) {
  exact(
    config,
    {
      rules: {
        "dependabot-cooldown": {
          config: { days: 7 },
        },
      },
    },
    "Zizmor configuration",
  );
}

function validateRelayConfig(source) {
  requirePolicy(
    typeof source === "string",
    `${RELAY_CONFIG_PATH} source is missing`,
  );
  let config;
  try {
    config = JSON.parse(source.replace(/,\s*([}\]])/gu, "$1"));
  } catch (error) {
    fail(`${RELAY_CONFIG_PATH} JSONC is invalid: ${error.message}`);
  }
  plainObject(config, RELAY_CONFIG_PATH);
  exact(
    config.vars,
    { SLACK_RELAY_SIGNING_ACTIVE_SLOT: "next" },
    `${RELAY_CONFIG_PATH} relay signer selection`,
  );
  exact(
    config.placement,
    { mode: "smart" },
    `${RELAY_CONFIG_PATH} D1 placement`,
  );
  const bindings = config.secrets_store_secrets;
  requirePolicy(
    Array.isArray(bindings),
    `${RELAY_CONFIG_PATH} Secrets Store bindings are missing`,
  );
  const relayBindings = bindings
    .filter(({ binding }) => binding.startsWith("SLACK_RELAY_SIGNING_SECRET"))
    .map(({ binding, secret_name: secretName }) => [binding, secretName]);
  exact(
    relayBindings,
    [
      ["SLACK_RELAY_SIGNING_SECRET", "github-slack-relay-signing-secret"],
      [
        "SLACK_RELAY_SIGNING_SECRET_NEXT",
        "github-slack-relay-signing-secret-next",
      ],
    ],
    `${RELAY_CONFIG_PATH} relay verifier bindings`,
  );
}

export async function readRequiredContextSources(
  repositoryRoot = new URL("../", import.meta.url),
) {
  const entries = await Promise.all(
    ALL_SOURCE_PATHS.map(async (path) => [
      path,
      await readFile(new URL(path, repositoryRoot), "utf8"),
    ]),
  );
  return Object.fromEntries(entries);
}

export function validateRequiredContextPolicy(sources) {
  const parsed = Object.fromEntries(
    YAML_SOURCE_PATHS.map((path) => [path, parseYaml(sources[path], path)]),
  );
  const contexts = WORKFLOW_SPECS.flatMap((spec) =>
    validateWorkflow(parsed[spec.path], spec),
  );
  for (const spec of STANDALONE_PRIVILEGED_WORKFLOW_SPECS) {
    validateStandalonePrivilegedWorkflow(parsed[spec.path], spec);
  }
  validateZizmorConfig(parsed[ZIZMOR_CONFIG_PATH]);
  validateRelayConfig(sources[RELAY_CONFIG_PATH]);
  exact(
    contexts,
    [
      "Dependency Review",
      "Analyze actions",
      "Analyze javascript-typescript",
      "Run zizmor",
      "Build Pages artifact",
      "Verify GitHub Slack relay",
      "Verify Slack workflow app",
    ],
    "required context inventory",
  );
  return Object.freeze(contexts);
}

const invokedPath = process.argv[1];
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  const contexts = validateRequiredContextPolicy(
    await readRequiredContextSources(),
  );
  console.log(
    `Validated ${contexts.length} required context contracts: ${contexts.join(", ")}`,
  );
}
