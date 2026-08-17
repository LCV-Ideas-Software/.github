import {
  asRecord,
  nestedRecord,
  nestedString,
  normalizeGitHubEvent,
  type RelayDestination,
  SUPPORTED_RELAY_EVENTS,
  TARGET_ORGANIZATION,
} from "./domain";
import {
  readSecret,
  signSlackRelayPayload,
  type SignedSlackCheckpointRequest,
  type SignedSlackProgress,
  type SignedSlackReconciliation,
  type SignedSlackReconciliationV3,
  type SignedSlackReconciliationV4,
  verifySlackCheckpointRequest,
  verifySlackProgress,
  verifySlackReconciliation,
  verifySlackReconciliationV3,
  verifySlackReconciliationV4,
  verifySlackReconciliationV2,
  verifyGitHubSignature,
} from "./security";
import {
  D1DeliveryStore,
  SlackProgressConflictError,
  SlackReconciliationConflictError,
  type DeliveryStore,
  type QueueJob,
  type StoredDelivery,
} from "./store";
import { type AlertQueueMessage, recuoMs } from "./alerts/contract";
import { processAlertMessage } from "./alerts/consumer";
import { runAlertCron } from "./alerts/cron";
import { statusBody, verifyStatusSecret } from "./alerts/status";
import { AlertStore } from "./alerts/store";

const WEBHOOK_PATH = "/github/webhook";
const ALERTS_STATUS_PATH = "/alerts/status";
const HEALTH_PATH = "/healthz";
const SLACK_PROGRESS_PATH = "/slack/progress";
const SLACK_RECONCILIATION_PATH = "/slack/reconciliation";
const SLACK_CHECKPOINT_PATH = "/slack/reconciliation/checkpoint";
const ALERT_QUEUE_NAME = "github-slack-alerts";
const ALERT_DEAD_LETTER_QUEUE = "github-slack-alerts-dlq";
const ACTIVITY_QUEUE_NAME = "github-slack-activity";
const ACTIVITY_DEAD_LETTER_QUEUE = "github-slack-activity-dlq";
const MAX_BODY_BYTES = 25_000_000;
const MINIMUM_SLACK_INTERVAL_MS = 6_100;
const MAXIMUM_DELIVERY_ATTEMPTS = 25;
const RECOVERY_LIMIT = 50;
const STALE_AFTER_MS = 15 * 60 * 1_000;
const SLACK_RECONCILIATION_GRACE_MS = 20 * 60 * 1_000;
const DELIVERED_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/u;
const EVENT_NAME_PATTERN = /^[a-z0-9_]{1,64}$/u;
const MINIMUM_SECRET_BYTES = 32;
const MAXIMUM_CONTROL_BODY_BYTES = 128_000;
const AUTHENTICATED_REQUEST_MAX_AGE_SECONDS = 300;
const AUTHENTICATED_REQUEST_MAX_FUTURE_SECONDS = 60;
const SLACK_MESSAGE_TS_PATTERN = /^\d{10,13}\.\d{6}$/u;
const SLACK_TRACE_ID_PATTERN = /^Tr[A-Za-z0-9_-]{1,125}$/u;
const SLACK_RECONCILIATION_TRACE_LIMIT = 25;
const WORKER_REVISION_PATTERN = /^[0-9a-f]{40}$/u;

export interface RuntimeOverrides {
  store?: DeliveryStore;
  alertStore?: AlertStore;
  now?: () => number;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface SchedulerResult {
  purged: number;
  recovered: number;
  enqueueFailures: number;
}

interface RelaySigningConfiguration {
  active: string;
  next: string | null;
}

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function safeFailureSummary(error: unknown): {
  error_name: string;
  error_message: string;
  error_code?: string;
} {
  const candidate = error instanceof Error ? error : undefined;
  const cause = candidate?.cause;
  const code =
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string" &&
    /^[A-Z0-9_]{1,64}$/u.test(cause.code)
      ? cause.code
      : undefined;
  const message = (candidate?.message ?? "non_error_failure")
    .replace(/https?:\/\/[^\s]+/giu, "[redacted-url]")
    .slice(0, 256);

  return {
    error_name: candidate?.name ?? typeof error,
    error_message: message,
    ...(code === undefined ? {} : { error_code: code }),
  };
}

function runtime(
  env: Env,
  overrides?: RuntimeOverrides,
): Required<RuntimeOverrides> {
  return {
    store: overrides?.store ?? new D1DeliveryStore(env.DB),
    alertStore: overrides?.alertStore ?? new AlertStore(env.DB),
    now: overrides?.now ?? Date.now,
    fetch: overrides?.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    sleep: overrides?.sleep ?? ((milliseconds) => scheduler.wait(milliseconds)),
  };
}

function validDeliveryId(value: unknown): value is string {
  return typeof value === "string" && DELIVERY_ID_PATTERN.test(value);
}

function destinationQueue(env: Env, destination: RelayDestination): Queue {
  return destination === "alerts" ? env.ALERT_QUEUE : env.ACTIVITY_QUEUE;
}

function queueJob(value: unknown): QueueJob | null {
  const record = asRecord(value);
  const deliveryId = record?.deliveryId;
  return validDeliveryId(deliveryId) ? { deliveryId } : null;
}

function repositoryFromPayload(payload: Record<string, unknown>): {
  fullName: string;
  archived: boolean;
  owner: string;
  defaultBranch: string;
} | null {
  const repository = nestedRecord(payload, "repository");
  if (repository === undefined) {
    return null;
  }

  const fullName = nestedString(repository, "full_name");
  const owner = nestedString(repository, "owner", "login");
  return {
    fullName,
    owner,
    defaultBranch: nestedString(repository, "default_branch"),
    archived: repository.archived === true,
  };
}

function sameOrganization(login: string): boolean {
  return login.toLowerCase() === TARGET_ORGANIZATION.toLowerCase();
}

function contentLengthTooLarge(request: Request): boolean {
  const header = request.headers.get("content-length");
  if (header === null) {
    return false;
  }

  const length = Number.parseInt(header, 10);
  return Number.isFinite(length) && length > MAX_BODY_BYTES;
}

function hasSafeSecretLength(value: string): boolean {
  return new TextEncoder().encode(value).byteLength >= MINIMUM_SECRET_BYTES;
}

async function readBodyWithLimit(
  request: Request,
  maximumBytes = MAX_BODY_BYTES,
): Promise<{ kind: "ok"; body: ArrayBuffer } | { kind: "too_large" }> {
  if (request.body === null) {
    return { kind: "ok", body: new ArrayBuffer(0) };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }

      total += result.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("payload_too_large");
        return { kind: "too_large" };
      }

      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { kind: "ok", body: combined.buffer };
}

function exactKeys(record: Record<string, unknown>, names: string[]): boolean {
  const actual = Object.keys(record).sort();
  const expected = [...names].sort();
  return (
    actual.length === expected.length &&
    actual.every((name, index) => name === expected[index])
  );
}

