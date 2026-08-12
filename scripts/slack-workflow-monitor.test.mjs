import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  monitorSlackWorkflow,
  readSlackMonitorConfiguration,
  reconcileSlackActivities,
} from "./slack-workflow-monitor.mjs";

const manifestSource = await readFile(
  new URL("../slack/github-integration/manifest.ts", import.meta.url),
  "utf8",
);
const workflowSource = await readFile(
  new URL("../.github/workflows/slack-github-integration.yml", import.meta.url),
  "utf8",
);
const relayWorkflowSource = await readFile(
  new URL("../.github/workflows/github-slack-integration.yml", import.meta.url),
  "utf8",
);
const relayWranglerSource = await readFile(
  new URL("../workers/github-slack-relay/wrangler.jsonc", import.meta.url),
  "utf8",
);

const environment = Object.freeze({
  SLACK_APP_ID: "A12345",
  SLACK_RELAY_SIGNING_SECRET: "monitor-test-only-relay-signing-secret",
  SLACK_SERVICE_TOKEN: "service-token-never-log",
  SLACK_TEAM_ID: "T12345",
});

const CHECKPOINT_URL =
  "https://github-slack-alerts.lcv.workers.dev/slack/reconciliation/checkpoint";
const RECONCILIATION_URL =
  "https://github-slack-alerts.lcv.workers.dev/slack/reconciliation";
const SLACK_URL = "https://slack.com/api/apps.activities.list";

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function hmac(canonical) {
  return createHmac("sha256", environment.SLACK_RELAY_SIGNING_SECRET)
    .update(canonical, "utf8")
    .digest("hex");
}

function signedProgressInputs(
  deliveryId,
  phase = "send_started",
  destination = "alerts",
  relayTimestamp = "1785830400",
) {
  return {
    delivery_id: deliveryId,
    destination,
    phase,
    relay_timestamp: relayTimestamp,
    progress_token: hmac(
      JSON.stringify([
        "slack_progress_authorization_v1",
        deliveryId,
        destination,
        relayTimestamp,
      ]),
    ),
  };
}

function signedValidatorInputs(
  deliveryId,
  destination = "alerts",
  relayTimestamp = "1785830400",
) {
  const inputs = {
    source: "github",
    severity: "high",
    repository: "LCV-Ideas-Software/.github",
    title: "test",
    details: "test",
    actor: "lcv-leo",
    branch: "main",
    url: "https://github.com/LCV-Ideas-Software/.github",
    occurred_at: "2026-08-04T08:00:00.000Z",
    delivery_id: deliveryId,
    event: "workflow_run",
    action: "completed",
    destination,
    relay_timestamp: relayTimestamp,
    expected_destination: destination,
  };
  return {
    ...inputs,
    relay_signature: hmac(
      JSON.stringify([
        inputs.source,
        inputs.severity,
        inputs.repository,
        inputs.title,
        inputs.details,
        inputs.actor,
        inputs.branch,
        inputs.url,
        inputs.occurred_at,
        inputs.delivery_id,
        inputs.event,
        inputs.action,
        inputs.destination,
        inputs.relay_timestamp,
      ]),
    ),
  };
}

function assertCheckpointRequest(init) {
  const body = JSON.parse(String(init.body));
  assert.equal(
    body.request_signature,
    hmac(
      JSON.stringify([
        "slack_activity_checkpoint_request_v1",
        body.request_timestamp,
      ]),
    ),
  );
}

function assertReconciliationRequest(init) {
  const body = JSON.parse(String(init.body));
  assert.equal(
    body.report_signature,
    hmac(
      JSON.stringify([
        "slack_activity_reconciliation_v1",
        body.checkpoint_us,
        body.report_timestamp,
        body.traces.map((trace) => [
          trace.trace_id,
          trace.delivery_id,
          trace.outcome,
          trace.send_boundary_reached,
          trace.pre_send_failure_proven,
          trace.started_at_us,
          trace.completed_at_us,
        ]),
      ]),
    ),
  );
  return body;
}

test("production manifest registers the receipt function and only the documented message scopes", () => {
  assert.match(
    manifestSource,
    /botScopes:\s*\["chat:write", "chat:write\.public", "channels:read"\]/,
  );
  assert.match(manifestSource, /ReportRelayProgressDefinition/);
  assert.match(
    manifestSource,
    /outgoingDomains:\s*\["github-slack-alerts\.lcv\.workers\.dev"\]/,
  );
  assert.doesNotMatch(manifestSource, /groups:(read|write)/);
  assert.doesNotMatch(
    workflowSource,
    /chat:write\\?\.public/,
    "the verifier must not reject Slack's manifest-required built-in scope",
  );
});

