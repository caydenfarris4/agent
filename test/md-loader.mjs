// Lets Node import .md files as text the way wrangler's Text rule does,
// so test code can import src/worker.js directly.
import fs from "node:fs/promises";

export async function load(url, context, nextLoad) {
  if (url.endsWith(".md")) {
    const source = await fs.readFile(new URL(url), "utf8");
    return {
      format: "module",
      source: `export default ${JSON.stringify(source)};`,
      shortCircuit: true,
    };
  }
  return nextLoad(url, context);
}
