import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

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
const APP_TOKEN_ACTION =
  "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0";

function workflowStep(source, name) {
  const marker = `      - name: ${name}\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `workflow step not found: ${name}`);
  const next = source.indexOf("\n      - name:", start + marker.length);
  return source.slice(start, next === -1 ? source.length : next);
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

  const [redelivery, relay, auditor] = await Promise.all([
    readFile(REDELIVERY_WORKFLOW_URL, "utf8"),
    readFile(RELAY_WORKFLOW_URL, "utf8"),
    readFile(AUDITOR_URL, "utf8"),
  ]);
  assert.match(redelivery, /^permissions: \{\}$/m);
  assert.match(
    redelivery,
    /jobs:\n  redeliver:\n    name: Redeliver failed organization webhook deliveries/,
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
  const [integrationDocs, relayReadme] = await Promise.all([
    readFile(INTEGRATION_DOC_URL, "utf8"),
    readFile(RELAY_README_URL, "utf8"),
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
  }
  assert.match(integrationDocs, /Before the controller's delivery scan/);
  assert.match(relayReadme, /Before scanning deliveries/);
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
