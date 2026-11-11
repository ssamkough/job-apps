// Creates the dev test account described in .test-account.local in Neon Auth.
//
//   node --env-file=.env scripts/create-test-account.mjs --allow-host <host>
//   node --env-file=.env scripts/create-test-account.mjs --allow-host <host> --code 123456
//
// What it does, in order (all over Neon Auth's HTTP API, the same endpoints
// the app's SDK calls):
//   1. POST /sign-in/email: if the account already works, it stops there.
//      A 403 EMAIL_NOT_VERIFIED means the account exists but is unverified
//      (Neon Auth has just emailed a fresh code).
//   2. Otherwise POST /sign-up/email. Neon Auth answers the same for a new and
//      an already-registered address, so this cannot tell you which it was.
//   3. POST /email-otp/verify-email with the 6-digit code from the inbox
//      (prompted for, or passed with --code).
//
// What it cannot do: skip the emailed code. Neon Auth does not offer a
// supported way to mark a password account verified without the code, and this
// script does not invent one. The address therefore has to be a real inbox you
// can read. The shared sender's rate limit is undocumented: if no code arrives,
// wait and try again.
//
// The app's own `User` row is NOT created here: the app creates it on the
// account's first authenticated request (src/lib/auth.ts, ensureAppUser).
// Nothing in this script touches a database.
//
// Safety:
//   - Refuses when NODE_ENV=production.
//   - Needs --allow-host <host> (or TEST_ACCOUNT_ALLOW_HOST) that exactly equals
//     the host of NEON_AUTH_BASE_URL. Pointing it at the production Neon Auth
//     therefore takes a deliberate act; use a development branch's URL.
//   - Prints the host it uses, but never the password, the code or any secret.
//
// .test-account.local is gitignored and has these lines:
//   Email: you+jobapps@example.com
//   Password: (8 to 128 characters)
//   Name: Dev Tester          (optional)
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

const die = (message) => {
  console.error(message);
  process.exit(1);
};

if (process.env.NODE_ENV === "production") {
  die("Refusing to create a test account when NODE_ENV=production.");
}

// ---- arguments ------------------------------------------------------------

function flag(name) {
  const args = process.argv.slice(2);
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return undefined;
  const a = args[i];
  return a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[i + 1];
}

// ---- target ---------------------------------------------------------------

const rawBase = process.env.NEON_AUTH_BASE_URL;
if (!rawBase) die("NEON_AUTH_BASE_URL is not set (run with: node --env-file=.env ...).");
let base;
try {
  base = new URL(rawBase);
} catch {
  die("NEON_AUTH_BASE_URL is not a valid URL.");
}
const baseUrl = rawBase.replace(/\/+$/, "");

const allowed = flag("allow-host") ?? process.env.TEST_ACCOUNT_ALLOW_HOST;
console.log(`Neon Auth host: ${base.host}`);
if (!allowed) {
  die(
    "Refusing to run without an explicit target.\n" +
      `Re-run with:  --allow-host ${base.host}\n` +
      "Only do that for a development Neon branch, never the production one.",
  );
}
if (allowed !== base.host) {
  die(`--allow-host (${allowed}) does not match the Neon Auth host above. Nothing was sent.`);
}

// Neon Auth rejects requests whose Origin isn't a trusted one. With "Allow
// localhost" on (the default for a development branch) any localhost origin works.
const origin = process.env.TEST_ACCOUNT_ORIGIN || "http://localhost:3000";

// ---- the account ----------------------------------------------------------

let text;
try {
  text = readFileSync(".test-account.local", "utf8");
} catch {
  die(".test-account.local not found. Create it with Email:, Password: and optional Name: lines.");
}
const field = (name) => text.match(new RegExp(`^${name}:\\s*(.+)$`, "mi"))?.[1].trim();
const email = field("Email")?.toLowerCase();
const password = field("Password");
const name = field("Name") ?? "";
if (!email || !password) die(".test-account.local needs Email: and Password: lines");
if (password.length < 8 || password.length > 128) die("Password must be 8 to 128 characters.");

