// ADR-001 architectural REDs — queue consumer, fence, observer and mode
// (R1 queue level, R5, R7, R11, R15, R20; plus §6.2 consumer wiring and the
// §6.1 30 s abort precondition). These tests are the executable spec for
// src/dispatch/{consumer,mode,observer,outbox}; they FAIL until those
// modules land (RED phase).
import { afterEach, describe, expect, it } from "vitest";

import type {
  DispatchConsumerDeps,
  DispatchQueueMessage,
} from "../src/dispatch/consumer";
import { processDispatchMessage } from "../src/dispatch/consumer";
import type {
  DispatchDestination,
  DispatchMode,
  DispatchStore,
  ObserverSnapshot,
} from "../src/dispatch/contract";
import { DISPATCH_METADATA_EVENT_TYPE } from "../src/dispatch/contract";
import { fenceDecision, parseDispatchMode } from "../src/dispatch/mode";
import { observerAlarms } from "../src/dispatch/observer";
import { D1DispatchStore } from "../src/dispatch/outbox";
import type { FixtureResponse } from "./dispatch-helpers";
import {
  auditRows,
  closeDispatchDatabases,
  DISPATCH_TEST_NOW,
  dispatchDatabase,
  outboxRow,
  scriptedFetch,
  slackPostError,
  slackPostOk,
  slackRateLimited,
} from "./dispatch-helpers";

const POST_URL = "https://slack.com/api/chat.postMessage";
const ALERTS_CHANNEL = "C0BMUK793NV";
const ACTIVITY_CHANNEL = "C0BMQMW3L4E";
const POST_TS = "1786795200.000100";
const THIRTY_MINUTES_MS = 30 * 60 * 1_000;
const MODES: readonly DispatchMode[] = ["off", "shadow", "primary"];

afterEach(closeDispatchDatabases);

function channelFor(destination: DispatchDestination): string {
  return destination === "alerts" ? ALERTS_CHANNEL : ACTIVITY_CHANNEL;
}

function consumerDeps(
  store: DispatchStore,
  fetchImpl: typeof fetch,
): DispatchConsumerDeps {
  return {
    store,
    fetch: fetchImpl,
    now: () => DISPATCH_TEST_NOW,
    botToken: "xoxb-red-fixture-token",
    channelFor,
  };
}

interface RecordedQueueMessage {
  message: DispatchQueueMessage;
  ackCount: () => number;
  retryOptions: ({ delaySeconds?: number } | undefined)[];
}

// Queue message body contract: `{ deliveryId, mode }`. The ADR does not
// specify the queue body; the pinned DispatchConsumerDeps carries no mode,
// and §6.8/R20 requires the mode to take effect at CONSUME time (a message
// already in flight when the operator flips DISPATCH_MODE must be processed
// under the NEW mode). The index.ts queue adapter therefore injects
// parseDispatchMode(env.DISPATCH_MODE) into the body it hands to
// processDispatchMessage.
function recordedMessage(
  deliveryId: string,
  mode: DispatchMode,
  attempts = 1,
): RecordedQueueMessage {
  let acks = 0;
  const retryOptions: ({ delaySeconds?: number } | undefined)[] = [];
  return {
    message: {
      body: { deliveryId, mode },
      attempts,
      ack() {
        acks += 1;
      },
      retry(options?: { delaySeconds?: number }) {
        retryOptions.push(options);
      },
    },
    ackCount: () => acks,
    retryOptions,
  };
}

async function seedQueuedRow(
  store: DispatchStore,
  deliveryId: string,
  destination: DispatchDestination,
  shadow = false,
): Promise<void> {
  const inserted = await store.insert({
    deliveryId,
    destination,
    shadow,
    payloadJson: JSON.stringify({ text: `red fixture ${deliveryId}` }),
    now: DISPATCH_TEST_NOW,
  });
  expect(inserted).toBe(true);
}

// Serves the scripted response for chat.postMessage ONLY; any other URL
// throws unscripted_fetch (scriptedFetch), which fails the test loudly.
function postMessageFetch(response: FixtureResponse): ReturnType<
  typeof scriptedFetch
> {
  return scriptedFetch((url) => (url === POST_URL ? response : undefined));
}

