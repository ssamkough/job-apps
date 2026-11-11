import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/admin";
import { SiteFooter } from "@/components/site-footer";

// Admin pages are never for search engines, even though they sit behind auth.
export const metadata: Metadata = {
  title: { default: "Admin", template: "%s · Admin · Job Tracker" },
  robots: { index: false, follow: false },
};

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Pages repeat this check themselves: layouts don't re-render on every
  // navigation, so this one alone is not the security boundary.
  const admin = await requireAdmin();

  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-10">
          <Link href="/admin" className="flex items-center gap-2 font-semibold text-zinc-900">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-zinc-900 text-sm text-white">
              JT
            </span>
            Admin
          </Link>
          <div className="flex items-center gap-4 text-sm">
            <span className="hidden truncate text-zinc-500 sm:inline">{admin.email}</span>
            <Link href="/dashboard" className="font-medium text-indigo-600 hover:text-indigo-500">
              Back to app
            </Link>
          </div>
        </div>
      </header>
      <main className="flex-1 px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
        <div className="mx-auto w-full max-w-6xl">{children}</div>
      </main>
      <SiteFooter />
    </div>
  );
}
