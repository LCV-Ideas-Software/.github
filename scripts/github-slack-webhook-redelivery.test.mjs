import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import {
  API_VERSION,
  GitHubApiError,
  MAX_DELIVERY_ATTEMPTS,
  MAX_DELIVERY_CLOCK_SKEW_MS,
  MAX_REDELIVERY_AGE_MS,
  REDELIVERY_WORKFLOW_FILE,
  REDELIVERY_WORKFLOW_PATH,
  fetchDeliveriesSince,
  fetchLastSuccessfulScheduledRun,
  parseNextCursor,
  readConfiguration,
  resolveContinuityCheckpoint,
  runRedelivery,
  selectFailedDeliveryIds,
  wasSuccessful,
} from "./github-slack-webhook-redelivery.mjs";

const baseEnvironment = Object.freeze({
  ACTIONS_TOKEN: "actions-token-never-log",
  HOOK_TOKEN: "hook-token-never-log",
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
  redelivery = false,
}) {
  return {
    id,
    guid,
    delivered_at: deliveredAt,
    status,
    status_code: statusCode,
    redelivery,
  };
}

function normalizedDelivery({
  id,
  guid = `guid-${id}`,
  deliveredAt,
  status = "Internal Server Error",
  statusCode = 500,
  redelivery = false,
}) {
  return {
    id: String(id),
    guid,
    deliveredAt,
    status,
    statusCode,
    redelivery,
  };
}

function rawWorkflowRun({
  id,
  runStartedAt,
  createdAt = runStartedAt - 1_000,
  updatedAt = runStartedAt + 1_000,
  path = REDELIVERY_WORKFLOW_PATH,
  event = "schedule",
  status = "completed",
  conclusion = "success",
  headBranch = "main",
  headSha = "a".repeat(40),
  runAttempt = 1,
}) {
  return {
    id,
    path,
    event,
    status,
    conclusion,
    head_branch: headBranch,
    head_sha: headSha,
    run_attempt: runAttempt,
    created_at: new Date(createdAt).toISOString(),
    run_started_at: new Date(runStartedAt).toISOString(),
    updated_at: new Date(updatedAt).toISOString(),
  };
}

function successfulRunsResponse(runs, totalCount = runs.length) {
  return responseJson({ total_count: totalCount, workflow_runs: runs });
}

function continuityWorkflowRun(startedAt, { id = 9_001 } = {}) {
  return rawWorkflowRun({ id, runStartedAt: startedAt - 60_000 });
}

function rawJob({
  id,
  name = "Redeliver failed organization webhook deliveries",
  runId = 9_001,
  runAttempt = 1,
  status = "completed",
  conclusion = "success",
  steps = [
    {
      name: "Recover failed webhook deliveries",
      number: 1,
      status: "completed",
      conclusion: "success",
    },
  ],
}) {
  return {
    id,
    name,
    run_id: runId,
    run_attempt: runAttempt,
    status,
    conclusion,
    steps,
  };
}

function jobsResponse(jobs, totalCount = jobs.length) {
  return responseJson({ total_count: totalCount, jobs });
}

function successfulRecoveryJobResponse({ runId = 9_001 } = {}) {
  return jobsResponse([rawJob({ id: 7_001, runId })]);
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
  assert.throws(
    () =>
      readConfiguration({
        ...baseEnvironment,
        ACTIONS_TOKEN: baseEnvironment.HOOK_TOKEN,
      }),
    /must be distinct least-privilege credentials/,
  );
});

test("continuity requires a successful scheduled run inside GitHub's three-day limit", () => {
  const startedAt = Date.parse("2026-08-03T12:00:00.000Z");
  assert.equal(
    resolveContinuityCheckpoint(
      { runStartedAt: Date.parse("2026-08-03T10:00:00.000Z") },
      startedAt,
    ),
    Date.parse("2026-08-03T10:00:00.000Z"),
  );

  assert.throws(
    () => resolveContinuityCheckpoint(undefined, startedAt),
    /valid successful scheduled workflow run is required/,
  );
  assert.throws(
    () => resolveContinuityCheckpoint({ runStartedAt: 1 }, startedAt),
    /older than GitHub's three-day redelivery window/,
  );
  assert.throws(
    () =>
      resolveContinuityCheckpoint({ runStartedAt: startedAt + 1 }, startedAt),
    /cannot start in the future/,
  );
  assert.throws(
    () => resolveContinuityCheckpoint({ runStartedAt: NaN }, startedAt),
    /valid successful scheduled workflow run is required/,
  );
});

test("continuity rejects the entire 15-minute safety margin inside retention", () => {
  const startedAt = Date.parse("2026-08-04T12:00:00.000Z");
  const safetyBoundary = startedAt - MAX_REDELIVERY_AGE_MS + 15 * 60 * 1000;

  assert.throws(
    () =>
      resolveContinuityCheckpoint({ runStartedAt: safetyBoundary }, startedAt),
    /15-minute safety margin/,
  );
  assert.throws(
    () =>
      resolveContinuityCheckpoint(
        { runStartedAt: safetyBoundary - 1 },
        startedAt,
      ),
    /15-minute safety margin/,
  );
  assert.equal(
    resolveContinuityCheckpoint(
      { runStartedAt: safetyBoundary + 1 },
      startedAt,
    ),
    safetyBoundary + 1,
  );
});

