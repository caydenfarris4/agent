import { createBot, registerCommandMenu } from "./telegram/bot.js";
import { initDb, ensureSchema, markUpdateSeen, logEvent } from "./db.js";
import { setPromptSources, validatePromptSources } from "./prompts.js";
import { processJobs } from "./jobs.js";
import { runScheduledTick } from "./scheduler.js";
import { config } from "./config.js";
import { isConfigured as postizConfigured, checkConnection } from "./postiz.js";
// Bundled as text by the [[rules]] block in wrangler.toml. Constitution
// amendments ratified at runtime live in D1 and override this copy.
import CONSTITUTION from "../prompts/01_AGENT_CONSTITUTION.md";
import SYSTEM_PROMPTS from "../prompts/02_SYSTEM_PROMPTS.md";

/**
 * Cloudflare Workers entry point. Telegram pushes updates to POST /telegram
 * (webhook, registered once via GET /setup), and a 5-minute Cron Trigger
 * drives the schedulers and drains the background job queue. There is no
 * long-lived process to die: every update and every tick is its own
 * invocation against D1 state.
 */

setPromptSources({ constitution: CONSTITUTION, systemPrompts: SYSTEM_PROMPTS });

// The environment arrives per-invocation; config.js reads process.env, so
// copy string bindings over before anything else runs. Idempotent.
function hydrateEnv(env) {
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") process.env[k] = v;
  }
}

let bot = null;
let validated = false;

async function getBot(env) {
  hydrateEnv(env);
  initDb(env.DB);
  await ensureSchema();
  if (!validated) {
    validatePromptSources();
    validated = true;
  }
  if (!bot) {
    if (!config.telegramToken) throw new Error("TELEGRAM_BOT_TOKEN is not set.");
    bot = createBot();
    await bot.init();
  }
  return bot;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Health check; deliberately says nothing about configuration.
    if (url.pathname === "/" && request.method === "GET") {
      return new Response("ok");
    }

    let b;
    try {
      b = await getBot(env);
    } catch (err) {
      console.error("Startup failed:", err);
      return new Response("startup failed", { status: 500 });
    }

    // --- Telegram webhook ---------------------------------------------------
    if (url.pathname === "/telegram" && request.method === "POST") {
      if (
        !config.webhookSecret ||
        request.headers.get("x-telegram-bot-api-secret-token") !== config.webhookSecret
      ) {
        return new Response("forbidden", { status: 403 });
      }
      let update;
      try {
        update = await request.json();
      } catch {
        return new Response("bad request", { status: 400 });
      }
      // Telegram redelivers on timeout; the first delivery wins.
      if (update.update_id && !(await markUpdateSeen(update.update_id))) {
        return new Response("ok");
      }
      const handled = b.handleUpdate(update).catch((err) => {
        console.error("Update handling failed:", err);
      });
      // waitUntil keeps the invocation alive if Telegram hangs up early, and
      // carries the queue drain (agent pipelines) past the response.
      ctx.waitUntil(
        handled
          .then(() => processJobs(b.api))
          .catch((err) => console.error("Job drain failed:", err)),
      );
      await handled;
      return new Response("ok");
    }

    // --- One-time setup: register the webhook and command menu ---------------
    if (url.pathname === "/setup") {
      if (url.searchParams.get("key") !== config.webhookSecret) {
        return new Response("forbidden", { status: 403 });
      }
      const hookUrl = `${url.origin}/telegram`;
      await b.api.setWebhook(hookUrl, {
        secret_token: config.webhookSecret,
        allowed_updates: ["message", "callback_query"],
      });
      await registerCommandMenu(b);
      await logEvent("webhook_registered", { url: hookUrl });
      const postiz = postizConfigured()
        ? await checkConnection()
        : { ok: false, error: "POSTIZ_API_URL / POSTIZ_API_KEY not set" };
      return json({
        webhook: hookUrl,
        bot: b.botInfo.username,
        dry_run: config.dryRun,
        anthropic_key: Boolean(config.anthropicApiKey),
        postiz: postiz.ok
          ? `connected, ${postiz.integrations.length} channel(s): ${postiz.integrations.map((i) => i.identifier).join(", ")}`
          : postiz.error,
      });
    }

    return new Response("not found", { status: 404 });
  },

  // Every 5 minutes: scheduled jobs by local wall-clock, the due-check for
  // scheduled posts, and the mop-up drain of the background queue.
  async scheduled(event, env, ctx) {
    const b = await getBot(env);
    await runScheduledTick(b.api);
    await processJobs(b.api);
  },
};
