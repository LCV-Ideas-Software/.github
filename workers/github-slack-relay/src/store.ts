import type { RelayDestination, SlackWorkflowPayload } from "./domain";
import {
  exactSlackDeliveryProtocolGuardDefinitions,
  SEALED_SLACK_DELIVERY_PROTOCOL_GUARDS,
} from "./slack-delivery-protocol-guards";
import {
  SLACK_RECONCILIATION_REPORT_COLUMN_CONTRACT,
  SLACK_RECONCILIATION_REPORT_ERROR_COLUMN_CONTRACT,
  SLACK_RECONCILIATION_REPORT_ERROR_INDEX_CONTRACT,
  SLACK_RECONCILIATION_REPORT_ERRORS_REPORT_INDEX_SQL,
  SLACK_RECONCILIATION_REPORT_ERRORS_TABLE_SQL,
  SLACK_RECONCILIATION_REPORT_FOREIGN_KEY_CONTRACT,
  SLACK_RECONCILIATION_REPORT_INDEX_CONTRACT,
  SLACK_RECONCILIATION_REPORTS_COMPLETED_INDEX_SQL,
  SLACK_RECONCILIATION_REPORTS_TABLE_SQL,
} from "./slack-reconciliation-schema-contract";
import {
  planSlackReconciliation,
  SlackReconciliationPlanConflictError,
  type SlackReconciliationDeliverySnapshot,
  type SlackReconciliationTraceSnapshot,
} from "./slack-reconciliation-plan";

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
export type SlackTraceRecordResult = "changed" | "duplicate";

export interface SlackReconciliationReportResult {
  traceCount: number;
  changedErrorTraces: number;
  requestedCheckpointUs: number;
  checkpointUs: number;
}

export interface SlackTraceReconciliation {
  traceId: string;
  deliveryId: string;
  destination: RelayDestination | null;
  outcome: SlackTraceOutcome;
  attemptCount: number;
  sendExecutionId: string | null;
  slackChannelId: string | null;
  messageTs: string | null;
  sendBoundaryReached: boolean;
  preSendFailureProven: boolean;
  startedAtUs: number;
  completedAtUs: number | null;
}

export interface SlackReconciliationTraceInput {
  traceId: string;
  deliveryId: string | null;
  outcome: SlackTraceOutcome;
  attemptCount: number | null;
  sendExecutionId: string | null;
  slackChannelId: string | null;
  messageTs: string | null;
  sendBoundaryReached: boolean;
  preSendFailureProven: boolean;
  startedAtUs: number;
  completedAtUs: number | null;
}

export interface SlackReconciliationInput {
  reportId: string;
  traces: readonly SlackReconciliationTraceInput[];
  checkpointUs: number;
  now: number;
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
  "0005_reconcile_live_slack_receipts";
export const SLACK_DELIVERY_PROTOCOL_SEALED_REVISION =
  "e0131a758123cf210d9cc9e7e537b72dc0441a90";
export const SLACK_DELIVERY_PROTOCOL_SEALED_ACTIVATED_AT = 1_786_579_752_661;
export const SLACK_DELIVERY_PROTOCOL_SEALED_ACTIVATION_ID =
  "18a94ba84d6bac0f8ae396996a5cd6ac026eb336be5eef702b92b3b6a60d4ff7";
export const SLACK_ACTIVITY_CHECKPOINT_OVERLAP_US = 20 * 60 * 1_000 * 1_000;

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
  recordSlackTrace(
    trace: SlackTraceReconciliation,
    now: number,
  ): Promise<SlackTraceRecordResult>;
  resolveSlackTraceIdentityBySendExecutionId(sendExecutionId: string): Promise<{
    deliveryId: string;
    destination: RelayDestination;
    attemptCount: number;
  } | null>;
  getSlackActivityCheckpoint(): Promise<number>;
  getSlackReconciliationReport(
    reportId: string,
  ): Promise<SlackReconciliationReportResult | null>;
  reconcileSlackReport(
    input: SlackReconciliationInput,
  ): Promise<SlackReconciliationReportResult>;
  finalizeSlackReconciliationReport(
    reportId: string,
    traceCount: number,
    errorTraceIds: readonly string[],
    checkpointUs: number,
    now: number,
  ): Promise<SlackReconciliationReportResult>;
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

interface SlackTraceRow {
  delivery_id: string;
  outcome: SlackTraceOutcome;
  relay_attempt: number;
  send_execution_id: string | null;
  slack_channel_id: string | null;
  slack_message_ts: string | null;
  send_boundary_reached: number;
  pre_send_failure_proven: number;
  applied_at: number | null;
}

interface SlackReconciliationPlanningRow {
  row_kind: "delivery" | "report" | "trace";
  state_json: string;
}

interface SlackTraceResolutionSnapshot {
  traceId: string;
  deliveryId: string;
  outcome: SlackTraceOutcome;
  attemptCount: number;
  sendExecutionId: string | null;
  slackChannelId: string | null;
  messageTs: string | null;
  sendBoundaryReached: boolean;
  preSendFailureProven: boolean;
  appliedAt: number | null;
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
const SLACK_RECONCILIATION_REPORT_ID_PATTERN = /^[0-9a-f]{64}$/u;
const SLACK_TRACE_ID_PATTERN = /^Tr[A-Za-z0-9_-]{1,125}$/u;
const SLACK_RECONCILIATION_TRACE_LIMIT = 25;
const SLACK_RECONCILIATION_REPORT_RETENTION_MS = 24 * 60 * 60 * 1_000;
const SLACK_FUNCTION_EXECUTION_ID_PATTERN = /^Fx[A-Za-z0-9]{1,126}$/u;
const SLACK_RECONCILIATION_RETRY_DELAY_MS =
  SLACK_ACTIVITY_CHECKPOINT_OVERLAP_US / 1_000;
const SLACK_TRACE_RESOLUTION_SNAPSHOT_PREDICATE = `EXISTS (
  SELECT 1
  FROM slack_workflow_traces AS resolution_trace
  WHERE resolution_trace.trace_id = ?
    AND resolution_trace.delivery_id = ?
    AND resolution_trace.outcome = ?
    AND resolution_trace.relay_attempt = ?
    AND resolution_trace.send_execution_id IS ?
    AND resolution_trace.slack_channel_id IS ?
    AND resolution_trace.slack_message_ts IS ?
    AND resolution_trace.send_boundary_reached = ?
    AND resolution_trace.pre_send_failure_proven = ?
    AND resolution_trace.applied_at IS ?
)`;

function slackTraceSnapshotBindings(
  trace: SlackTraceResolutionSnapshot,
): unknown[] {
  return [
    trace.traceId,
    trace.deliveryId,
    trace.outcome,
    trace.attemptCount,
    trace.sendExecutionId,
    trace.slackChannelId,
    trace.messageTs,
    trace.sendBoundaryReached ? 1 : 0,
    trace.preSendFailureProven ? 1 : 0,
    trace.appliedAt,
  ];
}

function relayDestinationForSlackChannel(
  channelId: string | null,
): RelayDestination | null {
  if (channelId === "C0BMUK793NV") return "alerts";
  if (channelId === "C0BMQMW3L4E") return "activity";
  return null;
}

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

  async #hasExactSlackDeliveryProtocolSeal(): Promise<boolean> {
    const result = await this.#database
      .prepare(
        `SELECT name, tbl_name, sql
         FROM sqlite_schema
         WHERE type = 'trigger'
           AND tbl_name = 'relay_state'
         ORDER BY name`,
      )
      .all<{ name: string; tbl_name: string; sql: string | null }>();
    return exactSlackDeliveryProtocolGuardDefinitions(
      result.results,
      SEALED_SLACK_DELIVERY_PROTOCOL_GUARDS,
    );
  }