async function readControlRecord(
  request: Request,
): Promise<Record<string, unknown> | null> {
  if (contentLengthTooLarge(request)) return null;
  const body = await readBodyWithLimit(request, MAXIMUM_CONTROL_BODY_BYTES);
  if (body.kind !== "ok") return null;
  try {
    const decoded = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(body.body);
    return asRecord(JSON.parse(decoded) as unknown) ?? null;
  } catch {
    return null;
  }
}

function authenticatedTimestampIsFresh(value: string, now: number): boolean {
  if (!/^\d{10}$/u.test(value)) return false;
  const timestamp = Number.parseInt(value, 10);
  const nowSeconds = Math.floor(now / 1_000);
  return (
    timestamp >= nowSeconds - AUTHENTICATED_REQUEST_MAX_AGE_SECONDS &&
    timestamp <= nowSeconds + AUTHENTICATED_REQUEST_MAX_FUTURE_SECONDS
  );
}

function parseSlackProgress(
  record: Record<string, unknown>,
  now: number,
): SignedSlackProgress | null {
  if (
    !exactKeys(record, [
      "delivery_id",
      "destination",
      "phase",
      "message_ts",
      "relay_attempt",
      "function_execution_id",
      "receipt_timestamp",
      "receipt_signature",
    ])
  ) {
    return null;
  }
  const deliveryId = record.delivery_id;
  const destination = record.destination;
  const phase = record.phase;
  const messageTs = record.message_ts;
  const relayAttempt = record.relay_attempt;
  const functionExecutionId = record.function_execution_id;
  const receiptTimestamp = record.receipt_timestamp;
  const receiptSignature = record.receipt_signature;
  if (
    !validDeliveryId(deliveryId) ||
    (destination !== "alerts" && destination !== "activity") ||
    (phase !== "send_started" && phase !== "delivered") ||
    typeof messageTs !== "string" ||
    typeof relayAttempt !== "string" ||
    !/^[1-9][0-9]{0,15}$/u.test(relayAttempt) ||
    !Number.isSafeInteger(Number.parseInt(relayAttempt, 10)) ||
    typeof functionExecutionId !== "string" ||
    !/^Fx[A-Za-z0-9]{1,126}$/u.test(functionExecutionId) ||
    typeof receiptTimestamp !== "string" ||
    !authenticatedTimestampIsFresh(receiptTimestamp, now) ||
    typeof receiptSignature !== "string" ||
    !/^[0-9a-f]{64}$/u.test(receiptSignature) ||
    (phase === "send_started" && messageTs !== "") ||
    (phase === "delivered" && !SLACK_MESSAGE_TS_PATTERN.test(messageTs))
  ) {
    return null;
  }
  return {
    delivery_id: deliveryId,
    destination,
    phase,
    message_ts: messageTs,
    relay_attempt: relayAttempt,
    function_execution_id: functionExecutionId,
    receipt_timestamp: receiptTimestamp,
    receipt_signature: receiptSignature,
  };
}

function parseSlackCheckpointRequest(
  record: Record<string, unknown>,
  now: number,
): SignedSlackCheckpointRequest | null {
  if (!exactKeys(record, ["request_timestamp", "request_signature"])) {
    return null;
  }
  const requestTimestamp = record.request_timestamp;
  const requestSignature = record.request_signature;
  if (
    typeof requestTimestamp !== "string" ||
    !authenticatedTimestampIsFresh(requestTimestamp, now) ||
    typeof requestSignature !== "string" ||
    !/^[0-9a-f]{64}$/u.test(requestSignature)
  ) {
    return null;
  }
  return {
    request_timestamp: requestTimestamp,
    request_signature: requestSignature,
  };
}

function parseSlackReconciliation(
  record: Record<string, unknown>,
  now: number,
): SignedSlackReconciliation | null {
  if (
    !exactKeys(record, [
      "checkpoint_us",
      "report_timestamp",
      "scan_state",
      "hydrations",
      "traces",
      "report_signature",
    ]) ||
    !Array.isArray(record.hydrations) ||
    !Array.isArray(record.traces) ||
    record.hydrations.length + record.traces.length >
      SLACK_RECONCILIATION_TRACE_LIMIT
  ) {
    return null;
  }

  const legacyRecord = { ...record };
  delete legacyRecord.scan_state;
  delete legacyRecord.hydrations;
  const legacy = parseSlackReconciliationV3(legacyRecord, now);
  if (legacy === null) return null;

  const hydrations: SignedSlackReconciliation["hydrations"] = [];
  const traceIds = new Set(legacy.traces.map((trace) => trace.trace_id));
  for (const candidate of record.hydrations) {
    const hydration = asRecord(candidate);
    if (
      hydration === undefined ||
      !exactKeys(hydration, [
        "trace_id",
        "first_observed_us",
        "last_observed_us",
        "status",
        "debt_reason",
        "attempted",
      ]) ||
      typeof hydration.trace_id !== "string" ||
      !SLACK_TRACE_ID_PATTERN.test(hydration.trace_id) ||
      traceIds.has(hydration.trace_id) ||
      !Number.isSafeInteger(hydration.first_observed_us) ||
      (hydration.first_observed_us as number) < 0 ||
      !Number.isSafeInteger(hydration.last_observed_us) ||
      (hydration.last_observed_us as number) <
        (hydration.first_observed_us as number) ||
      (hydration.status !== "pending" &&
        hydration.status !== "debt" &&
        hydration.status !== "legacy") ||
      ((hydration.status === "pending" || hydration.status === "legacy") &&
        hydration.debt_reason !== null) ||
      (hydration.status === "debt" &&
        hydration.debt_reason !== "retention_expired" &&
        hydration.debt_reason !== "pagination_bound") ||
      typeof hydration.attempted !== "boolean"
    ) {
      return null;
    }
    traceIds.add(hydration.trace_id);
    hydrations.push({
      trace_id: hydration.trace_id,
      first_observed_us: hydration.first_observed_us as number,
      last_observed_us: hydration.last_observed_us as number,
      status: hydration.status,
      debt_reason: hydration.debt_reason as
        "retention_expired" | "pagination_bound" | null,
      attempted: hydration.attempted,
    });
  }

  if (
    record.scan_state !== "preserve" &&
    record.scan_state !== "resume" &&
    record.scan_state !== "complete"
  ) {
    return null;
  }

  return {
    ...legacy,
    scan_state: record.scan_state,
    hydrations,
  };
}

function parseSlackReconciliationV4(
  record: Record<string, unknown>,
  now: number,
): SignedSlackReconciliationV4 | null {
  if (
    !exactKeys(record, [
      "checkpoint_us",
      "report_timestamp",
      "scan_state",
      "traces",
      "report_signature",
    ]) ||
    (record.scan_state !== "preserve" &&
      record.scan_state !== "resume" &&
      record.scan_state !== "complete")
  ) {
    return null;
  }
  const legacyRecord = { ...record };
  delete legacyRecord.scan_state;
  const legacy = parseSlackReconciliationV3(legacyRecord, now);
  return legacy === null ? null : { ...legacy, scan_state: record.scan_state };
}

