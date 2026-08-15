import { createHmac } from "node:crypto";
import { pathToFileURL } from "node:url";

const CHECKPOINT_URL =
  "https://github-slack-alerts.lcv.workers.dev/slack/reconciliation/checkpoint";
const MAX_ATTEMPTS = 2;
const MAX_RETRY_DELAY_MS = 5_000;
const MINIMUM_SECRET_BYTES = 32;

// Accommodates the strict v5 checkpoint envelope with 25 maximum-length,
// ASCII-only trace IDs while retaining a small, explicit response bound.
export const RELAY_SIGNER_PROOF_MAX_RESPONSE_BYTES = 4_096;
export const RELAY_SIGNER_PROOF_REQUEST_TIMEOUT_MS = 10_000;
export const RELAY_SIGNER_PROOF_WORST_CASE_NETWORK_MS =
  MAX_ATTEMPTS * RELAY_SIGNER_PROOF_REQUEST_TIMEOUT_MS + MAX_RETRY_DELAY_MS;

function unavailable() {
  return new Error("Slack relay signer proof is unavailable.");
}

function rejected() {
  return new Error("Slack relay signer proof was rejected.");
}

function exactKeys(value, expected) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  return (
    actual.length === required.length &&
    actual.every((key, index) => key === required[index])
  );
}

function relaySigningSecret(environment) {
  const secret = environment.SLACK_RELAY_SIGNING_SECRET;
  if (
    typeof secret !== "string" ||
    new TextEncoder().encode(secret).byteLength < MINIMUM_SECRET_BYTES
  ) {
    throw new Error(
      "Required environment variable SLACK_RELAY_SIGNING_SECRET is malformed.",
    );
  }
  return secret;
}

export function canonicalSlackCheckpointRequest(request) {
  return JSON.stringify([
    "slack_activity_checkpoint_request_v1",
    request.request_timestamp,
  ]);
}

function signCheckpointRequest(request, secret) {
  return createHmac("sha256", secret)
    .update(canonicalSlackCheckpointRequest(request), "utf8")
    .digest("hex");
}

async function cancelResponse(response) {
  try {
    await response.body?.cancel();
  } catch {
    // The remote response is intentionally neither read nor exposed.
  }
}

async function readBoundedJson(response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/json(?:;|$)/iu.test(contentType)) {
    await cancelResponse(response);
    throw unavailable();
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/u.test(contentLength)) {
      await cancelResponse(response);
      throw unavailable();
    }
    const declaredLength = Number.parseInt(contentLength, 10);
    if (
      !Number.isSafeInteger(declaredLength) ||
      declaredLength > RELAY_SIGNER_PROOF_MAX_RESPONSE_BYTES
    ) {
      await cancelResponse(response);
      throw unavailable();
    }
  }

  if (response.body === null) throw unavailable();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RELAY_SIGNER_PROOF_MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw unavailable();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined));
  } catch {
    throw unavailable();
  }
}

function acceptedCheckpoint(payload) {
  if (
    !exactKeys(payload, [
      "checkpoint_us",
      "reconciliation_version",
      "resume_from_us",
      "pending_trace_ids",
      "pending_trace_total",
      "pending_trace_oldest_us",
    ]) ||
    !Number.isSafeInteger(payload.checkpoint_us) ||
    payload.checkpoint_us < 0 ||
    payload.reconciliation_version !== 5 ||
    (payload.resume_from_us !== null &&
      (!Number.isSafeInteger(payload.resume_from_us) ||
        payload.resume_from_us < 0 ||
        payload.resume_from_us > payload.checkpoint_us)) ||
    !Array.isArray(payload.pending_trace_ids) ||
    payload.pending_trace_ids.length > 25 ||
    payload.pending_trace_ids.some(
      (traceId) =>
        typeof traceId !== "string" ||
        !/^Tr[A-Za-z0-9_-]{1,125}$/u.test(traceId),
    ) ||
    new Set(payload.pending_trace_ids).size !==
      payload.pending_trace_ids.length ||
    !Number.isSafeInteger(payload.pending_trace_total) ||
    payload.pending_trace_total < payload.pending_trace_ids.length ||
    (payload.pending_trace_total > 0 &&
      payload.pending_trace_ids.length === 0) ||
    (payload.pending_trace_total === 0) !==
      (payload.pending_trace_oldest_us === null) ||
    (payload.pending_trace_oldest_us !== null &&
      (!Number.isSafeInteger(payload.pending_trace_oldest_us) ||
        payload.pending_trace_oldest_us < 0))
  ) {
    throw unavailable();
  }
  return Object.freeze({
    checkpointUs: payload.checkpoint_us,
    reconciliationVersion: 5,
    resumeFromUs: payload.resume_from_us,
    pendingTraceIds: Object.freeze([...payload.pending_trace_ids]),
    pendingTraceTotal: payload.pending_trace_total,
    pendingTraceOldestUs: payload.pending_trace_oldest_us,
  });
}

function transientStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function retryDelay(response) {
  const value = response.headers.get("retry-after");
  if (value === null || !/^\d+$/u.test(value)) return 0;
  const seconds = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(seconds)) return MAX_RETRY_DELAY_MS;
  return Math.min(MAX_RETRY_DELAY_MS, seconds * 1_000);
}

export async function verifySlackRelaySigner({
  environment = process.env,
  fetchImpl = fetch,
  now = Date.now,
  signalFactory = (milliseconds) => AbortSignal.timeout(milliseconds),
  sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const secret = relaySigningSecret(environment);
  const nowMilliseconds = now();
  if (!Number.isSafeInteger(nowMilliseconds) || nowMilliseconds < 0) {
    throw unavailable();
  }
  const unsigned = {
    request_timestamp: String(Math.floor(nowMilliseconds / 1_000)),
  };
  if (!/^\d{10}$/u.test(unsigned.request_timestamp)) throw unavailable();
  const requestBody = JSON.stringify({
    ...unsigned,
    request_signature: signCheckpointRequest(unsigned, secret),
  });

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(CHECKPOINT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: requestBody,
        redirect: "error",
        signal: signalFactory(RELAY_SIGNER_PROOF_REQUEST_TIMEOUT_MS),
      });
    } catch {
      if (attempt < MAX_ATTEMPTS) continue;
      throw unavailable();
    }

    if (response.status !== 200) {
      const canRetry = transientStatus(response.status);
      const delay = canRetry ? retryDelay(response) : 0;
      await cancelResponse(response);
      if (canRetry && attempt < MAX_ATTEMPTS) {
        if (delay > 0) await sleep(delay);
        continue;
      }
      throw canRetry ? unavailable() : rejected();
    }

    try {
      return acceptedCheckpoint(await readBoundedJson(response));
    } catch {
      if (attempt === MAX_ATTEMPTS) throw unavailable();
    }
  }

  throw unavailable();
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  verifySlackRelaySigner()
    .then(() => console.log("Slack production relay signer equality verified."))
    .catch(() => {
      console.error("Slack production relay signer proof failed.");
      process.exitCode = 1;
    });
}