const [local, domain = ""] = email.split("@");
const masked = `${local.slice(0, 1)}***@${domain}`;

// ---- HTTP -----------------------------------------------------------------

/** One call to Neon Auth. Never throws; never logs the request body. */
async function call(path, body) {
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const raw = await res.text();
    let json = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      // Not JSON (for example an HTML error page); only the status is useful.
    }
    return { status: res.status, json };
  } catch (e) {
    return { status: 0, json: null, networkError: e instanceof Error ? e.message : "network error" };
  }
}

/** A short description of a failure that is safe to print (code and message from Neon Auth only). */
function describe(r) {
  if (r.networkError) return `could not reach Neon Auth (${r.networkError})`;
  const code = r.json?.code ? ` ${r.json.code}` : "";
  const message = typeof r.json?.message === "string" ? `: ${r.json.message}` : "";
  const hint =
    r.status === 429
      ? " (rate limited; the shared email sender's limit is undocumented, wait a while)"
      : r.json?.code === "INVALID_ORIGIN" || /origin/i.test(r.json?.message ?? "")
        ? ` (origin ${origin} isn't trusted: turn on "Allow localhost" for this Neon branch, or set TEST_ACCOUNT_ORIGIN to a trusted origin)`
        : "";
  return `HTTP ${r.status}${code}${message}${hint}`;
}

async function readCode() {
  const given = flag("code");
  if (given) return given.trim();
  if (!process.stdin.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question("Enter the 6-digit code from the email (blank to stop): ")).trim() || null;
  } finally {
    rl.close();
  }
}

async function verify(code) {
  if (!/^\d{4,10}$/.test(code)) die("The code should be the digits from the email.");
  const r = await call("/email-otp/verify-email", { email, otp: code });
  if (r.status === 200) {
    console.log(`Test account ${masked} is verified. Sign in at the app; its app-side row is created on first sign-in.`);
    return;
  }
  die(`Verification failed: ${describe(r)}\nThe code may be wrong or expired; sign in or re-run to get a new one.`);
}

// ---- main -----------------------------------------------------------------

// A code was passed in: verify directly. Signing in first would make Neon Auth
// email a new code and could invalidate the one being used.
if (flag("code")) {
  await verify(flag("code").trim());
  process.exit(0);
}

const signIn = await call("/sign-in/email", { email, password });
if (signIn.status === 200) {
  console.log(`Test account ${masked} already exists and can sign in. Nothing to do.`);
  process.exit(0);
}

let needsCode = false;
if (signIn.status === 403 && signIn.json?.code === "EMAIL_NOT_VERIFIED") {
  console.log(`Test account ${masked} exists but isn't verified; Neon Auth has emailed a new code.`);
  needsCode = true;
} else if (signIn.status === 401 || signIn.status === 400) {
  // Unknown address and wrong password look the same here, so try to sign up.
  const signUp = await call("/sign-up/email", { email, password, name });
  if (signUp.status !== 200) die(`Sign-up failed: ${describe(signUp)}`);
  console.log(
    `Sign-up accepted for ${masked}. If the address is new, a verification code was emailed to it.\n` +
      "(Neon Auth answers the same for an address that is already registered. If it already\n" +
      " has an account with a different password, no code is sent: sign in to the app and use\n" +
      " 'Forgot password', or change the password in .test-account.local.)",
  );
  needsCode = true;
} else {
  die(`Sign-in check failed: ${describe(signIn)}`);
}

if (needsCode) {
  const code = await readCode();
  if (code) {
    await verify(code);
  } else {
    console.log(
      "\nNext step: read the code from that inbox, then run:\n" +
        `  node --env-file=.env scripts/create-test-account.mjs --allow-host ${base.host} --code <code>\n` +
        "(Codes are short-lived; if it has expired, run the script again without --code for a fresh one.)",
    );
  }
}
