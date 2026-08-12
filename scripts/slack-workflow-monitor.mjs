import { createHmac, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";

const ACTIVITY_API_URL = "https://slack.com/api/apps.activities.list";
const RELAY_BASE_URL = "https://github-slack-alerts.lcv.workers.dev";
const CHECKPOINT_URL = `${RELAY_BASE_URL}/slack/reconciliation/checkpoint`;
const RECONCILIATION_URL = `${RELAY_BASE_URL}/slack/reconciliation`;
const INITIAL_LOOKBACK_US = 20 * 60 * 1_000 * 1_000;
const CHECKPOINT_OVERLAP_US = 20 * 60 * 1_000 * 1_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRY_AFTER_SECONDS = 30;
const MAX_PAGES = 100;
const REPORT_TRACE_LIMIT = 100;
const MAX_RELAY_AGE_SECONDS = 300;
const MAX_RELAY_CLOCK_SKEW_SECONDS = 60;
const SAFE_ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;
const TRACE_ID_PATTERN = /^Tr[A-Za-z0-9_-]{1,125}$/;
const SIGNATURE_PATTERN = /^[a-f0-9]{64}$/;
const RELAY_SIGNED_FIELDS = [
  "source",
  "severity",
  "repository",
  "title",
  "details",
  "actor",
  "branch",
  "url",
  "occurred_at",
  "delivery_id",
  "event",
  "action",
  "destination",
  "relay_attempt",
  "relay_timestamp",
];
const EXECUTION_EVENT_TYPES = new Set([
  "workflow_execution_started",
  "workflow_execution_result",
  "workflow_step_execution_result",
]);

function requiredEnvironmentValue(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Required environment variable ${name} is missing.`);
  }
  return value.trim();
}

export function readSlackMonitorConfiguration(environment = process.env) {
  const rawCurrent = environment.SLACK_RELAY_SIGNING_SECRET;
  const currentRelaySigningSecret =
    typeof rawCurrent === "string" && rawCurrent.trim() !== ""
      ? rawCurrent
      : null;
  if (
    currentRelaySigningSecret !== null &&
    Buffer.byteLength(currentRelaySigningSecret, "utf8") < 32
  ) {
    throw new Error(
      "Required environment variable SLACK_RELAY_SIGNING_SECRET is malformed.",
    );
  }
  const rawNext = environment.SLACK_RELAY_SIGNING_SECRET_NEXT;
  const nextRelaySigningSecret =
    typeof rawNext === "string" && rawNext.trim() !== "" ? rawNext : null;
  if (
    nextRelaySigningSecret !== null &&
    (Buffer.byteLength(nextRelaySigningSecret, "utf8") < 32 ||
      (currentRelaySigningSecret !== null &&
        nextRelaySigningSecret === currentRelaySigningSecret))
  ) {
    throw new Error(
      "Optional environment variable SLACK_RELAY_SIGNING_SECRET_NEXT is malformed.",
    );
  }
  const activeSlot =
    environment.SLACK_RELAY_SIGNING_ACTIVE_SLOT?.trim() || "current";
  if (activeSlot !== "current" && activeSlot !== "next") {
    throw new Error(
      "Environment variable SLACK_RELAY_SIGNING_ACTIVE_SLOT is malformed.",
    );
  }
  if (activeSlot === "current" && currentRelaySigningSecret === null) {
    throw new Error(
      "Required environment variable SLACK_RELAY_SIGNING_SECRET is missing.",
    );
  }
  if (activeSlot === "next" && nextRelaySigningSecret === null) {
    throw new Error(
      "SLACK_RELAY_SIGNING_ACTIVE_SLOT requires a staged NEXT secret.",
    );
  }
  const relaySigningSecret =
    activeSlot === "next" ? nextRelaySigningSecret : currentRelaySigningSecret;
  return Object.freeze({
    appId: requiredEnvironmentValue(environment, "SLACK_APP_ID"),
    relaySigningSecret: relaySigningSecret,
    relaySigningSecrets: Object.freeze(
      [currentRelaySigningSecret, nextRelaySigningSecret].filter(
        (secret) => secret !== null,
      ),
    ),
    relaySigningActiveSlot: activeSlot,
    serviceToken: requiredEnvironmentValue(environment, "SLACK_SERVICE_TOKEN"),
    teamId: requiredEnvironmentValue(environment, "SLACK_TEAM_ID"),
  });
}

function signature(secret, canonical) {
  return createHmac("sha256", secret).update(canonical, "utf8").digest("hex");
}

function checkpointCanonical(request) {
  return JSON.stringify([
    "slack_activity_checkpoint_request_v1",
    request.request_timestamp,
  ]);
}

function reconciliationCanonical(report) {
  return JSON.stringify([
    "slack_activity_reconciliation_v2",
    report.checkpoint_us,
    report.report_timestamp,
    report.traces.map((trace) => [
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
  ]);
}

function httpFailure(service, response) {
  const context = [];
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter && /^\d+$/.test(retryAfter)) {
    context.push(`retry-after=${retryAfter}s`);
  }
  const suffix = context.length > 0 ? ` (${context.join(", ")})` : "";
  return new Error(`${service} returned HTTP ${response.status}${suffix}.`);
}

function slackApiFailure(responseBody) {
  const code = responseBody?.error;
  if (typeof code === "string" && SAFE_ERROR_CODE.test(code)) {
    return new Error(`Slack activity API returned ${code}.`);
  }
  return new Error(
    "Slack activity API failed with an unrecognized error code; response withheld.",
  );
}

async function parsedJsonResponse(response, service) {
  let responseBody;
  try {
    responseBody = JSON.parse(await response.text());
  } catch (error) {
    throw new Error(`${service} returned invalid JSON.`, { cause: error });
  }
  return responseBody;
}

async function relayPost(fetchImpl, url, body) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error("Relay reconciliation endpoint could not be reached.", {
      cause: error,
    });
  }
  if (!response.ok)
    throw httpFailure("Relay reconciliation endpoint", response);
  const parsed = await parsedJsonResponse(
    response,
    "Relay reconciliation endpoint",
  );
  if (parsed?.ok !== true && !Number.isSafeInteger(parsed?.checkpoint_us)) {
    throw new Error("Relay reconciliation endpoint returned an invalid reply.");
  }
  return parsed;
}

async function readCheckpoint(fetchImpl, configuration, reportTimestamp) {
  const unsigned = { request_timestamp: reportTimestamp };
  const response = await relayPost(fetchImpl, CHECKPOINT_URL, {
    ...unsigned,
    request_signature: signature(
      configuration.relaySigningSecret,
      checkpointCanonical(unsigned),
    ),
  });
  if (
    !Number.isSafeInteger(response.checkpoint_us) ||
    response.checkpoint_us < 0
  ) {
    throw new Error("Relay reconciliation checkpoint is malformed.");
  }
  return response.checkpoint_us;
}

async function fetchSlackPage({ body, configuration, fetchImpl, sleepImpl }) {
  let response;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await fetchImpl(ACTIVITY_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${configuration.serviceToken}`,
          "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        throw new Error(
          `Slack activity API timed out after ${REQUEST_TIMEOUT_MS}ms.`,
          { cause: error },
        );
      }
      throw new Error("Slack activity API could not be reached.", {
        cause: error,
      });
    }

    if (response.status !== 429 || attempt === 1) break;
    const retryAfter = response.headers.get("retry-after");
    if (
      !retryAfter ||
      !/^\d+$/.test(retryAfter) ||
      Number(retryAfter) < 1 ||
      Number(retryAfter) > MAX_RETRY_AFTER_SECONDS
    ) {
      throw httpFailure("Slack activity API", response);
    }
    await sleepImpl(Number(retryAfter) * 1_000);
  }

  if (!response) throw new Error("Slack activity API returned no response.");
  if (!response.ok) throw httpFailure("Slack activity API", response);
  const responseBody = await parsedJsonResponse(response, "Slack activity API");
  if (responseBody?.ok !== true) throw slackApiFailure(responseBody);
  if (!Array.isArray(responseBody.activities)) {
    throw new Error(
      "Slack activity API returned a malformed activities collection.",
    );
  }
  const nextCursor = responseBody.response_metadata?.next_cursor ?? "";
  if (typeof nextCursor !== "string" || nextCursor.length > 2_048) {
    throw new Error(
      "Slack activity API returned a malformed pagination cursor.",
    );
  }
  return { activities: responseBody.activities, nextCursor };
}

