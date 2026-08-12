import assert from "node:assert/strict";
import test from "node:test";

import {
  readRequiredContextSources,
  validateRequiredContextPolicy,
} from "./required-contexts-policy.mjs";

const sources = await readRequiredContextSources();

function mutated(path, before, after) {
  const source = sources[path];
  assert.equal(typeof source, "string", `unknown policy source: ${path}`);
  assert.ok(source.includes(before), `mutation anchor missing in ${path}`);
  return {
    ...sources,
    [path]: source.replace(before, after),
  };
}

function rejectsMutation(path, before, after) {
  assert.throws(() =>
    validateRequiredContextPolicy(mutated(path, before, after)),
  );
}

test("the current seven required contexts satisfy one canonical contract", () => {
  assert.doesNotThrow(() => validateRequiredContextPolicy(sources));
});

test("the relay required context pins NEXT as the expanded runtime signer", () => {
  rejectsMutation(
    "workers/github-slack-relay/wrangler.jsonc",
    '"SLACK_RELAY_SIGNING_ACTIVE_SLOT": "next"',
    '"SLACK_RELAY_SIGNING_ACTIVE_SLOT": "current"',
  );
});

test("the privileged relay DAG cannot bypass or drift from its required predecessor", () => {
  rejectsMutation(
    ".github/workflows/github-slack-integration.yml",
    "    needs: verify\n    permissions:",
    "    permissions:",
  );
  rejectsMutation(
    ".github/workflows/github-slack-integration.yml",
    "    needs: deploy\n    permissions:",
    "    needs: verify\n    permissions:",
  );
  rejectsMutation(
    ".github/workflows/github-slack-integration.yml",
    "          workers/github-slack-relay/node_modules/.bin/wrangler deploy \\",
    "          echo skipped \\",
  );
  rejectsMutation(
    ".github/workflows/github-slack-integration.yml",
    "          scripts/slack-workflow-monitor.test.mjs\n",
    "",
  );
});

test("every required workflow keeps pull_request and merge_group exact", () => {
  for (const path of [
    ".github/workflows/dependency-review.yml",
    ".github/workflows/codeql.yml",
    ".github/workflows/zizmor.yml",
    ".github/workflows/pages.yml",
    ".github/workflows/github-slack-integration.yml",
    ".github/workflows/slack-github-integration.yml",
  ]) {
    rejectsMutation(
      path,
      "  merge_group:\n    types:\n      - checks_requested",
      "  merge_group:\n    types:\n      - closed",
    );
    rejectsMutation(
      path,
      "  pull_request:\n    branches:",
      "  pull_request:\n    paths-ignore:\n      - '**'\n    branches:",
    );
    rejectsMutation(
      path,
      "on:\n",
      "on:\n  pull_request_target:\n    branches:\n      - main\n",
    );
  }
});

test("job names and job-level conditions cannot turn required checks green by skipping", () => {
  const jobs = [
    [
      ".github/workflows/dependency-review.yml",
      "    name: Dependency Review",
      "    name: Dependency Review\n    if: false",
    ],
    [
      ".github/workflows/codeql.yml",
      "    name: Analyze ${{ matrix.language }}",
      "    name: Analyze ${{ matrix.language }}\n    if: false",
    ],
    [
      ".github/workflows/zizmor.yml",
      "    name: Run zizmor",
      "    name: Run zizmor\n    if: false",
    ],
    [
      ".github/workflows/pages.yml",
      "    name: Build Pages artifact",
      "    name: Build Pages artifact\n    if: false",
    ],
    [
      ".github/workflows/github-slack-integration.yml",
      "    name: Verify GitHub Slack relay",
      "    name: Verify GitHub Slack relay\n    if: false",
    ],
    [
      ".github/workflows/slack-github-integration.yml",
      "    if: github.event_name != 'schedule' || github.event.schedule == '17 7 * * *'",
      "    if: false",
    ],
  ];
  for (const [path, before, after] of jobs) {
    rejectsMutation(path, before, after);
  }

  for (const [path, name] of [
    [".github/workflows/dependency-review.yml", "Dependency Review"],
    [".github/workflows/codeql.yml", "Analyze ${{ matrix.language }}"],
    [".github/workflows/zizmor.yml", "Run zizmor"],
    [".github/workflows/pages.yml", "Build Pages artifact"],
    [
      ".github/workflows/github-slack-integration.yml",
      "Verify GitHub Slack relay",
    ],
    [
      ".github/workflows/slack-github-integration.yml",
      "Verify Slack workflow app",
    ],
  ]) {
    rejectsMutation(path, `    name: ${name}`, `    name: ${name} changed`);
  }
});

