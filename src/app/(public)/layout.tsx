import Link from "next/link";
import { LogoMark } from "@/components/logo";
import { SiteFooter } from "@/components/site-footer";

// Pages that work whether or not you're signed in (unlike the (auth) group,
// which redirects signed-in users away).
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col">
      <header className="mx-auto w-full max-w-3xl px-4 py-5 sm:px-6">
        <Link href="/" className="inline-flex items-center gap-2 font-semibold text-zinc-900">
          <LogoMark />
          Job Tracker
        </Link>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-10 sm:px-6">{children}</main>
      <SiteFooter />
    </div>
  );
}
