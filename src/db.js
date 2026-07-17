import { config } from "./config.js";

/**
 * Data layer over Cloudflare D1 (async, positional params). The binding is
 * injected at runtime: worker.js passes env.DB per invocation; the Node entry
 * (index.js) passes a D1-compatible shim over better-sqlite3 so local dev and
 * the VPS fallback keep working from the same code.
 */

let d1 = null;

export function initDb(binding) {
  d1 = binding;
}

function need() {
  if (!d1) throw new Error("Database not initialized (initDb was not called).");
  return d1;
}

async function get(sql, ...params) {
  return (await need().prepare(sql).bind(...params).first()) ?? null;
}
async function all(sql, ...params) {
  return (await need().prepare(sql).bind(...params).all()).results;
}
async function run(sql, ...params) {
  return (await need().prepare(sql).bind(...params).run()).meta;
}

// Exposed for the few call sites that build bespoke queries (bot.js /status).
export const sql = { get, all, run };

// --- Schema -------------------------------------------------------------------
// One statement per entry: D1 migrations and the local shim both consume this.
// Keep migrations/0001_init.sql in sync when changing anything here.

export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  // Drafts moving through the approval pipeline.
  // status: drafting -> cos_review -> critique -> queued -> approved | rejected -> published
  `CREATE TABLE IF NOT EXISTS drafts (
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
  )`,
  // Podcast / partnership outreach pipeline.
  `CREATE TABLE IF NOT EXISTS outreach (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    target         TEXT NOT NULL,
    brief          TEXT,
    pitch          TEXT,
    status         TEXT NOT NULL DEFAULT 'researched',
    last_action_at TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS metrics_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    vertical    TEXT NOT NULL,
    metric      TEXT NOT NULL,
    value       TEXT NOT NULL,
    note        TEXT,
    recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS kdp_entries (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    raw_text   TEXT NOT NULL,
    week_of    TEXT NOT NULL DEFAULT (date('now', 'weekday 1', '-7 days')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  // Media library: files sent to the Telegram bot and mirrored into Postiz.
  `CREATE TABLE IF NOT EXISTS media (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    postiz_id        TEXT NOT NULL,
    path             TEXT NOT NULL,
    kind             TEXT NOT NULL,
    label            TEXT,
    telegram_file_id TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  // Audit trail of everything the system does.
  `CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT NOT NULL,
    payload    TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  // Background jobs: agent pipelines are too long for a webhook request on
  // Workers, so commands enqueue here and the cron tick drains the queue.
  // status: pending -> running -> done | error
  `CREATE TABLE IF NOT EXISTS jobs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT NOT NULL,
    payload    TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    error      TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  // Telegram retries webhook deliveries; processed update ids make that safe.
  `CREATE TABLE IF NOT EXISTS updates_seen (
    update_id INTEGER PRIMARY KEY,
    seen_at   TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
];

// Keyed by binding, not module state: a rebound database (fresh isolate,
// tests, multiple environments) must get its own schema pass.
const schemaReady = new WeakSet();

export async function ensureSchema() {
  const db = need();
  if (schemaReady.has(db)) return;
  await db.batch(SCHEMA_STATEMENTS.map((s) => db.prepare(s)));
  schemaReady.add(db);
}

// --- Settings -------------------------------------------------------------------

export const settings = {
  async get(key, fallback = null) {
    const row = await get("SELECT value FROM settings WHERE key = ?", key);
    return row ? row.value : fallback;
  },
  async set(key, value) {
    await run(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      String(value),
    );
  },
};

/**
 * Approved links and assets (Amazon URL, tracked short links, email list).
 * Agents may only use URLs from here; /links manages it from Telegram.
 */
export const links = {
  async all() {
    return JSON.parse(await settings.get("links", "{}"));
  },
  async set(name, url) {
    const a = await this.all();
    a[name] = url;
    await settings.set("links", JSON.stringify(a));
  },
  async remove(name) {
    const a = await this.all();
    delete a[name];
    await settings.set("links", JSON.stringify(a));
  },
};

/** The owner's Telegram user id (== private chat id): env pin or claimed via /start. */
export async function getOwnerId() {
  if (config.ownerId) return config.ownerId;
  const stored = await settings.get("owner_id");
  return stored ? Number(stored) : null;
}

export async function isPaused() {
  return (await settings.get("paused", "0")) === "1";
}

export async function setPaused(paused) {
  await settings.set("paused", paused ? "1" : "0");
}

// --- Drafts ---------------------------------------------------------------------

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
  async insert({ agent, vertical, platform, content, status = "drafting" }) {
    const meta = await run(
      "INSERT INTO drafts (agent, vertical, platform, content, status) VALUES (?, ?, ?, ?, ?)",
      agent,
      vertical,
      platform,
      content,
      status,
    );
    return Number(meta.last_row_id);
  },
  async get(id) {
    return get("SELECT * FROM drafts WHERE id = ?", id);
  },
  async listByStatus(status) {
    return all("SELECT * FROM drafts WHERE status = ? ORDER BY created_at", status);
  },
  async update(id, fields) {
    const keys = Object.keys(fields).filter((k) => DRAFT_COLUMNS.has(k));
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = ?`).join(", ");
    await run(
      `UPDATE drafts SET ${sets}, updated_at = datetime('now') WHERE id = ?`,
      ...keys.map((k) => fields[k]),
      id,
    );
  },
};

// --- Outreach ---------------------------------------------------------------------

