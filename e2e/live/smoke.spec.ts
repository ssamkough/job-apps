/**
 * LIVE smoke test for a deployed instance. Opt-in: `npm run test:live`.
 *
 *   LIVE_BASE_URL=https://your-app.vercel.app npm run test:live
 *
 * It never starts a server, never runs in CI, and refuses to start when
 * LIVE_BASE_URL is unset or not https (localhost excepted); see ./target.ts.
 *
 * PART 1: read-mostly checks (always run). They create nothing:
 *   health, security headers, AI off, protected pages redirect, legal pages,
 *   and a request carrying a bogus session cookie must still render.
 *
 * PART 2: the account journey. It signs up a REAL account on the deployment, so
 * it runs only when you opt in with ALL of:
 *   LIVE_ALLOW_ACCOUNT_JOURNEY=1
 *   LIVE_TEST_EMAIL=you+job-live-{ts}@your-domain.com
 *         A plus-address of an inbox YOU own ("{ts}" is replaced by a fresh
 *         stamp, so every run uses a new address). Neon's shared sender really
 *         emails it. Careful: "plus" tags only help when the PART BEFORE the
 *         plus is your own mailbox; test+x@gmail.com is delivered to the Gmail
 *         user "test", a stranger.
 *   LIVE_DATABASE_URL=postgresql://...   (the DIRECT, non-pooler URL)
 *         Supplied at run time by the operator; used read-only to read the
 *         emailed code from `neon_auth.verification` (the mailbox is never
 *         opened) and to check what remains afterwards. Never logged.
 *
 * Passwords are random per run and never printed; codes are never printed.
 * The journey ends by deleting the account through the app. Neon Auth (managed)
 * cannot delete users itself: the IDENTITY stays at Neon, and this test prints
 * exactly what remains and the manual cleanup step.
 *
 * Other optional variables: LIVE_EXPECT_AI=on|off (default off, the production
 * launch setting).
 */
import { randomBytes } from "node:crypto";
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { LiveDb } from "./live-db";
import { liveTarget } from "./target";

const target = liveTarget();
const AUTH_COOKIE_PREFIX = "__Secure-neon-auth";
const CACHE_COOKIE = `${AUTH_COOKIE_PREFIX}.local.session_data`;

const say = (line: string) => console.log(`[live] ${line}`);

// ---------------------------------------------------------------------------
// PART 1: read-mostly checks
// ---------------------------------------------------------------------------

