import { requireUser } from "@/lib/auth";
import { AppNav } from "@/components/app-nav";
import { SiteFooter } from "@/components/site-footer";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();

  return (
    <div className="flex flex-1 flex-col">
      <AppNav user={{ email: user.email, name: user.name }} />
      <main id="main" tabIndex={-1} className="focus:outline-none flex-1 px-4 py-6 sm:px-6 lg:ml-60 lg:px-10 lg:py-8">
        <div className="mx-auto w-full max-w-6xl">
          {children}
        </div>
      </main>
      <div className="lg:ml-60">
        <SiteFooter />
      </div>
    </div>
  );
}
