import type { RelayDestination, SlackWorkflowPayload } from "./domain";

export type DeliveryStatus =
  | "pending"
  | "enqueueing"
  | "queued"
  | "sending"
  | "dead_letter"
  | "manual_review"
  | "accepted_by_slack"
  | "accepted_by_trigger"
  | "send_started"
  | "delivered";

export type SlackProgressPhase = "send_started" | "delivered";

export interface SlackProgressInput {
  deliveryId: string;
  destination: RelayDestination;
  phase: SlackProgressPhase;
  messageTs: string | null;
  attemptCount: number;
  functionExecutionId: string;
  now: number;
  reconcileAt: number;
}

export type SlackProgressResult = "recorded" | "duplicate";

export type SlackTraceOutcome = "pending" | "success" | "error";

export interface SlackTraceReconciliation {
  traceId: string;
  deliveryId: string;
  outcome: SlackTraceOutcome;
  attemptCount: number;
  sendExecutionId: string | null;
  sendBoundaryReached: boolean;
  preSendFailureProven: boolean;
  startedAtUs: number;
  completedAtUs: number | null;
}

export interface QueueJob {
  deliveryId: string;
}

export interface RecoveryClaim extends QueueJob {
  destination: RelayDestination;
}

export interface DeliveryInput {
  deliveryId: string;
  eventType: string;
  action: string;
  repository: string;
  destination: RelayDestination;
  payload: SlackWorkflowPayload;
  now: number;
}

export interface StoredDelivery {
  deliveryId: string;
  eventType: string;
  action: string;
  repository: string;
  destination: RelayDestination;
  payload: SlackWorkflowPayload;
  status: DeliveryStatus;
  attemptCount: number;
  nextAttemptAt: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  triggerAcceptedAt: number | null;
  sendStartedAt: number | null;
  deliveredAt: number | null;
  slackMessageTs: string | null;
  slackTraceId: string | null;
  slackSendExecutionId: string | null;
  legacyUnverified: boolean;
}

export const SLACK_DELIVERY_PROTOCOL_SCHEMA_REVISION =
  "0004_confirm_slack_delivery";
export const SLACK_ACTIVITY_CHECKPOINT_OVERLAP_US = 20 * 60 * 1_000 * 1_000;
export type SlackDeliveryProtocolActivationResult =
  "applied" | "already_applied";

export interface SlackDeliveryProtocolActivation {
  activationId: string;
  revision: string;
  schemaRevision: string;
  now: number;
}

export class SlackDeliveryProtocolActivationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackDeliveryProtocolActivationConflictError";
  }
}

export class SlackProgressConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackProgressConflictError";
  }
}

export class SlackReconciliationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackReconciliationConflictError";
  }
}

export interface DeliveryStore {
  isSlackDeliveryProtocolActive(expectedRevision: string): Promise<boolean>;
  activateSlackDeliveryProtocol(
    activation: SlackDeliveryProtocolActivation,
  ): Promise<SlackDeliveryProtocolActivationResult>;
  insert(input: DeliveryInput): Promise<boolean>;
  get(deliveryId: string): Promise<StoredDelivery | null>;
  markQueued(deliveryId: string, now: number): Promise<void>;
  markEnqueueFailed(
    deliveryId: string,
    now: number,
    nextAttemptAt: number,
    reason: string,
  ): Promise<void>;
  reserveSlackSlot(
    now: number,
    intervalMilliseconds: number,
    destination: RelayDestination,
  ): Promise<number>;
  extendSlackCooldown(until: number): Promise<void>;
  claimForSlack(
    deliveryId: string,
    now: number,
  ): Promise<StoredDelivery | null>;
  recordFailure(
    deliveryId: string,
    now: number,
    nextAttemptAt: number,
    reason: string,
  ): Promise<void>;
  markAcceptedByTrigger(
    deliveryId: string,
    now: number,
    reconcileAt: number,
  ): Promise<void>;
  recordSlackProgress(input: SlackProgressInput): Promise<SlackProgressResult>;
  markDeadLetter(
    deliveryId: string,
    now: number,
    nextAttemptAt: number,
    reason: string,
  ): Promise<void>;
  markManualReview(
    deliveryId: string,
    now: number,
    reason: string,
  ): Promise<void>;
  claimRecoverable(
    now: number,
    staleBefore: number,
    maximumAttempts: number,
    limit: number,
  ): Promise<RecoveryClaim[]>;
  recordSlackTrace(trace: SlackTraceReconciliation, now: number): Promise<void>;
  getSlackActivityCheckpoint(): Promise<number>;
  advanceSlackActivityCheckpoint(checkpointUs: number): Promise<number>;
  purgeDeliveredBefore(cutoff: number): Promise<number>;
  healthcheck(now: number, expectedRevision: string): Promise<boolean>;
  hasLegacyUnverifiedDebt(): Promise<boolean>;
}

interface DeliveryRow {
  delivery_id: string;
  event_type: string;
  action: string;
  repository: string;
  destination: RelayDestination;
  payload_json: string;
  status: DeliveryStatus;
  attempt_count: number;
  next_attempt_at: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  accepted_at: number | null;
  trigger_accepted_at: number | null;
  send_started_at: number | null;
  delivered_at: number | null;
  slack_message_ts: string | null;
  slack_trace_id: string | null;
  slack_send_execution_id: string | null;
  legacy_unverified: number;
}

interface RecoveryRow {
  delivery_id: string;
  destination: RelayDestination;
  status: DeliveryStatus;
  attempt_count: number;
  updated_at: number;
}

interface SlackDeliveryProtocolRow {
  slack_delivery_protocol_active: number;
  slack_delivery_protocol_revision: string | null;
  slack_delivery_protocol_activated_at: number | null;
  slack_delivery_protocol_activation_id: string | null;
  slack_delivery_protocol_schema_revision: string | null;
  slack_delivery_protocol_confirmation_open: number;
}

const WORKER_REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const ACTIVATION_ID_PATTERN = /^[0-9a-f]{64}$/u;
const SLACK_FUNCTION_EXECUTION_ID_PATTERN = /^Fx[A-Za-z0-9]{1,126}$/u;
const REQUIRED_PROTOCOL_SCHEMA_ARTIFACTS = 7;

function changed(result: D1Result<unknown>): boolean {
  return (result.meta.changes ?? 0) > 0;
}

function safeFailureReason(reason: string): string {
  const compact = reason.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").trim();
  return compact.slice(0, 200) || "unspecified_failure";
}

