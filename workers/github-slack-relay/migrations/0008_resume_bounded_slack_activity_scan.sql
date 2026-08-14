-- Preserve whether the activity monitor must resume a bounded catch-up from
-- its acknowledged checkpoint instead of replaying the normal overlap.
CREATE TABLE slack_activity_scan_state (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
  resume_from_us INTEGER CHECK (
    resume_from_us IS NULL OR resume_from_us >= 0
  )
);

INSERT INTO slack_activity_scan_state (singleton_id, resume_from_us)
VALUES (1, NULL);