test("deployment verifies both protected triggers without logging their details", () => {
  assert.match(relayWorkflowSource, /SLACK_GITHUB_ACTIVITY_TRIGGER_ID/);
  assert.match(relayWorkflowSource, /SLACK_GITHUB_ALERT_TRIGGER_ID/);
  assert.match(relayWorkflowSource, /api workflows\.triggers\.list/);
  assert.ok(
    relayWorkflowSource.includes(
      `request_body="$(printf '{"app_id":"%s","limit":100}' "$SLACK_APP_ID")"`,
    ),
  );
  assert.match(relayWorkflowSource, /scripts\/verify_trigger_inventory\.ts/);
  assert.doesNotMatch(relayWorkflowSource, /slack trigger (?:list|info)/);
  assert.doesNotMatch(relayWorkflowSource, /trigger_output/);
  assert.match(relayWorkflowSource, /rm -f "\$inventory_error"/);
});

test("Slack deployment is serialized behind the exact successful relay rollout", () => {
  assert.doesNotMatch(workflowSource, /workflow_run:/);
  assert.doesNotMatch(workflowSource, /github\.event\.workflow_run/);
  assert.doesNotMatch(workflowSource, /^  deploy:/m);
  const deployJob = relayWorkflowSource.slice(
    relayWorkflowSource.indexOf("  deploy_slack:"),
  );
  const relayDeployJob = relayWorkflowSource.slice(
    relayWorkflowSource.indexOf("  deploy:"),
    relayWorkflowSource.indexOf("  deploy_slack:"),
  );
  assert.match(relayDeployJob, /needs: verify/);
  assert.match(deployJob, /needs: deploy/);
  assert.match(deployJob, /environment: slack-production/);
  assert.match(deployJob, /github\.event_name == 'push'/);
  assert.match(deployJob, /github\.event_name == 'workflow_dispatch'/);
  assert.match(deployJob, /github\.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(deployJob, /workflow_run/);
  assert.match(relayWorkflowSource, /- "slack\/github-integration\/\*\*"/);
  assert.match(
    relayWorkflowSource,
    /- "\.github\/workflows\/slack-github-integration\.yml"/,
  );
  const deploySlack = deployJob.indexOf('bin/slack" deploy');
  const verifyTriggers = deployJob.indexOf(
    "scripts/verify_trigger_inventory.ts",
  );
  const activateProtocol = deployJob.indexOf(
    "scripts/activate_delivery_protocol.ts",
  );
  assert.ok(deploySlack >= 0 && verifyTriggers > deploySlack);
  assert.ok(activateProtocol > verifyTriggers);
  const activationStepStart = deployJob.lastIndexOf(
    "      - name:",
    activateProtocol,
  );
  const activationStepEnd = deployJob.indexOf(
    "\n      - name:",
    activateProtocol,
  );
  const activationStep = deployJob.slice(
    activationStepStart,
    activationStepEnd === -1 ? undefined : activationStepEnd,
  );
  assert.match(activationStep, /EXPECTED_REVISION: \$\{\{ github\.sha \}\}/);
  assert.match(
    activationStep,
    /--allow-env=EXPECTED_REVISION,SLACK_RELAY_SIGNING_SECRET_NEXT/,
  );
  assert.match(
    activationStep,
    /--allow-net=github-slack-alerts\.lcv\.workers\.dev/,
  );
  assert.doesNotMatch(activationStep, /if:\s*always\(\)/);
  assert.match(relayWorkflowSource, /--tag "\$GITHUB_SHA"/);
  assert.doesNotMatch(relayWorkflowSource, /GITHUB_PATH/);
  assert.match(
    deployJob,
    /"\$\{RUNNER_TEMP\}\/slack-cli-\$\{SLACK_CLI_VERSION\}\/bin\/slack" deploy/,
  );
  const provisionCloudflare = relayWorkflowSource.indexOf(
    "scripts/provision-cloudflare-relay-secret.mjs",
  );
  const deployWorker = relayWorkflowSource.indexOf("wrangler deploy");
  const provisionSlack = deployJob.indexOf(
    "scripts/provision-slack-relay-secret.mjs",
  );
  assert.ok(provisionCloudflare >= 0 && provisionCloudflare < deployWorker);
  assert.ok(provisionSlack >= 0 && provisionSlack < deploySlack);
  assert.match(
    relayWorkflowSource,
    /environment: cloudflare-production[\s\S]*SLACK_RELAY_SIGNING_SECRET: \$\{\{ secrets\.SLACK_RELAY_SIGNING_SECRET \}\}/,
  );
  assert.match(
    deployJob,
    /SLACK_RELAY_SIGNING_SECRET: \$\{\{ secrets\.SLACK_RELAY_SIGNING_SECRET \}\}/,
  );
  assert.match(
    activationStep,
    /SLACK_RELAY_SIGNING_SECRET_NEXT: \$\{\{ secrets\.SLACK_RELAY_SIGNING_SECRET \}\}/,
  );

  const requiredVerifyJob = relayWorkflowSource.slice(
    relayWorkflowSource.indexOf("  verify:"),
    relayWorkflowSource.indexOf("  deploy:"),
  );
  assert.match(requiredVerifyJob, /- name: Setup Deno 2\.9\.5/);
  assert.match(requiredVerifyJob, /- name: Check Slack workflow app/);
  assert.match(requiredVerifyJob, /deno task --frozen check/);
  assert.match(
    requiredVerifyJob,
    /- name: Audit Slack workflow app dependencies/,
  );
  assert.match(requiredVerifyJob, /run: deno task --frozen audit/);
  assert.match(
    requiredVerifyJob,
    /scripts\/slack-workflow-monitor\.test\.mjs/,
    "the privileged deploy predecessor must run the monitor candidate tests",
  );
});

test("expanded Worker selects staged NEXT while retaining current as a verifier", () => {
  assert.match(
    relayWranglerSource,
    /"SLACK_RELAY_SIGNING_ACTIVE_SLOT":\s*"next"/,
  );
  assert.match(
    relayWranglerSource,
    /"binding":\s*"SLACK_RELAY_SIGNING_SECRET"[\s\S]*?"secret_name":\s*"github-slack-relay-signing-secret"/,
  );
  assert.match(
    relayWranglerSource,
    /"binding":\s*"SLACK_RELAY_SIGNING_SECRET_NEXT"[\s\S]*?"secret_name":\s*"github-slack-relay-signing-secret-next"/,
  );
});

test("configuration rejects every absent required value and short relay secrets", () => {
  for (const name of Object.keys(environment)) {
    const candidate = { ...environment };
    delete candidate[name];
    assert.throws(
      () => readSlackMonitorConfiguration(candidate),
      new RegExp(`Required environment variable ${name} is missing`),
    );
  }
  assert.throws(
    () =>
      readSlackMonitorConfiguration({
        ...environment,
        SLACK_RELAY_SIGNING_SECRET: "short",
      }),
    /SLACK_RELAY_SIGNING_SECRET is malformed/,
  );
  assert.throws(
    () =>
      readSlackMonitorConfiguration({
        ...environment,
        SLACK_RELAY_SIGNING_SECRET_NEXT: "short",
      }),
    /SLACK_RELAY_SIGNING_SECRET_NEXT is malformed/,
  );
  assert.throws(
    () =>
      readSlackMonitorConfiguration({
        ...environment,
        SLACK_RELAY_SIGNING_SECRET_NEXT: environment.SLACK_RELAY_SIGNING_SECRET,
      }),
    /SLACK_RELAY_SIGNING_SECRET_NEXT is malformed/,
  );
  assert.throws(
    () =>
      readSlackMonitorConfiguration({
        ...environment,
        SLACK_RELAY_SIGNING_ACTIVE_SLOT: "next",
      }),
    /requires a staged NEXT secret/,
  );
  assert.throws(
    () =>
      readSlackMonitorConfiguration({
        ...environment,
        SLACK_RELAY_SIGNING_ACTIVE_SLOT: "invalid",
      }),
    /SLACK_RELAY_SIGNING_ACTIVE_SLOT is malformed/,
  );
});

test("configuration can stage both verifier keys while selecting one signer", () => {
  const next = "monitor-test-only-next-signing-secret";
  const staged = readSlackMonitorConfiguration({
    ...environment,
    SLACK_RELAY_SIGNING_SECRET_NEXT: next,
  });
  assert.equal(
    staged.relaySigningSecret,
    environment.SLACK_RELAY_SIGNING_SECRET,
  );
  assert.deepEqual(staged.relaySigningSecrets, [
    environment.SLACK_RELAY_SIGNING_SECRET,
    next,
  ]);
  assert.equal(staged.relaySigningActiveSlot, "current");

  const promoted = readSlackMonitorConfiguration({
    ...environment,
    SLACK_RELAY_SIGNING_SECRET_NEXT: next,
    SLACK_RELAY_SIGNING_ACTIVE_SLOT: "next",
  });
  assert.equal(promoted.relaySigningSecret, next);
  assert.equal(promoted.relaySigningActiveSlot, "next");
});

test("configuration preserves the exact HMAC secret bytes", () => {
  const current = ` ${"c".repeat(32)} `;
  const next = `\t${"n".repeat(32)}\n`;
  const configured = readSlackMonitorConfiguration({
    ...environment,
    SLACK_RELAY_SIGNING_SECRET: current,
    SLACK_RELAY_SIGNING_SECRET_NEXT: next,
    SLACK_RELAY_SIGNING_ACTIVE_SLOT: "next",
  });

  assert.equal(configured.relaySigningSecret, next);
  assert.deepEqual(configured.relaySigningSecrets, [current, next]);
});

test("monitor can sign with the staged NEXT key without storing old current in GitHub", () => {
  const next = "next-only-secret-for-protected-github-environment";
  const configuration = readSlackMonitorConfiguration({
    ...environment,
    SLACK_RELAY_SIGNING_SECRET: undefined,
    SLACK_RELAY_SIGNING_SECRET_NEXT: next,
    SLACK_RELAY_SIGNING_ACTIVE_SLOT: "next",
  });
  assert.equal(configuration.relaySigningSecret, next);
  assert.deepEqual(configuration.relaySigningSecrets, [next]);
});

test("monitor uses the durable checkpoint and posts an authenticated empty report", async () => {
  const now = Date.parse("2026-08-04T08:00:00.000Z");
  const calls = [];
  const result = await monitorSlackWorkflow({
    environment,
    now: () => now,
    fetchImpl: async (input, init) => {
      calls.push(input);
      if (input === CHECKPOINT_URL) {
        assertCheckpointRequest(init);
        return jsonResponse({ checkpoint_us: 0 });
      }
      if (input === SLACK_URL) {
        assert.equal(init.method, "POST");
        assert.equal(
          init.headers.Authorization,
          `Bearer ${environment.SLACK_SERVICE_TOKEN}`,
        );
        assert.deepEqual(Object.fromEntries(init.body), {
          app_id: environment.SLACK_APP_ID,
          team_id: environment.SLACK_TEAM_ID,
          min_log_level: "info",
          component_type: "workflows",
          min_date_created: String((now - 20 * 60 * 1_000) * 1_000),
          max_date_created: String(now * 1_000),
          sort_direction: "asc",
          limit: "100",
        });
        return jsonResponse({
          ok: true,
          activities: [],
          response_metadata: { next_cursor: "" },
        });
      }
      assert.equal(input, RECONCILIATION_URL);
      const report = assertReconciliationRequest(init);
      assert.equal(report.checkpoint_us, (now - 20 * 60 * 1_000) * 1_000);
      assert.deepEqual(report.traces, []);
      return jsonResponse({ ok: true, traces: 0 });
    },
  });

  assert.deepEqual(result, { errors: 0, pages: 1, traces: 0 });
  assert.deepEqual(calls, [CHECKPOINT_URL, SLACK_URL, RECONCILIATION_URL]);
});

test("an empty scan anchors its lower bound instead of advancing to wall clock", async () => {
  const now = Date.parse("2026-08-04T08:00:00.000Z");
  const initialAnchor = (now - 20 * 60 * 1_000) * 1_000;
  let report;
  await monitorSlackWorkflow({
    environment,
    now: () => now,
    fetchImpl: async (input, init) => {
      if (input === CHECKPOINT_URL) {
        return jsonResponse({ checkpoint_us: 0 });
      }
      if (input === SLACK_URL) {
        return jsonResponse({
          ok: true,
          activities: [],
          response_metadata: { next_cursor: "" },
        });
      }
      report = assertReconciliationRequest(init);
      return jsonResponse({ ok: true, traces: 0 });
    },
  });
  assert.equal(report.checkpoint_us, initialAnchor);

  const later = now + 2 * 60 * 60 * 1_000;
  await monitorSlackWorkflow({
    environment,
    now: () => later,
    fetchImpl: async (input, init) => {
      if (input === CHECKPOINT_URL) {
        return jsonResponse({ checkpoint_us: initialAnchor });
      }
      if (input === SLACK_URL) {
        const form = Object.fromEntries(init.body);
        assert.equal(
          form.min_date_created,
          String(initialAnchor - 20 * 60 * 1_000 * 1_000),
        );
        return jsonResponse({
          ok: true,
          activities: [],
          response_metadata: { next_cursor: "" },
        });
      }
      const secondReport = assertReconciliationRequest(init);
      assert.equal(secondReport.checkpoint_us, initialAnchor);
      return jsonResponse({ ok: true, traces: 0 });
    },
  });
});

test("paginates every activity and correlates delivery_id, trace_id, and send boundary", async () => {
  const now = Date.parse("2026-08-04T08:00:00.000Z");
  const created = now * 1_000 - 1_000;
  const reports = [];
  let slackPage = 0;
  const result = await monitorSlackWorkflow({
    environment,
    now: () => now,
    fetchImpl: async (input, init) => {
      if (input === CHECKPOINT_URL) {
        return jsonResponse({ checkpoint_us: created - 10_000 });
      }
      if (input === RECONCILIATION_URL) {
        reports.push(assertReconciliationRequest(init));
        return jsonResponse({ ok: true, traces: 1 });
      }
      assert.equal(input, SLACK_URL);
      slackPage += 1;
      const form = Object.fromEntries(init.body);
      assert.equal(
        form.min_date_created,
        String(created - 10_000 - 20 * 60 * 1_000 * 1_000),
      );
      if (slackPage === 1) {
        assert.equal(form.cursor, undefined);
        return jsonResponse({
          ok: true,
          activities: [
            {
              level: "info",
              event_type: "workflow_execution_started",
              component_type: "workflows",
              created,
              trace_id: "TrPaged1",
              payload: { workflow_name: "GitHub actionable alert" },
            },
            {
              level: "info",
              event_type: "workflow_step_execution_result",
              component_type: "workflows",
              created: created + 1,
              trace_id: "TrPaged1",
              payload: {
                exec_outcome: "Success",
                inputs: {
                  ...signedProgressInputs("delivery-paged-1"),
                  private_value: "must-not-leak",
                },
              },
            },
          ],
          response_metadata: { next_cursor: "cursor-two" },
        });
      }
      assert.equal(form.cursor, "cursor-two");
      return jsonResponse({
        ok: true,
        activities: [
          {
            level: "info",
            event_type: "workflow_execution_result",
            component_type: "workflows",
            created: created + 2,
            trace_id: "TrPaged1",
            payload: { exec_outcome: "Success" },
          },
        ],
        response_metadata: { next_cursor: "" },
      });
    },
  });

  assert.deepEqual(result, { errors: 0, pages: 2, traces: 1 });
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0].traces, [
    {
      trace_id: "TrPaged1",
      delivery_id: "delivery-paged-1",
      outcome: "success",
      send_boundary_reached: true,
      pre_send_failure_proven: false,
      started_at_us: created,
      completed_at_us: created + 2,
    },
  ]);
  assert.ok(!JSON.stringify(reports).includes("must-not-leak"));
});

