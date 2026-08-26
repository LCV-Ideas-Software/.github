# Registro de trabalho no GitHub

Este documento descreve como registrar trabalho no repositório público
[`LCV-Ideas-Software/.github`](https://github.com/LCV-Ideas-Software/.github) e nos
recursos nativos do GitHub associados. Ele não concede autorização para alterar
configurações da organização ou da Enterprise.

## Princípios

- Considere Issues, pull requests e Discussions deste repositório como conteúdo público. Registre
  aqui somente informações que possam ser apresentadas externamente sem ressalvas.
- Mantenha dados sensíveis, detalhes internos da Enterprise e execução operacional em superfícies
  privadas autorizadas, como Linear e Projects privados.
- Conduza auditorias e correções em um repositório por vez e encerre cada repositório com
  evidências verificáveis.
- Não altere regras, configurações, Apps, secrets ou variables da organização ou da
  Enterprise sem consentimento humano específico.
- Não publique segredos nem identificadores operacionais privados em artefatos públicos.
- Em texto destinado a pessoas, use datas e horas no formato pt-BR e no fuso UTC−03:00 de
  Brasília. Sistemas técnicos podem manter UTC, ISO 8601 ou epoch até a apresentação final.

## Onde registrar

### Issues

Use uma Issue de `.github` somente para trabalho acionável sobre suas superfícies públicas
institucionais, seus defaults comunitários ou sua governança pública. Selecione o formulário e o
Issue type apropriados. Vincule o PR de implementação à Issue, sem declarar encerramento automático
quando a decisão de fechamento ainda não tiver sido tomada.

### Projects

- [Project #17 — `LCV Ideas & Software Portfolio`](https://github.com/orgs/LCV-Ideas-Software/projects/17):
  visão consolidada da organização.

O quadro é **privado**. O link exige uma conta com acesso à organização; para quem lê este arquivo
publicamente ele retorna 404. Trabalho operacional interno usa os Projects privados e o Linear
correspondentes, não Issues ou Discussions públicas de `.github`.

A inclusão de novos itens é feita pelo workflow nativo **Auto-add to project** configurado no
Project. A presença e o estado no quadro ainda devem ser conferidos explicitamente; itens anteriores
ao Auto-add ou fora de seus filtros são adicionados manualmente quando necessário.

### Discussions

Use as [Discussions da organização](https://github.com/orgs/LCV-Ideas-Software/discussions) para
decisões, anúncios, desenho de governança e aprendizados que possam ser integralmente públicos e
continuarão úteis depois do trabalho imediato. O repositório público `.github` é a fonte das
Discussions da organização; lock não altera sua visibilidade pública.

- `Announcements`: publicações concluídas e sua verificação.
- `Ideas`: propostas ainda abertas à exploração.
- `Q&A`: perguntas técnicas com resposta durável.

### Pull requests

Use o PR para o diff, as revisões e a evidência da implementação. O PR deve referenciar a
Issue ou Discussion pertinente e registrar os gates executados. A conclusão do trabalho
depende do estado real dos checks, das revisões e do ambiente aplicável, não apenas do merge.

## Encerramento de um repositório

Antes de considerar um repositório concluído:

1. registre os achados e decisões nos recursos adequados;
2. confirme checks, revisões, alertas e comportamento operacional aplicáveis;
3. atualize manualmente o estado dos itens no Project privado aplicável;
4. deixe a worktree limpa, no branch esperado e alinhada ao remoto, preservando trabalho
   alheio que ainda esteja em andamento.
