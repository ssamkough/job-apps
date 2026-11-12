import type { Metadata } from "next";
import { aiEnabled, importEnabled } from "@/lib/features";
import { SITE_NAME, supportEmail } from "@/lib/site";

// Read SUPPORT_EMAIL at request time, not build time.
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Privacy Policy" };

// NOTE: This is a plain-language template describing what the app actually
// does. It is not legal advice; have it reviewed before launching publicly.
const UPDATED = "November 2026";

export default function PrivacyPage() {
  const email = supportEmail();
  return (
    <article className="prose-sm space-y-6 text-sm leading-6 text-zinc-700">
      <header>
        <h1 className="text-2xl font-semibold text-zinc-900">Privacy Policy</h1>
        <p className="mt-1 text-zinc-500">Last updated {UPDATED}</p>
      </header>

      <p>
        {SITE_NAME} helps you keep track of your job applications. This page explains
        what we store, why, and the choices you have.
      </p>

      <Section title="What we store">
        <ul className="list-disc space-y-1 pl-5">
          <li>Your account: email address, optional name, and a salted hash of your password (never the password itself). These are held by our sign-in provider (Neon Auth).</li>
          <li>What you add: applications, notes, contacts, status history, job descriptions, cover letters, the questions you save with your answers to them, and the resume files you upload.</li>
          <li>A session cookie that keeps you signed in. We don&apos;t use advertising or analytics cookies.</li>
          <li>Short-lived technical records used to limit abuse, such as how many times an IP address or email tried to sign in.</li>
        </ul>
      </Section>

      {aiEnabled() && (
        <Section title="How AI drafts work">
          When you ask for a cover letter draft, the job details, your instructions, and the
          text of the resume you select are sent to an AI model that we run ourselves. They
          are not sent to a third-party AI company, and we don&apos;t use your content to train models.
        </Section>
      )}

      {importEnabled() && (
        <Section title="Importing a job posting">
          When you import a posting from a link, our servers fetch that public page, read the
          job details and any application questions on it, and fill in the form for you to
          review. A pasted posting or uploaded PDF is read the same way. We keep a short record
          of each import (what was found, not the file) for up to 7 days so you can recover it,
          then delete it.
        </Section>
      )}

      <Section title="Who else handles your data">
        <ul className="list-disc space-y-1 pl-5">
          <li>Our hosting, database and file-storage providers store the data above on our behalf.</li>
          <li>Our sign-in provider (Neon Auth) emails you the 6-digit codes used to verify your address and reset your password.</li>
        </ul>
        We don&apos;t sell your data or share it for marketing.
      </Section>

      <Section title="Your choices">
        <ul className="list-disc space-y-1 pl-5">
          <li>Edit or delete any application or resume at any time.</li>
          <li>Delete your account from Settings. This permanently removes your applications and uploaded resumes and ends all sessions. Your sign-in details (email address, name and password hash) stay with our sign-in provider until they are removed; email us and we will have them deleted.</li>
          <li>Sign out of all devices from Settings.</li>
        </ul>
      </Section>

      <Section title="Security">
        Passwords are hashed, sessions can be revoked, files are checked on upload, and
        connections use HTTPS. No system is perfectly secure, so please use a unique password.
      </Section>

      <Section title="Contact">
        Questions or requests about your data: <a className="font-medium text-indigo-600" href={`mailto:${email}`}>{email}</a>.
      </Section>
    </article>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-base font-semibold text-zinc-900">{title}</h2>
      {children}
    </section>
  );
}
