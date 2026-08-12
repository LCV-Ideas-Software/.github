import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { parseDocument } from "yaml";

import {
  API_VERSION,
  GitHubApiError,
  HOOK_EVENTS,
  WEBHOOK_URL,
  auditOrganizationWebhook,
  parseNextHookPage,
  readConfiguration,
} from "./github-slack-hook-audit.mjs";

const TEST_TOKEN = "test-token-never-log";
const BASE_ENVIRONMENT = Object.freeze({
  TOKEN: TEST_TOKEN,
  HOOK_ID: "12345",
  GITHUB_REF: "refs/heads/main",
  ORGANIZATION_NAME: "example-org",
  WORKFLOW_REPO_OWNER: "example-org",
  WORKFLOW_REPO_NAME: ".github",
});
const REDELIVERY_WORKFLOW_URL = new URL(
  "../.github/workflows/github-slack-webhook-redelivery.yml",
  import.meta.url,
);
const WORKFLOWS_DIRECTORY_URL = new URL(
  "../.github/workflows/",
  import.meta.url,
);
const RELAY_WORKFLOW_URL = new URL(
  "../.github/workflows/github-slack-integration.yml",
  import.meta.url,
);
const REMOVED_MANAGEMENT_WORKFLOW_URL = new URL(
  "../.github/workflows/github-slack-hook-management.yml",
  import.meta.url,
);
const AUDITOR_URL = new URL("./github-slack-hook-audit.mjs", import.meta.url);
const INTEGRATION_DOC_URL = new URL(
  "../docs/GITHUB_SLACK_INTEGRATION.md",
  import.meta.url,
);
const RELAY_README_URL = new URL(
  "../workers/github-slack-relay/README.md",
  import.meta.url,
);
const SECURITY_POLICY_URL = new URL("../SECURITY.md", import.meta.url);
const CHANGELOG_URL = new URL("../CHANGELOG.md", import.meta.url);
const APP_TOKEN_ACTION =
  "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0";

