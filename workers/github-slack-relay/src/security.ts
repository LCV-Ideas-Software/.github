import type { RelayDestination, SlackWorkflowPayload } from "./domain";
import type { SlackProgressPhase, SlackTraceOutcome } from "./store";

export interface SignedSlackProgress {
  delivery_id: string;
  destination: RelayDestination;
  phase: SlackProgressPhase;
  message_ts: string;
  receipt_timestamp: string;
  receipt_signature: string;
}

export interface SignedSlackTrace {
  trace_id: string;
  delivery_id: string;
  outcome: SlackTraceOutcome;
  send_boundary_reached: boolean;
  pre_send_failure_proven: boolean;
  started_at_us: number;
  completed_at_us: number | null;
}

export interface SignedSlackReconciliation {
  checkpoint_us: number;
  report_timestamp: string;
  traces: SignedSlackTrace[];
  report_signature: string;
}

export interface SignedSlackCheckpointRequest {
  request_timestamp: string;
  request_signature: string;
}

export interface SignedSlackProtocolActivation {
  activation_id: string;
  expected_revision: string;
  schema_revision: string;
  activation_signature: string;
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
    "slack_delivery_progress_v1",
    receipt.delivery_id,
    receipt.destination,
    receipt.phase,
    receipt.message_ts,
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
    "slack_activity_reconciliation_v1",
    report.checkpoint_us,
    report.report_timestamp,
    report.traces.map((trace) => [
      trace.trace_id,
      trace.delivery_id,
      trace.outcome,
      trace.send_boundary_reached,
      trace.pre_send_failure_proven,
      trace.started_at_us,
      trace.completed_at_us,
    ]),
  ]);
}

export async function signSlackReconciliation(
  report: Omit<SignedSlackReconciliation, "report_signature">,
  secret: string,
): Promise<string> {
  return hmacSignature(canonicalSlackReconciliation(report), secret);
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

export function canonicalSlackProtocolActivation(
  request: Omit<SignedSlackProtocolActivation, "activation_signature">,
): string {
  return JSON.stringify([
    "slack_delivery_protocol_activation_v1",
    request.activation_id,
    request.expected_revision,
    request.schema_revision,
  ]);
}

export async function signSlackProtocolActivation(
  request: Omit<SignedSlackProtocolActivation, "activation_signature">,
  secret: string,
): Promise<string> {
  return hmacSignature(canonicalSlackProtocolActivation(request), secret);
}

export async function verifySlackProtocolActivation(
  request: SignedSlackProtocolActivation,
  secret: string,
): Promise<boolean> {
  return verifyHmacSignature(
    canonicalSlackProtocolActivation(request),
    request.activation_signature,
    secret,
  );
}
