import https from "node:https";
import http from "node:http";
import { HttpsProxyAgent } from "https-proxy-agent";
import { config } from "./config.js";

/**
 * Minimal Postiz public-API client (self-hosted or cloud).
 * POSTIZ_API_URL is the public API base, e.g. https://postiz.example.com/api/public/v1
 * (cloud: https://api.postiz.com/public/v1). Auth is the API key in the
 * Authorization header, per Postiz docs.
 *
 * NOTE: this path stays cold until DRY_RUN=false. Per the build guide, the
 * first live publish should target a private test channel.
 */

function request(method, path, body = null) {
  const base = config.postizUrl.replace(/\/+$/, "");
  const url = new URL(base + path);
  const isHttps = url.protocol === "https:";
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const payload = body ? JSON.stringify(body) : null;

  return new Promise((resolve, reject) => {
    const req = (isHttps ? https : http).request(
      url,
      {
        method,
        agent: isHttps && proxy ? new HttpsProxyAgent(proxy) : undefined,
        headers: {
          Authorization: config.postizKey,
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(
              new Error(`Postiz ${method} ${path}: HTTP ${res.statusCode} ${text.slice(0, 300)}`),
            );
          }
          try {
            resolve(text ? JSON.parse(text) : null);
          } catch {
            resolve(text);
          }
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const MIME_BY_EXT = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  mov: "video/quicktime",
};

/** Multipart upload to the Postiz public API. Returns the stored file record ({id, path, ...}). */
export function uploadFile(buffer, filename) {
  const base = config.postizUrl.replace(/\/+$/, "");
  const url = new URL(base + "/upload");
  const isHttps = url.protocol === "https:";
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;

  const ext = (filename.split(".").pop() || "").toLowerCase();
  const mime = MIME_BY_EXT[ext] || "application/octet-stream";
  const boundary = "----launchsys" + Math.random().toString(16).slice(2);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const payload = Buffer.concat([head, buffer, tail]);

  return new Promise((resolve, reject) => {
    const req = (isHttps ? https : http).request(
      url,
      {
        method: "POST",
        agent: isHttps && proxy ? new HttpsProxyAgent(proxy) : undefined,
        headers: {
          Authorization: config.postizKey,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": payload.length,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`Postiz upload: HTTP ${res.statusCode} ${text.slice(0, 300)}`));
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error(`Postiz upload: unparseable response ${text.slice(0, 120)}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

export function postizConfigured() {
  return Boolean(config.postizUrl && config.postizKey);
}

/** Connected channels: [{id, name, identifier ("linkedin"|"x"|"instagram"|...), disabled}] */
export async function listIntegrations({ req = request } = {}) {
  const out = await req("GET", "/integrations");
  return Array.isArray(out) ? out : out?.integrations || [];
}

/**
 * Publish one post to one channel, now or scheduled, optionally with media
 * previously stored via uploadFile ([{id}] entries).
 * @returns Postiz response (includes the post id).
 */
export async function createPost({ integrationId, content, scheduledFor = null, media = [] }, { req = request } = {}) {
  return req("POST", "/posts", {
    type: scheduledFor ? "schedule" : "now",
    date: scheduledFor || new Date().toISOString(),
    shortLink: false,
    tags: [],
    posts: [
      {
        integration: { id: integrationId },
        value: [{ content, ...(media.length ? { image: media } : {}) }],
      },
    ],
  });
}

/**
 * Map our platform names to Postiz integration ids by provider identifier.
 * Postiz calls X "x" (older versions "twitter").
 */
export function mapPlatforms(integrations) {
  const map = {};
  for (const i of integrations) {
    if (i.disabled) continue;
    const ident = String(i.identifier || "").toLowerCase();
    if (ident.includes("linkedin") && !map.linkedin) map.linkedin = i.id;
    if ((ident === "x" || ident.includes("twitter")) && !map.x) map.x = i.id;
    if (ident.includes("instagram") && !map.instagram) map.instagram = i.id;
  }
  return map;
}
