import { readFile as nodeReadFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

const teamKeySchema = z.string().regex(/^[A-Z][A-Z0-9]{0,19}$/u);
const repositorySchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]{1,100}$/u)
  .refine((value) => value !== "." && value !== "..")
  .transform((value) => value.toLowerCase());
const organizationSchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u)
  .transform((value) => value.toLowerCase());
const linearUuidSchema = z.uuid().transform((value) => value.toLowerCase());

const mappingSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    linearTeamKey: teamKeySchema,
    mode: z.literal("github-backed"),
    repository: repositorySchema,
    linearReleasePipelineId: linearUuidSchema,
  }),
  z.strictObject({
    linearTeamKey: teamKeySchema,
    mode: z.literal("linear-only"),
  }),
  z.strictObject({
    linearTeamKey: teamKeySchema,
    mode: z.literal("umbrella"),
  }),
]);

export const operationalConfigSchema = z
  .strictObject({
    organization: organizationSchema,
    releaseRequiredAfter: z.iso.datetime({ offset: true }),
    commentGraceMinutes: z.number().int().nonnegative().max(10_080),
    mappings: z.array(mappingSchema).min(1),
  })
  .superRefine((config, context) => {
    const keys = new Set();
    const repositories = new Set();
    const releasePipelineIds = new Set();
    let umbrellas = 0;
    for (const [index, mapping] of config.mappings.entries()) {
      if (keys.has(mapping.linearTeamKey)) {
        context.addIssue({
          code: "custom",
          path: ["mappings", index, "linearTeamKey"],
          message: "linearTeamKey duplicada",
        });
      }
      keys.add(mapping.linearTeamKey);
      if (mapping.mode === "umbrella") umbrellas += 1;
      if (mapping.mode === "github-backed") {
        const repository = mapping.repository.toLowerCase();
        if (repositories.has(repository)) {
          context.addIssue({
            code: "custom",
            path: ["mappings", index, "repository"],
            message: "repository duplicado",
          });
        }
        repositories.add(repository);
        const pipelineId = mapping.linearReleasePipelineId.toLowerCase();
        if (releasePipelineIds.has(pipelineId)) {
          context.addIssue({
            code: "custom",
            path: ["mappings", index, "linearReleasePipelineId"],
            message: "linearReleasePipelineId duplicado",
          });
        }
        releasePipelineIds.add(pipelineId);
      }
    }
    if (umbrellas !== 1) {
      context.addIssue({
        code: "custom",
        path: ["mappings"],
        message: "a config deve conter exatamente um mapping umbrella",
      });
    }
  });

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value))
    return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function parseOperationalConfig(value) {
  const parsed = operationalConfigSchema.safeParse(value);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    throw new Error(`config operacional invalida: ${details}`);
  }
  return deepFreeze({
    ...parsed.data,
    organization: parsed.data.organization.toLowerCase(),
    mappings: parsed.data.mappings.map((mapping) =>
      mapping.mode === "github-backed"
        ? {
            ...mapping,
            repository: mapping.repository.toLowerCase(),
            linearReleasePipelineId:
              mapping.linearReleasePipelineId.toLowerCase(),
          }
        : { ...mapping },
    ),
  });
}

export async function loadOperationalConfig(
  configPath,
  { readFile = nodeReadFile } = {},
) {
  if (typeof configPath !== "string" || !path.isAbsolute(configPath)) {
    throw new Error(
      "o caminho da config operacional deve ser local e absoluto",
    );
  }
  let value;
  try {
    value = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    throw new Error("nao foi possivel ler a config operacional local", {
      cause: error,
    });
  }
  return parseOperationalConfig(value);
}

export const loadConfig = loadOperationalConfig;
