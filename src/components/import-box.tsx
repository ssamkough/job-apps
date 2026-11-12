"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Card, inputClass } from "@/components/ui";
import { IMPORT_QUESTIONS_EVENT, IMPORT_QUESTIONS_UNDO_EVENT } from "@/components/questions-editor";
import { IMPORT_FIELD_KEYS, type ImportFieldKey, type ImportFields } from "@/lib/import/fields";

type Mode = "url" | "file" | "text";

type Outcome = {
  status: "done" | "queued" | "failed" | "expired";
  jobId: string;
  fields?: ImportFields;
  questions?: string[];
  notice?: string;
  error?: string;
};

type Filled = { key: ImportFieldKey; before: string };

const LABELS: Record<ImportFieldKey, string> = {
  company: "company",
  jobTitle: "job title",
  jobUrl: "link",
  location: "location",
  workType: "work type",
  salary: "salary",
  source: "source",
  jobDescription: "description",
};

const MODES: Array<{ id: Mode; label: string }> = [
  { id: "url", label: "Link" },
  { id: "file", label: "PDF" },
  { id: "text", label: "Paste text" },
];

// Marks a field the importer filled so it's easy to review.
const MARK = ["border-amber-300", "bg-amber-50"];

/** Poll every few seconds; give up a little after the server would. */
const POLL_MS = 3_000;
const POLL_GIVE_UP_MS = 16 * 60_000;

type FormControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

function control(form: HTMLFormElement, key: string) {
  const el = form.elements.namedItem(key);
  return el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
    ? (el as FormControl)
    : null;
}

/**
 * "Import from a job posting": reads a link, PDF or pasted text on the server
 * and fills the blank fields of the form below it. It never overwrites what
 * the person already typed, marks what it filled, and can undo it.
 */
