-- ADR-002 §4 (emendado em 16/08) — entrega de alertas, DOIS estados.
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
  -- O payload NORMALIZADO, não a mensagem renderizada. A montagem acontece
  -- no instante do envio, e é isso que dá caminho de reparo sem superfície
  -- de comando: corrigir o renderizador e implantar faz a tentativa
  -- seguinte funcionar sobre esta mesma linha (ADR-002 §4).
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  -- Dois estados, e o domínio fechado é a restrição que os prende.
  -- Não existe 'failed': a decisão 12 apagou o terminal. Uma entrega
  -- recusada continua 'pending' e será tentada de novo, sempre. A única
  -- saída além de 'sent' é o apagamento por retenção, que só alcança linha
  -- já entregue — apagar 'pending' seria perder o alerta.
  state TEXT NOT NULL CHECK (state IN ('pending', 'sent')),
  -- Monotônico. Nada o compara com um teto, porque teto não existe (ADR-002
  -- §5, decisão 7, revogada pela 12) — mas ele NÃO é só diagnóstico: entra
  -- no cálculo do recuo que decide quando o cron reagenda (§4).
  -- typeof() é obrigatório: `INTEGER` no SQLite é afinidade, não tipo, e
  -- sem ele o CHECK aceita 0.5 e aceita texto. Valor malformado aqui move
  -- a próxima tentativa, não suja um relatório.
  attempts INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(attempts) = 'integer' AND attempts >= 0),
  -- O tempo devido, PRÉ-COMPUTADO no carimbo do cron (ADR-002 §4):
  -- next_due_ms = agora + recuo(attempts). Pré-computado porque a forma
  -- por expressão — updated_ms + recuo(attempts) na consulta — não é
  -- indexável: updated_ms carrega o agora do último carimbo, então
  -- "updated_ms <= agora" casa com praticamente toda linha pendente, e o
  -- conjunto pendente é ilimitado por desenho (decisão 12). DEFAULT 0 é
  -- recuo(0): linha recém-inserida é devida no próximo passe.
  next_due_ms INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(next_due_ms) = 'integer' AND next_due_ms >= 0),
  slack_message_ts TEXT,
  last_error TEXT,
  -- Âncora da idade que o vigia lê. NENHUM caminho de recuperação escreve
  -- esta coluna: é o invariante da instância B. O teste que o prova por
  -- mutação pertence ao store, que ainda NÃO existe nesta branch — até ele
  -- existir, esta linha é intenção declarada, não restrição observada.
  created_ms INTEGER NOT NULL,
  -- Escrito a cada tentativa. É deste campo, somado ao recuo, que o cron
  -- calcula o tempo devido — e é justamente por isso que o vigia NÃO pode
  -- lê-lo (ADR-001 H40: ancorar a idade aqui manteria o alarme mudo).
  updated_ms INTEGER NOT NULL
);

-- Dois índices, dois leitores diferentes, e a distinção é o desenho:
--
-- 1) O VIGIA lê a idade da linha pendente mais velha, ancorada em created_ms,
--    que nenhum caminho de recuperação escreve (instância B).
CREATE INDEX idx_alert_delivery_pending ON alert_delivery (state, created_ms);
--
-- 2) O CRON seleciona por tempo devido pré-computado: next_due_ms.
--    (A versão anterior deste índice era por updated_ms, com um comentário
--    afirmando que "updated_ms <= agora" estreitava a varredura. Falso, e a
--    revisão pegou: updated_ms É o agora do último carimbo, então a condição
--    casa com praticamente tudo. A curva do recuo continua fora do esquema —
--    ela vive no código que carimba, e o esquema só guarda o resultado.)
CREATE INDEX idx_alert_delivery_due ON alert_delivery (state, next_due_ms);
