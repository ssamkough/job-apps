import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { RULES, hit, retryMessage } from "@/lib/rate-limit";
import { getCurrentUser } from "@/lib/auth";
import {
  AiBusyError,
  AiTimeoutError,
  AiUnavailableError,
  generateCoverLetter,
} from "@/lib/ai";
import { extractResumeText } from "@/lib/resume-text";
import { readResumeFile, readResumeUpload } from "@/lib/storage";

// Local models are slow; leave room for a long generation (Vercel Hobby caps at 300s).
export const maxDuration = 300;

const text = (form: FormData, key: string, max: number) => {
  const v = form.get(key);
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
};

/**
 * Takes the application form's fields directly (plus `instructions`), so it
 * works for applications that haven't been saved yet.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const company = text(form, "company", 120);
  const jobTitle = text(form, "jobTitle", 160);
  if (!company || !jobTitle) {
    return NextResponse.json(
      { error: "Add a company and job title first so the letter can be tailored." },
      { status: 400 },
    );
  }

  // The AI runs on shared, finite hardware, so it's limited to verified
  // accounts and a handful of drafts per hour each.
  if (!user.emailVerifiedAt) {
    return NextResponse.json(
      { error: "Verify your email address to use AI drafts. You can resend the link from Settings." },
      { status: 403 },
    );
  }
  const limit = await hit(`ai:user:${user.id}`, RULES.aiUser);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: `You've reached the hourly limit for AI drafts. ${retryMessage(limit)}` },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } },
    );
  }

  // Resume: a freshly chosen file wins over the selected library resume.
  // PDF and DOCX are read as text; legacy .doc and scans can't be.
  let resumeText: string | null = null;
  let hadResume = false;
  const upload = form.get("resumeFile");
  if (upload instanceof File && upload.size > 0) {
    const check = await readResumeUpload(upload);
    if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });
    hadResume = true;
    resumeText = await extractResumeText(
      check.upload.buffer,
      check.upload.mimeType,
    );
  } else {
    const resumeId = text(form, "resumeId", 100);
    if (resumeId) {
      const resume = await db.resume.findFirst({
        where: { id: resumeId, userId: user.id },
      });
      if (resume) {
        hadResume = true;
        const file = await readResumeFile(resume.storageKey).catch(() => null);
        if (file) resumeText = await extractResumeText(file, resume.mimeType);
      }
    }
  }

  try {
    const letter = await generateCoverLetter({
      applicantName: user.name,
      company,
      jobTitle,
      jobDescription: text(form, "jobDescription", 20000),
      contactName: text(form, "contactName", 120),
      instructions: text(form, "instructions", 1000),
      existingDraft: text(form, "coverLetter", 10000),
      resumeText,
    });
    return NextResponse.json({
      letter,
      resumeUsed: !!resumeText,
      resumeSkipped: hadResume && !resumeText,
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
    console.error("Cover letter generation failed", e);
    return NextResponse.json(
      { error: "Couldn't generate a draft right now. Please try again." },
      { status: 502 },
    );
  }
}
