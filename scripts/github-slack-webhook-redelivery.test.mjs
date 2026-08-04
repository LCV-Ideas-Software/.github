import test from "node:test";
import assert from "node:assert/strict";

import {
  API_VERSION,
  CHECKPOINT_VARIABLE,
  GitHubApiError,
  fetchDeliveriesSince,
  parseNextCursor,
  readConfiguration,
  resolveCheckpoint,
  runRedelivery,
  selectFailedDeliveryIds,
  wasSuccessful,
} from "./github-slack-webhook-redelivery.mjs";

const baseEnvironment = Object.freeze({
  TOKEN: "test-token-never-log",
  ORGANIZATION_NAME: "example-org",
  ORGANIZATION_ID: "987654",
  HOOK_ID: "12345",
  WORKFLOW_REPO_OWNER: "example-org",
  WORKFLOW_REPO_NAME: ".github",
});

function responseJson(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function responseText(body, { status = 200, headers = {} } = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function rawDelivery({
  id,
  guid = `guid-${id}`,
  deliveredAt,
  status = "Internal Server Error",
  statusCode = 500,
}) {
  return {
    id,
    guid,
    delivered_at: deliveredAt,
    status,
    status_code: statusCode,
  };
}

function normalizedDelivery({
  id,
  guid = `guid-${id}`,
  deliveredAt,
  status = "Internal Server Error",
  statusCode = 500,
}) {
  return { id: String(id), guid, deliveredAt, status, statusCode };
}

test("configuration fails before API access when any required input is absent", () => {
  for (const name of Object.keys(baseEnvironment)) {
    const environment = { ...baseEnvironment };
    delete environment[name];
    assert.throws(
      () => readConfiguration(environment),
      new RegExp(`Required environment variable ${name} is missing`),
      name,
    );
  }
  assert.throws(
    () => readConfiguration({ ...baseEnvironment, HOOK_ID: "not-an-id" }),
    /HOOK_ID must be a positive integer/,
  );
  assert.throws(
    () =>
      readConfiguration({
        ...baseEnvironment,
        ORGANIZATION_ID: "not-an-id",
      }),
    /ORGANIZATION_ID must be a positive integer/,
  );
});

test("checkpoint defaults to 24 hours and clamps values beyond GitHub's three-day limit", () => {
  const startedAt = Date.parse("2026-08-03T12:00:00.000Z");
  assert.equal(
    resolveCheckpoint(undefined, startedAt),
    startedAt - 24 * 60 * 60 * 1000,
  );
  assert.equal(
    resolveCheckpoint("2026-08-03T10:00:00.000Z", startedAt),
    Date.parse("2026-08-03T10:00:00.000Z"),
  );

  const warnings = [];
  assert.equal(
    resolveCheckpoint("1", startedAt, {
      warn: (warning) => warnings.push(warning),
    }),
    startedAt - 3 * 24 * 60 * 60 * 1000,
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /three-day redelivery window/);
  assert.throws(
    () => resolveCheckpoint(String(startedAt + 1), startedAt),
    /cannot be in the future/,
  );
  assert.throws(
    () => resolveCheckpoint("invalid", startedAt),
    new RegExp(CHECKPOINT_VARIABLE),
  );
});

test("Link pagination extracts only a cursor from the expected GitHub endpoint", () => {
  const path = "/orgs/example-org/hooks/12345/deliveries";
  const canonicalPath = "/organizations/987654/hooks/12345/deliveries";
  const link = [
    `<https://api.github.com${path}?per_page=100&cursor=previous>; rel="prev"`,
    `<https://api.github.com${path}?per_page=100&cursor=next%2Fcursor>; rel="next"`,
  ].join(", ");
  assert.equal(parseNextCursor(link, path), "next/cursor");
  assert.equal(
    parseNextCursor(
      `<https://api.github.com${canonicalPath}?per_page=100&cursor=canonical%2Fcursor>; rel="next"`,
      path,
      canonicalPath,
    ),
    "canonical/cursor",
  );
  assert.equal(parseNextCursor(undefined, path), undefined);
  assert.throws(
    () =>
      parseNextCursor(
        `<https://attacker.example${path}?cursor=next>; rel="next"`,
        path,
      ),
    /outside the expected deliveries endpoint/,
  );
  assert.throws(
    () =>
      parseNextCursor(
        `<https://api.github.com${path}?per_page=100>; rel="next"`,
        path,
      ),
    /without a cursor/,
  );
  assert.throws(
    () =>
      parseNextCursor(
        `<https://api.github.com/organizations/987655/hooks/12345/deliveries?cursor=next>; rel="next"`,
        path,
        canonicalPath,
      ),
    /outside the expected deliveries endpoint/,
  );
  assert.throws(
    () =>
      parseNextCursor(
        `<https://api.github.com/organizations/987654/hooks/54321/deliveries?cursor=next>; rel="next"`,
        path,
        canonicalPath,
      ),
    /outside the expected deliveries endpoint/,
  );
});

test("delivery pagination follows Link cursors and handles a terminal empty page", async () => {
  const cutoff = Date.parse("2026-08-03T10:00:00.000Z");
  const canonicalPath = "/organizations/987654/hooks/12345/deliveries";
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(new URL(url));
    if (requests.length === 1) {
      return responseJson(
        [
          rawDelivery({
            id: 2,
            deliveredAt: "2026-08-03T11:00:00.000Z",
          }),
          rawDelivery({
            id: 1,
            deliveredAt: "2026-08-03T10:30:00.000Z",
          }),
        ],
        {
          headers: {
            link: `<https://api.github.com${canonicalPath}?per_page=100&cursor=cursor-2>; rel="next"`,
          },
        },
      );
    }
    return responseJson([]);
  };

  const deliveries = await fetchDeliveriesSince({
    token: baseEnvironment.TOKEN,
    organizationName: baseEnvironment.ORGANIZATION_NAME,
    organizationId: baseEnvironment.ORGANIZATION_ID,
    hookId: baseEnvironment.HOOK_ID,
    cutoff,
    fetchImpl,
  });
  assert.deepEqual(
    deliveries.map((delivery) => delivery.id),
    ["2", "1"],
  );
  assert.equal(requests.length, 2);
  assert.equal(requests[0].searchParams.get("per_page"), "100");
  assert.equal(requests[1].searchParams.get("cursor"), "cursor-2");
});

test("delivery collection does not assume API ordering and scans every cursor", async () => {
  const cutoff = Date.parse("2026-08-03T10:00:00.000Z");
  const path = "/orgs/example-org/hooks/12345/deliveries";
  let requests = 0;
  const deliveries = await fetchDeliveriesSince({
    token: baseEnvironment.TOKEN,
    organizationName: baseEnvironment.ORGANIZATION_NAME,
    organizationId: baseEnvironment.ORGANIZATION_ID,
    hookId: baseEnvironment.HOOK_ID,
    cutoff,
    fetchImpl: async () => {
      requests += 1;
      if (requests === 1) {
        return responseJson(
          [
            rawDelivery({
              id: 1,
              deliveredAt: "2026-08-03T10:30:00.000Z",
            }),
            rawDelivery({
              id: 3,
              deliveredAt: "2026-08-03T11:00:00.000Z",
            }),
          ],
          {
            headers: {
              link: `<https://api.github.com${path}?cursor=cursor-2>; rel="next"`,
            },
          },
        );
      }
      return responseJson([
        rawDelivery({
          id: 2,
          deliveredAt: "2026-08-03T10:45:00.000Z",
        }),
        rawDelivery({
          id: 4,
          deliveredAt: "2026-08-03T09:59:59.999Z",
        }),
      ]);
    },
  });

  assert.equal(requests, 2);
  assert.deepEqual(
    deliveries.map((delivery) => delivery.id),
    ["3", "2", "1"],
  );
});

test("cursor overlap is deduplicated and contradictory delivery metadata fails closed", async () => {
  const path = "/orgs/example-org/hooks/12345/deliveries";
  const shared = rawDelivery({
    id: 7,
    deliveredAt: "2026-08-03T11:00:00.000Z",
  });
  const overlappingFetch = ({ contradiction = false } = {}) => {
    let requests = 0;
    return async () => {
      requests += 1;
      if (requests === 1) {
        return responseJson([shared], {
          headers: {
            link: `<https://api.github.com${path}?cursor=overlap>; rel="next"`,
          },
        });
      }
      return responseJson([
        contradiction ? { ...shared, status: "OK", status_code: 200 } : shared,
      ]);
    };
  };

  const deliveries = await fetchDeliveriesSince({
    token: baseEnvironment.TOKEN,
    organizationName: baseEnvironment.ORGANIZATION_NAME,
    organizationId: baseEnvironment.ORGANIZATION_ID,
    hookId: baseEnvironment.HOOK_ID,
    cutoff: Date.parse("2026-08-03T10:00:00.000Z"),
    fetchImpl: overlappingFetch(),
  });
  assert.deepEqual(
    deliveries.map((delivery) => delivery.id),
    ["7"],
  );

  await assert.rejects(
    fetchDeliveriesSince({
      token: baseEnvironment.TOKEN,
      organizationName: baseEnvironment.ORGANIZATION_NAME,
      organizationId: baseEnvironment.ORGANIZATION_ID,
      hookId: baseEnvironment.HOOK_ID,
      cutoff: Date.parse("2026-08-03T10:00:00.000Z"),
      fetchImpl: overlappingFetch({ contradiction: true }),
    }),
    /contradictory metadata/,
  );
});

test("delivery IDs beyond JavaScript's safe integer range retain every decimal digit", async () => {
  const exactDeliveryId = "3835001740625715000";
  const deliveries = await fetchDeliveriesSince({
    token: baseEnvironment.TOKEN,
    organizationName: baseEnvironment.ORGANIZATION_NAME,
    organizationId: baseEnvironment.ORGANIZATION_ID,
    hookId: baseEnvironment.HOOK_ID,
    cutoff: Date.parse("2026-08-03T10:00:00.000Z"),
    fetchImpl: async () =>
      responseText(
        `[{"id":${exactDeliveryId},"guid":"large-id-guid","delivered_at":"2026-08-03T11:00:00.000Z","status":"Internal Server Error","status_code":500}]`,
      ),
  });

  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].id, exactDeliveryId);

  await assert.rejects(
    fetchDeliveriesSince({
      token: baseEnvironment.TOKEN,
      organizationName: baseEnvironment.ORGANIZATION_NAME,
      organizationId: baseEnvironment.ORGANIZATION_ID,
      hookId: baseEnvironment.HOOK_ID,
      cutoff: Date.parse("2026-08-03T10:00:00.000Z"),
      fetchImpl: async () =>
        responseJson([
          rawDelivery({
            id: exactDeliveryId,
            deliveredAt: "2026-08-03T11:00:00.000Z",
          }),
        ]),
    }),
    /invalid ID/,
  );
});