test("Actions pagination uses the read-only token and selects the latest valid run without trusting API order", async () => {
  const startedAt = Date.parse("2026-08-04T12:00:00.000Z");
  const firstPage = Array.from({ length: 100 }, (_, index) =>
    rawWorkflowRun({
      id: index + 1,
      runStartedAt: startedAt - 60 * 60 * 1000 - index * 1_000,
    }),
  );
  const latest = rawWorkflowRun({
    id: 101,
    runStartedAt: startedAt - 60_000,
    headSha: "b".repeat(40),
  });
  const requests = [];

  const run = await fetchLastSuccessfulScheduledRun({
    token: baseEnvironment.ACTIONS_TOKEN,
    owner: baseEnvironment.WORKFLOW_REPO_OWNER,
    repository: baseEnvironment.WORKFLOW_REPO_NAME,
    startedAt,
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      assert.equal(
        init.headers.Authorization,
        `Bearer ${baseEnvironment.ACTIONS_TOKEN}`,
      );
      assert.notEqual(
        init.headers.Authorization,
        `Bearer ${baseEnvironment.HOOK_TOKEN}`,
      );
      if (url.pathname.includes("/actions/runs/")) {
        assert.equal(
          url.pathname,
          "/repos/example-org/.github/actions/runs/101/attempts/1/jobs",
        );
        return successfulRecoveryJobResponse({ runId: 101 });
      }
      requests.push({ url, init });
      assert.equal(
        url.pathname,
        `/repos/example-org/.github/actions/workflows/${REDELIVERY_WORKFLOW_FILE}/runs`,
      );
      assert.equal(url.searchParams.get("branch"), "main");
      assert.equal(url.searchParams.get("event"), "schedule");
      assert.equal(url.searchParams.get("status"), "success");
      assert.equal(url.searchParams.get("per_page"), "100");
      assert.equal(
        url.searchParams.get("created"),
        `>=${new Date(
          startedAt - MAX_REDELIVERY_AGE_MS + 15 * 60 * 1000,
        ).toISOString()}`,
      );
      return url.searchParams.get("page") === "1"
        ? successfulRunsResponse(firstPage, 101)
        : successfulRunsResponse([latest], 101);
    },
  });

  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests.map(({ url }) => url.searchParams.get("page")),
    ["1", "2"],
  );
  assert.deepEqual(run, {
    id: "101",
    createdAt: startedAt - 61_000,
    runStartedAt: startedAt - 60_000,
    updatedAt: startedAt - 59_000,
    headSha: "b".repeat(40),
    runAttempt: 1,
  });
});

test("Actions continuity has no fallback when no successful scheduled run exists", async () => {
  const startedAt = Date.parse("2026-08-04T12:00:00.000Z");
  await assert.rejects(
    fetchLastSuccessfulScheduledRun({
      token: baseEnvironment.ACTIONS_TOKEN,
      owner: baseEnvironment.WORKFLOW_REPO_OWNER,
      repository: baseEnvironment.WORKFLOW_REPO_NAME,
      startedAt,
      fetchImpl: async () => successfulRunsResponse([]),
    }),
    /No successful scheduled redelivery workflow run exists/,
  );
});

test("continuity skips a non-executed schedule and selects the newest proven recovery", async () => {
  const startedAt = Date.parse("2026-08-04T12:00:00.000Z");
  const proven = rawWorkflowRun({
    id: 9_001,
    runStartedAt: startedAt - 120_000,
  });
  const skipped = rawWorkflowRun({
    id: 9_002,
    runStartedAt: startedAt - 60_000,
  });
  const inspectedRunIds = [];
  let hookReads = 0;

  const result = await runRedelivery({
    environment: baseEnvironment,
    now: () => startedAt,
    logger: { info() {}, warn() {} },
    fetchImpl: async (input) => {
      const url = new URL(input);
      if (url.pathname.includes("/actions/workflows/")) {
        return successfulRunsResponse([proven, skipped]);
      }
      if (url.pathname.includes("/actions/runs/")) {
        const runId = url.pathname.split("/").at(-4);
        inspectedRunIds.push(runId);
        return runId === "9002"
          ? jobsResponse([
              rawJob({
                id: 7_002,
                runId: 9_002,
                conclusion: "skipped",
                steps: [],
              }),
            ])
          : successfulRecoveryJobResponse({ runId: 9_001 });
      }
      if (url.pathname.endsWith("/deliveries")) {
        hookReads += 1;
        return responseJson([]);
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    },
  });

  assert.deepEqual(inspectedRunIds, ["9002", "9001"]);
  assert.equal(hookReads, 1);
  assert.equal(result.continuityRunId, "9001");
});

test("Actions continuity rejects server-filter violations and malformed run identity", async () => {
  const startedAt = Date.parse("2026-08-04T12:00:00.000Z");
  const valid = rawWorkflowRun({ id: 1, runStartedAt: startedAt - 60_000 });
  const cases = [
    [{ ...valid, id: 0 }, /invalid ID/],
    [
      { ...valid, path: ".github/workflows/other.yml" },
      /unexpected workflow path/,
    ],
    [{ ...valid, event: "workflow_dispatch" }, /requested schedule/],
    [{ ...valid, status: "in_progress" }, /requested schedule/],
    [{ ...valid, conclusion: "failure" }, /requested schedule/],
    [{ ...valid, head_branch: "feature" }, /requested schedule/],
    [{ ...valid, head_sha: "not-a-sha" }, /invalid head SHA/],
    [{ ...valid, run_attempt: 0 }, /invalid run attempt/],
    [
      {
        ...valid,
        created_at: new Date(
          startedAt - MAX_REDELIVERY_AGE_MS - 1,
        ).toISOString(),
      },
      /outside the requested continuity window/,
    ],
    [{ ...valid, run_started_at: "invalid" }, /invalid run_started_at/],
  ];

  for (const [run, expected] of cases) {
    await assert.rejects(
      fetchLastSuccessfulScheduledRun({
        token: baseEnvironment.ACTIONS_TOKEN,
        owner: baseEnvironment.WORKFLOW_REPO_OWNER,
        repository: baseEnvironment.WORKFLOW_REPO_NAME,
        startedAt,
        fetchImpl: async () => successfulRunsResponse([run]),
      }),
      expected,
    );
  }
});

test("Actions pagination fails closed on duplicate IDs, changing totals, gaps, and over-limit totals", async () => {
  const startedAt = Date.parse("2026-08-04T12:00:00.000Z");
  const run = rawWorkflowRun({ id: 1, runStartedAt: startedAt - 60_000 });
  const fetchRun = (fetchImpl) =>
    fetchLastSuccessfulScheduledRun({
      token: baseEnvironment.ACTIONS_TOKEN,
      owner: baseEnvironment.WORKFLOW_REPO_OWNER,
      repository: baseEnvironment.WORKFLOW_REPO_NAME,
      startedAt,
      fetchImpl,
    });

  let page = 0;
  await assert.rejects(
    fetchRun(async () => {
      page += 1;
      return successfulRunsResponse([run], page === 1 ? 2 : 2);
    }),
    /duplicate workflow-run ID/,
  );

  page = 0;
  await assert.rejects(
    fetchRun(async () => {
      page += 1;
      return successfulRunsResponse(
        [page === 1 ? run : { ...run, id: 2 }],
        page === 1 ? 2 : 3,
      );
    }),
    /changed the workflow-run total/,
  );

  await assert.rejects(
    fetchRun(async () => successfulRunsResponse([], 1)),
    /empty workflow-runs page before the declared total/,
  );

  await assert.rejects(
    fetchRun(async () => successfulRunsResponse([run], 1_001)),
    /safety limit of 10 pages/,
  );
});

test("continuity margin failure occurs before any organization-hook GET", async () => {
  const startedAt = Date.parse("2026-08-04T12:00:00.000Z");
  const safetyBoundary = startedAt - MAX_REDELIVERY_AGE_MS + 15 * 60 * 1000;
  let hookRead = false;

  await assert.rejects(
    runRedelivery({
      environment: baseEnvironment,
      now: () => startedAt,
      logger: { info() {}, warn() {} },
      fetchImpl: async (input) => {
        const url = new URL(input);
        if (url.pathname.includes("/actions/workflows/")) {
          return successfulRunsResponse([
            rawWorkflowRun({
              id: 9_001,
              runStartedAt: safetyBoundary,
              createdAt: safetyBoundary,
            }),
          ]);
        }
        if (url.pathname.includes("/actions/runs/")) {
          return successfulRecoveryJobResponse();
        }
        hookRead = true;
        return responseJson([]);
      },
    }),
    /15-minute safety margin/,
  );
  assert.equal(hookRead, false);
});

test("continuity proves the exact recovery step through paginated run-attempt jobs", async () => {
  const startedAt = Date.parse("2026-08-04T12:00:00.000Z");
  const irrelevantJobs = Array.from({ length: 100 }, (_, index) =>
    rawJob({
      id: index + 1,
      name: `Irrelevant job ${index + 1}`,
      steps: [
        {
          name: `Irrelevant step ${index + 1}`,
          number: 1,
          status: "completed",
          conclusion: "success",
        },
      ],
    }),
  );
  const recoveryJob = rawJob({ id: 101 });
  const jobRequests = [];

  const result = await runRedelivery({
    environment: baseEnvironment,
    now: () => startedAt,
    logger: { info() {}, warn() {} },
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      if (url.pathname.includes("/actions/workflows/")) {
        return successfulRunsResponse([continuityWorkflowRun(startedAt)]);
      }
      if (url.pathname.includes("/actions/runs/")) {
        jobRequests.push(url);
        assert.equal(
          init.headers.Authorization,
          `Bearer ${baseEnvironment.ACTIONS_TOKEN}`,
        );
        assert.equal(
          url.pathname,
          "/repos/example-org/.github/actions/runs/9001/attempts/1/jobs",
        );
        assert.equal(url.searchParams.get("per_page"), "100");
        return url.searchParams.get("page") === "1"
          ? jobsResponse(irrelevantJobs, 101)
          : jobsResponse([recoveryJob], 101);
      }
      if (url.pathname.endsWith("/deliveries")) {
        return responseJson([]);
      }
      throw new Error(`Unexpected request: ${init.method} ${url.pathname}`);
    },
  });

  assert.equal(result.redeliveries, 0);
  assert.deepEqual(
    jobRequests.map((url) => url.searchParams.get("page")),
    ["1", "2"],
  );
});

