-- Persist the bounded set of Slack traces that need a trace_id-filtered
-- hydration without treating an expiring Slack pagination cursor as durable.
CREATE TABLE slack_trace_hydration_registry (
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
);

CREATE INDEX idx_slack_trace_hydration_registry_pending
  ON slack_trace_hydration_registry (
    status, last_hydrated_at, first_observed_us, trace_id
  );
