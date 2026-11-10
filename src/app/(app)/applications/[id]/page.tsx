import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import {
  deleteApplication,
  updateApplication,
} from "@/app/actions/applications";
import { STATUS_LABELS, isStatus } from "@/lib/constants";
import { formatBytes, toDateInput } from "@/lib/format";
import { Card } from "@/components/ui";
import { StatusBadge } from "@/components/status-badge";
import { ApplicationForm } from "@/components/application-form";
import { aiEnabled } from "@/lib/features";
import { DeleteButton } from "@/components/delete-button";
import { LocalTime } from "@/components/local-time";

export const metadata: Metadata = { title: "Application" };

export default async function ApplicationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const { saved } = await searchParams;

  const [app, resumes] = await Promise.all([
    db.application.findFirst({
      where: { id, userId: user.id },
      include: {
        resume: true,
        events: { orderBy: { createdAt: "desc" } },
      },
    }),
    db.resume.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      select: { id: true, label: true, fileName: true },
    }),
  ]);
  if (!app) notFound();

  return (
    <>
      <Link
        href="/applications"
        className="mb-4 inline-block text-sm text-zinc-500 hover:text-zinc-800"
      >
        ← All applications
      </Link>

      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight text-zinc-900">
            {app.company}
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-zinc-500">
            <span>{app.jobTitle}</span>
            <StatusBadge status={app.status} />
            {app.jobUrl && (
              <a
                href={app.jobUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-indigo-600 hover:text-indigo-500"
              >
                View posting ↗
              </a>
            )}
          </p>
        </div>
        <DeleteButton
          action={deleteApplication.bind(null, app.id)}
          confirmMessage={`Delete your application to ${app.company}? This also removes its cover letter and notes. This can't be undone.`}
        >
          Delete
        </DeleteButton>
      </div>

      <ApplicationForm
        // Remount after each save so stale values from a failed attempt can't
        // override what was just saved.
        key={app.updatedAt.getTime()}
        action={updateApplication.bind(null, app.id)}
        initial={{
          company: app.company,
          jobTitle: app.jobTitle,
          jobUrl: app.jobUrl ?? "",
          location: app.location ?? "",
          workType: app.workType ?? "",
          salary: app.salary ?? "",
          source: app.source ?? "",
          status: app.status,
          dateApplied: toDateInput(app.dateApplied),
          jobDescription: app.jobDescription ?? "",
          notes: app.notes ?? "",
          coverLetter: app.coverLetter ?? "",
          contactName: app.contactName ?? "",
          contactEmail: app.contactEmail ?? "",
          resumeId: app.resumeId ?? "",
        }}
        resumes={resumes}
        aiEnabled={aiEnabled()}
        submitLabel="Save changes"
        saved={saved === "1"}
      />

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <h2 className="mb-4 text-sm font-semibold text-zinc-900">History</h2>
          <ol className="space-y-3">
            {app.events.map((e) => (
              <li key={e.id} className="flex items-start justify-between gap-3 text-sm">
                <span className="text-zinc-700">
                  {e.fromStatus && isStatus(e.fromStatus)
                    ? `${STATUS_LABELS[e.fromStatus]} → `
                    : "Added as "}
                  <strong className="font-medium">
                    {isStatus(e.toStatus) ? STATUS_LABELS[e.toStatus] : e.toStatus}
                  </strong>
                </span>
                <span className="shrink-0 text-xs text-zinc-500">
                  <LocalTime iso={e.createdAt.toISOString()} />
                </span>
              </li>
            ))}
          </ol>
        </Card>

        {app.resume && (
          <Card className="p-5">
            <h2 className="mb-3 text-sm font-semibold text-zinc-900">Attached resume</h2>
            <p className="text-sm font-medium text-zinc-900">{app.resume.label}</p>
            <p className="text-xs text-zinc-500">
              {app.resume.fileName} · {formatBytes(app.resume.size)}
            </p>
            <a
              href={`/api/resumes/${app.resume.id}`}
              className="mt-3 inline-block text-sm font-medium text-indigo-600 hover:text-indigo-500"
            >
              Download
            </a>
          </Card>
        )}
      </div>
    </>
  );
}
