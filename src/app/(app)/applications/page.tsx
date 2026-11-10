import type { Metadata } from "next";
import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import {
  STATUSES,
  STATUS_LABELS,
  WORK_TYPE_LABELS,
  isStatus,
  type WorkType,
} from "@/lib/constants";
import { formatDate } from "@/lib/format";
import { Card, EmptyState, LinkButton, PageHeader, cx, inputClass } from "@/components/ui";
import { StatusSelect } from "@/components/status-select";

export const metadata: Metadata = { title: "Applications" };

const SORTS = {
  applied: { label: "Date applied", orderBy: [{ dateApplied: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }] },
  updated: { label: "Recently updated", orderBy: [{ statusUpdatedAt: "desc" }] },
  company: { label: "Company A–Z", orderBy: [{ company: "asc" }] },
} satisfies Record<string, { label: string; orderBy: Prisma.ApplicationOrderByWithRelationInput[] }>;

type SortKey = keyof typeof SORTS;

type SearchParams = { q?: string; status?: string; sort?: string };

function href(params: SearchParams) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
  const qs = sp.toString();
  return qs ? `/applications?${qs}` : "/applications";
}

export default async function ApplicationsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireUser();
  const sp = await searchParams;

  const q = (typeof sp.q === "string" ? sp.q : "").trim().slice(0, 100);
  const status = isStatus(sp.status) ? sp.status : undefined;
  const sort: SortKey = sp.sort && sp.sort in SORTS ? (sp.sort as SortKey) : "applied";

  const where: Prisma.ApplicationWhereInput = {
    userId: user.id,
    ...(status && { status }),
    ...(q && {
      OR: [
        { company: { contains: q, mode: "insensitive" } },
        { jobTitle: { contains: q, mode: "insensitive" } },
        { location: { contains: q, mode: "insensitive" } },
      ],
    }),
  };

  const [apps, counts] = await Promise.all([
    db.application.findMany({
      where,
      orderBy: SORTS[sort].orderBy,
      include: { resume: { select: { id: true, label: true } } },
    }),
    db.application.groupBy({
      by: ["status"],
      where: { userId: user.id },
      _count: { _all: true },
    }),
  ]);

  const countByStatus = new Map(counts.map((c) => [c.status, c._count._all]));
  const total = counts.reduce((n, c) => n + c._count._all, 0);
  const filtering = !!(q || status);

  const tab = (label: string, value: string | undefined, count: number) => {
    const active = status === value;
    return (
      <Link
        key={label}
        href={href({ q, sort: sort === "applied" ? undefined : sort, status: value })}
        aria-current={active ? "page" : undefined}
        className={cx(
          "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium",
          active
            ? "bg-zinc-900 text-white"
            : "bg-white text-zinc-600 ring-1 ring-inset ring-zinc-200 hover:bg-zinc-50",
        )}
      >
        {label}
        <span className={cx("text-xs tabular-nums", active ? "text-zinc-300" : "text-zinc-400")}>
          {count}
        </span>
      </Link>
    );
  };

  return (
    <>
      <PageHeader
        title="Applications"
        description={`${total} total`}
        actions={<LinkButton href="/applications/new">Add application</LinkButton>}
      />

      {total === 0 ? (
        <Card>
          <EmptyState
            title="No applications yet"
            description="Add a job to start tracking its status, resume, and cover letter."
            action={<LinkButton href="/applications/new">Add application</LinkButton>}
          />
        </Card>
      ) : (
        <>
          <div className="-mx-4 mb-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
            {tab("All", undefined, total)}
            {STATUSES.filter((s) => countByStatus.get(s)).map((s) =>
              tab(STATUS_LABELS[s], s, countByStatus.get(s) ?? 0),
            )}
          </div>

          <form action="/applications" className="mb-4 flex flex-col gap-2 sm:flex-row">
            {status && <input type="hidden" name="status" value={status} />}
            <input
              type="search"
              name="q"
              defaultValue={q}
              placeholder="Search company, title, or location"
              aria-label="Search applications"
              className={cx(inputClass, "sm:max-w-sm")}
            />
            <select
              name="sort"
              defaultValue={sort}
              aria-label="Sort by"
              className={cx(inputClass, "sm:w-48")}
            >
              {Object.entries(SORTS).map(([key, s]) => (
                <option key={key} value={key}>
                  {s.label}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="rounded-lg border border-zinc-300 bg-white px-3.5 py-2 text-sm font-medium text-zinc-800 shadow-sm hover:bg-zinc-50"
            >
              Apply
            </button>
            {filtering && (
              <Link
                href="/applications"
                className="px-2 py-2 text-sm text-zinc-500 hover:text-zinc-800"
              >
                Clear
              </Link>
            )}
          </form>

          {apps.length === 0 ? (
            <Card>
              <EmptyState
                title="No matches"
                description="Try a different search or filter."
                action={
                  <LinkButton href="/applications" variant="secondary">
                    Clear filters
                  </LinkButton>
                }
              />
            </Card>
          ) : (
            <>
              {/* Desktop table */}
              <Card className="hidden overflow-hidden md:block">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
                    <tr>
                      <th className="px-4 py-3 font-medium">Company / role</th>
                      <th className="px-4 py-3 font-medium">Status</th>
                      <th className="px-4 py-3 font-medium">Applied</th>
                      <th className="hidden px-4 py-3 font-medium xl:table-cell">
                        Location
                      </th>
                      <th className="hidden px-4 py-3 font-medium lg:table-cell">
                        Resume
                      </th>
                      <th className="px-4 py-3 font-medium">Updated</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100">
                    {apps.map((a) => (
                      <tr key={a.id} className="hover:bg-zinc-50/70">
                        <td className="max-w-xs px-4 py-3">
                          <Link href={`/applications/${a.id}`} className="block">
                            <span className="block truncate font-medium text-zinc-900">
                              {a.company}
                            </span>
                            <span className="block truncate text-zinc-500">
                              {a.jobTitle}
                            </span>
                          </Link>
                        </td>
                        <td className="px-4 py-3">
                          <StatusSelect
                            id={a.id}
                            status={a.status}
                            label={`Status for ${a.company}`}
                          />
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-zinc-600">
                          {formatDate(a.dateApplied)}
                        </td>
                        <td className="hidden max-w-[12rem] truncate px-4 py-3 text-zinc-600 xl:table-cell">
                          {[
                            a.location,
                            a.workType && WORK_TYPE_LABELS[a.workType as WorkType],
                          ]
                            .filter(Boolean)
                            .join(" · ") || "—"}
                        </td>
                        <td className="hidden max-w-[10rem] truncate px-4 py-3 text-zinc-600 lg:table-cell">
                          {a.resume?.label ?? "—"}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-zinc-500">
                          {formatDate(a.statusUpdatedAt, false)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>

              {/* Mobile cards */}
              <ul className="space-y-3 md:hidden">
                {apps.map((a) => (
                  <li key={a.id}>
                    <Card className="p-4">
                      <Link href={`/applications/${a.id}`} className="block">
                        <span className="block font-medium text-zinc-900">
                          {a.company}
                        </span>
                        <span className="block text-sm text-zinc-500">
                          {a.jobTitle}
                        </span>
                      </Link>
                      <div className="mt-3 flex items-center justify-between gap-3">
                        <StatusSelect
                          id={a.id}
                          status={a.status}
                          label={`Status for ${a.company}`}
                        />
                        <span className="text-xs text-zinc-500">
                          Applied {formatDate(a.dateApplied)}
                        </span>
                      </div>
                    </Card>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </>
  );
}
