import { InlineKeyboard } from "grammy";
import { config } from "../config.js";
import { sql, jobs, outreach, metrics, kdp, settings, links, logEvent, scrubSecrets } from "../db.js";
import { callAgent } from "../agents/client.js";
import { parseFields } from "../agents/pipeline.js";
import { loadConstitution, saveConstitution, formatAmendment } from "../prompts.js";
import { sendApprovalCard } from "./approvals.js";

export const PLATFORMS = new Set(["linkedin", "instagram", "x", "email"]);
export const VERTICALS = new Set(["book", "app"]);

/**
 * Pull optional leading platform/vertical tokens off a command's arguments.
 * "/draft x app the waitlist angle" -> { platform: "x", vertical: "app", rest: "the waitlist angle" }
 */
export function parseTargeting(args, { platform = "linkedin", vertical = "book" } = {}) {
  const words = args.split(/\s+/);
  while (words.length > 1) {
    const w = words[0].toLowerCase();
    if (PLATFORMS.has(w)) platform = w;
    else if (VERTICALS.has(w)) vertical = w;
    else break;
    words.shift();
  }
  return { platform, vertical, rest: words.join(" ") };
}

/**
 * Queue a pipeline pass. Agent pipelines run minutes, which no webhook
 * invocation should carry; the job queue runs them right after the update
 * is acknowledged (and the cron tick mops up anything left behind).
 */
async function firePipeline(chatId, job) {
  await jobs.enqueue("pipeline", { chatId, ...job });
}

const OUTREACH_STATUS_ORDER = [
  "researched",
  "awaiting_approval",
  "approved",
  "pitched",
  "followed_up",
  "replied",
  "scheduled",
  "aired",
  "declined",
];

function outreachCard(row) {
  return [
    `Outreach target #${row.id}: ${row.target}`,
    "",
    `Brief: ${row.brief || "(none)"}`,
    "",
    "Pitch:",
    row.pitch || "(none)",
    "",
    "Approve covers both the target and this exact pitch. Sending stays manual until email automation lands; approving means the pitch is cleared for you to send.",
  ].join("\n");
}

function outreachKeyboard(id) {
  return new InlineKeyboard()
    .text("✅ Approve", `oapprove:${id}`)
    .text("❌ Pass", `oreject:${id}`);
}

async function verticalSnapshot(ctx, vertical) {
  const agentKey = vertical === "book" ? "book_growth" : "app_growth";
  const recent = await metrics.recent(vertical, 12);
  const publishedWeek = (await sql.get(
    "SELECT COUNT(*) AS n FROM drafts WHERE vertical = ? AND status = 'published' AND published_at >= datetime('now', '-7 days')",
    vertical,
  )).n;
  const queued = (await sql.get(
    "SELECT COUNT(*) AS n FROM drafts WHERE vertical = ? AND status = 'queued'",
    vertical,
  )).n;
  const latestKdp = vertical === "book" ? await kdp.latest() : null;

  if (recent.length === 0 && !latestKdp && publishedWeek === 0 && queued === 0) {
    await ctx.reply(
      vertical === "book"
        ? "No book data logged yet. Log your KDP figures with /kdp; click and review data joins once tracking links and posts are live."
        : "No Foreman data logged yet. Waitlist and signup numbers get logged here once you report them; app posts show up as they move through the queue.",
    );
    return;
  }

  const dataLines = [
    `Published posts, last 7 days: ${publishedWeek}`,
    `Drafts in the approval queue: ${queued}`,
  ];
  if (latestKdp) {
    dataLines.push(
      `Latest KDP entry (week of ${latestKdp.week_of}, raw as Cayden typed it): ${latestKdp.raw_text}`,
    );
  }
  if (recent.length > 0) {
    dataLines.push("Recent logged metrics (newest first):");
    for (const m of recent) {
      dataLines.push(`  ${m.recorded_at} ${m.metric} = ${m.value}${m.note ? ` (${m.note})` : ""}`);
    }
  }

  const reply = await callAgent(agentKey, [
    {
      role: "user",
      content: [
        `Cayden asked for the /${vertical === "book" ? "book" : "app"} snapshot on Telegram.`,
        "Everything the system currently has:",
        ...dataLines,
        "",
        "Reply with the snapshot in under 8 short lines of plain text (this is an internal report, lists are permitted).",
        "Truth first: state what the data shows and what is missing. Do not invent or estimate numbers.",
        "End with one specific recommendation and the reason behind it.",
      ].join("\n"),
    },
  ]);
  await ctx.reply(reply);
}

