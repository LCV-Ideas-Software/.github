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

  assert.match(
    license,
    /original\s+contents\s+of\s+those\s+revisions\s+owned\s+by\s+LCV\s+Ideas\s+&\s+Software/i,
  );
  assert.match(
    license,
    /does\s+not\s+claim\s+ownership\s+of\s+third-party\s+or\s+contributor-owned\s+material/i,
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

  // Each guarded document must carry its approved ownership sentence directly
  // after the specific sentence or heading that introduces it. The pair is
  // checked for adjacency on whitespace-normalized text, so Markdown reflow is
  // irrelevant while nothing can be inserted between the two.
  //
  // Three punctuation-based anchors were tried before this and all three fell
  // to a negating preface, because every one of them tried to infer where a
  // sentence begins from the characters around it: a bare newline ("It is
  // false that\nThe original content ..."), any paragraph break ("The
  // following statement is false:\n\nThe original content ..."), and any
  // period ("It is false, e.g. The original content ..."). Inferring sentence
  // structure from punctuation is a losing game; naming the expected
  // predecessor ends it, because a preface can no longer reach the clause
  // without displacing text the guard also verifies.
  //
  // A rewrite of the introducing sentence fails this test on purpose: the
  // ownership paragraph is legal text, so changing it should require touching
  // the guard and getting the change reviewed.
  const normalize = (text) => text.replace(/\s+/g, " ").trim();

  const ownershipPairs = {
    NOTICE: [
      "maintained by LCV Ideas & Software.",
      "Its original content owned by LCV Ideas & Software is proprietary.",
    ],
    "README.md": [
      "Copyright © 2026 LCV Ideas & Software.",
      "The original content of this repository owned by LCV Ideas & Software is proprietary and **all rights are reserved**.",
    ],
    "THIRDPARTY.md": [
      "## This repository",
      "The original content of this repository owned by LCV Ideas & Software is proprietary to it.",
    ],
    "profile/README.md": [
      "Copyright © 2026 LCV Ideas &amp; Software.",
      "The original content of this repository owned by LCV Ideas &amp; Software is proprietary and **all rights are reserved**.",
    ],
  };

  const carriesClause = (text, [precededBy, clause]) =>
    normalize(text).includes(`${normalize(precededBy)} ${normalize(clause)}`);

  const notice = ownershipPairs.NOTICE;

  // Anything wedged between the introducing sentence and the clause breaks the
  // adjacency, which is what makes a negating preface unable to bind it.
  for (const reversed of [
    `${notice[0]} It is false that ${notice[1]}`,
    `${notice[0]} It is false, e.g. ${notice[1]}`,
    `${notice[0]}\n\nThe following statement is false:\n\n${notice[1]}`,
    `${notice[0]}\nNo one may claim that\n${notice[1]}`,
    "Its original content is not owned by LCV Ideas & Software and is proprietary.",
    "No original content owned by LCV Ideas & Software is proprietary.",
  ]) {
    assert.ok(
      !carriesClause(reversed, notice),
      `the ownership guard must reject a reversed clause: ${reversed}`,
    );
  }

  // Reflow between and inside the two parts stays acceptable.
  for (const legitimate of [
    `${notice[0]} ${notice[1]}`,
    `${notice[0]}\nIts original\ncontent owned by LCV Ideas & Software is\nproprietary.`,
  ]) {
    assert.ok(
      carriesClause(legitimate, notice),
      "the ownership guard must accept the approved sentence pair",
    );
  }

  for (const [path, pair] of Object.entries(ownershipPairs)) {
    assert.ok(
      carriesClause(readFileSync(join(repositoryRoot, path), "utf8"), pair),
      `${path} must carry the approved ownership sentence directly after "${pair[0]}"`,
    );
  }
});
