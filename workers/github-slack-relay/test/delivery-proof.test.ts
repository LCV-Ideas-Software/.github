import { describe, expect, it } from "vitest";

import { handleFetch } from "../src/index";
import {
  signSlackCheckpointRequest,
  signSlackProgress,
  signSlackReconciliation,
  signSlackReconciliationV2,
  type SignedSlackProgress,
  type SignedSlackReconciliation,
} from "../src/security";
import {
  FakeQueue,
  makeEnv,
  MemoryDeliveryStore,
  TEST_RELAY_SIGNING_SECRET,
  TEST_RELAY_SIGNING_SECRET_NEXT,
} from "./helpers";
import type {
  SlackProgressInput,
  SlackProgressResult,
  SlackReconciliationInput,
  SlackReconciliationReportResult,
} from "../src/store";

const NOW = Date.parse("2026-08-03T12:00:00.000Z");
const RECONCILIATION_RETRY_DELAY_MS = 20 * 60 * 1_000;
const NOW_SECONDS = String(Math.floor(NOW / 1_000));
const TRACE_REPORT_IDENTITY = Object.freeze({
  relay_attempt: "1",
  send_execution_id: null,
  slack_channel_id: null,
  slack_message_ts: null,
});
const PRE_SEND_TRACE_REPORT_IDENTITY = Object.freeze({
  relay_attempt: "1",
  send_execution_id: "FxDeliveryProofTrace1",
  slack_channel_id: null,
  slack_message_ts: null,
});
const PRE_SEND_TRACE_STORE_IDENTITY = Object.freeze({
  attemptCount: 1,
  sendExecutionId: "FxDeliveryProofTrace1",
  destination: null,
  slackChannelId: null,
  messageTs: null,
});
class ProgressResponseLossStore extends MemoryDeliveryStore {
  #loseFirstResponse = true;

  override async recordSlackProgress(
    input: SlackProgressInput,
  ): Promise<SlackProgressResult> {
    const result = await super.recordSlackProgress(input);
    if (this.#loseFirstResponse) {
      this.#loseFirstResponse = false;
      throw new Error("simulated_d1_response_loss_after_progress_cas");
    }
    return result;
  }
}

class ReconciliationResponseLossStore extends MemoryDeliveryStore {
  #loseFirstResponse = true;

  override async reconcileSlackReport(
    input: SlackReconciliationInput,
  ): Promise<SlackReconciliationReportResult> {
    const result = await super.reconcileSlackReport(input);
    if (this.#loseFirstResponse) {
      this.#loseFirstResponse = false;
      throw new Error("simulated_d1_response_loss_after_report_commit");
    }
    return result;
  }
}

class ReconciliationPersistenceFailureStore extends MemoryDeliveryStore {
  override reconcileSlackReport(): Promise<SlackReconciliationReportResult> {
    return Promise.reject(new Error("delivery_not_found"));
  }
}

class ReconciliationFinalizeResponseLossStore extends MemoryDeliveryStore {
  #loseFirstResponse = true;

  override async reconcileSlackReport(
    input: SlackReconciliationInput,
  ): Promise<SlackReconciliationReportResult> {
    const result = await super.reconcileSlackReport(input);
    if (this.#loseFirstResponse) {
      this.#loseFirstResponse = false;
      throw new Error("simulated_d1_response_loss_after_report_commit");
    }
    return result;
  }
}

class ReconciliationReportBudgetStore extends MemoryDeliveryStore {
  reconciliationReportBoundaries = 0;

  override async reconcileSlackReport(
    input: SlackReconciliationInput,
  ): Promise<SlackReconciliationReportResult> {
    this.reconciliationReportBoundaries += 1;
    if (this.reconciliationReportBoundaries > 1) {
      throw new Error("simulated_reconciliation_report_budget_exhausted");
    }
    return await super.reconcileSlackReport(input);
  }
}

async function progressRequest(
  overrides: Partial<Omit<SignedSlackProgress, "receipt_signature">> = {},
  secret = TEST_RELAY_SIGNING_SECRET_NEXT,
): Promise<Request> {
  const unsigned: Omit<SignedSlackProgress, "receipt_signature"> = {
    delivery_id: "receipt-delivery-1",
    destination: "alerts" as const,
    phase: "delivered" as const,
    message_ts: "1785758400.000001",
    relay_attempt: "1",
    function_execution_id: "FxDeliveryProof1",
    receipt_timestamp: NOW_SECONDS,
    ...overrides,
  };
  return new Request("https://relay.example/slack/progress", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...unsigned,
      receipt_signature: await signSlackProgress(unsigned, secret),
    }),
  });
}

async function reconciliationRequest(
  report: Omit<SignedSlackReconciliation, "report_signature">,
  secret = TEST_RELAY_SIGNING_SECRET_NEXT,
): Promise<Request> {
  return new Request("https://relay.example/slack/reconciliation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...report,
      report_signature: await signSlackReconciliation(report, secret),
    }),
  });
}

async function reconciliationRequestV2(
  report: Omit<SignedSlackReconciliation, "report_signature">,
  secret = TEST_RELAY_SIGNING_SECRET_NEXT,
): Promise<Request> {
  const legacyTraces = report.traces.map(
    ({ slack_channel_id: _channel, slack_message_ts: _messageTs, ...trace }) =>
      trace,
  );
  return new Request("https://relay.example/slack/reconciliation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      checkpoint_us: report.checkpoint_us,
      report_timestamp: report.report_timestamp,
      traces: legacyTraces,
      report_signature: await signSlackReconciliationV2(report, secret),
    }),
  });
}

