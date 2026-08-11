import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import {
  normalizeOsvResults,
  renderIssueBody,
  reportMetadata,
} from "./oss-advisory-watch.mjs";

const FIXTURE_ROOT = new URL("./fixtures/osv-scanner/", import.meta.url);

async function fixture(name) {
  return JSON.parse(await fs.readFile(new URL(name, FIXTURE_ROOT), "utf8"));
}

test("OSV alias groups deduplicate GHSA and RUSTSEC records", async () => {
  const findings = normalizeOsvResults(
    await fixture("alias-dedupe.json"),
    await fixture("provenance.json"),
  );
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0], {
    advisoryId: "GHSA-wrw7-89jp-8q8g",
    aliases: ["GHSA-wrw7-89jp-8q8g", "RUSTSEC-2024-0429"],
    severity: "MODERATE",
    ecosystem: "crates.io",
    package: "glib",
    installedVersion: "0.18.5",
    fixedVersions: ["0.20.0"],
    summary: "Unsound iterator implementation",
    repository: "LCV-Ideas-Software/maestro-app",
    path: "src-tauri/Cargo.lock",
    commitSha: "1111111111111111111111111111111111111111",
    permalink: "https://osv.dev/vulnerability/GHSA-wrw7-89jp-8q8g",
  });
});

test("OSV output already filtered by adjacent ignore configuration remains empty", async () => {
  const findings = normalizeOsvResults(
    await fixture("ignored-config-filtered.json"),
    await fixture("provenance.json"),
  );
  assert.deepEqual(findings, []);
});

test("normalization classifies severity and binds every finding to exact provenance", async () => {
  const findings = normalizeOsvResults(
    await fixture("severity-origin.json"),
    await fixture("provenance.json"),
  );
  assert.deepEqual(
    findings.map(
      ({ package: packageName, severity, repository, path, commitSha }) => ({
        packageName,
        severity,
        repository,
        path,
        commitSha,
      }),
    ),
    [
      {
        packageName: "dangerous-package",
        severity: "CRITICAL",
        repository: "LCV-Ideas-Software/example-app",
        path: "package-lock.json",
        commitSha: "2222222222222222222222222222222222222222",
      },
      {
        packageName: "moderate-package",
        severity: "MODERATE",
        repository: "LCV-Ideas-Software/example-app",
        path: "package-lock.json",
        commitSha: "2222222222222222222222222222222222222222",
      },
    ],
  );
});

test("zero-result fixture produces no findings and a deterministic closure message", async () => {
  const findings = normalizeOsvResults(
    await fixture("zero.json"),
    await fixture("provenance.json"),
  );
  const date = new Date("2026-08-05T01:30:00.000Z");
  assert.deepEqual(findings, []);
  assert.deepEqual(reportMetadata(findings, date), {
    count: 0,
    title: "OSS Advisory Watch — 04-08-2026",
    resolutionComment:
      "A execução do OSV-Scanner concluiu em 04/08/2026, 22:30 sem achados ativos após aplicar as configurações de exceção adjacentes aos lockfiles. Encerrando este alerta automaticamente.",
  });
});

test("Markdown is classified, carries origin, and presents time in pt-BR at fixed UTC-03", async () => {
  const findings = normalizeOsvResults(
    await fixture("severity-origin.json"),
    await fixture("provenance.json"),
  );
  const markdown = renderIssueBody(
    findings,
    new Date("2026-08-05T01:30:00.000Z"),
  );
  assert.match(markdown, /### CRITICAL \(1\)/);
  assert.match(
    markdown,
    /`LCV-Ideas-Software\/example-app\/package-lock\.json`/,
  );
  assert.match(markdown, /_Gerado em: 04\/08\/2026, 22:30_/);
  assert.doesNotMatch(markdown, /UTC|Brasília/);
});

test("normalization fails closed on unknown source provenance and incomplete JSON", async () => {
  const provenance = await fixture("provenance.json");
  assert.throws(
    () =>
      normalizeOsvResults(
        {
          results: [
            {
              source: { path: "unknown/Cargo.lock", type: "lockfile" },
              packages: [],
            },
          ],
          experimental_config: {},
        },
        provenance,
      ),
    /no exact provenance entry/,
  );
  assert.throws(
    () => normalizeOsvResults({}, provenance),
    /must contain a results array/,
  );
});

test("the public workflow excludes every non-public repository before reading trees", async () => {
  const workflow = await fs.readFile(
    new URL("../.github/workflows/oss-advisory-watch.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /\.visibility == "public"/);
  assert.match(workflow, /\.private == false/);
  assert.match(workflow, /GH_TOKEN: \$\{\{ github\.token \}\}/);
});