function retryableTriggerAmbiguityReason(reason: string | null): boolean {
  return (
    reason !== null &&
    ([
      "slack_trigger_request_outcome_ambiguous",
      "slack_trigger_success_confirmation_ambiguous",
      "slack_trigger_http_408_ambiguous",
      "replayed_slack_trigger_attempt_ambiguous",
      "stale_slack_trigger_attempt_ambiguous",
      "dead_letter_slack_trigger_attempt_ambiguous",
    ].includes(reason) ||
      /^slack_trigger_http_5\d\d_ambiguous$/u.test(reason))
  );
}

function fromRow(row: DeliveryRow): StoredDelivery {
  return {
    deliveryId: row.delivery_id,
    eventType: row.event_type,
    action: row.action,
    repository: row.repository,
    destination: row.destination,
    payload: JSON.parse(row.payload_json) as SlackWorkflowPayload,
    status: row.status,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    triggerAcceptedAt: row.trigger_accepted_at ?? row.accepted_at,
    sendStartedAt: row.send_started_at,
    deliveredAt: row.delivered_at,
    slackMessageTs: row.slack_message_ts,
    slackTraceId: row.slack_trace_id,
    slackSendExecutionId: row.slack_send_execution_id,
    legacyUnverified: row.legacy_unverified === 1,
  };
}

export class D1DeliveryStore implements DeliveryStore {
  readonly #database: D1Database;

  constructor(database: D1Database) {
    this.#database = database;
  }

  async isSlackDeliveryProtocolActive(
    expectedRevision: string,
  ): Promise<boolean> {
    if (!WORKER_REVISION_PATTERN.test(expectedRevision)) {
      return false;
    }
    const state = await this.#database
      .prepare(
        `SELECT slack_delivery_protocol_active,
                slack_delivery_protocol_revision,
                slack_delivery_protocol_activated_at,
                slack_delivery_protocol_activation_id,
                slack_delivery_protocol_schema_revision,
                slack_delivery_protocol_confirmation_open
         FROM relay_state
         WHERE singleton_id = 1`,
      )
      .first<SlackDeliveryProtocolRow>();
    if (state === null) {
      throw new Error("slack_delivery_protocol_state_missing");
    }

    if (state.slack_delivery_protocol_active === 0) {
      if (
        state.slack_delivery_protocol_revision !== null ||
        state.slack_delivery_protocol_activated_at !== null ||
        state.slack_delivery_protocol_activation_id !== null ||
        state.slack_delivery_protocol_schema_revision !== null ||
        state.slack_delivery_protocol_confirmation_open !== 1
      ) {
        throw new Error("slack_delivery_protocol_state_inconsistent");
      }
      return false;
    }

    if (
      state.slack_delivery_protocol_active !== 1 ||
      state.slack_delivery_protocol_revision === null ||
      !WORKER_REVISION_PATTERN.test(state.slack_delivery_protocol_revision) ||
      !Number.isSafeInteger(state.slack_delivery_protocol_activated_at) ||
      (state.slack_delivery_protocol_activated_at as number) <= 0 ||
      state.slack_delivery_protocol_activation_id === null ||
      !ACTIVATION_ID_PATTERN.test(
        state.slack_delivery_protocol_activation_id,
      ) ||
      state.slack_delivery_protocol_schema_revision !==
        SLACK_DELIVERY_PROTOCOL_SCHEMA_REVISION ||
      (state.slack_delivery_protocol_confirmation_open !== 0 &&
        state.slack_delivery_protocol_confirmation_open !== 1)
    ) {
      throw new Error("slack_delivery_protocol_state_inconsistent");
    }
    return state.slack_delivery_protocol_revision === expectedRevision;
  }

  async activateSlackDeliveryProtocol(
    activation: SlackDeliveryProtocolActivation,
  ): Promise<SlackDeliveryProtocolActivationResult> {
    if (
      !ACTIVATION_ID_PATTERN.test(activation.activationId) ||
      !WORKER_REVISION_PATTERN.test(activation.revision) ||
      activation.schemaRevision !== SLACK_DELIVERY_PROTOCOL_SCHEMA_REVISION ||
      !Number.isSafeInteger(activation.now) ||
      activation.now <= 0
    ) {
      throw new SlackDeliveryProtocolActivationConflictError(
        "invalid_slack_delivery_protocol_activation",
      );
    }

    const schema = await this.#database
      .prepare(
        `SELECT COUNT(*) AS artifact_count
         FROM sqlite_master
         WHERE (
           type = 'table'
           AND name IN (
             'slack_workflow_traces',
             'slack_delivery_recovery_audit'
           )
         ) OR (
           type = 'trigger'
           AND name IN (
             'quarantine_old_worker_acceptance',
             'validate_known_slack_delivery_recovery',
             'release_known_slack_delivery_recovery',
             'enforce_one_way_slack_delivery_protocol_activation',
             'enforce_one_way_slack_delivery_protocol_confirmation'
           )
         )`,
      )
      .first<{ artifact_count: number }>();
    if (schema?.artifact_count !== REQUIRED_PROTOCOL_SCHEMA_ARTIFACTS) {
      throw new SlackDeliveryProtocolActivationConflictError(
        "slack_delivery_protocol_schema_incomplete",
      );
    }

    const activated = await this.#database
      .prepare(
        `UPDATE relay_state
         SET slack_delivery_protocol_active = 1,
             slack_delivery_protocol_revision = ?,
             slack_delivery_protocol_activated_at = ?,
             slack_delivery_protocol_activation_id = ?,
             slack_delivery_protocol_schema_revision = ?
         WHERE singleton_id = 1
           AND slack_delivery_protocol_active = 0
           AND slack_delivery_protocol_revision IS NULL
           AND slack_delivery_protocol_activated_at IS NULL
           AND slack_delivery_protocol_activation_id IS NULL
           AND slack_delivery_protocol_schema_revision IS NULL
           AND slack_delivery_protocol_confirmation_open = 1
         RETURNING slack_delivery_protocol_active,
                   slack_delivery_protocol_revision,
                   slack_delivery_protocol_activated_at,
                   slack_delivery_protocol_activation_id,
                   slack_delivery_protocol_schema_revision,
                   slack_delivery_protocol_confirmation_open`,
      )
      .bind(
        activation.revision,
        activation.now,
        activation.activationId,
        activation.schemaRevision,
      )
      .first<SlackDeliveryProtocolRow>();
    if (activated !== null) {
      if (
        activated.slack_delivery_protocol_active !== 1 ||
        activated.slack_delivery_protocol_revision !== activation.revision ||
        activated.slack_delivery_protocol_activated_at !== activation.now ||
        activated.slack_delivery_protocol_activation_id !==
          activation.activationId ||
        activated.slack_delivery_protocol_schema_revision !==
          activation.schemaRevision ||
        activated.slack_delivery_protocol_confirmation_open !== 1
      ) {
        throw new SlackDeliveryProtocolActivationConflictError(
          "slack_delivery_protocol_activation_conflict",
        );
      }
      return "applied";
    }

    const existing = await this.#database
      .prepare(
        `SELECT slack_delivery_protocol_active,
                slack_delivery_protocol_revision,
                slack_delivery_protocol_activated_at,
                slack_delivery_protocol_activation_id,
                slack_delivery_protocol_schema_revision,
                slack_delivery_protocol_confirmation_open
         FROM relay_state
         WHERE singleton_id = 1`,
      )
      .first<SlackDeliveryProtocolRow>();
    if (
      existing === null ||
      existing.slack_delivery_protocol_active !== 1 ||
      existing.slack_delivery_protocol_revision !== activation.revision ||
      existing.slack_delivery_protocol_activation_id !==
        activation.activationId ||
      existing.slack_delivery_protocol_schema_revision !==
        activation.schemaRevision ||
      existing.slack_delivery_protocol_confirmation_open !== 1 ||
      !Number.isSafeInteger(existing.slack_delivery_protocol_activated_at) ||
      (existing.slack_delivery_protocol_activated_at as number) <= 0
    ) {
      throw new SlackDeliveryProtocolActivationConflictError(
        "slack_delivery_protocol_activation_conflict",
      );
    }
    return "already_applied";
  }

