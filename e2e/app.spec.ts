import { expect, request, test, type BrowserContext, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { makeDocx, makePdf } from "../src/test/files";

const MOCKS = "http://127.0.0.1:11501"; // Ollama stand-in's request log
const AUTH_MOCK = "http://127.0.0.1:11502"; // Neon Auth stand-in's test hooks
const PASSWORD = "e2e-password-1";
const NEW_PASSWORD = "e2e-password-2";
// Matches playwright.config.ts: E2E_AI=false runs the no-AI launch configuration.
const AI = process.env.E2E_AI !== "false";

const stamp = Date.now();
let counter = 0;
const uniqueEmail = (tag: string) => `${tag}-${stamp}-${counter++}@example.test`;

type CodeType = "email-verification" | "forget-password";
/** The 6-digit code Neon Auth would have emailed (the stand-in exposes it). */
async function codeFor(email: string, type: CodeType): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${AUTH_MOCK}/__otp?email=${encodeURIComponent(email)}&type=${type}`);
    if (res.ok) return ((await res.json()) as { code: string }).code;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`No ${type} code was issued for ${email}`);
}
/**
 * Our rate limits are per client IP. Without a proxy in front, every browser
 * here would be "unknown", and the suite would trip its own limits, so each
 * group of tests presents a different address (the app trusts x-forwarded-for).
 */
const ip = (address: string) => ({ "x-forwarded-for": address });
/**
 * The SDK trusts its signed `session_data` cookie for 60 s before asking Neon
 * Auth again, so a session revoked elsewhere can still load pages inside that
 * window (sensitive actions skip it). Drop the cookie to jump past the window.
 */
const expireSessionCache = (ctx: BrowserContext) =>
  ctx.clearCookies({ name: "__Secure-neon-auth.local.session_data" });
const wrongCode = (code: string) => (code === "000000" ? "111111" : "000000");

/** Collects things that should never happen in a healthy page. */
function watch(page: Page) {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text()}`);
  });
  return problems;
}

/** Fills the signup form; ends on the "enter your code" screen. */
async function signUp(page: Page, email: string, name = "Eve Tester") {
  await page.goto("/signup");
  await page.getByLabel("Name (optional)").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/verify-email\?email=/);
}