test("persists an incomplete trace so later pages cannot forget its send boundary", () => {
  const created = Date.parse("2026-08-04T08:00:00.000Z") * 1_000;
  const result = reconcileSlackActivities(
    [
      {
        level: "info",
        event_type: "workflow_execution_started",
        created,
        trace_id: "TrPendingBoundary1",
        payload: {},
      },
      {
        level: "info",
        event_type: "workflow_step_execution_result",
        created: created + 1,
        trace_id: "TrPendingBoundary1",
        payload: {
          exec_outcome: "Success",
          inputs: {
            ...signedProgressInputs("delivery-pending-boundary-1"),
            private_value: "must-not-leak",
          },
        },
      },
    ],
    [environment.SLACK_RELAY_SIGNING_SECRET],
  );

  assert.deepEqual(result.traces, [
    {
      trace_id: "TrPendingBoundary1",
      delivery_id: "delivery-pending-boundary-1",
      outcome: "pending",
      send_boundary_reached: true,
      pre_send_failure_proven: false,
      started_at_us: created,
      completed_at_us: null,
    },
  ]);
  assert.ok(!JSON.stringify(result).includes("must-not-leak"));
});

test("persists explicit pre-send failure proof before the terminal result arrives", () => {
  const created = Date.parse("2026-08-04T08:00:00.000Z") * 1_000;
  const result = reconcileSlackActivities(
    [
      {
        level: "info",
        event_type: "workflow_execution_started",
        created,
        trace_id: "TrPendingPreSend1",
        payload: {},
      },
      {
        level: "error",
        event_type: "workflow_step_execution_result",
        created: created + 1,
        trace_id: "TrPendingPreSend1",
        payload: {
          exec_outcome: "Error",
          inputs: signedProgressInputs("delivery-pending-pre-send-1"),
        },
      },
    ],
    [environment.SLACK_RELAY_SIGNING_SECRET],
  );

  assert.deepEqual(result.traces, [
    {
      trace_id: "TrPendingPreSend1",
      delivery_id: "delivery-pending-pre-send-1",
      outcome: "pending",
      send_boundary_reached: false,
      pre_send_failure_proven: true,
      started_at_us: created,
      completed_at_us: null,
    },
  ]);
});