function recordFor(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function verifiedHmac(secrets, canonical, candidate) {
  if (typeof candidate !== "string" || !SIGNATURE_PATTERN.test(candidate)) {
    return false;
  }
  const actual = Buffer.from(candidate, "hex");
  return secrets.slice(0, 2).some((secret) => {
    if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) {
      return false;
    }
    const expected = createHmac("sha256", secret)
      .update(canonical, "utf8")
      .digest();
    return timingSafeEqual(actual, expected);
  });
}

function authenticatedStepEvidence(
  inputs,
  stepOutcome,
  secrets,
  activityCreatedUs,
  functionExecutionId,
) {
  if (inputs === null) return null;
  const deliveryId = inputs.delivery_id;
  if (typeof deliveryId !== "string" || !DELIVERY_ID_PATTERN.test(deliveryId)) {
    return null;
  }
  const relayTimestamp = inputs.relay_timestamp;
  const relayAttempt = inputs.relay_attempt;
  if (
    typeof relayAttempt !== "string" ||
    !/^[1-9][0-9]{0,15}$/u.test(relayAttempt) ||
    !Number.isSafeInteger(Number.parseInt(relayAttempt, 10))
  ) {
    return null;
  }
  if (typeof relayTimestamp !== "string" || !/^\d{10}$/u.test(relayTimestamp)) {
    return null;
  }
  const relayTimestampSeconds = Number.parseInt(relayTimestamp, 10);
  const activityCreatedSeconds = Math.floor(activityCreatedUs / 1_000_000);
  if (
    relayTimestampSeconds < activityCreatedSeconds - MAX_RELAY_AGE_SECONDS ||
    relayTimestampSeconds >
      activityCreatedSeconds + MAX_RELAY_CLOCK_SKEW_SECONDS
  ) {
    return null;
  }

  const phase = inputs.phase;
  if (phase === "send_started" || phase === "delivered") {
    const destination = inputs.destination;
    if (destination !== "alerts" && destination !== "activity") {
      return null;
    }
    const canonical = JSON.stringify([
      "slack_progress_authorization_v2",
      deliveryId,
      destination,
      relayAttempt,
      relayTimestamp,
    ]);
    if (!verifiedHmac(secrets, canonical, inputs.progress_token)) return null;
    const sendExecutionId =
      phase === "send_started" &&
      typeof functionExecutionId === "string" &&
      /^Fx[A-Za-z0-9]{1,126}$/u.test(functionExecutionId)
        ? functionExecutionId
        : null;
    if (phase === "send_started" && sendExecutionId === null) return null;
    return {
      deliveryId,
      relayAttempt,
      sendExecutionId,
      sendBoundaryReached:
        phase === "delivered" ||
        (phase === "send_started" && stepOutcome === "Success"),
      preSendFailureProven: phase === "send_started" && stepOutcome === "Error",
    };
  }

  const expectedDestination = inputs.expected_destination;
  if (
    (expectedDestination !== "alerts" && expectedDestination !== "activity") ||
    inputs.destination !== expectedDestination ||
    !RELAY_SIGNED_FIELDS.every((name) => typeof inputs[name] === "string")
  ) {
    return null;
  }
  const canonical = JSON.stringify(
    RELAY_SIGNED_FIELDS.map((name) => inputs[name]),
  );
  if (!verifiedHmac(secrets, canonical, inputs.relay_signature)) return null;
  return {
    deliveryId,
    relayAttempt,
    sendExecutionId:
      stepOutcome === "Error" &&
      typeof functionExecutionId === "string" &&
      /^Fx[A-Za-z0-9]{1,126}$/u.test(functionExecutionId)
        ? functionExecutionId
        : null,
    sendBoundaryReached: false,
    preSendFailureProven:
      stepOutcome === "Error" &&
      typeof functionExecutionId === "string" &&
      /^Fx[A-Za-z0-9]{1,126}$/u.test(functionExecutionId),
  };
}

