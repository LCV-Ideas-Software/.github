# Entrega de alertas v2 — plano de implementação (dois estados)

> **Para trabalhadores agênticos:** SUB-SKILL OBRIGATÓRIA: use `superpowers:subagent-driven-development` (recomendado) ou `superpowers:executing-plans` para implementar tarefa a tarefa. Os passos usam caixas (`- [ ]`) para acompanhamento.

**Objetivo:** entregar no canal privado `#github-alerts` o que o app oficial não entrega — eventos de segurança e `workflow_run` com conclusão de falha — sem nunca perder um alerta aceito, aceitando duplicata.

**Arquitetura:** dois estados (`pending` → `sent`), nada terminal. Ingress grava a linha e publica **só no INSERT**. Consumidor posta via `chat.postMessage`, grava o desfecho e **sempre retorna**. O cron é o único agendador: carimba `attempts`/`updated_ms`/`next_due_ms` num `UPDATE` condicional e publica só se `changes = 1`; a retenção apaga só `sent`. O vigia lê a idade por `created_ms` via `/status`.

**Spec:** `docs/adr/ADR-002-alertas-v2.md` (emendada em 16/08; portão de desenho fechado por declaração do operador após 9 rodadas, cinco peers sem objeção). Substitui `2026-08-16-alertas-v2.md` (⛔ SUPERADO).

**Tecnologias:** Cloudflare Workers, D1, Cloudflare Queues, Vitest, TypeScript.

## Restrições globais

- **Branch:** `feat/alerts-v2`. Migração `0010_alert_delivery.sql` e seus 9 testes de esquema **já existem** (RED→GREEN feitos).
- **Canal único:** `C0BMUK793NV`. Sem conceito de destino.
- **Escopo — NOVE eventos:** `dependabot_alert`, `code_scanning_alert`, `secret_scanning_alert`, `security_advisory`, `repository_advisory`, `security_and_analysis`, `secret_scanning_alert_location`, `secret_scanning_scan`, e `workflow_run` com conclusão em `action_required|cancelled|failure|stale|startup_failure|timed_out`.
- **Exclusão por repositório + caminho** (decisão 1 emendada), nunca só caminho, nunca nome.
- **Mensagem da fila:** `{ v: 2, delivery_id }` — nada mais. O consumidor relê a linha; a linha é a verdade. O `v: 2` discrimina do `QueueJob` legado por declaração, não por inferência de forma.
- **Matriz de escritas (testada por mutação na Tarefa 2):** INGRESS escreve a linha inteira no INSERT e nada depois; CRON escreve `attempts`, `updated_ms`, `next_due_ms` e apaga `sent` velho; CONSUMIDOR escreve `state='sent'` + `slack_message_ts` no sucesso e `last_error` no fracasso — **nunca** colunas de agendamento nem `created_ms`.
- **Legado convive, não sai:** os eventos de atividade caem fora da allowlist (o app oficial os cobre), então o caminho legado perde o tráfego sem ser removido. Retirada do código morto é tarefa futura, fora deste plano.
- **Portão local pré-push = espelho da CI:** `npm run types:check && npx tsc --noEmit && npx tsc --noEmit --noUnusedLocals --noUnusedParameters && npx vitest run && npm run build`. Wrangler **pinado** (nunca `@latest`).
- **Antes e depois de cada push:** reler o PR inteiro (threads + corpos das reviews com suprimidos).
- **Regras de construção do ADR §11**, incluindo a cláusula operacional da regra 1 e âncora por conteúdo (nunca número de linha) para arquivos em edição.

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `src/alerts/contract.ts` | constantes e a curva de recuo; nenhuma E/S |
| `src/alerts/store.ts` | acesso ao D1; a matriz de escritas mora aqui |
| `src/alerts/render.ts` | payload normalizado → texto da mensagem; função pura |
| `src/alerts/consumer.ts` | processa `{v:2, delivery_id}`: posta e grava desfecho |
| `src/alerts/cron.ts` | carimbo CAS + publicação + retenção |
| `src/alerts/status.ts` | corpo do `/status`; comparação de segredo em tempo constante |
| `src/domain.ts` (modificar) | allowlist de 9 eventos + normalizadores dos 5 novos + exclusão repo+caminho |
| `src/index.ts` (modificar) | fiação: ingress, roteamento v2 na fila, cron, rota `/status` |
| `scripts/github-slack-hook-audit.mjs` (modificar) | `HOOK_EVENTS` com os 9 eventos |
| `.github/workflows/alerts-watchdog.yml` | o vigia |

Cada arquivo de `src/alerts/` tem teste irmão em `test/alerts/`.

---

### Tarefa 1: contrato e a curva de recuo

**Arquivos:** criar `src/alerts/contract.ts`; testar `test/alerts/contract.test.ts`.

**Produz:** `ALERTS_CHANNEL_ID`, `ROW_RETENTION_MS = 2_592_000_000`, `CRON_SELECT_LIMIT = 100`, `WATCHDOG_MAX_PENDING_AGE_MS = 3_600_000`, `recuoMs(attempts: number): number`, `type AlertQueueMessage = { v: 2; delivery_id: string }`.

- [ ] **Passo 1: teste que falha**

