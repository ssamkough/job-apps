import { expect, request, test, type Page } from "@playwright/test";
import { makeDocx, makePdf } from "../src/test/files";

const MAIL = "http://127.0.0.1:11501";
const PASSWORD = "e2e-password-1";
const NEW_PASSWORD = "e2e-password-2";
// Matches playwright.config.ts: E2E_AI=false runs the no-AI launch configuration.
const AI = process.env.E2E_AI !== "false";

type Mail = { to: string; subject: string; text: string };
const stamp = Date.now();
let counter = 0;
const uniqueEmail = (tag: string) => `${tag}-${stamp}-${counter++}@example.test`;

async function mailsFor(email: string, expected = 1): Promise<Mail[]> {
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${MAIL}/mails?to=${encodeURIComponent(email)}`);
    const mails = (await res.json()) as Mail[];
    if (mails.length >= expected) return mails;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`No ${expected} email(s) arrived for ${email}`);
}
const linkIn = (mail: Mail) => new URL(mail.text.match(/https?:\/\/\S+/)![0]);

/** Collects things that should never happen in a healthy page. */
function watch(page: Page) {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text()}`);
  });
  return problems;
}

async function signUp(page: Page, email: string, name = "Eve Tester") {
  await page.goto("/signup");
  await page.getByLabel("Name (optional)").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

async function verifyEmail(page: Page, email: string) {
  const [mail] = await mailsFor(email);
  const link = linkIn(mail);
  await page.goto(link.pathname + link.search);
  await page.getByRole("button", { name: "Confirm my email" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
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
    page = await (await browser.newContext({ viewport: { width: 1360, height: 860 } })).newPage();
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

  test("signup validation and success", async () => {
    await page.goto("/signup");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText(/email/i).first()).toBeVisible();
    await expect(page).toHaveURL(/\/signup/);

    await signUp(page, email);
    await expect(page.getByRole("heading", { name: "Welcome, Eve" })).toBeVisible();
    await expect(page.getByText("Verify your email.")).toBeVisible();
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

  test("AI drafts are blocked until the email is verified", async () => {
    test.skip(!AI, "AI is disabled in this run");
    await addApplication(page, { company: "Blocked Co", jobTitle: "Dev" });
    await page.getByRole("button", { name: "✨ Write with AI" }).click();
    await page.getByRole("button", { name: "Generate draft" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Verify your email" })).toBeVisible();
    problems.splice(0); // the 403 is logged by the browser as a console error; expected here
  });

  test("verification email link confirms the account (one click, not on GET)", async () => {
    const [mail] = await mailsFor(email);
    expect(mail.subject).toMatch(/confirm your email/i);
    const link = linkIn(mail);
    expect(link.origin).toBe("http://localhost:3100");

    await page.goto(link.pathname + link.search);
    // Merely visiting must not verify.
    await page.goto("/settings");
    await expect(page.getByText("Not verified")).toBeVisible();

    await page.goto(link.pathname + link.search);
    await page.getByRole("button", { name: "Confirm my email" }).click();
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByText("Verify your email.")).toHaveCount(0);

    // Single use.
    await page.goto(link.pathname + link.search);
    await expect(page.getByRole("heading", { name: "Link expired" })).toBeVisible();
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
    const chats = (await (await fetch(`${MAIL}/chats`)).json()) as { messages: { content: string }[] }[];
    const sent = chats.at(-1)!.messages.map((m) => m.content).join("\n");
    expect(sent).toContain("payments system used by two million people");
    expect(sent).toContain("Mention leadership");
    expect(sent).toContain("<resume>");

    await page.getByRole("button", { name: "Undo AI draft" }).click();
    await expect(page.getByLabel("Cover letter")).toHaveValue("");

    await page.getByRole("button", { name: "Generate draft" }).click();
    await expect(page.getByLabel("Cover letter")).toHaveValue(/MOCK COVER LETTER BODY/);
    await page.getByRole("button", { name: /^Save/ }).click();
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

  test("forgot password: email, reset, old password dead, old sessions revoked", async () => {
    // A second browser context stays signed in so we can prove it's revoked.
    const other = await page.context().browser()!.newContext();
    const otherPage = await other.newPage();
    await otherPage.goto("/login");
    await otherPage.getByLabel("Email").fill(email);
    await otherPage.getByLabel("Password").fill(PASSWORD);
    await otherPage.getByRole("button", { name: "Sign in" }).click();
    await expect(otherPage).toHaveURL(/\/dashboard/);

    await page.getByRole("button", { name: "Sign out" }).first().click();
    await page.goto("/login");
    await page.getByRole("link", { name: "Forgot password?" }).click();
    await expect(page).toHaveURL(/\/forgot-password/); // else we'd fill the login form that's about to unmount
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByText(/If an account exists/)).toBeVisible();

    // Same message for an address that isn't registered.
    await page.reload();
    await page.getByLabel("Email").fill(uniqueEmail("ghost"));
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByText(/If an account exists/)).toBeVisible();

    const mails = await mailsFor(email, 2); // verification + reset
    const reset = mails.find((m) => /reset/i.test(m.subject))!;
    const link = linkIn(reset);
    await page.goto(link.pathname + link.search);
    await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
    await page.getByLabel("Confirm new password").fill("something-else-entirely");
    await page.getByRole("button", { name: "Set new password" }).click();
    await expect(page.getByText(/match/i)).toBeVisible();

    // Passwords are never echoed back, so a failed submit clears both fields.
    await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
    await page.getByLabel("Confirm new password").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Set new password" }).click();
    await expect(page).toHaveURL(/\/login\?reset=1/);
    await expect(page.getByText("Password updated")).toBeVisible();

    // Link is spent.
    await page.goto(link.pathname + link.search);
    await expect(page.getByRole("heading", { name: "Link expired" })).toBeVisible();

    // Other device was signed out.
    await otherPage.goto("/dashboard");
    await expect(otherPage).toHaveURL(/\/login/);
    await other.close();

    // Old password fails, new one works.
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Incorrect email or password")).toBeVisible();
    problems.splice(0);
    await page.getByLabel("Password").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test("settings: change password, then delete the account", async () => {
    await page.goto("/settings");
    await expect(page.getByText(/Verified/)).toBeVisible();

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

    page.once("dialog", (d) => d.accept());
    await page.getByLabel("Confirm with your password").fill("e2e-password-3");
    await page.getByRole("button", { name: "Delete my account" }).click();
    await expect(page).toHaveURL(/\/\?deleted=1/);

    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill("e2e-password-3");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Incorrect email or password")).toBeVisible();
    problems.splice(0);
  });
});

test.describe("mobile layout @mobile", () => {
  test.skip(({ isMobile }) => !isMobile, "mobile only");

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
