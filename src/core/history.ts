/**
 * Run history. Schema is SQLite.
 * Driver order: node:sqlite (Node 22+) → JSON file with the same INSERT/SELECT API.
 * rusqlite is used from the Tauri crate on Mac.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import type { Owner } from "./types.ts";

export interface RunRow {
  id: string;
  ts: number;
  owner: Owner;
  promptPreview: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  blocked: number;
  cacheHit: number;
  degraded: number;
}

export interface HistoryStore {
  record(row: Omit<RunRow, "ts"> & { ts?: number }): void;
  list(limit?: number): RunRow[];
  close(): void;
  readonly driver: string;
}

type Prepared = {
  run: (...args: unknown[]) => void;
  all: (...args: unknown[]) => RunRow[];
};

type DbLike = {
  exec(sql: string): void;
  prepare(sql: string): Prepared;
  close?: () => void;
};

const SCHEMA = `CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  owner TEXT NOT NULL,
  promptPreview TEXT NOT NULL,
  tokensIn INTEGER NOT NULL,
  tokensOut INTEGER NOT NULL,
  costUsd REAL NOT NULL,
  blocked INTEGER NOT NULL,
  cacheHit INTEGER NOT NULL,
  degraded INTEGER NOT NULL
);`;

function tryNodeSqlite(file: string): DbLike | null {
  try {
    const require = createRequire(import.meta.url);
    const mod = require("node:sqlite") as {
      DatabaseSync: new (path: string) => DbLike & { close(): void };
    };
    if (!mod?.DatabaseSync) return null;
    mkdirSync(dirname(file), { recursive: true });
    return new mod.DatabaseSync(file);
  } catch {
    return null;
  }
}

class FileSql implements DbLike {
  private rows: RunRow[] = [];
  constructor(private file: string) {
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) {
      try {
        this.rows = JSON.parse(readFileSync(file, "utf8")) as RunRow[];
      } catch {
        this.rows = [];
      }
    }
  }
  exec(_sql: string): void {}
  prepare(sql: string): Prepared {
    const self = this;
    return {
      run(...args: unknown[]) {
        if (/insert/i.test(sql)) {
          const [id, ts, owner, promptPreview, tokensIn, tokensOut, costUsd, blocked, cacheHit, degraded] = args;
          self.rows.unshift({
            id: String(id),
            ts: Number(ts),
            owner: owner as Owner,
            promptPreview: String(promptPreview),
            tokensIn: Number(tokensIn),
            tokensOut: Number(tokensOut),
            costUsd: Number(costUsd),
            blocked: Number(blocked),
            cacheHit: Number(cacheHit),
            degraded: Number(degraded),
          });
          writeFileSync(self.file, JSON.stringify(self.rows));
        }
      },
      all(): RunRow[] {
        return [...self.rows];
      },
    };
  }
  close(): void {
    writeFileSync(this.file, JSON.stringify(this.rows));
  }
}

export class SqliteHistory implements HistoryStore {
  readonly driver: string;
  private db: DbLike;

  constructor(file: string) {
    const target = file === ":memory:"
      ? join("/tmp", `steward-hist-${process.pid}-${Date.now()}.json`)
      : file;
    const sqliteFile = target.endsWith(".json") ? target.replace(/\.json$/, ".sqlite") : target;
    const opened = file === ":memory:" ? null : tryNodeSqlite(sqliteFile);
    if (opened) {
      this.db = opened;
      this.driver = "node:sqlite";
    } else {
      const jsonFile = sqliteFile.endsWith(".sqlite")
        ? sqliteFile.replace(/\.sqlite$/, ".json")
        : `${sqliteFile}.json`;
      this.db = new FileSql(jsonFile);
      this.driver = "file-sql";
    }
    this.db.exec(SCHEMA);
  }

  record(row: Omit<RunRow, "ts"> & { ts?: number }): void {
    const ts = row.ts ?? Date.now();
    const stmt = this.db.prepare(
      `INSERT INTO runs (id, ts, owner, promptPreview, tokensIn, tokensOut, costUsd, blocked, cacheHit, degraded)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    stmt.run(
      row.id, ts, row.owner, row.promptPreview.slice(0, 180),
      row.tokensIn, row.tokensOut, row.costUsd,
      row.blocked ? 1 : 0, row.cacheHit ? 1 : 0, row.degraded ? 1 : 0,
    );
  }

  list(limit = 50): RunRow[] {
    const stmt = this.db.prepare(`SELECT * FROM runs ORDER BY ts DESC LIMIT ?`);
    return stmt.all(limit).slice(0, limit);
  }

  close(): void {
    this.db.close?.();
  }
}

export function openHistory(file: string): HistoryStore {
  return new SqliteHistory(file);
}