```ts
import { describe, expect, it } from "vitest";
import { recuoMs } from "../../src/alerts/contract";

// ADR-002 §4: recuo(n) = min(24h, 5min × 3^(n-1)), recuo(0) = 0.
// A tabela do ADR é o oráculo; o teste transcreve cada linha dela.
describe("curva de recuo (ADR-002 §4)", () => {
  it.each([
    [0, 0],
    [1, 5 * 60_000],
    [2, 15 * 60_000],
    [3, 45 * 60_000],
    [4, 135 * 60_000],
    [5, 405 * 60_000],
    [6, 1215 * 60_000],
    [7, 24 * 3_600_000],
    [8, 24 * 3_600_000],
    [100, 24 * 3_600_000],
  ])("recuo(%i) = %i ms", (attempts, esperado) => {
    expect(recuoMs(attempts)).toBe(esperado);
  });

  it("é monotônica até saturar — nunca encurta a espera", () => {
    for (let n = 0; n < 12; n++) {
      expect(recuoMs(n + 1)).toBeGreaterThanOrEqual(recuoMs(n));
    }
  });
});
```

- [ ] **Passo 2: rodar e ver falhar** — `npx vitest run test/alerts/contract.test.ts` → FALHA, módulo inexistente.
- [ ] **Passo 3: implementar**

```ts
// ADR-002 §5, decisão do operador: um canal só.
export const ALERTS_CHANNEL_ID = "C0BMUK793NV";

// Decisão 10: a linha guardada É a janela de deduplicação — 30 dias, e o
// apagamento só alcança linhas `sent` (a promessa proíbe apagar pendente).
export const ROW_RETENTION_MS = 2_592_000_000;

// Limite por passe do cron. A ordenação por next_due_ms garante rotação:
// o carimbo empurra a linha para o fim, então cabeça travada não existe.
export const CRON_SELECT_LIMIT = 100;

// Vigia: falha transitória se resolve em ~20 min pela curva; 60 min dá 3×
// de margem antes de alarmar sobre recuperação normal em curso.
export const WATCHDOG_MAX_PENDING_AGE_MS = 3_600_000;

// A mensagem da fila carrega SÓ a identidade. A linha é a verdade; payload
// embutido seria cópia que envelhece. v:2 discrimina do QueueJob legado
// por declaração.
export type AlertQueueMessage = { v: 2; delivery_id: string };

const RECUO_BASE_MS = 5 * 60_000;
const RECUO_TETO_MS = 24 * 3_600_000;

// ADR-002 §4: recuo(0)=0 (linha nova é devida no próximo passe); depois
// 5min × 3^(n-1), saturando em 24h — que é POLÍTICA da aplicação
// (≤1 cópia/dia em regime), não teto de plataforma.
export function recuoMs(attempts: number): number {
  if (attempts <= 0) return 0;
  return Math.min(RECUO_TETO_MS, RECUO_BASE_MS * 3 ** (attempts - 1));
}
```

- [ ] **Passo 4: rodar e ver passar.**
- [ ] **Passo 5: commit** — `feat(alerts): contrato e curva de recuo, com a tabela do ADR como oráculo`

---

### Tarefa 2: o store — a matriz de escritas em código

**Arquivos:** criar `src/alerts/store.ts`; testar `test/alerts/store.test.ts` (usa `test/alerts/helpers.ts`, que já existe e devolve `{ database, d1 }`).

**Interfaces — Produz:**

```ts
type AlertRow = {
  deliveryId: string; payloadJson: string; state: "pending" | "sent";
  attempts: number; nextDueMs: number; slackMessageTs: string | null;
  lastError: string | null; createdMs: number; updatedMs: number;
};
class AlertStore {
  constructor(db: D1Database);
  insert(deliveryId: string, payloadJson: string, now: number): Promise<boolean>; // false = GUID repetido
  get(deliveryId: string): Promise<AlertRow | null>;
  dueRows(now: number, limit: number): Promise<AlertRow[]>;
  stampDue(deliveryId: string, now: number, nextDueMs: number): Promise<boolean>; // o CAS; false = não estava devida
  markSent(deliveryId: string, ts: string | null, now: number): Promise<void>;
  recordFailure(deliveryId: string, error: string): Promise<void>; // NÃO toca agendamento
  counts(): Promise<{ pending: number; sent: number }>;
  oldestPendingCreatedMs(): Promise<number | null>;
  deleteSentOlderThan(cutoffMs: number): Promise<number>;
}
```

- [ ] **Passo 1: testes que falham** — os quatro vinculantes do ADR mais a matriz:

