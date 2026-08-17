# ADR-002 — Entrega de alertas do GitHub no Slack (implementação nova)

**Estado:** aprovado pelo operador em 16/08/2026; **emendado em 16/08/2026** após a revisão automática da PR #201 (Copilot e Codex, 14 achados distintos, todos verificados na fonte e todos procedentes).
**Substitui:** ADR-001 (dispatcher com outbox), abandonado por decisão do operador em 16/08/2026.
**Data:** 16/08/2026. Horários deste documento são de Brasília (UTC−03:00).

**O que a emenda mudou, em uma linha cada** — detalhe e evidência em `docs/superpowers/plans/2026-08-16-alertas-v2-achados-revisao.md`:

- **§1** — três frases apresentadas como citação não existiam nas fontes; retratadas e substituídas por inferência de enumeração, declarada.
- **§4 e §8** — o sistema deixa de decidir *por que* um envio foi recusado: some o estado `falhou`, some a coluna de estacionamento, some a tabela de códigos permanentes e some o teto de tentativas. Dois estados.
- **§5** — decisões 2, 7 e 8 emendadas; decisões 11 e 12 acrescentadas.
- **§6** — a instância G sai de "resolvida" e vira o terceiro limite declarado; C e C′ deixam de precisar de resolução, porque a peça que as criava foi apagada.
- **§7** — passa a separar o que a plataforma faz do que **a nossa configuração de hoje** faz, e a marcar o que ainda não é verdade.
- **§11** — a regra 1 ganha cláusula operacional; sem ela, era passável por fora e falsa por dentro.
- **§12** — nova: o que precisa existir fora do repositório. O plano tinha nove tarefas de código e zero de implantação.

---

## 1. Por que existe

O app oficial "GitHub for Slack" entrega quase tudo. Este sistema existe **apenas** para o que ele não sabe entregar, e para nada além disso.

