import { config, assertStartupConfig } from "./config.js";
import { logEvent } from "./db.js";
import { AGENT_KEYS, buildSystemPrompt } from "./prompts.js";
import { createBot, registerCommandMenu } from "./telegram/bot.js";
import { startSchedulers } from "./scheduler.js";

const problems = assertStartupConfig();
if (problems.length > 0) {
  for (const p of problems) console.error(`Config error: ${p}`);
  console.error("Copy .env.example to .env and fill in the missing values.");
  process.exit(1);
}

// Fail fast if the prompt documents are missing or malformed: every agent's
// system prompt must be buildable at startup.
for (const key of AGENT_KEYS) {
  buildSystemPrompt(key);
}
console.log(
  `Loaded system prompts for ${AGENT_KEYS.length} agents from prompts/ (constitution re-read on every call).`,
);

if (!config.anthropicApiKey) {
  console.warn(
    "ANTHROPIC_API_KEY is not set: /status, /pause, /resume work, but /draft and Chief of Staff chat are offline.",
  );
}

const bot = createBot();

let schedulers = { stop() {} };

async function main() {
  await registerCommandMenu(bot);
  schedulers = startSchedulers(bot);
  logEvent("startup", { dry_run: config.dryRun });
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