test("pagination filters the checkpoint without assuming later pages are older", async () => {
  const path = "/orgs/example-org/hooks/12345/deliveries";
  let requests = 0;
  const deliveries = await fetchDeliveriesSince({
    token: baseEnvironment.TOKEN,
    organizationName: baseEnvironment.ORGANIZATION_NAME,
    organizationId: baseEnvironment.ORGANIZATION_ID,
    hookId: baseEnvironment.HOOK_ID,
    cutoff: Date.parse("2026-08-03T10:00:00.000Z"),
    fetchImpl: async () => {
      requests += 1;
      if (requests === 2) {
        return responseJson([
          rawDelivery({
            id: 3,
            deliveredAt: "2026-08-03T10:30:00.000Z",
          }),
        ]);
      }
      return responseJson(
        [
          rawDelivery({
            id: 2,
            deliveredAt: "2026-08-03T11:00:00.000Z",
          }),
          rawDelivery({
            id: 1,
            deliveredAt: "2026-08-03T09:59:59.999Z",
          }),
        ],
        {
          headers: {
            link: `<https://api.github.com${path}?cursor=second-page>; rel="next"`,
          },
        },
      );
    },
  });
  assert.deepEqual(
    deliveries.map((delivery) => delivery.id),
    ["2", "3"],
  );
  assert.equal(requests, 2);
});