  async #hasExactSlackReconciliationSchema(): Promise<boolean> {
    const row = await this.#database
      .prepare(
        `SELECT
           (
             SELECT group_concat(
               name || ':' || type || ':' || "notnull" || ':' || pk,
               ','
             )
             FROM (
               SELECT name, type, "notnull", pk
               FROM pragma_table_info('slack_reconciliation_reports')
               ORDER BY cid
             )
           ) AS report_column_contract,
           (
             SELECT group_concat(
               name || ':' || type || ':' || "notnull" || ':' || pk,
               ','
             )
             FROM (
               SELECT name, type, "notnull", pk
               FROM pragma_table_info('slack_reconciliation_report_errors')
               ORDER BY cid
             )
           ) AS error_column_contract,
           (
             SELECT group_concat(
               name || ':' || "unique" || ':' || origin || ':' || partial,
               ','
             )
             FROM (
               SELECT name, "unique", origin, partial
               FROM pragma_index_list('slack_reconciliation_reports')
               ORDER BY name
             )
           ) AS report_index_contract,
           (
             SELECT group_concat(
               name || ':' || "unique" || ':' || origin || ':' || partial,
               ','
             )
             FROM (
               SELECT name, "unique", origin, partial
               FROM pragma_index_list('slack_reconciliation_report_errors')
               ORDER BY name
             )
           ) AS error_index_contract,
           (
             SELECT group_concat(
               id || ':' || seq || ':' || "table" || ':' || "from" || ':' ||
               "to" || ':' || on_update || ':' || on_delete || ':' || match,
               ','
             )
             FROM (
               SELECT id, seq, "table", "from", "to", on_update, on_delete,
                      match
               FROM pragma_foreign_key_list(
                 'slack_reconciliation_report_errors'
               )
               ORDER BY id, seq
             )
           ) AS foreign_key_contract,
           (
             SELECT sql
             FROM sqlite_schema
             WHERE type = 'index'
               AND name = 'idx_slack_reconciliation_reports_completed'
               AND tbl_name = 'slack_reconciliation_reports'
           ) AS report_index_sql,
           (
             SELECT sql
             FROM sqlite_schema
             WHERE type = 'index'
               AND name = 'idx_slack_reconciliation_report_errors_report'
               AND tbl_name = 'slack_reconciliation_report_errors'
           ) AS error_index_sql,
           (
             SELECT COUNT(*)
             FROM sqlite_schema
             WHERE tbl_name IN (
               'slack_reconciliation_reports',
               'slack_reconciliation_report_errors'
             )
               AND sql IS NOT NULL
           ) AS schema_object_count,
           (
             SELECT sql
             FROM sqlite_schema
             WHERE type = 'table'
               AND name = 'slack_reconciliation_reports'
               AND tbl_name = 'slack_reconciliation_reports'
           ) AS report_sql,
           (
             SELECT sql
             FROM sqlite_schema
             WHERE type = 'table'
               AND name = 'slack_reconciliation_report_errors'
               AND tbl_name = 'slack_reconciliation_report_errors'
           ) AS error_sql`,
      )
      .first<{
        report_column_contract: string | null;
        error_column_contract: string | null;
        report_index_contract: string | null;
        error_index_contract: string | null;
        foreign_key_contract: string | null;
        report_index_sql: string | null;
        error_index_sql: string | null;
        schema_object_count: number;
        report_sql: string | null;
        error_sql: string | null;
      }>();
    return (
      row !== null &&
      row.report_column_contract ===
        SLACK_RECONCILIATION_REPORT_COLUMN_CONTRACT &&
      row.error_column_contract ===
        SLACK_RECONCILIATION_REPORT_ERROR_COLUMN_CONTRACT &&
      row.report_index_contract ===
        SLACK_RECONCILIATION_REPORT_INDEX_CONTRACT &&
      row.error_index_contract ===
        SLACK_RECONCILIATION_REPORT_ERROR_INDEX_CONTRACT &&
      row.foreign_key_contract ===
        SLACK_RECONCILIATION_REPORT_FOREIGN_KEY_CONTRACT &&
      row.report_index_sql ===
        SLACK_RECONCILIATION_REPORTS_COMPLETED_INDEX_SQL &&
      row.error_index_sql ===
        SLACK_RECONCILIATION_REPORT_ERRORS_REPORT_INDEX_SQL &&
      row.schema_object_count === 4 &&
      row.report_sql === SLACK_RECONCILIATION_REPORTS_TABLE_SQL &&
      row.error_sql === SLACK_RECONCILIATION_REPORT_ERRORS_TABLE_SQL
    );
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
    if (
      state.slack_delivery_protocol_active !== 1 ||
      state.slack_delivery_protocol_revision !==
        SLACK_DELIVERY_PROTOCOL_SEALED_REVISION ||
      state.slack_delivery_protocol_activated_at !==
        SLACK_DELIVERY_PROTOCOL_SEALED_ACTIVATED_AT ||
      state.slack_delivery_protocol_activation_id !==
        SLACK_DELIVERY_PROTOCOL_SEALED_ACTIVATION_ID ||
      state.slack_delivery_protocol_schema_revision !==
        SLACK_DELIVERY_PROTOCOL_SCHEMA_REVISION ||
      state.slack_delivery_protocol_confirmation_open !== 0
    ) {
      throw new Error("slack_delivery_protocol_state_inconsistent");
    }

