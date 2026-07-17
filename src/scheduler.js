import { config } from "./config.js";
import { sql, jobs, outreach, metrics, kdp, settings, links, getOwnerId, isPaused, logEvent, scrubSecrets } from "./db.js";
import { callAgent } from "./agents/client.js";
import { runContentPipeline } from "./agents/pipeline.js";
import { sendApprovalCard } from "./telegram/approvals.js";
import { publishDue, describePublishResult } from "./publish.js";

const LAUNCH_DATE = "2026-08-11";
const MAX_DAILY_ASSIGNMENTS = 3;

function daysToLaunch() {
  return Math.ceil((new Date(LAUNCH_DATE) - Date.now()) / 86400000);
}

// --- Shared data gathering ---------------------------------------------------

async function weekActivity() {
  const published = await sql.all(
    "SELECT platform, vertical, substr(content, 1, 90) AS excerpt, quality_flag FROM drafts WHERE status = 'published' AND published_at >= datetime('now', '-7 days') ORDER BY published_at",
  );
  const rejected = await sql.all(
    "SELECT platform, vertical, rejection_reason, substr(content, 1, 90) AS excerpt FROM drafts WHERE status = 'rejected' AND updated_at >= datetime('now', '-7 days')",
  );
  const queued = (await sql.get("SELECT COUNT(*) AS n FROM drafts WHERE status = 'queued'")).n;
  return { published, rejected, queued };
}

async function systemContext() {
  const { published, rejected, queued } = await weekActivity();
  const lines = [
    `Today: ${new Date().toDateString()}. Days to launch: ${daysToLaunch()}.`,
    `Publishing: ${(await isPaused()) ? "PAUSED (drafting continues)" : "active"}${config.dryRun ? ", DRY RUN week" : ""}.`,
    `Approval queue depth: ${queued}.`,
    `Published last 7 days (${published.length}):`,
    ...published.map((p) => `  ${p.platform}/${p.vertical}: ${p.excerpt}${p.quality_flag ? " [was quality-flagged]" : ""}`),
    `Rejected last 7 days (${rejected.length}):`,
    ...rejected.map((r) => `  ${r.platform}/${r.vertical}: "${r.rejection_reason || "no reason"}" on: ${r.excerpt}`),
  ];
  const latestKdp = await kdp.latest();
  if (latestKdp) lines.push(`Latest KDP entry (raw): ${latestKdp.raw_text}`);
  const oc = await outreach.counts();
  if (oc.length > 0) {
    lines.push(`Outreach pipeline: ${oc.map((r) => `${r.status}=${r.n}`).join(", ")}`);
  }
  for (const v of ["book", "app"]) {
    const m = await metrics.recent(v, 6);
    if (m.length > 0) {
      lines.push(`Recent ${v} metrics: ${m.map((x) => `${x.metric}=${x.value}`).join(", ")}`);
    }
  }
  const linkEntries = Object.entries(await links.all());
  lines.push(
    linkEntries.length
      ? `Approved links: ${linkEntries.map(([k, v]) => `${k}=${v}`).join(", ")}`
      : "Approved links: none set yet (drafts carry the [AMAZON LINK] placeholder).",
  );
  const trends = await settings.get("trends_report");
  if (trends) {
    lines.push("", "Latest trends and virality research (from the Trends Agent):", trends);
  }
  const plan = await settings.get("weekly_plan");
  if (plan) lines.push("", "Current weekly plan:", plan);
  return lines.join("\n");
}

// --- Daily Chief of Staff run --------------------------------------------------

/** Parse "ASSIGN: platform | vertical | brief" lines from the CoS reply. */
export function parseAssignments(text, cap = MAX_DAILY_ASSIGNMENTS) {
  const out = [];
  for (const m of text.matchAll(/^ASSIGN:\s*([a-z]+)\s*\|\s*(book|app)\s*\|\s*(.+)$/gim)) {
    out.push({ platform: m[1].toLowerCase(), vertical: m[2].toLowerCase(), brief: m[3].trim() });
    if (out.length >= cap) break;
  }
  return out;
}

