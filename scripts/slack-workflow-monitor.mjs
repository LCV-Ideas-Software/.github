import { pathToFileURL } from "node:url";

const ACTIVITY_API_URL = "https://slack.com/api/apps.activities.list";
const LOOKBACK_MS = 20 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRY_AFTER_SECONDS = 30;
const SAFE_ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;

function requiredEnvironmentValue(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Required environment variable ${name} is missing.`);
  }
  return value.trim();
}

export function readSlackMonitorConfiguration(environment = process.env) {
  return Object.freeze({
    appId: requiredEnvironmentValue(environment, "SLACK_APP_ID"),
    serviceToken: requiredEnvironmentValue(environment, "SLACK_SERVICE_TOKEN"),
    teamId: requiredEnvironmentValue(environment, "SLACK_TEAM_ID"),
  });
}

function httpFailure(response) {
  const context = [];
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter && /^\d+$/.test(retryAfter)) {
    context.push(`retry-after=${retryAfter}s`);
  }
  const suffix = context.length > 0 ? ` (${context.join(", ")})` : "";
  return new Error(
    `Slack activity API returned HTTP ${response.status}${suffix}.`,
  );
}

function slackApiFailure(responseBody) {
  const code = responseBody?.error;
  if (typeof code === "string" && SAFE_ERROR_CODE.test(code)) {
    return new Error(`Slack activity API returned ${code}.`);
  }
  return new Error(
    "Slack activity API failed with an unrecognized error code; response withheld.",
  );
}

export async function monitorSlackWorkflow({
  environment = process.env,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  sleepImpl = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const configuration = readSlackMonitorConfiguration(environment);
  const currentTime = now();
  if (!Number.isSafeInteger(currentTime) || currentTime <= LOOKBACK_MS) {
    throw new Error("The monitor clock returned an invalid timestamp.");
  }
  const minDateCreated = (currentTime - LOOKBACK_MS) * 1000;
  if (!Number.isSafeInteger(minDateCreated)) {
    throw new Error("The Slack activity timestamp is outside the safe range.");
  }

  const body = new URLSearchParams({
    app_id: configuration.appId,
    team_id: configuration.teamId,
    min_log_level: "error",
    min_date_created: String(minDateCreated),
    limit: "100",
  });

  if (typeof sleepImpl !== "function") {
    throw new Error("A sleep implementation is required.");
  }

  let response;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await fetchImpl(ACTIVITY_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${configuration.serviceToken}`,
          "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        throw new Error(
          `Slack activity API timed out after ${REQUEST_TIMEOUT_MS}ms.`,
          { cause: error },
        );
      }
      throw new Error("Slack activity API could not be reached.", {
        cause: error,
      });
    }

    if (response.status !== 429 || attempt === 1) break;
    const retryAfter = response.headers.get("retry-after");
    if (
      !retryAfter ||
      !/^\d+$/.test(retryAfter) ||
      Number(retryAfter) < 1 ||
      Number(retryAfter) > MAX_RETRY_AFTER_SECONDS
    ) {
      throw httpFailure(response);
    }
    await sleepImpl(Number(retryAfter) * 1_000);
  }

  if (!response) throw new Error("Slack activity API returned no response.");
  if (!response.ok) {
    throw httpFailure(response);
  }

  let responseBody;
  try {
    responseBody = JSON.parse(await response.text());
  } catch (error) {
    throw new Error("Slack activity API returned invalid JSON.", {
      cause: error,
    });
  }

  if (responseBody?.ok !== true) {
    throw slackApiFailure(responseBody);
  }
  if (!Array.isArray(responseBody.activities)) {
    throw new Error(
      "Slack activity API returned a malformed activities collection.",
    );
  }

  const errorCount = responseBody.activities.length;
  if (errorCount > 0) {
    const noun = errorCount === 1 ? "error" : "errors";
    throw new Error(
      `Slack recorded ${errorCount} workflow ${noun} during the last 20 minutes; activity payloads withheld.`,
    );
  }

  return Object.freeze({ errors: 0 });
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (invokedPath === import.meta.url) {
  monitorSlackWorkflow()
    .then(() => {
      console.info(
        "No Slack workflow errors were recorded during the last 20 minutes.",
      );
    })
    .catch((error) => {
      // Messages are constructed exclusively from sanitized metadata. Slack
      // activities can contain private inputs and are never logged here.
      console.error(error instanceof Error ? error.message : "Monitor failed.");
      process.exitCode = 1;
    });
}
