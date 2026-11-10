import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { appUrl } from "@/lib/app-url";
import { EmailNotConfiguredError, EmailQuotaError, devOutbox, emailQuotaAvailable, resetEmailTransport, sendEmail } from "@/lib/email";
import { passwordResetEmail, verifyEmailEmail } from "@/lib/email-templates";
import { resetDb } from "@/test/db";

const sendMail = vi.fn();
vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: (...a: unknown[]) => sendMail(...a) }) },
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const mail = { to: "a@example.com", subject: "Hi", text: "hello", html: "<p>hello</p>" };

beforeEach(async () => {
  await resetDb();
  sendMail.mockReset().mockResolvedValue({});
  devOutbox().length = 0;
  resetEmailTransport();
});
afterEach(() => vi.unstubAllEnvs());

describe("sendEmail", () => {
  it("without SMTP configured (dev) logs to the outbox instead of sending", async () => {
    vi.stubEnv("SMTP_HOST", "");
    await sendEmail(mail);
    expect(sendMail).not.toHaveBeenCalled();
    expect(devOutbox()).toEqual([mail]);
  });

  it("refuses to silently drop mail in production when SMTP isn't set", async () => {
    vi.stubEnv("SMTP_HOST", "");
    vi.stubEnv("NODE_ENV", "production");
    await expect(sendEmail(mail)).rejects.toBeInstanceOf(EmailNotConfiguredError);
  });

  it("sends through SMTP with the configured From", async () => {
    vi.stubEnv("SMTP_HOST", "smtp.test");
    vi.stubEnv("EMAIL_FROM", "Job Tracker <noreply@example.com>");
    await sendEmail(mail);
    expect(sendMail).toHaveBeenCalledWith({ from: "Job Tracker <noreply@example.com>", ...mail });
  });

  it("requires EMAIL_FROM when SMTP is configured", async () => {
    vi.stubEnv("SMTP_HOST", "smtp.test");
    vi.stubEnv("EMAIL_FROM", "");
    await expect(sendEmail(mail)).rejects.toBeInstanceOf(EmailNotConfiguredError);
  });

  it("stops at the daily limit so we never exceed the provider's free cap", async () => {
    vi.stubEnv("SMTP_HOST", "smtp.test");
    vi.stubEnv("EMAIL_FROM", "x@example.com");
    vi.stubEnv("EMAIL_DAILY_LIMIT", "3");

    expect(await emailQuotaAvailable()).toBe(true);
    for (let i = 0; i < 3; i++) await sendEmail(mail);
    expect(await emailQuotaAvailable()).toBe(false);
    await expect(sendEmail(mail)).rejects.toBeInstanceOf(EmailQuotaError);
    expect(sendMail).toHaveBeenCalledTimes(3); // the 4th never reached the provider
  });

  it("defaults the daily limit to 90 (under Resend's 100/day)", async () => {
    vi.stubEnv("SMTP_HOST", "smtp.test");
    vi.stubEnv("EMAIL_FROM", "x@example.com");
    vi.stubEnv("EMAIL_DAILY_LIMIT", "");
    await sendEmail(mail);
    const row = await db.rateLimit.findFirstOrThrow({ where: { key: "email:daily" } });
    expect(row.count).toBe(1);
    // 90 allowed, 91st blocked
    await db.rateLimit.updateMany({ where: { key: "email:daily" }, data: { count: 90 } });
    expect(await emailQuotaAvailable()).toBe(false);
  });
});

describe("templates and links", () => {
  it("include the link in both text and html", () => {
    const url = "https://app.example.com/reset-password?token=abc";
    for (const m of [passwordResetEmail("a@b.co", url), verifyEmailEmail("a@b.co", url)]) {
      expect(m.text).toContain(url);
      expect(m.html).toContain(`href="${url}"`);
      expect(m.to).toBe("a@b.co");
    }
  });

  it("appUrl uses APP_URL, not request data", () => {
    vi.stubEnv("APP_URL", "https://jobs.example.com");
    expect(appUrl("/reset-password?token=x")).toBe("https://jobs.example.com/reset-password?token=x");
  });

  it("appUrl requires APP_URL in production", () => {
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(() => appUrl("/x")).toThrow(/APP_URL/);
  });
});
