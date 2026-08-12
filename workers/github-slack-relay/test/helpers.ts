import { vi } from "vitest";

import type { SlackWorkflowPayload } from "../src/domain";
import {
  SlackDeliveryProtocolActivationConflictError,
  SlackProgressConflictError,
  SlackReconciliationConflictError,
  SLACK_ACTIVITY_CHECKPOINT_OVERLAP_US,
  type DeliveryInput,
  type DeliveryStatus,
  type DeliveryStore,
  type QueueJob,
  type RecoveryClaim,
  type SlackDeliveryProtocolActivation,
  type SlackDeliveryProtocolActivationResult,
  type SlackProgressInput,
  type SlackProgressResult,
  type SlackTraceReconciliation,
  type SlackTraceRecordResult,
  type StoredDelivery,
} from "../src/store";

export const TEST_WEBHOOK_SECRET = "unit-test-github-webhook-secret-32";
export const TEST_SLACK_URL =
  "https://hooks.slack.com/triggers/T00000000/B00000000/TESTTOKEN";
export const TEST_RELAY_SIGNING_SECRET = "vitest-only-relay-signing-secret";
export const TEST_RELAY_SIGNING_SECRET_NEXT =
  "vitest-only-next-relay-signing-secret";

function cloneDelivery(delivery: StoredDelivery): StoredDelivery {
  return structuredClone(delivery);
}

type MemorySlackTrace = {
  deliveryId: string;
  outcome: SlackTraceReconciliation["outcome"];
  attemptCount: number;
  sendExecutionId: string | null;
  destination: "alerts" | "activity" | null;
  slackChannelId: string | null;
  messageTs: string | null;
  sendBoundaryReached: boolean;
  preSendFailureProven: boolean;
  startedAtUs: number;
  completedAtUs: number | null;
  applied: boolean;
};

export class MemoryDeliveryStore implements DeliveryStore {
  readonly deliveries = new Map<string, StoredDelivery>();
  readonly slackTraces = new Map<string, MemorySlackTrace>();
  nextSlackAt = 0;
  slackActivityCheckpoint = 0;
  slackDeliveryProtocolActive = true;
  slackDeliveryProtocolRevision: string | null = null;
  slackDeliveryProtocolActivatedAt: number | null = null;
  slackDeliveryProtocolActivationId: string | null = null;
  slackDeliveryProtocolSchemaRevision: string | null = null;
  slackDeliveryProtocolConfirmationOpen = true;
  healthy = true;

  async isSlackDeliveryProtocolActive(
    expectedRevision: string,
  ): Promise<boolean> {
    return (
      this.slackDeliveryProtocolActive &&
      (this.slackDeliveryProtocolRevision ?? expectedRevision) ===
        expectedRevision
    );
  }

  async activateSlackDeliveryProtocol(
    activation: SlackDeliveryProtocolActivation,
  ): Promise<SlackDeliveryProtocolActivationResult> {
    const isTargetActivation =
      activation.schemaRevision === "0005_reconcile_live_slack_receipts";
    const isExactBridgeSourceReplay =
      activation.revision ===
        "afe5250504d37543845b07f44af7bfc30a548feb" &&
      activation.schemaRevision === "0004_confirm_slack_delivery" &&
      activation.activationId === activation.bridgeSourceActivationId;
    const valid =
      /^[0-9a-f]{64}$/u.test(activation.activationId) &&
      /^[0-9a-f]{64}$/u.test(activation.bridgeSourceActivationId) &&
      /^[0-9a-f]{40}$/u.test(activation.revision) &&
      (isTargetActivation || isExactBridgeSourceReplay) &&
      Number.isSafeInteger(activation.now) &&
      activation.now > 0;
    if (!valid) {
      throw new SlackDeliveryProtocolActivationConflictError(
        "slack_delivery_protocol_activation_conflict",
      );
    }
    if (!this.slackDeliveryProtocolActive) {
      if (
        this.slackDeliveryProtocolRevision !== null ||
        this.slackDeliveryProtocolActivatedAt !== null ||
        this.slackDeliveryProtocolActivationId !== null ||
        this.slackDeliveryProtocolSchemaRevision !== null ||
        !this.slackDeliveryProtocolConfirmationOpen
      ) {
        throw new SlackDeliveryProtocolActivationConflictError(
          "slack_delivery_protocol_activation_conflict",
        );
      }
      this.slackDeliveryProtocolActive = true;
      this.slackDeliveryProtocolRevision = activation.revision;
      this.slackDeliveryProtocolActivatedAt = activation.now;
      this.slackDeliveryProtocolActivationId = activation.activationId;
      this.slackDeliveryProtocolSchemaRevision = activation.schemaRevision;
      return "applied";
    }

    if (
      this.slackDeliveryProtocolConfirmationOpen &&
      this.slackDeliveryProtocolRevision === activation.revision &&
      this.slackDeliveryProtocolActivationId === activation.activationId &&
      this.slackDeliveryProtocolSchemaRevision === activation.schemaRevision
    ) {
      return "already_applied";
    }
    if (
      this.slackDeliveryProtocolConfirmationOpen &&
      this.slackDeliveryProtocolRevision ===
        "afe5250504d37543845b07f44af7bfc30a548feb" &&
      this.slackDeliveryProtocolActivationId ===
        activation.bridgeSourceActivationId &&
      this.slackDeliveryProtocolSchemaRevision ===
        "0004_confirm_slack_delivery" &&
      this.slackDeliveryProtocolActivatedAt !== null &&
      activation.now > this.slackDeliveryProtocolActivatedAt &&
      this.slackDeliveryProtocolActivationId !== activation.activationId
    ) {
      this.slackDeliveryProtocolRevision = activation.revision;
      this.slackDeliveryProtocolActivatedAt = activation.now;
      this.slackDeliveryProtocolActivationId = activation.activationId;
      this.slackDeliveryProtocolSchemaRevision = activation.schemaRevision;
      return "applied";
    }
    throw new SlackDeliveryProtocolActivationConflictError(
      "slack_delivery_protocol_activation_conflict",
    );
  }