/** Enters the emailed code on the verify screen; ends signed in on the dashboard. */
async function verifyEmail(page: Page, email: string) {
  await page.getByLabel("6-digit code").fill(await codeFor(email, "email-verification"));
  await page.getByRole("button", { name: "Verify email" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function addApplication(
  page: Page,
  fields: { company: string; jobTitle: string; status?: string; notes?: string; jobDescription?: string },
) {
  await page.goto("/applications/new");
  await page.getByLabel("Company *").fill(fields.company);
  await page.getByLabel("Job title *").fill(fields.jobTitle);
  if (fields.status) await page.getByLabel("Status", { exact: true }).selectOption(fields.status);
  if (fields.notes) await page.getByLabel("Notes").fill(fields.notes);
  if (fields.jobDescription) await page.getByLabel("Job description").fill(fields.jobDescription);
}

test.describe("desktop journey", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(({ isMobile }) => isMobile, "desktop only");

  const email = uniqueEmail("eve");
  let page: Page;
  let problems: string[];

  test.beforeAll(async ({ browser }) => {
    page = await (await browser.newContext({ viewport: { width: 1360, height: 860 }, extraHTTPHeaders: ip("10.0.0.1") })).newPage();
    problems = watch(page);
  });
  test.afterAll(async () => {
    expect(problems, "no console errors / CSP violations during the journey").toEqual([]);
    await page.context().close();
  });

  test("landing page, legal pages and security headers", async () => {
    const res = await page.goto("/");
    const h = res!.headers();
    expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["referrer-policy"]).toBeTruthy();
    expect(h["x-powered-by"]).toBeUndefined();

    await page.getByRole("link", { name: "Privacy" }).click();
    await expect(page.getByRole("heading", { name: "Privacy Policy" })).toBeVisible();
    await expect(page.getByRole("link", { name: "help@example.test" })).toBeVisible();
    await page.getByRole("link", { name: "Terms" }).click();
    await expect(page.getByRole("heading", { name: "Terms of Service" })).toBeVisible();

    const health = await page.request.get("/api/health");
    expect(health.status()).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
  });

  test("protected pages redirect when signed out", async () => {
    for (const path of ["/dashboard", "/applications", "/applications/new", "/resumes", "/settings"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login$/);
    }
    expect((await page.request.get("/api/resumes/whatever")).status()).toBe(401);
  });

  test("signup validation, then the verify screen", async () => {
    await page.goto("/signup");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText(/email/i).first()).toBeVisible();
    await expect(page).toHaveURL(/\/signup/);

    await signUp(page, email);
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    await expect(page.getByText(email)).toBeVisible();

    // No account yet: the app stays closed until the address is verified.
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("signing in before verifying leads back to the code screen, with a fresh code", async () => {
    const signupCode = await codeFor(email, "email-verification");
    await signIn(page, email, PASSWORD);
    await expect(page).toHaveURL(/\/verify-email\?email=/);
    // Neon Auth sends nothing on sign-in (checked live) and its codes live only
    // 5 minutes, so the app asks for a new one; the sign-up code is now replaced.
    await expect.poll(() => codeFor(email, "email-verification")).not.toBe(signupCode);
    const cookies = await page.context().cookies();
    expect(cookies.filter((c) => c.name.startsWith("__Secure-neon-auth"))).toEqual([]);
  });

  test("the emailed code verifies the account: wrong codes fail, a new code replaces the old", async () => {
    const first = await codeFor(email, "email-verification");

    await page.getByLabel("6-digit code").fill("12ab56");
    await page.getByRole("button", { name: "Verify email" }).click();
    await expect(page.getByText("Enter the 6-digit code from the email")).toBeVisible();

    await page.getByLabel("6-digit code").fill(wrongCode(first));
    await page.getByRole("button", { name: "Verify email" }).click();
    await expect(page.getByText(/wrong or has expired/)).toBeVisible();
    await expect(page).toHaveURL(/\/verify-email/);

    await page.getByRole("button", { name: "send a new code" }).click();
    await expect(page.getByText(/we've emailed a new code/)).toBeVisible();
    const second = await codeFor(email, "email-verification");
    expect(second).not.toBe(first);

    await page.getByLabel("6-digit code").fill(second);
    await page.getByRole("button", { name: "Verify email" }).click();
    await expect(page).toHaveURL(/\/dashboard\?verified=1/);
    await expect(page.getByRole("heading", { name: "Welcome, Eve" })).toBeVisible();
  });

  test("session cookies are HttpOnly, Secure and SameSite=Lax", async () => {
    const auth = (await page.context().cookies()).filter((c) => c.name.startsWith("__Secure-neon-auth"));
    expect(auth.map((c) => c.name).sort()).toEqual([
      "__Secure-neon-auth.local.session_data",
      "__Secure-neon-auth.session_token",
    ]);
    for (const c of auth) {
      expect(c.httpOnly, c.name).toBe(true);
      expect(c.secure, c.name).toBe(true);
      expect(c.sameSite, c.name).toBe("Lax");
    }
  });

  test("the app does not expose Neon Auth's own endpoints", async () => {
    for (const path of ["/api/auth/get-session", "/api/auth/sign-in/email", "/api/auth/delete-user"]) {
      expect((await page.request.get(path)).status(), path).toBe(404);
    }
  });

  test("with AI_ENABLED off there is no AI button and the endpoint is a 404", async () => {
    test.skip(AI, "runs only with E2E_AI=false (the no-AI launch configuration)");
    await addApplication(page, { company: "Plain Co", jobTitle: "Dev" });
    await expect(page.getByLabel("Cover letter")).toBeVisible(); // still a normal textarea
    await expect(page.getByRole("button", { name: "✨ Write with AI" })).toHaveCount(0);
    // Nothing in the signed-in UI (banner, hints, placeholder) may mention AI...
    await expect(page.getByText(/\bAI\b/)).toHaveCount(0);
    await expect(page.getByPlaceholder(/\bAI\b/)).toHaveCount(0);
    // ...nor the public pages (the privacy policy must not describe AI processing that isn't happening).
    const anon = await request.newContext({ baseURL: "http://localhost:3100" });
    for (const path of ["/", "/privacy", "/terms"]) {
      const html = await (await anon.get(path)).text();
      expect(html, path).not.toMatch(/\bAI\b/);
    }
    await anon.dispose();
    expect((await page.request.post("/api/cover-letter", { multipart: { company: "A", jobTitle: "B" } })).status()).toBe(404);
  });

  test("create an application with a new PDF resume", async () => {
    const pdf = makePdf([
      "Eve Tester",
      "Senior software engineer with eight years of experience building web platforms.",
      "Led a team of five and shipped a payments system used by two million people.",
    ]);
    await addApplication(page, {
      company: "Acme Corp",
      jobTitle: "Staff Engineer",
      status: "APPLIED",
      notes: "Referred by Dana",
      jobDescription: "We need a staff engineer to lead our platform team.",
    });
    await page.getByLabel("Date applied").fill("2026-11-03");
    await page.getByLabel("Or upload a new one").setInputFiles({
      name: "eve-resume.pdf",
      mimeType: "application/pdf",
      buffer: pdf,
    });
    await page.getByRole("button", { name: /^(Save|Add|Create)/ }).click();

    await expect(page).toHaveURL(/\/applications\/[^/]+\?saved=1/);
    await expect(page.getByRole("heading", { name: "Acme Corp", level: 1 })).toBeVisible();
    await expect(page.getByText("Saved.")).toBeVisible();
    await expect(page.getByText("eve-resume.pdf").first()).toBeVisible();
    await expect(page.getByLabel("Notes")).toHaveValue("Referred by Dana");
  });

  test("uploaded resume downloads byte-for-byte as an attachment", async () => {
    await page.getByRole("link", { name: "Download" }).click({ trial: true });
    const href = await page.getByRole("link", { name: "Download" }).getAttribute("href");
    const res = await page.request.get(href!);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-disposition"]).toMatch(/^attachment/);
    expect((await res.body()).subarray(0, 5).toString()).toBe("%PDF-");
  });

  test("rejects a disguised file upload", async () => {
    await addApplication(page, { company: "Sneaky", jobTitle: "Test" });
    await page.getByLabel("Or upload a new one").setInputFiles({
      name: "evil.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("<html><script>alert(1)</script></html>"),
    });
    await page.getByRole("button", { name: /^(Save|Add|Create)/ }).click();
    await expect(page.getByRole("alert").filter({ hasText: /pdf|word|file/i }).first()).toBeVisible();
    await expect(page).toHaveURL(/\/applications\/new/);
  });

  test("import from a posting: pasted text and PDF fill only blank fields, and Undo restores them", async () => {
    const posting =
      "Platform Engineer. We are hiring someone to build and run our internal services, " +
      "own reliability, and mentor the team. You will work with Go, Postgres and Kubernetes.";
    await addApplication(page, { company: "Mine Co", jobTitle: "Dev" });
    const box = page.getByTestId("import-box");

    await box.getByRole("tab", { name: "Paste text" }).click();
    await box.getByLabel("Job posting text").fill(posting);
    await box.getByRole("button", { name: "Import" }).click();
    await expect(page.getByLabel("Job description")).toHaveValue(posting);
    await expect(box.getByRole("status")).toContainText("Filled in description");
    await expect(box).toContainText("couldn't be detected automatically");
    // What the person typed is never replaced.
    await expect(page.getByLabel("Company *")).toHaveValue("Mine Co");
    await expect(page.getByLabel("Job title *")).toHaveValue("Dev");

    await box.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByLabel("Job description")).toHaveValue("");

    await box.getByRole("tab", { name: "PDF" }).click();
    await box.getByLabel("Job posting PDF").setInputFiles({
      name: "posting.pdf",
      mimeType: "application/pdf",
      buffer: makePdf(["Data Engineer at Initech", posting.slice(0, 80), posting.slice(80)]),
    });
    await box.getByRole("button", { name: "Import" }).click();
    await expect(page.getByLabel("Job description")).toHaveValue(/Data Engineer at Initech/);

    // Imported fields look different until the person edits them. (Nothing is saved here:
    // later tests count applications.)
    const description = page.getByLabel("Job description");
    await expect(description).toHaveClass(/bg-amber-50/);
    await description.fill("Edited by hand");
    await expect(description).not.toHaveClass(/bg-amber-50/);
  });

  test("import from a posting: private addresses and bad input get a clear message", async ({ browser }) => {
    // Expected 4xx answers show up as browser console errors, so use a copy of this session.
    const ctx = await browser.newContext({
      storageState: await page.context().storageState(),
      extraHTTPHeaders: ip("10.0.0.1"),
    });
    const p = await ctx.newPage();
    await p.goto("/applications/new");
    const box = p.getByTestId("import-box");

    for (const url of ["http://169.254.169.254/latest/meta-data/", "http://localhost:3100/api/health"]) {
      await box.getByLabel("Job posting link").fill(url);
      await box.getByRole("button", { name: "Import" }).click();
      await expect(box.getByRole("alert")).toContainText("can't be imported");
    }

    await box.getByLabel("Job posting link").fill("not a link");
    await box.getByRole("button", { name: "Import" }).click();
    await expect(box.getByRole("alert")).toContainText("doesn't look like a web address");

    await box.getByRole("tab", { name: "Paste text" }).click();
    await box.getByLabel("Job posting text").fill("too short");
    await box.getByRole("button", { name: "Import" }).click();
    await expect(box.getByRole("alert")).toContainText("Paste a bit more");

    // Nothing was filled in by any of the failures.
    await expect(p.getByLabel("Company *")).toHaveValue("");
    await expect(p.getByLabel("Job description")).toHaveValue("");

    // The endpoint is closed to signed-out callers.
    const anon = await request.newContext({ baseURL: "http://localhost:3100" });
    expect((await anon.post("/api/import", { multipart: { text: "x".repeat(200) } })).status()).toBe(401);
    expect((await anon.get("/api/import/abc")).status()).toBe(401);
    await anon.dispose();
    await ctx.close();
  });

  test("more applications, list search, and inline status changes", async () => {
    await addApplication(page, { company: "Globex", jobTitle: "Designer", status: "WISHLIST" });
    await page.getByRole("button", { name: /^(Save|Add|Create)/ }).click();
    await expect(page).toHaveURL(/saved=1/);
    await addApplication(page, { company: "Initech", jobTitle: "Analyst", status: "INTERVIEWING" });
    await page.getByRole("button", { name: /^(Save|Add|Create)/ }).click();
    await expect(page).toHaveURL(/saved=1/);

    await page.goto("/applications");
    for (const c of ["Acme Corp", "Globex", "Initech"]) {
      await expect(page.getByRole("link", { name: new RegExp(c) }).first()).toBeVisible();
    }

    // Case-insensitive search.
    await page.getByLabel("Search applications").fill("gLoBeX");
    await page.getByLabel("Search applications").press("Enter");
    await expect(page.getByRole("link", { name: /Globex/ }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /Acme/ })).toHaveCount(0);

    // Inline status change persists across reloads.
    const select = page.locator('select[aria-label="Status for Globex"]:visible');
    await select.selectOption("APPLIED");
    await expect(select).toHaveValue("APPLIED");
    await page.reload();
    await expect(page.locator('select[aria-label="Status for Globex"]:visible')).toHaveValue("APPLIED");
  });

  test("dashboard reflects the data", async () => {
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Dashboard" }).or(page.getByText("Total applications")).first()).toBeVisible();
    await expect(page.getByText("Needs attention")).toBeVisible();
    await expect(page.getByText("3", { exact: true }).first()).toBeVisible();
  });

  test("edit an application and see its status history", async () => {
    await page.goto("/applications");
    await page.getByRole("link", { name: /Acme Corp/ }).first().click();
    await page.getByLabel("Company *").fill("Acme Corporation");
    await page.getByLabel("Notes").fill("");
    await page.getByLabel("Status", { exact: true }).selectOption("INTERVIEWING");
    await page.getByRole("button", { name: /^Save/ }).click();

    await expect(page.getByText("Saved.")).toBeVisible();
    await expect(page.getByLabel("Company *")).toHaveValue("Acme Corporation");
    await expect(page.getByLabel("Notes")).toHaveValue(""); // cleared fields really clear
    await expect(page.getByText("History")).toBeVisible();
  });

  test("AI cover letter draft uses the resume, can be undone, and persists on save", async () => {
    test.skip(!AI, "AI is disabled in this run");
    await page.getByRole("button", { name: "✨ Write with AI" }).click();
    await page.getByLabel("Anything to emphasize? (optional)").fill("Mention leadership");
    await page.getByRole("button", { name: "Generate draft" }).click();
    await expect(page.getByRole("button", { name: "Writing…" })).toBeVisible();
    await expect(page.getByLabel("Cover letter")).toHaveValue(/MOCK COVER LETTER BODY/);
    await expect(page.getByText(/Drafted using your resume/)).toBeVisible();

    // The model really received the resume text, delimited as data.
    const chats = (await (await fetch(`${MOCKS}/chats`)).json()) as { messages: { content: string }[] }[];
    const sent = chats.at(-1)!.messages.map((m) => m.content).join("\n");
    expect(sent).toContain("payments system used by two million people");
    expect(sent).toContain("Mention leadership");
    expect(sent).toContain("<resume>");

    await page.getByRole("button", { name: "Undo AI draft" }).click();
    await expect(page.getByLabel("Cover letter")).toHaveValue("");

    await page.getByRole("button", { name: "Generate draft" }).click();
    await expect(page.getByLabel("Cover letter")).toHaveValue(/MOCK COVER LETTER BODY/);
    // "Saved." may still be on screen from the previous test, so wait for the
    // save request itself before reloading.
    await Promise.all([
      page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/applications/")),
      page.getByRole("button", { name: /^Save/ }).click(),
    ]);
    await expect(page.getByText("Saved.")).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Cover letter")).toHaveValue(/MOCK COVER LETTER BODY/);
  });

  test("resume library: upload DOCX, attach, delete keeps the application", async () => {
    await page.goto("/resumes");
    await page.getByLabel("Label (optional)").fill("Design resume");
    await page.getByLabel("File").setInputFiles({
      name: "design.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: await makeDocx(["Designer with ten years of experience in product design."]),
    });
    await page.getByRole("button", { name: "Upload" }).click();
    await expect(page.getByText("Design resume")).toBeVisible();

    await page.goto("/applications");
    await page.getByRole("link", { name: /Globex/ }).first().click();
    await page.getByLabel("From your resumes").selectOption({ label: "Design resume" });
    await page.getByRole("button", { name: /^Save/ }).click();
    await expect(page.getByText("Saved.")).toBeVisible();

    await page.goto("/resumes");
    let confirmMessage = "";
    page.once("dialog", (d) => {
      confirmMessage = d.message();
      void d.accept();
    });
    const row = page
      .locator("div")
      .filter({ has: page.getByText("Design resume", { exact: true }) })
      .filter({ has: page.getByRole("button", { name: "Delete" }) })
      .last(); // innermost row, not the list around it
    await row.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText("Design resume")).toHaveCount(0);
    expect(confirmMessage).toContain("Design resume");
    expect(confirmMessage).toContain("1 application");
    await expect(page.getByText("eve-resume.pdf").first()).toBeVisible(); // the other resume is untouched

    await page.goto("/applications");
    await expect(page.getByRole("link", { name: /Globex/ }).first()).toBeVisible();
  });

  test("accessibility: no WCAG A/AA violations on the main screens", async () => {
    await page.goto("/applications");
    const detail = await page.locator('a[href^="/applications/"]:not([href="/applications/new"])').first().getAttribute("href");
    const paths = ["/dashboard", "/applications", "/applications/new", detail!, `${detail}/edit`, "/resumes", "/settings"];
    const found: string[] = [];
    for (const path of paths) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      for (const v of violations) {
        found.push(`${path.replace(/[0-9a-z]{25}/, ":id")} [${v.impact}] ${v.id}: ${v.nodes.length}x e.g. ${v.nodes[0].target.join(" ")} :: ${v.nodes[0].failureSummary?.split("\n").slice(1, 3).join(" ")}`);
      }
    }
    expect(found).toEqual([]);
  });

  test("accessibility: skip link, and the status pill is a centered, 24px+ target with a visible focus ring", async () => {
    await page.goto("/dashboard");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to main content" });
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#main$/);

    await page.goto("/applications");
    const pill = page.getByRole("combobox", { name: /^Status for / }).first();
    await expect(pill).toBeVisible();
    const style = await pill.evaluate((el) => {
      const s = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      return { align: s.textAlign, alignLast: s.textAlignLast, h: box.height, w: box.width };
    });
    expect(style.align).toBe("center");
    expect(style.alignLast).toBe("center");
    expect(style.h).toBeGreaterThanOrEqual(24);
    // Every pill is the same width, whatever the status.
    const widths = await page.getByRole("combobox", { name: /^Status for / }).evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
    expect(new Set(widths).size).toBe(1);

    await pill.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    const outline = await pill.evaluate((el) => getComputedStyle(el.parentElement!).outlineStyle);
    expect(outline).not.toBe("none");
  });

  test("delete an application", async () => {
    await page.goto("/applications");
    await page.getByRole("link", { name: /Initech/ }).first().click();
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Delete" }).click();
    await expect(page).toHaveURL(/\/applications$/);
    await expect(page.getByRole("link", { name: /Initech/ })).toHaveCount(0);
  });

  test("sign out, wrong password, then sign in", async () => {
    await page.getByRole("button", { name: "Sign out" }).first().click();
    await expect(page).toHaveURL(/\/login/);
    // The browser really dropped the (Secure, HttpOnly) cookies, not just the redirect.
    expect((await page.context().cookies()).filter((c) => c.name.startsWith("__Secure-neon-auth"))).toEqual([]);
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);

    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill("wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Incorrect email or password")).toBeVisible();
    problems.splice(0);

    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test("forgot password: emailed code, reset, old password dead, old sessions revoked", async () => {
    // A second browser context stays signed in so we can prove it's revoked.
    const other = await page.context().browser()!.newContext({ extraHTTPHeaders: ip("10.0.0.11") });
    const otherPage = await other.newPage();
    await signIn(otherPage, email, PASSWORD);
    await expect(otherPage).toHaveURL(/\/dashboard/);

    await page.getByRole("button", { name: "Sign out" }).first().click();
    await page.goto("/login");
    await page.getByRole("link", { name: "Forgot password?" }).click();
    await expect(page).toHaveURL(/\/forgot-password/); // else we'd fill the login form that's about to unmount

    // An address that isn't registered gets exactly the same screen...
    const ghost = uniqueEmail("ghost");
    await page.getByLabel("Email").fill(ghost);
    await page.getByRole("button", { name: "Send reset code" }).click();
    await expect(page).toHaveURL(/\/reset-password\?email=/);
    await expect(page.getByText(/If an account exists for/)).toBeVisible();
    // ...but no code exists for it.
    expect((await fetch(`${AUTH_MOCK}/__otp?email=${encodeURIComponent(ghost)}&type=forget-password`)).status).toBe(404);

    await page.goto("/forgot-password");
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Send reset code" }).click();
    await expect(page).toHaveURL(/\/reset-password\?email=/);
    await expect(page.getByText(/If an account exists for/)).toBeVisible();
    const code = await codeFor(email, "forget-password");

    // A wrong code and a mismatched confirmation are both refused.
    await page.getByLabel("6-digit code").fill(wrongCode(code));
    await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
    await page.getByLabel("Confirm new password").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Set new password" }).click();
    await expect(page.getByText(/wrong or has expired/)).toBeVisible();

    await page.getByLabel("6-digit code").fill(code);
    await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
    await page.getByLabel("Confirm new password").fill("something-else-entirely");
    await page.getByRole("button", { name: "Set new password" }).click();
    await expect(page.getByText(/match/i)).toBeVisible();

    // Passwords are never echoed back, so a failed submit clears both fields.
    await page.getByLabel("6-digit code").fill(code);
    await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
    await page.getByLabel("Confirm new password").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Set new password" }).click();
    await expect(page).toHaveURL(/\/login\?reset=1/);
    await expect(page.getByText("Password updated")).toBeVisible();

    // The code is spent.
    await page.goto(`/reset-password?email=${encodeURIComponent(email)}`);
    await page.getByLabel("6-digit code").fill(code);
    await page.getByLabel("New password", { exact: true }).fill("e2e-password-9");
    await page.getByLabel("Confirm new password").fill("e2e-password-9");
    await page.getByRole("button", { name: "Set new password" }).click();
    await expect(page.getByText(/wrong or has expired/)).toBeVisible();

    // Other device was signed out.
    await expireSessionCache(other);
    await otherPage.goto("/dashboard");
    await expect(otherPage).toHaveURL(/\/login/);
    await expect(otherPage.getByRole("button", { name: "Sign in" })).toBeVisible();
    await other.close();

    // Old password fails, new one works.
    await signIn(page, email, PASSWORD);
    await expect(page.getByText("Incorrect email or password")).toBeVisible();
    problems.splice(0);
    await page.getByLabel("Password").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test("settings: change password signs out other devices", async () => {
    const other = await page.context().browser()!.newContext({ extraHTTPHeaders: ip("10.0.0.11") });
    const otherPage = await other.newPage();
    await signIn(otherPage, email, NEW_PASSWORD);
    await expect(otherPage).toHaveURL(/\/dashboard/);

    await page.goto("/settings");
    await expect(page.getByText("Verified")).toBeVisible();

    await page.getByLabel("Current password").fill("not-my-password");
    await page.getByLabel("New password", { exact: true }).fill("e2e-password-3");
    await page.getByLabel("Confirm new password").fill("e2e-password-3");
    await page.getByRole("button", { name: "Update password" }).click();
    await expect(page.getByText("That isn't your current password")).toBeVisible();

    // A failed submit clears the password fields (never echoed), so refill all.
    await page.getByLabel("Current password").fill(NEW_PASSWORD);
    await page.getByLabel("New password", { exact: true }).fill("e2e-password-3");
    await page.getByLabel("Confirm new password").fill("e2e-password-3");
    await page.getByRole("button", { name: "Update password" }).click();
    await expect(page.getByText(/Password updated/)).toBeVisible();

    // This device stays signed in; the other one is out.
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/dashboard/);
    await expireSessionCache(other);
    await otherPage.goto("/dashboard");
    await expect(otherPage).toHaveURL(/\/login/);
    await expect(otherPage.getByRole("button", { name: "Sign in" })).toBeVisible();
    await other.close();
  });

  test("settings: sign out of all devices", async () => {
    const other = await page.context().browser()!.newContext({ extraHTTPHeaders: ip("10.0.0.11") });
    const otherPage = await other.newPage();
    await signIn(otherPage, email, "e2e-password-3");
    await expect(otherPage).toHaveURL(/\/dashboard/);

    await page.goto("/settings");
    await otherPage.goto("/settings"); // loaded while it is still signed in
    await page.getByRole("button", { name: "Sign out of all devices" }).click();
    await expect(page).toHaveURL(/\/login/);

    // Even inside the session cache window, the revoked device can't do anything
    // sensitive: account actions ask Neon Auth, not the cache.
    await otherPage.getByLabel("Current password").fill("e2e-password-3");
    await otherPage.getByLabel("New password", { exact: true }).fill("e2e-password-4");
    await otherPage.getByLabel("Confirm new password").fill("e2e-password-4");
    await otherPage.getByRole("button", { name: "Update password" }).click();
    await expect(otherPage).toHaveURL(/\/login/);

    await expireSessionCache(other);
    await otherPage.goto("/dashboard");
    await expect(otherPage).toHaveURL(/\/login/);
    await expect(otherPage.getByRole("button", { name: "Sign in" })).toBeVisible();
    await other.close();

    await signIn(page, email, "e2e-password-3");
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test("delete account: needs the password, removes the data, ends the session", async () => {
    await page.goto("/settings");
    page.on("dialog", (d) => void d.accept());

    await page.getByLabel("Confirm with your password").fill("not-my-password");
    await page.getByRole("button", { name: "Delete my account" }).click();
    await expect(page.getByText("That isn't your password")).toBeVisible();
    await page.goto("/applications");
    await expect(page.getByRole("link", { name: /Acme Corporation/ }).first()).toBeVisible(); // still there

    await page.goto("/settings");
    await page.getByLabel("Confirm with your password").fill("e2e-password-3");
    await page.getByRole("button", { name: "Delete my account" }).click();
    await expect(page).toHaveURL(/\/\?deleted=1/);

    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
    expect((await page.request.get("/api/resumes/anything")).status()).toBe(401);

    // Neon Auth can't delete the sign-in identity itself (see DEPLOYMENT.md),
    // so the credentials still work, but everything the app stored is gone:
    // signing in again starts from an empty account.
    await signIn(page, email, "e2e-password-3");
    await expect(page).toHaveURL(/\/dashboard/);
    await page.goto("/applications");
    await expect(page.getByRole("link", { name: /Acme Corporation|Globex/ })).toHaveCount(0);
    await page.goto("/resumes");
    await expect(page.getByText("eve-resume.pdf")).toHaveCount(0);
  });
});

test.describe("auth provider problems", () => {
  test.skip(({ isMobile }) => isMobile, "desktop only");
  test.use({ extraHTTPHeaders: ip("10.0.0.2") });
  test.afterEach(async () => {
    await fetch(`${AUTH_MOCK}/__outage?on=0`, { method: "POST" });
    await fetch(`${AUTH_MOCK}/__ratelimit?on=0`, { method: "POST" });
  });

  test("Neon Auth's own rate limit is explained, not shown as a wrong password", async ({ page }) => {
    const email = uniqueEmail("limited");
    await signUp(page, email);
    await verifyEmail(page, email);
    await page.getByRole("button", { name: "Sign out" }).first().click();

    await fetch(`${AUTH_MOCK}/__ratelimit?on=1`, { method: "POST" });
    await signIn(page, email, PASSWORD);
    await expect(page.getByText(/Too many attempts. Please wait a minute/)).toBeVisible();
    await expect(page.getByText("Incorrect email or password")).toHaveCount(0);
  });

  test("an outage shows an honest message, and recovery needs no restart", async ({ page }) => {
    const email = uniqueEmail("outage");
    await signUp(page, email);
    await verifyEmail(page, email);
    await page.getByRole("button", { name: "Sign out" }).first().click();

    await fetch(`${AUTH_MOCK}/__outage?on=1`, { method: "POST" });
    await signIn(page, email, PASSWORD);
    await expect(page.getByText(/temporarily unavailable/)).toBeVisible();
    await expect(page.getByText("Incorrect email or password")).toHaveCount(0);

    await fetch(`${AUTH_MOCK}/__outage?on=0`, { method: "POST" });
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test("a browser holding a revoked session cookie still reaches every page and can sign in again", async ({ page, browser }) => {
    // Seen on a real Neon branch: for a revoked token, get-session answers null AND
    // Set-Cookie headers the SDK can't apply while a page renders. That used to make
    // "/", "/login", "/signup" and the whole app answer 500 until the cookie expired.
    const email = uniqueEmail("stale");
    await signUp(page, email);
    await verifyEmail(page, email);

    const other = await browser.newContext({ extraHTTPHeaders: ip("10.0.0.2") });
    const stale = await other.newPage();
    await signIn(stale, email, PASSWORD);
    await expect(stale).toHaveURL(/\/dashboard/);

    await page.goto("/settings");
    await page.getByRole("button", { name: "Sign out of all devices" }).click();
    await expect(page).toHaveURL(/\/login/);
    await expireSessionCache(other); // the revoked session_token cookie is all that's left

    for (const [path, heading] of [
      ["/", /Keep your whole job search organized/],
      ["/login", /Welcome back/],
      ["/signup", /Create your account/],
      ["/dashboard", /Welcome back/], // bounced to /login
      ["/settings", /Welcome back/],
    ] as const) {
      const res = await stale.goto(path);
      expect(res!.status(), path).toBe(200);
      await expect(stale.getByText(heading).first(), path).toBeVisible();
    }
    expect((await stale.request.get("/api/resumes/whatever")).status()).toBe(401);

    // And signing in replaces the dead cookie.
    await signIn(stale, email, PASSWORD);
    await expect(stale).toHaveURL(/\/dashboard/);
    await other.close();
  });

  test("signing up twice with one address looks the same as the first time", async ({ page }) => {
    const email = uniqueEmail("twice");
    await signUp(page, email);
    await verifyEmail(page, email);
    await page.context().clearCookies();

    await signUp(page, email); // already registered: lands on the same code screen
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    // The real owner's account is untouched: their password still works.
    await signIn(page, email, PASSWORD);
    await expect(page).toHaveURL(/\/dashboard/);
  });
});

test.describe("mobile layout @mobile", () => {
  test.skip(({ isMobile }) => !isMobile, "mobile only");
  test.use({ extraHTTPHeaders: ip("10.0.0.3") });

  test("every screen fits the viewport and is usable", async ({ page }, info) => {
    const problems = watch(page);
    const email = uniqueEmail("mobile");
    await signUp(page, email, "Mia Mobile");
    await verifyEmail(page, email);

    await addApplication(page, {
      company: "A Fairly Long Company Name Incorporated International",
      jobTitle: "Principal Software Engineer, Distributed Systems Platform",
      status: "APPLIED",
      jobDescription: "Long description ".repeat(40),
    });
    await page.getByRole("button", { name: /^(Save|Add|Create)/ }).click();
    await expect(page).toHaveURL(/saved=1/);
    await addApplication(page, { company: "Globex", jobTitle: "Designer", status: "OFFER" });
    await page.getByRole("button", { name: /^(Save|Add|Create)/ }).click();
    await expect(page).toHaveURL(/saved=1/);

    const screens: Record<string, string> = {
      dashboard: "/dashboard",
      applications: "/applications",
      "application-new": "/applications/new",
      resumes: "/resumes",
      settings: "/settings",
      privacy: "/privacy",
    };
    for (const [name, path] of Object.entries(screens)) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const overflow = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      expect(overflow.scroll, `${name} overflows horizontally`).toBeLessThanOrEqual(overflow.client);
      await page.screenshot({ path: `e2e/screenshots/mobile-${name}.png`, fullPage: true });
    }

    // Detail page, plus the status select works with touch.
    await page.goto("/applications");
    await page.locator('select[aria-label="Status for Globex"]:visible').selectOption("ACCEPTED");
    await expect(page.locator('select[aria-label="Status for Globex"]:visible')).toHaveValue("ACCEPTED");
    await page.getByRole("link", { name: /Fairly Long/ }).first().click();
    await page.waitForLoadState("networkidle");
    const detail = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    expect(detail, "detail page overflows horizontally").toBe(true);
    await page.screenshot({ path: "e2e/screenshots/mobile-application-detail.png", fullPage: true });

    // Auth screens too (signed out).
    await page.context().clearCookies();
    for (const [name, path] of [["login", "/login"], ["signup", "/signup"], ["forgot", "/forgot-password"], ["home", "/"]]) {
      await page.goto(path);
      const fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
      expect(fits, `${name} overflows horizontally`).toBe(true);
      await page.screenshot({ path: `e2e/screenshots/mobile-${name}.png`, fullPage: true });
    }

    expect(problems).toEqual([]);
    info.annotations.push({ type: "screenshots", description: "e2e/screenshots/mobile-*.png" });
  });
});