  async insert(input: DeliveryInput): Promise<boolean> {
    const result = await this.#database
      .prepare(
        `INSERT INTO deliveries (
          delivery_id,
          event_type,
          action,
          repository,
          destination,
          payload_json,
          status,
          attempt_count,
          next_attempt_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
        ON CONFLICT(delivery_id) DO NOTHING`,
      )
      .bind(
        input.deliveryId,
        input.eventType,
        input.action,
        input.repository,
        input.destination,
        JSON.stringify(input.payload),
        input.now,
        input.now,
        input.now,
      )
      .run();

    return changed(result);
  }

  async get(deliveryId: string): Promise<StoredDelivery | null> {
    const row = await this.#database
      .prepare("SELECT * FROM deliveries WHERE delivery_id = ?")
      .bind(deliveryId)
      .first<DeliveryRow>();

    return row === null ? null : fromRow(row);
  }

  async markQueued(deliveryId: string, now: number): Promise<void> {
    await this.#database
      .prepare(
        `UPDATE deliveries
         SET status = 'queued', updated_at = ?, last_error = NULL
         WHERE delivery_id = ? AND status IN ('pending', 'enqueueing')`,
      )
      .bind(now, deliveryId)
      .run();
  }

  async markEnqueueFailed(
    deliveryId: string,
    now: number,
    nextAttemptAt: number,
    reason: string,
  ): Promise<void> {
    await this.#database
      .prepare(
        `UPDATE deliveries
         SET status = 'pending', updated_at = ?, next_attempt_at = ?, last_error = ?
         WHERE delivery_id = ?
           AND status NOT IN (
             'accepted_by_slack', 'accepted_by_trigger', 'send_started',
             'delivered', 'manual_review'
           )`,
      )
      .bind(now, nextAttemptAt, safeFailureReason(reason), deliveryId)
      .run();
  }

  async reserveSlackSlot(
    now: number,
    intervalMilliseconds: number,
    destination: RelayDestination,
  ): Promise<number> {
    const nextSlackAt = now + intervalMilliseconds;
    const reservation = await this.#database
      .prepare(
        `UPDATE relay_state
         SET next_slack_at = ?
         WHERE singleton_id = 1
           AND next_slack_at <= ?
           AND (
             ? = 'alerts'
             OR NOT EXISTS (
               SELECT 1
               FROM deliveries
               WHERE destination = 'alerts'
                 AND (
                   status IN ('enqueueing', 'queued', 'sending')
                   OR (status IN ('pending', 'dead_letter') AND next_attempt_at <= ?)
                 )
             )
           )`,
      )
      .bind(nextSlackAt, now, destination, now)
      .run();

    if (changed(reservation)) {
      return 0;
    }

    const current = await this.#database
      .prepare("SELECT next_slack_at FROM relay_state WHERE singleton_id = 1")
      .first<{ next_slack_at: number }>();

    if (current === null) {
      throw new Error("relay_state_missing");
    }

    if (destination === "activity" && current.next_slack_at <= now) {
      return 1_000;
    }

    return Math.max(1, current.next_slack_at - now);
  }

  async extendSlackCooldown(until: number): Promise<void> {
    await this.#database
      .prepare(
        `UPDATE relay_state
         SET next_slack_at = MAX(next_slack_at, ?)
         WHERE singleton_id = 1`,
      )
      .bind(until)
      .run();
  }

  async claimForSlack(
    deliveryId: string,
    now: number,
  ): Promise<StoredDelivery | null> {
    const row = await this.#database
      .prepare(
        `UPDATE deliveries
         SET status = 'sending', attempt_count = attempt_count + 1,
             updated_at = ?, slack_send_execution_id = NULL
         WHERE delivery_id = ?
           AND status IN ('pending', 'enqueueing', 'queued', 'dead_letter')
           AND next_attempt_at <= ?
         RETURNING *`,
      )
      .bind(now, deliveryId, now)
      .first<DeliveryRow>();

    return row === null ? null : fromRow(row);
  }

  async recordFailure(
    deliveryId: string,
    now: number,
    nextAttemptAt: number,
    reason: string,
  ): Promise<void> {
    await this.#database
      .prepare(
        `UPDATE deliveries
         SET status = 'pending', updated_at = ?, next_attempt_at = ?, last_error = ?
         WHERE delivery_id = ? AND status = 'sending'`,
      )
      .bind(now, nextAttemptAt, safeFailureReason(reason), deliveryId)
      .run();
  }

