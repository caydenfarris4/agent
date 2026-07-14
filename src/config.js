import "dotenv/config";

function bool(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return !["false", "0", "no", "off"].includes(String(value).toLowerCase());
}

export const config = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || "",
  ownerId: process.env.TELEGRAM_OWNER_ID
    ? Number(process.env.TELEGRAM_OWNER_ID)
    : null,

  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  agentModel: process.env.AGENT_MODEL || "claude-sonnet-4-6",

  // Default to Postiz cloud when only a key is provided; self-hosted
  // instances set POSTIZ_API_URL explicitly (…/api/public/v1).
  postizUrl: (
    process.env.POSTIZ_API_URL ||
    (process.env.POSTIZ_API_KEY ? "https://api.postiz.com/public/v1" : "")
  ).replace(/\/+$/, ""),
  postizKey: process.env.POSTIZ_API_KEY || "",

  // Safety default: dry run unless explicitly disabled.
  dryRun: bool(process.env.DRY_RUN, true),

  dbPath: process.env.DB_PATH || "./data/launch.db",
  timezone: process.env.TZ || "America/Denver",

  // Set ENABLE_SCHEDULERS=false to run the bot without the M4 cron jobs
  // (useful in development so a test bot doesn't run the daily pipeline).
  schedulersEnabled: bool(process.env.ENABLE_SCHEDULERS, true),
};

export function assertStartupConfig() {
  const problems = [];
  if (!config.telegramToken) {
    problems.push("TELEGRAM_BOT_TOKEN is not set (get one from @BotFather).");
  }
  return problems;
}
