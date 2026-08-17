# Os números do ADR-002, cada um com a fonte ou a justificativa

Produto da Tarefa 1 do plano. Nenhum valor aqui é gosto: cada um tem ou uma citação, ou uma conta que qualquer pessoa refaz.

> ## ⚠️ Revisado em 16/08 — dois dos quatro números morreram
>
> A emenda do ADR-002 (decisão 12) **revogou o teto de tentativas**, e com ele a base de recuo que existia para caber dentro do teto. Manter `MAX_SEND_ATTEMPTS = 4` publicado aqui orientaria um consumidor a **parar de tentar** — exatamente o estado terminal que a decisão 12 apagou, e portanto perda de alerta. Os revisores automáticos apontaram isto em quatro passes.
>
> As seções dos dois números mortos ficam abaixo **riscadas**, não apagadas: elas registram o raciocínio que a emenda derrubou, e apagá-las esconderia por que o desenho mudou.

## Restrições que os números têm de respeitar

Lidas da configuração como estava ANTES da mudança — este documento mediu a
linha de base sobre a qual a decisão 8 (emendada) operou; os valores vigentes
pós-decisão vêm logo abaixo:

*(A coluna de linha foi removida em 16/08: os bindings adicionados no mesmo PR deslocaram o arquivo e as cinco referências numéricas apodreceram — achado da revisão. Âncora por chave, que sobrevive a edição.)*

| Ajuste (no `wrangler.jsonc`, consumidor de `github-slack-alerts`) | Linha de base PRÉ-mudança | Vigente (decisão 8 emendada) |
|---|---|---|
| `max_retries` | `5` | `0` |
| `retry_delay` | `2` (segundos) | *(removido)* |
| `max_batch_size` | `1` | `1` |
| `max_concurrency` | `1` | `1` |
| `dead_letter_queue` | `github-slack-alerts-dlq` | *(removida; DLQ sem consumidor)* |
| `triggers.crons` do Worker | `*/5 * * * *` | `*/5 * * * *` |

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

**Consequência que fixa tudo o mais** — ~~a mensagem que esgota as tentativas é **apagada**~~. **Corrigido em 16/08:** essa frase descreve uma configuração que **esta branch não tem**. o consumidor de `github-slack-alerts` no `wrangler.jsonc` define `dead_letter_queue: "github-slack-alerts-dlq"`, e a DLQ tem consumidor próprio — então hoje a mensagem esgotada **vai para a fila de descarte**, não é apagada. A premissa só passa a valer depois que a decisão 8 remover a fila — e, com a emenda do cron único (ADR-002 §4), ela deixa de importar **no caminho normal**: o consumidor sempre confirma a mensagem ao retornar, então `max_retries` e fila de descarte não disparam em operação. *(Qualificado em 17/08: "jamais disparam", absoluto, era falso — a confirmação só acontece quando o handler retorna, e um crash do Worker antes disso reentrega a mensagem, podendo esgotar `max_retries` e alcançar a DLQ enquanto a configuração do §12 não for aplicada. O caso residual está tratado no bloco do agendador residual do ADR §4.)*

---

## ~~`MAX_SEND_ATTEMPTS = 4`~~ — REVOGADO pela decisão 12

~~**Restrição dura:** tem de ser **menor** que o `max_retries: 5` da fila, para o teto da aplicação disparar primeiro. Se o teto da fila disparasse antes, a mensagem sairia por um caminho que os três estados não sabem representar, e a linha ficaria `pending` para sempre (ADR-002 §5, decisão 8).~~

~~**O que ele limita, além de girar à toa:** é o **teto da amplificação de duplicatas**. Um envio que deu certo cuja resposta se perdeu é indistinguível de um que falhou, e a regra é retentar na dúvida — então cada tentativa pode produzir uma cópia. Quatro tentativas é o pior caso por ciclo de fila.~~

**Não existe teto.** Toda linha recusada permanece `pendente` e é retentada indefinidamente. O que limita a amplificação é o recuo, e o que a encerra é uma pessoa — ADR-002 §5, decisão 12, onde isso está escrito com o custo declarado, inclusive o fato de a duplicação total ser **ilimitada no tempo**.

**Registro do erro de processo, porque ele importa mais que o número:** a decisão 7 e o §10 mandavam escolher o teto **por medição**, e eu o escolhi por restrição (ser menor que `max_retries: 5`) sem dizer que trocara o critério. O Copilot apontou em quatro passes. O ponto virou discutível porque o número deixou de existir, mas o erro aconteceu.

## `RECUO` — cresce por tentativa e satura em 24 h

Substitui a antiga `RETRY_BASE_DELAY_SECONDS`, que existia para caber dentro de um teto que não existe mais.

**Quem aplica:** o cron, e só ele. Com a emenda do agendador único (ADR-002 §4), a fila deixa de retentar — o consumidor sempre confirma a mensagem depois de registrar o desfecho. O `retry_delay: 2` do consumidor no `wrangler.jsonc` deixa de ter efeito.

