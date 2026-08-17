import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { URL as NodeUrl } from "node:url";
import { readFileSync } from "node:fs";

// Adaptador SQLite -> D1 para os testes de alertas.
//
// Existe um adaptador mais completo, local a test/store-sqlite.test.ts, com
// suporte a batch() e contadores de fronteira. Este é deliberadamente menor:
// o store de alertas emite UMA instrução por mutação e nunca chama batch(),
// porque o desenho do ADR-002 não tem transição que precise de atomicidade
// entre duas escritas — foi justamente essa necessidade que o sistema
// anterior tinha e que a remoção do reparo de duplicata eliminou.
//
// Duplicar o adaptador maior custaria manter batch() e contadores que
// nenhum teste daqui exerce; extrair o dele exigiria mexer num teste legado
// grande, fora do escopo desta mudança.

const openDatabases: DatabaseSync[] = [];

export function closeAlertDatabases(): void {
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close();
  }
}

export function migrationSource(name: string): string {
  return readFileSync(
    new NodeUrl(`../../migrations/${name}`, import.meta.url),
    "utf8",
  );
}

function d1Result(changes: number, results: unknown[] = []): D1Result<unknown> {
  return {
    success: true,
    results,
    meta: { changes },
  } as unknown as D1Result<unknown>;
}

function sqliteD1(database: DatabaseSync): D1Database {
  return {
    prepare(query: string): D1PreparedStatement {
      const statement = database.prepare(query);
      let values: SQLInputValue[] = [];
      const prepared = {
        bind(...bindings: unknown[]): D1PreparedStatement {
          values = bindings as SQLInputValue[];
          return prepared as unknown as D1PreparedStatement;
        },
        async run(): Promise<D1Result<unknown>> {
          const result = statement.run(...values);
          return d1Result(Number(result.changes));
        },
        async first<T>(columnName?: string): Promise<T | null> {
          const row = statement.get(...values) as
            | Record<string, unknown>
            | undefined;
          if (row === undefined) return null;
          return (columnName === undefined ? row : row[columnName]) as T;
        },
        async all<T>(): Promise<D1Result<T>> {
          const rows = statement.all(...values) as T[];
          return d1Result(0, rows) as D1Result<T>;
        },
      };
      return prepared as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
}

export function makeAlertDb(
  opcoes: { aplicarMigracao?: boolean } = {},
): { database: DatabaseSync; d1: D1Database } {
  const database = new DatabaseSync(":memory:");
  openDatabases.push(database);
  if (opcoes.aplicarMigracao !== false) {
    database.exec(migrationSource("0010_alert_delivery.sql"));
  }
  return { database, d1: sqliteD1(database) };
}
