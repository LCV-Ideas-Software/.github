import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const workerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(workerRoot, "src");

describe("Cloudflare network boundary", () => {
  it("keeps only the required production ingress and disables preview URLs", () => {
    const config = readFileSync(resolve(workerRoot, "wrangler.jsonc"), "utf8");

    expect(config).toMatch(/"workers_dev"\s*:\s*true/);
    expect(config).toMatch(/"preview_urls"\s*:\s*false/);
  });

  it("never calls another Cloudflare application through a public dev URL", () => {
    const source = readdirSync(sourceRoot)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => readFileSync(resolve(sourceRoot, name), "utf8"))
      .join("\n");

    expect(source).not.toMatch(/\.(?:workers|pages)\.dev\b/i);
  });
});
