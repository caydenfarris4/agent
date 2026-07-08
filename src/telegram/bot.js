import { Bot } from "grammy";
import { HttpsProxyAgent } from "https-proxy-agent";
import { config } from "../config.js";
import { db, drafts, settings, isPaused, setPaused, logEvent } from "../db.js";
import { callAgent } from "../agents/client.js";
import { runContentPipeline } from "../agents/pipeline.js";
import { publishDraft, flushApproved } from "../publish.js";
import { sendApprovalCard } from "./approvals.js";

const PLATFORMS = new Set(["linkedin", "instagram", "x", "email"]);
const VERTICALS = new Set(["book", "app"]);

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

  // Rolling Chief of Staff conversation, in memory only. A restart clears
  // it; durable state lives in SQLite.
  const chiefHistory = [];

  function requireApiKey() {
    if (config.anthropicApiKey) return null;
    return "ANTHROPIC_API_KEY is not set. Agent features are offline; add the key to .env and restart.";
  }

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
        "Commands: /status /draft /queue /plan /report /book /app /idea /outreach /kdp /pause /resume /amend\n\n" +
        "Or just talk to the Chief of Staff.",
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

  // --- /draft: run one full pipeline pass ------------------------------------
  // Usage: /draft [platform] [vertical] <brief>
  // e.g.   /draft linkedin book six weeks out, the swim story angle
  bot.command("draft", async (ctx) => {
    const offline = requireApiKey();
    if (offline) return ctx.reply(offline);

    const args = (ctx.match || "").trim();
    if (!args) {
      return ctx.reply(
        "Usage: /draft [platform] [vertical] <brief>\n" +
          "Platforms: linkedin (default), instagram, x, email. Verticals: book (default), app.\n\n" +
          "Example: /draft x book launch is six weeks out, the swim story angle",
      );
    }

    const words = args.split(/\s+/);
    let platform = "linkedin";
    let vertical = "book";
    while (words.length > 1) {
      const w = words[0].toLowerCase();
      if (PLATFORMS.has(w)) platform = w;
      else if (VERTICALS.has(w)) vertical = w;
      else break;
      words.shift();
    }
    const brief = words.join(" ");

    const chatId = ctx.chat.id;
    await ctx.reply(
      `Running the pipeline: ${platform}, ${vertical} vertical.\nBrief: ${brief}`,
    );
    // Don't block the update loop while agents think; report back when done.
    runContentPipeline(
      { brief, vertical, platform },
      { onProgress: (line) => bot.api.sendMessage(chatId, line).then(() => {}) },
    )
      .then((draft) => sendApprovalCard(bot.api, chatId, draft))
      .catch(async (err) => {
        console.error("Pipeline error:", err);
        logEvent("pipeline_error", { message: String(err?.message ?? err) });
        await bot.api.sendMessage(chatId, `Pipeline failed: ${err.message}`);
      });
  });

  // --- /queue: resend anything awaiting approval ------------------------------
  bot.command("queue", async (ctx) => {
    const queued = drafts.listByStatus("queued");
    if (queued.length === 0) {
      return ctx.reply("The approval queue is empty. Nothing is waiting on you.");
    }
    await ctx.reply(
      `${queued.length} draft${queued.length === 1 ? "" : "s"} awaiting your approval:`,
    );
    for (const draft of queued) {
      await sendApprovalCard(bot.api, ctx.chat.id, draft);
    }
  });

  // --- Approve / Reject inline buttons ---------------------------------------
  bot.callbackQuery(/^approve:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const draft = drafts.get(id);
    if (!draft || draft.status !== "queued") {
      await ctx.answerCallbackQuery({ text: "Already handled." });
      return;
    }
    drafts.update(id, { status: "approved" });
    logEvent("draft_approved", { draft_id: id });
    await ctx.answerCallbackQuery({ text: "Approved." });
    await ctx.editMessageReplyMarkup(); // remove the buttons

    const result = publishDraft(drafts.get(id));
    if (result.published) {
      await ctx.reply(
        `Draft #${id} approved and published${result.dryRun ? " (dry run: logged, not posted)" : ""}.`,
      );
    } else if (result.reason === "paused") {
      await ctx.reply(
        `Draft #${id} approved. Publishing is paused; it goes out on /resume.`,
      );
    } else {
      await ctx.reply(
        `Draft #${id} approved. No publisher is connected yet (Postiz lands in M5), so it stays in the approved list.`,
      );
    }
  });

  bot.callbackQuery(/^reject:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const draft = drafts.get(id);
    if (!draft || draft.status !== "queued") {
      await ctx.answerCallbackQuery({ text: "Already handled." });
      return;
    }
    settings.set("awaiting_rejection_for", String(id));
    await ctx.answerCallbackQuery({ text: "Rejecting." });
    await ctx.reply(
      `Rejecting draft #${id}. Reply with a one-line reason (it goes back to the specialist), or "skip".`,
    );
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
    const flushed = flushApproved().filter((r) => r.result.published);
    let line = "Publishing resumed.";
    if (flushed.length > 0) {
      line += ` ${flushed.length} approved draft${flushed.length === 1 ? "" : "s"} published${config.dryRun ? " (dry run)" : ""}.`;
    }
    await ctx.reply(line);
  });

  // --- Commands arriving in later milestones ---------------------------------
  const pending = {
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

  // --- Free-form text: rejection reasons, then Chief of Staff chat -----------
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();

    // A pending rejection captures the next message as the reason.
    const rejecting = settings.get("awaiting_rejection_for");
    if (rejecting) {
      settings.set("awaiting_rejection_for", "");
      const id = Number(rejecting);
      const reason = /^skip$/i.test(text) ? "" : text;
      drafts.update(id, {
        status: "rejected",
        rejection_reason: reason || null,
      });
      logEvent("draft_rejected", { draft_id: id, reason });
      return ctx.reply(
        reason
          ? `Draft #${id} rejected. Reason logged for the specialist: "${reason}"`
          : `Draft #${id} rejected, no reason given.`,
      );
    }

    // Everything else is a conversation with the Chief of Staff.
    const offline = requireApiKey();
    if (offline) return ctx.reply(offline);

    const queued = drafts.listByStatus("queued").length;
    const context =
      `[System context: publishing is ${isPaused() ? "paused" : "active"}` +
      `${config.dryRun ? ", dry run" : ""}; ${queued} draft(s) in the approval queue. ` +
      "Cayden says:]\n\n";

    chiefHistory.push({ role: "user", content: context + text });
    while (chiefHistory.length > 20) chiefHistory.shift();
    try {
      const reply = await callAgent("chief_of_staff", [...chiefHistory]);
      chiefHistory.push({ role: "assistant", content: reply });
      await ctx.reply(reply);
    } catch (err) {
      chiefHistory.pop();
      console.error("Chief of Staff error:", err);
      await ctx.reply(`Chief of Staff call failed: ${err.message}`);
    }
  });

  bot.on("message", async (ctx) => {
    await ctx.reply(
      "Media asset drops arrive in M3. For now send text, or use /draft to run the content pipeline.",
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
    { command: "draft", description: "Run the content pipeline on a brief" },
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
