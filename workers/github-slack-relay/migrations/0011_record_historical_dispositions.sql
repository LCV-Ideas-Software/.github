-- ADR-001 §6.9 option (a), chosen by the operator on 2026-08-14 (issue #192
-- comment 5297040618): audited closed_manual disposition, WITHOUT resend, for
-- the two deliveries stranded in accepted_by_trigger by the retired
-- reconstruction architecture. The legacy rows in `deliveries` are NOT
-- touched (frozen forever behind the presence fence); this records the
-- decision durably in the new-path audit journal. at_ms is the decision
-- timestamp (2026-08-14T18:55:00Z).
INSERT INTO dispatch_audit (
  delivery_id,
  from_state,
  to_state,
  evidence_json,
  actor,
  at_ms
)
VALUES
  (
    'd43b2d70-9772-11f1-805f-1846e9afeb67',
    'accepted_by_trigger',
    'closed_manual',
    json(
      '{"decision":"ADR-001 §6.9 option (a): closed_manual without resend",'
      || '"reason":"stale self-referential deployment_status alert about the retired slack-production path; resend adds no information and risks a duplicate",'
      || '"record":"https://github.com/LCV-Ideas-Software/.github/issues/192#issuecomment-5297040618",'
      || '"legacy_row":"deliveries.status=accepted_by_trigger, slack fields NULL, untouched"}'
    ),
    'operator',
    1786733700000
  ),
  (
    '0aac32b0-97b8-11f1-825a-68c75513476d',
    'accepted_by_trigger',
    'closed_manual',
    json(
      '{"decision":"ADR-001 §6.9 option (a): closed_manual without resend",'
      || '"reason":"stale workflow_run alert for astrologo-app; the underlying incident was handled and closed; resend adds no information and risks a duplicate",'
      || '"record":"https://github.com/LCV-Ideas-Software/.github/issues/192#issuecomment-5297040618",'
      || '"legacy_row":"deliveries.status=accepted_by_trigger, slack fields NULL, untouched"}'
    ),
    'operator',
    1786733700000
  );