function workflowStep(source, name) {
  const marker = `      - name: ${name}\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `workflow step not found: ${name}`);
  const next = source.indexOf("\n      - name:", start + marker.length);
  return source.slice(start, next === -1 ? source.length : next);
}

function assertRootPolicyDependenciesInstalled(source, testStepName) {
  const installName = "Install governance policy dependencies";
  const installMarker = `      - name: ${installName}\n`;
  assert.equal(
    source.split(installMarker).length - 1,
    1,
    `${installName} must appear exactly once`,
  );
  const install = workflowStep(source, installName);
  assert.match(
    install,
    /run: \|\n          test "\$\(npm config get registry\)" = "https:\/\/registry\.npmjs\.org\/"\n          npm ci --ignore-scripts --no-audit --no-fund\n/u,
  );
  assert.ok(
    source.indexOf(installMarker) <
      source.indexOf(`      - name: ${testStepName}\n`),
    `${installName} must run before ${testStepName}`,
  );
}

async function workflowSources() {
  const names = (await readdir(WORKFLOWS_DIRECTORY_URL))
    .filter((name) => /\.ya?ml$/u.test(name))
    .sort();
  return new Map(
    await Promise.all(
      names.map(async (name) => [
        name,
        await readFile(new URL(name, WORKFLOWS_DIRECTORY_URL), "utf8"),
      ]),
    ),
  );
}

function assertRecoveryEnvironmentIsolation(workflows) {
  const environmentDeclarations = [];
  const credentialReferences = [];
  const parsedWorkflows = new Map();
  for (const [name, source] of workflows) {
    const document = parseDocument(source, {
      prettyErrors: true,
      schema: "core",
      uniqueKeys: true,
    });
    assert.deepEqual(document.errors, [], `${name} must be valid YAML`);
    assert.deepEqual(document.warnings, [], `${name} must be unambiguous YAML`);
    const workflow = document.toJS({ maxAliasCount: 0 });
    assert.equal(
      workflow !== null &&
        typeof workflow === "object" &&
        !Array.isArray(workflow),
      true,
      `${name} must contain a workflow mapping`,
    );
    assert.equal(
      workflow.jobs !== null &&
        typeof workflow.jobs === "object" &&
        !Array.isArray(workflow.jobs),
      true,
      `${name} must contain a jobs mapping`,
    );
    parsedWorkflows.set(name, workflow);
    const serializedWorkflowEnvironment = JSON.stringify(workflow.env ?? {});
    for (const credential of [
      "SLACK_REDELIVERY_APP_CLIENT_ID",
      "SLACK_REDELIVERY_APP_PRIVATE_KEY",
    ]) {
      assert.equal(
        serializedWorkflowEnvironment.includes(credential),
        false,
        `${name} must not expose ${credential} through workflow-level env`,
      );
    }
    for (const [jobId, job] of Object.entries(workflow.jobs)) {
      assert.equal(
        job !== null && typeof job === "object" && !Array.isArray(job),
        true,
        `${name}.${jobId} must contain a job mapping`,
      );
      if (job.environment !== undefined) {
        const environmentName =
          typeof job.environment === "string"
            ? job.environment
            : job.environment?.name;
        assert.match(
          environmentName ?? "",
          /^[a-z0-9-]+$/u,
          `${name}.${jobId} must use a literal approved environment name`,
        );
        environmentDeclarations.push([name, jobId, environmentName]);
      }
      const serializedJob = JSON.stringify(job);
      for (const credential of [
        "SLACK_REDELIVERY_APP_CLIENT_ID",
        "SLACK_REDELIVERY_APP_PRIVATE_KEY",
      ]) {
        if (serializedJob.includes(credential)) {
          credentialReferences.push([name, jobId, credential]);
        }
      }
    }
  }
  assert.deepEqual(environmentDeclarations, [
    ["cloudflare-pages.yml", "deploy", "cloudflare-production"],
    ["github-slack-integration.yml", "deploy", "cloudflare-production"],
    ["github-slack-integration.yml", "deploy_slack", "slack-production"],
    ["github-slack-webhook-redelivery.yml", "redeliver", "webhook-recovery"],
    ["pages.yml", "deploy", "github-pages"],
    ["slack-d1-disposable-reaper.yml", "reap", "cloudflare-production"],
    ["slack-github-integration.yml", "monitor", "slack-production"],
  ]);
  assert.deepEqual(credentialReferences, [
    [
      "github-slack-webhook-redelivery.yml",
      "redeliver",
      "SLACK_REDELIVERY_APP_CLIENT_ID",
    ],
    [
      "github-slack-webhook-redelivery.yml",
      "redeliver",
      "SLACK_REDELIVERY_APP_PRIVATE_KEY",
    ],
  ]);

  const redelivery = parsedWorkflows.get("github-slack-webhook-redelivery.yml");
  assert.deepEqual(Object.keys(redelivery.jobs), ["redeliver"]);
  assert.equal(redelivery.jobs.redeliver.environment, "webhook-recovery");
}

function responseJson(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function hook({
  id = 12345,
  active = true,
  url = WEBHOOK_URL,
  events = [...HOOK_EVENTS],
  name = "web",
  contentType = "json",
  insecureSsl = "0",
} = {}) {
  return {
    id,
    active,
    name,
    events,
    config: {
      url,
      content_type: contentType,
      insecure_ssl: insecureSsl,
    },
  };
}

function requestSnapshot(input, init) {
  const url = new URL(input);
  assert.equal(init.method, "GET");
  assert.equal(init.body, undefined);
  assert.equal(init.redirect, "error");
  assert.equal(init.headers.Authorization, `Bearer ${TEST_TOKEN}`);
  assert.equal(init.headers["X-GitHub-Api-Version"], API_VERSION);
  assert.equal(init.headers.Accept, "application/vnd.github+json");
  assert.ok(init.signal instanceof AbortSignal);
  return { pathname: url.pathname, search: url.search };
}

test("the organization webhook audit contract is exact", () => {
  assert.equal(API_VERSION, "2026-03-10");
  assert.equal(
    WEBHOOK_URL,
    "https://github-slack-alerts.lcv.workers.dev/github/webhook",
  );
  assert.deepEqual(HOOK_EVENTS, [
    "workflow_run",
    "deployment_status",
    "dependabot_alert",
    "code_scanning_alert",
    "secret_scanning_alert",
    "push",
    "pull_request",
    "pull_request_review",
    "pull_request_review_comment",
    "issues",
    "issue_comment",
    "release",
    "discussion",
    "discussion_comment",
  ]);
  assert.equal(new Set(HOOK_EVENTS).size, 14);
  assert.equal(Object.isFrozen(HOOK_EVENTS), true);
});

test("Actions exposes no organization webhook mutation workflow", async () => {
  await assert.rejects(access(REMOVED_MANAGEMENT_WORKFLOW_URL), {
    code: "ENOENT",
  });

  const [redelivery, relay, auditor, workflows] = await Promise.all([
    readFile(REDELIVERY_WORKFLOW_URL, "utf8"),
    readFile(RELAY_WORKFLOW_URL, "utf8"),
    readFile(AUDITOR_URL, "utf8"),
    workflowSources(),
  ]);
  assertRootPolicyDependenciesInstalled(
    redelivery,
    "Test webhook liveness and redelivery controllers",
  );
  assertRootPolicyDependenciesInstalled(
    relay,
    "Test organization webhook audit and recovery controllers",
  );
  assert.match(redelivery, /^permissions: \{\}$/m);
  assert.match(
    redelivery,
    /jobs:\n  redeliver:\n    name: Redeliver failed organization webhook deliveries/,
  );
  assertRecoveryEnvironmentIsolation(workflows);
  for (const rogueSource of [
    "jobs:\n  rogue:\n    environment: webhook-recovery\n",
    "jobs:\n  rogue:\n    environment: ${{ vars.RECOVERY_ENVIRONMENT }}\n",
    "jobs:\n  rogue:\n    env:\n      KEY: ${{ secrets.SLACK_REDELIVERY_APP_PRIVATE_KEY }}\n",
    "jobs:\n  rogue:\n    env:\n      CLIENT: ${{ vars.SLACK_REDELIVERY_APP_CLIENT_ID }}\n",
    "jobs: { rogue: { runs-on: ubuntu-latest, environment: webhook-recovery, steps: [] } }\n",
    'jobs: { rogue: { runs-on: ubuntu-latest, environment: "${{ vars.RECOVERY_ENVIRONMENT }}", steps: [] } }\n',
    "env:\n  PRIVATE_KEY: ${{ secrets.SLACK_REDELIVERY_APP_PRIVATE_KEY }}\njobs:\n  rogue:\n    runs-on: ubuntu-latest\n    steps: []\n",
    'env: { CLIENT_ID: "${{ vars.SLACK_REDELIVERY_APP_CLIENT_ID }}" }\njobs: { rogue: { runs-on: ubuntu-latest, steps: [] } }\n',
  ]) {
    const mutant = new Map(workflows);
    mutant.set("rogue.yml", rogueSource);
    assert.throws(() => assertRecoveryEnvironmentIsolation(mutant));
  }
  const extraJob = new Map(workflows);
  extraJob.set(
    "github-slack-webhook-redelivery.yml",
    `${redelivery}\n  rogue:\n    runs-on: ubuntu-latest\n    environment: webhook-recovery\n`,
  );
  assert.throws(
    () => assertRecoveryEnvironmentIsolation(extraJob),
    /Expected values to be strictly deep-equal/,
  );
  assert.match(
    redelivery,
    /permissions:\n      actions: read # Read the last successful schedule used as the continuity checkpoint\.\n      contents: read/,
  );
  assert.match(redelivery, /github-slack-hook-audit\.mjs/);
  assert.match(redelivery, /default: audit/);
  assert.match(
    redelivery,
    /github\.event_name == 'workflow_dispatch' \|\|\s+vars\.SLACK_GITHUB_INTEGRATION_ENABLED == 'true'/,
  );
  assert.match(
    redelivery,
    /inputs\.operation == 'redeliver'[\s\S]*SLACK_GITHUB_INTEGRATION_ENABLED=true/,
  );
  const auditToken = workflowStep(
    redelivery,
    "Mint read-only GitHub App token for audit",
  );
  const validation = workflowStep(
    redelivery,
    "Validate required configuration",
  );
  const recoveryToken = workflowStep(
    redelivery,
    "Mint least-privilege GitHub App token for recovery",
  );
  const audit = workflowStep(
    redelivery,
    "Audit active App-visible organization webhook without mutation",
  );
  const identity = workflowStep(
    redelivery,
    "Validate exact GitHub App identity",
  );
  const recovery = workflowStep(
    redelivery,
    "Recover failed webhook deliveries",
  );

  assert.equal(redelivery.split(APP_TOKEN_ACTION).length - 1, 2);
  assert.match(
    validation,
    /APP_CLIENT_ID: \$\{\{ vars\.SLACK_REDELIVERY_APP_CLIENT_ID \}\}/,
  );
  assert.doesNotMatch(validation, /APP_PRIVATE_KEY/);
  assert.equal(
    redelivery.split("secrets.SLACK_REDELIVERY_APP_PRIVATE_KEY").length - 1,
    2,
  );
  for (const step of [auditToken, recoveryToken]) {
    assert.ok(step.includes(`uses: ${APP_TOKEN_ACTION}`));
    assert.match(
      step,
      /client-id: \$\{\{ vars\.SLACK_REDELIVERY_APP_CLIENT_ID \}\}/,
    );
    assert.match(
      step,
      /private-key: \$\{\{ secrets\.SLACK_REDELIVERY_APP_PRIVATE_KEY \}\}/,
    );
    assert.match(step, /owner: \$\{\{ github\.repository_owner \}\}/);
    assert.match(
      step,
      /repositories: \$\{\{ github\.event\.repository\.name \}\}/,
    );
    assert.match(step, /skip-token-revoke: false/);
    assert.doesNotMatch(step, /app-id:/);
  }
  assert.match(auditToken, /permission-organization-hooks: read/);
  assert.doesNotMatch(auditToken, /permission-variables:/);
  assert.match(recoveryToken, /permission-organization-hooks: write/);
  assert.doesNotMatch(recoveryToken, /permission-variables:/);
  assert.match(
    identity,
    /APP_SLUG: \$\{\{ steps\.audit-app-token\.outputs\.app-slug \|\| steps\.recovery-app-token\.outputs\.app-slug \}\}/,
  );
  assert.match(
    identity,
    /INSTALLATION_ID: \$\{\{ steps\.audit-app-token\.outputs\.installation-id \|\| steps\.recovery-app-token\.outputs\.installation-id \}\}/,
  );
  assert.match(identity, /lcv-slack-webhook-recovery/);
  assert.match(identity, /\^\[1-9\]\[0-9\]\*\$/);
  assert.match(
    audit,
    /TOKEN: \$\{\{ steps\.audit-app-token\.outputs\.token \|\| steps\.recovery-app-token\.outputs\.token \}\}/,
  );
  assert.match(
    recovery,
    /HOOK_TOKEN: \$\{\{ steps\.recovery-app-token\.outputs\.token \}\}/,
  );
  assert.match(recovery, /ACTIONS_TOKEN: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(
    redelivery,
    /LCV_AUTOMATION_TOKEN|admin:org_hook|permission-organization-hooks: admin|permission-variables:/,
  );
  assert.doesNotMatch(redelivery, /OPERATION|WEBHOOK_SECRET|hook-management/);
  assert.doesNotMatch(auditor, /method:\s*"(?:POST|PUT|PATCH|DELETE)"/);
  assert.doesNotMatch(
    auditor,
    /WEBHOOK_SECRET|SLACK_RELAY_GITHUB_WEBHOOK_SECRET/,
  );
  assert.match(relay, /--tag "\$GITHUB_SHA"/);
  assert.match(
    relay,
    /--message "GitHub Actions \$\{GITHUB_REPOSITORY\}@\$\{GITHUB_SHA\}"/,
  );
});

test("recovery documentation states exact token grants and control-flow boundary", async () => {
  const [integrationDocs, relayReadme, securityPolicy, changelog] =
    await Promise.all([
      readFile(INTEGRATION_DOC_URL, "utf8"),
      readFile(RELAY_README_URL, "utf8"),
      readFile(SECURITY_POLICY_URL, "utf8"),
      readFile(CHANGELOG_URL, "utf8"),
    ]);

  for (const documentation of [integrationDocs, relayReadme]) {
    assert.match(
      documentation,
      /built-in `GITHUB_TOKEN`[^.]*`actions: read`[^.]*`contents: read`/,
    );
    assert.doesNotMatch(
      documentation,
      /Before any hook read|Before reading the hook/,
    );
    assert.match(
      documentation,
      /protected\s+`webhook-recovery` environment provides[\s\S]*`SLACK_REDELIVERY_APP_CLIENT_ID`[\s\S]*`SLACK_REDELIVERY_APP_PRIVATE_KEY`/,
    );
    const compactDocumentation = documentation.replaceAll(/\s+/gu, " ");
    assert.doesNotMatch(
      compactDocumentation,
      /(?:`cloudflare-production`.{0,240}`SLACK_REDELIVERY_APP_(?:CLIENT_ID|PRIVATE_KEY)`|`SLACK_REDELIVERY_APP_(?:CLIENT_ID|PRIVATE_KEY)`.{0,240}`cloudflare-production`)/u,
    );
  }

  assert.match(
    changelog,
    /At the snapshot that opened #169,[\s\S]*This repository has since moved the pair into the protected\n  environment and removed the repository-level copies\./u,
  );
  assert.match(
    changelog,
    /At the snapshot that opened #175,[\s\S]*rollback copies remain temporarily in the old environment until the exact-`main` canaries pass/u,
  );
  assert.doesNotMatch(
    changelog,
    /### Known issues[\s\S]*`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` are repository-scoped/u,
  );
  assert.match(integrationDocs, /Before the controller's delivery scan/);
  assert.match(relayReadme, /Before scanning deliveries/);
  assert.match(
    securityPolicy,
    /`SLACK_REDELIVERY_APP_PRIVATE_KEY`[^.]*`webhook-recovery`/,
  );
  assert.match(
    securityPolicy,
    /`cloudflare-production`[^.]*`CLOUDFLARE_API_TOKEN`/,
  );
  assert.match(
    securityPolicy,
    /Outside that reviewed HMAC transition,[\s\S]*migration artifacts and must be removed before[\s\S]*#175/u,
  );
  assert.match(
    securityPolicy,
    /same newly generated signer[\s\S]*`slack-production` and `cloudflare-production`[\s\S]*runtime `NEXT` slots/u,
  );
  assert.match(securityPolicy, /`github-dotgithub-production`/u);
  for (const permission of [
    "Pages Write",
    "Workers Scripts Write",
    "D1 Write",
    "Secrets Store Write",
  ]) {
    assert.ok(securityPolicy.includes(`\`${permission}\``));
  }
  assert.doesNotMatch(securityPolicy, /`Queues Write`/);
  assert.doesNotMatch(
    securityPolicy,
    /external credential isolation is \*\*partial today\*\*|SLACK_REDELIVERY_APP_PRIVATE_KEY` in `cloudflare-production`|Cloudflare deployment credentials are not in an environment/,
  );
});

test("configuration fails closed before API access", () => {
  for (const name of Object.keys(BASE_ENVIRONMENT)) {
    const environment = { ...BASE_ENVIRONMENT };
    delete environment[name];
    assert.throws(
      () => readConfiguration(environment),
      new RegExp(`Required environment variable ${name} is missing`),
      name,
    );
  }
  assert.throws(
    () => readConfiguration({ ...BASE_ENVIRONMENT, TOKEN: ` ${TEST_TOKEN}` }),
    /surrounding whitespace/,
  );
  assert.throws(
    () => readConfiguration({ ...BASE_ENVIRONMENT, HOOK_ID: "1e3" }),
    /positive integer/,
  );
  assert.throws(
    () =>
      readConfiguration({ ...BASE_ENVIRONMENT, GITHUB_REF: "refs/heads/x" }),
    /restricted to main/,
  );
  assert.throws(
    () =>
      readConfiguration({
        ...BASE_ENVIRONMENT,
        WORKFLOW_REPO_OWNER: "other-org",
      }),
    /must match/,
  );
  assert.throws(
    () => readConfiguration({ ...BASE_ENVIRONMENT, WORKFLOW_REPO_NAME: "app" }),
    /restricted to \.github/,
  );
});

test("pagination accepts only the exact GitHub organization hooks endpoint", () => {
  const path = "/orgs/example-org/hooks";
  const next = parseNextHookPage(
    `<https://api.github.com${path}?per_page=100&page=2>; rel="next"`,
    path,
    2,
  );
  assert.equal(next?.searchParams.get("page"), "2");
  assert.throws(
    () =>
      parseNextHookPage(
        `<https://example.test${path}?per_page=100&page=2>; rel="next"`,
        path,
        2,
      ),
    /outside the expected/,
  );
  assert.throws(
    () =>
      parseNextHookPage(
        `<https://api.github.com${path}?per_page=50&page=2>; rel="next"`,
        path,
        2,
      ),
    /invalid page size/,
  );
  for (const query of [
    "per_page=100&per_page=50&page=2",
    "per_page=100&page=2&page=3",
    "per_page=100&page=2&unexpected=true",
    "per_page=100&page=02",
  ]) {
    assert.throws(
      () =>
        parseNextHookPage(
          `<https://api.github.com${path}?${query}>; rel="next"`,
          path,
          2,
        ),
      /invalid|unexpected/,
    );
  }
  assert.throws(
    () =>
      parseNextHookPage(
        `<https://api.github.com${path}?per_page=100&page=3>; rel="next"`,
        path,
        2,
      ),
    /non-contiguous/,
  );
  assert.throws(
    () =>
      parseNextHookPage(
        `<https://api.github.com${path}?per_page=100&page=2>; rel="next", <https://api.github.com${path}?per_page=100&page=3>; rel="next"`,
        path,
        2,
      ),
    /multiple next-page/,
  );
  assert.equal(next?.href, `https://api.github.com${path}?per_page=100&page=2`);
});

