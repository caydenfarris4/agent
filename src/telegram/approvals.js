import { InlineKeyboard } from "grammy";

export function approvalKeyboard(draftId) {
  return new InlineKeyboard()
    .text("✅ Approve", `approve:${draftId}`)
    .text("❌ Reject", `reject:${draftId}`);
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
