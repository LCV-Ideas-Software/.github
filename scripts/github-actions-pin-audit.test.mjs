import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  API_VERSION,
  GitHubApiError,
  GitHubReadonlyApi,
  OciRegistryReadonlyClient,
  auditRuntimeToolUpdates,
  formatFindingAnnotation,
  isAuditedYamlPath,
  parseActionRuntime,
  parseDockerDigestBaseline,
  parseDockerImageReference,
  parseStableSemverTag,
  parseUsesReferences,
  parseWorkflowRuntimePins,
  readConfiguration,
  renderSummary,
  runAudit,
  selectLatestStableTag,
} from "./github-actions-pin-audit.mjs";

const SHA_CHECKOUT = "1".repeat(40);
const SHA_INTERNAL = "2".repeat(40);
const SHA_OLD = "3".repeat(40);
const SHA_ANNOTATED_TAG = "4".repeat(40);
const SHA_SCORECARD = "5".repeat(40);
const SHA_SETUP_DENO = "6".repeat(40);
const SHA_DENO_RELEASE = "7".repeat(40);
const SHA_SLACK_RELEASE = "8".repeat(40);
const DIGEST_BASELINE = `sha256:${"a".repeat(64)}`;
const DIGEST_DRIFT = `sha256:${"b".repeat(64)}`;
const TEST_TOKEN = "test-token-never-log";
const JAVASCRIPT_ACTION_METADATA = [
  "name: Fixture Action",
  "runs:",
  "  using: node24",
  "  main: dist/index.js",
  "",
].join("\n");