```ts
import { describe, expect, it, afterEach } from "vitest";
import { AlertStore } from "../../src/alerts/store";
import { closeAlertDatabases, makeAlertDb } from "./helpers";

afterEach(closeAlertDatabases);

describe("AlertStore — a matriz de escritas do ADR-002 §4", () => {
  it("insert é idempotente pelo GUID: a segunda vez devolve false", async () => {
    const store = new AlertStore(makeAlertDb().d1);
    expect(await store.insert("guid-1", "{}", 1_000)).toBe(true);
    expect(await store.insert("guid-1", "{}", 2_000)).toBe(false);
  });

  it("CAS: linha devida + dois passes = EXATAMENTE UM carimbo (teste vinculante do §9)", async () => {
    const store = new AlertStore(makeAlertDb().d1);
    await store.insert("guid-2", "{}", 1_000); // next_due_ms = 0: devida já
    const primeiro = await store.stampDue("guid-2", 10_000, 310_000);
    const segundo = await store.stampDue("guid-2", 10_001, 310_000);
    expect(primeiro).toBe(true);
    expect(segundo).toBe(false); // next_due_ms=310000 > 10001: não devida
    expect((await store.get("guid-2"))?.attempts).toBe(1);
  });

  it("linha 'sent' nunca é carimbada: o consumidor venceu a corrida", async () => {
    const store = new AlertStore(makeAlertDb().d1);
    await store.insert("guid-3", "{}", 1_000);
    await store.markSent("guid-3", "1786.000001", 2_000);
    expect(await store.stampDue("guid-3", 10_000, 310_000)).toBe(false);
  });

  it("recordFailure NÃO toca agendamento nem created_ms (matriz por mutação)", async () => {
    const store = new AlertStore(makeAlertDb().d1);
    await store.insert("guid-4", "{}", 1_000);
    await store.stampDue("guid-4", 5_000, 305_000);
    await store.recordFailure("guid-4", "http_500");
    const row = await store.get("guid-4");
    expect(row).toMatchObject({
      lastError: "http_500", attempts: 1, updatedMs: 5_000,
      nextDueMs: 305_000, createdMs: 1_000, state: "pending",
    });
  });

  it("dueRows ordena por next_due_ms e ignora sent e não-devidas", async () => {
    const store = new AlertStore(makeAlertDb().d1);
    await store.insert("velha", "{}", 1_000);
    await store.insert("nova", "{}", 2_000);
    await store.stampDue("nova", 3_000, 999_000); // não-devida
    await store.insert("entregue", "{}", 1_500);
    await store.markSent("entregue", null, 2_500);
    const due = await store.dueRows(10_000, 10);
    expect(due.map((r) => r.deliveryId)).toEqual(["velha"]);
  });

  it("retenção apaga só sent, por created_ms, e devolve a contagem", async () => {
    const store = new AlertStore(makeAlertDb().d1);
    await store.insert("pendente-velha", "{}", 1_000);
    await store.insert("sent-velha", "{}", 1_000);
    await store.markSent("sent-velha", null, 2_000);
    await store.insert("sent-nova", "{}", 900_000);
    await store.markSent("sent-nova", null, 900_500);
    expect(await store.deleteSentOlderThan(500_000)).toBe(1);
    expect(await store.get("pendente-velha")).not.toBeNull(); // NUNCA apagada
    expect(await store.get("sent-nova")).not.toBeNull();
  });

  it("counts e oldestPendingCreatedMs alimentam o /status", async () => {
    const store = new AlertStore(makeAlertDb().d1);
    await store.insert("a", "{}", 1_000);
    await store.insert("b", "{}", 3_000);
    await store.insert("c", "{}", 2_000);
    await store.markSent("c", null, 4_000);
    expect(await store.counts()).toEqual({ pending: 2, sent: 1 });
    expect(await store.oldestPendingCreatedMs()).toBe(1_000);
  });
});
```

- [ ] **Passo 2: rodar e ver falhar.**
- [ ] **Passo 3: implementar** — cada método é UMA instrução SQL; nenhum `batch()`:

```ts
import type { AlertRow } from "./contract-row"; // ver nota abaixo: tipo em store.ts mesmo

export type { AlertRow };

export class AlertStore {
  readonly #db: D1Database;
  constructor(db: D1Database) { this.#db = db; }

  async insert(deliveryId: string, payloadJson: string, now: number): Promise<boolean> {
    const r = await this.#db.prepare(
      `INSERT INTO alert_delivery (delivery_id, payload_json, state, created_ms, updated_ms)
       VALUES (?, ?, 'pending', ?, ?) ON CONFLICT(delivery_id) DO NOTHING`,
    ).bind(deliveryId, payloadJson, now, now).run();
    return (r.meta.changes ?? 0) > 0;
  }

  async get(deliveryId: string): Promise<AlertRow | null> {
    const row = await this.#db.prepare(
      "SELECT * FROM alert_delivery WHERE delivery_id = ?",
    ).bind(deliveryId).first<RawRow>();
    return row ? toAlertRow(row) : null;
  }

  async dueRows(now: number, limit: number): Promise<AlertRow[]> {
    const r = await this.#db.prepare(
      `SELECT * FROM alert_delivery
        WHERE state = 'pending' AND next_due_ms <= ?
        ORDER BY next_due_ms ASC LIMIT ?`,
    ).bind(now, limit).all<RawRow>();
    return r.results.map(toAlertRow);
  }

  // O carimbo (ADR-002 §4). created_ms NUNCA aparece num SET deste arquivo.
  async stampDue(deliveryId: string, now: number, nextDueMs: number): Promise<boolean> {
    const r = await this.#db.prepare(
      `UPDATE alert_delivery
          SET attempts = attempts + 1, updated_ms = ?, next_due_ms = ?
        WHERE delivery_id = ? AND state = 'pending' AND next_due_ms <= ?`,
    ).bind(now, nextDueMs, deliveryId, now).run();
    return (r.meta.changes ?? 0) > 0;
  }

  async markSent(deliveryId: string, ts: string | null, now: number): Promise<void> {
    await this.#db.prepare(
      `UPDATE alert_delivery
          SET state = 'sent', slack_message_ts = ?, last_error = NULL
        WHERE delivery_id = ? AND state = 'pending'`,
    ).bind(ts, deliveryId).run();
    void now; // a matriz: o consumidor não escreve colunas de agendamento
  }

  async recordFailure(deliveryId: string, error: string): Promise<void> {
    await this.#db.prepare(
      "UPDATE alert_delivery SET last_error = ? WHERE delivery_id = ? AND state = 'pending'",
    ).bind(error, deliveryId).run();
  }

  async counts(): Promise<{ pending: number; sent: number }> {
    const row = await this.#db.prepare(
      `SELECT
         SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN state = 'sent' THEN 1 ELSE 0 END) AS sent
       FROM alert_delivery`,
    ).first<{ pending: number | null; sent: number | null }>();
    return { pending: row?.pending ?? 0, sent: row?.sent ?? 0 };
  }

  async oldestPendingCreatedMs(): Promise<number | null> {
    const row = await this.#db.prepare(
      "SELECT MIN(created_ms) AS m FROM alert_delivery WHERE state = 'pending'",
    ).first<{ m: number | null }>();
    return row?.m ?? null;
  }

  async deleteSentOlderThan(cutoffMs: number): Promise<number> {
    const r = await this.#db.prepare(
      "DELETE FROM alert_delivery WHERE state = 'sent' AND created_ms < ?",
    ).bind(cutoffMs).run();
    return r.meta.changes ?? 0;
  }
}

type RawRow = {
  delivery_id: string; payload_json: string; state: "pending" | "sent";
  attempts: number; next_due_ms: number; slack_message_ts: string | null;
  last_error: string | null; created_ms: number; updated_ms: number;
};

export type AlertRow = {
  deliveryId: string; payloadJson: string; state: "pending" | "sent";
  attempts: number; nextDueMs: number; slackMessageTs: string | null;
  lastError: string | null; createdMs: number; updatedMs: number;
};

function toAlertRow(r: RawRow): AlertRow {
  return {
    deliveryId: r.delivery_id, payloadJson: r.payload_json, state: r.state,
    attempts: r.attempts, nextDueMs: r.next_due_ms,
    slackMessageTs: r.slack_message_ts, lastError: r.last_error,
    createdMs: r.created_ms, updatedMs: r.updated_ms,
  };
}
```

