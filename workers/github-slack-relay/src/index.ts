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
import { processDispatchMessage } from "./dispatch/consumer";
import { parseDispatchMode } from "./dispatch/mode";
import { D1DispatchStore } from "./dispatch/outbox";
import {
  acceptPrimary,
  channelForDestination,
  dispatchQueueJobBody,
  dispatchStatusBody,
  insertLegacyFenced,
  insertShadowPaired,
  isDispatchQueueJob,
  legacyAcceptBlockedByOutbox,
  runDispatchCronPass,
} from "./dispatch/wiring";

const WEBHOOK_PATH = "/github/webhook";
const HEALTH_PATH = "/healthz";
// ADR-001 §6.7: read-only aggregate counters for the dispatch outbox.
const DISPATCH_STATUS_PATH = "/status";
// ADR-001 §6.2/§6.3 (I1) audited operator menu — the ONLY resend path, and
// the only way a manual/dead_letter row leaves its parked state.
const DISPATCH_OPERATOR_PATH = "/dispatch/operator";
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
const OPERATOR_EVIDENCE_MAXIMUM_CHARACTERS = 512;
const SLACK_TRACE_ID_PATTERN = /^Tr[A-Za-z0-9_-]{1,125}$/u;
const SLACK_RECONCILIATION_TRACE_LIMIT = 25;
const WORKER_REVISION_PATTERN = /^[0-9a-f]{40}$/u;

