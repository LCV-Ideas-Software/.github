// Prova remota do D1 do relay (ADR-002): aplica a cadeia INTEIRA de
// migrações num banco descartável REAL (mesma engine e mesmo caminho do
// deploy) e afirma o esquema FINAL do caminho v2 — alert_delivery e seus
// dois índices, nada além. A prova roda ANTES do deploy tocar o banco de
// produção; se a cadeia não aplicar limpa aqui, o deploy nem começa.
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RELAY_ROOT = join(REPOSITORY_ROOT, "workers", "github-slack-relay");
const WRANGLER_ENTRYPOINT = join(
  RELAY_ROOT,
  "node_modules",
  "wrangler",
  "bin",
  "wrangler.js",
);

export const DATABASE_NAME_PREFIX = "tmp-slack-relay-171-";
export const DISPOSABLE_DATABASE_NAME_PATTERN =
  /^tmp-slack-relay-171-[0-9]{13}-[0-9a-f]{8}$/u;
const DATABASE_ID_PATTERN = /^[0-9a-f-]{36}$/u;
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/u;
const PRODUCTION_DATABASE_ID = "cf070eb0-32d9-4ee0-9516-d469833cdc77";
export const API_TIMEOUT_MS = 15_000;
export const WRANGLER_TIMEOUT_MS = 120_000;
export const STALE_DATABASE_AGE_MS = 3 * 60 * 60_000;
export const REMOTE_PROOF_MINIMUM_MARGIN_MS = 10 * 60_000;
const DELETE_CONFIRMATION_ATTEMPTS = 4;

// A migração 0006 sela o protocolo legado e EXIGE o estado de ativação
// histórico em relay_state (a 0001 o cria inativo). O pipeline legado foi
// aposentado, mas a cadeia de migrações é história imutável: a prova semeia
// a MESMA tupla de produção entre a 0005 e a 0006, exatamente como a
// implantação real viveu. Valores preservados do módulo de contrato
// aposentado (slack-delivery-protocol-contract.mjs).
const SEAL_MIGRATION_NAME = "0006_seal_slack_delivery_protocol.sql";
const SEALED_PROTOCOL_REVISION = "e0131a758123cf210d9cc9e7e537b72dc0441a90";
const SEALED_PROTOCOL_ACTIVATED_AT = 1_786_579_752_661;
const SEALED_PROTOCOL_ACTIVATION_ID =
  "18a94ba84d6bac0f8ae396996a5cd6ac026eb336be5eef702b92b3b6a60d4ff7";

// O esquema final EXATO do caminho v2 (pós-0011): qualquer objeto a mais ou
// a menos é falha — inclusive um vestígio legado que uma migração deixasse.
export const EXPECTED_FINAL_SCHEMA = Object.freeze([
  { type: "index", name: "idx_alert_delivery_due" },
  { type: "index", name: "idx_alert_delivery_pending" },
  { type: "table", name: "alert_delivery" },
  { type: "table", name: "d1_migrations" },
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export function verifyRemoteProofDeadline(environment, nowMs = Date.now()) {
  const raw = environment.REMOTE_PROOF_DEADLINE_MS;
  invariant(
    typeof raw === "string" && /^[0-9]{1,15}$/u.test(raw),
    "REMOTE_PROOF_DEADLINE_MS is missing or malformed; the job must establish the fail-closed deadline first.",
  );
  const deadline = Number.parseInt(raw, 10);
  invariant(
    deadline - nowMs >= REMOTE_PROOF_MINIMUM_MARGIN_MS,
    `The remote proof has less than ${REMOTE_PROOF_MINIMUM_MARGIN_MS} ms of margin before the job deadline; refusing to start work it cannot finish.`,
  );
  return deadline;
}

function readConfiguration(environment) {
  const accountId = environment.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = environment.CLOUDFLARE_API_TOKEN;
  invariant(
    typeof accountId === "string" && ACCOUNT_ID_PATTERN.test(accountId),
    "CLOUDFLARE_ACCOUNT_ID is missing or malformed.",
  );
  invariant(
    typeof apiToken === "string" && /^\S{20,}$/u.test(apiToken),
    "CLOUDFLARE_API_TOKEN is missing or malformed.",
  );
  return { accountId, apiToken };
}

async function cloudflareRequest(configuration, path, init = {}) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${configuration.apiToken}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
      redirect: "error",
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    },
  );
  const payload = await response.json();
  invariant(
    payload?.success === true,
    `Cloudflare API ${path} failed (HTTP ${response.status}): ${JSON.stringify(payload?.errors ?? [])}`,
  );
  return payload;
}