function responseJson(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function contentsFile(content) {
  return {
    type: "file",
    encoding: "base64",
    content: Buffer.from(content, "utf8").toString("base64"),
  };
}

function addActionMetadataRoute(
  routes,
  { source, sha, actionPath, filename = "action.yml", metadata },
) {
  const directory = actionPath ? `${actionPath}/` : "";
  routes.set(
    `/repos/${source}/contents/${directory}${filename}?ref=${sha}`,
    contentsFile(metadata ?? JAVASCRIPT_ACTION_METADATA),
  );
}

function repository({
  name = "example",
  archived = false,
  disabled = false,
} = {}) {
  return {
    name,
    full_name: `LCV-Ideas-Software/${name}`,
    archived,
    disabled,
    default_branch: "main",
    owner: { login: "LCV-Ideas-Software" },
  };
}

function baseRoutes(workflow) {
  const blob = Buffer.from(workflow, "utf8").toString("base64");
  return new Map([
    [
      "/repos/LCV-Ideas-Software/example/git/trees/main?recursive=1",
      {
        truncated: false,
        tree: [
          {
            path: ".github/workflows/ci.yml",
            type: "blob",
            sha: "workflow-blob",
          },
        ],
      },
    ],
    [
      "/repos/LCV-Ideas-Software/example/git/blobs/workflow-blob",
      { encoding: "base64", content: blob },
    ],
  ]);
}

class FixtureApi {
  constructor({ workflow, routes = new Map(), repositories } = {}) {
    this.calls = [];
    this.routes = baseRoutes(workflow ?? "name: empty\n");
    for (const [path, value] of routes) this.routes.set(path, value);
    this.repositories = repositories ?? [repository()];
  }

  async paginate(path) {
    this.calls.push({ method: "GET", path, paginated: true });
    if (path === "/orgs/LCV-Ideas-Software/repos?type=all") {
      return this.repositories;
    }
    const value = this.routes.get(`paginate:${path}`);
    if (value !== undefined) return value;
    throw new Error(`Unexpected paginated fixture request: ${path}`);
  }

  async getJson(path, { allow404 = false } = {}) {
    this.calls.push({ method: "GET", path, allow404 });
    if (!this.routes.has(path)) {
      if (allow404) return undefined;
      throw new Error(`Unexpected fixture request: ${path}`);
    }
    const value = this.routes.get(path);
    if (value instanceof Error) throw value;
    return structuredClone(value);
  }
}

function addActionRoutes(
  routes,
  {
    source,
    latestTag,
    latestSha,
    latestVerified = true,
    latestReason = "valid",
    commentTags = {},
    commits = {},
    actionPath,
    actionMetadata = JAVASCRIPT_ACTION_METADATA,
    metadataFilename = "action.yml",
  },
) {
  const [owner, name] = source.split("/");
  const prefix = `/repos/${owner}/${name}`;
  routes.set(`${prefix}/releases/latest`, {
    draft: false,
    prerelease: false,
    tag_name: latestTag,
  });
  routes.set(`${prefix}/git/ref/tags/${encodeURIComponent(latestTag)}`, {
    object: { type: "commit", sha: latestSha },
  });
  const family = parseStableSemverTag(latestTag)?.prefix;
  if (family) {
    routes.set(`${prefix}/git/matching-refs/tags/${family}`, [
      {
        ref: `refs/tags/${latestTag}`,
        object: { type: "commit", sha: latestSha },
      },
    ]);
  }
  for (const [tag, sha] of Object.entries(commentTags)) {
    routes.set(`${prefix}/git/ref/tags/${encodeURIComponent(tag)}`, {
      object: { type: "commit", sha },
    });
  }
  const allCommits = {
    [latestSha]: { verified: latestVerified, reason: latestReason },
    ...commits,
  };
  for (const [sha, verification] of Object.entries(allCommits)) {
    routes.set(`${prefix}/commits/${sha}`, {
      sha,
      commit: { verification },
    });
    addActionMetadataRoute(routes, {
      source,
      sha,
      actionPath,
      filename: metadataFilename,
      metadata: actionMetadata,
    });
  }
}

function releaseAsset({ source, tag, name, digest = DIGEST_BASELINE }) {
  return {
    name,
    state: "uploaded",
    size: 1024,
    digest,
    browser_download_url: `https://github.com/${source}/releases/download/${tag}/${encodeURIComponent(name)}`,
  };
}

function addOfficialReleaseRoutes(
  routes,
  {
    source,
    tag,
    sha,
    assets = [],
    latest = true,
    verified = true,
    reason = "valid",
  },
) {
  const release = {
    draft: false,
    prerelease: false,
    tag_name: tag,
    assets,
  };
  const prefix = `/repos/${source}`;
  if (latest) routes.set(`${prefix}/releases/latest`, release);
  routes.set(`${prefix}/releases/tags/${tag}`, release);
  routes.set(`${prefix}/git/ref/tags/${tag}`, {
    object: { type: "commit", sha },
  });
  routes.set(`${prefix}/commits/${sha}`, {
    sha,
    commit: { verification: { verified, reason } },
  });
}

test("configuration is strict and never normalizes a credential", () => {
  const configuration = readConfiguration({
    GITHUB_TOKEN: TEST_TOKEN,
    ORGANIZATION: "LCV-Ideas-Software",
    MIN_ACTIVE_REPOSITORIES: "11",
  });
  assert.equal(configuration.token, TEST_TOKEN);
  assert.equal(configuration.minimumRepositories, 11);
  assert.equal(Object.isFrozen(configuration), true);

  assert.throws(() => readConfiguration({}), /GITHUB_TOKEN is missing/);
  assert.throws(
    () => readConfiguration({ GITHUB_TOKEN: ` ${TEST_TOKEN}` }),
    /surrounding whitespace/,
  );
  assert.throws(
    () =>
      readConfiguration({
        GITHUB_TOKEN: TEST_TOKEN,
        MIN_ACTIVE_REPOSITORIES: "0",
      }),
    /positive integer/,
  );
});

test("GitHubReadonlyApi emits only authenticated GET requests", async () => {
  const requests = [];
  const api = new GitHubReadonlyApi({
    token: TEST_TOKEN,
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      requests.push({ url, init });
      return responseJson({ ok: true });
    },
  });
  assert.deepEqual(await api.getJson("/rate_limit"), { ok: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.href, "https://api.github.com/rate_limit");
  assert.equal(requests[0].init.method, "GET");
  assert.equal(requests[0].init.headers.Authorization, `Bearer ${TEST_TOKEN}`);
  assert.equal(requests[0].init.headers["X-GitHub-Api-Version"], API_VERSION);
  assert.ok(requests[0].init.signal instanceof AbortSignal);
  await assert.rejects(
    api.getJson("//attacker.example/path"),
    /outside api.github.com/,
  );
});

test("API failures do not render tokens or response bodies", async () => {
  const api = new GitHubReadonlyApi({
    token: TEST_TOKEN,
    fetchImpl: async () =>
      responseJson(
        { message: `sensitive ${TEST_TOKEN}` },
        {
          status: 403,
          headers: {
            "x-github-request-id": "request-123",
            "x-ratelimit-remaining": "0",
          },
        },
      ),
  });
  await assert.rejects(
    api.getJson("/rate_limit"),
    (error) =>
      error instanceof GitHubApiError &&
      /request-id=request-123/.test(error.message) &&
      /rate-limit-exhausted=true/.test(error.message) &&
      !error.message.includes(TEST_TOKEN),
  );
});

test("workflow and Action YAML path selection is complete and narrow", () => {
  for (const path of [
    ".github/workflows/ci.yml",
    ".github/workflows/nested/reusable.yaml",
    "action.yml",
    ".github/actions/build/action.yaml",
    "tools/custom/action.yml",
  ]) {
    assert.equal(isAuditedYamlPath(path), true, path);
  }
  for (const path of [
    ".github/dependabot.yml",
    ".github/workflows/readme.md",
    "action.json",
    "node_modules/example.yml",
  ]) {
    assert.equal(isAuditedYamlPath(path), false, path);
  }
});

test("uses parser accepts local Actions and exact SHA plus exact tag comments", () => {
  const parsed = parseUsesReferences(
    [
      "steps:",
      "  - uses: ./local-action",
      `  - uses: actions/checkout@${SHA_CHECKOUT} # v7.0.1`,
      `  - uses: 'LCV-Ideas-Software/.github/dependabot-automerge@${SHA_INTERNAL}' # v1.0.0`,
    ].join("\n"),
    { repository: "LCV-Ideas-Software/example", path: "workflow.yml" },
  );
  assert.equal(parsed.findings.length, 0);
  assert.deepEqual(
    parsed.references.map(({ source, actionPath, commentTag }) => ({
      source,
      actionPath,
      commentTag,
    })),
    [
      {
        source: "actions/checkout",
        actionPath: undefined,
        commentTag: "v7.0.1",
      },
      {
        source: "LCV-Ideas-Software/.github",
        actionPath: "dependabot-automerge",
        commentTag: "v1.0.0",
      },
    ],
  );
});

test("uses parser fails closed on mutable, Docker, expression, missing-comment, and flow syntax", () => {
  const parsed = parseUsesReferences(
    [
      "- uses: actions/checkout@v7",
      "- uses: docker://alpine:latest",
      "- uses: ${{ matrix.action }}",
      `- uses: actions/checkout@${SHA_CHECKOUT}`,
      `- { uses: actions/checkout@${SHA_CHECKOUT} }`,
    ].join("\n"),
    { repository: "LCV-Ideas-Software/example", path: "workflow.yml" },
  );
  assert.deepEqual(
    parsed.findings.map(({ code }) => code),
    [
      "UNPINNED_EXTERNAL_ACTION",
      "UNPINNED_EXTERNAL_ACTION",
      "UNSUPPORTED_USES_SYNTAX",
      "MISSING_VERSION_COMMENT",
      "UNSUPPORTED_USES_SYNTAX",
    ],
  );
});

test("runtime pin parser binds exact Deno and Slack CLI pins to canonical workflow blocks", () => {
  const workflow = [
    "steps:",
    "  - name: Setup Deno",
    `    uses: denoland/setup-deno@${SHA_SETUP_DENO} # v2.0.5`,
    "    with:",
    "      deno-version: v2.9.4",
    "  - name: Install Slack CLI",
    "    env:",
    "      SLACK_CLI_ASSET: slack_cli_4.6.0_linux_64-bit.tar.gz",
    `      SLACK_CLI_SHA256: ${"a".repeat(64)}`,
    "      SLACK_CLI_VERSION: 4.6.0",
    "    run: ./install-slack-cli.sh",
  ].join("\n");
  const parsed = parseWorkflowRuntimePins(workflow, {
    repository: "LCV-Ideas-Software/example",
    path: ".github/workflows/ci.yml",
  });
  assert.deepEqual(parsed.findings, []);
  assert.deepEqual(
    parsed.denoReferences.map(({ value, version, line }) => ({
      value,
      version,
      line,
    })),
    [{ value: "v2.9.4", version: "2.9.4", line: 5 }],
  );
  assert.deepEqual(
    parsed.slackCliReferences.map(
      ({ version, asset, checksum, line, checksumLine }) => ({
        version,
        asset,
        checksum,
        line,
        checksumLine,
      }),
    ),
    [
      {
        version: "4.6.0",
        asset: "slack_cli_4.6.0_linux_64-bit.tar.gz",
        checksum: "a".repeat(64),
        line: 10,
        checksumLine: 9,
      },
    ],
  );
});

test("runtime pin parser fails closed on ranges, missing inputs, expressions, and partial Slack pins", () => {
  const workflow = [
    "steps:",
    `  - uses: denoland/setup-deno@${SHA_SETUP_DENO} # v2.0.5`,
    "    with:",
    "      deno-version: v2.x",
    `  - uses: denoland/setup-deno@${SHA_SETUP_DENO} # v2.0.5`,
    "  - name: Partial Slack CLI pin",
    "    env:",
    "      SLACK_CLI_VERSION: 4.6.0",
    "  - name: Dynamic Slack CLI pin",
    "    env:",
    "      SLACK_CLI_ASSET: slack_cli_4.6.0_linux_64-bit.tar.gz",
    `      SLACK_CLI_SHA256: ${"a".repeat(64)}`,
    "      SLACK_CLI_VERSION: ${{ matrix.slack-cli }}",
  ].join("\n");
  const parsed = parseWorkflowRuntimePins(workflow, {
    repository: "LCV-Ideas-Software/example",
    path: ".github/workflows/ci.yml",
  });
  assert.deepEqual(
    parsed.findings.map(({ code }) => code),
    [
      "NON_EXACT_DENO_VERSION_PIN",
      "MISSING_DENO_VERSION_PIN",
      "INCOMPLETE_SLACK_CLI_PIN",
      "UNSUPPORTED_SLACK_CLI_PIN",
    ],
  );
  assert.deepEqual(parsed.denoReferences, []);
  assert.deepEqual(parsed.slackCliReferences, []);
});

test("official runtime audit validates latest signed Deno and Slack CLI releases and release-asset checksum", async () => {
  const routes = new Map();
  addOfficialReleaseRoutes(routes, {
    source: "denoland/deno",
    tag: "v2.9.4",
    sha: SHA_DENO_RELEASE,
  });
  addOfficialReleaseRoutes(routes, {
    source: "slackapi/slack-cli",
    tag: "v4.6.0",
    sha: SHA_SLACK_RELEASE,
    assets: [
      releaseAsset({
        source: "slackapi/slack-cli",
        tag: "v4.6.0",
        name: "slack_cli_4.6.0_linux_64-bit.tar.gz",
      }),
    ],
  });
  const api = new FixtureApi({ routes });
  const result = await auditRuntimeToolUpdates({
    api,
    denoReferences: [
      {
        repository: "LCV-Ideas-Software/example",
        path: ".github/workflows/ci.yml",
        line: 5,
        value: "2.9.4",
        version: "2.9.4",
      },
    ],
    slackCliReferences: [
      {
        repository: "LCV-Ideas-Software/example",
        path: ".github/workflows/ci.yml",
        line: 10,
        version: "4.6.0",
        asset: "slack_cli_4.6.0_linux_64-bit.tar.gz",
        checksum: DIGEST_BASELINE.slice("sha256:".length),
        checksumLine: 9,
      },
    ],
  });
  assert.deepEqual(result.findings, []);
  assert.equal(
    api.calls.every(({ method }) => method === "GET"),
    true,
  );
});

test("official runtime audit reports stale versions and supplies the exact latest Slack asset digest", async () => {
  const routes = new Map();
  addOfficialReleaseRoutes(routes, {
    source: "denoland/deno",
    tag: "v2.9.4",
    sha: SHA_DENO_RELEASE,
  });
  addOfficialReleaseRoutes(routes, {
    source: "slackapi/slack-cli",
    tag: "v4.6.0",
    sha: SHA_SLACK_RELEASE,
    assets: [
      releaseAsset({
        source: "slackapi/slack-cli",
        tag: "v4.6.0",
        name: "slack_cli_4.6.0_linux_64-bit.tar.gz",
        digest: DIGEST_DRIFT,
      }),
    ],
  });
  addOfficialReleaseRoutes(routes, {
    source: "slackapi/slack-cli",
    tag: "v4.5.0",
    sha: SHA_OLD,
    latest: false,
    assets: [
      releaseAsset({
        source: "slackapi/slack-cli",
        tag: "v4.5.0",
        name: "slack_cli_4.5.0_linux_64-bit.tar.gz",
      }),
    ],
  });
  const result = await auditRuntimeToolUpdates({
    api: new FixtureApi({ routes }),
    denoReferences: [
      {
        repository: "LCV-Ideas-Software/example",
        path: ".github/workflows/ci.yml",
        line: 5,
        value: "2.9.3",
        version: "2.9.3",
      },
    ],
    slackCliReferences: [
      {
        repository: "LCV-Ideas-Software/example",
        path: ".github/workflows/ci.yml",
        line: 10,
        version: "4.5.0",
        asset: "slack_cli_4.5.0_linux_64-bit.tar.gz",
        checksum: DIGEST_BASELINE.slice("sha256:".length),
        checksumLine: 9,
      },
    ],
  });
  assert.deepEqual(
    result.findings.map(({ code }) => code),
    ["STALE_DENO_VERSION_PIN", "STALE_SLACK_CLI_VERSION_PIN"],
  );
  assert.match(
    result.findings[1].message,
    new RegExp(
      `slack_cli_4\\.6\\.0_linux_64-bit\\.tar\\.gz.*${"b".repeat(64)}`,
    ),
  );
});

test("official runtime audit rejects a Slack CLI checksum that differs from GitHub release metadata", async () => {
  const routes = new Map();
  addOfficialReleaseRoutes(routes, {
    source: "slackapi/slack-cli",
    tag: "v4.6.0",
    sha: SHA_SLACK_RELEASE,
    assets: [
      releaseAsset({
        source: "slackapi/slack-cli",
        tag: "v4.6.0",
        name: "slack_cli_4.6.0_linux_64-bit.tar.gz",
      }),
    ],
  });
  const result = await auditRuntimeToolUpdates({
    api: new FixtureApi({ routes }),
    slackCliReferences: [
      {
        repository: "LCV-Ideas-Software/example",
        path: ".github/workflows/ci.yml",
        line: 10,
        version: "4.6.0",
        asset: "slack_cli_4.6.0_linux_64-bit.tar.gz",
        checksum: "f".repeat(64),
        checksumLine: 9,
      },
    ],
  });
  assert.deepEqual(
    result.findings.map(({ code }) => code),
    ["SLACK_CLI_CHECKSUM_MISMATCH"],
  );
});

test("Action metadata parser distinguishes external Docker images from immutable repository code", () => {
  assert.deepEqual(
    parseActionRuntime(
      [
        "name: Scorecard",
        "runs:",
        '  using: "docker"',
        '  image: "docker://ghcr.io/ossf/scorecard-action:v2.4.4"',
      ].join("\n"),
    ),
    {
      using: "docker",
      image: "docker://ghcr.io/ossf/scorecard-action:v2.4.4",
    },
  );
  assert.deepEqual(
    parseActionRuntime("runs:\n  using: docker\n  image: Dockerfile\n"),
    { using: "docker", image: "Dockerfile" },
  );
  assert.throws(
    () => parseActionRuntime("runs: { using: docker, image: Dockerfile }\n"),
    /Flow-style/,
  );
  assert.throws(
    () =>
      parseActionRuntime(
        "runs:\n  using: docker\n  image: ${{ inputs.image }}\n",
      ),
    /not a supported scalar|not a literal scalar/,
  );
});

test("Docker image and version-controlled digest baseline parsers fail closed", () => {
  const tagged = parseDockerImageReference(
    "docker://ghcr.io/ossf/scorecard-action:v2.4.4",
  );
  assert.deepEqual(
    {
      registry: tagged.registry,
      repository: tagged.repository,
      tag: tagged.tag,
      digest: tagged.digest,
      canonical: tagged.canonical,
    },
    {
      registry: "ghcr.io",
      repository: "ossf/scorecard-action",
      tag: "v2.4.4",
      digest: undefined,
      canonical: "ghcr.io/ossf/scorecard-action:v2.4.4",
    },
  );
  assert.equal(
    parseDockerImageReference(
      `docker://ghcr.io/ossf/scorecard-action@${DIGEST_BASELINE}`,
    ).digest,
    DIGEST_BASELINE,
  );
  assert.throws(
    () =>
      parseDockerImageReference("docker://ghcr.io/OSSF/scorecard-action:v1"),
    /canonical lowercase/,
  );
  assert.deepEqual(
    parseDockerDigestBaseline(
      JSON.stringify({
        version: 1,
        images: {
          "ghcr.io/ossf/scorecard-action:v2.4.4": DIGEST_BASELINE,
        },
      }),
    ),
    new Map([["ghcr.io/ossf/scorecard-action:v2.4.4", DIGEST_BASELINE]]),
  );
  assert.throws(
    () =>
      parseDockerDigestBaseline(
        JSON.stringify({
          version: 1,
          images: { "ghcr.io/ossf/scorecard-action": DIGEST_BASELINE },
        }),
      ),
    /canonical tagged GHCR image/,
  );
});

test("OCI resolver uses anonymous GETs and verifies manifest bytes against the GHCR digest", async () => {
  const manifest = Buffer.from('{"schemaVersion":2}', "utf8");
  const digest = `sha256:${createHash("sha256").update(manifest).digest("hex")}`;
  const requests = [];
  const registry = new OciRegistryReadonlyClient({
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      requests.push({ url, init });
      if (url.href.startsWith("https://ghcr.io/token?")) {
        return responseJson({ token: "fixture-anonymous-token" });
      }
      if (!init.headers.Authorization) {
        return new Response("unauthorized", {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:ossf/scorecard-action:pull"',
          },
        });
      }
      return new Response(manifest, {
        status: 200,
        headers: {
          "content-type":
            "application/vnd.docker.distribution.manifest.v2+json",
          "content-length": String(manifest.length),
          "docker-content-digest": digest,
        },
      });
    },
  });
  assert.equal(
    await registry.resolveDigest(
      "docker://ghcr.io/ossf/scorecard-action:v2.4.4",
    ),
    digest,
  );
  assert.equal(requests.length, 3);
  assert.equal(
    requests.every(({ init }) => init.method === "GET"),
    true,
  );
  assert.equal(
    requests.every(({ init }) => init.redirect === "error"),
    true,
  );
  assert.equal(requests[0].init.headers.Authorization, undefined);
  assert.equal(requests[1].init.headers.Authorization, undefined);
  assert.equal(
    requests[2].init.headers.Authorization,
    "Bearer fixture-anonymous-token",
  );
});

