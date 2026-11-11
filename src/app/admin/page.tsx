import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/admin";
import {
  ADMIN_PAGE_SIZE,
  getAdminOverview,
  getAdminUsers,
  type AdminOverview,
  type AdminUserPage,
} from "@/lib/admin-data";
import { STATUSES, STATUS_LABELS, STATUS_STYLES } from "@/lib/constants";
import { plural } from "@/lib/format";
import { Card, EmptyState, Notice, PageHeader, buttonClass, cx, inputClass } from "@/components/ui";
import { UserList } from "./user-list";

export const metadata: Metadata = { title: { absolute: "Admin" } };

type SearchParams = { q?: string | string[]; page?: string | string[] };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function href(q: string, page: number) {
  const sp = new URLSearchParams();
  if (q) sp.set("q", q);
  if (page > 1) sp.set("page", String(page));
  const qs = sp.toString();
  return qs ? `/admin?${qs}` : "/admin";
}

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <Card className="p-4 sm:p-5">
      <p className="text-sm text-zinc-500">{label}</p>
      <p className="mt-1 text-3xl font-semibold tracking-tight text-zinc-900">{value}</p>
      {sub && <p className="mt-1 text-xs text-zinc-500">{sub}</p>}
    </Card>
  );
}

function Overview({ data }: { data: AdminOverview }) {
  const { users, applications } = data;
  const pipeline = STATUSES.filter((s) => applications.byStatus[s] > 0);

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Stat
          label="Users"
          value={users.total}
          sub={`${users.verified} verified · ${plural(users.admins, "admin")}`}
        />
        <Stat
          label="New users"
          value={users.new7d}
          sub={`last 7 days · ${users.new30d} in the last 30`}
        />
        <Stat label="Active users" value={users.active30d} sub="Signed in or edited in the last 30 days" />
        <Stat
          label="Applications"
          value={applications.total}
          sub={
            applications.avgPerActiveUser === null
              ? "None yet"
              : `${applications.avgPerActiveUser.toFixed(1)} avg per user who has any · ${plural(data.resumes, "resume")}`
          }
        />
      </div>

      {applications.total > 0 && (
        <Card className="mt-4 p-5">
          <h2 className="text-sm font-semibold text-zinc-900">All applications by status</h2>
          <div
            className="mt-4 flex h-3 overflow-hidden rounded-full bg-zinc-100"
            role="img"
            aria-label={pipeline
              .map((s) => `${STATUS_LABELS[s]}: ${applications.byStatus[s]}`)
              .join(", ")}
          >
            {pipeline.map((s) => (
              <div
                key={s}
                className={STATUS_STYLES[s].bar}
                style={{ width: `${(applications.byStatus[s] / applications.total) * 100}%` }}
              />
            ))}
          </div>
          <ul className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
            {STATUSES.map((s) => (
              <li key={s} className="flex items-center justify-between gap-2 px-2 py-1 text-sm">
                <span className="flex items-center gap-2 text-zinc-600">
                  <span className={cx("h-2.5 w-2.5 rounded-full", STATUS_STYLES[s].bar)} />
                  {STATUS_LABELS[s]}
                </span>
                <span className="font-medium tabular-nums text-zinc-900">
                  {applications.byStatus[s]}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

function Pager({ q, data }: { q: string; data: AdminUserPage }) {
  if (data.pageCount <= 1) return null;
  const from = (data.page - 1) * ADMIN_PAGE_SIZE + 1;
  const to = Math.min(data.total, data.page * ADMIN_PAGE_SIZE);
  return (
    <nav className="mt-4 flex items-center justify-between gap-3 text-sm" aria-label="Pagination">
      <p className="text-zinc-500">
        {from}–{to} of {data.total}
      </p>
      <div className="flex gap-2">
        {data.page > 1 ? (
          <Link href={href(q, data.page - 1)} className={buttonClass("secondary")}>
            Previous
          </Link>
        ) : null}
        {data.page < data.pageCount ? (
          <Link href={href(q, data.page + 1)} className={buttonClass("secondary")}>
            Next
          </Link>
        ) : null}
      </div>
    </nav>
  );
}

export default async function AdminPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireAdmin();
  const sp = await searchParams;
  const q = (first(sp.q) ?? "").trim().slice(0, 100);
  const page = Number.parseInt(first(sp.page) ?? "1", 10);

  let overview: AdminOverview | null = null;
  let list: AdminUserPage | null = null;
  try {
    [overview, list] = await Promise.all([
      getAdminOverview(),
      getAdminUsers({ q, page: Number.isFinite(page) ? page : 1 }),
    ]);
  } catch (e) {
    console.error("admin data load failed:", e instanceof Error ? e.name : "unknown");
  }

  if (!overview || !list) {
    return (
      <>
        <PageHeader title="Admin" />
        <Notice tone="error">
          Couldn&apos;t load user data. Check that the database and Neon Auth are reachable, then
          reload.
        </Notice>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Admin"
        description="Everyone who has signed up, with their applications. Read-only."
      />

      <Overview data={overview} />

      <form action="/admin" className="mb-4 mt-6 flex flex-col gap-2 sm:flex-row">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search by name or email"
          aria-label="Search users"
          className={cx(inputClass, "sm:max-w-sm")}
        />
        <button type="submit" className={buttonClass("secondary")}>
          Search
        </button>
        {q && (
          <Link href="/admin" className={buttonClass("ghost")}>
            Clear
          </Link>
        )}
      </form>

      {list.users.length === 0 ? (
        <Card>
          <EmptyState
            title={q ? "No users match" : "No users yet"}
            description={
              q
                ? `Nobody's name or email contains "${q}".`
                : "People will appear here once they sign up."
            }
          />
        </Card>
      ) : (
        <UserList users={list.users} />
      )}
      <Pager q={q} data={list} />
    </>
  );
}