test("continuity rejects skipped, duplicate, absent, and malformed recovery-step evidence", async () => {
  const startedAt = Date.parse("2026-08-04T12:00:00.000Z");
  const successfulStep = {
    name: "Recover failed webhook deliveries",
    number: 1,
    status: "completed",
    conclusion: "success",
  };
  const cases = [
    [[], /No successful scheduled .* proven successful recovery step/],
    [
      [rawJob({ id: 1, status: "completed", conclusion: "skipped" })],
      /No successful scheduled .* proven successful recovery step/,
    ],
    [
      [rawJob({ id: 1, name: "Impostor recovery job" })],
      /No successful scheduled .* proven successful recovery step/,
    ],
    [
      [
        rawJob({ id: 1 }),
        rawJob({
          id: 2,
          steps: [
            {
              name: "Irrelevant step",
              number: 1,
              status: "completed",
              conclusion: "success",
            },
          ],
        }),
      ],
      /must not contain more than one recovery job/,
    ],
    [
      [
        rawJob({
          id: 1,
          steps: [{ ...successfulStep, conclusion: "skipped" }],
        }),
      ],
      /No successful scheduled .* proven successful recovery step/,
    ],
    [
      [
        rawJob({
          id: 1,
          steps: [successfulStep, { ...successfulStep, number: 2 }],
        }),
      ],
      /must not contain more than one recovery step/,
    ],
    [[rawJob({ id: 1, status: "banana" })], /invalid terminal job status/],
    [
      [rawJob({ id: 1, conclusion: "banana" })],
      /invalid terminal job conclusion/,
    ],
    [
      [
        rawJob({
          id: 1,
          steps: [{ ...successfulStep, status: "banana" }],
        }),
      ],
      /invalid terminal step status/,
    ],
    [
      [
        rawJob({
          id: 1,
          steps: [{ ...successfulStep, conclusion: "banana" }],
        }),
      ],
      /invalid terminal step conclusion/,
    ],
    [[rawJob({ id: 0 })], /invalid job ID/],
    [[rawJob({ id: 1, name: "" })], /invalid job name/],
    [[rawJob({ id: 1, runId: 9_002 })], /unexpected workflow run/],
    [[rawJob({ id: 1, runAttempt: 2 })], /unexpected workflow run attempt/],
  ];

  for (const [jobs, expected] of cases) {
    let hookRead = false;
    await assert.rejects(
      runRedelivery({
        environment: baseEnvironment,
        now: () => startedAt,
        logger: { info() {}, warn() {} },
        fetchImpl: async (input) => {
          const url = new URL(input);
          if (url.pathname.includes("/actions/workflows/")) {
            return successfulRunsResponse([continuityWorkflowRun(startedAt)]);
          }
          if (url.pathname.includes("/actions/runs/")) {
            return jobsResponse(jobs);
          }
          hookRead = true;
          return responseJson([]);
        },
      }),
      expected,
    );
    assert.equal(hookRead, false);
  }
});

