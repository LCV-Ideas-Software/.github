import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const API_BASE = "https://api.cloudflare.com/client/v4";
const CURRENT_NAME = "github-slack-relay-signing-secret";
const NEXT_NAME = "github-slack-relay-signing-secret-next";
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_PAGES = 100;

function required(environment, name, pattern) {
  const value = environment[name];
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`Required environment variable ${name} is malformed.`);
  }
  return value;
}

async function boundedJson(response) {
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Cloudflare Secrets Store request failed.");
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (
    !/^application\/json(?:;|$)/iu.test(contentType) ||
    response.body === null
  ) {
    throw new Error("Cloudflare Secrets Store returned invalid metadata.");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Cloudflare Secrets Store returned invalid metadata.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new Error("Cloudflare Secrets Store returned invalid metadata.");
  }
}

function validSecretMetadata(secret, storeId) {
  return (
    secret !== null &&
    typeof secret === "object" &&
    !Array.isArray(secret) &&
    typeof secret.id === "string" &&
    secret.id.length <= 32 &&
    typeof secret.name === "string" &&
    secret.store_id === storeId &&
    (secret.status === "pending" ||
      secret.status === "active" ||
      secret.status === "deleted") &&
    (secret.scopes === undefined ||
      (Array.isArray(secret.scopes) &&
        secret.scopes.every((scope) => typeof scope === "string"))) &&
    (secret.comment === undefined ||
      secret.comment === null ||
      typeof secret.comment === "string")
  );
}

function validRelaySecretMetadata(secret, storeId) {
  return (
    validSecretMetadata(secret, storeId) &&
    /^[0-9a-f]{32}$/u.test(secret.id) &&
    Array.isArray(secret.scopes) &&
    secret.scopes.length === 1 &&
    secret.scopes[0] === "workers" &&
    (secret.comment === undefined || typeof secret.comment === "string")
  );
}

async function inventory({ accountId, apiToken, fetchImpl, storeId }) {
  const secrets = [];
  let expectedTotalCount = null;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = new URL(
      `${API_BASE}/accounts/${accountId}/secrets_store/stores/${storeId}/secrets`,
    );
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", "100");
    let payload;
    try {
      payload = await boundedJson(
        await fetchImpl(url, {
          headers: { Authorization: `Bearer ${apiToken}` },
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        }),
      );
    } catch {
      throw new Error("Cloudflare Secrets Store inventory is unavailable.");
    }
    const info = payload?.result_info;
    if (
      payload?.success !== true ||
      !Array.isArray(payload.result) ||
      info === null ||
      typeof info !== "object" ||
      info.page !== page ||
      info.per_page !== 100 ||
      !Number.isSafeInteger(info.count) ||
      info.count !== payload.result.length ||
      !Number.isSafeInteger(info.total_count) ||
      info.total_count < 0 ||
      info.total_count > MAX_PAGES * 100
    ) {
      throw new Error("Cloudflare Secrets Store returned invalid metadata.");
    }
    expectedTotalCount ??= info.total_count;
    const expectedTotalPages = Math.max(
      1,
      Math.ceil(expectedTotalCount / info.per_page),
    );
    if (
      info.total_count !== expectedTotalCount ||
      (page < expectedTotalPages && payload.result.length !== info.per_page) ||
      (page === expectedTotalPages &&
        payload.result.length !==
          expectedTotalCount - info.per_page * (page - 1)) ||
      payload.result.some((secret) => !validSecretMetadata(secret, storeId))
    ) {
      throw new Error(
        "Cloudflare Secrets Store returned inconsistent metadata.",
      );
    }
    secrets.push(...payload.result);
    if (page === expectedTotalPages) break;
  }
  if (secrets.length !== expectedTotalCount) {
    throw new Error("Cloudflare Secrets Store inventory is incomplete.");
  }
  const names = new Set();
  for (const secret of secrets) {
    if (names.has(secret.name)) {
      throw new Error("Cloudflare Secrets Store inventory is ambiguous.");
    }
    names.add(secret.name);
  }
  return secrets;
}

function assertCurrent(secrets, expectedId, storeId) {
  const current = secrets.find(({ name }) => name === CURRENT_NAME);
  if (
    !validRelaySecretMetadata(current, storeId) ||
    current.id !== expectedId ||
    current.status !== "active"
  ) {
    throw new Error("Cloudflare current relay secret metadata is invalid.");
  }
}

