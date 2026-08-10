# Registro de trabalho — .github

Fonte canonica e versionada do ritual de registro da organizacao.
Os arquivos locais de agente (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`) sao gitignorados por
politica da organizacao e apenas apontam para este documento.

## Registro de trabalho (GitHub Projects, Issues e Discussions)

A equipe e composta por tres membros: o **operador** (humano), **Claude Code** e **ChatGPT-Codex**.
Quase todo trabalho acontece em par (operador+Claude ou operador+Codex). O que fica so no
transcript da sessao se perde para o outro membro. Por isso o registro abaixo e **obrigatorio**.

Quadro deste repositorio: `https://github.com/orgs/LCV-Ideas-Software/projects/15`
Quadro consolidado da organizacao: `https://github.com/orgs/LCV-Ideas-Software/projects/17`

### Os quatro gatilhos

**G1 — fim de bloco de trabalho.** Publique um *status update* no quadro deste repositorio,
dizendo o que foi feito, o que ficou pendente e o que o proximo agente precisa saber:

```bash
gh api graphql -f query='
  mutation($id:ID!, $body:String!) {
    createProjectV2StatusUpdate(input:{projectId:$id, status:ON_TRACK, body:$body}) {
      statusUpdate { id }
    }
  }' -f id="$PROJECT_ID" -f body="..."
```
Use `AT_RISK` ou `OFF_TRACK` quando for o caso. O `PROJECT_ID` sai de
`gh api graphql -f query='query{organization(login:"LCV-Ideas-Software"){projectV2(number:15){id}}}'`.

**G2 — achado nao corrigido.** Todo bug, falha, limitacao de plataforma ou comportamento
inesperado que voce encontrar e **nao** resolver na hora vira issue imediatamente, com
reproducao, ambiente, evidencia, o que ja foi tentado e a hipotese de causa. Use o
formulario adequado em `.github/ISSUE_TEMPLATE/`.

**G3 — decisao ou aprendizado duravel.** Criterio objetivo: *"isto seria util para quem
enfrentar este problema daqui a tres meses?"* Se sim, vira Discussion.
- Conhecimento especifico deste repo -> Discussions **deste repositorio** (Q&A ou Ideas).
- Conhecimento transversal a varios repos (politica de release, regra de ruleset, restricao
  de plataforma) -> Discussions **da organizacao**.

**G4 — trabalho nao-trivial.** Abra a issue **antes** do PR e referencie com `Closes #N`.
Isso ativa o fechamento automatico, o campo *Linked pull requests* e a progressao de Status.

### Valvula de escape

Bump de dependencia, correcao de typo, lockfile e ajuste de formatacao **dispensam issue**.
O PR basta — ele entra no quadro sozinho.

### Campos

Classifique toda issue com **Type** (Task, Bug, Feature, Incident, Security, Maintenance,
Documentation, Spike) e preencha os campos de issue da organizacao **Agent** (quem esta
tocando) e **Origin** (de onde surgiu). Em Bug e Incident preencha tambem **Environment**.
Esses campos sao `ORG_ONLY`: nao aparecem para o publico, mesmo neste repositorio publico.

### Fluxo de Status no quadro

`Triagem` -> `Backlog` -> `Em andamento` -> `Em cross-review` -> `Em PR` -> `Concluido`,
com desvios `Bloqueado` e `Descartado`.

> **Invariante**: as opcoes `Triagem` e `Concluido` estao vinculadas **por ID** a workflows
> internos do GitHub que nao sao editaveis por API. Podem ser renomeadas; **nunca apagadas**.

### Nada de identificador real em repositorio publico

Issues, PRs e Discussions deste repositorio sao publicos e permanentes. Use placeholders
(`proj-x`, `exemplo-projeto-000`, `exemplo.com`) no lugar de IDs de projeto de nuvem, nomes
de banco, dominios e contas. Detalhe operacional sensivel vai para o quadro privado ou para
`.github-private`.