test("pagination fails closed on contradictory empty pages", async () => {
  const path = "/orgs/example-org/hooks/12345/deliveries";
  await assert.rejects(
    fetchDeliveriesSince({
      token: baseEnvironment.TOKEN,
      organizationName: baseEnvironment.ORGANIZATION_NAME,
      organizationId: baseEnvironment.ORGANIZATION_ID,
      hookId: baseEnvironment.HOOK_ID,
      cutoff: 1,
      fetchImpl: async () =>
        responseJson([], {
          headers: {
            link: `<https://api.github.com${path}?cursor=unexpected>; rel="next"`,
          },
        }),
    }),
    /empty deliveries page with a next cursor/,
  );
});

test("HTTP 200-399 suppresses failed attempts but textual OK cannot override 4xx/5xx", () => {
  const time = Date.parse("2026-08-03T10:00:00.000Z");
  assert.equal(
    wasSuccessful(
      normalizedDelivery({
        id: 1,
        deliveredAt: time,
        status: "OK",
        statusCode: 200,
      }),
    ),
    true,
  );
  assert.equal(
    wasSuccessful(
      normalizedDelivery({
        id: 2,
        deliveredAt: time,
        status: "Accepted",
        statusCode: 202,
      }),
    ),
    true,
  );
  assert.equal(
    wasSuccessful(
      normalizedDelivery({
        id: 3,
        deliveredAt: time,
        status: "Found",
        statusCode: 302,
      }),
    ),
    true,
  );
  assert.equal(
    wasSuccessful(
      normalizedDelivery({
        id: 4,
        deliveredAt: time,
        status: "OK",
        statusCode: 500,
      }),
    ),
    false,
  );
  assert.equal(
    wasSuccessful(
      normalizedDelivery({
        id: 5,
        deliveredAt: time,
        status: "Moved",
        statusCode: 399,
      }),
    ),
    true,
  );

  const ids = selectFailedDeliveryIds([
    normalizedDelivery({ id: 11, guid: "a", deliveredAt: time - 2_000 }),
    normalizedDelivery({ id: 12, guid: "a", deliveredAt: time - 1_000 }),
    normalizedDelivery({ id: 21, guid: "b", deliveredAt: time - 4_000 }),
    normalizedDelivery({
      id: 22,
      guid: "b",
      deliveredAt: time - 3_000,
      status: "Accepted",
      statusCode: 202,
    }),
    normalizedDelivery({ id: 31, guid: "c", deliveredAt: time - 5_000 }),
    normalizedDelivery({
      id: 32,
      guid: "c",
      deliveredAt: time - 4_000,
      status: "OK",
      statusCode: 500,
    }),
    normalizedDelivery({ id: 41, guid: "d", deliveredAt: time - 8_000 }),
    normalizedDelivery({ id: 51, guid: "e", deliveredAt: time - 7_000 }),
    normalizedDelivery({
      id: 52,
      guid: "e",
      deliveredAt: time - 6_000,
      status: "Found",
      statusCode: 302,
    }),
    normalizedDelivery({ id: 61, guid: "f", deliveredAt: time - 10_000 }),
    normalizedDelivery({
      id: 62,
      guid: "f",
      deliveredAt: time - 9_000,
      status: "Moved",
      statusCode: 399,
    }),
  ]);
  assert.deepEqual(ids, ["41", "32", "12"]);

  assert.deepEqual(
    selectFailedDeliveryIds([
      normalizedDelivery({ id: "99", guid: "same", deliveredAt: time }),
      normalizedDelivery({ id: "100", guid: "same", deliveredAt: time }),
    ]),
    ["100"],
  );
  assert.deepEqual(
    selectFailedDeliveryIds([
      normalizedDelivery({
        id: "9007199254740993",
        guid: "higher",
        deliveredAt: time,
      }),
      normalizedDelivery({
        id: "9007199254740992",
        guid: "lower",
        deliveredAt: time,
      }),
    ]),
    ["9007199254740992", "9007199254740993"],
  );
});

