import {
  asRecord,
  nestedRecord,
  nestedString,
  normalizeGitHubEvent,
  SUPPORTED_RELAY_EVENTS,
  TARGET_ORGANIZATION,
} from "./domain";
import { readSecret, verifyGitHubSignature } from "./security";
import { type AlertQueueMessage, recuoMs } from "./alerts/contract";
import { processAlertMessage } from "./alerts/consumer";
import { runAlertCron } from "./alerts/cron";
import { statusBody, verifyStatusSecret } from "./alerts/status";
import { AlertStore } from "./alerts/store";

const WEBHOOK_PATH = "/github/webhook";
const ALERTS_STATUS_PATH = "/alerts/status";
const HEALTH_PATH = "/healthz";
const ALERT_QUEUE_NAME = "github-slack-alerts";
const MAX_BODY_BYTES = 25_000_000;
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/u;
const EVENT_NAME_PATTERN = /^[a-z0-9_]{1,64}$/u;
const MINIMUM_SECRET_BYTES = 32;
const WORKER_REVISION_PATTERN = /^[0-9a-f]{40}$/u;

export interface RuntimeOverrides {
  alertStore?: AlertStore;
  now?: () => number;
  fetch?: typeof fetch;
}

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function runtime(
  env: Env,
  overrides?: RuntimeOverrides,
): Required<RuntimeOverrides> {
  return {
    alertStore: overrides?.alertStore ?? new AlertStore(env.DB),
    now: overrides?.now ?? Date.now,
    fetch: overrides?.fetch ?? ((input, init) => globalThis.fetch(input, init)),
  };
}

function validDeliveryId(value: unknown): value is string {
  return typeof value === "string" && DELIVERY_ID_PATTERN.test(value);
}

function repositoryFromPayload(payload: Record<string, unknown>): {
  fullName: string;
  archived: boolean;
  owner: string;
} | null {
  const repository = nestedRecord(payload, "repository");
  if (repository === undefined) {
    return null;
  }

  const fullName = nestedString(repository, "full_name");
  const owner = nestedString(repository, "owner", "login");
  return {
    fullName,
    owner,
    archived: repository.archived === true,
  };
}

function sameOrganization(login: string): boolean {
  return login.toLowerCase() === TARGET_ORGANIZATION.toLowerCase();
}

function contentLengthTooLarge(request: Request): boolean {
  const header = request.headers.get("content-length");
  if (header === null) {
    return false;
  }

  const length = Number.parseInt(header, 10);
  return Number.isFinite(length) && length > MAX_BODY_BYTES;
}

function hasSafeSecretLength(value: string): boolean {
  return new TextEncoder().encode(value).byteLength >= MINIMUM_SECRET_BYTES;
}

async function readBodyWithLimit(
  request: Request,
  maximumBytes = MAX_BODY_BYTES,
): Promise<{ kind: "ok"; body: ArrayBuffer } | { kind: "too_large" }> {
  if (request.body === null) {
    return { kind: "ok", body: new ArrayBuffer(0) };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }

      total += result.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("payload_too_large");
        return { kind: "too_large" };
      }

      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { kind: "ok", body: combined.buffer };
}

