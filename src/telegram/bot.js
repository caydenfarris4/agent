import { Bot } from "grammy";
import { HttpsProxyAgent } from "https-proxy-agent";
import { fetch as undiciFetch, EnvHttpProxyAgent } from "undici";
import { config } from "../config.js";
import {
  db,
  settings,
  isPaused,
  setPaused,
  logEvent,
  mediaLibrary,
} from "../db.js";
import { checkConnection, isConfigured, uploadMedia } from "../postiz.js";

// Same proxy handling as the Postiz client: Node fetch ignores HTTPS_PROXY.
const dispatcher =
  process.env.HTTPS_PROXY || process.env.https_proxy
    ? new EnvHttpProxyAgent()
    : undefined;

// Strips secrets out of text that gets replied to chat or persisted in the
// events table (e.g. errors quoting a URL that embeds the bot token).
function scrubSecrets(text) {
  let out = String(text);
  for (const secret of [config.telegramToken, config.postizKey]) {
    if (secret) out = out.split(secret).join("[redacted]");
  }
  return out;
}

// Pulls a file off Telegram's servers. Bot API caps getFile at 20 MB.
async function downloadTelegramFile(api, fileId) {
  const file = await api.getFile(fileId);
  // This URL embeds the bot token — it must never appear in errors or logs.
  const url = `https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`;
  const res = await undiciFetch(url, { dispatcher });
  if (!res.ok) {
    throw new Error(`Telegram file download failed (${res.status})`);
  }
  return {
    data: Buffer.from(await res.arrayBuffer()),
    filename: file.file_path.split("/").pop(),
  };
}

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
        "Commands: /status /queue /plan /report /book /app /idea /outreach /kdp /postiz /media /pause /resume /amend\n\n" +
          "Send me a photo or video any time — it goes into the Postiz media library for reuse in posts.",
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

  // --- /postiz: verify the publishing connection -----------------------------
  bot.command("postiz", async (ctx) => {
    if (!isConfigured()) {
      await ctx.reply(
        "Postiz is not configured yet. Set POSTIZ_API_URL and POSTIZ_API_KEY in .env.\n" +
          `Publishing would ${config.dryRun ? "dry-run (log only)" : "FAIL"} right now.`,
      );
      return;
    }
    const result = await checkConnection();
    if (!result.ok) {
      logEvent("postiz_check_failed", { error: result.error });
      await ctx.reply(`Postiz connection FAILED:\n${result.error}`);
      return;
    }
    logEvent("postiz_check_ok", {
      channels: result.integrations.map((i) => i.identifier),
    });
    const channels = result.integrations.length
      ? result.integrations
          .map(
            (i) =>
              `• ${i.name} (${i.identifier})${i.disabled ? " — disabled" : ""}`,
          )
          .join("\n")
      : "• none yet — connect channels in the Postiz dashboard";
    await ctx.reply(
      `Postiz connected (${config.postizUrl}).\nChannels:\n${channels}\n\n` +
        `Mode: ${config.dryRun ? "DRY RUN — posts are logged, not published" : "LIVE"}`,
    );
  });

  // --- /media: browse the reusable media library -----------------------------
  bot.command("media", async (ctx) => {
    const rows = mediaLibrary.list(15);
    if (rows.length === 0) {
      await ctx.reply(
        "Media library is empty. Send me a photo or video and I'll upload it to Postiz and keep it here for reuse.",
      );
      return;
    }
    const lines = rows.map(
      (m) =>
        `#${m.id} ${m.kind}${m.label ? ` — ${m.label}` : ""}\n   ${m.path}`,
    );
    await ctx.reply(
      `Media library (newest ${rows.length}):\n\n${lines.join("\n")}\n\n` +
        "Reference these by #id when approving posts.",
    );
  });

  // --- Incoming photos/videos: mirror into Postiz + library ------------------
  // Send a photo or video (optionally with a caption used as its label) and
  // it becomes reusable media for any future post.
  async function saveIncomingMedia(ctx, kind, fileObj) {
    if (!isConfigured()) {
      await ctx.reply(
        "Postiz is not configured, so I can't upload media yet. Set POSTIZ_API_URL and POSTIZ_API_KEY.",
      );
      return;
    }
    try {
      const { data, filename } = await downloadTelegramFile(
        ctx.api,
        fileObj.file_id,
      );
      const uploaded = await uploadMedia({
        data,
        filename,
        contentType: fileObj.mime_type,
      });
      const label = ctx.message.caption?.trim() || null;
      const id = mediaLibrary.save({
        postizId: uploaded.id,
        path: uploaded.path,
        kind,
        label,
        telegramFileId: fileObj.file_id,
      });
      logEvent("media_saved", { id, kind, label, path: uploaded.path });
      await ctx.reply(
        `Saved to the media library as #${id} (${kind}${label ? `: "${label}"` : ""}).\n${uploaded.path}\n\nIt's in Postiz and reusable for any post. /media to browse.`,
      );
    } catch (err) {
      const message = scrubSecrets(err.message);
      logEvent("media_upload_failed", { kind, error: message });
      const hint = /file is too big|download failed \(4/i.test(message)
        ? " (Telegram bots can only fetch files up to 20 MB — for bigger videos, upload directly in the Postiz dashboard.)"
        : "";
      await ctx.reply(`Couldn't save that: ${message}${hint}`);
    }
  }

  bot.on("message:photo", async (ctx) => {
    // Telegram sends multiple resolutions; the last entry is the original size.
    const sizes = ctx.message.photo;
    await saveIncomingMedia(ctx, "photo", sizes[sizes.length - 1]);
  });
  bot.on("message:video", (ctx) =>
    saveIncomingMedia(ctx, "video", ctx.message.video),
  );
  bot.on("message:video_note", (ctx) =>
    saveIncomingMedia(ctx, "video", ctx.message.video_note),
  );
  bot.on("message:animation", (ctx) =>
    saveIncomingMedia(ctx, "animation", ctx.message.animation),
  );
  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    const kind = doc.mime_type?.startsWith("video/")
      ? "video"
      : doc.mime_type?.startsWith("image/")
        ? "photo"
        : null;
    if (!kind) {
      await ctx.reply(
        "I only store images and videos in the media library. Send photos or video files.",
      );
      return;
    }
    await saveIncomingMedia(ctx, kind, doc);
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
    { command: "postiz", description: "Check the Postiz publishing connection" },
    { command: "media", description: "Browse the reusable media library" },
    { command: "pause", description: "Freeze all publishing instantly" },
    { command: "resume", description: "Unfreeze publishing" },
    { command: "amend", description: "Propose a Constitution change" },
  ]);
}
