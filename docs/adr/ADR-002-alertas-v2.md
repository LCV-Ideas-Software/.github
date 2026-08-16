# ADR-002 — Entrega de alertas do GitHub no Slack (implementação nova)

**Estado:** proposta, aguardando aprovação do operador.
**Substitui:** ADR-001 (dispatcher com outbox), abandonado por decisão do operador em 16/08/2026.
**Data:** 16/08/2026. Horários deste documento são de Brasília (UTC−03:00).

---

## 1. Por que existe

O app oficial "GitHub for Slack" entrega quase tudo. Este sistema existe **apenas** para o que ele não sabe entregar, e para nada além disso.

O que o app oficial assina, verbatim da documentação do GitHub ([personalizar notificações](https://docs.github.com/en/integrations/how-tos/slack/customize-notifications)): por padrão issues, pull requests, commits na branch padrão, releases publicadas e status de deployment; opcionalmente revisões, execuções de workflow, branches, comentários, commits em qualquer branch e discussions.

Duas lacunas, ambas verificadas em fonte primária em 16/08/2026:

**Alerta de segurança não existe como evento assinável.** Da mesma página: *"The provided content does not mention Dependabot, code scanning, or secret scanning notifications."* Confirmado independentemente no README do próprio app ([integrations/slack](https://github.com/integrations/slack)): *"The documentation does not mention Dependabot alerts, code scanning alerts, secret scanning alerts, or security advisories as subscribable features."*

**Execução de workflow não filtra por conclusão.** Do mesmo README: *"The documentation specifies filters for workflows by 'name,' 'event,' 'branch,' and 'actor,' but does not include filtering by run conclusion (such as failures only)."* Ou seja, "me avise só quando falhar" não é expressável.

Estado real das assinaturas em 16/08/2026 16:55, lido da confirmação que o próprio app postou no `#github-activity` para cada um dos 12 repositórios:

```
issues, pulls, commits:'*', releases, deployments, reviews, comments,
branches, discussions, workflows:{event:"pull_request" branch:your-default-branch}
```

O app aplicou por conta própria um filtro em `workflows`: apenas execuções disparadas por `pull_request`, na branch padrão. Execuções agendadas, disparadas por push e de merge queue não são entregues por ele para nenhum dos 12 repositórios.

## 2. A promessa, e o que ela compra

**Nunca perder um alerta. Uma duplicata é aceitável.**

Essa segunda metade não é concessão: é o que torna a retentativa um recurso de recuperação **total**. Com ela, toda incerteza se resolve reenviando, e o sistema nunca precisa responder "chegou ou não chegou?" — que é a pergunta que gerou as 60 emendas do ADR-001, a varredura do histórico do Slack, a deleção irreversível de mensagem e o menu assinado de operador que existia para desfazer o que a máquina não devia fazer sozinha.

## 3. Escopo

**Entra:** alerta do Dependabot, de code scanning, de secret scanning (incluindo os sub-eventos), aviso de segurança publicado, mudança de configuração de segurança, e execução de workflow cuja conclusão seja `action_required`, `cancelled`, `failure`, `stale`, `startup_failure` ou `timed_out`.

**Sai, porque o oficial entrega:** issues, pull requests, commits, releases, deployment, revisões, comentários, branches e discussions.

**Sai, por decisão deliberada** (§5, decisão 1): falhas do próprio vigia e do workflow de deploy do relay.

## 4. A forma

Três estados: `pendente` → `enviado`, ou `pendente` → `falhou`.

**Ingress** — mantido do que roda hoje no `main`: confere a assinatura HMAC antes de parsear, aceita só os eventos do escopo, normaliza o payload, grava a linha com o GUID da entrega do GitHub como chave, publica na fila. Não há mais noção de destino: há um canal só.

**Consumidor** — posta no Slack e grava o desfecho.

**Cron** — reenfileira **toda** linha `pendente` mais velha que um limiar, incondicionalmente e de forma idempotente, sem conhecer o estado da fila; e reenfileira linhas `falhou` por causa externa. A fila é otimização de latência; **o cron é a única garantia de vivacidade** — ver §7.

**Status** — contagens por estado e a idade da linha pendente mais antiga, protegido por segredo compartilhado.

**Vigia** — tarefa agendada no GitHub que lê o status e falha de propósito quando há coisa parada; o e-mail que o GitHub manda ao falhar é o aviso.

## 5. Decisões do operador, registradas

1. **Excluir da entrega as falhas do próprio vigia e do deploy do relay**, casando pelo caminho do arquivo do workflow. É a única escolha deliberada de não entregar algo. Motivo em §6, instância A.
2. **O e-mail de aviso vai para `contato@lcv.dev`**, endereço escolhido, não herdado de quem editou o agendamento por último.
3. **"Não consegui falar com o Worker" conta como problema**, após duas verificações consecutivas falharem.
4. **O vigia poder morrer em silêncio é aceito e declarado** como limitação conhecida (§6, instância D).
5. **Todos os eventos de segurança extras entram**, inclusive os sub-eventos de secret scanning que a recomendação inicial deixava de fora.
6. **Tabela nova**, não reconstrução da existente.
7. **Resposta de limite de taxa do Slack não conta contra o teto de tentativas**; o valor do teto é escolhido por medição.
8. **A fila de descarte é removida**, para o teto da aplicação disparar antes do teto da fila.
9. **O status é protegido por segredo compartilhado.**
10. **A retenção da linha é declarada com a consequência escrita ao lado**: a linha guardada é a própria trava contra duplicata, então o prazo define também a janela em que um reenvio do GitHub não vira segunda mensagem.

## 6. A classe que este desenho precisa resistir

**O observador acoplado ao observado: o comportamento do próprio sistema corrompe o próprio sinal.** Oito instâncias, enumeradas antes de qualquer código.

**A — o vigia fabrica o que vigia.** Falha do vigia é `workflow_run` com conclusão de problema, que o ingress roteia para o canal de alertas. Um vigia vermelho produz um alerta novo e não entregável a cada tique. Registrado no ADR-001 §10 como defeito D12 do sistema aposentado. *Resolvido pela decisão 1.*

**B — a recuperação desarma a detecção.** Se a idade que o vigia lê for ancorada num campo que o cron escreve, o cron mantém a idade abaixo de qualquer limiar para sempre. O ADR-001 H40 rejeitou `updated_ms` por exatamente isso, em suas palavras "fail-DANGEROUS". *Resolução: a idade ancora no instante de ingresso, e nenhum caminho de recuperação escreve esse campo.*

**C — vermelho permanente não carrega informação.** Linha que nunca vai entrar, reenfileirada a cada passe, mantém o alarme aceso para sempre. É a cegueira de 22,6 horas do ADR-001 H44, em que o monitor já falhava de hora em hora por motivo alheio. *Resolução: causa externa (autenticação, pertencimento ao canal, indisponibilidade) é reenfileirada com recuo e limite por passe; causa intrínseca à linha (mensagem longa demais, payload irrenderizável) é estacionada e nunca reenfileirada.*

**C′ — a resolução de C reintroduzia C, e um peer pegou.** Estacionar sem superfície de comando de operador (§5, decisão... ausente por desenho) significa que **nada, nunca, limpa a linha estacionada**. O alarme ficaria aceso para sempre por causa dela — exatamente o vermelho permanente que C existe para evitar, entrando pela porta aberta para consertá-lo. Achado do painel de revisão de pares na segunda rodada, não meu. *Resolução: a linha estacionada deixa de ser condição de alarme e passa a ser CONTAGEM. O vigia alarma no DELTA — quando uma nova aparece —, nunca no nível. Assim o operador é avisado uma vez de que algo estacionou, e um estacionamento antigo não consome a capacidade de sinalizar do sistema.*

**D — ausência de sinal lê como saúde.** O GitHub documenta que execuções agendadas podem sumir: *"If the load is sufficiently high enough, some queued jobs may be dropped"*, e que em repositório público *"scheduled workflows are automatically disabled when no repository activity has occurred in 60 days"* ([eventos que disparam workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)). Execução que não acontece não gera artefato, logo não há onde pendurar notificação. *Aceito e declarado, decisão 4. Não sei quantificar a frequência.*

**E — o status é servido por quem está sendo vigiado.** Worker fora do ar devolve erro de transporte, não veredicto. *Resolvido pela decisão 3.*

**F — detector e fonte compartilham a plataforma.** O vigia roda no GitHub Actions e os eventos chegam por webhook do GitHub. Derivação, não citação: uma degradação do GitHub atinge os dois juntos, e o detector não consegue reportar a queda em que está. *Limite declarado, sem conserto.*

**F′ — o buraco do homem-morto foi MOVIDO, não FECHADO, e este documento diz isso com todas as letras.** Três peers independentes (codex, deepseek, grok) convergiram nisto na segunda rodada de revisão: qualquer arranjo em que os dois braços do aviso saem pelo GitHub — o e-mail do Actions e uma issue entregue pelo app oficial — cai junto numa degradação do GitHub. Deslocar a detecção para a Cloudflare não fecha o buraco; move-o. **Nenhum arranjo estudado fecha**, porque todo canal de aviso disponível depende do GitHub ou do Slack, e os dois são exatamente os lados que podem estar quebrados. O operador aceitou o limite na decisão 4 com esse entendimento. Registrado assim para que nenhuma leitura futura confunda "há um mecanismo" com "está resolvido" — que é precisamente o erro que o ADR-001 H26 cometeu e pagou.

**G — o aviso depende de uma caixa de e-mail.** *Resolvido pela decisão 2, que ao menos torna o destinatário uma escolha.*

**H — o deploy do relay é uma execução de workflow.** Deploy que falha vira alerta que o deploy falhado não entrega. *Resolvido pela decisão 1.*

## 7. Fatos de plataforma que o desenho assume, todos citados

**A fila descarta.** Da documentação da Cloudflare ([configurar filas](https://developers.cloudflare.com/queues/configuration/configure-queues/)): *"The maximum number of retries for a message... Defaults to 3 retries"* e *"If a `dead_letter_queue` is not defined, messages that repeatedly fail processing will eventually be discarded."* É por isso que o cron não é opcional: sem ele, "nunca perder" é falso.

**Retenção.** Da mesma página: *"Defaults to 345600 (4 days). Must be between 60 and 1209600 (14 days)"*. A fila de alertas está configurada em 86 400 s (24 h), lido da API da Cloudflare em 16/08/2026.

**O Slack devolve `ts` e `channel` no sucesso.** Da documentação ([chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage)): *"Response including the 'timestamp ID' (`ts`) and the channel-like thing where the message was posted."*

**Ritmo.** Da documentação de [limites de taxa](https://docs.slack.dev/apis/web-api/rate-limits/): *"no more than one message per second per channel"*, com rajada permitida. O volume real de alertas está na ordem de 9 por hora, então nenhuma tabela durável de ritmo é necessária — o 429 basta.

**Volume de workflow.** 153 execuções em 24 horas nos 12 repositórios, contadas pela API do GitHub em 16/08/2026.

**Migrações aplicadas em produção param na 0009**, lido do `d1_migrations` do banco `github-slack-alerts-db` em 16/08/2026. A migração nova é a 0010.

## 8. Classificação do envio

Lista **explícita de permanentes**; todo o resto tenta de novo. A direção importa: um código permanente que eu esqueça na lista gira até o teto e vira `falhou` alarmado — atraso limitado e visível. Um código transitório classificado como permanente perderia o alerta em silêncio.

Permanentes, da lista oficial de erros do método: `channel_not_found`, `is_archived`, `not_in_channel`, `invalid_auth`, `not_authed`, `token_expired`, `token_revoked`, `account_inactive`, `no_permission`, `missing_scope`, `no_text`, `msg_blocks_too_long`, `invalid_blocks`, `metadata_too_large`.

Transitórios documentados: `fatal_error`, `internal_error`, `service_unavailable`, `request_timeout`, `rate_limited`, `ratelimited`.

Tudo o mais: tenta de novo.

**O classificador é total sobre a invocação, não sobre a resposta do Slack.** Falha ao renderizar o payload, leitura de segredo que falha, ou erro ao gravar o desfecho nunca chegam à tabela acima. O corpo do consumidor é envolvido por inteiro e nunca deixa exceção escapar para a fila.

## 9. Deliberadamente ausente

Varredura do histórico do Slack, resolver, detecção de duplicata, reparo de duplicata, `chat.delete`, varredura de verificação, prova canônica a defender, menu de operador, requisição assinada, estado ambíguo, reivindicação, lease, CAS de estado, tabela durável de ritmo.

Cada item desta lista é uma decisão, não um esquecimento. Juntos, são a origem da maior parte das 60 emendas do ADR-001.

## 10. O que não sei, e não vou afirmar

- O comportamento de espera entre tentativas da fila da Cloudflare não está documentado na página de configuração.
- O que acontece com a mensagem se a retenção expirar enquanto ela ainda está sendo retentada não está documentado.
- A frequência com que o GitHub descarta execuções agendadas não é publicada.

Os três vão para medição antes de virarem número na implementação.

**Três números ainda não escolhidos**, e este documento não finge que estão: o limiar de idade que faz o cron reenfileirar, o teto de tentativas da decisão 7, e o prazo de retenção da decisão 10. As decisões fixaram o **critério** de cada um — medição para o teto, e para a retenção a consequência escrita ao lado —, não o valor. Eles entram no plano de implementação com a medição que os justifica.

**Fora de escopo, registrado para não se perder:** 203 linhas de alerta ficaram sem entrega entre 14/08/2026 16:38 e a pausa das filas, estacionadas em `manual_review` na tabela legada, e nenhum caminho automático as alcança. Não são tratadas aqui — importá-las é acréscimo de peça, e só se decide quando o sistema existir.

## 11. Regras de construção, vinculantes

Determinadas pelo operador em 16/08/2026, derivadas do colapso do ADR-001. O plano de implementação herda cada uma.

1. Nenhuma frase sobre comportamento entra em documento ou comentário sem a linha citada que a prova. Se não dá para citar, não se escreve.
2. Antes de concluir qualquer coisa a partir de um diff, verificar o que é `HEAD`.
3. Achado que chega: nomear a classe e varrer a superfície inteira antes de tocar na linha apontada, com a família definida larga o bastante.
4. O que se nota entra na lista no instante em que se nota.
5. Toda proteção nova entra com o teste que falha sem ela; e preferir apagar um componente a acrescentar uma guarda.
6. Antes de ação irreversível, nomear o que a desfaz. Se nada desfaz, a decisão é do operador.
7. Nada que acrescente estado à máquina entra sem justificativa contra a promessa.
