-- Generated from SCHEMA_STATEMENTS in src/db.js; keep in sync.

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

CREATE TABLE IF NOT EXISTS drafts (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    agent            TEXT NOT NULL,
    vertical         TEXT NOT NULL,
    platform         TEXT NOT NULL,
    content          TEXT NOT NULL,
    rationale        TEXT,
    status           TEXT NOT NULL DEFAULT 'drafting',
    critique_verdict TEXT,
    critique_notes   TEXT,
    quality_flag     INTEGER NOT NULL DEFAULT 0,
    rejection_reason TEXT,
    media_file_id    TEXT,
    scheduled_for    TEXT,
    published_at     TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );

CREATE TABLE IF NOT EXISTS outreach (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    target         TEXT NOT NULL,
    brief          TEXT,
    pitch          TEXT,
    status         TEXT NOT NULL DEFAULT 'researched',
    last_action_at TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

CREATE TABLE IF NOT EXISTS metrics_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    vertical    TEXT NOT NULL,
    metric      TEXT NOT NULL,
    value       TEXT NOT NULL,
    note        TEXT,
    recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

CREATE TABLE IF NOT EXISTS kdp_entries (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    raw_text   TEXT NOT NULL,
    week_of    TEXT NOT NULL DEFAULT (date('now', 'weekday 1', '-7 days')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

CREATE TABLE IF NOT EXISTS media (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    postiz_id        TEXT NOT NULL,
    path             TEXT NOT NULL,
    kind             TEXT NOT NULL,
    label            TEXT,
    telegram_file_id TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );

CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT NOT NULL,
    payload    TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

CREATE TABLE IF NOT EXISTS jobs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT NOT NULL,
    payload    TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    error      TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

CREATE TABLE IF NOT EXISTS updates_seen (
    update_id INTEGER PRIMARY KEY,
    seen_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
