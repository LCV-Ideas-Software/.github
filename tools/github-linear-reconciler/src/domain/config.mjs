import { finding } from "./findings.mjs";
import { TEAM_MODES } from "./model.mjs";

function nonempty(value) {
  return (
    typeof value === "string" && value === value.trim() && value.length > 0
  );
}

function instantMilliseconds(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string" && value === value.trim() && value) {
    return new Date(value).getTime();
  }
  return Number.NaN;
}

function stableUuid(value) {
  return (
    nonempty(value) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      value,
    )
  );
}

export function validateConfig(config) {
  const reasons = [];
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    reasons.push("config must be an object");
  }
  const organization = config?.organization;
  if (!nonempty(organization)) reasons.push("organization must be a string");
  if (
    !Number.isFinite(config?.commentGraceMinutes) ||
    config.commentGraceMinutes < 0
  ) {
    reasons.push("commentGraceMinutes must be finite and non-negative");
  }
  const commentGraceMs = Number(config?.commentGraceMinutes) * 60_000;
  if (!Number.isFinite(commentGraceMs)) {
    reasons.push("commentGraceMinutes exceeds the supported range");
  }
  const releaseRequiredAfterMs = instantMilliseconds(
    config?.releaseRequiredAfter,
  );
  if (!Number.isFinite(releaseRequiredAfterMs)) {
    reasons.push("releaseRequiredAfter must be a valid instant");
  }
  if (!Array.isArray(config?.mappings))
    reasons.push("mappings must be an array");

  const mappingByTeam = new Map();
  const mappingByRepository = new Map();
  const pipelineIds = new Set();
  const umbrellas = [];
  for (const mapping of Array.isArray(config?.mappings)
    ? config.mappings
    : []) {
    if (
      !mapping ||
      typeof mapping !== "object" ||
      Array.isArray(mapping) ||
      !nonempty(mapping.linearTeamKey) ||
      !TEAM_MODES.includes(mapping.mode)
    ) {
      reasons.push("each mapping needs a team key and supported mode");
      continue;
    }
    const normalizedMapping =
      mapping.mode === "github-backed" && nonempty(mapping.repository)
        ? { ...mapping, repository: mapping.repository.toLowerCase() }
        : mapping;
    if (mappingByTeam.has(mapping.linearTeamKey)) {
      reasons.push(`duplicate team mapping: ${mapping.linearTeamKey}`);
    } else {
      mappingByTeam.set(mapping.linearTeamKey, normalizedMapping);
    }
    if (mapping.mode === "umbrella") umbrellas.push(mapping.linearTeamKey);
    if (mapping.mode === "github-backed") {
      if (
        !nonempty(mapping.repository) ||
        !stableUuid(mapping.linearReleasePipelineId)
      ) {
        reasons.push(`invalid repository mapping: ${mapping.linearTeamKey}`);
      } else if (mappingByRepository.has(mapping.repository.toLowerCase())) {
        reasons.push(
          `duplicate repository mapping: ${mapping.repository.toLowerCase()}`,
        );
      } else {
        if (pipelineIds.has(mapping.linearReleasePipelineId)) {
          reasons.push(
            `duplicate release pipeline mapping: ${mapping.linearReleasePipelineId}`,
          );
        }
        pipelineIds.add(mapping.linearReleasePipelineId);
        mappingByRepository.set(
          mapping.repository.toLowerCase(),
          normalizedMapping,
        );
      }
    } else if (nonempty(mapping.repository)) {
      reasons.push(`repository is not allowed for mode ${mapping.mode}`);
    }
  }
  if (umbrellas.length !== 1) reasons.push("exactly one umbrella is required");

  const findings = reasons.map((reason) =>
    finding("incomplete", "configuration_invalid", "configuration", reason),
  );
  return {
    findings,
    mappingByTeam,
    mappingByRepository,
    umbrellaTeamKey: umbrellas.length === 1 ? umbrellas[0] : null,
    releaseRequiredAfterMs,
    commentGraceMs,
    organization: nonempty(organization) ? organization.toLowerCase() : "",
  };
}
