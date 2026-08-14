import type { RelayDestination, SlackWorkflowPayload } from "./domain";
import type {
  SlackProgressPhase,
  SlackReconciliationScanState,
  SlackTraceOutcome,
} from "./store";

export interface SignedSlackProgress {
  delivery_id: string;
  destination: RelayDestination;
  phase: SlackProgressPhase;
  message_ts: string;
  relay_attempt: string;
  function_execution_id: string;
  receipt_timestamp: string;
  receipt_signature: string;
}

export interface SignedSlackTrace {
  trace_id: string;
  delivery_id: string | null;
  outcome: SlackTraceOutcome;
  relay_attempt: string | null;
  send_execution_id: string | null;
  slack_channel_id: string | null;
  slack_message_ts: string | null;
  send_boundary_reached: boolean;
  pre_send_failure_proven: boolean;
  started_at_us: number;
  completed_at_us: number | null;
}

export type SlackTraceHydrationDebtReason =
  "retention_expired" | "pagination_bound";

export interface SignedSlackTraceHydration {
  trace_id: string;
  first_observed_us: number;
  last_observed_us: number;
  status: "pending" | "debt" | "legacy";
  debt_reason: SlackTraceHydrationDebtReason | null;
  attempted: boolean;
}

export interface SignedSlackReconciliationV4 {
  checkpoint_us: number;
  report_timestamp: string;
  scan_state: SlackReconciliationScanState;
  traces: SignedSlackTrace[];
  report_signature: string;
}

export interface SignedSlackReconciliation extends SignedSlackReconciliationV4 {
  hydrations: SignedSlackTraceHydration[];
}

export type SignedSlackReconciliationV3 = Omit<
  SignedSlackReconciliationV4,
  "scan_state"
>;

export interface SignedSlackCheckpointRequest {
  request_timestamp: string;
  request_signature: string;
}

interface TimingSafeSubtleCrypto extends SubtleCrypto {
  timingSafeEqual(left: BufferSource, right: BufferSource): boolean;
}

function decodeHex(value: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/iu.test(value)) {
    return null;
  }

  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    const byte = Number.parseInt(value.slice(index, index + 2), 16);
    if (!Number.isFinite(byte)) {
      return null;
    }
    bytes[index / 2] = byte;
  }

  return bytes;
}

export async function readSecret(binding: unknown): Promise<string> {
  if (typeof binding === "string") {
    return binding;
  }

  if (
    binding === null ||
    typeof binding !== "object" ||
    !("get" in binding) ||
    typeof binding.get !== "function"
  ) {
    throw new Error("secret_binding_unavailable");
  }

  const value = await binding.get();
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("secret_value_unavailable");
  }

  return value;
}

export async function verifyGitHubSignature(
  body: ArrayBuffer,
  signatureHeader: string,
  secret: string,
): Promise<boolean> {
  const match = /^sha256=([0-9a-f]{64})$/iu.exec(signatureHeader);
  if (match === null || match[1] === undefined || secret.length === 0) {
    return false;
  }

  const received = decodeHex(match[1]);
  if (received === null) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const calculated = new Uint8Array(
    await crypto.subtle.sign({ name: "HMAC" }, key, body),
  );
  const subtle = crypto.subtle as TimingSafeSubtleCrypto;

  if (typeof subtle.timingSafeEqual !== "function") {
    throw new Error("timing_safe_comparison_unavailable");
  }

  return subtle.timingSafeEqual(calculated, received);
}

export function canonicalSlackRelayPayload(
  payload: SlackWorkflowPayload,
): string {
  return JSON.stringify([
    payload.source,
    payload.severity,
    payload.repository,
    payload.title,
    payload.details,
    payload.actor,
    payload.branch,
    payload.url,
    payload.occurred_at,
    payload.delivery_id,
    payload.event,
    payload.action,
    payload.destination,
    payload.relay_attempt,
    payload.relay_timestamp,
  ]);
}

export async function signSlackRelayPayload(
  payload: SlackWorkflowPayload,
  secret: string,
): Promise<string> {
  if (secret.length === 0) {
    throw new Error("relay_signing_secret_unavailable");
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "HMAC" },
      key,
      new TextEncoder().encode(canonicalSlackRelayPayload(payload)),
    ),
  );

  return [...signature]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacSignature(message: string, secret: string): Promise<string> {
  if (secret.length === 0) {
    throw new Error("relay_signing_secret_unavailable");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "HMAC" },
      key,
      new TextEncoder().encode(message),
    ),
  );
  return [...signature]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function verifyHmacSignature(
  message: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  const decoded = decodeHex(signature);
  if (decoded === null || secret.length === 0) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    { name: "HMAC" },
    key,
    decoded,
    new TextEncoder().encode(message),
  );
}