function parseSlackReconciliationV3(
  record: Record<string, unknown>,
  now: number,
): SignedSlackReconciliationV3 | null {
  if (
    !exactKeys(record, [
      "checkpoint_us",
      "report_timestamp",
      "traces",
      "report_signature",
    ]) ||
    !Number.isSafeInteger(record.checkpoint_us) ||
    (record.checkpoint_us as number) < 0 ||
    typeof record.report_timestamp !== "string" ||
    !authenticatedTimestampIsFresh(record.report_timestamp, now) ||
    !Array.isArray(record.traces) ||
    record.traces.length > SLACK_RECONCILIATION_TRACE_LIMIT ||
    typeof record.report_signature !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.report_signature)
  ) {
    return null;
  }

  const traces: SignedSlackReconciliationV3["traces"] = [];
  const traceIds = new Set<string>();
  for (const candidate of record.traces) {
    const trace = asRecord(candidate);
    if (
      trace === undefined ||
      !exactKeys(trace, [
        "trace_id",
        "delivery_id",
        "outcome",
        "relay_attempt",
        "send_execution_id",
        "slack_channel_id",
        "slack_message_ts",
        "send_boundary_reached",
        "pre_send_failure_proven",
        "started_at_us",
        "completed_at_us",
      ]) ||
      typeof trace.trace_id !== "string" ||
      !SLACK_TRACE_ID_PATTERN.test(trace.trace_id) ||
      traceIds.has(trace.trace_id) ||
      (trace.delivery_id === null) !== (trace.relay_attempt === null) ||
      (trace.delivery_id !== null && !validDeliveryId(trace.delivery_id)) ||
      (trace.outcome !== "pending" &&
        trace.outcome !== "success" &&
        trace.outcome !== "error") ||
      (trace.relay_attempt !== null &&
        (typeof trace.relay_attempt !== "string" ||
          !/^[1-9][0-9]{0,15}$/u.test(trace.relay_attempt) ||
          !Number.isSafeInteger(Number.parseInt(trace.relay_attempt, 10)))) ||
      (trace.send_execution_id !== null &&
        (typeof trace.send_execution_id !== "string" ||
          !/^Fx[A-Za-z0-9]{1,126}$/u.test(trace.send_execution_id))) ||
      (trace.delivery_id === null && trace.send_execution_id === null) ||
      (trace.slack_channel_id === null) !== (trace.slack_message_ts === null) ||
      (trace.slack_channel_id !== null &&
        trace.slack_channel_id !== "C0BMUK793NV" &&
        trace.slack_channel_id !== "C0BMQMW3L4E") ||
      (trace.slack_message_ts !== null &&
        (typeof trace.slack_message_ts !== "string" ||
          !SLACK_MESSAGE_TS_PATTERN.test(trace.slack_message_ts) ||
          trace.send_execution_id === null ||
          trace.send_boundary_reached !== true ||
          trace.pre_send_failure_proven !== false)) ||
      typeof trace.send_boundary_reached !== "boolean" ||
      typeof trace.pre_send_failure_proven !== "boolean" ||
      (trace.pre_send_failure_proven === true &&
        trace.send_execution_id === null) ||
      (trace.pre_send_failure_proven === true &&
        (trace.outcome === "success" ||
          trace.send_boundary_reached === true)) ||
      !Number.isSafeInteger(trace.started_at_us) ||
      (trace.started_at_us as number) < 0 ||
      (trace.completed_at_us !== null &&
        (!Number.isSafeInteger(trace.completed_at_us) ||
          (trace.completed_at_us as number) <
            (trace.started_at_us as number))) ||
      (trace.outcome === "pending" && trace.completed_at_us !== null) ||
      (trace.outcome !== "pending" && trace.completed_at_us === null)
    ) {
      return null;
    }
    traceIds.add(trace.trace_id);
    traces.push({
      trace_id: trace.trace_id,
      delivery_id: trace.delivery_id,
      outcome: trace.outcome,
      relay_attempt: trace.relay_attempt,
      send_execution_id: trace.send_execution_id,
      slack_channel_id: trace.slack_channel_id,
      slack_message_ts: trace.slack_message_ts,
      send_boundary_reached: trace.send_boundary_reached,
      pre_send_failure_proven: trace.pre_send_failure_proven,
      started_at_us: trace.started_at_us as number,
      completed_at_us: trace.completed_at_us as number | null,
    });
  }

  return {
    checkpoint_us: record.checkpoint_us as number,
    report_timestamp: record.report_timestamp,
    traces,
    report_signature: record.report_signature,
  };
}

function parseSlackReconciliationV2(
  record: Record<string, unknown>,
  now: number,
): SignedSlackReconciliationV3 | null {
  if (
    !exactKeys(record, [
      "checkpoint_us",
      "report_timestamp",
      "traces",
      "report_signature",
    ]) ||
    !Number.isSafeInteger(record.checkpoint_us) ||
    (record.checkpoint_us as number) < 0 ||
    typeof record.report_timestamp !== "string" ||
    !authenticatedTimestampIsFresh(record.report_timestamp, now) ||
    !Array.isArray(record.traces) ||
    record.traces.length > SLACK_RECONCILIATION_TRACE_LIMIT ||
    typeof record.report_signature !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.report_signature)
  ) {
    return null;
  }

  const traces: SignedSlackReconciliationV3["traces"] = [];
  const traceIds = new Set<string>();
  for (const candidate of record.traces) {
    const trace = asRecord(candidate);
    if (
      trace === undefined ||
      !exactKeys(trace, [
        "trace_id",
        "delivery_id",
        "outcome",
        "relay_attempt",
        "send_execution_id",
        "send_boundary_reached",
        "pre_send_failure_proven",
        "started_at_us",
        "completed_at_us",
      ]) ||
      typeof trace.trace_id !== "string" ||
      !SLACK_TRACE_ID_PATTERN.test(trace.trace_id) ||
      traceIds.has(trace.trace_id) ||
      !validDeliveryId(trace.delivery_id) ||
      (trace.outcome !== "pending" &&
        trace.outcome !== "success" &&
        trace.outcome !== "error") ||
      typeof trace.relay_attempt !== "string" ||
      !/^[1-9][0-9]{0,15}$/u.test(trace.relay_attempt) ||
      !Number.isSafeInteger(Number.parseInt(trace.relay_attempt, 10)) ||
      (trace.send_execution_id !== null &&
        (typeof trace.send_execution_id !== "string" ||
          !/^Fx[A-Za-z0-9]{1,126}$/u.test(trace.send_execution_id))) ||
      typeof trace.send_boundary_reached !== "boolean" ||
      typeof trace.pre_send_failure_proven !== "boolean" ||
      (trace.pre_send_failure_proven === true &&
        trace.send_execution_id === null) ||
      (trace.pre_send_failure_proven === true &&
        (trace.outcome === "success" ||
          trace.send_boundary_reached === true)) ||
      !Number.isSafeInteger(trace.started_at_us) ||
      (trace.started_at_us as number) < 0 ||
      (trace.completed_at_us !== null &&
        (!Number.isSafeInteger(trace.completed_at_us) ||
          (trace.completed_at_us as number) <
            (trace.started_at_us as number))) ||
      (trace.outcome === "pending" && trace.completed_at_us !== null) ||
      (trace.outcome !== "pending" && trace.completed_at_us === null)
    ) {
      return null;
    }
    traceIds.add(trace.trace_id);
    traces.push({
      trace_id: trace.trace_id,
      delivery_id: trace.delivery_id,
      outcome: trace.outcome,
      relay_attempt: trace.relay_attempt,
      send_execution_id: trace.send_execution_id,
      slack_channel_id: null,
      slack_message_ts: null,
      send_boundary_reached: trace.send_boundary_reached,
      pre_send_failure_proven: trace.pre_send_failure_proven,
      started_at_us: trace.started_at_us as number,
      completed_at_us: trace.completed_at_us as number | null,
    });
  }

  return {
    checkpoint_us: record.checkpoint_us as number,
    report_timestamp: record.report_timestamp,
    traces,
    report_signature: record.report_signature,
  };
}