test("does not trust an unauthenticated failed validator input as retry proof", () => {
  const created = Date.parse("2026-08-04T08:00:00.000Z") * 1_000;
  const result = reconcileSlackActivities(
    [
      {
        level: "info",
        event_type: "workflow_execution_started",
        created,
        trace_id: "TrForgedValidator1",
        payload: {},
      },
      {
        level: "error",
        event_type: "workflow_step_execution_result",
        created: created + 1,
        trace_id: "TrForgedValidator1",
        payload: {
          exec_outcome: "Error",
          inputs: {
            ...signedValidatorInputs("existing-real-delivery-id"),
            relay_signature: "0".repeat(64),
          },
        },
      },
      {
        level: "error",
        event_type: "workflow_execution_result",
        created: created + 2,
        trace_id: "TrForgedValidator1",
        payload: { exec_outcome: "Error" },
      },
    ],
    [environment.SLACK_RELAY_SIGNING_SECRET],
  );

  assert.deepEqual(result.traces, []);
});

test("does not trust replayed authenticated step inputs outside their activity window", () => {
  const created = Date.parse("2026-08-04T08:00:00.000Z") * 1_000;
  const staleRelayTimestamp = String(created / 1_000_000 - 301);
  const futureRelayTimestamp = String(created / 1_000_000 + 61);
  const result = reconcileSlackActivities(
    [
      {
        level: "info",
        event_type: "workflow_execution_started",
        created: created - 1,
        trace_id: "TrReplayedValidator1",
        payload: {},
      },
      {
        level: "error",
        event_type: "workflow_step_execution_result",
        created,
        trace_id: "TrReplayedValidator1",
        payload: {
          exec_outcome: "Error",
          inputs: signedValidatorInputs(
            "existing-real-delivery-id",
            "alerts",
            staleRelayTimestamp,
          ),
        },
      },
      {
        level: "error",
        event_type: "workflow_execution_result",
        created: created + 1,
        trace_id: "TrReplayedValidator1",
        payload: { exec_outcome: "Error" },
      },
      {
        level: "info",
        event_type: "workflow_execution_started",
        created: created - 1,
        trace_id: "TrReplayedProgress1",
        payload: {},
      },
      {
        level: "error",
        event_type: "workflow_step_execution_result",
        created,
        trace_id: "TrReplayedProgress1",
        payload: {
          exec_outcome: "Error",
          inputs: signedProgressInputs(
            "existing-real-delivery-id",
            "send_started",
            "alerts",
            futureRelayTimestamp,
          ),
        },
      },
      {
        level: "error",
        event_type: "workflow_execution_result",
        created: created + 1,
        trace_id: "TrReplayedProgress1",
        payload: { exec_outcome: "Error" },
      },
    ],
    [environment.SLACK_RELAY_SIGNING_SECRET],
  );

  assert.deepEqual(result.traces, []);
});

