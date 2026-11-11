import "server-only";
import { db } from "@/lib/db";
import { STATUSES, isStatus, type Status } from "@/lib/constants";
import { hasAdminRole } from "@/lib/admin";

/**
 * Read-only queries behind /admin. Callers must have passed `requireAdmin()`.
 *
 * Users come from Neon Auth (`neon_auth.user`, so people who signed up but
 * never opened the app are included); applications come from our own tables.
 * Only list-level fields of an application are returned. Notes, cover letters,
 * contacts and resumes are deliberately left out.
 */

export const ADMIN_PAGE_SIZE = 25;
/** Applications listed per user before "and N more". */
export const APPS_PER_USER = 50;

const DAY_MS = 86_400_000;

export type CountsByStatus = Record<Status, number>;

const emptyCounts = (): CountsByStatus =>
  Object.fromEntries(STATUSES.map((s) => [s, 0])) as CountsByStatus;

export type AdminOverview = {
  users: { total: number; verified: number; admins: number; new7d: number; new30d: number; active30d: number };
  applications: {
    total: number;
    byStatus: CountsByStatus;
    usersWithApplications: number;
    avgPerActiveUser: number | null;
  };
  resumes: number;
};

export type AdminApplication = {
  id: string;
  company: string;
  jobTitle: string;
  status: string;
  location: string | null;
  workType: string | null;
  dateApplied: Date | null;
  updatedAt: Date;
};

export type AdminUserRow = {
  id: string;
  name: string | null;
  email: string;
  emailVerified: boolean;
  isAdmin: boolean;
  banned: boolean;
  signedUpAt: Date;
  /** Latest of: last session activity, last application change. */
  lastActiveAt: Date | null;
  applicationCount: number;
  byStatus: CountsByStatus;
  applications: AdminApplication[];
};

export type AdminUserPage = {
  users: AdminUserRow[];
  total: number;
  page: number;
  pageCount: number;
};

