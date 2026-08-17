-- Aposentadoria do pipeline legado GitHub→Slack (ADR-002; autorizada pelo
-- operador em 17/08/2026). O caminho v2 (alert_delivery) é o único vivo;
-- estas tabelas pertenciam à implementação anterior (workflow app + filas
-- de atividade) e foram ARQUIVADAS antes do DROP em
-- backups/d1-github-slack-alerts-db-pre-aposentadoria-legado-20260817.sql
-- (sha256 61988815b53ac4b71538d4357bebffe097ee413ac7cab4a639bb0537b91f8869).
-- DROP TABLE remove os índices junto; IF EXISTS torna a migração
-- idempotente num banco que nunca teve o legado.
DROP TABLE IF EXISTS slack_reconciliation_report_errors;
DROP TABLE IF EXISTS slack_reconciliation_reports;
DROP TABLE IF EXISTS slack_trace_hydration_registry;
DROP TABLE IF EXISTS slack_workflow_traces;
DROP TABLE IF EXISTS slack_delivery_recovery_audit;
DROP TABLE IF EXISTS slack_activity_scan_state;
DROP TABLE IF EXISTS relay_state;
DROP TABLE IF EXISTS deliveries;