describe("authenticated Slack delivery proof", () => {
  it.each(["GET", "POST"])(
    "does not expose the retired protocol activation endpoint over %s",
    async (method) => {
      const response = await handleFetch(
        new Request("https://relay.example/slack/protocol/activate", {
          method,
          ...(method === "POST"
            ? {
                headers: { "Content-Type": "application/json" },
                body: "{}",
              }
            : {}),
        }),
        {} as Env,
      );

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    },
  );

  it("matches the cross-runtime HMAC golden vectors", async () => {
    await expect(
      signSlackProgress(
        {
          delivery_id: "receipt-delivery-1",
          destination: "alerts",
          phase: "delivered",
          message_ts: "1785758400.000001",
          relay_attempt: "1",
          function_execution_id: "FxDeliveryProof1",
          receipt_timestamp: "1785758400",
        },
        TEST_RELAY_SIGNING_SECRET,
      ),
    ).resolves.toBe(
      "9cf3766466fa858cd43666850015dec2a7150c3bbf376c51e040d58580164d96",
    );
    await expect(
      signSlackReconciliation(
        {
          checkpoint_us: 1_785_758_400_000_000,
          report_timestamp: "1785758400",
          traces: [
            {
              trace_id: "TrSafeRetry1",
              delivery_id: "trace-safe-retry",
              outcome: "error",
              ...PRE_SEND_TRACE_REPORT_IDENTITY,
              send_boundary_reached: false,
              pre_send_failure_proven: true,
              started_at_us: 1_785_758_399_999_990,
              completed_at_us: 1_785_758_400_000_000,
            },
          ],
        },
        TEST_RELAY_SIGNING_SECRET,
      ),
    ).resolves.toBe(
      "113d8d41a4da52c9c28f26a5e1c7f042f13fa1225ec41488b4be8486f413374e",
    );
  });

  it("records delivery_id and message_ts idempotently without a state downgrade", async () => {
    const store = new MemoryDeliveryStore();
    const queue = new FakeQueue();
    store.seed("receipt-delivery-1", "send_started", NOW, {
      attemptCount: 1,
      nextAttemptAt: NOW + 20 * 60 * 1_000,
      slackSendExecutionId: "FxDeliveryProofSend1",
      triggerAcceptedAt: NOW,
    });
    const env = makeEnv(queue);

    const first = await handleFetch(await progressRequest(), env, {
      store,
      now: () => NOW,
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, duplicate: false });
    expect(store.deliveries.get("receipt-delivery-1")).toMatchObject({
      status: "delivered",
      slackMessageTs: "1785758400.000001",
      slackTraceId: null,
      deliveredAt: NOW,
    });

    const replay = await handleFetch(await progressRequest(), env, {
      store,
      now: () => NOW,
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ok: true, duplicate: true });

    await store.markAcceptedByTrigger(
      "receipt-delivery-1",
      NOW + 1,
      NOW + 1_000,
    );
    expect(store.deliveries.get("receipt-delivery-1")?.status).toBe(
      "delivered",
    );
    const checkpointUs =
      NOW * 1_000 + RECONCILIATION_RETRY_DELAY_MS * 1_000 + 2_000;
    await expect(
      store.advanceSlackActivityCheckpoint(checkpointUs),
    ).resolves.toBe(NOW * 1_000);
    await expect(store.purgeDeliveredBefore(NOW + 1)).resolves.toBe(0);
    expect(store.deliveries.has("receipt-delivery-1")).toBe(true);
  });

  it("keeps a terminal trace linked when its authenticated receipt arrives late", async () => {
    const store = new MemoryDeliveryStore();
    const deliveryId = "receipt-delivery-1";
    const traceId = "TrMemoryLateReceipt1";
    store.seed(deliveryId, "send_started", NOW, {
      attemptCount: 1,
      nextAttemptAt: NOW + RECONCILIATION_RETRY_DELAY_MS,
      slackSendExecutionId: "FxDeliveryProofSend1",
      triggerAcceptedAt: NOW,
    });
    await expect(
      store.recordSlackTrace(
        {
          traceId,
          deliveryId,
          outcome: "error",
          attemptCount: 1,
          sendExecutionId: "FxDeliveryProofSend1",
          destination: null,
          slackChannelId: null,
          messageTs: null,
          sendBoundaryReached: true,
          preSendFailureProven: false,
          startedAtUs: NOW * 1_000,
          completedAtUs: NOW * 1_000 + 1,
        },
        NOW + 1,
      ),
    ).resolves.toBe("changed");

    const response = await handleFetch(
      await progressRequest(),
      makeEnv(new FakeQueue()),
      { store, now: () => NOW + 2 },
    );
    expect(response.status).toBe(200);
    expect(store.deliveries.get(deliveryId)).toMatchObject({
      status: "delivered",
      slackMessageTs: "1785758400.000001",
      slackTraceId: traceId,
      slackSendExecutionId: "FxDeliveryProofSend1",
      lastError: null,
    });

    const checkpointUs =
      NOW * 1_000 + RECONCILIATION_RETRY_DELAY_MS * 1_000 + 2_000;
    await expect(
      store.advanceSlackActivityCheckpoint(checkpointUs),
    ).resolves.toBe(checkpointUs);
    await expect(store.purgeDeliveredBefore(NOW + 3)).resolves.toBe(1);
    expect(store.deliveries.has(deliveryId)).toBe(false);
    expect(store.slackTraces.has(traceId)).toBe(false);
  });

  it("does not retain a pre-send-only trace after a late authenticated receipt", async () => {
    const store = new MemoryDeliveryStore();
    const deliveryId = "receipt-delivery-1";
    const traceId = "TrMemoryLateReceiptPreSend1";
    store.seed(deliveryId, "send_started", NOW, {
      attemptCount: 1,
      nextAttemptAt: NOW + RECONCILIATION_RETRY_DELAY_MS,
      slackSendExecutionId: "FxDeliveryProofSend1",
      triggerAcceptedAt: NOW,
    });
    await expect(
      store.recordSlackTrace(
        {
          traceId,
          deliveryId,
          outcome: "error",
          attemptCount: 1,
          sendExecutionId: "FxDeliveryProofSend1",
          destination: null,
          slackChannelId: null,
          messageTs: null,
          sendBoundaryReached: false,
          preSendFailureProven: true,
          startedAtUs: NOW * 1_000,
          completedAtUs: NOW * 1_000 + 1,
        },
        NOW + 1,
      ),
    ).resolves.toBe("changed");

    const response = await handleFetch(
      await progressRequest(),
      makeEnv(new FakeQueue()),
      { store, now: () => NOW + 2 },
    );
    expect(response.status).toBe(200);
    expect(store.deliveries.get(deliveryId)).toMatchObject({
      status: "delivered",
      slackMessageTs: "1785758400.000001",
      slackTraceId: null,
      slackSendExecutionId: "FxDeliveryProofSend1",
      lastError: null,
    });

    const checkpointUs =
      NOW * 1_000 + RECONCILIATION_RETRY_DELAY_MS * 1_000 + 2_000;
    await expect(
      store.advanceSlackActivityCheckpoint(checkpointUs),
    ).resolves.toBe((NOW + 2) * 1_000);
    await expect(store.purgeDeliveredBefore(NOW + 3)).resolves.toBe(0);
    expect(store.deliveries.has(deliveryId)).toBe(true);
  });

  it("rejects delivery-owned message evidence before persisting a memory trace", async () => {
    const store = new MemoryDeliveryStore();
    const messageTs = "1785758400.000002";
    store.seed("memory-delivery-message-owner", "send_started", NOW, {
      attemptCount: 1,
      slackSendExecutionId: "FxMemoryDeliveryMessageOwner1",
    });
    await store.recordSlackProgress({
      deliveryId: "memory-delivery-message-owner",
      destination: "alerts",
      phase: "delivered",
      messageTs,
      attemptCount: 1,
      functionExecutionId: "FxMemoryDeliveryMessageReceipt1",
      now: NOW + 1,
      reconcileAt: NOW + RECONCILIATION_RETRY_DELAY_MS,
    });
    store.seed("memory-delivery-message-contender", "send_started", NOW + 2, {
      attemptCount: 1,
      slackSendExecutionId: "FxMemoryDeliveryMessageContender1",
    });

    await expect(
      store.recordSlackTrace(
        {
          traceId: "TrMemoryDeliveryMessageContender1",
          deliveryId: "memory-delivery-message-contender",
          outcome: "error",
          attemptCount: 1,
          sendExecutionId: "FxMemoryDeliveryMessageContender1",
          destination: "alerts",
          slackChannelId: "C0BMUK793NV",
          messageTs,
          sendBoundaryReached: true,
          preSendFailureProven: false,
          startedAtUs: NOW * 1_000 + 2,
          completedAtUs: NOW * 1_000 + 3,
        },
        NOW + 3,
      ),
    ).rejects.toThrow("slack_message_timestamp_conflict");
    expect(store.slackTraces.has("TrMemoryDeliveryMessageContender1")).toBe(
      false,
    );
    expect(
      store.deliveries.get("memory-delivery-message-contender"),
    ).toMatchObject({
      status: "send_started",
      slackMessageTs: null,
      slackTraceId: null,
    });
  });

  it("retries a receipt whose D1 CAS response was lost without another delivery mutation", async () => {
    const store = new ProgressResponseLossStore();
    const env = makeEnv(new FakeQueue());
    store.seed("receipt-delivery-1", "send_started", NOW, {
      attemptCount: 1,
      slackSendExecutionId: "FxDeliveryProofSend1",
    });

    const lost = await handleFetch(await progressRequest(), env, {
      store,
      now: () => NOW,
    });
    expect(lost.status).toBe(503);
    expect(await lost.json()).toEqual({ error: "persistence_unavailable" });
    expect(store.deliveries.get("receipt-delivery-1")).toMatchObject({
      status: "delivered",
      slackMessageTs: "1785758400.000001",
    });

    const confirmation = await handleFetch(await progressRequest(), env, {
      store,
      now: () => NOW + 1,
    });
    expect(confirmation.status).toBe(200);
    expect(await confirmation.json()).toEqual({ ok: true, duplicate: true });
  });

  it("lets an authenticated live workflow heal an ambiguous trigger response before SendMessage", async () => {
    const store = new MemoryDeliveryStore();
    const queue = new FakeQueue();
    store.seed("receipt-delivery-1", "manual_review", NOW, {
      attemptCount: 1,
      lastError: "slack_trigger_request_outcome_ambiguous",
    });

    const response = await handleFetch(
      await progressRequest({ phase: "send_started", message_ts: "" }),
      makeEnv(queue),
      { store, now: () => NOW },
    );

    expect(response.status).toBe(200);
    expect(store.deliveries.get("receipt-delivery-1")).toMatchObject({
      status: "send_started",
      lastError: null,
      nextAttemptAt: NOW + 20 * 60 * 1_000,
    });
  });

  it("does not let a workflow receipt clear an unrelated manual review", async () => {
    const store = new MemoryDeliveryStore();
    const queue = new FakeQueue();
    store.seed("receipt-delivery-1", "manual_review", NOW, {
      attemptCount: 1,
      lastError: "maximum_delivery_attempts_reached",
    });

    const response = await handleFetch(
      await progressRequest({ phase: "send_started", message_ts: "" }),
      makeEnv(queue),
      { store, now: () => NOW },
    );

    expect(response.status).toBe(409);
    expect(store.deliveries.get("receipt-delivery-1")).toMatchObject({
      status: "manual_review",
      lastError: "maximum_delivery_attempts_reached",
    });
  });

  it("rejects forgery, stale receipts, destination confusion, and reused message_ts", async () => {
    const store = new MemoryDeliveryStore();
    const queue = new FakeQueue();
    const env = makeEnv(queue);
    store.seed("receipt-delivery-1", "send_started", NOW, {
      attemptCount: 1,
      slackSendExecutionId: "FxDeliveryProofSend1",
    });

    const forged = await handleFetch(
      await progressRequest({}, "forged-secret-that-is-at-least-32-bytes"),
      env,
      { store, now: () => NOW },
    );
    expect(forged.status).toBe(401);

    const stale = await handleFetch(
      await progressRequest({
        receipt_timestamp: String(Math.floor(NOW / 1_000) - 301),
      }),
      env,
      { store, now: () => NOW },
    );
    expect(stale.status).toBe(400);

    const wrongDestination = await handleFetch(
      await progressRequest({ destination: "activity" }),
      env,
      { store, now: () => NOW },
    );
    expect(wrongDestination.status).toBe(409);

    const valid = await handleFetch(await progressRequest(), env, {
      store,
      now: () => NOW,
    });
    expect(valid.status).toBe(200);
    store.seed("receipt-delivery-2", "send_started", NOW, {
      attemptCount: 1,
      slackSendExecutionId: "FxDeliveryProofSend2",
    });
    const reused = await handleFetch(
      await progressRequest({ delivery_id: "receipt-delivery-2" }),
      env,
      { store, now: () => NOW },
    );
    expect(reused.status).toBe(409);
  });

  it("accepts a receipt authenticated by the staged NEXT key", async () => {
    const store = new MemoryDeliveryStore();
    const queue = new FakeQueue();
    const nextSecret = "vitest-next-relay-signing-secret-32";
    store.seed("receipt-delivery-1", "send_started", NOW, {
      attemptCount: 1,
      slackSendExecutionId: "FxDeliveryProofSend1",
    });

    const response = await handleFetch(
      await progressRequest({}, nextSecret),
      makeEnv(queue, { relaySigningSecretNext: nextSecret }),
      { store, now: () => NOW },
    );

    expect(response.status).toBe(200);
    expect(store.deliveries.get("receipt-delivery-1")?.status).toBe(
      "delivered",
    );
  });

  it("rejects a receipt authenticated only by inactive current", async () => {
    const store = new MemoryDeliveryStore();
    store.seed("receipt-delivery-1", "accepted_by_trigger", NOW);
    const response = await handleFetch(
      await progressRequest({}, TEST_RELAY_SIGNING_SECRET),
      makeEnv(new FakeQueue()),
      { store, now: () => NOW },
    );
    expect(response.status).toBe(401);
    expect(store.deliveries.get("receipt-delivery-1")?.status).toBe(
      "accepted_by_trigger",
    );
  });
});

