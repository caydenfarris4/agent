import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { buildSystemPrompt } from "../prompts.js";
import { logEvent } from "../db.js";

const client = new Anthropic({ apiKey: config.anthropicApiKey });

/**
 * Run one agent turn. Each agent is a Claude API call whose system prompt is
 * its section of 02_SYSTEM_PROMPTS.md plus the full Constitution, loaded from
 * disk at call time. The constitution block carries a cache breakpoint so the
 * shared prefix is cached across calls until the documents change.
 *
 * @param {string} agentKey one of the keys in prompts.js (chief_of_staff, critique, ...)
 * @param {Array<{role: string, content: string}>} messages conversation for this turn
 * @returns {Promise<string>} the agent's text response
 */
export async function callAgent(agentKey, messages, { maxTokens = 4096 } = {}) {
  const system = buildSystemPrompt(agentKey);

  const response = await client.messages.create({
    model: config.agentModel,
    max_tokens: maxTokens,
    thinking: { type: "adaptive" },
    system: [
      {
        type: "text",
        text: system,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages,
  });

  logEvent("agent_call", {
    agent: agentKey,
    model: response.model,
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    cache_read: response.usage.cache_read_input_tokens,
  });

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  if (!text) {
    throw new Error(
      `Agent ${agentKey} returned no text (stop_reason: ${response.stop_reason})`,
    );
  }
  return text;
}
