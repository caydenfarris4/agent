/**
 * End-to-end harness: runs the whole system in Node against the D1-shaped
 * shim with a stubbed Telegram API and a fake agent. Postiz calls are LIVE
 * (uses POSTIZ_API_KEY from the environment when present).
 *
 * Run: node --import ./test/register-md.mjs test/harness.mjs
 */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const scratch = process.env.HARNESS_DIR || here;

// --- Environment (before any src import reads config) -------------------------
process.env.DB_PATH = path.join(scratch, "harness.db");
process.env.ANTHROPIC_API_KEY = "test-key-not-used-by-fake-call";
process.env.TELEGRAM_BOT_TOKEN ||= "000000:test-token-for-harness";
process.env.DRY_RUN = "true";
process.env.TZ = "America/Denver";
fs.rmSync(process.env.DB_PATH, { force: true });

// Proxy-aware fetch, same as index.js does.
if (process.env.HTTPS_PROXY || process.env.https_proxy) {
  const { fetch: proxiedFetch, EnvHttpProxyAgent } = await import("undici");
  const agent = new EnvHttpProxyAgent();
  globalThis.fetch = (input, init = {}) => proxiedFetch(input, { ...init, dispatcher: agent });
}

// Stub the Anthropic API: inline handlers (chat, /amend, /kdp, /book, /app)
// call callAgent directly, and the harness must never hit the real API.
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.includes("api.anthropic.com")) return realFetch(input, init);
    const raw = init.body ?? (input instanceof Request ? await input.text() : "{}");
    const body = JSON.parse(raw);
    const sys = Array.isArray(body.system) ? body.system[0].text : String(body.system || "");
    const last = JSON.stringify(body.messages.at(-1));
    let text = "ok";
    if (sys.includes("CRITIQUE AGENT")) {
      text = last.includes("Constitution amendment")
        ? "No draft may exceed 900 characters on X."
        : "VERDICT: PASS\nQUALITY_FLAG: NO\nNOTES: NONE";
    } else if (sys.includes("CHIEF OF STAFF")) {
      text = "Chief of Staff inline reply.";
    } else if (sys.includes("BOOK GROWTH") || sys.includes("APP GROWTH")) {
      text = "METRIC: ebooks = 42\nREAD: honest quiet week.";
    }
    return new Response(
      JSON.stringify({
        id: "msg_test", type: "message", role: "assistant", model: "stub",
        stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: "text", text }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
}

const { initDb, ensureSchema, settings, drafts, jobs, markUpdateSeen, sql } = await import("../src/db.js");
const { openLocalDb } = await import("../src/db-local.js");
const { setPromptSources, validatePromptSources, loadConstitution, formatAmendment } = await import("../src/prompts.js");
const { createBot } = await import("../src/telegram/bot.js");
const { processJobs } = await import("../src/jobs.js");
const { runScheduledTick, localClock, parseAssignments } = await import("../src/scheduler.js");

initDb(openLocalDb(process.env.DB_PATH));
await ensureSchema();
setPromptSources({
  constitution: fs.readFileSync(path.join(here, "..", "prompts", "01_AGENT_CONSTITUTION.md"), "utf8"),
  systemPrompts: fs.readFileSync(path.join(here, "..", "prompts", "02_SYSTEM_PROMPTS.md"), "utf8"),
});
validatePromptSources();

// --- Stubbed Telegram API -------------------------------------------------------
const apiCalls = [];
const OWNER = 777;
const bot = createBot();
bot.botInfo = {
  id: 42, is_bot: true, first_name: "Harness", username: "harness_bot",
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false,
};
bot.api.config.use((prev, method, payload) => {
  apiCalls.push({ method, payload });
  const results = {
    sendMessage: { message_id: apiCalls.length, date: 0, chat: { id: payload.chat_id, type: "private" }, text: payload.text },
    getFile: { file_id: payload.file_id, file_unique_id: "u", file_path: "photos/does_not_exist.jpg" },
  };
  return { ok: true, result: results[method] ?? true };
});

function texts() {
  return apiCalls.filter((c) => c.method === "sendMessage").map((c) => c.payload.text);
}
function lastText() {
  return texts().at(-1) ?? "(no message)";
}

let updateId = 100;
function msgUpdate(text, from = OWNER, extra = {}) {
  const entities = text.startsWith("/")
    ? [{ type: "bot_command", offset: 0, length: text.split(/\s/)[0].length }]
    : [];
  return {
    update_id: updateId++,
    message: {
      message_id: updateId, date: 1, text, entities,
      chat: { id: from, type: "private" },
      from: { id: from, is_bot: false, first_name: "Cayden" },
      ...extra,
    },
  };
}
function callbackUpdate(data, from = OWNER) {
  return {
    update_id: updateId++,
    callback_query: {
      id: String(updateId), data, chat_instance: "ci",
      from: { id: from, is_bot: false, first_name: "Cayden" },
      message: { message_id: 1, date: 1, chat: { id: from, type: "private" } },
    },
  };
}

// --- Fake agent -------------------------------------------------------------------
const agentCalls = [];
async function fakeCall(agentKey, messages) {
  agentCalls.push(agentKey);
  const last = String(messages.at(-1).content);
  switch (agentKey) {
    case "content":
    case "engagement":
      return "Test post copy about the book.";
    case "chief_of_staff":
      if (last.includes("submitted this draft"))
        return "DECISION: SEND\nRATIONALE: strong angle, fits the week\nDRAFT:\nTest post copy about the book.";
      if (last.includes("Daily planning run"))
        return "ASSIGN: linkedin | book | harness daily brief";
      if (last.includes("Weekly planning session")) return "Weekly plan: post good things.";
      return "Chief of Staff reply.";
    case "critique":
      if (last.includes("proposes this Constitution amendment"))
        return "No draft may exceed 900 characters on X.";
      return "VERDICT: PASS\nQUALITY_FLAG: NO\nNOTES: NONE";
    case "book_growth":
    case "app_growth":
      return "Half report.\nREAD: quiet week.";
    case "trends":
      return "LEADERSHIP SPACE\n- something\nANGLES\n- x | Story Bank | works";
    default:
      return "ok";
  }
}
const deps = { call: fakeCall };

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

console.log("— Owner lock —");
await check("stranger before claim is ignored", async () => {
  await bot.handleUpdate(msgUpdate("/status", 888));
  assert.equal(texts().length, 0);
});
await check("/start claims ownership", async () => {
  await bot.handleUpdate(msgUpdate("/start"));
  assert.match(lastText(), /registered as the owner/);
  assert.equal(await settings.get("owner_id"), String(OWNER));
});
await check("stranger after claim is ignored", async () => {
  const before = texts().length;
  await bot.handleUpdate(msgUpdate("/status", 888));
  assert.equal(texts().length, before);
});

console.log("— /status —");
await check("/status reports empty state", async () => {
  await bot.handleUpdate(msgUpdate("/status"));
  assert.match(lastText(), /Publishing: active \(dry run\)/);
  assert.match(lastText(), /Approval queue: 0 drafts/);
});

console.log("— /draft pipeline through the job queue —");
await check("/draft enqueues a pipeline job", async () => {
  await bot.handleUpdate(msgUpdate("/draft x book the swim story angle"));
  assert.match(lastText(), /Running the pipeline: x, book/);
  const row = await sql.get("SELECT * FROM jobs WHERE status = 'pending'");
  assert.ok(row, "job row exists");
  assert.equal(JSON.parse(row.payload).platform, "x");
});
await check("processJobs runs the full pipeline to an approval card", async () => {
  const n = await processJobs(bot.api, { deps });
  assert.equal(n, 1);
  const queued = await drafts.listByStatus("queued");
  assert.equal(queued.length, 1);
  assert.equal(queued[0].critique_verdict, "PASS");
  const card = apiCalls.filter((c) => c.method === "sendMessage").at(-1);
  assert.match(card.payload.text, /Draft #1 · book · x/);
  assert.ok(card.payload.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === "approve:1"));
  assert.deepEqual(agentCalls, ["content", "chief_of_staff", "critique"]);
});

console.log("— Approve, schedule, dry-run publish —");
await check("approve swaps to scheduling keyboard", async () => {
  await bot.handleUpdate(callbackUpdate("approve:1"));
  assert.equal((await drafts.get(1)).status, "approved");
  const edit = apiCalls.filter((c) => c.method === "editMessageReplyMarkup").at(-1);
  const buttons = edit.payload.reply_markup.inline_keyboard.flat();
  assert.ok(buttons.some((b) => b.callback_data === "pub:1:now"));
  assert.ok(buttons.length >= 3, "peak slots offered");
});
await check("post-now publishes as dry run", async () => {
  await bot.handleUpdate(callbackUpdate("pub:1:now"));
  const d = await drafts.get(1);
  assert.equal(d.status, "published");
  assert.match(lastText(), /published \(dry run/);
});

console.log("— Edit flow through the revise job —");
await check("second draft queues and edit-instruction enqueues revise job", async () => {
  await bot.handleUpdate(msgUpdate("/draft linkedin book another angle"));
  await processJobs(bot.api, { deps });
  await bot.handleUpdate(callbackUpdate("edit:2"));
  await bot.handleUpdate(msgUpdate("> tighten the middle"));
  const job = await sql.get("SELECT * FROM jobs WHERE type = 'revise' AND status = 'pending'");
  assert.ok(job, "revise job queued");
  await processJobs(bot.api, { deps });
  assert.equal((await drafts.get(2)).status, "queued");
  assert.match(lastText(), /Draft #2/);
});
await check("reject with reason", async () => {
  await bot.handleUpdate(callbackUpdate("reject:2"));
  await bot.handleUpdate(msgUpdate("wrong tone"));
  const d = await drafts.get(2);
  assert.equal(d.status, "rejected");
  assert.equal(d.rejection_reason, "wrong tone");
});

console.log("— Asset drop (photo) —");
await check("photo with caption enqueues an asset pipeline", async () => {
  await bot.handleUpdate(msgUpdate("", OWNER, {
    text: undefined, entities: undefined,
    photo: [{ file_id: "small", file_unique_id: "s", width: 90, height: 90 },
            { file_id: "big", file_unique_id: "b", width: 800, height: 800 }],
    caption: "instagram book cover on the job site",
  }));
  assert.match(lastText(), /Asset received \(photo\)/);
  const job = await sql.get("SELECT * FROM jobs WHERE status = 'pending'");
  const p = JSON.parse(job.payload);
  assert.equal(p.mediaFileId, "big");
  assert.equal(p.platform, "instagram");
});
await check("asset pipeline completes (photo fetch fails soft → caption-only)", async () => {
  await processJobs(bot.api, { deps });
  const queued = await drafts.listByStatus("queued");
  assert.equal(queued.length, 1);
  assert.equal(queued[0].media_file_id, "big");
});

console.log("— Inline handlers (chat, /kdp) through the stubbed API —");
await check("free-form text reaches the Chief of Staff", async () => {
  await bot.handleUpdate(msgUpdate("how are we looking this week?"));
  assert.equal(lastText(), "Chief of Staff inline reply.");
});
await check("/kdp logs raw entry and extracts metrics", async () => {
  await bot.handleUpdate(msgUpdate("/kdp 42 ebooks, 3 reviews"));
  assert.match(lastText(), /KDP figures logged/);
  const m = await sql.get("SELECT * FROM metrics_log WHERE metric = 'ebooks'");
  assert.equal(m.value, "42");
});

console.log("— /amend to D1-backed constitution —");
await check("amendment ratifies into settings, not the filesystem", async () => {
  await bot.handleUpdate(msgUpdate("/amend cap X posts at 900 characters"));
  await bot.handleUpdate(callbackUpdate("amend:confirm"));
  const doc = await loadConstitution();
  assert.match(doc, /Amendment 1 .*900 characters/);
  assert.ok(await settings.get("constitution_document"), "stored in settings");
});

console.log("— Scheduler tick (Mon 09:05 Denver) —");
await check("localClock resolves Denver wall time", () => {
  const c = localClock(new Date("2026-07-20T15:05:00Z"));
  assert.deepEqual({ ...c }, { date: "2026-07-20", dow: 1, hour: 9, minute: 5 });
});
await check("tick runs trends, plan, daily once and only once", async () => {
  const now = new Date("2026-07-20T15:05:00Z");
  agentCalls.length = 0;
  const r1 = await runScheduledTick(bot.api, { now, deps });
  assert.deepEqual(r1.ran, ["trends", "weekly_plan", "daily"]);
  assert.ok(agentCalls.includes("trends"));
  const r2 = await runScheduledTick(bot.api, { now, deps });
  assert.deepEqual(r2.ran, [], "markers prevent double runs");
  // daily run assigned one brief; its pipeline ran inline and queued a card
  assert.ok((await drafts.listByStatus("queued")).length >= 1);
});
await check("parseAssignments caps and parses", () => {
  const a = parseAssignments("ASSIGN: linkedin | book | one\nASSIGN: x | app | two");
  assert.deepEqual(a.map((x) => x.platform), ["linkedin", "x"]);
});

console.log("— Webhook dedupe —");
await check("update ids dedupe on redelivery", async () => {
  assert.equal(await markUpdateSeen(5555), true);
  assert.equal(await markUpdateSeen(5555), false);
});

console.log("— /channels against LIVE Postiz —");
if (process.env.POSTIZ_API_KEY) {
  await check("live channel mapping", async () => {
    await bot.handleUpdate(msgUpdate("/channels"));
    assert.match(lastText(), /Postiz connected/);
    assert.match(lastText(), /linkedin: publishes to/);
    assert.match(lastText(), /instagram: publishes to/);
    assert.match(lastText(), /x: publishes to/);
  });
} else {
  console.log("  (skipped: POSTIZ_API_KEY not set)");
}

console.log("— Worker HTTP shell —");
{
  const worker = (await import("../src/worker.js")).default;
  const dbPath2 = path.join(scratch, "harness-worker.db");
  fs.rmSync(dbPath2, { force: true });
  const env = {
    DB: openLocalDb(dbPath2),
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_WEBHOOK_SECRET: "harness-secret",
    ANTHROPIC_API_KEY: "test-key",
    DRY_RUN: "true",
    TZ: "America/Denver",
  };
  const ctx = { waitUntil(p) { (this.tasks ||= []).push(p); } };

  await check("GET / health", async () => {
    const res = await worker.fetch(new Request("https://x.example/"), env, ctx);
    assert.equal(res.status, 200);
  });
  await check("webhook without secret is 403", async () => {
    const res = await worker.fetch(
      new Request("https://x.example/telegram", { method: "POST", body: "{}" }), env, ctx);
    assert.equal(res.status, 403);
  });
  await check("setup with wrong key is 403", async () => {
    const res = await worker.fetch(new Request("https://x.example/setup?key=nope"), env, ctx);
    assert.equal(res.status, 403);
  });
  await check("webhook accepts a signed update and dedupes the retry", async () => {
    const body = JSON.stringify(msgUpdate("/status", 999)); // unclaimed owner: silent
    const req = () => new Request("https://x.example/telegram", {
      method: "POST", body,
      headers: { "x-telegram-bot-api-secret-token": "harness-secret" },
    });
    const res1 = await worker.fetch(req(), env, ctx);
    assert.equal(res1.status, 200);
    const res2 = await worker.fetch(req(), env, ctx);
    assert.equal(res2.status, 200);
    await Promise.allSettled(ctx.tasks ?? []);
  });
}

console.log(`\nAll ${passed} checks passed.`);
