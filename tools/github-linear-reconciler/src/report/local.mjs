import { randomUUID } from "node:crypto";
import {
  lstat as nodeLstat,
  mkdir,
  open,
  readdir,
  realpath as nodeRealpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import {
  assertOutsideGitWorktree,
  assertOwnedLocalProfile,
  assertPrivateDirectory,
  assertPrivateFile,
  resolveLocalProfileRoot,
} from "../local-profile.mjs";

const REPORT_PREFIX = "github-linear-reconciliation-";
const REPORT_SUFFIX = ".json";
const RETENTION_DAYS = 14;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1_000;
const VALID_STATES = new Set(["clean", "advisory", "drift", "incomplete"]);
const FINDING_STRING_FIELDS = ["severity", "code", "entity", "message"];

function requireDate(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime()))
    throw new TypeError(`${label} inválido`);
  return date;
}

function normalizedState(result) {
  if (!VALID_STATES.has(result?.state))
    throw new TypeError("resultado sem estado válido");
  return result.state;
}

function normalizedCounts(result) {
  if (!result?.counts || typeof result.counts !== "object")
    throw new TypeError("resultado sem contagens válidas");
  return Object.fromEntries(
    Object.entries(result.counts)
      .filter(
        ([key, value]) =>
          typeof key === "string" &&
          key.length > 0 &&
          typeof value === "number" &&
          Number.isFinite(value) &&
          value >= 0,
      )
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function sanitizedFinding(finding) {
  if (!finding || typeof finding !== "object" || Array.isArray(finding))
    throw new TypeError("finding inválido");
  const sanitized = {};
  for (const field of FINDING_STRING_FIELDS) {
    if (typeof finding[field] !== "string" || finding[field].length === 0)
      throw new TypeError(`finding sem ${field} válido`);
    sanitized[field] = finding[field];
  }
  if (!Array.isArray(finding.references))
    throw new TypeError("finding sem references válido");
  sanitized.references = finding.references.map((reference) => {
    if (typeof reference !== "string" || reference.length === 0)
      throw new TypeError("finding com referência inválida");
    return reference;
  });
  return sanitized;
}

export function buildLocalReport(result, { generatedAt = new Date() } = {}) {
  const timestamp = requireDate(generatedAt, "generatedAt");
  if (!Array.isArray(result?.findings))
    throw new TypeError("resultado sem findings válidos");
  return {
    schemaVersion: 1,
    generatedAt: timestamp.toISOString(),
    state: normalizedState(result),
    counts: normalizedCounts(result),
    findings: result.findings.map(sanitizedFinding),
  };
}

export function renderRedactedStatus(result) {
  return JSON.stringify({
    state: normalizedState(result),
    counts: normalizedCounts(result),
  });
}

export function resolveLocalReportDirectory({
  env = process.env,
  homedir,
  platform = process.platform,
} = {}) {
  return path.join(
    resolveLocalProfileRoot({ env, homedir, platform }),
    "reports",
  );
}

function isMissingPath(error) {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT",
  );
}

async function pruneExpiredReports(directory, now, currentReportPath) {
  const cutoff = now.getTime() - RETENTION_MS;
  const removed = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      !entry.name.startsWith(REPORT_PREFIX) ||
      !entry.name.endsWith(REPORT_SUFFIX)
    ) {
      continue;
    }
    const candidate = path.join(directory, entry.name);
    if (candidate === currentReportPath) continue;
    const metadata = await stat(candidate);
    if (metadata.mtimeMs >= cutoff) continue;
    await unlink(candidate);
    removed.push(candidate);
  }
  return removed.sort();
}

export async function writeLocalReport({
  result,
  now = new Date(),
  directory,
  env = process.env,
  homedir,
  platform,
  idFactory = randomUUID,
  lstatImpl = nodeLstat,
  realpathImpl = nodeRealpath,
} = {}) {
  const timestamp = requireDate(now, "now");
  const runtimePlatform = platform ?? process.platform;
  const profile = await assertOwnedLocalProfile({
    root: directory,
    env,
    homedir,
    platform: runtimePlatform,
    lstatImpl,
    realpathImpl,
  });
  const configuredDirectory = profile.reportsPath;
  try {
    await lstatImpl(configuredDirectory);
  } catch (error) {
    if (!isMissingPath(error)) throw error;
    await mkdir(configuredDirectory, { recursive: false, mode: 0o700 });
  }
  assertPrivateDirectory(
    await lstatImpl(configuredDirectory),
    "diretório de relatórios",
    runtimePlatform,
  );
  const reportDirectory = await realpathImpl(configuredDirectory);
  if (path.relative(profile.reportsPath, reportDirectory) !== "") {
    throw new TypeError(
      "diretório de relatórios possui destino canônico inválido",
    );
  }
  await assertOutsideGitWorktree(reportDirectory, {
    candidateIsDirectory: true,
    lstatImpl,
    realpathImpl,
  });

  const timestampForName = timestamp.toISOString().replace(/[:.]/gu, "-");
  const uniqueId = String(idFactory()).replace(/[^a-zA-Z0-9_-]/gu, "");
  if (!uniqueId) throw new TypeError("identificador de relatório inválido");
  const reportName = `${REPORT_PREFIX}${timestampForName}-${uniqueId}${REPORT_SUFFIX}`;
  const reportPath = path.join(reportDirectory, reportName);
  const temporaryPath = path.join(
    reportDirectory,
    `.${reportName}.${process.pid}.tmp`,
  );
  const serialized = `${JSON.stringify(
    buildLocalReport(result, { generatedAt: timestamp }),
    null,
    2,
  )}\n`;

  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    assertPrivateFile(
      await handle.stat(),
      "arquivo temporário de relatório",
      runtimePlatform,
    );
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, reportPath);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }

  const removed = await pruneExpiredReports(
    reportDirectory,
    timestamp,
    reportPath,
  );
  return { path: reportPath, removed };
}

export const LOCAL_REPORT_RETENTION_DAYS = RETENTION_DAYS;