test("accepts authenticated step inputs at the exact activity freshness boundaries", () => {
  const created = Date.parse("2026-08-04T08:00:00.000Z") * 1_000;
  const result = reconcileSlackActivities(
    [
      {
        level: "info",
        event_type: "workflow_execution_started",
        created: created - 1,
        trace_id: "TrBoundaryValidator1",
        payload: {},
      },
      {
        level: "error",
        event_type: "workflow_step_execution_result",
        created,
        trace_id: "TrBoundaryValidator1",
        payload: {
          exec_outcome: "Error",
          inputs: signedValidatorInputs(
            "delivery-boundary-validator",
            "alerts",
            String(created / 1_000_000 - 300),
          ),
        },
      },
      {
        level: "error",
        event_type: "workflow_execution_result",
        created: created + 1,
        trace_id: "TrBoundaryValidator1",
        payload: { exec_outcome: "Error" },
      },
      {
        level: "info",
        event_type: "workflow_execution_started",
        created: created - 1,
        trace_id: "TrBoundaryProgress1",
        payload: {},
      },
      {
        level: "info",
        event_type: "workflow_step_execution_result",
        created,
        trace_id: "TrBoundaryProgress1",
        payload: {
          exec_outcome: "Success",
          inputs: signedProgressInputs(
            "delivery-boundary-progress",
            "send_started",
            "alerts",
            String(created / 1_000_000 + 60),
          ),
        },
      },
      {
        level: "info",
        event_type: "workflow_execution_result",
        created: created + 1,
        trace_id: "TrBoundaryProgress1",
        payload: { exec_outcome: "Success" },
      },
    ],
    [environment.SLACK_RELAY_SIGNING_SECRET],
  );

  assert.deepEqual(
    result.traces.map((trace) => ({
      delivery_id: trace.delivery_id,
      pre_send_failure_proven: trace.pre_send_failure_proven,
      send_boundary_reached: trace.send_boundary_reached,
    })),
    [
      {
        delivery_id: "delivery-boundary-progress",
        pre_send_failure_proven: false,
        send_boundary_reached: true,
      },
      {
        delivery_id: "delivery-boundary-validator",
        pre_send_failure_proven: true,
        send_boundary_reached: false,
      },
    ],
  );
});

