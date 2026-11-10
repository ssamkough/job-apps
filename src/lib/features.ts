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
