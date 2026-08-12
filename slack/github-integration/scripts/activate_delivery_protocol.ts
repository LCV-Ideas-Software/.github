const ACTIVATION_URL =
  "https://github-slack-alerts.lcv.workers.dev/slack/protocol/activate";
const MAX_ACTIVATION_ATTEMPTS = 2;
const MAX_RESPONSE_BYTES = 2_048;
const MINIMUM_SECRET_BYTES = 32;
const WORKER_REVISION_PATTERN = /^[0-9a-f]{40}$/;
const ACTIVATION_SEED_PATTERN = /^[1-9][0-9]{0,19}$/;
export const DELIVERY_PROTOCOL_SCHEMA_REVISION = "0004_confirm_slack_delivery";

type UnknownRecord = Record<string, unknown>;

interface ActivationConfiguration {
  activationSeed: string;
  expectedRevision: string;
  relaySigningSecret: string;
}

export interface ActivationResult {
  ok: true;
  activation_status: "applied" | "already_applied";
  activation_id: string;
  activated_revision: string;
  schema_revision: string;
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runtimeEnvironment(): Record<string, string | undefined> {
  return {
    ACTIVATION_SEED: Deno.env.get("ACTIVATION_SEED"),
    EXPECTED_REVISION: Deno.env.get("EXPECTED_REVISION"),
    SLACK_RELAY_SIGNING_SECRET: Deno.env.get("SLACK_RELAY_SIGNING_SECRET"),
  };
}

export function readActivationConfiguration(
  environment: Record<string, string | undefined>,
): Readonly<ActivationConfiguration> {
  const activationSeed = environment.ACTIVATION_SEED;
  const expectedRevision = environment.EXPECTED_REVISION;
  const relaySigningSecret = environment.SLACK_RELAY_SIGNING_SECRET;
  invariant(
    typeof activationSeed === "string" &&
      ACTIVATION_SEED_PATTERN.test(activationSeed),
    "ACTIVATION_SEED is missing or malformed.",
  );
  invariant(
    typeof expectedRevision === "string" &&
      WORKER_REVISION_PATTERN.test(expectedRevision),
    "EXPECTED_REVISION is missing or malformed.",
  );
  invariant(
    typeof relaySigningSecret === "string" &&
      new TextEncoder().encode(relaySigningSecret).byteLength >=
        MINIMUM_SECRET_BYTES,
    "SLACK_RELAY_SIGNING_SECRET is missing or malformed.",
  );
  return Object.freeze({
    activationSeed,
    expectedRevision,
    relaySigningSecret,
  });
}

async function hmac(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "HMAC" },
      key,
      new TextEncoder().encode(message),
    ),
  );
  return [...signature]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function canonicalActivationId(
  activationSeed: string,
  expectedRevision: string,
): string {
  return JSON.stringify([
    "slack_delivery_protocol_activation_id_v1",
    activationSeed,
    expectedRevision,
    DELIVERY_PROTOCOL_SCHEMA_REVISION,
  ]);
}

export function deriveActivationId(
  activationSeed: string,
  expectedRevision: string,
  secret: string,
): Promise<string> {
  return hmac(
    canonicalActivationId(activationSeed, expectedRevision),
    secret,
  );
}

export function canonicalProtocolActivation(
  activationId: string,
  expectedRevision: string,
  schemaRevision: string,
): string {
  return JSON.stringify([
    "slack_delivery_protocol_activation_v1",
    activationId,
    expectedRevision,
    schemaRevision,
  ]);
}

export function signProtocolActivation(
  activationId: string,
  expectedRevision: string,
  schemaRevision: string,
  secret: string,
): Promise<string> {
  return hmac(
    canonicalProtocolActivation(
      activationId,
      expectedRevision,
      schemaRevision,
    ),
    secret,
  );
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  invariant(
    /^application\/json(?:;|$)/i.test(contentType),
    "Protocol activation returned an invalid response.",
  );
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredLength = Number.parseInt(contentLength, 10);
    invariant(
      Number.isSafeInteger(declaredLength) &&
        declaredLength >= 0 &&
        declaredLength <= MAX_RESPONSE_BYTES,
      "Protocol activation returned an invalid response.",
    );
  }

  invariant(
    response.body !== null,
    "Protocol activation returned an invalid response.",
  );
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      invariant(
        total <= MAX_RESPONSE_BYTES,
        "Protocol activation returned an invalid response.",
      );
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(body),
    ) as unknown;
  } catch {
    throw new Error("Protocol activation returned an invalid response.");
  }
}

function validActivationResult(
  payload: unknown,
  activationId: string,
  expectedRevision: string,
): payload is ActivationResult {
  return isRecord(payload) &&
    Object.keys(payload).length === 5 &&
    payload.ok === true &&
    (payload.activation_status === "applied" ||
      payload.activation_status === "already_applied") &&
    payload.activation_id === activationId &&
    payload.activated_revision === expectedRevision &&
    payload.schema_revision === DELIVERY_PROTOCOL_SCHEMA_REVISION;
}

async function cancelResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The upstream body is intentionally neither read nor exposed.
  }
}

export async function activateDeliveryProtocol({
  environment = runtimeEnvironment(),
  fetchImpl = fetch,
}: {
  environment?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
} = {}): Promise<Readonly<ActivationResult>> {
  const configuration = readActivationConfiguration(environment);
  const activationId = await deriveActivationId(
    configuration.activationSeed,
    configuration.expectedRevision,
    configuration.relaySigningSecret,
  );
  const activationSignature = await signProtocolActivation(
    activationId,
    configuration.expectedRevision,
    DELIVERY_PROTOCOL_SCHEMA_REVISION,
    configuration.relaySigningSecret,
  );
  const requestBody = JSON.stringify({
    activation_id: activationId,
    expected_revision: configuration.expectedRevision,
    schema_revision: DELIVERY_PROTOCOL_SCHEMA_REVISION,
    activation_signature: activationSignature,
  });

  for (let attempt = 1; attempt <= MAX_ACTIVATION_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(ACTIVATION_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: requestBody,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      if (attempt < MAX_ACTIVATION_ATTEMPTS) continue;
      throw new Error("Protocol activation confirmation is unavailable.");
    }

    if (response.status >= 500) {
      await cancelResponse(response);
      if (attempt < MAX_ACTIVATION_ATTEMPTS) continue;
      throw new Error("Protocol activation confirmation is unavailable.");
    }
    if (response.status !== 200) {
      await cancelResponse(response);
      throw new Error("Protocol activation was rejected.");
    }

    try {
      const payload = await readBoundedJson(response);
      if (
        validActivationResult(
          payload,
          activationId,
          configuration.expectedRevision,
        )
      ) {
        return Object.freeze(payload);
      }
    } catch {
      // A 200 response can be lost or truncated after the CAS. Confirm once by
      // repeating the exact same signed tuple; never construct a new activation.
    }
    if (attempt === MAX_ACTIVATION_ATTEMPTS) {
      throw new Error("Protocol activation confirmation is unavailable.");
    }
  }

  throw new Error("Protocol activation confirmation is unavailable.");
}

if (import.meta.main) {
  try {
    const result = await activateDeliveryProtocol();
    console.log(
      `Confirmed ${result.activation_status} receipt-aware Slack delivery protocol at revision ${result.activated_revision}.`,
    );
  } catch {
    console.error("Receipt-aware Slack delivery protocol activation failed.");
    Deno.exit(1);
  }
}