test("a complete pre-send failure is reconciled before the sanitized monitor failure", async () => {
  const now = Date.parse("2026-08-04T08:00:00.000Z");
  const created = now * 1_000 - 10;
  let report;
  await assert.rejects(
    monitorSlackWorkflow({
      environment,
      now: () => now,
      fetchImpl: async (input, init) => {
        if (input === CHECKPOINT_URL) {
          return jsonResponse({ checkpoint_us: 0 });
        }
        if (input === RECONCILIATION_URL) {
          report = assertReconciliationRequest(init);
          return jsonResponse({ ok: true, traces: 1 });
        }
        return jsonResponse({
          ok: true,
          activities: [
            {
              level: "info",
              event_type: "workflow_execution_started",
              created,
              trace_id: "TrPreSend1",
              payload: {},
            },
            {
              level: "error",
              event_type: "workflow_step_execution_result",
              created: created + 1,
              trace_id: "TrPreSend1",
              payload: {
                exec_outcome: "Error",
                inputs: signedValidatorInputs("delivery-pre-send-1"),
              },
            },
            {
              level: "error",
              event_type: "workflow_execution_result",
              created: created + 2,
              trace_id: "TrPreSend1",
              payload: {
                exec_outcome: "Error",
                private_value: "secret-payload",
              },
            },
          ],
          response_metadata: { next_cursor: "" },
        });
      },
    }),
    (error) =>
      /recorded 2 workflow errors/.test(error.message) &&
      /durable reconciliation/.test(error.message) &&
      !/secret-payload/.test(error.message) &&
      !error.message.includes(environment.SLACK_SERVICE_TOKEN),
  );
  assert.deepEqual(report.traces[0], {
    trace_id: "TrPreSend1",
    delivery_id: "delivery-pre-send-1",
    outcome: "error",
    send_boundary_reached: false,
    pre_send_failure_proven: true,
    started_at_us: created,
    completed_at_us: created + 2,
  });
});

