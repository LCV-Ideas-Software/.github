import { pathToFileURL } from "node:url";

const API_BASE = "https://slack.com/api";
const CURRENT_NAME = "SLACK_RELAY_SIGNING_SECRET";
const NEXT_NAME = "SLACK_RELAY_SIGNING_SECRET_NEXT";
const MAX_RESPONSE_BYTES = 64_000;

function required(environment, name, pattern) {
  const value = environment[name];
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`Required environment variable ${name} is malformed.`);
  }
  return value;
}

async function slackJson(fetchImpl, method, token, body) {
  let response;
  try {
    response = await fetchImpl(`${API_BASE}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Slack hosted-variable request is unavailable.");
  }
  if (response.status !== 200 || response.body === null) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Slack hosted-variable request failed.");
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/json(?:;|$)/iu.test(contentType)) {
    throw new Error("Slack hosted-variable response is invalid.");
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
        throw new Error("Slack hosted-variable response is invalid.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const payload = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(joined),
    );
    if (payload?.ok !== true) throw new Error("not_ok");
    return payload;
  } catch {
    throw new Error("Slack hosted-variable response is invalid.");
  }
}

async function listVariables(fetchImpl, token, appId) {
  const payload = await slackJson(
    fetchImpl,
    "apps.hosted.variables.list",
    token,
    { app_id: appId },
  );
  if (
    !Array.isArray(payload.variable_names) ||
    payload.variable_names.some((name) => typeof name !== "string") ||
    new Set(payload.variable_names).size !== payload.variable_names.length
  ) {
    throw new Error("Slack hosted-variable inventory is invalid.");
  }
  return payload.variable_names;
}

export async function provisionSlackNextSecret({
  environment = process.env,
  fetchImpl = fetch,
} = {}) {
  const appId = required(environment, "SLACK_APP_ID", /^A[A-Z0-9]{8,}$/u);
  const token = required(environment, "SLACK_SERVICE_TOKEN", /^\S{20,}$/u);
  const secret = required(
    environment,
    "SLACK_RELAY_SIGNING_SECRET",
    /^.{32,}$/su,
  );
  const before = await listVariables(fetchImpl, token, appId);
  if (!before.includes(CURRENT_NAME)) {
    throw new Error("Slack current relay secret is missing.");
  }

  let applied = false;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await slackJson(fetchImpl, "apps.hosted.variables.add", token, {
        app_id: appId,
        variables: [{ name: NEXT_NAME, value: secret }],
      });
      applied = true;
      break;
    } catch {
      // apps.hosted.variables.add is a set operation. A byte-identical retry
      // after response loss cannot create a second variable or a second value.
    }
  }
  if (!applied) {
    throw new Error("Slack staged relay secret could not be written.");
  }
  const after = await listVariables(fetchImpl, token, appId);
  if (!after.includes(CURRENT_NAME) || !after.includes(NEXT_NAME)) {
    throw new Error("Slack staged relay secret could not be verified.");
  }
  return Object.freeze({ status: "staged", variableName: NEXT_NAME });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  provisionSlackNextSecret()
    .then(({ status }) =>
      console.log(`Slack relay NEXT metadata verified: ${status}.`),
    )
    .catch(() => {
      console.error("Slack relay NEXT provisioning failed.");
      process.exitCode = 1;
    });
}