test("OCI resolver rejects a manifest whose bytes do not match Docker-Content-Digest", async () => {
  const registry = new OciRegistryReadonlyClient({
    fetchImpl: async () =>
      new Response('{"schemaVersion":2}', {
        status: 200,
        headers: {
          "content-type": "application/vnd.oci.image.manifest.v1+json",
          "docker-content-digest": DIGEST_BASELINE,
        },
      }),
  });
  await assert.rejects(
    registry.resolveDigest("docker://ghcr.io/ossf/scorecard-action:v2.4.4"),
    (error) =>
      error.code === "REGISTRY_DIGEST_MISMATCH" &&
      !error.message.includes("fixture-anonymous-token"),
  );
});

test("stable semantic tags exclude prereleases and compare numerically", () => {
  assert.deepEqual(parseStableSemverTag("release-v12.34.56"), {
    tag: "release-v12.34.56",
    prefix: "release-v",
    major: 12,
    minor: 34,
    patch: 56,
  });
  assert.equal(parseStableSemverTag("v2.0.0-rc.1"), undefined);
  assert.equal(
    selectLatestStableTag([
      { name: "v9.10.0" },
      { name: "v10.0.0-rc.1" },
      { name: "v9.9.99" },
      { name: "v10.0.0" },
    ]),
    "v10.0.0",
  );
});