  async insert(input: DeliveryInput): Promise<boolean> {
    if (this.deliveries.has(input.deliveryId)) {
      return false;
    }

    this.deliveries.set(input.deliveryId, {
      deliveryId: input.deliveryId,
      eventType: input.eventType,
      action: input.action,
      repository: input.repository,
      destination: input.destination,
      payload: structuredClone(input.payload),
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: input.now,
      lastError: null,
      createdAt: input.now,
      updatedAt: input.now,
      triggerAcceptedAt: null,
      sendStartedAt: null,
      deliveredAt: null,
      slackMessageTs: null,
      slackTraceId: null,
      slackSendExecutionId: null,
      legacyUnverified: false,
    });
    return true;
  }

  async get(deliveryId: string): Promise<StoredDelivery | null> {
    const delivery = this.deliveries.get(deliveryId);
    return delivery === undefined ? null : cloneDelivery(delivery);
  }

  async resolveSlackTraceIdentityBySendExecutionId(
    sendExecutionId: string,
  ): Promise<{
    deliveryId: string;
    destination: "alerts" | "activity";
    attemptCount: number;
  } | null> {
    const matches = [...this.deliveries.values()].filter(
      (delivery) => delivery.slackSendExecutionId === sendExecutionId,
    );
    if (matches.length > 1) {
      throw new SlackReconciliationConflictError(
        "slack_send_execution_not_unique",
      );
    }
    const delivery = matches[0];
    return delivery === undefined
      ? null
      : {
          deliveryId: delivery.deliveryId,
          destination: delivery.destination,
          attemptCount: delivery.attemptCount,
        };
  }

  async markQueued(deliveryId: string, now: number): Promise<void> {
    const delivery = this.require(deliveryId);
    if (delivery.status === "pending" || delivery.status === "enqueueing") {
      delivery.status = "queued";
      delivery.updatedAt = now;
      delivery.lastError = null;
    }
  }

  async markEnqueueFailed(
    deliveryId: string,
    now: number,
    nextAttemptAt: number,
    reason: string,
  ): Promise<void> {
    const delivery = this.require(deliveryId);
    if (
      delivery.status !== "accepted_by_trigger" &&
      delivery.status !== "accepted_by_slack" &&
      delivery.status !== "send_started" &&
      delivery.status !== "delivered" &&
      delivery.status !== "manual_review"
    ) {
      delivery.status = "pending";
      delivery.updatedAt = now;
      delivery.nextAttemptAt = nextAttemptAt;
      delivery.lastError = reason;
    }
  }

  async reserveSlackSlot(
    now: number,
    intervalMilliseconds: number,
    destination: "alerts" | "activity",
  ): Promise<number> {
    const alertHasPriority =
      destination === "activity" &&
      [...this.deliveries.values()].some(
        (delivery) =>
          delivery.destination === "alerts" &&
          (["enqueueing", "queued", "sending"].includes(delivery.status) ||
            (["pending", "dead_letter"].includes(delivery.status) &&
              delivery.nextAttemptAt <= now)),
      );
    if (alertHasPriority) {
      return 1_000;
    }

    if (this.nextSlackAt <= now) {
      this.nextSlackAt = now + intervalMilliseconds;
      return 0;
    }

    return this.nextSlackAt - now;
  }

  async extendSlackCooldown(until: number): Promise<void> {
    this.nextSlackAt = Math.max(this.nextSlackAt, until);
  }

  async claimForSlack(
    deliveryId: string,
    now: number,
  ): Promise<StoredDelivery | null> {
    const delivery = this.deliveries.get(deliveryId);
    if (
      delivery === undefined ||
      delivery.nextAttemptAt > now ||
      !(
        ["pending", "enqueueing", "queued", "dead_letter"] as DeliveryStatus[]
      ).includes(delivery.status)
    ) {
      return null;
    }
    if (delivery.slackTraceId !== null) {
      const trace = this.slackTraces.get(delivery.slackTraceId);
      if (
        trace === undefined ||
        !trace.applied ||
        trace.deliveryId !== delivery.deliveryId ||
        trace.outcome !== "error" ||
        trace.attemptCount !== delivery.attemptCount ||
        trace.sendExecutionId !== delivery.slackSendExecutionId ||
        trace.slackChannelId !== null ||
        trace.messageTs !== null ||
        trace.sendBoundaryReached ||
        !trace.preSendFailureProven
      ) {
        return null;
      }
    }
    const incompatibleTrace = [...this.slackTraces.values()].some(
      (trace) =>
        trace.deliveryId === delivery.deliveryId &&
        trace.attemptCount === delivery.attemptCount &&
        (trace.sendExecutionId === null ||
          delivery.slackSendExecutionId === null ||
          trace.sendExecutionId === delivery.slackSendExecutionId) &&
        (!trace.applied ||
          trace.outcome !== "error" ||
          trace.slackChannelId !== null ||
          trace.messageTs !== null ||
          trace.sendBoundaryReached ||
          !trace.preSendFailureProven),
    );
    if (incompatibleTrace) return null;

    delivery.status = "sending";
    delivery.attemptCount += 1;
    delivery.updatedAt = now;
    delivery.slackTraceId = null;
    delivery.slackSendExecutionId = null;
    return cloneDelivery(delivery);
  }

