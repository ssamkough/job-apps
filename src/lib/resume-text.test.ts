import { describe, expect, it } from "vitest";
import { extractResumeText } from "@/lib/resume-text";
import { makeDocx, makePdf } from "@/test/files";

const LINES = [
  "Jane Developer - Senior Backend Engineer",
  "Built payment systems in Go and PostgreSQL at Acme Corp.",
  "Led a team of five engineers across two time zones.",
];

describe("extractResumeText", () => {
  it("reads text out of a PDF", async () => {
    const text = await extractResumeText(makePdf(LINES), "application/pdf");
    expect(text).toContain("Jane Developer");
    expect(text).toContain("Go and PostgreSQL");
  });

  it("reads text out of a DOCX", async () => {
    const text = await extractResumeText(
      await makeDocx(LINES),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(text).toContain("Jane Developer");
    expect(text).toContain("five engineers");
  });

  it("returns null for legacy .doc (unsupported)", async () => {
    expect(await extractResumeText(Buffer.from("whatever"), "application/msword")).toBeNull();
  });

  it("returns null for a PDF with no text layer (e.g. a scan)", async () => {
    expect(await extractResumeText(makePdf([""]), "application/pdf")).toBeNull();
  });

  it("returns null instead of throwing on corrupt files", async () => {
    expect(await extractResumeText(Buffer.from("%PDF-1.4 garbage"), "application/pdf")).toBeNull();
    expect(await extractResumeText(Buffer.from("PK nope"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBeNull();
  });

  it("truncates very long resumes to keep the prompt bounded", async () => {
    const long = Array.from({ length: 800 }, (_, i) => `Line ${i}: experience with distributed systems and databases.`);
    const text = await extractResumeText(await makeDocx(long), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(text).not.toBeNull();
    expect(text!.length).toBeLessThanOrEqual(12_000);
  });
});