test("organization audit controls the mutable image hidden behind a pinned Docker Action", async () => {
  const workflow = `- uses: ossf/scorecard-action@${SHA_SCORECARD} # v2.4.4\n`;
  const routes = new Map();
  addActionRoutes(routes, {
    source: "ossf/scorecard-action",
    latestTag: "v2.4.4",
    latestSha: SHA_SCORECARD,
    commentTags: { "v2.4.4": SHA_SCORECARD },
    metadataFilename: "action.yaml",
    actionMetadata: [
      "name: Scorecard",
      "runs:",
      '  using: "docker"',
      '  image: "docker://ghcr.io/ossf/scorecard-action:v2.4.4"',
      "",
    ].join("\n"),
  });
  const resolved = [];
  const registryClient = {
    async resolveDigest(image) {
      resolved.push(image.canonical);
      return DIGEST_BASELINE;
    },
  };
  const controlled = await runAudit({
    api: new FixtureApi({ workflow, routes }),
    registryClient,
    dockerDigestBaseline: new Map([
      ["ghcr.io/ossf/scorecard-action:v2.4.4", DIGEST_BASELINE],
    ]),
    minimumRepositories: 1,
  });
  assert.deepEqual(controlled.findings, []);
  assert.equal(controlled.dockerActionReferenceCount, 1);
  assert.equal(controlled.uniqueDockerImageCount, 1);
  assert.deepEqual(resolved, ["ghcr.io/ossf/scorecard-action:v2.4.4"]);

  const missing = await runAudit({
    api: new FixtureApi({ workflow, routes }),
    registryClient,
    dockerDigestBaseline: new Map(),
    minimumRepositories: 1,
  });
  assert.deepEqual(
    missing.findings.map(({ code }) => code),
    ["MISSING_DOCKER_IMAGE_DIGEST_BASELINE"],
  );

  const drift = await runAudit({
    api: new FixtureApi({ workflow, routes }),
    registryClient,
    dockerDigestBaseline: new Map([
      ["ghcr.io/ossf/scorecard-action:v2.4.4", DIGEST_DRIFT],
    ]),
    minimumRepositories: 1,
  });
  assert.deepEqual(
    drift.findings.map(({ code }) => code),
    ["DOCKER_IMAGE_DIGEST_DRIFT"],
  );
});

