import { Bot } from "grammy";
import { HttpsProxyAgent } from "https-proxy-agent";
import { config } from "../config.js";
import { db, settings, isPaused, setPaused, logEvent } from "../db.js";

export function createBot() {
  // Honor HTTPS_PROXY when present (e.g. sandboxed/corporate environments).
  // grammY's node-fetch ignores proxy env vars, so pass an agent explicitly.
  // On a normal VPS this is a no-op.
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const bot = new Bot(config.telegramToken, {
    client: proxy
      ? { baseFetchConfig: { agent: new HttpsProxyAgent(proxy), compress: true } }
      : undefined,
  });

  // --- Owner lock -----------------------------------------------------------
  // Only Cayden talks to this bot. Owner is TELEGRAM_OWNER_ID if set;
  // otherwise the first person to send /start claims ownership.
  function ownerId() {
    if (config.ownerId) return config.ownerId;
    const stored = settings.get("owner_id");
    return stored ? Number(stored) : null;
  }

  bot.use(async (ctx, next) => {
    const from = ctx.from?.id;
    if (!from) return;
    const owner = ownerId();
    if (owner === null) {
      // Unclaimed: only /start may claim ownership.
      if (ctx.message?.text?.startsWith("/start")) {
        settings.set("owner_id", String(from));
        logEvent("owner_claimed", { user_id: from });
        await ctx.reply(
          "You are now registered as the owner of this launch system. Only this account can use the bot.\n\nTry /status.",
        );
      }
      return;
    }
    if (from !== owner) {
      logEvent("unauthorized_access", { user_id: from });
      return; // silently ignore strangers
    }
    await next();
  });

  // --- /start ---------------------------------------------------------------
  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Under Construction launch system online.\n\n" +
        "Commands: /status /queue /plan /report /book /app /idea /outreach /kdp /pause /resume /amend",
    );
  });

  // --- /status: under ten lines ---------------------------------------------
  bot.command("status", async (ctx) => {
    const queued = db
      .prepare("SELECT COUNT(*) AS n FROM drafts WHERE status = 'queued'")
      .get().n;
    const scheduledToday = db
      .prepare(
        "SELECT COUNT(*) AS n FROM drafts WHERE status = 'approved' AND date(scheduled_for) = date('now')",
      )
      .get().n;
    const escalations = db
      .prepare(
        "SELECT COUNT(*) AS n FROM drafts WHERE critique_verdict = 'ESCALATE' AND status NOT IN ('rejected','published')",
      )
      .get().n;
    const outreachWaiting = db
      .prepare(
        "SELECT COUNT(*) AS n FROM outreach WHERE status = 'awaiting_approval'",
      )
      .get().n;

    const lines = [
      `Publishing: ${isPaused() ? "PAUSED" : "active"}${config.dryRun ? " (dry run)" : ""}`,
      `Approval queue: ${queued} draft${queued === 1 ? "" : "s"} awaiting you`,
      `Scheduled today: ${scheduledToday} post${scheduledToday === 1 ? "" : "s"}`,
    ];
    const waiting = [];
    if (escalations > 0) waiting.push(`${escalations} escalation(s)`);
    if (outreachWaiting > 0)
      waiting.push(`${outreachWaiting} outreach target(s)`);
    lines.push(
      waiting.length
        ? `Waiting on you: ${waiting.join(", ")}`
        : "Waiting on you: nothing",
    );
    await ctx.reply(lines.join("\n"));
  });

  // --- /pause and /resume: freeze or unfreeze all publishing instantly ------
  bot.command("pause", async (ctx) => {
    setPaused(true);
    logEvent("paused", {});
    await ctx.reply(
      "All publishing is paused. Drafting continues; nothing goes out until /resume.",
    );
  });

  bot.command("resume", async (ctx) => {
    setPaused(false);
    logEvent("resumed", {});
    await ctx.reply("Publishing resumed.");
  });

  // --- Commands arriving in later milestones ---------------------------------
  const pending = {
    queue: "M2",
    plan: "M4",
    report: "M4",
    book: "M3",
    app: "M3",
    idea: "M3",
    outreach: "M3",
    kdp: "M3",
    amend: "M3",
  };
  for (const [cmd, milestone] of Object.entries(pending)) {
    bot.command(cmd, async (ctx) => {
      await ctx.reply(`/${cmd} lands in milestone ${milestone}. Not wired up yet.`);
    });
  }

  bot.on("message", async (ctx) => {
    await ctx.reply(
      "Free-form conversation with the Chief of Staff arrives in M2. For now: /status, /pause, /resume.",
    );
  });

  bot.catch((err) => {
    console.error("Bot error:", err.error ?? err);
  });

  return bot;
}

export async function registerCommandMenu(bot) {
  await bot.api.setMyCommands([
    { command: "status", description: "Queue depth, today's posts, what's waiting on you" },
    { command: "queue", description: "Resend anything awaiting approval" },
    { command: "plan", description: "Trigger or review the weekly plan" },
    { command: "report", description: "Two-vertical weekly analytics report" },
    { command: "book", description: "Book vertical metrics snapshot" },
    { command: "app", description: "Foreman vertical metrics snapshot" },
    { command: "idea", description: "Throw a thought into the loop" },
    { command: "outreach", description: "Podcast pipeline status" },
    { command: "kdp", description: "Log weekly KDP sales figures" },
    { command: "pause", description: "Freeze all publishing instantly" },
    { command: "resume", description: "Unfreeze publishing" },
    { command: "amend", description: "Propose a Constitution change" },
  ]);
}
