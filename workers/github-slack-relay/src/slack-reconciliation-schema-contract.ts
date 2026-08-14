export const SLACK_RECONCILIATION_REPORTS_TABLE_SQL = `CREATE TABLE slack_reconciliation_reports (
  report_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(report_id) = 64
    AND report_id NOT GLOB '*[^0-9a-f]*'
  ),
  trace_count INTEGER NOT NULL CHECK (trace_count BETWEEN 0 AND 25),
  changed_error_traces INTEGER NOT NULL CHECK (
    changed_error_traces BETWEEN 0 AND trace_count
  ),
  requested_checkpoint_us INTEGER NOT NULL CHECK (requested_checkpoint_us >= 0),
  checkpoint_us INTEGER NOT NULL CHECK (
    checkpoint_us BETWEEN 0 AND requested_checkpoint_us
  ),
  completed_at INTEGER NOT NULL CHECK (completed_at > 0)
)`;

export const SLACK_RECONCILIATION_REPORT_ERRORS_TABLE_SQL = `CREATE TABLE slack_reconciliation_report_errors (
  trace_id TEXT PRIMARY KEY NOT NULL
    REFERENCES slack_workflow_traces(trace_id) ON DELETE CASCADE,
  report_id TEXT NOT NULL CHECK (
    length(report_id) = 64
    AND report_id NOT GLOB '*[^0-9a-f]*'
  ),
  committed_at INTEGER NOT NULL CHECK (committed_at > 0)
)`;

export const SLACK_RECONCILIATION_REPORTS_COMPLETED_INDEX_SQL = `CREATE INDEX idx_slack_reconciliation_reports_completed
  ON slack_reconciliation_reports (completed_at)`;

export const SLACK_RECONCILIATION_REPORT_ERRORS_REPORT_INDEX_SQL = `CREATE INDEX idx_slack_reconciliation_report_errors_report
  ON slack_reconciliation_report_errors (report_id)`;

export const SLACK_ACTIVITY_SCAN_STATE_TABLE_SQL = `CREATE TABLE slack_activity_scan_state (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
  resume_from_us INTEGER CHECK (
    resume_from_us IS NULL OR resume_from_us >= 0
  )
)`;

export const SLACK_TRACE_HYDRATION_REGISTRY_TABLE_SQL = `CREATE TABLE slack_trace_hydration_registry (
  trace_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(trace_id) BETWEEN 3 AND 127
    AND trace_id GLOB 'Tr[A-Za-z0-9_-]*'
    AND trace_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  first_observed_us INTEGER NOT NULL CHECK (first_observed_us >= 0),
  last_observed_us INTEGER NOT NULL CHECK (
    last_observed_us >= first_observed_us
  ),
  last_hydrated_at INTEGER NOT NULL CHECK (last_hydrated_at >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'debt')),
  debt_reason TEXT CHECK (
    debt_reason IS NULL
    OR debt_reason IN ('retention_expired', 'pagination_bound')
  ),
  updated_at INTEGER NOT NULL CHECK (updated_at >= last_hydrated_at),
  CHECK (
    (status = 'pending' AND debt_reason IS NULL)
    OR (status = 'debt' AND debt_reason IS NOT NULL)
  )
)`;

export const SLACK_TRACE_HYDRATION_REGISTRY_PENDING_INDEX_SQL = `CREATE INDEX idx_slack_trace_hydration_registry_pending
  ON slack_trace_hydration_registry (
    status, last_hydrated_at, first_observed_us, trace_id
  )`;

export const SLACK_ACTIVITY_SCAN_STATE_COLUMN_CONTRACT =
  "singleton_id:INTEGER:1:1,resume_from_us:INTEGER:0:0";

export const SLACK_TRACE_HYDRATION_REGISTRY_COLUMN_CONTRACT =
  "trace_id:TEXT:1:1,first_observed_us:INTEGER:1:0,last_observed_us:INTEGER:1:0,last_hydrated_at:INTEGER:1:0,status:TEXT:1:0,debt_reason:TEXT:0:0,updated_at:INTEGER:1:0";

export const SLACK_TRACE_HYDRATION_REGISTRY_INDEX_CONTRACT =
  "idx_slack_trace_hydration_registry_pending:0:c:0,sqlite_autoindex_slack_trace_hydration_registry_1:1:pk:0";

export const SLACK_RECONCILIATION_SCHEMA_OBJECT_CONTRACT = Object.freeze([
  Object.freeze({
    type: "index",
    name: "idx_slack_reconciliation_report_errors_report",
    tbl_name: "slack_reconciliation_report_errors",
    sql: SLACK_RECONCILIATION_REPORT_ERRORS_REPORT_INDEX_SQL,
  }),
  Object.freeze({
    type: "index",
    name: "idx_slack_reconciliation_reports_completed",
    tbl_name: "slack_reconciliation_reports",
    sql: SLACK_RECONCILIATION_REPORTS_COMPLETED_INDEX_SQL,
  }),
  Object.freeze({
    type: "index",
    name: "idx_slack_trace_hydration_registry_pending",
    tbl_name: "slack_trace_hydration_registry",
    sql: SLACK_TRACE_HYDRATION_REGISTRY_PENDING_INDEX_SQL,
  }),
  Object.freeze({
    type: "table",
    name: "slack_activity_scan_state",
    tbl_name: "slack_activity_scan_state",
    sql: SLACK_ACTIVITY_SCAN_STATE_TABLE_SQL,
  }),
  Object.freeze({
    type: "table",
    name: "slack_reconciliation_report_errors",
    tbl_name: "slack_reconciliation_report_errors",
    sql: SLACK_RECONCILIATION_REPORT_ERRORS_TABLE_SQL,
  }),
  Object.freeze({
    type: "table",
    name: "slack_reconciliation_reports",
    tbl_name: "slack_reconciliation_reports",
    sql: SLACK_RECONCILIATION_REPORTS_TABLE_SQL,
  }),
  Object.freeze({
    type: "table",
    name: "slack_trace_hydration_registry",
    tbl_name: "slack_trace_hydration_registry",
    sql: SLACK_TRACE_HYDRATION_REGISTRY_TABLE_SQL,
  }),
]);

export const SLACK_RECONCILIATION_REPORT_COLUMN_CONTRACT =
  "report_id:TEXT:1:1,trace_count:INTEGER:1:0,changed_error_traces:INTEGER:1:0,requested_checkpoint_us:INTEGER:1:0,checkpoint_us:INTEGER:1:0,completed_at:INTEGER:1:0";

export const SLACK_RECONCILIATION_REPORT_ERROR_COLUMN_CONTRACT =
  "trace_id:TEXT:1:1,report_id:TEXT:1:0,committed_at:INTEGER:1:0";

export const SLACK_RECONCILIATION_REPORT_FOREIGN_KEY_CONTRACT =
  "0:0:slack_workflow_traces:trace_id:trace_id:NO ACTION:CASCADE:NONE";

export const SLACK_RECONCILIATION_REPORT_INDEX_CONTRACT =
  "idx_slack_reconciliation_reports_completed:0:c:0,sqlite_autoindex_slack_reconciliation_reports_1:1:pk:0";

export const SLACK_RECONCILIATION_REPORT_ERROR_INDEX_CONTRACT =
  "idx_slack_reconciliation_report_errors_report:0:c:0,sqlite_autoindex_slack_reconciliation_report_errors_1:1:pk:0";