test("organization audit discovers runtime pins and validates them through official release metadata", async () => {
  const workflow = [
    "steps:",
    `  - uses: denoland/setup-deno@${SHA_SETUP_DENO} # v2.0.5`,
    "    with:",
    "      deno-version: 2.9.4",
    "  - name: Install Slack CLI",
    "    env:",
    "      SLACK_CLI_ASSET: slack_cli_4.6.0_linux_64-bit.tar.gz",
    `      SLACK_CLI_SHA256: ${"a".repeat(64)}`,
    "      SLACK_CLI_VERSION: 4.6.0",
    "    run: ./install-slack-cli.sh",
  ].join("\n");
  const routes = new Map();
  addActionRoutes(routes, {
    source: "denoland/setup-deno",
    latestTag: "v2.0.5",
    latestSha: SHA_SETUP_DENO,
    commentTags: { "v2.0.5": SHA_SETUP_DENO },
  });
  addOfficialReleaseRoutes(routes, {
    source: "denoland/deno",
    tag: "v2.9.4",
    sha: SHA_DENO_RELEASE,
  });
  addOfficialReleaseRoutes(routes, {
    source: "slackapi/slack-cli",
    tag: "v4.6.0",
    sha: SHA_SLACK_RELEASE,
    assets: [
      releaseAsset({
        source: "slackapi/slack-cli",
        tag: "v4.6.0",
        name: "slack_cli_4.6.0_linux_64-bit.tar.gz",
      }),
    ],
  });
  const result = await runAudit({
    api: new FixtureApi({ workflow, routes }),
    minimumRepositories: 1,
  });
  assert.deepEqual(result.findings, []);
  assert.equal(result.denoRuntimeReferenceCount, 1);
  assert.equal(result.slackCliReferenceCount, 1);
});

