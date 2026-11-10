/**
 * Absolute URLs for links in emails. Always built from APP_URL, never from the
 * incoming Host header: a forged Host header could otherwise poison password
 * reset links to point at an attacker's site.
 */
export function appUrl(pathAndQuery: string) {
  const base =
    process.env.APP_URL ||
    (process.env.NODE_ENV === "production" ? "" : "http://localhost:3000");
  if (!base) throw new Error("APP_URL must be set in production");
  return new URL(pathAndQuery, base).toString();
}
