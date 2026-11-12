import "server-only";
import {
  hasRequiredFields,
  sanitizeFields,
  type ImportFields,
} from "./fields";
import { MAX_TEXT_CHARS, MIN_TEXT_CHARS, pageText, readJobPosting } from "./html";
import { fetchPage, FetchError, type FetchFailure } from "./safe-fetch";
import { readPostingPdf } from "./pdf";
import { findQuestions } from "./questions";

export type ImportKind = "URL" | "PDF" | "TEXT";

export type ImportErrorCode =
  | FetchFailure
  | "no_content" // fetched fine but there's no readable posting text
  | "pdf_too_large"
  | "not_pdf"
  | "pdf_no_text"
  | "pdf_unreadable"
  | "text_too_short";

/**
 * The outcome of reading a posting before any AI is involved.
 *  - `complete`: structured data had everything needed; done.
 *  - `partial`: only text is available. `fields` holds what is known for sure
 *    (including the text as the description); an AI extractor may add more.
 */
export type Prepared =
  | {
      status: "complete";
      kind: ImportKind;
      fields: ImportFields;
      /** Application questions found on the posting (best effort). */
      questions: string[];
      sourceUrl?: string;
    }
  | {
      status: "partial";
      kind: ImportKind;
      fields: ImportFields;
      questions: string[];
      /** Cleaned text to hand to an extractor. Never persisted. */
      text: string;
      sourceUrl?: string;
    }
  | { status: "error"; code: ImportErrorCode };

export type PrepareOptions = { testLoopbackPort?: number };

const MIN_PASTED_CHARS = 80;

function partial(
  kind: ImportKind,
  text: string,
  known: ImportFields,
  sourceUrl?: string,
  questions: string[] = [],
): Prepared {
  // The text itself is a sound job description even when nothing else is known.
  const fields = sanitizeFields({ jobDescription: text, ...known });
  return { status: "partial", kind, fields, questions, text, sourceUrl };
}

export async function prepareFromUrl(url: string, options: PrepareOptions = {}): Promise<Prepared> {
  let page;
  try {
    page = await fetchPage(url, options);
  } catch (e) {
    return { status: "error", code: e instanceof FetchError ? e.code : "unreachable" };
  }

  // Best effort: never fails the import, and bounded by its own timeouts.
  const questions = await findQuestions(page);

  const structured = readJobPosting(page.html, page.finalUrl);
  if (structured && hasRequiredFields(structured)) {
    // JSON-LD descriptions can be thin; fall back to the page text.
    if (!structured.jobDescription) {
      const text = pageText(page.html, 20_000);
      if (text.length >= MIN_TEXT_CHARS) structured.jobDescription = text;
    }
    return {
      status: "complete",
      kind: "URL",
      fields: sanitizeFields(structured),
      questions,
      sourceUrl: page.finalUrl,
    };
  }

  const text = pageText(page.html);
  if (text.length < MIN_TEXT_CHARS) return { status: "error", code: "no_content" };
  return partial("URL", text, { ...structured, jobUrl: page.finalUrl }, page.finalUrl, questions);
}

export async function prepareFromPdf(file: File): Promise<Prepared> {
  const pdf = await readPostingPdf(file);
  if (!pdf.ok) {
    const code = {
      too_large: "pdf_too_large",
      not_pdf: "not_pdf",
      no_text: "pdf_no_text",
      unreadable: "pdf_unreadable",
    } as const;
    return { status: "error", code: code[pdf.error] };
  }
  return partial("PDF", pdf.text, {});
}

export function prepareFromText(raw: string): Prepared {
  const text = raw
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length < MIN_PASTED_CHARS) return { status: "error", code: "text_too_short" };
  return partial("TEXT", text.slice(0, MAX_TEXT_CHARS), {});
}

/** What a person sees for each failure. Specific enough to act on. */
export const IMPORT_ERROR_MESSAGES: Record<ImportErrorCode, string> = {
  invalid_url: "That doesn't look like a web address. Paste the full link, starting with https://.",
  blocked: "That address can't be imported. Use the public link to the job posting.",
  unreachable: "Couldn't reach that site. Check the link, or paste the posting text instead.",
  timeout: "The site took too long to respond. Try again, or paste the posting text instead.",
  too_large: "That page is too large to import. Paste the posting text instead.",
  too_many_redirects: "That link redirects too many times. Try the final link, or paste the text.",
  http_error:
    "The site wouldn't let us read that page (it may need a login). Paste the posting text instead.",
  not_html: "That link isn't a web page. If it's a PDF, upload it instead.",
  no_content:
    "That page has no readable text (many job boards load it with JavaScript). Paste the posting text instead.",
  pdf_too_large: "That PDF is too large. The limit is 4 MB.",
  not_pdf: "That file isn't a PDF.",
  pdf_no_text: "That PDF has no text we can read (it may be a scan). Paste the text instead.",
  pdf_unreadable: "Couldn't read that PDF. Paste the posting text instead.",
  text_too_short: "Paste a bit more of the posting so there's something to read.",
};
