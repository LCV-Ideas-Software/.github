import { createHmac, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";

const ACTIVITY_API_URL = "https://slack.com/api/apps.activities.list";
const RELAY_BASE_URL = "https://github-slack-alerts.lcv.workers.dev";
const CHECKPOINT_URL = `${RELAY_BASE_URL}/slack/reconciliation/checkpoint`;
const RECONCILIATION_URL = `${RELAY_BASE_URL}/slack/reconciliation`;
const INITIAL_LOOKBACK_US = 20 * 60 * 1_000 * 1_000;
const CHECKPOINT_OVERLAP_US = 20 * 60 * 1_000 * 1_000;
const REQUEST_TIMEOUT_MS = 30_000;
const RELAY_CHECKPOINT_TIMEOUT_MS = 10_000;
const RELAY_REPORT_TIMEOUT_MS = 15_000;
const RELAY_REPORT_REPLAY_TIMEOUT_MS = 5_000;
const MAX_RETRY_AFTER_SECONDS = 30;
const MAX_PAGES = 100;
const REPORT_TRACE_LIMIT = 25;
const MAX_TRACE_HYDRATION_PAGES = 2;
// Four worst-case Slack calls fit the 321-minute job timeout after
// retaining its 30-minute setup/processing margin. Durable fair rotation in
// D1 carries the remaining pending IDs into later natural runs.
const MAX_TRACE_HYDRATIONS_PER_RUN = 2;
const SLACK_ACTIVITY_RETENTION_US = 7 * 24 * 60 * 60 * 1_000 * 1_000;
const MAX_RELAY_AGE_SECONDS = 300;
const MAX_RELAY_CLOCK_SKEW_SECONDS = 60;
const MAX_ACTIVITIES_PER_PAGE = 100;
const SAFE_ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;
const TRACE_ID_PATTERN = /^Tr[A-Za-z0-9_-]{1,125}$/;
const FUNCTION_ID_PATTERN = /^Fn[A-Za-z0-9]{1,126}$/u;
const FUNCTION_EXECUTION_ID_PATTERN = /^Fx[A-Za-z0-9]{1,126}$/u;
const MESSAGE_TS_PATTERN = /^\d{10,13}\.\d{6}$/u;
const SLACK_DESTINATION_BY_CHANNEL = new Map([
  ["C0BMUK793NV", "alerts"],
  ["C0BMQMW3L4E", "activity"],
]);
const SLACK_SEND_MESSAGE_FUNCTION_ID = "Fn0102";
const LEGACY_VALIDATE_RELAY_FUNCTION_ID = "Fn0BMBCA9QG7";
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
  "workflow_step_started",
  "workflow_step_execution_result",
]);

const MAX_RECONCILIATION_ITEMS =
  MAX_PAGES * MAX_ACTIVITIES_PER_PAGE + 2 * MAX_TRACE_HYDRATIONS_PER_RUN;
// Trace and hydration reports are disjoint partitions. Splitting two
// partitions can add at most one partially filled chunk to the combined bound.
export const SLACK_MONITOR_MAX_RECONCILIATION_REPORTS =
  Math.ceil(MAX_RECONCILIATION_ITEMS / REPORT_TRACE_LIMIT) + 1;
export const SLACK_MONITOR_WORST_CASE_NETWORK_MS =
  RELAY_CHECKPOINT_TIMEOUT_MS +
  MAX_PAGES * (REQUEST_TIMEOUT_MS * 2 + MAX_RETRY_AFTER_SECONDS * 1_000) +
  MAX_TRACE_HYDRATIONS_PER_RUN *
    MAX_TRACE_HYDRATION_PAGES *
    (REQUEST_TIMEOUT_MS * 2 + MAX_RETRY_AFTER_SECONDS * 1_000) +
  SLACK_MONITOR_MAX_RECONCILIATION_REPORTS *
    (RELAY_REPORT_TIMEOUT_MS + RELAY_REPORT_REPLAY_TIMEOUT_MS);

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

