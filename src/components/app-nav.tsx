"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { logout } from "@/app/actions/auth";
import { cx } from "@/components/ui";

const items = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/applications", label: "Applications" },
  { href: "/resumes", label: "Resumes" },
  { href: "/settings", label: "Settings" },
];

function useIsActive() {
  const pathname = usePathname();
  return (href: string) => pathname === href || pathname.startsWith(`${href}/`);
}

function Brand() {
  return (
    <Link
      href="/dashboard"
      className="flex items-center gap-2 font-semibold text-zinc-900"
    >
      <span className="grid h-8 w-8 place-items-center rounded-lg bg-indigo-600 text-sm text-white">
        JT
      </span>
      Job Tracker
    </Link>
  );
}

function SignOut({ className }: { className?: string }) {
  return (
    <form action={logout}>
      <button
        type="submit"
        className={cx(
          "rounded-lg px-3 py-2 text-sm text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900",
          className,
        )}
      >
        Sign out
      </button>
    </form>
  );
}

export function AppNav({ user }: { user: { email: string; name: string | null } }) {
  const isActive = useIsActive();

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 hidden w-60 flex-col border-r border-zinc-200 bg-white px-3 py-5 lg:flex">
        <div className="px-2">
          <Brand />
        </div>
        <nav className="mt-8 flex flex-1 flex-col gap-1" aria-label="Main">
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive(item.href) ? "page" : undefined}
              className={cx(
                "rounded-lg px-3 py-2 text-sm font-medium",
                isActive(item.href)
                  ? "bg-indigo-50 text-indigo-700"
                  : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900",
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="border-t border-zinc-200 pt-3">
          <p className="truncate px-3 text-sm font-medium text-zinc-900">
            {user.name ?? user.email}
          </p>
          {user.name && (
            <p className="truncate px-3 text-xs text-zinc-500">{user.email}</p>
          )}
          <SignOut className="mt-2 w-full text-left" />
        </div>
      </aside>

      {/* Mobile / tablet top bar */}
      <header className="sticky top-0 z-20 border-b border-zinc-200 bg-white lg:hidden">
        <div className="flex items-center justify-between px-4 py-3">
          <Brand />
          <SignOut />
        </div>
        <nav
          className="flex gap-1 overflow-x-auto px-3 pb-2"
          aria-label="Main"
        >
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive(item.href) ? "page" : undefined}
              className={cx(
                "whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium",
                isActive(item.href)
                  ? "bg-indigo-50 text-indigo-700"
                  : "text-zinc-600 hover:bg-zinc-100",
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </header>
    </>
  );
}
