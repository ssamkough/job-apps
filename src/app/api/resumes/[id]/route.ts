import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { readResumeFile } from "@/lib/storage";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user?.emailVerified) return new Response("Unauthorized", { status: 401 });

  const { id } = await params;
  // Scoped by userId: other users' ids look identical to missing ones.
  const resume = await db.resume.findFirst({ where: { id, userId: user.id } });
  if (!resume) return new Response("Not found", { status: 404 });

  let file: Buffer;
  try {
    file = await readResumeFile(resume.storageKey);
  } catch {
    return new Response("File missing", { status: 404 });
  }

  // RFC 5987 encoding so non-ASCII file names survive.
  const encoded = encodeURIComponent(resume.fileName);
  return new Response(new Uint8Array(file), {
    headers: {
      "Content-Type": resume.mimeType,
      "Content-Length": String(file.length),
      "Content-Disposition": `attachment; filename*=UTF-8''${encoded}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