export interface RuntimeOverrides {
  store?: DeliveryStore;
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

// ADR-001 §6.2/§6.3 operator menu. The wire format follows the existing
// signed control requests: the signature travels inside the body over a
// canonical array whose first element is a version tag, so this message can
// never be confused with a progress receipt, a reconciliation report or a
// checkpoint request signed by the same secret.
interface DispatchOperatorCommand {
  action: "resend" | "close_manual";
  delivery_id: string;
  evidence: string;
  request_timestamp: string;
  request_signature: string;
}

function canonicalDispatchOperatorCommand(
  command: Omit<DispatchOperatorCommand, "request_signature">,
): string {
  return JSON.stringify([
    "dispatch_operator_action_v1",
    command.action,
    command.delivery_id,
    command.evidence,
    command.request_timestamp,
  ]);
}

function parseDispatchOperatorCommand(
  record: Record<string, unknown>,
  now: number,
): DispatchOperatorCommand | null {
  if (
    !exactKeys(record, [
      "action",
      "delivery_id",
      "evidence",
      "request_timestamp",
      "request_signature",
    ])
  ) {
    return null;
  }
  const action = record.action;
  const deliveryId = record.delivery_id;
  const evidence = record.evidence;
  const requestTimestamp = record.request_timestamp;
  const requestSignature = record.request_signature;
  if (
    (action !== "resend" && action !== "close_manual") ||
    !validDeliveryId(deliveryId) ||
    typeof evidence !== "string" ||
    evidence.length === 0 ||
    evidence.length > OPERATOR_EVIDENCE_MAXIMUM_CHARACTERS ||
    typeof requestTimestamp !== "string" ||
    !authenticatedTimestampIsFresh(requestTimestamp, now) ||
    typeof requestSignature !== "string" ||
    !/^[0-9a-f]{64}$/u.test(requestSignature)
  ) {
    return null;
  }
  return {
    action,
    delivery_id: deliveryId,
    evidence,
    request_timestamp: requestTimestamp,
    request_signature: requestSignature,
  };
}

async function verifyDispatchOperatorCommand(
  command: DispatchOperatorCommand,
  secret: string,
): Promise<boolean> {
  // security.ts exports exactly one generic timing-safe HMAC verifier
  // (verifyGitHubSignature: sha256=<hex> over raw bytes); it is applied here
  // to the canonical message bytes. Failures to compare are thrown, never
  // reported as a bad signature — the caller maps them to 503.
  const message = new TextEncoder().encode(
    canonicalDispatchOperatorCommand(command),
  );
  const preimage = new ArrayBuffer(message.byteLength);
  new Uint8Array(preimage).set(message);
  return verifyGitHubSignature(
    preimage,
    `sha256=${command.request_signature}`,
    secret,
  );
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

// ADR-001 §6.2/§6.3/§6.9 — the audited operator menu (Copilot finding: the
// advertised recovery path had no route, so every manual/dead_letter row was
// parked permanently). AUTHENTICATION reuses the machinery of
// handleSlackControlRequest against an EXISTING binding — no new binding, no
// new secret: the SLACK_RELAY_SIGNING_SECRET pair with its active-slot
// selection (relaySigningConfiguration), the same 128 KB control-body cap
// (readControlRecord), the same freshness window
// (authenticatedTimestampIsFresh) and security.ts's timing-safe HMAC
// verifier. The route never posts to Slack: a resend only re-enters the row
// into the normal pipeline, so it works in every DISPATCH_MODE and the
// consumer applies the mode active at consume time (R20).
async function handleDispatchOperatorRequest(
  request: Request,
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
  const command = parseDispatchOperatorCommand(record, now);
  if (command === null) {
    return jsonResponse({ error: "invalid_request" }, 400);
  }
  const signing = await relaySigningConfiguration(env);
  if (signing === null) {
    return jsonResponse({ error: "authentication_unavailable" }, 503);
  }
  let signatureIsValid: boolean;
  try {
    signatureIsValid = await verifyDispatchOperatorCommand(
      command,
      signing.active,
    );
  } catch {
    return jsonResponse({ error: "authentication_unavailable" }, 503);
  }
  if (!signatureIsValid) {
    return jsonResponse({ error: "invalid_signature" }, 401);
  }

  const dispatchStore = new D1DispatchStore(env.DB);
  if (command.action === "close_manual") {
    let closed: boolean;
    try {
      closed = await dispatchStore.operatorCloseManual(
        command.delivery_id,
        now,
        JSON.stringify({
          operator_action: "close_manual",
          evidence: command.evidence,
        }),
      );
    } catch {
      return jsonResponse({ error: "persistence_unavailable" }, 503);
    }
    return closed
      ? jsonResponse({ ok: true, state: "closed_manual" }, 200)
      : jsonResponse({ error: "delivery_state_conflict" }, 409);
  }

  // I1 (§6.3): the ONLY resend path — audited, marked possible-duplicate,
  // and arming the §6.3.3 verification scans inside the store CAS.
  let resent: boolean;
  try {
    resent = await dispatchStore.operatorResend(
      command.delivery_id,
      now,
      JSON.stringify({
        operator_action: "resend",
        possible_duplicate: true,
        evidence: command.evidence,
      }),
    );
  } catch {
    return jsonResponse({ error: "persistence_unavailable" }, 503);
  }
  if (!resent) {
    return jsonResponse({ error: "delivery_state_conflict" }, 409);
  }
  try {
    // §10/H2: the dispatcher carries the single destination "alerts", so the
    // marked job goes to the alerts queue and the row re-enters the pipeline.
    await destinationQueue(env, "alerts").send(
      dispatchQueueJobBody(command.delivery_id),
    );
  } catch {
    // R13: the row is already durably queued; the cron republishes stale
    // queued rows (itself gated on mode !== "off", per R20).
    return jsonResponse(
      { ok: true, queued: false, recovery_scheduled: true },
      200,
    );
  }
  return jsonResponse({ ok: true, queued: true }, 200);
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
      const [
        healthy,
        githubSecret,
        alertsUrl,
        activityUrl,
        relaySigning,
        legacyUnverified,
      ] = await Promise.all([
        dependencies.store.healthcheck(now, deployedRevision),
        readSecret(env.GITHUB_WEBHOOK_SECRET),
        readSecret(env.SLACK_ALERTS_WORKFLOW_WEBHOOK_URL),
        readSecret(env.SLACK_ACTIVITY_WORKFLOW_WEBHOOK_URL),
        relaySigningConfiguration(env),
        dependencies.store.hasLegacyUnverifiedDebt(),
      ]);
      const ready =
        healthy &&
        hasSafeSecretLength(githubSecret) &&
        relaySigning !== null &&
        slackWorkflowUrl(alertsUrl) !== null &&
        slackWorkflowUrl(activityUrl) !== null;
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

  if (url.pathname === DISPATCH_STATUS_PATH && request.method === "GET") {
    try {
      const dispatchStore = new D1DispatchStore(env.DB);
      const counters = await dispatchStore.statusCounters(dependencies.now());
      return jsonResponse(dispatchStatusBody(counters), 200);
    } catch {
      return jsonResponse({ error: "status_unavailable" }, 503);
    }
  }

  if (url.pathname === DISPATCH_OPERATOR_PATH) {
    return handleDispatchOperatorRequest(request, env, dependencies);
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

  const now = dependencies.now();
  const dispatchMode = parseDispatchMode(env.DISPATCH_MODE);
  const dispatchStore = new D1DispatchStore(env.DB);

  // ADR-001 §10 (operator decision 14/08/2026, issue #192 comment
  // 5299997975): the dispatcher owns ONLY #github-alerts — the official
  // "GitHub for Slack" app owns #github-activity. A delivery normalized to
  // "activity" therefore keeps flowing through the untouched legacy path in
  // EVERY mode, primary included.
  const dispatched = normalized.destination === "alerts" ? "alerts" : null;

  // ADR-001 §6.8 primary mode: the outbox is the accepting path; the legacy
  // table is read forever by the presence fence.
  if (dispatchMode === "primary" && dispatched !== null) {
    let accepted: Awaited<ReturnType<typeof acceptPrimary>>;
    try {
      accepted = await acceptPrimary(dispatchStore, {
        deliveryId,
        destination: dispatched,
        payloadJson: JSON.stringify(normalized.payload),
        now,
      });
    } catch {
      return jsonResponse({ error: "persistence_unavailable" }, 503);
    }
    if (accepted !== "inserted") {
      return jsonResponse({ accepted: true, duplicate: true }, 202);
    }
    try {
      await destinationQueue(env, normalized.destination).send(
        dispatchQueueJobBody(deliveryId),
      );
    } catch {
      // R13: the queued row is durable; the cron re-enqueues it and the
      // claim CAS makes an eventual double-publish safe.
      return jsonResponse(
        { accepted: true, queued: false, recovery_scheduled: true },
        202,
      );
    }
    return jsonResponse({ accepted: true, queued: true }, 202);
  }

  // ADR-001 §6.8 modes off/shadow — and, per §10, any "activity" delivery in
  // primary mode: the legacy path accepts, fenced by the outbox (shadow rows
  // excluded inside the helper).
  try {
    if (await legacyAcceptBlockedByOutbox(dispatchStore, deliveryId)) {
      return jsonResponse({ accepted: true, duplicate: true }, 202);
    }
  } catch {
    return jsonResponse({ error: "persistence_unavailable" }, 503);
  }

  let inserted: boolean;
  try {
    if (dispatchMode === "shadow" && dispatched !== null) {
      // ADR-001 §6.8 F2: legacy row and shadow outbox row commit atomically.
      // §10: an "activity" delivery gets NO shadow row — it falls through to
      // the plain legacy insert below.
      const paired = await insertShadowPaired(env.DB, {
        deliveryId,
        eventType: event,
        action: normalized.payload.action,
        repository: normalized.payload.repository,
        destination: dispatched,
        payloadJson: JSON.stringify(normalized.payload),
        now,
      });
      inserted = paired.legacyInserted;
    } else if (
      dependencies.store instanceof D1DeliveryStore &&
      dependencies.store.insert === D1DeliveryStore.prototype.insert
    ) {
      // ADR-001 §6.8 (Copilot finding F8): the production D1 path routes
      // through the fenced INSERT so the legacy row cannot commit while a
      // non-shadow outbox row exists — the read fence above only narrows
      // the check-then-insert window; this closes it in-statement. The
      // substitution applies ONLY to the stock D1 insert; a store whose
      // insert was replaced (test interposition) keeps its own behavior.
      inserted = await insertLegacyFenced(env.DB, {
        deliveryId,
        eventType: event,
        action: normalized.payload.action,
        repository: normalized.payload.repository,
        destination: normalized.destination,
        payloadJson: JSON.stringify(normalized.payload),
        now,
      });
    } else {
      // Injected stores (unit-test fakes) keep the plain insert; the fenced
      // SQL variant is pinned in test/dispatch-wiring.test.ts.
      inserted = await dependencies.store.insert({
        deliveryId,
        eventType: event,
        action: normalized.payload.action,
        repository: normalized.payload.repository,
        destination: normalized.destination,
        payload: normalized.payload,
        now,
      });
    }
  } catch {
    return jsonResponse({ error: "persistence_unavailable" }, 503);
  }

  if (!inserted) {
    return jsonResponse({ accepted: true, duplicate: true }, 202);
  }

  try {
    await destinationQueue(env, normalized.destination).send({ deliveryId });
  } catch {
    await dependencies.store.markEnqueueFailed(
      deliveryId,
      now,
      now + 5_000,
      "queue_enqueue_failed",
    );
    return jsonResponse(
      { error: "queue_unavailable", recovery_scheduled: true },
      503,
    );
  }

  try {
    await dependencies.store.markQueued(deliveryId, now);
  } catch {
    // The persisted pending row and queued delivery are intentionally retained.
    // Either the queue consumer or the scheduled recovery loop can finish it.
  }

  return jsonResponse({ accepted: true, queued: true }, 202);
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

async function processMarkedDispatchMessage(
  message: Message<QueueJob>,
  env: Env,
  dependencies: Required<RuntimeOverrides>,
): Promise<void> {
  const job = message.body as unknown as { deliveryId: string };
  // §6.8/R20: the mode active WHEN CONSUMED governs the message.
  // Copilot suppressed comment (F1): the mode is parsed FIRST and the secret
  // is never read while it is off. Reading it first made a Secrets Store
  // failure retry the message in mode off instead of taking the required R20
  // ack path — consuming max_retries and recreating the DLQ/mode-flip failure
  // §10.1 Residual 1 eliminated.
  const mode = parseDispatchMode(env.DISPATCH_MODE);
  let botToken = "";
  if (mode !== "off") {
    try {
      botToken = await readSecret(env.SLACK_DISPATCH_BOT_TOKEN);
    } catch {
      retryMessage(message, 60);
      return;
    }
  }
  await processDispatchMessage(
    {
      body: {
        deliveryId: job.deliveryId,
        mode,
      },
      attempts: message.attempts,
      ack: () => {
        message.ack();
      },
      retry: (options) => {
        if (options?.delaySeconds === undefined) {
          message.retry();
        } else {
          message.retry({ delaySeconds: options.delaySeconds });
        }
      },
    },
    {
      store: new D1DispatchStore(env.DB),
      fetch: dependencies.fetch,
      now: dependencies.now,
      botToken,
      channelFor: channelForDestination,
    },
  );
}

// ADR-001 §6.2/§6.5 row 16: a marked message that exhausted the main
// queue's retries reaches the DLQ and the row transitions to dead_letter
// (alarmed via the observer) — EXCEPT when the trips were DEFERRALS, not
// transport failures. Every consumer retry path is a deferral that leaves
// the row `queued` and untouched: the mode-off pause (R20), the F7 pacing
// reservation (§4 item 4) and the bot-token read failure. §10.1 Residual 1
// is exactly the failure of dead-lettering a healthy queued row on such a
// trip — "recoverable only through the operator menu, which §6.8/R20
// forbids" — so a row still in `queued` is spared in EVERY mode and the DLQ
// message is dropped (the row is durable; the cron republishes it and the
// queued_backlog_stale alarm makes the backlog visible). Row 16's transport
// failure keeps its transition: a row in `sending` still dead-letters.
async function processDispatchDeadLetterMessage(
  message: Message<QueueJob>,
  env: Env,
  dependencies: Required<RuntimeOverrides>,
): Promise<void> {
  const job = message.body as unknown as { deliveryId: string };
  const dispatchStore = new D1DispatchStore(env.DB);
  const now = dependencies.now();
  try {
    const row = await dispatchStore.get(job.deliveryId);
    if (row === null || row.state === "queued") {
      message.ack();
      return;
    }
    await dispatchStore.markDeadLetter(
      job.deliveryId,
      now,
      "cloudflare_queue_dead_letter",
    );
    message.ack();
  } catch {
    retryMessage(message, 60);
  }
}

export async function handleQueue(
  batch: MessageBatch<QueueJob>,
  env: Env,
  overrides?: RuntimeOverrides,
): Promise<void> {
  for (const message of batch.messages) {
    // ADR-001 §6.1: marked bodies belong to the dispatcher; legacy bodies
    // never carry the marker and keep flowing to the legacy consumers.
    if (isDispatchQueueJob(message.body)) {
      if (
        batch.queue === ALERT_DEAD_LETTER_QUEUE ||
        batch.queue === ACTIVITY_DEAD_LETTER_QUEUE
      ) {
        await processDispatchDeadLetterMessage(
          message,
          env,
          runtime(env, overrides),
        );
      } else {
        await processMarkedDispatchMessage(
          message,
          env,
          runtime(env, overrides),
        );
      }
      continue;
    }
    if (
      batch.queue === ALERT_DEAD_LETTER_QUEUE ||
      batch.queue === ACTIVITY_DEAD_LETTER_QUEUE
    ) {
      await processDeadLetterMessage(message, env, overrides);
    } else if (
      batch.queue === ALERT_QUEUE_NAME ||
      batch.queue === ACTIVITY_QUEUE_NAME
    ) {
      await processPrimaryMessage(message, env, overrides);
    } else {
      throw new Error("unexpected_queue");
    }
  }
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

// ADR-001 §6.3.1/§6.7/R13: dispatch pass — stale-queued handling, resolver
// budget and the observe-only alarms. Deliberately OUTSIDE
// runScheduledRecovery so the legacy protocol-seal early return can never
// starve it; a failure here never breaks the legacy recovery and vice versa.
// The pass is a no-op while the outbox is empty.
export async function runDispatchScheduled(
  env: Env,
  overrides?: RuntimeOverrides,
): Promise<void> {
  const dependencies = runtime(env, overrides);
  try {
    const dispatchResult = await runDispatchCronPass({
      database: env.DB,
      mode: parseDispatchMode(env.DISPATCH_MODE),
      fetch: dependencies.fetch,
      now: dependencies.now,
      readBotToken: () => readSecret(env.SLACK_DISPATCH_BOT_TOKEN),
      publish: async (destination, body) => {
        await destinationQueue(env, destination).send(body);
      },
    });
    if (!dispatchResult.skipped) {
      console.info(
        JSON.stringify({
          event: "dispatch_cron_pass",
          shadow_processed: dispatchResult.shadowProcessed,
          requeued: dispatchResult.requeued,
          resolver_examined: dispatchResult.resolverExamined,
          alarm_count: dispatchResult.alarms.length,
        }),
      );
      for (const alarm of dispatchResult.alarms) {
        console.error(
          JSON.stringify({ event: "dispatch_observer_alarm", alarm }),
        );
      }
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "dispatch_cron_pass_failed",
        ...safeFailureSummary(error),
      }),
    );
  }
}

// ADR-001 §6.7/R13/R20 — the scheduled entrypoint runs BOTH passes.
// Copilot suppressed comment (F2): the dispatch pass is documented as
// isolated from the legacy recovery, so a rejection from runScheduledRecovery
// (a D1/protocol lookup failure, say) must not starve outbox lease
// normalization, resolver work or alarms. The `finally` runs the dispatch
// pass either way and never swallows the legacy rejection —
// runDispatchScheduled handles its own errors, so it cannot mask it either.
export async function runScheduled(
  env: Env,
  overrides?: RuntimeOverrides,
): Promise<void> {
  try {
    await runScheduledRecovery(env, overrides);
  } finally {
    await runDispatchScheduled(env, overrides);
  }
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
    await runScheduled(env);
  },
} satisfies ExportedHandler<Env, QueueJob>;
