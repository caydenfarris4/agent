import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/**
 * D1-compatible facade over better-sqlite3 for the Node entry point (local
 * dev, tests, and the VPS fallback). Implements exactly the slice of the D1
 * API that db.js uses: prepare().bind().first()/all()/run() and batch().
 */

class Statement {
  constructor(sqlite, sqlText, params = []) {
    this.sqlite = sqlite;
    this.sqlText = sqlText;
    this.params = params;
  }
  bind(...params) {
    return new Statement(this.sqlite, this.sqlText, params);
  }
  async first() {
    return this.sqlite.prepare(this.sqlText).get(...this.params) ?? null;
  }
  async all() {
    return { results: this.sqlite.prepare(this.sqlText).all(...this.params), success: true };
  }
  async run() {
    const stmt = this.sqlite.prepare(this.sqlText);
    if (stmt.reader) {
      // D1 run() tolerates row-returning statements; better-sqlite3 does not.
      const rows = stmt.all(...this.params);
      return { success: true, meta: { changes: rows.length, last_row_id: 0 } };
    }
    const info = stmt.run(...this.params);
    return {
      success: true,
      meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) },
    };
  }
}

export function openLocalDb(dbPath = config.dbPath) {
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  return {
    prepare(sqlText) {
      return new Statement(sqlite, sqlText);
    },
    async batch(statements) {
      return statements.map((s) => {
        const stmt = sqlite.prepare(s.sqlText);
        return stmt.reader ? stmt.all(...s.params) : stmt.run(...s.params);
      });
    },
    close() {
      sqlite.close();
    },
  };
}
