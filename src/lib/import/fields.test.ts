import { describe, expect, it } from "vitest";
import { applicationSchema } from "@/lib/validation";
import { hasRequiredFields, mergeFields, sanitizeFields } from "./fields";

describe("sanitizeFields", () => {
  it("keeps good values and trims them", () => {
    expect(
      sanitizeFields({
        company: "  Acme  ",
        jobTitle: "Senior\n Engineer",
        jobUrl: "https://acme.test/jobs/1",
        location: "Austin, TX",
        workType: "hybrid",
        salary: "$100k",
        source: "LinkedIn",
        jobDescription: "Line one\r\n\r\n\r\n\r\nLine two",
      }),
    ).toEqual({
      company: "Acme",
      jobTitle: "Senior Engineer",
      jobUrl: "https://acme.test/jobs/1",
      location: "Austin, TX",
      workType: "HYBRID",
      salary: "$100k",
      source: "LinkedIn",
      jobDescription: "Line one\n\nLine two",
    });
  });

  it("drops one bad field without losing the rest", () => {
    expect(
      sanitizeFields({
        company: "Acme",
        jobTitle: 42,
        jobUrl: "javascript:alert(1)",
        workType: "on the moon",
        location: "",
        salary: null,
        unexpected: "x",
      }),
    ).toEqual({ company: "Acme" });
  });

  it.each([null, undefined, "text", 5, [], [{ company: "x" }]])("returns {} for %j", (v) => {
    expect(sanitizeFields(v)).toEqual({});
  });

  it("normalises work type spellings", () => {
    expect(sanitizeFields({ workType: "On-Site" }).workType).toBe("ONSITE");
    expect(sanitizeFields({ workType: "remote" }).workType).toBe("REMOTE");
  });

  it("clips to the form's limits so the result always saves", () => {
    const out = sanitizeFields({
      company: "C".repeat(500),
      jobTitle: "word ".repeat(100),
      location: "L".repeat(500),
      salary: "S".repeat(500),
      source: "X".repeat(500),
      jobDescription: "d".repeat(50_000),
    });
    const parsed = applicationSchema.safeParse({ ...out, status: "APPLIED" });
    expect(parsed.success).toBe(true);
    // Clipped at a word boundary, not mid-word.
    expect(out.jobTitle!.endsWith("word")).toBe(true);
  });
});

describe("hasRequiredFields / mergeFields", () => {
  it("needs company and title", () => {
    expect(hasRequiredFields({ company: "A", jobTitle: "B" })).toBe(true);
    expect(hasRequiredFields({ company: "A" })).toBe(false);
    expect(hasRequiredFields({})).toBe(false);
  });

  it("lets the preferred source win and the fallback fill gaps", () => {
    expect(
      mergeFields(
        { company: "From page", location: "Remote" },
        { company: "From model", jobTitle: "Engineer", location: "Mars" },
      ),
    ).toEqual({ company: "From page", jobTitle: "Engineer", location: "Remote" });
  });
});