async function relaySigningConfiguration(
  env: Env,
): Promise<RelaySigningConfiguration | null> {
  try {
    const current = await readSecret(env.SLACK_RELAY_SIGNING_SECRET);
    if (!hasSafeSecretLength(current)) return null;

    let next: string | null = null;
    try {
      const candidate = await readSecret(env.SLACK_RELAY_SIGNING_SECRET_NEXT);
      if (!hasSafeSecretLength(candidate) || candidate === current) return null;
      next = candidate;
    } catch {
      // NEXT is optional outside an explicitly staged rotation.
    }

    const slot = String(env.SLACK_RELAY_SIGNING_ACTIVE_SLOT);
    if (slot !== "current" && slot !== "next") return null;
    if (slot === "next" && next === null) return null;
    return {
      active: slot === "next" ? (next as string) : current,
      next,
    };
  } catch {
    return null;
  }
}

async function handleSlackControlRequest(
  request: Request,
  path: string,
  env: Env,
  dependencies: Required<RuntimeOverrides>,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }
  const record = await readControlRecord(request);
  if (record === null) {
    return jsonResponse({ error: "invalid_request" }, 400);
  }
  const now = dependencies.now();
  const signing = await relaySigningConfiguration(env);
  if (signing === null) {
    return jsonResponse({ error: "authentication_unavailable" }, 503);
  }

  if (path === SLACK_PROGRESS_PATH) {
    const receipt = parseSlackProgress(record, now);
    if (receipt === null) {
      return jsonResponse({ error: "invalid_request" }, 400);
    }
    if (!(await verifySlackProgress(receipt, signing.active))) {
      return jsonResponse({ error: "invalid_signature" }, 401);
    }
    try {
      const result = await dependencies.store.recordSlackProgress({
        deliveryId: receipt.delivery_id,
        destination: receipt.destination,
        phase: receipt.phase,
        messageTs: receipt.message_ts === "" ? null : receipt.message_ts,
        attemptCount: Number.parseInt(receipt.relay_attempt, 10),
        functionExecutionId: receipt.function_execution_id,
        now,
        reconcileAt: now + SLACK_RECONCILIATION_GRACE_MS,
      });
      return jsonResponse({ ok: true, duplicate: result === "duplicate" }, 200);
    } catch (error) {
      if (error instanceof SlackProgressConflictError) {
        return jsonResponse({ error: "delivery_state_conflict" }, 409);
      }
      return jsonResponse({ error: "persistence_unavailable" }, 503);
    }
  }

  if (path === SLACK_CHECKPOINT_PATH) {
    const checkpointRequest = parseSlackCheckpointRequest(record, now);
    if (checkpointRequest === null) {
      return jsonResponse({ error: "invalid_request" }, 400);
    }
    if (
      !(await verifySlackCheckpointRequest(checkpointRequest, signing.active))
    ) {
      return jsonResponse({ error: "invalid_signature" }, 401);
    }
    try {
      const scanState = await dependencies.store.getSlackActivityScanState();
      return jsonResponse(
        {
          checkpoint_us: scanState.checkpointUs,
          reconciliation_version: 5,
          resume_from_us: scanState.resumeFromUs,
          pending_trace_ids: scanState.pendingTraceIds,
          pending_trace_total: scanState.pendingTraceTotal,
          pending_trace_oldest_us: scanState.pendingTraceOldestUs,
        },
        200,
      );
    } catch {
      return jsonResponse({ error: "persistence_unavailable" }, 503);
    }
  }

  const currentReport = parseSlackReconciliation(record, now);
  const v4Report = parseSlackReconciliationV4(record, now);
  const v3Report = parseSlackReconciliationV3(record, now);
  const bridgeReport = parseSlackReconciliationV2(record, now);
  if (
    currentReport === null &&
    v4Report === null &&
    v3Report === null &&
    bridgeReport === null
  ) {
    return jsonResponse({ error: "invalid_request" }, 400);
  }
  let report: SignedSlackReconciliation | null = null;
  if (
    currentReport !== null &&
    (await verifySlackReconciliation(currentReport, signing.active))
  ) {
    report = currentReport;
  } else if (
    v4Report !== null &&
    (await verifySlackReconciliationV4(v4Report, signing.active))
  ) {
    return jsonResponse({ error: "reconciliation_upgrade_required" }, 409);
  } else if (
    v3Report !== null &&
    (await verifySlackReconciliationV3(v3Report, signing.active))
  ) {
    return jsonResponse({ error: "reconciliation_upgrade_required" }, 409);
  } else if (
    bridgeReport !== null &&
    (await verifySlackReconciliationV2(bridgeReport, signing.active))
  ) {
    // A monitor that started before the v3 rollout cannot observe or report
    // authenticated Slack message evidence. Never let that in-flight process
    // mutate delivery state or advance the checkpoint after the v3 Worker is
    // live; the next monitor run will negotiate v3 from the checkpoint reply.
    return jsonResponse({ error: "reconciliation_upgrade_required" }, 409);
  }
  if (report === null) {
    return jsonResponse({ error: "invalid_signature" }, 401);
  }
  try {
    const result = await dependencies.store.reconcileSlackReport({
      reportId: report.report_signature,
      traces: report.traces.map((trace) => ({
        traceId: trace.trace_id,
        deliveryId: trace.delivery_id,
        outcome: trace.outcome,
        attemptCount:
          trace.relay_attempt === null
            ? null
            : Number.parseInt(trace.relay_attempt, 10),
        sendExecutionId: trace.send_execution_id,
        slackChannelId: trace.slack_channel_id,
        messageTs: trace.slack_message_ts,
        sendBoundaryReached: trace.send_boundary_reached,
        preSendFailureProven: trace.pre_send_failure_proven,
        startedAtUs: trace.started_at_us,
        completedAtUs: trace.completed_at_us,
      })),
      hydrations: report.hydrations.map((hydration) => ({
        traceId: hydration.trace_id,
        firstObservedUs: hydration.first_observed_us,
        lastObservedUs: hydration.last_observed_us,
        status: hydration.status,
        debtReason: hydration.debt_reason,
        attempted: hydration.attempted,
      })),
      checkpointUs: report.checkpoint_us,
      scanState: report.scan_state,
      now,
    });
    return jsonResponse(
      {
        ok: true,
        traces: report.traces.length,
        hydrations: report.hydrations.length,
        changed_error_traces: result.changedErrorTraces,
        checkpoint_us: result.checkpointUs,
      },
      200,
    );
  } catch (error) {
    if (error instanceof SlackReconciliationConflictError) {
      return jsonResponse({ error: "reconciliation_conflict" }, 409);
    }
    return jsonResponse({ error: "persistence_unavailable" }, 503);
  }
}

