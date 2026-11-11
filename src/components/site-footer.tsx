import Link from "next/link";
import { SITE_NAME } from "@/lib/site";

export function SiteFooter() {
  return (
    <footer className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-6 text-xs text-zinc-500 sm:px-6">
      <span>&copy; {new Date().getFullYear()} {SITE_NAME}</span>
      <nav className="flex gap-4" aria-label="Legal">
        <Link href="/privacy" className="hover:text-zinc-800">Privacy</Link>
        <Link href="/terms" className="hover:text-zinc-800">Terms</Link>
      </nav>
    </footer>
  );
}
