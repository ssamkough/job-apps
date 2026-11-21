/**
 * Pure pricing for the site-wide Ollama Cloud cap. One micro-dollar is
 * 1/1_000_000 of a dollar, so $20 is 20_000_000. Token math stays in integers.
 */

export const AI_PAUSED_MESSAGE = "AI drafts are paused until next month.";

export class AiBudgetError extends Error {
  constructor() {
    super(AI_PAUSED_MESSAGE);
    this.name = "AiBudgetError";
  }
}

/** `YYYY-MM` in UTC. A new month is a new ledger row. */
export function spendMonth(now = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/** Positive finite number, or null. Zero and blanks count as unset. */
function positive(raw: string | undefined): number | null {
  if (!raw?.trim()) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Micro-dollars per million tokens, from a dollars-per-million env var. */
function microsPerMillion(raw: string | undefined): bigint | null {
  const dollars = positive(raw);
  if (dollars === null) return null;
  return BigInt(Math.round(dollars * 1_000_000));
}

export function budgetMicros(): bigint | null {
  const dollars = positive(process.env.AI_MONTHLY_BUDGET_USD);
  if (dollars === null) return null;
  return BigInt(Math.round(dollars * 1_000_000));
}

/** Both token prices are set. A missing price must not leave the bill open. */
export function pricesConfigured(): boolean {
  return (
    microsPerMillion(process.env.OLLAMA_INPUT_USD_PER_MILLION) !== null &&
    microsPerMillion(process.env.OLLAMA_OUTPUT_USD_PER_MILLION) !== null
  );
}

/**
 * Micro-dollars for a completed call. Input is priced at the uncached rate,
 * which is the higher of Ollama's published rates, so the ledger stops a
 * little before the real bill.
 *
 * `(tokens * micro-dollars per million tokens) / 1_000_000`.
 */
export function costMicros(promptTokens: number, outputTokens: number): bigint | null {
  const input = microsPerMillion(process.env.OLLAMA_INPUT_USD_PER_MILLION);
  const output = microsPerMillion(process.env.OLLAMA_OUTPUT_USD_PER_MILLION);
  if (input === null || output === null) return null;
  const prompt = BigInt(Math.max(0, Math.floor(promptTokens)));
  const generated = BigInt(Math.max(0, Math.floor(outputTokens)));
  return (prompt * input + generated * output) / BigInt(1_000_000);
}

/** Upper bound held before the call: prompt chars / 3, plus `num_predict`. */
export function estimateMicros(promptChars: number, numPredict: number): bigint | null {
  const inputTokens = Math.ceil(Math.max(0, promptChars) / 3);
  return costMicros(inputTokens, numPredict);
}