export async function handleFetch(
  request: Request,
  env: Env,
  overrides?: RuntimeOverrides,
): Promise<Response> {
  const url = new URL(request.url);
  const dependencies = runtime(env, overrides);

  if (
    url.pathname === SLACK_PROGRESS_PATH ||
    url.pathname === SLACK_RECONCILIATION_PATH ||
    url.pathname === SLACK_CHECKPOINT_PATH
  ) {
    return handleSlackControlRequest(request, url.pathname, env, dependencies);
  }

  // ADR-002 §4: os dois números do vigia, atrás do segredo compartilhado
  // (decisão 9). 401 idêntico para segredo ausente, errado ou binding
  // indisponível — a rota não explica a si mesma para quem não a conhece.
  if (url.pathname === ALERTS_STATUS_PATH && request.method === "GET") {
    let expected: string;
    try {
      expected = await readSecret(env.ALERTS_STATUS_SECRET);
    } catch {
      return jsonResponse({ error: "unauthorized" }, 401);
    }
    if (!(await verifyStatusSecret(request, expected))) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }
    try {
      const body = await statusBody(dependencies.alertStore, dependencies.now());
      return jsonResponse(body, 200);
    } catch {
      // O vigia trata "não consegui responder" como sinal (decisão 3);
      // um 503 explícito é melhor que um corpo inventado.
      return jsonResponse({ error: "status_unavailable" }, 503);
    }
  }

  if (url.pathname === HEALTH_PATH && request.method === "GET") {
    const now = dependencies.now();
    const deployedRevision = env.WORKER_VERSION?.tag;
    if (
      typeof deployedRevision !== "string" ||
      !WORKER_REVISION_PATTERN.test(deployedRevision)
    ) {
      return jsonResponse({ status: "unavailable" }, 503);
    }
    try {
      // A CLASSE da prontidão é "tudo de que uma rota do Worker precisa
      // para servir" — e o caminho v2 (ADR-002) acrescentou dois segredos
      // e uma tabela. Achado da revisão: /healthz dizia `ready` com o
      // SLACK_BOT_TOKEN ilegível (toda mensagem v2 parada em pending) e
      // com o ALERTS_STATUS_SECRET ausente (vigia sem rota). A sonda do
      // alert_delivery é o schemaProbe, em trabalho CONSTANTE (segundo
      // achado da revisão: o /healthz é público, e o agregado do
      // statusSnapshot aqui viraria amplificação de carga no D1 — o
      // retrato completo fica no /alerts/status, atrás do segredo).
      // readSecret lança para binding ausente ou vazio; string vazia de
      // fixture cai no checque de comprimento.
      const [
        healthy,
        githubSecret,
        alertsUrl,
        activityUrl,
        relaySigning,
        legacyUnverified,
        botToken,
        statusSecret,
      ] = await Promise.all([
        dependencies.store.healthcheck(now, deployedRevision),
        readSecret(env.GITHUB_WEBHOOK_SECRET),
        readSecret(env.SLACK_ALERTS_WORKFLOW_WEBHOOK_URL),
        readSecret(env.SLACK_ACTIVITY_WORKFLOW_WEBHOOK_URL),
        relaySigningConfiguration(env),
        dependencies.store.hasLegacyUnverifiedDebt(),
        readSecret(env.SLACK_BOT_TOKEN),
        readSecret(env.ALERTS_STATUS_SECRET),
        dependencies.alertStore.schemaProbe(),
      ]);
      const ready =
        healthy &&
        hasSafeSecretLength(githubSecret) &&
        relaySigning !== null &&
        slackWorkflowUrl(alertsUrl) !== null &&
        slackWorkflowUrl(activityUrl) !== null &&
        botToken.length > 0 &&
        statusSecret.length > 0;
      return jsonResponse(
        ready
          ? { status: "ready", legacy_unverified: legacyUnverified }
          : { status: "unavailable" },
        ready ? 200 : 503,
      );
    } catch {
      return jsonResponse({ status: "unavailable" }, 503);
    }
  }

  if (url.pathname !== WEBHOOK_PATH) {
    return jsonResponse({ error: "not_found" }, 404);
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  if (contentLengthTooLarge(request)) {
    return jsonResponse({ error: "payload_too_large" }, 413);
  }

  const event = request.headers.get("x-github-event") ?? "";
  const deliveryId = request.headers.get("x-github-delivery") ?? "";
  const signature = request.headers.get("x-hub-signature-256") ?? "";

  if (
    !EVENT_NAME_PATTERN.test(event) ||
    !validDeliveryId(deliveryId) ||
    signature === ""
  ) {
    return jsonResponse({ error: "invalid_github_headers" }, 400);
  }

  let bodyResult: Awaited<ReturnType<typeof readBodyWithLimit>>;
  try {
    bodyResult = await readBodyWithLimit(request);
  } catch {
    return jsonResponse({ error: "invalid_request_body" }, 400);
  }

  if (bodyResult.kind === "too_large") {
    return jsonResponse({ error: "payload_too_large" }, 413);
  }
  const body = bodyResult.body;

  let webhookSecret: string;
  try {
    webhookSecret = await readSecret(env.GITHUB_WEBHOOK_SECRET);
  } catch {
    return jsonResponse({ error: "webhook_verification_unavailable" }, 503);
  }
  if (!hasSafeSecretLength(webhookSecret)) {
    return jsonResponse({ error: "webhook_verification_unavailable" }, 503);
  }

  let signatureIsValid: boolean;
  try {
    signatureIsValid = await verifyGitHubSignature(
      body,
      signature,
      webhookSecret,
    );
  } catch {
    return jsonResponse({ error: "webhook_verification_unavailable" }, 503);
  }

  if (!signatureIsValid) {
    return jsonResponse({ error: "invalid_signature" }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    const decoded = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(body);
    const parsed = JSON.parse(decoded) as unknown;
    const record = asRecord(parsed);
    if (record === undefined) {
      return jsonResponse({ error: "invalid_json_payload" }, 400);
    }
    payload = record;
  } catch {
    return jsonResponse({ error: "invalid_json_payload" }, 400);
  }

  const organization = nestedString(payload, "organization", "login");
  if (!sameOrganization(organization)) {
    return jsonResponse({ error: "organization_not_allowed" }, 403);
  }

  if (event === "ping") {
    return jsonResponse({ accepted: true, event: "ping" }, 200);
  }

  if (!SUPPORTED_RELAY_EVENTS.has(event)) {
    return jsonResponse(
      { accepted: false, ignored: true, reason: "event_not_supported" },
      202,
    );
  }

  const repository = repositoryFromPayload(payload);
  if (
    repository === null ||
    repository.fullName === "" ||
    !sameOrganization(repository.owner)
  ) {
    return jsonResponse({ error: "repository_not_allowed" }, 403);
  }

  if (repository.archived) {
    return jsonResponse(
      { accepted: false, ignored: true, reason: "repository_archived" },
      202,
    );
  }

  const normalized = normalizeGitHubEvent(
    event,
    payload,
    deliveryId,
    repository.fullName,
    repository.defaultBranch,
  );
  if (normalized.kind === "ignored") {
    return jsonResponse(
      { accepted: false, ignored: true, reason: normalized.reason },
      202,
    );
  }

  // ADR-002 §2: a promessa ancora AQUI — aceito = linha gravada + sucesso
  // respondido. O INSERT falhando, o erro volta ao GitHub e a entrega fica
  // registrada no painel de webhooks (sem reenvio automático; reenvio
  // manual por 3 dias).
  const now = dependencies.now();
  let inserted: boolean;
  try {
    inserted = await dependencies.alertStore.insert(
      deliveryId,
      JSON.stringify(normalized.payload),
      now,
    );
  } catch {
    return jsonResponse({ error: "persistence_unavailable" }, 503);
  }

  if (!inserted) {
    // Redelivery do GitHub: a linha guardada É a trava de deduplicação
    // (decisão 10). Publicar aqui violaria "publica só quando INSERE".
    return jsonResponse({ accepted: true, duplicate: true }, 202);
  }

  // PUBLICA SÓ QUEM CARIMBA — inclusive o ingress, e o send é GATEADO no
  // resultado do carimbo (achados da revisão, em duas rodadas): sem o
  // carimbo, a primeira tentativa falhada era reagendada em segundos,
  // furando o recuo(1); e sem o GATE, um passe do cron carimbando entre o
  // INSERT e o carimbo do ingress produzia DUAS publicações da primeira
  // tentativa — o changes=0 do CAS é exatamente o sinal de que outro
  // agendador já publicou esta tentativa.
  const stamped = await dependencies.alertStore.stampDue(
    deliveryId,
    now,
    now + recuoMs(1),
  );

  let queued = false;
  if (stamped) {
    try {
      await env.ALERT_QUEUE.send({ v: 2, delivery_id: deliveryId });
      queued = true;
    } catch {
      // A fila é otimização de latência; o cron é a vivacidade (ADR-002
      // §4). O alerta está ACEITO — responder erro faria o GitHub
      // registrar falha de uma entrega que já é nossa. Mas o corpo diz a
      // verdade (queued:true durante a queda da fila mentia ao
      // diagnóstico).
    }
  }
  // stamped=false: um passe concorrente do cron venceu o CAS e a
  // publicação desta tentativa é dele — publicar aqui seria a segunda.

  return jsonResponse(
    queued
      ? { accepted: true, queued: true }
      : { accepted: true, queued: false, recovery: "cron" },
    202,
  );
}

function slackWorkflowUrl(value: string): string | null {
  if (
    !/^https:\/\/hooks\.slack\.com\/triggers\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/u.test(
      value,
    )
  ) {
    return null;
  }

  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname.toLowerCase() !== "hooks.slack.com" ||
      !parsed.pathname.startsWith("/triggers/") ||
      parsed.port !== "" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function defaultRetrySeconds(attemptCount: number): number {
  return Math.max(
    2,
    Math.min(3_600, 2 ** Math.min(Math.max(attemptCount, 1), 12)),
  );
}

function retryAfterSeconds(header: string | null, now: number): number | null {
  if (header === null || header.trim() === "") {
    return null;
  }

  const numeric = Number(header);
  if (Number.isFinite(numeric) && numeric >= 0) {
    return Math.max(2, Math.min(43_200, Math.ceil(numeric)));
  }

  const date = Date.parse(header);
  if (!Number.isFinite(date)) {
    return null;
  }

  return Math.max(2, Math.min(43_200, Math.ceil((date - now) / 1_000)));
}

function retryMessage(message: Message<QueueJob>, delaySeconds: number): void {
  message.retry({ delaySeconds: Math.max(2, Math.ceil(delaySeconds)) });
}

function protocolActivationRetrySeconds(attempts: number): number {
  return Math.min(3_600, 60 * 2 ** Math.min(Math.max(attempts - 1, 0), 6));
}

async function slackDeliveryProtocolIsActive(
  store: DeliveryStore,
  expectedRevision: unknown,
): Promise<boolean> {
  if (
    typeof expectedRevision !== "string" ||
    !WORKER_REVISION_PATTERN.test(expectedRevision)
  ) {
    return false;
  }
  try {
    return await store.isSlackDeliveryProtocolActive(expectedRevision);
  } catch {
    return false;
  }
}

async function cancelUnreadResponseBody(response: Response): Promise<void> {
  if (response.body === null || response.bodyUsed) {
    return;
  }

  try {
    await response.body.cancel();
  } catch {
    // Cleanup failure must not bypass the durable status and retry handling.
  }
}

async function recordSlackFailure(
  store: DeliveryStore,
  delivery: StoredDelivery,
  message: Message<QueueJob>,
  now: number,
  reason: string,
  delaySeconds: number,
): Promise<void> {
  const boundedDelay = Math.max(2, Math.min(43_200, Math.ceil(delaySeconds)));
  await store.recordFailure(
    delivery.deliveryId,
    now,
    now + boundedDelay * 1_000,
    reason,
  );
  retryMessage(message, boundedDelay);
}

async function recordAmbiguousSlackTrigger(
  store: DeliveryStore,
  deliveryId: string,
  message: Message<QueueJob>,
  now: number,
  reason: string,
): Promise<void> {
  await store.markManualReview(deliveryId, now, reason);
  message.ack();
}

function triggerResponseIsDefiniteRejection(status: number): boolean {
  return status === 429 || (status >= 300 && status < 500 && status !== 408);
}

export async function processPrimaryMessage(
  message: Message<QueueJob>,
  env: Env,
  overrides?: RuntimeOverrides,
): Promise<void> {
  const dependencies = runtime(env, overrides);
  const job = queueJob(message.body);
  if (job === null) {
    message.ack();
    return;
  }

  if (
    !(await slackDeliveryProtocolIsActive(
      dependencies.store,
      env.WORKER_VERSION?.tag,
    ))
  ) {
    retryMessage(message, protocolActivationRetrySeconds(message.attempts));
    return;
  }

  const existing = await dependencies.store.get(job.deliveryId);
  if (existing?.status === "sending") {
    await recordAmbiguousSlackTrigger(
      dependencies.store,
      existing.deliveryId,
      message,
      dependencies.now(),
      "replayed_slack_trigger_attempt_ambiguous",
    );
    return;
  }
  if (
    existing === null ||
    existing.status === "accepted_by_slack" ||
    existing.status === "accepted_by_trigger" ||
    existing.status === "send_started" ||
    existing.status === "delivered" ||
    existing.status === "manual_review"
  ) {
    message.ack();
    return;
  }

  if (existing.attemptCount >= MAXIMUM_DELIVERY_ATTEMPTS) {
    await dependencies.store.markManualReview(
      existing.deliveryId,
      dependencies.now(),
      "maximum_delivery_attempts_reached",
    );
    message.ack();
    return;
  }

  let now = dependencies.now();
  if (existing.nextAttemptAt > now) {
    const waitMilliseconds = existing.nextAttemptAt - now;
    if (waitMilliseconds <= MINIMUM_SLACK_INTERVAL_MS) {
      await dependencies.sleep(waitMilliseconds);
      now = dependencies.now();
    }

    if (existing.nextAttemptAt > now) {
      retryMessage(message, Math.ceil((existing.nextAttemptAt - now) / 1_000));
      return;
    }
  }

  while (true) {
    const waitMilliseconds = await dependencies.store.reserveSlackSlot(
      now,
      MINIMUM_SLACK_INTERVAL_MS,
      existing.destination,
    );
    if (waitMilliseconds === 0) {
      break;
    }

    if (waitMilliseconds > MINIMUM_SLACK_INTERVAL_MS) {
      retryMessage(message, Math.ceil(waitMilliseconds / 1_000));
      return;
    }

    await dependencies.sleep(waitMilliseconds);
    now = dependencies.now();
  }

  const delivery = await dependencies.store.claimForSlack(job.deliveryId, now);
  if (delivery === null) {
    retryMessage(message, 2);
    return;
  }

  let webhookUrl: string | null;
  let relaySigning: RelaySigningConfiguration | null;
  try {
    const destinationBinding =
      delivery.destination === "alerts"
        ? env.SLACK_ALERTS_WORKFLOW_WEBHOOK_URL
        : env.SLACK_ACTIVITY_WORKFLOW_WEBHOOK_URL;
    webhookUrl = slackWorkflowUrl(await readSecret(destinationBinding));
    relaySigning = await relaySigningConfiguration(env);
  } catch {
    webhookUrl = null;
    relaySigning = null;
  }

  if (webhookUrl === null || relaySigning === null) {
    await recordSlackFailure(
      dependencies.store,
      delivery,
      message,
      now,
      "slack_webhook_configuration_invalid",
      defaultRetrySeconds(delivery.attemptCount),
    );
    return;
  }

  const outboundPayload = {
    ...delivery.payload,
    destination: delivery.destination,
    relay_attempt: String(delivery.attemptCount),
    relay_timestamp: String(Math.floor(now / 1_000)),
    relay_signature: "",
  };
  try {
    outboundPayload.relay_signature = await signSlackRelayPayload(
      outboundPayload,
      relaySigning.active,
    );
  } catch {
    await recordSlackFailure(
      dependencies.store,
      delivery,
      message,
      now,
      "relay_signature_generation_failed",
      defaultRetrySeconds(delivery.attemptCount),
    );
    return;
  }

  let response: Response;
  try {
    response = await dependencies.fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(outboundPayload),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "slack_request_failed",
        ...safeFailureSummary(error),
      }),
    );
    await recordAmbiguousSlackTrigger(
      dependencies.store,
      delivery.deliveryId,
      message,
      now,
      "slack_trigger_request_outcome_ambiguous",
    );
    return;
  }

  if (response.ok) {
    let confirmation: Record<string, unknown> | undefined;
    try {
      confirmation = asRecord(await response.json());
    } catch {
      confirmation = undefined;
    }

    if (confirmation?.ok !== true) {
      await recordAmbiguousSlackTrigger(
        dependencies.store,
        delivery.deliveryId,
        message,
        now,
        "slack_trigger_success_confirmation_ambiguous",
      );
      return;
    }

    await dependencies.store.markAcceptedByTrigger(
      delivery.deliveryId,
      now,
      now + SLACK_RECONCILIATION_GRACE_MS,
    );
    message.ack();
    return;
  }

  await cancelUnreadResponseBody(response);

  if (!triggerResponseIsDefiniteRejection(response.status)) {
    await recordAmbiguousSlackTrigger(
      dependencies.store,
      delivery.deliveryId,
      message,
      now,
      `slack_trigger_http_${response.status}_ambiguous`,
    );
    return;
  }

  const retryDelay =
    retryAfterSeconds(response.headers.get("retry-after"), now) ??
    defaultRetrySeconds(delivery.attemptCount);
  if (response.status === 429) {
    await dependencies.store.extendSlackCooldown(now + retryDelay * 1_000);
  }

  await recordSlackFailure(
    dependencies.store,
    delivery,
    message,
    now,
    `slack_http_${response.status}`,
    retryDelay,
  );
}

