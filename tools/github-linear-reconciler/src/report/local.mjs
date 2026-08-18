import { randomUUID } from "node:crypto";
import {
  lstat as nodeLstat,
  mkdir as nodeMkdir,
  open as nodeOpen,
  readdir,
  realpath as nodeRealpath,
  rename as nodeRename,
  rmdir as nodeRmdir,
  unlink as nodeUnlink,
} from "node:fs/promises";
import path from "node:path";

import {
  assertOutsideGitWorktree,
  assertOwnedLocalProfile,
  assertPrivateDirectoryPath,
  assertPrivateFilePath,
  hardenCreatedPrivatePath,
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

async function pruneExpiredReports(
  directory,
  now,
  currentReportPath,
  { env, lstatImpl, platform, readWindowsAclImpl, unlinkImpl },
) {
  const cutoff = now.getTime() - RETENTION_MS;
  const removed = [];
  const candidates = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (
      !entry.name.startsWith(REPORT_PREFIX) ||
      !entry.name.endsWith(REPORT_SUFFIX)
    ) {
      continue;
    }
    const candidate = path.join(directory, entry.name);
    if (candidate === currentReportPath) continue;
    const metadata = await lstatImpl(candidate);
    await assertPrivateFilePath(candidate, metadata, "relatório preexistente", {
      env,
      platform,
      readWindowsAclImpl,
    });
    candidates.push([candidate, metadata]);
  }
  for (const [candidate, metadata] of candidates) {
    if (metadata.mtimeMs >= cutoff) continue;
    await unlinkImpl(candidate);
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
  mkdirImpl = nodeMkdir,
  openImpl = nodeOpen,
  readWindowsAclImpl,
  realpathImpl = nodeRealpath,
  renameImpl = nodeRename,
  rmdirImpl = nodeRmdir,
  setWindowsAclImpl,
  stagingIdFactory = randomUUID,
  unlinkImpl = nodeUnlink,
} = {}) {
  const timestamp = requireDate(now, "now");
  const runtimePlatform = platform ?? process.platform;
  const profile = await assertOwnedLocalProfile({
    root: directory,
    env,
    homedir,
    platform: runtimePlatform,
    lstatImpl,
    readWindowsAclImpl,
    realpathImpl,
  });
  const configuredDirectory = profile.reportsPath;
  let reportsDirectoryMissing = false;
  try {
    await lstatImpl(configuredDirectory);
  } catch (error) {
    if (!isMissingPath(error)) throw error;
    reportsDirectoryMissing = true;
  }
  if (reportsDirectoryMissing) {
    const stagingId = String(stagingIdFactory()).replace(
      /[^a-zA-Z0-9_-]/gu,
      "",
    );
    if (!stagingId)
      throw new TypeError("identificador de staging de relatórios inválido");
    const stagingDirectory = path.join(
      profile.root,
      `.reports.${process.pid}.${stagingId}.tmp`,
    );
    let stagingCreated = false;
    let movedToFinal = false;
    try {
      await mkdirImpl(stagingDirectory, { recursive: false, mode: 0o700 });
      stagingCreated = true;
      await hardenCreatedPrivatePath(stagingDirectory, {
        env,
        kind: "directory",
        label: "staging do diretório de relatórios",
        lstatImpl,
        platform: runtimePlatform,
        readWindowsAclImpl,
        setWindowsAclImpl,
      });
      await renameImpl(stagingDirectory, configuredDirectory);
      movedToFinal = true;
      await assertPrivateDirectoryPath(
        configuredDirectory,
        await lstatImpl(configuredDirectory),
        "diretório de relatórios",
        { env, platform: runtimePlatform, readWindowsAclImpl },
      );
    } catch (error) {
      if (stagingCreated) {
        await rmdirImpl(
          movedToFinal ? configuredDirectory : stagingDirectory,
        ).catch((rmdirError) => {
          if (!isMissingPath(rmdirError)) throw rmdirError;
        });
      }
      throw error;
    }
  }
  await assertPrivateDirectoryPath(
    configuredDirectory,
    await lstatImpl(configuredDirectory),
    "diretório de relatórios",
    { env, platform: runtimePlatform, readWindowsAclImpl },
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
  let movedToFinal = false;
  try {
    handle = await openImpl(temporaryPath, "wx", 0o600);
    await hardenCreatedPrivatePath(temporaryPath, {
      env,
      kind: "file",
      label: "arquivo temporário de relatório",
      lstatImpl,
      platform: runtimePlatform,
      readWindowsAclImpl,
      setWindowsAclImpl,
    });
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await renameImpl(temporaryPath, reportPath);
    movedToFinal = true;
    await assertPrivateFilePath(
      reportPath,
      await lstatImpl(reportPath),
      "arquivo final de relatório",
      { env, platform: runtimePlatform, readWindowsAclImpl },
    );
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlinkImpl(movedToFinal ? reportPath : temporaryPath).catch(() => {});
    throw error;
  }

  let removed;
  try {
    removed = await pruneExpiredReports(
      reportDirectory,
      timestamp,
      reportPath,
      {
        env,
        lstatImpl,
        platform: runtimePlatform,
        readWindowsAclImpl,
        unlinkImpl,
      },
    );
  } catch (error) {
    await unlinkImpl(reportPath).catch(() => {});
    throw error;
  }
  return { path: reportPath, removed };
}

export const LOCAL_REPORT_RETENTION_DAYS = RETENTION_DAYS;
