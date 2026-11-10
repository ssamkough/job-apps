import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import S3rver from "s3rver";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  deleteResumeFile,
  readResumeFile,
  readResumeUpload,
  resetStorageDriver,
  saveResumeFile,
  type ResumeUpload,
} from "@/lib/storage";
import { OLE_HEADER, fileFrom, makeDocx, makePdf } from "@/test/files";

const upload = (text = "hello resume"): ResumeUpload => {
  const buffer = makePdf([text]);
  return { fileName: "r.pdf", mimeType: "application/pdf", size: buffer.length, buffer };
};

afterEach(() => {
  vi.unstubAllEnvs();
  resetStorageDriver();
});

describe("local driver", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "uploads-"));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("round-trips a file and deletes it", async () => {
    vi.stubEnv("UPLOAD_DIR", dir);
    const u = upload();
    const key = await saveResumeFile("user1", u);
    expect(key).toMatch(/^user1\/[0-9a-f-]{36}$/);
    expect((await readResumeFile(key)).equals(u.buffer)).toBe(true);

    await deleteResumeFile(key);
    await expect(readResumeFile(key)).rejects.toThrow();
    expect(await readdir(path.join(dir, "user1"))).toHaveLength(0);
  });

  it("deleting a missing file is not an error", async () => {
    vi.stubEnv("UPLOAD_DIR", dir);
    await expect(deleteResumeFile("user1/does-not-exist")).resolves.toBeUndefined();
  });

  it("refuses keys that escape the upload directory", async () => {
    vi.stubEnv("UPLOAD_DIR", dir);
    await expect(readResumeFile("../../etc/passwd")).rejects.toThrow(/Invalid storage key/);
    await expect(readResumeFile("user1/../../outside")).rejects.toThrow(/Invalid storage key/);
  });
});

describe("s3 driver (against an in-process S3 server)", () => {
  let server: S3rver;
  let dir: string;
  const port = 4569;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "s3rver-"));
    server = new S3rver({
      port,
      address: "127.0.0.1",
      silent: true,
      directory: dir,
      configureBuckets: [{ name: "resumes", configs: [] }],
    });
    await server.run();
  });
  afterAll(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  const useS3 = (extra: Record<string, string> = {}) => {
    vi.stubEnv("STORAGE_DRIVER", "s3");
    vi.stubEnv("S3_ENDPOINT", `http://127.0.0.1:${port}`);
    vi.stubEnv("S3_REGION", "us-east-1");
    vi.stubEnv("S3_BUCKET", "resumes");
    vi.stubEnv("S3_ACCESS_KEY_ID", "S3RVER");
    vi.stubEnv("S3_SECRET_ACCESS_KEY", "S3RVER");
    vi.stubEnv("S3_FORCE_PATH_STYLE", "true");
    for (const [k, v] of Object.entries(extra)) vi.stubEnv(k, v);
    resetStorageDriver();
  };

  it("round-trips a file and deletes it", async () => {
    useS3();
    const u = upload("stored in s3");
    const key = await saveResumeFile("user2", u);
    expect((await readResumeFile(key)).equals(u.buffer)).toBe(true);

    await deleteResumeFile(key);
    await expect(readResumeFile(key)).rejects.toThrow();
  });

  it("applies the key prefix", async () => {
    useS3({ S3_KEY_PREFIX: "/prod/" });
    const key = await saveResumeFile("user3", upload());
    // The prefix is internal: callers keep using the un-prefixed key.
    expect(key.startsWith("user3/")).toBe(true);
    expect((await readResumeFile(key)).length).toBeGreaterThan(0);
    await deleteResumeFile(key);
  });

  it("fails fast with a clear message when misconfigured", async () => {
    vi.stubEnv("STORAGE_DRIVER", "s3");
    vi.stubEnv("S3_BUCKET", "");
    resetStorageDriver();
    await expect(saveResumeFile("u", upload())).rejects.toThrow(/S3_BUCKET/);
  });
});

describe("driver selection", () => {
  it("rejects an unknown driver name", async () => {
    vi.stubEnv("STORAGE_DRIVER", "ftp");
    resetStorageDriver();
    await expect(readResumeFile("a/b")).rejects.toThrow(/Unknown STORAGE_DRIVER/);
  });
});

describe("readResumeUpload", () => {
  it("accepts a real PDF and reports the detected type", async () => {
    const r = await readResumeUpload(fileFrom(makePdf(["hi"]), "cv.pdf"));
    expect(r.ok && r.upload.mimeType).toBe("application/pdf");
  });

  it("accepts DOCX and DOC", async () => {
    const docx = await readResumeUpload(fileFrom(await makeDocx(["hi"]), "cv.docx"));
    expect(docx.ok && docx.upload.mimeType).toMatch(/wordprocessingml/);
    const doc = await readResumeUpload(fileFrom(OLE_HEADER, "cv.doc"));
    expect(doc.ok && doc.upload.mimeType).toBe("application/msword");
  });

  it("trusts contents over the claimed type or extension", async () => {
    // Claims to be a PDF, is actually text
    const fake = await readResumeUpload(fileFrom(Buffer.from("not a pdf"), "evil.pdf", "application/pdf"));
    expect(fake).toEqual({ ok: false, error: "Upload a PDF, DOC, or DOCX file" });
    // A PDF with a wrong claimed type and no extension is still fine
    const real = await readResumeUpload(fileFrom(makePdf(["hi"]), "resume", "application/octet-stream"));
    expect(real.ok).toBe(true);
  });

  it("rejects empty, missing and oversized files", async () => {
    expect((await readResumeUpload(null)).ok).toBe(false);
    expect((await readResumeUpload(fileFrom(Buffer.alloc(0), "a.pdf"))).ok).toBe(false);
    const big = await readResumeUpload(fileFrom(Buffer.alloc(5 * 1024 * 1024 + 1), "big.pdf"));
    expect(big).toEqual({ ok: false, error: "File is too large (max 5 MB)" });
  });

  it("strips path components and control characters from the file name", async () => {
    const r = await readResumeUpload(fileFrom(makePdf(["hi"]), "../../etc/pass\u0000wd.pdf"));
    expect(r.ok && r.upload.fileName).toBe("passwd.pdf");
    const blank = await readResumeUpload(fileFrom(makePdf(["hi"]), "   "));
    expect(blank.ok && blank.upload.fileName).toBe("resume");
  });
});