test("run-attempt jobs pagination fails closed on duplicates, drift, gaps, malformed pages, and limits", async () => {
  const startedAt = Date.parse("2026-08-04T12:00:00.000Z");
  const irrelevantJob = rawJob({
    id: 1,
    steps: [
      {
        name: "Irrelevant step",
        number: 1,
        status: "completed",
        conclusion: "success",
      },
    ],
  });
  const cases = [
    [
      (page) => jobsResponse([irrelevantJob], page === 1 ? 2 : 2),
      /duplicate workflow-job ID/,
    ],
    [
      (page) =>
        jobsResponse(
          [page === 1 ? irrelevantJob : { ...irrelevantJob, id: 2 }],
          page === 1 ? 2 : 3,
        ),
      /changed the workflow-job total/,
    ],
    [() => jobsResponse([], 1), /empty workflow-jobs page/],
    [() => jobsResponse([irrelevantJob], 1_001), /safety limit of 10 pages/],
    [
      () => responseJson({ total_count: "1", jobs: [] }),
      /malformed workflow-jobs page/,
    ],
  ];

  for (const [jobsPage, expected] of cases) {
    let hookRead = false;
    await assert.rejects(
      runRedelivery({
        environment: baseEnvironment,
        now: () => startedAt,
        logger: { info() {}, warn() {} },
        fetchImpl: async (input) => {
          const url = new URL(input);
          if (url.pathname.includes("/actions/workflows/")) {
            return successfulRunsResponse([continuityWorkflowRun(startedAt)]);
          }
          if (url.pathname.includes("/actions/runs/")) {
            return jobsPage(Number(url.searchParams.get("page")));
          }
          hookRead = true;
          return responseJson([]);
        },
      }),
      expected,
    );
    assert.equal(hookRead, false);
  }
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
  assert.throws(
    () =>
      parseNextCursor(
        [
          `<https://api.github.com${path}?per_page=100&cursor=one>; rel="next"`,
          `<https://api.github.com${path}?per_page=100&cursor=two>; rel="next"`,
        ].join(", "),
        path,
      ),
    /exactly one next relation/,
  );
  assert.throws(
    () =>
      parseNextCursor(
        `<https://api.github.com${path}?per_page=100&cursor=one&cursor=two>; rel="next"`,
        path,
      ),
    /exactly one cursor/,
  );
  assert.throws(
    () =>
      parseNextCursor(
        `<https://api.github.com${path}?per_page=99&cursor=next>; rel="next"`,
        path,
      ),
    /per_page=100/,
  );
  assert.throws(
    () =>
      parseNextCursor(
        `<https://api.github.com${path}?per_page=100&cursor=next&extra=value>; rel="next"`,
        path,
      ),
    /unexpected query parameters/,
  );
  assert.throws(
    () =>
      parseNextCursor(
        `<https://api.github.com${path}?per_page=100&cursor=>; rel="next"`,
        path,
      ),
    /non-empty cursor/,
  );
});

test("Link parsing rejects adversarial parameters without regex backtracking", () => {
  const moduleUrl = new URL(
    "./github-slack-webhook-redelivery.mjs",
    import.meta.url,
  ).href;
  const script = `
    import { parseNextCursor } from ${JSON.stringify(moduleUrl)};
    let rejected = false;
    try {
      parseNextCursor(
        "<=>;" + " : ;".repeat(100_000) + ";",
        "/orgs/example-org/hooks/12345/deliveries",
      );
    } catch {
      rejected = true;
    }
    if (!rejected) process.exit(2);
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      encoding: "utf8",
      timeout: 5_000,
    },
  );

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
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
    token: baseEnvironment.HOOK_TOKEN,
    organizationName: baseEnvironment.ORGANIZATION_NAME,
    organizationId: baseEnvironment.ORGANIZATION_ID,
    hookId: baseEnvironment.HOOK_ID,
    cutoff,
    startedAt: Date.parse("2026-08-03T12:00:00.000Z"),
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
    token: baseEnvironment.HOOK_TOKEN,
    organizationName: baseEnvironment.ORGANIZATION_NAME,
    organizationId: baseEnvironment.ORGANIZATION_ID,
    hookId: baseEnvironment.HOOK_ID,
    cutoff,
    startedAt: Date.parse("2026-08-03T12:00:00.000Z"),
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
              link: `<https://api.github.com${path}?per_page=100&cursor=cursor-2>; rel="next"`,
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
  const overlappingFetch = ({
    contradiction = false,
    redeliveryContradiction = false,
  } = {}) => {
    let requests = 0;
    return async () => {
      requests += 1;
      if (requests === 1) {
        return responseJson([shared], {
          headers: {
            link: `<https://api.github.com${path}?per_page=100&cursor=overlap>; rel="next"`,
          },
        });
      }
      return responseJson([
        contradiction
          ? { ...shared, status: "OK", status_code: 200 }
          : redeliveryContradiction
            ? { ...shared, redelivery: true }
            : shared,
      ]);
    };
  };

  const deliveries = await fetchDeliveriesSince({
    token: baseEnvironment.HOOK_TOKEN,
    organizationName: baseEnvironment.ORGANIZATION_NAME,
    organizationId: baseEnvironment.ORGANIZATION_ID,
    hookId: baseEnvironment.HOOK_ID,
    cutoff: Date.parse("2026-08-03T10:00:00.000Z"),
    startedAt: Date.parse("2026-08-03T12:00:00.000Z"),
    fetchImpl: overlappingFetch(),
  });
  assert.deepEqual(
    deliveries.map((delivery) => delivery.id),
    ["7"],
  );

  await assert.rejects(
    fetchDeliveriesSince({
      token: baseEnvironment.HOOK_TOKEN,
      organizationName: baseEnvironment.ORGANIZATION_NAME,
      organizationId: baseEnvironment.ORGANIZATION_ID,
      hookId: baseEnvironment.HOOK_ID,
      cutoff: Date.parse("2026-08-03T10:00:00.000Z"),
      startedAt: Date.parse("2026-08-03T12:00:00.000Z"),
      fetchImpl: overlappingFetch({ contradiction: true }),
    }),
    /contradictory metadata/,
  );
  await assert.rejects(
    fetchDeliveriesSince({
      token: baseEnvironment.HOOK_TOKEN,
      organizationName: baseEnvironment.ORGANIZATION_NAME,
      organizationId: baseEnvironment.ORGANIZATION_ID,
      hookId: baseEnvironment.HOOK_ID,
      cutoff: Date.parse("2026-08-03T10:00:00.000Z"),
      startedAt: Date.parse("2026-08-03T12:00:00.000Z"),
      fetchImpl: overlappingFetch({ redeliveryContradiction: true }),
    }),
    /contradictory metadata/,
  );
});

