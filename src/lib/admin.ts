import "server-only";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser, type CurrentUser } from "@/lib/auth";

/**
 * Admin access.
 *
 * Roles live in Neon Auth (Better Auth's admin plugin): `neon_auth."user".role`
 * is `user` or `admin`. We read it straight from the database on every check
 * instead of from the session, so removing someone's admin role takes effect
 * on their next request rather than when a cached session expires. Identity
 * (who is signed in) still comes from `requireUser`.
 *
 * Fails closed: if the role can't be read (table missing, query error) the
 * caller is treated as a non-admin.
 *
 * Grant or revoke admin in the Neon Console (Auth → Users), with the Neon MCP
 * `update_auth_user_role` tool, or in SQL:
 *   UPDATE neon_auth."user" SET role = 'admin' WHERE email = 'you@example.com';
 */

type AuthRoleRow = { role: string | null; banned: boolean | null; banExpires: Date | null };

/** Better Auth stores several roles as one comma-separated string. */
export function hasAdminRole(role: string | null | undefined): boolean {
  if (!role) return false;
  return role
    .split(",")
    .map((r) => r.trim().toLowerCase())
    .includes("admin");
}

function isBanned(row: Pick<AuthRoleRow, "banned" | "banExpires">, now = new Date()) {
  return row.banned === true && (!row.banExpires || row.banExpires > now);
}

/** True when the Neon Auth user has the admin role and isn't banned. */
export async function isAdmin(userId: string): Promise<boolean> {
  try {
    const rows = await db.$queryRaw<AuthRoleRow[]>`
      SELECT "role", "banned", "banExpires"
      FROM neon_auth."user"
      WHERE "id" = ${userId}::uuid
    `;
    const row = rows[0];
    return !!row && hasAdminRole(row.role) && !isBanned(row);
  } catch (e) {
    // Log the error class only: query errors can echo values.
    console.error("admin role lookup failed:", e instanceof Error ? e.name : "unknown");
    return false;
  }
}

/**
 * Gate for admin pages. Signed-out visitors go to /login and unverified ones
 * to email verification (via `requireUser`); signed-in non-admins get a 404 so
 * the page's existence isn't advertised. Call it in every admin page and
 * action: the proxy is not the security boundary.
 */
export async function requireAdmin(): Promise<CurrentUser> {
  const user = await requireUser();
  if (!(await isAdmin(user.id))) notFound();
  return user;
}
