import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildManifest,
  diffManifests,
  readManifest,
  serializeManifest,
} from "../scripts/site-manifest.mjs";

test("the recorded manifest describes every file under site/", () => {
  const differences = diffManifests(buildManifest(), readManifest());
  assert.deepEqual(differences, [], `site/site-manifest.json drifted: ${differences.join("; ")}`);
});

test("the manifest is byte-deterministic, so both repositories write the same file", () => {
  const manifest = buildManifest();
  const shuffled = {
    files: Object.fromEntries(Object.entries(manifest.files).reverse()),
  };
  assert.equal(serializeManifest(manifest), serializeManifest(shuffled));
  assert.match(serializeManifest(manifest), /\n$/);
});

test("the manifest never describes itself", () => {
  assert.equal(Object.hasOwn(buildManifest().files, "site-manifest.json"), false);
});

test("a changed, added or removed file is reported, not tolerated", () => {
  const root = mkdtempSync(join(tmpdir(), "site-"));
  mkdirSync(join(root, "nested"));
  writeFileSync(join(root, "index.html"), "<!doctype html>\n");
  writeFileSync(join(root, "nested", "app.js"), "export {};\n");
  const original = buildManifest(root);

  writeFileSync(join(root, "index.html"), "<!doctype html><!-- edited -->\n");
  assert.deepEqual(diffManifests(buildManifest(root), original), ["index.html: differs"]);

  writeFileSync(join(root, "extra.css"), "body{}\n");
  const withExtra = diffManifests(buildManifest(root), original);
  assert.ok(withExtra.includes("extra.css: present here, absent there"));
});

test("an empty counterpart manifest is drift, never silent agreement", () => {
  const differences = diffManifests(buildManifest(), { files: {} });
  assert.ok(differences.length > 0);
  assert.ok(differences.every((entry) => entry.endsWith("present here, absent there")));
});