const OUTREACH_COLUMNS = new Set(["target", "brief", "pitch", "status", "last_action_at"]);

export const outreach = {
  async insert({ target, brief = null, pitch = null, status = "researched" }) {
    const meta = await run(
      "INSERT INTO outreach (target, brief, pitch, status, last_action_at) VALUES (?, ?, ?, ?, datetime('now'))",
      target,
      brief,
      pitch,
      status,
    );
    return Number(meta.last_row_id);
  },
  async get(id) {
    return get("SELECT * FROM outreach WHERE id = ?", id);
  },
  async listByStatus(status) {
    return all("SELECT * FROM outreach WHERE status = ? ORDER BY created_at", status);
  },
  async counts() {
    return all("SELECT status, COUNT(*) AS n FROM outreach GROUP BY status");
  },
  async update(id, fields) {
    const keys = Object.keys(fields).filter((k) => OUTREACH_COLUMNS.has(k));
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = ?`).join(", ");
    await run(
      `UPDATE outreach SET ${sets}, last_action_at = datetime('now') WHERE id = ?`,
      ...keys.map((k) => fields[k]),
      id,
    );
  },
};

// --- Metrics / KDP -------------------------------------------------------------------

export const metrics = {
  async insert({ vertical, metric, value, note = null }) {
    await run(
      "INSERT INTO metrics_log (vertical, metric, value, note) VALUES (?, ?, ?, ?)",
      vertical,
      metric,
      String(value),
      note,
    );
  },
  async recent(vertical, limit = 10) {
    return all(
      "SELECT * FROM metrics_log WHERE vertical = ? ORDER BY recorded_at DESC LIMIT ?",
      vertical,
      limit,
    );
  },
};

export const kdp = {
  async insert(rawText) {
    const meta = await run("INSERT INTO kdp_entries (raw_text) VALUES (?)", rawText);
    return Number(meta.last_row_id);
  },
  async latest() {
    return get("SELECT * FROM kdp_entries ORDER BY created_at DESC, id DESC LIMIT 1");
  },
};

// --- Media library ---------------------------------------------------------------------

export const mediaLibrary = {
  async save({ postizId, path, kind, label = null, telegramFileId = null }) {
    const meta = await run(
      "INSERT INTO media (postiz_id, path, kind, label, telegram_file_id) VALUES (?, ?, ?, ?, ?)",
      postizId,
      path,
      kind,
      label,
      telegramFileId,
    );
    return Number(meta.last_row_id);
  },
  async list(limit = 20) {
    return all("SELECT * FROM media ORDER BY created_at DESC, id DESC LIMIT ?", limit);
  },
  async get(id) {
    return get("SELECT * FROM media WHERE id = ?", id);
  },
};

// --- Jobs (background work drained by the cron tick) ------------------------------------

export const jobs = {
  async enqueue(type, payload) {
    const meta = await run(
      "INSERT INTO jobs (type, payload) VALUES (?, ?)",
      type,
      JSON.stringify(payload),
    );
    return Number(meta.last_row_id);
  },
  /** Atomically claim one pending job; null when the queue is empty. */
  async claim() {
    const row = await get(
      "SELECT * FROM jobs WHERE status = 'pending' ORDER BY id LIMIT 1",
    );
    if (!row) return null;
    const meta = await run(
      "UPDATE jobs SET status = 'running', updated_at = datetime('now') WHERE id = ? AND status = 'pending'",
      row.id,
    );
    // Another tick raced us to it; let the caller try again.
    if (meta.changes === 0) return this.claim();
    return { ...row, payload: JSON.parse(row.payload) };
  },
  async finish(id, error = null) {
    await run(
      "UPDATE jobs SET status = ?, error = ?, updated_at = datetime('now') WHERE id = ?",
      error ? "error" : "done",
      error,
      id,
    );
  },
  /** Jobs stuck 'running' past the cron budget get failed so they surface. */
  async failStale(minutes = 20) {
    const stale = await all(
      `SELECT id FROM jobs WHERE status = 'running' AND updated_at <= datetime('now', ?)`,
      `-${minutes} minutes`,
    );
    for (const { id } of stale) await this.finish(id, "timed out");
    return stale.length;
  },
};

/** True the first time an update id is seen; false on Telegram redelivery. */
export async function markUpdateSeen(updateId) {
  const meta = await run(
    "INSERT OR IGNORE INTO updates_seen (update_id) VALUES (?)",
    updateId,
  );
  return meta.changes > 0;
}

// --- Events / secrets ---------------------------------------------------------------------

export async function logEvent(type, payload = {}) {
  // Defense in depth: nothing that lands in the audit trail may carry a secret
  // (e.g. an error quoting the Telegram file URL, which embeds the bot token).
  try {
    await run(
      "INSERT INTO events (type, payload) VALUES (?, ?)",
      type,
      scrubSecrets(JSON.stringify(payload)),
    );
  } catch (err) {
    // The audit trail must never take the feature down with it.
    console.error("logEvent failed:", err);
  }
}

/**
 * Strips secrets out of text that gets replied to chat or persisted in the
 * events table (e.g. errors quoting a URL that embeds the bot token).
 */
export function scrubSecrets(text) {
  let out = String(text);
  for (const secret of [config.telegramToken, config.postizKey, config.anthropicApiKey]) {
    // Length guard: a degenerate short value must not shred unrelated text.
    if (secret && secret.length >= 8) out = out.split(secret).join("[redacted]");
  }
  return out;
}