export function reconcileSlackActivities(activities, relaySigningSecrets = []) {
  const traces = new Map();
  let errors = 0;
  let maximumCreated = 0;

  for (const activityValue of activities) {
    const activity = recordFor(activityValue);
    if (activity === null) {
      throw new Error("Slack activity API returned a malformed activity.");
    }
    const traceId = activity.trace_id;
    const created = activity.created;
    const eventType = activity.event_type;
    const level = activity.level;
    if (
      !Number.isSafeInteger(created) ||
      created < 0 ||
      typeof eventType !== "string" ||
      typeof level !== "string"
    ) {
      throw new Error(
        "Slack activity API returned malformed activity metadata.",
      );
    }
    maximumCreated = Math.max(maximumCreated, created);
    if (level === "error" || level === "fatal") errors += 1;
    if (!EXECUTION_EVENT_TYPES.has(eventType)) continue;
    if (typeof traceId !== "string" || !TRACE_ID_PATTERN.test(traceId)) {
      throw new Error(
        "Slack activity API returned malformed activity metadata.",
      );
    }

    let trace = traces.get(traceId);
    if (!trace) {
      trace = {
        traceId,
        deliveryId: null,
        relayAttempt: null,
        sendExecutionId: null,
        outcome: "pending",
        sendBoundaryReached: false,
        preSendFailureProven: false,
        startedAtUs: null,
        completedAtUs: null,
      };
      traces.set(traceId, trace);
    }
    const payload = recordFor(activity.payload);
    if (eventType === "workflow_execution_started") {
      trace.startedAtUs =
        trace.startedAtUs === null
          ? created
          : Math.min(trace.startedAtUs, created);
    }
    if (eventType === "workflow_execution_result") {
      const outcome = payload?.exec_outcome;
      const terminalOutcome =
        outcome === "Success"
          ? "success"
          : outcome === "Error"
            ? "error"
            : null;
      if (
        terminalOutcome !== null &&
        trace.outcome !== "pending" &&
        trace.outcome !== terminalOutcome
      ) {
        throw new Error(
          "Slack trace contains contradictory terminal outcomes.",
        );
      }
      if (terminalOutcome !== null) trace.outcome = terminalOutcome;
      else if (outcome !== "Pending") {
        throw new Error("Slack workflow result has an unknown outcome.");
      }
      if (outcome === "Success" || outcome === "Error") {
        trace.completedAtUs = created;
      }
    }
    if (eventType === "workflow_step_execution_result") {
      const inputs = recordFor(payload?.inputs);
      const stepOutcome = payload?.exec_outcome;
      const evidence = authenticatedStepEvidence(
        inputs,
        stepOutcome,
        relaySigningSecrets,
        created,
        payload?.function_execution_id,
      );
      if (evidence !== null) {
        const deliveryId = evidence.deliveryId;
        if (trace.deliveryId !== null && trace.deliveryId !== deliveryId) {
          throw new Error("Slack trace contains conflicting delivery IDs.");
        }
        trace.deliveryId = deliveryId;
        if (
          trace.relayAttempt !== null &&
          trace.relayAttempt !== evidence.relayAttempt
        ) {
          throw new Error("Slack trace contains conflicting relay attempts.");
        }
        trace.relayAttempt = evidence.relayAttempt;
        if (
          trace.sendExecutionId !== null &&
          evidence.sendExecutionId !== null &&
          trace.sendExecutionId !== evidence.sendExecutionId
        ) {
          throw new Error(
            "Slack trace contains conflicting send execution IDs.",
          );
        }
        trace.sendExecutionId ??= evidence.sendExecutionId;
        trace.sendBoundaryReached ||= evidence.sendBoundaryReached;
        trace.preSendFailureProven ||=
          evidence.preSendFailureProven && !trace.sendBoundaryReached;
        if (trace.sendBoundaryReached) trace.preSendFailureProven = false;
      }
    }
  }

  const normalizedTraces = [];
  for (const trace of traces.values()) {
    if (
      trace.deliveryId !== null &&
      trace.relayAttempt !== null &&
      trace.startedAtUs !== null &&
      (trace.outcome === "pending" || trace.completedAtUs !== null)
    ) {
      normalizedTraces.push({
        trace_id: trace.traceId,
        delivery_id: trace.deliveryId,
        outcome: trace.outcome,
        relay_attempt: trace.relayAttempt,
        send_execution_id: trace.sendExecutionId,
        send_boundary_reached: trace.sendBoundaryReached,
        pre_send_failure_proven:
          trace.preSendFailureProven && !trace.sendBoundaryReached,
        started_at_us: trace.startedAtUs,
        completed_at_us: trace.completedAtUs,
      });
    }
  }
  normalizedTraces.sort((left, right) =>
    left.trace_id.localeCompare(right.trace_id),
  );
  return Object.freeze({ errors, maximumCreated, traces: normalizedTraces });
}

