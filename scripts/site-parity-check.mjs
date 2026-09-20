#!/usr/bin/env node

// Fetches the site manifest published by the other repository and fails when
// the two copies of site/ have drifted apart. Each repository checks itself
// against a digest the other publishes over HTTPS: no central controller, and
// no credential — both manifests are public.

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { buildManifest, diffManifests, readManifest } from "./site-manifest.mjs";

// The counterpart copy of this site lives in LCV-Ideas-Software/.github-private,
// which publishes enterprise.lcv.dev on GitHub Pages and www.lcv.dev on
// Cloudflare Pages from the same site/.
export const COUNTERPART_MANIFEST_URL = "https://enterprise.lcv.dev/site-manifest.json";
const TIMEOUT_MS = 20_000;

export async function fetchManifest(url, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
    const payload = await response.json();
    if (!payload || typeof payload !== "object" || typeof payload.files !== "object") {
      throw new Error(`${url} did not return a site manifest`);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const local = buildManifest();
  const recorded = readManifest();
  const selfDrift = diffManifests(local, recorded);
  if (selfDrift.length > 0) {
    for (const drift of selfDrift) process.stderr.write(`LOCAL DRIFT ${drift}\n`);
    throw new Error("the recorded manifest does not describe this repository's site/");
  }

  const counterpart = await fetchManifest(COUNTERPART_MANIFEST_URL);
  const differences = diffManifests(local, counterpart);
  process.stdout.write(
    `Compared ${Object.keys(local.files).length} files against ${COUNTERPART_MANIFEST_URL}; ` +
      `${differences.length} difference(s).\n`,
  );
  if (differences.length > 0) {
    for (const difference of differences) process.stderr.write(`PARITY ${difference}\n`);
    throw new Error("the two published copies of site/ have drifted apart");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