*(Nota do executor: o `import type` do topo é ilustrativo do problema que o plano anterior teve — defina `AlertRow`/`RawRow`/`toAlertRow` NESTE arquivo, como acima, e remova o import. Nenhum símbolo pode vir de arquivo que não existe.)*

- [ ] **Passo 4: rodar e ver passar.**
- [ ] **Passo 5: mutação — provar o invariante de `created_ms`:** trocar `SET last_error = ?` por `SET last_error = ?, created_ms = 0` em `recordFailure`, rodar, capturar a falha do teste da matriz verbatim, restaurar via Edit.
- [ ] **Passo 6: commit** — `feat(alerts): store com a matriz de escritas, CAS provado por dois passes`

---

### Tarefa 3: renderizador e consumidor

**Arquivos:** criar `src/alerts/render.ts`, `src/alerts/consumer.ts`; testar `test/alerts/render.test.ts`, `test/alerts/consumer.test.ts`.

**Interfaces — Consome:** `AlertStore` (T2), `ALERTS_CHANNEL_ID`/`AlertQueueMessage` (T1). **Produz:** `renderAlertText(payload: Record<string, unknown>): string`, `processAlertMessage(raw: unknown, deps: { store: AlertStore; botToken: string; fetch: typeof fetch; now: () => number }): Promise<void>`.

- [ ] **Passo 1: testes do renderizador** — formato observado no canal (leitura de 16/08):

```ts
import { describe, expect, it } from "vitest";
import { renderAlertText } from "../../src/alerts/render";

describe("renderAlertText", () => {
  it("monta título, repositório, fonte, link e a linha de delivery", () => {
    const texto = renderAlertText({
      severity: "high", title: "OpenSSF Scorecard: failure",
      repository: "LCV-Ideas-Software/astrologo-app",
      source: "GitHub Actions / workflow_run:completed",
      branch: "main", actor: "github-merge-queue[bot]",
      body: "Workflow OpenSSF Scorecard completed with conclusion failure.",
      html_url: "https://github.com/LCV-Ideas-Software/astrologo-app/actions/runs/1",
      delivery_id: "fa20c8e0-0000-0000-0000-000000000000",
      occurred_at: "2026-08-16T18:43:01Z",
    });
    expect(texto).toContain("*[high] OpenSSF Scorecard: failure*");
    expect(texto).toContain("Repository: LCV-Ideas-Software/astrologo-app");
    expect(texto).toContain("<https://github.com/LCV-Ideas-Software/astrologo-app/actions/runs/1|Open in GitHub>");
    expect(texto).toContain("fa20c8e0-0000-0000-0000-000000000000");
  });

  it("campo ausente não derruba: linha é omitida, nunca 'undefined' no texto", () => {
    const texto = renderAlertText({ title: "X", delivery_id: "d-1" });
    expect(texto).not.toContain("undefined");
    expect(texto).toContain("*X*");
  });
});
```

- [ ] **Passo 2: testes do consumidor** — com `fetch` falso; a linha 1 do §8 inteira:

```ts
import { describe, expect, it, afterEach } from "vitest";
import { AlertStore } from "../../src/alerts/store";
import { processAlertMessage } from "../../src/alerts/consumer";
import { closeAlertDatabases, makeAlertDb } from "./helpers";

afterEach(closeAlertDatabases);

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
    })) as unknown as typeof fetch;
}

async function comLinha(payload = '{"title":"T","delivery_id":"d-1"}') {
  const store = new AlertStore(makeAlertDb().d1);
  await store.insert("d-1", payload, 1_000);
  return store;
}

const deps = (store: AlertStore, f: typeof fetch) => ({
  store, botToken: "xoxb-token-de-teste", fetch: f, now: () => 50_000,
});

describe("consumidor (ADR-002 §8: ok:true = enviado; resto fica pendente)", () => {
  it("ok:true marca sent e guarda ts", async () => {
    const store = await comLinha();
    await processAlertMessage({ v: 2, delivery_id: "d-1" },
      deps(store, fakeFetch(200, { ok: true, ts: "1786.000010" })));
    expect(await store.get("d-1")).toMatchObject({ state: "sent", slackMessageTs: "1786.000010" });
  });

  it("ok:true SEM ts também é sent — ts é recibo, não prova (§7)", async () => {
    const store = await comLinha();
    await processAlertMessage({ v: 2, delivery_id: "d-1" },
      deps(store, fakeFetch(200, { ok: true })));
    expect(await store.get("d-1")).toMatchObject({ state: "sent", slackMessageTs: null });
  });

  it("ok:false fica pendente com o código registrado — nunca desiste (decisão 12)", async () => {
    const store = await comLinha();
    await processAlertMessage({ v: 2, delivery_id: "d-1" },
      deps(store, fakeFetch(200, { ok: false, error: "channel_not_found" })));
    expect(await store.get("d-1")).toMatchObject({ state: "pending", lastError: "channel_not_found" });
  });

  it("HTTP 500 e corpo não-JSON ficam pendentes", async () => {
    const store = await comLinha();
    await processAlertMessage({ v: 2, delivery_id: "d-1" },
      deps(store, fakeFetch(500, "<html>")));
    expect((await store.get("d-1"))?.state).toBe("pending");
  });

  it("linha já sent: reentrega da plataforma NÃO posta de novo", async () => {
    const store = await comLinha();
    await store.markSent("d-1", "1786.1", 2_000);
    let chamadas = 0;
    const contando: typeof fetch = (async () => { chamadas++; return new Response("{}"); }) as never;
    await processAlertMessage({ v: 2, delivery_id: "d-1" }, deps(store, contando));
    expect(chamadas).toBe(0);
  });

  it("payload irrenderizável: registra e RETORNA — exceção nunca escapa", async () => {
    const store = await comLinha("{\"title\":123}"); // render lança? não: vira string. Força:
    const explosivo: typeof fetch = (async () => { throw new Error("boom"); }) as never;
    await expect(
      processAlertMessage({ v: 2, delivery_id: "d-1" }, deps(store, explosivo)),
    ).resolves.toBeUndefined();
    expect((await store.get("d-1"))?.state).toBe("pending");
  });

  it("mensagem que não é {v:2, delivery_id} é ignorada sem lançar", async () => {
    const store = await comLinha();
    await expect(
      processAlertMessage({ deliveryId: "legado" }, deps(store, fakeFetch(200, {}))),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Passo 3: rodar e ver falhar; implementar:**

```ts
// render.ts — puro; campo ausente = linha omitida.
export function renderAlertText(payload: Record<string, unknown>): string {
  const s = (k: string): string | null =>
    typeof payload[k] === "string" && (payload[k] as string).length > 0
      ? (payload[k] as string) : null;
  const linhas: string[] = [];
  const sev = s("severity");
  const titulo = s("title") ?? "GitHub alert";
  linhas.push(sev ? `*[${sev}] ${titulo}*` : `*${titulo}*`);
  const campos: ReadonlyArray<readonly [string, string]> = [
    ["repository", "Repository"], ["source", "Source"],
    ["branch", "Branch"], ["actor", "Actor"],
  ];
  for (const [k, rotulo] of campos) {
    const v = s(k);
    if (v !== null) linhas.push(`${rotulo}: ${v}`);
  }
  const corpo = s("body");
  if (corpo !== null) linhas.push(corpo);
  const url = s("html_url");
  if (url !== null) linhas.push(`<${url}|Open in GitHub>`);
  const id = s("delivery_id");
  const quando = s("occurred_at");
  if (id !== null) linhas.push(`Delivery: \`${id}\`${quando ? ` · ${quando}` : ""}`);
  return linhas.join("\n");
}
```

```ts
// consumer.ts — corpo inteiro num try; retorno normal = ack implícito.
import { ALERTS_CHANNEL_ID } from "./contract";
import type { AlertStore } from "./store";
import { renderAlertText } from "./render";

type Deps = { store: AlertStore; botToken: string; fetch: typeof fetch; now: () => number };