  async recordFailure(
    deliveryId: string,
    now: number,
    nextAttemptAt: number,
    reason: string,
  ): Promise<void> {
    const delivery = this.require(deliveryId);
    if (delivery.status === "sending") {
      delivery.status = "pending";
      delivery.updatedAt = now;
      delivery.nextAttemptAt = nextAttemptAt;
      delivery.lastError = reason;
    }
  }

  async markAcceptedByTrigger(
    deliveryId: string,
    now: number,
    reconcileAt: number,
  ): Promise<void> {
    const delivery = this.require(deliveryId);
    if (delivery.status === "send_started" || delivery.status === "delivered") {
      delivery.triggerAcceptedAt ??= now;
      if (delivery.status === "send_started") {
        delivery.nextAttemptAt = Math.max(delivery.nextAttemptAt, reconcileAt);
      }
      return;
    }
    if (delivery.status !== "sending") {
      throw new Error("delivery_state_changed_before_trigger_acceptance");
    }
    delivery.status = "accepted_by_trigger";
    delivery.updatedAt = now;
    delivery.triggerAcceptedAt = now;
    delivery.nextAttemptAt = reconcileAt;
    delivery.lastError = null;
  }

  async recordSlackProgress(
    input: SlackProgressInput,
  ): Promise<SlackProgressResult> {
    const delivery = this.require(input.deliveryId);
    if (delivery.destination !== input.destination) {
      throw new SlackProgressConflictError("delivery_destination_mismatch");
    }
    if (
      !Number.isSafeInteger(input.attemptCount) ||
      input.attemptCount <= 0 ||
      delivery.attemptCount !== input.attemptCount
    ) {
      throw new SlackProgressConflictError("slack_delivery_attempt_conflict");
    }
    if (!/^Fx[A-Za-z0-9]{1,126}$/u.test(input.functionExecutionId)) {
      throw new SlackProgressConflictError("invalid_slack_function_execution");
    }
    if (input.phase === "send_started") {
      if (
        delivery.status === "send_started" ||
        delivery.status === "delivered"
      ) {
        if (delivery.slackSendExecutionId === input.functionExecutionId) {
          return "duplicate";
        }
        throw new SlackProgressConflictError("slack_send_execution_conflict");
      }
      const releasedPreSendRetry =
        (["pending", "enqueueing", "queued", "dead_letter"] as const).includes(
          delivery.status as "pending" | "enqueueing" | "queued" | "dead_letter",
        ) &&
        delivery.slackTraceId !== null &&
        delivery.slackSendExecutionId === input.functionExecutionId;
      if (
        delivery.status !== "sending" &&
        delivery.status !== "accepted_by_slack" &&
        delivery.status !== "accepted_by_trigger" &&
        !(
          delivery.status === "manual_review" &&
          delivery.lastError !== null &&
          ([
            "slack_trigger_request_outcome_ambiguous",
            "slack_trigger_success_confirmation_ambiguous",
            "slack_trigger_http_408_ambiguous",
            "replayed_slack_trigger_attempt_ambiguous",
            "stale_slack_trigger_attempt_ambiguous",
            "dead_letter_slack_trigger_attempt_ambiguous",
          ].includes(delivery.lastError) ||
            /^slack_trigger_http_5\d\d_ambiguous$/u.test(delivery.lastError))
        ) &&
        !releasedPreSendRetry
      ) {
        throw new SlackProgressConflictError(
          "delivery_not_awaiting_slack_progress",
        );
      }
      delivery.status = "send_started";
      delivery.sendStartedAt = input.now;
      delivery.updatedAt = input.now;
      delivery.nextAttemptAt = input.reconcileAt;
      delivery.lastError = null;
      delivery.legacyUnverified = false;
      delivery.slackTraceId = null;
      delivery.slackSendExecutionId = input.functionExecutionId;
      return "recorded";
    }
    if (input.messageTs === null) {
      throw new SlackProgressConflictError("slack_message_timestamp_missing");
    }
    if (
      delivery.status === "manual_review" &&
      delivery.lastError === "known_slack_workflow_timeout_message_absent"
    ) {
      throw new SlackProgressConflictError(
        "known_loss_recovery_authorization_required",
      );
    }
    if (delivery.status === "delivered") {
      if (delivery.slackMessageTs === input.messageTs) return "duplicate";
      throw new SlackProgressConflictError("slack_message_timestamp_conflict");
    }
    const releasedPreSendRetry =
      (["pending", "enqueueing", "queued", "dead_letter"] as const).includes(
        delivery.status as "pending" | "enqueueing" | "queued" | "dead_letter",
      ) && delivery.slackTraceId !== null;
    if (delivery.slackSendExecutionId === null) {
      throw new SlackProgressConflictError("slack_send_execution_missing");
    }
    for (const other of this.deliveries.values()) {
      if (
        other.deliveryId !== input.deliveryId &&
        other.destination === input.destination &&
        other.slackMessageTs === input.messageTs
      ) {
        throw new SlackProgressConflictError(
          "slack_message_timestamp_conflict",
        );
      }
    }
    if (
      ![
        "accepted_by_slack",
        "sending",
        "accepted_by_trigger",
        "send_started",
        "manual_review",
      ].includes(delivery.status)
      && !releasedPreSendRetry
    ) {
      throw new SlackProgressConflictError(
        "delivery_not_awaiting_slack_progress",
      );
    }
    delivery.status = "delivered";
    delivery.deliveredAt = input.now;
    delivery.slackMessageTs = input.messageTs;
    delivery.slackTraceId = null;
    delivery.updatedAt = input.now;
    delivery.nextAttemptAt = input.now;
    delivery.lastError = null;
    delivery.legacyUnverified = false;
    return "recorded";
  }

