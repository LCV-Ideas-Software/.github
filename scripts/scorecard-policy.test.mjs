import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const POLICY_URL = new URL("./scorecard-policy.jq", import.meta.url);
const POLICY_PATH = fileURLToPath(POLICY_URL);
const NO_FILE = "no file associated with this alert";
const TRUSTED_BRANCH_PROTECTION_MESSAGE =
  "score is 3: branch protection is not maximal on development and all release branches:\n" +
  "Warn: 'stale review dismissal' is disabled on branch 'main'\n" +
  "Warn: branch 'main' does not require approvers\n" +
  "Warn: codeowners review is not required on branch 'main'\n" +
  "Warn: 'last push approval' is disabled on branch 'main'\n" +
  "Warn: 'up-to-date branches' is disabled on branch 'main'\n" +
  "Click Remediation section below to solve this issue";
const CII_BASELINE_MESSAGE =
  "score is 0: no effort to earn an OpenSSF best practices badge detected\n" +
  "Click Remediation section below to solve this issue";

function codeReviewBaselineMessage(total) {
  return (
    `score is 0: Found 0/${total} approved changesets -- score normalized to 0\n` +
    "Click Remediation section below to solve this issue"
  );
}

function result(ruleId, { message, snippet = null, uri = NO_FILE }) {
  return {
    ruleId,
    message: { text: message },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri },
          region: { snippet: { text: snippet } },
        },
      },
    ],
  };
}

function sarif(results = []) {
  return {
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "Scorecard",
            semanticVersion: "v5.5.0",
            rules: [],
          },
        },
        results,
      },
    ],
  };
}

function runPolicy(input, { event = "push" } = {}) {
  return spawnSync("jq", ["-e", "--arg", "event", event, "-f", POLICY_PATH], {
    encoding: "utf8",
    input: typeof input === "string" ? input : JSON.stringify(input),
    windowsHide: true,
  });
}

function assertAccepted(input, options) {
  const outcome = runPolicy(input, options);
  assert.ifError(outcome.error);
  assert.equal(outcome.status, 0, outcome.stderr);
  assert.equal(outcome.stdout.trim(), "true");
}

function assertRejected(input, options) {
  const outcome = runPolicy(input, options);
  assert.ifError(outcome.error);
  assert.notEqual(
    outcome.status,
    0,
    `policy unexpectedly accepted input: ${JSON.stringify(input)}`,
  );
}

test("valid Scorecard SARIF with no findings passes", () => {
  assertAccepted(sarif());
});

test("missing, null, primitive, and malformed SARIF shapes fail closed", () => {
  for (const candidate of [
    null,
    true,
    7,
    "sarif",
    [],
    {},
    { version: "2.1.0" },
    { version: "2.1.0", runs: null },
    { version: "2.1.0", runs: "not-an-array" },
    { version: "2.1.0", runs: [] },
    { version: "2.1.0", runs: [null] },
    {
      version: "2.1.0",
      runs: [{ tool: { driver: { name: "Scorecard", rules: [] } } }],
    },
    sarif([null]),
    sarif([{ ruleId: "UnknownID" }]),
  ]) {
    assertRejected(candidate);
  }
  assertRejected("{");
});

test("TokenPermissions and PinnedDependencies findings always fail", () => {
  for (const rejected of [
    result("TokenPermissionsID", {
      message: "score is 0: workflow token permissions are excessive",
      snippet: "write-all",
      uri: ".github/workflows/codeql.yml",
    }),
    result("PinnedDependenciesID", {
      message:
        "score is 7: npmCommand not pinned by hash\n" +
        "Click Remediation section below to solve this issue",
      snippet: "npm install wrangler@" + "latest",
      uri: ".github/workflows/cloudflare-pages.yml",
    }),
  ]) {
    assertRejected(sarif([rejected]));
  }
});

test("accepts only the exact trusted repository-policy baseline", () => {
  const trustedBaseline = [
    result("BranchProtectionID", {
      message: TRUSTED_BRANCH_PROTECTION_MESSAGE,
    }),
    result("CodeReviewID", { message: codeReviewBaselineMessage(29) }),
    result("CIIBestPracticesID", { message: CII_BASELINE_MESSAGE }),
  ];

  for (const event of ["push", "schedule"]) {
    assertAccepted(sarif(trustedBaseline), { event });
  }
  for (const event of ["pull_request", "merge_group", "workflow_dispatch"]) {
    assertRejected(sarif(trustedBaseline), { event });
    assertRejected(sarif(), { event });
  }

  for (const mutation of [
    result("BranchProtectionID", {
      message: `${TRUSTED_BRANCH_PROTECTION_MESSAGE}\nWarn: status checks missing`,
    }),
    result("CodeReviewID", { message: codeReviewBaselineMessage(0) }),
    result("CodeReviewID", {
      message:
        "score is 1: Found 1/29 approved changesets -- score normalized to 1\n" +
        "Click Remediation section below to solve this issue",
    }),
    result("CIIBestPracticesID", {
      message: `${CII_BASELINE_MESSAGE}\nWarn: altered result`,
    }),
  ]) {
    assertRejected(sarif([mutation]), { event: "push" });
  }
});

test("an unapproved finding fails even beside approved findings", () => {
  const approved = result("BranchProtectionID", {
    message: TRUSTED_BRANCH_PROTECTION_MESSAGE,
  });
  const unknown = result("UnexpectedSecurityFindingID", {
    message: "score is 0: actionable finding",
  });
  assertRejected(sarif([approved, unknown]));
});

test("does not authorize unremediated or unknown quality findings", async () => {
  const policy = await readFile(POLICY_URL, "utf8");
  assert.doesNotMatch(policy, /\.ruleId == "FuzzingID"/);
  for (const ruleId of ["FuzzingID", "UnexpectedQualityID"]) {
    assertRejected(
      sarif([
        result(ruleId, {
          message: `score is 0: unapproved ${ruleId} finding`,
        }),
      ]),
    );
  }
});
