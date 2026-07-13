import { fetch as undiciFetch, EnvHttpProxyAgent } from "undici";
import { config } from "./config.js";
import { isPaused, logEvent } from "./db.js";

// Node's global fetch ignores HTTPS_PROXY, so route through undici's
// env-aware agent when a proxy is configured (same reason bot.js passes
// an agent to grammY). On a normal VPS this is a no-op.
const dispatcher =
  process.env.HTTPS_PROXY || process.env.https_proxy
    ? new EnvHttpProxyAgent()
    : undefined;

export function isConfigured() {
  return Boolean(config.postizUrl && config.postizKey);
}

async function request(method, path, body) {
  if (!isConfigured()) {
    throw new Error(
      "Postiz is not configured. Set POSTIZ_API_URL and POSTIZ_API_KEY in .env.",
    );
  }
  const res = await undiciFetch(`${config.postizUrl}${path}`, {
    method,
    dispatcher,
    headers: {
      Authorization: config.postizKey,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const detail =
      (data && typeof data === "object" && (data.msg || data.message)) ||
      text ||
      res.statusText;
    throw new Error(`Postiz ${method} ${path} failed (${res.status}): ${detail}`);
  }
  return data;
}

// --- Channels ---------------------------------------------------------------

// Connected social channels: [{ id, name, identifier, disabled, ... }]
// where identifier is the platform, e.g. "linkedin", "x", "instagram".
export async function listIntegrations() {
  return request("GET", "/integrations");
}

// Draft platforms use our own names; Postiz identifiers vary slightly
// (e.g. "instagram" vs "instagram-standalone", legacy "twitter" for x).
const PLATFORM_ALIASES = {
  linkedin: ["linkedin", "linkedin-page"],
  instagram: ["instagram", "instagram-standalone"],
  x: ["x", "twitter"],
};

export function integrationsForPlatform(integrations, platform) {
  const wanted = PLATFORM_ALIASES[platform] ?? [platform];
  return integrations.filter(
    (i) => !i.disabled && wanted.includes(String(i.identifier).toLowerCase()),
  );
}

// Verifies the domain is reachable and the API key is accepted.
export async function checkConnection() {
  if (!isConfigured()) {
    return { ok: false, error: "POSTIZ_API_URL / POSTIZ_API_KEY not set" };
  }
  try {
    const integrations = await listIntegrations();
    return { ok: true, integrations };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// --- Publishing ---------------------------------------------------------------

// Sends one piece of content to one or more connected channels.
// This is the single choke point for outbound posts: DRY_RUN and /pause are
// enforced here so no caller can accidentally publish around them.
export async function createPost({ content, platform, scheduledFor }) {
  if (config.dryRun) {
    logEvent("postiz_dry_run", { platform, scheduledFor, content });
    return { dryRun: true };
  }
  if (isPaused()) {
    throw new Error("Publishing is paused (/resume to unfreeze).");
  }

  const integrations = integrationsForPlatform(
    await listIntegrations(),
    platform,
  );
  if (integrations.length === 0) {
    throw new Error(
      `No connected Postiz channel for platform "${platform}". Connect one in the Postiz dashboard.`,
    );
  }

  const date = scheduledFor
    ? new Date(scheduledFor).toISOString()
    : new Date().toISOString();
  const result = await request("POST", "/posts", {
    type: scheduledFor ? "schedule" : "now",
    date,
    shortLink: false,
    tags: [],
    posts: integrations.map((integration) => ({
      integration: { id: integration.id },
      value: [{ content }],
      settings: {},
    })),
  });
  logEvent("postiz_published", {
    platform,
    scheduledFor: date,
    integrations: integrations.map((i) => i.id),
  });
  return result;
}