  async markAcceptedByTrigger(
    deliveryId: string,
    now: number,
    reconcileAt: number,
  ): Promise<void> {
    const result = await this.#database
      .prepare(
        `UPDATE deliveries
         SET status = 'accepted_by_trigger', updated_at = ?,
             trigger_accepted_at = ?, next_attempt_at = ?, last_error = NULL
         WHERE delivery_id = ? AND status = 'sending'`,
      )
      .bind(now, now, reconcileAt, deliveryId)
      .run();

    if (!changed(result)) {
      const existing = await this.get(deliveryId);
      if (
        existing?.status !== "accepted_by_slack" &&
        existing?.status !== "send_started" &&
        existing?.status !== "delivered"
      ) {
        throw new Error("delivery_state_changed_before_trigger_acceptance");
      }
      await this.#database
        .prepare(
          `UPDATE deliveries
           SET trigger_accepted_at = COALESCE(trigger_accepted_at, ?),
               next_attempt_at = CASE
                 WHEN status = 'send_started'
                   THEN MAX(next_attempt_at, ?)
                 ELSE next_attempt_at
               END
           WHERE delivery_id = ? AND status IN ('send_started', 'delivered')`,
        )
        .bind(now, reconcileAt, deliveryId)
        .run();
    }
  }

  async recordSlackProgress(
    input: SlackProgressInput,
  ): Promise<SlackProgressResult> {
    const existing = await this.get(input.deliveryId);
    if (existing === null) {
      throw new SlackProgressConflictError("delivery_not_found");
    }
    if (existing.destination !== input.destination) {
      throw new SlackProgressConflictError("delivery_destination_mismatch");
    }
    if (
      !Number.isSafeInteger(input.attemptCount) ||
      input.attemptCount <= 0 ||
      existing.attemptCount !== input.attemptCount
    ) {
      throw new SlackProgressConflictError("slack_delivery_attempt_conflict");
    }
    if (!SLACK_FUNCTION_EXECUTION_ID_PATTERN.test(input.functionExecutionId)) {
      throw new SlackProgressConflictError("invalid_slack_function_execution");
    }

    if (input.phase === "send_started") {
      if (
        existing.status === "send_started" ||
        existing.status === "delivered"
      ) {
        if (existing.slackSendExecutionId === input.functionExecutionId) {
          return "duplicate";
        }
        throw new SlackProgressConflictError("slack_send_execution_conflict");
      }
      if (
        existing.status !== "sending" &&
        existing.status !== "accepted_by_slack" &&
        existing.status !== "accepted_by_trigger" &&
        !(
          existing.status === "manual_review" &&
          retryableTriggerAmbiguityReason(existing.lastError)
        )
      ) {
        throw new SlackProgressConflictError(
          "delivery_not_awaiting_slack_progress",
        );
      }

      const result = await this.#database
        .prepare(
          `UPDATE deliveries
           SET status = 'send_started', updated_at = ?, send_started_at = ?,
               next_attempt_at = ?, last_error = NULL, legacy_unverified = 0,
               slack_trace_id = NULL, slack_send_execution_id = ?
           WHERE delivery_id = ? AND destination = ?
             AND attempt_count = ?
             AND (
               status IN ('sending', 'accepted_by_slack', 'accepted_by_trigger')
               OR (
                 status = 'manual_review'
                 AND (
                   last_error IN (
                     'slack_trigger_request_outcome_ambiguous',
                     'slack_trigger_success_confirmation_ambiguous',
                     'slack_trigger_http_408_ambiguous',
                     'replayed_slack_trigger_attempt_ambiguous',
                     'stale_slack_trigger_attempt_ambiguous',
                     'dead_letter_slack_trigger_attempt_ambiguous'
                   )
                   OR last_error GLOB 'slack_trigger_http_5[0-9][0-9]_ambiguous'
                 )
               )
             )`,
        )
        .bind(
          input.now,
          input.now,
          input.reconcileAt,
          input.functionExecutionId,
          input.deliveryId,
          input.destination,
          input.attemptCount,
        )
        .run();
      if (!changed(result)) {
        const current = await this.get(input.deliveryId);
        if (
          current?.destination === input.destination &&
          current.attemptCount === input.attemptCount &&
          (current.status === "send_started" ||
            current.status === "delivered") &&
          current.slackSendExecutionId === input.functionExecutionId
        ) {
          return "duplicate";
        }
        throw new SlackProgressConflictError(
          "delivery_state_changed_before_progress_recorded",
        );
      }
      return "recorded";
    }

    if (input.messageTs === null) {
      throw new SlackProgressConflictError("slack_message_timestamp_missing");
    }
    if (
      existing.status === "manual_review" &&
      existing.lastError === "known_slack_workflow_timeout_message_absent"
    ) {
      throw new SlackProgressConflictError(
        "known_loss_recovery_authorization_required",
      );
    }
    if (existing.status === "delivered") {
      if (existing.slackMessageTs === input.messageTs) {
        return "duplicate";
      }
      throw new SlackProgressConflictError("slack_message_timestamp_conflict");
    }
    if (
      existing.status !== "sending" &&
      existing.status !== "accepted_by_slack" &&
      existing.status !== "accepted_by_trigger" &&
      existing.status !== "send_started" &&
      existing.status !== "manual_review"
    ) {
      throw new SlackProgressConflictError(
        "delivery_not_awaiting_slack_progress",
      );
    }

    let result: D1Result<unknown>;
    try {
      result = await this.#database
        .prepare(
          `UPDATE deliveries
           SET status = 'delivered', updated_at = ?, delivered_at = ?,
               slack_message_ts = ?, next_attempt_at = ?, last_error = NULL,
               legacy_unverified = 0
           WHERE delivery_id = ? AND destination = ?
             AND attempt_count = ?
             AND slack_send_execution_id IS NOT NULL
             AND status IN (
               'sending', 'accepted_by_slack', 'accepted_by_trigger',
               'send_started', 'manual_review'
             )`,
        )
        .bind(
          input.now,
          input.now,
          input.messageTs,
          input.now,
          input.deliveryId,
          input.destination,
          input.attemptCount,
        )
        .run();
    } catch (error) {
      const current = await this.get(input.deliveryId);
      if (
        current?.destination === input.destination &&
        current.status === "delivered" &&
        current.slackMessageTs === input.messageTs
      ) {
        return "duplicate";
      }
      const owner = await this.#database
        .prepare(
          `SELECT delivery_id
           FROM deliveries
           WHERE destination = ? AND slack_message_ts = ?
           LIMIT 1`,
        )
        .bind(input.destination, input.messageTs)
        .first<{ delivery_id: string }>();
      if (owner !== null && owner.delivery_id !== input.deliveryId) {
        throw new SlackProgressConflictError(
          "slack_message_timestamp_conflict",
        );
      }
      throw error;
    }
    if (!changed(result)) {
      const current = await this.get(input.deliveryId);
      if (
        current?.destination === input.destination &&
        current.status === "delivered" &&
        current.slackMessageTs === input.messageTs
      ) {
        return "duplicate";
      }
      throw new SlackProgressConflictError(
        "delivery_state_changed_before_progress_recorded",
      );
    }
    return "recorded";
  }

