import { WORK_TYPES } from "@/lib/constants";
import { truncateAtBoundary } from "./text";

/** What an import can fill in on the Add application form. */
export const IMPORT_FIELD_KEYS = [
  "company",
  "jobTitle",
  "jobUrl",
  "location",
  "workType",
  "salary",
  "source",
  "jobDescription",
] as const;

export type ImportFieldKey = (typeof IMPORT_FIELD_KEYS)[number];
export type ImportFields = Partial<Record<ImportFieldKey, string>>;

/** Same limits as `applicationSchema`, so an imported value always saves. */
const MAX_LENGTH: Record<ImportFieldKey, number> = {
  company: 120,
  jobTitle: 160,
  jobUrl: 2000,
  location: 120,
  workType: 20,
  salary: 80,
  source: 80,
  jobDescription: 20_000,
};

/** The most a saved job description holds (same as `applicationSchema`). */
export const MAX_DESCRIPTION_CHARS = MAX_LENGTH.jobDescription;

function clip(value: string, max: number) {
  if (value.length <= max) return value;
  // Prefer a word boundary so a clipped title doesn't end mid-word.
  const cut = value.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd();
}

function isHttpUrl(value: string) {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Cleans untrusted extractor output (JSON-LD or a model's JSON) into form
 * values. Anything unusable is dropped on its own rather than failing the
 * whole import: one bad field shouldn't throw away the other seven.
 */
export function sanitizeFields(raw: unknown): ImportFields {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const input = raw as Record<string, unknown>;
  const out: ImportFields = {};

  for (const key of IMPORT_FIELD_KEYS) {
    const value = input[key];
    if (typeof value !== "string") continue;
    // Keep paragraph breaks in the description; flatten everything else.
    const text =
      key === "jobDescription"
        ? value.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim()
        : value.replace(/\s+/g, " ").trim();
    if (!text) continue;

    if (key === "workType") {
      const upper = text.toUpperCase().replace(/[\s-]+/g, "");
      const match = WORK_TYPES.find((w) => w === upper);
      if (match) out.workType = match;
      continue;
    }
    if (key === "jobUrl") {
      if (isHttpUrl(text) && text.length <= MAX_LENGTH.jobUrl) out.jobUrl = text;
      continue;
    }
    // A long description is cut at a paragraph or sentence, not mid-word.
    out[key] = key === "jobDescription" ? truncateAtBoundary(text, MAX_LENGTH[key]) : clip(text, MAX_LENGTH[key]);
  }
  return out;
}

/** True when a posting has enough for an application: company and title. */
export function hasRequiredFields(fields: ImportFields) {
  return Boolean(fields.company && fields.jobTitle);
}

/**
 * Combines two sets of fields. Values in `preferred` win; `fallback` fills
 * the gaps. Used so a model never overwrites what structured data said.
 */
export function mergeFields(preferred: ImportFields, fallback: ImportFields): ImportFields {
  const out: ImportFields = { ...fallback };
  for (const key of IMPORT_FIELD_KEYS) {
    const value = preferred[key];
    if (value) out[key] = value;
  }
  return out;
}
