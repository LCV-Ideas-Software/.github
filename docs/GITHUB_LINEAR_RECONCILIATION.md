# Reconciliação GitHub ↔ Linear

O reconciliador é uma ferramenta estritamente somente leitura para os sistemas
externos. O repositório público contém apenas o código genérico, a documentação
e fixtures sintéticas. Configuração operacional, snapshots, identifiers, URLs e
findings reais permanecem exclusivamente na estação local confiável.

A integração usa o SDK TypeScript oficial `@linear/sdk` para Linear e os
clientes oficiais `@octokit/core` e `@octokit/plugin-paginate-rest` para GitHub.
As fronteiras validam todas as respostas antes de construir o snapshot
normalizado.

## Contrato

A reconciliação inventaria os repositórios GitHub ativos e não arquivados, seus
Issues e pull requests, além dos times e Issues Linear definidos na configuração
local. A avaliação detecta, sem efetuar qualquer alteração:

- ausência ou cardinalidade diferente de 1:1 entre contrapartes;
- divergência de estado;
- attachments e releases ausentes;
- comentários sem proveniência estável ou sem contraparte;
- duplicatas e itens semelhantes sem relação explícita;
- Issues, Cycles, Projects, Initiatives ou Documents vinculados diretamente ao
  time configurado no modo `umbrella`.

O time `umbrella` permanece apenas como contêiner hierárquico. O reconciliador
não escolhe destinos, não migra entidades, não cria relações e não corrige
findings. Times sem repositório correspondente são declarados explicitamente no
modo `linear-only`.

Snapshots incompletos, paginação inconclusiva, credenciais insuficientes e
respostas inválidas nunca são classificados como limpos. Comentários são
correlacionados apenas por identidade externa ou thread estável, não por
similaridade do corpo Markdown.

## Configuração local

A configuração é um arquivo JSON explícito, mantido fora de qualquer worktree
Git. Este exemplo é integralmente sintético:

```json
{
  "organization": "example-org",
  "releaseRequiredAfter": "2026-01-01T00:00:00.000Z",
  "commentGraceMinutes": 30,
  "mappings": [
    {
      "linearTeamKey": "UMBRELLA",
      "mode": "umbrella"
    },
    {
      "linearTeamKey": "EXAMPLE",
      "mode": "github-backed",
      "repository": "example-app",
      "linearReleasePipelineId": "00000000-0000-4000-8000-000000000001"
    },
    {
      "linearTeamKey": "INTERNAL",
      "mode": "linear-only"
    }
  ]
}
```

`linearReleasePipelineId` identifica a pipeline Linear exata usada para
correlacionar releases. A configuração exige exatamente um mapping `umbrella`,
chaves de time únicas e repositórios únicos para mappings `github-backed`.

## Execução live manual e local

A ferramenta não agenda nem dispara execuções live. Um operador a executa
manualmente em uma estação confiável. A CLI recusa `GITHUB_ACTIONS`, `CI` ou
marcadores conhecidos de provedores de integração contínua quando seus valores
são truthy.

Pré-requisitos:

- Node.js 24 ou superior;
- `LINEAR_READ_KEY`, limitado à permissão de leitura no workspace Linear;
- `LINEAR_GITHUB_READ_TOKEN`, limitado a leitura de Metadata, Issues e Pull
  requests nos repositórios inventariados;
- arquivo de configuração local aceito por `loadConfig`.

Exemplo em PowerShell, assumindo que as credenciais já foram carregadas somente
no processo local:

```powershell
node tools/github-linear-reconciler/src/cli.mjs --config C:\caminho\seguro\github-linear-reconciliation.json
```

A CLI não possui fallback para `GITHUB_TOKEN` e nunca imprime tokens, findings,
identifiers, URLs ou snapshots no stdout. O stdout contém uma única linha JSON
com o estado e as contagens agregadas, por exemplo:

```json
{ "state": "drift", "counts": { "advisory": 1, "drift": 2, "incomplete": 0 } }
```

Falhas inesperadas produzem somente uma mensagem genérica no stderr e o estado
redigido `incomplete` no stdout.

## Relatório local

O resultado detalhado e derivado é gravado atomicamente no perfil local. Raw
snapshots dos provedores nunca são persistidos. O arquivo contém somente versão
do schema, instante técnico em UTC, estado, contagens e findings derivados.

Diretórios padrão:

- Windows: `%LOCALAPPDATA%\github-linear-reconciler\reports`;
- Linux/macOS: `$XDG_STATE_HOME/github-linear-reconciler/reports` ou
  `$HOME/.local/state/github-linear-reconciler/reports`.

`GITHUB_LINEAR_RECONCILER_PROFILE_DIR` permite selecionar outro diretório local
absoluto e confiável. Antes de qualquer gravação, a implementação procura um
marcador `.git` no diretório e em todos os ancestrais, inclusive depois de
resolver o caminho canônico, e recusa destinos dentro de worktrees Git.

Em plataformas POSIX, o modo `0700` é reaplicado ao diretório mesmo quando ele já
existe, e cada arquivo é criado com `0600`. No Windows, valem as ACLs herdadas do
perfil do usuário.

Somente arquivos com o prefixo próprio
`github-linear-reconciliation-` participam da retenção. Relatórios com mais de
14 dias são removidos após uma nova gravação bem-sucedida. O diretório não deve
ser sincronizado para armazenamento público.

## Estados e códigos de saída

| Estado       | Código | Significado                                         |
| ------------ | -----: | --------------------------------------------------- |
| `clean`      |    `0` | Snapshot completo e nenhum finding.                 |
| `advisory`   |    `1` | Item semelhante ou outra revisão humana necessária. |
| `drift`      |    `1` | Divergência acionável confirmada.                   |
| `incomplete` |    `2` | Não foi possível provar completude.                 |

Um finding produzido pela execução local deve ser analisado contra o panorama
global antes de qualquer write operacional no GitHub ou Linear. A ferramenta é
e permanece somente leitura para ambos os provedores.

## Verificação pública

O workflow público usa apenas Actions oficiais fixadas por SHA, permissões
mínimas e checkout sem credenciais persistidas. Ele instala exclusivamente o
lockfile versionado, com lifecycle scripts desabilitados, e executa a suíte
sintética:

```sh
npm ci --ignore-scripts
npm run test:github-linear-reconciler
```

O workflow responde a mudanças no código, nos testes, na documentação, no
inventário de terceiros e nos arquivos que definem a instalação npm. Ele não
possui schedule, secrets, execução live, artifacts, Step Summary operacional nem
acesso a dados reais.
