import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Parser } from "commonmark";

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
  ".github/workflows/dependabot-automerge.yml",
  ".github/workflows/dependabot-automerge-signal.yml",
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

test("the published GitHub marks retain exact official provenance and color", () => {
  const site = readFileSync(join(repositoryRoot, "site", "index.html"), "utf8");
  const styles = readFileSync(join(repositoryRoot, "site", "styles.css"), "utf8");
  const thirdParty = readFileSync(join(repositoryRoot, "THIRDPARTY.md"), "utf8");
  const officialMarkPath =
    "M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656";

  assert.equal(
    site.split(officialMarkPath).length - 1,
    2,
    "both inline marks must match the immutable v19.33.0 Octicons asset",
  );
  const brandedMarkBlocks = [
    ...site.matchAll(/<svg\s+class="github-mark"[\s\S]*?<\/svg\s*>/g),
  ].map((match) => match[0]);
  assert.equal(
    brandedMarkBlocks.length,
    2,
    "only the two GitHub marks receive the brand-color class",
  );
  for (const block of brandedMarkBlocks) {
    assert.ok(
      block.includes(`d="${officialMarkPath}"`),
      "the brand-color class must be attached to the official GitHub Mark path",
    );
  }
  assert.match(styles, /svg\.github-mark\s*\{\s*color:\s*#fff;\s*\}/);
  assert.ok(
    styles.indexOf("svg.github-mark") >
      styles.indexOf(".orgcard__items svg"),
    "the exact brand color must override the generic card icon color",
  );
  assert.match(thirdParty, /Octicons `v19\.33\.0`/);
  assert.match(
    thirdParty,
    /cc4e12df6ff8292447ba9141eaa2a6f6e1c59a85/,
  );
  assert.ok(thirdParty.includes("https://brand.github.com/foundations/logo"));
  assert.ok(thirdParty.includes("outbound link to the GitHub organization"));
  assert.ok(thirdParty.includes("non-interactive metric indicator"));
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
    /linear\/linear-release-action@3f31fcf14c110cc53579fcc3575a26d469c413b4/,
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
    "dependabot-automerge-signal.yml",
    "dependabot-automerge.yml",
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

  // Parse Markdown with the CommonMark reference implementation instead of
  // maintaining a second, partial Markdown parser in this test. The guard only
  // accepts an exact top-level structural anchor followed by the exact approved
  // paragraph. Soft line wrapping is normalized, while links, emphasis, code,
  // hard breaks, raw HTML, and every other semantic node remain significant.
  const markdownParser = new Parser();

  const topLevelNodesOf = (text) => {
    const document = markdownParser.parse(text);
    const nodes = [];
    for (let node = document.firstChild; node; node = node.next) {
      nodes.push(node);
    }
    return nodes;
  };

  const appendText = (children, text) => {
    const previous = children.at(-1);
    if (previous?.type === "text") {
      previous.literal += text;
    } else {
      children.push({ type: "text", literal: text });
    }
  };

  const canonicalChildrenOf = (parent) => {
    const children = [];
    for (let node = parent.firstChild; node; node = node.next) {
      if (node.type === "text") {
        appendText(children, node.literal);
        continue;
      }
      if (node.type === "softbreak") {
        appendText(children, " ");
        continue;
      }

      const child = { type: node.type };
      if (["code", "html_inline"].includes(node.type)) {
        child.literal = node.literal;
      }
      if (["link", "image"].includes(node.type)) {
        child.destination = node.destination;
        child.title = node.title;
      }
      if (node.firstChild) {
        child.children = canonicalChildrenOf(node);
      }
      children.push(child);
    }

    for (const child of children) {
      if (child.type === "text") {
        child.literal = child.literal.replace(/\s+/gu, " ");
      }
    }
    if (children[0]?.type === "text") {
      children[0].literal = children[0].literal.trimStart();
    }
    if (children.at(-1)?.type === "text") {
      children.at(-1).literal = children.at(-1).literal.trimEnd();
    }
    return children.filter(
      (child) => child.type !== "text" || child.literal !== "",
    );
  };

  const canonicalNodeOf = (node) => {
    const canonical = { type: node.type };
    if (node.type === "heading") canonical.level = node.level;
    if (node.firstChild) canonical.children = canonicalChildrenOf(node);
    return canonical;
  };

  const canonicalBlockOf = (markdown, expectedType) => {
    const nodes = topLevelNodesOf(markdown);
    assert.equal(nodes.length, 1, "the approved fixture must be one block");
    assert.equal(
      nodes[0].type,
      expectedType,
      `the approved fixture must be a ${expectedType}`,
    );
    return canonicalNodeOf(nodes[0]);
  };

  const canonicalKeyOf = (node) => JSON.stringify(canonicalNodeOf(node));

  const ownershipParagraphOf = (text, spec) => {
    const nodes = topLevelNodesOf(text);
    const anchorType = spec.heading ? "heading" : "paragraph";
    const anchorMarkdown = spec.heading ?? spec.anchorParagraph;
    const anchorKey = JSON.stringify(
      canonicalBlockOf(anchorMarkdown, anchorType),
    );
    const anchors = nodes.filter(
      (node) => node.type === anchorType && canonicalKeyOf(node) === anchorKey,
    );
    if (anchors.length !== 1) return undefined;

    const paragraph = anchors[0].next;
    if (!paragraph || paragraph.type !== "paragraph") return undefined;
    return canonicalNodeOf(paragraph);
  };

  const ownershipParagraphs = [
    {
      path: "NOTICE",
      heading: null,
      anchorParagraph:
        "LCV Ideas & Software public organization surfaces Copyright © 2026 LCV Ideas & Software. All rights reserved.",
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
    const approvedParagraph = canonicalBlockOf(spec.paragraph, "paragraph");
    const found = ownershipParagraphOf(
      readFileSync(join(repositoryRoot, spec.path), "utf8"),
      spec,
    );
    assert.deepEqual(
      found,
      approvedParagraph,
      `${spec.path} must carry the approved CommonMark ownership paragraph at ${
        spec.heading ?? "the approved top-level anchor"
      }`,
    );
  }

  const noticeSpec = ownershipParagraphs[0];
  const approvedNotice = canonicalBlockOf(noticeSpec.paragraph, "paragraph");
  const noticeDocumentWith = (paragraph) =>
    `${noticeSpec.anchorParagraph}\n\n${paragraph}\n`;

  // Every historical textual bypass remains pinned as a parser-level
  // regression: bare newline, paragraph break, punctuation, quoted wrapper,
  // trailing denial, direct negation, and deletion.
  for (const tampered of [
    `It is false that\n${noticeSpec.paragraph}`,
    `The following statement is false:\n\n${noticeSpec.paragraph}`,
    `The following passage is false: "${noticeSpec.paragraph}"`,
    `${noticeSpec.paragraph} None of the above applies.`,
    `It is false, e.g. ${noticeSpec.paragraph}`,
    noticeSpec.paragraph.replace("is proprietary", "is not proprietary"),
    noticeSpec.paragraph.replace(
      "Its original content owned by LCV Ideas & Software is proprietary.",
      "",
    ),
  ]) {
    assert.notDeepEqual(
      ownershipParagraphOf(noticeDocumentWith(tampered), noticeSpec),
      approvedNotice,
      "the ownership guard must reject a tampered governing paragraph",
    );
  }

  // Structural tampering the scanner must reject: the paragraph rendered as an
  // indented code block; the heading and paragraph hidden inside a fence while
  // the real section is altered; and the heading inside an HTML comment.
  const readmeSpec = ownershipParagraphs[1];
  const approvedReadme = canonicalBlockOf(readmeSpec.paragraph, "paragraph");
  for (const doc of [
    `## License\n\n    ${readmeSpec.paragraph}\n`,
    `\`\`\`\n## License\n\n${readmeSpec.paragraph}\n\`\`\`\n\n## License\n\nAll rights waived.\n`,
    `<!--\n## License\n\n${readmeSpec.paragraph}\n-->\n`,
    // heading and paragraph inside a raw HTML block (CommonMark type 1 and
    // type 6), while the real section carries altered terms
    `<script>\n## License\n\n${readmeSpec.paragraph}\n</script>\n\n## License\n\nAll rights waived.\n`,
    `<div>\n## License\n\n${readmeSpec.paragraph}\n</div>\n\n## License\n\nAll rights waived.\n`,
    // A tab expands to four columns in CommonMark, so this apparent fence
    // closer remains code and must not expose the decoy heading.
    `\`\`\`\n\t\`\`\`\n## License\n\n${readmeSpec.paragraph}\n\`\`\`\n\n## License\n\nAll rights waived.\n`,
    // A real heading nested in a list item is not the top-level License
    // section that governs the document.
    `- item\n\n  ## License\n\n  ${readmeSpec.paragraph}\n\n## License\n\nAll rights waived.\n`,
    // "## License#" is the heading text "License#": a closing hash sequence
    // requires separating whitespace, so this must not match the heading
    `## License#\n\n${readmeSpec.paragraph}\n\n## License\n\nAll rights waived.\n`,
    // Duplicate top-level anchors are ambiguous and therefore fail closed.
    `## License\n\n${readmeSpec.paragraph}\n\n## License\n\n${readmeSpec.paragraph}\n`,
  ]) {
    assert.notDeepEqual(
      ownershipParagraphOf(doc, readmeSpec),
      approvedReadme,
      `the ownership guard must reject structural tampering: ${doc.slice(0, 60)}...`,
    );
  }

  // An autolink begins with "<" but is not a raw-HTML block. The visible
  // negating preface must therefore remain part of the block sequence.
  const autolinkPreface = `${noticeSpec.anchorParagraph}\n\n<https://example.invalid> The following statement is false:\n\n${noticeSpec.paragraph}`;
  assert.notDeepEqual(
    ownershipParagraphOf(autolinkPreface, noticeSpec),
    approvedNotice,
    "the ownership guard must not hide an autolink as raw HTML",
  );

  // Markdown semantics are part of the approved paragraph, not decoration
  // discarded by a plain-text comparison.
  for (const tampered of [
    readmeSpec.paragraph.replace(
      "**all rights are reserved**",
      "all rights are reserved",
    ),
    readmeSpec.paragraph.replace(
      "https://docs.github.com/en/site-policy/github-terms/github-terms-of-service",
      "https://example.invalid/terms",
    ),
    readmeSpec.paragraph.replace(
      "content of this repository",
      "content  \n of this repository",
    ),
  ]) {
    assert.notDeepEqual(
      canonicalBlockOf(tampered, "paragraph"),
      approvedReadme,
      "the ownership guard must preserve approved CommonMark semantics",
    );
  }

  // Soft line wrapping inside the governing paragraph stays acceptable.
  assert.deepEqual(
    ownershipParagraphOf(
      noticeDocumentWith(noticeSpec.paragraph.split(" ").join("\n")),
      noticeSpec,
    ),
    approvedNotice,
    "the ownership guard must tolerate reflow inside the governing paragraph",
  );
  assert.deepEqual(
    ownershipParagraphOf(
      `## License\n\n${readmeSpec.paragraph.split(" ").join("\n")}\n`,
      readmeSpec,
    ),
    approvedReadme,
    "the structural locator must tolerate reflow inside the governing paragraph",
  );
});
