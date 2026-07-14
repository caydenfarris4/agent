import { Bot } from "grammy";
import { HttpsProxyAgent } from "https-proxy-agent";
import { config } from "../config.js";
import { db, drafts, settings, links, getOwnerId, isPaused, setPaused, logEvent, scrubSecrets } from "../db.js";
import { callAgent } from "../agents/client.js";
import { runContentPipeline, reviseDraft } from "../agents/pipeline.js";
import { publishDraft, publishDue, describePublishResult } from "../publish.js";
import { isConfigured as postizConfigured, checkConnection, integrationsForPlatform } from "../postiz.js";
import { sendApprovalCard, scheduleKeyboard } from "./approvals.js";
import { formatSlot, toSqliteUtc } from "../schedule.js";
import { registerM3, parseTargeting } from "./m3.js";
import { registerM4 } from "../scheduler.js";

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
  bot.use(async (ctx, next) => {
    const from = ctx.from?.id;
    if (!from) return;
    const owner = getOwnerId();
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
        "Commands: /status /draft /queue /reply /plan /report /book /app /idea /outreach /kdp /pause /resume /amend\n\n" +
        "Send a photo or video with a caption as an asset drop, or just talk to the Chief of Staff.",
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
    const unscheduled = db
      .prepare(
        "SELECT COUNT(*) AS n FROM drafts WHERE status = 'approved' AND scheduled_for IS NULL AND published_at IS NULL",
      )
      .get().n;
    if (unscheduled > 0)
      waiting.push(`${unscheduled} approved draft(s) awaiting a post time`);
    lines.push(
      waiting.length
        ? `Waiting on you: ${waiting.join(", ")}`
        : "Waiting on you: nothing",
    );
    if (!links.all().amazon) {
      lines.push("Amazon link not set; drafts use a placeholder. Fix: /links amazon <url>");
    }
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

    const { platform, vertical, rest: brief } = parseTargeting(args);

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
        await bot.api.sendMessage(chatId, `Pipeline failed: ${scrubSecrets(err.message)}`);
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
    await ctx.answerCallbackQuery({ text: "Approved. When should it post?" });
    // Swap Approve/Reject for the scheduling choices (peak slots per platform).
    await ctx.editMessageReplyMarkup({ reply_markup: scheduleKeyboard(draft) });
  });

  // --- When to post: now, or a peak slot --------------------------------------
  bot.callbackQuery(/^pub:(\d+):(now|\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const when = ctx.match[2];
    const draft = drafts.get(id);
    if (!draft || draft.status !== "approved" || draft.published_at) {
      await ctx.answerCallbackQuery({ text: "Already handled." });
      return;
    }

    if (when === "now") {
      // Stamp the choice: if publishing is paused or fails, the due-check
      // and /resume know this draft was released, unlike one still waiting
      // for a time to be picked.
      drafts.update(id, { scheduled_for: toSqliteUtc(new Date()) });
      await ctx.answerCallbackQuery({ text: "Posting now." });
      await ctx.editMessageReplyMarkup(); // remove the buttons
      const fresh = drafts.get(id);
      const result = await publishDraft(fresh, { api: ctx.api });
      await ctx.reply(describePublishResult(fresh, result));
      return;
    }

    const slot = new Date(Number(when) * 1000);
    drafts.update(id, { scheduled_for: toSqliteUtc(slot) });
    logEvent("draft_scheduled", { draft_id: id, scheduled_for: toSqliteUtc(slot) });
    await ctx.answerCallbackQuery({ text: "Scheduled." });
    await ctx.editMessageReplyMarkup();
    await ctx.reply(
      `Draft #${id} scheduled for ${formatSlot(slot)} (${config.timezone}), a peak window for ${draft.platform}. It posts automatically${config.dryRun ? " (dry run: it will log, not post)" : ""}; /pause holds it.`,
    );
  });

  bot.callbackQuery(/^reject:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const draft = drafts.get(id);
    if (!draft || draft.status !== "queued") {
      await ctx.answerCallbackQuery({ text: "Already handled." });
      return;
    }
    settings.set("awaiting_rejection_for", String(id));
    settings.set("awaiting_edit_for", "");
    await ctx.answerCallbackQuery({ text: "Rejecting." });
    await ctx.reply(
      `Rejecting draft #${id}. Reply with a one-line reason (it goes back to the specialist), or "skip".`,
    );
  });

  // --- ✏️ Edit: replace the copy, or instruct the specialist -------------------
  bot.callbackQuery(/^edit:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const draft = drafts.get(id);
    if (!draft || draft.status !== "queued") {
      await ctx.answerCallbackQuery({ text: "Already handled." });
      return;
    }
    settings.set("awaiting_edit_for", String(id));
    settings.set("awaiting_rejection_for", "");
    await ctx.answerCallbackQuery({ text: "Editing." });
    await ctx.reply(
      `Editing draft #${id}. Reply with either:\n` +
        `• the full revised copy (it replaces the draft as-is), or\n` +
        `• an instruction starting with ">" and the specialist revises it, e.g.\n` +
        `  > tighten the middle and cut the second metaphor\n\n` +
        `Or "cancel".`,
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
    // Release only drafts whose post time was chosen and has arrived;
    // approved drafts still awaiting a time pick stay put.
    const flushed = await publishDue({ api: ctx.api });
    const lines = ["Publishing resumed."];
    for (const { draft, result } of flushed) {
      lines.push(describePublishResult(draft, result));
    }
    await ctx.reply(lines.join("\n"));
  });

  // --- /channels: Postiz connection + per-platform coverage ------------------
  bot.command("channels", async (ctx) => {
    if (!postizConfigured()) {
      return ctx.reply(
        "Postiz isn't configured. Set POSTIZ_API_URL and POSTIZ_API_KEY once the dry-run week is complete.",
      );
    }
    const check = await checkConnection();
    if (!check.ok) {
      return ctx.reply(`Postiz connection failed: ${scrubSecrets(check.error)}`);
    }
    if (check.integrations.length === 0) {
      return ctx.reply(
        "Postiz responded but has no connected channels yet. Connect LinkedIn/Instagram/X in the Postiz dashboard, then rerun /channels.",
      );
    }
    const lines = ["Postiz connected. Channels:"];
    for (const i of check.integrations) {
      lines.push(`  ${i.identifier}: ${i.name}${i.disabled ? " (disabled)" : ""}`);
    }
    lines.push("");
    for (const p of ["linkedin", "instagram", "x"]) {
      const matches = integrationsForPlatform(check.integrations, p);
      lines.push(
        matches.length
          ? `${p}: publishes to ${matches.map((m) => m.name).join(", ")}`
          : `${p}: MISSING (connect it in Postiz, then rerun /channels)`,
      );
    }
    logEvent("postiz_channels_checked", { count: check.integrations.length });
    await ctx.reply(lines.join("\n"));
  });

  // --- M3: specialists, commands, asset drops --------------------------------
  registerM3(bot, { requireApiKey });

  // --- M4: /plan and /report on demand (schedulers start in index.js) --------
  registerM4(bot, { requireApiKey });

  // --- Free-form text: rejection reasons, then Chief of Staff chat -----------
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();

    // A pending edit captures the next message as new copy or an instruction.
    const editing = settings.get("awaiting_edit_for");
    if (editing) {
      settings.set("awaiting_edit_for", "");
      const id = Number(editing);
      const draft = drafts.get(id);
      if (!draft || draft.status !== "queued") {
        return ctx.reply(`Draft #${id} is no longer in the queue; nothing edited.`);
      }
      if (/^cancel$/i.test(text)) {
        return ctx.reply(`Edit cancelled. Draft #${id} is unchanged in the queue.`);
      }

      if (text.startsWith(">")) {
        const instruction = text.slice(1).trim();
        const offline = requireApiKey();
        if (offline) return ctx.reply(offline);
        await ctx.reply(`Sending your instruction to the ${draft.agent} agent...`);
        try {
          const revised = await reviseDraft(draft, instruction);
          drafts.update(id, { content: revised });
          logEvent("draft_edited", { draft_id: id, mode: "instruction" });
          await sendApprovalCard(ctx.api, ctx.chat.id, drafts.get(id));
        } catch (err) {
          await ctx.reply(`Revision failed: ${scrubSecrets(err.message)}. Draft #${id} is unchanged.`);
        }
        return;
      }

      // Full replacement: Cayden's words are final, no re-audit (Article IX).
      drafts.update(id, { content: text });
      logEvent("draft_edited", { draft_id: id, mode: "replace" });
      await ctx.reply(`Draft #${id} updated with your copy.`);
      await sendApprovalCard(ctx.api, ctx.chat.id, drafts.get(id));
      return;
    }

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
    const linkList = Object.entries(links.all())
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    const context =
      `[System context: publishing is ${isPaused() ? "paused" : "active"}` +
      `${config.dryRun ? ", DRY RUN (publishes are logged, not posted, until Cayden flips DRY_RUN off)" : ""}; ` +
      `${queued} draft(s) in the approval queue. ` +
      `Approved links: ${linkList || "none set yet"}. ` +
      "How publishing works in this system: when Cayden taps Approve on a draft card in Telegram, he picks a posting time (now, or a peak slot) and the system itself publishes through Postiz to the connected channel automatically. " +
      `Postiz is ${postizConfigured() ? "configured" : "NOT configured yet"}. ` +
      "Neither you nor any specialist posts anything manually, and Cayden never needs to copy content anywhere; do not tell him otherwise. " +
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
      await ctx.reply(`Chief of Staff call failed: ${scrubSecrets(err.message)}`);
    }
  });

  bot.on("message", async (ctx) => {
    await ctx.reply(
      "Send photos or videos with a caption as asset drops. Other media types aren't supported yet.",
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
    { command: "reply", description: "Draft a reply to a comment you paste" },
    { command: "plan", description: "Trigger or review the weekly plan" },
    { command: "report", description: "Two-vertical weekly analytics report" },
    { command: "trends", description: "What's trending and going viral this week" },
    { command: "book", description: "Book vertical metrics snapshot" },
    { command: "app", description: "Foreman vertical metrics snapshot" },
    { command: "idea", description: "Throw a thought into the loop" },
    { command: "outreach", description: "Podcast pipeline status" },
    { command: "kdp", description: "Log weekly KDP sales figures" },
    { command: "pause", description: "Freeze all publishing instantly" },
    { command: "resume", description: "Unfreeze publishing" },
    { command: "channels", description: "List and map Postiz channels" },
    { command: "links", description: "Approved links the agents may use" },
    { command: "amend", description: "Propose a Constitution change" },
  ]);
}
