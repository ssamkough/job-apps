import { describe, expect, it } from "vitest";
import {
  applicationSchema,
  fieldErrors,
  loginSchema,
  otpSchema,
  resetPasswordSchema,
  signupSchema,
  verifyEmailSchema,
} from "@/lib/validation";

describe("signupSchema", () => {
  it("normalizes email and treats a blank name as absent", () => {
    const r = signupSchema.parse({ email: "  Sammy@Example.COM ", password: "longenough", name: "  " });
    expect(r.email).toBe("sammy@example.com");
    expect(r.name).toBeUndefined();
  });

  it("enforces password length bounds", () => {
    expect(signupSchema.safeParse({ email: "a@b.co", password: "short" }).success).toBe(false);
    expect(signupSchema.safeParse({ email: "a@b.co", password: "x".repeat(129) }).success).toBe(false);
    expect(signupSchema.safeParse({ email: "a@b.co", password: "x".repeat(8) }).success).toBe(true);
  });

  it("rejects malformed emails", () => {
    expect(signupSchema.safeParse({ email: "nope", password: "longenough" }).success).toBe(false);
  });
});

describe("loginSchema", () => {
  it("only requires a non-empty password (never reveals policy at login)", () => {
    expect(loginSchema.safeParse({ email: "a@b.co", password: "x" }).success).toBe(true);
    expect(loginSchema.safeParse({ email: "a@b.co", password: "" }).success).toBe(false);
  });
});

describe("applicationSchema", () => {
  const base = { company: "Acme", jobTitle: "Engineer", status: "APPLIED" };

  it("requires company, title and a valid status", () => {
    expect(applicationSchema.safeParse(base).success).toBe(true);
    expect(applicationSchema.safeParse({ ...base, company: " " }).success).toBe(false);
    expect(applicationSchema.safeParse({ ...base, status: "NOPE" }).success).toBe(false);
  });

  it("turns blank optional fields into undefined", () => {
    const r = applicationSchema.parse({ ...base, location: "", notes: "  ", workType: "", jobUrl: "" });
    expect(r.location).toBeUndefined();
    expect(r.notes).toBeUndefined();
    expect(r.workType).toBeUndefined();
    expect(r.jobUrl).toBeUndefined();
  });

  it("only accepts http(s) URLs (blocks javascript: links)", () => {
    expect(applicationSchema.safeParse({ ...base, jobUrl: "https://example.com/job" }).success).toBe(true);
    expect(applicationSchema.safeParse({ ...base, jobUrl: "javascript:alert(1)" }).success).toBe(false);
    expect(applicationSchema.safeParse({ ...base, jobUrl: "example.com" }).success).toBe(false);
  });

  it("parses dates as UTC midnight and rejects garbage", () => {
    const r = applicationSchema.parse({ ...base, dateApplied: "2026-11-09" });
    expect(r.dateApplied?.toISOString()).toBe("2026-11-09T00:00:00.000Z");
    expect(applicationSchema.safeParse({ ...base, dateApplied: "11/09/2026" }).success).toBe(false);
    expect(applicationSchema.safeParse({ ...base, dateApplied: "2026-13-45" }).success).toBe(false);
  });

  it("validates contact email and work type", () => {
    expect(applicationSchema.safeParse({ ...base, contactEmail: "bad" }).success).toBe(false);
    expect(applicationSchema.safeParse({ ...base, workType: "MOON" }).success).toBe(false);
    expect(applicationSchema.safeParse({ ...base, workType: "REMOTE" }).success).toBe(true);
  });

  it("fieldErrors keeps the first message per field", () => {
    const r = applicationSchema.safeParse({ ...base, company: "", jobUrl: "nope" });
    if (r.success) throw new Error("expected failure");
    const errs = fieldErrors(r.error);
    expect(errs.company).toBe("Company is required");
    expect(errs.jobUrl).toMatch(/http/);
  });
});

describe("one-time codes", () => {
  it("accepts exactly six digits (trimmed)", () => {
    expect(otpSchema.parse(" 123456 ")).toBe("123456");
  });

  it("rejects anything else", () => {
    for (const bad of ["", "12345", "1234567", "12345a", "12 345", "１２３４５６"]) {
      expect(otpSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("verify and reset forms normalize the email and require a code", () => {
    expect(verifyEmailSchema.parse({ email: " A@B.co ", code: "123456" }).email).toBe("a@b.co");
    expect(verifyEmailSchema.safeParse({ email: "a@b.co", code: "" }).success).toBe(false);
    const reset = { email: "a@b.co", code: "123456", password: "longenough", confirm: "longenough" };
    expect(resetPasswordSchema.safeParse(reset).success).toBe(true);
    expect(resetPasswordSchema.safeParse({ ...reset, confirm: "other-thing" }).success).toBe(false);
    expect(resetPasswordSchema.safeParse({ ...reset, code: "abc" }).success).toBe(false);
  });
});
