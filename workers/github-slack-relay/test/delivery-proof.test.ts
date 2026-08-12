import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";

import { handleFetch } from "../src/index";
import {
  signSlackCheckpointRequest,
  signSlackProgress,
  signSlackReconciliation,
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
  SlackDeliveryProtocolActivation,
  SlackDeliveryProtocolActivationResult,
  SlackProgressInput,
  SlackProgressResult,
  SlackTraceReconciliation,
} from "../src/store";

const NOW = Date.parse("2026-08-03T12:00:00.000Z");
const NOW_SECONDS = String(Math.floor(NOW / 1_000));
const REVISION = "a".repeat(40);
const ACTIVATION_ID = "1".repeat(64);
const SCHEMA_REVISION = "0004_confirm_slack_delivery";
const ACTIVATION_SECRET = "staged-next-activation-key-for-tests";

class ActivationResponseLossStore extends MemoryDeliveryStore {
  #loseFirstResponse = true;

  override async activateSlackDeliveryProtocol(
    activation: SlackDeliveryProtocolActivation,
  ): Promise<SlackDeliveryProtocolActivationResult> {
    const result = await super.activateSlackDeliveryProtocol(activation);
    if (this.#loseFirstResponse) {
      this.#loseFirstResponse = false;
      throw new Error("simulated_d1_response_loss_after_activation_cas");
    }
    return result;
  }
}

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

  override async recordSlackTrace(
    trace: SlackTraceReconciliation,
    now: number,
  ): Promise<void> {
    await super.recordSlackTrace(trace, now);
    if (this.#loseFirstResponse) {
      this.#loseFirstResponse = false;
      throw new Error("simulated_d1_response_loss_after_reconciliation_write");
    }
  }
}

class ReconciliationPersistenceFailureStore extends MemoryDeliveryStore {
  override recordSlackTrace(): Promise<void> {
    return Promise.reject(new Error("delivery_not_found"));
  }
}

class CheckpointResponseLossStore extends MemoryDeliveryStore {
  #loseFirstResponse = true;

  override async advanceSlackActivityCheckpoint(
    checkpointUs: number,
  ): Promise<number> {
    const result = await super.advanceSlackActivityCheckpoint(checkpointUs);
    if (this.#loseFirstResponse) {
      this.#loseFirstResponse = false;
      throw new Error("simulated_d1_response_loss_after_checkpoint_write");
    }
    return result;
  }
}

function activationRequest({
  activationId = ACTIVATION_ID,
  expectedRevision = REVISION,
  schemaRevision = SCHEMA_REVISION,
  secret = ACTIVATION_SECRET,
}: {
  activationId?: string;
  expectedRevision?: string;
  schemaRevision?: string;
  secret?: string;
} = {}): Request {
  const unsigned = {
    activation_id: activationId,
    expected_revision: expectedRevision,
    schema_revision: schemaRevision,
  };
  const activationSignature = createHmac("sha256", secret)
    .update(
      JSON.stringify([
        "slack_delivery_protocol_activation_v1",
        unsigned.activation_id,
        unsigned.expected_revision,
        unsigned.schema_revision,
      ]),
      "utf8",
    )
    .digest("hex");
  return new Request("https://relay.example/slack/protocol/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...unsigned,
      activation_signature: activationSignature,
    }),
  });
}

