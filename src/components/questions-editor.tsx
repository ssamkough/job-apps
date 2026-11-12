"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import {
  MAX_QUESTIONS_PER_APPLICATION,
  MAX_QUESTION_CHARS,
  cleanQuestionText,
  questionKey,
} from "@/lib/questions";
import { Button, inputClass } from "@/components/ui";

export type LibraryOption = {
  id: string;
  text: string;
  answers: Array<{ id: string; label: string | null; preview: string }>;
};

export type EditorItem = {
  questionId: string | null;
  text: string;
  answerId: string | null;
  source: "MANUAL" | "IMPORT";
};

/** Events the import box uses to add (and take back) questions it found. */
export const IMPORT_QUESTIONS_EVENT = "job-import-questions";
export const IMPORT_QUESTIONS_UNDO_EVENT = "job-import-questions-undo";

type Row = EditorItem & { uid: number };

// Row keys only need to be unique; they never appear in the page itself.
let lastRowId = 0;
const nextUid = () => ++lastRowId;

/**
 * The questions attached to an application. The list lives in React state and
 * is sent with the form as one hidden JSON field; the server re-checks all of
 * it (ownership, limits), so nothing here is trusted.
 */
export function QuestionsEditor({
  library,
  initial,
  error,
}: {
  library: LibraryOption[];
  initial: EditorItem[];
  error?: string;
}) {
  const [rows, setRows] = useState<Row[]>(() => initial.map((i) => ({ ...i, uid: nextUid() })));
  const [pick, setPick] = useState("");
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const byId = new Map(library.map((q) => [q.id, q]));
  const byKey = new Map(library.map((q) => [questionKey(q.text), q]));

  const full = rows.length >= MAX_QUESTIONS_PER_APPLICATION;
  const attachedIds = new Set(rows.map((r) => r.questionId).filter(Boolean));
  const attachedKeys = new Set(rows.map((r) => questionKey(r.text)));
  const available = library.filter((q) => !attachedIds.has(q.id));

  function add(texts: string[], source: "MANUAL" | "IMPORT") {
    setRows((current) => {
      const next = [...current];
      const keys = new Set(next.map((r) => questionKey(r.text)));
      for (const raw of texts) {
        if (next.length >= MAX_QUESTIONS_PER_APPLICATION) break;
        const text = cleanQuestionText(raw);
        const key = questionKey(text);
        if (!key || keys.has(key)) continue;
        keys.add(key);
        // A question already in the library is attached as that question.
        const known = byKey.get(key);
        next.push({
          uid: nextUid(),
          questionId: known?.id ?? null,
          text: known?.text ?? text,
          answerId: null,
          source,
        });
      }
      return next;
    });
  }

  // The import box (outside this component) hands over what it found.
  const addRef = useRef(add);
  useEffect(() => {
    addRef.current = add;
  });
  useEffect(() => {
    const form = root.current?.closest("form");
    if (!form) return;
    const onAdd = (e: Event) => addRef.current((e as CustomEvent<{ questions: string[] }>).detail.questions, "IMPORT");
    const onUndo = (e: Event) => {
      const keys = new Set((e as CustomEvent<{ questions: string[] }>).detail.questions.map(questionKey));
      setRows((current) => current.filter((r) => !(r.source === "IMPORT" && keys.has(questionKey(r.text)))));
    };
    form.addEventListener(IMPORT_QUESTIONS_EVENT, onAdd);
    form.addEventListener(IMPORT_QUESTIONS_UNDO_EVENT, onUndo);
    return () => {
      form.removeEventListener(IMPORT_QUESTIONS_EVENT, onAdd);
      form.removeEventListener(IMPORT_QUESTIONS_UNDO_EVENT, onUndo);
    };
  }, []);

  function addTyped() {
    const text = cleanQuestionText(typed);
    if (text.length < 3) return setProblem("Write the question (at least a few words).");
    if (attachedKeys.has(questionKey(text))) return setProblem("That question is already on this application.");
    setProblem(null);
    add([text], "MANUAL");
    setTyped("");
  }

  function addPicked() {
    const q = byId.get(pick);
    if (!q) return;
    setProblem(null);
    setRows((current) => [
      ...current,
      { uid: nextUid(), questionId: q.id, text: q.text, answerId: null, source: "MANUAL" },
    ]);
    setPick("");
  }

  const payload = JSON.stringify(
    rows.map((r) => ({
      // Existing questions go by id; new ones by text (the server finds or makes them).
      ...(r.questionId ? { questionId: r.questionId } : { text: r.text }),
      answerId: r.answerId,
      source: r.source,
    })),
  );

  return (
    <div ref={root}>
      <input type="hidden" name="questions" value={payload} />
      <h2 id={headingId} className="text-sm font-semibold text-zinc-900">
        Application questions
      </h2>
      <p className="mt-1 text-xs text-zinc-500">
        Questions this application asks. Pick which of your saved answers you used or plan to use.
      </p>

      {error && (
        <p role="alert" className="mt-2 text-xs text-rose-600">
          {error}
        </p>
      )}

      {rows.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-zinc-300 px-3 py-4 text-sm text-zinc-500">
          No questions yet. Add one below, or import a posting to find the ones it asks.
        </p>
      ) : (
        <ul className="mt-4 space-y-3" aria-labelledby={headingId}>
          {rows.map((row) => {
            const lib = row.questionId ? byId.get(row.questionId) : undefined;
            return (
              <li key={row.uid} className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-3">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm font-medium text-zinc-900">{row.text}</p>
                  <button
                    type="button"
                    onClick={() => setRows((c) => c.filter((r) => r.uid !== row.uid))}
                    aria-label={`Remove question: ${row.text}`}
                    className="-mr-1 -mt-1 shrink-0 rounded-md px-2 py-1 text-sm text-zinc-600 hover:bg-zinc-200 hover:text-zinc-900"
                  >
                    Remove
                  </button>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
                  {row.source === "IMPORT" && !row.questionId && (
                    <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-inset ring-amber-200">
                      Found on the posting
                    </span>
                  )}
                  {lib && lib.answers.length > 0 ? (
                    <select
                      aria-label={`Answer to use for: ${row.text}`}
                      value={row.answerId ?? ""}
                      onChange={(e) =>
                        setRows((c) =>
                          c.map((r) => (r.uid === row.uid ? { ...r, answerId: e.target.value || null } : r)),
                        )
                      }
                      className={`${inputClass} max-w-md`}
                    >
                      <option value="">No answer chosen</option>
                      {lib.answers.map((a, i) => (
                        <option key={a.id} value={a.id}>
                          {(a.label || `Variant ${i + 1}`) + " — " + a.preview.replace(/\s+/g, " ")}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-xs text-zinc-500">
                      {row.questionId
                        ? "No answers saved yet."
                        : "Saved to your questions with this application; add answers afterwards."}
                    </span>
                  )}
                  {row.questionId && (
                    <Link
                      href={`/questions/${row.questionId}`}
                      target="_blank"
                      rel="noopener"
                      className="text-xs font-medium text-indigo-700 hover:text-indigo-600"
                    >
                      Manage answers<span className="sr-only"> for {row.text} (opens in a new tab)</span> ↗
                    </Link>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-4 space-y-3 border-t border-zinc-100 pt-4">
        {available.length > 0 && (
          <div className="flex flex-col gap-2 sm:flex-row">
            <select
              aria-label="Add one of your saved questions"
              value={pick}
              onChange={(e) => setPick(e.target.value)}
              disabled={full}
              className={inputClass}
            >
              <option value="">Add one of your saved questions…</option>
              {available.map((q) => (
                <option key={q.id} value={q.id}>
                  {q.text.length > 90 ? `${q.text.slice(0, 90)}…` : q.text}
                </option>
              ))}
            </select>
            <Button variant="secondary" onClick={addPicked} disabled={!pick || full} className="sm:shrink-0">
              Attach
            </Button>
          </div>
        )}
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            aria-label="Type a new question"
            placeholder="Or type a new question, e.g. Why do you want to work here?"
            value={typed}
            maxLength={MAX_QUESTION_CHARS}
            disabled={full}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              // Enter adds the question; it must not submit the whole application.
              if (e.key === "Enter") {
                e.preventDefault();
                addTyped();
              }
            }}
            className={inputClass}
          />
          <Button variant="secondary" onClick={addTyped} disabled={!typed.trim() || full} className="sm:shrink-0">
            Attach question
          </Button>
        </div>
        {full && (
          <p className="text-xs text-zinc-500">An application can have up to {MAX_QUESTIONS_PER_APPLICATION} questions.</p>
        )}
        <p role="alert" className="min-h-0 text-xs text-rose-600">
          {problem}
        </p>
      </div>
    </div>
  );
}
