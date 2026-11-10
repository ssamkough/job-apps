import { z } from "zod";
import { STATUSES, WORK_TYPES } from "@/lib/constants";

/** Empty / whitespace-only form values become undefined. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Must be ${max} characters or fewer`)
    .optional()
    .transform((v) => (v ? v : undefined));

export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128, "Password must be 128 characters or fewer");

const emailSchema = z.string().trim().toLowerCase().email("Enter a valid email address");

export const signupSchema = z.object({
  name: optionalText(80),
  email: emailSchema,
  password: passwordSchema,
});

export const forgotPasswordSchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z
  .object({
    token: z.string().min(1, "This link is invalid or has expired."),
    password: passwordSchema,
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, {
    path: ["confirm"],
    message: "Passwords don't match",
  });

export const changePasswordSchema = z
  .object({
    current: z.string().min(1, "Enter your current password"),
    password: passwordSchema,
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, {
    path: ["confirm"],
    message: "Passwords don't match",
  })
  .refine((v) => v.password !== v.current, {
    path: ["password"],
    message: "Choose a password you haven't used here before",
  });

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Enter your password"),
});

const optionalUrl = z
  .string()
  .trim()
  .max(2000)
  .optional()
  .transform((v) => (v ? v : undefined))
  .refine(
    (v) => {
      if (!v) return true;
      try {
        const u = new URL(v);
        return u.protocol === "http:" || u.protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "Enter a full URL starting with http:// or https://" },
  );

const optionalDate = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : undefined))
  .refine((v) => !v || /^\d{4}-\d{2}-\d{2}$/.test(v), {
    message: "Enter a valid date",
  })
  .transform((v) => (v ? new Date(`${v}T00:00:00.000Z`) : undefined))
  .refine((d) => !d || !Number.isNaN(d.getTime()), {
    message: "Enter a valid date",
  });

export const applicationSchema = z.object({
  company: z.string().trim().min(1, "Company is required").max(120),
  jobTitle: z.string().trim().min(1, "Job title is required").max(160),
  jobUrl: optionalUrl,
  location: optionalText(120),
  workType: z
    .enum(WORK_TYPES)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  salary: optionalText(80),
  source: optionalText(80),
  status: z.enum(STATUSES),
  dateApplied: optionalDate,
  jobDescription: optionalText(20000),
  notes: optionalText(10000),
  coverLetter: optionalText(10000),
  contactName: optionalText(120),
  contactEmail: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((v) => (v ? v : undefined))
    .refine((v) => !v || z.string().email().safeParse(v).success, {
      message: "Enter a valid email address",
    }),
  resumeId: optionalText(100),
});

export type FieldErrors = Record<string, string | undefined>;

export function fieldErrors(error: z.ZodError): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    out[key] ??= issue.message;
  }
  return out;
}
