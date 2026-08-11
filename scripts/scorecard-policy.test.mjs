import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const POLICY_URL = new URL("./scorecard-policy.jq", import.meta.url);
const POLICY_PATH = fileURLToPath(POLICY_URL);
const NO_FILE = "no file associated with this alert";
const BOOTSTRAP_BRANCH_PROTECTION_MESSAGE =
  "score is 3: branch protection is not maximal on development and all release branches:\n" +
  "Warn: could not determine whether codeowners review is allowed\n" +
  "Warn: no status checks found to merge onto branch 'main'\n" +
  "Warn: PRs are not required to make changes on branch 'main'; or we don't have data to detect it.If you think it might be the latter, make sure to run Scorecard with a PAT or use Repo Rules (that are always public) instead of Branch Protection settings\n" +
  "Click Remediation section below to solve this issue";
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

function tokenMessage(filename, { local = false, score = 2 } = {}) {
  const target = local
    ? `https://app.stepsecurity.io/secureworkflow/file://./${filename}/unknown?enable=permissions`
    : `https://app.stepsecurity.io/secureworkflow/github.com/LCV-Ideas-Software/.github/${filename}/main?enable=permissions`;
  return (
    `score is ${score}: topLevel permissions set to 'write-all'\n` +
    `Remediation tip: Visit [https://app.stepsecurity.io/secureworkflow](${target}).\n` +
    "Tick the 'Restrict permissions for GITHUB_TOKEN'\n" +
    "Untick other options\n" +
    "NOTE: If you want to resolve multiple issues at once, you can visit [https://app.stepsecurity.io/securerepo](https://app.stepsecurity.io/securerepo) instead.\n" +
    "Click Remediation section below for further remediation help"
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

function runPolicy(input, { event = "pull_request", program } = {}) {
  const args =
    program === undefined
      ? ["-e", "--arg", "event", event, "-f", POLICY_PATH]
      : ["-e", "--arg", "event", event, program];
  return spawnSync("jq", args, {
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

test("only the exact transitional write-all signature passes", () => {
  const token = result("TokenPermissionsID", {
    message: tokenMessage("codeql.yml"),
    snippet: "write-all",
    uri: ".github/workflows/codeql.yml",
  });
  const localToken = result("TokenPermissionsID", {
    message: tokenMessage("pages.yml", { local: true, score: 2 }),
    snippet: "write-all",
    uri: ".github/workflows/pages.yml",
  });
  assertAccepted(sarif([token, localToken]));
  assertAccepted(
    sarif([
      result("TokenPermissionsID", {
        message: tokenMessage("pages.yml", { local: true, score: 0 }),
        snippet: "write-all",
        uri: ".github/workflows/pages.yml",
      }),
      result("TokenPermissionsID", {
        message: tokenMessage("pages.yml", { local: true, score: 10 }),
        snippet: "write-all",
        uri: ".github/workflows/pages.yml",
      }),
    ]),
  );

  for (const rejected of [
    { ...token, ruleId: "OtherID" },
    result("TokenPermissionsID", {
      message: tokenMessage("codeql.yml"),
      snippet: "contents: write",
      uri: ".github/workflows/codeql.yml",
    }),
    result("TokenPermissionsID", {
      message: tokenMessage("codeql.yml"),
      snippet: "write-all",
      uri: "scripts/not-a-workflow.yml",
    }),
    result("TokenPermissionsID", {
      message: "score is 2: another permissions finding",
      snippet: "write-all",
      uri: ".github/workflows/codeql.yml",
    }),
    result("TokenPermissionsID", {
      message: `${tokenMessage("codeql.yml")}\nWarn: another permission failure`,
      snippet: "write-all",
      uri: ".github/workflows/codeql.yml",
    }),
    result("TokenPermissionsID", {
      message: tokenMessage("pages.yml"),
      snippet: "write-all",
      uri: ".github/workflows/codeql.yml",
    }),
    result("TokenPermissionsID", {
      message: tokenMessage("pages.yml", { local: true, score: 17 }),
      snippet: "write-all",
      uri: ".github/workflows/pages.yml",
    }),
    result("TokenPermissionsID", {
      message: tokenMessage("pages.yml", { local: true, score: 11 }),
      snippet: "write-all",
      uri: ".github/workflows/pages.yml",
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

test("the bootstrap BranchProtection signature is exact, not a prefix", () => {
  const bootstrap = result("BranchProtectionID", {
    message: BOOTSTRAP_BRANCH_PROTECTION_MESSAGE,
  });
  assertAccepted(sarif([bootstrap]));
  assertAccepted(sarif([bootstrap]), { event: "merge_group" });
  for (const trustedEvent of ["push", "schedule", "workflow_dispatch"]) {
    assertRejected(sarif([bootstrap]), { event: trustedEvent });
  }

  const warningMutation = structuredClone(bootstrap);
  warningMutation.message.text = warningMutation.message.text.replace(
    "\nClick Remediation section below",
    "\nWarn: an additional branch protection failure\nClick Remediation section below",
  );
  assertRejected(sarif([warningMutation]));
});

test("accepts only the exact trusted repository-policy baseline", () => {
  const trustedBaseline = [
    result("BranchProtectionID", {
      message: TRUSTED_BRANCH_PROTECTION_MESSAGE,
    }),
    result("CodeReviewID", { message: codeReviewBaselineMessage(29) }),
    result("CIIBestPracticesID", { message: CII_BASELINE_MESSAGE }),
  ];

  for (const event of ["push", "schedule", "workflow_dispatch"]) {
    assertAccepted(sarif(trustedBaseline), { event });
  }
  for (const event of ["pull_request", "merge_group"]) {
    assertRejected(sarif(trustedBaseline), { event });
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
  const token = result("TokenPermissionsID", {
    message: tokenMessage("codeql.yml"),
    snippet: "write-all",
    uri: ".github/workflows/codeql.yml",
  });
  const unknown = result("UnexpectedSecurityFindingID", {
    message: "score is 0: actionable finding",
  });
  assertRejected(sarif([token, unknown]));
});

test("removing later exceptions preserves the transitional token decision", async () => {
  const policy = await readFile(POLICY_URL, "utf8");
  const firstTransitionalBranch = policy.indexOf(
    '\n    elif .ruleId == "BranchProtectionID" then',
  );
  const finalElse = policy.indexOf(
    "\n    else\n      false\n    end;",
    firstTransitionalBranch,
  );
  assert.ok(firstTransitionalBranch >= 0);
  assert.ok(finalElse > firstTransitionalBranch);
  const tokenOnly =
    policy.slice(0, firstTransitionalBranch) + policy.slice(finalElse);

  assertAccepted(
    sarif([
      result("TokenPermissionsID", {
        message: tokenMessage("codeql.yml"),
        snippet: "write-all",
        uri: ".github/workflows/codeql.yml",
      }),
    ]),
    { program: tokenOnly },
  );
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
