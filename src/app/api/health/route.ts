import { db } from "@/lib/db";

// For uptime monitors and load balancers. Deliberately public and minimal:
// it reports up/down only, never versions, hosts, or error details.
export const dynamic = "force-dynamic";

export async function GET() {
  const headers = { "Cache-Control": "no-store" };
  try {
    await db.$queryRaw`SELECT 1`;
    return Response.json({ status: "ok" }, { headers });
  } catch (e) {
    console.error("Health check failed", e);
    return Response.json({ status: "down" }, { status: 503, headers });
  }
}
