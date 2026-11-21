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
import { AI_PAUSED_MESSAGE } from "@/lib/ai-budget";

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

type DraftResponse = {
  draft?: string;
  error?: string;
  resumeUsed?: boolean;
  resumeSkipped?: boolean;
  application?: { company: string; jobTitle: string } | null;
  usedMostRecent?: boolean;
};

function draftNotice(data: DraftResponse) {
  const app = data.application;
  const where = app ? `${app.company} · ${app.jobTitle}` : null;
  const review = "Review and edit before saving.";
  if (data.usedMostRecent && where) {
    const resume = data.resumeUsed
      ? " Your resume for that application was included."
      : data.resumeSkipped
        ? " Its resume couldn't be read (scanned PDFs and old .doc files aren't supported)."
        : "";
    return `Drafted from your most recently updated application (${where}).${resume} ${review}`;
  }
  if (where && data.resumeUsed) {
    return `Drafted using your resume for ${where}. ${review}`;
  }
  if (where && data.resumeSkipped) {
    return `Drafted for ${where} without your resume (it couldn't be read: scanned PDFs and old .doc files aren't supported). ${review}`;
  }
  if (where) return `Drafted for ${where} without a resume. ${review}`;
  return `Drafted from the question alone. ${review}`;
}

/**
 * One variant: a name and the answer text. Used both to add a variant (the
 * form clears itself after a successful add) and to edit an existing one.
 * When `aiEnabled` and `questionId` are set, a draft can be written into the
 * answer box. It is not saved until the person submits the form.
 */
export function AnswerForm({
  action,
  id,
  label = "",
  body = "",
  submitLabel,
  actions,
  aiEnabled = false,
  aiPaused = false,
  questionId,
}: {
  action: Action;
  /** Unique per form on the page, for label/input association. */
  id: string;
  label?: string;
  body?: string;
  submitLabel: string;
  /** Extra buttons next to Save (copy, delete). */
  actions?: React.ReactNode;
  /** When false this is a plain answer form: no AI button and no request. */
  aiEnabled?: boolean;
  /** The monthly budget is used up. The button stays hidden until next month. */
  aiPaused?: boolean;
  /** The saved question a draft is written for. Required for the AI button. */
  questionId?: string;
}) {
  const [state, formAction] = useActionState(action, initial);
  const err = state.errors ?? {};
  const canDraft = aiEnabled && !aiPaused && !!questionId;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sourceRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [previous, setPrevious] = useState<{ text: string; source: string } | null>(null);

  async function draft() {
    const textarea = textareaRef.current;
    if (!textarea || !questionId) return;

    setLoading(true);
    setProblem(null);
    setNotice(null);

    try {
      const body = new FormData();
      body.set("questionId", questionId);
      const res = await fetch("/api/answer-draft", { method: "POST", body });
      const data = (await res.json().catch(() => ({}))) as DraftResponse;
      if (!res.ok) throw new Error(data.error ?? "Something went wrong.");
      if (!data.draft) throw new Error("Couldn't generate a draft right now. Please try again.");

      setPrevious({ text: textarea.value, source: sourceRef.current?.value ?? "" });
      textarea.value = data.draft;
      if (sourceRef.current) sourceRef.current.value = "AI";
      textarea.focus();
      setNotice(draftNotice(data));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  function undo() {
    if (textareaRef.current && previous) {
      textareaRef.current.value = previous.text;
      if (sourceRef.current) sourceRef.current.value = previous.source;
      setPrevious(null);
      setNotice(null);
    }
  }

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
      {canDraft ? (
        <input type="hidden" name="source" ref={sourceRef} defaultValue={state.values?.source === "AI" ? "AI" : ""} />
      ) : null}
      <div>
        <div className="mb-1.5 flex items-center justify-between gap-3">
          <label htmlFor={`${id}-body`} className="block text-sm font-medium text-zinc-700">
            Answer
          </label>
          {aiEnabled && aiPaused && questionId && (
            <p className="text-xs text-zinc-500">{AI_PAUSED_MESSAGE}</p>
          )}
          {canDraft && (
            <div className="flex items-center gap-2">
              {previous !== null && (
                <Button variant="ghost" className="px-2 py-1 text-xs" onClick={undo}>
                  Undo AI draft
                </Button>
              )}
              <Button
                variant="secondary"
                className="px-2.5 py-1 text-xs"
                onClick={draft}
                disabled={loading}
              >
                {loading ? "Drafting…" : "Draft with AI"}
              </Button>
            </div>
          )}
        </div>
        <textarea
          ref={textareaRef}
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
        {canDraft && loading && (
          <p className="mt-1.5 text-xs text-zinc-500" aria-live="polite">
            This can take a minute or two.
          </p>
        )}
        {canDraft && notice && (
          <p className="mt-1.5 text-xs text-zinc-500" aria-live="polite">
            {notice}
          </p>
        )}
        {canDraft && problem && (
          <p role="alert" className="mt-1.5 text-sm text-rose-600">
            {problem}
          </p>
        )}
        {err.body && (
          <p id={`${id}-body-error`} role="alert" className="mt-1.5 text-xs text-rose-600">
            {err.body}
          </p>
        )}
      </div>
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