describe("fail-closed Slack trace reconciliation", () => {
  it("reconciles the maximum 25 traces through one report persistence boundary", async () => {
    const store = new ReconciliationReportBudgetStore();
    const traces = Array.from({ length: 25 }, (_, index) => {
      const suffix = String(index + 1).padStart(2, "0");
      const deliveryId = `trace-report-budget-${suffix}`;
      store.seed(deliveryId, "accepted_by_trigger", NOW, { attemptCount: 1 });
      return {
        trace_id: `TrReportBudget${suffix}`,
        delivery_id: deliveryId,
        outcome: "pending" as const,
        relay_attempt: "1",
        send_execution_id: null,
        slack_channel_id: null,
        slack_message_ts: null,
        send_boundary_reached: false,
        pre_send_failure_proven: false,
        started_at_us: NOW * 1_000 - index,
        completed_at_us: null,
      };
    });

    const response = await handleFetch(
      await reconciliationRequest({
        checkpoint_us: NOW * 1_000,
        report_timestamp: NOW_SECONDS,
        traces,
      }),
      makeEnv(new FakeQueue()),
      { store, now: () => NOW },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, traces: 25 });
    expect(store.slackTraces.size).toBe(25);
    expect(store.slackReconciliationReports.size).toBe(1);
    expect(store.reconciliationReportBoundaries).toBe(1);
  });

  it.each([
    ["pre-send error first", false],
    ["pending competitor first", true],
  ])(
    "never authorizes a duplicate send when the %s ordering contains a competing trace",
    async (_ordering, pendingFirst) => {
      const store = new MemoryDeliveryStore();
      const deliveryId = `trace-report-order-${pendingFirst ? "pending" : "error"}`;
      const safeErrorTrace = {
        traceId: `TrReportOrderError${pendingFirst ? "PendingFirst" : "ErrorFirst"}`,
        deliveryId,
        outcome: "error" as const,
        attemptCount: 1,
        sendExecutionId: "FxReportOrderPreSend1",
        slackChannelId: null,
        messageTs: null,
        sendBoundaryReached: false,
        preSendFailureProven: true,
        startedAtUs: NOW * 1_000 - 2,
        completedAtUs: NOW * 1_000 - 1,
      };
      const pendingTrace = {
        traceId: `TrReportOrderPending${pendingFirst ? "PendingFirst" : "ErrorFirst"}`,
        deliveryId,
        outcome: "pending" as const,
        attemptCount: 1,
        sendExecutionId: null,
        slackChannelId: null,
        messageTs: null,
        sendBoundaryReached: false,
        preSendFailureProven: false,
        startedAtUs: NOW * 1_000,
        completedAtUs: null,
      };
      store.seed(deliveryId, "accepted_by_trigger", NOW, { attemptCount: 1 });

      await store.reconcileSlackReport({
        reportId: (pendingFirst ? "b" : "a").repeat(64),
        traces: pendingFirst
          ? [pendingTrace, safeErrorTrace]
          : [safeErrorTrace, pendingTrace],
        checkpointUs: NOW * 1_000,
        now: NOW + 1,
      });

      expect(store.deliveries.get(deliveryId)).toMatchObject({
        status: "accepted_by_trigger",
        attemptCount: 1,
        slackTraceId: null,
        slackSendExecutionId: null,
        lastError: null,
      });
    },
  );

  it.each([
    ["owned execution first", false],
    ["unowned execution first", true],
  ])(
    "classifies competing terminal pre-send errors before applying the %s ordering",
    async (_ordering, unownedFirst) => {
      const store = new MemoryDeliveryStore();
      const deliveryId = `trace-terminal-order-${unownedFirst ? "unowned" : "owned"}`;
      const ownedTraceId = `TrTerminalOwned${unownedFirst ? "UnownedFirst" : "OwnedFirst"}`;
      const unownedTraceId = `TrTerminalUnowned${unownedFirst ? "UnownedFirst" : "OwnedFirst"}`;
      const ownedTrace = {
        traceId: ownedTraceId,
        deliveryId,
        outcome: "error" as const,
        attemptCount: 1,
        sendExecutionId: "FxTerminalOwnedA1",
        slackChannelId: null,
        messageTs: null,
        sendBoundaryReached: false,
        preSendFailureProven: true,
        startedAtUs: NOW * 1_000 - 2,
        completedAtUs: NOW * 1_000 - 1,
      };
      const unownedTrace = {
        ...ownedTrace,
        traceId: unownedTraceId,
        sendExecutionId: "FxTerminalUnownedB1",
        startedAtUs: NOW * 1_000,
        completedAtUs: NOW * 1_000 + 1,
      };
      store.seed(deliveryId, "accepted_by_trigger", NOW, {
        attemptCount: 1,
        slackSendExecutionId: ownedTrace.sendExecutionId,
      });

      await store.reconcileSlackReport({
        reportId: (unownedFirst ? "d" : "c").repeat(64),
        traces: unownedFirst
          ? [unownedTrace, ownedTrace]
          : [ownedTrace, unownedTrace],
        checkpointUs: NOW * 1_000,
        now: NOW + 1,
      });

      expect(store.deliveries.get(deliveryId)).toMatchObject({
        status: "accepted_by_trigger",
        attemptCount: 1,
        slackTraceId: null,
        slackSendExecutionId: ownedTrace.sendExecutionId,
        lastError: null,
      });
      expect(store.slackTraces.get(ownedTraceId)?.applied).toBe(false);
      expect(store.slackTraces.get(unownedTraceId)?.applied).toBe(true);
    },
  );

  it("accepts at most 25 traces in both reconciliation protocol parsers", async () => {
    const store = new MemoryDeliveryStore();
    const env = makeEnv(new FakeQueue());
    const traces = Array.from({ length: 26 }, (_, index) => {
      const suffix = String(index + 1).padStart(2, "0");
      const deliveryId = `trace-report-limit-${suffix}`;
      store.seed(deliveryId, "accepted_by_trigger", NOW, { attemptCount: 1 });
      return {
        trace_id: `TrReportLimit${suffix}`,
        delivery_id: deliveryId,
        outcome: "pending" as const,
        relay_attempt: "1",
        send_execution_id: null,
        slack_channel_id: null,
        slack_message_ts: null,
        send_boundary_reached: false,
        pre_send_failure_proven: false,
        started_at_us: NOW * 1_000 - index,
        completed_at_us: null,
      };
    });
    const accepted = {
      checkpoint_us: NOW * 1_000,
      report_timestamp: NOW_SECONDS,
      traces: traces.slice(0, 25),
    };
    const acceptedResponse = await handleFetch(
      await reconciliationRequest(accepted),
      env,
      { store, now: () => NOW },
    );
    expect(acceptedResponse.status).toBe(200);
    expect(await acceptedResponse.json()).toMatchObject({ traces: 25 });
    expect(store.slackTraces.size).toBe(25);

    const oversized = { ...accepted, traces };
    for (const request of [
      await reconciliationRequest(oversized),
      await reconciliationRequestV2(oversized),
    ]) {
      const response = await handleFetch(request, env, {
        store,
        now: () => NOW,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_request" });
    }
    expect(store.slackTraces.size).toBe(25);
  });

  it("derives the owner from the authenticated send execution and records live Slack message evidence", async () => {
    const store = new MemoryDeliveryStore();
    const queue = new FakeQueue();
    const env = makeEnv(queue);
    store.seed("trace-live-shape", "send_started", NOW, {
      attemptCount: 1,
      destination: "alerts",
      slackSendExecutionId: "Fx0BPVFG8ARF",
      nextAttemptAt: NOW + 20 * 60 * 1_000,
    });
    const report = {
      checkpoint_us: NOW * 1_000,
      report_timestamp: NOW_SECONDS,
      traces: [
        {
          trace_id: "Tr0BPPV04R45",
          delivery_id: null,
          outcome: "error" as const,
          relay_attempt: null,
          send_execution_id: "Fx0BPVFG8ARF",
          send_boundary_reached: true,
          pre_send_failure_proven: false,
          slack_channel_id: "C0BMUK793NV",
          slack_message_ts: "1786555894.853909",
          started_at_us: NOW * 1_000 - 10,
          completed_at_us: NOW * 1_000,
        },
      ],
    };

    const response = await handleFetch(
      await reconciliationRequest(
        report as unknown as Omit<
          SignedSlackReconciliation,
          "report_signature"
        >,
      ),
      env,
      { store, now: () => NOW },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      traces: 1,
      changed_error_traces: 1,
    });
    expect(store.deliveries.get("trace-live-shape")).toMatchObject({
      status: "delivered",
      attemptCount: 1,
      slackMessageTs: "1786555894.853909",
      slackTraceId: "Tr0BPPV04R45",
      slackSendExecutionId: "Fx0BPVFG8ARF",
      lastError: null,
    });
    expect(store.slackActivityCheckpoint).toBe(NOW * 1_000);
  });

  it("rejects an explicit pre-send identity whose execution belongs to another delivery", async () => {
    const store = new MemoryDeliveryStore();
    const queue = new FakeQueue();
    const env = makeEnv(queue);
    const sendExecutionId = "FxUniqueOwnerA1";
    store.seed("trace-owner-a", "send_started", NOW, {
      attemptCount: 1,
      destination: "alerts",
      slackSendExecutionId: sendExecutionId,
    });
    store.seed("trace-owner-b", "accepted_by_trigger", NOW, {
      attemptCount: 1,
      destination: "alerts",
      slackSendExecutionId: null,
    });
    const report = {
      checkpoint_us: NOW * 1_000,
      report_timestamp: NOW_SECONDS,
      traces: [
        {
          trace_id: "TrCrossOwnerPreSend1",
          delivery_id: "trace-owner-b",
          outcome: "error" as const,
          relay_attempt: "1",
          send_execution_id: sendExecutionId,
          slack_channel_id: null,
          slack_message_ts: null,
          send_boundary_reached: false,
          pre_send_failure_proven: true,
          started_at_us: NOW * 1_000 - 10,
          completed_at_us: NOW * 1_000,
        },
      ],
    };

    const response = await handleFetch(
      await reconciliationRequest(report),
      env,
      { store, now: () => NOW },
    );

    expect(response.status).toBe(409);
    expect(store.deliveries.get("trace-owner-a")).toMatchObject({
      status: "send_started",
      slackSendExecutionId: sendExecutionId,
    });
    expect(store.deliveries.get("trace-owner-b")).toMatchObject({
      status: "accepted_by_trigger",
      slackTraceId: null,
      slackSendExecutionId: null,
    });
    expect(store.slackActivityCheckpoint).toBe(0);
  });

  it("rejects a second memory trace that reuses an owned send execution", async () => {
    const store = new MemoryDeliveryStore();
    const deliveryId = "trace-memory-reused-send-execution";
    const sendExecutionId = "FxMemoryUniqueTraceOwner1";
    const firstTraceId = "TrMemoryOwnedSendExecution1";
    store.seed(deliveryId, "send_started", NOW, {
      attemptCount: 1,
      slackSendExecutionId: sendExecutionId,
    });

    await expect(
      store.recordSlackTrace(
        {
          traceId: firstTraceId,
          deliveryId,
          outcome: "error",
          attemptCount: 1,
          sendExecutionId,
          destination: null,
          slackChannelId: null,
          messageTs: null,
          sendBoundaryReached: false,
          preSendFailureProven: true,
          startedAtUs: NOW * 1_000,
          completedAtUs: NOW * 1_000 + 1,
        },
        NOW + 1,
      ),
    ).resolves.toBe("changed");

    await expect(
      store.recordSlackTrace(
        {
          traceId: "TrMemoryReusedSendExecution2",
          deliveryId,
          outcome: "error",
          attemptCount: 1,
          sendExecutionId,
          destination: "alerts",
          slackChannelId: "C0BMUK793NV",
          messageTs: "1785758400.000998",
          sendBoundaryReached: true,
          preSendFailureProven: false,
          startedAtUs: NOW * 1_000,
          completedAtUs: NOW * 1_000 + 2,
        },
        NOW + 2,
      ),
    ).rejects.toThrow("slack_trace_send_execution_owner_conflict");

    expect([...store.slackTraces.keys()]).toEqual([firstTraceId]);
    expect(store.deliveries.get(deliveryId)).toMatchObject({
      status: "manual_review",
      attemptCount: 1,
      slackMessageTs: null,
      slackTraceId: firstTraceId,
      slackSendExecutionId: sendExecutionId,
      lastError: "slack_workflow_failed_after_send_boundary",
    });
  });

  it("rejects a memory trace that reuses message evidence owned only by another trace", async () => {
    const store = new MemoryDeliveryStore();
    const messageTs = "1785758400.000999";
    const staleDeliveryId = "trace-memory-stale-message-owner";
    const activeDeliveryId = "trace-memory-message-reuse";
    store.seed(staleDeliveryId, "accepted_by_trigger", NOW, {
      attemptCount: 1,
    });

    await expect(
      store.recordSlackTrace(
        {
          traceId: "TrMemoryStaleMessageOwner1",
          deliveryId: staleDeliveryId,
          outcome: "error",
          attemptCount: 1,
          sendExecutionId: "FxMemoryStaleMessageOwner1",
          destination: "alerts",
          slackChannelId: "C0BMUK793NV",
          messageTs,
          sendBoundaryReached: true,
          preSendFailureProven: false,
          startedAtUs: NOW * 1_000,
          completedAtUs: NOW * 1_000 + 1,
        },
        NOW + 1,
      ),
    ).rejects.toThrow("slack_trace_owner_conflict");
    expect(store.deliveries.get(staleDeliveryId)?.slackMessageTs).toBeNull();

    store.seed(activeDeliveryId, "send_started", NOW + 2, {
      attemptCount: 1,
      slackSendExecutionId: "FxMemoryMessageReuse2",
    });
    await expect(
      store.recordSlackTrace(
        {
          traceId: "TrMemoryMessageReuse2",
          deliveryId: activeDeliveryId,
          outcome: "error",
          attemptCount: 1,
          sendExecutionId: "FxMemoryMessageReuse2",
          destination: "alerts",
          slackChannelId: "C0BMUK793NV",
          messageTs,
          sendBoundaryReached: true,
          preSendFailureProven: false,
          startedAtUs: NOW * 1_000 + 2,
          completedAtUs: NOW * 1_000 + 3,
        },
        NOW + 3,
      ),
    ).rejects.toThrow("slack_trace_message_owner_conflict");
    expect(store.deliveries.get(activeDeliveryId)).toMatchObject({
      status: "send_started",
      slackMessageTs: null,
      slackTraceId: null,
    });
  });

  it("retries only a complete failure proven to precede the send boundary", async () => {
    const store = new MemoryDeliveryStore();
    const queue = new FakeQueue();
    const env = makeEnv(queue);
    store.seed("trace-safe-retry", "accepted_by_trigger", NOW, {
      attemptCount: 1,
      nextAttemptAt: NOW + 20 * 60 * 1_000,
    });
    const report = {
      checkpoint_us: NOW * 1_000,
      report_timestamp: NOW_SECONDS,
      traces: [
        {
          trace_id: "TrSafeRetry1",
          delivery_id: "trace-safe-retry",
          outcome: "error" as const,
          ...PRE_SEND_TRACE_REPORT_IDENTITY,
          send_boundary_reached: false,
          pre_send_failure_proven: true,
          started_at_us: NOW * 1_000 - 10,
          completed_at_us: NOW * 1_000,
        },
      ],
    };

    const response = await handleFetch(
      await reconciliationRequest(report),
      env,
      { store, now: () => NOW },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ changed_error_traces: 1 });
    expect(store.deliveries.get("trace-safe-retry")).toMatchObject({
      status: "pending",
      lastError: "slack_workflow_failed_before_send_boundary",
      slackTraceId: "TrSafeRetry1",
    });
    expect(store.slackActivityCheckpoint).toBe(NOW * 1_000);

    await store.markQueued("trace-safe-retry", NOW + 1);
    const replay = await handleFetch(await reconciliationRequest(report), env, {
      store,
      now: () => NOW + 1,
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ changed_error_traces: 1 });
    expect(store.deliveries.get("trace-safe-retry")?.status).toBe("queued");

    const laterReport = {
      ...report,
      report_timestamp: String(Number.parseInt(NOW_SECONDS, 10) + 1),
    };
    const overlap = await handleFetch(
      await reconciliationRequest(laterReport),
      env,
      { store, now: () => NOW + 1_000 },
    );
    expect(overlap.status).toBe(200);
    expect(await overlap.json()).toMatchObject({ changed_error_traces: 0 });
  });

  it("never lets a stale pre-send claim override a persisted send boundary", async () => {
    const store = new MemoryDeliveryStore();
    const deliveryId = "trace-persisted-boundary-dominates";
    const sendExecutionId = "FxPersistedBoundaryDominates1";
    store.seed(deliveryId, "send_started", NOW, {
      attemptCount: 1,
      slackSendExecutionId: sendExecutionId,
    });

    await expect(
      store.recordSlackTrace(
        {
          traceId: "TrPersistedBoundaryDominates1",
          deliveryId,
          outcome: "error",
          attemptCount: 1,
          sendExecutionId,
          destination: null,
          slackChannelId: null,
          messageTs: null,
          sendBoundaryReached: false,
          preSendFailureProven: true,
          startedAtUs: NOW * 1_000,
          completedAtUs: NOW * 1_000 + 1,
        },
        NOW + 1,
      ),
    ).resolves.toBe("changed");

    expect(store.deliveries.get(deliveryId)).toMatchObject({
      status: "manual_review",
      attemptCount: 1,
      slackSendExecutionId: sendExecutionId,
      lastError: "slack_workflow_failed_after_send_boundary",
    });
  });

  it("rejects an authenticated v2 report after the v3 Worker is live", async () => {
    const store = new MemoryDeliveryStore();
    const deliveryId = "trace-v2-persisted-boundary";
    const sendExecutionId = "FxV2PersistedBoundary1";
    store.seed(deliveryId, "send_started", NOW, {
      attemptCount: 1,
      slackSendExecutionId: sendExecutionId,
    });
    const report = {
      checkpoint_us: NOW * 1_000,
      report_timestamp: NOW_SECONDS,
      traces: [
        {
          trace_id: "TrV2PersistedBoundary1",
          delivery_id: deliveryId,
          outcome: "error" as const,
          relay_attempt: "1",
          send_execution_id: sendExecutionId,
          slack_channel_id: null,
          slack_message_ts: null,
          send_boundary_reached: false,
          pre_send_failure_proven: true,
          started_at_us: NOW * 1_000,
          completed_at_us: NOW * 1_000 + 1,
        },
      ],
    };

    const response = await handleFetch(
      await reconciliationRequestV2(report),
      makeEnv(new FakeQueue()),
      { store, now: () => NOW },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "reconciliation_upgrade_required",
    });
    expect(store.deliveries.get(deliveryId)).toMatchObject({
      status: "send_started",
      attemptCount: 1,
      slackSendExecutionId: sendExecutionId,
      lastError: null,
    });
    await expect(store.claimForSlack(deliveryId, NOW + 1)).resolves.toBeNull();
  });

  it("rejects an empty authenticated v2 report without advancing its checkpoint", async () => {
    const store = new MemoryDeliveryStore();
    store.slackActivityCheckpoint = NOW * 1_000 - 10;
    const response = await handleFetch(
      await reconciliationRequestV2({
        checkpoint_us: NOW * 1_000,
        report_timestamp: NOW_SECONDS,
        traces: [],
      }),
      makeEnv(new FakeQueue()),
      { store, now: () => NOW },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "reconciliation_upgrade_required",
    });
    expect(store.slackActivityCheckpoint).toBe(NOW * 1_000 - 10);
  });

  it("never resends when SendMessage may have run or success lacks a receipt", async () => {
    const store = new MemoryDeliveryStore();
    const queue = new FakeQueue();
    const env = makeEnv(queue);
    store.seed("trace-ambiguous", "send_started", NOW, {
      attemptCount: 1,
      slackSendExecutionId: PRE_SEND_TRACE_REPORT_IDENTITY.send_execution_id,
    });
    store.seed("trace-incomplete", "accepted_by_trigger", NOW, {
      attemptCount: 1,
    });
    store.seed("trace-no-receipt", "accepted_by_trigger", NOW, {
      attemptCount: 1,
    });
    const report = {
      checkpoint_us: NOW * 1_000,
      report_timestamp: NOW_SECONDS,
      traces: [
        {
          trace_id: "TrAmbiguous1",
          delivery_id: "trace-ambiguous",
          outcome: "error" as const,
          ...PRE_SEND_TRACE_REPORT_IDENTITY,
          send_boundary_reached: true,
          pre_send_failure_proven: false,
          started_at_us: NOW * 1_000 - 20,
          completed_at_us: NOW * 1_000 - 10,
        },
        {
          trace_id: "TrIncomplete1",
          delivery_id: "trace-incomplete",
          outcome: "error" as const,
          ...TRACE_REPORT_IDENTITY,
          send_boundary_reached: false,
          pre_send_failure_proven: false,
          started_at_us: NOW * 1_000 - 15,
          completed_at_us: NOW * 1_000 - 14,
        },
        {
          trace_id: "TrNoReceipt1",
          delivery_id: "trace-no-receipt",
          outcome: "success" as const,
          ...TRACE_REPORT_IDENTITY,
          send_boundary_reached: true,
          pre_send_failure_proven: false,
          started_at_us: NOW * 1_000 - 9,
          completed_at_us: NOW * 1_000,
        },
      ],
    };

    const response = await handleFetch(
      await reconciliationRequest(report),
      env,
      { store, now: () => NOW },
    );

    expect(response.status).toBe(200);
    expect(store.deliveries.get("trace-ambiguous")?.status).toBe(
      "manual_review",
    );
    expect(store.deliveries.get("trace-incomplete")).toMatchObject({
      status: "manual_review",
      lastError: "slack_workflow_failed_without_pre_send_proof",
    });
    expect(store.deliveries.get("trace-no-receipt")?.status).toBe(
      "manual_review",
    );
  });

  it("clears a trigger-network ambiguity only with a complete pre-send error trace", async () => {
    const store = new MemoryDeliveryStore();
    const queue = new FakeQueue();
    const env = makeEnv(queue);
    store.seed("trace-network-ambiguous", "manual_review", NOW, {
      attemptCount: 1,
      lastError: "slack_trigger_request_outcome_ambiguous",
    });
    const report = {
      checkpoint_us: NOW * 1_000,
      report_timestamp: NOW_SECONDS,
      traces: [
        {
          trace_id: "TrNetworkSafe1",
          delivery_id: "trace-network-ambiguous",
          outcome: "error" as const,
          ...PRE_SEND_TRACE_REPORT_IDENTITY,
          send_boundary_reached: false,
          pre_send_failure_proven: true,
          started_at_us: NOW * 1_000 - 1,
          completed_at_us: NOW * 1_000,
        },
      ],
    };

    const response = await handleFetch(
      await reconciliationRequest(report),
      env,
      { store, now: () => NOW },
    );

    expect(response.status).toBe(200);
    expect(store.deliveries.get("trace-network-ambiguous")).toMatchObject({
      status: "pending",
      lastError: "slack_workflow_failed_before_send_boundary",
    });
  });

  it("merges late pre-send proof for the same applied trace in the memory store", async () => {
    const store = new MemoryDeliveryStore();
    const queue = new FakeQueue();
    const env = makeEnv(queue);
    const deliveryId = "trace-late-memory-proof";
    store.seed(deliveryId, "accepted_by_trigger", NOW, { attemptCount: 1 });
    const baseTrace = {
      trace_id: "TrMemoryLateProof1",
      delivery_id: deliveryId,
      outcome: "error" as const,
      ...TRACE_REPORT_IDENTITY,
      send_boundary_reached: false,
      started_at_us: NOW * 1_000 - 1,
      completed_at_us: NOW * 1_000,
    };

    const first = await handleFetch(
      await reconciliationRequest({
        checkpoint_us: NOW * 1_000,
        report_timestamp: NOW_SECONDS,
        traces: [{ ...baseTrace, pre_send_failure_proven: false }],
      }),
      env,
      { store, now: () => NOW },
    );
    expect(first.status).toBe(200);
    expect(store.deliveries.get(deliveryId)).toMatchObject({
      status: "manual_review",
      lastError: "slack_workflow_failed_without_pre_send_proof",
      slackTraceId: baseTrace.trace_id,
    });

    const second = await handleFetch(
      await reconciliationRequest({
        checkpoint_us: NOW * 1_000,
        report_timestamp: NOW_SECONDS,
        traces: [
          {
            ...baseTrace,
            ...PRE_SEND_TRACE_REPORT_IDENTITY,
            pre_send_failure_proven: true,
          },
        ],
      }),
      env,
      { store, now: () => NOW + 1 },
    );
    expect(second.status).toBe(200);
    expect(store.deliveries.get(deliveryId)).toMatchObject({
      status: "pending",
      lastError: "slack_workflow_failed_before_send_boundary",
      slackTraceId: baseTrace.trace_id,
    });
  });

  it("does not quarantine a later memory attempt when an earlier trace gains a boundary", async () => {
    const store = new MemoryDeliveryStore();
    const deliveryId = "trace-late-memory-boundary-old-attempt";
    store.seed(deliveryId, "accepted_by_trigger", NOW, { attemptCount: 1 });
    const trace = {
      traceId: "TrMemoryLateBoundary1",
      deliveryId,
      outcome: "error" as const,
      ...PRE_SEND_TRACE_STORE_IDENTITY,
      sendBoundaryReached: false,
      preSendFailureProven: true,
      startedAtUs: NOW * 1_000 - 1,
      completedAtUs: NOW * 1_000,
    };

    await expect(store.recordSlackTrace(trace, NOW)).resolves.toBe("changed");
    const secondAttemptAt = NOW + RECONCILIATION_RETRY_DELAY_MS;
    await store.markQueued(deliveryId, NOW + 1);
    await store.claimForSlack(deliveryId, secondAttemptAt);
    await store.markAcceptedByTrigger(
      deliveryId,
      secondAttemptAt,
      secondAttemptAt + 60_000,
    );
    await expect(
      store.recordSlackTrace(
        {
          ...trace,
          sendBoundaryReached: true,
          preSendFailureProven: false,
        },
        secondAttemptAt + 1,
      ),
    ).resolves.toBe("duplicate");

    expect(store.deliveries.get(deliveryId)).toMatchObject({
      status: "accepted_by_trigger",
      attemptCount: 2,
      lastError: null,
    });
  });

  it("reapplies a memory pre-send trace after the trigger leaves sending", async () => {
    const store = new MemoryDeliveryStore();
    const deliveryId = "trace-memory-sending-before-acceptance";
    store.seed(deliveryId, "sending", NOW, { attemptCount: 1 });
    const trace = {
      traceId: "TrMemorySendingPreSend1",
      deliveryId,
      outcome: "error" as const,
      ...PRE_SEND_TRACE_STORE_IDENTITY,
      sendBoundaryReached: false,
      preSendFailureProven: true,
      startedAtUs: NOW * 1_000 - 1,
      completedAtUs: NOW * 1_000,
    };

    await store.recordSlackTrace(trace, NOW);
    expect(store.slackTraces.get(trace.traceId)?.applied).toBe(false);
    await store.markAcceptedByTrigger(deliveryId, NOW + 1, NOW + 60_000);
    await store.recordSlackTrace(trace, NOW + 2);

    expect(store.deliveries.get(deliveryId)).toMatchObject({
      status: "pending",
      attemptCount: 1,
      slackTraceId: trace.traceId,
      lastError: "slack_workflow_failed_before_send_boundary",
    });
    expect(store.slackTraces.get(trace.traceId)?.applied).toBe(true);
  });

  it("keeps the memory checkpoint behind a live accepted retry with an old trace", async () => {
    const store = new MemoryDeliveryStore();
    store.seed("trace-memory-checkpoint", "accepted_by_trigger", NOW, {
      slackTraceId: "TrEarlierAttempt1",
    });

    await expect(
      store.advanceSlackActivityCheckpoint((NOW + 60 * 60 * 1_000) * 1_000),
    ).resolves.toBe(NOW * 1_000);
  });

  it("does not attach an error trace without a send boundary to a delivered memory row", async () => {
    const store = new MemoryDeliveryStore();
    const deliveryId = "trace-delivered-unrelated-error";
    store.seed(deliveryId, "delivered", NOW, { attemptCount: 1 });

    await store.recordSlackTrace(
      {
        traceId: "TrDeliveredError1",
        deliveryId,
        outcome: "error",
        ...PRE_SEND_TRACE_STORE_IDENTITY,
        sendBoundaryReached: false,
        preSendFailureProven: true,
        startedAtUs: NOW * 1_000 - 1,
        completedAtUs: NOW * 1_000,
      },
      NOW + 1,
    );

    expect(store.deliveries.get(deliveryId)?.slackTraceId).toBeNull();
  });

  it("keeps the durable checkpoint unchanged when any trace is invalid", async () => {
    const store = new MemoryDeliveryStore();
    const queue = new FakeQueue();
    const env = makeEnv(queue);
    store.slackActivityCheckpoint = NOW * 1_000 - 100;
    const report = {
      checkpoint_us: NOW * 1_000,
      report_timestamp: NOW_SECONDS,
      traces: [
        {
          trace_id: "TrUnknown1",
          delivery_id: "missing-delivery",
          outcome: "error" as const,
          ...PRE_SEND_TRACE_REPORT_IDENTITY,
          send_boundary_reached: false,
          pre_send_failure_proven: true,
          started_at_us: NOW * 1_000 - 1,
          completed_at_us: NOW * 1_000,
        },
      ],
    };
    const response = await handleFetch(
      await reconciliationRequest(report),
      env,
      { store, now: () => NOW },
    );
    expect(response.status).toBe(409);
    expect(store.slackActivityCheckpoint).toBe(NOW * 1_000 - 100);
  });

  it("replays an atomic reconciliation after an ambiguous response", async () => {
    const store = new ReconciliationResponseLossStore();
    const queue = new FakeQueue();
    const env = makeEnv(queue);
    const deliveryId = "trace-reconciliation-response-loss";
    const secondDeliveryId = "trace-reconciliation-response-loss-second";
    store.seed(deliveryId, "accepted_by_trigger", NOW, { attemptCount: 1 });
    store.seed(secondDeliveryId, "accepted_by_trigger", NOW, {
      attemptCount: 1,
    });
    store.slackActivityCheckpoint = NOW * 1_000 - 100;
    const report = {
      checkpoint_us: NOW * 1_000,
      report_timestamp: NOW_SECONDS,
      traces: [
        {
          trace_id: "TrReconciliationResponseLoss1",
          delivery_id: deliveryId,
          outcome: "error" as const,
          ...PRE_SEND_TRACE_REPORT_IDENTITY,
          send_boundary_reached: false,
          pre_send_failure_proven: true,
          started_at_us: NOW * 1_000 - 1,
          completed_at_us: NOW * 1_000,
        },
        {
          trace_id: "TrReconciliationResponseLoss2",
          delivery_id: secondDeliveryId,
          outcome: "error" as const,
          relay_attempt: "1",
          send_execution_id: "FxDeliveryProofTrace2",
          slack_channel_id: null,
          slack_message_ts: null,
          send_boundary_reached: false,
          pre_send_failure_proven: true,
          started_at_us: NOW * 1_000 - 1,
          completed_at_us: NOW * 1_000,
        },
      ],
    };

    const first = await handleFetch(await reconciliationRequest(report), env, {
      store,
      now: () => NOW,
    });
    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({ error: "persistence_unavailable" });
    expect(store.slackActivityCheckpoint).toBe(NOW * 1_000);
    expect(store.slackTraces.size).toBe(2);

    const replay = await handleFetch(await reconciliationRequest(report), env, {
      store,
      now: () => NOW + 1,
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ changed_error_traces: 2 });
    expect(store.deliveries.get(deliveryId)).toMatchObject({
      status: "pending",
      lastError: "slack_workflow_failed_before_send_boundary",
    });
    expect(store.deliveries.get(secondDeliveryId)).toMatchObject({
      status: "pending",
      lastError: "slack_workflow_failed_before_send_boundary",
    });
    expect(store.slackActivityCheckpoint).toBe(NOW * 1_000);
  });

  it("classifies persistence failures nominally rather than by their message", async () => {
    const store = new ReconciliationPersistenceFailureStore();
    const report = {
      checkpoint_us: NOW * 1_000,
      report_timestamp: NOW_SECONDS,
      traces: [
        {
          trace_id: "TrReconciliationPersistenceFailure1",
          delivery_id: "missing-delivery",
          outcome: "error" as const,
          ...PRE_SEND_TRACE_REPORT_IDENTITY,
          send_boundary_reached: false,
          pre_send_failure_proven: true,
          started_at_us: NOW * 1_000 - 1,
          completed_at_us: NOW * 1_000,
        },
      ],
    };

    const response = await handleFetch(
      await reconciliationRequest(report),
      makeEnv(new FakeQueue()),
      { store, now: () => NOW },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "persistence_unavailable" });
  });

  it("replays the journal after a lost finalization response without reapplying trace effects", async () => {
    const store = new ReconciliationFinalizeResponseLossStore();
    const queue = new FakeQueue();
    const env = makeEnv(queue);
    const deliveryId = "trace-checkpoint-response-loss";
    store.seed(deliveryId, "accepted_by_trigger", NOW, { attemptCount: 1 });
    store.slackActivityCheckpoint = NOW * 1_000 - 100;
    const report = {
      checkpoint_us: NOW * 1_000,
      report_timestamp: NOW_SECONDS,
      traces: [
        {
          trace_id: "TrCheckpointResponseLoss1",
          delivery_id: deliveryId,
          outcome: "error" as const,
          ...PRE_SEND_TRACE_REPORT_IDENTITY,
          send_boundary_reached: false,
          pre_send_failure_proven: true,
          started_at_us: NOW * 1_000 - 1,
          completed_at_us: NOW * 1_000,
        },
      ],
    };

    const first = await handleFetch(await reconciliationRequest(report), env, {
      store,
      now: () => NOW,
    });
    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({ error: "persistence_unavailable" });
    expect(store.slackActivityCheckpoint).toBe(NOW * 1_000);

    const replay = await handleFetch(await reconciliationRequest(report), env, {
      store,
      now: () => NOW + 1,
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ changed_error_traces: 1 });
    expect(store.deliveries.get(deliveryId)).toMatchObject({
      status: "pending",
      lastError: "slack_workflow_failed_before_send_boundary",
    });
    expect(store.slackActivityCheckpoint).toBe(NOW * 1_000);
  });

  it("returns the durable checkpoint only to an authenticated monitor", async () => {
    const store = new MemoryDeliveryStore();
    store.slackActivityCheckpoint = NOW * 1_000;
    const unsigned = { request_timestamp: NOW_SECONDS };
    const request = new Request(
      "https://relay.example/slack/reconciliation/checkpoint",
      {
        method: "POST",
        body: JSON.stringify({
          ...unsigned,
          request_signature: await signSlackCheckpointRequest(
            unsigned,
            TEST_RELAY_SIGNING_SECRET_NEXT,
          ),
        }),
      },
    );
    const response = await handleFetch(request, makeEnv(new FakeQueue()), {
      store,
      now: () => NOW,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      checkpoint_us: NOW * 1_000,
      reconciliation_version: 3,
    });
  });

  it("rejects current-only checkpoint and reconciliation control requests", async () => {
    const store = new MemoryDeliveryStore();
    store.slackActivityCheckpoint = NOW * 1_000;
    const unsignedCheckpoint = { request_timestamp: NOW_SECONDS };
    const checkpoint = await handleFetch(
      new Request("https://relay.example/slack/reconciliation/checkpoint", {
        method: "POST",
        body: JSON.stringify({
          ...unsignedCheckpoint,
          request_signature: await signSlackCheckpointRequest(
            unsignedCheckpoint,
            TEST_RELAY_SIGNING_SECRET,
          ),
        }),
      }),
      makeEnv(new FakeQueue()),
      { store, now: () => NOW },
    );
    expect(checkpoint.status).toBe(401);

    const report = {
      checkpoint_us: NOW * 1_000,
      report_timestamp: NOW_SECONDS,
      traces: [],
    };
    const reconciliation = await handleFetch(
      await reconciliationRequest(report, TEST_RELAY_SIGNING_SECRET),
      makeEnv(new FakeQueue()),
      { store, now: () => NOW },
    );
    expect(reconciliation.status).toBe(401);
  });
});