export async function processAlertMessage(raw: unknown, deps: Deps): Promise<void> {
  try {
    const msg = raw as { v?: unknown; delivery_id?: unknown };
    if (msg?.v !== 2 || typeof msg.delivery_id !== "string") return;
    const row = await deps.store.get(msg.delivery_id);
    if (row === null || row.state === "sent") return; // reentrega/duplicata: nada

    const texto = renderAlertText(JSON.parse(row.payloadJson) as Record<string, unknown>);
    const resp = await deps.fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deps.botToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel: ALERTS_CHANNEL_ID, text: texto }),
      signal: AbortSignal.timeout(10_000),
    });

    let corpo: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = await resp.json();
      if (typeof parsed === "object" && parsed !== null) corpo = parsed as Record<string, unknown>;
    } catch { /* corpo ilegível = não-sucesso; a linha fica pendente */ }

    if (corpo?.ok === true) {
      const ts = typeof corpo.ts === "string" ? corpo.ts : null;
      await deps.store.markSent(row.deliveryId, ts, deps.now());
      return;
    }
    const codigo = typeof corpo?.error === "string" ? corpo.error : `http_${resp.status}`;
    await deps.store.recordFailure(row.deliveryId, codigo);
  } catch (error) {
    // Nunca escapa para a fila. Registrar é melhor-esforço.
    try {
      const msg = raw as { delivery_id?: unknown };
      if (typeof msg?.delivery_id === "string") {
        await deps.store.recordFailure(msg.delivery_id, `exception:${String(error).slice(0, 200)}`);
      }
    } catch { /* a linha continua pendente; o cron recarimba */ }
  }
}
```

- [ ] **Passo 4: rodar e ver passar.**
- [ ] **Passo 5: commit** — `feat(alerts): renderizador e consumidor — ok:true é enviado, o resto fica pendente`

---

### Tarefa 4: cron e retenção

**Arquivos:** criar `src/alerts/cron.ts`; testar `test/alerts/cron.test.ts`.

**Interfaces — Consome:** `AlertStore` (T2), `recuoMs`/`CRON_SELECT_LIMIT`/`ROW_RETENTION_MS` (T1). **Produz:** `runAlertCron(deps: { store: AlertStore; queue: Pick<Queue, "send">; now: () => number }): Promise<{ published: number; purged: number }>`.

- [ ] **Passo 1: testes que falham:**

```ts
import { describe, expect, it, afterEach } from "vitest";
import { AlertStore } from "../../src/alerts/store";
import { runAlertCron } from "../../src/alerts/cron";
import { ROW_RETENTION_MS } from "../../src/alerts/contract";
import { closeAlertDatabases, makeAlertDb } from "./helpers";

afterEach(closeAlertDatabases);

function fila(): { sent: unknown[]; queue: { send(m: unknown): Promise<void> } } {
  const sent: unknown[] = [];
  return { sent, queue: { async send(m) { sent.push(m); } } };
}

describe("cron — o único agendador (ADR-002 §4)", () => {
  it("linha devida: carimba e publica {v:2, delivery_id} — e o SEGUNDO passe não republica", async () => {
    const store = new AlertStore(makeAlertDb().d1);
    await store.insert("d-1", "{}", 1_000);
    const { sent, queue } = fila();
    const r1 = await runAlertCron({ store, queue, now: () => 10_000 });
    const r2 = await runAlertCron({ store, queue, now: () => 10_500 });
    expect(r1.published).toBe(1);
    expect(r2.published).toBe(0); // ADR §9: dois passes, UM enfileiramento
    expect(sent).toEqual([{ v: 2, delivery_id: "d-1" }]);
    expect((await store.get("d-1"))?.attempts).toBe(1);
  });

  it("depois do recuo vencer, a linha volta a ser publicada", async () => {
    const store = new AlertStore(makeAlertDb().d1);
    await store.insert("d-2", "{}", 1_000);
    const { queue } = fila();
    await runAlertCron({ store, queue, now: () => 10_000 }); // attempts=1, next=+5min
    const depois = 10_000 + 5 * 60_000 + 1;
    const r = await runAlertCron({ store, queue, now: () => depois });
    expect(r.published).toBe(1);
    expect((await store.get("d-2"))?.attempts).toBe(2);
  });

  it("sent não é publicada; retenção apaga sent velha no mesmo passe", async () => {
    const store = new AlertStore(makeAlertDb().d1);
    await store.insert("s-1", "{}", 1_000);
    await store.markSent("s-1", null, 2_000);
    const agora = 1_000 + ROW_RETENTION_MS + 1;
    const { sent, queue } = fila();
    const r = await runAlertCron({ store, queue, now: () => agora });
    expect(sent).toEqual([]);
    expect(r.purged).toBe(1);
    expect(await store.get("s-1")).toBeNull();
  });

  it("falha do send não perde a linha: o carimbo já correu, o próximo ciclo recarimba", async () => {
    const store = new AlertStore(makeAlertDb().d1);
    await store.insert("d-3", "{}", 1_000);
    const explosiva = { async send() { throw new Error("queue down"); } };
    await expect(
      runAlertCron({ store, queue: explosiva, now: () => 10_000 }),
    ).resolves.toMatchObject({ published: 0 });
    expect((await store.get("d-3"))?.state).toBe("pending"); // atraso, nunca perda
  });
});
```

- [ ] **Passo 2: rodar e ver falhar; implementar:**

```ts
import { CRON_SELECT_LIMIT, ROW_RETENTION_MS, recuoMs } from "./contract";
import type { AlertStore } from "./store";

type Deps = { store: AlertStore; queue: { send(m: unknown): Promise<void> }; now: () => number };

