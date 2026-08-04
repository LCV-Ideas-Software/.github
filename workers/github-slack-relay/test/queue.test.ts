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
  it("acks and marks accepted only after HTTP 2xx with JSON ok:true", async () => {
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
    expect(store.deliveries.get(deliveryId)?.status).toBe("accepted_by_slack");
  });

  it("does not ack a 2xx response without the exact ok:true confirmation", async () => {
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

    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledOnce();
    expect(store.deliveries.get(deliveryId)?.status).toBe("pending");
    expect(store.deliveries.get(deliveryId)?.lastError).toBe(
      "slack_success_confirmation_invalid",
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
    const originalExtendSlackCooldown =
      store.extendSlackCooldown.bind(store);
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

  it("continues retry handling when canceling a non-2xx body rejects", async () => {
    const store = new MemoryDeliveryStore();
    const queue = new FakeQueue();
    const deliveryId = "00000000-0000-4000-8000-000000000044";
    store.seed(deliveryId, "queued", NOW);
    const { message, ack, retry } = fakeMessage(deliveryId);
    const cancel = vi.fn().mockRejectedValue(new Error("cancel failed"));

    await processPrimaryMessage(message, makeEnv(queue), {
      store,
      now: () => NOW,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(new ReadableStream({ cancel }), { status: 503 }),
      ),
    });

    expect(cancel).toHaveBeenCalledOnce();
    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledOnce();
    expect(store.deliveries.get(deliveryId)?.status).toBe("pending");
    expect(store.deliveries.get(deliveryId)?.lastError).toBe("slack_http_503");
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
    expect(store.deliveries.get(deliveryId)?.status).toBe("accepted_by_slack");
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
    expect(store.deliveries.get(alertId)?.status).toBe("accepted_by_slack");
    expect(store.deliveries.get(activityId)?.status).toBe("accepted_by_slack");
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
    expect(store.deliveries.get(deliveryId)?.status).toBe("accepted_by_slack");
  });

  it("retries a network failure without acknowledging it", async () => {
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

    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledOnce();
    expect(store.deliveries.get(deliveryId)?.status).toBe("pending");
    expect(store.deliveries.get(deliveryId)?.lastError).toBe(
      "slack_request_failed",
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
});

describe("scheduled recovery and retention", () => {
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

  it("purges only Slack-accepted payloads older than 30 days", async () => {
    const store = new MemoryDeliveryStore();
    const queue = new FakeQueue();
    const day = 24 * 60 * 60 * 1_000;
    store.seed("old-accepted", "accepted_by_slack", NOW - 31 * day, {
      acceptedAt: NOW - 31 * day,
    });
    store.seed("recent-accepted", "accepted_by_slack", NOW - 29 * day, {
      acceptedAt: NOW - 29 * day,
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
    expect(store.deliveries.has("old-accepted")).toBe(false);
    expect(store.deliveries.has("recent-accepted")).toBe(true);
    expect(store.deliveries.has("old-pending")).toBe(true);
    expect(store.deliveries.has("old-dead-letter")).toBe(true);
    expect(store.deliveries.has("old-manual-review")).toBe(true);
  });
});
