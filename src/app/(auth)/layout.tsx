import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { SiteFooter } from "@/components/site-footer";

export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (await getCurrentUser()) redirect("/dashboard");

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-4 py-12">
      <Link
        href="/"
        className="mb-8 flex items-center gap-2 text-lg font-semibold text-zinc-900"
      >
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-indigo-600 text-sm text-white">
          JT
        </span>
        Job Tracker
      </Link>
      <div className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-6 shadow-sm sm:p-8">
        {children}
      </div>
      <SiteFooter />
    </main>
  );
}