  async markDeadLetter(
    deliveryId: string,
    now: number,
    nextAttemptAt: number,
    reason: string,
  ): Promise<void> {
    await this.#database
      .prepare(
        `UPDATE deliveries
         SET status = 'dead_letter', updated_at = ?, next_attempt_at = ?, last_error = ?
         WHERE delivery_id = ?
           AND status NOT IN (
             'accepted_by_slack', 'accepted_by_trigger', 'send_started',
             'delivered', 'manual_review'
           )`,
      )
      .bind(now, nextAttemptAt, safeFailureReason(reason), deliveryId)
      .run();
  }

  async markManualReview(
    deliveryId: string,
    now: number,
    reason: string,
  ): Promise<void> {
    await this.#database
      .prepare(
        `UPDATE deliveries
         SET status = 'manual_review', updated_at = ?, last_error = ?
         WHERE delivery_id = ? AND status != 'delivered'`,
      )
      .bind(now, safeFailureReason(reason), deliveryId)
      .run();
  }

  async claimRecoverable(
    now: number,
    staleBefore: number,
    maximumAttempts: number,
    limit: number,
  ): Promise<RecoveryClaim[]> {
    const result = await this.#database
      .prepare(
        `SELECT delivery_id, destination, status, attempt_count, updated_at
         FROM deliveries
         WHERE (
           (status IN ('pending', 'dead_letter') AND next_attempt_at <= ?)
           OR (status IN ('enqueueing', 'queued', 'sending') AND updated_at <= ?)
         )
         ORDER BY next_attempt_at ASC, created_at ASC
         LIMIT ?`,
      )
      .bind(now, staleBefore, limit)
      .all<RecoveryRow>();

    const claimed: RecoveryClaim[] = [];

    for (const row of result.results) {
      if (row.status === "sending") {
        await this.markManualReview(
          row.delivery_id,
          now,
          "stale_slack_trigger_attempt_ambiguous",
        );
        continue;
      }
      if (row.attempt_count >= maximumAttempts) {
        await this.markManualReview(
          row.delivery_id,
          now,
          "maximum_delivery_attempts_reached",
        );
        continue;
      }

      const update = await this.#database
        .prepare(
          `UPDATE deliveries
           SET status = 'enqueueing', updated_at = ?, next_attempt_at = ?
           WHERE delivery_id = ? AND status = ? AND updated_at = ?`,
        )
        .bind(now, now, row.delivery_id, row.status, row.updated_at)
        .run();

      if (changed(update)) {
        claimed.push({
          deliveryId: row.delivery_id,
          destination: row.destination,
        });
      }
    }

    return claimed;
  }

