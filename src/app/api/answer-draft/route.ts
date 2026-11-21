import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { RULES, hit, retryMessage } from "@/lib/rate-limit";
import { getCurrentUser } from "@/lib/auth";
import { aiEnabled } from "@/lib/features";
import {
  AiBusyError,
  AiTimeoutError,
  AiUnavailableError,
  generateAnswerDraft,
} from "@/lib/ai";
import { MAX_ANSWER_CHARS } from "@/lib/questions";
import { extractResumeText } from "@/lib/resume-text";
import { readResumeFile } from "@/lib/storage";

// Local models are slow; leave room for a long generation (Vercel Hobby caps at 300s).
export const maxDuration = 300;

const text = (form: FormData, key: string, max: number) => {
  const v = form.get(key);
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
};

/**
 * Drafts an answer for one of the signed-in user's saved questions. The draft
 * is returned to the editor; nothing is saved until they submit it.
 *
 * The route checks the user itself. `requireUser` redirects, which is right
 * for pages and wrong for a JSON API, so this uses the same gates as
 * `/api/cover-letter`: signed in, verified email, then a friendly error.
 */
export async function POST(req: Request) {
  // Feature off: behave as if the endpoint doesn't exist.
  if (!aiEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const questionId = text(form, "questionId", 100);
  if (!questionId) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  if (!user.emailVerified) {
    return NextResponse.json(
      { error: "Verify your email address to use AI drafts." },
      { status: 403 },
    );
  }

  const question = await db.question.findFirst({
    where: { id: questionId, userId: user.id },
    select: { id: true, text: true },
  });
  if (!question) {
    return NextResponse.json({ error: "That question no longer exists." }, { status: 404 });
  }

  // Separate key from cover letters (`ai:user:`) so the two budgets don't mix.
  const limit = await hit(`ai-answer:user:${user.id}`, RULES.aiAnswerUser);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: `You've reached the hourly limit for AI drafts. ${retryMessage(limit)}` },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } },
    );
  }

  const links = await db.applicationQuestion.findMany({
    where: { questionId: question.id, application: { userId: user.id } },
    select: {
      application: {
        select: {
          id: true,
          company: true,
          jobTitle: true,
          jobDescription: true,
          updatedAt: true,
          resumeId: true,
        },
      },
    },
  });
  const applications = links
    .map((link) => link.application)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || (a.id < b.id ? 1 : -1));
  const application = applications[0] ?? null;

  let resumeText: string | null = null;
  let hadResume = false;
  if (application?.resumeId) {
    const resume = await db.resume.findFirst({
      where: { id: application.resumeId, userId: user.id },
    });
    if (resume) {
      hadResume = true;
      const file = await readResumeFile(resume.storageKey).catch(() => null);
      if (file) resumeText = await extractResumeText(file, resume.mimeType);
    }
  }

  try {
    const draft = await generateAnswerDraft({
      question: question.text,
      applicantName: user.name,
      company: application?.company ?? null,
      jobTitle: application?.jobTitle ?? null,
      jobDescription: application?.jobDescription
        ? application.jobDescription.slice(0, 20000)
        : null,
      resumeText,
    });
    return NextResponse.json({
      draft: draft.slice(0, MAX_ANSWER_CHARS),
      resumeUsed: !!resumeText,
      resumeSkipped: hadResume && !resumeText,
      application: application
        ? { company: application.company, jobTitle: application.jobTitle }
        : null,
      usedMostRecent: applications.length > 1,
    });
  } catch (e) {
    if (e instanceof AiBusyError) {
      return NextResponse.json({ error: e.message }, { status: 429 });
    }
    if (e instanceof AiTimeoutError) {
      return NextResponse.json({ error: e.message }, { status: 504 });
    }
    if (e instanceof AiUnavailableError) {
      return NextResponse.json({ error: e.message }, { status: 503 });
    }
    console.error("Answer draft generation failed", e);
    return NextResponse.json(
      { error: "Couldn't generate a draft right now. Please try again." },
      { status: 502 },
    );
  }
}
