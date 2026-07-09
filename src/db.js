import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

fs.mkdirSync(path.dirname(path.resolve(config.dbPath)), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Drafts moving through the approval pipeline.
-- status: drafting -> cos_review -> critique -> queued -> approved | rejected -> published
CREATE TABLE IF NOT EXISTS drafts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  agent            TEXT NOT NULL,             -- originating specialist
  vertical         TEXT NOT NULL,             -- book | app
  platform         TEXT NOT NULL,             -- linkedin | instagram | x | email | reply
  content          TEXT NOT NULL,
  rationale        TEXT,                      -- Chief of Staff one-line rationale
  status           TEXT NOT NULL DEFAULT 'drafting',
  critique_verdict TEXT,                      -- PASS | FIX | ESCALATE
  critique_notes   TEXT,
  quality_flag     INTEGER NOT NULL DEFAULT 0, -- "compliant, flagged for quality"
  rejection_reason TEXT,
  media_file_id    TEXT,                      -- Telegram file id for asset drops
  scheduled_for    TEXT,                      -- ISO datetime for publishing
  published_at     TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Podcast / partnership outreach pipeline.
-- status: researched -> awaiting_approval -> approved -> pitched -> replied -> scheduled -> aired | declined
CREATE TABLE IF NOT EXISTS outreach (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  target         TEXT NOT NULL,
  brief          TEXT,
  pitch          TEXT,
  status         TEXT NOT NULL DEFAULT 'researched',
  last_action_at TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Weekly / ad-hoc metrics for both verticals.
CREATE TABLE IF NOT EXISTS metrics_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  vertical    TEXT NOT NULL,                  -- book | app
  metric      TEXT NOT NULL,
  value       TEXT NOT NULL,
  note        TEXT,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Weekly KDP figures Cayden reports via /kdp.
CREATE TABLE IF NOT EXISTS kdp_entries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_text   TEXT NOT NULL,
  week_of    TEXT NOT NULL DEFAULT (date('now', 'weekday 1', '-7 days')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Audit trail of everything the system does.
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL,
  payload    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

const getSetting = db.prepare("SELECT value FROM settings WHERE key = ?");
const putSetting = db.prepare(
  "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
);

export const settings = {
  get(key, fallback = null) {
    const row = getSetting.get(key);
    return row ? row.value : fallback;
  },
  set(key, value) {
    putSetting.run(key, String(value));
  },
};

/** The owner's Telegram user id (== private chat id): env pin or claimed via /start. */
export function getOwnerId() {
  if (config.ownerId) return config.ownerId;
  const stored = settings.get("owner_id");
  return stored ? Number(stored) : null;
}

export function isPaused() {
  return settings.get("paused", "0") === "1";
}

export function setPaused(paused) {
  settings.set("paused", paused ? "1" : "0");
}

const insertDraft = db.prepare(`
  INSERT INTO drafts (agent, vertical, platform, content, status)
  VALUES (@agent, @vertical, @platform, @content, @status)
`);
const getDraft = db.prepare("SELECT * FROM drafts WHERE id = ?");
const listDraftsByStatus = db.prepare(
  "SELECT * FROM drafts WHERE status = ? ORDER BY created_at",
);

const DRAFT_COLUMNS = new Set([
  "content",
  "rationale",
  "status",
  "critique_verdict",
  "critique_notes",
  "quality_flag",
  "rejection_reason",
  "media_file_id",
  "scheduled_for",
  "published_at",
]);

export const drafts = {
  insert({ agent, vertical, platform, content, status = "drafting" }) {
    const info = insertDraft.run({ agent, vertical, platform, content, status });
    return Number(info.lastInsertRowid);
  },
  get(id) {
    return getDraft.get(id);
  },
  listByStatus(status) {
    return listDraftsByStatus.all(status);
  },
  update(id, fields) {
    const keys = Object.keys(fields).filter((k) => DRAFT_COLUMNS.has(k));
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = @${k}`).join(", ");
    db.prepare(
      `UPDATE drafts SET ${sets}, updated_at = datetime('now') WHERE id = @id`,
    ).run({ ...fields, id });
  },
};

const insertOutreach = db.prepare(`
  INSERT INTO outreach (target, brief, pitch, status, last_action_at)
  VALUES (@target, @brief, @pitch, @status, datetime('now'))
`);
const OUTREACH_COLUMNS = new Set(["target", "brief", "pitch", "status", "last_action_at"]);

export const outreach = {
  insert({ target, brief = null, pitch = null, status = "researched" }) {
    const info = insertOutreach.run({ target, brief, pitch, status });
    return Number(info.lastInsertRowid);
  },
  get(id) {
    return db.prepare("SELECT * FROM outreach WHERE id = ?").get(id);
  },
  listByStatus(status) {
    return db
      .prepare("SELECT * FROM outreach WHERE status = ? ORDER BY created_at")
      .all(status);
  },
  counts() {
    return db
      .prepare("SELECT status, COUNT(*) AS n FROM outreach GROUP BY status")
      .all();
  },
  update(id, fields) {
    const keys = Object.keys(fields).filter((k) => OUTREACH_COLUMNS.has(k));
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = @${k}`).join(", ");
    db.prepare(
      `UPDATE outreach SET ${sets}, last_action_at = datetime('now') WHERE id = @id`,
    ).run({ ...fields, id });
  },
};

const insertMetric = db.prepare(
  "INSERT INTO metrics_log (vertical, metric, value, note) VALUES (?, ?, ?, ?)",
);

export const metrics = {
  insert({ vertical, metric, value, note = null }) {
    insertMetric.run(vertical, metric, String(value), note);
  },
  recent(vertical, limit = 10) {
    return db
      .prepare(
        "SELECT * FROM metrics_log WHERE vertical = ? ORDER BY recorded_at DESC LIMIT ?",
      )
      .all(vertical, limit);
  },
};

export const kdp = {
  insert(rawText) {
    const info = db
      .prepare("INSERT INTO kdp_entries (raw_text) VALUES (?)")
      .run(rawText);
    return Number(info.lastInsertRowid);
  },
  latest() {
    return db
      .prepare("SELECT * FROM kdp_entries ORDER BY created_at DESC, id DESC LIMIT 1")
      .get();
  },
};

const insertEvent = db.prepare(
  "INSERT INTO events (type, payload) VALUES (?, ?)",
);

export function logEvent(type, payload = {}) {
  insertEvent.run(type, JSON.stringify(payload));
}