  async markDeadLetter(
    deliveryId: string,
    now: number,
    nextAttemptAt: number,
    reason: string,
  ): Promise<void> {
    const delivery = this.require(deliveryId);
    if (
      delivery.status !== "accepted_by_trigger" &&
      delivery.status !== "accepted_by_slack" &&
      delivery.status !== "send_started" &&
      delivery.status !== "delivered" &&
      delivery.status !== "manual_review"
    ) {
      delivery.status = "dead_letter";
      delivery.updatedAt = now;
      delivery.nextAttemptAt = nextAttemptAt;
      delivery.lastError = reason;
    }
  }

  async markManualReview(
    deliveryId: string,
    now: number,
    reason: string,
  ): Promise<void> {
    const delivery = this.require(deliveryId);
    if (delivery.status !== "delivered") {
      delivery.status = "manual_review";
      delivery.updatedAt = now;
      delivery.lastError = reason;
    }
  }

  async claimRecoverable(
    now: number,
    staleBefore: number,
    maximumAttempts: number,
    limit: number,
  ): Promise<RecoveryClaim[]> {
    const candidates = [...this.deliveries.values()]
      .filter((delivery) => {
        const due =
          (["pending", "dead_letter"] as DeliveryStatus[]).includes(
            delivery.status,
          ) && delivery.nextAttemptAt <= now;
        const stale =
          (["enqueueing", "queued", "sending"] as DeliveryStatus[]).includes(
            delivery.status,
          ) && delivery.updatedAt <= staleBefore;
        return due || stale;
      })
      .sort(
        (left, right) =>
          left.nextAttemptAt - right.nextAttemptAt ||
          left.createdAt - right.createdAt,
      )
      .slice(0, limit);

    const claimed: RecoveryClaim[] = [];
    for (const delivery of candidates) {
      if (delivery.status === "sending") {
        delivery.status = "manual_review";
        delivery.updatedAt = now;
        delivery.lastError = "stale_slack_trigger_attempt_ambiguous";
      } else if (delivery.attemptCount >= maximumAttempts) {
        delivery.status = "manual_review";
        delivery.updatedAt = now;
        delivery.lastError = "maximum_delivery_attempts_reached";
      } else {
        delivery.status = "enqueueing";
        delivery.updatedAt = now;
        delivery.nextAttemptAt = now;
        claimed.push({
          deliveryId: delivery.deliveryId,
          destination: delivery.destination,
        });
      }
    }
    return claimed;
  }

