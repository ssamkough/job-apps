import "server-only";
import { db } from "@/lib/db";
import { aiEnabled } from "@/lib/features";
import { budgetMicros, pricesConfigured, spendMonth } from "@/lib/ai-budget";

/**
 * Site-wide monthly Ollama spend. Reserve before the call so two Vercel
 * instances can't both pass a check that still has room for only one draft.
 * Returns the month key when the reservation landed, or null when the draft
 * does not fit (including when the price or budget env vars are missing).
 */
export async function reserveAiSpend(estimate: bigint): Promise<string | null> {
  const budget = budgetMicros();
  if (budget === null || !pricesConfigured() || estimate < BigInt(0)) return null;
  const month = spendMonth();

  await db.$executeRaw`
    INSERT INTO "AiSpend" ("month", "spentMicros", "reservedMicros")
    VALUES (${month}, 0, 0)
    ON CONFLICT ("month") DO NOTHING
  `;

  const updated = await db.$executeRaw`
    UPDATE "AiSpend"
    SET "reservedMicros" = "reservedMicros" + ${estimate}
    WHERE "month" = ${month}
      AND "spentMicros" + "reservedMicros" < ${budget}
      AND "spentMicros" + "reservedMicros" + ${estimate} <= ${budget}
  `;
  return updated === 1 ? month : null;
}

/** Replace a reservation with the measured cost of a finished draft. */
export async function commitAiSpend(month: string, estimate: bigint, actual: bigint) {
  await db.$executeRaw`
    UPDATE "AiSpend"
    SET "spentMicros" = "spentMicros" + ${actual},
        "reservedMicros" = GREATEST("reservedMicros" - ${estimate}, 0)
    WHERE "month" = ${month}
  `;
}

/** Give back a reservation when the call fails or returns nothing usable. */
export async function releaseAiSpend(month: string, estimate: bigint) {
  await db.$executeRaw`
    UPDATE "AiSpend"
    SET "reservedMicros" = GREATEST("reservedMicros" - ${estimate}, 0)
    WHERE "month" = ${month}
  `;
}

/** True when another draft is allowed. Does not reserve. */
export async function aiBudgetOpen(): Promise<boolean> {
  const budget = budgetMicros();
  if (budget === null || !pricesConfigured()) return false;
  const row = await db.aiSpend.findUnique({ where: { month: spendMonth() } });
  if (!row) return true;
  return row.spentMicros + row.reservedMicros < budget;
}

/**
 * The pages use this to hide the buttons. When AI is off, the ledger is not
 * read and the page stays in the plain-textarea state.
 */
export async function aiDraftsPaused(): Promise<boolean> {
  if (!aiEnabled()) return false;
  return !(await aiBudgetOpen());
}
