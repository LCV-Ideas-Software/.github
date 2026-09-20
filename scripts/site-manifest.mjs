#!/usr/bin/env node

// The published site lives in two repositories and must be byte-identical in
// both. This writes, or verifies, a deterministic digest of every file under
// site/ so each island can prove its own copy and compare it with the other's
// published manifest — without a central controller.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, posix, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const SITE_ROOT = join(repositoryRoot, "site");
export const MANIFEST_NAME = "site-manifest.json";
export const MANIFEST_PATH = join(SITE_ROOT, MANIFEST_NAME);

function walk(directory) {
  const found = [];
  for (const entry of readdirSync(directory).sort()) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) found.push(...walk(full));
    else found.push(full);
  }
  return found;
}

export function buildManifest(siteRoot = SITE_ROOT) {
  const files = {};
  for (const full of walk(siteRoot)) {
    const key = relative(siteRoot, full).split("\\").join(posix.sep);
    // The manifest cannot describe itself.
    if (key === MANIFEST_NAME) continue;
    files[key] = createHash("sha256").update(readFileSync(full)).digest("hex");
  }
  return { files };
}

export function serializeManifest(manifest) {
  // Sorted keys and a fixed shape: both repositories must produce the same bytes.
  const files = Object.fromEntries(
    Object.keys(manifest.files)
      .sort((left, right) => left.localeCompare(right, "en"))
      .map((key) => [key, manifest.files[key]]),
  );
  return `${JSON.stringify({ files }, null, 2)}\n`;
}

export function readManifest(path = MANIFEST_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function diffManifests(mine, theirs) {
  const differences = [];
  for (const key of [...new Set([...Object.keys(mine.files), ...Object.keys(theirs.files)])].sort()) {
    const left = mine.files[key];
    const right = theirs.files[key];
    if (left === right) continue;
    if (!left) differences.push(`${key}: absent here, present there`);
    else if (!right) differences.push(`${key}: present here, absent there`);
    else differences.push(`${key}: differs`);
  }
  return differences;
}

function main(argv) {
  const manifest = buildManifest();
  if (argv.includes("--write")) {
    writeFileSync(MANIFEST_PATH, serializeManifest(manifest), "utf8");
    process.stdout.write(`Wrote ${Object.keys(manifest.files).length} entries to site/${MANIFEST_NAME}.\n`);
    return;
  }
  const recorded = readManifest();
  const differences = diffManifests(manifest, recorded);
  if (differences.length > 0) {
    for (const difference of differences) process.stderr.write(`DRIFT ${difference}\n`);
    throw new Error(`site/${MANIFEST_NAME} does not describe site/; run npm run site:manifest`);
  }
  process.stdout.write(`site/${MANIFEST_NAME} matches all ${Object.keys(manifest.files).length} files.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