export async function handleFetch(
  request: Request,
  env: Env,
  overrides?: RuntimeOverrides,
): Promise<Response> {
  const url = new URL(request.url);
  const dependencies = runtime(env, overrides);

  // ADR-002 §4: os dois números do vigia, atrás do segredo compartilhado
  // (decisão 9). 401 idêntico para segredo ausente, errado ou binding
  // indisponível — a rota não explica a si mesma para quem não a conhece.
  if (url.pathname === ALERTS_STATUS_PATH && request.method === "GET") {
    let expected: string;
    try {
      expected = await readSecret(env.ALERTS_STATUS_SECRET);
    } catch {
      return jsonResponse({ error: "unauthorized" }, 401);
    }
    if (!hasSafeSecretLength(expected)) {
      // Piso de 32 bytes na classe "segredo que NÓS provisionamos" — a
      // mesma guarda que o webhook tem na rota (achado da revisão: um
      // valor truncado na provisão virava autenticação de um caractere).
      // 401 idêntico, e o vigia alarma em dois tiques até a rotação.
      return jsonResponse({ error: "unauthorized" }, 401);
    }
    if (!(await verifyStatusSecret(request, expected))) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }
    try {
      const body = await statusBody(dependencies.alertStore, dependencies.now());
      return jsonResponse(body, 200);
    } catch {
      // O vigia trata "não consegui responder" como sinal (decisão 3);
      // um 503 explícito é melhor que um corpo inventado.
      return jsonResponse({ error: "status_unavailable" }, 503);
    }
  }

  if (url.pathname === HEALTH_PATH && request.method === "GET") {
    const deployedRevision = env.WORKER_VERSION?.tag;
    if (
      typeof deployedRevision !== "string" ||
      !WORKER_REVISION_PATTERN.test(deployedRevision)
    ) {
      return jsonResponse({ status: "unavailable" }, 503);
    }
    try {
      // A CLASSE da prontidão é "tudo de que uma rota do Worker precisa
      // para servir": o segredo do webhook (com o piso de 32 bytes), o
      // token do bot (formato pertence ao Slack — só legibilidade e
      // não-vazio), o segredo do /status (NOSSO dos dois lados: vale o
      // piso) e a tabela de alertas respondendo à sonda de trabalho
      // CONSTANTE (o /healthz é público; um agregado aqui viraria
      // amplificação de carga no D1 — o retrato completo fica no
      // /alerts/status, atrás do segredo). readSecret lança para binding
      // ausente ou vazio; string vazia de fixture cai no checque de
      // comprimento.
      const [githubSecret, botToken, statusSecret] = await Promise.all([
        readSecret(env.GITHUB_WEBHOOK_SECRET),
        readSecret(env.SLACK_BOT_TOKEN),
        readSecret(env.ALERTS_STATUS_SECRET),
        dependencies.alertStore.schemaProbe(),
      ]);
      const ready =
        hasSafeSecretLength(githubSecret) &&
        botToken.length > 0 &&
        hasSafeSecretLength(statusSecret);
      return jsonResponse(
        ready ? { status: "ready" } : { status: "unavailable" },
        ready ? 200 : 503,
      );
    } catch {
      return jsonResponse({ status: "unavailable" }, 503);
    }
  }

  if (url.pathname !== WEBHOOK_PATH) {
    return jsonResponse({ error: "not_found" }, 404);
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  if (contentLengthTooLarge(request)) {
    return jsonResponse({ error: "payload_too_large" }, 413);
  }

  const event = request.headers.get("x-github-event") ?? "";
  const deliveryId = request.headers.get("x-github-delivery") ?? "";
  const signature = request.headers.get("x-hub-signature-256") ?? "";

  if (
    !EVENT_NAME_PATTERN.test(event) ||
    !validDeliveryId(deliveryId) ||
    signature === ""
  ) {
    return jsonResponse({ error: "invalid_github_headers" }, 400);
  }

  let bodyResult: Awaited<ReturnType<typeof readBodyWithLimit>>;
  try {
    bodyResult = await readBodyWithLimit(request);
  } catch {
    return jsonResponse({ error: "invalid_request_body" }, 400);
  }

  if (bodyResult.kind === "too_large") {
    return jsonResponse({ error: "payload_too_large" }, 413);
  }
  const body = bodyResult.body;

  let webhookSecret: string;
  try {
    webhookSecret = await readSecret(env.GITHUB_WEBHOOK_SECRET);
  } catch {
    return jsonResponse({ error: "webhook_verification_unavailable" }, 503);
  }
  if (!hasSafeSecretLength(webhookSecret)) {
    return jsonResponse({ error: "webhook_verification_unavailable" }, 503);
  }

  let signatureIsValid: boolean;
  try {
    signatureIsValid = await verifyGitHubSignature(
      body,
      signature,
      webhookSecret,
    );
  } catch {
    return jsonResponse({ error: "webhook_verification_unavailable" }, 503);
  }

  if (!signatureIsValid) {
    return jsonResponse({ error: "invalid_signature" }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    const decoded = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(body);
    const parsed = JSON.parse(decoded) as unknown;
    const record = asRecord(parsed);
    if (record === undefined) {
      return jsonResponse({ error: "invalid_json_payload" }, 400);
    }
    payload = record;
  } catch {
    return jsonResponse({ error: "invalid_json_payload" }, 400);
  }

  const organization = nestedString(payload, "organization", "login");
  if (!sameOrganization(organization)) {
    return jsonResponse({ error: "organization_not_allowed" }, 403);
  }

  if (event === "ping") {
    return jsonResponse({ accepted: true, event: "ping" }, 200);
  }

  if (!SUPPORTED_RELAY_EVENTS.has(event)) {
    return jsonResponse(
      { accepted: false, ignored: true, reason: "event_not_supported" },
      202,
    );
  }

  const repository = repositoryFromPayload(payload);
  if (
    repository === null ||
    repository.fullName === "" ||
    !sameOrganization(repository.owner)
  ) {
    return jsonResponse({ error: "repository_not_allowed" }, 403);
  }

  if (repository.archived) {
    return jsonResponse(
      { accepted: false, ignored: true, reason: "repository_archived" },
      202,
    );
  }

  const normalized = normalizeGitHubEvent(
    event,
    payload,
    deliveryId,
    repository.fullName,
  );
  if (normalized.kind === "ignored") {
    return jsonResponse(
      { accepted: false, ignored: true, reason: normalized.reason },
      202,
    );
  }

  // ADR-002 §2: a promessa ancora AQUI — aceito = linha gravada + sucesso
  // respondido. O INSERT falhando, o erro volta ao GitHub e a entrega fica
  // registrada no painel de webhooks (sem reenvio automático; reenvio
  // manual por 3 dias).
  const now = dependencies.now();
  let inserted: boolean;
  try {
    inserted = await dependencies.alertStore.insert(
      deliveryId,
      JSON.stringify(normalized.payload),
      now,
    );
  } catch {
    return jsonResponse({ error: "persistence_unavailable" }, 503);
  }

  if (!inserted) {
    // Redelivery do GitHub: a linha guardada É a trava de deduplicação
    // (decisão 10). Publicar aqui violaria "publica só quando INSERE".
    return jsonResponse({ accepted: true, duplicate: true }, 202);
  }

  // PUBLICA SÓ QUEM CARIMBA — inclusive o ingress, e o send é GATEADO no
  // resultado do carimbo (achados da revisão, em duas rodadas): sem o
  // carimbo, a primeira tentativa falhada era reagendada em segundos,
  // furando o recuo(1); e sem o GATE, um passe do cron carimbando entre o
  // INSERT e o carimbo do ingress produzia DUAS publicações da primeira
  // tentativa — o changes=0 do CAS é exatamente o sinal de que outro
  // agendador já publicou esta tentativa.
  // O carimbo que LANÇA equivale a carimbo perdido (terceiro achado da
  // revisão): a fronteira de aceitação é o INSERT — depois dele a resposta
  // é 202 SEMPRE, senão o GitHub registra falha de uma entrega que já tem
  // linha durável. Sem carimbo, a linha continua com next_due_ms = 0:
  // devida no próximo passe do cron.
  let stamped = false;
  try {
    // A linha que o ingress acabou de INSERIR tem attempts = 0 — a versão
    // observada do pino do CAS (achado da rodada 15). Um passe do cron que
    // carimbe antes muda a versão, e o pino falha como o prazo falharia.
    stamped = await dependencies.alertStore.stampDue(
      deliveryId,
      now,
      now + recuoMs(1),
      0,
    );
  } catch {
    // stamped continua false: publica só quem carimba.
  }

  let queued = false;
  if (stamped) {
    try {
      await env.ALERT_QUEUE.send({ v: 2, delivery_id: deliveryId });
      queued = true;
    } catch {
      // A fila é otimização de latência; o cron é a vivacidade (ADR-002
      // §4). O alerta está ACEITO — responder erro faria o GitHub
      // registrar falha de uma entrega que já é nossa. Mas o corpo diz a
      // verdade (queued:true durante a queda da fila mentia ao
      // diagnóstico).
    }
  }
  // stamped=false: um passe concorrente do cron venceu o CAS e a
  // publicação desta tentativa é dele — publicar aqui seria a segunda.

  return jsonResponse(
    queued
      ? { accepted: true, queued: true }
      : { accepted: true, queued: false, recovery: "cron" },
    202,
  );
}

// A fila única do caminho de alertas (ADR-002 §4). O consumidor sempre
// retorna — ack implícito; a plataforma nunca retenta (max_retries: 0) e o
// cron é o único agendador. A mensagem é {v:2, delivery_id}; qualquer outra
// forma morre na guarda de shape do consumidor, e a linha no D1 continua
// sendo a fonte de verdade.
export async function handleQueue(
  batch: MessageBatch<AlertQueueMessage>,
  env: Env,
  overrides?: RuntimeOverrides,
): Promise<void> {
  if (batch.queue !== ALERT_QUEUE_NAME) {
    throw new Error("unexpected_queue");
  }
  for (const message of batch.messages) {
    await processAlertV2Message(message.body, env, overrides);
  }
}

// O consumidor do ADR-002 §8. Retorno normal = ack implícito; nada aqui
// lança, então a fila nunca agenda nada — o cron é o único agendador.
async function processAlertV2Message(
  raw: unknown,
  env: Env,
  overrides?: RuntimeOverrides,
): Promise<void> {
  const dependencies = runtime(env, overrides);
  let botToken: string;
  try {
    botToken = await readSecret(env.SLACK_BOT_TOKEN);
  } catch {
    // Sem token não há envio; a linha fica pendente e o cron recarimba.
    try {
      const body = asRecord(raw);
      if (typeof body?.delivery_id === "string") {
        await dependencies.alertStore.recordFailure(
          body.delivery_id,
          "bot_token_unavailable",
        );
      }
    } catch {
      // Direção do erro: atraso, nunca perda.
    }
    return;
  }
  await processAlertMessage(raw, {
    store: dependencies.alertStore,
    botToken,
    fetch: dependencies.fetch,
    now: dependencies.now,
  });
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await handleFetch(request, env);
    } catch {
      console.error(
        JSON.stringify({ event: "webhook_handler_unexpected_failure" }),
      );
      return jsonResponse({ error: "internal_error" }, 500);
    }
  },

  async queue(batch, env): Promise<void> {
    await handleQueue(batch, env);
  },

  async scheduled(_controller, env): Promise<void> {
    await runScheduledEntry(env);
  },
} satisfies ExportedHandler<Env, AlertQueueMessage>;

// ADR-002 §4: o cron dos alertas é o ÚNICO agendador — carimbo, publicação
// e retenção. O erro do passe NÃO é engolido (achado da revisão): engoli-lo
// faria toda falha do passe parecer invocação bem-sucedida — em particular,
// uma falha persistente só da retenção (deleteSentOlderThan) seria
// invisível ao vigia, que lê idade de PENDENTE, e as linhas `sent`
// cresceriam sem limite sem sinal algum. Com o pipeline legado aposentado,
// o passe é o cron de alertas puro: uma exceção sobe direto e a invocação
// falha observavelmente na plataforma. A direção do erro continua a mesma:
// atraso de um período de cron, nunca perda.
export async function runScheduledEntry(
  env: Env,
  overrides?: RuntimeOverrides,
): Promise<void> {
  const dependencies = runtime(env, overrides);
  await runAlertCron({
    store: dependencies.alertStore,
    queue: {
      send: async (m): Promise<void> => {
        await env.ALERT_QUEUE.send(m);
      },
    },
    now: dependencies.now,
  });
}
