import { config } from "./config.js";
import { drafts, mediaLibrary, isPaused, logEvent, scrubSecrets } from "./db.js";
import { isConfigured as postizConfigured, createPost, uploadMedia } from "./postiz.js";
import { downloadTelegramFile } from "./telegram/files.js";

const MIME_BY_EXT = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  mov: "video/quicktime",
};

async function markPublished(id) {
  await drafts.update(id, {
    status: "published",
    published_at: new Date().toISOString(),
  });
}

/**
 * Publish an approved draft. Triple-gated: the caller got here only through
 * the approval pipeline, /pause holds everything, and DRY_RUN (the default)
 * logs instead of posting. With DRY_RUN=false the draft goes out through
 * Postiz to every connected channel matching the draft's platform.
 *
 * @returns {Promise<{published: boolean, dryRun?: boolean, reason?: string, error?: string}>}
 */
export async function publishDraft(draft, { post = createPost, upload = uploadMedia, download = downloadTelegramFile, api = null } = {}) {
  if (await isPaused()) {
    return { published: false, reason: "paused" };
  }
  // The bot owns scheduling: a future scheduled_for waits for the due-check
  // cron (publishDue) rather than being handed to Postiz, so dry run and
  // live behave identically and /status can show what's pending.
  if (draft.scheduled_for && draft.scheduled_for > new Date().toISOString().replace("T", " ").slice(0, 19)) {
    return { published: false, reason: "not_due" };
  }
  if (config.dryRun) {
    await markPublished(draft.id);
    await logEvent("publish_dry_run", {
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
  if (draft.media_file_id && !api) {
    // Media publishing needs a Telegram api handle to fetch the asset;
    // callers without one (none today) hold rather than post without it,
    // because an Instagram post missing its media would fail or lie.
    return { published: false, reason: "media_unavailable" };
  }
  if (!postizConfigured()) {
    await logEvent("publish_skipped_no_publisher", { draft_id: draft.id });
    return { published: false, reason: "no_publisher" };
  }

  try {
    let media = [];
    if (draft.media_file_id) {
      const { buffer, filename } = await download(api, draft.media_file_id);
      const ext = (filename.split(".").pop() || "").toLowerCase();
      const stored = await upload({
        data: buffer,
        filename,
        contentType: MIME_BY_EXT[ext] || "application/octet-stream",
      });
      if (!stored?.id) throw new Error("Postiz upload returned no file id");
      media = [{ id: stored.id, path: stored.path }];
      // Mirror into the media library so the asset is findable and reusable.
      await mediaLibrary.save({
        postizId: stored.id,
        path: stored.path,
        kind: MIME_BY_EXT[ext]?.startsWith("video") ? "video" : "photo",
        label: `draft #${draft.id}`,
        telegramFileId: draft.media_file_id,
      });
    }
    const res = await post({
      content: draft.content,
      platform: draft.platform,
      media,
    });
    await markPublished(draft.id);
    await logEvent("publish_live", {
      draft_id: draft.id,
      platform: draft.platform,
      postiz_response_id: res?.id ?? res?.[0]?.postId ?? null,
    });
    return { published: true, dryRun: false };
  } catch (err) {
    // Draft stays 'approved' so /resume (or a fixed config) retries it.
    await logEvent("publish_error", { draft_id: draft.id, message: String(err?.message ?? err) });
    return { published: false, reason: "error", error: scrubSecrets(err.message) };
  }
}

/**
 * Publish scheduled drafts whose slot has arrived: the due-check cron, and
 * /resume after a pause. "Post now" stamps scheduled_for too, so pause-held
 * and publish-failed drafts retry here, while approved drafts still waiting
 * for Cayden to pick a time never move.
 *
 * @returns {Promise<Array<{draft: object, result: object}>>}
 */
export async function publishDue(deps = {}) {
  const nowStr = new Date().toISOString().replace("T", " ").slice(0, 19);
  const results = [];
  for (const draft of await drafts.listByStatus("approved")) {
    if (!draft.scheduled_for || draft.scheduled_for > nowStr) continue;
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
    case "not_due":
      return `Draft #${draft.id} is scheduled and will post at its slot.`;
    case "manual_platform":
      return `Draft #${draft.id} approved. ${draft.platform} content is sent manually; the copy above is ready.`;
    case "media_unavailable":
      return `Draft #${draft.id} approved, but the asset couldn't be fetched for publishing. It stays approved; /resume retries.`;
    case "no_publisher":
      return `Draft #${draft.id} approved. Postiz isn't configured yet, so it stays in the approved list.`;
    default:
      return `Draft #${draft.id} approved, but publishing failed: ${result.error}. It stays approved; /resume retries.`;
  }
}