test("organization audit covers internal and third-party Actions with zero mutations", async () => {
  const workflow = [
    "name: CI",
    "steps:",
    `  - uses: actions/checkout@${SHA_CHECKOUT} # v7.0.1`,
    `  - uses: LCV-Ideas-Software/.github/dependabot-automerge@${SHA_INTERNAL} # v1.0.0`,
  ].join("\n");
  const routes = new Map();
  addActionRoutes(routes, {
    source: "actions/checkout",
    latestTag: "v7.0.1",
    latestSha: SHA_CHECKOUT,
    commentTags: { "v7.0.1": SHA_CHECKOUT },
  });
  addActionRoutes(routes, {
    source: "LCV-Ideas-Software/.github",
    latestTag: "v1.0.0",
    latestSha: SHA_INTERNAL,
    commentTags: { "v1.0.0": SHA_INTERNAL },
    actionPath: "dependabot-automerge",
  });
  const api = new FixtureApi({
    workflow,
    routes,
    repositories: [
      repository(),
      repository({ name: "retired", archived: true }),
    ],
  });
  const result = await runAudit({ api, minimumRepositories: 1 });
  assert.deepEqual(result.findings, []);
  assert.equal(result.repositoryCount, 1);
  assert.equal(result.yamlFileCount, 1);
  assert.equal(result.referenceCount, 2);
  assert.equal(result.uniqueActionRepositoryCount, 2);
  assert.equal(
    api.calls.every(({ method }) => method === "GET"),
    true,
  );
});

