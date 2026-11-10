import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { aiEnabled } from "@/lib/features";
import { LinkButton } from "@/components/ui";
import { SiteFooter } from "@/components/site-footer";

const features = (ai: boolean) => [
  {
    title: "Every application in one place",
    body: "Company, role, link, salary, contacts, notes, and the job description, all attached to the application.",
  },
  {
    title: "Know where you stand",
    body: "See what's active, what's gone quiet, and how many applications turn into interviews.",
  },
  {
    title: "Resume and cover letter included",
    body: ai
      ? "Attach the exact resume you sent and draft a tailored cover letter with AI help."
      : "Attach the exact resume you sent and keep the cover letter with the application.",
  },
];

export default async function Home() {
  if (await getCurrentUser()) redirect("/dashboard");

  return (
    <div className="flex flex-1 flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-5 sm:px-6">
        <span className="flex items-center gap-2 font-semibold text-zinc-900">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-indigo-600 text-sm text-white">
            JT
          </span>
          Job Tracker
        </span>
        <nav className="flex items-center gap-2">
          <LinkButton href="/login" variant="ghost">
            Sign in
          </LinkButton>
          <LinkButton href="/signup">Get started</LinkButton>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 sm:px-6">
        <section className="py-16 sm:py-24">
          <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-zinc-900 sm:text-5xl">
            Keep your whole job search organized.
          </h1>
          <p className="mt-5 max-w-2xl text-lg text-zinc-600">
            Track every application, the resume you used, your cover letter, and
            its status, so you always know what to do next.
          </p>
          <div className="mt-8 flex gap-3">
            <LinkButton href="/signup" className="px-5 py-2.5">
              Create a free account
            </LinkButton>
            <LinkButton href="/login" variant="secondary" className="px-5 py-2.5">
              Sign in
            </LinkButton>
          </div>
        </section>

        <section className="grid gap-4 pb-20 sm:grid-cols-3">
          {features(aiEnabled()).map((f) => (
            <div
              key={f.title}
              className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm"
            >
              <h2 className="font-semibold text-zinc-900">{f.title}</h2>
              <p className="mt-2 text-sm text-zinc-600">{f.body}</p>
            </div>
          ))}
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
