import type { FieldErrors } from "@/lib/validation";

export type FormState = {
  errors?: FieldErrors;
  /** Top-level message not tied to a field (an error unless `ok` is set). */
  message?: string;
  /** The message is a success notice, not an error. */
  ok?: boolean;
  /** Submitted values, so inputs keep what the user typed after an error. */
  values?: Record<string, string>;
};

/** FormData -> plain object of string fields (files are skipped). */
export function formValues(formData: FormData) {
  const out: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string" && !key.startsWith("$ACTION")) out[key] = value;
  }
  return out;
}