test("a complete run redelivers only unresolved GUIDs and persists the checkpoint last", async () => {
  const startedAt = Date.parse("2026-08-03T12:00:00.000Z");
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    assert.equal(init.headers.Authorization, `Bearer ${baseEnvironment.TOKEN}`);
    assert.equal(init.headers["X-GitHub-Api-Version"], API_VERSION);
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);

    if (
      init.method === "GET" &&
      url.pathname.endsWith(`/actions/variables/${CHECKPOINT_VARIABLE}`)
    ) {
      return responseJson({ message: "Not Found" }, { status: 404 });
    }
    if (init.method === "GET" && url.pathname.endsWith("/deliveries")) {
      return responseJson([
        rawDelivery({
          id: 101,
          guid: "failed-guid",
          deliveredAt: "2026-08-03T11:30:00.000Z",
        }),
        rawDelivery({
          id: 201,
          guid: "eventually-successful-guid",
          deliveredAt: "2026-08-03T11:20:00.000Z",
          status: "OK",
          statusCode: 200,
        }),
        rawDelivery({
          id: 200,
          guid: "eventually-successful-guid",
          deliveredAt: "2026-08-03T11:10:00.000Z",
        }),
      ]);
    }
    if (init.method === "POST" && url.pathname.endsWith("/attempts")) {
      assert.match(url.pathname, /\/deliveries\/101\/attempts$/);
      return new Response(null, { status: 202 });
    }
    if (init.method === "POST" && url.pathname.endsWith("/actions/variables")) {
      assert.deepEqual(JSON.parse(init.body), {
        name: CHECKPOINT_VARIABLE,
        value: String(startedAt),
      });
      return responseJson({ name: CHECKPOINT_VARIABLE }, { status: 201 });
    }
    throw new Error(`Unexpected request: ${init.method} ${url.pathname}`);
  };
  const messages = [];

  const result = await runRedelivery({
    environment: baseEnvironment,
    fetchImpl,
    now: () => startedAt,
    logger: {
      info: (message) => messages.push(message),
      warn: (message) => messages.push(message),
    },
  });

  assert.deepEqual(result, {
    examined: 3,
    redeliveries: 1,
    checkpoint: String(startedAt),
  });
  assert.equal(calls.at(-1).url.pathname.endsWith("/actions/variables"), true);
  assert.equal(messages.length, 1);
  assert.doesNotMatch(messages[0], /test-token|failed-guid/);
});