function deadLetterDelayMilliseconds(attemptCount: number): number {
  const seconds = Math.max(
    300,
    Math.min(21_600, 2 ** Math.min(attemptCount + 4, 14)),
  );
  return seconds * 1_000;
}

export async function processDeadLetterMessage(
  message: Message<QueueJob>,
  env: Env,
  overrides?: RuntimeOverrides,
): Promise<void> {
  const dependencies = runtime(env, overrides);
  const job = queueJob(message.body);
  if (job === null) {
    message.ack();
    return;
  }

  if (
    !(await slackDeliveryProtocolIsActive(
      dependencies.store,
      env.WORKER_VERSION?.tag,
    ))
  ) {
    retryMessage(message, protocolActivationRetrySeconds(message.attempts));
    return;
  }

  const delivery = await dependencies.store.get(job.deliveryId);
  if (delivery?.status === "sending") {
    await dependencies.store.markManualReview(
      delivery.deliveryId,
      dependencies.now(),
      "dead_letter_slack_trigger_attempt_ambiguous",
    );
    message.ack();
    return;
  }
  if (
    delivery === null ||
    delivery.status === "accepted_by_slack" ||
    delivery.status === "accepted_by_trigger" ||
    delivery.status === "send_started" ||
    delivery.status === "delivered" ||
    delivery.status === "manual_review"
  ) {
    message.ack();
    return;
  }

  const now = dependencies.now();
  if (delivery.attemptCount >= MAXIMUM_DELIVERY_ATTEMPTS) {
    await dependencies.store.markManualReview(
      delivery.deliveryId,
      now,
      "maximum_delivery_attempts_reached_in_dlq",
    );
    message.ack();
    return;
  }

  await dependencies.store.markDeadLetter(
    delivery.deliveryId,
    now,
    now + deadLetterDelayMilliseconds(delivery.attemptCount),
    "cloudflare_queue_dead_letter",
  );
  message.ack();
}

