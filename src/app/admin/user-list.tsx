import { STATUSES, STATUS_LABELS, STATUS_STYLES, WORK_TYPE_LABELS, type WorkType } from "@/lib/constants";
import { APPS_PER_USER, type AdminUserRow } from "@/lib/admin-data";
import { daysSince, formatDate, plural } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";
import { Card, cx } from "@/components/ui";

function Pill({ tone, children }: { tone: "indigo" | "rose" | "amber"; children: React.ReactNode }) {
  const tones = {
    indigo: "bg-indigo-50 text-indigo-700 ring-indigo-200",
    rose: "bg-rose-50 text-rose-700 ring-rose-200",
    amber: "bg-amber-50 text-amber-800 ring-amber-200",
  } as const;
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

function relative(date: Date | null) {
  if (!date) return "Never";
  const days = daysSince(date);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 60) return `${days} days ago`;
  return formatDate(date);
}

function StatusBar({ user }: { user: AdminUserRow }) {
  if (user.applicationCount === 0) return <span className="text-sm text-zinc-400">—</span>;
  const present = STATUSES.filter((s) => user.byStatus[s] > 0);
  return (
    <div
      className="flex h-2 w-full min-w-24 overflow-hidden rounded-full bg-zinc-100"
      role="img"
      aria-label={present.map((s) => `${STATUS_LABELS[s]}: ${user.byStatus[s]}`).join(", ")}
      title={present.map((s) => `${STATUS_LABELS[s]}: ${user.byStatus[s]}`).join("\n")}
    >
      {present.map((s) => (
        <div
          key={s}
          className={STATUS_STYLES[s].bar}
          style={{ width: `${(user.byStatus[s] / user.applicationCount) * 100}%` }}
        />
      ))}
    </div>
  );
}

const GRID = "lg:grid lg:grid-cols-[minmax(0,2.2fr)_7rem_8rem_6rem_minmax(7rem,1fr)] lg:items-center lg:gap-4";

function UserApplications({ user }: { user: AdminUserRow }) {
  if (user.applicationCount === 0) {
    return <p className="px-4 py-6 text-sm text-zinc-500 sm:px-5">No applications yet.</p>;
  }
  const hidden = user.applicationCount - user.applications.length;
  return (
    <>
      <ul className="divide-y divide-zinc-100">
        {user.applications.map((a) => (
          <li
            key={a.id}
            className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-5"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-zinc-900">{a.company}</p>
              <p className="truncate text-xs text-zinc-500">
                {[
                  a.jobTitle,
                  a.location,
                  a.workType && a.workType in WORK_TYPE_LABELS
                    ? WORK_TYPE_LABELS[a.workType as WorkType]
                    : null,
                ]
                  .filter((part, i, all): part is string => !!part && all.indexOf(part) === i)
                  .join(" · ")}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-3 sm:justify-end">
              <span className="text-xs text-zinc-500">
                {a.dateApplied ? `Applied ${formatDate(a.dateApplied)}` : "No date"}
                {" · "}Updated {relative(a.updatedAt).toLowerCase()}
              </span>
              <StatusBadge status={a.status} />
            </div>
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <p className="border-t border-zinc-100 px-4 py-3 text-xs text-zinc-500 sm:px-5">
          Showing the {APPS_PER_USER} most recently updated; {plural(hidden, "more application")} not
          shown.
        </p>
      )}
    </>
  );
}

export function UserList({ users }: { users: AdminUserRow[] }) {
  return (
    <Card className="overflow-hidden">
      <div
        className={cx(
          "hidden border-b border-zinc-200 bg-zinc-50 px-5 py-2.5 text-xs font-medium uppercase tracking-wide text-zinc-500",
          GRID,
        )}
        aria-hidden="true"
      >
        <span>User</span>
        <span>Signed up</span>
        <span>Last active</span>
        <span>Apps</span>
        <span>Status mix</span>
      </div>
      <ul className="divide-y divide-zinc-200">
        {users.map((u) => (
          <li key={u.id}>
            <details className="group">
              <summary
                className={cx(
                  "flex cursor-pointer list-none flex-col gap-2 px-4 py-3 hover:bg-zinc-50 sm:px-5 [&::-webkit-details-marker]:hidden",
                  GRID,
                )}
              >
                <span className="flex min-w-0 items-start gap-2">
                  <span
                    aria-hidden="true"
                    className="mt-1 text-xs text-zinc-400 transition-transform group-open:rotate-90"
                  >
                    ▶
                  </span>
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="truncate text-sm font-medium text-zinc-900">
                        {u.name ?? u.email}
                      </span>
                      {u.isAdmin && <Pill tone="indigo">Admin</Pill>}
                      {u.banned && <Pill tone="rose">Banned</Pill>}
                      {!u.emailVerified && <Pill tone="amber">Unverified</Pill>}
                    </span>
                    {u.name && <span className="block truncate text-xs text-zinc-500">{u.email}</span>}
                  </span>
                </span>
                <span className="flex gap-4 pl-5 text-xs text-zinc-500 lg:contents lg:pl-0 lg:text-sm lg:text-zinc-700">
                  <span>
                    <span className="lg:hidden">Joined </span>
                    {formatDate(u.signedUpAt)}
                  </span>
                  <span title={u.lastActiveAt?.toISOString()}>
                    <span className="lg:hidden">Active </span>
                    {relative(u.lastActiveAt)}
                  </span>
                  <span className="tabular-nums">
                    {u.applicationCount}
                    <span className="lg:hidden"> {u.applicationCount === 1 ? "app" : "apps"}</span>
                  </span>
                </span>
                <span className="pl-5 lg:pl-0">
                  <StatusBar user={u} />
                </span>
              </summary>
              <div className="border-t border-zinc-100 bg-zinc-50/50">
                <dl className="flex flex-wrap gap-x-6 gap-y-1 px-4 py-3 text-xs text-zinc-500 sm:px-5">
                  <div>
                    <dt className="inline">User ID: </dt>
                    <dd className="inline font-mono text-zinc-700">{u.id}</dd>
                  </div>
                  {STATUSES.filter((s) => u.byStatus[s] > 0).map((s) => (
                    <div key={s}>
                      <dt className="inline">{STATUS_LABELS[s]}: </dt>
                      <dd className="inline font-medium text-zinc-700">{u.byStatus[s]}</dd>
                    </div>
                  ))}
                </dl>
                <div className="border-t border-zinc-100 bg-white">
                  <UserApplications user={u} />
                </div>
              </div>
            </details>
          </li>
        ))}
      </ul>
    </Card>
  );
}