test("a complete run preserves a large delivery ID in the redelivery endpoint", async () => {
  const startedAt = Date.parse("2026-08-03T12:00:00.000Z");
  const exactDeliveryId = "3835001740625715000";
  let exactAttemptObserved = false;

  const result = await runRedelivery({
    environment: baseEnvironment,
    now: () => startedAt,
    logger: { info() {}, warn() {} },
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      if (
        init.method === "GET" &&
        url.pathname.endsWith(`/actions/variables/${CHECKPOINT_VARIABLE}`)
      ) {
        return responseJson({ message: "Not Found" }, { status: 404 });
      }
      if (init.method === "GET" && url.pathname.endsWith("/deliveries")) {
        return responseText(
          `[{"id":${exactDeliveryId},"guid":"large-failed-guid","delivered_at":"2026-08-03T11:30:00.000Z","status":"Internal Server Error","status_code":500}]`,
        );
      }
      if (init.method === "POST" && url.pathname.endsWith("/attempts")) {
        assert.equal(
          url.pathname,
          `/orgs/example-org/hooks/12345/deliveries/${exactDeliveryId}/attempts`,
        );
        exactAttemptObserved = true;
        return new Response(null, { status: 202 });
      }
      if (
        init.method === "POST" &&
        url.pathname.endsWith("/actions/variables")
      ) {
        return responseJson({ name: CHECKPOINT_VARIABLE }, { status: 201 });
      }
      throw new Error(`Unexpected request: ${init.method} ${url.pathname}`);
    },
  });

  assert.equal(exactAttemptObserved, true);
  assert.equal(result.redeliveries, 1);
});