export async function runDaily(api, { call = callAgent } = {}) {
  const owner = await getOwnerId();
  if (!owner || !config.anthropicApiKey) return { skipped: true };

  const reply = await call("chief_of_staff", [
    {
      role: "user",
      content: [
        "Daily planning run. Decide today's content assignments within the Constitution's cadence (4 to 5 posts per week per platform pre-launch; check what already went out this week below).",
        "",
        await systemContext(),
        "",
        `Respond with at most ${MAX_DAILY_ASSIGNMENTS} assignment lines, each in exactly this format:`,
        "ASSIGN: platform | vertical | one-line brief for the Content Agent",
        "(platforms: linkedin, instagram, x. verticals: book, app.)",
        "If nothing should be drafted today, respond with the single line ASSIGN: NONE and one line explaining why.",
      ].join("\n"),
    },
  ]);

  const assignments = parseAssignments(reply);
  await logEvent("daily_run", { assignments: assignments.length });
  if (assignments.length === 0) {
    await api.sendMessage(owner, `Chief of Staff daily run: nothing to draft today.\n${reply.trim()}`);
  } else {
    await api.sendMessage(
      owner,
      `Chief of Staff daily run: ${assignments.length} draft${assignments.length === 1 ? "" : "s"} incoming as one bundle.`,
    );
    for (const a of assignments) {
      try {
        const draft = await runContentPipeline(a, { call });
        await sendApprovalCard(api, owner, draft);
      } catch (err) {
        console.error("Daily pipeline error:", err);
        await api.sendMessage(owner, `Pipeline failed for ${a.platform}/${a.vertical}: ${scrubSecrets(err.message)}`);
      }
    }
  }

  // Follow-ups run every day, whether or not content was assigned.
  await draftOutreachFollowUps(api, owner, call);
  return { assignments: assignments.length };
}

/**
 * Pitched targets quiet for 10+ days get one drafted follow-up, per the
 * Outreach Agent's charter (respectful interval, one follow-up maximum,
 * sending stays manual and approved by Cayden).
 */
async function draftOutreachFollowUps(api, owner, call) {
  const due = await sql.all(
    "SELECT * FROM outreach WHERE status = 'pitched' AND last_action_at <= datetime('now', '-10 days')",
  );
  for (const t of due) {
    try {
      const followUp = await call("outreach", [
        {
          role: "user",
          content: [
            `The pitch to "${t.target}" has had no reply for over 10 days. Draft the one respectful follow-up your charter allows: short, no guilt, no pressure, references the original pitch naturally.`,
            "",
            "Original pitch:",
            t.pitch || "(not recorded)",
            "",
            "Return only the follow-up email text, subject line first.",
          ].join("\n"),
        },
      ]);
      // One follow-up maximum: the status change takes it out of this query for good.
      await outreach.update(t.id, { status: "followed_up" });
      await logEvent("outreach_followup_drafted", { id: t.id });
      await api.sendMessage(
        owner,
        `Follow-up drafted for outreach target #${t.id} (${t.target}), quiet 10+ days. Sending stays manual; if they reply, /outreach mark ${t.id} replied.\n\n${followUp.trim()}`,
      );
    } catch (err) {
      console.error("Follow-up drafting error:", err);
    }
  }
}

// --- Weekly plan -----------------------------------------------------------------

export async function runWeeklyPlan(api, { call = callAgent } = {}) {
  const owner = await getOwnerId();
  if (!owner || !config.anthropicApiKey) return { skipped: true };

  const plan = await call("chief_of_staff", [
    {
      role: "user",
      content: [
        "Weekly planning session. Deliver the plan for the coming week per Article XI: the week's content themes per platform, the outreach slate (targets awaiting approval and next moves), and exactly one data-driven change based on last week, with the specific reason named.",
        "Where the Trends Agent's research below offers a real opening, fold it into the themes and say so; ignore any of it that doesn't serve the launch.",
        "",
        await systemContext(),
        "",
        "Write it as the Telegram message Cayden receives: short, direct, decision-ready, lead with anything that needs his attention. Plain text, internal lists permitted.",
      ].join("\n"),
    },
  ], { maxTokens: 2048 });

  await settings.set("weekly_plan", plan.trim());
  await settings.set("weekly_plan_date", new Date().toISOString());
  await logEvent("weekly_plan", {});
  await api.sendMessage(owner, plan.trim());
  return { sent: true };
}