test("audit reports stale, mismatched, and unverified pins independently", async () => {
  const workflow = `- uses: actions/checkout@${SHA_OLD} # v7.0.0\n`;
  const routes = new Map();
  addActionRoutes(routes, {
    source: "actions/checkout",
    latestTag: "v7.0.1",
    latestSha: SHA_CHECKOUT,
    commentTags: { "v7.0.0": SHA_INTERNAL },
    commits: {
      [SHA_OLD]: { verified: false, reason: "unsigned" },
    },
  });
  const result = await runAudit({
    api: new FixtureApi({ workflow, routes }),
    minimumRepositories: 1,
  });
  assert.deepEqual(
    result.findings.map(({ code }) => code),
    [
      "STALE_ACTION_PIN",
      "STALE_VERSION_COMMENT",
      "UNVERIFIED_ACTION_COMMIT",
      "VERSION_COMMENT_SHA_MISMATCH",
    ],
  );
});

test("annotated latest tags are peeled to the verified release commit", async () => {
  const workflow = `- uses: actions/checkout@${SHA_CHECKOUT} # v7.0.1\n`;
  const routes = new Map();
  addActionRoutes(routes, {
    source: "actions/checkout",
    latestTag: "v7.0.1",
    latestSha: SHA_CHECKOUT,
    commentTags: { "v7.0.1": SHA_CHECKOUT },
  });
  routes.set("/repos/actions/checkout/git/ref/tags/v7.0.1", {
    object: { type: "tag", sha: SHA_ANNOTATED_TAG },
  });
  routes.set(`/repos/actions/checkout/git/tags/${SHA_ANNOTATED_TAG}`, {
    object: { type: "commit", sha: SHA_CHECKOUT },
  });
  const result = await runAudit({
    api: new FixtureApi({ workflow, routes }),
    minimumRepositories: 1,
  });
  assert.deepEqual(result.findings, []);
});

