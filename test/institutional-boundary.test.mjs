import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
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
  ".github/workflows/linear-release.yml",
  ".github/workflows/slack-d1-disposable-reaper.yml",
  "docs/GITHUB_LINEAR_RECONCILIATION.md",
  "docs/GITHUB_SLACK_INTEGRATION.md",
  "docs/adr/ADR-002-alertas-v2.md",
  "docs/superpowers",
  "scripts/github-slack-hook-audit.mjs",
  "scripts/github-slack-hook-audit.test.mjs",
  "scripts/github-slack-webhook-redelivery.mjs",
  "scripts/github-slack-webhook-redelivery.test.mjs",
  "scripts/slack-relay-d1-remote-proof.test.mjs",
  "scripts/verify-slack-relay-d1-remote.mjs",
  "tools/github-linear-reconciler",
  "workers/github-slack-relay",
];

const retainedPublicPaths = [
  ".github/workflows/cloudflare-pages.yml",
  ".github/workflows/codeql.yml",
  ".github/workflows/dependency-review.yml",
  ".github/workflows/pages.yml",
  ".github/workflows/scorecard.yml",
  ".github/workflows/zizmor.yml",
  ".github/ISSUE_TEMPLATE",
  ".github/DISCUSSION_TEMPLATE",
  "profile/README.md",
  "site/index.html",
  "site/sponsor/index.html",
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

test("only active public workflows and their lockfile remain versioned", () => {
  const workflows = readdirSync(
    join(repositoryRoot, ".github", "workflows"),
  ).sort();
  assert.deepEqual(workflows, [
    "actions.lock",
    "cloudflare-pages.yml",
    "codeql.yml",
    "dependency-review.yml",
    "pages.yml",
    "scorecard.yml",
    "zizmor.yml",
  ]);
});
