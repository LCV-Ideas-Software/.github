// ADR-001 §6.2 — the TOTAL outcome classifier for chat.postMessage
// responses (R10, R4). HTTP status is classified first; ok-body rules apply
// ONLY to HTTP 200. The function never throws: every input lands in exactly
// one of delivered / manual / ambiguous.
import { MANUAL_ERROR_CODES, type PostMessageOutcome } from "./contract";

export interface PostMessageResponseParts {
  httpStatus: number;
  headers: { get(name: string): string | null };
  bodyText: string;
}

// ADR §6.2 [E-A12]: Retry-After seconds × 1000; null when absent or invalid.
function retryAfterMsFrom(headers: {
  get(name: string): string | null;
}): number | null {
  const raw = headers.get("Retry-After");
  if (raw === null) return null;
  const seconds = Number(raw.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.round(seconds * 1000);
}

function parseJsonObject(bodyText: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // §6.5 row 9: a malformed body is classified below, never thrown.
  }
  return null;
}

export function classifyPostMessageOutcome(
  input: PostMessageResponseParts,
): PostMessageOutcome {
  if (input.httpStatus === 429) {
    // §6.2: 429 wins regardless of body, including an ok:false ratelimited
    // body — and regardless of a delivered-looking body.
    return {
      kind: "ambiguous",
      reason: "http_429",
      retryAfterMs: retryAfterMsFrom(input.headers),
    };
  }
  if (input.httpStatus !== 200) {
    // §6.5 rows 5-6: 5xx and unexpected 3xx/4xx may follow a materialized
    // post — fail-safe.
    return {
      kind: "ambiguous",
      reason: `http_${input.httpStatus}`,
      retryAfterMs: null,
    };
  }
  const body = parseJsonObject(input.bodyText);
  if (body === null) {
    return {
      kind: "ambiguous",
      reason: "unparseable_body",
      retryAfterMs: null,
    };
  }
  if (body["ok"] === true) {
    const ts = body["ts"];
    const channel = body["channel"];
    if (
      typeof ts === "string" &&
      ts.length > 0 &&
      typeof channel === "string" &&
      channel.length > 0
    ) {
      return { kind: "delivered", ts, channel };
    }
    // ok:true without ts — canonical proof missing.
    return {
      kind: "ambiguous",
      reason: "ok_true_without_canonical_ts",
      retryAfterMs: null,
    };
  }
  const errorCode = body["error"];
  if (body["ok"] === false && typeof errorCode === "string") {
    if (MANUAL_ERROR_CODES.has(errorCode)) {
      return { kind: "manual", errorCode };
    }
    // internal_error / fatal_error / any unknown code: the descriptions do
    // not state whether effects were applied [E-A15].
    return {
      kind: "ambiguous",
      reason: `slack_error_${errorCode}`,
      retryAfterMs: null,
    };
  }
  return {
    kind: "ambiguous",
    reason: "unrecognized_body_shape",
    retryAfterMs: null,
  };
}