describe("ADR-001 dispatch consumer (queue path)", () => {
  it("R15: delivers a queued row with one metadata-correlated top-level post", async () => {
    const { database, d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);
    const deliveryId = "red-r15-happy-path";
    await seedQueuedRow(store, deliveryId, "alerts");
    const scripted = postMessageFetch(slackPostOk(POST_TS, ALERTS_CHANNEL));
    const recorded = recordedMessage(deliveryId, "primary");

    await processDispatchMessage(
      recorded.message,
      consumerDeps(store, scripted.fetch),
    );

    expect(scripted.calls).toHaveLength(1);
    const call = scripted.calls[0];
    expect(call?.url).toBe(POST_URL);
    expect(call?.method).toBe("POST");
    // §6.1: metadata.event_payload carries the delivery GUID (§6.6 permits
    // GUID + attempt, nothing else) — the resolver's match rule depends on
    // exactly this shape (R14 owns the round-trip).
    expect(call?.body).toMatchObject({
      channel: ALERTS_CHANNEL,
      metadata: {
        event_type: DISPATCH_METADATA_EVENT_TYPE,
        event_payload: { delivery_id: deliveryId },
      },
    });
    // R15: the dispatcher never sets thread_ts/reply_broadcast — the keys
    // must not appear ANYWHERE in the serialized request body.
    const serialized = JSON.stringify(call?.body);
    expect(serialized).not.toContain("thread_ts");
    expect(serialized).not.toContain("reply_broadcast");

    expect(outboxRow(database, deliveryId)).toMatchObject({
      state: "delivered",
      slack_message_ts: POST_TS,
      slack_channel_id: ALERTS_CHANNEL,
    });
    expect(recorded.ackCount()).toBe(1);
    expect(recorded.retryOptions).toHaveLength(0);
  });

  it("F1: a normalized SlackWorkflowPayload renders a readable message, never raw JSON", async () => {
    const { database, d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);
    const deliveryId = "f1-workflow-payload-render";
    // Copilot finding F1: real primary-mode payload_json is the normalized
    // SlackWorkflowPayload (src/domain.ts) — it carries NO `text` field, so
    // the old JSON.stringify fallback would post raw JSON to Slack.
    const payload = {
      source: "GitHub Actions",
      severity: "high",
      repository: "proj-x/exemplo-projeto-000",
      title: "CI: failure",
      details: "Workflow CI completed with conclusion failure.",
      actor: "octocat",
      branch: "main",
      url: "https://github.com/proj-x/exemplo-projeto-000/actions/runs/1",
      occurred_at: "2026-08-15T11:58:00.000Z",
      delivery_id: deliveryId,
      event: "workflow_run",
      action: "completed",
      destination: "alerts",
      relay_attempt: "1",
      relay_timestamp: "1786795080",
      relay_signature: "0".repeat(64),
    };
    expect(
      await store.insert({
        deliveryId,
        destination: "alerts",
        shadow: false,
        payloadJson: JSON.stringify(payload),
        now: DISPATCH_TEST_NOW,
      }),
    ).toBe(true);
    const scripted = postMessageFetch(slackPostOk(POST_TS, ALERTS_CHANNEL));
    const recorded = recordedMessage(deliveryId, "primary");

    await processDispatchMessage(
      recorded.message,
      consumerDeps(store, scripted.fetch),
    );

    expect(scripted.calls).toHaveLength(1);
    const call = scripted.calls[0];
    const text = String(call?.body?.["text"]);
    // Readable render of the normalized fields — never raw JSON.
    expect(text.startsWith("{")).toBe(false);
    expect(text).toContain("CI: failure");
    expect(text).toContain("proj-x/exemplo-projeto-000");
    expect(text).toContain(payload.url);
    expect(outboxRow(database, deliveryId)).toMatchObject({
      state: "delivered",
      slack_message_ts: POST_TS,
    });
    expect(recorded.ackCount()).toBe(1);
  });

  it("R1: duplicate queue delivery claim is a no-op", async () => {
    const { database, d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);
    const deliveryId = "red-r1-duplicate-claim";
    await seedQueuedRow(store, deliveryId, "alerts");
    const scripted = postMessageFetch(slackPostOk(POST_TS, ALERTS_CHANNEL));
    const deps = consumerDeps(store, scripted.fetch);

    const first = recordedMessage(deliveryId, "primary");
    await processDispatchMessage(first.message, deps);
    expect(scripted.calls).toHaveLength(1);
    expect(first.ackCount()).toBe(1);

    // At-least-once transport redelivers the same GUID: the claim CAS finds
    // no queued row, so the replay acks WITHOUT any Slack call and without
    // touching the row (failure matrix #11).
    const replay = recordedMessage(deliveryId, "primary");
    await processDispatchMessage(replay.message, deps);

    expect(scripted.calls).toHaveLength(1);
    expect(replay.ackCount()).toBe(1);
    expect(replay.retryOptions).toHaveLength(0);
    expect(outboxRow(database, deliveryId)).toMatchObject({
      state: "delivered",
      slack_message_ts: POST_TS,
      slack_channel_id: ALERTS_CHANNEL,
    });
  });

  it("R10 (consumer wiring): a MANUAL-list code parks the row in manual without retry", async () => {
    const { database, d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);
    const deliveryId = "red-r10-channel-not-found";
    await seedQueuedRow(store, deliveryId, "alerts");
    const scripted = postMessageFetch(slackPostError("channel_not_found"));
    const recorded = recordedMessage(deliveryId, "primary");

    await processDispatchMessage(
      recorded.message,
      consumerDeps(store, scripted.fetch),
    );

    expect(scripted.calls).toHaveLength(1);
    expect(outboxRow(database, deliveryId)).toMatchObject({
      state: "manual",
    });
    expect(
      String(outboxRow(database, deliveryId)?.["last_error"]),
    ).toContain("channel_not_found");
    expect(recorded.ackCount()).toBe(1);
    expect(recorded.retryOptions).toHaveLength(0);
  });

  it("R10 (consumer wiring): internal_error lands ambiguous and the queue never retries it", async () => {
    const { database, d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);
    const deliveryId = "red-r10-internal-error";
    await seedQueuedRow(store, deliveryId, "alerts");
    const scripted = postMessageFetch(slackPostError("internal_error"));
    const recorded = recordedMessage(deliveryId, "primary");

    await processDispatchMessage(
      recorded.message,
      consumerDeps(store, scripted.fetch),
    );

    // §6.2: effects possibly applied — the resolver owns the row now. The
    // QUEUE must ack, never retry: a queue retry would be an automatic
    // resend, which does not exist (I1).
    expect(scripted.calls).toHaveLength(1);
    expect(outboxRow(database, deliveryId)).toMatchObject({
      state: "ambiguous",
    });
    expect(recorded.ackCount()).toBe(1);
    expect(recorded.retryOptions).toHaveLength(0);
  });

  it("R10 (consumer wiring): HTTP 429 lands ambiguous with Retry-After recorded", async () => {
    const { database, d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);
    const deliveryId = "red-r10-rate-limited";
    await seedQueuedRow(store, deliveryId, "alerts");
    const scripted = postMessageFetch(slackRateLimited(7));
    const recorded = recordedMessage(deliveryId, "primary");

    await processDispatchMessage(
      recorded.message,
      consumerDeps(store, scripted.fetch),
    );

    // §6.2: 429 wins over the ok:false ratelimited body; the Retry-After
    // value is recorded (absolute ms) for the resolver's scheduling.
    expect(scripted.calls).toHaveLength(1);
    expect(outboxRow(database, deliveryId)).toMatchObject({
      state: "ambiguous",
      next_attempt_ms: DISPATCH_TEST_NOW + 7_000,
    });
    expect(recorded.ackCount()).toBe(1);
    expect(recorded.retryOptions).toHaveLength(0);
  });

  it("R12 (consumer precondition): chat.postMessage carries an AbortSignal for the 30 s hard timeout", async () => {
    const { database, d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);
    const deliveryId = "red-r12-abort-signal";
    await seedQueuedRow(store, deliveryId, "alerts");
    const scripted = postMessageFetch(slackPostOk(POST_TS, ALERTS_CHANNEL));
    const signals: (AbortSignal | null | undefined)[] = [];
    const wrappedFetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      signals.push(init?.signal);
      return scripted.fetch(input, init);
    }) as typeof fetch;
    const recorded = recordedMessage(deliveryId, "primary");

    await processDispatchMessage(
      recorded.message,
      consumerDeps(store, wrappedFetch),
    );

    // §6.1: hard client timeout 30 s (abort). The cooling-off floor (R12)
    // is sound only because every send is abortable client-side.
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(outboxRow(database, deliveryId)).toMatchObject({
      state: "delivered",
    });
  });

  it("R7: a shadow row in shadow mode is delivered with zero Slack egress", async () => {
    const { database, d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);
    const deliveryId = "red-r7-shadow-no-egress";
    await seedQueuedRow(store, deliveryId, "activity", true);
    // ANY fetch would throw unscripted_fetch — §9.A1 restates R7 as
    // "shadow never calls the Slack API".
    const scripted = scriptedFetch(() => undefined);
    const recorded = recordedMessage(deliveryId, "shadow");

    await processDispatchMessage(
      recorded.message,
      consumerDeps(store, scripted.fetch),
    );

    expect(scripted.calls).toHaveLength(0);
    expect(outboxRow(database, deliveryId)).toMatchObject({
      state: "delivered",
      shadow: 1,
      slack_message_ts: null,
      slack_channel_id: null,
    });
    expect(recorded.ackCount()).toBe(1);
    expect(recorded.retryOptions).toHaveLength(0);
    const delivered = auditRows(database, deliveryId).find(
      (entry) => entry["to_state"] === "delivered",
    );
    expect(delivered).toBeDefined();
    expect(String(delivered?.["evidence_json"])).toContain("shadow");
  });

  it("R20: mode off pauses egress and leaves the queued row untouched for re-enable", async () => {
    const { database, d1 } = dispatchDatabase();
    const store = new D1DispatchStore(d1);
    const deliveryId = "red-r20-mode-off";
    await seedQueuedRow(store, deliveryId, "alerts");
    const scripted = scriptedFetch(() => undefined);
    const recorded = recordedMessage(deliveryId, "off");

    await processDispatchMessage(
      recorded.message,
      consumerDeps(store, scripted.fetch),
    );

    // §6.8 regime B: egress pauses, nothing is stranded — the row stays
    // `queued` unchanged and the message is deferred (retry with a delay,
    // never acked) so re-enabling the mode re-enters the normal pipeline.
    expect(scripted.calls).toHaveLength(0);
    expect(outboxRow(database, deliveryId)).toMatchObject({
      state: "queued",
      attempt_count: 0,
      last_send_start_ms: null,
      lease_until_ms: null,
      updated_ms: DISPATCH_TEST_NOW,
    });
    expect(recorded.ackCount()).toBe(0);
    expect(recorded.retryOptions).toHaveLength(1);
    const options = recorded.retryOptions[0];
    expect(options?.delaySeconds ?? 0).toBeGreaterThan(0);
  });
});

