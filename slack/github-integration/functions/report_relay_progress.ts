import { DefineFunction, Schema, SlackFunction } from "deno-slack-sdk/mod.ts";
import { canonicalProgressAuthorization } from "./validate_relay_message.ts";

export type RelayProgressPhase = "send_started" | "delivered";

export interface RelayProgressInputs {
  delivery_id: string;
  destination: string;
  phase: string;
  message_ts: string;
  message: string;
  relay_attempt: string;
  relay_timestamp: string;
  progress_token: string;
}

const RELAY_PROGRESS_URL =
  "https://github-slack-alerts.lcv.workers.dev/slack/progress";
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;
const MESSAGE_TS_PATTERN = /^\d{10,13}\.\d{6}$/;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_AGE_SECONDS = 300;
const MAX_CLOCK_SKEW_SECONDS = 60;

interface UnsignedProgress {
  delivery_id: string;
  destination: "alerts" | "activity";
  phase: RelayProgressPhase;
  message_ts: string;
  relay_attempt: string;
  function_execution_id: string;
  receipt_timestamp: string;
}

export function canonicalRelayProgress(progress: UnsignedProgress): string {
  return JSON.stringify([
    "slack_delivery_progress_v2",
    progress.delivery_id,
    progress.destination,
    progress.phase,
    progress.message_ts,
    progress.relay_attempt,
    progress.function_execution_id,
    progress.receipt_timestamp,
  ]);
}

async function signRelayProgress(
  progress: UnsignedProgress,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(canonicalRelayProgress(progress)),
    ),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function signatureBytes(signature: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[a-f0-9]{64}$/.test(signature)) return null;
  const bytes = new Uint8Array(new ArrayBuffer(32));
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(
      signature.slice(index * 2, index * 2 + 2),
      16,
    );
  }
  return bytes;
}

async function authorizedSigningSecret(
  inputs: RelayProgressInputs,
  secrets: readonly string[],
  now: number,
): Promise<string | null> {
  if (!/^\d{10}$/.test(inputs.relay_timestamp)) return null;
  const relayTimestamp = Number.parseInt(inputs.relay_timestamp, 10);
  const nowSeconds = Math.floor(now / 1_000);
  if (
    relayTimestamp < nowSeconds - MAX_AGE_SECONDS ||
    relayTimestamp > nowSeconds + MAX_CLOCK_SKEW_SECONDS
  ) {
    return null;
  }
  const token = signatureBytes(inputs.progress_token);
  if (token === null) return null;
  const canonical = new TextEncoder().encode(
    canonicalProgressAuthorization(inputs),
  );
  const candidates = secrets.slice(0, 2);
  const results = await Promise.all(
    candidates.map(async (secret) => {
      if (new TextEncoder().encode(secret).byteLength < 32) return false;
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );
      return crypto.subtle.verify("HMAC", key, token, canonical);
    }),
  );
  const index = results.findIndex(Boolean);
  return index < 0 ? null : (candidates[index] ?? null);
}

function validatedProgress(
  inputs: RelayProgressInputs,
  functionExecutionId: string,
  now: number,
): UnsignedProgress | null {
  if (
    !DELIVERY_ID_PATTERN.test(inputs.delivery_id) ||
    !/^[1-9][0-9]{0,15}$/.test(inputs.relay_attempt) ||
    !Number.isSafeInteger(Number.parseInt(inputs.relay_attempt, 10)) ||
    !/^Fx[A-Za-z0-9]{1,126}$/.test(functionExecutionId) ||
    (inputs.destination !== "alerts" && inputs.destination !== "activity") ||
    (inputs.phase !== "send_started" && inputs.phase !== "delivered") ||
    !Number.isSafeInteger(now) ||
    now <= 0 ||
    (inputs.phase === "send_started" && inputs.message_ts !== "") ||
    (inputs.phase === "delivered" &&
      !MESSAGE_TS_PATTERN.test(inputs.message_ts))
  ) {
    return null;
  }
  return {
    delivery_id: inputs.delivery_id,
    destination: inputs.destination,
    phase: inputs.phase,
    message_ts: inputs.message_ts,
    relay_attempt: inputs.relay_attempt,
    function_execution_id: functionExecutionId,
    receipt_timestamp: String(Math.floor(now / 1_000)),
  };
}

export async function reportRelayProgress(
  inputs: RelayProgressInputs,
  signingSecret: string,
  functionExecutionId: string,
  options: {
    fetchImpl?: typeof fetch;
    now?: () => number;
  } = {},
): Promise<{ ok: true; message: string } | { ok: false }> {
  const now = (options.now ?? Date.now)();
  const secret = await authorizedSigningSecret(inputs, [signingSecret], now);
  if (secret === null) return { ok: false };
  const progress = validatedProgress(inputs, functionExecutionId, now);
  if (progress === null) return { ok: false };
  const body = JSON.stringify({
    ...progress,
    receipt_signature: await signRelayProgress(progress, secret),
  });
  const fetchImpl = options.fetchImpl ??
    ((input, init) => globalThis.fetch(input, init));

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(RELAY_PROGRESS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      if (attempt === 0) continue;
      return { ok: false };
    }

    if (response.status >= 500 && attempt === 0) {
      await response.body?.cancel().catch(() => undefined);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false };
    }
    try {
      const confirmation = await response.json();
      if (
        confirmation !== null &&
        typeof confirmation === "object" &&
        !Array.isArray(confirmation) &&
        (confirmation as Record<string, unknown>).ok === true
      ) {
        return { ok: true, message: inputs.message };
      }
    } catch {
      // A receipt is not accepted without the exact authenticated endpoint reply.
    }
    // A successful HTTP status with a truncated or structurally invalid body is
    // indistinguishable from a committed write whose confirmation was lost.
    // Retry the byte-identical, execution-bound operation once; the relay's CAS
    // returns the same owner as an idempotent duplicate after a prior commit.
    if (attempt === 0) continue;
    return { ok: false };
  }
  return { ok: false };
}

const text = { type: Schema.types.string } as const;

export const ReportRelayProgressDefinition = DefineFunction({
  callback_id: "report_github_relay_progress",
  title: "Record GitHub relay send boundary",
  description:
    "Authenticates the send boundary and confirms the resulting Slack message",
  source_file: "functions/report_relay_progress.ts",
  input_parameters: {
    properties: {
      delivery_id: text,
      destination: text,
      phase: text,
      message_ts: text,
      message: text,
      relay_attempt: text,
      relay_timestamp: text,
      progress_token: text,
    },
    required: [
      "delivery_id",
      "destination",
      "phase",
      "message_ts",
      "message",
      "relay_attempt",
      "relay_timestamp",
      "progress_token",
    ],
  },
  output_parameters: {
    properties: { message: text },
    required: ["message"],
  },
});

export default SlackFunction(
  ReportRelayProgressDefinition,
  async ({ inputs, env, event }) => {
    const result = await reportRelayProgress(
      inputs as RelayProgressInputs,
      env["SLACK_RELAY_SIGNING_SECRET_NEXT"] ?? "",
      event.function_execution_id,
    );
    return result.ok
      ? { outputs: { message: result.message } }
      : { error: "GitHub relay delivery progress could not be confirmed" };
  },
);
