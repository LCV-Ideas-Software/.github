import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SEVERITY_ORDER = Object.freeze({
  CRITICAL: 0,
  HIGH: 1,
  MODERATE: 2,
  LOW: 3,
  UNKNOWN: 4,
});
const ADVISORY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function requiredString(value, context) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${context} must be a non-empty string.`);
  }
  return value;
}

function canonicalPath(value) {
  return path
    .resolve(requiredString(value, "Provenance path"))
    .replaceAll("\\", "/");
}

function markdownText(value) {
  return String(value)
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
    .replace(/[\\`*_{}\[\]<>]/g, "\\$&");
}

function inlineCode(value) {
  return `\`${String(value).replaceAll("`", "'").replaceAll("\r", " ").replaceAll("\n", " ")}\``;
}

function brasiliaTimestamp(date = new Date()) {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "Etc/GMT+3",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function brasiliaDateForTitle(date = new Date()) {
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "Etc/GMT+3",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.map(({ type, value }) => [type, value]),
  );
  return `${values.day}-${values.month}-${values.year}`;
}

function severityFromScore(score) {
  const numeric = Number.parseFloat(score);
  if (!Number.isFinite(numeric) || String(score).trim() === "")
    return undefined;
  if (numeric >= 9) return "CRITICAL";
  if (numeric >= 7) return "HIGH";
  if (numeric >= 4) return "MODERATE";
  if (numeric > 0) return "LOW";
  return undefined;
}

function normalizedNamedSeverity(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toUpperCase();
  if (normalized === "MEDIUM") return "MODERATE";
  return Object.hasOwn(SEVERITY_ORDER, normalized) ? normalized : undefined;
}

function groupSeverity(group, vulnerabilities) {
  const scored = severityFromScore(group.max_severity);
  if (scored) return scored;
  let severity = "UNKNOWN";
  for (const vulnerability of vulnerabilities) {
    const candidates = [
      vulnerability?.database_specific?.severity,
      ...(Array.isArray(vulnerability?.severity)
        ? vulnerability.severity.map(({ score }) => severityFromScore(score))
        : []),
    ];
    for (const candidate of candidates) {
      const normalized = normalizedNamedSeverity(candidate) ?? candidate;
      if (
        Object.hasOwn(SEVERITY_ORDER, normalized) &&
        SEVERITY_ORDER[normalized] < SEVERITY_ORDER[severity]
      ) {
        severity = normalized;
      }
    }
  }
  return severity;
}

function canonicalAdvisoryId(ids) {
  const ordered = [...ids].sort((left, right) => {
    const leftGhsa = left.startsWith("GHSA-") ? 0 : 1;
    const rightGhsa = right.startsWith("GHSA-") ? 0 : 1;
    return leftGhsa - rightGhsa || left.localeCompare(right);
  });
  return ordered[0];
}

function vulnerabilityIds(vulnerability) {
  return new Set(
    [
      vulnerability.id,
      ...(Array.isArray(vulnerability.aliases) ? vulnerability.aliases : []),
    ].filter((value) => typeof value === "string"),
  );
}

function fixedVersions(vulnerabilities, packageName, ecosystem) {
  const versions = new Set();
  for (const vulnerability of vulnerabilities) {
    if (!Array.isArray(vulnerability.affected)) continue;
    for (const affected of vulnerability.affected) {
      if (
        affected?.package?.name !== packageName ||
        affected?.package?.ecosystem !== ecosystem ||
        !Array.isArray(affected.ranges)
      ) {
        continue;
      }
      for (const range of affected.ranges) {
        if (!Array.isArray(range?.events)) continue;
        for (const event of range.events) {
          if (typeof event?.fixed === "string" && event.fixed.length > 0) {
            versions.add(event.fixed);
          }
        }
      }
    }
  }
  return [...versions].sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true }),
  );
}

