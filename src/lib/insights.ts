import "server-only";
import { db } from "@/lib/db";
import {
  ACTIVE_STATUSES,
  RESPONDED_STATUSES,
  STALE_AFTER_DAYS,
  STATUSES,
  isStatus,
  type Status,
} from "@/lib/constants";
import { daysSince } from "@/lib/format";

const WEEKS = 12;

function weekStartUTC(date: Date) {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const dayFromMonday = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayFromMonday);
  return d;
}

export async function getDashboardInsights(userId: string) {
  const [apps, events] = await Promise.all([
    db.application.findMany({
      where: { userId },
      select: {
        id: true,
        company: true,
        jobTitle: true,
        status: true,
        dateApplied: true,
        statusUpdatedAt: true,
      },
    }),
    db.statusEvent.findMany({
      where: { application: { userId } },
      orderBy: { createdAt: "desc" },
      take: 8,
      include: {
        application: { select: { id: true, company: true, jobTitle: true } },
      },
    }),
  ]);

  const now = new Date();

  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<
    Status,
    number
  >;
  for (const a of apps) if (isStatus(a.status)) byStatus[a.status]++;

  const submitted = apps.length - byStatus.WISHLIST;
  const responded = RESPONDED_STATUSES.reduce((n, s) => n + byStatus[s], 0);
  // WITHDRAWN could have happened before or after a response; leave it out of
  // the rate rather than guess.
  const rateBase = submitted - byStatus.WITHDRAWN;

  // Applications submitted per week for the last WEEKS weeks (oldest first).
  const thisWeek = weekStartUTC(now);
  const weekly = Array.from({ length: WEEKS }, (_, i) => {
    const start = new Date(thisWeek);
    start.setUTCDate(start.getUTCDate() - 7 * (WEEKS - 1 - i));
    return { start, count: 0 };
  });
  for (const a of apps) {
    if (!a.dateApplied) continue;
    const idx = weekly.findIndex(
      (w) => w.start.getTime() === weekStartUTC(a.dateApplied!).getTime(),
    );
    if (idx >= 0) weekly[idx].count++;
  }

  const needsAttention = apps
    .filter(
      (a) =>
        isStatus(a.status) &&
        ACTIVE_STATUSES.includes(a.status) &&
        a.status !== "OFFER" &&
        daysSince(a.statusUpdatedAt, now) >= STALE_AFTER_DAYS,
    )
    .map((a) => ({
      id: a.id,
      company: a.company,
      jobTitle: a.jobTitle,
      status: a.status as Status,
      daysSinceUpdate: daysSince(a.statusUpdatedAt, now),
    }))
    .sort((a, b) => b.daysSinceUpdate - a.daysSinceUpdate)
    .slice(0, 6);

  return {
    total: apps.length,
    active: ACTIVE_STATUSES.reduce((n, s) => n + byStatus[s], 0),
    interviewing: byStatus.INTERVIEWING,
    offers: byStatus.OFFER + byStatus.ACCEPTED,
    responseRate: rateBase > 0 ? Math.round((responded / rateBase) * 100) : null,
    appliedLast30Days: apps.filter(
      (a) => a.dateApplied && daysSince(a.dateApplied, now) <= 30,
    ).length,
    byStatus,
    weekly,
    needsAttention,
    recent: events.map((e) => ({
      id: e.id,
      applicationId: e.application.id,
      company: e.application.company,
      jobTitle: e.application.jobTitle,
      fromStatus: e.fromStatus && isStatus(e.fromStatus) ? e.fromStatus : null,
      toStatus: e.toStatus as Status,
      createdAt: e.createdAt,
    })),
  };
}
