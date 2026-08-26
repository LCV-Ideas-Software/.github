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

  // The ownership statement is verified as a whole block, not searched for.
  //
  // Every earlier version asked "does this text appear somewhere in the file?",
  // which is fail-open: it says nothing about what surrounds the match. Five
  // rounds of review walked that consequence down one counterexample at a time
  // - a bare newline, a paragraph break, an abbreviation period, and finally a
  // negating preface quoting the approved pair verbatim. Each fix closed one
  // wrapper and left the next one available, because containment cannot
  // constrain context.
  //
  // So the check is inverted to fail-closed. Each document declares WHERE its
  // ownership paragraph lives - a heading, or an index into the block sequence
  // - and the paragraph found at that location must EQUAL the approved text
  // once whitespace is normalized. Nothing may be added to it, quoted around
  // it inside the block, or removed from it. Reflow remains free because the
  // comparison normalizes whitespace.
  //
  // Boundary, stated because it is real and not worth another round: text in a
  // DIFFERENT block cannot be constrained by any test of this kind, and an
  // author with commit access could edit this file as easily as the documents
  // it guards. What this test buys is that the governing paragraph cannot
  // drift, be padded, or be quoted-and-reframed in place without failing.
  const normalize = (text) => text.replace(/\s+/g, " ").trim();

  const blocksOf = (text) =>
    text
      .split(/\n\s*\n/)
      .map((block) => block.trim())
      .filter(Boolean);

  // Locates the governing paragraph: the block after the named heading, or the
  // block at the given index when the document has no headings.
  const ownershipParagraphOf = (text, { heading, index }) => {
    if (!heading) return blocksOf(text)[index];
    const start = text.indexOf(heading);
    if (start === -1) return undefined;
    const rest = text.slice(start + heading.length);
    const nextHeading = rest.indexOf("\n## ");
    const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
    return blocksOf(section)[index];
  };

  const ownershipParagraphs = [
    {
      path: "NOTICE",
      heading: null,
      index: 1,
      paragraph:
        "This repository hosts organization profile, static site, sponsorship, and community-health material maintained by LCV Ideas & Software. Its original content owned by LCV Ideas & Software is proprietary. This notice does not claim copyright in third-party or contributor-owned material, which may be accepted only under separate documented written terms and the repository-local process in INBOUND.md. The repository remains public so GitHub can provide the special organization-profile and default community-health features of a repository named `.github`.",
    },
    {
      path: "README.md",
      heading: "## License",
      index: 0,
      paragraph:
        "Copyright © 2026 LCV Ideas & Software. The original content of this repository owned by LCV Ideas & Software is proprietary and **all rights are reserved**. Third-party and contributor-owned material remains subject to its own documented terms. Public visibility permits viewing and forking through GitHub as provided by the applicable GitHub Terms of Service; it does not grant an additional public license. See the [GitHub Terms of Service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service), [LICENSE](./LICENSE), [NOTICE](./NOTICE), and [THIRDPARTY](./THIRDPARTY.md).",
    },
    {
      path: "THIRDPARTY.md",
      heading: "## This repository",
      index: 0,
      paragraph:
        "The original content of this repository owned by LCV Ideas & Software is proprietary to it. Copyright © 2026 LCV Ideas & Software. All rights reserved. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE). Contributor-owned material may be incorporated only under the separate documented written terms and local gate defined in [INBOUND.md](./INBOUND.md), and must be listed here or in NOTICE before merge.",
    },
    {
      path: "profile/README.md",
      heading: "## 📄 License",
      index: 0,
      paragraph:
        "Copyright © 2026 LCV Ideas &amp; Software. The original content of this repository owned by LCV Ideas &amp; Software is proprietary and **all rights are reserved**. See [LICENSE](https://github.com/LCV-Ideas-Software/.github/blob/main/LICENSE), [NOTICE](https://github.com/LCV-Ideas-Software/.github/blob/main/NOTICE), and [THIRDPARTY](https://github.com/LCV-Ideas-Software/.github/blob/main/THIRDPARTY.md).",
    },
  ];

  for (const spec of ownershipParagraphs) {
    const found = ownershipParagraphOf(
      readFileSync(join(repositoryRoot, spec.path), "utf8"),
      spec,
    );
    assert.equal(
      found === undefined ? undefined : normalize(found),
      spec.paragraph,
      `${spec.path} must carry the approved ownership paragraph verbatim at ${
        spec.heading ?? `block ${spec.index}`
      }`,
    );
  }

  // A negating wrapper has to live inside the governing block to reach the
  // statement, and putting it there breaks the equality.
  const noticeSpec = ownershipParagraphs[0];
  for (const tampered of [
    `The following passage is false: "${noticeSpec.paragraph}"`,
    `${noticeSpec.paragraph} None of the above applies.`,
    `It is false, e.g. ${noticeSpec.paragraph}`,
    noticeSpec.paragraph.replace("is proprietary", "is not proprietary"),
    noticeSpec.paragraph.replace(
      "Its original content owned by LCV Ideas & Software is proprietary.",
      "",
    ),
  ]) {
    assert.notEqual(
      normalize(tampered),
      noticeSpec.paragraph,
      "the ownership guard must reject a tampered governing paragraph",
    );
  }

  // Reflow inside the block stays acceptable.
  assert.equal(
    normalize(noticeSpec.paragraph.split(" ").join("\n   ")),
    noticeSpec.paragraph,
    "the ownership guard must tolerate reflow inside the governing paragraph",
  );
});
