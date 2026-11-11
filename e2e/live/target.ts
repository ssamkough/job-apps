/**
 * Where the LIVE smoke test points and what it may do, read from the
 * environment and validated before anything runs. Used by both
 * playwright.live.config.ts and the spec, so the rules can't be bypassed by
 * running the spec some other way.
 *
 * Nothing here is read at import time by the normal suites: `npm run test:e2e`
 * never loads this file (see `testIgnore` in playwright.config.ts).
 */

export type LiveTarget = {
  /** Origin of the deployment under test, e.g. https://job-apps.vercel.app */
  baseURL: string;
  /** True for localhost: https is waived and HSTS-over-http is not an error. */
  isLocal: boolean;
  /** Whether this deployment is expected to have AI drafts ON (default: off, like production). */
  expectAi: boolean;
  /** Present only when the operator explicitly opted in to the account journey. */
  journey: null | {
    email: string;
    /** DIRECT Postgres URL of the deployment's database (read-only use: reads the emailed code). */
    databaseUrl: string;
  };
  /** Why the journey is off, for the "skipped" line. */
  journeyOffReason: string;
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function liveTarget(env: NodeJS.ProcessEnv = process.env): LiveTarget {
  const raw = env.LIVE_BASE_URL?.trim();
  if (!raw) {
    throw new Error(
      "LIVE_BASE_URL is not set. The live smoke test only runs against a URL you name on purpose, e.g.\n" +
        "  LIVE_BASE_URL=https://your-app.vercel.app npm run test:live",
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("LIVE_BASE_URL is not a valid URL (include https://).");
  }
  const isLocal = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) {
    throw new Error("LIVE_BASE_URL must be https:// (plain http is accepted only for localhost).");
  }
  if (url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error("LIVE_BASE_URL must be just the origin, e.g. https://your-app.vercel.app (no path, query or credentials).");
  }

  const expectAi = env.LIVE_EXPECT_AI === "on";
  if (env.LIVE_EXPECT_AI && !["on", "off"].includes(env.LIVE_EXPECT_AI)) {
    throw new Error('LIVE_EXPECT_AI must be "on" or "off" (default off).');
  }

  const base = { baseURL: url.origin, isLocal, expectAi };
  const flag = env.LIVE_ALLOW_ACCOUNT_JOURNEY;
  if (flag === undefined || flag === "") {
    return {
      ...base,
      journey: null,
      journeyOffReason: "account journey is off (set LIVE_ALLOW_ACCOUNT_JOURNEY=1 to opt in)",
    };
  }
  if (flag !== "1") {
    throw new Error("LIVE_ALLOW_ACCOUNT_JOURNEY must be exactly 1 to opt in (or unset).");
  }

  // The journey creates a real account, so every input must be deliberate.
  let email = env.LIVE_TEST_EMAIL?.trim() ?? "";
  if (!email) throw new Error("LIVE_TEST_EMAIL is required for the account journey (a plus-address of an inbox you own).");
  // "{ts}" lets a script mint a fresh address per run: me+job-live-{ts}@example.com
  email = email.replace("{ts}", Date.now().toString(36)).toLowerCase();
  // Pin the stamp: the config and the test worker both call this, and must agree.
  env.LIVE_TEST_EMAIL = email;
  const m = /^([^@\s+]+)\+([^@\s]+)@([^@\s]+\.[^@\s]+)$/.exec(email);
  if (!m) {
    throw new Error("LIVE_TEST_EMAIL must be a plus-address like you+job-live-1@example.com (name+tag@domain).");
  }
  const databaseUrl = env.LIVE_DATABASE_URL?.trim() ?? "";
  if (!databaseUrl) {
    throw new Error(
      "LIVE_DATABASE_URL is required for the account journey: the DIRECT (non-pooler) Postgres URL of the deployment's\n" +
        "database. It is used only to read the emailed code and to check what remains. It is never logged.",
    );
  }
  let db: URL;
  try {
    db = new URL(databaseUrl);
  } catch {
    throw new Error("LIVE_DATABASE_URL is not a valid postgres URL.");
  }
  if (!/^postgres(ql)?:$/.test(db.protocol)) throw new Error("LIVE_DATABASE_URL must start with postgresql://");
  if (db.hostname.includes("-pooler")) {
    throw new Error("LIVE_DATABASE_URL must be the DIRECT url (no -pooler in the host), not the pooled one.");
  }
  return { ...base, journey: { email, databaseUrl }, journeyOffReason: "" };
}
