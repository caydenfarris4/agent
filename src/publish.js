import { config } from "./config.js";
import { drafts, isPaused, logEvent } from "./db.js";

/**
 * Publish an approved draft. Triple-gated: the caller got here only through
 * the approval pipeline, /pause holds everything, and DRY_RUN (the default)
 * logs instead of posting. Real posting via Postiz lands in M5.
 *
 * @returns {{published: boolean, dryRun?: boolean, reason?: string}}
 */
export function publishDraft(draft) {
  if (isPaused()) {
    return { published: false, reason: "paused" };
  }
  if (config.dryRun) {
    drafts.update(draft.id, {
      status: "published",
      published_at: new Date().toISOString(),
    });
    logEvent("publish_dry_run", {
      draft_id: draft.id,
      vertical: draft.vertical,
      platform: draft.platform,
    });
    console.log(
      `[DRY RUN] Would publish draft #${draft.id} to ${draft.platform} (${draft.vertical}):\n${draft.content}`,
    );
    return { published: true, dryRun: true };
  }
  // Live publishing (Postiz) is M5. Until then a non-dry-run config
  // holds the draft in 'approved' rather than pretending it went out.
  logEvent("publish_skipped_no_publisher", { draft_id: draft.id });
  return { published: false, reason: "no_publisher" };
}

/**
 * Publish every approved-but-unpublished draft. Called on /resume so a
 * pause doesn't strand approvals.
 *
 * @returns {Array<{draft: object, result: object}>}
 */
export function flushApproved() {
  const results = [];
  for (const draft of drafts.listByStatus("approved")) {
    results.push({ draft, result: publishDraft(draft) });
  }
  return results;
}
