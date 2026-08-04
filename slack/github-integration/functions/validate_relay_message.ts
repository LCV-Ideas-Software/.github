import { DefineFunction, Schema, SlackFunction } from "deno-slack-sdk/mod.ts";

export type RelayDestination = "activity" | "alerts";

export interface RelayMessageInputs {
  source: string;
  severity: string;
  repository: string;
  title: string;
  details: string;
  actor: string;
  branch: string;
  url: string;
  occurred_at: string;
  delivery_id: string;
  event: string;
  action: string;
  destination: string;
  relay_timestamp: string;
  relay_signature: string;
  expected_destination: RelayDestination;
}

const SIGNED_FIELD_NAMES = [
  "source",
  "severity",
  "repository",
  "title",
  "details",
  "actor",
  "branch",
  "url",
  "occurred_at",
  "delivery_id",
  "event",
  "action",
  "destination",
  "relay_timestamp",
] as const;

const MAX_AGE_SECONDS = 300;
const MAX_CLOCK_SKEW_SECONDS = 60;

export function canonicalRelayMessage(
  inputs: Pick<RelayMessageInputs, typeof SIGNED_FIELD_NAMES[number]>,
): string {
  return JSON.stringify(SIGNED_FIELD_NAMES.map((name) => inputs[name]));
}

function signatureBytes(signature: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[a-f0-9]{64}$/.test(signature)) return null;
  const bytes = new Uint8Array(new ArrayBuffer(32));
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(
      signature.slice(index * 2, index * 2 + 2),
      16,
    );
  }
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signRelayMessage(
  secret: string,
  inputs: Pick<RelayMessageInputs, typeof SIGNED_FIELD_NAMES[number]>,
): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await hmacKey(secret),
      new TextEncoder().encode(canonicalRelayMessage(inputs)),
    ),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export async function verifyRelayMessage(
  secret: string,
  inputs: RelayMessageInputs,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<boolean> {
  if (
    secret.length < 32 || inputs.destination !== inputs.expected_destination
  ) {
    return false;
  }

  if (!/^\d{10}$/.test(inputs.relay_timestamp)) return false;
  const timestamp = Number.parseInt(inputs.relay_timestamp, 10);
  if (
    timestamp < nowSeconds - MAX_AGE_SECONDS ||
    timestamp > nowSeconds + MAX_CLOCK_SKEW_SECONDS
  ) {
    return false;
  }

  const signature = signatureBytes(inputs.relay_signature);
  if (signature === null) return false;

  return await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    signature,
    new TextEncoder().encode(canonicalRelayMessage(inputs)),
  );
}

export async function verifyRelayMessageWithSecrets(
  secrets: readonly string[],
  inputs: RelayMessageInputs,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<boolean> {
  const results = await Promise.all(
    secrets.slice(0, 2).map((secret) =>
      verifyRelayMessage(secret, inputs, nowSeconds)
    ),
  );
  return results.some(Boolean);
}

function githubUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname.toLowerCase() !== "github.com" ||
      parsed.port !== "" ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export function formatRelayMessage(inputs: RelayMessageInputs): string | null {
  const url = githubUrl(inputs.url);
  if (url === null) return null;

  const heading = inputs.expected_destination === "alerts"
    ? `*[${inputs.severity.slice(0, 20)}] ${inputs.title.slice(0, 300)}*`
    : `*${inputs.title.slice(0, 300)}*`;

  return [
    heading,
    `Repository: ${inputs.repository.slice(0, 200)}`,
    `Source: ${inputs.source.slice(0, 50)} / ${inputs.event.slice(0, 64)}:${
      inputs.action.slice(0, 64)
    }`,
    `Branch: ${inputs.branch.slice(0, 255)}`,
    `Actor: ${inputs.actor.slice(0, 100)}`,
    inputs.details.slice(0, 1_500),
    `<${url}|Open in GitHub>`,
    `Delivery: \`${inputs.delivery_id.slice(0, 128)}\` · ${
      inputs.occurred_at.slice(0, 40)
    }`,
  ].join("\n");
}

const text = { type: Schema.types.string } as const;

export const ValidateRelayMessageDefinition = DefineFunction({
  callback_id: "validate_github_relay_message",
  title: "Validate GitHub relay message",
  description: "Authenticate and format a GitHub relay record before posting",
  source_file: "functions/validate_relay_message.ts",
  input_parameters: {
    properties: {
      source: text,
      severity: text,
      repository: text,
      title: text,
      details: text,
      actor: text,
      branch: text,
      url: text,
      occurred_at: text,
      delivery_id: text,
      event: text,
      action: text,
      destination: text,
      relay_timestamp: text,
      relay_signature: text,
      expected_destination: text,
    },
    required: [
      "source",
      "severity",
      "repository",
      "title",
      "details",
      "actor",
      "branch",
      "url",
      "occurred_at",
      "delivery_id",
      "event",
      "action",
      "destination",
      "relay_timestamp",
      "relay_signature",
      "expected_destination",
    ],
  },
  output_parameters: {
    properties: { message: text },
    required: ["message"],
  },
});

export default SlackFunction(
  ValidateRelayMessageDefinition,
  async ({ inputs, env }) => {
    const secrets = [
      env["SLACK_RELAY_SIGNING_SECRET"] ?? "",
      env["SLACK_RELAY_SIGNING_SECRET_NEXT"] ?? "",
    ];
    const typedInputs = inputs as RelayMessageInputs;
    if (!(await verifyRelayMessageWithSecrets(secrets, typedInputs))) {
      return { error: "GitHub relay authentication failed" };
    }

    const message = formatRelayMessage(typedInputs);
    if (message === null) {
      return { error: "GitHub relay URL validation failed" };
    }
    return { outputs: { message } };
  },
);