export function canonicalSlackProgress(
  receipt: Omit<SignedSlackProgress, "receipt_signature">,
): string {
  return JSON.stringify([
    "slack_delivery_progress_v2",
    receipt.delivery_id,
    receipt.destination,
    receipt.phase,
    receipt.message_ts,
    receipt.relay_attempt,
    receipt.function_execution_id,
    receipt.receipt_timestamp,
  ]);
}

export async function signSlackProgress(
  receipt: Omit<SignedSlackProgress, "receipt_signature">,
  secret: string,
): Promise<string> {
  return hmacSignature(canonicalSlackProgress(receipt), secret);
}

export async function verifySlackProgress(
  receipt: SignedSlackProgress,
  secret: string,
): Promise<boolean> {
  return verifyHmacSignature(
    canonicalSlackProgress(receipt),
    receipt.receipt_signature,
    secret,
  );
}

export function canonicalSlackReconciliation(
  report: Omit<SignedSlackReconciliation, "report_signature">,
): string {
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

export function canonicalSlackReconciliationV4(
  report: Omit<SignedSlackReconciliationV4, "report_signature">,
): string {
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

export function canonicalSlackReconciliationV3(
  report: Omit<SignedSlackReconciliationV3, "report_signature">,
): string {
  return JSON.stringify([
    "slack_activity_reconciliation_v3",
    report.checkpoint_us,
    report.report_timestamp,
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

export function canonicalSlackReconciliationV2(
  report: Omit<SignedSlackReconciliationV3, "report_signature">,
): string {
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

export async function signSlackReconciliation(
  report:
    | Omit<SignedSlackReconciliation, "report_signature">
    | Omit<SignedSlackReconciliationV4, "report_signature">
    | Omit<SignedSlackReconciliationV3, "report_signature">,
  secret: string,
): Promise<string> {
  return hmacSignature(
    "hydrations" in report
      ? canonicalSlackReconciliation(report)
      : "scan_state" in report
        ? canonicalSlackReconciliationV4(report)
        : canonicalSlackReconciliationV3(report),
    secret,
  );
}

export async function verifySlackReconciliation(
  report: SignedSlackReconciliation,
  secret: string,
): Promise<boolean> {
  return verifyHmacSignature(
    canonicalSlackReconciliation(report),
    report.report_signature,
    secret,
  );
}

export async function verifySlackReconciliationV4(
  report: SignedSlackReconciliationV4,
  secret: string,
): Promise<boolean> {
  return verifyHmacSignature(
    canonicalSlackReconciliationV4(report),
    report.report_signature,
    secret,
  );
}

export async function verifySlackReconciliationV3(
  report: SignedSlackReconciliationV3,
  secret: string,
): Promise<boolean> {
  return verifyHmacSignature(
    canonicalSlackReconciliationV3(report),
    report.report_signature,
    secret,
  );
}

export async function signSlackReconciliationV2(
  report: Omit<SignedSlackReconciliationV3, "report_signature">,
  secret: string,
): Promise<string> {
  return hmacSignature(canonicalSlackReconciliationV2(report), secret);
}

export async function verifySlackReconciliationV2(
  report: SignedSlackReconciliationV3,
  secret: string,
): Promise<boolean> {
  return verifyHmacSignature(
    canonicalSlackReconciliationV2(report),
    report.report_signature,
    secret,
  );
}

export function canonicalSlackCheckpointRequest(
  request: Omit<SignedSlackCheckpointRequest, "request_signature">,
): string {
  return JSON.stringify([
    "slack_activity_checkpoint_request_v1",
    request.request_timestamp,
  ]);
}

export async function signSlackCheckpointRequest(
  request: Omit<SignedSlackCheckpointRequest, "request_signature">,
  secret: string,
): Promise<string> {
  return hmacSignature(canonicalSlackCheckpointRequest(request), secret);
}

export async function verifySlackCheckpointRequest(
  request: SignedSlackCheckpointRequest,
  secret: string,
): Promise<boolean> {
  return verifyHmacSignature(
    canonicalSlackCheckpointRequest(request),
    request.request_signature,
    secret,
  );
}
