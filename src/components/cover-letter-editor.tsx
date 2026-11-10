"use client";

import { useRef, useState } from "react";
import { Button, Field, inputClass } from "@/components/ui";

/**
 * Cover letter textarea with an AI drafting helper. The textarea is
 * uncontrolled (so it submits with the surrounding form and resets correctly
 * after a failed save); the AI request is built from that form's fields.
 */
export function CoverLetterEditor({
  defaultValue,
  error,
}: {
  defaultValue: string;
  error?: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [open, setOpen] = useState(false);
  const [instructions, setInstructions] = useState("");
  const [revise, setRevise] = useState(false);
  const [canRevise, setCanRevise] = useState(false);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [previous, setPrevious] = useState<string | null>(null);

  async function generate() {
    const textarea = textareaRef.current;
    if (!textarea?.form) return;

    setLoading(true);
    setProblem(null);
    setNotice(null);

    try {
      const body = new FormData(textarea.form);
      body.set("instructions", instructions);
      if (!revise) body.delete("coverLetter");

      const res = await fetch("/api/cover-letter", { method: "POST", body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Something went wrong.");

      setPrevious(textarea.value);
      textarea.value = data.letter;
      textarea.focus();

      setNotice(
        data.resumeUsed
          ? "Drafted using your resume. Review and edit before sending."
          : data.resumeSkipped
            ? "Drafted without your resume (it couldn't be read: scanned PDFs and old .doc files aren't supported). Review and edit before sending."
            : "Drafted without a resume. Choose a PDF or DOCX resume for a more personal letter.",
      );
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  function undo() {
    if (textareaRef.current && previous !== null) {
      textareaRef.current.value = previous;
      setPrevious(null);
      setNotice(null);
    }
  }

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <label htmlFor="coverLetter" className="block text-sm font-medium text-zinc-700">
          Cover letter
        </label>
        <div className="flex items-center gap-2">
          {previous !== null && (
            <Button variant="ghost" className="px-2 py-1 text-xs" onClick={undo}>
              Undo AI draft
            </Button>
          )}
          <Button
            variant="secondary"
            className="px-2.5 py-1 text-xs"
            aria-expanded={open}
            onClick={() => {
              const has = !!textareaRef.current?.value.trim();
              setCanRevise(has);
              setRevise(has);
              setOpen((o) => !o);
            }}
          >
            ✨ Write with AI
          </Button>
        </div>
      </div>

      {open && (
        <div className="mb-3 space-y-3 rounded-lg border border-indigo-200 bg-indigo-50/50 p-3">
          <p className="text-xs text-zinc-600">
            Uses the company, job title, job description, and the resume you&apos;ve
            selected (PDF or DOCX) from this form.
          </p>
          <Field label="Anything to emphasize? (optional)" htmlFor="ai-instructions">
            <input
              id="ai-instructions"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              maxLength={1000}
              placeholder="e.g. Keep it short. Mention my leadership experience."
              className={inputClass}
            />
          </Field>
          {canRevise && (
            <label className="flex items-center gap-2 text-sm text-zinc-700">
              <input
                type="checkbox"
                checked={revise}
                onChange={(e) => setRevise(e.target.checked)}
                className="rounded border-zinc-300"
              />
              Revise my current draft instead of starting over
            </label>
          )}
          <div className="flex items-center gap-3">
            <Button onClick={generate} disabled={loading}>
              {loading ? "Writing…" : "Generate draft"}
            </Button>
            {loading && (
              <span className="text-xs text-zinc-500" aria-live="polite">
                Running on a local model: this can take a minute or two.
              </span>
            )}
          </div>
          {problem && (
            <p role="alert" className="text-sm text-rose-600">
              {problem}
            </p>
          )}
        </div>
      )}

      <textarea
        ref={textareaRef}
        id="coverLetter"
        name="coverLetter"
        rows={14}
        defaultValue={defaultValue}
        maxLength={10000}
        placeholder="Write your cover letter here, or let AI draft one."
        aria-invalid={!!error}
        className={inputClass}
      />
      {notice && (
        <p className="mt-1.5 text-xs text-zinc-500" aria-live="polite">
          {notice}
        </p>
      )}
      {error && <p role="alert" className="mt-1.5 text-xs text-rose-600">{error}</p>}
    </div>
  );
}