export async function runAlertCron(deps: Deps): Promise<{ published: number; purged: number }> {
  const agora = deps.now();
  let published = 0;
  const devidas = await deps.store.dueRows(agora, CRON_SELECT_LIMIT);
  for (const row of devidas) {
    // O carimbo (CAS): a linha deixa de ser devida NO enfileiramento.
    const proximaTentativa = row.attempts + 1;
    const carimbou = await deps.store.stampDue(
      row.deliveryId, agora, agora + recuoMs(proximaTentativa),
    );
    if (!carimbou) continue; // outro passe venceu, ou o consumidor marcou sent
    try {
      await deps.queue.send({ v: 2, delivery_id: row.deliveryId });
      published++;
    } catch {
      // Publicação falhou DEPOIS do carimbo: direção do erro é atraso
      // (o próximo ciclo recarimba após o recuo), nunca perda nem cópia.
    }
  }
  const purged = await deps.store.deleteSentOlderThan(agora - ROW_RETENTION_MS);
  return { published, purged };
}
```

- [ ] **Passo 3: rodar e ver passar.**
- [ ] **Passo 4: commit** — `feat(alerts): cron com carimbo no enfileiramento e retenção só de sent`

---

### Tarefa 5: escopo do ingress — os nove eventos pelos três portões locais

**Arquivos:** modificar `src/domain.ts` (âncora: `export const SUPPORTED_RELAY_EVENTS` e o `switch` de `normalizeGitHubEvent`); modificar `scripts/github-slack-hook-audit.mjs` (âncora: `export const HOOK_EVENTS`); testar `test/alerts/scope.test.ts`.

O portão 1 (assinatura do webhook da organização) é ação do operador (§12, item 5) — o teste cobre os portões 2 (allowlist) e 3 (normalizador), e o `HOOK_EVENTS` do script de auditoria acompanha para o portão 1 ser verificável.

- [ ] **Passo 1: teste dirigido por tabela — NOVE eventos, e a exclusão por repo+caminho:**

```ts
import { describe, expect, it } from "vitest";
import { SUPPORTED_RELAY_EVENTS, normalizeGitHubEvent, isExcludedWorkflowRun } from "../../src/domain";
import { HOOK_EVENTS } from "../../../scripts/github-slack-hook-audit.mjs";

const NOVE = [
  "dependabot_alert", "code_scanning_alert", "secret_scanning_alert",
  "security_advisory", "repository_advisory", "security_and_analysis",
  "secret_scanning_alert_location", "secret_scanning_scan", "workflow_run",
] as const;

