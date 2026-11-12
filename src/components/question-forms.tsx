"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import type { FormState } from "@/lib/form-state";
import {
  MAX_ANSWER_CHARS,
  MAX_LABEL_CHARS,
  MAX_QUESTION_CHARS,
} from "@/lib/questions";
import { Button, Field, inputClass } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;
const initial: FormState = {};

/** Adds a question, optionally with a first answer. */
export function CreateQuestionForm({ action }: { action: Action }) {
  const [state, formAction] = useActionState(action, initial);
  const err = state.errors ?? {};
  const v = (k: string) => state.values?.[k] ?? "";

  return (
    <form action={formAction} className="mb-6 rounded-xl border border-zinc-200 bg-white p-5 shadow-sm" noValidate>
      <h2 className="mb-4 text-sm font-semibold text-zinc-900">Add a question</h2>
      <div className="space-y-4">
        <Field
          label="Question"
          htmlFor="new-question-text"
          error={err.text}
          hint="Paste it as it appears on the application, e.g. “Why do you want to work here?”"
        >
          <textarea
            id="new-question-text"
            name="text"
            rows={2}
            required
            maxLength={MAX_QUESTION_CHARS}
            defaultValue={v("text")}
            className={inputClass}
            aria-invalid={!!err.text}
            aria-describedby={err.text ? "new-question-text-error" : undefined}
          />
        </Field>
        <details className="group" open={!!(v("body") || err.body || err.label)}>
          <summary className="cursor-pointer text-sm font-medium text-indigo-700 hover:text-indigo-600">
            Add a first answer (optional)
          </summary>
          <div className="mt-3 space-y-4">
            <Field label="Variant name" htmlFor="new-answer-label" error={err.label} hint="Optional, e.g. “Short” or “For startups”.">
              <input
                id="new-answer-label"
                name="label"
                maxLength={MAX_LABEL_CHARS}
                defaultValue={v("label")}
                className={inputClass}
              />
            </Field>
            <Field label="Answer" htmlFor="new-answer-body" error={err.body}>
              <textarea
                id="new-answer-body"
                name="body"
                rows={5}
                maxLength={MAX_ANSWER_CHARS}
                defaultValue={v("body")}
                className={inputClass}
              />
            </Field>
          </div>
        </details>
        <div className="flex justify-end">
          <SubmitButton pendingText="Adding…">Add question</SubmitButton>
        </div>
      </div>
    </form>
  );
}

/** Edits the wording of a question. */
export function QuestionTextForm({ action, text }: { action: Action; text: string }) {
  const [state, formAction] = useActionState(action, initial);
  const err = state.errors ?? {};
  return (
    <form action={formAction} className="space-y-3" noValidate>
      <Field label="Question" htmlFor="question-text" error={err.text}>
        <textarea
          id="question-text"
          name="text"
          rows={3}
          required
          maxLength={MAX_QUESTION_CHARS}
          defaultValue={state.values?.text ?? text}
          className={inputClass}
          aria-invalid={!!err.text}
          aria-describedby={err.text ? "question-text-error" : undefined}
        />
      </Field>
      <div className="flex items-center justify-end gap-3">
        {state.ok && <span role="status" className="text-sm text-emerald-700">{state.message}</span>}
        <SubmitButton pendingText="Saving…">Save question</SubmitButton>
      </div>
    </form>
  );
}

/**
 * One variant: a name and the answer text. Used both to add a variant (the
 * form clears itself after a successful add) and to edit an existing one.
 */
export function AnswerForm({
  action,
  id,
  label = "",
  body = "",
  submitLabel,
  actions,
}: {
  action: Action;
  /** Unique per form on the page, for label/input association. */
  id: string;
  label?: string;
  body?: string;
  submitLabel: string;
  /** Extra buttons next to Save (copy, delete). */
  actions?: React.ReactNode;
}) {
  const [state, formAction] = useActionState(action, initial);
  const err = state.errors ?? {};
  return (
    <form action={formAction} className="space-y-3" noValidate>
      <Field label="Variant name" htmlFor={`${id}-label`} error={err.label}>
        <input
          id={`${id}-label`}
          name="label"
          maxLength={MAX_LABEL_CHARS}
          placeholder="Optional, e.g. Short"
          defaultValue={state.values?.label ?? label}
          className={inputClass}
        />
      </Field>
      <Field label="Answer" htmlFor={`${id}-body`} error={err.body}>
        <textarea
          id={`${id}-body`}
          name="body"
          rows={6}
          required
          maxLength={MAX_ANSWER_CHARS}
          defaultValue={state.values?.body ?? body}
          className={inputClass}
          aria-invalid={!!err.body}
          aria-describedby={err.body ? `${id}-body-error` : undefined}
        />
      </Field>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {state.ok && <span role="status" className="mr-auto text-sm text-emerald-700">{state.message}</span>}
        {actions}
        <SubmitButton pendingText="Saving…">{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}

/** Copies text to the clipboard, so an answer can be pasted into a real application. */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  return (
    <>
      <Button
        variant="secondary"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 2000);
          } catch {
            // Clipboard can be blocked (permissions, insecure context); nothing to do.
          }
        }}
      >
        {copied ? "Copied" : label}
      </Button>
      <span role="status" className="sr-only">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </>
  );
}
