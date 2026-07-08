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

  postizUrl: process.env.POSTIZ_API_URL || "",
  postizKey: process.env.POSTIZ_API_KEY || "",

  // Safety default: dry run unless explicitly disabled.
  dryRun: bool(process.env.DRY_RUN, true),

  dbPath: process.env.DB_PATH || "./data/launch.db",
  timezone: process.env.TZ || "America/Denver",
};

export function assertStartupConfig() {
  const problems = [];
  if (!config.telegramToken) {
    problems.push("TELEGRAM_BOT_TOKEN is not set (get one from @BotFather).");
  }
  return problems;
}