export function parseProvenance(payload) {
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error("Provenance must contain at least one lockfile entry.");
  }
  const provenance = new Map();
  for (const [index, entry] of payload.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Provenance entry ${index} is malformed.`);
    }
    const repository = requiredString(
      entry.repository,
      `Provenance entry ${index} repository`,
    );
    const sourcePath = requiredString(
      entry.path,
      `Provenance entry ${index} path`,
    );
    const commitSha = requiredString(
      entry.commitSha,
      `Provenance entry ${index} commit SHA`,
    );
    const localPath = canonicalPath(entry.localPath);
    if (!/^LCV-Ideas-Software\/[A-Za-z0-9_.-]+$/.test(repository)) {
      throw new Error(`Provenance entry ${index} has an invalid repository.`);
    }
    if (!/^[0-9a-f]{40}$/.test(commitSha)) {
      throw new Error(`Provenance entry ${index} has an invalid commit SHA.`);
    }
    if (sourcePath.startsWith("/") || sourcePath.split("/").includes("..")) {
      throw new Error(`Provenance entry ${index} has an unsafe source path.`);
    }
    if (provenance.has(localPath)) {
      throw new Error(`Provenance contains duplicate local path ${localPath}.`);
    }
    provenance.set(
      localPath,
      Object.freeze({ repository, path: sourcePath, commitSha }),
    );
  }
  return provenance;
}

export function normalizeOsvResults(payload, provenancePayload) {
  if (
    !payload ||
    typeof payload !== "object" ||
    !Array.isArray(payload.results) ||
    !payload.experimental_config ||
    typeof payload.experimental_config !== "object" ||
    Array.isArray(payload.experimental_config)
  ) {
    throw new Error(
      "OSV Scanner JSON must contain a results array and experimental_config object.",
    );
  }
  const provenance = parseProvenance(provenancePayload);
  const findings = [];
  const dedupe = new Set();

  for (const [resultIndex, result] of payload.results.entries()) {
    const sourcePath = canonicalPath(result?.source?.path);
    const origin = provenance.get(sourcePath);
    if (!origin) {
      throw new Error(
        `OSV result ${resultIndex} has no exact provenance entry for ${sourcePath}.`,
      );
    }
    if (result.source.type !== "lockfile" || !Array.isArray(result.packages)) {
      throw new Error(
        `OSV result ${resultIndex} is not a lockfile result with packages.`,
      );
    }

    for (const [packageIndex, packageResult] of result.packages.entries()) {
      const packageName = requiredString(
        packageResult?.package?.name,
        `OSV result ${resultIndex} package ${packageIndex} name`,
      );
      const installedVersion = requiredString(
        packageResult?.package?.version,
        `OSV result ${resultIndex} package ${packageIndex} version`,
      );
      const ecosystem = requiredString(
        packageResult?.package?.ecosystem,
        `OSV result ${resultIndex} package ${packageIndex} ecosystem`,
      );
      const vulnerabilities = Array.isArray(packageResult.vulnerabilities)
        ? packageResult.vulnerabilities
        : [];
      const groups = Array.isArray(packageResult.groups)
        ? packageResult.groups
        : [];
      if (vulnerabilities.length > 0 && groups.length === 0) {
        throw new Error(
          `OSV result ${resultIndex} package ${packageIndex} has vulnerabilities without alias groups.`,
        );
      }

      for (const [groupIndex, group] of groups.entries()) {
        const aliases = new Set([
          ...(Array.isArray(group.ids) ? group.ids : []),
          ...(Array.isArray(group.aliases) ? group.aliases : []),
        ]);
        if (
          aliases.size === 0 ||
          [...aliases].some((id) => !ADVISORY_ID.test(id))
        ) {
          throw new Error(
            `OSV result ${resultIndex} package ${packageIndex} group ${groupIndex} has invalid advisory IDs.`,
          );
        }
        const relevantVulnerabilities = vulnerabilities.filter(
          (vulnerability) =>
            [...vulnerabilityIds(vulnerability)].some((id) => aliases.has(id)),
        );
        if (relevantVulnerabilities.length === 0) {
          throw new Error(
            `OSV result ${resultIndex} package ${packageIndex} group ${groupIndex} has no matching vulnerability record.`,
          );
        }
        const sortedAliases = [...aliases].sort();
        const advisoryId = canonicalAdvisoryId(sortedAliases);
        const key = [
          origin.repository,
          origin.path,
          ecosystem,
          packageName,
          installedVersion,
          sortedAliases.join(","),
        ].join("\u0000");
        if (dedupe.has(key)) continue;
        dedupe.add(key);

        const summaries = [
          ...new Set(
            relevantVulnerabilities
              .map(({ summary }) => summary)
              .filter(
                (summary) =>
                  typeof summary === "string" && summary.trim().length > 0,
              )
              .map((summary) => summary.trim()),
          ),
        ];
        findings.push(
          Object.freeze({
            advisoryId,
            aliases: sortedAliases,
            severity: groupSeverity(group, relevantVulnerabilities),
            ecosystem,
            package: packageName,
            installedVersion,
            fixedVersions: fixedVersions(
              relevantVulnerabilities,
              packageName,
              ecosystem,
            ),
            summary:
              summaries.join(" / ") || "Advisory sem resumo no registro OSV.",
            repository: origin.repository,
            path: origin.path,
            commitSha: origin.commitSha,
            permalink: `https://osv.dev/vulnerability/${encodeURIComponent(advisoryId)}`,
          }),
        );
      }
    }
  }

  return findings.sort(
    (left, right) =>
      SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity] ||
      left.repository.localeCompare(right.repository) ||
      left.path.localeCompare(right.path) ||
      left.package.localeCompare(right.package) ||
      left.advisoryId.localeCompare(right.advisoryId),
  );
}

