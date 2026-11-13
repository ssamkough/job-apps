import "server-only";
import type { ImportJob } from "@prisma/client";
import { db } from "@/lib/db";
import { hasRequiredFields, mergeFields, sanitizeFields, type ImportFields } from "./fields";
import { sanitizeQuestionList } from "@/lib/questions";
import type { ImportKind } from "./prepare";

/** A queued job nobody has answered in this long is given up on. */
export const QUEUE_EXPIRY_MINUTES = 15;
/** Finished jobs are kept this long (the "recent imports" window), then deleted. */
export const JOB_RETENTION_DAYS = 7;
/** Queued jobs one person may have waiting at once. */
export const MAX_PENDING_PER_USER = 3;

export type ImportVia = "structured" | "text" | "ai";

export type ImportOutcome = {
  status: "done" | "queued" | "failed" | "expired";
  jobId: string;
  fields?: ImportFields;
  via?: ImportVia;
  /** Application questions found on the posting. */
  questions?: string[];
  /** Something worth telling the person, e.g. what couldn't be filled in. */
  notice?: string;
  error?: string;
};

type StoredResult = { fields: ImportFields; via: ImportVia; notice?: string };

export const NOTICE_NO_AI =
  "Filled in the description and link. The company and job title couldn't be detected automatically, so add them yourself.";

export const NOTICE_THIN_PAGE =
  "Filled in what we could find, but this page has very little readable text (many job boards load it with JavaScript). Add the rest yourself, or paste the posting text instead.";

export const NOTICE_NOT_FOUND =
  "Couldn't find the company and job title in this posting. The description is filled in; add the rest yourself.";

export const ERROR_WORKER =
  "The importer didn't finish this one. The description is filled in; add the rest yourself.";

export const ERROR_EXPIRED =
  "The importer didn't pick this up in time. The description is filled in; add the rest yourself.";

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

/**
 * Gives up on stale queued jobs and deletes old ones. Runs lazily when a
 * person starts or checks an import, so nothing has to poll the database.
 */
export async function housekeeping(userId: string) {
  await db.importJob.updateMany({
    where: { userId, status: "QUEUED", createdAt: { lt: minutesAgo(QUEUE_EXPIRY_MINUTES) } },
    data: { status: "EXPIRED", errorCode: "expired", finishedAt: new Date() },
  });
  await db.importJob.deleteMany({
    where: { userId, createdAt: { lt: minutesAgo(JOB_RETENTION_DAYS * 24 * 60) } },
  });
}

export function pendingCount(userId: string) {
  return db.importJob.count({
    where: { userId, status: "QUEUED", createdAt: { gte: minutesAgo(QUEUE_EXPIRY_MINUTES) } },
  });
}

export function createJob(args: {
  userId: string;
  kind: ImportKind;
  sourceUrl?: string;
  fields: ImportFields;
  questions?: string[];
  status: "QUEUED" | "DONE";
  result?: StoredResult;
}) {
  return db.importJob.create({
    data: {
      userId: args.userId,
      kind: args.kind,
      sourceUrl: args.sourceUrl,
      status: args.status,
      // Set here, not by the database, so expiry compares like with like.
      createdAt: new Date(),
      fields: args.fields,
      questions: args.questions?.length ? args.questions : undefined,
      result: args.result,
      finishedAt: args.status === "DONE" ? new Date() : undefined,
    },
  });
}

/**
 * Records the extractor's answer. Structured data already read from the page
 * always wins; the model only fills what is missing. Safe to call twice: only
 * a job that is still queued changes.
 */
export async function completeJob(jobId: string, extracted: unknown): Promise<boolean> {
  const job = await db.importJob.findUnique({ where: { id: jobId } });
  if (!job || job.status !== "QUEUED") return false;

  const known = sanitizeFields(job.fields);
  const fields = mergeFields(known, sanitizeFields(extracted));
  const found = hasRequiredFields(fields);
  const result: StoredResult = {
    fields,
    via: "ai",
    ...(found ? {} : { notice: NOTICE_NOT_FOUND }),
  };
  // Questions read from the page itself come first; the model adds what it saw.
  const aiQuestions =
    extracted && typeof extracted === "object" ? (extracted as { questions?: unknown }).questions : undefined;
  const questions = sanitizeQuestionList([
    ...sanitizeQuestionList(job.questions),
    ...sanitizeQuestionList(aiQuestions),
  ]);
  const { count } = await db.importJob.updateMany({
    where: { id: jobId, status: "QUEUED" },
    data: {
      status: "DONE",
      result,
      questions: questions.length ? questions : undefined,
      finishedAt: new Date(),
    },
  });
  return count === 1;
}

/** Marks a queued job as failed. The text-only fields stay available. */
export async function failJob(jobId: string, errorCode: string): Promise<boolean> {
  const { count } = await db.importJob.updateMany({
    where: { id: jobId, status: "QUEUED" },
    data: { status: "FAILED", errorCode, finishedAt: new Date() },
  });
  return count === 1;
}

/** The shape the browser receives for a stored job. */
export function outcomeFor(job: ImportJob): ImportOutcome {
  const known = sanitizeFields(job.fields);
  const questions = sanitizeQuestionList(job.questions);
  switch (job.status) {
    case "DONE": {
      const result = job.result as StoredResult | null;
      return {
        status: "done",
        jobId: job.id,
        fields: sanitizeFields(result?.fields ?? known),
        via: result?.via ?? "text",
        questions,
        notice: result?.notice,
      };
    }
    case "QUEUED":
      return { status: "queued", jobId: job.id };
    case "EXPIRED":
      return { status: "expired", jobId: job.id, fields: known, questions, error: ERROR_EXPIRED };
    default:
      return { status: "failed", jobId: job.id, fields: known, questions, error: ERROR_WORKER };
  }
}
