import test from "node:test";
import assert from "node:assert/strict";

import {
  API_VERSION,
  GitHubApiError,
  HOOK_EVENTS,
  HOOK_VARIABLE,
  WEBHOOK_URL,
  parseNextHookPage,
  readConfiguration,
  runHookManagement,
} from "./github-slack-hook-management.mjs";

const TEST_TOKEN = "test-token-never-log";
const TEST_SECRET = "test-webhook-secret-never-log";
const BASE_ENVIRONMENT = Object.freeze({
  OPERATION: "provision",
  TOKEN: TEST_TOKEN,
  WEBHOOK_SECRET: TEST_SECRET,
  GITHUB_REF: "refs/heads/main",
  ORGANIZATION_NAME: "example-org",
  WORKFLOW_REPO_OWNER: "example-org",
  WORKFLOW_REPO_NAME: ".github",
});

function environmentFor(operation, overrides = {}) {
  return {
    ...BASE_ENVIRONMENT,
    OPERATION: operation,
    ...(operation === "provision" ? {} : { HOOK_ID: "12345" }),
    ...overrides,
  };
}

function responseJson(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function hook({
  id = 12345,
  active = false,
  url = WEBHOOK_URL,
  events = [...HOOK_EVENTS],
  name = "web",
  contentType = "json",
  insecureSsl = "0",
} = {}) {
  return {
    id,
    active,
    name,
    events,
    config: {
      url,
      content_type: contentType,
      insecure_ssl: insecureSsl,
    },
  };
}

function silentLogger(messages = []) {
  return {
    info: (message) => messages.push(message),
    warn: (message) => messages.push(message),
  };
}

function requestSnapshot(input, init) {
  const url = new URL(input);
  assert.equal(init.headers.Authorization, `Bearer ${TEST_TOKEN}`);
  assert.equal(init.headers["X-GitHub-Api-Version"], API_VERSION);
  assert.equal(init.headers.Accept, "application/vnd.github+json");
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(init.signal.aborted, false);
  return {
    method: init.method,
    pathname: url.pathname,
    search: url.search,
    body: init.body === undefined ? undefined : JSON.parse(init.body),
  };
}

test("the managed webhook contract is exact and complete", () => {
  assert.equal(API_VERSION, "2026-03-10");
  assert.equal(HOOK_VARIABLE, "SLACK_RELAY_ORG_HOOK_ID");
  assert.equal(
    WEBHOOK_URL,
    "https://github-slack-alerts.lcv.workers.dev/github/webhook",
  );
  assert.equal(HOOK_EVENTS.length, 14);
  assert.deepEqual(HOOK_EVENTS, [
    "workflow_run",
    "deployment_status",
    "dependabot_alert",
    "code_scanning_alert",
    "secret_scanning_alert",
    "push",
    "pull_request",
    "pull_request_review",
    "pull_request_review_comment",
    "issues",
    "issue_comment",
    "release",
    "discussion",
    "discussion_comment",
  ]);
  assert.equal(Object.isFrozen(HOOK_EVENTS), true);
});

test("configuration fails closed before API access", () => {
  for (const name of Object.keys(BASE_ENVIRONMENT)) {
    const environment = { ...BASE_ENVIRONMENT };
    delete environment[name];
    assert.throws(
      () => readConfiguration(environment),
      new RegExp(`Required environment variable ${name} is missing`),
      name,
    );
  }

  assert.throws(
    () => readConfiguration(environmentFor("invalid")),
    /OPERATION must be one of/,
  );
  assert.throws(
    () =>
      readConfiguration(
        environmentFor("provision", { GITHUB_REF: "refs/heads/topic" }),
      ),
    /restricted to main/,
  );
  assert.throws(
    () =>
      readConfiguration(
        environmentFor("provision", { WORKFLOW_REPO_OWNER: "other-org" }),
      ),
    /must match WORKFLOW_REPO_OWNER/,
  );
  assert.throws(
    () => readConfiguration(environmentFor("activate", { HOOK_ID: "0" })),
    /HOOK_ID must be a positive integer/,
  );
  assert.throws(
    () => readConfiguration(environmentFor("deactivate", { HOOK_ID: "1e3" })),
    /HOOK_ID must be a positive integer/,
  );
  assert.throws(
    () =>
      readConfiguration(
        environmentFor("activate", { WEBHOOK_SECRET: ` ${TEST_SECRET}` }),
      ),
    /contains surrounding whitespace/,
  );

  const pingEnvironment = environmentFor("ping");
  delete pingEnvironment.WEBHOOK_SECRET;
  assert.equal(readConfiguration(pingEnvironment).operation, "ping");
});

test("hook pagination accepts only the expected GitHub endpoint", () => {
  const pathname = "/orgs/example-org/hooks";
  const link = [
    `<https://api.github.com${pathname}?per_page=100&page=1>; rel="prev"`,
    `<https://api.github.com${pathname}?per_page=100&page=2>; rel="next"`,
  ].join(", ");
  assert.equal(parseNextHookPage(undefined, pathname), undefined);
  assert.equal(
    parseNextHookPage(link, pathname).href,
    `https://api.github.com${pathname}?per_page=100&page=2`,
  );
  assert.throws(
    () =>
      parseNextHookPage(
        `<https://attacker.example${pathname}?per_page=100&page=2>; rel="next"`,
        pathname,
      ),
    /outside the expected organization hooks endpoint/,
  );
  assert.throws(
    () =>
      parseNextHookPage(
        `<https://api.github.com${pathname}?per_page=99&page=2>; rel="next"`,
        pathname,
      ),
    /invalid page size/,
  );
  assert.throws(
    () =>
      parseNextHookPage(
        `<https://api.github.com${pathname}?per_page=100&page=1>; rel="next"`,
        pathname,
      ),
    /invalid page number/,
  );
});

test("provision creates one inactive hook, verifies it, and creates the repository variable last", async () => {
  const requests = [];
  const messages = [];
  const createdHook = hook();
  let variableValue;
  const fetchImpl = async (input, init) => {
    const request = requestSnapshot(input, init);
    requests.push(request);

    if (
      request.method === "GET" &&
      request.pathname === "/orgs/example-org/hooks"
    ) {
      assert.equal(request.search, "?per_page=100&page=1");
      return responseJson([]);
    }
    if (
      request.method === "POST" &&
      request.pathname === "/orgs/example-org/hooks"
    ) {
      assert.deepEqual(request.body, {
        name: "web",
        config: {
          url: WEBHOOK_URL,
          content_type: "json",
          secret: TEST_SECRET,
          insecure_ssl: "0",
        },
        events: HOOK_EVENTS,
        active: false,
      });
      return responseJson(createdHook, { status: 201 });
    }
    if (
      request.method === "GET" &&
      request.pathname === "/orgs/example-org/hooks/12345"
    ) {
      return responseJson(createdHook);
    }
    if (
      request.method === "GET" &&
      request.pathname ===
        `/repos/example-org/.github/actions/variables/${HOOK_VARIABLE}`
    ) {
      return variableValue === undefined
        ? responseJson({ message: "Not Found" }, { status: 404 })
        : responseJson({ name: HOOK_VARIABLE, value: variableValue });
    }
    if (
      request.method === "POST" &&
      request.pathname === "/repos/example-org/.github/actions/variables"
    ) {
      assert.deepEqual(request.body, {
        name: HOOK_VARIABLE,
        value: "12345",
      });
      variableValue = request.body.value;
      return responseJson({ name: HOOK_VARIABLE }, { status: 201 });
    }
    throw new Error(
      `Unexpected request: ${request.method} ${request.pathname}`,
    );
  };

  const result = await runHookManagement({
    environment: environmentFor("provision"),
    fetchImpl,
    logger: silentLogger(messages),
  });

  assert.deepEqual(result, {
    operation: "provision",
    hookId: "12345",
    created: true,
  });
  assert.equal(
    requests.at(-1).pathname.endsWith(`/actions/variables/${HOOK_VARIABLE}`),
    true,
  );
  assert.equal(messages.length, 1);
  assert.doesNotMatch(messages[0], new RegExp(`${TEST_TOKEN}|${TEST_SECRET}`));
});

test("provision paginates, reuses one exact PAT-visible hook, and updates the variable", async () => {
  const requests = [];
  const exactHook = hook({ active: true });
  let variableValue = "old";
  const fetchImpl = async (input, init) => {
    const request = requestSnapshot(input, init);
    requests.push(request);

    if (
      request.method === "GET" &&
      request.pathname === "/orgs/example-org/hooks"
    ) {
      if (request.search === "?per_page=100&page=1") {
        return responseJson([], {
          headers: {
            link: '<https://api.github.com/orgs/example-org/hooks?per_page=100&page=2>; rel="next"',
          },
        });
      }
      return responseJson([exactHook]);
    }
    if (
      request.method === "GET" &&
      request.pathname === "/orgs/example-org/hooks/12345"
    ) {
      return responseJson(exactHook);
    }
    if (
      request.method === "GET" &&
      request.pathname.endsWith(`/actions/variables/${HOOK_VARIABLE}`)
    ) {
      return responseJson({ name: HOOK_VARIABLE, value: variableValue });
    }
    if (
      request.method === "PATCH" &&
      request.pathname.endsWith(`/actions/variables/${HOOK_VARIABLE}`)
    ) {
      assert.deepEqual(request.body, {
        name: HOOK_VARIABLE,
        value: "12345",
      });
      variableValue = request.body.value;
      return new Response(null, { status: 204 });
    }
    throw new Error(
      `Unexpected request: ${request.method} ${request.pathname}`,
    );
  };

  const result = await runHookManagement({
    environment: environmentFor("provision"),
    fetchImpl,
    logger: silentLogger(),
  });
  assert.deepEqual(result, {
    operation: "provision",
    hookId: "12345",
    created: false,
  });
  assert.equal(
    requests.some(
      ({ method, pathname }) =>
        method === "POST" && pathname === "/orgs/example-org/hooks",
    ),
    false,
  );
  assert.equal(requests[1].search, "?per_page=100&page=2");
});

test("provision rejects drift and duplicates without mutating remote state", async () => {
  for (const visibleHooks of [
    [hook({ events: HOOK_EVENTS.slice(1) })],
    [hook(), hook({ id: 12346 })],
  ]) {
    const requests = [];
    await assert.rejects(
      runHookManagement({
        environment: environmentFor("provision"),
        fetchImpl: async (input, init) => {
          const request = requestSnapshot(input, init);
          requests.push(request);
          return responseJson(visibleHooks);
        },
        logger: silentLogger(),
      }),
      /configuration drift or is duplicated/,
    );
    assert.deepEqual(
      requests.map(({ method }) => method),
      ["GET"],
    );
  }
});

test("provision deletes only a newly created hook when variable synchronization fails", async () => {
  const requests = [];
  const createdHook = hook();
  await assert.rejects(
    runHookManagement({
      environment: environmentFor("provision"),
      fetchImpl: async (input, init) => {
        const request = requestSnapshot(input, init);
        requests.push(request);
        if (
          request.method === "GET" &&
          request.pathname === "/orgs/example-org/hooks"
        ) {
          return responseJson([]);
        }
        if (
          request.method === "POST" &&
          request.pathname === "/orgs/example-org/hooks"
        ) {
          return responseJson(createdHook, { status: 201 });
        }
        if (
          request.method === "GET" &&
          request.pathname === "/orgs/example-org/hooks/12345"
        ) {
          return responseJson(createdHook);
        }
        if (
          request.method === "GET" &&
          request.pathname.includes("/actions/variables/")
        ) {
          return responseJson({ message: "unavailable" }, { status: 503 });
        }
        if (
          request.method === "DELETE" &&
          request.pathname === "/orgs/example-org/hooks/12345"
        ) {
          return new Response(null, { status: 204 });
        }
        throw new Error(
          `Unexpected request: ${request.method} ${request.pathname}`,
        );
      },
      logger: silentLogger(),
    }),
    (error) =>
      error instanceof GitHubApiError &&
      error.status === 503 &&
      !error.message.includes(TEST_SECRET) &&
      !error.message.includes(TEST_TOKEN),
  );
  assert.equal(requests.at(-1).method, "DELETE");

  const reusedRequests = [];
  await assert.rejects(
    runHookManagement({
      environment: environmentFor("provision"),
      fetchImpl: async (input, init) => {
        const request = requestSnapshot(input, init);
        reusedRequests.push(request);
        if (request.pathname === "/orgs/example-org/hooks")
          return responseJson([createdHook]);
        if (request.pathname === "/orgs/example-org/hooks/12345")
          return responseJson(createdHook);
        return responseJson({ message: "unavailable" }, { status: 503 });
      },
      logger: silentLogger(),
    }),
    /HTTP 503/,
  );
  assert.equal(
    reusedRequests.some(({ method }) => method === "DELETE"),
    false,
  );
});

test("provision reconciles an ambiguous variable mutation before deciding rollback", async () => {
  const requests = [];
  const createdHook = hook();
  let variableReads = 0;
  const result = await runHookManagement({
    environment: environmentFor("provision"),
    fetchImpl: async (input, init) => {
      const request = requestSnapshot(input, init);
      requests.push(request);
      if (
        request.method === "GET" &&
        request.pathname === "/orgs/example-org/hooks"
      ) {
        return responseJson([]);
      }
      if (
        request.method === "POST" &&
        request.pathname === "/orgs/example-org/hooks"
      ) {
        return responseJson(createdHook, { status: 201 });
      }
      if (
        request.method === "GET" &&
        request.pathname === "/orgs/example-org/hooks/12345"
      ) {
        return responseJson(createdHook);
      }
      if (
        request.method === "GET" &&
        request.pathname.includes("/actions/variables/")
      ) {
        variableReads += 1;
        return variableReads === 1
          ? responseJson({ message: "Not Found" }, { status: 404 })
          : responseJson({ name: HOOK_VARIABLE, value: "12345" });
      }
      if (
        request.method === "POST" &&
        request.pathname.endsWith("/actions/variables")
      ) {
        throw new DOMException("response lost after apply", "TimeoutError");
      }
      throw new Error(
        `Unexpected request: ${request.method} ${request.pathname}`,
      );
    },
    logger: silentLogger(),
  });

  assert.deepEqual(result, {
    operation: "provision",
    hookId: "12345",
    created: true,
  });
  assert.equal(
    requests.some(({ method }) => method === "DELETE"),
    false,
  );
});

test("provision preserves an inactive new hook when variable mutation outcome cannot be reconciled", async () => {
  const requests = [];
  const createdHook = hook();
  let variableReads = 0;
  await assert.rejects(
    runHookManagement({
      environment: environmentFor("provision"),
      fetchImpl: async (input, init) => {
        const request = requestSnapshot(input, init);
        requests.push(request);
        if (
          request.method === "GET" &&
          request.pathname === "/orgs/example-org/hooks"
        ) {
          return responseJson([]);
        }
        if (
          request.method === "POST" &&
          request.pathname === "/orgs/example-org/hooks"
        ) {
          return responseJson(createdHook, { status: 201 });
        }
        if (
          request.method === "GET" &&
          request.pathname === "/orgs/example-org/hooks/12345"
        ) {
          return responseJson(createdHook);
        }
        if (
          request.method === "GET" &&
          request.pathname.includes("/actions/variables/")
        ) {
          variableReads += 1;
          return variableReads === 1
            ? responseJson({ message: "Not Found" }, { status: 404 })
            : responseJson({ message: "unavailable" }, { status: 503 });
        }
        if (
          request.method === "POST" &&
          request.pathname.endsWith("/actions/variables")
        ) {
          throw new DOMException("response lost after apply", "TimeoutError");
        }
        throw new Error(
          `Unexpected request: ${request.method} ${request.pathname}`,
        );
      },
      logger: silentLogger(),
    }),
    (error) =>
      error instanceof AggregateError &&
      error.rollbackSafe === false &&
      /outcome .* is uncertain/.test(error.message) &&
      !error.message.includes(TEST_TOKEN) &&
      !error.message.includes(TEST_SECRET),
  );
  assert.equal(
    requests.some(({ method }) => method === "DELETE"),
    false,
  );
});

test("provision preserves a new hook when a failed variable mutation is immediately reported absent", async () => {
  const requests = [];
  const createdHook = hook();
  await assert.rejects(
    runHookManagement({
      environment: environmentFor("provision"),
      fetchImpl: async (input, init) => {
        const request = requestSnapshot(input, init);
        requests.push(request);
        if (
          request.method === "GET" &&
          request.pathname === "/orgs/example-org/hooks"
        ) {
          return responseJson([]);
        }
        if (
          request.method === "POST" &&
          request.pathname === "/orgs/example-org/hooks"
        ) {
          return responseJson(createdHook, { status: 201 });
        }
        if (
          request.method === "GET" &&
          request.pathname === "/orgs/example-org/hooks/12345"
        ) {
          return responseJson(createdHook);
        }
        if (
          request.method === "GET" &&
          request.pathname.includes("/actions/variables/")
        ) {
          return responseJson({ message: "Not Found" }, { status: 404 });
        }
        if (
          request.method === "POST" &&
          request.pathname.endsWith("/actions/variables")
        ) {
          throw new DOMException("response lost after apply", "TimeoutError");
        }
        throw new Error(
          `Unexpected request: ${request.method} ${request.pathname}`,
        );
      },
      logger: silentLogger(),
    }),
    (error) => error instanceof AggregateError && error.rollbackSafe === false,
  );
  assert.equal(
    requests.some(({ method }) => method === "DELETE"),
    false,
  );
});

test("provision preserves a new hook when post-success variable verification is stale", async () => {
  const requests = [];
  const createdHook = hook();
  await assert.rejects(
    runHookManagement({
      environment: environmentFor("provision"),
      fetchImpl: async (input, init) => {
        const request = requestSnapshot(input, init);
        requests.push(request);
        if (
          request.method === "GET" &&
          request.pathname === "/orgs/example-org/hooks"
        ) {
          return responseJson([]);
        }
        if (
          request.method === "POST" &&
          request.pathname === "/orgs/example-org/hooks"
        ) {
          return responseJson(createdHook, { status: 201 });
        }
        if (
          request.method === "GET" &&
          request.pathname === "/orgs/example-org/hooks/12345"
        ) {
          return responseJson(createdHook);
        }
        if (
          request.method === "GET" &&
          request.pathname.includes("/actions/variables/")
        ) {
          return responseJson({ message: "Not Found" }, { status: 404 });
        }
        if (
          request.method === "POST" &&
          request.pathname.endsWith("/actions/variables")
        ) {
          return responseJson({ name: HOOK_VARIABLE }, { status: 201 });
        }
        throw new Error(
          `Unexpected request: ${request.method} ${request.pathname}`,
        );
      },
      logger: silentLogger(),
    }),
    (error) => error instanceof AggregateError && error.rollbackSafe === false,
  );
  assert.equal(
    requests.some(({ method }) => method === "DELETE"),
    false,
  );
});

test("activate applies the full secret-bearing configuration, verifies state, then pings", async () => {
  const requests = [];
  let targetGets = 0;
  const fetchImpl = async (input, init) => {
    const request = requestSnapshot(input, init);
    requests.push(request);
    if (
      request.method === "GET" &&
      request.pathname === "/orgs/example-org/hooks"
    ) {
      return responseJson([hook({ active: false })]);
    }
    if (request.method === "GET" && request.pathname.endsWith("/hooks/12345")) {
      targetGets += 1;
      return responseJson(hook({ active: targetGets > 1 }));
    }
    if (
      request.method === "PATCH" &&
      request.pathname.endsWith("/hooks/12345")
    ) {
      assert.deepEqual(request.body, {
        name: "web",
        config: {
          url: WEBHOOK_URL,
          content_type: "json",
          secret: TEST_SECRET,
          insecure_ssl: "0",
        },
        events: HOOK_EVENTS,
        active: true,
      });
      return responseJson(hook({ active: true }));
    }
    if (
      request.method === "POST" &&
      request.pathname.endsWith("/hooks/12345/pings")
    ) {
      return new Response(null, { status: 204 });
    }
    throw new Error(
      `Unexpected request: ${request.method} ${request.pathname}`,
    );
  };

  const result = await runHookManagement({
    environment: environmentFor("activate"),
    fetchImpl,
    logger: silentLogger(),
  });
  assert.deepEqual(result, {
    operation: "activate",
    hookId: "12345",
    active: true,
  });
  assert.deepEqual(
    requests.map(({ method }) => method),
    ["GET", "GET", "PATCH", "GET", "POST"],
  );
});

test("mutating and ping operations fail before mutation on PAT-visible duplicates or drift", async () => {
  for (const operation of ["activate", "deactivate", "ping"]) {
    const requests = [];
    await assert.rejects(
      runHookManagement({
        environment: environmentFor(operation),
        fetchImpl: async (input, init) => {
          requests.push(requestSnapshot(input, init));
          return responseJson([hook(), hook({ id: 12346 })]);
        },
        logger: silentLogger(),
      }),
      /Expected exactly one PAT-visible organization webhook.*found 2/,
    );
    assert.deepEqual(
      requests.map(({ method }) => method),
      ["GET"],
    );
  }

  for (const visibleHook of [
    hook({ events: HOOK_EVENTS.slice(1) }),
    hook({ id: 12346 }),
  ]) {
    const requests = [];
    await assert.rejects(
      runHookManagement({
        environment: environmentFor("ping"),
        fetchImpl: async (input, init) => {
          requests.push(requestSnapshot(input, init));
          return responseJson([visibleHook]);
        },
        logger: silentLogger(),
      }),
      /does not exactly match|not configured HOOK_ID/,
    );
    assert.deepEqual(
      requests.map(({ method }) => method),
      ["GET"],
    );
  }
});

test("failed activation drives a previously inactive hook back to inactive", async () => {
  const patches = [];
  let gets = 0;
  await assert.rejects(
    runHookManagement({
      environment: environmentFor("activate"),
      fetchImpl: async (input, init) => {
        const request = requestSnapshot(input, init);
        if (
          request.method === "GET" &&
          request.pathname === "/orgs/example-org/hooks"
        ) {
          return responseJson([hook({ active: false })]);
        }
        if (request.method === "GET") {
          gets += 1;
          return responseJson(hook({ active: gets === 2 }));
        }
        if (request.method === "PATCH") {
          patches.push(request.body);
          return responseJson(hook({ active: request.body.active }));
        }
        if (request.method === "POST" && request.pathname.endsWith("/pings")) {
          return responseJson({ message: "unavailable" }, { status: 503 });
        }
        throw new Error(
          `Unexpected request: ${request.method} ${request.pathname}`,
        );
      },
      logger: silentLogger(),
    }),
    /HTTP 503/,
  );
  assert.deepEqual(
    patches.map(({ active }) => active),
    [true, false],
  );
  for (const body of patches) {
    assert.equal(body.config.secret, TEST_SECRET);
    assert.deepEqual(body.events, HOOK_EVENTS);
  }
});

test("an ambiguous activation PATCH timeout still triggers verified rollback", async () => {
  const requests = [];
  let patchCount = 0;
  await assert.rejects(
    runHookManagement({
      environment: environmentFor("activate"),
      fetchImpl: async (input, init) => {
        const request = requestSnapshot(input, init);
        requests.push(request);
        if (
          request.method === "GET" &&
          request.pathname === "/orgs/example-org/hooks"
        ) {
          return responseJson([hook({ active: false })]);
        }
        if (request.method === "GET") {
          return responseJson(hook({ active: false }));
        }
        if (request.method === "PATCH") {
          patchCount += 1;
          if (patchCount === 1) {
            throw new DOMException("response lost after apply", "TimeoutError");
          }
          assert.equal(request.body.active, false);
          assert.equal(request.body.config.secret, TEST_SECRET);
          return responseJson(hook({ active: false }));
        }
        throw new Error(
          `Unexpected request: ${request.method} ${request.pathname}`,
        );
      },
      logger: silentLogger(),
    }),
    /timed out after 30000ms/,
  );
  assert.deepEqual(
    requests.map(({ method }) => method),
    ["GET", "GET", "PATCH", "PATCH", "GET"],
  );
});

test("deactivate sends the full configuration and verifies the inactive state", async () => {
  const requests = [];
  let gets = 0;
  const result = await runHookManagement({
    environment: environmentFor("deactivate"),
    fetchImpl: async (input, init) => {
      const request = requestSnapshot(input, init);
      requests.push(request);
      if (
        request.method === "GET" &&
        request.pathname === "/orgs/example-org/hooks"
      ) {
        return responseJson([hook({ active: true })]);
      }
      if (request.method === "GET") {
        gets += 1;
        return responseJson(hook({ active: gets === 1 }));
      }
      if (request.method === "PATCH") {
        assert.equal(request.body.active, false);
        assert.equal(request.body.config.secret, TEST_SECRET);
        assert.deepEqual(request.body.events, HOOK_EVENTS);
        return responseJson(hook({ active: false }));
      }
      throw new Error(
        `Unexpected request: ${request.method} ${request.pathname}`,
      );
    },
    logger: silentLogger(),
  });
  assert.deepEqual(result, {
    operation: "deactivate",
    hookId: "12345",
    active: false,
  });
  assert.deepEqual(
    requests.map(({ method }) => method),
    ["GET", "GET", "PATCH", "GET"],
  );
});

test("ping requires an already active exact hook and never sends the webhook secret", async () => {
  const requests = [];
  const pingEnvironment = environmentFor("ping");
  delete pingEnvironment.WEBHOOK_SECRET;
  const result = await runHookManagement({
    environment: pingEnvironment,
    fetchImpl: async (input, init) => {
      const request = requestSnapshot(input, init);
      requests.push(request);
      if (
        request.method === "GET" &&
        request.pathname === "/orgs/example-org/hooks"
      ) {
        return responseJson([hook({ active: true })]);
      }
      if (request.method === "GET") return responseJson(hook({ active: true }));
      if (request.method === "POST") return new Response(null, { status: 204 });
      throw new Error(
        `Unexpected request: ${request.method} ${request.pathname}`,
      );
    },
    logger: silentLogger(),
  });
  assert.deepEqual(result, {
    operation: "ping",
    hookId: "12345",
    active: true,
  });
  assert.deepEqual(
    requests.map(({ method }) => method),
    ["GET", "GET", "POST"],
  );
  assert.equal(
    requests.some(({ body }) =>
      (JSON.stringify(body) ?? "").includes(TEST_SECRET),
    ),
    false,
  );

  const inactiveRequests = [];
  await assert.rejects(
    runHookManagement({
      environment: pingEnvironment,
      fetchImpl: async (input, init) => {
        const request = requestSnapshot(input, init);
        inactiveRequests.push(request);
        if (request.pathname === "/orgs/example-org/hooks") {
          return responseJson([hook({ active: false })]);
        }
        return responseJson(hook({ active: false }));
      },
      logger: silentLogger(),
    }),
    /did not reach active=true/,
  );
  assert.deepEqual(
    inactiveRequests.map(({ method }) => method),
    ["GET", "GET"],
  );
});

test("404 and timeout diagnostics classify authorization without leaking scopes or credentials", async () => {
  await assert.rejects(
    runHookManagement({
      environment: environmentFor("ping"),
      fetchImpl: async () =>
        responseJson(
          { message: `do not render ${TEST_SECRET}` },
          {
            status: 404,
            headers: {
              "x-oauth-scopes": "repo, admin:org_hook, workflow",
              "x-github-request-id": "request-scope",
            },
          },
        ),
      logger: silentLogger(),
    }),
    (error) =>
      error instanceof GitHubApiError &&
      /admin:org_hook-scope=present/.test(error.message) &&
      /request-id=request-scope/.test(error.message) &&
      !/repo, admin:org_hook, workflow/.test(error.message) &&
      !error.message.includes(TEST_TOKEN) &&
      !error.message.includes(TEST_SECRET),
  );

  await assert.rejects(
    runHookManagement({
      environment: environmentFor("ping"),
      fetchImpl: async (_url, init) => {
        assert.ok(init.signal instanceof AbortSignal);
        throw new DOMException("request timed out", "TimeoutError");
      },
      logger: silentLogger(),
    }),
    (error) =>
      /timed out after 30000ms/.test(error.message) &&
      !error.message.includes(TEST_TOKEN) &&
      !error.message.includes(TEST_SECRET),
  );
});