  async recordSlackTrace(
    trace: SlackTraceReconciliation,
    now: number,
  ): Promise<SlackTraceRecordResult> {
    const destination = trace.destination;
    const slackChannelId = trace.slackChannelId;
    const messageTs = trace.messageTs;
    if (
      !Number.isSafeInteger(trace.attemptCount) ||
      trace.attemptCount <= 0 ||
      (trace.sendExecutionId !== null &&
        !/^Fx[A-Za-z0-9]{1,126}$/u.test(trace.sendExecutionId)) ||
      (trace.preSendFailureProven && trace.sendExecutionId === null)
      || ((slackChannelId === null) !== (messageTs === null))
      || (messageTs !== null &&
        (trace.sendExecutionId === null ||
          !trace.sendBoundaryReached ||
          trace.preSendFailureProven ||
          destination === null ||
          (destination === "alerts" && slackChannelId !== "C0BMUK793NV") ||
          (destination === "activity" && slackChannelId !== "C0BMQMW3L4E") ||
          !/^\d{10,13}\.\d{6}$/u.test(messageTs)))
    ) {
      throw new SlackReconciliationConflictError("invalid_slack_trace_attempt");
    }
    if (trace.outcome !== "pending" && trace.completedAtUs === null) {
      throw new SlackReconciliationConflictError(
        "terminal_slack_trace_missing_completion",
      );
    }
    const delivery = this.deliveries.get(trace.deliveryId);
    if (delivery === undefined) {
      throw new SlackReconciliationConflictError("delivery_not_found");
    }
    if (trace.sendExecutionId !== null) {
      const owner = [...this.deliveries.values()].find(
        (candidate) =>
          candidate.slackSendExecutionId === trace.sendExecutionId,
      );
      if (
        owner !== undefined &&
        (owner.deliveryId !== trace.deliveryId ||
          owner.attemptCount !== trace.attemptCount)
      ) {
        throw new SlackReconciliationConflictError("slack_trace_owner_conflict");
      }
      const traceOwner = [...this.slackTraces.entries()].find(
        ([traceId, candidate]) =>
          traceId !== trace.traceId &&
          candidate.sendExecutionId === trace.sendExecutionId,
      );
      if (traceOwner !== undefined) {
        throw new SlackReconciliationConflictError(
          "slack_trace_send_execution_owner_conflict",
        );
      }
    }
    const previous = this.slackTraces.get(trace.traceId);
    if (previous !== undefined && previous.deliveryId !== trace.deliveryId) {
      throw new SlackReconciliationConflictError(
        "slack_trace_delivery_conflict",
      );
    }
    if (
      previous !== undefined &&
      previous.outcome !== "pending" &&
      trace.outcome !== "pending" &&
      previous.outcome !== trace.outcome
    ) {
      throw new SlackReconciliationConflictError(
        "slack_trace_outcome_conflict",
      );
    }
    if (
      previous !== undefined &&
      previous.attemptCount !== trace.attemptCount
    ) {
      throw new SlackReconciliationConflictError(
        "slack_trace_attempt_conflict",
      );
    }
    if (
      previous?.sendExecutionId !== null &&
      previous?.sendExecutionId !== undefined &&
      trace.sendExecutionId !== null &&
      previous.sendExecutionId !== trace.sendExecutionId
    ) {
      throw new SlackReconciliationConflictError(
        "slack_trace_send_execution_conflict",
      );
    }
    if (
      previous !== undefined &&
      ((previous.destination !== null &&
        destination !== null &&
        previous.destination !== destination) ||
        (previous.slackChannelId !== null &&
          slackChannelId !== null &&
          previous.slackChannelId !== slackChannelId) ||
        (previous.messageTs !== null &&
          messageTs !== null &&
          previous.messageTs !== messageTs))
    ) {
      throw new SlackReconciliationConflictError(
        "slack_trace_message_evidence_conflict",
      );
    }
    const sendBoundaryReached =
      (previous?.sendBoundaryReached ?? false) || trace.sendBoundaryReached;
    const preSendFailureProven =
      !sendBoundaryReached &&
      ((previous?.preSendFailureProven ?? false) || trace.preSendFailureProven);
    const gainedEvidence =
      previous !== undefined &&
      ((previous.outcome === "pending" && trace.outcome !== "pending") ||
        (previous.sendExecutionId === null && trace.sendExecutionId !== null) ||
        (previous.messageTs === null && messageTs !== null) ||
        (!previous.sendBoundaryReached && sendBoundaryReached) ||
        (!previous.preSendFailureProven && preSendFailureProven));
    const effectiveTrace: MemorySlackTrace = {
      deliveryId: trace.deliveryId,
      outcome:
        previous === undefined || previous.outcome === "pending"
          ? trace.outcome
          : previous.outcome,
      attemptCount: trace.attemptCount,
      sendExecutionId: previous?.sendExecutionId ?? trace.sendExecutionId,
      destination: previous?.destination ?? destination,
      slackChannelId: previous?.slackChannelId ?? slackChannelId,
      messageTs: previous?.messageTs ?? messageTs,
      sendBoundaryReached,
      preSendFailureProven,
      startedAtUs: Math.min(
        previous?.startedAtUs ?? trace.startedAtUs,
        trace.startedAtUs,
      ),
      completedAtUs: previous?.completedAtUs ?? trace.completedAtUs ?? null,
      applied: previous?.applied ?? false,
    };
    if (
      effectiveTrace.slackChannelId !== null &&
      effectiveTrace.messageTs !== null &&
      [...this.slackTraces.entries()].some(
        ([traceId, candidate]) =>
          traceId !== trace.traceId &&
          candidate.slackChannelId === effectiveTrace.slackChannelId &&
          candidate.messageTs === effectiveTrace.messageTs,
      )
    ) {
      throw new SlackReconciliationConflictError(
        "slack_trace_message_owner_conflict",
      );
    }
    const observationResult: SlackTraceRecordResult =
      trace.outcome === "pending" && effectiveTrace.outcome !== "pending"
        ? "duplicate"
        : previous === undefined ||
      (previous.outcome === "pending" && gainedEvidence)
        ? "changed"
        : "duplicate";
    this.slackTraces.set(trace.traceId, effectiveTrace);
    if (effectiveTrace.outcome === "pending") return observationResult;
    if (previous?.applied && !gainedEvidence) return observationResult;
    const markApplied = () => {
      effectiveTrace.applied = true;
    };
    if (effectiveTrace.messageTs !== null) {
      if (
        effectiveTrace.sendExecutionId === null ||
        delivery.slackSendExecutionId !== effectiveTrace.sendExecutionId ||
        effectiveTrace.destination !== delivery.destination
      ) {
        throw new SlackReconciliationConflictError(
          "slack_trace_owner_conflict",
        );
      }
      for (const other of this.deliveries.values()) {
        if (
          other.deliveryId !== delivery.deliveryId &&
          other.destination === delivery.destination &&
          other.slackMessageTs === effectiveTrace.messageTs
        ) {
          throw new SlackReconciliationConflictError(
            "slack_message_timestamp_conflict",
          );
        }
      }
      if (
        delivery.status === "delivered" &&
        delivery.slackMessageTs !== effectiveTrace.messageTs
      ) {
        throw new SlackReconciliationConflictError(
          "slack_message_timestamp_conflict",
        );
      }
      delivery.status = "delivered";
      delivery.deliveredAt ??= now;
      delivery.slackMessageTs = effectiveTrace.messageTs;
      delivery.slackTraceId = trace.traceId;
      delivery.updatedAt = now;
      delivery.nextAttemptAt = now;
      delivery.lastError = null;
      delivery.legacyUnverified = false;
      markApplied();
      return observationResult;
    }
    if (delivery.status === "delivered") {
      if (
        delivery.attemptCount === effectiveTrace.attemptCount &&
        delivery.slackSendExecutionId !== null &&
        delivery.slackSendExecutionId === effectiveTrace.sendExecutionId &&
        (effectiveTrace.outcome === "success" || sendBoundaryReached)
      ) {
        delivery.slackTraceId = trace.traceId;
        delivery.updatedAt = now;
      }
      markApplied();
      return observationResult;
    }
    if (delivery.attemptCount !== effectiveTrace.attemptCount) {
      markApplied();
      return observationResult;
    }
    if (
      delivery.slackSendExecutionId !== null &&
      delivery.slackSendExecutionId !== effectiveTrace.sendExecutionId
    ) {
      markApplied();
      return observationResult;
    }
    if (
      effectiveTrace.outcome === "success" &&
      delivery.status === "accepted_by_slack" &&
      delivery.legacyUnverified
    ) {
      if (
        delivery.slackTraceId !== null &&
        delivery.slackTraceId !== trace.traceId
      ) {
        delivery.status = "manual_review";
        delivery.lastError = "slack_legacy_trace_conflict";
      } else {
        delivery.slackTraceId = trace.traceId;
      }
      delivery.updatedAt = now;
      markApplied();
      return observationResult;
    }
    if (effectiveTrace.outcome === "success") {
      delivery.status = "manual_review";
      delivery.lastError =
        "slack_workflow_succeeded_without_authenticated_receipt";
      delivery.slackTraceId = trace.traceId;
      delivery.updatedAt = now;
      markApplied();
      return observationResult;
    }
    if (
      effectiveTrace.sendBoundaryReached ||
      delivery.status === "send_started" ||
      (!effectiveTrace.preSendFailureProven && delivery.legacyUnverified)
    ) {
      delivery.status = "manual_review";
      delivery.lastError = "slack_workflow_failed_after_send_boundary";
      delivery.slackTraceId = trace.traceId;
      delivery.updatedAt = now;
      markApplied();
      return observationResult;
    }
    if (!effectiveTrace.preSendFailureProven) {
      delivery.status = "manual_review";
      delivery.lastError = "slack_workflow_failed_without_pre_send_proof";
      delivery.slackTraceId = trace.traceId;
      delivery.updatedAt = now;
      markApplied();
      return observationResult;
    }
    const retryableManualAmbiguity =
      delivery.status === "manual_review" &&
      delivery.lastError !== null &&
      ([
        "slack_trigger_request_outcome_ambiguous",
        "slack_trigger_success_confirmation_ambiguous",
        "slack_trigger_http_408_ambiguous",
        "replayed_slack_trigger_attempt_ambiguous",
        "stale_slack_trigger_attempt_ambiguous",
        "dead_letter_slack_trigger_attempt_ambiguous",
      ].includes(delivery.lastError) ||
        /^slack_trigger_http_5\d\d_ambiguous$/u.test(delivery.lastError));
    const sameTraceMayReleaseMissingProof =
      delivery.status === "manual_review" &&
      delivery.lastError === "slack_workflow_failed_without_pre_send_proof" &&
      delivery.slackTraceId === trace.traceId &&
      effectiveTrace.preSendFailureProven;
    if (
      delivery.status === "accepted_by_trigger" ||
      delivery.status === "accepted_by_slack" ||
      (["pending", "enqueueing", "queued", "dead_letter"] as const).includes(
        delivery.status as "pending" | "enqueueing" | "queued" | "dead_letter",
      ) && delivery.slackTraceId === null ||
      retryableManualAmbiguity ||
      sameTraceMayReleaseMissingProof
    ) {
      if (
        delivery.attemptCount !== effectiveTrace.attemptCount ||
        (delivery.slackSendExecutionId !== null &&
          delivery.slackSendExecutionId !== effectiveTrace.sendExecutionId)
      ) {
        markApplied();
        return observationResult;
      }
      const competingTrace = [...this.slackTraces.entries()].some(
        ([traceId, candidate]) =>
          traceId !== trace.traceId &&
          candidate.deliveryId === delivery.deliveryId &&
          candidate.attemptCount === delivery.attemptCount &&
          (!candidate.applied ||
            candidate.outcome !== "error" ||
            candidate.slackChannelId !== null ||
            candidate.messageTs !== null ||
            candidate.sendBoundaryReached ||
            !candidate.preSendFailureProven),
      );
      if (competingTrace) return observationResult;
      delivery.status = "pending";
      delivery.nextAttemptAt = Math.max(
        delivery.nextAttemptAt,
        now + 20 * 60 * 1_000,
      );
      delivery.lastError = "slack_workflow_failed_before_send_boundary";
      delivery.slackTraceId = trace.traceId;
      delivery.slackSendExecutionId ??= effectiveTrace.sendExecutionId;
      delivery.legacyUnverified = false;
      delivery.updatedAt = now;
      markApplied();
      return observationResult;
    }
    if (delivery.status !== "sending") markApplied();
    return observationResult;
  }