test("tag-family resolution ignores unrelated releases in a shared repository", async () => {
  const workflow = `- uses: github/codeql-action/init@${SHA_CHECKOUT} # v4.37.6\n`;
  const routes = new Map([
    [
      "/repos/github/codeql-action/releases/latest",
      {
        draft: false,
        prerelease: false,
        tag_name: "codeql-bundle-v99.0.0",
      },
    ],
    [
      "/repos/github/codeql-action/git/matching-refs/tags/v",
      [
        { ref: "refs/tags/v4.37.5" },
        { ref: "refs/tags/v4.37.6" },
        { ref: "refs/tags/v5.0.0-rc.1" },
      ],
    ],
    [
      "/repos/github/codeql-action/git/ref/tags/v4.37.6",
      { object: { type: "commit", sha: SHA_CHECKOUT } },
    ],
    [
      `/repos/github/codeql-action/commits/${SHA_CHECKOUT}`,
      {
        sha: SHA_CHECKOUT,
        commit: { verification: { verified: true, reason: "valid" } },
      },
    ],
  ]);
  addActionMetadataRoute(routes, {
    source: "github/codeql-action",
    sha: SHA_CHECKOUT,
    actionPath: "init",
  });
  const api = new FixtureApi({ workflow, routes });
  const result = await runAudit({ api, minimumRepositories: 1 });
  assert.deepEqual(result.findings, []);
  assert.equal(
    api.calls.some(({ path }) => path?.endsWith("/releases/latest")),
    false,
  );
});

test("repositories using tags instead of Releases get a stable semantic fallback", async () => {
  const workflow = `- uses: example/action@${SHA_CHECKOUT} # v2.0.0\n`;
  const routes = new Map([
    [
      "/repos/example/action/git/matching-refs/tags/v",
      [
        { ref: "refs/tags/v2.0.0" },
        { ref: "refs/tags/v2.1.0-beta.1" },
        { ref: "refs/tags/v1.9.9" },
      ],
    ],
    [
      "/repos/example/action/git/ref/tags/v2.0.0",
      { object: { type: "commit", sha: SHA_CHECKOUT } },
    ],
    [
      `/repos/example/action/commits/${SHA_CHECKOUT}`,
      {
        sha: SHA_CHECKOUT,
        commit: { verification: { verified: true, reason: "valid" } },
      },
    ],
  ]);
  const result = await runAudit({
    api: new FixtureApi({
      workflow,
      routes: new Map([
        ...routes,
        [
          `/repos/example/action/contents/action.yml?ref=${SHA_CHECKOUT}`,
          contentsFile(JAVASCRIPT_ACTION_METADATA),
        ],
      ]),
    }),
    minimumRepositories: 1,
  });
  assert.deepEqual(result.findings, []);
});

test("truncated trees and incomplete repository visibility abort coverage", async () => {
  const truncated = new FixtureApi();
  truncated.routes.set(
    "/repos/LCV-Ideas-Software/example/git/trees/main?recursive=1",
    { truncated: true, tree: [] },
  );
  await assert.rejects(
    runAudit({ api: truncated, minimumRepositories: 1 }),
    /truncated or malformed/,
  );
  await assert.rejects(
    runAudit({ api: new FixtureApi(), minimumRepositories: 11 }),
    /can see only 1.*expected at least 11/,
  );
});

test("annotations escape commands and summary dates use pt-BR at fixed UTC-03", () => {
  const annotation = formatFindingAnnotation({
    code: "STALE:PIN",
    repository: "owner/repo",
    path: ".github/workflows/ci.yml",
    line: 12,
    message: "line one\nline two%",
  });
  assert.match(annotation, /title=STALE%3APIN/);
  assert.match(annotation, /line one%0Aline two%25/);

  const summary = renderSummary(
    {
      repositoryCount: 11,
      yamlFileCount: 42,
      referenceCount: 100,
      uniqueActionRepositoryCount: 10,
      findings: [],
    },
    new Date("2026-08-05T01:30:00.000Z"),
  );
  assert.match(summary, /Gerado em: 04\/08\/2026, 22:30/);
  assert.doesNotMatch(summary, /UTC|Brasília/);
});
