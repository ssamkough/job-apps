import { describe, expect, it } from "vitest";
import { sniffResumeType } from "@/lib/file-type";
import { OLE_HEADER, makeDocx, makePdf } from "@/test/files";

describe("sniffResumeType", () => {
  it("detects PDF, DOCX and legacy DOC from contents", async () => {
    expect(sniffResumeType(makePdf(["hello"]))).toBe("application/pdf");
    expect(sniffResumeType(await makeDocx(["hello"]))).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(sniffResumeType(OLE_HEADER)).toBe("application/msword");
  });

  it("rejects things that merely claim to be resumes", () => {
    expect(sniffResumeType(Buffer.from("just some text, named resume.pdf"))).toBeNull();
    expect(sniffResumeType(Buffer.from("<script>alert(1)</script>"))).toBeNull();
    expect(sniffResumeType(Buffer.alloc(0))).toBeNull();
  });

  it("rejects a zip that isn't a Word document", () => {
    // PK header but no word/ entries (e.g. a .zip or .xlsx)
    const zipish = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("xl/workbook.xml")]);
    expect(sniffResumeType(zipish)).toBeNull();
  });
});
