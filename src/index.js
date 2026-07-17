import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, assertStartupConfig } from "./config.js";
import { initDb, ensureSchema, logEvent } from "./db.js";
import { openLocalDb } from "./db-local.js";
import { setPromptSources, validatePromptSources } from "./prompts.js";
import { createBot, registerCommandMenu } from "./telegram/bot.js";
import { startSchedulers } from "./scheduler.js";
import { processJobs } from "./jobs.js";
import { checkConnection, isConfigured } from "./postiz.js";

/**
 * Node entry point: local development and the VPS/Docker fallback. Long
 * polling instead of a webhook, better-sqlite3 (through the D1-shaped shim)
 * instead of D1, setInterval instead of Cron Triggers. Production runs on
 * Cloudflare Workers via src/worker.js.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

// Node's global fetch ignores HTTPS_PROXY (sandboxed/corporate environments);
// install a proxy-aware fetch so Postiz, Telegram file downloads, and the
// Anthropic SDK all route correctly. On a normal VPS this is a no-op.
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
let grammyClientConfig;
if (proxy) {
  const { fetch: proxiedFetch, EnvHttpProxyAgent } = await import("undici");
  const agent = new EnvHttpProxyAgent();
  globalThis.fetch = (input, init = {}) => proxiedFetch(input, { ...init, dispatcher: agent });
  // grammY bundles node-fetch, which takes a classic agent instead.
  const { HttpsProxyAgent } = await import("https-proxy-agent");
  grammyClientConfig = { baseFetchConfig: { agent: new HttpsProxyAgent(proxy), compress: true } };
}

const problems = assertStartupConfig();
if (problems.length > 0) {
  for (const p of problems) console.error(`Config error: ${p}`);
  console.error("Copy .env.example to .env and fill in the missing values.");
  process.exit(1);
}

initDb(openLocalDb());
await ensureSchema();

setPromptSources({
  constitution: fs.readFileSync(path.join(here, "..", "prompts", "01_AGENT_CONSTITUTION.md"), "utf8"),
  systemPrompts: fs.readFileSync(path.join(here, "..", "prompts", "02_SYSTEM_PROMPTS.md"), "utf8"),
});
// Fail fast if the prompt documents are missing or malformed.
validatePromptSources();
console.log("Loaded prompt documents (constitution re-read on every call).");

if (!config.anthropicApiKey) {
  console.warn(
    "ANTHROPIC_API_KEY is not set: /status, /pause, /resume work, but /draft and Chief of Staff chat are offline.",
  );
}

let bot;
bot = createBot({
  clientConfig: grammyClientConfig,
  // Long polling has no waitUntil: drain queued pipeline jobs right after
  // each update lands.
  afterUpdate: () => {
    processJobs(bot.api).catch((err) => console.error("Job drain failed:", err));
  },
});

let schedulers = { stop() {} };

async function main() {
  await registerCommandMenu(bot);
  schedulers = startSchedulers(bot);
  await logEvent("startup", { dry_run: config.dryRun });

  // Non-fatal Postiz check: publishing must never block the bot from starting.
  if (isConfigured()) {
    const postiz = await checkConnection();
    if (postiz.ok) {
      const names = postiz.integrations.map((i) => i.identifier).join(", ");
      console.log(
        `Postiz connected (${config.postizUrl}): ${postiz.integrations.length} channel(s)${names ? ` [${names}]` : ""}`,
      );
    } else {
      console.error(`Postiz connection failed: ${postiz.error}`);
    }
  } else {
    console.log("Postiz not configured; publish steps will dry-run/log only.");
  }

  console.log(
    `Starting Telegram bot (long polling). DRY_RUN=${config.dryRun}, model=${config.agentModel}`,
  );
  // grammY long polling; resolves only on stop.
  await bot.start({
    onStart: (me) => console.log(`Bot online as @${me.username}`),
  });
}

function shutdown() {
  schedulers.stop();
  bot.stop();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