// O contrato REAL da fila é a união dos dois protocolos: o QueueJob legado
// e a mensagem v2 do ADR-002. Achado da revisão: o handler declarado como
// MessageBatch<QueueJob> excluía o formato v2 que ele mesmo processa, e os
// casts `as unknown as QueueJob` nos testes eram o sintoma.
export type RelayQueueMessage = QueueJob | AlertQueueMessage;

export async function handleQueue(
  batch: MessageBatch<RelayQueueMessage>,
  env: Env,
  overrides?: RuntimeOverrides,
): Promise<void> {
  for (const message of batch.messages) {
    // ADR-002: mensagem nova é {v:2, delivery_id}, discriminada por
    // declaração — mas SÓ nas filas primárias. A revisão derrubou a versão
    // anterior, que processava v2 também na DLQ: isso fazia da DLQ um
    // SEGUNDO caminho de entrega com ciclo de retentativas próprio
    // (max_retries: 10), por fora do único agendador. Na DLQ, v2 é
    // DESCARTADA de propósito: a linha continua `pending` no D1 e o cron a
    // recarimba — a fonte de verdade é a linha, nunca a mensagem.
    const body = asRecord(message.body);
    if (
      batch.queue === ALERT_DEAD_LETTER_QUEUE ||
      batch.queue === ACTIVITY_DEAD_LETTER_QUEUE
    ) {
      if (body?.v === 2) {
        message.ack();
        continue;
      }
      // body.v !== 2 é a discriminação do protocolo: daqui para baixo a
      // mensagem é do formato legado (o TS não estreita Message<A|B> pelo
      // corpo, então o estreitamento é declarado uma vez, junto do guarda).
      await processDeadLetterMessage(message as Message<QueueJob>, env, overrides);
    } else if (body?.v === 2) {
      await processAlertV2Message(message.body, env, overrides);
    } else if (
      batch.queue === ALERT_QUEUE_NAME ||
      batch.queue === ACTIVITY_QUEUE_NAME
    ) {
      await processPrimaryMessage(message as Message<QueueJob>, env, overrides);
    } else {
      throw new Error("unexpected_queue");
    }
  }
}