  async recordSlackTrace(
    trace: SlackTraceReconciliation,
    now: number,
  ): Promise<void> {
    if (
      !Number.isSafeInteger(trace.attemptCount) ||
      trace.attemptCount <= 0 ||
      (trace.sendExecutionId !== null &&
        !SLACK_FUNCTION_EXECUTION_ID_PATTERN.test(trace.sendExecutionId)) ||
      (trace.preSendFailureProven && trace.sendExecutionId === null)
    ) {
      throw new SlackReconciliationConflictError("invalid_slack_trace_attempt");
    }
    if (trace.outcome !== "pending" && trace.completedAtUs === null) {
      throw new SlackReconciliationConflictError(
        "terminal_slack_trace_missing_completion",
      );
    }

    const delivery = await this.get(trace.deliveryId);
    if (delivery === null) {
      throw new SlackReconciliationConflictError("delivery_not_found");
    }

    const existingTrace = await this.#database
      .prepare(
        `SELECT delivery_id, outcome, relay_attempt, send_execution_id,
                send_boundary_reached, pre_send_failure_proven, applied_at
         FROM slack_workflow_traces
         WHERE trace_id = ?`,
      )
      .bind(trace.traceId)
      .first<{
        delivery_id: string;
        outcome: SlackTraceOutcome;
        relay_attempt: number;
        send_execution_id: string | null;
        send_boundary_reached: number;
        pre_send_failure_proven: number;
        applied_at: number | null;
      }>();
    if (
      existingTrace !== null &&
      existingTrace.delivery_id !== trace.deliveryId
    ) {
      throw new SlackReconciliationConflictError(
        "slack_trace_delivery_conflict",
      );
    }
    if (
      existingTrace !== null &&
      existingTrace.outcome !== "pending" &&
      existingTrace.outcome !== trace.outcome
    ) {
      throw new SlackReconciliationConflictError(
        "slack_trace_outcome_conflict",
      );
    }
    if (
      existingTrace !== null &&
      existingTrace.relay_attempt !== trace.attemptCount
    ) {
      throw new SlackReconciliationConflictError(
        "slack_trace_attempt_conflict",
      );
    }
    if (
      existingTrace?.send_execution_id !== null &&
      existingTrace?.send_execution_id !== undefined &&
      trace.sendExecutionId !== null &&
      existingTrace.send_execution_id !== trace.sendExecutionId
    ) {
      throw new SlackReconciliationConflictError(
        "slack_trace_send_execution_conflict",
      );
    }
    await this.#database
      .prepare(
        `INSERT INTO slack_workflow_traces (
           trace_id,
           delivery_id,
           outcome,
           relay_attempt,
           send_execution_id,
           send_boundary_reached,
           pre_send_failure_proven,
           started_at_us,
           completed_at_us,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(trace_id) DO UPDATE SET
           applied_at = CASE
             WHEN (
               slack_workflow_traces.outcome = 'pending'
               AND excluded.outcome != 'pending'
             )
             OR (
               slack_workflow_traces.send_execution_id IS NULL
               AND excluded.send_execution_id IS NOT NULL
             )
             OR (
               slack_workflow_traces.send_boundary_reached = 0
               AND excluded.send_boundary_reached = 1
             )
             OR (
               slack_workflow_traces.pre_send_failure_proven = 0
               AND MAX(
                 slack_workflow_traces.send_boundary_reached,
                 excluded.send_boundary_reached
               ) = 0
               AND excluded.pre_send_failure_proven = 1
             )
             THEN NULL
             ELSE slack_workflow_traces.applied_at
           END,
           outcome = excluded.outcome,
           send_execution_id = COALESCE(
             slack_workflow_traces.send_execution_id,
             excluded.send_execution_id
           ),
           send_boundary_reached = MAX(
             slack_workflow_traces.send_boundary_reached,
             excluded.send_boundary_reached
           ),
           pre_send_failure_proven = CASE
             WHEN MAX(
               slack_workflow_traces.send_boundary_reached,
               excluded.send_boundary_reached
             ) = 1 THEN 0
             ELSE MAX(
               slack_workflow_traces.pre_send_failure_proven,
               excluded.pre_send_failure_proven
             )
           END,
           started_at_us = MIN(
             slack_workflow_traces.started_at_us,
             excluded.started_at_us
           ),
           completed_at_us = COALESCE(
             excluded.completed_at_us,
             slack_workflow_traces.completed_at_us
           ),
           updated_at = excluded.updated_at`,
      )
      .bind(
        trace.traceId,
        trace.deliveryId,
        trace.outcome,
        trace.attemptCount,
        trace.sendExecutionId,
        trace.sendBoundaryReached ? 1 : 0,
        trace.preSendFailureProven ? 1 : 0,
        trace.startedAtUs,
        trace.completedAtUs,
        now,
      )
      .run();

    if (trace.outcome === "pending") {
      return;
    }

    const effectiveTrace = await this.#database
      .prepare(
        `SELECT outcome, send_execution_id, send_boundary_reached,
                pre_send_failure_proven
         FROM slack_workflow_traces
         WHERE trace_id = ?`,
      )
      .bind(trace.traceId)
      .first<{
        outcome: SlackTraceOutcome;
        send_execution_id: string | null;
        send_boundary_reached: number;
        pre_send_failure_proven: number;
      }>();
    if (effectiveTrace === null) {
      throw new Error("slack_trace_persistence_failed");
    }
    const sendBoundaryReached = effectiveTrace.send_boundary_reached === 1;
    const preSendFailureProven = effectiveTrace.pre_send_failure_proven === 1;
    const sendExecutionId = effectiveTrace.send_execution_id;
    const appliedTraceGainedEvidence =
      existingTrace !== null &&
      ((existingTrace.outcome === "pending" &&
        effectiveTrace.outcome !== "pending") ||
        (existingTrace.send_execution_id === null &&
          sendExecutionId !== null) ||
        (existingTrace.send_boundary_reached === 0 && sendBoundaryReached) ||
        (existingTrace.pre_send_failure_proven === 0 && preSendFailureProven));
    if (
      existingTrace !== null &&
      existingTrace.applied_at !== null &&
      !appliedTraceGainedEvidence
    ) {
      return;
    }

    const current = await this.get(trace.deliveryId);
    if (current === null) {
      throw new SlackReconciliationConflictError("delivery_not_found");
    }

    const sameTraceMayReleaseMissingProof =
      current.slackTraceId === trace.traceId &&
      current.status === "manual_review" &&
      current.lastError === "slack_workflow_failed_without_pre_send_proof" &&
      preSendFailureProven;
    if (
      current.slackTraceId === trace.traceId &&
      !sendBoundaryReached &&
      trace.outcome === "error" &&
      !sameTraceMayReleaseMissingProof
    ) {
      await this.#markSlackTraceApplied(trace.traceId, now);
      return;
    }

    if (current.status === "delivered") {
      if (
        current.attemptCount === trace.attemptCount &&
        current.slackSendExecutionId !== null &&
        current.slackSendExecutionId === sendExecutionId &&
        (trace.outcome === "success" || sendBoundaryReached)
      ) {
        await this.#applySlackTraceResolution(
          this.#database
            .prepare(
              `UPDATE deliveries
               SET slack_trace_id = ?, updated_at = ?
               WHERE delivery_id = ?
                 AND status = 'delivered'
                 AND attempt_count = ?
                 AND slack_send_execution_id = ?
                 AND (slack_trace_id IS NULL OR slack_trace_id = ?)`,
            )
            .bind(
              trace.traceId,
              now,
              trace.deliveryId,
              trace.attemptCount,
              sendExecutionId,
              trace.traceId,
            ),
          trace,
          now,
        );
        return;
      }
      await this.#markSlackTraceApplied(trace.traceId, now);
      return;
    }

    if (current.attemptCount !== trace.attemptCount) {
      await this.#markSlackTraceApplied(trace.traceId, now);
      return;
    }
    if (
      current.slackSendExecutionId !== null &&
      current.slackSendExecutionId !== sendExecutionId
    ) {
      await this.#markSlackTraceApplied(trace.traceId, now);
      return;
    }

    if (trace.outcome === "success") {
      await this.#resolveSuccessfulSlackTrace(trace, now, sendExecutionId);
      return;
    }

