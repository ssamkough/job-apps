import { z } from "zod";

export const MAX_QUESTION_CHARS = 1000;
export const MAX_ANSWER_CHARS = 10_000;
export const MAX_LABEL_CHARS = 60;
export const MAX_QUESTIONS_PER_APPLICATION = 50;
export const MAX_QUESTIONS_PER_USER = 1000;
export const MAX_ANSWERS_PER_QUESTION = 20;
/** Most questions an import will offer from one posting. */
export const MAX_IMPORTED_QUESTIONS = 30;

/**
 * Tidies a question as found on a form or typed in: one line of text, without
 * the markers sites add ("*", "✱", "(required)").
 */
export function cleanQuestionText(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/[\u00a0\s]+/g, " ")
    .replace(/\s*[*✱]+\s*$/u, "")
    .replace(/\s*\((required|optional)\)\s*$/i, "")
    .replace(/\s*[*✱]\s*$/u, "")
    .trim();
}

/**
 * What makes two questions "the same": case, spacing and trailing punctuation
 * don't matter, so "Why us?" and "why us" are one question.
 */
export function questionKey(text: string): string {
  return cleanQuestionText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .slice(0, MAX_QUESTION_CHARS);
}

// Contact and identity fields every application has. They aren't questions
// worth keeping answers for, so the importer leaves them out.
const STANDARD_FIELDS = [
  /^((full|first|last|legal|preferred|middle|nick) ?)*name\b/,
  /^(your )?(e-?mail|email address)\b/,
  /^(your )?(phone|mobile|telephone|cell)\b/,
  /^(current |your )?(location|city|address|country|zip|postal)\b/,
  /^(resume|cv|curriculum)\b/,
  /^(cover letter)\b/,
  /^(attach|upload)\b/,
  /^(linkedin|github|twitter|website|portfolio|personal site|other website)\b/,
  /^(current |present )?(company|employer|organi[sz]ation)\b$/,
  /^(current )?(job )?title\b$/,
  /^pronouns\b/,
  /^(gender|race|ethnicity|veteran|disability|hispanic)\b/,
  // Equal-opportunity survey questions, however they are phrased.
  /\b(gender|ethnic|veteran|sexual orientation|disabilit|age range)/,
  /^(password|captcha|recaptcha|submit)\b/,
];

export function isStandardField(label: string): boolean {
  const key = questionKey(label);
  return key.length < 3 || STANDARD_FIELDS.some((re) => re.test(key));
}

/**
 * Cleans a list of candidate questions from untrusted input (a page, an API,
 * a model): cleaned, no standard contact fields, no duplicates, bounded.
 */
export function sanitizeQuestionList(raw: unknown, max = MAX_IMPORTED_QUESTIONS): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const text = cleanQuestionText(item);
    if (text.length < 3 || text.length > MAX_QUESTION_CHARS) continue;
    if (isStandardField(text)) continue;
    // "Please review the points below:" is a heading for a consent box, not a question.
    if (text.endsWith(":") && !text.includes("?")) continue;
    const key = questionKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

// ---- Form validation --------------------------------------------------------

export const questionTextSchema = z
  .string()
  .transform(cleanQuestionText)
  .pipe(
    z
      .string()
      .min(3, "Write the question (at least a few words)")
      .max(MAX_QUESTION_CHARS, `Must be ${MAX_QUESTION_CHARS} characters or fewer`),
  );

export const answerSchema = z.object({
  label: z
    .string()
    .trim()
    .max(MAX_LABEL_CHARS, `Name must be ${MAX_LABEL_CHARS} characters or fewer`)
    .optional()
    .transform((v) => (v ? v : undefined)),
  body: z
    .string()
    .trim()
    .min(1, "Write an answer")
    .max(MAX_ANSWER_CHARS, `Must be ${MAX_ANSWER_CHARS} characters or fewer`),
});

/** One question attached to an application, as sent by the form. */
export const attachmentSchema = z.object({
  /** An existing question of the person's. */
  questionId: z.string().max(100).optional(),
  /** Or new text; resolved to an existing question with the same key. */
  text: z.string().max(5000).optional(),
  /** The variant used for this application, if chosen. */
  answerId: z.string().max(100).nullish(),
  source: z.enum(["MANUAL", "IMPORT"]).optional(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

const attachmentsSchema = z.array(attachmentSchema).max(MAX_QUESTIONS_PER_APPLICATION);

/** Reads the form's `questions` field (JSON). Empty or missing means none. */
export function parseAttachments(
  raw: string | undefined,
): { ok: true; items: Attachment[] } | { ok: false; error: string } {
  if (!raw || !raw.trim()) return { ok: true, items: [] };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Couldn't read the questions list. Reload the page and try again." };
  }
  const parsed = attachmentsSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      error: `An application can have up to ${MAX_QUESTIONS_PER_APPLICATION} questions.`,
    };
  }
  const items = parsed.data.filter((a) => a.questionId || (a.text && cleanQuestionText(a.text)));
  return { ok: true, items };
}
