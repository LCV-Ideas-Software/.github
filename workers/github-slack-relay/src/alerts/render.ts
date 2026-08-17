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
  if (id !== null) {
    const quando = s("occurred_at");
    linhas.push(`Delivery: \`${id}\`${quando ? ` · ${quando}` : ""}`);
  }
  return linhas.join("\n");
}