    const mayHaveSent =
      sendBoundaryReached ||
      (!preSendFailureProven &&
        (current.status === "send_started" || current.legacyUnverified));
    if (mayHaveSent) {
      await this.#resolveSlackTraceAsManualReview(
        trace,
        trace.deliveryId,
        now,
        "slack_workflow_failed_after_send_boundary",
        sendExecutionId,
        sendBoundaryReached,
      );
      return;
    }

    if (!preSendFailureProven) {
      await this.#resolveSlackTraceAsManualReview(
        trace,
        trace.deliveryId,
        now,
        "slack_workflow_failed_without_pre_send_proof",
        sendExecutionId,
        false,
      );
      return;
    }

    const retryStatement = this.#database
      .prepare(
        `UPDATE deliveries
         SET status = 'pending', updated_at = ?, next_attempt_at = ?,
             last_error = 'slack_workflow_failed_before_send_boundary',
             slack_trace_id = ?, slack_send_execution_id = NULL,
             legacy_unverified = 0
         WHERE delivery_id = ?
           AND (
             status IN (
               'accepted_by_slack', 'accepted_by_trigger', 'send_started'
             )
             OR (
               status = 'manual_review'
               AND (
                  last_error IN (
                    'slack_trigger_request_outcome_ambiguous',
                   'slack_trigger_success_confirmation_ambiguous',
                   'slack_trigger_http_408_ambiguous',
                   'replayed_slack_trigger_attempt_ambiguous',
                   'stale_slack_trigger_attempt_ambiguous',
                   'dead_letter_slack_trigger_attempt_ambiguous'
                  )
                  OR last_error GLOB 'slack_trigger_http_5[0-9][0-9]_ambiguous'
                  OR (
                    last_error = 'slack_workflow_failed_without_pre_send_proof'
                    AND slack_trace_id = ?
                  )
                )
             )
           )
           AND attempt_count = ?
           AND (
             slack_send_execution_id IS NULL
             OR slack_send_execution_id = ?
           )`,
      )
      .bind(
        now,
        now,
        trace.traceId,
        trace.deliveryId,
        trace.traceId,
        trace.attemptCount,
        sendExecutionId,
      );
    await this.#applySlackTraceResolution(retryStatement, trace, now);
  }

  async #resolveSlackTraceAsManualReview(
    trace: SlackTraceReconciliation,
    deliveryId: string,
    now: number,
    reason: string,
    sendExecutionId: string | null,
    attachIfDelivered: boolean,
  ): Promise<void> {
    await this.#applySlackTraceResolution(
      this.#database
        .prepare(
          `UPDATE deliveries
           SET status = CASE
                 WHEN status = 'delivered' THEN status
                 ELSE 'manual_review'
               END,
               updated_at = ?,
               last_error = CASE
                 WHEN status = 'delivered' THEN last_error
                 ELSE ?
               END,
               slack_trace_id = ?
           WHERE delivery_id = ?
             AND attempt_count = ?
             AND (
               slack_send_execution_id IS NULL
               OR slack_send_execution_id = ?
             )
             AND (
               status != 'delivered'
               OR (
                 ? = 1
                 AND (slack_trace_id IS NULL OR slack_trace_id = ?)
               )
             )`,
        )
        .bind(
          now,
          safeFailureReason(reason),
          trace.traceId,
          deliveryId,
          trace.attemptCount,
          sendExecutionId,
          attachIfDelivered ? 1 : 0,
          trace.traceId,
        ),
      trace,
      now,
    );
  }

  async #resolveSuccessfulSlackTrace(
    trace: SlackTraceReconciliation,
    now: number,
    sendExecutionId: string | null,
  ): Promise<void> {
    await this.#applySlackTraceResolution(
      this.#database
        .prepare(
          `UPDATE deliveries
           SET status = CASE
                 WHEN status = 'delivered' THEN status
                 WHEN status = 'accepted_by_slack'
                   AND legacy_unverified = 1
                   AND (slack_trace_id IS NULL OR slack_trace_id = ?)
                   THEN status
                 ELSE 'manual_review'
               END,
               last_error = CASE
                 WHEN status = 'delivered' THEN last_error
                 WHEN status = 'accepted_by_slack'
                   AND legacy_unverified = 1
                   AND (slack_trace_id IS NULL OR slack_trace_id = ?)
                   THEN last_error
                 WHEN status = 'accepted_by_slack'
                   AND legacy_unverified = 1
                   THEN 'slack_legacy_trace_conflict'
                 ELSE 'slack_workflow_succeeded_without_authenticated_receipt'
               END,
               slack_trace_id = CASE
                 WHEN status = 'accepted_by_slack'
                   AND legacy_unverified = 1
                   AND slack_trace_id IS NOT NULL
                   AND slack_trace_id != ?
                   THEN slack_trace_id
                 ELSE ?
               END,
               updated_at = ?
           WHERE delivery_id = ?
             AND attempt_count = ?
             AND (
               slack_send_execution_id IS NULL
               OR slack_send_execution_id = ?
             )
             AND (
               status != 'delivered'
               OR (slack_trace_id IS NULL OR slack_trace_id = ?)
             )`,
        )
        .bind(
          trace.traceId,
          trace.traceId,
          trace.traceId,
          trace.traceId,
          now,
          trace.deliveryId,
          trace.attemptCount,
          sendExecutionId,
          trace.traceId,
        ),
      trace,
      now,
    );
  }

  async #applySlackTraceResolution(
    mutation: D1PreparedStatement,
    trace: SlackTraceReconciliation,
    now: number,
  ): Promise<boolean> {
    const canAttachToDelivered =
      trace.outcome === "success" || trace.sendBoundaryReached;
    const appliedStatement = this.#database
      .prepare(
        `UPDATE slack_workflow_traces
         SET applied_at = COALESCE(applied_at, ?), updated_at = ?
         WHERE trace_id = ?
           AND EXISTS (
             SELECT 1
             FROM deliveries
             WHERE delivery_id = ?
               AND (
                 attempt_count != ?
                 OR (
                   slack_send_execution_id IS NOT NULL
                   AND (
                     ? IS NULL
                     OR slack_send_execution_id != ?
                   )
                 )
                 OR (
                   status = 'delivered'
                   AND (
                     ? = 0
                     OR slack_trace_id = ?
                   )
                 )
                 OR status = 'manual_review'
                 OR (
                   status IN ('pending', 'enqueueing', 'queued', 'dead_letter')
                   AND slack_trace_id = ?
                 )
                 OR (
                   status = 'accepted_by_slack'
                   AND legacy_unverified = 1
                   AND ? = 'success'
                   AND slack_trace_id = ?
                 )
               )
           )`,
      )
      .bind(
        now,
        now,
        trace.traceId,
        trace.deliveryId,
        trace.attemptCount,
        trace.sendExecutionId,
        trace.sendExecutionId,
        canAttachToDelivered ? 1 : 0,
        trace.traceId,
        trace.traceId,
        trace.outcome,
        trace.traceId,
      );
    const [resolution, applied] = await this.#database.batch([
      mutation,
      appliedStatement,
    ]);
    if (resolution === undefined || applied === undefined) {
      throw new Error("slack_trace_resolution_batch_result_missing");
    }
    return changed(resolution);
  }

  async #markSlackTraceApplied(traceId: string, now: number): Promise<void> {
    await this.#database
      .prepare(
        `UPDATE slack_workflow_traces
         SET applied_at = COALESCE(applied_at, ?), updated_at = ?
         WHERE trace_id = ?`,
      )
      .bind(now, now, traceId)
      .run();
  }

  async getSlackActivityCheckpoint(): Promise<number> {
    const state = await this.#database
      .prepare(
        `SELECT slack_activity_checkpoint_us
         FROM relay_state
         WHERE singleton_id = 1`,
      )
      .first<{ slack_activity_checkpoint_us: number }>();
    if (
      state === null ||
      !Number.isSafeInteger(state.slack_activity_checkpoint_us) ||
      state.slack_activity_checkpoint_us < 0
    ) {
      throw new Error("slack_activity_checkpoint_unavailable");
    }
    return state.slack_activity_checkpoint_us;
  }

  async advanceSlackActivityCheckpoint(checkpointUs: number): Promise<number> {
    if (!Number.isSafeInteger(checkpointUs) || checkpointUs < 0) {
      throw new SlackReconciliationConflictError(
        "invalid_slack_activity_checkpoint",
      );
    }
    const state = await this.#database
      .prepare(
        `UPDATE relay_state
         SET slack_activity_checkpoint_us = MAX(
           slack_activity_checkpoint_us,
           MIN(
             ?,
             COALESCE(
               (
                 SELECT MIN(updated_at * 1000)
                 FROM deliveries
                 WHERE legacy_unverified = 0
                   AND (
                      status IN (
                        'pending', 'enqueueing', 'queued', 'sending',
                        'accepted_by_slack', 'accepted_by_trigger', 'send_started'
                      )
                     OR slack_trace_id IS NULL
                   )
               ),
               ?
             )
           )
         )
         WHERE singleton_id = 1
         RETURNING slack_activity_checkpoint_us`,
      )
      .bind(checkpointUs, checkpointUs)
      .first<{ slack_activity_checkpoint_us: number }>();
    if (
      state === null ||
      !Number.isSafeInteger(state.slack_activity_checkpoint_us) ||
      state.slack_activity_checkpoint_us < 0
    ) {
      throw new Error("slack_activity_checkpoint_unavailable");
    }
    return state.slack_activity_checkpoint_us;
  }

  async purgeDeliveredBefore(cutoff: number): Promise<number> {
    const result = await this.#database
      .prepare(
        `DELETE FROM deliveries
         WHERE status = 'delivered'
           AND delivered_at IS NOT NULL
           AND slack_trace_id IS NOT NULL
           AND delivered_at < ?
           AND EXISTS (
             SELECT 1
             FROM slack_workflow_traces AS trace
             JOIN relay_state AS state ON state.singleton_id = 1
             WHERE trace.trace_id = deliveries.slack_trace_id
               AND trace.delivery_id = deliveries.delivery_id
               AND trace.relay_attempt = deliveries.attempt_count
               AND trace.send_execution_id = deliveries.slack_send_execution_id
               AND (
                 trace.outcome = 'success'
                 OR (
                   trace.outcome = 'error'
                   AND trace.send_boundary_reached = 1
                 )
               )
               AND trace.applied_at IS NOT NULL
               AND trace.completed_at_us IS NOT NULL
               AND trace.started_at_us < MAX(
                 0,
                 state.slack_activity_checkpoint_us - ?
               )
               AND trace.completed_at_us < MAX(
                 0,
                 state.slack_activity_checkpoint_us - ?
               )
           )`,
      )
      .bind(
        cutoff,
        SLACK_ACTIVITY_CHECKPOINT_OVERLAP_US,
        SLACK_ACTIVITY_CHECKPOINT_OVERLAP_US,
      )
      .run();

    return result.meta.changes ?? 0;
  }

  async healthcheck(now: number, expectedRevision: string): Promise<boolean> {
    if (!WORKER_REVISION_PATTERN.test(expectedRevision)) {
      return false;
    }
    await this.#database
      .prepare(
        `SELECT
           delivery_id,
           event_type,
           action,
           repository,
           destination,
           payload_json,
           status,
           attempt_count,
           next_attempt_at,
           last_error,
           created_at,
           updated_at,
           accepted_at,
           trigger_accepted_at,
           send_started_at,
           delivered_at,
           slack_message_ts,
           slack_trace_id,
           slack_send_execution_id,
           legacy_unverified
         FROM deliveries
         WHERE 0 = 1`,
      )
      .all();

    const state = await this.#database
      .prepare(
        `SELECT next_slack_at, slack_activity_checkpoint_us,
                slack_delivery_protocol_active,
                slack_delivery_protocol_revision,
                slack_delivery_protocol_activated_at,
                slack_delivery_protocol_activation_id,
                slack_delivery_protocol_schema_revision,
                slack_delivery_protocol_confirmation_open
         FROM relay_state
         WHERE singleton_id = 1
           AND typeof(next_slack_at) = 'integer'
           AND typeof(slack_activity_checkpoint_us) = 'integer'
           AND slack_delivery_protocol_active = 1
           AND typeof(slack_delivery_protocol_revision) = 'text'
           AND slack_delivery_protocol_revision = ?
           AND length(slack_delivery_protocol_revision) = 40
           AND slack_delivery_protocol_revision NOT GLOB '*[^0-9a-f]*'
           AND typeof(slack_delivery_protocol_activated_at) = 'integer'
           AND slack_delivery_protocol_activated_at > 0
           AND typeof(slack_delivery_protocol_activation_id) = 'text'
           AND length(slack_delivery_protocol_activation_id) = 64
           AND slack_delivery_protocol_activation_id NOT GLOB '*[^0-9a-f]*'
           AND slack_delivery_protocol_schema_revision =
             '0004_confirm_slack_delivery'
           AND slack_delivery_protocol_confirmation_open IN (0, 1)`,
      )
      .bind(expectedRevision)
      .first<{
        next_slack_at: number;
        slack_activity_checkpoint_us: number;
        slack_delivery_protocol_active: number;
        slack_delivery_protocol_revision: string;
        slack_delivery_protocol_activated_at: number;
        slack_delivery_protocol_activation_id: string;
        slack_delivery_protocol_schema_revision: string;
        slack_delivery_protocol_confirmation_open: number;
      }>();

    const unresolved = await this.#database
      .prepare(
        `SELECT 1 AS present
         FROM deliveries
         WHERE status IN ('manual_review', 'dead_letter')
           OR (
             legacy_unverified = 0
             AND status IN (
               'accepted_by_slack', 'accepted_by_trigger', 'send_started'
             )
             AND next_attempt_at <= ?
           )
         LIMIT 1`,
      )
      .bind(now)
      .first<{ present: number }>();

    return (
      state !== null &&
      Number.isSafeInteger(state.next_slack_at) &&
      Number.isSafeInteger(state.slack_activity_checkpoint_us) &&
      unresolved === null
    );
  }

  async hasLegacyUnverifiedDebt(): Promise<boolean> {
    const legacy = await this.#database
      .prepare(
        `SELECT 1 AS present
         FROM deliveries
         WHERE legacy_unverified = 1
         LIMIT 1`,
      )
      .first<{ present: number }>();
    return legacy !== null;
  }
}
