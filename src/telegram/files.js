import https from "node:https";
import { HttpsProxyAgent } from "https-proxy-agent";
import { config } from "../config.js";

export function httpGetBuffer(url) {
  return new Promise((resolve, reject) => {
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    const opts = proxy ? { agent: new HttpsProxyAgent(proxy) } : {};
    https
      .get(url, opts, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} downloading file`));
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      })
      .on("error", reject);
  });
}

/**
 * Download a Telegram file by file id. The Bot API caps downloads at 20MB.
 * @returns {Promise<{buffer: Buffer, filename: string}>}
 */
export async function downloadTelegramFile(api, fileId, { maxBytes = 20 * 1024 * 1024 } = {}) {
  const file = await api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`;
  const buffer = await httpGetBuffer(url);
  if (buffer.length > maxBytes) {
    throw new Error(`file is ${Math.round(buffer.length / 1024 / 1024)}MB, over the ${Math.round(maxBytes / 1024 / 1024)}MB limit`);
  }
  const filename = file.file_path.split("/").pop() || "upload.bin";
  return { buffer, filename };
}
