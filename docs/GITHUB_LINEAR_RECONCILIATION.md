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
Issues e pull requests. No Linear, ela coleta primeiro uma visão global paginada
de Teams, Issues, Cycles, Projects, Initiatives, Documents, ReleasePipelines,
Releases e IssueToRelease. Identidades, referências e todos os timestamps
mutáveis são validados contra o mesmo `capturedAt` antes de qualquer filtragem
pelos mappings locais. A avaliação detecta, sem efetuar qualquer alteração:

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
`syncedWith.id` deve coincidir exatamente, com comparação case-sensitive, com o
`node_id` do GitHub Issue. A resource key é derivada somente depois dessa prova;
URL ou attachment não substitui a identidade nativa.

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
- `LINEAR_READ_KEY`, criado no Linear com somente a permissão `Read`, sem
  restrição por time e por uma conta que enxergue também os times privados;
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
crie uma chave com somente `Read` e acesso completo aos dados do workspace — não
limite a chave a times específicos. A conta proprietária deve possuir acesso
aos times privados incluídos na auditoria. Consulte a
[documentação oficial da API do Linear](https://linear.app/docs/api-and-webhooks)
e a página oficial de
[segurança e acesso](https://linear.app/docs/security-and-access), além do
contrato de [times privados](https://linear.app/docs/private-teams).

No GitHub, em **Organization Settings → Developer settings → GitHub Apps**, crie
uma App privada dedicada, desative autorização de usuário, Device Flow e
webhooks, não selecione eventos e conceda somente as três permissões de leitura
acima. Em **Where can this GitHub App be installed?**, selecione **Only on this
account**. Em **Install App**, instale-a somente na organização proprietária e
escolha **All repositories**. Anote o **App ID** — não o Client ID —, gere uma
private key e mantenha o `.pem` no diretório `credentials` do profile local. O
GitHub mantém somente a parte pública da chave. Consulte as instruções oficiais
para
[registrar uma GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app),
[instalar a própria App](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app),
[gerenciar private keys](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps)
e [autenticar como App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app).

Inicialize uma vez o profile tool-owned:

```powershell
node tools/github-linear-reconciler/src/cli.mjs --init-profile
```

O inicializador cria a raiz, o marker e o diretório fixo `credentials` com
permissões privadas. No Windows, a ferramenta exige owner igual ao operador
atual, DACL protegida e somente ACEs explícitas `Allow` com `FullControl` para o
SID do operador e `SYSTEM`. ACL herdada, outro principal ou `Deny` torna a
execução inconclusiva. Objetos preexistentes são apenas verificados e nunca
corrigidos automaticamente.

Depois de criar o `config.json` e copiar o PEM para o diretório criado pela
ferramenta, aplique a mesma policy aos dois arquivos com as APIs nativas de ACL
do PowerShell:

```powershell
$profileRoot = Join-Path $env:LOCALAPPDATA "github-linear-reconciler"
$configPath = Join-Path $profileRoot "config.json"
$pemPath = Join-Path $profileRoot "credentials\github-linear-reconciler.pem"

Copy-Item -LiteralPath "C:\caminho\baixado\app.private-key.pem" -Destination $pemPath

function Protect-ReconcilerFile([string] $LiteralPath) {
  $operatorSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $systemSid = [System.Security.Principal.SecurityIdentifier]::new("S-1-5-18")
  $acl = [System.Security.AccessControl.FileSecurity]::new()
  foreach ($sid in @($operatorSid, $systemSid)) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
      $sid,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
    [void] $acl.AddAccessRule($rule)
  }
  $acl.SetOwner($operatorSid)
  $acl.SetAccessRuleProtection($true, $false)
  Set-Acl -LiteralPath $LiteralPath -AclObject $acl
}

Protect-ReconcilerFile $configPath
Protect-ReconcilerFile $pemPath
```

Grave antes o JSON sintaticamente válido no caminho `$configPath`; a função
acima apenas protege um arquivo já existente. Para escolher outra raiz absoluta
e externa a worktrees, defina
`GITHUB_LINEAR_RECONCILER_PROFILE_DIR` antes da inicialização. Uma raiz já
existente sem o marker versionado da ferramenta é recusada e nunca tem suas
permissões alteradas. Ao executar novamente `--init-profile` sobre um profile
tool-owned de uma versão anterior, a ferramenta pode criar o novo diretório
`credentials` ausente; nenhum objeto preexistente é alterado. `Get-Acl` e
`Set-Acl` são os cmdlets nativos usados para verificar e aplicar essa policy.

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
arquivos `0600`. No Windows, exige owner atual e a ACL explícita descrita acima
para raiz, marker, credentials, config, reports, temporários e arquivos finais.
Ela nunca corrige um objeto preexistente: qualquer desvio de ownership, modo ou
ACL torna a execução inconclusiva.

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
mínimas e checkout sem credenciais persistidas. Os jobs usam as famílias
oficiais `ubuntu-24.04` e `windows-2025`; elas recebem atualizações do GitHub e
não são descritas como imagens fisicamente imutáveis. Ambos instalam
exclusivamente o lockfile versionado, com lifecycle scripts desabilitados, e
executam a suíte sintética:

```sh
npm ci --ignore-scripts
npm run test:github-linear-reconciler
```

O workflow responde a mudanças no código, nos testes, na documentação, no
inventário de terceiros e nos arquivos que definem a instalação npm. Ele não
possui schedule, secrets, execução live, artifacts, Step Summary operacional nem
acesso a dados reais.
