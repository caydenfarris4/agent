import { config, assertStartupConfig } from "./config.js";
import { logEvent } from "./db.js";
import { AGENT_KEYS, buildSystemPrompt } from "./prompts.js";
import { createBot, registerCommandMenu } from "./telegram/bot.js";
import { checkConnection, isConfigured } from "./postiz.js";

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

const bot = createBot();

async function main() {
  await registerCommandMenu(bot);
  logEvent("startup", { dry_run: config.dryRun });

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

process.once("SIGINT", () => bot.stop());
process.once("SIGTERM", () => bot.stop());

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
