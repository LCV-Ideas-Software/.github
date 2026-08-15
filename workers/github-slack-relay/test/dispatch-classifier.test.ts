// ADR-001 §6.2 — architectural REDs for the TOTAL outcome classifier.
// Covers R10 (total classifier over the full status × body fixture space)
// plus the Retry-After capture half of R4 (the recorded value the resolver's
// scheduling later honors). These tests are the executable specification for
// ../src/dispatch/classifier and MUST fail until it is implemented.
import { afterEach, describe, expect, it } from "vitest";

import { classifyPostMessageOutcome } from "../src/dispatch/classifier";
import {
  MANUAL_ERROR_CODES,
  RETRY_AFTER_CEILING_MS,
  type PostMessageOutcome,
} from "../src/dispatch/contract";
import {
  closeDispatchDatabases,
  type FixtureResponse,
  slackPostError,
  slackPostOk,
  slackRateLimited,
} from "./dispatch-helpers";

afterEach(closeDispatchDatabases);

interface ClassifierInput {
  httpStatus: number;
  headers: { get(name: string): string | null };
  bodyText: string;
}

function classifierInput(
  httpStatus: number,
  bodyText: string,
  headers?: Record<string, string>,
): ClassifierInput {
  return { httpStatus, headers: new Headers(headers ?? {}), bodyText };
}

function fixtureInput(fixture: FixtureResponse): ClassifierInput {
  return classifierInput(
    fixture.status,
    JSON.stringify(fixture.body),
    fixture.headers,
  );
}

// Type-level pin of the codomain (R10): the classifier's outcome space is
// EXACTLY delivered / manual / ambiguous. `retry_scheduled` does not exist
// (ADR §6.2 — "There is NO automatic resend of any kind"). If a
// resend-scheduling kind were ever added to PostMessageOutcome, the `never`
// assignment below stops compiling.
function outcomeKind(
  outcome: PostMessageOutcome,
): "delivered" | "manual" | "ambiguous" {
  switch (outcome.kind) {
    case "delivered":
    case "manual":
    case "ambiguous":
      return outcome.kind;
    default: {
      const impossible: never = outcome;
      throw new Error(`unreachable_outcome_kind:${JSON.stringify(impossible)}`);
    }
  }
}

const DELIVERED_LOOKING_BODY = JSON.stringify({
  ok: true,
  channel: "C0BMUK793NV",
  ts: "1786665600.000100",
});

const MATRIX_STATUSES = [200, 201, 204, 302, 400, 404, 408, 429, 500, 502, 503];

const MATRIX_BODIES = [
  DELIVERED_LOOKING_BODY,
  JSON.stringify({ ok: true, channel: "C0BMUK793NV" }),
  JSON.stringify({ ok: true }),
  JSON.stringify({ ok: false, error: "channel_not_found" }),
  JSON.stringify({ ok: false, error: "internal_error" }),
  JSON.stringify({ ok: false, error: "ratelimited" }),
  JSON.stringify({ ok: false }),
  JSON.stringify({}),
  JSON.stringify(null),
  JSON.stringify([1, 2, 3]),
  JSON.stringify("ok"),
  '{"ok":true,"ts":"178',
  "<html>service unavailable</html>",
  "",
];

const MATRIX_HEADER_VARIANTS: (Record<string, string> | undefined)[] = [
  undefined,
  { "Retry-After": "5" },
];