// O consumidor do ADR-002 §8. Retorno normal = ack implícito; nada aqui
// lança, então a fila nunca agenda nada — o cron é o único agendador.
async function processAlertV2Message(
  raw: unknown,
  env: Env,
  overrides?: RuntimeOverrides,
): Promise<void> {
  const dependencies = runtime(env, overrides);
  let botToken: string;
  try {
    botToken = await readSecret(env.SLACK_BOT_TOKEN);
  } catch {
    // Sem token não há envio; a linha fica pendente e o cron recarimba.
    try {
      const body = asRecord(raw);
      if (typeof body?.delivery_id === "string") {
        await dependencies.alertStore.recordFailure(
          body.delivery_id,
          "bot_token_unavailable",
        );
      }
    } catch {
      // Direção do erro: atraso, nunca perda.
    }
    return;
  }
  await processAlertMessage(raw, {
    store: dependencies.alertStore,
    botToken,
    fetch: dependencies.fetch,
    now: dependencies.now,
  });
}

export async function runScheduledRecovery(
  env: Env,
  overrides?: RuntimeOverrides,
): Promise<SchedulerResult> {
  const dependencies = runtime(env, overrides);
  const now = dependencies.now();
  if (
    !(await slackDeliveryProtocolIsActive(
      dependencies.store,
      env.WORKER_VERSION?.tag,
    ))
  ) {
    console.info(
      JSON.stringify({
        event: "scheduled_recovery_deferred",
        reason: "slack_delivery_protocol_inactive",
      }),
    );
    return { purged: 0, recovered: 0, enqueueFailures: 0 };
  }
  const purged = await dependencies.store.purgeDeliveredBefore(
    now - DELIVERED_RETENTION_MS,
  );
  const recoverable = await dependencies.store.claimRecoverable(
    now,
    now - STALE_AFTER_MS,
    MAXIMUM_DELIVERY_ATTEMPTS,
    RECOVERY_LIMIT,
  );

  let recovered = 0;
  let enqueueFailures = 0;

  for (const recovery of recoverable) {
    try {
      await destinationQueue(env, recovery.destination).send({
        deliveryId: recovery.deliveryId,
      });
      await dependencies.store.markQueued(recovery.deliveryId, now);
      recovered += 1;
    } catch {
      enqueueFailures += 1;
      await dependencies.store.markEnqueueFailed(
        recovery.deliveryId,
        now,
        now + 5 * 60 * 1_000,
        "scheduled_queue_enqueue_failed",
      );
    }
  }

  console.info(
    JSON.stringify({
      enqueue_failures: enqueueFailures,
      event: "scheduled_recovery",
      purged,
      recovered,
    }),
  );

  return { purged, recovered, enqueueFailures };
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await handleFetch(request, env);
    } catch {
      console.error(
        JSON.stringify({ event: "webhook_handler_unexpected_failure" }),
      );
      return jsonResponse({ error: "internal_error" }, 500);
    }
  },

  async queue(batch, env): Promise<void> {
    await handleQueue(batch, env);
  },

  async scheduled(_controller, env): Promise<void> {
    // ADR-002 §4: o cron dos alertas é o ÚNICO agendador do caminho novo —
    // carimbo, publicação e retenção. Roda antes do legado, e um erro num
    // caminho não cala o outro.
    try {
      await runAlertCron({
        store: new AlertStore(env.DB),
        queue: {
          send: async (m): Promise<void> => {
            await env.ALERT_QUEUE.send(m);
          },
        },
        now: Date.now,
      });
    } catch {
      // A falha de um passe é atraso de um período de cron, nunca perda;
      // o vigia alarma pela idade se isso virar padrão.
    }
    await runScheduledRecovery(env);
  },
} satisfies ExportedHandler<Env, RelayQueueMessage>;