// --- Weekly analytics report --------------------------------------------------------

export async function runWeeklyReport(api, { call = callAgent } = {}) {
  const owner = await getOwnerId();
  if (!owner || !config.anthropicApiKey) return { skipped: true };

  const context = await systemContext();
  const halves = [];
  for (const [agentKey, vertical] of [["book_growth", "book"], ["app_growth", "app"]]) {
    halves.push(
      await call(agentKey, [
        {
          role: "user",
          content: [
            `Produce your ${vertical} half of the weekly report per your charter: what happened, why as best the data shows, what to change, with the reason named. State uncertainty plainly when the data is thin; never estimate without labeling it.`,
            "",
            context,
            "",
            "Under 10 lines, plain text.",
          ].join("\n"),
        },
      ]),
    );
  }

  const report = await call("chief_of_staff", [
    {
      role: "user",
      content: [
        "Assemble the weekly two-vertical analytics report for Cayden per Article XI. The specialist halves follow; do not inflate or soften them.",
        "",
        "BOOK GROWTH HALF:",
        halves[0],
        "",
        "APP GROWTH HALF:",
        halves[1],
        "",
        "Deliver the report as the Telegram message Cayden receives: both verticals clearly separated, truth first, recommendations with the reason named. Plain text.",
      ].join("\n"),
    },
  ], { maxTokens: 2048 });

  await logEvent("weekly_report", {});
  await api.sendMessage(owner, report.trim());
  return { sent: true };
}

// --- Weekly trends and virality research -----------------------------------------

export async function runTrendsResearch(api, { call = callAgent } = {}) {
  const owner = await getOwnerId();
  if (!owner || !config.anthropicApiKey) return { skipped: true };

  const report = await call(
    "trends",
    [
      {
        role: "user",
        content: [
          `Weekly research sweep, ${new Date().toDateString()}. Days to launch: ${daysToLaunch()}.`,
          "Use web search to research what is trending RIGHT NOW: (1) in the leadership / faith-and-work / young-professional / author space, (2) across social media broadly, and (3) which formats and hooks are currently earning reach on LinkedIn, Instagram, and X.",
          "Then deliver your weekly report in your charter's exact format (LEADERSHIP SPACE / BROADER ATTENTION / ANGLES / AVOID).",
          "Keep it under 40 lines. Every ANGLES entry must name the platform, the Story Bank material it draws on, and why it should work now.",
        ].join("\n"),
      },
    ],
    { webSearch: true, maxTokens: 8192 },
  );

  await settings.set("trends_report", report.trim());
  await settings.set("trends_report_date", new Date().toISOString());
  await logEvent("trends_research", {});
  await api.sendMessage(owner, `Trends Agent weekly research:\n\n${report.trim()}`);
  return { sent: true };
}

/** Publish any scheduled drafts whose slot has arrived; tell Cayden per post. */
export async function runDueCheck(api, deps = {}) {
  const owner = await getOwnerId();
  if (!owner) return { skipped: true };
  const results = await publishDue({ api, ...deps });
  for (const { draft, result } of results) {
    if (result.published || result.reason === "error") {
      await api.sendMessage(owner, describePublishResult(draft, result));
    }
    // 'paused' stays silent: /pause already told him, and /resume reports.
  }
  return { published: results.filter((r) => r.result.published).length };
}

// --- Wiring ------------------------------------------------------------------------