async function postReconciliation({
  checkpointUs,
  previousCheckpointUs,
  reportTimestamp,
  traces,
  configuration,
  fetchImpl,
}) {
  const chunks = [];
  for (let index = 0; index < traces.length; index += REPORT_TRACE_LIMIT) {
    chunks.push(traces.slice(index, index + REPORT_TRACE_LIMIT));
  }
  if (chunks.length === 0) chunks.push([]);

  for (let index = 0; index < chunks.length; index += 1) {
    const final = index === chunks.length - 1;
    const unsigned = {
      checkpoint_us: final ? checkpointUs : previousCheckpointUs,
      report_timestamp: reportTimestamp,
      traces: chunks[index],
    };
    const response = await relayPost(fetchImpl, RECONCILIATION_URL, {
      ...unsigned,
      report_signature: signature(
        configuration.relaySigningSecret,
        reconciliationCanonical(unsigned),
      ),
    });
    if (response.ok !== true) {
      throw new Error("Relay reconciliation report was not accepted.");
    }
  }
}

export async function monitorSlackWorkflow({
  environment = process.env,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  sleepImpl = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const configuration = readSlackMonitorConfiguration(environment);
  const currentTime = now();
  if (!Number.isSafeInteger(currentTime) || currentTime <= 20 * 60 * 1_000) {
    throw new Error("The monitor clock returned an invalid timestamp.");
  }
  if (typeof sleepImpl !== "function") {
    throw new Error("A sleep implementation is required.");
  }
  const currentTimeUs = currentTime * 1_000;
  if (!Number.isSafeInteger(currentTimeUs)) {
    throw new Error("The Slack activity timestamp is outside the safe range.");
  }
  const reportTimestamp = String(Math.floor(currentTime / 1_000));
  const previousCheckpointUs = await readCheckpoint(
    fetchImpl,
    configuration,
    reportTimestamp,
  );
  const minimumFromCheckpoint = Math.max(
    0,
    previousCheckpointUs - CHECKPOINT_OVERLAP_US,
  );
  const minDateCreated =
    previousCheckpointUs === 0
      ? currentTimeUs - INITIAL_LOOKBACK_US
      : minimumFromCheckpoint;

  const activities = [];
  const seenCursors = new Set();
  let cursor = "";
  let pages = 0;
  while (true) {
    pages += 1;
    if (pages > MAX_PAGES) {
      throw new Error("Slack activity pagination exceeded its safety bound.");
    }
    const body = new URLSearchParams({
      app_id: configuration.appId,
      team_id: configuration.teamId,
      min_log_level: "info",
      component_type: "workflows",
      min_date_created: String(minDateCreated),
      max_date_created: String(currentTimeUs),
      sort_direction: "asc",
      limit: "100",
    });
    if (cursor !== "") body.set("cursor", cursor);
    const page = await fetchSlackPage({
      body,
      configuration,
      fetchImpl,
      sleepImpl,
    });
    activities.push(...page.activities);
    if (page.nextCursor === "") break;
    if (seenCursors.has(page.nextCursor)) {
      throw new Error("Slack activity pagination repeated a cursor.");
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  const reconciliation = reconcileSlackActivities(
    activities,
    configuration.relaySigningSecrets,
  );
  const evidenceCheckpointUs =
    reconciliation.maximumCreated === 0
      ? previousCheckpointUs === 0
        ? minDateCreated
        : previousCheckpointUs
      : Math.max(previousCheckpointUs, reconciliation.maximumCreated);
  await postReconciliation({
    checkpointUs: evidenceCheckpointUs,
    previousCheckpointUs,
    reportTimestamp,
    traces: reconciliation.traces,
    configuration,
    fetchImpl,
  });

  if (reconciliation.errors > 0) {
    const noun = reconciliation.errors === 1 ? "error" : "errors";
    throw new Error(
      `Slack recorded ${reconciliation.errors} workflow ${noun}; activity payloads withheld after durable reconciliation.`,
    );
  }
  return Object.freeze({
    errors: 0,
    pages,
    traces: reconciliation.traces.length,
  });
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (invokedPath === import.meta.url) {
  monitorSlackWorkflow()
    .then((result) => {
      console.info(
        `Slack workflow monitor reconciled ${result.traces} complete traces across ${result.pages} pages with no errors.`,
      );
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : "Monitor failed.");
      process.exitCode = 1;
    });
}
