import { createHmac, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";

const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const ACTIVATION_ID_PATTERN = /^[0-9a-f]{64}$/u;
const MINIMUM_SECRET_BYTES = 32;
const MAX_INPUT_BYTES = 1_000_000;
const SCHEMA_REVISION = "0004_confirm_slack_delivery";
const EXPECTED_ROW_KEYS = [
  "slack_delivery_protocol_active",
  "slack_delivery_protocol_activated_at",
  "slack_delivery_protocol_activation_id",
  "slack_delivery_protocol_confirmation_open",
  "slack_delivery_protocol_revision",
  "slack_delivery_protocol_schema_revision",
].sort();

function fail(reason) {
  throw new Error(`Slack delivery protocol preflight ${reason}.`);
}

function plainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function validateSlackDeliveryProtocolPreflight(
  source,
  expectedRevision,
  relaySigningSecret,
) {
  if (
    typeof expectedRevision !== "string" ||
    !REVISION_PATTERN.test(expectedRevision)
  ) {
    fail("received a malformed expected revision");
  }
  if (
    typeof relaySigningSecret !== "string" ||
    relaySigningSecret.trim() === "" ||
    Buffer.byteLength(relaySigningSecret, "utf8") < MINIMUM_SECRET_BYTES
  ) {
    fail("received a missing or malformed relay signing secret");
  }
  if (
    typeof source !== "string" ||
    source === "" ||
    Buffer.byteLength(source, "utf8") > MAX_INPUT_BYTES
  ) {
    fail("received missing or oversized D1 output");
  }

  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    fail("received malformed D1 JSON");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 1 ||
    !plainObject(parsed[0]) ||
    parsed[0].success !== true ||
    !Array.isArray(parsed[0].results) ||
    parsed[0].results.length !== 1 ||
    !plainObject(parsed[0].results[0])
  ) {
    fail("received an incomplete D1 result");
  }

  const row = parsed[0].results[0];
  const keys = Object.keys(row).sort();
  if (JSON.stringify(keys) !== JSON.stringify(EXPECTED_ROW_KEYS)) {
    fail("received an unexpected D1 row shape");
  }
  const active = row.slack_delivery_protocol_active;
  const revision = row.slack_delivery_protocol_revision;
  const activatedAt = row.slack_delivery_protocol_activated_at;
  const activationId = row.slack_delivery_protocol_activation_id;
  const schemaRevision = row.slack_delivery_protocol_schema_revision;
  const confirmationOpen = row.slack_delivery_protocol_confirmation_open;

  if (
    active === 0 &&
    revision === null &&
    activatedAt === null &&
    activationId === null &&
    schemaRevision === null &&
    confirmationOpen === 1
  ) {
    return Object.freeze({ state: "inactive_initial" });
  }
  if (active === 1 && confirmationOpen === 0) {
    fail("confirmation is closed; a reviewed contract is required");
  }
  if (
    active !== 1 ||
    confirmationOpen !== 1 ||
    typeof revision !== "string" ||
    !REVISION_PATTERN.test(revision) ||
    !Number.isSafeInteger(activatedAt) ||
    activatedAt <= 0 ||
    typeof activationId !== "string" ||
    !ACTIVATION_ID_PATTERN.test(activationId) ||
    schemaRevision !== SCHEMA_REVISION
  ) {
    fail("found an inconsistent activation tuple");
  }
  if (revision !== expectedRevision) {
    fail("is activated for another revision; refusing Worker replacement");
  }
  const expectedActivationId = createHmac("sha256", relaySigningSecret)
    .update(
      JSON.stringify([
        "slack_delivery_protocol_activation_id_v1",
        expectedRevision,
        SCHEMA_REVISION,
      ]),
      "utf8",
    )
    .digest("hex");
  if (
    !timingSafeEqual(
      Buffer.from(activationId, "hex"),
      Buffer.from(expectedActivationId, "hex"),
    )
  ) {
    fail(
      "found an activation ID that does not match the exact revision and signer",
    );
  }
  return Object.freeze({ state: "active_exact_tuple" });
}

async function readBoundedStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_INPUT_BYTES) {
      fail("received oversized D1 output");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const invokedPath = process.argv[1];
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  try {
    const result = validateSlackDeliveryProtocolPreflight(
      await readBoundedStdin(),
      process.env.EXPECTED_REVISION,
      process.env.SLACK_RELAY_SIGNING_SECRET,
    );
    console.log(`Slack delivery protocol preflight: ${result.state}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed closed";
    console.error(`::error::${message}`);
    process.exitCode = 1;
  }
}