  async getSlackActivityCheckpoint(): Promise<number> {
    return this.slackActivityCheckpoint;
  }

  async advanceSlackActivityCheckpoint(checkpointUs: number): Promise<number> {
    if (!Number.isSafeInteger(checkpointUs) || checkpointUs < 0) {
      throw new SlackReconciliationConflictError(
        "invalid_slack_activity_checkpoint",
      );
    }
    const unresolved = [...this.deliveries.values()]
      .filter(
        (delivery) =>
          !delivery.legacyUnverified &&
          ([
            "pending",
            "enqueueing",
            "queued",
            "sending",
            "accepted_by_slack",
            "accepted_by_trigger",
            "send_started",
          ].includes(delivery.status) ||
            delivery.slackTraceId === null),
      )
      .reduce(
        (minimum, delivery) => Math.min(minimum, delivery.updatedAt * 1_000),
        checkpointUs,
      );
    this.slackActivityCheckpoint = Math.max(
      this.slackActivityCheckpoint,
      Math.min(checkpointUs, unresolved),
    );
    return this.slackActivityCheckpoint;
  }

  async purgeDeliveredBefore(cutoff: number): Promise<number> {
    let purged = 0;
    const retainedActivityBoundary = Math.max(
      0,
      this.slackActivityCheckpoint - SLACK_ACTIVITY_CHECKPOINT_OVERLAP_US,
    );
    for (const [deliveryId, delivery] of this.deliveries) {
      const trace =
        delivery.slackTraceId === null
          ? undefined
          : this.slackTraces.get(delivery.slackTraceId);
      if (
        delivery.status === "delivered" &&
        delivery.deliveredAt !== null &&
        delivery.slackTraceId !== null &&
        delivery.deliveredAt < cutoff &&
        trace?.deliveryId === deliveryId &&
        trace.attemptCount === delivery.attemptCount &&
        delivery.slackSendExecutionId !== null &&
        trace.sendExecutionId === delivery.slackSendExecutionId &&
        (trace.outcome === "success" ||
          (trace.outcome === "error" && trace.sendBoundaryReached)) &&
        trace.applied &&
        trace.completedAtUs !== null &&
        trace.startedAtUs < retainedActivityBoundary &&
        trace.completedAtUs < retainedActivityBoundary
      ) {
        this.deliveries.delete(deliveryId);
        this.slackTraces.delete(delivery.slackTraceId);
        purged += 1;
      }
    }
    return purged;
  }