test("audit proves one exact active hook through GET-only list and detail reads", async () => {
  const requests = [];
  const messages = [];
  const result = await auditOrganizationWebhook({
    environment: { ...BASE_ENVIRONMENT },
    fetchImpl: async (input, init) => {
      const request = requestSnapshot(input, init);
      requests.push(request);
      if (request.pathname === "/orgs/example-org/hooks") {
        return responseJson([hook()]);
      }
      if (request.pathname === "/orgs/example-org/hooks/12345") {
        return responseJson(hook());
      }
      throw new Error(`Unexpected GET ${request.pathname}`);
    },
    logger: { info: (message) => messages.push(message) },
  });

  assert.deepEqual(result, { hookId: "12345", active: true });
  assert.deepEqual(
    requests.map(({ pathname }) => pathname),
    ["/orgs/example-org/hooks", "/orgs/example-org/hooks/12345"],
  );
  assert.equal(messages.length, 1);
  assert.doesNotMatch(messages[0], new RegExp(TEST_TOKEN));
});

test("audit paginates and rejects absence, duplicates, ID drift, and configuration drift", async () => {
  const scenarios = [
    { list: [], error: /found 0/ },
    { list: [hook(), hook({ id: 12346 })], error: /found 2/ },
    { list: [hook({ id: 12346 })], error: /does not match configured HOOK_ID/ },
    { list: [hook({ active: false })], error: /is not active/ },
    {
      list: [hook({ events: HOOK_EVENTS.slice(1) })],
      error: /does not exactly match/,
    },
    {
      list: [hook({ url: "https://example.test" })],
      error: /does not exactly match/,
    },
  ];

  for (const scenario of scenarios) {
    await assert.rejects(
      auditOrganizationWebhook({
        environment: { ...BASE_ENVIRONMENT },
        fetchImpl: async (input, init) => {
          requestSnapshot(input, init);
          return responseJson(scenario.list);
        },
        logger: { info() {} },
      }),
      scenario.error,
    );
  }

  let page = 0;
  await assert.rejects(
    auditOrganizationWebhook({
      environment: { ...BASE_ENVIRONMENT },
      fetchImpl: async (input, init) => {
        const request = requestSnapshot(input, init);
        if (request.pathname.endsWith("/12345")) return responseJson(hook());
        page += 1;
        if (page === 1) {
          return responseJson([], {
            headers: {
              link: '<https://api.github.com/orgs/example-org/hooks?per_page=100&page=2>; rel="next"',
            },
          });
        }
        return responseJson([hook(), hook()]);
      },
      logger: { info() {} },
    }),
    /duplicate organization webhook/,
  );
});

test("404 and timeout diagnostics retain request metadata without leaking credentials", async () => {
  await assert.rejects(
    auditOrganizationWebhook({
      environment: { ...BASE_ENVIRONMENT },
      fetchImpl: async () =>
        responseJson(
          { message: `do not render ${TEST_TOKEN}` },
          {
            status: 404,
            headers: {
              "x-github-request-id": "request-scope",
            },
          },
        ),
      logger: { info() {} },
    }),
    (error) =>
      error instanceof GitHubApiError &&
      /request-id=request-scope/.test(error.message) &&
      !/admin:org_hook/.test(error.message) &&
      !error.message.includes(TEST_TOKEN),
  );

  await assert.rejects(
    auditOrganizationWebhook({
      environment: { ...BASE_ENVIRONMENT },
      fetchImpl: async (_url, init) => {
        assert.ok(init.signal instanceof AbortSignal);
        throw new DOMException("request timed out", "TimeoutError");
      },
      logger: { info() {} },
    }),
    (error) =>
      /timed out after 30000ms/.test(error.message) &&
      !error.message.includes(TEST_TOKEN),
  );
});