**A forma:** o cron seleciona linhas em que `next_due_ms <= agora` — o tempo devido é **pré-computado no carimbo** (`next_due_ms = agora + recuo(attempts)`), porque a forma por expressão não era indexável e obrigava varrer o conjunto pendente inteiro a cada passe (ADR-002 §4, emendado). O `recuo` cresce por tentativa e **satura em 24 h**.

~~O teto de 24 h não é escolha de gosto: é o máximo que a plataforma aceita.~~ **Corrigido em 16/08:** essa justificativa morreu quando `delaySeconds` saiu do desenho. O cron calcula o tempo devido **no D1** e publica na hora — nenhuma mensagem fica atrasada dentro da fila, então o teto de atraso da plataforma não restringe nada aqui. **As 24 h são escolha de política da aplicação**, e o critério é o da decisão 12: em regime, no máximo uma cópia por dia de um envio permanentemente ambíguo. Um teto menor acelera duplicatas; um maior atrasa a retentativa de uma causa externa já consertada. Ambos são defensáveis; 24 h é o registrado.

**A conta que importa, e que eu já errei uma vez:** o recuo é logarítmico apenas **antes** de saturar. Depois de saturado, cada dia permite mais uma tentativa, então as cópias de um envio ambíguo crescem **linearmente**, cerca de uma por dia. Isso é limite de **taxa**, nunca de **total**.

**Piso efetivo:** como o cron roda a cada 5 minutos (`triggers.crons` no `wrangler.jsonc`), nenhuma retentativa acontece antes disso, qualquer que seja o valor do recuo.

## ~~`CRON_STALE_AFTER_MS = 600_000` (10 minutos)~~ — MORTO junto com o segundo agendador

~~**Restrição inferior:** tem de ser maior que a janela de insistência da fila (155 s), senão o cron republica uma linha que a fila ainda está tentando.~~ ~~**Restrição superior:** o cron roda a cada 5 minutos... O pior caso de invisibilidade é **10 + 5 = 15 minutos**.~~

**Corrigido em 16/08, terceiro achado da mesma família:** as duas restrições derivavam da janela de retentativa da fila — e a fila **não retenta mais** (ADR-002 §4: o consumidor sempre confirma; o cron é o único agendador). Um limiar de "linha parada" separado deixa de existir: a elegibilidade é o próprio predicado de tempo devido, `next_due_ms <= agora`, e a constante morre com o desenho que a exigia.

**O que substitui a conta de 15 minutos, derivado da curva e não da fila:** uma linha recém-falhada tem `recuo(0) = 0` e é reagendada **no passe seguinte do cron, em até 5 minutos**. Nas primeiras três tentativas (5 + 15 min de recuo), uma falha transitória se resolve em cerca de **20 minutos**. O limiar de alarme do vigia tem de ser maior que isso para não alarmar sobre recuperação normal em curso — o valor exato entra na reescrita do plano, junto com o teste do vigia, porque é lá que ele ganha um observador.

## `ROW_RETENTION_MS = 30 dias`

**A consequência, escrita aqui e não em outra seção** (ADR-002 §5, decisão 10): a linha guardada **é** a trava de deduplicação. Enquanto ela existe, um *Redeliver* do mesmo GUID pelo painel de webhooks do GitHub não vira segunda mensagem. Depois que ela é apagada, vira — e a pergunta "o que aconteceu com aquele alerta?" deixa de ter resposta no banco.

**Por que 30 dias:** é o prazo que o sistema anterior já praticava para linhas entregues, então não introduz regime novo de armazenamento; e cobre com folga a janela em que um *Redeliver* manual é plausível durante a investigação de um incidente.

---

## Tabela final

| Constante | Valor | Fixado por |
|---|---|---|
| ~~`MAX_SEND_ATTEMPTS`~~ | **revogado** | decisão 12: não há teto |
| ~~`RETRY_BASE_DELAY_SECONDS`~~ | **substituído** | virou `RECUO`, saturando em 24 h |
| ~~`CRON_STALE_AFTER_MS`~~ | **morto** | o predicado de tempo devido substitui o limiar; não há segundo agendador |
| `RECUO(n)` | `min(24 h, 5 min × 3ⁿ⁻¹)`, `recuo(0) = 0` | política da aplicação: ≤ 1 cópia/dia em regime |
| `ROW_RETENTION_MS` | `2_592_000_000` | 30 dias; é a janela de deduplicação, e só alcança linha `enviado` |

**Derivado, para o vigia:** ~~o pior caso de invisibilidade continua sendo 15 minutos~~ — conta morta, derivava da fila. Pela curva: falha transitória se resolve em ~**20 minutos** (três tentativas). O limiar de alarme tem de ser maior que isso; o valor exato entra na reescrita do plano, onde o vigia ganha teste.

**O que este documento ainda deve, e não finge que não deve:** a curva concreta de `recuo(attempts)` — os valores por tentativa até saturar em 24 h — entra na reescrita do plano, junto com o teste que a prende. Publicar aqui um número que nenhum teste observa seria repetir exatamente o defeito que a emenda H38 do ADR-001 cometeu.
