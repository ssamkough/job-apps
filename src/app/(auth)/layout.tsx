import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { LogoMark } from "@/components/logo";
import { SiteFooter } from "@/components/site-footer";

export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Only verified users are bounced: an unverified one with a session would
  // otherwise loop between here and the app's verify redirect.
  const user = await getCurrentUser();
  if (user?.emailVerified) redirect("/dashboard");

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-4 py-12">
      <Link
        href="/"
        className="mb-8 flex items-center gap-2 text-lg font-semibold text-zinc-900"
      >
        <LogoMark size={36} />
        Job Tracker
      </Link>
      <div className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-6 shadow-sm sm:p-8">
        {children}
      </div>
      <SiteFooter />
    </main>
  );
}
