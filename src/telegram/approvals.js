import { InlineKeyboard } from "grammy";
import { nextPeakSlots, formatSlot } from "../schedule.js";

export function approvalKeyboard(draftId) {
  return new InlineKeyboard()
    .text("✅ Approve", `approve:${draftId}`)
    .text("❌ Reject", `reject:${draftId}`);
}

/**
 * After Approve: post now, or one of the next three peak engagement slots
 * for the draft's platform. Slot times ride in the callback data as epoch
 * seconds so the choice is exact regardless of when it's tapped.
 */
export function scheduleKeyboard(draft) {
  const kb = new InlineKeyboard().text("⚡ Post now", `pub:${draft.id}:now`).row();
  for (const slot of nextPeakSlots(draft.platform)) {
    kb.text(formatSlot(slot), `pub:${draft.id}:${Math.floor(slot.getTime() / 1000)}`);
  }
  return kb;
}

/**
 * Render the approval card for a queued draft. Plain text (no Telegram
 * Markdown) so agent copy can never break the message.
 */
export function draftCard(draft) {
  const lines = [
    `Draft #${draft.id} · ${draft.vertical} · ${draft.platform}`,
  ];
  if (draft.media_file_id) lines.push("Built around your uploaded asset.");
  if (draft.critique_verdict === "ESCALATE") {
    lines.push("⚠️ ESCALATION, the Chief of Staff and Critique Agent disagree:");
    if (draft.critique_notes) lines.push(draft.critique_notes);
  } else {
    if (draft.rationale) lines.push(`Rationale: ${draft.rationale}`);
    if (draft.quality_flag) {
      lines.push(
        `Compliant, flagged for quality${draft.critique_notes ? `: ${draft.critique_notes}` : "."}`,
      );
    }
  }
  lines.push("", draft.content);
  return lines.join("\n");
}

export async function sendApprovalCard(api, chatId, draft) {
  await api.sendMessage(chatId, draftCard(draft), {
    reply_markup: approvalKeyboard(draft.id),
  });
}
