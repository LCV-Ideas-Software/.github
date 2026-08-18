# Reconciliação GitHub ↔ Linear

O workflow público `GitHub Linear Reconciliation` apenas verifica por testes que
o reconciliador é **somente leitura**. O carrier interno obrigatório deve
executar o audit live a cada 12 horas no repositório `.github-private`, onde
Summary, logs e artifact detalhados não expõem o inventário Linear privado. Até
esse carrier ser implantado e provar sua primeira execução, não há audit live
agendado. O cliente GitHub aceita apenas `GET`; o cliente Linear aceita apenas
operações GraphQL `query` e recusa qualquer `mutation` antes do acesso à rede.

## Escopo

O inventário cobre, nos dois sentidos:

- todos os Issues Linear, inclusive arquivados, e todos os times do workspace;
- todos os repositórios GitHub ativos e não arquivados, inclusive forks;
- todos os Issues GitHub abertos e fechados de cada repositório com Issues
  habilitados.

`.github-org` mapeia para o repositório `.github`; os demais times respaldados
por repositório usam o nome do repositório. Um time archived ou retired não
satisfaz a presença exigida para um repositório ativo.

Times deliberadamente privados e sem repositório podem ser declarados pela
variável `LINEAR_ONLY_TEAM_KEYS`, usando **chaves estáveis** separadas por
vírgula. A lista é estrita: entradas vazias, repetidas, desconhecidas ou a chave
`LCV` falham. As exceções aparecem no sumário e não reduzem o inventário
GitHub→Linear.

A API GraphQL pública do Linear não expõe a configuração do GitHub Issues
Sync. Por isso, cada chave Linear-only também deve constar separadamente em
`LINEAR_ONLY_NO_GITHUB_SYNC_ATTESTED_TEAM_KEYS`, como atestação humana
versionada no workflow de que o sync foi desabilitado na UI. A ausência ou
divergência entre as duas listas torna a execução inconclusiva.

Para impedir que essa declaração manual permaneça válida depois de uma mudança
na integração, `LINEAR_GITHUB_INTEGRATION_ATTESTATION` deve conter
`<integration-id>@<updatedAt>` exatamente como observado pelo próprio audit. O
auditor exige uma única integração GitHub ativa e torna a execução inconclusiva
quando o id, o timestamp, a cardinalidade ou a metadata mudam. A configuração
interna de repositórios continua sendo uma inspeção humana porque a API pública
não a expõe. O auditor também rejeita qualquer evidência material de sync ou
vínculo GitHub nos times Linear-only.

O time guarda-chuva `LCV` permanece como contêiner de hierarquia, mas seu
estado-alvo de trabalho é **vazio**, inclusive no histórico arquivado: nenhum
Issue, Cycle, Project, Initiative ou Document diretamente vinculado. Seus
sub-times podem permanecer parentados a ele. Cada entidade de trabalho deve ser
migrada para o time individual
responsável, preservando relações, comentários, attachments e releases.
Duplicatas são consolidadas no canônico antes da migração.

O reconciliador apenas detecta a pendência. Ele nunca escolhe um destino nem
realiza a migração.

## Verificações

- divergência de estado entre o issue Linear e seu gêmeo GitHub;
- cardinalidade exatamente 1:1 dos gêmeos e Issue presente em apenas um dos
  inventários;
- ausência do attachment GitHub no repositório exato do time;
- release `completed` de pipeline `continuous` ausente para cada PR mergeado a
  partir de 17/08/2026 09:00, com SHA e pipeline correspondentes; carriers
  anteriores à implantação da pipeline continuam obrigatórios como attachment,
  mas são explicitamente dispensados de release histórica;
- comentário ausente em qualquer direção, desatualizado ou com thread
  desconectada, inválida ou fora da organização configurada;
- metadata obrigatória ausente ou inválida em Issue, carrier PR ou comentário;
- duplicata ou item semelhante sem relação explícita, inclusive dentro do mesmo
  time;
- qualquer entidade de trabalho ainda pertencente ao time `LCV`;
- paginação, repositório inacessível, rate limit, resposta parcial ou teto
  conservador de comparações de duplicatas excedido.

O processo retorna `0` quando está limpo, `1` para drift acionável e `2` quando
a auditoria é inconclusiva. Uma leitura parcial nunca é classificada como limpa.
O Step Summary preserva as contagens completas e limita os detalhes para ficar
abaixo do teto do GitHub Actions. O carrier interno deve publicar o resultado
JSON integral por 14 dias somente no repositório interno, no artifact
`github-linear-reconciliation-<run>-<attempt>`, inclusive quando o audit termina
com drift ou de forma inconclusiva. O workflow público não recebe credenciais,
não executa o audit live e não publica Summary ou artifact com dados
operacionais.

## Credenciais

O environment `linear-observability` do repositório interno `.github-private`
deve conter `LINEAR_READ_KEY`, uma chave Linear somente leitura, e
`LINEAR_GITHUB_READ_TOKEN`, com acesso organizacional somente leitura a
Metadata, Issues e Pull requests em todos os repositórios. A preferência durável
é um GitHub App com permissões equivalentes e token de curta duração.

`LINEAR_GITHUB_READ_TOKEN` é obrigatório. O workflow não usa o `GITHUB_TOKEN`
local como fallback, pois esse token pode omitir silenciosamente repositórios
Internal e Private fora do repositório `.github`. Se a credencial estiver
ausente, a auditoria aborta como inconclusiva (`exit 2`).