async function listDatabases(configuration) {
  const payload = await cloudflareRequest(
    configuration,
    `/accounts/${configuration.accountId}/d1/database?per_page=1000`,
  );
  invariant(Array.isArray(payload.result), "D1 database list is not an array.");
  return payload.result;
}

export function parseDisposableTimestamp(name) {
  const match = /^tmp-slack-relay-171-([0-9]{13})-[0-9a-f]{8}$/u.exec(name);
  return match === null ? null : Number.parseInt(match[1], 10);
}

async function reapStaleDisposables(configuration, nowMs) {
  const databases = await listDatabases(configuration);
  for (const database of databases) {
    const createdMs = parseDisposableTimestamp(database.name ?? "");
    if (createdMs === null) continue;
    if (nowMs - createdMs < STALE_DATABASE_AGE_MS) continue;
    invariant(
      database.uuid !== PRODUCTION_DATABASE_ID,
      "Refusing to reap: a disposable-named database carries the production ID.",
    );
    console.log(`Reaping stale disposable database ${database.name}.`);
    await deleteDatabaseWithConfirmation(configuration, database.uuid);
  }
}

async function createDisposableDatabase(configuration, nowMs) {
  const suffix = [...crypto.getRandomValues(new Uint8Array(4))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const name = `${DATABASE_NAME_PREFIX}${String(nowMs)}-${suffix}`;
  invariant(
    DISPOSABLE_DATABASE_NAME_PATTERN.test(name),
    `Generated disposable name does not match its own pattern: ${name}`,
  );
  const payload = await cloudflareRequest(
    configuration,
    `/accounts/${configuration.accountId}/d1/database`,
    { method: "POST", body: JSON.stringify({ name }) },
  );
  const databaseId = payload.result?.uuid;
  invariant(
    typeof databaseId === "string" && DATABASE_ID_PATTERN.test(databaseId),
    "Disposable D1 creation returned no usable database ID.",
  );
  invariant(
    databaseId !== PRODUCTION_DATABASE_ID,
    "Disposable D1 creation returned the PRODUCTION database ID.",
  );
  return { databaseId, name };
}

async function deleteDatabaseWithConfirmation(configuration, databaseId) {
  invariant(
    databaseId !== PRODUCTION_DATABASE_ID,
    "Refusing to delete the production database.",
  );
  for (let attempt = 0; attempt < DELETE_CONFIRMATION_ATTEMPTS; attempt += 1) {
    try {
      await cloudflareRequest(
        configuration,
        `/accounts/${configuration.accountId}/d1/database/${databaseId}`,
        { method: "DELETE" },
      );
    } catch (error) {
      if (attempt + 1 === DELETE_CONFIRMATION_ATTEMPTS) throw error;
    }
    const databases = await listDatabases(configuration);
    if (!databases.some((database) => database.uuid === databaseId)) {
      return;
    }
    await delay(250 * 2 ** attempt);
  }
  throw new Error(
    `Disposable database ${databaseId} still listed after ${DELETE_CONFIRMATION_ATTEMPTS} delete attempts.`,
  );
}

async function d1Query(configuration, databaseId, sql) {
  const payload = await cloudflareRequest(
    configuration,
    `/accounts/${configuration.accountId}/d1/database/${databaseId}/query`,
    { method: "POST", body: JSON.stringify({ sql }) },
  );
  const first = Array.isArray(payload.result) ? payload.result[0] : undefined;
  invariant(first?.success === true, `D1 query failed: ${sql}`);
  return first.results ?? [];
}

function applyMigrationsWithWrangler(temporaryConfigPath) {
  // Ambiente esfregado: o wrangler só enxerga o necessário; o token entra
  // por variável e nunca por arquivo.
  const environment = {
    CI: "true",
    CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
    HOME: process.env.HOME ?? process.env.USERPROFILE ?? tmpdir(),
    PATH: process.env.PATH,
    WRANGLER_SEND_METRICS: "false",
  };
  // stdio herdado: o wrangler escreve o próprio diagnóstico direto no log
  // do job; este processo nunca captura nem re-registra a saída (que o
  // CodeQL trata como derivada do ambiente, onde vive o token).
  const result = spawnSync(
    process.execPath,
    [
      WRANGLER_ENTRYPOINT,
      "d1",
      "migrations",
      "apply",
      "github-slack-alerts-db",
      "--remote",
      "--config",
      temporaryConfigPath,
    ],
    {
      cwd: REPOSITORY_ROOT,
      env: environment,
      stdio: ["ignore", "inherit", "inherit"],
      timeout: WRANGLER_TIMEOUT_MS,
    },
  );
  invariant(
    result.status === 0,
    `wrangler d1 migrations apply failed with status ${String(result.status)}; the wrangler output above carries the diagnostic.`,
  );
}

export function assertFinalSchema(rows) {
  const observed = rows
    .filter(
      (row) =>
        !String(row.name).startsWith("sqlite_") &&
        !String(row.name).startsWith("_cf"),
    )
    .map((row) => ({ type: row.type, name: row.name }))
    .sort((left, right) =>
      `${left.type}:${left.name}`.localeCompare(`${right.type}:${right.name}`),
    );
  const expected = [...EXPECTED_FINAL_SCHEMA].sort((left, right) =>
    `${left.type}:${left.name}`.localeCompare(`${right.type}:${right.name}`),
  );
  invariant(
    JSON.stringify(observed) === JSON.stringify(expected),
    `The migrated schema is not the exact v2 surface.\nExpected: ${JSON.stringify(expected)}\nObserved: ${JSON.stringify(observed)}`,
  );
}

async function proveAlertDeliveryRoundtrip(configuration, databaseId) {
  const deliveryId = "00000000-0000-4000-8000-00000000d1d1";
  await d1Query(
    configuration,
    databaseId,
    `INSERT INTO alert_delivery (delivery_id, payload_json, state, created_ms, updated_ms)
     VALUES ('${deliveryId}', '{"title":"prova"}', 'pending', 1000, 1000)`,
  );
  const rows = await d1Query(
    configuration,
    databaseId,
    `SELECT delivery_id, state, attempts, next_due_ms FROM alert_delivery WHERE delivery_id = '${deliveryId}'`,
  );
  invariant(
    rows.length === 1 &&
      rows[0].state === "pending" &&
      rows[0].attempts === 0 &&
      rows[0].next_due_ms === 0,
    `alert_delivery roundtrip returned an unexpected row: ${JSON.stringify(rows)}`,
  );
  let rejected = false;
  try {
    await d1Query(
      configuration,
      databaseId,
      `UPDATE alert_delivery SET state = 'parked' WHERE delivery_id = '${deliveryId}'`,
    );
  } catch {
    rejected = true;
  }
  invariant(
    rejected,
    "alert_delivery accepted a state outside the two-state design; the CHECK constraint is missing.",
  );
}

export async function proveRemoteMigration({ environment = process.env } = {}) {
  verifyRemoteProofDeadline(environment);
  const configuration = readConfiguration(environment);
  const nowMs = Date.now();

  await reapStaleDisposables(configuration, nowMs);
  const { databaseId, name } = await createDisposableDatabase(
    configuration,
    nowMs,
  );
  console.log(`Created disposable database ${name}.`);

  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "slack-relay-remote-proof-"),
  );
  try {
    const temporaryConfigPath = join(temporaryDirectory, "wrangler.jsonc");
    const stagedMigrationsDir = join(temporaryDirectory, "migrations");
    await mkdir(stagedMigrationsDir);
    // O id vem da API: o valor gravado no arquivo é a EXTRAÇÃO do casamento
    // com o padrão estrito, nunca a string da rede em si.
    const safeDatabaseId = DATABASE_ID_PATTERN.exec(databaseId)?.[0];
    invariant(
      typeof safeDatabaseId === "string" && safeDatabaseId !== "",
      "Disposable database ID failed strict re-validation before the config write.",
    );
    const configuration_json = {
      name: "github-slack-alerts-remote-proof",
      main: join(RELAY_ROOT, "src", "index.ts"),
      compatibility_date: "2026-08-03",
      d1_databases: [
        {
          binding: "DB",
          database_name: "github-slack-alerts-db",
          database_id: safeDatabaseId,
          migrations_dir: stagedMigrationsDir,
        },
      ],
    };
    await writeFile(
      temporaryConfigPath,
      `${JSON.stringify(configuration_json, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );

    // Estágio 1: só as migrações ANTERIORES ao selo (0001-0005), como a
    // produção viveu antes da ativação.
    const migrationNames = (await readdir(join(RELAY_ROOT, "migrations")))
      .filter((entry) => entry.endsWith(".sql"))
      .sort();
    invariant(
      migrationNames.includes(SEAL_MIGRATION_NAME),
      `The migration chain no longer contains ${SEAL_MIGRATION_NAME}; the staged proof needs updating.`,
    );
    const preSeal = migrationNames.filter((entry) => entry < SEAL_MIGRATION_NAME);
    for (const entry of preSeal) {
      await copyFile(
        join(RELAY_ROOT, "migrations", entry),
        join(stagedMigrationsDir, entry),
      );
    }
    applyMigrationsWithWrangler(temporaryConfigPath);

    // Semeadura da tupla de ativação histórica que a 0006 exige.
    await d1Query(
      configuration,
      databaseId,
      `UPDATE relay_state
          SET slack_delivery_protocol_active = 1,
              slack_delivery_protocol_revision = '${SEALED_PROTOCOL_REVISION}',
              slack_delivery_protocol_activated_at = ${String(SEALED_PROTOCOL_ACTIVATED_AT)},
              slack_delivery_protocol_activation_id = '${SEALED_PROTOCOL_ACTIVATION_ID}',
              slack_delivery_protocol_schema_revision = '0005_reconcile_live_slack_receipts'
        WHERE singleton_id = 1`,
    );

    // Estágio 2: a cadeia completa (o wrangler retoma depois das gravadas)
    // — inclusive a 0011, que dropa o legado e deixa o esquema final v2.
    for (const entry of migrationNames) {
      if (entry < SEAL_MIGRATION_NAME) continue;
      await copyFile(
        join(RELAY_ROOT, "migrations", entry),
        join(stagedMigrationsDir, entry),
      );
    }
    applyMigrationsWithWrangler(temporaryConfigPath);
    const schemaRows = await d1Query(
      configuration,
      databaseId,
      "SELECT type, name FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY type, name",
    );
    assertFinalSchema(schemaRows);
    await proveAlertDeliveryRoundtrip(configuration, databaseId);
  } finally {
    await deleteDatabaseWithConfirmation(configuration, databaseId);
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
  return Object.freeze({ status: "proved", database: name });
}

export async function reapStaleDisposablesOnly({
  environment = process.env,
} = {}) {
  // Modo do slack-d1-disposable-reaper.yml: só a colheita de descartáveis
  // obsoletos, sem prazo de prova (o workflow não define
  // REMOTE_PROOF_DEADLINE_MS) e sem criar banco nenhum.
  const configuration = readConfiguration(environment);
  await reapStaleDisposables(configuration, Date.now());
  return Object.freeze({ status: "reaped" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const entry = process.argv.includes("--reap-stale")
    ? reapStaleDisposablesOnly().then(() => {
        console.log("Stale disposable reap completed.");
      })
    : proveRemoteMigration().then(({ database }) => {
        console.log(`Remote v2 migration proof passed on ${database}.`);
      });
  entry.catch((error) => {
    console.error(
      `Remote D1 maintenance failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