    if (!(await this.#hasExactSlackDeliveryProtocolSeal())) {
      throw new Error("slack_delivery_protocol_seal_incomplete");
    }
    return true;
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

  async resolveSlackTraceIdentityBySendExecutionId(
    sendExecutionId: string,
  ): Promise<{
    deliveryId: string;
    destination: RelayDestination;
    attemptCount: number;
  } | null> {
    if (!SLACK_FUNCTION_EXECUTION_ID_PATTERN.test(sendExecutionId)) {
      throw new SlackReconciliationConflictError(
        "invalid_slack_function_execution",
      );
    }
    const rows = await this.#database
      .prepare(
        `SELECT delivery_id, destination, attempt_count
         FROM deliveries
         WHERE slack_send_execution_id = ?
         LIMIT 2`,
      )
      .bind(sendExecutionId)
      .all<{
        delivery_id: string;
        destination: RelayDestination;
        attempt_count: number;
      }>();
    if (rows.results.length > 1) {
      throw new SlackReconciliationConflictError(
        "slack_send_execution_not_unique",
      );
    }
    const row = rows.results[0];
    return row === undefined
      ? null
      : {
          deliveryId: row.delivery_id,
          destination: row.destination,
          attemptCount: row.attempt_count,
        };
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
             updated_at = ?, slack_trace_id = NULL,
             slack_send_execution_id = NULL
         WHERE delivery_id = ?
           AND status IN ('pending', 'enqueueing', 'queued', 'dead_letter')
           AND next_attempt_at <= ?
           AND (
             slack_trace_id IS NULL
             OR EXISTS (
               SELECT 1
               FROM slack_workflow_traces AS retry_trace
               WHERE retry_trace.trace_id = deliveries.slack_trace_id
                 AND retry_trace.delivery_id = deliveries.delivery_id
                 AND retry_trace.outcome = 'error'
                 AND retry_trace.relay_attempt = deliveries.attempt_count
                 AND retry_trace.send_execution_id =
                   deliveries.slack_send_execution_id
                 AND retry_trace.slack_channel_id IS NULL
                 AND retry_trace.slack_message_ts IS NULL
                 AND retry_trace.send_boundary_reached = 0
                 AND retry_trace.pre_send_failure_proven = 1
                 AND retry_trace.applied_at IS NOT NULL
             )
           )
           AND NOT EXISTS (
             SELECT 1
             FROM slack_workflow_traces AS incompatible_trace
             WHERE incompatible_trace.delivery_id = deliveries.delivery_id
               AND incompatible_trace.relay_attempt = deliveries.attempt_count
               AND (
                 incompatible_trace.send_execution_id IS NULL
                 OR deliveries.slack_send_execution_id IS NULL
                 OR incompatible_trace.send_execution_id =
                   deliveries.slack_send_execution_id
               )
               AND (
                 incompatible_trace.applied_at IS NULL
                 OR incompatible_trace.outcome != 'error'
                 OR incompatible_trace.slack_channel_id IS NOT NULL
                 OR incompatible_trace.slack_message_ts IS NOT NULL
                 OR incompatible_trace.send_boundary_reached != 0
                 OR incompatible_trace.pre_send_failure_proven != 1
               )
           )
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
      const releasedPreSendRetry =
        (existing.status === "pending" ||
          existing.status === "enqueueing" ||
          existing.status === "queued" ||
          existing.status === "dead_letter") &&
        existing.slackTraceId !== null &&
        existing.slackSendExecutionId === input.functionExecutionId;
      if (
        existing.status !== "sending" &&
        existing.status !== "accepted_by_slack" &&
        existing.status !== "accepted_by_trigger" &&
        !(
          existing.status === "manual_review" &&
          retryableTriggerAmbiguityReason(existing.lastError)
        ) &&
        !releasedPreSendRetry
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
                OR (
                  status IN ('pending', 'enqueueing', 'queued', 'dead_letter')
                  AND slack_send_execution_id = ?
                  AND slack_trace_id IS NOT NULL
                  AND EXISTS (
                    SELECT 1
                    FROM slack_workflow_traces AS released_trace
                    WHERE released_trace.trace_id = deliveries.slack_trace_id
                      AND released_trace.delivery_id = deliveries.delivery_id
                      AND released_trace.relay_attempt = deliveries.attempt_count
                      AND released_trace.send_execution_id =
                        deliveries.slack_send_execution_id
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
          input.functionExecutionId,
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
    const releasedPreSendRetry =
      (existing.status === "pending" ||
        existing.status === "enqueueing" ||
        existing.status === "queued" ||
        existing.status === "dead_letter") &&
      existing.slackTraceId !== null;
    if (
      existing.status !== "sending" &&
      existing.status !== "accepted_by_slack" &&
      existing.status !== "accepted_by_trigger" &&
      existing.status !== "send_started" &&
      existing.status !== "manual_review" &&
      !releasedPreSendRetry
    ) {
      throw new SlackProgressConflictError(
        "delivery_not_awaiting_slack_progress",
      );
    }
    if (existing.slackSendExecutionId === null) {
      throw new SlackProgressConflictError("slack_send_execution_missing");
    }

    let result: D1Result<unknown>;
    try {
      result = await this.#database
        .prepare(
          `UPDATE deliveries
           SET status = 'delivered', updated_at = ?, delivered_at = ?,
               slack_message_ts = ?, next_attempt_at = ?, last_error = NULL,
               slack_trace_id = CASE
                 WHEN slack_trace_id IS NOT NULL
                   AND EXISTS (
                     SELECT 1
                     FROM slack_workflow_traces AS receipt_trace
                     WHERE receipt_trace.trace_id = deliveries.slack_trace_id
                       AND receipt_trace.delivery_id = deliveries.delivery_id
                       AND receipt_trace.relay_attempt = deliveries.attempt_count
                       AND receipt_trace.send_execution_id =
                         deliveries.slack_send_execution_id
                       AND receipt_trace.applied_at IS NOT NULL
                       AND (
                         receipt_trace.outcome = 'success'
                         OR (
                           receipt_trace.outcome = 'error'
                           AND receipt_trace.send_boundary_reached = 1
                         )
                       )
                   )
                   THEN slack_trace_id
                 ELSE NULL
               END,
               legacy_unverified = 0
           WHERE delivery_id = ? AND destination = ?
              AND attempt_count = ?
              AND slack_send_execution_id = ?
              AND (
                status IN (
                  'sending', 'accepted_by_slack', 'accepted_by_trigger',
                  'send_started', 'manual_review'
                )
                OR (
                  status IN ('pending', 'enqueueing', 'queued', 'dead_letter')
                  AND slack_trace_id IS NOT NULL
                  AND EXISTS (
                    SELECT 1
                    FROM slack_workflow_traces AS released_trace
                    WHERE released_trace.trace_id = deliveries.slack_trace_id
                      AND released_trace.delivery_id = deliveries.delivery_id
                      AND released_trace.outcome = 'error'
                      AND released_trace.relay_attempt = deliveries.attempt_count
                      AND released_trace.send_execution_id =
                        deliveries.slack_send_execution_id
                  )
                )
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
          existing.slackSendExecutionId,
        )
        .run();
    } catch (error) {
      const current = await this.get(input.deliveryId);
      if (
        current?.destination === input.destination &&
        current.status === "delivered" &&
        current.attemptCount === input.attemptCount &&
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
        current.attemptCount === input.attemptCount &&
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
  ): Promise<SlackTraceRecordResult> {
    const destination = trace.destination;
    const slackChannelId = trace.slackChannelId;
    const messageTs = trace.messageTs;
    if (
      !Number.isSafeInteger(trace.attemptCount) ||
      trace.attemptCount <= 0 ||
      (trace.sendExecutionId !== null &&
        !SLACK_FUNCTION_EXECUTION_ID_PATTERN.test(trace.sendExecutionId)) ||
      (trace.preSendFailureProven && trace.sendExecutionId === null) ||
      (slackChannelId === null) !== (messageTs === null) ||
      (messageTs !== null &&
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

    const delivery = await this.get(trace.deliveryId);
    if (delivery === null) {
      throw new SlackReconciliationConflictError("delivery_not_found");
    }

    const existingTrace = await this.#database
      .prepare(
        `SELECT delivery_id, outcome, relay_attempt, send_execution_id,
                slack_channel_id, slack_message_ts,
                send_boundary_reached, pre_send_failure_proven, applied_at
         FROM slack_workflow_traces
         WHERE trace_id = ?`,
      )
      .bind(trace.traceId)
      .first<SlackTraceRow>();
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
      ((existingTrace.slack_channel_id !== null &&
        slackChannelId !== null &&
        existingTrace.slack_channel_id !== slackChannelId) ||
        (existingTrace.slack_message_ts !== null &&
          messageTs !== null &&
          existingTrace.slack_message_ts !== messageTs))
    ) {
      throw new SlackReconciliationConflictError(
        "slack_trace_message_evidence_conflict",
      );
    }
    if (
      existingTrace !== null &&
      existingTrace.outcome !== "pending" &&
      trace.outcome !== "pending" &&
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
    const assertUniqueTraceOwners = async (): Promise<void> => {
      if (trace.sendExecutionId !== null) {
        const executionOwner = await this.#database
          .prepare(
            `SELECT trace_id
             FROM slack_workflow_traces
             WHERE send_execution_id = ?
             LIMIT 2`,
          )
          .bind(trace.sendExecutionId)
          .all<{ trace_id: string }>();
        if (
          executionOwner.results.length > 1 ||
          (executionOwner.results.length === 1 &&
            executionOwner.results[0]?.trace_id !== trace.traceId)
        ) {
          throw new SlackReconciliationConflictError(
            "slack_trace_send_execution_owner_conflict",
          );
        }
      }
      if (slackChannelId !== null && messageTs !== null) {
        const messageOwner = await this.#database
          .prepare(
            `SELECT trace_id
             FROM slack_workflow_traces
             WHERE slack_channel_id = ? AND slack_message_ts = ?
             LIMIT 2`,
          )
          .bind(slackChannelId, messageTs)
          .all<{ trace_id: string }>();
        if (
          messageOwner.results.length > 1 ||
          (messageOwner.results.length === 1 &&
            messageOwner.results[0]?.trace_id !== trace.traceId)
        ) {
          throw new SlackReconciliationConflictError(
            "slack_trace_message_owner_conflict",
          );
        }
      }
    };
    await assertUniqueTraceOwners();
    if (destination !== null && messageTs !== null) {
      await this.#assertUniqueDeliveryMessageOwner(
        trace.deliveryId,
        destination,
        messageTs,
      );
    }
    const traceWrite = this.#database
      .prepare(
        `INSERT INTO slack_workflow_traces (
           trace_id,
           delivery_id,
           outcome,
           relay_attempt,
           send_execution_id,
           slack_channel_id,
           slack_message_ts,
           send_boundary_reached,
           pre_send_failure_proven,
           started_at_us,
           completed_at_us,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(trace_id) DO UPDATE SET
           applied_at = CASE
             WHEN (
               slack_workflow_traces.outcome = 'pending'
               AND excluded.outcome != 'pending'
             )
             OR (
               slack_workflow_traces.slack_message_ts IS NULL
               AND excluded.slack_message_ts IS NOT NULL
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
           outcome = CASE
             WHEN slack_workflow_traces.outcome = 'pending'
               THEN excluded.outcome
             ELSE slack_workflow_traces.outcome
           END,
           send_execution_id = COALESCE(
             slack_workflow_traces.send_execution_id,
             excluded.send_execution_id
           ),
           slack_channel_id = COALESCE(
             slack_workflow_traces.slack_channel_id,
             excluded.slack_channel_id
           ),
           slack_message_ts = COALESCE(
             slack_workflow_traces.slack_message_ts,
             excluded.slack_message_ts
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
             slack_workflow_traces.completed_at_us,
             excluded.completed_at_us
           ),
           updated_at = excluded.updated_at
         WHERE (
               slack_workflow_traces.outcome = 'pending'
               OR excluded.outcome = 'pending'
               OR slack_workflow_traces.outcome = excluded.outcome
           )
           AND slack_workflow_traces.delivery_id = excluded.delivery_id
           AND slack_workflow_traces.relay_attempt = excluded.relay_attempt
           AND (
             slack_workflow_traces.send_execution_id IS NULL
             OR excluded.send_execution_id IS NULL
             OR slack_workflow_traces.send_execution_id =
               excluded.send_execution_id
           )
           AND (
             slack_workflow_traces.slack_channel_id IS NULL
             OR excluded.slack_channel_id IS NULL
             OR slack_workflow_traces.slack_channel_id =
               excluded.slack_channel_id
           )
           AND (
             slack_workflow_traces.slack_message_ts IS NULL
             OR excluded.slack_message_ts IS NULL
             OR slack_workflow_traces.slack_message_ts =
               excluded.slack_message_ts
           )`,
      )
      .bind(
        trace.traceId,
        trace.deliveryId,
        trace.outcome,
        trace.attemptCount,
        trace.sendExecutionId,
        slackChannelId,
        messageTs,
        trace.sendBoundaryReached ? 1 : 0,
        trace.preSendFailureProven ? 1 : 0,
        trace.startedAtUs,
        trace.completedAtUs,
        now,
      );
    try {
      await traceWrite.run();
    } catch (error) {
      await assertUniqueTraceOwners();
      throw error;
    }

    const effectiveTrace = await this.#database
      .prepare(
        `SELECT delivery_id, outcome, relay_attempt, send_execution_id,
                slack_channel_id,
                slack_message_ts, send_boundary_reached,
                pre_send_failure_proven, applied_at
         FROM slack_workflow_traces
         WHERE trace_id = ?`,
      )
      .bind(trace.traceId)
      .first<SlackTraceRow>();
    if (effectiveTrace === null) {
      throw new Error("slack_trace_persistence_failed");
    }
    if (effectiveTrace.delivery_id !== trace.deliveryId) {
      throw new SlackReconciliationConflictError(
        "slack_trace_delivery_conflict",
      );
    }
    if (effectiveTrace.relay_attempt !== trace.attemptCount) {
      throw new SlackReconciliationConflictError(
        "slack_trace_attempt_conflict",
      );
    }
    if (
      effectiveTrace.send_execution_id !== null &&
      trace.sendExecutionId !== null &&
      effectiveTrace.send_execution_id !== trace.sendExecutionId
    ) {
      throw new SlackReconciliationConflictError(
        "slack_trace_send_execution_conflict",
      );
    }
    if (
      (effectiveTrace.slack_channel_id !== null &&
        slackChannelId !== null &&
        effectiveTrace.slack_channel_id !== slackChannelId) ||
      (effectiveTrace.slack_message_ts !== null &&
        messageTs !== null &&
        effectiveTrace.slack_message_ts !== messageTs)
    ) {
      throw new SlackReconciliationConflictError(
        "slack_trace_message_evidence_conflict",
      );
    }
    if (
      trace.outcome !== "pending" &&
      effectiveTrace.outcome !== trace.outcome
    ) {
      throw new SlackReconciliationConflictError(
        "slack_trace_outcome_conflict",
      );
    }
    const sendBoundaryReached = effectiveTrace.send_boundary_reached === 1;
    const preSendFailureProven = effectiveTrace.pre_send_failure_proven === 1;
    const sendExecutionId = effectiveTrace.send_execution_id;
    const effectiveMessageTs = effectiveTrace.slack_message_ts;
    const effectiveDestination =
      effectiveMessageTs === null
        ? destination
        : relayDestinationForSlackChannel(effectiveTrace.slack_channel_id);
    const resolutionTrace: SlackTraceReconciliation = {
      ...trace,
      outcome: effectiveTrace.outcome,
      sendExecutionId,
      destination: effectiveDestination,
      slackChannelId: effectiveTrace.slack_channel_id,
      messageTs: effectiveMessageTs,
      sendBoundaryReached,
      preSendFailureProven,
    };
    const resolutionSnapshot: SlackTraceResolutionSnapshot = {
      traceId: trace.traceId,
      deliveryId: trace.deliveryId,
      outcome: effectiveTrace.outcome,
      attemptCount: trace.attemptCount,
      sendExecutionId,
      slackChannelId: effectiveTrace.slack_channel_id,
      messageTs: effectiveMessageTs,
      sendBoundaryReached,
      preSendFailureProven,
      appliedAt: effectiveTrace.applied_at,
    };
    const appliedTraceGainedEvidence =
      existingTrace !== null &&
      ((existingTrace.outcome === "pending" &&
        effectiveTrace.outcome !== "pending") ||
        (existingTrace.send_execution_id === null &&
          sendExecutionId !== null) ||
        (existingTrace.slack_message_ts === null &&
          effectiveMessageTs !== null) ||
        (existingTrace.send_boundary_reached === 0 && sendBoundaryReached) ||
        (existingTrace.pre_send_failure_proven === 0 && preSendFailureProven));
    const observationResult: SlackTraceRecordResult =
      trace.outcome === "pending" && effectiveTrace.outcome !== "pending"
        ? "duplicate"
        : existingTrace === null ||
            (existingTrace.outcome === "pending" && appliedTraceGainedEvidence)
          ? "changed"
          : "duplicate";
    if (effectiveTrace.outcome === "pending") {
      return observationResult;
    }
    if (
      existingTrace !== null &&
      existingTrace.applied_at !== null &&
      !appliedTraceGainedEvidence
    ) {
      return observationResult;
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
      effectiveTrace.outcome === "error" &&
      !sameTraceMayReleaseMissingProof
    ) {
      await this.#markSlackTraceApplied(resolutionSnapshot, now);
      return observationResult;
    }

    if (effectiveMessageTs !== null) {
      if (
        sendExecutionId === null ||
        current.slackSendExecutionId !== sendExecutionId ||
        effectiveDestination === null ||
        effectiveDestination !== current.destination
      ) {
        throw new SlackReconciliationConflictError(
          "slack_trace_owner_conflict",
        );
      }
      await this.#applySlackMessageTraceResolution(
        this.#database
          .prepare(
            `UPDATE deliveries
             SET status = 'delivered', delivered_at = COALESCE(delivered_at, ?),
                 slack_message_ts = ?, slack_trace_id = ?, updated_at = ?,
                 next_attempt_at = ?, last_error = NULL, legacy_unverified = 0
             WHERE delivery_id = ?
               AND destination = ?
               AND attempt_count = ?
               AND slack_send_execution_id = ?
                AND status IN (
                  'accepted_by_slack', 'accepted_by_trigger', 'send_started',
                  'manual_review', 'delivered', 'pending', 'enqueueing',
                  'queued', 'dead_letter'
                )
                AND (slack_message_ts IS NULL OR slack_message_ts = ?)
                AND (
                  slack_trace_id IS NULL
                  OR slack_trace_id = ?
                  OR EXISTS (
                    SELECT 1
                    FROM slack_workflow_traces AS superseded_trace
                    WHERE superseded_trace.trace_id = deliveries.slack_trace_id
                      AND superseded_trace.delivery_id = deliveries.delivery_id
                      AND superseded_trace.outcome = 'error'
                      AND superseded_trace.relay_attempt = deliveries.attempt_count
                      AND superseded_trace.send_execution_id =
                        deliveries.slack_send_execution_id
                      AND superseded_trace.slack_channel_id IS NULL
                      AND superseded_trace.slack_message_ts IS NULL
                      AND superseded_trace.send_boundary_reached = 0
                      AND superseded_trace.pre_send_failure_proven = 1
                      AND superseded_trace.applied_at IS NOT NULL
                  )
                )
                AND ${SLACK_TRACE_RESOLUTION_SNAPSHOT_PREDICATE}`,
          )
          .bind(
            now,
            effectiveMessageTs,
            trace.traceId,
            now,
            now,
            trace.deliveryId,
            effectiveDestination,
            trace.attemptCount,
            sendExecutionId,
            effectiveMessageTs,
            trace.traceId,
            ...slackTraceSnapshotBindings(resolutionSnapshot),
          ),
        resolutionTrace,
        effectiveDestination,
        sendExecutionId,
        effectiveMessageTs,
        resolutionSnapshot,
        now,
      );
      return observationResult;
    }

    if (current.status === "delivered") {
      if (
        current.attemptCount === trace.attemptCount &&
        current.slackSendExecutionId !== null &&
        current.slackSendExecutionId === sendExecutionId &&
        (effectiveTrace.outcome === "success" || sendBoundaryReached)
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
                 AND (slack_trace_id IS NULL OR slack_trace_id = ?)
                 AND ${SLACK_TRACE_RESOLUTION_SNAPSHOT_PREDICATE}`,
            )
            .bind(
              trace.traceId,
              now,
              trace.deliveryId,
              trace.attemptCount,
              sendExecutionId,
              trace.traceId,
              ...slackTraceSnapshotBindings(resolutionSnapshot),
            ),
          resolutionTrace,
          resolutionSnapshot,
          now,
        );
        return observationResult;
      }
      await this.#markSlackTraceApplied(resolutionSnapshot, now);
      return observationResult;
    }

    if (current.attemptCount !== trace.attemptCount) {
      await this.#markSlackTraceApplied(resolutionSnapshot, now);
      return observationResult;
    }
    if (
      current.slackSendExecutionId !== null &&
      current.slackSendExecutionId !== sendExecutionId
    ) {
      await this.#markSlackTraceApplied(resolutionSnapshot, now);
      return observationResult;
    }

    if (effectiveTrace.outcome === "success") {
      await this.#resolveSuccessfulSlackTrace(
        resolutionTrace,
        resolutionSnapshot,
        now,
        sendExecutionId,
      );
      return observationResult;
    }

    const mayHaveSent =
      sendBoundaryReached ||
      current.status === "send_started" ||
      (!preSendFailureProven && current.legacyUnverified);
    if (mayHaveSent) {
      await this.#resolveSlackTraceAsManualReview(
        resolutionTrace,
        resolutionSnapshot,
        trace.deliveryId,
        now,
        "slack_workflow_failed_after_send_boundary",
        sendExecutionId,
        sendBoundaryReached,
      );
      return observationResult;
    }

    if (!preSendFailureProven) {
      await this.#resolveSlackTraceAsManualReview(
        resolutionTrace,
        resolutionSnapshot,
        trace.deliveryId,
        now,
        "slack_workflow_failed_without_pre_send_proof",
        sendExecutionId,
        false,
      );
      return observationResult;
    }

    const retryStatement = this.#database
      .prepare(
        `UPDATE deliveries
           SET status = 'pending', updated_at = ?, next_attempt_at = MAX(next_attempt_at, ?),
              last_error = 'slack_workflow_failed_before_send_boundary',
              slack_trace_id = ?, slack_send_execution_id = COALESCE(slack_send_execution_id, ?),
              legacy_unverified = 0
         WHERE delivery_id = ?
           AND (
             status IN (
               'accepted_by_slack', 'accepted_by_trigger'
             )
             OR (
               status IN ('pending', 'enqueueing', 'queued', 'dead_letter')
               AND slack_trace_id IS NULL
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
            )
            AND NOT EXISTS (
              SELECT 1
              FROM slack_workflow_traces AS competing_trace
              WHERE competing_trace.delivery_id = deliveries.delivery_id
                AND competing_trace.relay_attempt = deliveries.attempt_count
                AND competing_trace.trace_id != ?
                AND (
                  competing_trace.applied_at IS NULL
                  OR competing_trace.outcome != 'error'
                  OR competing_trace.slack_channel_id IS NOT NULL
                  OR competing_trace.slack_message_ts IS NOT NULL
                  OR competing_trace.send_boundary_reached != 0
                  OR competing_trace.pre_send_failure_proven != 1
                )
            )
            AND ${SLACK_TRACE_RESOLUTION_SNAPSHOT_PREDICATE}`,
      )
      .bind(
        now,
        now + SLACK_RECONCILIATION_RETRY_DELAY_MS,
        trace.traceId,
        sendExecutionId,
        trace.deliveryId,
        trace.traceId,
        trace.attemptCount,
        sendExecutionId,
        trace.traceId,
        ...slackTraceSnapshotBindings(resolutionSnapshot),
      );
    const retryApplied = await this.#applySlackTraceResolution(
      retryStatement,
      resolutionTrace,
      resolutionSnapshot,
      now,
    );
    if (!retryApplied) {
      const raced = await this.get(trace.deliveryId);
      if (
        raced !== null &&
        raced.attemptCount === trace.attemptCount &&
        raced.status === "send_started" &&
        raced.slackSendExecutionId === sendExecutionId
      ) {
        const quarantined = await this.#resolveSlackTraceAsManualReview(
          resolutionTrace,
          resolutionSnapshot,
          trace.deliveryId,
          now,
          "slack_workflow_failed_after_send_boundary",
          sendExecutionId,
          false,
        );
        if (quarantined) return observationResult;
      }
      if (
        raced !== null &&
        raced.attemptCount === trace.attemptCount &&
        raced.status === "pending" &&
        raced.slackTraceId === trace.traceId &&
        raced.slackSendExecutionId === sendExecutionId &&
        raced.lastError === "slack_workflow_failed_before_send_boundary"
      ) {
        return observationResult;
      }
      // A competing positive trace, a still-sending trigger, or an unrelated
      // quarantine may deliberately make the retry CAS a no-op. Leave this
      // trace unapplied unless the batch's guarded applied statement proved a
      // converged state; checkpoint clamping will replay it. The only stale
      // state that requires an immediate mutation is the exact send_started
      // race handled above.
      return observationResult;
    }
    return observationResult;
  }

  async #resolveSlackTraceAsManualReview(
    trace: SlackTraceReconciliation,
    snapshot: SlackTraceResolutionSnapshot,
    deliveryId: string,
    now: number,
    reason: string,
    sendExecutionId: string | null,
    attachIfDelivered: boolean,
  ): Promise<boolean> {
    return await this.#applySlackTraceResolution(
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
              )
              AND ${SLACK_TRACE_RESOLUTION_SNAPSHOT_PREDICATE}`,
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
          ...slackTraceSnapshotBindings(snapshot),
        ),
      trace,
      snapshot,
      now,
    );
  }

  async #resolveSuccessfulSlackTrace(
    trace: SlackTraceReconciliation,
    snapshot: SlackTraceResolutionSnapshot,
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
              )
              AND ${SLACK_TRACE_RESOLUTION_SNAPSHOT_PREDICATE}`,
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
          ...slackTraceSnapshotBindings(snapshot),
        ),
      trace,
      snapshot,
      now,
    );
  }

  async #applySlackTraceResolution(
    mutation: D1PreparedStatement,
    trace: SlackTraceReconciliation,
    snapshot: SlackTraceResolutionSnapshot,
    now: number,
  ): Promise<boolean> {
    const canAttachToDelivered =
      trace.outcome === "success" || trace.sendBoundaryReached;
    const appliedStatement = this.#database
      .prepare(
        `UPDATE slack_workflow_traces
         SET applied_at = COALESCE(applied_at, ?), updated_at = ?
         WHERE trace_id = ?
           AND delivery_id = ?
           AND outcome = ?
           AND relay_attempt = ?
           AND send_execution_id IS ?
           AND slack_channel_id IS ?
           AND slack_message_ts IS ?
           AND send_boundary_reached = ?
           AND pre_send_failure_proven = ?
           AND applied_at IS ?
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
        ...slackTraceSnapshotBindings(snapshot),
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

  async #applySlackMessageTraceResolution(
    mutation: D1PreparedStatement,
    trace: SlackTraceReconciliation,
    destination: RelayDestination,
    sendExecutionId: string,
    messageTs: string,
    snapshot: SlackTraceResolutionSnapshot,
    now: number,
  ): Promise<void> {
    const appliedStatement = this.#database
      .prepare(
        `UPDATE slack_workflow_traces
         SET applied_at = COALESCE(applied_at, ?), updated_at = ?
         WHERE trace_id = ?
           AND delivery_id = ?
           AND outcome = ?
           AND relay_attempt = ?
           AND send_execution_id IS ?
           AND slack_channel_id IS ?
           AND slack_message_ts IS ?
           AND send_boundary_reached = ?
           AND pre_send_failure_proven = ?
           AND applied_at IS ?
           AND EXISTS (
             SELECT 1
             FROM deliveries
             WHERE delivery_id = ?
               AND destination = ?
               AND attempt_count = ?
               AND slack_send_execution_id = ?
               AND status = 'delivered'
               AND slack_message_ts = ?
               AND slack_trace_id = ?
           )`,
      )
      .bind(
        now,
        now,
        ...slackTraceSnapshotBindings(snapshot),
        trace.deliveryId,
        destination,
        trace.attemptCount,
        sendExecutionId,
        messageTs,
        trace.traceId,
      );
    let resolution: D1Result<unknown> | undefined;
    let applied: D1Result<unknown> | undefined;
    try {
      [resolution, applied] = await this.#database.batch([
        mutation,
        appliedStatement,
      ]);
    } catch (error) {
      await this.#assertUniqueDeliveryMessageOwner(
        trace.deliveryId,
        destination,
        messageTs,
      );
      throw error;
    }
    if (resolution === undefined || applied === undefined) {
      throw new Error("slack_trace_resolution_batch_result_missing");
    }
    if (!changed(applied)) {
      throw new SlackReconciliationConflictError(
        "slack_trace_message_resolution_conflict",
      );
    }
  }

  async #assertUniqueDeliveryMessageOwner(
    deliveryId: string,
    destination: RelayDestination,
    messageTs: string,
  ): Promise<void> {
    const owners = await this.#database
      .prepare(
        `SELECT delivery_id
         FROM deliveries
         WHERE destination = ? AND slack_message_ts = ?
         LIMIT 2`,
      )
      .bind(destination, messageTs)
      .all<{ delivery_id: string }>();
    if (
      owners.results.length > 1 ||
      (owners.results.length === 1 &&
        owners.results[0]?.delivery_id !== deliveryId)
    ) {
      throw new SlackReconciliationConflictError(
        "slack_message_timestamp_conflict",
      );
    }
  }

  async #markSlackTraceApplied(
    snapshot: SlackTraceResolutionSnapshot,
    now: number,
  ): Promise<void> {
    await this.#database
      .prepare(
        `UPDATE slack_workflow_traces
         SET applied_at = COALESCE(applied_at, ?), updated_at = ?
         WHERE trace_id = ?
           AND delivery_id = ?
           AND outcome = ?
           AND relay_attempt = ?
           AND send_execution_id IS ?
           AND slack_channel_id IS ?
           AND slack_message_ts IS ?
           AND send_boundary_reached = ?
           AND pre_send_failure_proven = ?
           AND applied_at IS ?`,
      )
      .bind(now, now, ...slackTraceSnapshotBindings(snapshot))
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

  async getSlackReconciliationReport(
    reportId: string,
  ): Promise<SlackReconciliationReportResult | null> {
    if (!SLACK_RECONCILIATION_REPORT_ID_PATTERN.test(reportId)) {
      throw new SlackReconciliationConflictError(
        "invalid_slack_reconciliation_report_id",
      );
    }
    const row = await this.#database
      .prepare(
        `SELECT trace_count, changed_error_traces,
                requested_checkpoint_us, checkpoint_us
         FROM slack_reconciliation_reports
         WHERE report_id = ?`,
      )
      .bind(reportId)
      .first<{
        trace_count: number;
        changed_error_traces: number;
        requested_checkpoint_us: number;
        checkpoint_us: number;
      }>();
    if (row === null) return null;
    if (
      !Number.isSafeInteger(row.trace_count) ||
      row.trace_count < 0 ||
      row.trace_count > SLACK_RECONCILIATION_TRACE_LIMIT ||
      !Number.isSafeInteger(row.changed_error_traces) ||
      row.changed_error_traces < 0 ||
      row.changed_error_traces > row.trace_count ||
      !Number.isSafeInteger(row.requested_checkpoint_us) ||
      row.requested_checkpoint_us < 0 ||
      !Number.isSafeInteger(row.checkpoint_us) ||
      row.checkpoint_us < 0 ||
      row.checkpoint_us > row.requested_checkpoint_us
    ) {
      throw new Error("slack_reconciliation_report_unavailable");
    }
    return {
      traceCount: row.trace_count,
      changedErrorTraces: row.changed_error_traces,
      requestedCheckpointUs: row.requested_checkpoint_us,
      checkpointUs: row.checkpoint_us,
    };
  }

  async reconcileSlackReport(
    input: SlackReconciliationInput,
  ): Promise<SlackReconciliationReportResult> {
    if (
      !SLACK_RECONCILIATION_REPORT_ID_PATTERN.test(input.reportId) ||
      input.traces.length > SLACK_RECONCILIATION_TRACE_LIMIT ||
      new Set(input.traces.map(({ traceId }) => traceId)).size !==
        input.traces.length ||
      !Number.isSafeInteger(input.checkpointUs) ||
      input.checkpointUs < 0 ||
      !Number.isSafeInteger(input.now) ||
      input.now <= 0
    ) {
      throw new SlackReconciliationConflictError(
        "invalid_slack_reconciliation_report",
      );
    }

    const rawTracesJson = JSON.stringify(input.traces);
    const planningRows = await this.#database
      .prepare(
        `WITH report_input AS (
           SELECT value
           FROM json_each(?)
         ), relevant_delivery_ids AS (
           SELECT json_extract(value, '$.deliveryId') AS delivery_id
           FROM report_input
           WHERE json_extract(value, '$.deliveryId') IS NOT NULL
           UNION
           SELECT deliveries.delivery_id
           FROM deliveries
           JOIN report_input
             ON deliveries.slack_send_execution_id =
                json_extract(report_input.value, '$.sendExecutionId')
         )
         SELECT 'report' AS row_kind,
                json_object(
                  'traceCount', trace_count,
                  'changedErrorTraces', changed_error_traces,
                  'requestedCheckpointUs', requested_checkpoint_us,
                  'checkpointUs', checkpoint_us
                ) AS state_json
         FROM slack_reconciliation_reports
         WHERE report_id = ?
         UNION ALL
         SELECT 'delivery' AS row_kind,
                json_object(
                  'deliveryId', delivery_id,
                  'destination', destination,
                  'status', status,
                  'attemptCount', attempt_count,
                  'nextAttemptAt', next_attempt_at,
                  'lastError', last_error,
                  'updatedAt', updated_at,
                  'deliveredAt', delivered_at,
                  'slackMessageTs', slack_message_ts,
                  'slackTraceId', slack_trace_id,
                  'slackSendExecutionId', slack_send_execution_id,
                  'legacyUnverified', legacy_unverified
                ) AS state_json
         FROM deliveries
         WHERE delivery_id IN (SELECT delivery_id FROM relevant_delivery_ids)
            OR EXISTS (
              SELECT 1
              FROM report_input
              WHERE json_extract(value, '$.messageTs') IS NOT NULL
                AND deliveries.slack_message_ts =
                    json_extract(value, '$.messageTs')
                AND deliveries.destination = CASE
                  json_extract(value, '$.slackChannelId')
                  WHEN 'C0BMUK793NV' THEN 'alerts'
                  WHEN 'C0BMQMW3L4E' THEN 'activity'
                END
            )
         UNION ALL
         SELECT 'trace' AS row_kind,
                json_object(
                  'traceId', trace_id,
                  'deliveryId', delivery_id,
                  'outcome', outcome,
                  'attemptCount', relay_attempt,
                  'sendExecutionId', send_execution_id,
                  'destination', CASE slack_channel_id
                    WHEN 'C0BMUK793NV' THEN 'alerts'
                    WHEN 'C0BMQMW3L4E' THEN 'activity'
                  END,
                  'slackChannelId', slack_channel_id,
                  'messageTs', slack_message_ts,
                  'sendBoundaryReached', send_boundary_reached,
                  'preSendFailureProven', pre_send_failure_proven,
                  'startedAtUs', started_at_us,
                  'completedAtUs', completed_at_us,
                  'updatedAt', updated_at,
                  'appliedAt', applied_at
                ) AS state_json
         FROM slack_workflow_traces
         WHERE delivery_id IN (SELECT delivery_id FROM relevant_delivery_ids)
            OR trace_id IN (
              SELECT json_extract(value, '$.traceId') FROM report_input
            )
            OR send_execution_id IN (
              SELECT json_extract(value, '$.sendExecutionId')
              FROM report_input
              WHERE json_extract(value, '$.sendExecutionId') IS NOT NULL
            )
            OR EXISTS (
              SELECT 1
              FROM report_input
              WHERE json_extract(value, '$.messageTs') IS NOT NULL
                AND slack_workflow_traces.slack_channel_id =
                    json_extract(value, '$.slackChannelId')
                AND slack_workflow_traces.slack_message_ts =
                    json_extract(value, '$.messageTs')
            )`,
      )
      .bind(rawTracesJson, input.reportId)
      .all<SlackReconciliationPlanningRow>();

    const deliveries = new Map<string, SlackReconciliationDeliverySnapshot>();
    const existingTraces = new Map<string, SlackReconciliationTraceSnapshot>();
    let replay: SlackReconciliationReportResult | null = null;
    for (const row of planningRows.results) {
      const state = JSON.parse(row.state_json) as Record<string, unknown>;
      if (row.row_kind === "report") {
        replay = {
          traceCount: state.traceCount as number,
          changedErrorTraces: state.changedErrorTraces as number,
          requestedCheckpointUs: state.requestedCheckpointUs as number,
          checkpointUs: state.checkpointUs as number,
        };
      } else if (row.row_kind === "delivery") {
        const snapshot: SlackReconciliationDeliverySnapshot = {
          deliveryId: state.deliveryId as string,
          destination: state.destination as RelayDestination,
          status: state.status as DeliveryStatus,
          attemptCount: state.attemptCount as number,
          nextAttemptAt: state.nextAttemptAt as number,
          lastError: state.lastError as string | null,
          updatedAt: state.updatedAt as number,
          deliveredAt: state.deliveredAt as number | null,
          slackMessageTs: state.slackMessageTs as string | null,
          slackTraceId: state.slackTraceId as string | null,
          slackSendExecutionId: state.slackSendExecutionId as string | null,
          legacyUnverified: state.legacyUnverified === 1,
        };
        deliveries.set(snapshot.deliveryId, snapshot);
      } else {
        const snapshot: SlackReconciliationTraceSnapshot = {
          traceId: state.traceId as string,
          deliveryId: state.deliveryId as string,
          outcome: state.outcome as SlackTraceOutcome,
          attemptCount: state.attemptCount as number,
          sendExecutionId: state.sendExecutionId as string | null,
          destination: state.destination as RelayDestination | null,
          slackChannelId: state.slackChannelId as string | null,
          messageTs: state.messageTs as string | null,
          sendBoundaryReached: state.sendBoundaryReached === 1,
          preSendFailureProven: state.preSendFailureProven === 1,
          startedAtUs: state.startedAtUs as number,
          completedAtUs: state.completedAtUs as number | null,
          updatedAt: state.updatedAt as number,
          appliedAt: state.appliedAt as number | null,
        };
        existingTraces.set(snapshot.traceId, snapshot);
      }
    }
    if (replay !== null) {
      if (
        replay.traceCount !== input.traces.length ||
        replay.requestedCheckpointUs !== input.checkpointUs
      ) {
        throw new SlackReconciliationConflictError(
          "slack_reconciliation_report_conflict",
        );
      }
      return replay;
    }

    let plan: ReturnType<typeof planSlackReconciliation>;
    try {
      plan = planSlackReconciliation({
        traces: input.traces,
        deliveries,
        existingTraces,
        now: input.now,
      });
    } catch (error) {
      if (error instanceof SlackReconciliationPlanConflictError) {
        throw new SlackReconciliationConflictError(error.code);
      }
      throw error;
    }

    const traceChanges = input.traces.map(({ traceId }) => {
      const final = plan.traces.get(traceId);
      if (final === undefined) {
        throw new Error("slack_reconciliation_trace_plan_missing");
      }
      return { initial: existingTraces.get(traceId) ?? null, final };
    });
    const deliveryChanges = [...plan.deliveries].map(([deliveryId, final]) => ({
      initial: deliveries.get(deliveryId),
      final,
    }));
    if (deliveryChanges.some(({ initial }) => initial === undefined)) {
      throw new Error("slack_reconciliation_delivery_plan_missing");
    }
    const guardedDeliveryChanges = deliveryChanges as Array<{
      initial: SlackReconciliationDeliverySnapshot;
      final: SlackReconciliationDeliverySnapshot;
    }>;
    const traceChangesJson = JSON.stringify(traceChanges);
    const traceGuardsJson = JSON.stringify(
      [...plan.traces.values()].map((final) => ({ final })),
    );
    const deliveryChangesJson = JSON.stringify(guardedDeliveryChanges);
    const purgeExpiredReports = this.#database
      .prepare(
        `DELETE FROM slack_reconciliation_reports
         WHERE completed_at < ?`,
      )
      .bind(input.now - SLACK_RECONCILIATION_REPORT_RETENTION_MS);
    const insertNewTraces = this.#database
      .prepare(
        `INSERT INTO slack_workflow_traces (
           trace_id, delivery_id, outcome, relay_attempt, send_execution_id,
           slack_channel_id, slack_message_ts, send_boundary_reached,
           pre_send_failure_proven, started_at_us, completed_at_us,
           updated_at, applied_at
         )
         SELECT
           json_extract(value, '$.final.traceId'),
           json_extract(value, '$.final.deliveryId'),
           json_extract(value, '$.final.outcome'),
           json_extract(value, '$.final.attemptCount'),
           json_extract(value, '$.final.sendExecutionId'),
           json_extract(value, '$.final.slackChannelId'),
           json_extract(value, '$.final.messageTs'),
           json_extract(value, '$.final.sendBoundaryReached'),
           json_extract(value, '$.final.preSendFailureProven'),
           json_extract(value, '$.final.startedAtUs'),
           json_extract(value, '$.final.completedAtUs'),
           json_extract(value, '$.final.updatedAt'),
           json_extract(value, '$.final.appliedAt')
         FROM json_each(?)
         WHERE json_type(value, '$.initial') = 'null'
         ON CONFLICT(trace_id) DO NOTHING`,
      )
      .bind(traceChangesJson);
    const updateExistingTraces = this.#database
      .prepare(
        `UPDATE slack_workflow_traces AS current
         SET delivery_id = json_extract(entry.value, '$.final.deliveryId'),
             outcome = json_extract(entry.value, '$.final.outcome'),
             relay_attempt = json_extract(entry.value, '$.final.attemptCount'),
             send_execution_id =
               json_extract(entry.value, '$.final.sendExecutionId'),
             slack_channel_id =
               json_extract(entry.value, '$.final.slackChannelId'),
             slack_message_ts = json_extract(entry.value, '$.final.messageTs'),
             send_boundary_reached =
               json_extract(entry.value, '$.final.sendBoundaryReached'),
             pre_send_failure_proven =
               json_extract(entry.value, '$.final.preSendFailureProven'),
             started_at_us = json_extract(entry.value, '$.final.startedAtUs'),
             completed_at_us =
               json_extract(entry.value, '$.final.completedAtUs'),
             updated_at = json_extract(entry.value, '$.final.updatedAt'),
             applied_at = json_extract(entry.value, '$.final.appliedAt')
         FROM json_each(?) AS entry
         WHERE json_type(entry.value, '$.initial') = 'object'
           AND current.trace_id = json_extract(entry.value, '$.final.traceId')
           AND current.delivery_id IS
               json_extract(entry.value, '$.initial.deliveryId')
           AND current.outcome IS json_extract(entry.value, '$.initial.outcome')
           AND current.relay_attempt IS
               json_extract(entry.value, '$.initial.attemptCount')
           AND current.send_execution_id IS
               json_extract(entry.value, '$.initial.sendExecutionId')
           AND current.slack_channel_id IS
               json_extract(entry.value, '$.initial.slackChannelId')
           AND current.slack_message_ts IS
               json_extract(entry.value, '$.initial.messageTs')
           AND current.send_boundary_reached IS
               json_extract(entry.value, '$.initial.sendBoundaryReached')
           AND current.pre_send_failure_proven IS
               json_extract(entry.value, '$.initial.preSendFailureProven')
           AND current.started_at_us IS
               json_extract(entry.value, '$.initial.startedAtUs')
           AND current.completed_at_us IS
               json_extract(entry.value, '$.initial.completedAtUs')
           AND current.updated_at IS
               json_extract(entry.value, '$.initial.updatedAt')
           AND current.applied_at IS
               json_extract(entry.value, '$.initial.appliedAt')`,
      )
      .bind(traceChangesJson);
    const updateDeliveries = this.#database
      .prepare(
        `UPDATE deliveries AS current
         SET status = json_extract(entry.value, '$.final.status'),
             attempt_count = json_extract(entry.value, '$.final.attemptCount'),
             next_attempt_at =
               json_extract(entry.value, '$.final.nextAttemptAt'),
             last_error = json_extract(entry.value, '$.final.lastError'),
             updated_at = json_extract(entry.value, '$.final.updatedAt'),
             delivered_at = json_extract(entry.value, '$.final.deliveredAt'),
             slack_message_ts =
               json_extract(entry.value, '$.final.slackMessageTs'),
             slack_trace_id = json_extract(entry.value, '$.final.slackTraceId'),
             slack_send_execution_id =
               json_extract(entry.value, '$.final.slackSendExecutionId'),
             legacy_unverified =
               json_extract(entry.value, '$.final.legacyUnverified')
         FROM json_each(?) AS entry
         WHERE current.delivery_id =
               json_extract(entry.value, '$.initial.deliveryId')
           AND current.destination IS
               json_extract(entry.value, '$.initial.destination')
           AND current.status IS json_extract(entry.value, '$.initial.status')
           AND current.attempt_count IS
               json_extract(entry.value, '$.initial.attemptCount')
           AND current.next_attempt_at IS
               json_extract(entry.value, '$.initial.nextAttemptAt')
           AND current.last_error IS
               json_extract(entry.value, '$.initial.lastError')
           AND current.updated_at IS
               json_extract(entry.value, '$.initial.updatedAt')
           AND current.delivered_at IS
               json_extract(entry.value, '$.initial.deliveredAt')
           AND current.slack_message_ts IS
               json_extract(entry.value, '$.initial.slackMessageTs')
           AND current.slack_trace_id IS
               json_extract(entry.value, '$.initial.slackTraceId')
           AND current.slack_send_execution_id IS
               json_extract(entry.value, '$.initial.slackSendExecutionId')
           AND current.legacy_unverified IS
               json_extract(entry.value, '$.initial.legacyUnverified')`,
      )
      .bind(deliveryChangesJson);
    const errorTraceIdsJson = JSON.stringify(plan.errorTraceIds);
    const reserveErrors = this.#database
      .prepare(
        `INSERT INTO slack_reconciliation_report_errors (
           trace_id, report_id, committed_at
         )
         SELECT trace_id, ?, ?
         FROM slack_workflow_traces
         WHERE trace_id IN (SELECT value FROM json_each(?))
           AND outcome = 'error'
         ON CONFLICT(trace_id) DO NOTHING`,
      )
      .bind(input.reportId, input.now, errorTraceIdsJson);
    const advanceCheckpoint = this.#database
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
         WHERE singleton_id = 1`,
      )
      .bind(input.checkpointUs, input.checkpointUs);
    const journalReport = this.#database
      .prepare(
        `INSERT INTO slack_reconciliation_reports (
           report_id, trace_count, changed_error_traces,
           requested_checkpoint_us, checkpoint_us, completed_at
         ) VALUES (
           ?,
           CASE WHEN
             NOT EXISTS (
               SELECT 1
               FROM json_each(?) AS entry
               LEFT JOIN slack_workflow_traces AS trace
                 ON trace.trace_id =
                    json_extract(entry.value, '$.final.traceId')
               WHERE trace.trace_id IS NULL
                  OR trace.delivery_id IS NOT
                     json_extract(entry.value, '$.final.deliveryId')
                  OR trace.outcome IS NOT
                     json_extract(entry.value, '$.final.outcome')
                  OR trace.relay_attempt IS NOT
                     json_extract(entry.value, '$.final.attemptCount')
                  OR trace.send_execution_id IS NOT
                     json_extract(entry.value, '$.final.sendExecutionId')
                  OR trace.slack_channel_id IS NOT
                     json_extract(entry.value, '$.final.slackChannelId')
                  OR trace.slack_message_ts IS NOT
                     json_extract(entry.value, '$.final.messageTs')
                  OR trace.send_boundary_reached IS NOT
                     json_extract(entry.value, '$.final.sendBoundaryReached')
                  OR trace.pre_send_failure_proven IS NOT
                     json_extract(entry.value, '$.final.preSendFailureProven')
                  OR trace.started_at_us IS NOT
                     json_extract(entry.value, '$.final.startedAtUs')
                  OR trace.completed_at_us IS NOT
                     json_extract(entry.value, '$.final.completedAtUs')
                  OR trace.updated_at IS NOT
                     json_extract(entry.value, '$.final.updatedAt')
                  OR trace.applied_at IS NOT
                     json_extract(entry.value, '$.final.appliedAt')
             )
             AND NOT EXISTS (
               SELECT 1
               FROM json_each(?) AS delivery_entry
               WHERE (
                 SELECT COUNT(*)
                 FROM slack_workflow_traces
                 WHERE delivery_id = json_extract(
                   delivery_entry.value,
                   '$.final.deliveryId'
                 )
               ) != (
                 SELECT COUNT(*)
                 FROM json_each(?) AS trace_entry
                 WHERE json_extract(
                   trace_entry.value,
                   '$.final.deliveryId'
                 ) = json_extract(
                   delivery_entry.value,
                   '$.final.deliveryId'
                 )
               )
             )
             AND NOT EXISTS (
               SELECT 1
               FROM json_each(?) AS entry
               LEFT JOIN deliveries AS delivery
                 ON delivery.delivery_id =
                    json_extract(entry.value, '$.final.deliveryId')
               WHERE delivery.delivery_id IS NULL
                  OR delivery.destination IS NOT
                     json_extract(entry.value, '$.final.destination')
                  OR delivery.status IS NOT
                     json_extract(entry.value, '$.final.status')
                  OR delivery.attempt_count IS NOT
                     json_extract(entry.value, '$.final.attemptCount')
                  OR delivery.next_attempt_at IS NOT
                     json_extract(entry.value, '$.final.nextAttemptAt')
                  OR delivery.last_error IS NOT
                     json_extract(entry.value, '$.final.lastError')
                  OR delivery.updated_at IS NOT
                     json_extract(entry.value, '$.final.updatedAt')
                  OR delivery.delivered_at IS NOT
                     json_extract(entry.value, '$.final.deliveredAt')
                  OR delivery.slack_message_ts IS NOT
                     json_extract(entry.value, '$.final.slackMessageTs')
                  OR delivery.slack_trace_id IS NOT
                     json_extract(entry.value, '$.final.slackTraceId')
                  OR delivery.slack_send_execution_id IS NOT
                     json_extract(entry.value, '$.final.slackSendExecutionId')
                  OR delivery.legacy_unverified IS NOT
                     json_extract(entry.value, '$.final.legacyUnverified')
             )
             AND EXISTS (
               SELECT 1 FROM relay_state WHERE singleton_id = 1
             )
             THEN ? ELSE -1 END,
           (SELECT COUNT(*)
            FROM slack_reconciliation_report_errors
            WHERE report_id = ?),
           ?,
           COALESCE(
             (SELECT MIN(slack_activity_checkpoint_us, ?)
              FROM relay_state WHERE singleton_id = 1),
             -1
           ),
           ?
         )`,
      )
      .bind(
        input.reportId,
        traceGuardsJson,
        deliveryChangesJson,
        traceGuardsJson,
        deliveryChangesJson,
        input.traces.length,
        input.reportId,
        input.checkpointUs,
        input.checkpointUs,
        input.now,
      );

    try {
      await this.#database.batch([
        purgeExpiredReports,
        insertNewTraces,
        updateExistingTraces,
        updateDeliveries,
        reserveErrors,
        advanceCheckpoint,
        journalReport,
      ]);
    } catch (error) {
      const racedReplay = await this.getSlackReconciliationReport(
        input.reportId,
      );
      if (racedReplay !== null) {
        if (
          racedReplay.traceCount !== input.traces.length ||
          racedReplay.requestedCheckpointUs !== input.checkpointUs
        ) {
          throw new SlackReconciliationConflictError(
            "slack_reconciliation_report_conflict",
          );
        }
        return racedReplay;
      }
      throw error;
    }
    const result = await this.getSlackReconciliationReport(input.reportId);
    if (
      result === null ||
      result.traceCount !== input.traces.length ||
      result.requestedCheckpointUs !== input.checkpointUs
    ) {
      throw new Error("slack_reconciliation_report_unavailable");
    }
    return result;
  }

  async finalizeSlackReconciliationReport(
    reportId: string,
    traceCount: number,
    errorTraceIds: readonly string[],
    checkpointUs: number,
    now: number,
  ): Promise<SlackReconciliationReportResult> {
    if (
      !SLACK_RECONCILIATION_REPORT_ID_PATTERN.test(reportId) ||
      !Number.isSafeInteger(traceCount) ||
      traceCount < 0 ||
      traceCount > SLACK_RECONCILIATION_TRACE_LIMIT ||
      errorTraceIds.length > traceCount ||
      new Set(errorTraceIds).size !== errorTraceIds.length ||
      errorTraceIds.some((traceId) => !SLACK_TRACE_ID_PATTERN.test(traceId)) ||
      !Number.isSafeInteger(checkpointUs) ||
      checkpointUs < 0 ||
      !Number.isSafeInteger(now) ||
      now <= 0
    ) {
      throw new SlackReconciliationConflictError(
        "invalid_slack_reconciliation_report",
      );
    }

    const replay = await this.getSlackReconciliationReport(reportId);
    if (replay !== null) {
      if (
        replay.traceCount !== traceCount ||
        replay.requestedCheckpointUs !== checkpointUs
      ) {
        throw new SlackReconciliationConflictError(
          "slack_reconciliation_report_conflict",
        );
      }
      return replay;
    }

    const purgeExpiredReports = this.#database
      .prepare(
        `DELETE FROM slack_reconciliation_reports
         WHERE completed_at < ?`,
      )
      .bind(now - SLACK_RECONCILIATION_REPORT_RETENTION_MS);
    const errorPlaceholders = errorTraceIds.map(() => "?").join(", ");
    const reserveErrors =
      errorTraceIds.length === 0
        ? this.#database.prepare(`SELECT 1 WHERE 0`)
        : this.#database
            .prepare(
              `INSERT INTO slack_reconciliation_report_errors (
                 trace_id, report_id, committed_at
               )
               SELECT trace_id, ?, ?
               FROM slack_workflow_traces
               WHERE trace_id IN (${errorPlaceholders})
                 AND outcome = 'error'
                 AND NOT EXISTS (
                   SELECT 1
                   FROM slack_reconciliation_report_errors AS reported
                   WHERE reported.trace_id = slack_workflow_traces.trace_id
                 )
               ON CONFLICT(trace_id) DO NOTHING`,
            )
            .bind(reportId, now, ...errorTraceIds);
    const advanceCheckpoint = this.#database
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
         WHERE singleton_id = 1`,
      )
      .bind(checkpointUs, checkpointUs);
    const journalReport = this.#database
      .prepare(
        `INSERT INTO slack_reconciliation_reports (
           report_id, trace_count, changed_error_traces,
           requested_checkpoint_us, checkpoint_us, completed_at
         )
         SELECT ?, ?,
                (SELECT COUNT(*)
                 FROM slack_reconciliation_report_errors
                 WHERE report_id = ?),
                ?, MIN(slack_activity_checkpoint_us, ?), ?
         FROM relay_state
         WHERE singleton_id = 1
         ON CONFLICT(report_id) DO NOTHING`,
      )
      .bind(reportId, traceCount, reportId, checkpointUs, checkpointUs, now);

    await this.#database.batch([
      purgeExpiredReports,
      reserveErrors,
      advanceCheckpoint,
      journalReport,
    ]);
    const result = await this.getSlackReconciliationReport(reportId);
    if (
      result === null ||
      result.traceCount !== traceCount ||
      result.requestedCheckpointUs !== checkpointUs
    ) {
      throw new Error("slack_reconciliation_report_unavailable");
    }
    return result;
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
           AND slack_delivery_protocol_activated_at = ?
           AND typeof(slack_delivery_protocol_activation_id) = 'text'
           AND slack_delivery_protocol_activation_id = ?
           AND length(slack_delivery_protocol_activation_id) = 64
           AND slack_delivery_protocol_activation_id NOT GLOB '*[^0-9a-f]*'
           AND slack_delivery_protocol_schema_revision = ?
           AND slack_delivery_protocol_confirmation_open = 0`,
      )
      .bind(
        SLACK_DELIVERY_PROTOCOL_SEALED_REVISION,
        SLACK_DELIVERY_PROTOCOL_SEALED_ACTIVATED_AT,
        SLACK_DELIVERY_PROTOCOL_SEALED_ACTIVATION_ID,
        SLACK_DELIVERY_PROTOCOL_SCHEMA_REVISION,
      )
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
      (await this.#hasExactSlackDeliveryProtocolSeal()) &&
      (await this.#hasExactSlackReconciliationSchema()) &&
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
