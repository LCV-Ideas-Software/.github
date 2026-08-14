import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  monitorSlackWorkflow,
  readSlackMonitorConfiguration,
  reconcileSlackActivities,
  SLACK_MONITOR_WORST_CASE_NETWORK_MS,
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

function hmacWithSecret(canonical, secret) {
  return createHmac("sha256", secret).update(canonical, "utf8").digest("hex");
}

function hmac(canonical) {
  return hmacWithSecret(canonical, environment.SLACK_RELAY_SIGNING_SECRET);
}

function signedProgressInputs(
  deliveryId,
  phase = "send_started",
  destination = "alerts",
  relayTimestamp = "1785830400",
  secret = environment.SLACK_RELAY_SIGNING_SECRET,
) {
  return {
    delivery_id: deliveryId,
    destination,
    phase,
    relay_attempt: "1",
    relay_timestamp: relayTimestamp,
    progress_token: hmacWithSecret(
      JSON.stringify([
        "slack_progress_authorization_v2",
        deliveryId,
        destination,
        "1",
        relayTimestamp,
      ]),
      secret,
    ),
  };
}

function signedValidatorInputs(
  deliveryId,
  destination = "alerts",
  relayTimestamp = "1785830400",
  secret = environment.SLACK_RELAY_SIGNING_SECRET,
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
    relay_attempt: "1",
    relay_timestamp: relayTimestamp,
    expected_destination: destination,
  };
  return {
    ...inputs,
    relay_signature: hmacWithSecret(
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
        inputs.relay_attempt,
        inputs.relay_timestamp,
      ]),
      secret,
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
        "slack_activity_reconciliation_v3",
        body.checkpoint_us,
        body.report_timestamp,
        body.traces.map((trace) => [
          trace.trace_id,
          trace.delivery_id,
          trace.outcome,
          trace.relay_attempt,
          trace.send_execution_id,
          trace.slack_channel_id,
          trace.slack_message_ts,
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

function assertReconciliationV4Request(init) {
  const body = JSON.parse(String(init.body));
  assert.equal(
    body.report_signature,
    hmac(
      JSON.stringify([
        "slack_activity_reconciliation_v4",
        body.checkpoint_us,
        body.report_timestamp,
        body.scan_state,
        body.traces.map((trace) => [
          trace.trace_id,
          trace.delivery_id,
          trace.outcome,
          trace.relay_attempt,
          trace.send_execution_id,
          trace.slack_channel_id,
          trace.slack_message_ts,
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

function assertReconciliationV5Request(init) {
  const body = JSON.parse(String(init.body));
  assert.equal(
    body.report_signature,
    hmac(
      JSON.stringify([
        "slack_activity_reconciliation_v5",
        body.checkpoint_us,
        body.report_timestamp,
        body.scan_state,
        body.hydrations.map((hydration) => [
          hydration.trace_id,
          hydration.first_observed_us,
          hydration.last_observed_us,
          hydration.status,
          hydration.debt_reason,
          hydration.attempted,
        ]),
        body.traces.map((trace) => [
          trace.trace_id,
          trace.delivery_id,
          trace.outcome,
          trace.relay_attempt,
          trace.send_execution_id,
          trace.slack_channel_id,
          trace.slack_message_ts,
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

function assertBridgeReconciliationRequest(init) {
  const body = JSON.parse(String(init.body));
  assert.equal(
    body.report_signature,
    hmac(
      JSON.stringify([
        "slack_activity_reconciliation_v2",
        body.checkpoint_us,
        body.report_timestamp,
        body.traces.map((trace) => [
          trace.trace_id,
          trace.delivery_id,
          trace.outcome,
          trace.relay_attempt,
          trace.send_execution_id,
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

function acceptedReconciliationResponse(report, changedErrorTraces = 0) {
  return jsonResponse({
    ok: true,
    traces: report.traces.length,
    ...(Array.isArray(report.hydrations)
      ? { hydrations: report.hydrations.length }
      : {}),
    changed_error_traces: changedErrorTraces,
    checkpoint_us: report.checkpoint_us,
  });
}

function checkpointResponse(checkpointUs) {
  return jsonResponse({
    checkpoint_us: checkpointUs,
    reconciliation_version: 3,
  });
}

function checkpointResponseV4(checkpointUs, resumeFromUs = null) {
  return jsonResponse({
    checkpoint_us: checkpointUs,
    reconciliation_version: 4,
    resume_from_us: resumeFromUs,
  });
}

function checkpointResponseV5({
  checkpointUs,
  resumeFromUs = null,
  pendingTraceIds = [],
  pendingTraceTotal = pendingTraceIds.length,
  pendingTraceOldestUs = null,
}) {
  return jsonResponse({
    checkpoint_us: checkpointUs,
    reconciliation_version: 5,
    resume_from_us: resumeFromUs,
    pending_trace_ids: pendingTraceIds,
    pending_trace_total: pendingTraceTotal,
    pending_trace_oldest_us: pendingTraceOldestUs,
  });
}

function hydrationTraceActivities({ created, deliveryId, traceId }) {
  return {
    start: {
      level: "info",
      event_type: "workflow_execution_started",
      component_type: "workflows",
      created,
      trace_id: traceId,
      payload: { workflow_name: "GitHub activity" },
    },
    boundary: {
      level: "info",
      event_type: "workflow_step_execution_result",
      component_type: "workflows",
      created: created + 1,
      trace_id: traceId,
      payload: {
        exec_outcome: "Success",
        function_execution_id: `Fx${traceId.slice(2)}Boundary`,
        inputs: signedProgressInputs(
          deliveryId,
          "send_started",
          "alerts",
          String(Math.floor(created / 1_000_000)),
        ),
      },
    },
    terminal: {
      level: "info",
      event_type: "workflow_execution_result",
      component_type: "workflows",
      created: created + 2,
      trace_id: traceId,
      payload: { exec_outcome: "Success" },
    },
  };
}

function legacyTraceActivities({ created, traceId }) {
  return [
    {
      level: "info",
      event_type: "workflow_execution_started",
      component_type: "workflows",
      created,
      trace_id: traceId,
      payload: {},
    },
    {
      level: "info",
      event_type: "workflow_step_started",
      component_type: "workflows",
      created: created + 1,
      trace_id: traceId,
      payload: {
        current_step: 1,
        total_steps: 2,
        function_id: "Fn0BMBCA9QG7",
        function_execution_id: `Fx${traceId.slice(2)}Validator`,
      },
    },
    {
      level: "info",
      event_type: "workflow_step_execution_result",
      component_type: "workflows",
      created: created + 2,
      trace_id: traceId,
      payload: {
        exec_outcome: "Success",
        function_id: "Fn0BMBCA9QG7",
        function_execution_id: `Fx${traceId.slice(2)}Validator`,
      },
    },
    {
      level: "info",
      event_type: "workflow_step_started",
      component_type: "workflows",
      created: created + 3,
      trace_id: traceId,
      payload: {
        current_step: 2,
        total_steps: 2,
        function_id: "Fn0102",
        function_execution_id: `Fx${traceId.slice(2)}Send`,
      },
    },
    {
      level: "info",
      event_type: "workflow_step_execution_result",
      component_type: "workflows",
      created: created + 4,
      trace_id: traceId,
      payload: {
        exec_outcome: "Success",
        function_id: "Fn0102",
        function_execution_id: `Fx${traceId.slice(2)}Send`,
        outputs: {
          channel_id: "C0BMQMW3L4E",
          message_ts: "1786555894.853909",
        },
      },
    },
    {
      level: "info",
      event_type: "workflow_execution_result",
      component_type: "workflows",
      created: created + 5,
      trace_id: traceId,
      payload: { exec_outcome: "Success" },
    },
  ];
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

test("deployment updates both protected trigger definitions before inventory without activation", () => {
  const deployJob = relayWorkflowSource.slice(
    relayWorkflowSource.indexOf("  deploy_slack:"),
  );
  const deploySlack = deployJob.indexOf('"$SLACK_BIN" deploy');
  const updateStepStart = deployJob.indexOf(
    "      - name: Update the two protected production webhook triggers",
  );
  const verifyTriggers = deployJob.indexOf(
    "scripts/verify_trigger_inventory.ts",
  );

  assert.ok(
    deploySlack >= 0 &&
      updateStepStart > deploySlack &&
      verifyTriggers > updateStepStart,
  );
  assert.doesNotMatch(deployJob, /activate_delivery_protocol\.ts/u);

  const updateStepEnd = deployJob.indexOf(
    "\n      - name:",
    updateStepStart + 1,
  );
  const updateStep = deployJob.slice(updateStepStart, updateStepEnd);
  assert.match(
    updateStep,
    /trigger update \\\n\s+--trigger-id "\$ACTIVITY_TRIGGER_ID" \\\n\s+--trigger-def triggers\/github_activity_webhook\.ts/,
  );
  assert.match(
    updateStep,
    /trigger update \\\n\s+--trigger-id "\$ALERT_TRIGGER_ID" \\\n\s+--trigger-def triggers\/github_alert_webhook\.ts/,
  );
  assert.equal(updateStep.match(/\n\s+trigger update \\/g)?.length, 2);
  assert.match(updateStep, /umask 077/);
  assert.match(
    updateStep,
    /mktemp "\$\{RUNNER_TEMP\}\/slack-trigger-update\.XXXXXX"/,
  );
  assert.match(updateStep, /trap 'rm -f "\$update_log"' EXIT/);
  assert.equal(
    updateStep.match(/>"\$update_log" 2>&1/g)?.length,
    2,
    "both CLI responses must be captured instead of exposing webhook URLs",
  );
  assert.doesNotMatch(updateStep, /(?:cat|tee).*\$update_log/);
  assert.doesNotMatch(updateStep, /\|\|\s*true/);
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
  const remoteProofJob = relayWorkflowSource.slice(
    relayWorkflowSource.indexOf("  prove_remote_d1:"),
    relayWorkflowSource.indexOf("  deploy:"),
  );
  assert.match(remoteProofJob, /needs: verify/);
  assert.match(relayDeployJob, /needs: prove_remote_d1/);
  const productionMigration = relayDeployJob.indexOf(
    "wrangler d1 migrations apply github-slack-alerts-db",
  );
  const sealedPostflight = relayDeployJob.indexOf(
    "scripts/slack-delivery-protocol-contract.mjs",
  );
  assert.ok(
    productionMigration >= 0 && sealedPostflight > productionMigration,
    "the exact sealed tuple must be verified after production D1 migrates",
  );
  assert.match(
    relayDeployJob,
    /slack-delivery-protocol-contract\.mjs --print-sql/u,
  );
  assert.match(relayDeployJob, /--command "\$CONTRACT_SQL"/u);
  assert.doesNotMatch(relayDeployJob, /EXPECTED_REVISION:/u);
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
  const deploySlack = deployJob.indexOf('"$SLACK_BIN" deploy');
  const proveSigner = deployJob.indexOf(
    "node scripts/verify-slack-relay-signer.mjs",
  );
  const installSlackCli = deployJob.indexOf(
    "      - name: Install verified Slack CLI 4.6.0",
  );
  const verifyTriggers = deployJob.indexOf(
    "scripts/verify_trigger_inventory.ts",
  );
  assert.ok(deploySlack >= 0 && verifyTriggers > deploySlack);
  assert.doesNotMatch(deployJob, /activate_delivery_protocol\.ts/u);
  assert.match(relayWorkflowSource, /--tag "\$GITHUB_SHA"/);
  assert.doesNotMatch(relayWorkflowSource, /GITHUB_PATH/);
  assert.match(
    deployJob,
    /printf 'slack_bin=%s\\n' "\$install_root\/bin\/slack" >> "\$GITHUB_OUTPUT"[\s\S]*SLACK_BIN: \$\{\{ steps\.install-slack-cli\.outputs\.slack_bin \}\}[\s\S]*"\$SLACK_BIN" deploy/,
  );
  const provisionCloudflare = relayWorkflowSource.indexOf(
    "scripts/provision-cloudflare-relay-secret.mjs",
  );
  const deployWorker = relayWorkflowSource.indexOf("wrangler deploy");
  const provisionSlack = deployJob.indexOf(
    "scripts/provision-slack-relay-secret.mjs",
  );
  assert.ok(provisionCloudflare >= 0 && provisionCloudflare < deployWorker);
  assert.ok(
    proveSigner >= 0 &&
      proveSigner < installSlackCli &&
      installSlackCli < provisionSlack,
    "the slack-production secret must prove equality before every Slack mutation",
  );
  assert.ok(provisionSlack >= 0 && provisionSlack < deploySlack);
  const proofStepStart = deployJob.lastIndexOf("      - name:", proveSigner);
  const proofStepEnd = deployJob.indexOf("\n      - name:", proveSigner);
  const proofStep = deployJob.slice(proofStepStart, proofStepEnd);
  assert.match(
    proofStep,
    /SLACK_RELAY_SIGNING_SECRET: \$\{\{ secrets\.SLACK_RELAY_SIGNING_SECRET \}\}/u,
  );
  assert.doesNotMatch(proofStep, /set -x|curl\s+(?:-[^\s]*v|--verbose)/u);
  assert.match(
    relayWorkflowSource,
    /environment: cloudflare-production[\s\S]*SLACK_RELAY_SIGNING_SECRET: \$\{\{ secrets\.SLACK_RELAY_SIGNING_SECRET \}\}/,
  );
  assert.match(
    deployJob,
    /SLACK_RELAY_SIGNING_SECRET: \$\{\{ secrets\.SLACK_RELAY_SIGNING_SECRET \}\}/,
  );

  const requiredVerifyJob = relayWorkflowSource.slice(
    relayWorkflowSource.indexOf("  verify:"),
    relayWorkflowSource.indexOf("  deploy:"),
  );
  assert.match(requiredVerifyJob, /- name: Setup Deno 2\.9\.5/);
  assert.match(requiredVerifyJob, /- name: Check Slack workflow app/);
  assert.match(
    requiredVerifyJob,
    /deno task --config=deno\.jsonc --frozen check/,
  );
  assert.match(
    requiredVerifyJob,
    /- name: Audit Slack workflow app dependencies/,
  );
  assert.match(
    requiredVerifyJob,
    /run: deno task --config=deno\.jsonc --frozen audit/,
  );
  assert.match(
    requiredVerifyJob,
    /scripts\/slack-workflow-monitor\.test\.mjs/,
    "the privileged deploy predecessor must run the monitor candidate tests",
  );
  assert.match(
    requiredVerifyJob,
    /scripts\/verify-slack-relay-signer\.test\.mjs/,
    "the privileged deploy predecessor must run the signer boundary tests",
  );
});

test("the monitor job can finish its bounded worst-case network plan", async () => {
  const monitorModule = await import("./slack-workflow-monitor.mjs");
  const monitorJob = workflowSource.slice(workflowSource.indexOf("  monitor:"));
  const timeout = monitorJob.match(/timeout-minutes:\s*(\d+)/);
  assert.notEqual(timeout, null);
  const timeoutMinutes = Number.parseInt(timeout[1], 10);
  const timeoutMs = Number.parseInt(timeout[1], 10) * 60_000;
  const setupAndProcessingMarginMs = 30 * 60_000;
  assert.equal(monitorModule.SLACK_MONITOR_MAX_RECONCILIATION_REPORTS, 402);
  assert.equal(SLACK_MONITOR_WORST_CASE_NETWORK_MS, 17_410_000);
  assert.equal(timeoutMinutes, 321);
  assert.ok(
    timeoutMs >=
      SLACK_MONITOR_WORST_CASE_NETWORK_MS + setupAndProcessingMarginMs,
    "the job timeout must cover every bounded page/retry/report plus setup margin",
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
        return checkpointResponse(0);
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
      return acceptedReconciliationResponse(report);
    },
  });

  assert.deepEqual(result, {
    caughtUp: true,
    errors: 0,
    pages: 1,
    traces: 0,
  });
  assert.deepEqual(calls, [CHECKPOINT_URL, SLACK_URL, RECONCILIATION_URL]);
});

test("identifies a checkpoint timeout without exposing authenticated material", async () => {
  const timeout = Object.assign(new Error("upstream included a secret"), {
    name: "TimeoutError",
  });
  await assert.rejects(
    monitorSlackWorkflow({
      environment,
      now: () => Date.parse("2026-08-04T08:00:00.000Z"),
      fetchImpl: async (input) => {
        assert.equal(input, CHECKPOINT_URL);
        throw timeout;
      },
    }),
    (error) => {
      assert.equal(
        error.message,
        "Relay reconciliation checkpoint timed out after 10000ms.",
      );
      assert.doesNotMatch(
        error.message,
        /service-token-never-log|monitor-test-only/u,
      );
      return true;
    },
  );
});

test("keeps the Slack API timeout distinct from relay phases", async () => {
  const timeout = Object.assign(new Error("private Slack response"), {
    name: "AbortError",
  });
  await assert.rejects(
    monitorSlackWorkflow({
      environment,
      now: () => Date.parse("2026-08-04T08:00:00.000Z"),
      fetchImpl: async (input) => {
        if (input === CHECKPOINT_URL) return checkpointResponse(0);
        assert.equal(input, SLACK_URL);
        throw timeout;
      },
    }),
    (error) => {
      assert.equal(
        error.message,
        "Slack activity API timed out after 30000ms.",
      );
      assert.doesNotMatch(error.message, /private Slack response/u);
      return true;
    },
  );
});

test("replays the exact signed report after an ambiguous response loss", async () => {
  const timeout = Object.assign(new Error("signed report body"), {
    name: "TimeoutError",
  });
  const reportBodies = [];
  const result = await monitorSlackWorkflow({
    environment,
    now: () => Date.parse("2026-08-04T08:00:00.000Z"),
    fetchImpl: async (input, init) => {
      if (input === CHECKPOINT_URL) return checkpointResponse(0);
      if (input === SLACK_URL) {
        return jsonResponse({
          ok: true,
          activities: [],
          response_metadata: { next_cursor: "" },
        });
      }
      assert.equal(input, RECONCILIATION_URL);
      reportBodies.push(init.body);
      if (reportBodies.length === 1) throw timeout;
      return acceptedReconciliationResponse(JSON.parse(init.body));
    },
  });
  assert.deepEqual(result, {
    caughtUp: true,
    errors: 0,
    pages: 1,
    traces: 0,
  });
  assert.equal(reportBodies.length, 2);
  assert.equal(reportBodies[1], reportBodies[0]);
});

test("identifies a reconciliation replay that also times out", async () => {
  const timeout = Object.assign(new Error("signed report body"), {
    name: "TimeoutError",
  });
  let reportRequests = 0;
  await assert.rejects(
    monitorSlackWorkflow({
      environment,
      now: () => Date.parse("2026-08-04T08:00:00.000Z"),
      fetchImpl: async (input) => {
        if (input === CHECKPOINT_URL) return checkpointResponse(0);
        if (input === SLACK_URL) {
          return jsonResponse({
            ok: true,
            activities: [],
            response_metadata: { next_cursor: "" },
          });
        }
        assert.equal(input, RECONCILIATION_URL);
        reportRequests += 1;
        throw timeout;
      },
    }),
    (error) => {
      assert.equal(
        error.message,
        "Relay reconciliation report 1/1 replay timed out after 5000ms.",
      );
      assert.doesNotMatch(error.message, /signed report body/u);
      return true;
    },
  );
  assert.equal(reportRequests, 2);
});

test("replays the exact signed report after an ambiguous HTTP 503", async () => {
  const reportBodies = [];
  const result = await monitorSlackWorkflow({
    environment,
    now: () => Date.parse("2026-08-04T08:00:00.000Z"),
    fetchImpl: async (input, init) => {
      if (input === CHECKPOINT_URL) return checkpointResponse(0);
      if (input === SLACK_URL) {
        return jsonResponse({
          ok: true,
          activities: [],
          response_metadata: { next_cursor: "" },
        });
      }
      assert.equal(input, RECONCILIATION_URL);
      reportBodies.push(init.body);
      if (reportBodies.length === 1) {
        return new Response("withheld", { status: 503 });
      }
      return acceptedReconciliationResponse(JSON.parse(init.body));
    },
  });
  assert.deepEqual(result, {
    caughtUp: true,
    errors: 0,
    pages: 1,
    traces: 0,
  });
  assert.deepEqual(reportBodies, [reportBodies[0], reportBodies[0]]);
});

test("replays the exact signed report after an ambiguous HTTP 408", async () => {
  const reportBodies = [];
  const result = await monitorSlackWorkflow({
    environment,
    now: () => Date.parse("2026-08-04T08:00:00.000Z"),
    fetchImpl: async (input, init) => {
      if (input === CHECKPOINT_URL) return checkpointResponse(0);
      if (input === SLACK_URL) {
        return jsonResponse({
          ok: true,
          activities: [],
          response_metadata: { next_cursor: "" },
        });
      }
      assert.equal(input, RECONCILIATION_URL);
      reportBodies.push(init.body);
      if (reportBodies.length === 1) {
        return new Response("withheld", { status: 408 });
      }
      return acceptedReconciliationResponse(JSON.parse(init.body));
    },
  });
  assert.deepEqual(result, {
    caughtUp: true,
    errors: 0,
    pages: 1,
    traces: 0,
  });
  assert.deepEqual(reportBodies, [reportBodies[0], reportBodies[0]]);
});

test("replays the exact signed report after an ambiguous invalid JSON response", async () => {
  const reportBodies = [];
  const result = await monitorSlackWorkflow({
    environment,
    now: () => Date.parse("2026-08-04T08:00:00.000Z"),
    fetchImpl: async (input, init) => {
      if (input === CHECKPOINT_URL) return checkpointResponse(0);
      if (input === SLACK_URL) {
        return jsonResponse({
          ok: true,
          activities: [],
          response_metadata: { next_cursor: "" },
        });
      }
      assert.equal(input, RECONCILIATION_URL);
      reportBodies.push(init.body);
      if (reportBodies.length === 1) {
        return new Response("{", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return acceptedReconciliationResponse(JSON.parse(init.body));
    },
  });
  assert.deepEqual(result, {
    caughtUp: true,
    errors: 0,
    pages: 1,
    traces: 0,
  });
  assert.deepEqual(reportBodies, [reportBodies[0], reportBodies[0]]);
});

test("rejects a checkpoint error envelope before reading Slack activities", async () => {
  let slackRequests = 0;
  await assert.rejects(
    monitorSlackWorkflow({
      environment,
      now: () => Date.parse("2026-08-04T08:00:00.000Z"),
      fetchImpl: async (input) => {
        assert.equal(input, CHECKPOINT_URL);
        slackRequests += input === SLACK_URL ? 1 : 0;
        return jsonResponse({
          ok: false,
          checkpoint_us: Number.MAX_SAFE_INTEGER,
        });
      },
    }),
    /checkpoint is malformed/,
  );
  assert.equal(slackRequests, 0);
});

test("rejects malformed v5 pending trace ids through the controlled checkpoint error", async () => {
  let slackRequests = 0;
  await assert.rejects(
    monitorSlackWorkflow({
      environment,
      now: () => Date.parse("2026-08-04T08:00:00.000Z"),
      fetchImpl: async (input) => {
        assert.equal(input, CHECKPOINT_URL);
        slackRequests += input === SLACK_URL ? 1 : 0;
        return jsonResponse({
          checkpoint_us: 1,
          reconciliation_version: 5,
          resume_from_us: null,
          pending_trace_ids: null,
          pending_trace_total: 0,
          pending_trace_oldest_us: null,
        });
      },
    }),
    /Relay reconciliation checkpoint is malformed/,
  );
  assert.equal(slackRequests, 0);
});

test("uses the authenticated v2 bridge while the old Worker is still live", async () => {
  const now = Date.parse("2026-08-04T08:00:00.000Z");
  const initialAnchor = (now - 20 * 60 * 1_000) * 1_000;
  let report;
  const result = await monitorSlackWorkflow({
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
      assert.equal(input, RECONCILIATION_URL);
      report = assertBridgeReconciliationRequest(init);
      return jsonResponse({
        ok: true,
        traces: report.traces.length,
        checkpoint_us: report.checkpoint_us,
      });
    },
  });
  assert.equal(report.checkpoint_us, initialAnchor);
  assert.deepEqual(report.traces, []);
  assert.deepEqual(result, {
    caughtUp: true,
    errors: 0,
    pages: 1,
    traces: 0,
  });
});

test("fails closed on an error trace reported through the v2 bridge", async () => {
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
        if (input === SLACK_URL) {
          return jsonResponse({
            ok: true,
            activities: [
              {
                level: "info",
                event_type: "workflow_execution_started",
                created,
                trace_id: "TrBridgeError1",
                payload: {},
              },
              {
                level: "error",
                event_type: "workflow_step_execution_result",
                created: created + 1,
                trace_id: "TrBridgeError1",
                payload: {
                  exec_outcome: "Error",
                  function_execution_id: "FxBridgeError1",
                  inputs: signedValidatorInputs("delivery-bridge-error-1"),
                },
              },
              {
                level: "error",
                event_type: "workflow_execution_result",
                created: created + 2,
                trace_id: "TrBridgeError1",
                payload: { exec_outcome: "Error" },
              },
            ],
            response_metadata: { next_cursor: "" },
          });
        }
        report = assertBridgeReconciliationRequest(init);
        return jsonResponse({
          ok: true,
          traces: report.traces.length,
          checkpoint_us: report.checkpoint_us,
        });
      },
    }),
    /recorded 1 new or uncorrelated workflow error/,
  );
  assert.equal(report.traces.length, 1);
  assert.equal(report.traces[0].outcome, "error");
});

test("retains v3-only message evidence until the new Worker is live", async () => {
  const now = Date.parse("2026-08-04T08:00:00.000Z");
  const created = now * 1_000 - 10;
  const traceId = "TrBridgeMessageEvidence1";
  const boundaryFunctionId = "FnBridgeMessageBoundary1";
  let report;
  await assert.rejects(
    monitorSlackWorkflow({
      environment,
      now: () => now,
      fetchImpl: async (input, init) => {
        if (input === CHECKPOINT_URL) {
          return jsonResponse({ checkpoint_us: 0 });
        }
        if (input === SLACK_URL) {
          const step = (
            offset,
            current_step,
            function_id,
            function_execution_id,
          ) => ({
            level: "info",
            event_type: "workflow_step_started",
            created: created + offset,
            trace_id: traceId,
            payload: {
              current_step,
              total_steps: 4,
              function_id,
              function_execution_id,
            },
          });
          const result = (
            offset,
            function_id,
            function_execution_id,
            outputs,
          ) => ({
            level: "info",
            event_type: "workflow_step_execution_result",
            created: created + offset,
            trace_id: traceId,
            payload: {
              exec_outcome: "Success",
              function_id,
              function_execution_id,
              ...(outputs === undefined ? {} : { outputs }),
            },
          });
          return jsonResponse({
            ok: true,
            activities: [
              {
                level: "info",
                event_type: "workflow_execution_started",
                created,
                trace_id: traceId,
                payload: {},
              },
              step(1, 2, boundaryFunctionId, "FxBridgeMessageBoundary1"),
              result(2, boundaryFunctionId, "FxBridgeMessageBoundary1"),
              step(3, 3, "Fn0102", "FxBridgeMessageSend1"),
              result(4, "Fn0102", "FxBridgeMessageSend1", {
                channel_id: "C0BMUK793NV",
                message_ts: "1785830400.123456",
              }),
              step(5, 4, boundaryFunctionId, "FxBridgeMessageReceipt1"),
              result(6, boundaryFunctionId, "FxBridgeMessageReceipt1"),
              {
                level: "info",
                event_type: "workflow_execution_result",
                created: created + 7,
                trace_id: traceId,
                payload: { exec_outcome: "Success" },
              },
            ],
            response_metadata: { next_cursor: "" },
          });
        }
        report = assertBridgeReconciliationRequest(init);
        return jsonResponse({
          ok: true,
          traces: report.traces.length,
          checkpoint_us: report.checkpoint_us,
        });
      },
    }),
    /retained 1 trace until relay reconciliation v3 or newer becomes available/,
  );
  assert.equal(report.checkpoint_us, 0);
  assert.deepEqual(report.traces, []);
});

test("retains a successful receipt-less trace until the v3 Worker is live", async () => {
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
        if (input === SLACK_URL) {
          return jsonResponse({
            ok: true,
            activities: [
              {
                level: "info",
                event_type: "workflow_execution_started",
                created,
                trace_id: "TrBridgeReceiptlessSuccess1",
                payload: {},
              },
              {
                level: "info",
                event_type: "workflow_step_execution_result",
                created: created + 1,
                trace_id: "TrBridgeReceiptlessSuccess1",
                payload: {
                  exec_outcome: "Success",
                  function_execution_id: "FxBridgeReceiptlessSuccess1",
                  inputs: signedProgressInputs(
                    "delivery-bridge-receiptless-success-1",
                  ),
                },
              },
              {
                level: "info",
                event_type: "workflow_execution_result",
                created: created + 2,
                trace_id: "TrBridgeReceiptlessSuccess1",
                payload: { exec_outcome: "Success" },
              },
            ],
            response_metadata: { next_cursor: "" },
          });
        }
        report = assertBridgeReconciliationRequest(init);
        return jsonResponse({
          ok: true,
          traces: report.traces.length,
          checkpoint_us: report.checkpoint_us,
        });
      },
    }),
    /retained 1 trace until relay reconciliation v3 or newer becomes available/,
  );
  assert.equal(report.checkpoint_us, 0);
  assert.deepEqual(report.traces, []);
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
        return checkpointResponse(0);
      }
      if (input === SLACK_URL) {
        return jsonResponse({
          ok: true,
          activities: [],
          response_metadata: { next_cursor: "" },
        });
      }
      report = assertReconciliationRequest(init);
      return acceptedReconciliationResponse(report);
    },
  });
  assert.equal(report.checkpoint_us, initialAnchor);

  const later = now + 2 * 60 * 60 * 1_000;
  await monitorSlackWorkflow({
    environment,
    now: () => later,
    fetchImpl: async (input, init) => {
      if (input === CHECKPOINT_URL) {
        return checkpointResponse(initialAnchor);
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
      return acceptedReconciliationResponse(secondReport);
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
        return checkpointResponse(created - 10_000);
      }
      if (input === RECONCILIATION_URL) {
        const report = assertReconciliationRequest(init);
        reports.push(report);
        return acceptedReconciliationResponse(report);
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
                function_execution_id: "FxMonitorPagedSend1",
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

  assert.deepEqual(result, {
    caughtUp: true,
    errors: 0,
    pages: 2,
    traces: 1,
  });
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0].traces, [
    {
      trace_id: "TrPaged1",
      delivery_id: "delivery-paged-1",
      outcome: "success",
      relay_attempt: "1",
      send_execution_id: "FxMonitorPagedSend1",
      slack_channel_id: null,
      slack_message_ts: null,
      send_boundary_reached: true,
      pre_send_failure_proven: false,
      started_at_us: created,
      completed_at_us: created + 2,
    },
  ]);
  assert.ok(!JSON.stringify(reports).includes("must-not-leak"));
});

test("reconciles a bounded prefix before requiring the next run", async () => {
  const now = Date.parse("2026-08-14T06:11:06.000Z");
  const previousCheckpointUs = now * 1_000 - 60 * 60 * 1_000 * 1_000;
  const firstCreated = previousCheckpointUs + 1;
  const reports = [];
  let slackRequests = 0;

  await assert.rejects(
    monitorSlackWorkflow({
      environment,
      now: () => now,
      fetchImpl: async (input, init) => {
        if (input === CHECKPOINT_URL) {
          return checkpointResponseV4(previousCheckpointUs);
        }
        if (input === RECONCILIATION_URL) {
          const report = assertReconciliationV4Request(init);
          reports.push(report);
          return acceptedReconciliationResponse(report);
        }
        assert.equal(input, SLACK_URL);
        slackRequests += 1;
        assert.ok(
          slackRequests <= 100,
          "the bounded catch-up must not request page 101",
        );
        const created = firstCreated + slackRequests - 1;
        const activities =
          slackRequests === 100
            ? Array.from({ length: 26 }, (_, index) => {
                const suffix = String(index + 1).padStart(3, "0");
                const traceCreated = created + index * 2;
                return [
                  {
                    level: "info",
                    event_type: "workflow_execution_started",
                    component_type: "workflows",
                    created: traceCreated,
                    trace_id: `TrBoundedPrefix${suffix}`,
                    payload: {},
                  },
                  {
                    level: "info",
                    event_type: "workflow_step_execution_result",
                    component_type: "workflows",
                    created: traceCreated + 1,
                    trace_id: `TrBoundedPrefix${suffix}`,
                    payload: {
                      exec_outcome: "Success",
                      function_execution_id: `FxBoundedPrefix${suffix}`,
                      inputs: signedProgressInputs(
                        `delivery-bounded-prefix-${suffix}`,
                        "send_started",
                        "alerts",
                        String(Math.floor(traceCreated / 1_000_000)),
                      ),
                    },
                  },
                ];
              }).flat()
            : [
                {
                  level: "info",
                  event_type: "workflow_published",
                  component_type: "workflows",
                  created,
                  payload: { workflow_name: "GitHub activity" },
                },
              ];
        return jsonResponse({
          ok: true,
          activities,
          response_metadata: { next_cursor: `cursor-${slackRequests + 1}` },
        });
      },
    }),
    /catch-up acknowledged durable checkpoint progress after 100 pages/,
  );

  assert.equal(slackRequests, 100);
  assert.deepEqual(
    reports.map((report) => report.traces.length),
    [25, 1],
  );
  assert.equal(reports[0].checkpoint_us, previousCheckpointUs);
  assert.equal(reports[1].checkpoint_us, firstCreated + 99);
  assert.deepEqual(
    reports.map((report) => report.scan_state),
    ["preserve", "resume"],
  );
  const reportedTraces = reports.flatMap((report) => report.traces);
  assert.equal(reportedTraces.length, 26);
  assert.deepEqual(reportedTraces[0], {
    trace_id: "TrBoundedPrefix001",
    delivery_id: "delivery-bounded-prefix-001",
    outcome: "pending",
    relay_attempt: "1",
    send_execution_id: "FxBoundedPrefix001",
    slack_channel_id: null,
    slack_message_ts: null,
    send_boundary_reached: true,
    pre_send_failure_proven: false,
    started_at_us: firstCreated + 99,
    completed_at_us: null,
  });
  assert.equal(reportedTraces[25].trace_id, "TrBoundedPrefix026");
  assert.equal(reportedTraces[25].started_at_us, firstCreated + 149);
});

test("a second run resumes after the acknowledged bounded prefix instead of replaying the overlap", async () => {
  const firstNow = Date.parse("2026-08-14T06:11:06.000Z");
  const secondNow = firstNow + 15 * 60 * 1_000;
  const initialCheckpointUs = firstNow * 1_000 - 60 * 60 * 1_000 * 1_000;
  const firstCreated = initialCheckpointUs + 1;
  let durableCheckpointUs = initialCheckpointUs;
  let resumeFromUs = null;
  let run = 1;
  let firstRunSlackRequests = 0;
  let secondRunSlackRequests = 0;
  const requestedMinimums = [];
  const scanStates = [];

  const fetchImpl = async (input, init) => {
    if (input === CHECKPOINT_URL) {
      return checkpointResponseV4(durableCheckpointUs, resumeFromUs);
    }
    if (input === RECONCILIATION_URL) {
      const report = assertReconciliationV4Request(init);
      scanStates.push(report.scan_state);
      durableCheckpointUs = report.checkpoint_us;
      if (report.scan_state === "resume") {
        resumeFromUs = durableCheckpointUs;
      } else if (report.scan_state === "complete") {
        resumeFromUs = null;
      }
      return jsonResponse({
        ok: true,
        traces: report.traces.length,
        changed_error_traces: 0,
        checkpoint_us: durableCheckpointUs,
      });
    }
    assert.equal(input, SLACK_URL);
    const form = Object.fromEntries(init.body);
    requestedMinimums.push(Number(form.min_date_created));
    if (run === 1) {
      firstRunSlackRequests += 1;
      assert.ok(firstRunSlackRequests <= 100);
      return jsonResponse({
        ok: true,
        activities: [
          {
            level: "info",
            event_type: "workflow_published",
            component_type: "workflows",
            created: firstCreated + firstRunSlackRequests - 1,
            payload: { workflow_name: "GitHub activity" },
          },
        ],
        response_metadata: {
          next_cursor: `first-run-cursor-${firstRunSlackRequests + 1}`,
        },
      });
    }
    secondRunSlackRequests += 1;
    assert.equal(form.cursor, undefined);
    return jsonResponse({
      ok: true,
      activities: [
        {
          level: "info",
          event_type: "workflow_published",
          component_type: "workflows",
          created: resumeFromUs,
          payload: { workflow_name: "GitHub activity" },
        },
        {
          level: "info",
          event_type: "workflow_published",
          component_type: "workflows",
          created: resumeFromUs + 1,
          payload: { workflow_name: "GitHub alerts" },
        },
      ],
      response_metadata: { next_cursor: "" },
    });
  };

  await assert.rejects(
    monitorSlackWorkflow({
      environment,
      now: () => firstNow,
      fetchImpl,
    }),
    /catch-up acknowledged durable checkpoint progress after 100 pages/,
  );
  assert.equal(firstRunSlackRequests, 100);
  const acknowledgedPrefixUs = firstCreated + 99;
  assert.equal(durableCheckpointUs, acknowledgedPrefixUs);
  assert.equal(resumeFromUs, acknowledgedPrefixUs);

  run = 2;
  const result = await monitorSlackWorkflow({
    environment,
    now: () => secondNow,
    fetchImpl,
  });

  assert.equal(secondRunSlackRequests, 1);
  assert.equal(
    requestedMinimums[0],
    initialCheckpointUs - 20 * 60 * 1_000 * 1_000,
  );
  assert.equal(requestedMinimums.at(-1), acknowledgedPrefixUs);
  assert.deepEqual(scanStates, ["resume", "complete"]);
  assert.deepEqual(result, {
    caughtUp: true,
    errors: 0,
    pages: 1,
    traces: 0,
  });
  assert.equal(resumeFromUs, null);
  assert.equal(durableCheckpointUs, acknowledgedPrefixUs + 1);
});

test("hydrates the terminal after a page-100 start without requesting temporal page 101", async () => {
  const now = Date.parse("2026-08-14T06:11:06.000Z");
  const previousCheckpointUs = now * 1_000 - 60 * 60 * 1_000 * 1_000;
  const traceCreatedUs = previousCheckpointUs + 10_000;
  const traceId = "TrHydratePageBoundary1";
  const activities = hydrationTraceActivities({
    created: traceCreatedUs,
    deliveryId: "delivery-hydrate-page-boundary-1",
    traceId,
  });
  let temporalPages = 0;
  let hydrationPages = 0;
  let report;

  const fetchImpl = async (input, init) => {
    if (input === CHECKPOINT_URL) {
      return checkpointResponseV5({ checkpointUs: previousCheckpointUs });
    }
    if (input === RECONCILIATION_URL) {
      report = assertReconciliationV5Request(init);
      return acceptedReconciliationResponse(report);
    }
    assert.equal(input, SLACK_URL);
    const form = Object.fromEntries(init.body);
    if (form.trace_id === traceId) {
      hydrationPages += 1;
      assert.equal(form.min_date_created, undefined);
      assert.equal(form.max_date_created, undefined);
      assert.equal(form.cursor, undefined);
      return jsonResponse({
        ok: true,
        activities: [
          activities.start,
          activities.boundary,
          activities.terminal,
        ],
        response_metadata: { next_cursor: "" },
      });
    }
    temporalPages += 1;
    assert.ok(temporalPages <= 100, "temporal page 101 must never be fetched");
    return jsonResponse({
      ok: true,
      activities:
        temporalPages === 100
          ? [activities.start, activities.boundary]
          : [
              {
                level: "info",
                event_type: "workflow_published",
                component_type: "workflows",
                created: previousCheckpointUs + temporalPages,
                payload: { workflow_name: "GitHub activity" },
              },
            ],
      response_metadata: { next_cursor: `temporal-${temporalPages + 1}` },
    });
  };

  await assert.rejects(
    monitorSlackWorkflow({ environment, fetchImpl, now: () => now }),
    /catch-up acknowledged durable checkpoint progress after 100 pages/,
  );
  assert.equal(temporalPages, 100);
  assert.equal(hydrationPages, 1);
  assert.equal(report.scan_state, "resume");
  assert.equal(report.checkpoint_us, traceCreatedUs + 1);
  assert.deepEqual(report.hydrations, []);
  assert.equal(report.traces.length, 1);
  assert.equal(report.traces[0].trace_id, traceId);
  assert.equal(report.traces[0].outcome, "success");
});

test("hydrates a suffix-only trace behind the durable checkpoint without regressing it", async () => {
  const now = Date.parse("2026-08-14T06:11:06.000Z");
  const checkpointUs = now * 1_000 - 60 * 1_000 * 1_000;
  const traceCreatedUs = checkpointUs - 10_000;
  const traceId = "TrHydrateSuffixOnly1";
  const activities = hydrationTraceActivities({
    created: traceCreatedUs,
    deliveryId: "delivery-hydrate-suffix-only-1",
    traceId,
  });
  let report;
  let hydrationRequests = 0;

  const result = await monitorSlackWorkflow({
    environment,
    now: () => now,
    fetchImpl: async (input, init) => {
      if (input === CHECKPOINT_URL) {
        return checkpointResponseV5({ checkpointUs });
      }
      if (input === RECONCILIATION_URL) {
        report = assertReconciliationV5Request(init);
        return acceptedReconciliationResponse(report);
      }
      assert.equal(input, SLACK_URL);
      const form = Object.fromEntries(init.body);
      if (form.trace_id === traceId) {
        hydrationRequests += 1;
        assert.equal(form.min_date_created, undefined);
        assert.equal(form.max_date_created, undefined);
        return jsonResponse({
          ok: true,
          activities: [
            activities.start,
            activities.boundary,
            activities.terminal,
          ],
          response_metadata: { next_cursor: "" },
        });
      }
      return jsonResponse({
        ok: true,
        activities: [activities.terminal],
        response_metadata: { next_cursor: "" },
      });
    },
  });

  assert.equal(hydrationRequests, 1);
  assert.equal(report.checkpoint_us, checkpointUs);
  assert.equal(report.traces[0].started_at_us, traceCreatedUs);
  assert.equal(report.traces[0].completed_at_us, traceCreatedUs + 2);
  assert.deepEqual(result, { caughtUp: true, errors: 0, pages: 1, traces: 1 });
});

test("paginates a trace hydration independently without temporal bounds", async () => {
  const now = Date.parse("2026-08-14T06:11:06.000Z");
  const checkpointUs = now * 1_000 - 60 * 1_000 * 1_000;
  const traceId = "TrHydrateCursor1";
  const activities = hydrationTraceActivities({
    created: checkpointUs - 1_000,
    deliveryId: "delivery-hydrate-cursor-1",
    traceId,
  });
  const hydrationCursors = [];

  await monitorSlackWorkflow({
    environment,
    now: () => now,
    fetchImpl: async (input, init) => {
      if (input === CHECKPOINT_URL) {
        return checkpointResponseV5({ checkpointUs });
      }
      if (input === RECONCILIATION_URL) {
        const report = assertReconciliationV5Request(init);
        return acceptedReconciliationResponse(report);
      }
      const form = Object.fromEntries(init.body);
      if (form.trace_id !== traceId) {
        return jsonResponse({
          ok: true,
          activities: [activities.terminal],
          response_metadata: { next_cursor: "" },
        });
      }
      assert.equal(form.min_date_created, undefined);
      assert.equal(form.max_date_created, undefined);
      hydrationCursors.push(form.cursor ?? null);
      return hydrationCursors.length === 1
        ? jsonResponse({
            ok: true,
            activities: [activities.start, activities.boundary],
            response_metadata: { next_cursor: "trace-page-2" },
          })
        : jsonResponse({
            ok: true,
            activities: [activities.terminal],
            response_metadata: { next_cursor: "" },
          });
    },
  });

  assert.deepEqual(hydrationCursors, [null, "trace-page-2"]);
});

test("deduplicates activities replayed by temporal scan and trace hydration", async () => {
  const now = Date.parse("2026-08-14T06:11:06.000Z");
  const checkpointUs = now * 1_000 - 60 * 1_000 * 1_000;
  const traceId = "TrHydrateExactReplay1";
  const activities = hydrationTraceActivities({
    created: checkpointUs + 1_000,
    deliveryId: "delivery-hydrate-exact-replay-1",
    traceId,
  });
  let hydrationPage = 0;
  let report;

  const result = await monitorSlackWorkflow({
    environment,
    now: () => now,
    fetchImpl: async (input, init) => {
      if (input === CHECKPOINT_URL) {
        return checkpointResponseV5({ checkpointUs });
      }
      if (input === RECONCILIATION_URL) {
        report = assertReconciliationV5Request(init);
        return acceptedReconciliationResponse(report);
      }
      const form = Object.fromEntries(init.body);
      if (form.trace_id !== traceId) {
        return jsonResponse({
          ok: true,
          activities: [activities.start, activities.boundary],
          response_metadata: { next_cursor: "" },
        });
      }
      hydrationPage += 1;
      return hydrationPage === 1
        ? jsonResponse({
            ok: true,
            activities: [activities.start, activities.boundary],
            response_metadata: { next_cursor: "exact-replay-page-2" },
          })
        : jsonResponse({
            ok: true,
            activities: [activities.boundary, activities.terminal],
            response_metadata: { next_cursor: "" },
          });
    },
  });

  assert.equal(hydrationPage, 2);
  assert.deepEqual(report.hydrations, []);
  assert.equal(report.traces.length, 1);
  assert.equal(report.traces[0].trace_id, traceId);
  assert.deepEqual(result, { caughtUp: true, errors: 0, pages: 1, traces: 1 });
});

test("preserves normalized trace ownership when hydration hits its pagination bound", async () => {
  const now = Date.parse("2026-08-14T06:11:06.000Z");
  const checkpointUs = now * 1_000 - 60 * 1_000 * 1_000;
  const traceId = "TrHydrationBoundOwnership1";
  const deliveryId = "delivery-hydration-bound-ownership-1";
  const activities = hydrationTraceActivities({
    created: checkpointUs + 1_000,
    deliveryId,
    traceId,
  });
  let hydrationPage = 0;
  let report;

  const result = await monitorSlackWorkflow({
    environment,
    now: () => now,
    fetchImpl: async (input, init) => {
      if (input === CHECKPOINT_URL) {
        return checkpointResponseV5({ checkpointUs });
      }
      if (input === RECONCILIATION_URL) {
        report = assertReconciliationV5Request(init);
        return acceptedReconciliationResponse(report);
      }
      const form = Object.fromEntries(init.body);
      if (form.trace_id === traceId) {
        hydrationPage += 1;
        return jsonResponse({
          ok: true,
          activities:
            hydrationPage === 1
              ? [activities.start, activities.boundary, activities.terminal]
              : [],
          response_metadata: {
            next_cursor: `hydration-bound-${hydrationPage + 1}`,
          },
        });
      }
      return jsonResponse({
        ok: true,
        activities: [activities.terminal],
        response_metadata: { next_cursor: "" },
      });
    },
  });

  assert.equal(hydrationPage, 2);
  assert.deepEqual(report.hydrations, []);
  assert.equal(report.traces.length, 1);
  assert.equal(report.traces[0].trace_id, traceId);
  assert.equal(report.traces[0].delivery_id, deliveryId);
  assert.equal(report.traces[0].outcome, "success");
  assert.deepEqual(result, { caughtUp: true, errors: 0, pages: 1, traces: 1 });
});

test("persists bounded pending ownership before durable pagination debt", async () => {
  const now = Date.parse("2026-08-14T06:11:06.000Z");
  const checkpointUs = now * 1_000 - 60 * 1_000 * 1_000;
  const traceId = "TrHydrationBoundPending1";
  const deliveryId = "delivery-hydration-bound-pending-1";
  const activities = hydrationTraceActivities({
    created: checkpointUs - 1_000,
    deliveryId,
    traceId,
  });
  const reports = [];
  let hydrationRequests = 0;
  let pendingTrace = true;

  const fetchImpl = async (input, init) => {
    if (input === CHECKPOINT_URL) {
      return checkpointResponseV5({
        checkpointUs,
        pendingTraceIds: pendingTrace ? [traceId] : [],
        pendingTraceOldestUs: pendingTrace ? activities.start.created : null,
      });
    }
    if (input === RECONCILIATION_URL) {
      const report = assertReconciliationV5Request(init);
      reports.push(report);
      if (
        report.hydrations.some(
          (hydration) =>
            hydration.trace_id === traceId &&
            hydration.status === "debt" &&
            hydration.debt_reason === "pagination_bound",
        )
      ) {
        pendingTrace = false;
      }
      return acceptedReconciliationResponse(report);
    }
    assert.equal(input, SLACK_URL);
    const form = Object.fromEntries(init.body);
    if (form.trace_id === traceId) {
      hydrationRequests += 1;
      return hydrationRequests % 2 === 1
        ? jsonResponse({
            ok: true,
            activities: [activities.start, activities.boundary],
            response_metadata: { next_cursor: "pending-bound-page-2" },
          })
        : jsonResponse({
            ok: true,
            activities: [],
            response_metadata: { next_cursor: "pending-bound-page-3" },
          });
    }
    return jsonResponse({
      ok: true,
      activities: [],
      response_metadata: { next_cursor: "" },
    });
  };

  await monitorSlackWorkflow({ environment, fetchImpl, now: () => now });
  await monitorSlackWorkflow({ environment, fetchImpl, now: () => now + 1 });

  assert.equal(hydrationRequests, 2);
  assert.equal(reports.length, 3);
  const [ownershipReport, debtReport, replayReport] = reports;
  assert.equal(ownershipReport.checkpoint_us, checkpointUs);
  assert.equal(ownershipReport.scan_state, "preserve");
  assert.deepEqual(ownershipReport.hydrations, []);
  assert.equal(ownershipReport.traces.length, 1);
  assert.equal(ownershipReport.traces[0].trace_id, traceId);
  assert.equal(ownershipReport.traces[0].delivery_id, deliveryId);
  assert.equal(ownershipReport.traces[0].outcome, "pending");
  assert.equal(debtReport.checkpoint_us, checkpointUs);
  assert.equal(debtReport.scan_state, "complete");
  assert.deepEqual(debtReport.traces, []);
  assert.deepEqual(debtReport.hydrations, [
    {
      trace_id: traceId,
      first_observed_us: activities.start.created,
      last_observed_us: activities.boundary.created,
      status: "debt",
      debt_reason: "pagination_bound",
      attempted: true,
    },
  ]);
  assert.deepEqual(replayReport.traces, []);
  assert.deepEqual(replayReport.hydrations, []);
  for (const report of reports) {
    const hydrationIds = new Set(
      report.hydrations.map((hydration) => hydration.trace_id),
    );
    assert.equal(
      report.traces.some((trace) => hydrationIds.has(trace.trace_id)),
      false,
    );
  }
});

test("separates a terminal trace from same-delivery hydration debt", async () => {
  const now = Date.parse("2026-08-14T06:11:06.000Z");
  const checkpointUs = now * 1_000 - 60 * 1_000 * 1_000;
  const deliveryId = "delivery-mixed-trace-hydration-1";
  const pendingTraceId = "TrMixedHydrationPending1";
  const terminalTraceId = "TrMixedHydrationTerminal1";
  const pendingActivities = hydrationTraceActivities({
    created: checkpointUs - 1_000,
    deliveryId,
    traceId: pendingTraceId,
  });
  const terminalActivities = hydrationTraceActivities({
    created: checkpointUs + 1_000,
    deliveryId,
    traceId: terminalTraceId,
  });
  const reports = [];
  let hydrationPage = 0;

  await monitorSlackWorkflow({
    environment,
    now: () => now,
    fetchImpl: async (input, init) => {
      if (input === CHECKPOINT_URL) {
        return checkpointResponseV5({
          checkpointUs,
          pendingTraceIds: [pendingTraceId],
          pendingTraceOldestUs: pendingActivities.start.created,
        });
      }
      if (input === RECONCILIATION_URL) {
        const report = assertReconciliationV5Request(init);
        reports.push(report);
        return acceptedReconciliationResponse(report);
      }
      assert.equal(input, SLACK_URL);
      const form = Object.fromEntries(init.body);
      if (form.trace_id === pendingTraceId) {
        hydrationPage += 1;
        return hydrationPage === 1
          ? jsonResponse({
              ok: true,
              activities: [pendingActivities.start, pendingActivities.boundary],
              response_metadata: { next_cursor: "mixed-hydration-page-2" },
            })
          : jsonResponse({
              ok: true,
              activities: [],
              response_metadata: { next_cursor: "mixed-hydration-page-3" },
            });
      }
      return jsonResponse({
        ok: true,
        activities: [
          terminalActivities.start,
          terminalActivities.boundary,
          terminalActivities.terminal,
        ],
        response_metadata: { next_cursor: "" },
      });
    },
  });

  assert.equal(hydrationPage, 2);
  assert.equal(reports.length, 2);
  const [traceReport, debtReport] = reports;
  assert.deepEqual(traceReport.hydrations, []);
  assert.deepEqual(
    traceReport.traces.map((trace) => trace.trace_id),
    [pendingTraceId, terminalTraceId],
  );
  assert.equal(traceReport.scan_state, "preserve");
  assert.deepEqual(debtReport.traces, []);
  assert.deepEqual(
    debtReport.hydrations.map((hydration) => [
      hydration.trace_id,
      hydration.status,
      hydration.debt_reason,
    ]),
    [[pendingTraceId, "debt", "pagination_bound"]],
  );
  assert.equal(debtReport.scan_state, "complete");
});

test("does not register a complete legacy workflow for hydration", async () => {
  const now = Date.parse("2026-08-14T06:11:06.000Z");
  const checkpointUs = now * 1_000 - 60 * 1_000 * 1_000;
  const traceId = "TrLegacyHydrationRegistry1";
  const activities = legacyTraceActivities({
    created: checkpointUs + 1_000,
    traceId,
  });
  let report;
  let hydrationRequests = 0;

  const result = await monitorSlackWorkflow({
    environment,
    now: () => now,
    fetchImpl: async (input, init) => {
      if (input === CHECKPOINT_URL) {
        return checkpointResponseV5({ checkpointUs });
      }
      if (input === RECONCILIATION_URL) {
        report = assertReconciliationV5Request(init);
        return acceptedReconciliationResponse(report);
      }
      const form = Object.fromEntries(init.body);
      if (form.trace_id === traceId) hydrationRequests += 1;
      return jsonResponse({
        ok: true,
        activities,
        response_metadata: { next_cursor: "" },
      });
    },
  });

  assert.equal(hydrationRequests, 0);
  assert.deepEqual(report.hydrations, []);
  assert.deepEqual(report.traces, []);
  assert.deepEqual(result, { caughtUp: true, errors: 0, pages: 1, traces: 0 });
});

test("removes a persisted hydration after confirming a legacy workflow", async () => {
  const now = Date.parse("2026-08-14T06:11:06.000Z");
  const checkpointUs = now * 1_000 - 60 * 1_000 * 1_000;
  const traceId = "TrPersistedLegacyHydration1";
  const activities = legacyTraceActivities({
    created: checkpointUs + 1_000,
    traceId,
  });
  let hydrationRequests = 0;
  let report;

  const result = await monitorSlackWorkflow({
    environment,
    now: () => now,
    fetchImpl: async (input, init) => {
      if (input === CHECKPOINT_URL) {
        return checkpointResponseV5({
          checkpointUs,
          pendingTraceIds: [traceId],
          pendingTraceOldestUs: activities[0].created,
        });
      }
      if (input === RECONCILIATION_URL) {
        report = assertReconciliationV5Request(init);
        return acceptedReconciliationResponse(report);
      }
      assert.equal(input, SLACK_URL);
      const form = Object.fromEntries(init.body);
      if (form.trace_id === traceId) hydrationRequests += 1;
      return jsonResponse({
        ok: true,
        activities,
        response_metadata: { next_cursor: "" },
      });
    },
  });

  assert.equal(hydrationRequests, 0);
  assert.deepEqual(report.traces, []);
  assert.deepEqual(report.hydrations, [
    {
      trace_id: traceId,
      first_observed_us: activities[0].created,
      last_observed_us: activities.at(-1).created,
      status: "legacy",
      debt_reason: null,
      attempted: false,
    },
  ]);
  assert.equal(report.scan_state, "complete");
  assert.equal(report.checkpoint_us, activities.at(-1).created);
  assert.deepEqual(result, { caughtUp: true, errors: 0, pages: 1, traces: 0 });
});

test("reports attempted normalized pending hydrations without registering unattempted traces", async () => {
  const now = Date.parse("2026-08-14T06:11:06.000Z");
  const checkpointUs = now * 1_000 - 60 * 1_000 * 1_000;
  const traceIds = [
    "TrHydrationFairness1",
    "TrHydrationFairness2",
    "TrHydrationFairness3",
  ];
  const activitiesByTrace = new Map(
    traceIds.map((traceId, index) => [
      traceId,
      hydrationTraceActivities({
        created: checkpointUs + index * 10 + 1,
        deliveryId: `delivery-hydration-fairness-${index + 1}`,
        traceId,
      }),
    ]),
  );
  const fetchedTraceIds = [];
  const reports = [];

  let monitorError = null;
  try {
    await monitorSlackWorkflow({
      environment,
      now: () => now,
      fetchImpl: async (input, init) => {
        if (input === CHECKPOINT_URL) {
          return checkpointResponseV5({ checkpointUs });
        }
        if (input === RECONCILIATION_URL) {
          const report = assertReconciliationV5Request(init);
          reports.push(report);
          return acceptedReconciliationResponse(report);
        }
        const form = Object.fromEntries(init.body);
        if (form.trace_id !== undefined) {
          fetchedTraceIds.push(form.trace_id);
          const traceActivities = activitiesByTrace.get(form.trace_id);
          return jsonResponse({
            ok: true,
            activities: [traceActivities.start, traceActivities.boundary],
            response_metadata: { next_cursor: "" },
          });
        }
        return jsonResponse({
          ok: true,
          activities: [...activitiesByTrace.values()].flatMap(
            ({ start, boundary }) => [start, boundary],
          ),
          response_metadata: { next_cursor: "" },
        });
      },
    });
  } catch (error) {
    monitorError = error;
  }

  assert.deepEqual(fetchedTraceIds, traceIds.slice(0, 2));
  assert.equal(reports.length, 2);
  const [traceReport, hydrationReport] = reports;
  assert.deepEqual(
    traceReport.traces.map((trace) => trace.trace_id),
    traceIds,
  );
  assert.deepEqual(traceReport.hydrations, []);
  assert.equal(traceReport.scan_state, "preserve");
  assert.deepEqual(hydrationReport.traces, []);
  assert.deepEqual(
    hydrationReport.hydrations.map(({ trace_id: traceId, attempted }) => ({
      traceId,
      attempted,
    })),
    traceIds.slice(0, 2).map((traceId) => ({ traceId, attempted: true })),
  );
  assert.equal(hydrationReport.scan_state, "complete");
  assert.match(String(monitorError), /trace hydration remains incomplete/);
});

test("persists completed hydration attempts before surfacing a later hydration failure", async () => {
  const now = Date.parse("2026-08-14T06:11:06.000Z");
  const checkpointUs = now * 1_000 - 60 * 1_000 * 1_000;
  const firstTraceId = "TrHydrationCompletedBeforeFailure1";
  const failingTraceId = "TrHydrationFailureAfterCompleted2";
  const firstActivities = hydrationTraceActivities({
    created: checkpointUs - 1_000,
    deliveryId: "delivery-hydration-completed-before-failure-1",
    traceId: firstTraceId,
  });
  const hydratedTraceIds = [];
  const reports = [];

  let monitorError = null;
  try {
    await monitorSlackWorkflow({
      environment,
      now: () => now,
      fetchImpl: async (input, init) => {
        if (input === CHECKPOINT_URL) {
          return checkpointResponseV5({
            checkpointUs,
            pendingTraceIds: [firstTraceId, failingTraceId],
            pendingTraceOldestUs: firstActivities.start.created,
          });
        }
        if (input === RECONCILIATION_URL) {
          const report = assertReconciliationV5Request(init);
          reports.push(report);
          return acceptedReconciliationResponse(report);
        }
        assert.equal(input, SLACK_URL);
        const form = Object.fromEntries(init.body);
        if (form.trace_id === undefined) {
          return jsonResponse({
            ok: true,
            activities: [],
            response_metadata: { next_cursor: "" },
          });
        }
        hydratedTraceIds.push(form.trace_id);
        if (form.trace_id === firstTraceId) {
          return jsonResponse({
            ok: true,
            activities: [firstActivities.start, firstActivities.boundary],
            response_metadata: { next_cursor: "" },
          });
        }
        assert.equal(form.trace_id, failingTraceId);
        return jsonResponse({
          ok: true,
          activities: null,
          response_metadata: { next_cursor: "" },
        });
      },
    });
  } catch (error) {
    monitorError = error;
  }

  assert.deepEqual(hydratedTraceIds, [firstTraceId, failingTraceId]);
  assert.equal(reports.length, 2);
  assert.deepEqual(
    reports[0].traces.map((trace) => [trace.trace_id, trace.outcome]),
    [[firstTraceId, "pending"]],
  );
  assert.deepEqual(reports[0].hydrations, []);
  assert.equal(reports[0].scan_state, "preserve");
  assert.deepEqual(reports[1].traces, []);
  assert.deepEqual(
    reports[1].hydrations.map(({ trace_id: traceId, status, attempted }) => ({
      traceId,
      status,
      attempted,
    })),
    [firstTraceId, failingTraceId].map((traceId) => ({
      traceId,
      status: "pending",
      attempted: true,
    })),
  );
  assert.equal(reports[1].checkpoint_us, checkpointUs);
  assert.match(
    String(monitorError),
    /Slack activity API returned a malformed activities collection/,
  );
});

test("does not advance the checkpoint while trace hydration remains unresolved", async () => {
  const now = Date.parse("2026-08-14T06:11:06.000Z");
  const checkpointUs = now * 1_000 - 60 * 1_000 * 1_000;
  const traceId = "TrHydrateUnresolved1";
  const terminal = {
    level: "info",
    event_type: "workflow_execution_result",
    component_type: "workflows",
    created: checkpointUs + 1_000,
    trace_id: traceId,
    payload: { exec_outcome: "Success" },
  };
  let report;

  await assert.rejects(
    monitorSlackWorkflow({
      environment,
      now: () => now,
      fetchImpl: async (input, init) => {
        if (input === CHECKPOINT_URL) {
          return checkpointResponseV5({ checkpointUs });
        }
        if (input === RECONCILIATION_URL) {
          report = assertReconciliationV5Request(init);
          return acceptedReconciliationResponse(report);
        }
        return jsonResponse({
          ok: true,
          activities: [terminal],
          response_metadata: { next_cursor: "" },
        });
      },
    }),
    /trace hydration remains incomplete/,
  );

  assert.equal(report.checkpoint_us, checkpointUs);
  assert.deepEqual(report.traces, []);
  assert.deepEqual(report.hydrations, [
    {
      trace_id: traceId,
      first_observed_us: terminal.created,
      last_observed_us: terminal.created,
      status: "pending",
      debt_reason: null,
      attempted: true,
    },
  ]);
});

test("resumes before a pending trace start so the terminal suffix can complete it", async () => {
  const firstNow = Date.parse("2026-08-14T06:11:06.000Z");
  const secondNow = firstNow + 15 * 60 * 1_000;
  const initialCheckpointUs = firstNow * 1_000 - 60 * 60 * 1_000 * 1_000;
  const traceStartedAtUs = initialCheckpointUs + 1_000;
  const traceId = "TrBoundarySplit1";
  const deliveryId = "delivery-boundary-split-1";
  let durableCheckpointUs = initialCheckpointUs;
  let resumeFromUs = null;
  let durableTrace = null;
  let run = 1;
  let firstRunSlackRequests = 0;
  let secondRunSlackRequests = 0;
  const requestedMinimums = [];
  const reports = [];

  const startActivity = {
    level: "info",
    event_type: "workflow_execution_started",
    component_type: "workflows",
    created: traceStartedAtUs,
    trace_id: traceId,
    payload: { workflow_name: "GitHub activity" },
  };
  const boundaryActivity = {
    level: "info",
    event_type: "workflow_step_execution_result",
    component_type: "workflows",
    created: traceStartedAtUs + 1,
    trace_id: traceId,
    payload: {
      exec_outcome: "Success",
      function_execution_id: "FxBoundarySplit1",
      inputs: signedProgressInputs(
        deliveryId,
        "send_started",
        "alerts",
        String(Math.floor(traceStartedAtUs / 1_000_000)),
      ),
    },
  };
  const terminalActivity = {
    level: "info",
    event_type: "workflow_execution_result",
    component_type: "workflows",
    created: traceStartedAtUs + 2,
    trace_id: traceId,
    payload: { exec_outcome: "Success" },
  };

  const fetchImpl = async (input, init) => {
    if (input === CHECKPOINT_URL) {
      return checkpointResponseV4(durableCheckpointUs, resumeFromUs);
    }
    if (input === RECONCILIATION_URL) {
      const report = assertReconciliationV4Request(init);
      reports.push(report);
      for (const trace of report.traces) {
        if (trace.trace_id === traceId) durableTrace = structuredClone(trace);
      }
      durableCheckpointUs = report.checkpoint_us;
      if (report.scan_state === "resume") {
        resumeFromUs = durableCheckpointUs;
      } else if (report.scan_state === "complete") {
        resumeFromUs = null;
      }
      return acceptedReconciliationResponse(report);
    }
    assert.equal(input, SLACK_URL);
    const form = Object.fromEntries(init.body);
    const minimum = Number(form.min_date_created);
    requestedMinimums.push(minimum);
    if (run === 1) {
      firstRunSlackRequests += 1;
      assert.ok(firstRunSlackRequests <= 100);
      return jsonResponse({
        ok: true,
        activities:
          firstRunSlackRequests === 100
            ? [startActivity, boundaryActivity]
            : [
                {
                  level: "info",
                  event_type: "workflow_published",
                  component_type: "workflows",
                  created: initialCheckpointUs + firstRunSlackRequests,
                  payload: { workflow_name: "GitHub activity" },
                },
              ],
        response_metadata: {
          next_cursor: `split-cursor-${firstRunSlackRequests + 1}`,
        },
      });
    }
    secondRunSlackRequests += 1;
    assert.equal(form.cursor, undefined);
    return jsonResponse({
      ok: true,
      activities: [
        ...(minimum <= traceStartedAtUs ? [startActivity] : []),
        ...(minimum <= traceStartedAtUs + 1 ? [boundaryActivity] : []),
        terminalActivity,
      ],
      response_metadata: { next_cursor: "" },
    });
  };

  await assert.rejects(
    monitorSlackWorkflow({
      environment,
      now: () => firstNow,
      fetchImpl,
    }),
    /catch-up acknowledged durable checkpoint progress after 100 pages/,
  );
  assert.equal(firstRunSlackRequests, 100);
  assert.equal(durableTrace?.outcome, "pending");

  run = 2;
  const result = await monitorSlackWorkflow({
    environment,
    now: () => secondNow,
    fetchImpl,
  });

  assert.equal(secondRunSlackRequests, 1);
  assert.equal(requestedMinimums.at(-1), traceStartedAtUs);
  assert.equal(durableTrace?.outcome, "success");
  assert.deepEqual(
    reports.map(({ scan_state }) => scan_state),
    ["resume", "complete"],
  );
  assert.deepEqual(result, {
    caughtUp: true,
    errors: 0,
    pages: 1,
    traces: 1,
  });
});

test("a bounded overlap-only prefix persists v4 resume state before failing closed", async () => {
  const firstNow = Date.parse("2026-08-14T06:11:06.000Z");
  const secondNow = firstNow + 15 * 60 * 1_000;
  const previousCheckpointUs = firstNow * 1_000 - 60 * 60 * 1_000 * 1_000;
  let durableCheckpointUs = previousCheckpointUs;
  let resumeFromUs = null;
  let run = 1;
  let firstRunSlackRequests = 0;
  let secondRunSlackRequests = 0;
  let reconciliationPosts = 0;
  const requestedMinimums = [];
  const scanStates = [];

  const fetchImpl = async (input, init) => {
    if (input === CHECKPOINT_URL) {
      return checkpointResponseV4(durableCheckpointUs, resumeFromUs);
    }
    if (input === RECONCILIATION_URL) {
      reconciliationPosts += 1;
      const report = assertReconciliationV4Request(init);
      scanStates.push(report.scan_state);
      durableCheckpointUs = report.checkpoint_us;
      if (report.scan_state === "resume") {
        resumeFromUs = durableCheckpointUs;
      } else if (report.scan_state === "complete") {
        resumeFromUs = null;
      }
      return acceptedReconciliationResponse(report);
    }
    assert.equal(input, SLACK_URL);
    const form = Object.fromEntries(init.body);
    requestedMinimums.push(Number(form.min_date_created));
    if (run === 1) {
      firstRunSlackRequests += 1;
      assert.ok(firstRunSlackRequests <= 100);
      return jsonResponse({
        ok: true,
        activities: [
          {
            level: "info",
            event_type: "workflow_published",
            component_type: "workflows",
            created: previousCheckpointUs - 100 + firstRunSlackRequests,
            payload: { workflow_name: "GitHub activity" },
          },
        ],
        response_metadata: {
          next_cursor: `overlap-cursor-${firstRunSlackRequests + 1}`,
        },
      });
    }
    secondRunSlackRequests += 1;
    assert.equal(form.cursor, undefined);
    return jsonResponse({
      ok: true,
      activities: [
        {
          level: "info",
          event_type: "workflow_published",
          component_type: "workflows",
          created: previousCheckpointUs + 1,
          payload: { workflow_name: "GitHub alerts" },
        },
      ],
      response_metadata: { next_cursor: "" },
    });
  };

  await assert.rejects(
    monitorSlackWorkflow({
      environment,
      now: () => firstNow,
      fetchImpl,
    }),
    /Relay did not acknowledge Slack activity checkpoint progress/,
  );
  assert.equal(firstRunSlackRequests, 100);
  assert.equal(reconciliationPosts, 1);
  assert.equal(durableCheckpointUs, previousCheckpointUs);
  assert.equal(resumeFromUs, previousCheckpointUs);

  run = 2;
  const result = await monitorSlackWorkflow({
    environment,
    now: () => secondNow,
    fetchImpl,
  });

  assert.equal(secondRunSlackRequests, 1);
  assert.equal(
    requestedMinimums[0],
    previousCheckpointUs - 20 * 60 * 1_000 * 1_000,
  );
  assert.equal(requestedMinimums.at(-1), previousCheckpointUs);
  assert.deepEqual(scanStates, ["resume", "complete"]);
  assert.deepEqual(result, {
    caughtUp: true,
    errors: 0,
    pages: 1,
    traces: 0,
  });
  assert.equal(resumeFromUs, null);
  assert.equal(durableCheckpointUs, previousCheckpointUs + 1);
});

test("a relay response that does not advance the checkpoint cannot claim progress", async () => {
  const now = Date.parse("2026-08-14T06:11:06.000Z");
  const previousCheckpointUs = now * 1_000 - 60 * 60 * 1_000 * 1_000;
  let slackRequests = 0;
  let reconciliationPosts = 0;

  await assert.rejects(
    monitorSlackWorkflow({
      environment,
      now: () => now,
      fetchImpl: async (input, init) => {
        if (input === CHECKPOINT_URL) {
          return checkpointResponseV4(previousCheckpointUs);
        }
        if (input === RECONCILIATION_URL) {
          reconciliationPosts += 1;
          const report = assertReconciliationV4Request(init);
          return jsonResponse({
            ok: true,
            traces: report.traces.length,
            changed_error_traces: 0,
            checkpoint_us: previousCheckpointUs,
          });
        }
        assert.equal(input, SLACK_URL);
        slackRequests += 1;
        return jsonResponse({
          ok: true,
          activities: [
            {
              level: "info",
              event_type: "workflow_published",
              component_type: "workflows",
              created: previousCheckpointUs + slackRequests,
              payload: { workflow_name: "GitHub activity" },
            },
          ],
          response_metadata: {
            next_cursor: `unacknowledged-cursor-${slackRequests + 1}`,
          },
        });
      },
    }),
    (error) =>
      /Relay did not acknowledge Slack activity checkpoint progress/u.test(
        error.message,
      ) && !/advanced|success/iu.test(error.message),
  );

  assert.equal(slackRequests, 100);
  assert.equal(reconciliationPosts, 1);
});

test("fails closed when a bounded prefix cannot advance the checkpoint", async () => {
  const now = Date.parse("2026-08-14T06:11:06.000Z");
  const previousCheckpointUs = now * 1_000 - 60 * 1_000 * 1_000;
  let slackRequests = 0;
  let reconciliationPosts = 0;

  await assert.rejects(
    monitorSlackWorkflow({
      environment,
      now: () => now,
      fetchImpl: async (input) => {
        if (input === CHECKPOINT_URL) {
          return checkpointResponse(previousCheckpointUs);
        }
        if (input === RECONCILIATION_URL) {
          reconciliationPosts += 1;
          return jsonResponse({ ok: true });
        }
        assert.equal(input, SLACK_URL);
        slackRequests += 1;
        return jsonResponse({
          ok: true,
          activities: [
            {
              level: "info",
              event_type: "workflow_published",
              component_type: "workflows",
              created: previousCheckpointUs,
              payload: { workflow_name: "GitHub activity" },
            },
          ],
          response_metadata: {
            next_cursor: `stalled-cursor-${slackRequests + 1}`,
          },
        });
      },
    }),
    /could not advance its checkpoint within its safety bound/,
  );

  assert.equal(slackRequests, 100);
  assert.equal(reconciliationPosts, 0);
});

test("v3 cannot post an advancing bounded prefix without durable resume state", async () => {
  const now = Date.parse("2026-08-14T06:11:06.000Z");
  const previousCheckpointUs = now * 1_000 - 60 * 60 * 1_000 * 1_000;
  let slackRequests = 0;
  let reconciliationPosts = 0;

  await assert.rejects(
    monitorSlackWorkflow({
      environment,
      now: () => now,
      fetchImpl: async (input, init) => {
        if (input === CHECKPOINT_URL) {
          return checkpointResponse(previousCheckpointUs);
        }
        if (input === RECONCILIATION_URL) {
          reconciliationPosts += 1;
          const report = assertReconciliationRequest(init);
          return acceptedReconciliationResponse(report);
        }
        assert.equal(input, SLACK_URL);
        slackRequests += 1;
        return jsonResponse({
          ok: true,
          activities: [
            {
              level: "info",
              event_type: "workflow_published",
              component_type: "workflows",
              created: previousCheckpointUs + slackRequests,
              payload: { workflow_name: "GitHub activity" },
            },
          ],
          response_metadata: {
            next_cursor: `v3-bounded-cursor-${slackRequests + 1}`,
          },
        });
      },
    }),
    /Relay reconciliation v4 is required to resume bounded Slack activity catch-up/,
  );

  assert.equal(slackRequests, 100);
  assert.equal(reconciliationPosts, 0);
});

test("refreshes the authenticated report timestamp after long pagination and between chunks", async () => {
  let clock = Date.parse("2026-08-04T08:00:00.000Z");
  const created = clock * 1_000 - 1_000;
  const activities = Array.from({ length: 101 }, (_, index) => {
    const suffix = String(index + 1).padStart(3, "0");
    const deliveryId = `delivery-fresh-report-${suffix}`;
    const traceId = `TrFreshReport${suffix}`;
    return [
      {
        level: "info",
        event_type: "workflow_execution_started",
        component_type: "workflows",
        created,
        trace_id: traceId,
        payload: {},
      },
      {
        level: "info",
        event_type: "workflow_step_execution_result",
        component_type: "workflows",
        created: created + 1,
        trace_id: traceId,
        payload: {
          exec_outcome: "Success",
          function_execution_id: `FxFreshReport${suffix}`,
          inputs: signedProgressInputs(deliveryId),
        },
      },
    ];
  }).flat();
  const pages = [
    activities.slice(0, 100),
    activities.slice(100, 200),
    activities.slice(200),
  ];
  const reportTimestamps = [];
  const reportSizes = [];
  let page = 0;

  const result = await monitorSlackWorkflow({
    environment,
    now: () => clock,
    fetchImpl: async (input, init) => {
      if (input === CHECKPOINT_URL) {
        assertCheckpointRequest(init);
        return checkpointResponse(created - 10_000);
      }
      if (input === SLACK_URL) {
        const currentPage = page;
        page += 1;
        if (page === pages.length) clock += 301_000;
        return jsonResponse({
          ok: true,
          activities: pages[currentPage],
          response_metadata: {
            next_cursor: page < pages.length ? `cursor-${page + 1}` : "",
          },
        });
      }
      assert.equal(input, RECONCILIATION_URL);
      const report = assertReconciliationRequest(init);
      reportTimestamps.push(report.report_timestamp);
      reportSizes.push(report.traces.length);
      assert.equal(report.report_timestamp, String(Math.floor(clock / 1_000)));
      if (reportTimestamps.length === 1) clock += 301_000;
      return acceptedReconciliationResponse(report);
    },
  });

  assert.deepEqual(result, {
    caughtUp: true,
    errors: 0,
    pages: 3,
    traces: 101,
  });
  assert.deepEqual(reportSizes, [25, 25, 25, 25, 1]);
  assert.deepEqual(reportTimestamps, [
    "1785830701",
    "1785831002",
    "1785831002",
    "1785831002",
    "1785831002",
  ]);
});

test("places the relay Worker near its D1 backend", () => {
  assert.match(
    relayWranglerSource,
    /"placement":\s*\{\s*"mode":\s*"smart",?\s*\}/u,
    "the relay must not execute a sequential D1 reconciliation batch at an arbitrary edge colo",
  );
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
          function_execution_id: "FxMonitorPendingBoundary1",
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
      relay_attempt: "1",
      send_execution_id: "FxMonitorPendingBoundary1",
      slack_channel_id: null,
      slack_message_ts: null,
      send_boundary_reached: true,
      pre_send_failure_proven: false,
      started_at_us: created,
      completed_at_us: null,
    },
  ]);
  assert.ok(!JSON.stringify(result).includes("must-not-leak"));
});

test("reconciles the live Slack activity shape when custom-step inputs are omitted", () => {
  const created = Date.parse("2026-08-12T17:31:29.000Z") * 1_000;
  const result = reconcileSlackActivities([
    {
      level: "info",
      event_type: "workflow_execution_started",
      created,
      trace_id: "Tr0BPPV04R45",
      payload: {},
    },
    {
      level: "info",
      event_type: "workflow_step_started",
      created: created + 1,
      trace_id: "Tr0BPPV04R45",
      payload: {
        current_step: 2,
        total_steps: 4,
        function_id: "Fn0BQMSJB7DE",
        function_execution_id: "Fx0BPVFG8ARF",
      },
    },
    {
      level: "info",
      event_type: "workflow_step_execution_result",
      created: created + 2,
      trace_id: "Tr0BPPV04R45",
      payload: {
        exec_outcome: "Success",
        function_id: "Fn0BQMSJB7DE",
        function_execution_id: "Fx0BPVFG8ARF",
      },
    },
    {
      level: "info",
      event_type: "workflow_step_started",
      created: created + 3,
      trace_id: "Tr0BPPV04R45",
      payload: {
        current_step: 3,
        total_steps: 4,
        function_id: "Fn0102",
        function_execution_id: "Fx0BPTGJMJKU",
      },
    },
    {
      level: "info",
      event_type: "workflow_step_execution_result",
      created: created + 4,
      trace_id: "Tr0BPPV04R45",
      payload: {
        exec_outcome: "Success",
        function_id: "Fn0102",
        function_execution_id: "Fx0BPTGJMJKU",
        outputs: {
          channel_id: "C0BMUK793NV",
          message_ts: "1786555894.853909",
        },
      },
    },
    {
      level: "info",
      event_type: "workflow_step_started",
      created: created + 5,
      trace_id: "Tr0BPPV04R45",
      payload: {
        current_step: 4,
        total_steps: 4,
        function_id: "Fn0BQMSJB7DE",
        function_execution_id: "Fx0BPPUYSB3P",
      },
    },
    {
      level: "error",
      event_type: "workflow_step_execution_result",
      created: created + 6,
      trace_id: "Tr0BPPV04R45",
      payload: {
        exec_outcome: "Error",
        function_id: "Fn0BQMSJB7DE",
        function_execution_id: "Fx0BPPUYSB3P",
      },
    },
    {
      level: "error",
      event_type: "workflow_execution_result",
      created: created + 7,
      trace_id: "Tr0BPPV04R45",
      payload: { exec_outcome: "Error" },
    },
  ]);

  assert.deepEqual(result.traces, [
    {
      trace_id: "Tr0BPPV04R45",
      delivery_id: null,
      outcome: "error",
      relay_attempt: null,
      send_execution_id: "Fx0BPVFG8ARF",
      send_boundary_reached: true,
      pre_send_failure_proven: false,
      slack_channel_id: "C0BMUK793NV",
      slack_message_ts: "1786555894.853909",
      started_at_us: created,
      completed_at_us: created + 7,
    },
  ]);
  assert.equal(result.errors, 0);
});

test("ignores a complete legacy two-step workflow while reconciling current traces", () => {
  const created = Date.parse("2026-08-12T17:31:29.000Z") * 1_000;
  const legacyTraceId = "TrLegacyTwoStepSuccess1";
  const currentTraceId = "TrCurrentReceiptAware1";
  const result = reconcileSlackActivities(
    [
      {
        level: "info",
        event_type: "workflow_execution_started",
        created,
        trace_id: legacyTraceId,
        payload: {},
      },
      {
        level: "info",
        event_type: "workflow_step_started",
        created: created + 1,
        trace_id: legacyTraceId,
        payload: {
          current_step: 1,
          total_steps: 2,
          function_id: "Fn0BMBCA9QG7",
          function_execution_id: "FxLegacyValidatorSuccess1",
        },
      },
      {
        level: "info",
        event_type: "workflow_step_execution_result",
        created: created + 2,
        trace_id: legacyTraceId,
        payload: {
          exec_outcome: "Success",
          function_id: "Fn0BMBCA9QG7",
          function_execution_id: "FxLegacyValidatorSuccess1",
        },
      },
      {
        level: "info",
        event_type: "workflow_step_started",
        created: created + 3,
        trace_id: legacyTraceId,
        payload: {
          current_step: 2,
          total_steps: 2,
          function_id: "Fn0102",
          function_execution_id: "FxLegacySendMessageSuccess1",
        },
      },
      {
        level: "info",
        event_type: "workflow_step_execution_result",
        created: created + 4,
        trace_id: legacyTraceId,
        payload: {
          exec_outcome: "Success",
          function_id: "Fn0102",
          function_execution_id: "FxLegacySendMessageSuccess1",
          outputs: {
            channel_id: "C0BMQMW3L4E",
            message_ts: "1786555894.853909",
          },
        },
      },
      {
        level: "info",
        event_type: "workflow_execution_result",
        created: created + 5,
        trace_id: legacyTraceId,
        payload: { exec_outcome: "Success" },
      },
      {
        level: "info",
        event_type: "workflow_execution_started",
        created: created + 6,
        trace_id: currentTraceId,
        payload: {},
      },
      {
        level: "info",
        event_type: "workflow_step_execution_result",
        created: created + 7,
        trace_id: currentTraceId,
        payload: {
          exec_outcome: "Success",
          function_execution_id: "FxCurrentReceiptBoundary1",
          inputs: signedProgressInputs(
            "delivery-current-receipt-aware-1",
            "send_started",
            "alerts",
            String(Math.floor(created / 1_000_000)),
          ),
        },
      },
      {
        level: "info",
        event_type: "workflow_execution_result",
        created: created + 8,
        trace_id: currentTraceId,
        payload: { exec_outcome: "Success" },
      },
    ],
    [environment.SLACK_RELAY_SIGNING_SECRET],
  );

  assert.equal(result.errors, 0);
  assert.equal(result.maximumCreated, created + 8);
  assert.equal(result.traces.length, 1);
  assert.equal(result.traces[0].trace_id, currentTraceId);
  assert.equal(
    result.traces[0].delivery_id,
    "delivery-current-receipt-aware-1",
  );
});

test("leaves correlated errors to durable relay novelty and retains uncorrelated errors", () => {
  const created = Date.parse("2026-08-12T17:31:29.000Z") * 1_000;
  const recovered = reconcileSlackActivities(
    [
      {
        level: "info",
        event_type: "workflow_execution_started",
        created,
        trace_id: "TrRecoveredOverlap1",
        payload: {},
      },
      {
        level: "info",
        event_type: "workflow_step_started",
        created: created + 1,
        trace_id: "TrRecoveredOverlap1",
        payload: {
          current_step: 2,
          total_steps: 4,
          function_id: "FnBoundaryOverlap1",
          function_execution_id: "FxBoundaryOverlap1",
        },
      },
      {
        level: "info",
        event_type: "workflow_step_execution_result",
        created: created + 2,
        trace_id: "TrRecoveredOverlap1",
        payload: {
          exec_outcome: "Success",
          function_id: "FnBoundaryOverlap1",
          function_execution_id: "FxBoundaryOverlap1",
        },
      },
      {
        level: "info",
        event_type: "workflow_step_started",
        created: created + 3,
        trace_id: "TrRecoveredOverlap1",
        payload: {
          current_step: 3,
          total_steps: 4,
          function_id: "Fn0102",
          function_execution_id: "FxSendOverlap1",
        },
      },
      {
        level: "info",
        event_type: "workflow_step_execution_result",
        created: created + 4,
        trace_id: "TrRecoveredOverlap1",
        payload: {
          exec_outcome: "Success",
          function_id: "Fn0102",
          function_execution_id: "FxSendOverlap1",
          outputs: {
            channel_id: "C0BMQMW3L4E",
            message_ts: "1786555894.853909",
          },
        },
      },
      {
        level: "info",
        event_type: "workflow_step_started",
        created: created + 5,
        trace_id: "TrRecoveredOverlap1",
        payload: {
          current_step: 4,
          total_steps: 4,
          function_id: "FnBoundaryOverlap1",
          function_execution_id: "FxReceiptOverlap1",
        },
      },
      {
        level: "error",
        event_type: "workflow_step_execution_result",
        created: created + 6,
        trace_id: "TrRecoveredOverlap1",
        payload: {
          exec_outcome: "Error",
          function_id: "FnBoundaryOverlap1",
          function_execution_id: "FxReceiptOverlap1",
        },
      },
      {
        level: "error",
        event_type: "workflow_execution_result",
        created: created + 7,
        trace_id: "TrRecoveredOverlap1",
        payload: { exec_outcome: "Error" },
      },
      {
        level: "error",
        event_type: "workflow_execution_result",
        created: created - 1,
        trace_id: "TrHistoricalOverlap1",
        payload: { exec_outcome: "Error" },
      },
    ],
    [],
  );

  assert.equal(recovered.errors, 1);
});

test("correlates a current-authenticated relay through its NEXT-only progress evidence", () => {
  const created = Date.parse("2026-08-04T08:00:00.000Z") * 1_000;
  const oldCurrentSecret = "monitor-test-only-old-current-signing-secret";
  const deliveryId = "delivery-current-inbound-next-progress";
  const result = reconcileSlackActivities(
    [
      {
        level: "info",
        event_type: "workflow_execution_started",
        created,
        trace_id: "TrCurrentInboundNextProgress1",
        payload: {},
      },
      {
        level: "info",
        event_type: "workflow_step_execution_result",
        created: created + 1,
        trace_id: "TrCurrentInboundNextProgress1",
        payload: {
          exec_outcome: "Success",
          inputs: signedValidatorInputs(
            deliveryId,
            "alerts",
            "1785830400",
            oldCurrentSecret,
          ),
        },
      },
      {
        level: "info",
        event_type: "workflow_step_execution_result",
        created: created + 2,
        trace_id: "TrCurrentInboundNextProgress1",
        payload: {
          exec_outcome: "Success",
          function_execution_id: "FxMonitorCurrentInbound1",
          inputs: signedProgressInputs(deliveryId),
        },
      },
      {
        level: "info",
        event_type: "workflow_execution_result",
        created: created + 3,
        trace_id: "TrCurrentInboundNextProgress1",
        payload: { exec_outcome: "Success" },
      },
    ],
    [environment.SLACK_RELAY_SIGNING_SECRET],
  );

  assert.deepEqual(result.traces, [
    {
      trace_id: "TrCurrentInboundNextProgress1",
      delivery_id: deliveryId,
      outcome: "success",
      relay_attempt: "1",
      send_execution_id: "FxMonitorCurrentInbound1",
      slack_channel_id: null,
      slack_message_ts: null,
      send_boundary_reached: true,
      pre_send_failure_proven: false,
      started_at_us: created,
      completed_at_us: created + 3,
    },
  ]);
});

test("does not call an ambiguous boundary failure pre-send proof before the terminal result arrives", () => {
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
          function_execution_id: "FxMonitorPreSendB1",
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
      relay_attempt: "1",
      send_execution_id: "FxMonitorPreSendB1",
      slack_channel_id: null,
      slack_message_ts: null,
      send_boundary_reached: false,
      pre_send_failure_proven: false,
      started_at_us: created,
      completed_at_us: null,
    },
  ]);
  assert.equal(result.errors, 1);
});

test("quarantines a boundary-step failure without inventing later workflow steps", () => {
  const created = Date.parse("2026-08-04T08:00:00.000Z") * 1_000;
  const result = reconcileSlackActivities(
    [
      {
        level: "info",
        event_type: "workflow_execution_started",
        created,
        trace_id: "TrBoundaryFailure1",
        payload: {},
      },
      {
        level: "info",
        event_type: "workflow_step_started",
        created: created + 1,
        trace_id: "TrBoundaryFailure1",
        payload: {
          current_step: 2,
          total_steps: 4,
          function_id: "FnBoundaryFailure1",
          function_execution_id: "FxBoundaryFailure1",
        },
      },
      {
        level: "error",
        event_type: "workflow_step_execution_result",
        created: created + 2,
        trace_id: "TrBoundaryFailure1",
        payload: {
          exec_outcome: "Error",
          function_id: "FnBoundaryFailure1",
          function_execution_id: "FxBoundaryFailure1",
          inputs: signedProgressInputs("delivery-boundary-failure-1"),
        },
      },
      {
        level: "error",
        event_type: "workflow_execution_result",
        created: created + 3,
        trace_id: "TrBoundaryFailure1",
        payload: { exec_outcome: "Error" },
      },
    ],
    [environment.SLACK_RELAY_SIGNING_SECRET],
  );

  assert.deepEqual(result.traces, [
    {
      trace_id: "TrBoundaryFailure1",
      delivery_id: "delivery-boundary-failure-1",
      outcome: "error",
      relay_attempt: "1",
      send_execution_id: "FxBoundaryFailure1",
      slack_channel_id: null,
      slack_message_ts: null,
      send_boundary_reached: false,
      pre_send_failure_proven: false,
      started_at_us: created,
      completed_at_us: created + 3,
    },
  ]);
});

test("rejects a failed boundary that nevertheless advances to SendMessage", () => {
  const created = Date.parse("2026-08-04T08:00:00.000Z") * 1_000;
  assert.throws(
    () =>
      reconcileSlackActivities(
        [
          {
            level: "info",
            event_type: "workflow_execution_started",
            created,
            trace_id: "TrContradictoryBoundary1",
            payload: {},
          },
          {
            level: "info",
            event_type: "workflow_step_started",
            created: created + 1,
            trace_id: "TrContradictoryBoundary1",
            payload: {
              current_step: 2,
              total_steps: 4,
              function_id: "FnContradictoryBoundary1",
              function_execution_id: "FxContradictoryBoundary1",
            },
          },
          {
            level: "error",
            event_type: "workflow_step_execution_result",
            created: created + 2,
            trace_id: "TrContradictoryBoundary1",
            payload: {
              exec_outcome: "Error",
              function_id: "FnContradictoryBoundary1",
              function_execution_id: "FxContradictoryBoundary1",
              inputs: signedProgressInputs("delivery-contradictory-boundary"),
            },
          },
          {
            level: "info",
            event_type: "workflow_step_started",
            created: created + 3,
            trace_id: "TrContradictoryBoundary1",
            payload: {
              current_step: 3,
              total_steps: 4,
              function_id: "Fn0102",
              function_execution_id: "FxContradictorySend1",
            },
          },
        ],
        [environment.SLACK_RELAY_SIGNING_SECRET],
      ),
    /advanced after a failed boundary step/,
  );
});

test("rejects a failed validator trace that nevertheless starts the boundary", () => {
  const created = Date.parse("2026-08-04T08:00:00.000Z") * 1_000;
  assert.throws(
    () =>
      reconcileSlackActivities(
        [
          {
            level: "info",
            event_type: "workflow_execution_started",
            created,
            trace_id: "TrContradictoryValidator1",
            payload: {},
          },
          {
            level: "error",
            event_type: "workflow_step_execution_result",
            created: created + 1,
            trace_id: "TrContradictoryValidator1",
            payload: {
              exec_outcome: "Error",
              function_id: "FnContradictoryValidator1",
              function_execution_id: "FxContradictoryValidator1",
              inputs: signedValidatorInputs("delivery-contradictory-validator"),
            },
          },
          {
            level: "info",
            event_type: "workflow_step_started",
            created: created + 2,
            trace_id: "TrContradictoryValidator1",
            payload: {
              current_step: 2,
              total_steps: 4,
              function_id: "FnContradictoryBoundary2",
              function_execution_id: "FxContradictoryBoundary2",
            },
          },
        ],
        [environment.SLACK_RELAY_SIGNING_SECRET],
      ),
    /advanced after a failed validator step/,
  );
});

test("rejects a receipt result whose function identity differs from its start", () => {
  const created = Date.parse("2026-08-04T08:00:00.000Z") * 1_000;
  const traceId = "TrReceiptIdentityMismatch1";
  assert.throws(
    () =>
      reconcileSlackActivities([
        {
          level: "info",
          event_type: "workflow_execution_started",
          created,
          trace_id: traceId,
          payload: {},
        },
        {
          level: "info",
          event_type: "workflow_step_started",
          created: created + 1,
          trace_id: traceId,
          payload: {
            current_step: 2,
            total_steps: 4,
            function_id: "FnReceiptIdentity1",
            function_execution_id: "FxReceiptIdentityBoundary1",
          },
        },
        {
          level: "info",
          event_type: "workflow_step_execution_result",
          created: created + 2,
          trace_id: traceId,
          payload: {
            exec_outcome: "Success",
            function_id: "FnReceiptIdentity1",
            function_execution_id: "FxReceiptIdentityBoundary1",
          },
        },
        {
          level: "info",
          event_type: "workflow_step_started",
          created: created + 3,
          trace_id: traceId,
          payload: {
            current_step: 3,
            total_steps: 4,
            function_id: "Fn0102",
            function_execution_id: "FxReceiptIdentitySend1",
          },
        },
        {
          level: "info",
          event_type: "workflow_step_execution_result",
          created: created + 4,
          trace_id: traceId,
          payload: {
            exec_outcome: "Success",
            function_id: "Fn0102",
            function_execution_id: "FxReceiptIdentitySend1",
            outputs: {
              channel_id: "C0BMQMW3L4E",
              message_ts: "1786555894.853909",
            },
          },
        },
        {
          level: "info",
          event_type: "workflow_step_started",
          created: created + 5,
          trace_id: traceId,
          payload: {
            current_step: 4,
            total_steps: 4,
            function_id: "FnReceiptIdentity1",
            function_execution_id: "FxReceiptIdentityFinal1",
          },
        },
        {
          level: "error",
          event_type: "workflow_step_execution_result",
          created: created + 6,
          trace_id: traceId,
          payload: {
            exec_outcome: "Error",
            function_id: "FnDifferentReceipt1",
            function_execution_id: "FxReceiptIdentityFinal1",
          },
        },
      ]),
    /receipt step identity changed/,
  );
});

test("rejects SendMessage result evidence without its exact step start", () => {
  const created = Date.parse("2026-08-04T08:00:00.000Z") * 1_000;
  assert.throws(
    () =>
      reconcileSlackActivities(
        [
          {
            level: "info",
            event_type: "workflow_execution_started",
            created,
            trace_id: "TrUnboundSendResult1",
            payload: {},
          },
          {
            level: "error",
            event_type: "workflow_step_execution_result",
            created: created + 1,
            trace_id: "TrUnboundSendResult1",
            payload: {
              exec_outcome: "Error",
              function_id: "FnBoundaryUnbound1",
              function_execution_id: "FxBoundaryUnbound1",
              inputs: signedProgressInputs("delivery-unbound-send-result"),
            },
          },
          {
            level: "info",
            event_type: "workflow_step_execution_result",
            created: created + 2,
            trace_id: "TrUnboundSendResult1",
            payload: {
              exec_outcome: "Success",
              function_id: "Fn0102",
              function_execution_id: "FxUnboundSendResult1",
              outputs: {
                channel_id: "C0BMQMW3L4E",
                message_ts: "1786555894.853909",
              },
            },
          },
        ],
        [environment.SLACK_RELAY_SIGNING_SECRET],
      ),
    /unknown step topology/,
  );
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
          function_execution_id: "FxMonitorBoundaryValidator1",
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
          function_execution_id: "FxMonitorBoundaryValidator1",
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
          function_execution_id: "FxMonitorBoundaryProgress1",
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
          return checkpointResponse(0);
        }
        if (input === RECONCILIATION_URL) {
          report = assertReconciliationRequest(init);
          return acceptedReconciliationResponse(report, 1);
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
                function_execution_id: "FxMonitorPreSendValidator1",
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
      /recorded 1 new or uncorrelated workflow error/.test(error.message) &&
      /durable reconciliation/.test(error.message) &&
      !/secret-payload/.test(error.message) &&
      !error.message.includes(environment.SLACK_SERVICE_TOKEN),
  );
  assert.deepEqual(report.traces[0], {
    trace_id: "TrPreSend1",
    delivery_id: "delivery-pre-send-1",
    outcome: "error",
    relay_attempt: "1",
    send_execution_id: "FxMonitorPreSendValidator1",
    slack_channel_id: null,
    slack_message_ts: null,
    send_boundary_reached: false,
    pre_send_failure_proven: true,
    started_at_us: created,
    completed_at_us: created + 2,
  });
});

test("reports a late-indexed error trace once and accepts its durable replay", async () => {
  const now = Date.parse("2026-08-04T08:00:00.000Z");
  const created = now * 1_000 - 10;
  const activities = [
    {
      level: "info",
      event_type: "workflow_execution_started",
      created,
      trace_id: "TrLateIndexedError1",
      payload: {},
    },
    {
      level: "error",
      event_type: "workflow_step_execution_result",
      created: created + 1,
      trace_id: "TrLateIndexedError1",
      payload: {
        exec_outcome: "Error",
        function_execution_id: "FxLateIndexedError1",
        inputs: signedProgressInputs("delivery-late-indexed-error-1"),
      },
    },
    {
      level: "error",
      event_type: "workflow_execution_result",
      created: created + 2,
      trace_id: "TrLateIndexedError1",
      payload: { exec_outcome: "Error" },
    },
  ];
  let reportAttempt = 0;
  const fetchImpl = async (input, init) => {
    if (input === CHECKPOINT_URL) {
      return checkpointResponse(created + 100);
    }
    if (input === RECONCILIATION_URL) {
      const report = assertReconciliationRequest(init);
      assert.equal(report.traces.length, 1);
      reportAttempt += 1;
      return acceptedReconciliationResponse(
        report,
        reportAttempt === 1 ? 1 : 0,
      );
    }
    return jsonResponse({
      ok: true,
      activities,
      response_metadata: { next_cursor: "" },
    });
  };

  await assert.rejects(
    monitorSlackWorkflow({ environment, fetchImpl, now: () => now }),
    /recorded 1 new or uncorrelated workflow error/,
  );
  await assert.doesNotReject(
    monitorSlackWorkflow({ environment, fetchImpl, now: () => now }),
  );
  assert.equal(reportAttempt, 2);
});

test("finalizes the checkpoint before surfacing an uncorrelated Slack error", async () => {
  const now = Date.parse("2026-08-04T08:00:00.000Z");
  const created = now * 1_000 - 10;
  let reportRequests = 0;
  await assert.rejects(
    monitorSlackWorkflow({
      environment,
      now: () => now,
      fetchImpl: async (input, init) => {
        if (input === CHECKPOINT_URL) return checkpointResponse(0);
        if (input === SLACK_URL) {
          return jsonResponse({
            ok: true,
            activities: [
              {
                level: "error",
                event_type: "workflow_execution_result",
                created,
                trace_id: "TrUncorrelatedError001",
                payload: { exec_outcome: "Error" },
              },
            ],
            response_metadata: { next_cursor: "" },
          });
        }
        assert.equal(input, RECONCILIATION_URL);
        reportRequests += 1;
        const report = assertReconciliationRequest(init);
        assert.deepEqual(report.traces, []);
        assert.equal(report.checkpoint_us, created);
        return acceptedReconciliationResponse(report);
      },
    }),
    /recorded 1 new or uncorrelated workflow error/,
  );
  assert.equal(reportRequests, 1);
});

test("surfaces journaled and uncorrelated errors together after the final checkpoint", async () => {
  const now = Date.parse("2026-08-04T08:00:00.000Z");
  const created = now * 1_000 - 10;
  let reportRequests = 0;
  await assert.rejects(
    monitorSlackWorkflow({
      environment,
      now: () => now,
      fetchImpl: async (input, init) => {
        if (input === CHECKPOINT_URL) return checkpointResponse(0);
        if (input === SLACK_URL) {
          return jsonResponse({
            ok: true,
            activities: [
              {
                level: "info",
                event_type: "workflow_execution_started",
                created,
                trace_id: "TrCombinedCorrelated001",
                payload: {},
              },
              {
                level: "error",
                event_type: "workflow_step_execution_result",
                created: created + 1,
                trace_id: "TrCombinedCorrelated001",
                payload: {
                  exec_outcome: "Error",
                  function_execution_id: "FxCombinedCorrelated001",
                  inputs: signedProgressInputs(
                    "delivery-combined-correlated-001",
                  ),
                },
              },
              {
                level: "error",
                event_type: "workflow_execution_result",
                created: created + 2,
                trace_id: "TrCombinedCorrelated001",
                payload: { exec_outcome: "Error" },
              },
              {
                level: "error",
                event_type: "workflow_execution_result",
                created: created + 3,
                trace_id: "TrCombinedUncorrelated001",
                payload: { exec_outcome: "Error" },
              },
            ],
            response_metadata: { next_cursor: "" },
          });
        }
        assert.equal(input, RECONCILIATION_URL);
        reportRequests += 1;
        const report = assertReconciliationRequest(init);
        assert.equal(report.traces.length, 1);
        assert.equal(report.traces[0].trace_id, "TrCombinedCorrelated001");
        assert.equal(report.checkpoint_us, created + 3);
        return acceptedReconciliationResponse(report, 1);
      },
    }),
    /recorded 2 new or uncorrelated workflow errors/,
  );
  assert.equal(reportRequests, 1);
});

test("surfaces a journaled error before a later reconciliation chunk can fail", async () => {
  const now = Date.parse("2026-08-04T08:00:00.000Z");
  const created = now * 1_000 - 10;
  const activities = [
    {
      level: "info",
      event_type: "workflow_execution_started",
      created,
      trace_id: "TrAChunkError001",
      payload: {},
    },
    {
      level: "error",
      event_type: "workflow_step_execution_result",
      created: created + 1,
      trace_id: "TrAChunkError001",
      payload: {
        exec_outcome: "Error",
        function_execution_id: "FxAChunkError001",
        inputs: signedProgressInputs("delivery-a-chunk-error-001"),
      },
    },
    {
      level: "error",
      event_type: "workflow_execution_result",
      created: created + 2,
      trace_id: "TrAChunkError001",
      payload: { exec_outcome: "Error" },
    },
    {
      level: "error",
      event_type: "workflow_execution_result",
      created: created + 3,
      trace_id: "TrAChunkUncorrelated001",
      payload: { exec_outcome: "Error" },
    },
    ...Array.from({ length: 25 }, (_, index) => {
      const suffix = String(index + 1).padStart(3, "0");
      const traceId = `TrBChunkPending${suffix}`;
      return [
        {
          level: "info",
          event_type: "workflow_execution_started",
          created,
          trace_id: traceId,
          payload: {},
        },
        {
          level: "info",
          event_type: "workflow_step_execution_result",
          created: created + 1,
          trace_id: traceId,
          payload: {
            exec_outcome: "Success",
            function_execution_id: `FxBChunkPending${suffix}`,
            inputs: signedProgressInputs(`delivery-b-chunk-pending-${suffix}`),
          },
        },
      ];
    }).flat(),
  ];
  let reportRequests = 0;
  await assert.rejects(
    monitorSlackWorkflow({
      environment,
      now: () => now,
      fetchImpl: async (input, init) => {
        if (input === CHECKPOINT_URL) return checkpointResponse(0);
        if (input === SLACK_URL) {
          return jsonResponse({
            ok: true,
            activities,
            response_metadata: { next_cursor: "" },
          });
        }
        assert.equal(input, RECONCILIATION_URL);
        reportRequests += 1;
        const report = assertReconciliationRequest(init);
        if (reportRequests > 1) {
          throw Object.assign(new Error("second chunk unavailable"), {
            name: "TimeoutError",
          });
        }
        assert.equal(report.traces.length, 25);
        assert.equal(report.traces[0].trace_id, "TrAChunkError001");
        return acceptedReconciliationResponse(report, 1);
      },
    }),
    /recorded 1 new or uncorrelated workflow error/,
  );
  assert.equal(reportRequests, 1);
});

test("repeated pagination cursors fail before advancing the checkpoint", async () => {
  let reports = 0;
  await assert.rejects(
    monitorSlackWorkflow({
      environment,
      fetchImpl: async (input) => {
        if (input === CHECKPOINT_URL) {
          return checkpointResponse(0);
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

test("rejects an oversized Slack page before it can exceed the job budget", async () => {
  let reconciliationPosts = 0;
  await assert.rejects(
    monitorSlackWorkflow({
      environment,
      fetchImpl: async (input) => {
        if (input === CHECKPOINT_URL) {
          return checkpointResponse(0);
        }
        if (input === RECONCILIATION_URL) {
          reconciliationPosts += 1;
          return jsonResponse({ ok: true });
        }
        return jsonResponse({
          ok: true,
          activities: Array.from({ length: 101 }, () => ({})),
          response_metadata: { next_cursor: "" },
        });
      },
    }),
    /exceeded its requested page size/,
  );
  assert.equal(reconciliationPosts, 0);
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
              function_execution_id: "FxMonitorConflictOne1",
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
              function_execution_id: "FxMonitorConflictTwo2",
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
          return checkpointResponse(0);
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
                function_execution_id: "FxMonitorContradictory1",
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
    fetchImpl: async (input, init) => {
      if (input === CHECKPOINT_URL) {
        return checkpointResponse(0);
      }
      if (input === RECONCILIATION_URL) {
        return acceptedReconciliationResponse(
          assertReconciliationRequest(init),
        );
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
  assert.deepEqual(result, {
    caughtUp: true,
    errors: 0,
    pages: 1,
    traces: 0,
  });
  assert.equal(slackRequests, 2);
  assert.deepEqual(delays, [2_000]);

  slackRequests = 0;
  await assert.rejects(
    monitorSlackWorkflow({
      environment,
      fetchImpl: async (input) => {
        if (input === CHECKPOINT_URL) {
          return checkpointResponse(0);
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
          input === CHECKPOINT_URL ? checkpointResponse(0) : response,
      }),
      (error) =>
        !/private upstream body|private invalid JSON/.test(error.message) &&
        !error.message.includes(environment.SLACK_SERVICE_TOKEN) &&
        !error.message.includes(environment.SLACK_RELAY_SIGNING_SECRET),
    );
  }
});