test.describe("deployment (read-only checks)", () => {
  test("/api/health reports ok", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("security headers are present and nothing leaks the stack", async ({ request }) => {
    for (const path of ["/", "/login", "/api/health"]) {
      const h = (await request.get(path)).headers();
      const csp = h["content-security-policy"] ?? "";
      expect(csp, `${path}: CSP`).toContain("default-src 'self'");
      expect(csp, `${path}: CSP frame-ancestors`).toContain("frame-ancestors 'none'");
      expect(csp, `${path}: CSP object-src`).toContain("object-src 'none'");
      expect(h["x-frame-options"], `${path}: X-Frame-Options`).toBe("DENY");
      expect(h["x-content-type-options"], `${path}: nosniff`).toBe("nosniff");
      expect(h["referrer-policy"], `${path}: Referrer-Policy`).toBeTruthy();
      // Production builds always send HSTS (browsers ignore it over plain http://localhost).
      expect(h["strict-transport-security"], `${path}: HSTS`).toMatch(/max-age=\d{8,}/);
      expect(h["x-powered-by"], `${path}: X-Powered-By`).toBeUndefined();
    }
  });

  test(`AI is ${target.expectAi ? "on" : "off"}: endpoint, wording and legal pages agree`, async ({ request }) => {
    const res = await request.post("/api/cover-letter", { multipart: { company: "A", jobTitle: "B" } });
    // Off: the route pretends not to exist. On: it exists and wants a session.
    expect(res.status()).toBe(target.expectAi ? 401 : 404);
    if (!target.expectAi) {
      for (const path of ["/", "/privacy", "/terms"]) {
        const html = await (await request.get(path)).text();
        expect(html, `${path} must not mention AI while it is off`).not.toMatch(/\bAI\b/);
      }
    }
  });

  test("signed-out visitors are sent to /login and get no resume", async ({ request }) => {
    for (const path of ["/dashboard", "/applications", "/applications/new", "/resumes", "/settings"]) {
      const res = await request.get(path, { maxRedirects: 0 });
      expect([307, 308], `${path} status`).toContain(res.status());
      expect(new URL(res.headers()["location"], target.baseURL).pathname, `${path} location`).toBe("/login");
    }
    expect((await request.get("/api/resumes/does-not-exist")).status()).toBe(401);
  });

  test("a bogus session cookie still renders the public pages (no 500, no lockout)", async ({ request }) => {
    // A browser can hold a cookie for a session Neon Auth has revoked (password reset or "sign out
    // everywhere" on another device). The app must answer normally and let the person sign in again.
    const cookie = { cookie: `${AUTH_COOKIE_PREFIX}.session_token=not-a-real-token.${randomBytes(8).toString("hex")}` };
    for (const [path, text] of [["/", /Track every application/], ["/login", /Welcome back/], ["/signup", /Create your account/]] as const) {
      const res = await request.get(path, { headers: cookie, maxRedirects: 0 });
      expect(res.status(), path).toBe(200);
      expect(await res.text(), path).toMatch(text);
    }
  });

  test("privacy and terms render", async ({ page }) => {
    await page.goto("/privacy");
    await expect(page.getByRole("heading", { name: "Privacy Policy" })).toBeVisible();
    await page.goto("/terms");
    await expect(page.getByRole("heading", { name: "Terms of Service" })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// PART 2: the account journey (opt-in)
// ---------------------------------------------------------------------------

/**
 * Types a secret without Playwright's call log echoing it (a failing `fill()`
 * prints its value). Sets the value natively and fires the events React and
 * form submission need.
 */
async function fillSecret(field: Locator, value: string) {
  await field.evaluate((el, v) => {
    const input = el as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

/** A page whose forms are interactive. (Clicking before hydration submits a plain GET.) */
const open = (page: Page, path: string) => page.goto(path, { waitUntil: "networkidle" });

async function signInUi(page: Page, email: string, password: string) {
  await open(page, "/login");
  await page.getByLabel("Email").fill(email);
  await fillSecret(page.getByLabel("Password"), password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

const authCookies = async (ctx: BrowserContext) =>
  (await ctx.cookies()).filter((c) => c.name.startsWith(AUTH_COOKIE_PREFIX));

const randomPassword = () => `Lv1-${randomBytes(12).toString("base64url")}`;

/** A tiny but valid-enough PDF (the app checks the file signature, not the structure). */
const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);

test.describe("account journey (creates, then deletes, a real account)", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!target.journey, target.journeyOffReason);

  const journey = target.journey; // null when not opted in; the skip above then covers every test and hook
  const email = journey?.email ?? "";
  const password = randomPassword();
  const newPassword = randomPassword();
  let db: LiveDb;
  let ctx: BrowserContext;
  let page: Page;
  let userId: string | null = null;
  let deletedThroughApp = false;
  /** Set once we know the address is fresh, i.e. everything under it is ours to report on. */
  let ownsAddress = false;

  test.beforeAll(async ({ browser }) => {
    db = new LiveDb(journey!.databaseUrl);
    // Never touch an address that already has an identity: signing up again would
    // be answered like a new sign-up but send no code (non-enumeration), and we
    // could be about to drive somebody's real account.
    const existing = await db.identity(email);
    if (existing) {
      throw new Error(
        "LIVE_TEST_EMAIL already has a Neon Auth identity (the previous run's identity is retained by Neon).\n" +
          "Use a fresh plus-address (put {ts} in it), or remove that user first in the Neon Console (Auth → Users).",
      );
    }
    ownsAddress = true;
    say(`using a fresh test address (${email}); the code is read from the database, not from the mailbox`);
    ctx = await browser.newContext();
    page = await ctx.newPage();
  });

  test.afterAll(async () => {
    // Always say what is left, even after a failure halfway through.
    try {
      const identity = ownsAddress ? await db.identity(email) : null;
      if (!ownsAddress) {
        say("Nothing was created: the address already had an identity, so the journey did not start.");
      } else if (identity) {
        userId = identity.id;
        const kept = await db.retained(identity.id);
        const app = await db.appRows(identity.id);
        say("------------------------------------------------------------");
        say(`WHAT REMAINS for ${email}:`);
        say(`  Neon Auth identity: user id ${identity.id}, emailVerified=${identity.emailVerified},`);
        say(`    ${kept.accounts} password credential(s), ${kept.sessions} live session(s)`);
        say(`  App data: ${app.users} user row(s), ${app.applications} application(s), ${app.resumes} resume(s)`);
        if (deletedThroughApp) {
          say("  Deleting through the app removed the app data and ended the sessions; Neon Auth (managed) offers");
          say("  no delete-user call, so the identity above stays, and the password still works.");
        } else {
          say("  The journey did NOT finish: the account may still hold data. Sign in and use Settings → Delete account,");
          say("  or remove the user from the Neon Console.");
        }
        say("MANUAL CLEANUP: remove that Neon Auth user (Neon Console → project → branch → Auth → Users → delete,");
        say(`  or the Neon API / MCP delete_auth_user with auth_user_id=${identity.id}). Then nothing is left.`);
        say("  (Expired code rows in neon_auth.verification are harmless and age out.)");
        say("------------------------------------------------------------");
      } else {
        say("No Neon Auth identity was created for the test address; nothing to clean up.");
      }
    } finally {
      await ctx?.close();
      await db?.close();
    }
  });

  test("sign up lands on the code screen, with no session yet", async () => {
    await open(page, "/signup");
    await page.getByLabel("Name (optional)").fill("Live Smoke");
    await page.getByLabel("Email").fill(email);
    await fillSecret(page.getByLabel("Password"), password);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(/\/verify-email\?email=/);
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    expect(await authCookies(ctx)).toEqual([]);
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("the emailed code: a wrong one is refused and counted, the right one signs in", async () => {
    const row = await db.waitForOtp(email, "email-verification");
    const identity = await db.identity(email);
    expect(identity, "sign-up must have created the identity in THIS database (is LIVE_DATABASE_URL the deployment's?)").not.toBeNull();
    userId = identity!.id;
    expect(row.attempts).toBe(0);
    // Neon Auth: 300 s. (Its docs say 15 minutes; the app's screens say 5.)
    expect(row.ttlSeconds).toBeGreaterThanOrEqual(240);
    expect(row.ttlSeconds).toBeLessThanOrEqual(900);

    await open(page, `/verify-email?email=${encodeURIComponent(email)}`);
    const wrong = row.code === "000000" ? "111111" : "000000";
    await fillSecret(page.getByLabel("6-digit code"), wrong);
    await page.getByRole("button", { name: "Verify email" }).click();
    await expect(page.getByText(/wrong or has expired/)).toBeVisible();
    expect((await db.otp(email, "email-verification"))!.attempts).toBe(1);
    expect(await authCookies(ctx)).toEqual([]);

    await fillSecret(page.getByLabel("6-digit code"), row.code);
    await page.getByRole("button", { name: "Verify email" }).click();
    await expect(page).toHaveURL(/\/dashboard\?verified=1/);
    expect(await db.otp(email, "email-verification"), "a used code is gone").toBeNull();
  });

  test("session cookies are HttpOnly, Secure, SameSite=Lax and carry the __Secure- prefix", async () => {
    const cookies = await authCookies(ctx);
    expect(cookies.map((c) => c.name).sort()).toEqual([CACHE_COOKIE, `${AUTH_COOKIE_PREFIX}.session_token`].sort());
    for (const c of cookies) {
      expect(c.httpOnly, c.name).toBe(true);
      expect(c.secure, c.name).toBe(true);
      expect(c.sameSite, c.name).toBe("Lax");
      expect(c.path, c.name).toBe("/");
    }
  });

  test("with AI off the application form has no AI button and no AI wording", async () => {
    await open(page, "/applications/new");
    await expect(page.getByLabel("Cover letter")).toBeVisible();
    if (!target.expectAi) {
      await expect(page.getByRole("button", { name: "✨ Write with AI" })).toHaveCount(0);
      await expect(page.getByText(/\bAI\b/)).toHaveCount(0);
    } else {
      await expect(page.getByRole("button", { name: "✨ Write with AI" })).toBeVisible();
    }
  });

  test("add an application with a resume, then download the same bytes", async () => {
    await open(page, "/applications/new");
    await page.getByLabel("Company *").fill("Live Smoke Co");
    await page.getByLabel("Job title *").fill("Test Engineer");
    await page.getByLabel("Or upload a new one").setInputFiles({ name: "live-smoke.pdf", mimeType: "application/pdf", buffer: PDF });
    await page.getByRole("button", { name: /^(Save|Add|Create)/ }).click();
    await expect(page).toHaveURL(/\/applications\/[^/]+\?saved=1/);
    await expect(page.getByRole("heading", { name: "Live Smoke Co", level: 1 })).toBeVisible();

    const href = await page.getByRole("link", { name: "Download" }).getAttribute("href");
    const res = await page.request.get(href!);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-disposition"]).toMatch(/^attachment/);
    expect((await res.body()).equals(PDF), "downloaded file is byte-identical").toBe(true);

    // Private to the owner: a signed-out client gets nothing.
    const anon = await page.context().browser()!.newContext({ baseURL: target.baseURL });
    expect((await anon.request.get(href!)).status()).toBe(401);
    await anon.close();
  });

  test("change password signs the other device out and keeps this one", async ({ browser }) => {
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await signInUi(otherPage, email, password);
    await expect(otherPage).toHaveURL(/\/dashboard/);

    await open(page, "/settings");
    await fillSecret(page.getByLabel("Current password"), "not-my-password");
    await fillSecret(page.getByLabel("New password", { exact: true }), newPassword);
    await fillSecret(page.getByLabel("Confirm new password"), newPassword);
    await page.getByRole("button", { name: "Update password" }).click();
    await expect(page.getByText("That isn't your current password")).toBeVisible();

    await fillSecret(page.getByLabel("Current password"), password);
    await fillSecret(page.getByLabel("New password", { exact: true }), newPassword);
    await fillSecret(page.getByLabel("Confirm new password"), newPassword);
    await page.getByRole("button", { name: "Update password" }).click();
    await expect(page.getByText(/Password updated/)).toBeVisible();

    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/dashboard/); // this device is still signed in

    // The app trusts a signed copy of the session for up to 60 s; drop it to look past that window.
    await other.clearCookies({ name: CACHE_COOKIE });
    await otherPage.goto("/dashboard");
    await expect(otherPage).toHaveURL(/\/login/);
    await expect(otherPage.getByRole("button", { name: "Sign in" })).toBeVisible(); // the form renders (no 500)
    await other.close();
  });

  test("sign out clears the cookies; bad logins look identical; the new password works, the old one doesn't", async () => {
    await page.getByRole("button", { name: "Sign out" }).first().click();
    await expect(page).toHaveURL(/\/login/);
    expect(await authCookies(ctx)).toEqual([]);
    await page.goto("/settings");
    await expect(page).toHaveURL(/\/login/);

    const messages: string[] = [];
    for (const [who, pw] of [[email, randomPassword()], [`nobody+${Date.now().toString(36)}@example.com`, newPassword]] as const) {
      await signInUi(page, who, pw);
      await expect(page.getByText("Incorrect email or password")).toBeVisible();
      messages.push(await page.getByText("Incorrect email or password").innerText());
    }
    expect(messages[1], "unknown email and wrong password give the same message").toBe(messages[0]);

    await signInUi(page, email, password); // the old password is dead
    await expect(page.getByText("Incorrect email or password")).toBeVisible();
    await signInUi(page, email, newPassword);
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test("delete the account through the app; report what remains at Neon", async () => {
    expect(userId).not.toBeNull();
    const before = await db.appRows(userId!);
    expect(before.users).toBe(1);
    expect(before.applications).toBeGreaterThanOrEqual(1);
    expect(before.resumes).toBeGreaterThanOrEqual(1);

    page.on("dialog", (d) => void d.accept());
    await open(page, "/settings");
    await fillSecret(page.getByLabel("Confirm with your password"), "not-my-password");
    await page.getByRole("button", { name: "Delete my account" }).click();
    await expect(page.getByText("That isn't your password")).toBeVisible();
    await fillSecret(page.getByLabel("Confirm with your password"), newPassword);
    await page.getByRole("button", { name: "Delete my account" }).click();
    await expect(page).toHaveURL(/\/\?deleted=1/);
    deletedThroughApp = true;

    expect(await authCookies(ctx)).toEqual([]);
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);

    const after = await db.appRows(userId!);
    expect(after, "everything the app stored is gone").toEqual({ users: 0, applications: 0, resumes: 0 });
    const kept = await db.retained(userId!);
    expect(kept.sessions, "every session was ended").toBe(0);
    // `kept.accounts` is whatever Neon Auth keeps; afterAll prints the full picture and the cleanup step.
  });
});