describe("escopo — três portões locais (ADR-002 §3, §12)", () => {
  it("allowlist aceita exatamente os nove", () => {
    expect([...SUPPORTED_RELAY_EVENTS].sort()).toEqual([...NOVE].sort());
  });

  it("HOOK_EVENTS do auditor tem os mesmos nove", () => {
    expect([...HOOK_EVENTS].sort()).toEqual([...NOVE].sort());
  });

  it.each(NOVE)("normalizador produz linha para %s", (evento) => {
    const resultado = normalizeGitHubEvent(evento, fixturePara(evento));
    expect(resultado.kind).toBe("alert");
  });

  it("workflow_run só entra com conclusão de problema", () => {
    const ok = fixturePara("workflow_run");
    (ok as { workflow_run: { conclusion: string } }).workflow_run.conclusion = "success";
    expect(normalizeGitHubEvent("workflow_run", ok).kind).toBe("ignored");
  });

  it("exclusão exige repositório E caminho — caminho igual em OUTRO repo entra", () => {
    expect(isExcludedWorkflowRun("LCV-Ideas-Software/.github", ".github/workflows/alerts-watchdog.yml")).toBe(true);
    expect(isExcludedWorkflowRun("LCV-Ideas-Software/astrologo-app", ".github/workflows/alerts-watchdog.yml")).toBe(false);
  });
});
```

*(O executor cria `fixturePara(evento)` no próprio teste com o payload mínimo real de cada evento — os cinco novos vêm da [documentação de webhooks do GitHub](https://docs.github.com/en/webhooks/webhook-events-and-payloads); `security_advisory` **não tem** campo `repository`, e o normalizador precisa aceitar isso — foi um dos achados da revisão.)*

- [ ] **Passo 2: rodar e ver falhar; implementar** — encolher a allowlist para os nove; adicionar os cinco `case` novos no `switch` (título/severidade/URL por evento, payload mínimo); `isExcludedWorkflowRun(repoFullName, path)` com os dois caminhos excluídos do repo do relay; `HOOK_EVENTS` no script com os nove.
- [ ] **Passo 3: rodar e ver passar; rodar a suíte INTEIRA** — o encolhimento da allowlist derruba testes legados de eventos de atividade; cada um é atualizado para esperar recusa, com o motivo no diff (o app oficial cobre).
- [ ] **Passo 4: commit** — `feat(alerts): escopo de nove eventos nos três portões, exclusão por repo+caminho`

---

### Tarefa 6: fiação — ingress, fila, cron e /status

**Arquivos:** criar `src/alerts/status.ts`; modificar `src/index.ts` (âncoras: `export default` com `fetch`/`queue`/`scheduled`; `handleQueue`; o ponto do ingress onde o evento aceito é gravado e publicado); testar `test/alerts/status.test.ts` e ajustar `test/alerts/consumer.test.ts` se a fiação pedir.

- [ ] **Passo 1: teste do /status:**

```ts
// status.ts produz: statusBody(store) e verifyStatusSecret(request, secret)
// com comparação em tempo constante (crypto.subtle.timingSafeEqual não existe
// em Workers para strings — usar comparação de digests SHA-256).
it("sem segredo ou com segredo errado: 401 sem corpo de contagens", ...);
it("com segredo: { pending, sent, oldest_pending_age_ms }", ...);
```

- [ ] **Passo 2: fiação no `index.ts`,** cada ponto com seu teste:
  - **Ingress:** evento aceito no escopo → `alertStore.insert(guid, payloadNormalizado, agora)`; se `true`, `env.ALERT_QUEUE.send({ v: 2, delivery_id: guid })`. Se `false` (GUID repetido), 202 sem publicar — a redelivery do GitHub não vira segunda publicação.
  - **`handleQueue`:** mensagem com `v === 2` → `processAlertMessage`; caso contrário → caminho legado intacto.
  - **`scheduled`:** `runAlertCron` ANTES de `runScheduledRecovery` (legado permanece; filas legadas estão pausadas).
  - **`fetch`:** rota `GET /alerts/status` → `verifyStatusSecret` → `statusBody`.
  - **Segredos:** `readSecret(env.SLACK_BOT_TOKEN)` no consumidor real — **este binding só existirá após o item 8 do §12 (rotação)**; até lá o wire-up usa o binding condicional e o teste cobre a ausência (falha → linha fica pendente, nada lança).
- [ ] **Passo 3: suíte inteira + portão espelho da CI.**
- [ ] **Passo 4: commit** — `feat(alerts): fiação — ingress v2, roteamento por v:2, cron e /status`

---

### Tarefa 7: o vigia

**Arquivos:** criar `.github/workflows/alerts-watchdog.yml`.

Restrições que são consequência, não preferência: o job **não** tem `if:`, `environment:` nem `vars.*` — job pulado conclui sucesso e não gera e-mail (fato documentado, já citado no ADR §6-D).

- [ ] **Passo 1: o workflow** — agendado `*/15 * * * *`; um passo que faz `curl` do `/alerts/status` com `ALERTS_STATUS_SECRET` (segredo do repositório, já provisionado); **duas verificações consecutivas sem resposta contam como problema** (decisão 3): a primeira falha de transporte grava um marcador em cache de workflow e sai verde; a segunda consecutiva falha o job. Falha também quando `oldest_pending_age_ms > 3_600_000` (o `WATCHDOG_MAX_PENDING_AGE_MS` de T1 — manter os dois em sincronia é responsabilidade declarada deste passo).
- [ ] **Passo 2: exclusão do próprio caminho** — conferir que `isExcludedWorkflowRun` (T5) lista `.github/workflows/alerts-watchdog.yml` no repo do relay: fecha a instância A do §6.
- [ ] **Passo 3: commit** — `feat(alerts): vigia com uma condição de idade e dupla verificação de transporte`

---

### Tarefa 8: configuração gated, portões e revisão

**Pré-requisitos do §12 que são AÇÃO DO OPERADOR antes desta tarefa:** rotação do token para `chat:write` puro (item 8) — só então o binding `SLACK_BOT_TOKEN` re-entra no `wrangler.jsonc` (o bloco está comentado no próprio arquivo); assinatura dos nove eventos no webhook da organização (item 5, verificação pela tela).

- [ ] **Passo 1: varredura da fila de descarte — cinco arquivos**, com teste RED antes (a lista veio de varredura, não de memória): `wrangler.jsonc` (as duas ocorrências), `src/index.ts` (`processDeadLetterMessage` e o despacho), `test/queue.test.ts`, `README.md`, `docs/GITHUB_SLACK_INTEGRATION.md`. `max_retries` do consumidor de alertas vai ao **mínimo que a plataforma aceitar** — verificação empírica aqui (o mínimo não é documentado), começando por `0` e registrando a resposta do `wrangler deploy --dry-run`.
- [ ] **Passo 2: regenerar tipos com o wrangler PINADO e rodar `npm run types:check`** — nunca `@latest`.
- [ ] **Passo 3: portão completo (espelho da CI):** `npm run types:check && npx tsc --noEmit && npx tsc --noEmit --noUnusedLocals --noUnusedParameters && npx vitest run && npm run build`.
- [ ] **Passo 4: varredura do §6 do ADR sobre o código escrito** — as dez instâncias, veredito uma a uma, registrado.
- [ ] **Passo 5: cross-review da implementação até unanimidade** — esta sessão **herda os itens adiados do checklist** da sessão de desenho `a73420b1` (código do cron, SQL da retenção, integração postMessage, testes rodando) e os satisfaz com os artefatos reais desta implementação.
- [ ] **Passo 6: PR pronta para o operador** — com o registro no #192.

## Autoavaliação (skill, executada na escrita)

- **Cobertura da spec:** §2 fronteira → T6 ingress (insert-antes-de-2xx); §4 carimbo/curva/retenção/crash → T1/T2/T4 e o teste de reentrega em T3; §5 decisões 9/10/11/12 → T6/T4/T3; §8 → T3; §12 → T8 e os gates de operador. Instâncias do §6: A → T7 passo 2; B → T2 mutação; C′ → inexistente por desenho; G/D/F′ → limites declarados, sem tarefa.
- **Placeholders:** nenhum "TBD"; os dois pontos delegados ao executor (fixtures de payload e o corpo exato do YAML) têm fonte e critério declarados no próprio passo.
- **Consistência de tipos:** `AlertRow`/`stampDue`/`recuoMs`/`AlertQueueMessage` usados em T2–T6 com as mesmas assinaturas de onde nascem.
