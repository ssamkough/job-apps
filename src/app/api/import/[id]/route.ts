import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { importEnabled } from "@/lib/features";
import { housekeeping, outcomeFor } from "@/lib/import/jobs";

/** Where a queued import stands. The browser polls this until it is done. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!importEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  await housekeeping(user.id);
  // Scoped by userId: other people's ids look the same as missing ones.
  const job = await db.importJob.findFirst({ where: { id, userId: user.id } });
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json(outcomeFor(job), { headers: { "Cache-Control": "no-store" } });
}
