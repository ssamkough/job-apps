"use client";

import { useActionState, useEffect, useRef } from "react";
import { uploadResume } from "@/app/actions/resumes";
import type { FormState } from "@/lib/form-state";
import { Card, Field, inputClass } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";

export function ResumeUploadForm() {
  const [state, action] = useActionState<FormState, FormData>(uploadResume, {});
  const formRef = useRef<HTMLFormElement>(null);
  const err = state.errors ?? {};

  // The action resets the form on completion; nothing else to do on success
  // besides showing the confirmation below.
  useEffect(() => {
    if (state.message) formRef.current?.reset();
  }, [state]);

  return (
    <Card className="mb-6 p-5">
      <h2 className="mb-4 text-sm font-semibold text-zinc-900">Upload a resume</h2>
      <form
        ref={formRef}
        action={action}
        className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_1.5fr_auto] md:items-start"
      >
        <Field
          label="Label (optional)"
          htmlFor="label"
          error={err.label}
          hint="e.g. Backend – 2026"
        >
          <input id="label" name="label" maxLength={80} className={inputClass} />
        </Field>
        <Field
          label="File"
          htmlFor="file"
          error={err.file}
          hint="PDF, DOC, or DOCX, up to 5 MB."
        >
          <input
            id="file"
            name="file"
            type="file"
            required
            accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            className="block w-full text-sm text-zinc-600 file:mr-3 file:rounded-lg file:border-0 file:bg-zinc-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-zinc-700 hover:file:bg-zinc-200"
          />
        </Field>
        <div className="md:pt-[1.625rem]">
          <SubmitButton pendingText="Uploading…">Upload</SubmitButton>
        </div>
      </form>
      {state.message && (
        <p role="status" className="mt-3 text-sm text-emerald-700">
          {state.message}
        </p>
      )}
    </Card>
  );
}
