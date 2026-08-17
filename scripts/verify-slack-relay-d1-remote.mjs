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

// Reconstrução por alfabeto CONSTANTE: todo identificador vindo da rede que
// precise aparecer num log, numa mensagem de erro ou num arquivo é
// reconstruído caractere a caractere a partir deste alfabeto local — o
// valor emitido nunca é a string remota em si (a classe inteira dos
// findings de taint morre aqui, sem adjudicação humana).
const SAFE_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";

function reconstructSafe(value, pattern, label) {
  invariant(
    typeof value === "string" && pattern.test(value),
    `${label} failed strict validation before reconstruction.`,
  );
  let reconstructed = "";
  for (const character of value) {
    const index = SAFE_ALPHABET.indexOf(character);
    invariant(index !== -1, `${label} contains an unexpected character.`);
    reconstructed += SAFE_ALPHABET[index];
  }
  return reconstructed;
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
  // Diagnóstico sem conteúdo remoto: só o caminho local, o status HTTP e os
  // CÓDIGOS numéricos de erro (Number() não carrega taint de string).
  const numericErrorCodes = Array.isArray(payload?.errors)
    ? payload.errors
        .map((entry) => Number(entry?.code))
        .filter((code) => Number.isFinite(code))
        .join(",")
    : "";
  // A mensagem nunca inclui o caminho: ele embute o account id vindo do
  // ambiente, e nada derivado do ambiente pode alcançar um log.
  invariant(
    payload?.success === true,
    `A Cloudflare API request failed (HTTP ${response.status}; error codes: ${numericErrorCodes || "none"}); the failing step names the operation.`,
  );
  return payload;
}

export const INVENTORY_PAGE_SIZE = 1000;
const MAX_INVENTORY_PAGES = 100;

export function inventoryPageIsLast(resultInfo, pageLength, collectedCount) {
  if (pageLength < INVENTORY_PAGE_SIZE) return true;
  const totalCount = Number(resultInfo?.total_count);
  return Number.isFinite(totalCount) && collectedCount >= totalCount;
}

// O inventário percorre TODAS as páginas: uma leitura parcial faria o
// reaper ignorar descartáveis além da primeira página e faria a
// confirmação de DELETE reportar ausência de um banco que só não coube
// na página lida.
export async function listDatabases(configuration, requestFn = cloudflareRequest) {
  const collected = [];
  for (let page = 1; page <= MAX_INVENTORY_PAGES; page += 1) {
    const payload = await requestFn(
      configuration,
      `/accounts/${configuration.accountId}/d1/database?per_page=${String(INVENTORY_PAGE_SIZE)}&page=${String(page)}`,
    );
    invariant(Array.isArray(payload.result), "D1 database list is not an array.");
    collected.push(...payload.result);
    if (
      inventoryPageIsLast(payload.result_info, payload.result.length, collected.length)
    ) {
      return collected;
    }
  }
  throw new Error(
    `The D1 inventory exceeded ${MAX_INVENTORY_PAGES} pages; refusing to treat a partial read as the full inventory.`,
  );
}

export function parseDisposableTimestamp(name) {
  const match = /^tmp-slack-relay-171-([0-9]{13})-[0-9a-f]{8}$/u.exec(name);
  return match === null ? null : Number.parseInt(match[1], 10);
}

// Teto de trabalho por execução: cada colheita custa até 4 DELETEs + 4
// leituras do inventário, e tanto o reaper agendado (timeout de 10 min)
// quanto a prova (prazo fail-closed) não podem gastar a janela inteira
// num backlog degradado. O excedente fica DECLARADO no log e sai nas
// execuções seguintes — o cron do reaper é o backstop.
export const MAX_REAP_PER_RUN = 5;

export function selectStaleDisposables(databases, nowMs, limit = MAX_REAP_PER_RUN) {
  const stale = databases
    .map((database) => ({
      database,
      createdMs: parseDisposableTimestamp(database.name ?? ""),
    }))
    .filter(
      (entry) =>
        entry.createdMs !== null && nowMs - entry.createdMs >= STALE_DATABASE_AGE_MS,
    )
    .sort((left, right) => left.createdMs - right.createdMs)
    .map((entry) => entry.database);
  return Object.freeze({
    stale: Object.freeze(stale.slice(0, limit)),
    deferredCount: Math.max(0, stale.length - limit),
  });
}

async function reapStaleDisposables(configuration, nowMs) {
  const databases = await listDatabases(configuration);
  const { stale, deferredCount } = selectStaleDisposables(databases, nowMs);
  for (const database of stale) {
    invariant(
      database.uuid !== PRODUCTION_DATABASE_ID,
      "Refusing to reap: a disposable-named database carries the production ID.",
    );
    console.log(
      `Reaping stale disposable database ${reconstructSafe(database.name, DISPOSABLE_DATABASE_NAME_PATTERN, "Disposable database name")}.`,
    );
    await deleteDatabaseWithConfirmation(configuration, database.uuid);
  }
  if (deferredCount > 0) {
    console.log(
      `Deferring ${String(deferredCount)} stale disposable database(s) to the next run (per-run cap ${String(MAX_REAP_PER_RUN)}).`,
    );
  }
}

