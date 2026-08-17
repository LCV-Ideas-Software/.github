// Payload normalizado -> texto da mensagem. Puro, e a montagem é NO ENVIO
// (ADR-002 §4): corrigir isto e implantar conserta a próxima tentativa da
// mesma linha — é o caminho de reparo sem superfície de comando.
// Campo ausente = linha omitida; "undefined" nunca aparece no texto.
export function renderAlertText(payload: Record<string, unknown>): string {
  const s = (k: string): string | null =>
    typeof payload[k] === "string" && (payload[k] as string).length > 0
      ? (payload[k] as string)
      : null;

  const linhas: string[] = [];
  const sev = s("severity");
  const titulo = s("title") ?? "GitHub alert";
  linhas.push(sev ? `*[${sev}] ${titulo}*` : `*${titulo}*`);

  const campos: ReadonlyArray<readonly [string, string]> = [
    ["repository", "Repository"],
    ["source", "Source"],
    ["branch", "Branch"],
    ["actor", "Actor"],
  ];
  for (const [k, rotulo] of campos) {
    const v = s(k);
    if (v !== null) linhas.push(`${rotulo}: ${v}`);
  }

  // As chaves são as do CONTRATO (SlackWorkflowPayload: details/url) — a
  // versão anterior lia body/html_url, que o payload normalizado não tem, e
  // omitia corpo e link em silêncio (achado da revisão).
  const corpo = s("details");
  if (corpo !== null) linhas.push(corpo);

  const url = s("url");
  if (url !== null) linhas.push(`<${url}|Open in GitHub>`);

  const id = s("delivery_id");
  const quando = formatarBrasilia(s("occurred_at"));
  if (id !== null) {
    linhas.push(`Delivery: \`${id}\`${quando ? ` · ${quando}` : ""}`);
  }
  if (quando === null) {
    // Contrato de apresentação (docs/GITHUB_SLACK_INTEGRATION.md): o
    // fallback é explícito, nunca silêncio nem ISO cru.
    linhas.push("Data e hora do evento: não informadas");
  }
  return linhas.join("\n");
}

// dd/MM/aaaa às HH:mm:ss em UTC−03:00 (Brasília, sem horário de verão
// desde 2019). O Slack Workflow que formatava datas saiu do caminho; o
// renderizador é a fronteira de apresentação agora (achado da revisão).
function formatarBrasilia(iso: string | null): string | null {
  if (iso === null) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t - 3 * 3_600_000);
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}` +
    ` às ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}