/**
 * Register everything M3: /book /app /kdp /idea /outreach /amend /reply,
 * the amendment confirm flow, outreach approval buttons, and photo/video
 * asset drops. Must run before the generic message handlers in bot.js.
 */
export function registerM3(bot, { requireApiKey }) {
  // --- /book and /app: vertical snapshots -----------------------------------
  for (const [cmd, vertical] of [["book", "book"], ["app", "app"]]) {
    bot.command(cmd, async (ctx) => {
      const offline = requireApiKey();
      if (offline) return ctx.reply(offline);
      try {
        await verticalSnapshot(ctx, vertical);
      } catch (err) {
        console.error(`/${cmd} error:`, err);
        await ctx.reply(`Snapshot failed: ${scrubSecrets(err.message)}`);
      }
    });
  }

  // --- /kdp: log weekly figures ----------------------------------------------
  bot.command("kdp", async (ctx) => {
    const raw = (ctx.match || "").trim();
    if (!raw) {
      return ctx.reply(
        "Usage: /kdp <this week's figures, as you'd say them>\n" +
          "Example: /kdp 42 ebooks, 13 paperbacks, 3 new reviews, 11 total",
      );
    }
    const id = await kdp.insert(raw);
    await logEvent("kdp_logged", { id });

    let extra = "";
    if (config.anthropicApiKey) {
      try {
        const out = await callAgent("book_growth", [
          {
            role: "user",
            content:
              `Cayden logged this week's KDP figures via /kdp, raw: "${raw}".\n` +
              "Extract each figure on its own line in exactly this format: METRIC: name = value\n" +
              "After the metrics, exactly one line: READ: your one-sentence honest read of the week.",
          },
        ]);
        const found = [...out.matchAll(/^METRIC:\s*(.+?)\s*=\s*(.+)$/gim)];
        for (const m of found) {
          await metrics.insert({ vertical: "book", metric: m[1].trim(), value: m[2].trim(), note: "kdp" });
        }
        const read = out.match(/^READ:\s*(.+)$/im)?.[1];
        extra = `\nLogged ${found.length} metric(s).${read ? "\n" + read : ""}`;
      } catch (err) {
        extra = `\nStored the raw entry; metric extraction failed (${scrubSecrets(err.message)}).`;
      }
    }
    await ctx.reply(`KDP figures logged.${extra}`);
  });

  // --- /idea: route a thought through the Chief of Staff ----------------------
  bot.command("idea", async (ctx) => {
    const text = (ctx.match || "").trim();
    if (!text) return ctx.reply("Usage: /idea <the thought>");
    await logEvent("idea", { text });
    const offline = requireApiKey();
    if (offline) return ctx.reply(`Idea logged. ${offline}`);
    try {
      const reply = await callAgent("chief_of_staff", [
        {
          role: "user",
          content:
            `Cayden sent this idea via /idea: "${text}".\n` +
            "Route it per your charter: which specialist it goes to and what will happen with it. " +
            "Confirm back to him in one or two lines. If it should become a post now, include the exact /draft command he can run.",
        },
      ]);
      await ctx.reply(reply);
    } catch (err) {
      await ctx.reply(`Idea logged, but the Chief of Staff call failed: ${scrubSecrets(err.message)}`);
    }
  });

  // --- /outreach: pipeline status, add targets, mark sent ---------------------
  bot.command("outreach", async (ctx) => {
    const args = (ctx.match || "").trim();

    if (/^add\s+/i.test(args)) {
      const target = args.replace(/^add\s+/i, "").trim();
      const offline = requireApiKey();
      if (offline) return ctx.reply(offline);
      await ctx.reply(`Outreach Agent is preparing a brief and pitch for: ${target}`);
      try {
        const out = await callAgent("outreach", [
          {
            role: "user",
            content: [
              `Cayden wants this target added to the podcast pipeline: "${target}".`,
              "You have no web access. Work only from what he gave you plus general knowledge, and never state a fact about the show you cannot verify. Where a detail must be checked before sending (host name, a recent episode reference), write it in brackets like [VERIFY: ...].",
              "Respond in exactly this format, nothing before or after:",
              "BRIEF: one paragraph: who they are, why Cayden fits their audience specifically, and the proposed angle",
              "PITCH:",
              "the pitch email, subject line first, short and specific, written for this one show",
            ].join("\n"),
          },
        ]);
        const f = parseFields(out);
        const id = await outreach.insert({
          target,
          brief: f.brief || out,
          pitch: f.pitch || "",
          status: "awaiting_approval",
        });
        await logEvent("outreach_target_added", { id, target });
        const row = await outreach.get(id);
        await ctx.reply(outreachCard(row), { reply_markup: outreachKeyboard(id) });
      } catch (err) {
        await ctx.reply(`Outreach Agent call failed: ${scrubSecrets(err.message)}`);
      }
      return;
    }

    const sent = args.match(/^sent\s+(\d+)$/i);
    if (sent) {
      const id = Number(sent[1]);
      const row = await outreach.get(id);
      if (!row) return ctx.reply(`No outreach target #${id}.`);
      if (row.status !== "approved") {
        return ctx.reply(`Target #${id} is '${row.status}', not 'approved'; only approved pitches get marked sent.`);
      }
      await outreach.update(id, { status: "pitched" });
      await logEvent("outreach_pitched", { id });
      return ctx.reply(`Target #${id} marked pitched. If it stays quiet 10+ days, the daily run drafts the one allowed follow-up.`);
    }

    const mark = args.match(/^mark\s+(\d+)\s+(replied|scheduled|aired|declined)$/i);
    if (mark) {
      const id = Number(mark[1]);
      const status = mark[2].toLowerCase();
      const row = await outreach.get(id);
      if (!row) return ctx.reply(`No outreach target #${id}.`);
      await outreach.update(id, { status });
      await logEvent("outreach_marked", { id, status });
      return ctx.reply(`Target #${id} (${row.target}) marked ${status}.`);
    }

    // Status view.
    const counts = Object.fromEntries((await outreach.counts()).map((r) => [r.status, r.n]));
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total === 0) {
      return ctx.reply(
        "The outreach pipeline is empty.\n" +
          "Add a target: /outreach add <show name and why it fits>\n" +
          "Mark an approved pitch sent: /outreach sent <id>\n" +
          "Update a target: /outreach mark <id> replied|scheduled|aired|declined",
      );
    }
    const lines = ["Outreach pipeline:"];
    for (const s of OUTREACH_STATUS_ORDER) {
      if (counts[s]) lines.push(`  ${s.replace("_", " ")}: ${counts[s]}`);
    }
    await ctx.reply(lines.join("\n"));
    for (const row of await outreach.listByStatus("awaiting_approval")) {
      await ctx.reply(outreachCard(row), { reply_markup: outreachKeyboard(row.id) });
    }
  });

  bot.callbackQuery(/^oapprove:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const row = await outreach.get(id);
    if (!row || row.status !== "awaiting_approval") {
      return ctx.answerCallbackQuery({ text: "Already handled." });
    }
    await outreach.update(id, { status: "approved" });
    await logEvent("outreach_approved", { id });
    await ctx.answerCallbackQuery({ text: "Approved." });
    await ctx.editMessageReplyMarkup();
    await ctx.reply(
      `Target #${id} approved. Copy the pitch above and send it; then run /outreach sent ${id} so the pipeline tracks it.`,
    );
  });

  bot.callbackQuery(/^oreject:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const row = await outreach.get(id);
    if (!row || row.status !== "awaiting_approval") {
      return ctx.answerCallbackQuery({ text: "Already handled." });
    }
    await outreach.update(id, { status: "declined" });
    await logEvent("outreach_declined", { id });
    await ctx.answerCallbackQuery({ text: "Passed." });
    await ctx.editMessageReplyMarkup();
    await ctx.reply(`Target #${id} declined and off the list.`);
  });

  // --- /amend: propose, Critique restates, confirm to ratify ------------------
  bot.command("amend", async (ctx) => {
    const text = (ctx.match || "").trim();
    if (!text) return ctx.reply("Usage: /amend <the change you want in the Constitution>");
    const offline = requireApiKey();
    if (offline) return ctx.reply(offline);
    try {
      const restated = (
        await callAgent("critique", [
          {
            role: "user",
            content:
              `Cayden proposes this Constitution amendment via /amend: "${text}".\n` +
              "Restate it as formal constitution text: plain, direct, unambiguous, in the document's register, no em dashes. " +
              "Return only the restated amendment text, nothing else.",
          },
        ])
      ).trim();
      await settings.set("pending_amendment", restated);
      await ctx.reply(
        `The Critique Agent restates your amendment as:\n\n${restated}\n\nRatify it?`,
        {
          reply_markup: new InlineKeyboard()
            .text("✅ Ratify", "amend:confirm")
            .text("❌ Cancel", "amend:cancel"),
        },
      );
    } catch (err) {
      await ctx.reply(`Critique Agent call failed: ${scrubSecrets(err.message)}`);
    }
  });

  bot.callbackQuery("amend:confirm", async (ctx) => {
    const text = await settings.get("pending_amendment", "");
    if (!text) return ctx.answerCallbackQuery({ text: "Nothing pending." });
    await settings.set("pending_amendment", "");
    const date = new Date().toISOString().slice(0, 10);
    await saveConstitution(formatAmendment(await loadConstitution(), text, date));
    await logEvent("constitution_amended", { text });
    await ctx.answerCallbackQuery({ text: "Ratified." });
    await ctx.editMessageReplyMarkup();
    await ctx.reply(
      "Amendment ratified and written into the Constitution. It binds every agent from their next call.",
    );
  });

  bot.callbackQuery("amend:cancel", async (ctx) => {
    await settings.set("pending_amendment", "");
    await ctx.answerCallbackQuery({ text: "Cancelled." });
    await ctx.editMessageReplyMarkup();
    await ctx.reply("Amendment dropped. The Constitution is unchanged.");
  });

  // --- /links: approved links the agents may use --------------------------------
  bot.command("links", async (ctx) => {
    const args = (ctx.match || "").trim();

    if (!args) {
      const all = Object.entries(await links.all());
      const lines = all.length
        ? ["Approved links (agents use these exact URLs):", ...all.map(([k, v]) => `  ${k}: ${v}`)]
        : ["No links set yet. Agents use the placeholder [AMAZON LINK] until you add the real one."];
      lines.push(
        "",
        "Set one: /links <name> <url>",
        "Remove one: /links remove <name>",
        "Recognized names: amazon (the purchase link), amazon_linkedin / amazon_instagram / amazon_x (tracked short links per platform), email_list, waitlist. Any other name works too.",
      );
      return ctx.reply(lines.join("\n"));
    }

    const rm = args.match(/^remove\s+(\S+)$/i);
    if (rm) {
      const name = rm[1].toLowerCase();
      if (!(await links.all())[name]) return ctx.reply(`No link named "${name}".`);
      await links.remove(name);
      await logEvent("link_removed", { name });
      return ctx.reply(`Link "${name}" removed.`);
    }

    const m = args.match(/^(\S+)\s+(https?:\/\/\S+)$/i);
    if (!m) {
      return ctx.reply("Usage: /links <name> <url>  (the url must start with http). Bare /links lists everything.");
    }
    const name = m[1].toLowerCase();
    await links.set(name, m[2]);
    await logEvent("link_set", { name });
    return ctx.reply(
      `Link "${name}" saved. Every agent sees it from the next draft on; the Critique Agent rejects drafts that use any URL not on this list.`,
    );
  });

  // --- /reply: Engagement Agent drafts a comment reply through the queue ------
  bot.command("reply", async (ctx) => {
    const comment = (ctx.match || "").trim();
    if (!comment) {
      return ctx.reply(
        "Usage: /reply <paste the comment>\nThe Engagement Agent drafts Cayden's reply and it comes back through the approval queue.",
      );
    }
    const offline = requireApiKey();
    if (offline) return ctx.reply(offline);
    await ctx.reply("Engagement Agent is drafting a reply...");
    await firePipeline(ctx.chat.id, {
      specialist: "engagement",
      vertical: "book",
      platform: "reply",
      assignment: [
        "A comment arrived on one of Cayden's posts, forwarded through the Chief of Staff:",
        `"${comment}"`,
        "",
        "Draft Cayden's reply per your charter: warm, brief, specific to what the person said, never generic. If the comment is political or hostile, say so instead of drafting (the system exits those silently).",
        "Return only the reply text, nothing else.",
      ].join("\n"),
    });
  });

  // --- Asset drops: photo or video with a caption ------------------------------
  bot.on(["message:photo", "message:video"], async (ctx) => {
    const offline = requireApiKey();
    if (offline) return ctx.reply(offline);
    const caption = (ctx.message.caption || "").trim();
    if (!caption) {
      return ctx.reply(
        "Asset received, but I need context. Send it again with a caption: what it is and what you want it to become.",
      );
    }
    const isPhoto = Boolean(ctx.message.photo);
    const fileId = isPhoto
      ? ctx.message.photo.at(-1).file_id
      : ctx.message.video.file_id;

    const lower = caption.toLowerCase();
    const platform =
      ["linkedin", "instagram", "x"].find((p) => lower.includes(p)) || "instagram";
    const vertical = /foreman|\bapp\b/.test(lower) ? "app" : "book";

    await ctx.reply(
      `Asset received (${isPhoto ? "photo" : "video"}). Content Agent is building a ${platform} ${vertical} post around it...`,
    );
    await firePipeline(ctx.chat.id, {
      specialist: "content",
      vertical,
      platform,
      mediaFileId: fileId,
      asset: { caption, isPhoto },
    });
  });
}
