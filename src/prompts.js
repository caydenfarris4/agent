import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.join(here, "..", "prompts");

const CONSTITUTION_PATH = path.join(PROMPTS_DIR, "01_AGENT_CONSTITUTION.md");
const SYSTEM_PROMPTS_PATH = path.join(PROMPTS_DIR, "02_SYSTEM_PROMPTS.md");

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

export function loadConstitution() {
  return fs.readFileSync(CONSTITUTION_PATH, "utf8");
}

export function saveConstitution(text) {
  fs.writeFileSync(CONSTITUTION_PATH, text, "utf8");
}

/**
 * Append a ratified amendment to the constitution text and return the new
 * document. Pure function so the /amend flow is testable without touching
 * the real file.
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
 * 02_SYSTEM_PROMPTS.md with the entire Constitution appended.
 * Read from disk on every call so an amendment to the Constitution
 * takes effect immediately, without touching code or restarting.
 */
export function buildSystemPrompt(agentKey) {
  const heading = SECTION_HEADINGS[agentKey];
  if (!heading) {
    throw new Error(`Unknown agent: ${agentKey}`);
  }
  const promptsDoc = fs.readFileSync(SYSTEM_PROMPTS_PATH, "utf8");
  const section = extractSection(promptsDoc, heading);
  const constitution = loadConstitution();
  return `${section}\n\n---\n\nThe Agent Constitution, which you operate under at all times, follows in full.\n\n${constitution}`;
}