describe("ADR-001 presence fence (R11)", () => {
  it("R11: any legacy-path row blocks cross-path acceptance in every mode", () => {
    // fenceDecision sees PRESENCE only: the store's legacyRowExists matches
    // rows in ANY legacy state, so each state below reports hasLegacyRow.
    for (const mode of MODES) {
      for (const legacyState of [
        "accepted_by_trigger",
        "sending",
        "ambiguous",
      ]) {
        expect(
          fenceDecision(mode, true, null),
          `mode=${mode} legacyState=${legacyState}`,
        ).toBe("blocked_other_path");
      }
    }
  });

  it("R11: a non-shadow outbox row routes to same-path duplicate handling in every mode", () => {
    for (const mode of MODES) {
      expect(
        fenceDecision(mode, false, { state: "ambiguous", shadow: false }),
        `mode=${mode}`,
      ).toBe("duplicate_same_path");
    }
  });

  it("R11: shadow outbox rows are excluded from the presence fence in every mode", () => {
    for (const mode of MODES) {
      for (const state of ["queued", "ambiguous", "delivered"] as const) {
        expect(
          fenceDecision(mode, false, { state, shadow: true }),
          `mode=${mode} state=${state}`,
        ).toBe("accept_new");
      }
    }
  });

  it("R11: a GUID absent from both paths is accepted as new in every mode", () => {
    for (const mode of MODES) {
      expect(fenceDecision(mode, false, null), `mode=${mode}`).toBe(
        "accept_new",
      );
    }
  });
});