describe("dispatch outcome classifier (ADR §6.2 — R10, R4)", () => {
  it("R10: HTTP 200 ok:true with ts classifies as delivered carrying ts and channel", () => {
    const outcome = classifyPostMessageOutcome(
      fixtureInput(slackPostOk("1786665600.000100", "C0BMQMW3L4E")),
    );

    expect(outcome).toEqual({
      kind: "delivered",
      ts: "1786665600.000100",
      channel: "C0BMQMW3L4E",
    });
  });

  it("R10: HTTP 200 ok:false classifies every MANUAL_ERROR_CODES code as manual with that code", () => {
    // Guard against a vacuous loop: ADR §6.2 enumerates exactly 16 codes.
    expect(MANUAL_ERROR_CODES.size).toBe(16);

    for (const code of MANUAL_ERROR_CODES) {
      const outcome = classifyPostMessageOutcome(
        fixtureInput(slackPostError(code)),
      );

      expect(outcome).toEqual({ kind: "manual", errorCode: code });
    }
  });

  it("R10: HTTP 200 ok:false internal_error and fatal_error classify as ambiguous", () => {
    // Spec guard: these codes must never be on the MANUAL list (E-A15 —
    // their descriptions do not state whether effects were applied).
    expect(MANUAL_ERROR_CODES.has("internal_error")).toBe(false);
    expect(MANUAL_ERROR_CODES.has("fatal_error")).toBe(false);

    for (const code of ["internal_error", "fatal_error"]) {
      const outcome = classifyPostMessageOutcome(
        fixtureInput(slackPostError(code)),
      );

      expect(outcome).toMatchObject({ kind: "ambiguous" });
    }
  });

  it("R10: HTTP 200 ok:false with an unrecognized code classifies as ambiguous", () => {
    expect(MANUAL_ERROR_CODES.has("brand_new_code")).toBe(false);

    const outcome = classifyPostMessageOutcome(
      fixtureInput(slackPostError("brand_new_code")),
    );

    expect(outcome).toMatchObject({ kind: "ambiguous" });
  });

  it("R4: HTTP 429 with an ok:false ratelimited body and Retry-After header classifies as ambiguous with retryAfterMs = header seconds × 1000", () => {
    const thirty = classifyPostMessageOutcome(fixtureInput(slackRateLimited(30)));
    expect(thirty).toMatchObject({ kind: "ambiguous", retryAfterMs: 30_000 });

    const seven = classifyPostMessageOutcome(fixtureInput(slackRateLimited(7)));
    expect(seven).toMatchObject({ kind: "ambiguous", retryAfterMs: 7_000 });
  });

  // Review finding N3 (ADR §10 H24): the finiteness check ran on the parsed
  // SECONDS, before the × 1000 conversion, so a header that overflows only
  // after the conversion produced an INFINITE delay — a schedule no clock
  // reaches, and a total classifier that is no longer fail-safe.
  it("N3: a Retry-After that overflows the millisecond conversion never yields an infinite delay", () => {
    // Finite as seconds, Infinity as milliseconds: treated as an ABSENT
    // header, so the caller falls back to its own bounded backoff.
    const overflowing = classifyPostMessageOutcome(
      classifierInput(429, JSON.stringify({ ok: false, error: "ratelimited" }), {
        "Retry-After": "1e308",
      }),
    );
    expect(overflowing).toMatchObject({ kind: "ambiguous", retryAfterMs: null });

    // Finite in both units but absurd: clamped to the legacy path's own
    // ceiling (retryAfterSeconds, src/index.ts).
    const huge = classifyPostMessageOutcome(
      classifierInput(429, JSON.stringify({ ok: false, error: "ratelimited" }), {
        "Retry-After": "1000000000000",
      }),
    );
    expect(huge).toMatchObject({
      kind: "ambiguous",
      retryAfterMs: RETRY_AFTER_CEILING_MS,
    });
    expect(RETRY_AFTER_CEILING_MS).toBe(43_200_000);

    // A value inside the ceiling is untouched.
    const ordinary = classifyPostMessageOutcome(
      classifierInput(429, JSON.stringify({ ok: false, error: "ratelimited" }), {
        "Retry-After": "43200",
      }),
    );
    expect(ordinary).toMatchObject({
      kind: "ambiguous",
      retryAfterMs: 43_200_000,
    });
  });

  it("R4: HTTP 429 without a Retry-After header classifies as ambiguous with retryAfterMs null", () => {
    const outcome = classifyPostMessageOutcome(
      classifierInput(429, JSON.stringify({ ok: false, error: "ratelimited" })),
    );

    expect(outcome).toMatchObject({ kind: "ambiguous", retryAfterMs: null });
  });

  it("R10: HTTP 429 with a nonsense body is still ambiguous — the status is classified before the body", () => {
    // A delivered-looking body must NOT rescue a 429 (ok-body rules apply
    // ONLY to HTTP 200), and garbage must not crash the classifier.
    for (const bodyText of [DELIVERED_LOOKING_BODY, "complete nonsense"]) {
      const outcome = classifyPostMessageOutcome(
        classifierInput(429, bodyText, { "Retry-After": "12" }),
      );

      expect(outcome).toMatchObject({ kind: "ambiguous", retryAfterMs: 12_000 });
    }
  });

  it("R10: HTTP 200 ok:true without ts classifies as ambiguous — canonical proof missing", () => {
    const outcome = classifyPostMessageOutcome(
      classifierInput(
        200,
        JSON.stringify({ ok: true, channel: "C0BMUK793NV" }),
      ),
    );

    expect(outcome).toMatchObject({ kind: "ambiguous" });
  });

  // Copilot suppressed comment (F4): a non-empty but MALFORMED ts or channel
  // used to reach markDelivered. Migration 0010 CHECKs both columns, so the
  // write raises a constraint violation inside the consumer and the message
  // neither acks nor transitions. A malformed success body stays AMBIGUOUS —
  // the resolver recovers the canonical identifiers from history.
  it("suppressed F4: an ok:true body with a malformed ts or channel classifies as ambiguous, never delivered", () => {
    const validTs = "1786737141.039580";
    const validChannel = "C0BMUK793NV";
    const malformed = [
      // Junk in the seconds part (the loose SQL glob would admit it).
      { ts: "1garbage.123456", channel: validChannel },
      // Five fraction digits: violates /^\d{10,13}\.\d{6}$/ and 0010's CHECK.
      { ts: "1786737141.03958", channel: validChannel },
      // Seven fraction digits, and a bare seconds value with no fraction.
      { ts: "1786737141.0395801", channel: validChannel },
      { ts: "1786737141", channel: validChannel },
      // Channel outside the 0010 shape (C + uppercase alphanumerics, 9-32).
      { ts: validTs, channel: "not-a-channel" },
      { ts: validTs, channel: "D0BMUK793NV" },
      { ts: validTs, channel: "C0BMUK79" },
      { ts: validTs, channel: "C0bmuk793nv" },
    ];

    for (const { ts, channel } of malformed) {
      const outcome = classifyPostMessageOutcome(
        classifierInput(200, JSON.stringify({ ok: true, channel, ts })),
      );

      expect(outcome, `ts=${ts} channel=${channel}`).toEqual({
        kind: "ambiguous",
        reason: "malformed_canonical_identifiers",
        retryAfterMs: null,
      });
    }

    // The valid pair still classifies as delivered with canonical proof.
    expect(
      classifyPostMessageOutcome(
        classifierInput(
          200,
          JSON.stringify({ ok: true, channel: validChannel, ts: validTs }),
        ),
      ),
    ).toEqual({ kind: "delivered", ts: validTs, channel: validChannel });
  });

  it("R10: 5xx responses classify as ambiguous regardless of body", () => {
    // A 5xx may follow a materialized post (ADR §6.5 row 5): neither a
    // delivered-looking nor a MANUAL-looking body may override the status.
    const bodies = [
      DELIVERED_LOOKING_BODY,
      JSON.stringify({ ok: false, error: "channel_not_found" }),
    ];
    for (const status of [500, 503]) {
      for (const bodyText of bodies) {
        const outcome = classifyPostMessageOutcome(
          classifierInput(status, bodyText),
        );

        expect(outcome).toMatchObject({ kind: "ambiguous" });
      }
    }
  });

  it("R10: unexpected 3xx and 4xx responses classify as ambiguous", () => {
    for (const status of [302, 404]) {
      const outcome = classifyPostMessageOutcome(
        classifierInput(status, "<html>Not what you expected</html>"),
      );

      expect(outcome).toMatchObject({ kind: "ambiguous" });
    }
  });

  it("R10: non-JSON and empty bodies on HTTP 200 classify as ambiguous", () => {
    // A success may hide behind a broken body (ADR §6.5 row 9) — fail-safe.
    for (const bodyText of ["<html>", ""]) {
      const outcome = classifyPostMessageOutcome(
        classifierInput(200, bodyText),
      );

      expect(outcome).toMatchObject({ kind: "ambiguous" });
    }
  });

  it("R10: totality — the classifier never throws and always returns one of the three kinds across the status × body × header matrix", () => {
    // A throw anywhere in this loop fails the test: totality is the claim.
    for (const status of MATRIX_STATUSES) {
      for (const bodyText of MATRIX_BODIES) {
        for (const headers of MATRIX_HEADER_VARIANTS) {
          const outcome = classifyPostMessageOutcome(
            classifierInput(status, bodyText, headers),
          );

          expect(["delivered", "manual", "ambiguous"]).toContain(outcome.kind);
        }
      }
    }
  });

  it("R10: no fixture yields an outcome that schedules a resend — the codomain is exactly delivered/manual/ambiguous", () => {
    const inputs: ClassifierInput[] = [
      fixtureInput(slackPostOk("1786665600.000100")),
      fixtureInput(slackRateLimited(30)),
    ];
    for (const code of MANUAL_ERROR_CODES) {
      inputs.push(fixtureInput(slackPostError(code)));
    }
    for (const code of ["internal_error", "fatal_error", "brand_new_code"]) {
      inputs.push(fixtureInput(slackPostError(code)));
    }
    for (const status of MATRIX_STATUSES) {
      for (const bodyText of MATRIX_BODIES) {
        inputs.push(classifierInput(status, bodyText));
      }
    }

    const observedKinds = new Set<string>();
    for (const input of inputs) {
      // outcomeKind throws on any kind outside the pinned three (and its
      // `never` branch makes a widened codomain a COMPILE error).
      observedKinds.add(outcomeKind(classifyPostMessageOutcome(input)));
    }

    for (const kind of observedKinds) {
      expect(["delivered", "manual", "ambiguous"]).toContain(kind);
      expect(kind).not.toMatch(/retry|resend|schedul/i);
    }
  });
});
