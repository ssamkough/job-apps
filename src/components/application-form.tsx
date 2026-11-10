"use client";

import Link from "next/link";
import { useActionState } from "react";
import type { FormState } from "@/lib/form-state";
import {
  STATUSES,
  STATUS_LABELS,
  WORK_TYPES,
  WORK_TYPE_LABELS,
} from "@/lib/constants";
import { Card, Field, inputClass } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";
import { CoverLetterEditor } from "@/components/cover-letter-editor";

export type ApplicationFormValues = {
  company: string;
  jobTitle: string;
  jobUrl: string;
  location: string;
  workType: string;
  salary: string;
  source: string;
  status: string;
  dateApplied: string;
  jobDescription: string;
  notes: string;
  coverLetter: string;
  contactName: string;
  contactEmail: string;
  resumeId: string;
};

export type ResumeOption = { id: string; label: string; fileName: string };

const initialState: FormState = {};

export function ApplicationForm({
  action,
  initial,
  resumes,
  submitLabel,
  saved,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  initial: ApplicationFormValues;
  resumes: ResumeOption[];
  submitLabel: string;
  saved?: boolean;
}) {
  const [state, formAction] = useActionState(action, initialState);
  const err = state.errors ?? {};
  // After a failed submit keep what the user typed; otherwise show saved data.
  const v = (key: keyof ApplicationFormValues) =>
    state.values?.[key] ?? initial[key];

  const invalid = (key: string) => ({
    "aria-invalid": !!err[key],
    "aria-describedby": err[key] ? `${key}-error` : undefined,
  });

  const hasErrors = Object.values(err).some(Boolean);

  return (
    <form action={formAction} className="space-y-6" noValidate>
      {saved && !hasErrors && (
        <div
          role="status"
          className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800"
        >
          Saved.
        </div>
      )}
      {hasErrors && (
        <div
          role="alert"
          className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-700"
        >
          Fix the highlighted fields and try again.
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card className="p-5">
            <h2 className="mb-4 text-sm font-semibold text-zinc-900">Job details</h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Company *" htmlFor="company" error={err.company}>
                <input
                  id="company"
                  name="company"
                  required
                  defaultValue={v("company")}
                  className={inputClass}
                  {...invalid("company")}
                />
              </Field>
              <Field label="Job title *" htmlFor="jobTitle" error={err.jobTitle}>
                <input
                  id="jobTitle"
                  name="jobTitle"
                  required
                  defaultValue={v("jobTitle")}
                  className={inputClass}
                  {...invalid("jobTitle")}
                />
              </Field>
              <Field
                label="Job posting URL"
                htmlFor="jobUrl"
                error={err.jobUrl}
                className="sm:col-span-2"
              >
                <input
                  id="jobUrl"
                  name="jobUrl"
                  type="url"
                  placeholder="https://"
                  defaultValue={v("jobUrl")}
                  className={inputClass}
                  {...invalid("jobUrl")}
                />
              </Field>
              <Field label="Location" htmlFor="location" error={err.location}>
                <input
                  id="location"
                  name="location"
                  defaultValue={v("location")}
                  className={inputClass}
                />
              </Field>
              <Field label="Work type" htmlFor="workType" error={err.workType}>
                <select
                  id="workType"
                  name="workType"
                  defaultValue={v("workType")}
                  className={inputClass}
                >
                  <option value="">Not specified</option>
                  {WORK_TYPES.map((w) => (
                    <option key={w} value={w}>
                      {WORK_TYPE_LABELS[w]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Salary" htmlFor="salary" error={err.salary}>
                <input
                  id="salary"
                  name="salary"
                  placeholder="e.g. $120k–$140k"
                  defaultValue={v("salary")}
                  className={inputClass}
                />
              </Field>
              <Field label="Where you found it" htmlFor="source" error={err.source}>
                <input
                  id="source"
                  name="source"
                  placeholder="e.g. LinkedIn, referral"
                  defaultValue={v("source")}
                  className={inputClass}
                />
              </Field>
              <Field
                label="Job description"
                htmlFor="jobDescription"
                error={err.jobDescription}
                hint="Paste it here. It's used to tailor your AI cover letter."
                className="sm:col-span-2"
              >
                <textarea
                  id="jobDescription"
                  name="jobDescription"
                  rows={6}
                  defaultValue={v("jobDescription")}
                  className={inputClass}
                />
              </Field>
            </div>
          </Card>

          <Card className="p-5">
            <CoverLetterEditor
              defaultValue={v("coverLetter")}
              error={err.coverLetter}
            />
          </Card>

          <Card className="p-5">
            <Field label="Notes" htmlFor="notes" error={err.notes}>
              <textarea
                id="notes"
                name="notes"
                rows={5}
                placeholder="Interview prep, questions to ask, follow-ups…"
                defaultValue={v("notes")}
                className={inputClass}
              />
            </Field>
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="p-5">
            <h2 className="mb-4 text-sm font-semibold text-zinc-900">Status</h2>
            <div className="space-y-4">
              <Field label="Status" htmlFor="status" error={err.status}>
                <select
                  id="status"
                  name="status"
                  defaultValue={v("status")}
                  className={inputClass}
                >
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABELS[s]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Date applied" htmlFor="dateApplied" error={err.dateApplied}>
                <input
                  id="dateApplied"
                  name="dateApplied"
                  type="date"
                  defaultValue={v("dateApplied")}
                  className={inputClass}
                  {...invalid("dateApplied")}
                />
              </Field>
            </div>
          </Card>

          <Card className="p-5">
            <h2 className="mb-4 text-sm font-semibold text-zinc-900">Resume used</h2>
            <div className="space-y-4">
              <Field label="From your resumes" htmlFor="resumeId" error={err.resumeId}>
                <select
                  id="resumeId"
                  name="resumeId"
                  defaultValue={v("resumeId")}
                  className={inputClass}
                >
                  <option value="">None</option>
                  {resumes.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="Or upload a new one"
                htmlFor="resumeFile"
                error={err.resumeFile}
                hint="PDF, DOC, or DOCX, up to 5 MB. Overrides the selection above."
              >
                <input
                  id="resumeFile"
                  name="resumeFile"
                  type="file"
                  accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  className="block w-full text-sm text-zinc-600 file:mr-3 file:rounded-lg file:border-0 file:bg-zinc-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-zinc-700 hover:file:bg-zinc-200"
                />
              </Field>
            </div>
          </Card>

          <Card className="p-5">
            <h2 className="mb-4 text-sm font-semibold text-zinc-900">Contact</h2>
            <div className="space-y-4">
              <Field label="Name" htmlFor="contactName" error={err.contactName}>
                <input
                  id="contactName"
                  name="contactName"
                  defaultValue={v("contactName")}
                  className={inputClass}
                />
              </Field>
              <Field label="Email" htmlFor="contactEmail" error={err.contactEmail}>
                <input
                  id="contactEmail"
                  name="contactEmail"
                  type="email"
                  defaultValue={v("contactEmail")}
                  className={inputClass}
                  {...invalid("contactEmail")}
                />
              </Field>
            </div>
          </Card>
        </div>
      </div>

      <div className="sticky bottom-0 -mx-4 flex items-center justify-end gap-3 border-t border-zinc-200 bg-background/90 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:mx-0 lg:rounded-xl lg:border">
        <Link
          href="/applications"
          className="rounded-lg px-3.5 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100"
        >
          Cancel
        </Link>
        <SubmitButton>{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}
