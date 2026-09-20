import assert from "node:assert/strict";
import test from "node:test";

import { COUNTERPART_MANIFEST_URL, fetchManifest } from "../scripts/site-parity-check.mjs";

// The network check itself runs in its own scheduled workflow; these tests pin
// the contract it relies on, offline.

test("the counterpart is the other repository's published site, over HTTPS", () => {
  const url = new URL(COUNTERPART_MANIFEST_URL);
  assert.equal(url.protocol, "https:");
  assert.equal(url.hostname, "enterprise.lcv.dev");
  assert.equal(url.pathname, "/site-manifest.json");
});

test("a manifest is accepted only when it is one", async () => {
  const manifest = await fetchManifest("https://example.test/site-manifest.json", {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ files: { "index.html": "a" } }) }),
  });
  assert.deepEqual(manifest.files, { "index.html": "a" });
});

test("an HTTP error fails closed instead of passing as agreement", async () => {
  await assert.rejects(
    fetchManifest("https://example.test/site-manifest.json", {
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    }),
    /HTTP 404/,
  );
});

test("a page that is not a manifest fails closed", async () => {
  await assert.rejects(
    fetchManifest("https://example.test/site-manifest.json", {
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ hello: "world" }) }),
    }),
    /did not return a site manifest/,
  );
});
