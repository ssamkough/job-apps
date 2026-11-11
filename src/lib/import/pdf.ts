import "server-only";
import { extractText, getDocumentProxy } from "unpdf";
import { MAX_TEXT_CHARS } from "./html";

export const MAX_IMPORT_PDF_MB = 4;

export type PdfResult =
  | { ok: true; text: string }
  | { ok: false; error: "too_large" | "not_pdf" | "no_text" | "unreadable" };

/** Plain text of an uploaded job-posting PDF. The file itself is never stored. */
export async function readPostingPdf(file: File): Promise<PdfResult> {
  if (file.size > MAX_IMPORT_PDF_MB * 1024 * 1024) return { ok: false, error: "too_large" };
  const bytes = new Uint8Array(await file.arrayBuffer());
  // Trust the content, not the filename or declared type.
  const magic = new TextDecoder("latin1").decode(bytes.subarray(0, 5));
  if (magic !== "%PDF-") return { ok: false, error: "not_pdf" };

  try {
    const pdf = await getDocumentProxy(bytes);
    const { text } = await extractText(pdf, { mergePages: true });
    const clean = text
      .replace(/\r/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (clean.length < 50) return { ok: false, error: "no_text" };
    return { ok: true, text: clean.length > MAX_TEXT_CHARS ? clean.slice(0, MAX_TEXT_CHARS) : clean };
  } catch {
    return { ok: false, error: "unreadable" };
  }
}
