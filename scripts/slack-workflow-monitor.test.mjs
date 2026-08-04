import test from "node:test";
import assert from "node:assert/strict";

import {
  monitorSlackWorkflow,
  readSlackMonitorConfiguration,
} from "./slack-workflow-monitor.mjs";

const environment = Object.freeze({
  SLACK_APP_ID: "A12345",
  SLACK_SERVICE_TOKEN: "service-token-never-log",
  SLACK_TEAM_ID: "T12345",
});

function slackResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("configuration rejects every absent required value", () => {
  for (const name of Object.keys(environment)) {
    const candidate = { ...environment };
    delete candidate[name];
    assert.throws(
      () => readSlackMonitorConfiguration(candidate),
      new RegExp(`Required environment variable ${name} is missing`),
    );
  }
});

test("monitor uses the documented form encoding and reports no errors", async () => {
  const now = Date.parse("2026-08-04T08:00:00.000Z");
  let observed = false;
  const result = await monitorSlackWorkflow({
    environment,
    now: () => now,
    fetchImpl: async (input, init) => {
      observed = true;
      assert.equal(input, "https://slack.com/api/apps.activities.list");
      assert.equal(init.method, "POST");
      assert.equal(
        init.headers.Authorization,
        `Bearer ${environment.SLACK_SERVICE_TOKEN}`,
      );
      assert.equal(
        init.headers["Content-Type"],
        "application/x-www-form-urlencoded; charset=utf-8",
      );
      assert.ok(init.body instanceof URLSearchParams);
      assert.deepEqual(Object.fromEntries(init.body), {
        app_id: environment.SLACK_APP_ID,
        team_id: environment.SLACK_TEAM_ID,
        min_log_level: "error",
        min_date_created: String((now - 20 * 60 * 1000) * 1000),
        limit: "100",
      });
      assert.ok(init.signal instanceof AbortSignal);
      return slackResponse({ ok: true, activities: [] });
    },
  });

  assert.equal(observed, true);
  assert.deepEqual(result, { errors: 0 });
});

test("Slack errors expose only a validated code, never response payloads or credentials", async () => {
  await assert.rejects(
    monitorSlackWorkflow({
      environment,
      fetchImpl: async () =>
        slackResponse({
          ok: false,
          error: "invalid_args",
          activities: [{ payload: { inputs: "private-value" } }],
        }),
    }),
    (error) =>
      /invalid_args/.test(error.message) &&
      !/private-value/.test(error.message) &&
      !error.message.includes(environment.SLACK_SERVICE_TOKEN),
  );

  await assert.rejects(
    monitorSlackWorkflow({
      environment,
      fetchImpl: async () =>
        slackResponse({ ok: false, error: "unsafe value\nsecret-data" }),
    }),
    (error) =>
      /unrecognized error code/.test(error.message) &&
      !/unsafe|secret-data/.test(error.message),
  );
});

test("recorded workflow errors fail without exposing activity payloads", async () => {
  await assert.rejects(
    monitorSlackWorkflow({
      environment,
      fetchImpl: async () =>
        slackResponse({
          ok: true,
          activities: [{ payload: { inputs: "private-value" } }],
        }),
    }),
    (error) =>
      /recorded 1 workflow error/.test(error.message) &&
      !/private-value/.test(error.message),
  );
});

test("malformed and HTTP failures remain fail-closed without echoing bodies", async () => {
  await assert.rejects(
    monitorSlackWorkflow({
      environment,
      fetchImpl: async () =>
        new Response("private upstream body", {
          status: 503,
          headers: { "retry-after": "30" },
        }),
    }),
    (error) =>
      /HTTP 503/.test(error.message) &&
      /retry-after=30s/.test(error.message) &&
      !/private upstream body/.test(error.message),
  );

  await assert.rejects(
    monitorSlackWorkflow({
      environment,
      fetchImpl: async () => new Response("private invalid JSON"),
    }),
    (error) =>
      /invalid JSON/.test(error.message) &&
      !/private invalid JSON/.test(error.message),
  );
});
