// ADR-001 §6.2 — the TOTAL outcome classifier for chat.postMessage
// responses (R10, R4). HTTP status is classified first; ok-body rules apply
// ONLY to HTTP 200. The function never throws: every input lands in exactly
// one of delivered / manual / ambiguous.
import {
  MANUAL_ERROR_CODES,
  RETRY_AFTER_CEILING_MS,
  type PostMessageOutcome,
} from "./contract";

export interface PostMessageResponseParts {
  httpStatus: number;
  headers: { get(name: string): string | null };
  bodyText: string;
}

// Copilot suppressed comment (F4): a non-empty but MALFORMED ts or channel
// must not reach markDelivered. Migration 0010 CHECKs both columns, so a
// malformed value raises a constraint violation inside the consumer — the
// message would neither ack nor transition. These patterns are the exact
// shapes 0010 enforces: SLACK_MESSAGE_TS_PATTERN (src/index.ts) for the ts,
// and C + uppercase alphanumerics, total length 9-32, for the channel id.
// A malformed success body stays AMBIGUOUS (§6.2 fail-safe) so the resolver
// recovers the canonical identifiers from conversations.history.
// Copilot finding F8: the operator menu's `mark_delivered` action records the
// same canonical identifiers by hand, so it validates through these exact
// patterns instead of a second copy of the literals (src/index.ts).
export const CANONICAL_TS_PATTERN = /^\d{10,13}\.\d{6}$/u;
export const CANONICAL_CHANNEL_PATTERN = /^C[A-Z0-9]{8,31}$/u;

// ADR §6.2 [E-A12]: Retry-After seconds × 1000; null when absent or invalid.
// Review finding N3 (ADR §10 H24): the finiteness check ran on the PARSED
// SECONDS, before the × 1000 conversion, so `Retry-After: 1e308` passed it and
// became `Infinity`. Persisted, that is a delay no clock ever reaches:
// `next_attempt_ms` (§6.2/R4) leaves the row permanently undue for the
// resolver, and `verify_after_ms` (§6.3.3) does the same to a verification row
// WITHOUT ever raising `verification_abandoned`, because H14's ceiling is only
// reached by scans that actually run. The CONVERTED value is therefore what is
// validated: a non-finite result is treated as an ABSENT header — the §6.2
// fail-safe for a value that cannot be trusted, so the caller falls back to its
// own bounded backoff — and a finite value beyond RETRY_AFTER_CEILING_MS is
// clamped to it. Exported because the resolver's scan applies the SAME rule to
// the same header (one shape, one source — as with CANONICAL_TS_PATTERN).
export function retryAfterMsFrom(headers: {
  get(name: string): string | null;
}): number | null {
  const raw = headers.get("Retry-After");
  if (raw === null) return null;
  const seconds = Number(raw.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const milliseconds = Math.round(seconds * 1000);
  if (!Number.isFinite(milliseconds)) return null;
  return Math.min(milliseconds, RETRY_AFTER_CEILING_MS);
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
      // F4: validate the canonical identifiers BEFORE claiming delivery.
      if (
        !CANONICAL_TS_PATTERN.test(ts) ||
        !CANONICAL_CHANNEL_PATTERN.test(channel)
      ) {
        return {
          kind: "ambiguous",
          reason: "malformed_canonical_identifiers",
          retryAfterMs: null,
        };
      }
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
