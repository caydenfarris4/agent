import { config } from "../config.js";

/**
 * Download a Telegram file by file id. The Bot API caps downloads at 20MB.
 * Uses global fetch so it runs identically on Cloudflare Workers and Node
 * (the Node entry installs a proxy-aware fetch when HTTPS_PROXY is set).
 * @returns {Promise<{buffer: Buffer, filename: string}>}
 */
export async function downloadTelegramFile(api, fileId, { maxBytes = 20 * 1024 * 1024 } = {}) {
  const file = await api.getFile(fileId);
  // This URL embeds the bot token — it must never appear in errors or logs.
  const url = `https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} downloading file`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > maxBytes) {
    throw new Error(
      `file is ${Math.round(buffer.length / 1024 / 1024)}MB, over the ${Math.round(maxBytes / 1024 / 1024)}MB limit`,
    );
  }
  const filename = file.file_path.split("/").pop() || "upload.bin";
  return { buffer, filename };
}
