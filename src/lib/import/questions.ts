import "server-only";
import { parse, type HTMLElement } from "node-html-parser";
import { sanitizeQuestionList } from "@/lib/questions";
import { fetchPage, type FetchedPage } from "./safe-fetch";

/**
 * Finds the questions a job application asks (beyond the usual name, email and
 * resume fields). Best-effort by design: every path swallows its own failure,
 * so a missing question list never fails an import.
 *
 * Order of preference:
 *  1. Greenhouse's public board API (exact, includes optional questions).
 *     That call lives in `boards.ts`, which reads the whole posting at once;
 *     this file keeps the Greenhouse parsing helpers it uses.
 *  2. Lever's apply page, whose custom questions are marked up as such.
 *  3. Labelled fields of any application form on the page itself.
 */

const STEP_TIMEOUT_MS = 5_000;
/** Lever apply pages run well over 700 KB. */
const LEVER_MAX_BYTES = 4 * 1024 * 1024;

// ---- Greenhouse -------------------------------------------------------------

const GREENHOUSE_HOSTS: Record<string, string> = {
  "boards.greenhouse.io": "https://boards-api.greenhouse.io",
  "job-boards.greenhouse.io": "https://boards-api.greenhouse.io",
  "boards.eu.greenhouse.io": "https://boards-api.eu.greenhouse.io",
  "job-boards.eu.greenhouse.io": "https://boards-api.eu.greenhouse.io",
};
const TOKEN = /^[A-Za-z0-9_-]{1,64}$/;
const JOB_ID = /^\d{1,15}$/;

/** The board and job a page belongs to, from its URL or an embedded script. */
export function greenhouseRef(
  page: { html: string; finalUrl: string },
): { api: string; token: string; jobId: string } | null {
  let url: URL;
  try {
    url = new URL(page.finalUrl);
  } catch {
    return null;
  }

  const hosted = GREENHOUSE_HOSTS[url.hostname];
  if (hosted) {
    const m = /^\/(?:embed\/job_app\/?)?([^/]+)\/jobs\/(\d+)/.exec(url.pathname);
    const token = m?.[1] ?? url.searchParams.get("for");
    const jobId = m?.[2] ?? url.searchParams.get("token");
    if (token && jobId && TOKEN.test(token) && JOB_ID.test(jobId)) return { api: hosted, token, jobId };
    return null;
  }

  // A company's own careers page embedding a Greenhouse board: ?gh_jid=123
  // plus a script naming the board.
  const jobId = url.searchParams.get("gh_jid");
  if (!jobId || !JOB_ID.test(jobId)) return null;
  const embed = /greenhouse\.io\/embed\/job_(?:board|app)(?:\/js)?\?[^"'\s>]*?\bfor=([A-Za-z0-9_-]{1,64})/.exec(
    page.html,
  );
  if (!embed) return null;
  const eu = /\.eu\.greenhouse\.io/.test(page.html);
  return {
    api: eu ? "https://boards-api.eu.greenhouse.io" : "https://boards-api.greenhouse.io",
    token: embed[1],
    jobId,
  };
}

type GreenhouseQuestion = { label?: unknown; fields?: Array<{ type?: unknown }> };

export function greenhouseQuestions(data: unknown): string[] {
  if (!data || typeof data !== "object") return [];
  const raw = (data as { questions?: unknown }).questions;
  if (!Array.isArray(raw)) return [];
  const labels = (raw as GreenhouseQuestion[])
    .filter((q) => q && typeof q === "object")
    // File uploads (resume, cover letter, portfolio) aren't questions to answer.
    .filter((q) => !(q.fields ?? []).every((f) => f?.type === "input_file"))
    .map((q) => q.label);
  return sanitizeQuestionList(labels);
}

// ---- Lever ------------------------------------------------------------------

const LEVER_HOSTS = new Set(["jobs.lever.co", "jobs.eu.lever.co"]);

