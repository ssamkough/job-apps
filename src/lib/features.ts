/**
 * Feature flags, read from the environment on the server.
 *
 * AI cover-letter drafting is opt-in: it needs a reachable Ollama model, so a
 * deployment without one should not show a button that can only fail. Set
 * `AI_ENABLED=true` to turn it on.
 */
export function aiEnabled(): boolean {
  return process.env.AI_ENABLED?.trim().toLowerCase() === "true";
}

const on = (name: string) => process.env[name]?.trim().toLowerCase() === "true";

/**
 * "Import from a job posting" on the Add application page. This part needs no
 * AI: it fetches a URL (or reads a PDF / pasted text) and reads the page's
 * structured data. Set `IMPORT_ENABLED=true` to turn it on.
 */
export function importEnabled(): boolean {
  return on("IMPORT_ENABLED");
}

/**
 * Lets an import hand pages without structured data to the background AI
 * worker. Needs `IMPORT_ENABLED` too, and a worker listening on the queue.
 */
export function importAiEnabled(): boolean {
  return importEnabled() && on("AI_IMPORT_ENABLED");
}
