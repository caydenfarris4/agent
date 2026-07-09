import { config } from "./config.js";
import { drafts, settings, isPaused, logEvent } from "./db.js";
import { postizConfigured, createPost } from "./postiz.js";

function markPublished(id) {
  drafts.update(id, {
    status: "published",
    published_at: new Date().toISOString(),
  });
}

/**
 * Publish an approved draft. Triple-gated: the caller got here only through
 * the approval pipeline, /pause holds everything, and DRY_RUN (the default)
 * logs instead of posting. With DRY_RUN=false the draft goes out through
 * Postiz to the channel mapped for its platform (/channels builds the map).
 *
 * @returns {Promise<{published: boolean, dryRun?: boolean, reason?: string, error?: string}>}
 */
export async function publishDraft(draft, { post = createPost } = {}) {
  if (isPaused()) {
    return { published: false, reason: "paused" };
  }
  if (config.dryRun) {
    markPublished(draft.id);
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

  // Live path. Honest guards first: what Postiz cannot take stays manual.
  if (draft.platform === "reply" || draft.platform === "email") {
    return { published: false, reason: "manual_platform" };
  }
  if (draft.media_file_id) {
    // Media upload to Postiz is not built; claiming the post went out with
    // its asset would be false (and Instagram requires the media).
    return { published: false, reason: "media_unsupported" };
  }
  if (!postizConfigured()) {
    logEvent("publish_skipped_no_publisher", { draft_id: draft.id });
    return { published: false, reason: "no_publisher" };
  }
  const map = JSON.parse(settings.get("postiz_map", "{}"));
  const integrationId = map[draft.platform];
  if (!integrationId) {
    return { published: false, reason: "unmapped_platform" };
  }

  try {
    const res = await post({
      integrationId,
      content: draft.content,
      scheduledFor: draft.scheduled_for,
    });
    markPublished(draft.id);
    logEvent("publish_live", {
      draft_id: draft.id,
      platform: draft.platform,
      postiz_response_id: res?.id ?? res?.[0]?.postId ?? null,
    });
    return { published: true, dryRun: false };
  } catch (err) {
    // Draft stays 'approved' so /resume (or a fixed config) retries it.
    logEvent("publish_error", { draft_id: draft.id, message: String(err?.message ?? err) });
    return { published: false, reason: "error", error: err.message };
  }
}

/**
 * Publish every approved-but-unpublished draft. Called on /resume so a
 * pause doesn't strand approvals; also retries drafts whose live publish
 * previously failed.
 *
 * @returns {Promise<Array<{draft: object, result: object}>>}
 */
export async function flushApproved(deps = {}) {
  const results = [];
  for (const draft of drafts.listByStatus("approved")) {
    results.push({ draft, result: await publishDraft(draft, deps) });
  }
  return results;
}

/** One line for Telegram describing a publish result. */
export function describePublishResult(draft, result) {
  if (result.published) {
    return result.dryRun
      ? `Draft #${draft.id} published (dry run: logged, not posted).`
      : `Draft #${draft.id} published to ${draft.platform} via Postiz.`;
  }
  switch (result.reason) {
    case "paused":
      return `Draft #${draft.id} approved. Publishing is paused; it goes out on /resume.`;
    case "manual_platform":
      return `Draft #${draft.id} approved. ${draft.platform} content is sent manually; the copy above is ready.`;
    case "media_unsupported":
      return `Draft #${draft.id} approved. Posts with media stay manual until media upload lands; copy and asset are above.`;
    case "no_publisher":
      return `Draft #${draft.id} approved. Postiz isn't configured yet, so it stays in the approved list.`;
    case "unmapped_platform":
      return `Draft #${draft.id} approved, but no Postiz channel is mapped for ${draft.platform}. Run /channels, then /resume to retry.`;
    default:
      return `Draft #${draft.id} approved, but publishing failed: ${result.error}. It stays approved; /resume retries.`;
  }
}
