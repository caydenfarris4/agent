import { jobs, drafts, logEvent, scrubSecrets } from "./db.js";
import { runSpecialistPipeline, reviseDraft } from "./agents/pipeline.js";
import { sendApprovalCard } from "./telegram/approvals.js";
import { runWeeklyPlan, runWeeklyReport, runTrendsResearch } from "./scheduler.js";
import { downloadTelegramFile } from "./telegram/files.js";

/**
 * Background job execution. Webhook handlers enqueue anything that takes
 * minutes (agent pipelines, reports, trends research) and the runtime drains
 * the queue outside the request: right after each update via waitUntil, and
 * every cron tick as the mop-up for anything a died invocation left behind.
 */

/** Build the asset-drop assignment; the photo is fetched at execution time. */
async function assetAssignment(api, payload) {
  const { caption, isPhoto } = payload.asset;
  let imageBase64 = null;
  if (isPhoto) {
    try {
      // 4MB guard: Claude's per-image request limit, well above Telegram photos.
      const { buffer } = await downloadTelegramFile(api, payload.mediaFileId, {
        maxBytes: 4 * 1024 * 1024,
      });
      imageBase64 = buffer.toString("base64");
    } catch (err) {
      console.error("Photo download failed:", err);
    }
  }
  const assignment = imageBase64
    ? [
        `Cayden uploaded the attached photo with this caption: "${caption}".`,
        `Build the ${payload.platform} post around this exact asset per your charter. The photo is attached; write to what is actually in it.`,
        "Return only the post copy, exactly as it should be published.",
      ].join("\n")
    : [
        `Cayden uploaded a ${isPhoto ? "photo" : "video"} with this caption: "${caption}".`,
        `You have NOT been shown the ${isPhoto ? "image" : "footage"}. Write the hook and ${payload.platform} caption strictly from his description; do not describe visuals he has not described.`,
        isPhoto ? "" : "If a cut list or on-screen text would help, suggest them from the caption only, clearly marked as suggestions.",
        "Return only the post copy, exactly as it should be published.",
      ].filter(Boolean).join("\n");
  return { assignment, imageBase64 };
}

async function runOne(api, job, deps = {}) {
  const callOpt = deps.call ? { call: deps.call } : {};
  const p = job.payload;
  switch (job.type) {
    case "pipeline": {
      let assignment = p.assignment;
      let imageBase64 = null;
      if (p.asset) {
        ({ assignment, imageBase64 } = await assetAssignment(api, p));
      }
      const draft = await runSpecialistPipeline(
        {
          specialist: p.specialist,
          vertical: p.vertical,
          platform: p.platform,
          mediaFileId: p.mediaFileId,
          imageBase64,
          assignment,
        },
        {
          ...callOpt,
          onProgress: (line) => api.sendMessage(p.chatId, line).then(() => {}, () => {}),
        },
      );
      await sendApprovalCard(api, p.chatId, draft);
      return;
    }
    case "revise": {
      const draft = await drafts.get(p.draftId);
      if (!draft || draft.status !== "queued") {
        await api.sendMessage(p.chatId, `Draft #${p.draftId} is no longer in the queue; nothing revised.`);
        return;
      }
      try {
        const revised = await reviseDraft(draft, p.instruction, callOpt);
        await drafts.update(p.draftId, { content: revised });
        await logEvent("draft_edited", { draft_id: p.draftId, mode: "instruction" });
        await sendApprovalCard(api, p.chatId, await drafts.get(p.draftId));
      } catch (err) {
        await api.sendMessage(
          p.chatId,
          `Revision failed: ${scrubSecrets(err.message)}. Draft #${p.draftId} is unchanged.`,
        );
      }
      return;
    }
    case "plan":
      await runWeeklyPlan(api, callOpt);
      return;
    case "report":
      await runWeeklyReport(api, callOpt);
      return;
    case "trends":
      await runTrendsResearch(api, callOpt);
      return;
    default:
      throw new Error(`Unknown job type: ${job.type}`);
  }
}

export async function processJobs(api, { max = 5, deps = {} } = {}) {
  await jobs.failStale();
  let processed = 0;
  for (; processed < max; processed++) {
    const job = await jobs.claim();
    if (!job) break;
    try {
      await runOne(api, job, deps);
      await jobs.finish(job.id);
    } catch (err) {
      const message = scrubSecrets(String(err?.message ?? err));
      console.error(`Job #${job.id} (${job.type}) failed:`, err);
      await jobs.finish(job.id, message);
      await logEvent("job_error", { id: job.id, type: job.type, message });
      const chatId = job.payload?.chatId;
      if (chatId) {
        await api
          .sendMessage(chatId, `${job.type === "pipeline" ? "Pipeline" : "Job"} failed: ${message}`)
          .catch(() => {});
      }
    }
  }
  return processed;
}