/** The apply page for a Lever posting URL, or null if it isn't one. */
export function leverApplyUrl(finalUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(finalUrl);
  } catch {
    return null;
  }
  if (!LEVER_HOSTS.has(url.hostname)) return null;
  const m = /^\/([^/]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/apply)?\/?$/i.exec(
    url.pathname,
  );
  return m ? `https://${url.hostname}/${m[1]}/${m[2]}/apply` : null;
}

export function leverQuestions(html: string): string[] {
  const root = parse(html);
  const labels = root
    .querySelectorAll("li.application-question.custom-question .application-label")
    .map((n) => labelText(n));
  return sanitizeQuestionList(labels);
}

async function fromLever(page: FetchedPage): Promise<string[] | null> {
  const applyUrl = leverApplyUrl(page.finalUrl);
  if (!applyUrl) return null;
  const apply = await fetchPage(applyUrl, { timeoutMs: STEP_TIMEOUT_MS, maxBytes: LEVER_MAX_BYTES });
  return leverQuestions(apply.html);
}

// ---- Any application form ---------------------------------------------------

/** A label's own text, without the controls nested inside it. */
function labelText(node: HTMLElement): string {
  const copy = parse(node.outerHTML);
  copy.querySelectorAll("select, textarea, input, option, script, style").forEach((n) => n.remove());
  return copy.structuredText.replace(/\s+/g, " ").trim();
}

function describe(root: HTMLElement, el: HTMLElement): string {
  const aria = el.getAttribute("aria-label")?.trim();
  if (aria) return aria;
  const id = el.getAttribute("id");
  if (id) {
    const byFor = root.querySelectorAll("label").find((l) => l.getAttribute("for") === id);
    if (byFor) return labelText(byFor);
  }
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const target = root.querySelector(`#${CSS_ID(labelledBy.split(/\s+/)[0])}`);
    if (target) return labelText(target);
  }
  const wrapping = el.closest("label");
  return wrapping ? labelText(wrapping) : "";
}

// Ids come from the page; keep only characters that are safe in a selector.
const CSS_ID = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "");

const MIN_GENERIC_CHARS = 8;

/**
 * Labelled fields of application forms: free-text boxes, dropdowns, and
 * grouped choices. Only forms that look like an application count (a file
 * upload, a text area, or an "apply" button); login, search and newsletter
 * forms don't.
 */
export function formQuestions(html: string): string[] {
  const root = parse(html);
  const labels: string[] = [];

  for (const form of root.querySelectorAll("form")) {
    if (form.querySelector('input[type="password"]')) continue;
    const looksLikeApplication =
      !!form.querySelector('input[type="file"], textarea') ||
      form
        .querySelectorAll('button, input[type="submit"]')
        .some((b) => /\bapply\b|submit application/i.test(b.text || b.getAttribute("value") || ""));
    if (!looksLikeApplication) continue;

    for (const el of form.querySelectorAll("textarea, select, input")) {
      const type = (el.getAttribute("type") ?? "text").toLowerCase();
      if (el.tagName === "INPUT" && !["text", "url", "number"].includes(type)) continue;
      labels.push(describe(root, el));
    }
    // Radio and checkbox groups are asked as one question.
    for (const group of form.querySelectorAll("fieldset")) {
      const legend = group.querySelector("legend");
      if (legend && group.querySelector('input[type="radio"], input[type="checkbox"]')) {
        labels.push(labelText(legend));
      }
    }
  }

  return sanitizeQuestionList(labels.filter((l) => l.length >= MIN_GENERIC_CHARS));
}

// ---- Entry point ------------------------------------------------------------

/** Application questions for a fetched posting. Never throws. */
export async function findQuestions(page: FetchedPage): Promise<string[]> {
  for (const source of [fromLever]) {
    try {
      const found = await source(page);
      if (found && found.length > 0) return found;
    } catch {
      // Fall through to the next strategy.
    }
  }
  try {
    return formQuestions(page.html);
  } catch {
    return [];
  }
}
