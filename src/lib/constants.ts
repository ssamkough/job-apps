export const STATUSES = [
  "WISHLIST",
  "APPLIED",
  "SCREENING",
  "INTERVIEWING",
  "OFFER",
  "ACCEPTED",
  "REJECTED",
  "WITHDRAWN",
] as const;

export type Status = (typeof STATUSES)[number];

export const STATUS_LABELS: Record<Status, string> = {
  WISHLIST: "Wishlist",
  APPLIED: "Applied",
  SCREENING: "Screening",
  INTERVIEWING: "Interviewing",
  OFFER: "Offer",
  ACCEPTED: "Accepted",
  REJECTED: "Rejected",
  WITHDRAWN: "Withdrawn",
};

// Tailwind classes: badge (bg + text + ring) and a solid color for charts.
export const STATUS_STYLES: Record<Status, { badge: string; bar: string }> = {
  WISHLIST: {
    badge: "bg-slate-100 text-slate-700 ring-slate-200",
    bar: "bg-slate-400",
  },
  APPLIED: {
    badge: "bg-blue-50 text-blue-700 ring-blue-200",
    bar: "bg-blue-500",
  },
  SCREENING: {
    badge: "bg-violet-50 text-violet-700 ring-violet-200",
    bar: "bg-violet-500",
  },
  INTERVIEWING: {
    badge: "bg-amber-50 text-amber-800 ring-amber-200",
    bar: "bg-amber-500",
  },
  OFFER: {
    badge: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    bar: "bg-emerald-500",
  },
  ACCEPTED: {
    badge: "bg-green-100 text-green-800 ring-green-300",
    bar: "bg-green-600",
  },
  REJECTED: {
    badge: "bg-rose-50 text-rose-700 ring-rose-200",
    bar: "bg-rose-500",
  },
  WITHDRAWN: {
    badge: "bg-zinc-100 text-zinc-600 ring-zinc-200",
    bar: "bg-zinc-400",
  },
};

/** Statuses where the application is still in play. */
export const ACTIVE_STATUSES: Status[] = [
  "APPLIED",
  "SCREENING",
  "INTERVIEWING",
  "OFFER",
];

/** Statuses meaning the employer has responded in some way. */
export const RESPONDED_STATUSES: Status[] = [
  "SCREENING",
  "INTERVIEWING",
  "OFFER",
  "ACCEPTED",
  "REJECTED",
];

export const WORK_TYPES = ["REMOTE", "HYBRID", "ONSITE"] as const;
export type WorkType = (typeof WORK_TYPES)[number];
export const WORK_TYPE_LABELS: Record<WorkType, string> = {
  REMOTE: "Remote",
  HYBRID: "Hybrid",
  ONSITE: "On-site",
};

// Vercel rejects function request bodies over 4.5 MB (413), and the upload
// travels in the same request as the rest of the form. 4 MB leaves headroom.
export const MAX_RESUME_MB = 4;
export const MAX_RESUME_BYTES = MAX_RESUME_MB * 1024 * 1024;
export const ALLOWED_RESUME_TYPES: Record<string, string> = {
  "application/pdf": "PDF",
  "application/msword": "DOC",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "DOCX",
};

/** Days without a status change before an active application is flagged. */
export const STALE_AFTER_DAYS = 14;

export function isStatus(value: unknown): value is Status {
  return typeof value === "string" && (STATUSES as readonly string[]).includes(value);
}

/**
 * How long an emailed verification / reset code works. Measured against a real
 * Neon Auth branch: the code's `expiresAt` is 300 s after it was created (Neon's
 * docs say 15 minutes; the service does not). If Neon changes it, change it here.
 */
export const OTP_LIFETIME_MINUTES = 5;
