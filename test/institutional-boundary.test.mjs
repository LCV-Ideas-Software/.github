import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const migratedOperationalPaths = [
  ".github/workflows/alerts-watchdog.yml",
  ".github/workflows/github-linear-reconciliation.yml",
  ".github/workflows/github-slack-integration.yml",
  ".github/workflows/github-slack-webhook-redelivery.yml",
  ".github/workflows/linear-freshness.yml",
  ".github/workflows/slack-d1-disposable-reaper.yml",
  "docs/GITHUB_LINEAR_RECONCILIATION.md",
  "docs/GITHUB_SLACK_INTEGRATION.md",
  "docs/adr/ADR-002-alertas-v2.md",
  "docs/superpowers",
  "dependabot-automerge",
  "scripts/github-slack-hook-audit.mjs",
  "scripts/github-slack-hook-audit.test.mjs",
  "scripts/github-slack-webhook-redelivery.mjs",
  "scripts/github-slack-webhook-redelivery.test.mjs",
  "scripts/slack-relay-d1-remote-proof.test.mjs",
  "scripts/verify-slack-relay-d1-remote.mjs",
  "test/dependabot-automerge.test.mjs",
  "tools/github-linear-reconciler",
  "workers/github-slack-relay",
];

const retainedPublicPaths = [
  ".github/workflows/cloudflare-pages.yml",
  ".github/workflows/codeql.yml",
  ".github/workflows/dependency-review.yml",
  ".github/workflows/linear-release.yml",
  ".github/workflows/pages.yml",
  ".github/workflows/scorecard.yml",
  ".github/workflows/zizmor.yml",
  ".github/ISSUE_TEMPLATE",
  ".github/DISCUSSION_TEMPLATE",
  "profile/README.md",
  "site/index.html",
  "site/sponsor/index.html",
  "INBOUND.md",
  "SECURITY.md",
];

test("main contains no migrated operational implementation", () => {
  for (const path of migratedOperationalPaths) {
    assert.equal(
      existsSync(join(repositoryRoot, path)),
      false,
      `${path} must be absent`,
    );
  }
});

test("main retains the public institutional surface", () => {
  for (const path of retainedPublicPaths) {
    assert.equal(
      existsSync(join(repositoryRoot, path)),
      true,
      `${path} must remain`,
    );
  }
});

test("Linear Release remains a repository-local official writer", () => {
  const workflow = readFileSync(
    join(repositoryRoot, ".github", "workflows", "linear-release.yml"),
    "utf8",
  );

  assert.match(workflow, /push:\s*\n\s*branches:\s*\n\s*- main/);
  assert.match(workflow, /^permissions: \{\}$/m);
  assert.match(workflow, /environment: linear-release/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /queue: max/);
  assert.doesNotMatch(workflow, /cancel-in-progress:/);
  assert.doesNotMatch(workflow, /continue-on-error:/);
  assert.match(
    workflow,
    /linear\/linear-release-action@0a25abab892a91062ebf42260dbb2ce6277aa205/,
  );
  assert.doesNotMatch(workflow, /workflow_call:/);
  assert.doesNotMatch(workflow, /\b(?:curl|wget|Invoke-WebRequest)\b/);
  assert.doesNotMatch(
    workflow,
    /(?:github-slack|github-linear|reconciliation)/i,
  );
});

test("only active public workflows and their lockfile remain versioned", () => {
  const workflows = readdirSync(
    join(repositoryRoot, ".github", "workflows"),
  ).sort();
  assert.deepEqual(workflows, [
    "actions.lock",
    "cloudflare-pages.yml",
    "codeql.yml",
    "dependency-review.yml",
    "linear-release.yml",
    "pages.yml",
    "scorecard.yml",
    "zizmor.yml",
  ]);
});

test("proprietary terms preserve external ownership and stay repository-scoped", () => {
  const license = readFileSync(join(repositoryRoot, "LICENSE"), "utf8");
  const contributing = readFileSync(
    join(repositoryRoot, "CONTRIBUTING.md"),
    "utf8",
  );
  const inbound = readFileSync(join(repositoryRoot, "INBOUND.md"), "utf8");
  const pullRequestTemplate = readFileSync(
    join(repositoryRoot, ".github", "pull_request_template.md"),
    "utf8",
  );

  assert.match(license, /LCV-owned original contents/i);
  assert.match(
    license,
    /does\s+not claim ownership of third-party or contributor-owned material/i,
  );
  assert.match(
    inbound,
    /applies only when the target repository is `LCV-Ideas-Software\/\.github`/,
  );
  assert.match(
    inbound,
    /opening an issue or pull request does not transfer copyright/i,
  );
  assert.match(
    inbound,
    /will not be merged unless a separate written inbound license or copyright assignment has been executed and verified/i,
  );
  assert.doesNotMatch(contributing, /inbound license|copyright assignment/i);
  assert.doesNotMatch(
    pullRequestTemplate,
    /inbound license|copyright assignment|LCV-Ideas-Software\/\.github/i,
  );

  for (const path of [
    "NOTICE",
    "README.md",
    "THIRDPARTY.md",
    "profile/README.md",
  ]) {
    assert.match(
      readFileSync(join(repositoryRoot, path), "utf8"),
      /LCV-owned\s+original content/i,
      `${path} must limit the ownership claim to LCV-owned material`,
    );
  }
});
