import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { importAiEnabled, importEnabled } from "@/lib/features";
import { RULES, clientIp, hit, retryMessage } from "@/lib/rate-limit";
import {
  IMPORT_ERROR_MESSAGES,
  prepareFromPdf,
  prepareFromText,
  prepareFromUrl,
  type Prepared,
} from "@/lib/import/prepare";
import {
  MAX_PENDING_PER_USER,
  NOTICE_NO_AI,
  createJob,
  failJob,
  housekeeping,
  outcomeFor,
  pendingCount,
  type ImportOutcome,
} from "@/lib/import/jobs";
import { getImportQueue } from "@/lib/import/queue";

// A page fetch is capped at 8 s; leave room for parsing a PDF too.
export const maxDuration = 30;

const json = (body: unknown, status = 200, headers?: HeadersInit) =>
  NextResponse.json(body, { status, headers });

function textField(form: FormData, key: string) {
  const v = form.get(key);
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Reads a job posting (URL, PDF or pasted text) and returns form fields.
 * Pages with structured data answer immediately. Others are queued for the
 * AI worker when it is on; otherwise they get the text as a description.
 */
export async function POST(req: Request) {
  // Feature off: behave as if the endpoint doesn't exist.
  if (!importEnabled()) return json({ error: "Not found" }, 404);

  const user = await getCurrentUser();
  if (!user) return json({ error: "Unauthorized" }, 401);
  if (!user.emailVerified) {
    return json({ error: "Verify your email address to import job postings." }, 403);
  }

  const form = await req.formData().catch(() => null);
  if (!form) return json({ error: "Invalid request" }, 400);

  const url = textField(form, "url");
  const pasted = textField(form, "text");
  const file = form.get("file");
  const pdf = file instanceof File && file.size > 0 ? file : null;
  if ([url, pasted, pdf].filter(Boolean).length !== 1) {
    return json({ error: "Provide one of: a link, a PDF, or pasted text." }, 400);
  }

  const byUser = await hit(`import:user:${user.id}`, RULES.importUser);
  if (!byUser.allowed) {
    return json(
      { error: `You've reached today's import limit. ${retryMessage(byUser)}` },
      429,
      { "Retry-After": String(byUser.retryAfterSec) },
    );
  }
  const byIp = await hit(`import:ip:${await clientIp()}`, RULES.importIp);
  if (!byIp.allowed) {
    return json({ error: `Too many imports from this network. ${retryMessage(byIp)}` }, 429, {
      "Retry-After": String(byIp.retryAfterSec),
    });
  }

  await housekeeping(user.id);

  const prepared: Prepared = url
    ? await prepareFromUrl(url)
    : pdf
      ? await prepareFromPdf(pdf)
      : prepareFromText(pasted!);

  if (prepared.status === "error") {
    return json({ error: IMPORT_ERROR_MESSAGES[prepared.code], code: prepared.code }, 422);
  }

  if (prepared.status === "complete") {
    const job = await createJob({
      userId: user.id,
      kind: prepared.kind,
      sourceUrl: prepared.sourceUrl,
      fields: prepared.fields,
      questions: prepared.questions,
      status: "DONE",
      result: { fields: prepared.fields, via: "structured" },
    });
    return json(outcomeFor(job) satisfies ImportOutcome);
  }

  // Only the text is known. Hand it to the AI worker if there is one.
  const queue = importAiEnabled() ? getImportQueue() : null;
  let notice = NOTICE_NO_AI;
  if (queue) {
    if ((await pendingCount(user.id)) >= MAX_PENDING_PER_USER) {
      notice = `You already have ${MAX_PENDING_PER_USER} imports waiting. ${NOTICE_NO_AI}`;
    } else if (!(await hit(`import:ai:${user.id}`, RULES.importAiUser)).allowed) {
      notice = `You've used today's AI imports. ${NOTICE_NO_AI}`;
    } else {
      const job = await createJob({
        userId: user.id,
        kind: prepared.kind,
        sourceUrl: prepared.sourceUrl,
        fields: prepared.fields,
        questions: prepared.questions,
        status: "QUEUED",
      });
      try {
        await queue.enqueue({
          jobId: job.id,
          kind: prepared.kind,
          text: prepared.text,
          sourceUrl: prepared.sourceUrl,
        });
        return json(outcomeFor(job) satisfies ImportOutcome);
      } catch (e) {
        console.error("Could not queue import", e);
        await failJob(job.id, "enqueue_failed");
        // Fall through to the text-only answer below.
      }
    }
  }

  const job = await createJob({
    userId: user.id,
    kind: prepared.kind,
    sourceUrl: prepared.sourceUrl,
    fields: prepared.fields,
    questions: prepared.questions,
    status: "DONE",
    result: { fields: prepared.fields, via: "text", notice },
  });
  return json(outcomeFor(job) satisfies ImportOutcome);
}