test("a failed redelivery never advances the repository checkpoint", async () => {
  const startedAt = Date.parse("2026-08-03T12:00:00.000Z");
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (init.method === "GET" && url.pathname.includes("/actions/variables/")) {
      return responseJson({ value: String(startedAt - 60_000) });
    }
    if (init.method === "GET" && url.pathname.endsWith("/deliveries")) {
      return responseJson([
        rawDelivery({
          id: 101,
          deliveredAt: "2026-08-03T11:59:30.000Z",
        }),
      ]);
    }
    if (init.method === "POST" && url.pathname.endsWith("/attempts")) {
      return responseJson(
        { message: "server unavailable" },
        { status: 503, headers: { "x-github-request-id": "request-1" } },
      );
    }
    throw new Error(`Checkpoint was mutated after a failure: ${url.pathname}`);
  };

  await assert.rejects(
    runRedelivery({
      environment: baseEnvironment,
      fetchImpl,
      now: () => startedAt,
      logger: { info() {}, warn() {} },
    }),
    (error) =>
      error instanceof GitHubApiError &&
      error.status === 503 &&
      /request-id=request-1/.test(error.message),
  );
  assert.equal(
    calls.some(
      ({ init, url }) =>
        init.method === "PATCH" && url.pathname.includes("/actions/variables/"),
    ),
    false,
  );
});

test("rate-limit errors are explicit and never include the token", async () => {
  const reset = String(Math.floor(Date.now() / 1000) + 60);
  await assert.rejects(
    runRedelivery({
      environment: baseEnvironment,
      fetchImpl: async () =>
        responseJson(
          { message: "rate limited" },
          {
            status: 403,
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": reset,
            },
          },
        ),
      now: () => Date.now(),
      logger: { info() {}, warn() {} },
    }),
    (error) =>
      error instanceof GitHubApiError &&
      error.rateLimited &&
      /rate limit reached/.test(error.message) &&
      !error.message.includes(baseEnvironment.TOKEN),
  );
});

test("organization-hook 404 classifies missing scope without listing token scopes", async () => {
  await assert.rejects(
    fetchDeliveriesSince({
      token: baseEnvironment.TOKEN,
      organizationName: baseEnvironment.ORGANIZATION_NAME,
      organizationId: baseEnvironment.ORGANIZATION_ID,
      hookId: baseEnvironment.HOOK_ID,
      cutoff: Date.now() - 60_000,
      fetchImpl: async () =>
        responseJson(
          { message: "Not Found" },
          {
            status: 404,
            headers: {
              "x-oauth-scopes": "repo, workflow",
              "x-github-request-id": "request-scope",
            },
          },
        ),
    }),
    (error) =>
      error instanceof GitHubApiError &&
      /admin:org_hook-scope=missing/.test(error.message) &&
      /request-id=request-scope/.test(error.message) &&
      !/repo, workflow/.test(error.message) &&
      !error.message.includes(baseEnvironment.TOKEN),
  );
});

test("API requests carry a timeout and report aborts without leaking credentials", async () => {
  await assert.rejects(
    runRedelivery({
      environment: baseEnvironment,
      fetchImpl: async (_url, init) => {
        assert.ok(init.signal instanceof AbortSignal);
        throw new DOMException("request timed out", "TimeoutError");
      },
      now: () => Date.now(),
      logger: { info() {}, warn() {} },
    }),
    (error) =>
      /timed out after 30000ms/.test(error.message) &&
      !error.message.includes(baseEnvironment.TOKEN),
  );
});
