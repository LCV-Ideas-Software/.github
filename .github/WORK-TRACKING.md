# Registro de trabalho no GitHub

Este documento descreve como registrar trabalho no repositório público
[`LCV-Ideas-Software/.github`](https://github.com/LCV-Ideas-Software/.github) e nos
recursos nativos do GitHub associados. Ele não concede autorização para alterar
configurações da organização ou da Enterprise.

## Princípios

- Conduza auditorias e correções em um repositório por vez e encerre cada repositório com
  evidências verificáveis.
- Prefira Issues, Projects e Discussions nativos do GitHub para o registro durável.
- Não altere regras, configurações, Apps, secrets ou variables da organização ou da
  Enterprise sem consentimento humano específico.
- Não publique segredos nem identificadores operacionais privados em artefatos públicos.
- Em texto destinado a pessoas, use datas e horas no formato pt-BR e no fuso UTC−03:00 de
  Brasília. Sistemas técnicos podem manter UTC, ISO 8601 ou epoch até a apresentação final.

## Onde registrar

### Issues

Use uma Issue para trabalho acionável, achados não resolvidos, incidentes e investigações.
Selecione o formulário e o Issue type apropriados. Vincule o PR de implementação à Issue,
sem declarar encerramento automático quando a decisão de fechamento ainda não tiver sido
tomada.

### Projects

- [Project #15 — `.github`](https://github.com/orgs/LCV-Ideas-Software/projects/15):
  acompanhamento deste repositório.
- [Project #17 — `LCV Portfolio`](https://github.com/orgs/LCV-Ideas-Software/projects/17):
  visão consolidada da organização.

A presença e o estado de cada item nos dois quadros devem ser conferidos explicitamente.
Este repositório não declara inclusão, backfill ou mudança automática de status em Projects.

### Discussions

Use as [Discussions da organização](https://github.com/orgs/LCV-Ideas-Software/discussions)
para decisões, desenho de governança e aprendizados que continuarão úteis depois do trabalho
imediato. O repositório público `.github` é a fonte das Discussions da organização.

- `Announcements`: publicações concluídas e sua verificação.
- `Ideas`: propostas ainda abertas a exploração.
- `Q&A`: perguntas técnicas com resposta durável.

### Pull requests

Use o PR para o diff, as revisões e a evidência da implementação. O PR deve referenciar a
Issue ou Discussion pertinente e registrar os gates executados. A conclusão do trabalho
depende do estado real dos checks, das revisões e do ambiente aplicável, não apenas do merge.

## Encerramento de um repositório

Antes de considerar um repositório concluído:

1. registre os achados e decisões nos recursos adequados;
2. confirme checks, revisões, alertas e comportamento operacional aplicáveis;
3. atualize manualmente o estado dos itens nos Projects #15 e #17;
4. deixe a worktree limpa, no branch esperado e alinhada ao remoto, preservando trabalho
   alheio que ainda esteja em andamento.
