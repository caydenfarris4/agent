function bool(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return !["false", "0", "no", "off"].includes(String(value).toLowerCase());
}

function env(name) {
  return typeof process !== "undefined" ? process.env[name] : undefined;
}

// Getters, not values: on Cloudflare Workers the environment is attached
// per-invocation (worker.js copies bindings into process.env before any
// handler runs), so nothing may snapshot process.env at import time.
export const config = {
  get telegramToken() {
    return env("TELEGRAM_BOT_TOKEN") || "";
  },
  get ownerId() {
    return env("TELEGRAM_OWNER_ID") ? Number(env("TELEGRAM_OWNER_ID")) : null;
  },
  get webhookSecret() {
    return env("TELEGRAM_WEBHOOK_SECRET") || "";
  },

  get anthropicApiKey() {
    return env("ANTHROPIC_API_KEY") || "";
  },
  get agentModel() {
    return env("AGENT_MODEL") || "claude-sonnet-4-6";
  },

  // Default to Postiz cloud when only a key is provided; self-hosted
  // instances set POSTIZ_API_URL explicitly (…/api/public/v1).
  get postizUrl() {
    return (
      env("POSTIZ_API_URL") ||
      (env("POSTIZ_API_KEY") ? "https://api.postiz.com/public/v1" : "")
    ).replace(/\/+$/, "");
  },
  get postizKey() {
    return env("POSTIZ_API_KEY") || "";
  },

  // Safety default: dry run unless explicitly disabled.
  get dryRun() {
    return bool(env("DRY_RUN"), true);
  },

  get dbPath() {
    return env("DB_PATH") || "./data/launch.db";
  },
  get timezone() {
    return env("TZ") || "America/Denver";
  },

  // Set ENABLE_SCHEDULERS=false to run the bot without the M4 cron jobs
  // (useful in development so a test bot doesn't run the daily pipeline).
  get schedulersEnabled() {
    return bool(env("ENABLE_SCHEDULERS"), true);
  },
};

export function assertStartupConfig() {
  const problems = [];
  if (!config.telegramToken) {
    problems.push("TELEGRAM_BOT_TOKEN is not set (get one from @BotFather).");
  }
  return problems;
}