// Uma resposta perdida, expirada ou ilegível pode ter criado o banco
// mesmo assim — e a limpeza do proveRemoteMigration só se instala DEPOIS
// do retorno daqui. O nome é conhecido ANTES do POST, então a
// reconciliação procura o órfão pelo nome exato e o apaga antes de
// propagar a falha original; se a própria reconciliação falhar, o reaper
// de obsoletos continua sendo o backstop declarado.
async function reconcileAmbiguousCreation(configuration, name, requestFn) {
  try {
    const databases = await listDatabases(configuration, requestFn);
    const orphan = databases.find((database) => database.name === name);
    if (orphan === undefined) {
      console.log("Ambiguous disposable creation left no orphan behind.");
      return;
    }
    invariant(
      orphan.uuid !== PRODUCTION_DATABASE_ID,
      "Refusing to reconcile: the orphan carries the production ID.",
    );
    await deleteDatabaseWithConfirmation(configuration, orphan.uuid, requestFn);
    // O nome é construído localmente (prefixo + relógio + sufixo local);
    // nada dele veio da rede.
    console.log(`Deleted the orphaned disposable database ${name}.`);
  } catch {
    console.log(
      "Ambiguous disposable creation could not be reconciled; the stale reaper remains the backstop.",
    );
  }
}

export async function createDisposableDatabase(
  configuration,
  nowMs,
  requestFn = cloudflareRequest,
) {
  const suffix = [...crypto.getRandomValues(new Uint8Array(4))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const name = `${DATABASE_NAME_PREFIX}${String(nowMs)}-${suffix}`;
  invariant(
    DISPOSABLE_DATABASE_NAME_PATTERN.test(name),
    `Generated disposable name does not match its own pattern: ${name}`,
  );
  try {
    const payload = await requestFn(
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
  } catch (error) {
    await reconcileAmbiguousCreation(configuration, name, requestFn);
    throw error;
  }
}

export async function deleteDatabaseWithConfirmation(
  configuration,
  databaseId,
  requestFn = cloudflareRequest,
) {
  invariant(
    databaseId !== PRODUCTION_DATABASE_ID,
    "Refusing to delete the production database.",
  );
  for (let attempt = 0; attempt < DELETE_CONFIRMATION_ATTEMPTS; attempt += 1) {
    try {
      await requestFn(
        configuration,
        `/accounts/${configuration.accountId}/d1/database/${databaseId}`,
        { method: "DELETE" },
      );
    } catch (error) {
      if (attempt + 1 === DELETE_CONFIRMATION_ATTEMPTS) {
        // Um DELETE anterior pode ter vencido com o inventário atrasado:
        // o erro do último DELETE (um 404, por exemplo) só é veredito se
        // o banco AINDA estiver listado. Se o inventário estiver
        // indisponível, a causa raiz continua sendo o erro original.
        let stillListed = true;
        try {
          const databases = await listDatabases(configuration, requestFn);
          stillListed = databases.some(
            (database) => database.uuid === databaseId,
          );
        } catch {
          // inventário indisponível: propaga o erro original do DELETE
        }
        if (!stillListed) return;
        throw error;
      }
    }
    const databases = await listDatabases(configuration, requestFn);
    if (!databases.some((database) => database.uuid === databaseId)) {
      return;
    }
    await delay(250 * 2 ** attempt);
  }
  throw new Error(
    `A disposable database is still listed after ${DELETE_CONFIRMATION_ATTEMPTS} delete attempts (ID withheld from the log; see the Cloudflare dashboard).`,
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
  // O diagnóstico nunca carrega as strings remotas: o esperado é constante
  // local, e o observado entra reconstruído do alfabeto (ou marcado como
  // fora-do-alfabeto), preservando a exatidão da comparação.
  const describeObserved = observed
    .map((entry) => {
      try {
        return `${String(entry.type) === "table" ? "table" : "index"}:${reconstructSafe(String(entry.name), /^[A-Za-z0-9_-]{1,128}$/u, "Schema object name")}`;
      } catch {
        return "objeto-fora-do-alfabeto";
      }
    })
    .join(", ");
  invariant(
    JSON.stringify(observed) === JSON.stringify(expected),
    `The migrated schema is not the exact v2 surface. Expected: ${JSON.stringify(expected)}. Observed (reconstructed): ${describeObserved}.`,
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
  // Diagnóstico sem conteúdo remoto: só contagens e booleanos locais.
  invariant(
    rows.length === 1 &&
      rows[0].state === "pending" &&
      rows[0].attempts === 0 &&
      rows[0].next_due_ms === 0,
    `alert_delivery roundtrip mismatch: rows=${String(rows.length)} pending=${String(rows[0]?.state === "pending")} attempts0=${String(rows[0]?.attempts === 0)} due0=${String(rows[0]?.next_due_ms === 0)}.`,
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
    // O id vem da API: o valor gravado no arquivo é RECONSTRUÍDO do
    // alfabeto constante após a validação estrita, nunca a string da rede.
    const safeDatabaseId = reconstructSafe(
      databaseId,
      DATABASE_ID_PATTERN,
      "Disposable database ID",
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
