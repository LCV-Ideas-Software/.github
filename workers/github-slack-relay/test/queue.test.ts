import { describe, expect, it, vi } from "vitest";

import {
  processDeadLetterMessage,
  processPrimaryMessage,
  runScheduledRecovery,
} from "../src/index";
import type { SlackWorkflowPayload } from "../src/domain";
import { signSlackRelayPayload } from "../src/security";
import {
  fakeMessage,
  FakeQueue,
  makeEnv,
  MemoryDeliveryStore,
  TEST_RELAY_SIGNING_SECRET,
  TEST_SLACK_URL,
} from "./helpers";

const NOW = Date.parse("2026-08-03T12:00:00.000Z");

function successResponse(): Response {
  return Response.json({ ok: true });
}

describe("Slack queue delivery", () => {
  it("defers a primary message before protocol activation without crossing a boundary", async () => {
    const store = new MemoryDeliveryStore();
    (
      store as MemoryDeliveryStore & {
        slackDeliveryProtocolActive: boolean;
      }
    ).slackDeliveryProtocolActive = false;
    const queue = new FakeQueue();
    const deliveryId = "protocol-window-primary";
    store.seed(deliveryId, "queued", NOW, { attemptCount: 4 });
    const { message, ack, retry } = fakeMessage(deliveryId);
    const fetchMock = vi.fn<typeof fetch>();

    await processPrimaryMessage(message, makeEnv(queue), {
      store,
      now: () => NOW,
      fetch: fetchMock,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(store.deliveries.get(deliveryId)).toMatchObject({
      status: "queued",
      attemptCount: 4,
      lastError: null,
    });
  });

  it("defers a DLQ message before protocol activation without creating debt", async () => {
    const store = new MemoryDeliveryStore();
    (
      store as MemoryDeliveryStore & {
        slackDeliveryProtocolActive: boolean;
      }
    ).slackDeliveryProtocolActive = false;
    const queue = new FakeQueue();
    const deliveryId = "protocol-window-dlq";
    store.seed(deliveryId, "queued", NOW, { attemptCount: 4 });
    const { message, ack, retry } = fakeMessage(deliveryId);

    await processDeadLetterMessage(message, makeEnv(queue), {
      store,
      now: () => NOW,
    });

    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(store.deliveries.get(deliveryId)).toMatchObject({
      status: "queued",
      attemptCount: 4,
      lastError: null,
    });
  });

  it("acks the Queue but keeps Slack trigger acceptance nonterminal", async () => {
    const store = new MemoryDeliveryStore();
    const queue = new FakeQueue();
    const deliveryId = "00000000-0000-4000-8000-000000000030";
    store.seed(deliveryId, "queued", NOW);
    const { message, ack, retry } = fakeMessage(deliveryId);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(successResponse());

    await processPrimaryMessage(message, makeEnv(queue), {
      store,
      now: () => NOW,
      fetch: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(TEST_SLACK_URL);
    const requestInit = fetchMock.mock.calls[0]?.[1];
    expect(requestInit?.redirect).toBe("manual");
    const sentPayload = JSON.parse(
      String(requestInit?.body),
    ) as SlackWorkflowPayload;
    expect(sentPayload.delivery_id).toBe(deliveryId);
    expect(
      Object.values(sentPayload).every((value) => typeof value === "string"),
    ).toBe(true);
    expect(sentPayload.destination).toBe("alerts");
    expect(sentPayload.relay_timestamp).toBe(String(Math.floor(NOW / 1_000)));
    expect(sentPayload.relay_signature).toMatch(/^[0-9a-f]{64}$/u);
    expect(sentPayload.relay_signature).toBe(
      await signSlackRelayPayload(sentPayload, TEST_RELAY_SIGNING_SECRET),
    );
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(store.deliveries.get(deliveryId)?.status).toBe(
      "accepted_by_trigger",
    );
    expect(store.deliveries.get(deliveryId)?.deliveredAt).toBeNull();
    expect(store.deliveries.get(deliveryId)?.slackMessageTs).toBeNull();
  });

  it("fails closed on a 2xx response without exact trigger confirmation", async () => {
    const store = new MemoryDeliveryStore();
    const queue = new FakeQueue();
    const deliveryId = "00000000-0000-4000-8000-000000000031";
    store.seed(deliveryId, "queued", NOW);
    const { message, ack, retry } = fakeMessage(deliveryId);

    await processPrimaryMessage(message, makeEnv(queue), {
      store,
      now: () => NOW,
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ ok: false })),
    });

    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(store.deliveries.get(deliveryId)?.status).toBe("manual_review");
    expect(store.deliveries.get(deliveryId)?.lastError).toBe(
      "slack_trigger_success_confirmation_ambiguous",
    );
  });

  it("honors Retry-After and extends the global cooldown on HTTP 429", async () => {
    const store = new MemoryDeliveryStore();
    const queue = new FakeQueue();
    const deliveryId = "00000000-0000-4000-8000-000000000032";
    store.seed(deliveryId, "queued", NOW);
    const { message, ack, retry } = fakeMessage(deliveryId);
    const operations: string[] = [];
    const body = new ReadableStream({
      cancel() {
        operations.push("cancel_body");
      },
    });
    const originalExtendSlackCooldown = store.extendSlackCooldown.bind(store);
    const originalRecordFailure = store.recordFailure.bind(store);
    store.extendSlackCooldown = vi.fn(async (until: number) => {
      operations.push("extend_cooldown");
      await originalExtendSlackCooldown(until);
    });
    store.recordFailure = vi.fn(
      async (
        failedDeliveryId: string,
        failedAt: number,
        nextAttemptAt: number,
        reason: string,
      ) => {
        operations.push("record_failure");
        await originalRecordFailure(
          failedDeliveryId,
          failedAt,
          nextAttemptAt,
          reason,
        );
      },
    );
    retry.mockImplementation(() => {
      operations.push("retry_message");
    });

    await processPrimaryMessage(message, makeEnv(queue), {
      store,
      now: () => NOW,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(body, {
          status: 429,
          headers: { "Retry-After": "17" },
        }),
      ),
    });

    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 17 });
    expect(store.nextSlackAt).toBeGreaterThanOrEqual(NOW + 17_000);
    expect(store.deliveries.get(deliveryId)?.status).toBe("pending");
    expect(store.deliveries.get(deliveryId)?.lastError).toBe("slack_http_429");
    expect(operations).toEqual([
      "cancel_body",
      "extend_cooldown",
      "record_failure",
      "retry_message",
    ]);
  });

  it("keeps a 5xx trigger result for manual review even if body cleanup rejects", async () => {
    const store = new MemoryDeliveryStore();
    const queue = new FakeQueue();
    const deliveryId = "00000000-0000-4000-8000-000000000044";
    store.seed(deliveryId, "queued", NOW);
    const { message, ack, retry } = fakeMessage(deliveryId);
    const cancel = vi.fn().mockRejectedValue(new Error("cancel failed"));

    await processPrimaryMessage(message, makeEnv(queue), {
      store,
      now: () => NOW,
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(new ReadableStream({ cancel }), { status: 503 }),
        ),
    });

    expect(cancel).toHaveBeenCalledOnce();
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(store.deliveries.get(deliveryId)?.status).toBe("manual_review");
    expect(store.deliveries.get(deliveryId)?.lastError).toBe(
      "slack_trigger_http_503_ambiguous",
    );
  });

  it("treats redirects as a controlled Slack failure without following them", async () => {
    const store = new MemoryDeliveryStore();
    const queue = new FakeQueue();
    const deliveryId = "00000000-0000-4000-8000-000000000042";
    store.seed(deliveryId, "queued", NOW);
    const { message, ack, retry } = fakeMessage(deliveryId);

    await processPrimaryMessage(message, makeEnv(queue), {
      store,
      now: () => NOW,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: { Location: "https://example.invalid/redirect" },
        }),
      ),
    });

    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledOnce();
    expect(store.deliveries.get(deliveryId)?.lastError).toBe("slack_http_302");
  });

  it("calls the default global fetch with the workerd-compatible receiver", async () => {
    const store = new MemoryDeliveryStore();
    const queue = new FakeQueue();
    const deliveryId = "00000000-0000-4000-8000-000000000043";
    store.seed(deliveryId, "queued", NOW);
    const { message, ack } = fakeMessage(deliveryId);
    const originalFetch = globalThis.fetch;
    const receiverAwareFetch = vi.fn(function (
      this: unknown,
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> {
      if (this !== globalThis) {
        return Promise.reject(new TypeError("Illegal invocation"));
      }
      return Promise.resolve(successResponse());
    });
    globalThis.fetch = receiverAwareFetch as typeof fetch;

    try {
      await processPrimaryMessage(message, makeEnv(queue), {
        store,
        now: () => NOW,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(receiverAwareFetch).toHaveBeenCalledOnce();
    expect(ack).toHaveBeenCalledOnce();
    expect(store.deliveries.get(deliveryId)?.status).toBe(
      "accepted_by_trigger",
    );
  });

  it("waits for the strict 6.1 second slot without consuming a queue retry", async () => {
    const store = new MemoryDeliveryStore();
    const queue = new FakeQueue();
    const firstId = "00000000-0000-4000-8000-000000000033";
    const secondId = "00000000-0000-4000-8000-000000000034";
    store.seed(firstId, "queued", NOW);
    store.seed(secondId, "queued", NOW);
    let currentTime = NOW;
    const sleep = vi.fn(async (milliseconds: number) => {
      currentTime += milliseconds;
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => successResponse());
    const first = fakeMessage(firstId);
    const second = fakeMessage(secondId);

    await processPrimaryMessage(first.message, makeEnv(queue), {
      store,
      now: () => currentTime,
      sleep,
      fetch: fetchMock,
    });
    await processPrimaryMessage(second.message, makeEnv(queue), {
      store,
      now: () => currentTime,
      sleep,
      fetch: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(6_100);
    expect(second.retry).not.toHaveBeenCalled();
    expect(second.ack).toHaveBeenCalledOnce();
    expect(currentTime).toBe(NOW + 6_100);
  });

  it("gives a queued alert the global slot before queued activity", async () => {
    const store = new MemoryDeliveryStore();
    const queue = new FakeQueue();
    const alertId = "00000000-0000-4000-8000-000000000038";
    const activityId = "00000000-0000-4000-8000-000000000039";
    store.seed(alertId, "queued", NOW, { destination: "alerts" });
    store.seed(activityId, "queued", NOW, { destination: "activity" });
    store.deliveries.get(activityId)!.payload.destination = "activity";
    let currentTime = NOW;
    const destinations: string[] = [];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_url, init) => {
        const payload = JSON.parse(String(init?.body)) as SlackWorkflowPayload;
        destinations.push(payload.destination);
        return successResponse();
      });
    const alert = fakeMessage(alertId);
    const activity = fakeMessage(activityId);
    let alertProcessed = false;
    const env = makeEnv(queue);
    const sleep = vi.fn(async (milliseconds: number) => {
      currentTime += milliseconds;
      if (!alertProcessed) {
        alertProcessed = true;
        await processPrimaryMessage(alert.message, env, {
          store,
          now: () => currentTime,
          fetch: fetchMock,
        });
      }
    });

    await processPrimaryMessage(activity.message, env, {
      store,
      now: () => currentTime,
      sleep,
      fetch: fetchMock,
    });

    expect(destinations).toEqual(["alerts", "activity"]);
    expect(alert.retry).not.toHaveBeenCalled();
    expect(activity.retry).not.toHaveBeenCalled();
    expect(alert.ack).toHaveBeenCalledOnce();
    expect(activity.ack).toHaveBeenCalledOnce();
    expect(store.deliveries.get(alertId)?.status).toBe("accepted_by_trigger");
    expect(store.deliveries.get(activityId)?.status).toBe(
      "accepted_by_trigger",
    );
  });

  it("rejects Slack URLs containing a port, query, fragment, or userinfo", async () => {
    for (const invalidUrl of [
      "https://hooks.slack.com:444/triggers/a/b/c",
      "https://hooks.slack.com/triggers/a/b/c?token=leak",
      "https://hooks.slack.com/triggers/a/b/c#fragment",
      "https://user@hooks.slack.com/triggers/a/b/c",
    ]) {
      const store = new MemoryDeliveryStore();
      const queue = new FakeQueue();
      const deliveryId = `invalid-url-${Math.random().toString(16).slice(2)}`;
      store.seed(deliveryId, "queued", NOW);
      const { message, ack, retry } = fakeMessage(deliveryId);
      const fetchMock = vi.fn<typeof fetch>();

      await processPrimaryMessage(
        message,
        makeEnv(queue, { slackUrl: invalidUrl }),
        {
          store,
          now: () => NOW,
          fetch: fetchMock,
        },
      );

      expect(fetchMock).not.toHaveBeenCalled();
      expect(ack).not.toHaveBeenCalled();
      expect(retry).toHaveBeenCalledOnce();
      expect(store.deliveries.get(deliveryId)?.lastError).toBe(
        "slack_webhook_configuration_invalid",
      );
    }
  });

  it("rejects a relay signing secret shorter than 32 bytes before any Slack call", async () => {
    const store = new MemoryDeliveryStore();
    const queue = new FakeQueue();
    const deliveryId = "00000000-0000-4000-8000-000000000041";
    store.seed(deliveryId, "queued", NOW);
    const { message, ack, retry } = fakeMessage(deliveryId);
    const fetchMock = vi.fn<typeof fetch>();

    await processPrimaryMessage(
      message,
      makeEnv(queue, { relaySigningSecret: "short" }),
      { store, now: () => NOW, fetch: fetchMock },
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledOnce();
    expect(store.deliveries.get(deliveryId)?.lastError).toBe(
      "slack_webhook_configuration_invalid",
    );
  });

  it("defers an early duplicate queue delivery until next_attempt_at without a D1 attempt", async () => {
    const store = new MemoryDeliveryStore();
    const queue = new FakeQueue();
    const deliveryId = "00000000-0000-4000-8000-000000000042";
    store.seed(deliveryId, "pending", NOW, {
      attemptCount: 4,
      nextAttemptAt: NOW + 17_000,
    });
    const early = fakeMessage(deliveryId);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(successResponse());

    await processPrimaryMessage(early.message, makeEnv(queue), {
      store,
      now: () => NOW,
      fetch: fetchMock,
    });

    expect(early.ack).not.toHaveBeenCalled();
    expect(early.retry).toHaveBeenCalledWith({ delaySeconds: 17 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.deliveries.get(deliveryId)?.attemptCount).toBe(4);

    const due = fakeMessage(deliveryId);
    await processPrimaryMessage(due.message, makeEnv(queue), {
      store,
      now: () => NOW + 17_000,
      fetch: fetchMock,
    });

    expect(due.ack).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(store.deliveries.get(deliveryId)?.attemptCount).toBe(5);
    expect(store.deliveries.get(deliveryId)?.status).toBe(
      "accepted_by_trigger",
    );
  });

  it("never resends after an ambiguous trigger network failure", async () => {
    const store = new MemoryDeliveryStore();
    const queue = new FakeQueue();
    const deliveryId = "00000000-0000-4000-8000-000000000035";
    store.seed(deliveryId, "queued", NOW);
    const { message, ack, retry } = fakeMessage(deliveryId);

    await processPrimaryMessage(message, makeEnv(queue), {
      store,
      now: () => NOW,
      fetch: vi
        .fn<typeof fetch>()
        .mockRejectedValue(new Error("network unavailable")),
    });

    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(store.deliveries.get(deliveryId)?.status).toBe("manual_review");
    expect(store.deliveries.get(deliveryId)?.lastError).toBe(
      "slack_trigger_request_outcome_ambiguous",
    );
  });

  it("preserves a failed delivery in D1 state before acknowledging the DLQ message", async () => {
    const store = new MemoryDeliveryStore();
    const queue = new FakeQueue();
    const deliveryId = "00000000-0000-4000-8000-000000000036";
    store.seed(deliveryId, "pending", NOW, { attemptCount: 6 });
    const { message, ack, retry } = fakeMessage(deliveryId);

    await processDeadLetterMessage(message, makeEnv(queue), {
      store,
      now: () => NOW,
    });

    expect(store.deliveries.get(deliveryId)?.status).toBe("dead_letter");
    expect(store.deliveries.get(deliveryId)?.nextAttemptAt).toBeGreaterThan(
      NOW,
    );
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  it("never turns an ambiguous sending state into a retryable dead letter", async () => {
    const store = new MemoryDeliveryStore();
    const queue = new FakeQueue();
    const deliveryId = "ambiguous-sending-dlq";
    store.seed(deliveryId, "sending", NOW);
    const { message, ack, retry } = fakeMessage(deliveryId);

    await processDeadLetterMessage(message, makeEnv(queue), {
      store,
      now: () => NOW,
    });

    expect(store.deliveries.get(deliveryId)).toMatchObject({
      status: "manual_review",
      lastError: "dead_letter_slack_trigger_attempt_ambiguous",
    });
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });
});

describe("scheduled recovery and retention", () => {
  it("leaves durable state untouched while the delivery protocol is inactive", async () => {
    const store = new MemoryDeliveryStore();
    store.slackDeliveryProtocolActive = false;
    const queue = new FakeQueue();
    const deliveryId = "inactive-protocol-stale-sending";
    store.seed(deliveryId, "sending", NOW - 20 * 60 * 1_000, {
      attemptCount: 4,
      updatedAt: NOW - 20 * 60 * 1_000,
    });

    await expect(
      runScheduledRecovery(makeEnv(queue), {
        store,
        now: () => NOW,
      }),
    ).resolves.toEqual({
      purged: 0,
      recovered: 0,
      enqueueFailures: 0,
    });
    expect(queue.sent).toEqual([]);
    expect(store.deliveries.get(deliveryId)).toMatchObject({
      status: "sending",
      attemptCount: 4,
      lastError: null,
    });
  });

  it("recovers a stale queued record whose queue message was lost", async () => {
    const store = new MemoryDeliveryStore();
    const queue = new FakeQueue();
    const deliveryId = "00000000-0000-4000-8000-000000000037";
    store.seed(deliveryId, "queued", NOW - 20 * 60 * 1_000, {
      nextAttemptAt: NOW + 24 * 60 * 60 * 1_000,
      updatedAt: NOW - 20 * 60 * 1_000,
    });

    const result = await runScheduledRecovery(makeEnv(queue), {
      store,
      now: () => NOW,
    });

    expect(result.recovered).toBe(1);
    expect(queue.sent).toEqual([{ deliveryId }]);
    expect(store.deliveries.get(deliveryId)?.status).toBe("queued");
  });

  it("moves a stale sending record to manual review without another trigger POST", async () => {
    const store = new MemoryDeliveryStore();
    const queue = new FakeQueue();
    const deliveryId = "stale-sending-ambiguous";
    store.seed(deliveryId, "sending", NOW - 20 * 60 * 1_000, {
      updatedAt: NOW - 20 * 60 * 1_000,
    });

    const result = await runScheduledRecovery(makeEnv(queue), {
      store,
      now: () => NOW,
    });

    expect(result.recovered).toBe(0);
    expect(queue.sent).toHaveLength(0);
    expect(store.deliveries.get(deliveryId)).toMatchObject({
      status: "manual_review",
      lastError: "stale_slack_trigger_attempt_ambiguous",
    });
  });

  it("purges only receipt-confirmed Slack deliveries older than 30 days", async () => {
    const store = new MemoryDeliveryStore();
    const queue = new FakeQueue();
    const day = 24 * 60 * 60 * 1_000;
    store.seed("old-delivered", "delivered", NOW - 31 * day, {
      deliveredAt: NOW - 31 * day,
    });
    store.seed("recent-delivered", "delivered", NOW - 29 * day, {
      deliveredAt: NOW - 29 * day,
    });
    store.seed("old-trigger-accepted", "accepted_by_trigger", NOW - 60 * day, {
      legacyUnverified: true,
    });
    store.seed("old-pending", "pending", NOW - 60 * day, {
      nextAttemptAt: NOW + day,
    });
    store.seed("old-dead-letter", "dead_letter", NOW - 60 * day, {
      nextAttemptAt: NOW + day,
    });
    store.seed("old-manual-review", "manual_review", NOW - 60 * day);

    const result = await runScheduledRecovery(makeEnv(queue), {
      store,
      now: () => NOW,
    });

    expect(result.purged).toBe(1);
    expect(store.deliveries.has("old-delivered")).toBe(false);
    expect(store.deliveries.has("recent-delivered")).toBe(true);
    expect(store.deliveries.has("old-trigger-accepted")).toBe(true);
    expect(store.deliveries.has("old-pending")).toBe(true);
    expect(store.deliveries.has("old-dead-letter")).toBe(true);
    expect(store.deliveries.has("old-manual-review")).toBe(true);
  });
});