async function progressRequest(
  overrides: Partial<Omit<SignedSlackProgress, "receipt_signature">> = {},
  secret = TEST_RELAY_SIGNING_SECRET_NEXT,
): Promise<Request> {
  const unsigned = {
    delivery_id: "receipt-delivery-1",
    destination: "alerts" as const,
    phase: "delivered" as const,
    message_ts: "1785758400.000001",
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

describe("authenticated Slack delivery proof", () => {
  it("activates the exact deployed protocol revision once and rejects mismatches", async () => {
    const store = new MemoryDeliveryStore();
    (
      store as MemoryDeliveryStore & {
        slackDeliveryProtocolActive: boolean;
      }
    ).slackDeliveryProtocolActive = false;
    const queue = new FakeQueue();
    const env = makeEnv(queue, {
      relaySigningSecretNext: ACTIVATION_SECRET,
    });
    (env as Env & { WORKER_VERSION: WorkerVersionMetadata }).WORKER_VERSION = {
      id: "version-id",
      tag: REVISION,
      timestamp: "2026-08-03T12:00:00.000Z",
    };

    const wrongKey = await handleFetch(
      activationRequest({
        secret: "wrong-activation-key-that-is-long-enough",
      }),
      env,
      { store, now: () => NOW },
    );
    expect(wrongKey.status).toBe(401);

    const currentKeyCannotActivate = await handleFetch(
      activationRequest({ secret: TEST_RELAY_SIGNING_SECRET }),
      env,
      { store, now: () => NOW },
    );
    expect(currentKeyCannotActivate.status).toBe(401);

    const wrongRevision = await handleFetch(
      activationRequest({ expectedRevision: "b".repeat(40) }),
      env,
      { store, now: () => NOW },
    );
    expect(wrongRevision.status).toBe(409);

    const activated = await handleFetch(activationRequest(), env, {
      store,
      now: () => NOW,
    });
    expect(activated.status).toBe(200);
    expect(await activated.json()).toEqual({
      ok: true,
      activation_status: "applied",
      activation_id: ACTIVATION_ID,
      activated_revision: REVISION,
      schema_revision: SCHEMA_REVISION,
    });

    const confirmation = await handleFetch(activationRequest(), env, {
      store,
      now: () => NOW,
    });
    expect(confirmation.status).toBe(200);
    expect(await confirmation.json()).toEqual({
      ok: true,
      activation_status: "already_applied",
      activation_id: ACTIVATION_ID,
      activated_revision: REVISION,
      schema_revision: SCHEMA_REVISION,
    });

    const newId = await handleFetch(
      activationRequest({ activationId: "2".repeat(64) }),
      env,
      { store, now: () => NOW },
    );
    expect(newId.status).toBe(409);

    const changedSchema = await handleFetch(
      activationRequest({ schemaRevision: "0005_modified_payload" }),
      env,
      { store, now: () => NOW },
    );
    expect(changedSchema.status).toBe(409);

    store.slackDeliveryProtocolConfirmationOpen = false;
    const postContractReplay = await handleFetch(activationRequest(), env, {
      store,
      now: () => NOW,
    });
    expect(postContractReplay.status).toBe(409);
  });

  it("returns a retryable failure when D1 loses the activation CAS response", async () => {
    const store = new ActivationResponseLossStore();
    store.slackDeliveryProtocolActive = false;
    const env = makeEnv(new FakeQueue(), {
      relaySigningSecretNext: ACTIVATION_SECRET,
      workerRevision: REVISION,
    });

    const lost = await handleFetch(activationRequest(), env, {
      store,
      now: () => NOW,
    });
    expect(lost.status).toBe(503);
    expect(await lost.json()).toEqual({ error: "persistence_unavailable" });

    const confirmation = await handleFetch(activationRequest(), env, {
      store,
      now: () => NOW + 1,
    });
    expect(confirmation.status).toBe(200);
    expect(await confirmation.json()).toMatchObject({
      activation_status: "already_applied",
      activation_id: ACTIVATION_ID,
    });
  });

  it("matches the cross-runtime HMAC golden vectors", async () => {
    await expect(
      signSlackProgress(
        {
          delivery_id: "receipt-delivery-1",
          destination: "alerts",
          phase: "delivered",
          message_ts: "1785758400.000001",
          receipt_timestamp: "1785758400",
        },
        TEST_RELAY_SIGNING_SECRET,
      ),
    ).resolves.toBe(
      "24c40d3b01cd4f50fcacc9cdae12953a8650f3e29056a1fea8656aedaba720f9",
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
      "57755ca181dcdbd50b36855f1a18b3d2ca6552fa97c81c781eda42499f8895c2",
    );
  });

  it("records delivery_id and message_ts idempotently without a state downgrade", async () => {
    const store = new MemoryDeliveryStore();
    const queue = new FakeQueue();
    store.seed("receipt-delivery-1", "accepted_by_trigger", NOW, {
      nextAttemptAt: NOW + 20 * 60 * 1_000,
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
  });

  it("retries a receipt whose D1 CAS response was lost without another delivery mutation", async () => {
    const store = new ProgressResponseLossStore();
    const env = makeEnv(new FakeQueue());
    store.seed("receipt-delivery-1", "accepted_by_trigger", NOW);

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
    store.seed("receipt-delivery-1", "accepted_by_trigger", NOW);

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
    store.seed("receipt-delivery-2", "accepted_by_trigger", NOW);
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
    store.seed("receipt-delivery-1", "accepted_by_trigger", NOW);

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
  it("retries only a complete failure proven to precede the send boundary", async () => {
    const store = new MemoryDeliveryStore();
    const queue = new FakeQueue();
    const env = makeEnv(queue);
    store.seed("trace-safe-retry", "accepted_by_trigger", NOW, {
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
    expect(store.deliveries.get("trace-safe-retry")?.status).toBe("queued");
  });

  it("never resends when SendMessage may have run or success lacks a receipt", async () => {
    const store = new MemoryDeliveryStore();
    const queue = new FakeQueue();
    const env = makeEnv(queue);
    store.seed("trace-ambiguous", "accepted_by_trigger", NOW);
    store.seed("trace-incomplete", "accepted_by_trigger", NOW);
    store.seed("trace-no-receipt", "accepted_by_trigger", NOW);
    const report = {
      checkpoint_us: NOW * 1_000,
      report_timestamp: NOW_SECONDS,
      traces: [
        {
          trace_id: "TrAmbiguous1",
          delivery_id: "trace-ambiguous",
          outcome: "error" as const,
          send_boundary_reached: true,
          pre_send_failure_proven: false,
          started_at_us: NOW * 1_000 - 20,
          completed_at_us: NOW * 1_000 - 10,
        },
        {
          trace_id: "TrIncomplete1",
          delivery_id: "trace-incomplete",
          outcome: "error" as const,
          send_boundary_reached: false,
          pre_send_failure_proven: false,
          started_at_us: NOW * 1_000 - 15,
          completed_at_us: NOW * 1_000 - 14,
        },
        {
          trace_id: "TrNoReceipt1",
          delivery_id: "trace-no-receipt",
          outcome: "success" as const,
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
    store.seed(deliveryId, "accepted_by_trigger", NOW);
    const baseTrace = {
      trace_id: "TrMemoryLateProof1",
      delivery_id: deliveryId,
      outcome: "error" as const,
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
        traces: [{ ...baseTrace, pre_send_failure_proven: true }],
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
    store.seed(deliveryId, "delivered", NOW);

    await store.recordSlackTrace(
      {
        traceId: "TrDeliveredError1",
        deliveryId,
        outcome: "error",
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

  it("retries an ambiguous reconciliation write instead of classifying it as a conflict", async () => {
    const store = new ReconciliationResponseLossStore();
    const queue = new FakeQueue();
    const env = makeEnv(queue);
    const deliveryId = "trace-reconciliation-response-loss";
    store.seed(deliveryId, "accepted_by_trigger", NOW);
    store.slackActivityCheckpoint = NOW * 1_000 - 100;
    const report = {
      checkpoint_us: NOW * 1_000,
      report_timestamp: NOW_SECONDS,
      traces: [
        {
          trace_id: "TrReconciliationResponseLoss1",
          delivery_id: deliveryId,
          outcome: "error" as const,
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
    expect(store.slackActivityCheckpoint).toBe(NOW * 1_000 - 100);

    const replay = await handleFetch(await reconciliationRequest(report), env, {
      store,
      now: () => NOW + 1,
    });
    expect(replay.status).toBe(200);
    expect(store.deliveries.get(deliveryId)).toMatchObject({
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

  it("retries a lost checkpoint response without reapplying trace effects", async () => {
    const store = new CheckpointResponseLossStore();
    const queue = new FakeQueue();
    const env = makeEnv(queue);
    const deliveryId = "trace-checkpoint-response-loss";
    store.seed(deliveryId, "accepted_by_trigger", NOW);
    store.slackActivityCheckpoint = NOW * 1_000 - 100;
    const report = {
      checkpoint_us: NOW * 1_000,
      report_timestamp: NOW_SECONDS,
      traces: [
        {
          trace_id: "TrCheckpointResponseLoss1",
          delivery_id: deliveryId,
          outcome: "error" as const,
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

    const replay = await handleFetch(await reconciliationRequest(report), env, {
      store,
      now: () => NOW + 1,
    });
    expect(replay.status).toBe(200);
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
    expect(await response.json()).toEqual({ checkpoint_us: NOW * 1_000 });
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