function findNext(secrets, fingerprint, storeId) {
  const next = secrets.find(({ name }) => name === NEXT_NAME);
  if (next === undefined) return null;
  if (!validRelaySecretMetadata(next, storeId)) {
    throw new Error("Cloudflare staged relay secret metadata conflicts.");
  }
  if (next.comment !== `sha256:${fingerprint}`) {
    throw new Error("Cloudflare staged relay secret metadata conflicts.");
  }
  if (next.status !== "pending" && next.status !== "active") {
    throw new Error("Cloudflare staged relay secret metadata conflicts.");
  }
  return next;
}

export async function provisionCloudflareNextSecret({
  environment = process.env,
  fetchImpl = fetch,
  sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const accountId = required(
    environment,
    "CLOUDFLARE_ACCOUNT_ID",
    /^[0-9a-f]{32}$/u,
  );
  const apiToken = required(environment, "CLOUDFLARE_API_TOKEN", /^\S{20,}$/u);
  const storeId = required(
    environment,
    "SLACK_RELAY_SECRET_STORE_ID",
    /^[0-9a-f]{32}$/u,
  );
  const currentId = required(
    environment,
    "SLACK_RELAY_CURRENT_SECRET_ID",
    /^[0-9a-f]{32}$/u,
  );
  const secret = required(
    environment,
    "SLACK_RELAY_SIGNING_SECRET",
    /^.{32,}$/su,
  );
  const fingerprint = createHash("sha256").update(secret, "utf8").digest("hex");
  const before = await inventory({ accountId, apiToken, fetchImpl, storeId });
  assertCurrent(before, currentId, storeId);
  const existingNext = findNext(before, fingerprint, storeId);

  const collectionUrl = `${API_BASE}/accounts/${accountId}/secrets_store/stores/${storeId}/secrets`;
  if (existingNext === null) {
    try {
      const payload = await boundedJson(
        await fetchImpl(collectionUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify([
            {
              name: NEXT_NAME,
              value: secret,
              scopes: ["workers"],
              comment: `sha256:${fingerprint}`,
            },
          ]),
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        }),
      );
      if (payload?.success !== true || !Array.isArray(payload.result)) {
        throw new Error("invalid_create_response");
      }
    } catch {
      // A committed create can lose its response. Inventory discovers its ID;
      // the mandatory PATCH below still rewrites the exact value.
    }
  }

  let next = existingNext;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const observed = await inventory({
      accountId,
      apiToken,
      fetchImpl,
      storeId,
    });
    assertCurrent(observed, currentId, storeId);
    next = findNext(observed, fingerprint, storeId);
    if (next !== null) break;
    if (attempt < 3) await sleep(1_000);
  }
  if (next === null) {
    throw new Error("Cloudflare staged relay secret could not be found.");
  }

  let patchConfirmed = false;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const payload = await boundedJson(
        await fetchImpl(`${collectionUrl}/${next.id}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            value: secret,
            scopes: ["workers"],
            comment: `sha256:${fingerprint}`,
          }),
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        }),
      );
      if (
        payload?.success !== true ||
        !validRelaySecretMetadata(payload.result, storeId) ||
        payload.result.id !== next.id ||
        payload.result.name !== NEXT_NAME ||
        (payload.result.status !== "pending" &&
          payload.result.status !== "active") ||
        payload.result.comment !== `sha256:${fingerprint}`
      ) {
        throw new Error("invalid_patch_response");
      }
      patchConfirmed = true;
      break;
    } catch {
      // PATCH is an idempotent replacement. Repeat only the identical body.
    }
  }
  if (!patchConfirmed) {
    throw new Error("Cloudflare staged relay secret rewrite is unconfirmed.");
  }
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const after = await inventory({ accountId, apiToken, fetchImpl, storeId });
    assertCurrent(after, currentId, storeId);
    const confirmed = findNext(after, fingerprint, storeId);
    if (confirmed?.id !== next.id) {
      throw new Error("Cloudflare staged relay secret metadata changed.");
    }
    if (confirmed.status === "active") {
      return Object.freeze({
        status: existingNext === null ? "staged" : "restaged",
        secretName: NEXT_NAME,
      });
    }
    if (attempt < 5) await sleep(1_000);
  }
  throw new Error("Cloudflare staged relay secret did not become active.");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  provisionCloudflareNextSecret()
    .then(({ status }) =>
      console.log(`Cloudflare relay NEXT metadata verified: ${status}.`),
    )
    .catch(() => {
      console.error("Cloudflare relay NEXT provisioning failed.");
      process.exitCode = 1;
    });
}