describe("ADR-001 observe-only alarms (R5)", () => {
  const CLEAN_SNAPSHOT: ObserverSnapshot = {
    deadLetter: 0,
    manual: 0,
    oldestAmbiguousAgeMs: null,
    repairedDuplicates: 0,
  };

  function snapshot(overrides: Partial<ObserverSnapshot>): ObserverSnapshot {
    return { ...CLEAN_SNAPSHOT, ...overrides };
  }

  it("R5: the observer admits no store handle — pure snapshots in, alarms out", () => {
    // Type-level: the signature accepts plain data only, so a write path
    // cannot exist by construction (§6.7: observe-only).
    const pure: (
      current: ObserverSnapshot,
      previous: { repairedDuplicates: number } | null,
    ) => string[] = observerAlarms;
    // Runtime: frozen inputs (a mutation would throw) and a stable output.
    const current = Object.freeze(snapshot({ deadLetter: 1 }));
    const previous = Object.freeze({ repairedDuplicates: 0 });
    const first = pure(current, previous);
    const second = pure(current, previous);
    expect(second).toEqual(first);
  });

  it("R5: dead_letter presence raises dead_letter_present", () => {
    expect(
      observerAlarms(snapshot({ deadLetter: 3 }), { repairedDuplicates: 0 }),
    ).toEqual(["dead_letter_present"]);
  });

  it("R5: manual presence raises manual_present", () => {
    expect(
      observerAlarms(snapshot({ manual: 1 }), { repairedDuplicates: 0 }),
    ).toEqual(["manual_present"]);
  });

  it("R5: an ambiguous row older than 30 minutes raises ambiguous_stale", () => {
    expect(
      observerAlarms(
        snapshot({ oldestAmbiguousAgeMs: THIRTY_MINUTES_MS + 1 }),
        { repairedDuplicates: 0 },
      ),
    ).toEqual(["ambiguous_stale"]);
    // §6.7: "older than 30 min" — exactly 30 min does not alarm.
    expect(
      observerAlarms(snapshot({ oldestAmbiguousAgeMs: THIRTY_MINUTES_MS }), {
        repairedDuplicates: 0,
      }),
    ).toEqual([]);
  });

  it("R5: repaired-duplicate growth since the last observation raises repaired_duplicates_increased", () => {
    expect(
      observerAlarms(snapshot({ repairedDuplicates: 3 }), {
        repairedDuplicates: 2,
      }),
    ).toEqual(["repaired_duplicates_increased"]);
    expect(
      observerAlarms(snapshot({ repairedDuplicates: 3 }), {
        repairedDuplicates: 3,
      }),
    ).toEqual([]);
  });

  it("R5: a clean snapshot with an equal previous observation raises nothing", () => {
    expect(observerAlarms(CLEAN_SNAPSHOT, { repairedDuplicates: 0 })).toEqual(
      [],
    );
  });

  it("R5: every active condition reports its stable identifier", () => {
    const alarms = observerAlarms(
      {
        deadLetter: 1,
        manual: 2,
        oldestAmbiguousAgeMs: THIRTY_MINUTES_MS + 60_000,
        repairedDuplicates: 5,
      },
      { repairedDuplicates: 4 },
    );
    expect([...alarms].sort()).toEqual([
      "ambiguous_stale",
      "dead_letter_present",
      "manual_present",
      "repaired_duplicates_increased",
    ]);
  });
});

describe("ADR-001 dispatch mode (R20)", () => {
  it("R20: parseDispatchMode round-trips the three modes and fails safe to off", () => {
    expect(parseDispatchMode("off")).toBe("off");
    expect(parseDispatchMode("shadow")).toBe("shadow");
    expect(parseDispatchMode("primary")).toBe("primary");
    // Fail-safe: anything unrecognized degrades to off (§6.8 regime B —
    // ingress keeps persisting, egress pauses, nothing is stranded).
    expect(parseDispatchMode("")).toBe("off");
    expect(parseDispatchMode(undefined)).toBe("off");
    expect(parseDispatchMode("PRIMARY")).toBe("off");
    expect(parseDispatchMode(3)).toBe("off");
  });

  it("R20: the presence fence evaluates identically under mode off", () => {
    // §6.8: the fence applies "in every DISPATCH_MODE" — off included.
    expect(fenceDecision("off", true, null)).toBe("blocked_other_path");
    expect(fenceDecision("off", false, null)).toBe("accept_new");
    expect(
      fenceDecision("off", false, { state: "ambiguous", shadow: false }),
    ).toBe("duplicate_same_path");
  });
});
