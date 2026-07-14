import { callAgent } from "./client.js";
import { drafts, links, logEvent } from "../db.js";

// One extra specialist pass after a FIX verdict; a second FIX escalates to
// Cayden instead of looping (build guide: FIX loops back once with the
// violation attached, disagreements end up in front of Cayden).
const MAX_FIX_ROUNDS = 1;

const SPECIALIST_NAMES = {
  content: "Content Agent",
  engagement: "Engagement Agent",
  outreach: "Outreach Agent",
  book_growth: "Book Growth Agent",
  app_growth: "App Growth Agent",
};

/**
 * Parse "FIELD: value" blocks out of an agent reply. A field's value runs
 * until the next all-caps field label or end of text, so multi-line values
 * (NOTES, DRAFT) survive. Code fences are stripped first.
 */
export function parseFields(text) {
  const clean = text.replace(/```[a-z]*\n?/g, "").trim();
  const out = {};
  let current = null;
  for (const line of clean.split("\n")) {
    const m = line.match(/^([A-Z][A-Z_]{2,}):\s*(.*)$/);
    if (m) {
      current = m[1].toLowerCase();
      out[current] = m[2];
    } else if (current !== null) {
      out[current] += "\n" + line;
    }
  }
  for (const k of Object.keys(out)) out[k] = out[k].trim();
  return out;
}

/**
 * The approved-links block appended to every specialist assignment and shown
 * to the Critique Agent, so real URLs land in drafts and invented ones fail
 * the audit.
 */
export function linksBlock(platform) {
  const all = links.all();
  const entries = Object.entries(all);
  if (entries.length === 0) {
    return [
      "",
      "No approved links are configured yet. If the piece needs the Amazon link (or any URL), write the placeholder [AMAZON LINK] instead of inventing one, and Cayden will be nudged to set /links.",
    ].join("\n");
  }
  return [
    "",
    "Approved links. Use these exact URLs; never invent, alter, or shorten them:",
    ...entries.map(([k, v]) => `  ${k}: ${v}`),
    platform && (all[`amazon_${platform}`] || all.amazon)
      ? `For book content on ${platform}, the Amazon destination is: ${all[`amazon_${platform}`] || all.amazon}`
      : "",
    "Place any link in the post copy itself. Publishing is automated and posts exactly what you write; it cannot add a first comment, so 'link in the first comment' is not available.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function contentBrief({ brief, vertical, platform }) {
  return [
    "Brief from the Chief of Staff.",
    `Vertical: ${vertical}`,
    `Platform: ${platform}`,
    `Objective: ${brief}`,
    "",
    "Write the post now. Return only the post copy, exactly as it should be published. No preamble, no commentary, no alternatives.",
  ].join("\n");
}

/** Wrap message text with the job's image (asset drops) when present. */
function withImage(job, text) {
  if (!job.imageBase64) return text;
  return [
    { type: "text", text },
    {
      type: "image",
      source: {
        type: "base64",
        media_type: job.imageMediaType || "image/jpeg",
        data: job.imageBase64,
      },
    },
  ];
}

async function specialistDraft(call, job) {
  const text = await call(job.specialist, [
    { role: "user", content: withImage(job, job.assignment) },
  ]);
  return text.trim();
}

async function specialistRedraft(call, job, draftText, violation) {
  const message = [
    job.assignment,
    "",
    "Your previous draft was returned with this violation:",
    violation,
    "",
    "Previous draft:",
    draftText,
    "",
    "Rewrite it to fix the violation while keeping what worked. Return only the revised copy.",
  ].join("\n");
  const text = await call(job.specialist, [
    { role: "user", content: withImage(job, message) },
  ]);
  return text.trim();
}

async function chiefReview(call, job, draftText) {
  const name = SPECIALIST_NAMES[job.specialist] || job.specialist;
  const message = [
    `The ${name} submitted this draft for your review before it goes to the Critique Agent.`,
    `Vertical: ${job.vertical}`,
    `Platform: ${job.platform}`,
    job.mediaFileId
      ? "The draft is built around an asset Cayden uploaded; you are seeing the copy only."
      : null,
    "",
    "Assignment given to the specialist:",
    job.assignment,
    "",
    "DRAFT:",
    draftText,
    "",
    "Review it for strategy, voice, and fit. Light edits are yours to make. Respond in exactly this format, nothing before or after:",
    "DECISION: SEND or RETURN",
    "RATIONALE: one line for Cayden's approval card, naming the specific reason this earns a slot",
    "NOTES: only if RETURN, what the specialist must fix",
    "DRAFT:",
    "the final draft text (your edited version if you made edits, otherwise the draft unchanged)",
  ]
    .filter((l) => l !== null)
    .join("\n");
  const text = await call("chief_of_staff", [{ role: "user", content: message }]);
  const fields = parseFields(text);
  const decision = /return/i.test(fields.decision || "") ? "RETURN" : "SEND";
  return {
    decision,
    rationale: fields.rationale || "Fits the weekly plan.",
    notes: fields.notes || "",
    draft: fields.draft || draftText,
  };
}

async function critiqueAudit(call, job, draftText, rationale) {
  const message = [
    "Audit this draft against your checklist before it reaches Cayden's approval queue.",
    `Vertical: ${job.vertical}`,
    `Platform: ${job.platform}`,
    `Chief of Staff rationale: ${rationale}`,
    "",
    "DRAFT:",
    draftText,
    linksBlock(job.platform),
    "",
    "Respond in exactly this format, nothing before or after:",
    "VERDICT: PASS or FIX or ESCALATE",
    "QUALITY_FLAG: YES or NO (YES means compliant but flagged for quality)",
    "NOTES: the specific violation with the offending line quoted, or the one-line quality note, or NONE",
    "POSITION: only if ESCALATE, your position in two sentences",
  ].join("\n");
  const text = await call("critique", [{ role: "user", content: message }]);
  const fields = parseFields(text);
  let verdict = (fields.verdict || "").toUpperCase();
  if (!["PASS", "FIX", "ESCALATE"].includes(verdict)) {
    // Tolerant fallback: take the first verdict word found anywhere.
    const m = text.match(/\b(PASS|FIX|ESCALATE)\b/);
    verdict = m ? m[1] : "ESCALATE";
  }
  return {
    verdict,
    qualityFlag: /^y/i.test(fields.quality_flag || ""),
    notes: fields.notes && fields.notes !== "NONE" ? fields.notes : "",
    position: fields.position || "",
  };
}

async function chiefEscalationPosition(call, job, draftText, critiquePosition) {
  const message = [
    "The Critique Agent wants to escalate this draft to Cayden and has stated its position:",
    critiquePosition,
    "",
    "DRAFT:",
    draftText,
    "",
    "State your position in two sentences, exactly as it should appear next to the Critique Agent's on Cayden's phone. Return only the two sentences.",
  ].join("\n");
  const text = await call("chief_of_staff", [{ role: "user", content: message }]);
  return text.trim();
}

/**
 * Run one full pipeline pass for any specialist:
 * specialist draft -> Chief of Staff review -> Critique audit -> approval queue.
 *
 * Returns the queued draft row. FIX loops back to the specialist once with
 * the violation attached; a second FIX, or an ESCALATE verdict, queues the
 * draft as an escalation carrying both positions so Cayden decides.
 *
 * @param {{specialist: string, assignment: string, vertical: string, platform: string,
 *          mediaFileId?: string, imageBase64?: string, imageMediaType?: string}} job
 * @param {{call?: Function, onProgress?: (line: string) => Promise<void>}} deps
 */
export async function runSpecialistPipeline(job, { call = callAgent, onProgress = async () => {} } = {}) {
  // Every specialist sees the approved links with its assignment.
  job = { ...job, assignment: job.assignment + "\n" + linksBlock(job.platform) };
  const name = SPECIALIST_NAMES[job.specialist] || job.specialist;
  await onProgress(`${name} is drafting...`);
  let draftText = await specialistDraft(call, job);
  const id = drafts.insert({
    agent: job.specialist,
    vertical: job.vertical,
    platform: job.platform,
    content: draftText,
    status: "cos_review",
  });
  if (job.mediaFileId) drafts.update(id, { media_file_id: job.mediaFileId });
  logEvent("pipeline_started", {
    draft_id: id,
    specialist: job.specialist,
    vertical: job.vertical,
    platform: job.platform,
    has_media: Boolean(job.mediaFileId),
  });

  await onProgress("Chief of Staff is reviewing...");
  let review = await chiefReview(call, job, draftText);
  if (review.decision === "RETURN") {
    await onProgress(`Returned by the Chief of Staff. ${name} is redrafting...`);
    draftText = await specialistRedraft(call, job, review.draft, review.notes);
    review = await chiefReview(call, job, draftText);
    // One return round only; whatever the Chief of Staff holds now goes on.
  }
  draftText = review.draft;
  drafts.update(id, {
    content: draftText,
    rationale: review.rationale,
    status: "critique",
  });

  let audit;
  for (let round = 0; ; round++) {
    await onProgress("Critique Agent is auditing...");
    audit = await critiqueAudit(call, job, draftText, review.rationale);
    logEvent("critique_verdict", {
      draft_id: id,
      verdict: audit.verdict,
      round,
      quality_flag: audit.qualityFlag,
    });
    if (audit.verdict !== "FIX") break;
    if (round >= MAX_FIX_ROUNDS) {
      // Still failing after the fix round: put it in front of Cayden
      // rather than burning API calls in a loop.
      audit.verdict = "ESCALATE";
      audit.position = audit.position ||
        `Draft still violates the constitution after ${round + 1} audit round(s): ${audit.notes}`;
      break;
    }
    await onProgress(`FIX verdict. ${name} is redrafting...`);
    draftText = await specialistRedraft(call, job, draftText, audit.notes);
    drafts.update(id, { content: draftText });
  }

  let escalation = null;
  if (audit.verdict === "ESCALATE") {
    await onProgress("Escalation. Collecting both positions...");
    const chiefPosition = await chiefEscalationPosition(
      call, job, draftText, audit.position || audit.notes,
    );
    escalation = {
      critique: audit.position || audit.notes,
      chief: chiefPosition,
    };
  }

  drafts.update(id, {
    content: draftText,
    status: "queued",
    critique_verdict: audit.verdict,
    critique_notes: escalation
      ? `Critique: ${escalation.critique}\nChief of Staff: ${escalation.chief}`
      : audit.notes,
    quality_flag: audit.qualityFlag ? 1 : 0,
  });
  logEvent("draft_queued", { draft_id: id, verdict: audit.verdict });
  return drafts.get(id);
}

/**
 * Revise a queued draft from Cayden's instruction ("> tighten the middle").
 * Goes straight back to the drafting specialist; no re-review or re-audit,
 * because Cayden is the final gate and is looking at the result either way
 * (Article IX: he approves, rejects, or edits).
 *
 * @returns {Promise<string>} the revised copy
 */
export async function reviseDraft(draft, instruction, { call = callAgent } = {}) {
  const specialist = draft.agent || "content";
  const message = [
    `Cayden reviewed your draft in the approval queue and wants a revision. His instruction: "${instruction}"`,
    `Vertical: ${draft.vertical}`,
    `Platform: ${draft.platform}`,
    "",
    "Current draft:",
    draft.content,
    linksBlock(draft.platform),
    "",
    "Apply his instruction faithfully; change nothing he didn't ask about unless his instruction requires it. Return only the revised copy.",
  ].join("\n");
  const text = await call(specialist, [{ role: "user", content: message }]);
  return text.trim();
}

/** The M2 entry point: a Content Agent pass from a /draft brief. */
export async function runContentPipeline(job, deps) {
  return runSpecialistPipeline(
    {
      specialist: "content",
      assignment: contentBrief(job),
      vertical: job.vertical,
      platform: job.platform,
    },
    deps,
  );
}