test("repeated pagination cursors fail before advancing the checkpoint", async () => {
  let reports = 0;
  await assert.rejects(
    monitorSlackWorkflow({
      environment,
      fetchImpl: async (input) => {
        if (input === CHECKPOINT_URL) {
          return jsonResponse({ checkpoint_us: 0 });
        }
        if (input === RECONCILIATION_URL) {
          reports += 1;
          return jsonResponse({ ok: true });
        }
        return jsonResponse({
          ok: true,
          activities: [],
          response_metadata: { next_cursor: "same-cursor" },
        });
      },
    }),
    /repeated a cursor/,
  );
  assert.equal(reports, 0);
});

test("pure reconciliation refuses conflicting delivery IDs without exposing inputs", () => {
  const created = Date.parse("2026-08-04T08:00:00.000Z") * 1_000;
  assert.throws(
    () =>
      reconcileSlackActivities(
        [
          {
            level: "info",
            event_type: "workflow_step_execution_result",
            created,
            trace_id: "TrConflict1",
            payload: {
              exec_outcome: "Success",
              inputs: {
                ...signedProgressInputs("delivery-one"),
                secret: "one",
              },
            },
          },
          {
            level: "error",
            event_type: "workflow_step_execution_result",
            created: created + 1,
            trace_id: "TrConflict1",
            payload: {
              exec_outcome: "Error",
              inputs: {
                ...signedProgressInputs("delivery-two"),
                secret: "two",
              },
            },
          },
        ],
        [environment.SLACK_RELAY_SIGNING_SECRET],
      ),
    (error) =>
      /conflicting delivery IDs/.test(error.message) &&
      !/secret|one|two/.test(error.message),
  );
});