test("job-level and critical-step continue-on-error are forbidden", () => {
  const jobs = [
    [".github/workflows/dependency-review.yml", "    timeout-minutes: 10"],
    [".github/workflows/codeql.yml", "    timeout-minutes: 20"],
    [".github/workflows/zizmor.yml", "    timeout-minutes: 15"],
    [".github/workflows/pages.yml", "    timeout-minutes: 15"],
    [
      ".github/workflows/github-slack-integration.yml",
      "    timeout-minutes: 20",
    ],
    [
      ".github/workflows/slack-github-integration.yml",
      "    timeout-minutes: 10",
    ],
  ];
  for (const [path, anchor] of jobs) {
    rejectsMutation(path, anchor, `${anchor}\n    continue-on-error: true`);
  }

  for (const [path, step] of [
    [
      ".github/workflows/dependency-review.yml",
      "      - name: Review pull request dependencies",
    ],
    [
      ".github/workflows/codeql.yml",
      "      - name: Enforce zero CodeQL findings",
    ],
    [
      ".github/workflows/zizmor.yml",
      "      - name: Enforce zero active zizmor findings",
    ],
    [".github/workflows/pages.yml", "      - name: Upload Pages artifact"],
    [
      ".github/workflows/github-slack-integration.yml",
      "      - name: Verify Cloudflare relay",
    ],
    [
      ".github/workflows/slack-github-integration.yml",
      "      - name: Audit Slack workflow app dependencies",
    ],
  ]) {
    rejectsMutation(path, step, `${step}\n        continue-on-error: true`);
  }
});

test("critical actions, inputs, paths, and failure propagation stay exact", () => {
  for (const [path, before, after] of [
    [
      ".github/workflows/dependency-review.yml",
      "          fail-on-severity: low",
      "          fail-on-severity: high",
    ],
    [
      ".github/workflows/codeql.yml",
      "          sarif-directory: ${{ runner.temp }}/codeql-results",
      "          sarif-directory: ${{ runner.temp }}/missing",
    ],
    [
      ".github/workflows/zizmor.yml",
      "            --no-ignores \\",
      "            --no-exit-codes \\",
    ],
    [
      ".github/workflows/pages.yml",
      "          path: site",
      "          path: .",
    ],
    [
      ".github/workflows/github-slack-integration.yml",
      "          npm test",
      "          npm test || true",
    ],
    [
      ".github/workflows/github-slack-integration.yml",
      "          deno task --frozen check",
      "          deno task --frozen check || true",
    ],
    [
      ".github/workflows/github-slack-integration.yml",
      "        run: deno task --frozen audit",
      "        run: deno task --frozen audit || true",
    ],
    [
      ".github/workflows/slack-github-integration.yml",
      "        run: deno task --frozen audit",
      "        run: deno task --frozen audit || true",
    ],
  ]) {
    rejectsMutation(path, before, after);
  }

  rejectsMutation(
    ".github/workflows/codeql.yml",
    "        uses: ./codeql-sarif-gate",
    "        uses: ./missing-gate",
  );
  rejectsMutation(
    ".github/workflows/codeql.yml",
    "          - language: actions",
    "          - language: actions-disabled",
  );
  rejectsMutation(
    ".github/workflows/dependency-review.yml",
    "          persist-credentials: false",
    "          persist-credentials: true",
  );
  rejectsMutation(
    ".github/workflows/dependency-review.yml",
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    "actions/checkout@0000000000000000000000000000000000000000",
  );
});

test("the two independent workflows must keep invoking and policing the contract", () => {
  for (const path of [
    ".github/workflows/dependency-review.yml",
    ".github/workflows/codeql.yml",
  ]) {
    rejectsMutation(
      path,
      "      - name: Validate all required context contracts\n        run: node scripts/required-contexts-policy.mjs\n",
      "",
    );
  }
});

test("NODE_OPTIONS cannot silently select or skip policy tests", () => {
  rejectsMutation(
    ".github/workflows/dependency-review.yml",
    "permissions: {}",
    'permissions: {}\nenv:\n  NODE_OPTIONS: "--test-name-pattern=unrelated"',
  );
});

test("Zizmor config cannot disable, ignore, or remap an audit", () => {
  for (const injected of [
    "    disable: true\n",
    "    ignore:\n      - codeql.yml\n",
    "    remap:\n      severity: informational\n",
  ]) {
    rejectsMutation(
      ".github/zizmor.yml",
      "rules:\n",
      `rules:\n  dangerous-triggers:\n${injected}`,
    );
  }
});

test("YAML aliases cannot hide a structurally different value", () => {
  rejectsMutation(
    ".github/workflows/pages.yml",
    "permissions: {}",
    "permissions: &workflow-permissions {}\nx-policy-alias: *workflow-permissions",
  );
});