export function ImportBox({
  formId,
  queueAvailable,
}: {
  /** The application form to fill. */
  formId: string;
  /** Whether pages without structured data can go to the AI worker. */
  queueAvailable: boolean;
}) {
  const [mode, setMode] = useState<Mode>("url");
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filled, setFilled] = useState<Filled[] | null>(null);
  const [kept, setKept] = useState<ImportFieldKey[]>([]);
  // Application questions found on the posting, which ones are ticked, and
  // which were added to the form (so they can be taken back).
  const [found, setFound] = useState<string[]>([]);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState<string[] | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const ready =
    (mode === "url" && url.trim().length > 0) ||
    (mode === "file" && file !== null) ||
    (mode === "text" && text.trim().length > 0);

  function apply(fields: ImportFields) {
    const form = document.getElementById(formId);
    if (!(form instanceof HTMLFormElement)) return;
    const done: Filled[] = [];
    const skipped: ImportFieldKey[] = [];

    for (const key of IMPORT_FIELD_KEYS) {
      const value = fields[key];
      const el = control(form, key);
      if (!value || !el) continue;
      // Only blank fields: never replace what the person typed.
      if (el.value.trim() && el.value !== value) {
        skipped.push(key);
        continue;
      }
      if (el.value === value) continue;
      done.push({ key, before: el.value });
      el.value = value;
      el.classList.add(...MARK);
      // The mark goes away once the person edits the field themselves.
      el.addEventListener("input", () => el.classList.remove(...MARK), { once: true });
    }
    setFilled(done);
    setKept(skipped);
  }

  function undo() {
    const form = document.getElementById(formId);
    if (!(form instanceof HTMLFormElement) || !filled) return;
    for (const { key, before } of filled) {
      const el = control(form, key);
      if (!el) continue;
      el.value = before;
      el.classList.remove(...MARK);
    }
    setFilled(null);
    setKept([]);
    setNotice(null);
  }

  function sendQuestions(type: string, questions: string[]) {
    const form = document.getElementById(formId);
    form?.dispatchEvent(new CustomEvent(type, { detail: { questions } }));
  }

  function addQuestions() {
    const chosen = found.filter((q) => ticked.has(q));
    if (chosen.length === 0) return;
    sendQuestions(IMPORT_QUESTIONS_EVENT, chosen);
    // `found` stays, so Undo can offer the whole list again.
    setAdded(chosen);
  }

  function undoQuestions() {
    if (!added) return;
    sendQuestions(IMPORT_QUESTIONS_UNDO_EVENT, added);
    setAdded(null);
  }

  function finish(outcome: Outcome) {
    setBusy(false);
    setWaiting(false);
    if (outcome.fields) apply(outcome.fields);
    const questions = outcome.questions ?? [];
    setFound(questions);
    setTicked(new Set(questions));
    setAdded(null);
    if (outcome.status === "done") setNotice(outcome.notice ?? null);
    else setProblem(outcome.error ?? "Couldn't import that posting.");
  }

  function poll(jobId: string, startedAt: number) {
    timer.current = setTimeout(async () => {
      if (!alive.current) return;
      try {
        const res = await fetch(`/api/import/${jobId}`, { cache: "no-store" });
        const data: Outcome = await res.json();
        if (!alive.current) return;
        if (res.ok && data.status === "queued") {
          if (Date.now() - startedAt > POLL_GIVE_UP_MS) {
            setBusy(false);
            setWaiting(false);
            setProblem("This is taking too long. Try again, or paste the text instead.");
            return;
          }
          return poll(jobId, startedAt);
        }
        if (!res.ok) throw new Error();
        finish(data);
      } catch {
        if (!alive.current) return;
        // A dropped connection shouldn't end the wait; try again shortly.
        if (Date.now() - startedAt > POLL_GIVE_UP_MS) {
          setBusy(false);
          setWaiting(false);
          setProblem("Lost track of this import. Try again.");
        } else poll(jobId, startedAt);
      }
    }, POLL_MS);
  }

  async function run() {
    setBusy(true);
    setWaiting(false);
    setProblem(null);
    setNotice(null);
    setFilled(null);
    setKept([]);
    setFound([]);
    setAdded(null);

    const body = new FormData();
    if (mode === "url") body.set("url", url.trim());
    if (mode === "text") body.set("text", text);
    if (mode === "file" && file) body.set("file", file);

    try {
      const res = await fetch("/api/import", { method: "POST", body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Couldn't import that posting.");
      if ((data as Outcome).status === "queued") {
        setWaiting(true);
        poll((data as Outcome).jobId, Date.now());
        return;
      }
      finish(data as Outcome);
    } catch (e) {
      setBusy(false);
      setProblem(e instanceof Error ? e.message : "Couldn't import that posting.");
    }
  }

  return (
    <Card className="mb-6 p-5" data-testid="import-box">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900">Import from a job posting</h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            Fills in the blank fields below. Review them before saving.
          </p>
        </div>
        <div role="tablist" aria-label="Import source" className="flex rounded-lg bg-zinc-100 p-0.5">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={mode === m.id}
              disabled={busy}
              onClick={() => setMode(m.id)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors disabled:opacity-60 ${
                mode === m.id ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-600 hover:text-zinc-900"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          {mode === "url" && (
            <input
              aria-label="Job posting link"
              type="url"
              inputMode="url"
              placeholder="https://company.com/careers/software-engineer"
              value={url}
              disabled={busy}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && ready && !busy) {
                  e.preventDefault();
                  void run();
                }
              }}
              className={inputClass}
            />
          )}
          {mode === "file" && (
            <input
              aria-label="Job posting PDF"
              type="file"
              accept=".pdf,application/pdf"
              disabled={busy}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm text-zinc-600 file:mr-3 file:rounded-lg file:border-0 file:bg-zinc-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-zinc-700 hover:file:bg-zinc-200"
            />
          )}
          {mode === "text" && (
            <textarea
              aria-label="Job posting text"
              rows={5}
              placeholder="Paste the whole posting here"
              value={text}
              disabled={busy}
              onChange={(e) => setText(e.target.value)}
              className={inputClass}
            />
          )}
        </div>
        <Button onClick={() => void run()} disabled={!ready || busy} className="sm:shrink-0">
          {busy ? (waiting ? "Waiting…" : "Reading…") : "Import"}
        </Button>
      </div>

      <div aria-live="polite" className="mt-3 space-y-2 text-sm">
        {waiting && (
          <p className="text-zinc-600">
            Reading the posting in the background. This can take a minute or two. Keep filling in the
            form; the blank fields are filled when it&apos;s done.
          </p>
        )}
        {problem && (
          <p role="alert" className="text-rose-700">
            {problem}
          </p>
        )}
        {filled && (
          <div
            role="status"
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-800"
          >
            <span>
              {filled.length > 0
                ? `Filled in ${filled.map((f) => LABELS[f.key]).join(", ")}.`
                : "Nothing new to fill in."}
              {kept.length > 0 && ` Kept your ${kept.map((k) => LABELS[k]).join(", ")}.`}
            </span>
            {filled.length > 0 && (
              <button type="button" onClick={undo} className="font-medium underline">
                Undo
              </button>
            )}
          </div>
        )}
        {found.length > 0 && !added && (
          <fieldset className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-3">
            <legend className="px-1 text-sm font-medium text-zinc-900">
              This application asks {found.length === 1 ? "a question" : `${found.length} questions`}
            </legend>
            <ul className="mt-1 space-y-1.5">
              {found.map((q) => (
                <li key={q}>
                  <label className="flex items-start gap-2 text-zinc-800">
                    <input
                      type="checkbox"
                      checked={ticked.has(q)}
                      onChange={(e) =>
                        setTicked((cur) => {
                          const next = new Set(cur);
                          if (e.target.checked) next.add(q);
                          else next.delete(q);
                          return next;
                        })
                      }
                      className="mt-1 size-4 shrink-0 accent-indigo-700"
                    />
                    <span>{q}</span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="mt-3">
              <Button variant="secondary" onClick={addQuestions} disabled={ticked.size === 0}>
                Attach selected to this application
              </Button>
            </div>
          </fieldset>
        )}
        {added && (
          <div
            role="status"
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-800"
          >
            <span>
              Attached {added.length === 1 ? "1 question" : `${added.length} questions`} to this application.
            </span>
            <button type="button" onClick={undoQuestions} aria-label="Undo attaching questions" className="font-medium underline">
              Undo
            </button>
          </div>
        )}
        {notice && <p className="text-zinc-600">{notice}</p>}
        {!queueAvailable && mode === "url" && !busy && !problem && !filled && (
          <p className="text-xs text-zinc-500">
            Works best with job boards that publish structured data. Otherwise you&apos;ll get the
            page text as the description.
          </p>
        )}
      </div>
    </Card>
  );
}