test("contradictory terminal outcomes abort before any relay mutation", async () => {
  const now = Date.parse("2026-08-04T08:00:00.000Z");
  const created = now * 1_000 - 10;
  let reconciliationPosts = 0;
  await assert.rejects(
    monitorSlackWorkflow({
      environment,
      now: () => now,
      fetchImpl: async (input) => {
        if (input === CHECKPOINT_URL) {
          return jsonResponse({ checkpoint_us: 0 });
        }
        if (input === RECONCILIATION_URL) {
          reconciliationPosts += 1;
          return jsonResponse({ ok: true });
        }
        return jsonResponse({
          ok: true,
          activities: [
            {
              level: "info",
              event_type: "workflow_execution_started",
              created,
              trace_id: "TrContradictory1",
              payload: {},
            },
            {
              level: "info",
              event_type: "workflow_execution_result",
              created: created + 1,
              trace_id: "TrContradictory1",
              payload: { exec_outcome: "Success" },
            },
            {
              level: "error",
              event_type: "workflow_step_execution_result",
              created: created + 2,
              trace_id: "TrContradictory1",
              payload: {
                exec_outcome: "Error",
                inputs: signedProgressInputs("delivery-contradictory-1"),
              },
            },
            {
              level: "error",
              event_type: "workflow_execution_result",
              created: created + 3,
              trace_id: "TrContradictory1",
              payload: { exec_outcome: "Error" },
            },
          ],
          response_metadata: { next_cursor: "" },
        });
      },
    }),
    /contradictory terminal outcomes/,
  );
  assert.equal(reconciliationPosts, 0);
});

test("ignores non-execution workflow metadata that has no trace ID", () => {
  const result = reconcileSlackActivities([
    {
      level: "info",
      event_type: "workflow_published",
      created: 1,
      payload: { workflow_name: "GitHub actionable alert" },
    },
  ]);
  assert.deepEqual(result.traces, []);
  assert.equal(result.errors, 0);
});

test("HTTP 429 performs one bounded Slack retry and does not retry twice", async () => {
  let slackRequests = 0;
  const delays = [];
  const result = await monitorSlackWorkflow({
    environment,
    fetchImpl: async (input) => {
      if (input === CHECKPOINT_URL) {
        return jsonResponse({ checkpoint_us: 0 });
      }
      if (input === RECONCILIATION_URL) {
        return jsonResponse({ ok: true, traces: 0 });
      }
      slackRequests += 1;
      return slackRequests === 1
        ? new Response("withheld", {
            status: 429,
            headers: { "retry-after": "2" },
          })
        : jsonResponse({
            ok: true,
            activities: [],
            response_metadata: { next_cursor: "" },
          });
    },
    sleepImpl: async (milliseconds) => delays.push(milliseconds),
  });
  assert.deepEqual(result, { errors: 0, pages: 1, traces: 0 });
  assert.equal(slackRequests, 2);
  assert.deepEqual(delays, [2_000]);

  slackRequests = 0;
  await assert.rejects(
    monitorSlackWorkflow({
      environment,
      fetchImpl: async (input) => {
        if (input === CHECKPOINT_URL) {
          return jsonResponse({ checkpoint_us: 0 });
        }
        slackRequests += 1;
        return new Response("withheld", {
          status: 429,
          headers: { "retry-after": "1" },
        });
      },
      sleepImpl: async () => {},
    }),
    /HTTP 429/,
  );
  assert.equal(slackRequests, 2);
});

test("HTTP and malformed failures never echo upstream bodies or credentials", async () => {
  for (const response of [
    new Response("private upstream body", { status: 503 }),
    new Response("private invalid JSON"),
  ]) {
    await assert.rejects(
      monitorSlackWorkflow({
        environment,
        fetchImpl: async (input) =>
          input === CHECKPOINT_URL
            ? jsonResponse({ checkpoint_us: 0 })
            : response,
      }),
      (error) =>
        !/private upstream body|private invalid JSON/.test(error.message) &&
        !error.message.includes(environment.SLACK_SERVICE_TOKEN) &&
        !error.message.includes(environment.SLACK_RELAY_SIGNING_SECRET),
    );
  }
});
