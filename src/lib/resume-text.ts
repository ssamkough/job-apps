import "server-only";
import { extractText, getDocumentProxy } from "unpdf";
import mammoth from "mammoth";

/** Keeps the prompt within the model's context window. */
const MAX_CHARS = 12_000;
/** Below this we assume the file is a scan/image with no real text layer. */
const MIN_CHARS = 50;

export const READABLE_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

function clean(text: string) {
  return text
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Plain text from a PDF or DOCX resume. Returns null if the type isn't
 * supported (legacy .doc), the file is unreadable, or it has no text layer
 * (e.g. a scanned image).
 */
export async function extractResumeText(
  buffer: Buffer,
  mimeType: string,
): Promise<string | null> {
  try {
    let raw: string;
    if (mimeType === "application/pdf") {
      const pdf = await getDocumentProxy(new Uint8Array(buffer));
      const { text } = await extractText(pdf, { mergePages: true });
      raw = text;
    } else if (
      mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      raw = (await mammoth.extractRawText({ buffer })).value;
    } else {
      return null;
    }

    const text = clean(raw);
    if (text.length < MIN_CHARS) return null;
    return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
  } catch (e) {
    console.warn("Could not extract resume text", e);
    return null;
  }
}
