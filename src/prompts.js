import { settings } from "./db.js";

/**
 * Prompt documents. Workers has no filesystem, so the runtime entry injects
 * the document text: worker.js imports prompts/*.md as bundled text,
 * index.js reads the same files from disk. Constitution amendments ratified
 * via /amend are stored in the settings table and take precedence over the
 * bundled document, preserving the "amend without redeploy" behavior.
 */

let SOURCES = null;

export function setPromptSources({ constitution, systemPrompts }) {
  SOURCES = { constitution, systemPrompts };
}

function sources() {
  if (!SOURCES) {
    throw new Error("Prompt sources not set (setPromptSources was not called).");
  }
  return SOURCES;
}

// Maps agent keys to their section heading in 02_SYSTEM_PROMPTS.md.
const SECTION_HEADINGS = {
  chief_of_staff: "## 1. CHIEF OF STAFF",
  critique: "## 2. CRITIQUE AGENT",
  content: "## 3. CONTENT AGENT",
  outreach: "## 4. OUTREACH AGENT",
  book_growth: "## 5. BOOK GROWTH AGENT",
  app_growth: "## 6. APP GROWTH AGENT",
  engagement: "## 7. ENGAGEMENT AGENT",
  trends: "## 8. TRENDS AGENT",
};

export const AGENT_KEYS = Object.keys(SECTION_HEADINGS);

/** The live constitution: the amended copy in settings, else the bundled one. */
export async function loadConstitution() {
  const amended = await settings.get("constitution_document");
  return amended || sources().constitution;
}

export async function saveConstitution(text) {
  await settings.set("constitution_document", text);
}

/**
 * Append a ratified amendment to the constitution text and return the new
 * document. Pure function so the /amend flow is testable without touching
 * stored state.
 */
export function formatAmendment(doc, amendmentText, date) {
  const n = (doc.match(/\*\*Amendment \d+/g) || []).length + 1;
  let out = doc.trimEnd() + "\n";
  if (!out.includes("## AMENDMENTS")) {
    out +=
      "\n---\n\n## AMENDMENTS\n\nRatified by Cayden via /amend. Each amendment takes effect on every agent's next call.\n";
  }
  out += `\n**Amendment ${n} (${date}).** ${amendmentText}\n`;
  return out;
}

function extractSection(document, heading) {
  const start = document.indexOf(heading);
  if (start === -1) {
    throw new Error(`Section not found in 02_SYSTEM_PROMPTS.md: ${heading}`);
  }
  // Section runs until the next second-level heading or end of file.
  const rest = document.slice(start + heading.length);
  const next = rest.search(/\n## /);
  const body = next === -1 ? rest : rest.slice(0, next);
  return (heading + body).trim();
}

/**
 * Build the full system prompt for an agent: its section from
 * 02_SYSTEM_PROMPTS.md with the entire Constitution appended. The
 * constitution is re-read on every call so an amendment takes effect
 * immediately, without touching code or redeploying.
 */
export async function buildSystemPrompt(agentKey) {
  const heading = SECTION_HEADINGS[agentKey];
  if (!heading) {
    throw new Error(`Unknown agent: ${agentKey}`);
  }
  const section = extractSection(sources().systemPrompts, heading);
  const constitution = await loadConstitution();
  return `${section}\n\n---\n\nThe Agent Constitution, which you operate under at all times, follows in full.\n\n${constitution}`;
}

/** Startup validation: every agent's section must exist in the bundled doc. */
export function validatePromptSources() {
  for (const key of AGENT_KEYS) {
    extractSection(sources().systemPrompts, SECTION_HEADINGS[key]);
  }
}