  async healthcheck(now: number, expectedRevision: string): Promise<boolean> {
    return (
      this.healthy &&
      this.slackDeliveryProtocolActive &&
      (this.slackDeliveryProtocolRevision ?? expectedRevision) ===
        expectedRevision &&
      ![...this.deliveries.values()].some(
        (delivery) =>
          delivery.status === "manual_review" ||
          delivery.status === "dead_letter" ||
          (!delivery.legacyUnverified &&
            [
              "accepted_by_slack",
              "accepted_by_trigger",
              "send_started",
            ].includes(delivery.status) &&
            delivery.nextAttemptAt <= now),
      )
    );
  }

  async hasLegacyUnverifiedDebt(): Promise<boolean> {
    return [...this.deliveries.values()].some(
      (delivery) => delivery.legacyUnverified,
    );
  }

  seed(
    deliveryId: string,
    status: DeliveryStatus,
    now: number,
    overrides: Partial<StoredDelivery> = {},
  ): StoredDelivery {
    const payload = sampleSlackPayload(deliveryId);
    const delivery: StoredDelivery = {
      deliveryId,
      eventType: "workflow_run",
      action: "completed",
      repository: "LCV-Ideas-Software/cross-review",
      destination: "alerts",
      payload,
      status,
      attemptCount: 0,
      nextAttemptAt: now,
      lastError: null,
      createdAt: now,
      updatedAt: now,
      triggerAcceptedAt:
        status === "accepted_by_trigger" || status === "accepted_by_slack"
          ? now
          : null,
      sendStartedAt: status === "send_started" ? now : null,
      deliveredAt: status === "delivered" ? now : null,
      slackMessageTs: status === "delivered" ? "1785758400.000001" : null,
      slackTraceId: null,
      slackSendExecutionId: null,
      legacyUnverified: false,
      ...overrides,
    };
    this.deliveries.set(deliveryId, delivery);
    return delivery;
  }

