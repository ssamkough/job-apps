import type { Metadata } from "next";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { deleteResume } from "@/app/actions/resumes";
import { ALLOWED_RESUME_TYPES } from "@/lib/constants";
import { formatBytes, formatDate, plural } from "@/lib/format";
import { Card, EmptyState, PageHeader, buttonClass } from "@/components/ui";
import { DeleteButton } from "@/components/delete-button";
import { ResumeUploadForm } from "@/components/resume-upload-form";

export const metadata: Metadata = { title: "Resumes" };

export default async function ResumesPage() {
  const user = await requireUser();
  const resumes = await db.resume.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { applications: true } } },
  });

  return (
    <>
      <PageHeader
        title="Resumes"
        description="Upload each version once, then attach it to any application."
      />

      <ResumeUploadForm />

      {resumes.length === 0 ? (
        <Card>
          <EmptyState
            title="No resumes yet"
            description="Upload one above. You can also upload directly while adding an application."
          />
        </Card>
      ) : (
        <Card className="divide-y divide-zinc-100">
          {resumes.map((r) => (
            <div
              key={r.id}
              className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="truncate font-medium text-zinc-900">{r.label}</p>
                <p className="truncate text-sm text-zinc-500">
                  {r.fileName} · {ALLOWED_RESUME_TYPES[r.mimeType] ?? "File"} ·{" "}
                  {formatBytes(r.size)} · Added {formatDate(r.createdAt)} · Used in{" "}
                  {plural(r._count.applications, "application")}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <a
                  href={`/api/resumes/${r.id}`}
                  className={buttonClass("secondary")}
                >
                  Download
                </a>
                <DeleteButton
                  action={deleteResume.bind(null, r.id)}
                  confirmMessage={
                    r._count.applications > 0
                      ? `Delete "${r.label}"? It's attached to ${plural(r._count.applications, "application")}; they'll stay but lose this resume.`
                      : `Delete "${r.label}"?`
                  }
                >
                  Delete
                </DeleteButton>
              </div>
            </div>
          ))}
        </Card>
      )}
    </>
  );
}