test("delivery IDs beyond JavaScript's safe integer range retain every decimal digit", async () => {
  const exactDeliveryId = "3835001740625715000";
  const deliveries = await fetchDeliveriesSince({
    token: baseEnvironment.HOOK_TOKEN,
    organizationName: baseEnvironment.ORGANIZATION_NAME,
    organizationId: baseEnvironment.ORGANIZATION_ID,
    hookId: baseEnvironment.HOOK_ID,
    cutoff: Date.parse("2026-08-03T10:00:00.000Z"),
    startedAt: Date.parse("2026-08-03T12:00:00.000Z"),
    fetchImpl: async () =>
      responseText(
        `[{"id":${exactDeliveryId},"guid":"large-id-guid","delivered_at":"2026-08-03T11:00:00.000Z","status":"Internal Server Error","status_code":500,"redelivery":false}]`,
      ),
  });

  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].id, exactDeliveryId);

  await assert.rejects(
    fetchDeliveriesSince({
      token: baseEnvironment.HOOK_TOKEN,
      organizationName: baseEnvironment.ORGANIZATION_NAME,
      organizationId: baseEnvironment.ORGANIZATION_ID,
      hookId: baseEnvironment.HOOK_ID,
      cutoff: Date.parse("2026-08-03T10:00:00.000Z"),
      startedAt: Date.parse("2026-08-03T12:00:00.000Z"),
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

test("delivery normalization requires redelivery provenance, bounded status codes, and non-future timestamps", async () => {
  const startedAt = Date.parse("2026-08-03T12:00:00.000Z");
  const base = rawDelivery({
    id: 1,
    deliveredAt: "2026-08-03T11:00:00.000Z",
  });
  const fetchOne = (delivery) =>
    fetchDeliveriesSince({
      token: baseEnvironment.HOOK_TOKEN,
      organizationName: baseEnvironment.ORGANIZATION_NAME,
      organizationId: baseEnvironment.ORGANIZATION_ID,
      hookId: baseEnvironment.HOOK_ID,
      cutoff: Date.parse("2026-08-03T10:00:00.000Z"),
      startedAt,
      now: () => startedAt,
      fetchImpl: async () => responseJson([delivery]),
    });

  const withoutRedelivery = { ...base };
  delete withoutRedelivery.redelivery;
  await assert.rejects(fetchOne(withoutRedelivery), /redelivery flag/);
  await assert.rejects(
    fetchOne({
      ...base,
      delivered_at: new Date(
        startedAt + MAX_DELIVERY_CLOCK_SKEW_MS + 1,
      ).toISOString(),
    }),
    /future timestamp/,
  );
  for (const statusCode of [0, 199, 600]) {
    await assert.rejects(
      fetchOne({ ...base, status_code: statusCode }),
      /between 200 and 599/,
    );
  }

  for (const statusCode of [200, 399, 400, 599]) {
    const [delivery] = await fetchOne({
      ...base,
      id: statusCode,
      status_code: statusCode,
    });
    assert.equal(wasSuccessful(delivery), statusCode <= 399);
  }
});

test("delivery timestamps are bounded by page observation instead of the stale run start", async () => {
  const startedAt = Date.parse("2026-08-03T12:00:00.000Z");
  const pageObservedAt = startedAt + 2 * 60 * 1000;
  const fetchOne = (deliveredAt) =>
    fetchDeliveriesSince({
      token: baseEnvironment.HOOK_TOKEN,
      organizationName: baseEnvironment.ORGANIZATION_NAME,
      organizationId: baseEnvironment.ORGANIZATION_ID,
      hookId: baseEnvironment.HOOK_ID,
      cutoff: Date.parse("2026-08-03T10:00:00.000Z"),
      startedAt,
      now: () => pageObservedAt,
      fetchImpl: async () =>
        responseJson([
          rawDelivery({
            id: 1,
            deliveredAt: new Date(deliveredAt).toISOString(),
          }),
        ]),
    });

  const [arrivedDuringPagination] = await fetchOne(startedAt + 60_000);
  assert.equal(arrivedDuringPagination.id, "1");

  const [withinClockSkew] = await fetchOne(pageObservedAt + 60_000);
  assert.equal(withinClockSkew.id, "1");

  await assert.rejects(fetchOne(pageObservedAt + 60_001), /future timestamp/);
});

test("delivery reads use the live clock when callers do not inject one", async (context) => {
  const startedAt = Date.parse("2026-08-03T12:00:00.000Z");
  const observedAt = startedAt + 120_000;
  const deliveredAt = startedAt + 90_000;
  context.mock.method(Date, "now", () => observedAt);
  const [delivery] = await fetchDeliveriesSince({
    token: baseEnvironment.HOOK_TOKEN,
    organizationName: baseEnvironment.ORGANIZATION_NAME,
    organizationId: baseEnvironment.ORGANIZATION_ID,
    hookId: baseEnvironment.HOOK_ID,
    cutoff: startedAt - 60_000,
    startedAt,
    fetchImpl: async () =>
      responseJson([
        rawDelivery({
          id: 1,
          deliveredAt: new Date(deliveredAt).toISOString(),
        }),
      ]),
  });

  assert.equal(delivery.deliveredAt, deliveredAt);
});

test("delivery pagination fails closed when its observation clock moves backwards", async () => {
  const startedAt = Date.parse("2026-08-03T12:00:00.000Z");
  const path = "/orgs/example-org/hooks/12345/deliveries";
  let page = 0;
  const observations = [startedAt + 2_000, startedAt + 1_000];

  await assert.rejects(
    fetchDeliveriesSince({
      token: baseEnvironment.HOOK_TOKEN,
      organizationName: baseEnvironment.ORGANIZATION_NAME,
      organizationId: baseEnvironment.ORGANIZATION_ID,
      hookId: baseEnvironment.HOOK_ID,
      cutoff: Date.parse("2026-08-03T10:00:00.000Z"),
      startedAt,
      now: () => observations[page - 1],
      fetchImpl: async () => {
        page += 1;
        if (page === 1) {
          return responseJson(
            [
              rawDelivery({
                id: 1,
                deliveredAt: "2026-08-03T11:00:00.000Z",
              }),
            ],
            {
              headers: {
                link: `<https://api.github.com${path}?per_page=100&cursor=second>; rel="next"`,
              },
            },
          );
        }
        return responseJson([]);
      },
    }),
    /observation clock moved backwards/,
  );
  assert.equal(page, 2);
});

test("pagination filters the checkpoint without assuming later pages are older", async () => {
  const path = "/orgs/example-org/hooks/12345/deliveries";
  let requests = 0;
  const deliveries = await fetchDeliveriesSince({
    token: baseEnvironment.HOOK_TOKEN,
    organizationName: baseEnvironment.ORGANIZATION_NAME,
    organizationId: baseEnvironment.ORGANIZATION_ID,
    hookId: baseEnvironment.HOOK_ID,
    cutoff: Date.parse("2026-08-03T10:00:00.000Z"),
    startedAt: Date.parse("2026-08-03T12:00:00.000Z"),
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
            link: `<https://api.github.com${path}?per_page=100&cursor=second-page>; rel="next"`,
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
      token: baseEnvironment.HOOK_TOKEN,
      organizationName: baseEnvironment.ORGANIZATION_NAME,
      organizationId: baseEnvironment.ORGANIZATION_ID,
      hookId: baseEnvironment.HOOK_ID,
      cutoff: 1,
      startedAt: Date.now(),
      fetchImpl: async () =>
        responseJson([], {
          headers: {
            link: `<https://api.github.com${path}?per_page=100&cursor=unexpected>; rel="next"`,
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
    normalizedDelivery({
      id: 12,
      guid: "a",
      deliveredAt: time - 1_000,
      redelivery: true,
    }),
    normalizedDelivery({ id: 21, guid: "b", deliveredAt: time - 4_000 }),
    normalizedDelivery({
      id: 22,
      guid: "b",
      deliveredAt: time - 3_000,
      status: "Accepted",
      statusCode: 202,
      redelivery: true,
    }),
    normalizedDelivery({ id: 31, guid: "c", deliveredAt: time - 5_000 }),
    normalizedDelivery({
      id: 32,
      guid: "c",
      deliveredAt: time - 4_000,
      status: "OK",
      statusCode: 500,
      redelivery: true,
    }),
    normalizedDelivery({ id: 41, guid: "d", deliveredAt: time - 8_000 }),
    normalizedDelivery({ id: 51, guid: "e", deliveredAt: time - 7_000 }),
    normalizedDelivery({
      id: 52,
      guid: "e",
      deliveredAt: time - 6_000,
      status: "Found",
      statusCode: 302,
      redelivery: true,
    }),
    normalizedDelivery({ id: 61, guid: "f", deliveredAt: time - 10_000 }),
    normalizedDelivery({
      id: 62,
      guid: "f",
      deliveredAt: time - 9_000,
      status: "Moved",
      statusCode: 399,
      redelivery: true,
    }),
  ]);
  assert.deepEqual(ids, ["41", "32", "12"]);

  assert.deepEqual(
    selectFailedDeliveryIds([
      normalizedDelivery({ id: "99", guid: "same", deliveredAt: time }),
      normalizedDelivery({
        id: "100",
        guid: "same",
        deliveredAt: time,
        redelivery: true,
      }),
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

  assert.deepEqual(
    selectFailedDeliveryIds([
      normalizedDelivery({
        id: 101,
        guid: "resolved-truncated-history",
        deliveredAt: time,
        status: "OK",
        statusCode: 200,
        redelivery: true,
      }),
    ]),
    [],
  );
});

test("automatic redelivery fails closed at the per-GUID attempt limit", () => {
  const time = Date.parse("2026-08-03T10:00:00.000Z");
  const exhaustedAttempts = Array.from(
    { length: MAX_DELIVERY_ATTEMPTS },
    (_, index) =>
      normalizedDelivery({
        id: 100 + index,
        guid: "poisoned-delivery",
        deliveredAt: time + index,
        redelivery: index > 0,
      }),
  );

  assert.throws(
    () => selectFailedDeliveryIds(exhaustedAttempts),
    new RegExp(`limit of ${MAX_DELIVERY_ATTEMPTS} unsuccessful attempts`),
  );
});

test("every GUID requires exactly one retained original and retries cannot renew the attempt budget", () => {
  const time = Date.parse("2026-08-03T10:00:00.000Z");

  assert.throws(
    () =>
      selectFailedDeliveryIds([
        normalizedDelivery({
          id: 1,
          guid: "truncated-history",
          deliveredAt: time,
          redelivery: true,
        }),
      ]),
    /exactly one original delivery/,
  );
  assert.throws(
    () =>
      selectFailedDeliveryIds([
        normalizedDelivery({
          id: 1,
          guid: "duplicate-original",
          deliveredAt: time,
        }),
        normalizedDelivery({
          id: 2,
          guid: "duplicate-original",
          deliveredAt: time + 1,
        }),
      ]),
    /exactly one original delivery/,
  );
  assert.throws(
    () =>
      selectFailedDeliveryIds([
        normalizedDelivery({ id: 1, guid: "fixed-budget", deliveredAt: time }),
        normalizedDelivery({
          id: 2,
          guid: "fixed-budget",
          deliveredAt: time + 1,
          redelivery: true,
        }),
        normalizedDelivery({
          id: 3,
          guid: "fixed-budget",
          deliveredAt: time + 2,
          redelivery: true,
        }),
      ]),
    new RegExp(`limit of ${MAX_DELIVERY_ATTEMPTS} unsuccessful attempts`),
  );
});

test("a complete run counts retained attempts from before the continuity run", async () => {
  const startedAt = Date.parse("2026-08-04T12:00:00.000Z");
  const oldAttempt = startedAt - 2 * 24 * 60 * 60 * 1000;
  const calls = [];

  await assert.rejects(
    runRedelivery({
      environment: baseEnvironment,
      now: () => startedAt,
      logger: { info() {}, warn() {} },
      fetchImpl: async (input, init) => {
        const url = new URL(input);
        calls.push({ url, init });
        if (url.pathname.includes("/actions/workflows/")) {
          return successfulRunsResponse([continuityWorkflowRun(startedAt)]);
        }
        if (url.pathname.includes("/actions/runs/")) {
          return successfulRecoveryJobResponse();
        }
        if (init.method === "GET" && url.pathname.endsWith("/deliveries")) {
          return responseJson(
            Array.from({ length: MAX_DELIVERY_ATTEMPTS }, (_, index) =>
              rawDelivery({
                id: 100 + index,
                guid: "retained-poisoned-delivery",
                deliveredAt: new Date(oldAttempt + index).toISOString(),
                redelivery: index > 0,
              }),
            ),
          );
        }
        throw new Error(`Unexpected request: ${init.method} ${url.pathname}`);
      },
    }),
    new RegExp(`limit of ${MAX_DELIVERY_ATTEMPTS} unsuccessful attempts`),
  );

  assert.ok(oldAttempt >= startedAt - MAX_REDELIVERY_AGE_MS);
  assert.equal(
    calls.some(({ init }) => init.method === "POST" || init.method === "PATCH"),
    false,
  );
});

test("a complete run isolates Actions and hook credentials and mutates only redelivery attempts", async () => {
  const startedAt = Date.parse("2026-08-03T12:00:00.000Z");
  const continuityRun = continuityWorkflowRun(startedAt);
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    assert.equal(init.headers["X-GitHub-Api-Version"], API_VERSION);
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);

    if (url.pathname.includes("/actions/workflows/")) {
      assert.equal(
        init.headers.Authorization,
        `Bearer ${baseEnvironment.ACTIONS_TOKEN}`,
      );
      return successfulRunsResponse([continuityRun]);
    }
    if (url.pathname.includes("/actions/runs/")) {
      assert.equal(
        init.headers.Authorization,
        `Bearer ${baseEnvironment.ACTIONS_TOKEN}`,
      );
      return successfulRecoveryJobResponse();
    }

    assert.equal(
      init.headers.Authorization,
      `Bearer ${baseEnvironment.HOOK_TOKEN}`,
    );
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
          redelivery: true,
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
    continuityStartedAt: String(startedAt - 60_000),
    continuityRunId: "9001",
    deferredTargets: 0,
    staleTargetsSkipped: 0,
  });
  assert.equal(calls.at(-1).url.pathname.endsWith("/attempts"), true);
  assert.equal(
    calls.filter(({ url }) => url.pathname.endsWith("/deliveries")).length,
    2,
  );
  assert.equal(
    calls.some(({ url }) => url.pathname.includes("/actions/variables")),
    false,
  );
  assert.equal(messages.length, 1);
  assert.doesNotMatch(messages[0], /actions-token|hook-token|failed-guid/);
});

test("recovery performs one revalidation scan and drains a bounded oldest-first batch", async () => {
  const startedAt = Date.parse("2026-08-03T12:00:00.000Z");
  const expectedBatchSize = 10;
  const failures = Array.from({ length: expectedBatchSize + 2 }, (_, index) =>
    rawDelivery({
      id: 100 + index,
      guid: `batch-guid-${index}`,
      deliveredAt: new Date(
        startedAt - (expectedBatchSize + 2 - index) * 1_000,
      ).toISOString(),
    }),
  );
  let deliveryReads = 0;
  const postedIds = [];

  const result = await runRedelivery({
    environment: baseEnvironment,
    now: () => startedAt,
    logger: { info() {}, warn() {} },
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      if (url.pathname.includes("/actions/workflows/")) {
        return successfulRunsResponse([continuityWorkflowRun(startedAt)]);
      }
      if (url.pathname.includes("/actions/runs/")) {
        return successfulRecoveryJobResponse();
      }
      if (init.method === "GET" && url.pathname.endsWith("/deliveries")) {
        deliveryReads += 1;
        return responseJson(failures);
      }
      if (init.method === "POST" && url.pathname.endsWith("/attempts")) {
        postedIds.push(url.pathname.split("/").at(-2));
        return new Response(null, { status: 202 });
      }
      throw new Error(`Unexpected request: ${init.method} ${url.pathname}`);
    },
  });

  assert.equal(deliveryReads, 2);
  assert.deepEqual(
    postedIds,
    Array.from({ length: expectedBatchSize }, (_, index) =>
      String(100 + index),
    ),
  );
  assert.equal(result.redeliveries, expectedBatchSize);
  assert.equal(result.deferredTargets, 2);
});

test("revalidation reports newly observed failed targets as deferred backlog", async () => {
  const startedAt = Date.parse("2026-08-03T12:00:00.000Z");
  const initial = [
    rawDelivery({
      id: 100,
      guid: "initial-guid",
      deliveredAt: new Date(startedAt - 20_000).toISOString(),
    }),
  ];
  const refreshed = [
    ...initial,
    ...Array.from({ length: 11 }, (_, index) =>
      rawDelivery({
        id: 200 + index,
        guid: `new-guid-${index}`,
        deliveredAt: new Date(startedAt - 10_000 + index).toISOString(),
      }),
    ),
  ];
  let deliveryReads = 0;
  const postedIds = [];

  const result = await runRedelivery({
    environment: baseEnvironment,
    now: () => startedAt,
    logger: { info() {}, warn() {} },
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      if (url.pathname.includes("/actions/workflows/")) {
        return successfulRunsResponse([continuityWorkflowRun(startedAt)]);
      }
      if (url.pathname.includes("/actions/runs/")) {
        return successfulRecoveryJobResponse();
      }
      if (init.method === "GET" && url.pathname.endsWith("/deliveries")) {
        deliveryReads += 1;
        return responseJson(deliveryReads === 1 ? initial : refreshed);
      }
      if (init.method === "POST" && url.pathname.endsWith("/attempts")) {
        postedIds.push(url.pathname.split("/").at(-2));
        return new Response(null, { status: 202 });
      }
      throw new Error(`Unexpected request: ${init.method} ${url.pathname}`);
    },
  });

  assert.equal(deliveryReads, 2);
  assert.deepEqual(postedIds, ["100"]);
  assert.equal(result.redeliveries, 1);
  assert.equal(result.deferredTargets, 11);
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
      if (url.pathname.includes("/actions/workflows/")) {
        return successfulRunsResponse([continuityWorkflowRun(startedAt)]);
      }
      if (url.pathname.includes("/actions/runs/")) {
        return successfulRecoveryJobResponse();
      }
      if (init.method === "GET" && url.pathname.endsWith("/deliveries")) {
        return responseText(
          `[{"id":${exactDeliveryId},"guid":"large-failed-guid","delivered_at":"2026-08-03T11:30:00.000Z","status":"Internal Server Error","status_code":500,"redelivery":false}]`,
        );
      }
      if (init.method === "POST" && url.pathname.endsWith("/attempts")) {
        assert.equal(
          url.pathname,
          `/orgs/example-org/hooks/12345/deliveries/${exactDeliveryId}/attempts`,
        );
        assert.equal(
          init.headers.Authorization,
          `Bearer ${baseEnvironment.HOOK_TOKEN}`,
        );
        exactAttemptObserved = true;
        return new Response(null, { status: 202 });
      }
      throw new Error(`Unexpected request: ${init.method} ${url.pathname}`);
    },
  });

  assert.equal(exactAttemptObserved, true);
  assert.equal(result.redeliveries, 1);
});

test("a failed redelivery performs no repository-variable mutation", async () => {
  const startedAt = Date.parse("2026-08-03T12:00:00.000Z");
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (url.pathname.includes("/actions/workflows/")) {
      return successfulRunsResponse([continuityWorkflowRun(startedAt)]);
    }
    if (url.pathname.includes("/actions/runs/")) {
      return successfulRecoveryJobResponse();
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
    throw new Error(`Unexpected request: ${init.method} ${url.pathname}`);
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
    calls.some(({ url }) => url.pathname.includes("/actions/variables")),
    false,
  );
});

test("TOCTOU revalidation skips an obsolete target after success or a newer attempt", async () => {
  const startedAt = Date.parse("2026-08-03T12:00:00.000Z");
  const original = rawDelivery({
    id: 101,
    guid: "racing-guid",
    deliveredAt: "2026-08-03T11:30:00.000Z",
  });
  const cases = [
    [
      [
        original,
        rawDelivery({
          id: 102,
          guid: "racing-guid",
          deliveredAt: "2026-08-03T12:00:30.000Z",
          status: "OK",
          statusCode: 200,
          redelivery: true,
        }),
      ],
      "success",
    ],
    [
      [
        original,
        rawDelivery({
          id: 102,
          guid: "racing-guid",
          deliveredAt: "2026-08-03T12:00:30.000Z",
          redelivery: true,
        }),
      ],
      "new attempt",
    ],
  ];

  for (const [refreshed, description] of cases) {
    let deliveryReads = 0;
    let clockReads = 0;
    let posts = 0;
    const result = await runRedelivery({
      environment: baseEnvironment,
      now: () => {
        clockReads += 1;
        return clockReads === 1 ? startedAt : startedAt + 60_000;
      },
      logger: { info() {}, warn() {} },
      fetchImpl: async (input) => {
        const url = new URL(input);
        if (url.pathname.includes("/actions/workflows/")) {
          return successfulRunsResponse([continuityWorkflowRun(startedAt)]);
        }
        if (url.pathname.includes("/actions/runs/")) {
          return successfulRecoveryJobResponse();
        }
        if (url.pathname.endsWith("/deliveries")) {
          deliveryReads += 1;
          return responseJson(deliveryReads === 1 ? [original] : refreshed);
        }
        if (url.pathname.endsWith("/attempts")) {
          posts += 1;
          return new Response(null, { status: 202 });
        }
        throw new Error(`Unexpected request: ${url.pathname}`);
      },
    });

    assert.equal(deliveryReads, 2, description);
    assert.equal(clockReads, 4, description);
    assert.equal(posts, 0, description);
    assert.equal(result.redeliveries, 0, description);
    assert.equal(result.staleTargetsSkipped, 1, description);
  }
});

test("TOCTOU revalidation fails closed when the clock rolls back between scans", async () => {
  const startedAt = Date.parse("2026-08-03T12:00:00.000Z");
  const observations = [
    startedAt,
    startedAt + 10 * 60_000,
    startedAt + 60_000,
    startedAt + 60_000,
  ];
  let clockReads = 0;
  let posts = 0;

  await assert.rejects(
    runRedelivery({
      environment: baseEnvironment,
      now: () => observations[clockReads++],
      logger: { info() {}, warn() {} },
      fetchImpl: async (input) => {
        const url = new URL(input);
        if (url.pathname.includes("/actions/workflows/")) {
          return successfulRunsResponse([continuityWorkflowRun(startedAt)]);
        }
        if (url.pathname.includes("/actions/runs/")) {
          return successfulRecoveryJobResponse();
        }
        if (url.pathname.endsWith("/deliveries")) {
          return responseJson([
            rawDelivery({
              id: 101,
              guid: "clock-rollback-guid",
              deliveredAt: "2026-08-03T11:30:00.000Z",
            }),
          ]);
        }
        if (url.pathname.endsWith("/attempts")) {
          posts += 1;
          return new Response(null, { status: 202 });
        }
        throw new Error(`Unexpected request: ${url.pathname}`);
      },
    }),
    /clock moved backwards/,
  );

  assert.equal(posts, 0);
  assert.equal(clockReads, 3);
});

test("TOCTOU revalidation aborts when refreshed history loses its original", async () => {
  const startedAt = Date.parse("2026-08-03T12:00:00.000Z");
  let deliveryReads = 0;
  let posts = 0;

  await assert.rejects(
    runRedelivery({
      environment: baseEnvironment,
      now: () => startedAt,
      logger: { info() {}, warn() {} },
      fetchImpl: async (input) => {
        const url = new URL(input);
        if (url.pathname.includes("/actions/workflows/")) {
          return successfulRunsResponse([continuityWorkflowRun(startedAt)]);
        }
        if (url.pathname.includes("/actions/runs/")) {
          return successfulRecoveryJobResponse();
        }
        if (url.pathname.endsWith("/deliveries")) {
          deliveryReads += 1;
          return responseJson([
            rawDelivery({
              id: deliveryReads === 1 ? 101 : 102,
              guid: "truncated-during-race",
              deliveredAt: "2026-08-03T11:30:00.000Z",
              redelivery: deliveryReads > 1,
            }),
          ]);
        }
        if (url.pathname.endsWith("/attempts")) {
          posts += 1;
          return new Response(null, { status: 202 });
        }
        throw new Error(`Unexpected request: ${url.pathname}`);
      },
    }),
    /exactly one original delivery/,
  );
  assert.equal(deliveryReads, 2);
  assert.equal(posts, 0);
});

test("rate-limit errors are explicit and never include either token", async () => {
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
      !error.message.includes(baseEnvironment.ACTIONS_TOKEN) &&
      !error.message.includes(baseEnvironment.HOOK_TOKEN),
  );
});

test("organization-hook 404 omits obsolete OAuth scope diagnostics", async () => {
  await assert.rejects(
    fetchDeliveriesSince({
      token: baseEnvironment.HOOK_TOKEN,
      organizationName: baseEnvironment.ORGANIZATION_NAME,
      organizationId: baseEnvironment.ORGANIZATION_ID,
      hookId: baseEnvironment.HOOK_ID,
      cutoff: Date.now() - 60_000,
      startedAt: Date.now(),
      fetchImpl: async () =>
        responseJson(
          { message: "Not Found" },
          {
            status: 404,
            headers: {
              "x-oauth-scopes": "admin:org_hook, repo, workflow",
              "x-github-request-id": "request-scope",
            },
          },
        ),
    }),
    (error) =>
      error instanceof GitHubApiError &&
      /request-id=request-scope/.test(error.message) &&
      !/admin:org_hook|repo, workflow|oauth/i.test(error.message) &&
      !error.message.includes(baseEnvironment.HOOK_TOKEN),
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
      !error.message.includes(baseEnvironment.ACTIONS_TOKEN) &&
      !error.message.includes(baseEnvironment.HOOK_TOKEN),
  );
});
