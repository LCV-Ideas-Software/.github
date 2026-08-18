import assert from "node:assert/strict";
import test from "node:test";

import { createGithubAdapter } from "../src/adapters/github.mjs";
import { parseOperationalConfig } from "../src/config.mjs";
import { validateConfig } from "../src/domain/config.mjs";
import {
  buildGithubResourceKey,
  parseGithubOwner,
  parseGithubRepository,
  parseGithubResourceKey,
  parseGithubResourceUrl,
} from "../src/domain/github-resource.mjs";

const PIPELINE_ID = "00000000-0000-4000-8000-000000000001";

test("gramatica GitHub oficial e unica aceita repositorios dot-leading", () => {
  assert.equal(parseGithubOwner("Example-Org"), "example-org");
  assert.equal(parseGithubRepository(".GitHub"), ".github");
  assert.equal(parseGithubRepository(".GitHub-Private"), ".github-private");
  assert.equal(
    buildGithubResourceKey({
      owner: "Example-Org",
      repository: ".GitHub",
      number: "7",
    }),
    "example-org/.github#7",
  );
  assert.deepEqual(parseGithubResourceKey("example-org/.github#7"), {
    owner: "example-org",
    repository: ".github",
    number: 7,
    key: "example-org/.github#7",
  });
});

test("gramatica GitHub recusa nomes ambiguos e numeros nao seguros", () => {
  for (const repository of [
    "",
    ".",
    "..",
    " repo",
    "repo ",
    "repo/name",
    "repo\\name",
    "repo%2fname",
  ]) {
    assert.equal(parseGithubRepository(repository), null, repository);
  }
  assert.equal(
    buildGithubResourceKey({
      owner: "example-org",
      repository: ".github",
      number: Number.MAX_SAFE_INTEGER + 1,
    }),
    null,
  );
  assert.equal(parseGithubResourceKey("example-org/../x#1"), null);
});

test("fragmento e apenas navegacao em externalThread, nunca em attachment", () => {
  const raw =
    "https://github.com/example-org/.github/issues/7#issuecomment-123";
  const externalThread = parseGithubResourceUrl(raw, {
    role: "external-thread",
  });
  const attachment = parseGithubResourceUrl(raw, { role: "attachment" });
  assert.equal(externalThread?.key, "example-org/.github#7");
  assert.equal(externalThread?.secure, true);
  assert.equal(attachment?.key, "example-org/.github#7");
  assert.equal(attachment?.secure, false);
});

test("configuracoes operacional e de dominio reutilizam a mesma gramatica", () => {
  const config = parseOperationalConfig({
    organization: "Example-Org",
    releaseRequiredAfter: "2030-01-01T00:00:00.000Z",
    commentGraceMinutes: 30,
    mappings: [
      {
        linearTeamKey: "EXAMPLE",
        mode: "github-backed",
        repository: ".GitHub",
        linearReleasePipelineId: PIPELINE_ID,
      },
      { linearTeamKey: "ROOT", mode: "umbrella" },
    ],
  });
  assert.equal(config.organization, "example-org");
  assert.equal(config.mappings[0].repository, ".github");
  assert.deepEqual(validateConfig(config).findings, []);

  const invalid = structuredClone(config);
  invalid.mappings[0].repository = "..";
  assert.equal(
    validateConfig(invalid).findings[0]?.code,
    "configuration_invalid",
  );
});

test("inventario GitHub App preserva repositorio .github canonico", async () => {
  const adapter = createGithubAdapter({
    request: async () => ({ data: {} }),
    paginateIterator: async function* () {
      yield { data: [] };
    },
    repositoryInventory: [
      {
        id: 1,
        name: ".GitHub",
        archived: false,
        has_issues: false,
        fork: false,
      },
    ],
  });
  const snapshot = await adapter.readOrganizationSnapshot({
    organization: "Example-Org",
    capturedAt: "2030-01-01T00:00:00.000Z",
  });
  assert.equal(snapshot.complete, true, JSON.stringify(snapshot.failures));
  assert.equal(snapshot.organization, "example-org");
  assert.equal(snapshot.repositories[0].name, ".github");

  const invalidAdapter = createGithubAdapter({
    request: async () => ({ data: {} }),
    paginateIterator: async function* () {
      yield { data: [] };
    },
    repositoryInventory: [
      {
        id: 2,
        name: "..",
        archived: false,
        has_issues: false,
        fork: false,
      },
    ],
  });
  const invalid = await invalidAdapter.readOrganizationSnapshot({
    organization: "example-org",
    capturedAt: "2030-01-01T00:00:00.000Z",
  });
  assert.equal(invalid.complete, false);
  assert.deepEqual(invalid.repositories, []);
});
