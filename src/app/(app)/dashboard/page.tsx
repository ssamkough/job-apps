import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getDashboardInsights } from "@/lib/insights";
import {
  STATUSES,
  STATUS_LABELS,
  STATUS_STYLES,
  STALE_AFTER_DAYS,
} from "@/lib/constants";
import { formatDate, plural } from "@/lib/format";
import { Card, EmptyState, LinkButton, PageHeader, cx } from "@/components/ui";
import { StatusBadge } from "@/components/status-badge";
import { LocalTime } from "@/components/local-time";

export const metadata: Metadata = { title: "Dashboard" };

function Stat({
  label,
  value,
  sub,
  href,
}: {
  label: string;
  value: string | number;
  sub?: string;
  href?: string;
}) {
  const body = (
    <Card className="h-full p-4 sm:p-5">
      <p className="text-sm text-zinc-500">{label}</p>
      <p className="mt-1 text-3xl font-semibold tracking-tight text-zinc-900">
        {value}
      </p>
      {sub && <p className="mt-1 text-xs text-zinc-500">{sub}</p>}
    </Card>
  );
  return href ? (
    <Link href={href} className="block rounded-xl transition-shadow hover:shadow-md">
      {body}
    </Link>
  ) : (
    body
  );
}

export default async function DashboardPage() {
  const user = await requireUser();
  const data = await getDashboardInsights(user.id);

  if (data.total === 0) {
    return (
      <>
        <PageHeader
          title={`Welcome${user.name ? `, ${user.name.split(" ")[0]}` : ""}`}
          description="Your dashboard will fill in as you add applications."
        />
        <Card>
          <EmptyState
            title="No applications yet"
            description="Add the first job you've applied to (or want to apply to). You can attach your resume and write a cover letter on the same page."
            action={<LinkButton href="/applications/new">Add application</LinkButton>}
          />
        </Card>
      </>
    );
  }

  const maxWeek = Math.max(1, ...data.weekly.map((w) => w.count));
  const pipeline = STATUSES.filter((s) => data.byStatus[s] > 0);

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Where your job search stands."
        actions={<LinkButton href="/applications/new">Add application</LinkButton>}
      />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Stat
          label="Total applications"
          value={data.total}
          sub={`${data.appliedLast30Days} in the last 30 days`}
          href="/applications"
        />
        <Stat
          label="Active"
          value={data.active}
          sub="Applied, screening, interviewing, or offer"
        />
        <Stat
          label="Interviewing"
          value={data.interviewing}
          sub={data.offers ? `${plural(data.offers, "offer")} so far` : undefined}
          href="/applications?status=INTERVIEWING"
        />
        <Stat
          label="Response rate"
          value={data.responseRate === null ? "—" : `${data.responseRate}%`}
          sub="Applications that got a reply"
        />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-5">
        <Card className="p-5 lg:col-span-3">
          <h2 className="text-sm font-semibold text-zinc-900">Pipeline</h2>
          <div
            className="mt-4 flex h-3 overflow-hidden rounded-full bg-zinc-100"
            role="img"
            aria-label={pipeline
              .map((s) => `${STATUS_LABELS[s]}: ${data.byStatus[s]}`)
              .join(", ")}
          >
            {pipeline.map((s) => (
              <div
                key={s}
                className={STATUS_STYLES[s].bar}
                style={{ width: `${(data.byStatus[s] / data.total) * 100}%` }}
              />
            ))}
          </div>
          <ul className="mt-5 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
            {STATUSES.map((s) => (
              <li key={s}>
                <Link
                  href={`/applications?status=${s}`}
                  className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-zinc-50"
                >
                  <span className="flex items-center gap-2 text-zinc-600">
                    <span
                      className={cx("h-2.5 w-2.5 rounded-full", STATUS_STYLES[s].bar)}
                    />
                    {STATUS_LABELS[s]}
                  </span>
                  <span className="font-medium tabular-nums text-zinc-900">
                    {data.byStatus[s]}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="p-5 lg:col-span-2">
          <h2 className="text-sm font-semibold text-zinc-900">
            Applications per week
          </h2>
          <p className="text-xs text-zinc-500">Last 12 weeks</p>
          <div className="mt-4 flex h-32 items-end gap-1.5" role="img"
            aria-label={`Applications per week, oldest to newest: ${data.weekly.map((w) => w.count).join(", ")}`}>
            {data.weekly.map((w) => (
              <div
                key={w.start.toISOString()}
                className="group relative flex h-full flex-1 items-end"
                title={`Week of ${formatDate(w.start, false)}: ${plural(w.count, "application")}`}
              >
                <div
                  className={cx(
                    "w-full rounded-t",
                    w.count ? "bg-indigo-500" : "bg-zinc-100",
                  )}
                  style={{ height: w.count ? `${(w.count / maxWeek) * 100}%` : "4px" }}
                />
              </div>
            ))}
          </div>
          <div className="mt-2 flex justify-between text-xs text-zinc-400">
            <span>{formatDate(data.weekly[0].start, false)}</span>
            <span>This week</span>
          </div>
        </Card>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <div className="border-b border-zinc-100 px-5 py-4">
            <h2 className="text-sm font-semibold text-zinc-900">Needs attention</h2>
            <p className="text-xs text-zinc-500">
              No status change in {STALE_AFTER_DAYS}+ days
            </p>
          </div>
          {data.needsAttention.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-zinc-500">
              Nothing is going stale. Nice.
            </p>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {data.needsAttention.map((a) => (
                <li key={a.id}>
                  <Link
                    href={`/applications/${a.id}`}
                    className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-zinc-50"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-zinc-900">
                        {a.company}
                      </span>
                      <span className="block truncate text-xs text-zinc-500">
                        {a.jobTitle}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1">
                      <StatusBadge status={a.status} />
                      <span className="text-xs text-zinc-500">
                        Updated {a.daysSinceUpdate} days ago
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <div className="border-b border-zinc-100 px-5 py-4">
            <h2 className="text-sm font-semibold text-zinc-900">Recent activity</h2>
          </div>
          <ul className="divide-y divide-zinc-100">
            {data.recent.map((e) => (
              <li key={e.id}>
                <Link
                  href={`/applications/${e.applicationId}`}
                  className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-zinc-50"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-zinc-900">
                      {e.company}
                    </span>
                    <span className="block truncate text-xs text-zinc-500">
                      {e.fromStatus
                        ? `${STATUS_LABELS[e.fromStatus]} → ${STATUS_LABELS[e.toStatus]}`
                        : `Added as ${STATUS_LABELS[e.toStatus]}`}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-zinc-500">
                    <LocalTime iso={e.createdAt.toISOString()} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
