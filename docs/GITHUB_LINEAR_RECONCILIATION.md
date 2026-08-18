# Reconciliação GitHub ↔ Linear

O reconciliador é uma ferramenta estritamente somente leitura para os sistemas
externos. O repositório público contém apenas o código genérico, a documentação
e fixtures sintéticas. Configuração operacional, snapshots, identifiers, URLs e
findings reais permanecem exclusivamente na estação local confiável.

A integração usa o SDK TypeScript oficial `@linear/sdk` para Linear e os
clientes oficiais `@octokit/auth-app`, `@octokit/core` e
`@octokit/plugin-paginate-rest` para GitHub.
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

A identidade canônica vem exclusivamente do GitHub Issues Sync nativo. O
attachment dessa contraparte é obrigatório, mas attachments suplementares
seguros para outros Issues existentes são permitidos: eles são referências e
não participam de estado, comentários, releases ou cardinalidade.

## Configuração local

A configuração é o arquivo fixo `config.json` dentro de um profile local criado
pela ferramenta e mantido fora de qualquer worktree Git. Este exemplo é
integralmente sintético:

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

- Node.js `24.19.0`, conforme `.node-version`;
- `LINEAR_READ_KEY`, criado no Linear com somente a permissão `Read` e acesso a
  todos os times inventariados;
- uma GitHub App privada dedicada, instalada na organização em `All
repositories`, sem webhooks ou eventos e com somente `Metadata: read`,
  `Issues: read` e `Pull requests: read`;
- `LINEAR_GITHUB_APP_ID`, contendo o App ID dessa App;
- `LINEAR_GITHUB_APP_PRIVATE_KEY_PATH`, apontando para a chave PEM RSA em
  arquivo local privado, fora de qualquer worktree Git.

O uso de GitHub App é intencional: a instalação permite provar por API a
seleção `all`, a organização, a ausência de suspensão e o conjunto exato de
permissões antes do inventário. Um PAT com acesso somente a repositórios
selecionados não fornece essa prova e não é aceito.

### Preparação oficial das credenciais

No Linear, abra **Settings → Account → Security & Access → Personal API keys**,
crie uma chave com somente `Read` e inclua todos os times mapeados, o time
`umbrella` e os times `linear-only`. Para que times futuros também entrem no
inventário, prefira leitura do workspace inteiro. Consulte a
[documentação oficial da API do Linear](https://linear.app/docs/api-and-webhooks)
e a página oficial de
[segurança e acesso](https://linear.app/docs/security-and-access).

No GitHub, em **Organization Settings → Developer settings → GitHub Apps**, crie
uma App privada dedicada, desative autorização de usuário, Device Flow e
webhooks, não selecione eventos e conceda somente as três permissões de leitura
acima. Instale-a apenas na organização proprietária, escolhendo **All
repositories**. Anote o **App ID**, gere uma private key e mova o `.pem` para um
diretório privado fora de qualquer checkout. O GitHub mantém somente a parte
pública da chave. Consulte as instruções oficiais para
[registrar uma GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app),
[revisar a instalação](https://docs.github.com/en/apps/using-github-apps/reviewing-and-modifying-installed-github-apps)
e [gerenciar private keys](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps).

Inicialize uma vez o profile tool-owned:

```powershell
node tools/github-linear-reconciler/src/cli.mjs --init-profile
```

O inicializador cria somente a raiz e o marker. Crie então a pasta privada de
credenciais, mova para ela o PEM baixado e restrinja a ACL ao operador e ao
`SYSTEM` (substitua o caminho de origem):

```powershell
$profileRoot = Join-Path $env:LOCALAPPDATA "github-linear-reconciler"
$credentialsDir = Join-Path $profileRoot "credentials"
$operator = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
New-Item -ItemType Directory -Path $credentialsDir -ErrorAction Stop
icacls $credentialsDir /inheritance:r /grant:r "${operator}:(OI)(CI)F" "SYSTEM:(OI)(CI)F"
$pemPath = Join-Path $credentialsDir "github-linear-reconciler.pem"
Move-Item -LiteralPath "C:\caminho\baixado\app.private-key.pem" -Destination $pemPath
icacls $pemPath /inheritance:r /grant:r "${operator}:R" "SYSTEM:R"
```

Depois grave o JSON no caminho fixo
`$env:LOCALAPPDATA\github-linear-reconciler\config.json`. Para escolher outra
raiz absoluta e externa a worktrees, defina
`GITHUB_LINEAR_RECONCILER_PROFILE_DIR` antes da inicialização. Uma raiz já
existente sem o marker versionado da ferramenta é recusada e nunca tem suas
permissões alteradas.

Exemplo em PowerShell, carregando as credenciais somente no processo atual:

```powershell
$env:LINEAR_READ_KEY = Read-Host "Linear API key" -MaskInput
$env:LINEAR_GITHUB_APP_ID = "<App ID>"
$env:LINEAR_GITHUB_APP_PRIVATE_KEY_PATH = "$env:LOCALAPPDATA\github-linear-reconciler\credentials\github-linear-reconciler.pem"
node tools/github-linear-reconciler/src/cli.mjs
Remove-Item Env:LINEAR_READ_KEY, Env:LINEAR_GITHUB_APP_ID, Env:LINEAR_GITHUB_APP_PRIVATE_KEY_PATH
```

A CLI não aceita PAT, não possui fallback para `GITHUB_TOKEN` e nunca imprime
tokens, private key, findings, identifiers, URLs ou snapshots no stdout. O
stdout contém uma única linha JSON com o estado e as contagens agregadas, por
exemplo:

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

`GITHUB_LINEAR_RECONCILER_PROFILE_DIR` seleciona a raiz inteira do profile, não
um diretório arbitrário de relatórios. Antes de qualquer gravação, a
implementação procura um marcador `.git` no diretório e em todos os ancestrais,
inclusive depois de resolver o caminho canônico, e recusa destinos dentro de
worktrees Git.

Em plataformas POSIX, a ferramenta exige owner atual, diretórios `0700` e
arquivos `0600`. Ela nunca corrige com `chmod` um objeto preexistente: qualquer
desvio de ownership ou modo torna a execução inconclusiva. No Windows, valem as
ACLs herdadas do perfil do usuário; restrinja o PEM ao operador e `SYSTEM`.

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
