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