function reconciliationCanonical(report, version = 3) {
  if (version === 5) {
    return JSON.stringify([
      "slack_activity_reconciliation_v5",
      report.checkpoint_us,
      report.report_timestamp,
      report.scan_state,
      report.hydrations.map((hydration) => [
        hydration.trace_id,
        hydration.first_observed_us,
        hydration.last_observed_us,
        hydration.status,
        hydration.debt_reason,
        hydration.attempted,
      ]),
      report.traces.map((trace) => [
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
    ]);
  }
  if (version === 4) {
    return JSON.stringify([
      "slack_activity_reconciliation_v4",
      report.checkpoint_us,
      report.report_timestamp,
      report.scan_state,
      report.traces.map((trace) => [
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
    ]);
  }
  return JSON.stringify([
    `slack_activity_reconciliation_v${version}`,
    report.checkpoint_us,
    report.report_timestamp,
    report.traces.map((trace) => [
      trace.trace_id,
      trace.delivery_id,
      trace.outcome,
      trace.relay_attempt,
      trace.send_execution_id,
      ...(version === 3
        ? [trace.slack_channel_id, trace.slack_message_ts]
        : []),
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

function hasExactKeys(value, expectedKeys) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const actualKeys = Object.keys(value).sort();
  const requiredKeys = [...expectedKeys].sort();
  return (
    actualKeys.length === requiredKeys.length &&
    actualKeys.every((key, index) => key === requiredKeys[index])
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

async function relayPost(
  fetchImpl,
  url,
  body,
  phase,
  timeoutMs,
  { retryAmbiguous = false, replayTimeoutMs = timeoutMs } = {},
) {
  const encodedBody = JSON.stringify(body);
  const attempts = retryAmbiguous ? 2 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const attemptPhase = attempt === 0 ? phase : `${phase} replay`;
    const attemptTimeout = attempt === 0 ? timeoutMs : replayTimeoutMs;
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: encodedBody,
        redirect: "error",
        signal: AbortSignal.timeout(attemptTimeout),
      });
    } catch (error) {
      if (attempt === 0 && retryAmbiguous) continue;
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        throw new Error(
          `${attemptPhase} timed out after ${attemptTimeout}ms.`,
          {
            cause: error,
          },
        );
      }
      throw new Error(`${attemptPhase} could not be reached.`, {
        cause: error,
      });
    }
    if (!response.ok) {
      if (
        attempt === 0 &&
        retryAmbiguous &&
        (response.status === 408 || response.status >= 500)
      ) {
        continue;
      }
      throw httpFailure(attemptPhase, response);
    }
    try {
      return await parsedJsonResponse(response, attemptPhase);
    } catch (error) {
      if (attempt === 0 && retryAmbiguous) continue;
      throw error;
    }
  }
  throw new Error(`${phase} returned no response.`);
}

async function readCheckpoint(fetchImpl, configuration, reportTimestamp) {
  const unsigned = { request_timestamp: reportTimestamp };
  const response = await relayPost(
    fetchImpl,
    CHECKPOINT_URL,
    {
      ...unsigned,
      request_signature: signature(
        configuration.relaySigningSecret,
        checkpointCanonical(unsigned),
      ),
    },
    "Relay reconciliation checkpoint",
    RELAY_CHECKPOINT_TIMEOUT_MS,
  );
  const v5Shape = hasExactKeys(response, [
    "checkpoint_us",
    "reconciliation_version",
    "resume_from_us",
    "pending_trace_ids",
    "pending_trace_total",
    "pending_trace_oldest_us",
  ]);
  const v4Shape = hasExactKeys(response, [
    "checkpoint_us",
    "reconciliation_version",
    "resume_from_us",
  ]);
  const v3Shape = hasExactKeys(response, [
    "checkpoint_us",
    "reconciliation_version",
  ]);
  const bridgeShape = hasExactKeys(response, ["checkpoint_us"]);
  const pendingTraceIdsValid =
    v5Shape &&
    Array.isArray(response.pending_trace_ids) &&
    response.pending_trace_ids.length <= REPORT_TRACE_LIMIT &&
    response.pending_trace_ids.every(
      (traceId) =>
        typeof traceId === "string" && TRACE_ID_PATTERN.test(traceId),
    ) &&
    new Set(response.pending_trace_ids).size ===
      response.pending_trace_ids.length;
  const pendingTraceSummaryValid =
    v5Shape &&
    pendingTraceIdsValid &&
    Number.isSafeInteger(response.pending_trace_total) &&
    response.pending_trace_total >= response.pending_trace_ids.length &&
    (response.pending_trace_total === 0 ||
      response.pending_trace_ids.length > 0) &&
    ((response.pending_trace_total === 0 &&
      response.pending_trace_ids.length === 0 &&
      response.pending_trace_oldest_us === null) ||
      (response.pending_trace_total > 0 &&
        Number.isSafeInteger(response.pending_trace_oldest_us) &&
        response.pending_trace_oldest_us >= 0));
  if (
    (!v5Shape && !v4Shape && !v3Shape && !bridgeShape) ||
    !Number.isSafeInteger(response.checkpoint_us) ||
    response.checkpoint_us < 0 ||
    (v5Shape &&
      (response.reconciliation_version !== 5 ||
        !pendingTraceIdsValid ||
        !pendingTraceSummaryValid ||
        (response.resume_from_us !== null &&
          (!Number.isSafeInteger(response.resume_from_us) ||
            response.resume_from_us < 0 ||
            response.resume_from_us > response.checkpoint_us)))) ||
    (v4Shape &&
      (response.reconciliation_version !== 4 ||
        (response.resume_from_us !== null &&
          (!Number.isSafeInteger(response.resume_from_us) ||
            response.resume_from_us < 0 ||
            response.resume_from_us > response.checkpoint_us)))) ||
    (v3Shape && response.reconciliation_version !== 3)
  ) {
    throw new Error("Relay reconciliation checkpoint is malformed.");
  }
  return Object.freeze({
    checkpointUs: response.checkpoint_us,
    reconciliationVersion: v5Shape ? 5 : v4Shape ? 4 : v3Shape ? 3 : 2,
    resumeFromUs: v5Shape || v4Shape ? response.resume_from_us : null,
    pendingTraceIds: Object.freeze(
      v5Shape ? [...response.pending_trace_ids] : [],
    ),
    pendingTraceTotal: v5Shape ? response.pending_trace_total : 0,
    pendingTraceOldestUs: v5Shape ? response.pending_trace_oldest_us : null,
  });
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
  if (responseBody.activities.length > MAX_ACTIVITIES_PER_PAGE) {
    throw new Error("Slack activity API exceeded its requested page size.");
  }
  const nextCursor = responseBody.response_metadata?.next_cursor ?? "";
  if (typeof nextCursor !== "string" || nextCursor.length > 2_048) {
    throw new Error(
      "Slack activity API returned a malformed pagination cursor.",
    );
  }
  return { activities: responseBody.activities, nextCursor };
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  const record = recordFor(value);
  if (record === null) return value;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalJsonValue(record[key])]),
  );
}

function deduplicateSlackActivities(activities) {
  const seen = new Set();
  const unique = [];
  for (const activity of activities) {
    const key = JSON.stringify(canonicalJsonValue(activity));
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(activity);
  }
  return unique;
}

function observeExecutionTraces(activities) {
  const observations = new Map();
  for (const activityValue of activities) {
    const activity = recordFor(activityValue);
    if (activity === null || !EXECUTION_EVENT_TYPES.has(activity.event_type)) {
      continue;
    }
    const traceId = activity.trace_id;
    const created = activity.created;
    if (
      typeof traceId !== "string" ||
      !TRACE_ID_PATTERN.test(traceId) ||
      !Number.isSafeInteger(created) ||
      created < 0
    ) {
      continue;
    }
    let observation = observations.get(traceId);
    if (observation === undefined) {
      observation = {
        firstObservedUs: created,
        lastObservedUs: created,
        hasStart: false,
        hasTerminal: false,
        legacyTopologyObserved: false,
        currentTopologyObserved: false,
      };
      observations.set(traceId, observation);
    }
    observation.firstObservedUs = Math.min(
      observation.firstObservedUs,
      created,
    );
    observation.lastObservedUs = Math.max(observation.lastObservedUs, created);
    observation.hasStart ||=
      activity.event_type === "workflow_execution_started";
    if (activity.event_type === "workflow_execution_result") {
      const outcome = recordFor(activity.payload)?.exec_outcome;
      observation.hasTerminal ||= outcome === "Success" || outcome === "Error";
    }
    if (activity.event_type === "workflow_step_started") {
      const totalSteps = recordFor(activity.payload)?.total_steps;
      observation.legacyTopologyObserved ||= totalSteps === 2;
      observation.currentTopologyObserved ||= totalSteps === 4;
    }
  }
  return observations;
}

async function fetchTraceHydration({
  traceId,
  configuration,
  fetchImpl,
  sleepImpl,
}) {
  const activities = [];
  const seenCursors = new Set();
  let cursor = "";
  for (
    let pageNumber = 0;
    pageNumber < MAX_TRACE_HYDRATION_PAGES;
    pageNumber += 1
  ) {
    const body = new URLSearchParams({
      app_id: configuration.appId,
      team_id: configuration.teamId,
      min_log_level: "info",
      component_type: "workflows",
      trace_id: traceId,
      sort_direction: "asc",
      limit: String(MAX_ACTIVITIES_PER_PAGE),
    });
    if (cursor !== "") body.set("cursor", cursor);
    const page = await fetchSlackPage({
      body,
      configuration,
      fetchImpl,
      sleepImpl,
    });
    activities.push(...page.activities);
    if (page.nextCursor === "") {
      return Object.freeze({ activities, paginationBoundReached: false });
    }
    if (seenCursors.has(page.nextCursor)) {
      throw new Error("Slack trace hydration pagination repeated a cursor.");
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  return Object.freeze({ activities, paginationBoundReached: true });
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
      // A failed boundary callback is ambiguous: the Worker may have committed
      // send_started before the Slack function lost the HTTP confirmation.
      // Only the validator step below runs strictly before this side effect.
      preSendFailureProven: false,
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

function sameStepResult(left, right) {
  const leftOutputs = recordFor(left.outputs);
  const rightOutputs = recordFor(right.outputs);
  return (
    left.functionId === right.functionId &&
    left.outcome === right.outcome &&
    leftOutputs?.channel_id === rightOutputs?.channel_id &&
    leftOutputs?.message_ts === rightOutputs?.message_ts
  );
}

export function reconcileSlackActivities(activities, relaySigningSecrets = []) {
  const traces = new Map();
  const errorActivities = [];
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
    if (level === "error" || level === "fatal") {
      errorActivities.push({ created, traceId });
    }
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
        slackChannelId: null,
        slackMessageTs: null,
        outcome: "pending",
        sendBoundaryReached: false,
        preSendFailureProven: false,
        startedAtUs: null,
        completedAtUs: null,
        executionEventCount: 0,
        workflowStartCount: 0,
        workflowResultCount: 0,
        topologyTotalSteps: null,
        stepStarts: new Map(),
        stepResults: new Map(),
      };
      traces.set(traceId, trace);
    }
    trace.executionEventCount += 1;
    const payload = recordFor(activity.payload);
    if (eventType === "workflow_execution_started") {
      trace.workflowStartCount += 1;
      trace.startedAtUs =
        trace.startedAtUs === null
          ? created
          : Math.min(trace.startedAtUs, created);
    }
    if (eventType === "workflow_execution_result") {
      trace.workflowResultCount += 1;
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
    if (eventType === "workflow_step_started") {
      const currentStep = payload?.current_step;
      const totalSteps = payload?.total_steps;
      const functionId = payload?.function_id;
      const functionExecutionId = payload?.function_execution_id;
      if (
        !Number.isSafeInteger(currentStep) ||
        currentStep < 1 ||
        (totalSteps !== 2 && totalSteps !== 4) ||
        currentStep > totalSteps ||
        (trace.topologyTotalSteps !== null &&
          trace.topologyTotalSteps !== totalSteps) ||
        typeof functionId !== "string" ||
        !FUNCTION_ID_PATTERN.test(functionId) ||
        typeof functionExecutionId !== "string" ||
        !FUNCTION_EXECUTION_ID_PATTERN.test(functionExecutionId)
      ) {
        throw new Error("Slack workflow step start has an unknown topology.");
      }
      trace.topologyTotalSteps = totalSteps;
      const existingStart = trace.stepStarts.get(currentStep);
      if (
        existingStart !== undefined &&
        (existingStart.functionId !== functionId ||
          existingStart.functionExecutionId !== functionExecutionId)
      ) {
        throw new Error("Slack trace contains conflicting step starts.");
      }
      for (const [step, value] of trace.stepStarts) {
        if (
          step !== currentStep &&
          value.functionExecutionId === functionExecutionId
        ) {
          throw new Error("Slack trace reuses a function execution ID.");
        }
      }
      trace.stepStarts.set(currentStep, { functionId, functionExecutionId });
    }
    if (eventType === "workflow_step_execution_result") {
      const inputs = recordFor(payload?.inputs);
      const stepOutcome = payload?.exec_outcome;
      const functionId = payload?.function_id;
      const functionExecutionId = payload?.function_execution_id;
      if (
        typeof functionId === "string" &&
        FUNCTION_ID_PATTERN.test(functionId) &&
        typeof functionExecutionId === "string" &&
        FUNCTION_EXECUTION_ID_PATTERN.test(functionExecutionId) &&
        (stepOutcome === "Success" || stepOutcome === "Error")
      ) {
        const result = {
          functionId,
          outcome: stepOutcome,
          outputs: payload?.outputs,
        };
        const existingResult = trace.stepResults.get(functionExecutionId);
        if (
          existingResult !== undefined &&
          !sameStepResult(existingResult, result)
        ) {
          throw new Error("Slack trace contains conflicting step results.");
        }
        trace.stepResults.set(functionExecutionId, result);
      }
      const evidence = authenticatedStepEvidence(
        inputs,
        stepOutcome,
        relaySigningSecrets,
        created,
        functionExecutionId,
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
    if (trace.topologyTotalSteps === 2) {
      const validatorStart = trace.stepStarts.get(1);
      const sendStart = trace.stepStarts.get(2);
      const validatorResult =
        validatorStart === undefined
          ? undefined
          : trace.stepResults.get(validatorStart.functionExecutionId);
      const sendResult =
        sendStart === undefined
          ? undefined
          : trace.stepResults.get(sendStart.functionExecutionId);
      const sendOutputs = recordFor(sendResult?.outputs);
      const exactLegacyTopology =
        trace.executionEventCount === 6 &&
        trace.workflowStartCount === 1 &&
        trace.workflowResultCount === 1 &&
        trace.stepStarts.size === 2 &&
        trace.stepResults.size === 2 &&
        validatorStart?.functionId === LEGACY_VALIDATE_RELAY_FUNCTION_ID &&
        sendStart?.functionId === SLACK_SEND_MESSAGE_FUNCTION_ID &&
        validatorResult?.functionId === LEGACY_VALIDATE_RELAY_FUNCTION_ID &&
        sendResult?.functionId === SLACK_SEND_MESSAGE_FUNCTION_ID &&
        trace.deliveryId === null &&
        trace.relayAttempt === null &&
        trace.sendExecutionId === null &&
        trace.startedAtUs !== null &&
        trace.completedAtUs !== null;
      if (!exactLegacyTopology) {
        throw new Error("Slack legacy workflow trace has an unknown topology.");
      }
      if (
        trace.outcome === "success" &&
        validatorResult.outcome === "Success" &&
        sendResult.outcome === "Success" &&
        sendOutputs !== null &&
        typeof sendOutputs.channel_id === "string" &&
        SLACK_DESTINATION_BY_CHANNEL.has(sendOutputs.channel_id) &&
        typeof sendOutputs.message_ts === "string" &&
        MESSAGE_TS_PATTERN.test(sendOutputs.message_ts)
      ) {
        // This exact two-step topology predates durable receipts. Its message
        // metadata is not an ownership proof for current D1 rows, so it is
        // recognized only to keep the overlap scan compatible and is ignored.
        continue;
      }
      if (
        trace.outcome === "error" &&
        errorActivities.some(({ traceId }) => traceId === trace.traceId)
      ) {
        // Preserve the Slack error in the sanitized aggregate below while
        // allowing receipt-aware traces from the same page to be reconciled.
        continue;
      }
      throw new Error("Slack legacy workflow trace is incomplete.");
    }
    const boundaryStart = trace.stepStarts.get(2);
    const sendStart = trace.stepStarts.get(3);
    const receiptStart = trace.stepStarts.get(4);
    const hasUnboundSendResult = [...trace.stepResults].some(
      ([functionExecutionId, result]) =>
        result.functionId === SLACK_SEND_MESSAGE_FUNCTION_ID &&
        (sendStart === undefined ||
          functionExecutionId !== sendStart.functionExecutionId),
    );
    if (
      hasUnboundSendResult ||
      (sendStart !== undefined && boundaryStart === undefined) ||
      (receiptStart !== undefined &&
        (boundaryStart === undefined || sendStart === undefined)) ||
      (sendStart !== undefined &&
        sendStart.functionId !== SLACK_SEND_MESSAGE_FUNCTION_ID) ||
      (receiptStart !== undefined &&
        boundaryStart?.functionId !== receiptStart.functionId)
    ) {
      throw new Error("Slack workflow trace has an unknown step topology.");
    }
    if (trace.preSendFailureProven && boundaryStart !== undefined) {
      throw new Error("Slack workflow advanced after a failed validator step.");
    }
    if (boundaryStart !== undefined) {
      const boundaryResult = trace.stepResults.get(
        boundaryStart.functionExecutionId,
      );
      if (
        boundaryResult !== undefined &&
        boundaryResult.functionId !== boundaryStart.functionId
      ) {
        throw new Error("Slack boundary step identity changed within a trace.");
      }
      if (boundaryResult?.outcome === "Success") {
        if (
          trace.sendExecutionId !== null &&
          trace.sendExecutionId !== boundaryStart.functionExecutionId
        ) {
          throw new Error(
            "Slack trace contains conflicting send execution IDs.",
          );
        }
        trace.sendExecutionId = boundaryStart.functionExecutionId;
        trace.sendBoundaryReached = true;
        trace.preSendFailureProven = false;
      }
      if (sendStart !== undefined) {
        if (boundaryResult?.outcome === "Error") {
          throw new Error(
            "Slack workflow advanced after a failed boundary step.",
          );
        }
        if (
          trace.sendExecutionId !== null &&
          trace.sendExecutionId !== boundaryStart.functionExecutionId
        ) {
          throw new Error(
            "Slack trace contains conflicting send execution IDs.",
          );
        }
        trace.sendExecutionId = boundaryStart.functionExecutionId;
        trace.sendBoundaryReached = true;
        trace.preSendFailureProven = false;
      }
    }
    if (sendStart !== undefined) {
      const sendResult = trace.stepResults.get(sendStart.functionExecutionId);
      if (
        sendResult !== undefined &&
        sendResult.functionId !== sendStart.functionId
      ) {
        throw new Error("Slack SendMessage identity changed within a trace.");
      }
      if (receiptStart !== undefined && sendResult?.outcome === "Error") {
        throw new Error(
          "Slack workflow advanced after a failed SendMessage step.",
        );
      }
      if (
        sendResult?.outcome === "Success" &&
        boundaryStart !== undefined &&
        trace.sendExecutionId === boundaryStart.functionExecutionId
      ) {
        const outputs = recordFor(sendResult.outputs);
        if (
          outputs === null ||
          typeof outputs.channel_id !== "string" ||
          !SLACK_DESTINATION_BY_CHANNEL.has(outputs.channel_id) ||
          typeof outputs.message_ts !== "string" ||
          !MESSAGE_TS_PATTERN.test(outputs.message_ts)
        ) {
          throw new Error("Slack SendMessage returned malformed evidence.");
        }
        trace.slackChannelId = outputs.channel_id;
        trace.slackMessageTs = outputs.message_ts;
      }
    }
    if (receiptStart !== undefined) {
      const receiptResult = trace.stepResults.get(
        receiptStart.functionExecutionId,
      );
      if (
        receiptResult !== undefined &&
        receiptResult.functionId !== receiptStart.functionId
      ) {
        throw new Error("Slack receipt step identity changed within a trace.");
      }
    }
    const hasExplicitIdentity =
      trace.deliveryId !== null && trace.relayAttempt !== null;
    const hasDerivedIdentity =
      trace.deliveryId === null &&
      trace.relayAttempt === null &&
      trace.sendExecutionId !== null;
    if (
      (hasExplicitIdentity || hasDerivedIdentity) &&
      trace.startedAtUs !== null &&
      (trace.outcome === "pending" || trace.completedAtUs !== null)
    ) {
      normalizedTraces.push({
        trace_id: trace.traceId,
        delivery_id: trace.deliveryId,
        outcome: trace.outcome,
        relay_attempt: trace.relayAttempt,
        send_execution_id: trace.sendExecutionId,
        slack_channel_id: trace.slackChannelId,
        slack_message_ts: trace.slackMessageTs,
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
  const normalizedTraceIds = new Set(
    normalizedTraces
      .filter((trace) => trace.outcome === "error")
      .map((trace) => trace.trace_id),
  );
  const errors = errorActivities.filter(
    ({ traceId }) =>
      typeof traceId !== "string" || !normalizedTraceIds.has(traceId),
  ).length;
  return Object.freeze({ errors, maximumCreated, traces: normalizedTraces });
}

async function postReconciliation({
  checkpointUs,
  previousCheckpointUs,
  hydrations = [],
  traces,
  configuration,
  fetchImpl,
  now,
  reconciliationVersion,
  scanState,
  uncorrelatedErrors,
}) {
  const chunks = [];
  for (let index = 0; index < traces.length; index += REPORT_TRACE_LIMIT) {
    chunks.push({
      traces: traces.slice(index, index + REPORT_TRACE_LIMIT),
      hydrations: [],
    });
  }
  if (reconciliationVersion === 5) {
    for (
      let index = 0;
      index < hydrations.length;
      index += REPORT_TRACE_LIMIT
    ) {
      chunks.push({
        traces: [],
        hydrations: hydrations.slice(index, index + REPORT_TRACE_LIMIT),
      });
    }
  }
  if (chunks.length === 0) chunks.push({ traces: [], hydrations: [] });
  let acknowledgedCheckpointUs = previousCheckpointUs;

  for (let index = 0; index < chunks.length; index += 1) {
    const final = index === chunks.length - 1;
    const currentTime = now();
    if (!Number.isSafeInteger(currentTime) || currentTime <= 0) {
      throw new Error("The monitor clock returned an invalid timestamp.");
    }
    const reportTimestamp = String(Math.floor(currentTime / 1_000));
    const unsigned = {
      checkpoint_us: final ? checkpointUs : previousCheckpointUs,
      report_timestamp: reportTimestamp,
      ...(reconciliationVersion >= 4
        ? { scan_state: final ? scanState : "preserve" }
        : {}),
      ...(reconciliationVersion === 5
        ? { hydrations: chunks[index].hydrations }
        : {}),
      traces: chunks[index].traces,
    };
    const response = await relayPost(
      fetchImpl,
      RECONCILIATION_URL,
      {
        ...unsigned,
        report_signature: signature(
          configuration.relaySigningSecret,
          reconciliationCanonical(unsigned, reconciliationVersion),
        ),
      },
      `Relay reconciliation report ${index + 1}/${chunks.length}`,
      RELAY_REPORT_TIMEOUT_MS,
      {
        retryAmbiguous: true,
        replayTimeoutMs: RELAY_REPORT_REPLAY_TIMEOUT_MS,
      },
    );
    const currentShape = hasExactKeys(response, [
      "ok",
      "traces",
      "changed_error_traces",
      "checkpoint_us",
    ]);
    const v5Shape =
      reconciliationVersion === 5 &&
      hasExactKeys(response, [
        "ok",
        "traces",
        "hydrations",
        "changed_error_traces",
        "checkpoint_us",
      ]);
    const bridgeShape =
      reconciliationVersion === 2 &&
      hasExactKeys(response, ["ok", "traces", "checkpoint_us"]);
    const acceptedShape =
      reconciliationVersion === 5
        ? v5Shape
        : reconciliationVersion === 2
          ? bridgeShape
          : currentShape;
    if (!acceptedShape || response.ok !== true) {
      throw new Error("Relay reconciliation report was not accepted.");
    }
    if (
      response.traces !== chunks[index].traces.length ||
      (v5Shape && response.hydrations !== chunks[index].hydrations.length) ||
      (reconciliationVersion !== 2 &&
        (!Number.isSafeInteger(response.changed_error_traces) ||
          response.changed_error_traces < 0 ||
          response.changed_error_traces > response.traces)) ||
      !Number.isSafeInteger(response.checkpoint_us) ||
      response.checkpoint_us < previousCheckpointUs ||
      response.checkpoint_us > unsigned.checkpoint_us
    ) {
      throw new Error("Relay reconciliation report returned invalid counts.");
    }
    const changedErrorTraces =
      reconciliationVersion !== 2
        ? response.changed_error_traces
        : chunks[index].traces.filter((trace) => trace.outcome === "error")
            .length;
    if (changedErrorTraces > 0) {
      throw slackWorkflowError(
        changedErrorTraces + (final ? uncorrelatedErrors : 0),
      );
    }
    if (final) acknowledgedCheckpointUs = response.checkpoint_us;
  }
  return acknowledgedCheckpointUs;
}

function slackWorkflowError(errors) {
  const noun = errors === 1 ? "error" : "errors";
  return new Error(
    `Slack recorded ${errors} new or uncorrelated workflow ${noun}; activity payloads withheld after durable reconciliation.`,
  );
}

function bridgeCompatibleTrace(trace) {
  return (
    trace.outcome === "error" &&
    trace.delivery_id !== null &&
    trace.relay_attempt !== null &&
    trace.slack_channel_id === null &&
    trace.slack_message_ts === null
  );
}

function asBridgeTrace(trace) {
  return Object.freeze({
    trace_id: trace.trace_id,
    delivery_id: trace.delivery_id,
    outcome: trace.outcome,
    relay_attempt: trace.relay_attempt,
    send_execution_id: trace.send_execution_id,
    send_boundary_reached: trace.send_boundary_reached,
    pre_send_failure_proven: trace.pre_send_failure_proven,
    started_at_us: trace.started_at_us,
    completed_at_us: trace.completed_at_us,
  });
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
  const checkpoint = await readCheckpoint(
    fetchImpl,
    configuration,
    reportTimestamp,
  );
  const previousCheckpointUs = checkpoint.checkpointUs;
  const minimumFromCheckpoint = Math.max(
    0,
    previousCheckpointUs - CHECKPOINT_OVERLAP_US,
  );
  const minDateCreated =
    checkpoint.resumeFromUs !== null
      ? checkpoint.resumeFromUs
      : previousCheckpointUs === 0
        ? currentTimeUs - INITIAL_LOOKBACK_US
        : minimumFromCheckpoint;

  const activities = [];
  const seenCursors = new Set();
  let cursor = "";
  let pages = 0;
  let caughtUp = false;
  while (pages < MAX_PAGES) {
    pages += 1;
    const body = new URLSearchParams({
      app_id: configuration.appId,
      team_id: configuration.teamId,
      min_log_level: "info",
      component_type: "workflows",
      min_date_created: String(minDateCreated),
      max_date_created: String(currentTimeUs),
      sort_direction: "asc",
      limit: String(MAX_ACTIVITIES_PER_PAGE),
    });
    if (cursor !== "") body.set("cursor", cursor);
    const page = await fetchSlackPage({
      body,
      configuration,
      fetchImpl,
      sleepImpl,
    });
    activities.push(...page.activities);
    if (page.nextCursor === "") {
      caughtUp = true;
      break;
    }
    if (seenCursors.has(page.nextCursor)) {
      throw new Error("Slack activity pagination repeated a cursor.");
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  if (checkpoint.reconciliationVersion === 5) {
    const temporalObservations = observeExecutionTraces(activities);
    const hydrationCandidateIds = [];
    const hydrationCandidateSet = new Set();
    const addHydrationCandidate = (traceId) => {
      if (hydrationCandidateSet.has(traceId)) return;
      hydrationCandidateSet.add(traceId);
      hydrationCandidateIds.push(traceId);
    };
    for (const traceId of checkpoint.pendingTraceIds) {
      const observation = temporalObservations.get(traceId);
      if (
        observation?.legacyTopologyObserved === true &&
        observation.currentTopologyObserved === false
      ) {
        continue;
      }
      addHydrationCandidate(traceId);
    }
    for (const [traceId, observation] of temporalObservations) {
      if (
        !observation.legacyTopologyObserved &&
        (!observation.hasStart || !observation.hasTerminal)
      ) {
        addHydrationCandidate(traceId);
      }
    }

    const hydrationActivities = [];
    const attemptedHydrationTraceIds = [];
    const paginationBoundTraceIds = new Set();
    let hydrationFailure = null;
    for (const traceId of hydrationCandidateIds.slice(
      0,
      MAX_TRACE_HYDRATIONS_PER_RUN,
    )) {
      attemptedHydrationTraceIds.push(traceId);
      try {
        const hydration = await fetchTraceHydration({
          traceId,
          configuration,
          fetchImpl,
          sleepImpl,
        });
        hydrationActivities.push(...hydration.activities);
        if (hydration.paginationBoundReached) {
          paginationBoundTraceIds.add(traceId);
        }
      } catch (error) {
        hydrationFailure = error;
        break;
      }
    }

    const combinedActivities = deduplicateSlackActivities([
      ...activities,
      ...hydrationActivities,
    ]);
    const attemptedHydrationTraceIdSet = new Set(attemptedHydrationTraceIds);
    const checkpointPendingTraceIdSet = new Set(checkpoint.pendingTraceIds);
    const reconciliation = reconcileSlackActivities(
      combinedActivities,
      configuration.relaySigningSecrets,
    );
    const normalizedTracesById = new Map(
      reconciliation.traces.map((trace) => [trace.trace_id, trace]),
    );
    const combinedObservations = observeExecutionTraces(combinedActivities);
    const hydrationIds = [];
    const hydrationIdsSet = new Set();
    const legacyHydrationTraceIds = new Set();
    const addHydrationId = (traceId) => {
      if (hydrationIdsSet.has(traceId)) return;
      hydrationIdsSet.add(traceId);
      hydrationIds.push(traceId);
    };
    for (const traceId of attemptedHydrationTraceIds) {
      const observation = combinedObservations.get(traceId);
      if (
        observation?.legacyTopologyObserved === true &&
        observation.currentTopologyObserved === false
      ) {
        legacyHydrationTraceIds.add(traceId);
        addHydrationId(traceId);
        continue;
      }
      addHydrationId(traceId);
    }
    for (const [traceId, observation] of combinedObservations) {
      if (
        observation.legacyTopologyObserved &&
        !observation.currentTopologyObserved
      ) {
        if (
          attemptedHydrationTraceIdSet.has(traceId) ||
          checkpointPendingTraceIdSet.has(traceId)
        ) {
          legacyHydrationTraceIds.add(traceId);
          addHydrationId(traceId);
        }
        continue;
      }
      addHydrationId(traceId);
    }

    const hydrations = [];
    for (const traceId of hydrationIds) {
      const normalizedTrace = normalizedTracesById.get(traceId);
      const observation = combinedObservations.get(traceId);
      // The checkpoint exposes a global oldest timestamp for health/fairness,
      // not a trace-to-timestamp mapping. Never attribute that age to an
      // arbitrary fair-page member; D1 preserves each registry row's minimum
      // observation and performs the exact retention transition atomically.
      const firstObservedUs = observation?.firstObservedUs ?? currentTimeUs;
      const lastObservedUs = observation?.lastObservedUs ?? firstObservedUs;
      if (legacyHydrationTraceIds.has(traceId)) {
        hydrations.push(
          Object.freeze({
            trace_id: traceId,
            first_observed_us: firstObservedUs,
            last_observed_us: lastObservedUs,
            status: "legacy",
            debt_reason: null,
            attempted: attemptedHydrationTraceIdSet.has(traceId),
          }),
        );
        continue;
      }
      const paginationBoundReached = paginationBoundTraceIds.has(traceId);
      const retentionExpired =
        currentTimeUs - firstObservedUs >= SLACK_ACTIVITY_RETENTION_US;
      const debtReason = paginationBoundReached
        ? "pagination_bound"
        : retentionExpired
          ? "retention_expired"
          : null;
      if (normalizedTrace !== undefined) {
        if (
          normalizedTrace.outcome === "pending" &&
          (attemptedHydrationTraceIdSet.has(traceId) || debtReason !== null)
        ) {
          hydrations.push(
            Object.freeze({
              trace_id: traceId,
              first_observed_us: firstObservedUs,
              last_observed_us: lastObservedUs,
              status: debtReason === null ? "pending" : "debt",
              debt_reason: debtReason,
              attempted: attemptedHydrationTraceIdSet.has(traceId),
            }),
          );
        }
        continue;
      }
      hydrations.push(
        Object.freeze({
          trace_id: traceId,
          first_observed_us: firstObservedUs,
          last_observed_us: lastObservedUs,
          status: debtReason === null ? "pending" : "debt",
          debt_reason: debtReason,
          attempted: attemptedHydrationTraceIdSet.has(traceId),
        }),
      );
    }

    let temporalMaximumCreated = 0;
    for (const activityValue of activities) {
      const created = recordFor(activityValue)?.created;
      if (Number.isSafeInteger(created) && created >= 0) {
        temporalMaximumCreated = Math.max(temporalMaximumCreated, created);
      }
    }
    const evidenceCheckpointUs =
      temporalMaximumCreated === 0
        ? previousCheckpointUs === 0
          ? minDateCreated
          : previousCheckpointUs
        : Math.max(previousCheckpointUs, temporalMaximumCreated);
    const hasPendingHydration = hydrations.some(
      (hydration) => hydration.status === "pending",
    );
    const reportTraces = reconciliation.traces;
    const reportCheckpointUs = hasPendingHydration
      ? previousCheckpointUs
      : evidenceCheckpointUs;
    const canPersistInitialBoundedResume =
      !caughtUp && previousCheckpointUs > 0 && checkpoint.resumeFromUs === null;
    if (
      !caughtUp &&
      !hasPendingHydration &&
      (temporalMaximumCreated <= previousCheckpointUs ||
        reportCheckpointUs <= previousCheckpointUs) &&
      !canPersistInitialBoundedResume
    ) {
      throw new Error(
        "Slack activity pagination could not advance its checkpoint within its safety bound.",
      );
    }
    const acknowledgedCheckpointUs = await postReconciliation({
      checkpointUs: reportCheckpointUs,
      previousCheckpointUs,
      hydrations,
      traces: reportTraces,
      configuration,
      fetchImpl,
      now,
      reconciliationVersion: checkpoint.reconciliationVersion,
      scanState: caughtUp ? "complete" : "resume",
      uncorrelatedErrors: reconciliation.errors,
    });

    if (hydrationFailure !== null) throw hydrationFailure;
    if (hasPendingHydration) {
      throw new Error(
        "Slack trace hydration remains incomplete after durable reconciliation.",
      );
    }
    if (!caughtUp && acknowledgedCheckpointUs <= previousCheckpointUs) {
      throw new Error(
        "Relay did not acknowledge Slack activity checkpoint progress within its safety bound.",
      );
    }
    if (reconciliation.errors > 0) {
      throw slackWorkflowError(reconciliation.errors);
    }
    if (!caughtUp) {
      throw new Error(
        `Slack activity catch-up acknowledged durable checkpoint progress after ${pages} pages; more activity remains for the next scheduled run.`,
      );
    }
    return Object.freeze({
      caughtUp: true,
      errors: 0,
      pages,
      traces: reportTraces.length,
    });
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
  // Resume inclusively before an incomplete trace so its terminal suffix is
  // never detached from the authenticated start observed in this prefix.
  const earliestPendingTraceStartUs = reconciliation.traces.reduce(
    (earliest, trace) =>
      trace.outcome !== "pending"
        ? earliest
        : earliest === null
          ? trace.started_at_us
          : Math.min(earliest, trace.started_at_us),
    null,
  );
  const traceSafeCheckpointUs =
    earliestPendingTraceStartUs === null
      ? evidenceCheckpointUs
      : Math.min(
          evidenceCheckpointUs,
          Math.max(previousCheckpointUs, earliestPendingTraceStartUs),
        );
  const bridgeTraces = reconciliation.traces.filter(bridgeCompatibleTrace);
  const reportTraces =
    checkpoint.reconciliationVersion >= 3
      ? reconciliation.traces
      : bridgeTraces.map(asBridgeTrace);
  const reportCheckpointUs =
    checkpoint.reconciliationVersion === 2 &&
    bridgeTraces.length !== reconciliation.traces.length
      ? previousCheckpointUs
      : traceSafeCheckpointUs;
  const withheldBridgeTraces =
    checkpoint.reconciliationVersion === 2
      ? reconciliation.traces.filter((trace) => !bridgeCompatibleTrace(trace))
          .length
      : 0;
  const canPersistInitialBoundedResume =
    !caughtUp &&
    previousCheckpointUs > 0 &&
    checkpoint.reconciliationVersion === 4 &&
    checkpoint.resumeFromUs === null;
  if (
    !caughtUp &&
    (reconciliation.maximumCreated <= previousCheckpointUs ||
      reportCheckpointUs <= previousCheckpointUs) &&
    !canPersistInitialBoundedResume
  ) {
    throw new Error(
      "Slack activity pagination could not advance its checkpoint within its safety bound.",
    );
  }
  if (!caughtUp && checkpoint.reconciliationVersion !== 4) {
    throw new Error(
      "Relay reconciliation v4 is required to resume bounded Slack activity catch-up.",
    );
  }
  const acknowledgedCheckpointUs = await postReconciliation({
    checkpointUs: reportCheckpointUs,
    previousCheckpointUs,
    traces: reportTraces,
    configuration,
    fetchImpl,
    now,
    reconciliationVersion: checkpoint.reconciliationVersion,
    scanState: caughtUp ? "complete" : "resume",
    uncorrelatedErrors: reconciliation.errors,
  });

  if (!caughtUp && acknowledgedCheckpointUs <= previousCheckpointUs) {
    throw new Error(
      "Relay did not acknowledge Slack activity checkpoint progress within its safety bound.",
    );
  }

  if (reconciliation.errors > 0) {
    throw slackWorkflowError(reconciliation.errors);
  }
  if (withheldBridgeTraces > 0) {
    const noun = withheldBridgeTraces === 1 ? "trace" : "traces";
    throw new Error(
      `Slack retained ${withheldBridgeTraces} ${noun} until relay reconciliation v3 or newer becomes available; activity payloads withheld.`,
    );
  }
  if (!caughtUp) {
    throw new Error(
      `Slack activity catch-up acknowledged durable checkpoint progress after ${pages} pages; more activity remains for the next scheduled run.`,
    );
  }
  return Object.freeze({
    caughtUp: true,
    errors: 0,
    pages,
    traces: reportTraces.length,
  });
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (invokedPath === import.meta.url) {
  monitorSlackWorkflow()
    .then((result) => {
      const message = `Slack workflow monitor reconciled ${result.traces} traces across ${result.pages} pages`;
      console.info(`${message} with no errors.`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : "Monitor failed.");
      process.exitCode = 1;
    });
}