export async function getAdminOverview(now = new Date()): Promise<AdminOverview> {
  const since7 = new Date(now.getTime() - 7 * DAY_MS);
  const since30 = new Date(now.getTime() - 30 * DAY_MS);

  const [userStats, active, byStatusRows, withApps, resumes] = await Promise.all([
    db.$queryRaw<
      { total: number; verified: number; admins: number; new7d: number; new30d: number }[]
    >`
      SELECT
        count(*)::int AS "total",
        (count(*) FILTER (WHERE "emailVerified"))::int AS "verified",
        (count(*) FILTER (
          WHERE lower(coalesce("role", '')) ~ '(^|,)[[:space:]]*admin[[:space:]]*(,|$)'
        ))::int AS "admins",
        (count(*) FILTER (WHERE "createdAt" >= ${since7}))::int AS "new7d",
        (count(*) FILTER (WHERE "createdAt" >= ${since30}))::int AS "new30d"
      FROM neon_auth."user"
    `,
    db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS "n" FROM (
        SELECT "userId"::text AS uid FROM neon_auth.session WHERE "updatedAt" >= ${since30}
        UNION
        SELECT "userId" AS uid FROM "Application" WHERE "updatedAt" >= ${since30}
      ) active
    `,
    db.application.groupBy({ by: ["status"], _count: { _all: true } }),
    db.$queryRaw<{ n: number }[]>`
      SELECT count(DISTINCT "userId")::int AS "n" FROM "Application"
    `,
    db.resume.count(),
  ]);

  const byStatus = emptyCounts();
  let total = 0;
  for (const row of byStatusRows) {
    total += row._count._all;
    if (isStatus(row.status)) byStatus[row.status] += row._count._all;
  }
  const usersWithApplications = withApps[0]?.n ?? 0;
  const u = userStats[0] ?? { total: 0, verified: 0, admins: 0, new7d: 0, new30d: 0 };

  return {
    users: { ...u, active30d: active[0]?.n ?? 0 },
    applications: {
      total,
      byStatus,
      usersWithApplications,
      avgPerActiveUser: usersWithApplications ? total / usersWithApplications : null,
    },
    resumes,
  };
}

/** Escapes LIKE wildcards so a search for "50%" matches literally. */
function likePattern(q: string) {
  return `%${q.replace(/[!%_]/g, (c) => `!${c}`)}%`;
}

type UserRecord = {
  id: string;
  name: string | null;
  email: string;
  emailVerified: boolean;
  role: string | null;
  banned: boolean | null;
  banExpires: Date | null;
  createdAt: Date;
  lastSeenAt: Date | null;
};

export async function getAdminUsers(opts: { q?: string; page?: number } = {}, now = new Date()): Promise<AdminUserPage> {
  const q = (opts.q ?? "").trim().slice(0, 100);
  const pattern = likePattern(q);
  const wantedPage = Math.max(1, Math.floor(opts.page ?? 1) || 1);

  const [{ n: total } = { n: 0 }] = await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS "n" FROM neon_auth."user"
    WHERE (${q}::text = '' OR "email" ILIKE ${pattern} ESCAPE '!' OR "name" ILIKE ${pattern} ESCAPE '!')
  `;
  const pageCount = Math.max(1, Math.ceil(total / ADMIN_PAGE_SIZE));
  const page = Math.min(wantedPage, pageCount);

  const records = await db.$queryRaw<UserRecord[]>`
    SELECT u."id"::text AS "id", u."name", u."email", u."emailVerified", u."role",
           u."banned", u."banExpires", u."createdAt",
           (SELECT max(s."updatedAt") FROM neon_auth.session s WHERE s."userId" = u."id") AS "lastSeenAt"
    FROM neon_auth."user" u
    WHERE (${q}::text = '' OR u."email" ILIKE ${pattern} ESCAPE '!' OR u."name" ILIKE ${pattern} ESCAPE '!')
    ORDER BY u."createdAt" DESC, u."id"
    LIMIT ${ADMIN_PAGE_SIZE} OFFSET ${(page - 1) * ADMIN_PAGE_SIZE}
  `;

  const apps = records.length
    ? await db.application.findMany({
        where: { userId: { in: records.map((r) => r.id) } },
        orderBy: [{ updatedAt: "desc" }],
        select: {
          id: true,
          userId: true,
          company: true,
          jobTitle: true,
          status: true,
          location: true,
          workType: true,
          dateApplied: true,
          updatedAt: true,
        },
      })
    : [];

  const appsByUser = new Map<string, typeof apps>();
  for (const a of apps) {
    const list = appsByUser.get(a.userId);
    if (list) list.push(a);
    else appsByUser.set(a.userId, [a]);
  }

  const users = records.map((r): AdminUserRow => {
    const mine = appsByUser.get(r.id) ?? [];
    const byStatus = emptyCounts();
    for (const a of mine) if (isStatus(a.status)) byStatus[a.status]++;
    // `mine` is newest-first, so the first row has the latest change.
    const lastAppChange = mine[0]?.updatedAt ?? null;
    const lastActiveAt =
      lastAppChange && r.lastSeenAt
        ? new Date(Math.max(lastAppChange.getTime(), r.lastSeenAt.getTime()))
        : (lastAppChange ?? r.lastSeenAt);

    return {
      id: r.id,
      name: r.name || null,
      email: r.email,
      emailVerified: r.emailVerified,
      isAdmin: hasAdminRole(r.role),
      banned: r.banned === true && (!r.banExpires || r.banExpires > now),
      signedUpAt: r.createdAt,
      lastActiveAt,
      applicationCount: mine.length,
      byStatus,
      applications: mine.slice(0, APPS_PER_USER).map((a) => ({
        id: a.id,
        company: a.company,
        jobTitle: a.jobTitle,
        status: a.status,
        location: a.location,
        workType: a.workType,
        dateApplied: a.dateApplied,
        updatedAt: a.updatedAt,
      })),
    };
  });

  return { users, total, page, pageCount };
}