export function renderIssueBody(findings, date = new Date()) {
  if (!Array.isArray(findings)) throw new Error("Findings must be an array.");
  const lines = [
    `## OSS Advisory Watch — ${findings.length} achado(s) ativo(s)`,
    "",
    "_Fonte: OSV-Scanner oficial aplicado aos lockfiles dos repositórios públicos ativos e não arquivados; os arquivos `osv-scanner.toml` adjacentes foram respeitados. Repositórios privados ficam fora deste workflow público e devem ser auditados separadamente no repositório privado de governança._",
    `_Gerado em: ${brasiliaTimestamp(date)}_`,
    "",
  ];
  for (const severity of Object.keys(SEVERITY_ORDER)) {
    const group = findings.filter((finding) => finding.severity === severity);
    if (group.length === 0) continue;
    lines.push(`### ${severity} (${group.length})`, "");
    for (const finding of group) {
      lines.push(
        `- **${markdownText(finding.package)}** (${inlineCode(finding.ecosystem)}) — [${markdownText(finding.advisoryId)}](${finding.permalink})`,
        `  - Origem: ${inlineCode(`${finding.repository}/${finding.path}`)}`,
        `  - Commit auditado: ${inlineCode(finding.commitSha)}`,
        `  - Versão instalada: ${inlineCode(finding.installedVersion)}`,
        `  - Aliases: ${finding.aliases.map(inlineCode).join(", ")}`,
        `  - Versões corrigidas: ${finding.fixedVersions.length > 0 ? finding.fixedVersions.map(inlineCode).join(", ") : "não informadas"}`,
        `  - Resumo: ${markdownText(finding.summary)}`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export function reportMetadata(findings, date = new Date()) {
  return Object.freeze({
    count: findings.length,
    title: `OSS Advisory Watch — ${brasiliaDateForTitle(date)}`,
    resolutionComment: `A execução do OSV-Scanner concluiu em ${brasiliaTimestamp(date)} sem achados ativos após aplicar as configurações de exceção adjacentes aos lockfiles. Encerrando este alerta automaticamente.`,
  });
}

function parseArguments(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      !name?.startsWith("--") ||
      value === undefined ||
      value.startsWith("--")
    ) {
      throw new Error("Arguments must be supplied as --name value pairs.");
    }
    if (options.has(name)) throw new Error(`Duplicate argument ${name}.`);
    options.set(name, value);
  }
  const allowed = new Set([
    "--input",
    "--provenance",
    "--findings",
    "--markdown",
    "--metadata",
  ]);
  for (const name of options.keys()) {
    if (!allowed.has(name)) throw new Error(`Unknown argument ${name}.`);
  }
  for (const name of allowed) {
    if (!options.has(name))
      throw new Error(`Missing required argument ${name}.`);
  }
  return options;
}

export async function main(argv = process.argv.slice(2), date = new Date()) {
  const options = parseArguments(argv);
  const [payload, provenancePayload] = await Promise.all([
    fs.readFile(options.get("--input"), "utf8").then(JSON.parse),
    fs.readFile(options.get("--provenance"), "utf8").then(JSON.parse),
  ]);
  const findings = normalizeOsvResults(payload, provenancePayload);
  const metadata = reportMetadata(findings, date);
  await Promise.all([
    fs.writeFile(
      options.get("--findings"),
      `${JSON.stringify(findings, null, 2)}\n`,
      "utf8",
    ),
    fs.writeFile(
      options.get("--markdown"),
      renderIssueBody(findings, date),
      "utf8",
    ),
    fs.writeFile(
      options.get("--metadata"),
      `${JSON.stringify(metadata, null, 2)}\n`,
      "utf8",
    ),
  ]);
  console.log(JSON.stringify(metadata));
  return { findings, metadata };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(`OSS Advisory Watch normalization failed: ${error.message}`);
    process.exitCode = 2;
  });
}
