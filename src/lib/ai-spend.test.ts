import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spendMonth } from "@/lib/ai-budget";
import { reserveAiSpend } from "@/lib/ai-spend";
import { db } from "@/lib/db";
import { resetDb } from "@/test/db";

beforeEach(async () => {
  vi.stubEnv("OLLAMA_INPUT_USD_PER_MILLION", "0.14");
  vi.stubEnv("OLLAMA_OUTPUT_USD_PER_MILLION", "0.40");
  vi.stubEnv("AI_MONTHLY_BUDGET_USD", "1");
  await resetDb();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("reserveAiSpend", () => {
  it("accepts only one of two reservations that would together pass the cap", async () => {
    const estimate = BigInt(600_000);
    const [first, second] = await Promise.all([
      reserveAiSpend(estimate),
      reserveAiSpend(estimate),
    ]);
    expect([first, second].filter((month) => month !== null)).toEqual([spendMonth()]);
    const row = await db.aiSpend.findUniqueOrThrow({ where: { month: spendMonth() } });
    expect(row.spentMicros).toBe(BigInt(0));
    expect(row.reservedMicros).toBe(estimate);
  });
});
