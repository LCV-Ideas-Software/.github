-- Preserve the terminal result of each authenticated reconciliation report.
-- A client can safely replay the same signed body after an ambiguous network
-- failure and receive the original error count and checkpoint.
CREATE TABLE slack_reconciliation_reports (
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
);

CREATE INDEX idx_slack_reconciliation_reports_completed
  ON slack_reconciliation_reports (completed_at);

-- A terminal error is novel exactly once, even when an interrupted report is
-- replayed or overlaps a later report. No historical receipt is inferred: the
-- first authenticated post-migration observation owns the receipt.
CREATE TABLE slack_reconciliation_report_errors (
  trace_id TEXT PRIMARY KEY NOT NULL
    REFERENCES slack_workflow_traces(trace_id) ON DELETE CASCADE,
  report_id TEXT NOT NULL CHECK (
    length(report_id) = 64
    AND report_id NOT GLOB '*[^0-9a-f]*'
  ),
  committed_at INTEGER NOT NULL CHECK (committed_at > 0)
);

CREATE INDEX idx_slack_reconciliation_report_errors_report
  ON slack_reconciliation_report_errors (report_id);