  private require(deliveryId: string): StoredDelivery {
    const delivery = this.deliveries.get(deliveryId);
    if (delivery === undefined) {
      throw new Error(`missing test delivery ${deliveryId}`);
    }
    return delivery;
  }
}

export class FakeQueue {
  readonly sent: QueueJob[] = [];
  fail = false;

  async send(body: QueueJob): Promise<void> {
    if (this.fail) {
      throw new Error("test queue failure");
    }
    this.sent.push(structuredClone(body));
  }
}

export function makeEnv(
  queue: FakeQueue,
  options: {
    githubSecret?: string;
    slackUrl?: string;
    alertsSlackUrl?: string;
    activitySlackUrl?: string;
    activityQueue?: FakeQueue;
    relaySigningSecret?: string;
    relaySigningSecretNext?: string;
    workerRevision?: string;
  } = {},
): Env {
  return {
    ALERT_QUEUE: queue as unknown as Queue,
    ACTIVITY_QUEUE: (options.activityQueue ?? queue) as unknown as Queue,
    DB: {} as D1Database,
    GITHUB_WEBHOOK_SECRET: (options.githubSecret ??
      TEST_WEBHOOK_SECRET) as unknown as SecretsStoreSecret,
    SLACK_ALERTS_WORKFLOW_WEBHOOK_URL: (options.alertsSlackUrl ??
      options.slackUrl ??
      TEST_SLACK_URL) as unknown as SecretsStoreSecret,
    SLACK_ACTIVITY_WORKFLOW_WEBHOOK_URL: (options.activitySlackUrl ??
      options.slackUrl ??
      TEST_SLACK_URL) as unknown as SecretsStoreSecret,
    SLACK_RELAY_SIGNING_SECRET: (options.relaySigningSecret ??
      TEST_RELAY_SIGNING_SECRET) as unknown as SecretsStoreSecret,
    SLACK_RELAY_SIGNING_SECRET_NEXT: (options.relaySigningSecretNext ??
      TEST_RELAY_SIGNING_SECRET_NEXT) as unknown as SecretsStoreSecret,
    SLACK_RELAY_SIGNING_ACTIVE_SLOT: "next",
    WORKER_VERSION: {
      id: "test-worker-version",
      tag: options.workerRevision ?? "a".repeat(40),
      timestamp: "2026-08-03T12:00:00.000Z",
    },
  };
}

export function sampleSlackPayload(deliveryId: string): SlackWorkflowPayload {
  return {
    source: "GitHub Actions",
    severity: "high",
    repository: "LCV-Ideas-Software/cross-review",
    title: "CI: failure",
    details: "Workflow CI completed with conclusion failure.",
    actor: "dependabot[bot]",
    branch: "dependabot/npm_and_yarn/example-1.0.0",
    url: "https://github.com/LCV-Ideas-Software/cross-review/actions/runs/1",
    occurred_at: "2026-08-03T12:00:00.000Z",
    delivery_id: deliveryId,
    event: "workflow_run",
    action: "completed",
    destination: "alerts",
    relay_attempt: "",
    relay_timestamp: "",
    relay_signature: "",
  };
}

export function fakeMessage(deliveryId: string): {
  message: Message<QueueJob>;
  ack: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
} {
  const ack = vi.fn();
  const retry = vi.fn();
  const message = {
    ack,
    attempts: 1,
    body: { deliveryId },
    id: `message-${deliveryId}`,
    retry,
    timestamp: new Date("2026-08-03T12:00:00.000Z"),
  } as unknown as Message<QueueJob>;

  return { message, ack, retry };
}

export function workflowPayload(
  conclusion: string = "failure",
): Record<string, unknown> {
  return {
    action: "completed",
    organization: { login: "LCV-Ideas-Software" },
    repository: {
      archived: false,
      full_name: "LCV-Ideas-Software/cross-review",
      owner: { login: "LCV-Ideas-Software" },
    },
    sender: { login: "dependabot[bot]" },
    workflow_run: {
      actor: { login: "dependabot[bot]" },
      conclusion,
      created_at: "2026-08-03T11:58:00Z",
      head_branch: "dependabot/npm_and_yarn/example-1.0.0",
      html_url:
        "https://github.com/LCV-Ideas-Software/cross-review/actions/runs/1",
      name: "CI",
      updated_at: "2026-08-03T12:00:00Z",
    },
  };
}

export async function signedRequest(
  event: string,
  deliveryId: string,
  payload: unknown,
  options: { secret?: string; rawBody?: string } = {},
): Promise<Request> {
  const rawBody = options.rawBody ?? JSON.stringify(payload);
  const body = new TextEncoder().encode(rawBody);
  const secret = options.secret ?? TEST_WEBHOOK_SECRET;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "HMAC" }, key, body),
  );
  const hexadecimal = [...signature]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  return new Request("https://relay.example/github/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Delivery": deliveryId,
      "X-GitHub-Event": event,
      "X-Hub-Signature-256": `sha256=${hexadecimal}`,
    },
    body,
  });
}
