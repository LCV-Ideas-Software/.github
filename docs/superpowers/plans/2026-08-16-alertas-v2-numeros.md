# Os quatro números do ADR-002, cada um com a fonte ou a justificativa

Produto da Tarefa 1 do plano. Nenhum valor aqui é gosto: cada um tem ou uma citação, ou uma conta que qualquer pessoa refaz.

## Restrições que os números têm de respeitar

Lidas da configuração desta branch, não de memória — `workers/github-slack-relay/wrangler.jsonc`:

| Ajuste | Valor | Linha |
|---|---|---|
| `max_retries` do consumidor de alertas | `5` | 81 |
| `retry_delay` do consumidor | `2` (segundos) | 83 |
| `max_batch_size` | `1` | 79 |
| `max_concurrency` | `1` | 82 |
| Cron do Worker | `*/5 * * * *` | 111 |

Da [documentação de batching, retries e delays](https://developers.cloudflare.com/queues/configuration/batching-retries/), verbatim:

> *"Messages can be delayed by up to 24 hours."*
> *"Each message delivered to a consumer includes an `attempts` property that tracks the number of delivery attempts made."*
> *"Messages that reach the configured maximum retries will be deleted from the queue, or if a dead-letter queue (DLQ) is configured, written to the DLQ instead."*

E o helper que a própria documentação fornece:

```js
function calculateExponentialBackoff(attempts, baseDelaySeconds) {
	return baseDelaySeconds ** attempts;
}
```

**Consequência que fixa tudo o mais:** a mensagem que esgota as tentativas é **apagada**. O `retry_delay: 2` configurado dá uma janela de insistência de cerca de 10 segundos com as 5 tentativas — curta demais para absorver qualquer indisponibilidade real. Sem recuo por mensagem e sem o cron, um soluço de meio minuto no Slack apagaria o alerta.

---

## `MAX_SEND_ATTEMPTS = 4`

**Restrição dura:** tem de ser **menor** que o `max_retries: 5` da fila, para o teto da aplicação disparar primeiro. Se o teto da fila disparasse antes, a mensagem sairia por um caminho que os três estados não sabem representar, e a linha ficaria `pending` para sempre (ADR-002 §5, decisão 8).

**O que ele limita, além de girar à toa:** é o **teto da amplificação de duplicatas**. Um envio que deu certo cuja resposta se perdeu é indistinguível de um que falhou, e a regra é retentar na dúvida — então cada tentativa pode produzir uma cópia. Quatro tentativas é o pior caso por ciclo de fila.

## `RETRY_BASE_DELAY_SECONDS = 5`

Com o helper da documentação, os atrasos por tentativa ficam **5 s, 25 s, 125 s**, e a quarta tentativa acontece cerca de **155 segundos (2,6 min)** depois da primeira.

**Por que 5 e não mais:** a janela da fila não precisa cobrir uma queda longa — quem cobre é o cron. Ela só precisa absorver o soluço curto sem consumir tentativa à toa. Base 6 daria 6+36+216 = 258 s; base 10 daria 1110 s (18,5 min) e empurraria a linha para além do limiar do cron, criando republicação concorrente. Base 5 é o maior valor que ainda cabe confortavelmente dentro do limiar escolhido abaixo.

**Teto da plataforma respeitado:** 125 s está muito abaixo do máximo documentado de 24 horas.

## `CRON_STALE_AFTER_MS = 600_000` (10 minutos)

**Restrição inferior:** tem de ser maior que a janela de insistência da fila (155 s), senão o cron republica uma linha que a fila ainda está tentando — duas entregas simultâneas da mesma linha, e portanto duplicata garantida em vez de possível. 600 s dá margem de quase 4×.

**Restrição superior:** o cron roda a cada 5 minutos, então uma linha que cruza o limiar é recuperada em até 5 minutos. O pior caso de invisibilidade é **10 + 5 = 15 minutos**, que é o número que o limiar de alarme do vigia tem de respeitar — o vigia não pode alarmar antes disso, ou alarmaria sobre recuperação normal em curso.

## `ROW_RETENTION_MS = 30 dias`

**A consequência, escrita aqui e não em outra seção** (ADR-002 §5, decisão 10): a linha guardada **é** a trava de deduplicação. Enquanto ela existe, um *Redeliver* do mesmo GUID pelo painel de webhooks do GitHub não vira segunda mensagem. Depois que ela é apagada, vira — e a pergunta "o que aconteceu com aquele alerta?" deixa de ter resposta no banco.

**Por que 30 dias:** é o prazo que o sistema anterior já praticava para linhas entregues, então não introduz regime novo de armazenamento; e cobre com folga a janela em que um *Redeliver* manual é plausível durante a investigação de um incidente.

---

## Tabela final

| Constante | Valor | Fixado por |
|---|---|---|
| `MAX_SEND_ATTEMPTS` | `4` | menor que `max_retries: 5` da fila |
| `RETRY_BASE_DELAY_SECONDS` | `5` | maior base que cabe dentro do limiar do cron |
| `CRON_STALE_AFTER_MS` | `600_000` | > 155 s da fila; < limiar do vigia |
| `ROW_RETENTION_MS` | `2_592_000_000` | 30 dias; é a janela de deduplicação |

**Derivado, para o vigia:** o pior caso de invisibilidade de um alerta em operação normal é **15 minutos**. Qualquer limiar de alarme do vigia tem de ser maior que isso.
