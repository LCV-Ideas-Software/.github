-- ADR-002 §4 — entrega de alertas, três estados.
--
-- Tabela NOVA em vez de reaproveitar `deliveries` (decisão 6 do operador):
-- aquela tabela tem um CHECK com os dez estados do sistema anterior, e
-- escrever 'sent' nela faria o banco recusar, o consumidor lançar e o
-- alerta se perder no primeiro dia.
--
-- Migração 0010: produção tem 0001..0009 aplicadas, verificado por consulta
-- ao d1_migrations do banco github-slack-alerts-db em 16/08/2026.
CREATE TABLE alert_delivery (
  -- O GUID da entrega do GitHub. É ele que faz a redelivery não virar
  -- segunda mensagem, e por isso a retenção da linha é também a janela de
  -- deduplicação (ADR-002 §5, decisão 10). Mesmo formato que o ingress já
  -- valida em DELIVERY_ID_PATTERN (src/index.ts).
  delivery_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(delivery_id) BETWEEN 1 AND 128
    AND delivery_id NOT GLOB '*[^A-Za-z0-9-]*'
  ),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  state TEXT NOT NULL CHECK (state IN ('pending', 'sent', 'failed')),
  -- Monotônico. O cron NUNCA o reinicia: ADR-002 §6, instância B — se a
  -- recuperação apagasse o rastro das tentativas, uma linha que gira para
  -- sempre ficaria indistinguível de uma recém-chegada.
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- Estacionada: a falha é intrínseca à LINHA (mensagem longa demais,
  -- payload irrenderizável), então reenviar a mesma linha nunca funciona,
  -- nem depois de o operador corrigir a causa. É CONTAGEM, não condição de
  -- alarme — o vigia alarma no delta (ADR-002 §6, instância C′).
  parked INTEGER NOT NULL DEFAULT 0 CHECK (parked IN (0, 1)),
  slack_message_ts TEXT,
  last_error TEXT,
  -- Âncora da idade que o vigia lê. NENHUM caminho de recuperação escreve
  -- esta coluna. É o invariante da instância B, e o teste do store o prova
  -- por mutação: trocar updated_ms por created_ms num UPDATE faz falhar.
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL
);

-- O cron seleciona linhas pendentes por idade de ingresso, em ordem.
CREATE INDEX idx_alert_delivery_pending ON alert_delivery (state, created_ms);