O que o app oficial assina, verbatim da documentação do GitHub ([personalizar notificações](https://docs.github.com/en/integrations/how-tos/slack/customize-notifications)): por padrão issues, pull requests, commits na branch padrão, releases publicadas e status de deployment; opcionalmente revisões, execuções de workflow, branches, comentários, commits em qualquer branch e discussions.

Duas lacunas, ambas verificadas em fonte primária em 16/08/2026.

**Retratação, registrada onde o erro foi cometido.** A versão anterior desta seção trazia três frases entre aspas, apresentadas como verbatim das fontes. **Elas não existem em nenhuma das duas.** Eram frases do sumarizador da ferramenta de busca — reconhecíveis pela forma, *"The provided content does not mention…"*, que nenhuma fonte usa para falar de si mesma. O achado é do Copilot na revisão da PR #201, e procede. As duas lacunas continuam verdadeiras; o que não era verdade é que a documentação as tivesse enunciado. A regra que deveria ter impedido isso ganhou cláusula operacional em §11.

**Alerta de segurança não é assinável.** O README do app ([integrations/slack](https://github.com/integrations/slack)) enumera os recursos assináveis, verbatim: `issues`, `pulls`, `commits`, `releases`, `deployments`, `workflows`, `reviews`, `comments`, `branches`, `commits:*`, `+label:"your label"`, `discussions`. Nenhum alerta de segurança aparece na lista. **Isto é inferência de enumeração fechada, não citação**: nenhuma frase diz "não entregamos alertas de segurança"; o que existe é uma lista onde eles não estão. A confirmação empírica está logo abaixo, e é mais forte que a documental — o próprio app postou as assinaturas ativas dos 12 repositórios, e elas contêm exatamente esses nomes.

**Execução de workflow não filtra por conclusão.** Os filtros que o mesmo README documenta para `workflows` são quatro, verbatim: **name** (*"Name of your workflow"*), **event** (*"The event on which the workflow is triggered"*), **actor** (*"The person who triggered or responsible for running of the workflow"*) e **branch** (*"The branch on which the workflow is running"*). Não há filtro por conclusão. Mesma natureza de evidência: enumeração fechada. Ou seja, "me avise só quando falhar" não é expressável.

Estado real das assinaturas em 16/08/2026 16:55, lido da confirmação que o próprio app postou no `#github-activity` para cada um dos 12 repositórios:

```
issues, pulls, commits:'*', releases, deployments, reviews, comments,
branches, discussions, workflows:{event:"pull_request" branch:your-default-branch}
```

O app aplicou por conta própria um filtro em `workflows`: apenas execuções disparadas por `pull_request`, na branch padrão. Execuções agendadas, disparadas por push e de merge queue não são entregues por ele para nenhum dos 12 repositórios.

## 2. A promessa, e o que ela compra

**Nunca perder um alerta. Uma duplicata é aceitável.**

Essa segunda metade não é concessão: é o que torna a retentativa um recurso de recuperação **total**. Com ela, toda incerteza se resolve reenviando, e o sistema nunca precisa responder "chegou ou não chegou?" — que é a pergunta que gerou as 60 emendas do ADR-001, a varredura do histórico do Slack, a deleção irreversível de mensagem e o menu assinado de operador que existia para desfazer o que a máquina não devia fazer sozinha.

**Onde a promessa começa** *(fronteira exigida pela revisão em duas rodadas — primeiro "qualifique formalmente", depois "isso é 'nenhuma perda silenciosa', não a promessa declarada" — e das duas vezes os peers tinham razão)*: **a promessa ancora na aceitação durável. Um alerta está aceito quando, e somente quando, sua linha foi gravada no banco e o ingress respondeu sucesso ao GitHub. Do instante da aceitação em diante, "nunca perder" vale por construção** — dois estados, nada terminal, retenção só alcança `enviado`, retentativa para sempre.

**Antes dessa fronteira, a entrega pertence à camada de webhooks do GitHub**, com o contrato que a documentação fixa, verbatim ([entregas falhas](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries) e [reenvio](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks)): *"GitHub does not automatically redeliver failed webhook deliveries, but you can handle failed deliveries manually or by writing code."* e *"You can redeliver webhook deliveries that occurred in the past 3 days."* Ou seja: um INSERT que falhe vira **erro respondido ao GitHub, registro de entrega falha no painel da organização, sem reenvio automático, e com reenvio manual disponível por três dias**.

Toda promessa de entrega tem uma fronteira de aceitação; o ADR-001 tinha exatamente esta e não a declarava. Declará-la não a alarga: a distância entre o regime real e uma falha de INSERT está medida em §4, e o trajeto inteiro até lá acontece com o alarme de idade aceso. **Nenhum modo de perda é silencioso em nenhum dos dois lados da fronteira** — dentro, porque nada é terminal; fora, porque a falha fica registrada num painel do GitHub com prazo conhecido.

## 3. Escopo

**Entra:** alerta do Dependabot, de code scanning, de secret scanning (incluindo os sub-eventos), aviso de segurança publicado **nos nossos repositórios** (`repository_advisory`), mudança de configuração de segurança, e execução de workflow cuja conclusão seja `action_required`, `cancelled`, `failure`, `stale`, `startup_failure` ou `timed_out`. **Oito eventos.**

**Um evento saiu do escopo por impossibilidade de plataforma, em 16/08** — o `security_advisory` global (banco de advisories do GitHub). Da [lista oficial de eventos](https://docs.github.com/en/webhooks/webhook-events-and-payloads), verbatim: sua disponibilidade é **"Availability: `app`"** — só GitHub Apps podem assiná-lo; webhook de organização não o recebe, e o nosso transporte é webhook de organização. Os outros quatro eventos novos listam `organization` na disponibilidade e entram. A lacuna residual é estreita: `repository_advisory` cobre advisories publicados nos nossos repositórios; o que fica de fora é o feed global, que voltaria ao escopo apenas se um dia existir um GitHub App próprio.

**Sai, porque o oficial entrega:** issues, pull requests, commits, releases, deployment, revisões, comentários, branches e discussions.

**Sai, por decisão deliberada** (§5, decisão 1): falhas do próprio vigia e do workflow de deploy do relay.

## 4. A forma

**Dois estados: `pendente` → `enviado`.** Não há terceiro.

A máquina **não decide por que** o Slack recusou. Uma entrega recusada continua `pendente` e será tentada outra vez, sempre, com recuo crescente. Nada aqui é terminal — a única saída além de `enviado` é o apagamento por retenção, e ele só alcança linha já entregue.

Essa decisão (§5, decisão 12) é o que apaga, de uma vez: o estado `falhou`, a coluna de estacionamento, a distinção entre causa externa e causa intrínseca, a tabela de códigos permanentes, o teto de tentativas, a medição que justificaria o teto, a segunda consulta e o segundo caminho do cron, e o valor durável que o vigia guardaria para comparar. Oito peças serviam a uma pergunta — *"por que falhou?"* — cuja resposta não mudava nada para o operador: nos dois casos ele recebe um aviso e age com as próprias mãos.

**Ingress** — mantido do que roda hoje no `main`: confere a assinatura HMAC antes de parsear, aceita só os eventos do escopo, normaliza o payload, grava a linha com o GUID da entrega do GitHub como chave, publica na fila. Não há mais noção de destino: há um canal só.

**Consumidor** — monta a mensagem **no instante do envio**, a partir do payload normalizado que a linha guarda, posta com `chat.postMessage` e grava o desfecho. Que a montagem seja no envio, e não na entrada, é o que dá caminho de reparo sem superfície de comando: corrigir o renderizador e implantar faz a tentativa seguinte funcionar **sobre a mesma linha**. É assim que o código de hoje já se comporta — `src/index.ts:1318-1324` monta o corpo a partir de `delivery.payload` no momento do POST.

**Cron — o único agendador.** *(Reescrito em 16/08; a versão anterior desta seção estava errada e a correção veio da revisão automática, não de mim.)*

A versão anterior dizia que o cron reenfileira toda linha pendente mais velha que um limiar *"incondicionalmente e de forma idempotente"*. **Não é idempotente.** Como `created_ms` nunca muda, a linha continua elegível em todo passe, e cada passe publica uma **mensagem nova**, com ciclo de retentativas próprio. Publicações repetidas na fila não são deduplicadas. Com dois agendadores — a fila retentando por dentro e o cron criando fluxos novos por fora —, as tentativas crescem no ritmo do **cron**, a cada cinco minutos, e não no ritmo do recuo. A promessa de "taxa limitada" da decisão 12 seria falsa por construção.

**Primeira resolução, e ela também estava errada** *(escrita e derrubada em 16/08, no intervalo de uma hora)*: a fila deixa de retentar, o consumidor registra a tentativa antes de confirmar, e o cron seleciona por `updated_ms + recuo(attempts) <= agora`. **Codex, deepseek e grok convergiram contra ela, e o Copilot já a tinha apontado:** se `updated_ms` só é escrito **no consumo**, a linha continua devida enquanto a mensagem está em voo ou atrasada na fila — e o cron a republica **em todo passe de cinco minutos**. Nas palavras do grok: *"That is the same non-idempotent stacking §4 just retracted."* Eu carimbei no lugar errado.

**Resolução final: o carimbo é no ENFILEIRAMENTO, não no consumo.** O cron, para cada linha devida, executa **uma instrução condicional** e só publica se ela afetar a linha:

```sql
UPDATE alert_delivery
   SET attempts    = attempts + 1,
       updated_ms  = :agora,
       next_due_ms = :agora + :recuo_da_proxima_tentativa
 WHERE delivery_id = :id
   AND state = 'pending'
   AND next_due_ms <= :agora
```

Se `changes = 1`, publica; se `0`, outro passe já pegou a linha e este não faz nada. A linha deixa de ser devida **no instante do enfileiramento**, e não quando o consumidor roda.

*(Emendado em 16/08, mesma noite: a primeira forma avaliava `updated_ms + recuo(attempts)` na consulta, e a revisão derrubou — `updated_ms` carrega o agora do último carimbo, então `updated_ms <= agora` casa com praticamente toda linha pendente e **nenhum índice estreita a varredura**, num conjunto que é ilimitado por desenho. O tempo devido passa a ser **pré-computado no carimbo**, na coluna `next_due_ms`, e a seleção do cron vira exatamente indexável: `WHERE state = 'pending' AND next_due_ms <= :agora ORDER BY next_due_ms`. A curva continua no código que carimba; o esquema guarda só o resultado.)*

**E `delaySeconds` some inteiro.** Se o cron já espera o tempo devido para publicar, atrasar a mensagem *dentro* da fila é o segundo relógio que criava a janela onde as cópias se empilhavam — o deepseek pediu exatamente essa reconciliação. Sem ele, a mensagem publicada é consumida em segundos, e o único relógio do sistema é o predicado de tempo devido.

~~**Nenhuma coluna nova**: `attempts` e `updated_ms` já existem.~~ **Retratado na mesma noite: uma coluna entrou — `next_due_ms` — e a regra 7 exige a justificativa contra a promessa, então aqui está.** Ela é **derivada**, escrita atomicamente no mesmo `UPDATE` do carimbo, lida por exatamente uma consulta, e existe porque a alternativa sem ela — o predicado por expressão — obrigava cada passe do cron a varrer o conjunto pendente inteiro, que a decisão 12 torna ilimitado. Sem ela, o custo de cada passe cresceria com o tamanho da patologia que o sistema promete sobreviver. `attempts` conta tentativas **agendadas**, `updated_ms` marca o último agendamento, e quem lê idade é o vigia, em `created_ms`, intocado — a distinção que o H40 do ADR-001 exigia.

**A curva, escrita por inteiro porque o grok cobrou o valor de `recuo(0)`:**

| `attempts` | `recuo` | quando a linha volta a ser devida |
|---|---|---|
| 0 | 0 | no próximo passe do cron (≤ 5 min) |
| 1 | 5 min | ~5 min depois do 1º agendamento |
| 2 | 15 min | |
| 3 | 45 min | |
| 4 | 2 h 15 | |
| 5 | 6 h 45 | |
| 6 | 20 h 15 | |
| ≥ 7 | **24 h** | saturado; uma tentativa por dia, para sempre |

`recuo(n) = min(24 h, 5 min × 3ⁿ⁻¹)`, e o piso é o próprio período do cron: nenhuma retentativa acontece antes de cinco minutos, qualquer que seja a fórmula. A saturação chega na sétima tentativa, cerca de **30 horas** depois da primeira.

**As 24 h são política da aplicação, não restrição de plataforma** — e a distinção importa porque a versão anterior as justificava pelo teto de `delaySeconds`, que este desenho **não usa**: o tempo devido é calculado no D1 e a publicação é imediata. O critério verdadeiro é o da decisão 12: em regime, no máximo uma cópia por dia de um envio permanentemente ambíguo. Um teto menor acelera duplicatas; um maior atrasa a retentativa de causa externa já consertada.

**O ingress publica só quando INSERE**, nunca para uma linha pendente que já existe — exigência do grok, e ela fecha a última porta pela qual uma publicação escapava do carimbo. A inserção é idempotente pelo GUID (chave primária), então uma redelivery do GitHub não vira segunda publicação.

*(Emendado na revisão da implementação, em duas rodadas:)* **o ingress também CARIMBA** — depois do INSERT, executa o mesmo CAS do agendador para a tentativa 1 e **só publica se o carimbo dele venceu**. Sem o carimbo, a primeira tentativa falhada era reagendada em segundos, furando o recuo(1); sem o gate no resultado, um passe do cron carimbando entre o INSERT e o carimbo do ingress produzia **duas** publicações da mesma tentativa. A matriz de escritas fica assim: o carimbo pertence ao **papel de agendador**, exercido pelo cron a cada passe e pelo ingress exatamente uma vez, no aceite.

**O agendador residual que a plataforma impõe, e como ele é neutralizado** *(achado da revisão sobre o commit anterior, e procede)*: "o consumidor sempre confirma" só vale quando o handler **retorna**. Se o Worker morre entre o POST no Slack e o retorno, a plataforma trata a entrega como falha e **reentrega a mensagem** — com o `max_retries: 5` de hoje, um único agendamento do cron poderia virar várias postagens em segundos, por fora do recuo. A neutralização tem três camadas, nenhuma delas nova: (1) o consumidor **relê a linha antes de postar** e retorna se `state = 'sent'` — a reentrega só duplica se a morte caiu exatamente na janela POST→gravação; (2) a decisão 8 (emendada) leva o `max_retries` do consumidor ao **mínimo que a plataforma aceitar** — a documentação fixa default 3 e máximo 100, **não documenta o mínimo**, então o valor exato se verifica empiricamente na tarefa de configuração do §12, junto com a remoção da fila de descarte; (3) se a mensagem morrer sem reentrega, **nada se perde**: a linha continua `pendente` e o cron a recarimba quando `next_due_ms` vencer — a fonte de verdade é a linha, nunca a mensagem. O custo declarado: um crash na janela estreita pode produzir até o número de reentregas configurado de cópias; a taxa de regime da decisão 12 não é afetada.

Três defeitos morrem juntos com essa resolução: a amplificação no ritmo do cron; a inanição que a revisão apontou em seguida — *"se pelo menos `limit` linhas forem irrecuperáveis, todos os alertas posteriores ficam fora de cada passe para sempre"* —, porque a ordenação passa a ser por tempo devido e a linha travada sai da cabeça da fila; e a dependência do `max_retries` e da fila de descarte **no caminho normal** — a mensagem confirmada nunca os aciona. *(Emendado: a versão anterior dizia "nunca mais disparam", e é falso — no crash antes do retorno, a mensagem não é confirmada, e crashes repetidos podem esgotar `max_retries` e alcançar a DLQ **enquanto a configuração do §12 não for aplicada**. O caso está tratado no bloco do agendador residual, adiante.)*

**O que isso custa, declarado:** o cron passa a ser o **único** caminho de recuperação. Se o gatilho agendado da Cloudflare não disparar, nada reagenda. Quem detecta isso é o vigia, que alarma pela idade da linha pendente mais velha — é precisamente o buraco que ele existe para cobrir.

**Recuo** — requisito de desenho, não presente de plataforma: a plataforma não impõe recuo próprio. O `retry_delay: 2` do consumidor de `github-slack-alerts` no `wrangler.jsonc` **não** é esta política e deixa de ter efeito quando a fila para de retentar. *(Referências a este arquivo passam a ser pela chave, não pela linha: os bindings adicionados neste mesmo PR deslocaram as linhas e apodreceram quatro citações numéricas — achado da revisão, e a classe é a mesma do documento-fantasma, em escala de linha.)*

**Retenção** — apaga linhas `enviado` mais velhas que o prazo. **Nunca apaga `pendente`**, porque apagar pendente é perder o alerta. Com dois estados, o apagamento é a única transição terminal do sistema, e por isso ele se justifica contra a promessa, não contra o espaço em disco.

**O crescimento sem limite que isso admite, com a conta feita e não estimada.** Se uma condição sistêmica mantiver **toda** linha pendente para sempre, elas se acumulam. Medido no banco em 16/08 sobre a tabela existente: 13 381 linhas, payload médio de **578 bytes**, máximo de 827. O volume de alertas está na ordem de 9 por hora (§7), ou cerca de 78 800 linhas por ano; a 1 KB por linha, com folga sobre a média medida, são **≈ 79 MB por ano**. O teto documentado é *"Maximum database size | 10 GB (Workers Paid)"*, e *"Maximum number of rows per table | Unlimited (excluding per-database storage limits)"*.

Ou seja: o crescimento é **ilimitado em princípio** — três peers cobraram que isso fosse dito — e, no volume medido, levaria mais de um século para encostar no teto, no cenário patológico em que nada nunca entrega. O limite não é o disco; é a paciência do operador diante de um alarme aceso. Aceito e declarado, com os números acima, e não com a palavra "desprezível".

**E o caso da rajada, levantado pelo deepseek na quarta rodada: pode uma rajada exaurir o banco e bloquear inserções novas — perdendo alertas na entrada?** A análise, em três passos, sem peça nova:

1. **Acumular exige não-entregar.** Linha que entrega vira `enviado` e a retenção a apaga; só o que não entrega se acumula. E a primeira linha que não entrega faz o alarme de idade disparar **em menos de uma hora** — então todo o trajeto até o teto acontece com o alarme aceso.
2. **A escala entre o alarme e o teto é de seis ordens de grandeza.** O teto exige ~10⁷ linhas de 1 KB; o alarme dispara com **uma**. Uma rajada que vencesse essa corrida contra o operador precisaria de milhões de eventos vindos de 12 repositórios cujo volume medido é 9/hora — não é um cenário; é outro sistema.
3. **Mesmo no extremo, a falha fica fora da fronteira da promessa e registrada.** Se um INSERT falhar, o alerta **não foi aceito** (§2): o ingress responde erro ao GitHub, e a entrega fica registrada como falha no painel de webhooks da organização — sem reenvio automático, com reenvio manual por três dias (citações em §2). É falha de aceitação com registro externo e prazo conhecido, não apagamento sem rastro.

Fica como **limite declarado com a forma da falha descrita**, não como resolvido: nenhum mecanismo interno protege contra um operador que ignora um alarme por anos, e construir proteção para isso foi exatamente o erro que gerou as 60 emendas do ADR-001.

**Status** — contagem por estado e a idade da linha pendente mais antiga, protegido por segredo compartilhado.

**Vigia** — tarefa agendada no GitHub que lê o status e falha de propósito quando há coisa parada. **Uma condição só: a idade da linha pendente mais velha.** Sem nível, sem delta, sem valor guardado entre execuções. O e-mail que o GitHub manda ao falhar é o aviso — com a ressalva de §5, decisão 2.

## 5. Decisões do operador, registradas

1. **Excluir da entrega as falhas do próprio vigia e do deploy do relay**, casando por **repositório mais caminho** do arquivo do workflow. É a única escolha deliberada de não entregar algo. Motivo em §6, instância A. *(Emendado em 16/08: casar só por caminho suprimiria, em silêncio, a falha de um workflow homônimo em qualquer outro repositório assinado — achado do Codex, rodada 3. Nome continua fora de questão: nome é renomeável.)*
2. **O e-mail de aviso vai para `contato@lcv.dev`.** *(Emendado em 16/08, e a versão anterior desta decisão era falsa.)* Ela dizia que o endereço é *"escolhido, não herdado de quem editou o agendamento por último"*. A documentação do GitHub diz o contrário, verbatim ([notificações de execução de workflow](https://docs.github.com/en/actions/monitoring-and-troubleshooting-workflows/notifications-for-workflow-runs)): *"If a different user updates the cron syntax, in the `schedule` event in the workflow file, subsequent notifications will be sent to that user instead."* e *"If a scheduled workflow is disabled and then re-enabled, notifications will be sent to the user who re-enabled the workflow rather than the user who last modified the cron syntax."*

   **O mecanismo real, e o operador o aceitou conhecendo-o:** o destinatário é a conta que mexeu no cron por último, e o endereço é ajuste **daquela conta**, não do YAML. Logo o endereço não é garantido por este desenho; é garantido por uma configuração fora dele, que §12 inventaria. **A armadilha, escrita para não ser redescoberta:** quem editar o agendamento herda o aviso, e o operador deixa de recebê-lo sem que nada falhe.
3. **"Não consegui falar com o Worker" conta como problema**, após duas verificações consecutivas falharem.
4. **O vigia poder morrer em silêncio é aceito e declarado** como limitação conhecida (§6, instância D).
5. **Todos os eventos de segurança extras entram**, inclusive os sub-eventos de secret scanning que a recomendação inicial deixava de fora.
6. **Tabela nova**, não reconstrução da existente.
7. ~~**Resposta de limite de taxa do Slack não conta contra o teto de tentativas**; o valor do teto é escolhido por medição.~~ **Revogada em 16/08 pela decisão 12: não há teto.** Sem teto, não há o que o 429 não conte contra, e a medição que justificaria o valor deixa de ser necessária. Esta decisão morre inteira — as duas metades dela existiam para administrar um número que a deleção apagou.
8. **A fila de descarte é removida**, para o teto da aplicação disparar antes do teto da fila. *(Emendada em 16/08: a justificativa muda, a decisão fica.* Sem teto de aplicação, a razão passa a ser outra e mais simples — a fila de descarte é um **segundo mecanismo de entrega**, com política própria, que reentrega por fora do único caminho que o desenho reconhece. Duas máquinas entregando o mesmo alerta é a forma da qual o ADR-001 morreu. Estado de hoje: o consumidor de `github-slack-alerts` no `wrangler.jsonc` ainda declara `dead_letter_queue: "github-slack-alerts-dlq"`, e a própria DLQ ainda figura como consumidor; a remoção entra em §12.*)*
9. **O status é protegido por segredo compartilhado.**
10. **A retenção da linha é declarada com a consequência escrita ao lado**: a linha guardada é a própria trava contra duplicata, então o prazo define também a janela em que um reenvio do GitHub não vira segunda mensagem. *(Emendada em 16/08: o apagamento alcança **apenas** linhas `enviado`. Uma linha `pendente` nunca é apagada, porque apagá-la é perder o alerta.)*

11. *(Acrescentada em 16/08, depois da revisão da PR #201.)* **O transporte é `chat.postMessage`, com token de bot.** O app é o "LCV Ideas Software GitHub Alerts", que já está no canal desde 14/08/2026 16:51. Verificado por `auth.test` em 16/08: `user_id` `U0BR6NL2B9N` — o mesmo que entrou no canal —, `bot_id` `B0BQ65BTHC3`, escopos concedidos `chat:write,groups:history,groups:read`.

    **Esta decisão carrega uma dependência que não pode ser esquecida** (achado do Codex, rodada 3): a equivalência **`ok:true` = entregue** vale para `chat.postMessage`, cuja resposta de sucesso traz a mensagem postada, e **é falsa** para o gatilho de workflow do Slack, que com `ok:true` apenas aceitou o gatilho — o workflow a jusante ainda pode falhar antes de postar. É por isso que o código de hoje grava `accepted_by_trigger` em `src/index.ts:1387` em vez de "enviado". **Trocar o transporte sem trocar o classificador perde alertas em silêncio.**

12. *(Acrescentada em 16/08.)* **O sistema nunca desiste de um alerta.** Toda entrega recusada continua `pendente` e é retentada com recuo crescente, indefinidamente. É a decisão que apaga as oito peças listadas em §4.

    **O custo, dito inteiro — e esta é a segunda versão deste parágrafo, porque a primeira foi derrubada por três peers independentes.** Se o Slack processa o POST e a resposta se perde **depois** disso, a mensagem aparece no canal e o sistema nunca vê `ok:true`; cada retentativa produz uma cópia visível.

    ~~O que limita não é um contador: é o recuo, que cresce e satura no teto documentado da plataforma, fazendo as cópias crescerem com o logaritmo do tempo.~~ **Falso, e por duas razões que codex, deepseek e grok apontaram convergindo.** Primeira: *"Messages can be delayed by up to 24 hours"* é um **máximo permitido**, não um regulador — nas palavras do grok, *"a max, not a governor"*. A plataforma não impõe recuo nenhum; quem escolhe é o consumidor, via `delaySeconds`. Segunda: depois de saturar em 24 h o crescimento é **linear**, uma cópia por dia, não logarítmico. Eu errei a própria aritmética que usei para me tranquilizar.

    **O que fica escrito, sem maquiagem: a duplicação total é ILIMITADA no tempo.** O que é limitado é a **taxa** — no máximo uma cópia por dia depois que o recuo satura — e essa limitação **não vem de graça**: ela depende inteiramente do carimbo de enfileiramento descrito em §4. ~~Toda reenfileirada precisa fixar `delaySeconds` crescente.~~ *(Corrigido em 16/08, na mesma rodada: `delaySeconds` foi **removido do desenho**. Atrasar a mensagem dentro da fila era um segundo relógio, e era na janela entre publicar e consumir que as cópias se empilhavam.)* O `retry_delay: 2` do consumidor no `wrangler.jsonc` nunca foi essa política e deixa de ter efeito, porque nada mais retenta pela fila.

    **Quem encerra o caso é uma pessoa, e isso também fica escrito.** O vigia alarma pela idade em minutos; o operador age. Se ele nunca agir, as cópias se acumulam a uma por dia — barulho crescente com o alarme aceso, nunca silêncio com o alerta perdido. E a ferramenta que ele tem para encerrar uma linha permanentemente ambígua não é um comando que este sistema precise construir: é o **acesso direto ao D1**, que já existe e já foi usado para medir os números desta seção. Foi por não reconhecer isso que o ADR-001 construiu um menu de operador assinado.

    Repor um teto tornaria a linha terminal, e terminal **perde** o alerta — a única coisa que a promessa proíbe. Entre duplicar com o alarme aceso e perder em silêncio, a promessa já escolheu.

## 6. A classe que este desenho precisa resistir

**O observador acoplado ao observado: o comportamento do próprio sistema corrompe o próprio sinal.** **Dez** instâncias, enumeradas antes de qualquer código: A, B, C, C′, D, E, F, F′, G e H. *(O documento dizia "oito" e enumerava dez — as duas linhas com apóstrofo, C′ e F′, nasceram de revisões posteriores e ninguém recontou. Corrigido em 16/08; subcontar a superfície de revisão é o tipo de erro que faz a revisão parecer completa quando não está.)*

**A — o vigia fabrica o que vigia.** Falha do vigia é `workflow_run` com conclusão de problema, que o ingress roteia para o canal de alertas. Um vigia vermelho produz um alerta novo e não entregável a cada tique. Registrado no ADR-001 §10 como defeito D12 do sistema aposentado. *Resolvido pela decisão 1.*

**B — a recuperação desarma a detecção.** Se a idade que o vigia lê for ancorada num campo que o cron escreve, o cron mantém a idade abaixo de qualquer limiar para sempre. O ADR-001 H40 rejeitou `updated_ms` por exatamente isso, em suas palavras "fail-DANGEROUS". *Resolução: a idade ancora no instante de ingresso, e nenhum caminho de recuperação escreve esse campo.*

**C — vermelho permanente não carrega informação.** Linha que nunca vai entrar, reenfileirada a cada passe, mantém o alarme aceso para sempre. É a cegueira de 22,6 horas do ADR-001 H44, em que o monitor já falhava de hora em hora por motivo alheio. *Resolução emendada em 16/08, e ela **não** é "C desapareceu".* Com a decisão 12, uma linha que não entra continua sendo reenfileirada e o alarme continua aceso — exatamente o que C descreve. O que muda é a **natureza do sinal**: o vigia não emite um booleano que satura, e sim dois números, a idade da linha pendente mais velha e a contagem de pendentes. Um alerta novo travado **move os dois**, mesmo que já houvesse um travado antes. Foi a saturação, não o vermelho, que produziu a cegueira de 22,6 horas do H44.

*Resíduo declarado, porque o desenho não o resolve:* um vermelho que dura semanas produz **habituação no humano**, e nenhum arranjo de números conserta isso. É limite de operação, não de software, e fica escrito aqui para não ser redescoberto como defeito.

**C′ — a resolução de C reintroduzia C, e um peer pegou.** Estacionar sem superfície de comando de operador (§5, decisão... ausente por desenho) significa que **nada, nunca, limpa a linha estacionada**. O alarme ficaria aceso para sempre por causa dela — exatamente o vermelho permanente que C existe para evitar, entrando pela porta aberta para consertá-lo. Achado do painel de revisão de pares na segunda rodada, não meu. *Resolução emendada em 16/08: **C′ deixa de existir, porque a peça que a criava foi apagada.*** Não há estacionamento, logo não há linha estacionada que nada limpa, logo não há delta a computar nem valor durável a guardar entre execuções do vigia. A resolução anterior — alarmar no delta — foi ela própria derrubada na revisão da PR #201 por Copilot e Codex, que mostraram, independentemente, que um delta exige um marco durável que nem o esquema nem o vigia tinham. Os dois estavam certos, e a resposta certa não era acrescentar o marco: era apagar o estacionamento.

*Registro do padrão, porque ele é o padrão que matou o ADR-001:* C ganhou uma resolução que criou C′; C′ ganhou uma resolução que exigia peça nova. Duas emendas encadeadas, e nenhuma delas tocava a causa — a distinção externo/intrínseco, que não mudava nada para o operador.

**D — ausência de sinal lê como saúde.** O GitHub documenta que execuções agendadas podem sumir: *"If the load is sufficiently high enough, some queued jobs may be dropped"*, e que em repositório público *"scheduled workflows are automatically disabled when no repository activity has occurred in 60 days"* ([eventos que disparam workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)). Execução que não acontece não gera artefato, logo não há onde pendurar notificação. *Aceito e declarado, decisão 4. Não sei quantificar a frequência.*

**E — o status é servido por quem está sendo vigiado.** Worker fora do ar devolve erro de transporte, não veredicto. *Resolvido pela decisão 3.*

**F — detector e fonte compartilham a plataforma.** O vigia roda no GitHub Actions e os eventos chegam por webhook do GitHub. Derivação, não citação: uma degradação do GitHub atinge os dois juntos, e o detector não consegue reportar a queda em que está. *Limite declarado, sem conserto.*

**F′ — o buraco do homem-morto foi MOVIDO, não FECHADO, e este documento diz isso com todas as letras.** Três peers independentes (codex, deepseek, grok) convergiram nisto na segunda rodada de revisão: qualquer arranjo em que os dois braços do aviso saem pelo GitHub — o e-mail do Actions e uma issue entregue pelo app oficial — cai junto numa degradação do GitHub. Deslocar a detecção para a Cloudflare não fecha o buraco; move-o. **Nenhum arranjo estudado fecha**, porque todo canal de aviso disponível depende do GitHub ou do Slack, e os dois são exatamente os lados que podem estar quebrados. O operador aceitou o limite na decisão 4 com esse entendimento. Registrado assim para que nenhuma leitura futura confunda "há um mecanismo" com "está resolvido" — que é precisamente o erro que o ADR-001 H26 cometeu e pagou.

**G — o aviso depende de uma caixa de e-mail.** ~~*Resolvido pela decisão 2, que ao menos torna o destinatário uma escolha.*~~ **Emendado em 16/08: não estava resolvido, e esta linha era o erro que o próprio F′ nomeia.** A decisão 2 não escolhe destinatário nenhum — a documentação do GitHub manda o aviso para a conta que editou o cron por último, e o endereço é ajuste daquela conta. *Terceiro limite declarado*, ao lado de D e F/F′: o aviso depende de uma configuração fora deste desenho (§12) e de ninguém mais tocar no agendamento.

**Consequência de ler as três juntas, que nenhuma instância isolada mostra:** o §6 passa a ter **três** instâncias declaradamente não fechadas — D (execução agendada some), F/F′ (detector e fonte caem juntos) e G (o aviso depende de configuração externa). As garantias do vigia são mais fracas do que a leitura anterior deste documento sugeria, e quem decidir confiar nele precisa decidir sabendo disto.

**H — o deploy do relay é uma execução de workflow.** Deploy que falha vira alerta que o deploy falhado não entrega. *Resolvido pela decisão 1.*

## 7. Fatos de plataforma que o desenho assume, todos citados

**Emenda de 16/08, sobre a forma desta seção.** Ela misturava duas coisas de natureza diferente: o que a plataforma faz, que é citável, e o que **a nossa configuração** faz, que se lê no `wrangler.jsonc`. A citação da fila de descarte era verdadeira e a conclusão que tirei dela **não vale para a configuração de hoje** — porque hoje existe fila de descarte configurada. Cada item abaixo agora diz de qual das duas naturezas é, e o que ainda não é verdade está marcado.

**A fila descarta.** Da documentação da Cloudflare ([configurar filas](https://developers.cloudflare.com/queues/configuration/configure-queues/)): *"The maximum number of retries for a message... Defaults to 3 retries"* e *"If a `dead_letter_queue` is not defined, messages that repeatedly fail processing will eventually be discarded."* É por isso que o cron não é opcional: sem ele, "nunca perder" é falso.

**Estado da configuração, que é a outra natureza, e hoje contradiz a frase acima:** no `wrangler.jsonc`, o consumidor de `github-slack-alerts` declara `dead_letter_queue: "github-slack-alerts-dlq"`, e a DLQ tem consumidor próprio. Logo, **hoje** a mensagem esgotada não é descartada — ela cai num segundo mecanismo de entrega, com política própria. A decisão 8 remove essa fila, e só depois disso o parágrafo anterior descreve o sistema. Enquanto não remover, o desenho tem duas máquinas entregando o mesmo alerta.

**Retenção.** Da mesma página: *"Defaults to 345600 (4 days). Must be between 60 and 1209600 (14 days)"*. A fila de alertas está configurada em 86 400 s (24 h), lido da API da Cloudflare em 16/08/2026.

**O Slack devolve `ts` e `channel` no sucesso.** Da documentação ([chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage)): *"Response including the 'timestamp ID' (`ts`) and the channel-like thing where the message was posted."* O exemplo de resposta bem-sucedida traz `ok`, `channel`, `ts` e `message`, com `ts` valendo `"1503435956.000247"`.

**E o que a página NÃO diz, verificado em 16/08 procurando exatamente por isso:** não há nenhuma frase garantindo que `ts` esteja **sempre** presente numa resposta de sucesso, nem declarando campo algum como obrigatório. Há um exemplo, e exemplo não é garantia. **Consequência de desenho:** `ok:true` é o que marca `enviado`; o `ts` é gravado quando vier, e nada no sistema o lê para decidir — os dois leitores que existiriam, `chat.delete` e a varredura de verificação, estão aposentados em §9. Nenhuma validação de formato de `ts` entra: ela recusaria um envio que ocorreu, produzindo cópia e alarme, e não impediria nada que a promessa proíba.

**Ritmo.** Da documentação de [limites de taxa](https://docs.slack.dev/apis/web-api/rate-limits/): *"no more than one message per second per channel"*, com rajada permitida. O volume real de alertas está na ordem de 9 por hora, então nenhuma tabela durável de ritmo é necessária — o 429 basta.

**Volume de workflow.** 153 execuções em 24 horas nos 12 repositórios, contadas pela API do GitHub em 16/08/2026.

**Migrações aplicadas em produção param na 0009**, lido do `d1_migrations` do banco `github-slack-alerts-db` em 16/08/2026. A migração nova é a 0010.

## 8. Classificação do envio

**Emendado em 16/08 pela decisão 12. A seção inteira cabe em duas linhas:**

1. **`ok:true` marca `enviado`.**
2. **Qualquer outra coisa deixa a linha `pendente`, para a próxima tentativa.**

**A linha 1 deixou de ser inferência minha e passou a ter contrato autoritativo**, porque o codex recusou a versão anterior exatamente por isso — *"Substituir a inferência sobre `chat.postMessage` por contrato autoritativo de sucesso"*. Da documentação da Web API do Slack, verbatim: *"All Web API responses contain a JSON object, which will always contain a top-level boolean property `ok` that indicates success or failure."* e *"For failure results, the `error` property will contain a short machine-readable error code."* Há ainda o caso intermediário, também verbatim: *"In the case of problematic calls that could still be completed successfully, `ok` will be `true` and the `warning` property will contain a short machine-readable warning code."* — ou seja, `ok:true` com `warning` continua sendo sucesso, e o desenho o trata como tal.

**O que NÃO entra, e o grok pediu explicitamente que ficasse escrito:** não se exige `ts`. O campo autoritativo é `ok`; `ts` é recibo. Exigi-lo recusaria um envio que ocorreu, produzindo cópia e alarme sem impedir nada que a promessa proíba.

Não há mais lista de códigos permanentes, nem lista de transitórios, nem "tudo o mais". A tabela de 14 códigos existia para decidir *quem vira terminal*, e nada mais é terminal. Uma classificação que não altera nenhum caminho de execução é descrição, não código — e sai.

**A linha 1 depende do transporte, e essa dependência é a coisa mais frágil deste documento** (§5, decisão 11): ela é verdadeira para `chat.postMessage`, cuja resposta de sucesso contém a mensagem postada, e **falsa** para o gatilho de workflow do Slack, cujo `ok:true` significa apenas que o gatilho foi aceito. Quem trocar o transporte sem reler esta seção perde alertas em silêncio.

**O que se perde com a simplificação, dito honestamente:** um erro de configuração permanente — token revogado, bot fora do canal — passa a ser retentado como qualquer outra coisa, em vez de virar falha imediata. Não é perda real: o alerta continua indo para o mesmo lugar, o vigia alarma pela idade, e a ação do operador é idêntica nos dois desenhos. O que se ganha é não ter oito peças para descobrir algo que não muda a ação de ninguém.

**O classificador é total sobre a invocação, não sobre a resposta do Slack.** Falha ao renderizar o payload, leitura de segredo que falha, ou erro ao gravar o desfecho nunca chegam à tabela acima. O corpo do consumidor é envolvido por inteiro e nunca deixa exceção escapar para a fila.

## 9. Deliberadamente ausente

Varredura do histórico do Slack, resolver, detecção de duplicata, reparo de duplicata, `chat.delete`, varredura de verificação, prova canônica a defender, menu de operador, requisição assinada, estado ambíguo, reivindicação, lease, CAS de estado, tabela durável de ritmo.

**Um item desta lista VOLTOU, e voltar exige justificativa contra a promessa (regra 7).** A lista aposenta *"CAS de estado"*, e o carimbo de enfileiramento de §4 é uma atualização condicional — um CAS. Volta assim, e com este preço declarado:

- **O que voltou:** exatamente uma instrução `UPDATE ... WHERE state = 'pending' AND <devida>`, cujo `changes` decide se publica — mais a coluna derivada `next_due_ms` que ela escreve, justificada logo abaixo. Nenhum estado novo, nenhuma transação de duas escritas. *(Este bullet dizia "nenhuma coluna nova" mesmo depois de a retratação ao lado admitir a coluna — fantasma dentro da própria retratação, e a revisão pegou.)*
- **O que NÃO voltou:** o CAS que esta lista aposentou era o árbitro entre escritores concorrentes de uma máquina de dez estados — o que gerava estado ambíguo, reivindicação e lease. Nada disso volta.
- **Por que a promessa exige:** sem o carimbo, a linha continua devida enquanto a mensagem está em voo, o cron a republica a cada cinco minutos, e a taxa prometida na decisão 12 é falsa por construção — o canal afoga. Três peers e o revisor do GitHub derrubaram o desenho sem ele.
- **O teste que o prende, antes do código:** uma linha devida submetida a dois passes consecutivos do cron produz **exatamente um** enfileiramento. Sem essa prova, o carimbo é descrição e não restrição.

**Acrescentados em 16/08 pela decisão 12** — peças que este documento chegou a especificar e que agora saem: o estado `falhou`, a coluna de estacionamento, a distinção entre causa externa e causa intrínseca, a tabela de códigos permanentes, a tabela de códigos transitórios, o teto de tentativas, a medição que o justificaria, a segunda consulta e o segundo caminho do cron, e o marco durável do delta do vigia. Também sai a validação de formato do `ts` (§7): guarda que recusaria um envio ocorrido.

Cada item desta lista é uma decisão, não um esquecimento. Juntos, são a origem da maior parte das 60 emendas do ADR-001.

**Acrescentado na revisão da implementação (achado recusado, com registro):** o **limitador de taxa por canal** para o `chat.postMessage` — a "tabela durável de ritmo" desta lista, sob outro nome. A revisão apontou que uma rajada acima de ~1 msg/s pode receber 429 sincronizados e que o `Retry-After` é ignorado. Fica ausente de propósito: (1) 429 não perde nada — a linha continua `pending` e o recuo crescente espalha as retentativas por construção; (2) honrar `Retry-After` exigiria o consumidor escrever coluna de agendamento, violando a matriz de escritas do §4 (a curva já cobre qualquer `Retry-After` do Slack: recuo(2) = 15 min); (3) o volume de eventos de segurança desta organização fica ordens de grandeza abaixo do limite, e um acúmulo real que passe de uma hora alarma o vigia — que é o comportamento desenhado; (4) o ritmo compartilhado (`reserveSlackSlot`, cooldown durável) é exatamente o maquinário de que o sistema anterior morreu. Se a medição pós-ativação (§12) mostrar 429 recorrente, a decisão volta ao operador.

## 10. O que não sei, e não vou afirmar

- O que acontece com a mensagem se a retenção expirar enquanto ela ainda está sendo retentada não está documentado.
- A frequência com que o GitHub descarta execuções agendadas não é publicada.

Os dois vão para medição antes de virarem número na implementação.

**Um item saiu desta lista por ter sido encontrado documentado.** Eu havia listado "o comportamento de espera entre tentativas da fila" como desconhecido, depois de ler a página de configuração. Estava na página de [batching, retries e delays](https://developers.cloudflare.com/queues/configuration/batching-retries/), que eu não tinha consultado — e a resposta muda o desenho: **a plataforma não impõe recuo próprio**. Quem escolhe é o consumidor, via `delaySeconds` em `retry()` ou `retryAll()`, com teto de *"up to 24 hours"*; cada mensagem carrega *"an `attempts` property that tracks the number of delivery attempts made"*; e o esgotamento é explícito — *"Messages that reach the configured maximum retries will be deleted from the queue, or if a dead-letter queue (DLQ) is configured, written to the DLQ instead."* Essa última citação é a prova mais forte de §7: sem o cron, "nunca perder" é falso, porque a mensagem é apagada.

Registro do erro, porque ele é do tipo que esta série paga caro: eu declarei desconhecido depois de ler **uma** página, quando o que eu sabia era que aquela página não dizia. Não saber onde está não é o mesmo que não estar documentado.

~~**Três números ainda não escolhidos**, e este documento não finge que estão: o limiar de idade que faz o cron reenfileirar, o teto de tentativas da decisão 7, e o prazo de retenção da decisão 10.~~ **Emendado duas vezes em 16/08, e a primeira emenda ficou obsoleta no mesmo dia** — ela dizia "sobraram dois", contando o limiar de idade do cron, e o agendador único o matou também: a elegibilidade é o predicado de tempo devido, não um limiar (achado da revisão, apontando a contradição com §4). **Dos três números originais, sobrou um**: o prazo de retenção da decisão 10. O teto morreu com a decisão 7 revogada; o limiar morreu com o segundo agendador. O que existe de numérico agora é a **curva de recuo** de §4, escolhida como política e registrada com a conta em `docs/superpowers/plans/2026-08-16-alertas-v2-numeros.md`.

**Registro de um erro de processo que o Copilot pegou e que procede:** a Tarefa 1 escolheu o teto de tentativas por **restrição** (ser menor que o `max_retries` da fila), quando a decisão 7 e esta seção diziam **medição**. Trocar o critério fixado pelo operador é permitido; trocá-lo sem dizer que se trocou, não. O ponto virou discutível porque o número desapareceu, mas o erro de processo aconteceu e fica escrito.

**Fora de escopo, registrado para não se perder:** 203 linhas de alerta ficaram sem entrega entre 14/08/2026 16:38 e a pausa das filas, estacionadas em `manual_review` na tabela legada, e nenhum caminho automático as alcança. Não são tratadas aqui — importá-las é acréscimo de peça, e só se decide quando o sistema existir.

## 11. Regras de construção, vinculantes

Determinadas pelo operador em 16/08/2026, derivadas do colapso do ADR-001. O plano de implementação herda cada uma.

1. Nenhuma frase sobre comportamento entra em documento ou comentário sem a linha citada que a prova. Se não dá para citar, não se escreve.

   **Cláusula operacional, acrescentada em 16/08 porque a regra falhou exatamente como estava escrita.** Uma citação só entra se for possível **apontar a string exata dentro do corpo buscado**. Não basta que uma ferramenta tenha respondido aquilo: o resumo de um buscador não é a fonte. Se a fonte enumera e a conclusão vem da ausência de um item na enumeração, isso é **inferência de enumeração fechada** e entra assim declarado, com a enumeração transcrita. Origem: três frases do §1 apresentadas como verbatim que não existiam em nenhuma das duas fontes, achado do Copilot na PR #201. Eu cumpri a regra como ela estava escrita — citei — e o que citei foi o resumo. A regra era passável por fora e falsa por dentro.
2. Antes de concluir qualquer coisa a partir de um diff, verificar o que é `HEAD`.
3. Achado que chega: nomear a classe e varrer a superfície inteira antes de tocar na linha apontada, com a família definida larga o bastante.
4. O que se nota entra na lista no instante em que se nota.
5. Toda proteção nova entra com o teste que falha sem ela; e preferir apagar um componente a acrescentar uma guarda.
6. Antes de ação irreversível, nomear o que a desfaz. Se nada desfaz, a decisão é do operador.
7. Nada que acrescente estado à máquina entra sem justificativa contra a promessa.

## 12. O que precisa existir fora do repositório

Seção nova, de 16/08. O plano de implementação tinha **nove tarefas de código e nenhuma de implantação**, e por isso três achados distintos dos revisores — token do Slack, segredo do `/status` e remoção da fila de descarte — eram, na verdade, o mesmo buraco: não havia lugar onde se respondesse "o que precisa existir fora do repositório para isto rodar". Sem esta seção, cada item seria redescoberto no deploy, um por vez.

**Regra que acompanha a seção:** nenhuma tarefa cujo código dependa de um item abaixo entra antes de o item estar verificado pelo comando ao lado. Verificação é comando, não afirmação.

A coluna de estado distingue **fonte** (o repositório contém a mudança) de **deploy** (produção a executa) — a revisão apontou, com razão, que marcar "falta" o que a branch já contém faz o portão reportar como bloqueado o trabalho já feito. Nada desta branch está em produção até o deploy do worker.

| # | Item | Estado em 16/08 | Como se verifica |
|---|---|---|---|
| 1 | Token de bot no Secrets Store | **feito** — `github-slack-alerts-bot-token`, id `e73fc103b19545d8a4466671fb52e113`, escopo `workers` | `GET /accounts/{acc}/secrets_store/stores/df90c093…/secrets` |
| 2 | Binding do token no Worker | **feito** — reentrou em 16/08 ~22:05, depois de o item 8 ser executado; `Env` regenerado com o wrangler pinado | `SLACK_BOT_TOKEN` presente em `worker-configuration.d.ts` |
| 3 | Segredo compartilhado do `/status`, dos dois lados | **feito e rotacionado em 17/08** — Secrets Store `github-slack-alerts-status-secret` (id `815c2dc2…`, valor novo) + `ALERTS_STATUS_SECRET` **no environment `alerts-watchdog`** (dedicado, sem regras de proteção — exigência do zizmor; o repo-level foi removido) + binding na fonte; deploy pende | `gh secret list --env alerts-watchdog` e o `Env` gerado |
| 4 | Fila de descarte removida (decisão 8) | **fonte: feito em 17/08** — consumidor de alertas sem `dead_letter_queue`, `max_retries: 0` (mínimo não documentado; o primeiro deploy valida, fallback registrado = 1), DLQ fora dos consumers, docs atualizados; teste de contrato da configuração prende tudo (RED antes). O código mantém a guarda defensiva enquanto o **recurso** `github-slack-alerts-dlq` existir na Cloudflare — a exclusão do recurso é ação de infra pós-deploy | teste `config.test.ts` + ausência nos docs |
| 5 | Assinatura do webhook da organização com os **oito** eventos alcançáveis | **feito** — operador assinou os eventos novos pela tela em 16/08 ~22:00 (`security_advisory` é inalcançável: disponibilidade `app`, ver §3) | **não é verificável por `gh api`** — ver o bloco abaixo; verifica-se na tela da organização |
| 6 | Endereço de notificação da conta que edita o cron do vigia | **feito** — operador confirmou `contato@lcv.dev` em 16/08 ("concedido e confirmado") | declaração do operador; ajuste vive na conta, fora do alcance da API |
| 7 | Bot presente no canal privado | **feito** — `U0BR6NL2B9N` no `#github-alerts` desde 14/08 16:51 | `auth.test` e a leitura do canal |
| 8 | **Reduzir o app a `chat:write`** e reinstalar/rotacionar o token — **PRÉ-REQUISITO do deploy do Worker** | **feito** — 16/08 ~22:00: escopos reduzidos, `auth.revoke` devolveu `{"ok":true,"revoked":true}`, token novo no Secrets Store; o token vazado testado depois devolve `{"ok":false,"error":"account_inactive"}` | o header `x-oauth-scopes` do `auth.test` **com o token novo** listar só `chat:write` — pendente de o operador rodar (eu não leio o valor do Secrets Store) |
| 9 | **Recuperar o vão da assinatura** — reenviar pela tela os eventos das 4 famílias novas entregues entre 16/08 ~22:00 e o deploy do v2 | **pende — ação do operador, APÓS o deploy e DENTRO do prazo** | painel de webhooks da organização → Recent Deliveries dos tipos novos desde 16/08 22:00 → *Redeliver* em cada um; conferir a mensagem no canal |

**O item 9 é um achado P1 do Codex, e tem prazo.** Entre a assinatura dos oito eventos (~22:00 de 16/08) e o momento em que o v2 chegar à produção, o Worker **antigo** responde `202 event_not_supported` para `repository_advisory`, `security_and_analysis`, `secret_scanning_alert_location` e `secret_scanning_scan` — e o controlador de redelivery trata todo 2xx como sucesso (`scripts/github-slack-webhook-redelivery.mjs`, faixa `isDeliverySuccessful`), então **nada automático os revisita**. A janela de reenvio manual do GitHub é *"You can redeliver webhook deliveries that occurred in the past 3 days"* — ou seja, **cada entrega do vão expira 3 dias depois de ocorrer**; as primeiras, por volta de **19/08 22:00**. A verificação é pela tela (a API é cega para este hook, item 5). Reenviar ANTES do deploy não adianta: o Worker antigo recusaria de novo.

**Limite do reenvio (achado P2 da revisão):** reenviar **só as entregas do vão** — as 4 famílias novas, que o Worker antigo recusou e que por isso **não têm linha em lugar nenhum**. Um GUID das 4 famílias retidas que for reenviado manualmente **não é deduplicado através da fronteira v1→v2**: a `alert_delivery` nasce vazia e não consulta a `deliveries` legada — acoplá-las foi deliberadamente recusado (decisão 6: tabela nova para não herdar o CHECK de dez estados; e a leitura dupla acoplaria para sempre o ingress ao esquema legado por causa de uma janela de transição). O custo desse reenvio fora do escopo é **uma cópia duplicada no canal**, que a decisão 12 já precifica como aceitável — nunca perder vale mais que nunca duplicar.

**A ordem do item 8 é vinculante, não preferência** *(achado da revisão: o binding na fonte torna o token disponível ao Worker implantado)*: primeiro reduzir o escopo e rotacionar, **depois** o primeiro deploy que carrega o binding. Um Worker comprometido com o token atual leria o histórico do canal privado; com a ordem respeitada, o token que o binding entrega já nasce mínimo.

**O item 8 é achado da revisão automática, e procede como princípio de menor privilégio:** o token de hoje carrega `groups:history` e `groups:read`, mas este desenho **só posta** — a varredura de histórico está deliberadamente aposentada em §9, então nenhum caminho lê canal. Um Worker comprometido com o token atual leria o histórico do canal privado; com `chat:write` puro, não. A redução é na página **OAuth & Permissions** do app (remover os dois escopos de Bot Token Scopes, reinstalar, e o token novo substitui o do Secrets Store — a rotação que já estava recomendada por o token ter passado pelo chat).

**O item 5 não é verificável pela API, e a história de como eu descobri isso vale mais que o fato.** Primeiro `GET /orgs/LCV-Ideas-Software/hooks` devolveu `{"message":"Not Found","status":"404"}` — falta do escopo `admin:org_hook`. Concedido o escopo, a mesma chamada passou a devolver **HTTP 200 com corpo `[]`**, com `X-Accepted-Oauth-Scopes: admin:org_hook` satisfeito e o token pertencendo ao **único owner** da organização (`role=admin state=active`).

**E eu li `[]` como "não existe webhook nenhum". Estava errado.** O operador mostrou a tela: existem **dois** hooks na organização, um deles apontando para este Worker, com entrega mais recente bem-sucedida. Não há webhooks no nível Enterprise.

A explicação está documentada, verbatim ([webhooks de organização](https://docs.github.com/en/rest/orgs/webhooks)): *"OAuth apps cannot list, view, or edit webhooks that they did not create and users cannot list, view, or edit webhooks that were created by OAuth apps."*

**Três consequências.** A primeira, de método: **lista vazia não é prova de ausência** — é uma resposta que eu não interroguei, e a regra 1 vale para o que a API devolve tanto quanto para o que a documentação diz. A segunda, prática: a verificação deste item **não pode ser `gh api`**; tem de ser a tela da organização, ou um token da mesma identidade que criou o hook. A terceira, para o script: `scripts/github-slack-hook-audit.mjs` audita por `/orgs/{org}/hooks` (linha 297) e exige igualdade exata de conjunto (`:184-196`) — se o token que ele usa em Actions for cego pela mesma regra, a auditoria enxerga zero hooks e o resultado dela não significa o que parece. **Isso não foi verificado e não vou afirmar o que acontece; entra como item de medição antes de a Tarefa dos oito eventos existir** *(oito desde a emenda do §3, que removeu `security_advisory` por inalcançabilidade)*.

**O item 4 é maior do que "editar uma chave", e isso foi varrido antes de eu tocar em qualquer linha.** A fila de descarte aparece em **cinco** arquivos, e um deles é teste: `workers/github-slack-relay/wrangler.jsonc` (configuração), `src/index.ts` (o consumidor `processDeadLetterMessage` e o despacho por nome de fila), `test/queue.test.ts` (testes que exercitam esse caminho), `README.md` e `docs/GITHUB_SLACK_INTEGRATION.md` (documentação). Por isso a remoção é **tarefa própria, com teste falhando antes**, e não edição de configuração — apagar a chave e deixar o consumidor vivo produziria exatamente o silêncio que esta série já pagou caro para aprender a evitar.

**O item 5 tem uma armadilha que o item sozinho não mostra:** um evento precisa atravessar **três portões** para chegar ao canal — a assinatura do webhook da organização, a allowlist do Worker e o normalizador (`src/domain.ts:1064-1104`, que hoje só conhece três eventos). O plano mexia apenas no segundo. Por isso o portão da implementação não é "os quatro eventos foram adicionados", e sim **um teste dirigido por tabela que atravessa os três portões para cada um dos oito eventos** (quatro/oito desde a emenda do §3; o portão existe em `test/alerts/scope.test.ts`). Sem ele, o nono evento repete o erro.

**Anotado no instante em que notei, sem número que o sustente:** `secret_scanning_scan` dispara a cada varredura concluída. Não medi a frequência e não vou afirmar que é alta — mas é o único evento do escopo cuja cadência não tem relação com haver algo errado, e um canal de alertas afogado é um canal que ninguém lê. Medir antes de ligar.