export function registerM4(bot, { requireApiKey }) {
  bot.command("plan", async (ctx) => {
    const offline = requireApiKey();
    if (offline) return ctx.reply(offline);
    const arg = (ctx.match || "").trim().toLowerCase();
    const stored = await settings.get("weekly_plan");
    const storedAt = await settings.get("weekly_plan_date");
    const fresh = storedAt && Date.now() - new Date(storedAt).getTime() < 7 * 86400000;
    if (stored && fresh && arg !== "new") {
      return ctx.reply(`${stored}\n\n(From this week's session. /plan new regenerates.)`);
    }
    await jobs.enqueue("plan", { chatId: ctx.chat.id });
    await ctx.reply("Running the weekly planning session; the plan lands here in a minute or two.");
  });

  bot.command("report", async (ctx) => {
    const offline = requireApiKey();
    if (offline) return ctx.reply(offline);
    await jobs.enqueue("report", { chatId: ctx.chat.id });
    await ctx.reply("Assembling the two-vertical report; it lands here in a minute or two.");
  });

  bot.command("trends", async (ctx) => {
    const offline = requireApiKey();
    if (offline) return ctx.reply(offline);
    const arg = (ctx.match || "").trim().toLowerCase();
    const stored = await settings.get("trends_report");
    const storedAt = await settings.get("trends_report_date");
    const fresh = storedAt && Date.now() - new Date(storedAt).getTime() < 7 * 86400000;
    if (stored && fresh && arg !== "new") {
      return ctx.reply(`${stored}\n\n(From this week's sweep. /trends new re-researches.)`);
    }
    await jobs.enqueue("trends", { chatId: ctx.chat.id });
    await ctx.reply("Trends Agent is researching (web search); the report lands here in a minute or two.");
  });
}

// --- Tick dispatch -------------------------------------------------------------
// The runtime fires runScheduledTick every ~5 minutes (a Cloudflare Cron
// Trigger, or setInterval on Node). Cron Triggers run in UTC, so each job
// fires when its local wall-clock time (config.timezone) has been reached
// and it hasn't run yet that day — which also self-heals DST shifts and
// makes missed ticks run late instead of never.

const SCHEDULED_JOBS = [
  // Monday order matters: trends feeds the plan, the plan frames the daily run.
  { name: "trends", marker: "last_trends_run", dow: 1, hour: 7, minute: 30, run: runTrendsResearch },
  { name: "weekly_plan", marker: "last_weekly_plan_run", dow: 1, hour: 8, minute: 0, run: runWeeklyPlan },
  { name: "daily", marker: "last_daily_run", dow: null, hour: 9, minute: 0, run: runDaily },
  { name: "weekly_report", marker: "last_weekly_report_run", dow: 0, hour: 18, minute: 0, run: runWeeklyReport },
];

/** Local wall-clock parts for a timezone: date string, dow, hour, minute. */
export function localClock(now = new Date(), tz = config.timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    weekday: "short",
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
  };
}

export async function runScheduledTick(api, { now = new Date(), deps = {} } = {}) {
  if (!config.schedulersEnabled) return { skipped: "disabled" };
  const clock = localClock(now);
  const ran = [];

  for (const job of SCHEDULED_JOBS) {
    if (job.dow !== null && clock.dow !== job.dow) continue;
    if (clock.hour < job.hour || (clock.hour === job.hour && clock.minute < job.minute)) continue;
    if ((await settings.get(job.marker)) === clock.date) continue;
    // Mark before running: a crashed run must not retry every 5 minutes and
    // hammer the API; the error lands in the events table instead.
    await settings.set(job.marker, clock.date);
    try {
      const r = await job.run(api, deps);
      if (r?.skipped) console.log(`Scheduler ${job.name}: skipped (no owner or no API key).`);
      ran.push(job.name);
    } catch (err) {
      console.error(`Scheduler ${job.name} failed:`, err);
      await logEvent("scheduler_error", { name: job.name, message: String(err?.message ?? err) });
    }
  }

  // Due-check runs every tick so scheduled posts fire within ~5 minutes.
  try {
    await runDueCheck(api, deps);
  } catch (err) {
    console.error("Scheduler due_check failed:", err);
    await logEvent("scheduler_error", { name: "due_check", message: String(err?.message ?? err) });
  }

  return { ran };
}

/** Node entry point: emulate the Workers cron with a 5-minute interval. */
export function startSchedulers(bot) {
  if (!config.schedulersEnabled) {
    console.log("Schedulers disabled (ENABLE_SCHEDULERS=false).");
    return { stop() {} };
  }
  const timer = setInterval(() => {
    runScheduledTick(bot.api).catch((err) => console.error("Scheduled tick failed:", err));
  }, 5 * 60 * 1000);
  console.log(
    `Schedulers armed (${config.timezone}): trends Mon 07:30, weekly plan Mon 08:00, daily CoS run 09:00, weekly report Sun 18:00, due-check every 5 min.`,
  );
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
