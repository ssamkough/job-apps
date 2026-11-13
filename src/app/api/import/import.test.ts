import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeAuth } from "@/test/fake-auth";

const h = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  ip: "2.2.2.2",
  fake: undefined as unknown as FakeAuth,
  fetchPage: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (h.jar.has(n) ? { name: n, value: h.jar.get(n)! } : undefined),
    getAll: () => [...h.jar].map(([name, value]) => ({ name, value })),
    set: (n: string, v: string, o?: { maxAge?: number }) => {
      if (o?.maxAge === 0) h.jar.delete(n);
      else h.jar.set(n, v);
    },
    delete: (n: string) => void h.jar.delete(n),
  }),
  headers: async () => new Headers({ "x-forwarded-for": h.ip }),
}));
vi.mock("next/navigation", () => ({ redirect: () => {} }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("react", async (orig) => ({
  ...(await orig<typeof import("react")>()),
  cache: <T,>(fn: T) => fn,
}));
vi.mock("@/lib/auth-api", () => ({ authApi: () => h.fake }));
// The network is the one thing replaced; everything after it is real.
vi.mock("@/lib/import/safe-fetch", async (orig) => ({
  ...(await orig<typeof import("@/lib/import/safe-fetch")>()),
  fetchPage: h.fetchPage,
}));

import { db } from "@/lib/db";
import { POST as startImport } from "@/app/api/import/route";
import { GET as importStatus } from "@/app/api/import/[id]/route";
import { FetchError } from "@/lib/import/safe-fetch";
import { completeJob, failJob } from "@/lib/import/jobs";
import { setImportQueue, type ExtractionRequest } from "@/lib/import/queue";
import { makePdf } from "@/test/files";
import { resetDb } from "@/test/db";
import { FakeAuth as FakeAuthImpl } from "@/test/fake-auth";

const form = (fields: Record<string, string | File>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const post = (fields: Record<string, string | File>) =>
  startImport(new Request("http://x/api/import", { method: "POST", body: form(fields) }));
const status = (id: string) =>
  importStatus(new Request("http://x"), { params: Promise.resolve({ id }) });

async function signIn(opts: { verified?: boolean } = {}) {
  const u = h.fake.seedUser({ verified: opts.verified ?? true });
  if (u.verified) await db.user.create({ data: { id: u.id } });
  h.fake.signInAs(u);
  return u;
}

const LONG = "We are hiring a platform engineer to build and run our services. ".repeat(8);
const withLd = (posting: object) =>
  `<html><head><script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "JobPosting",
    ...posting,
  })}</script></head><body><main><p>${LONG}</p></main></body></html>`;
const PLAIN = `<html><body><main><h2>Platform Engineer at Globex</h2><p>${LONG}</p></main></body></html>`;

let queued: ExtractionRequest[];
const fakeQueue = { enqueue: async (r: ExtractionRequest) => void queued.push(r) };

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-01T12:07:30Z"));
  vi.stubEnv("IMPORT_ENABLED", "true");
  await resetDb();
  h.jar.clear();
  h.ip = "2.2.2.2";
  h.fake = new FakeAuthImpl(h.jar);
  h.fetchPage.mockReset();
  queued = [];
  setImportQueue(null);
});
afterEach(() => {
  setImportQueue(null);
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("access", () => {
  it("is a 404 unless IMPORT_ENABLED is exactly 'true'", async () => {
    await signIn();
    for (const v of ["", "false", "1", "yes"]) {
      vi.stubEnv("IMPORT_ENABLED", v);
      expect((await post({ url: "https://a.test/x" })).status, v).toBe(404);
      expect((await status("x")).status, v).toBe(404);
    }
    expect(h.fetchPage).not.toHaveBeenCalled();
  });

  it("requires sign-in and a verified email, before fetching anything", async () => {
    expect((await post({ url: "https://a.test/x" })).status).toBe(401);
    await signIn({ verified: false });
    expect((await post({ url: "https://a.test/x" })).status).toBe(403);
    expect(h.fetchPage).not.toHaveBeenCalled();
  });

  it("needs exactly one of link, PDF or text", async () => {
    await signIn();
    expect((await post({})).status).toBe(400);
    expect((await post({ url: "https://a.test/x", text: LONG })).status).toBe(400);
    expect(h.fetchPage).not.toHaveBeenCalled();
  });
});

describe("a posting with structured data", () => {
  it("answers immediately without any AI", async () => {
    const user = await signIn();
    h.fetchPage.mockResolvedValue({
      html: withLd({
        title: "Platform Engineer",
        hiringOrganization: { name: "Globex" },
        jobLocationType: "TELECOMMUTE",
        description: "<p>Run the platform.</p>",
      }),
      finalUrl: "https://boards.test/jobs/9",
    });
    const res = await post({ url: "https://boards.test/jobs/9" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      status: "done",
      via: "structured",
      fields: {
        company: "Globex",
        jobTitle: "Platform Engineer",
        workType: "REMOTE",
        jobUrl: "https://boards.test/jobs/9",
        jobDescription: "Run the platform.",
      },
    });
    const job = await db.importJob.findUniqueOrThrow({ where: { id: body.jobId } });
    expect(job).toMatchObject({ userId: user.id, status: "DONE", kind: "URL" });
    expect(queued).toEqual([]);
  });

  it("falls back to the page text when the posting has no description", async () => {
    await signIn();
    h.fetchPage.mockResolvedValue({
      html: withLd({ title: "Dev", hiringOrganization: { name: "X" } }),
      finalUrl: "https://boards.test/j",
    });
    const body = await (await post({ url: "https://boards.test/j" })).json();
    expect(body.fields.jobDescription).toContain("platform engineer");
  });
});

describe("descriptions", () => {
  it("keeps the posting's own description instead of the page text", async () => {
    await signIn();
    h.fetchPage.mockResolvedValue({
      // A title but no company, so this takes the text path, where the page text is on hand.
      html: withLd({ title: "Platform Engineer", description: "<p>The posting's own description.</p>" }),
      finalUrl: "https://boards.test/d",
    });
    const body = await (await post({ url: "https://boards.test/d" })).json();
    expect(body.fields.jobDescription).toBe("The posting's own description.");
  });

  it("drops cookie banners and Apply buttons from a page-text description", async () => {
    await signIn();
    h.fetchPage.mockResolvedValue({
      html: `<!DOCTYPE html><html><head><title>Platform Engineer at Globex</title></head><body>
        <div id="cookie-banner"><p>We use cookies to improve your experience.</p><button>Accept all</button></div>
        <div><h2>Platform Engineer at Globex</h2><button>Apply now</button><p>${LONG}</p><p>Share this job</p></div>
        </body></html>`,
      finalUrl: "https://careers.test/clean",
    });
    const body = await (await post({ url: "https://careers.test/clean" })).json();
    expect(body.fields.jobDescription).toContain("platform engineer");
    expect(body.fields.jobDescription).not.toMatch(/cookies|Accept all|Apply now|Share this job|doctype/i);
  });

  it("cuts an overlong page-text description at a paragraph boundary", async () => {
    await signIn();
    const paragraphs = Array.from({ length: 400 }, (_, i) => `<p>Paragraph ${i} describes the role in some detail for you.</p>`);
    h.fetchPage.mockResolvedValue({
      html: `<html><body><main><h2>Platform Engineer at Globex</h2>${paragraphs.join("")}</main></body></html>`,
      finalUrl: "https://careers.test/long",
    });
    const body = await (await post({ url: "https://careers.test/long" })).json();
    const d: string = body.fields.jobDescription;
    expect(d.length).toBeLessThanOrEqual(12_000);
    expect(d.length).toBeGreaterThan(11_000);
    expect(d.endsWith("in some detail for you.")).toBe(true);
  });
});

describe("a page without structured data", () => {
  it("fills the description and says what's missing when AI is off", async () => {
    await signIn();
    h.fetchPage.mockResolvedValue({ html: PLAIN, finalUrl: "https://careers.test/p" });
    const body = await (await post({ url: "https://careers.test/p" })).json();
    expect(body.status).toBe("done");
    expect(body.via).toBe("text");
    expect(body.notice).toMatch(/couldn't be detected/);
    expect(body.fields.company).toBeUndefined();
    expect(body.fields.jobUrl).toBe("https://careers.test/p");
    expect(body.fields.jobDescription).toContain("platform engineer");
  });

  it("fills company and title from the page's own metadata when there is no JSON-LD", async () => {
    await signIn();
    h.fetchPage.mockResolvedValue({
      html: `<html><head><title>Platform Engineer | Globex</title><meta property="og:site_name" content="Globex"></head><body><main><p>${LONG}</p></main></body></html>`,
      finalUrl: "https://careers.test/p",
    });
    const body = await (await post({ url: "https://careers.test/p" })).json();
    expect(body).toMatchObject({
      status: "done",
      fields: { company: "Globex", jobTitle: "Platform Engineer" },
    });
  });

  it("queues it for the worker when AI import is on, sending the text along", async () => {
    vi.stubEnv("AI_IMPORT_ENABLED", "true");
    setImportQueue(fakeQueue);
    await signIn();
    h.fetchPage.mockResolvedValue({ html: PLAIN, finalUrl: "https://careers.test/p" });
    const body = await (await post({ url: "https://careers.test/p" })).json();
    expect(body).toMatchObject({ status: "queued" });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ jobId: body.jobId, kind: "URL", sourceUrl: "https://careers.test/p" });
    expect(queued[0].text).toContain("Platform Engineer at Globex");
    expect((await (await status(body.jobId)).json()).status).toBe("queued");
  });

  it("stays text-only when the flag is on but no queue is wired up", async () => {
    vi.stubEnv("AI_IMPORT_ENABLED", "true");
    await signIn();
    h.fetchPage.mockResolvedValue({ html: PLAIN, finalUrl: "https://careers.test/p" });
    expect((await (await post({ url: "https://careers.test/p" })).json()).via).toBe("text");
  });

  it("ignores AI_IMPORT_ENABLED without IMPORT_ENABLED", async () => {
    vi.stubEnv("IMPORT_ENABLED", "false");
    vi.stubEnv("AI_IMPORT_ENABLED", "true");
    setImportQueue(fakeQueue);
    await signIn();
    expect((await post({ url: "https://careers.test/p" })).status).toBe(404);
    expect(queued).toEqual([]);
  });

  it("merges the worker's answer, never overriding what the page said", async () => {
    vi.stubEnv("AI_IMPORT_ENABLED", "true");
    setImportQueue(fakeQueue);
    const user = await signIn();
    // JSON-LD with a title but no company: partial, so it is queued.
    h.fetchPage.mockResolvedValue({
      html: withLd({ title: "Platform Engineer", description: "<p>Real description.</p>" }),
      finalUrl: "https://boards.test/p",
    });
    const { jobId } = await (await post({ url: "https://boards.test/p" })).json();

    expect(
      await completeJob(jobId, {
        company: "Globex",
        jobTitle: "WRONG TITLE FROM MODEL",
        location: "Berlin",
        workType: "nonsense",
        evil: "<script>",
      }),
    ).toBe(true);

    const body = await (await status(jobId)).json();
    expect(body).toMatchObject({
      status: "done",
      via: "ai",
      fields: {
        company: "Globex",
        jobTitle: "Platform Engineer",
        location: "Berlin",
        jobDescription: "Real description.",
      },
    });
    expect(body.fields.workType).toBeUndefined();
    expect(body.fields.evil).toBeUndefined();
    expect(user.id).toBeTruthy();
  });

  it("flags when the model found nothing", async () => {
    vi.stubEnv("AI_IMPORT_ENABLED", "true");
    setImportQueue(fakeQueue);
    await signIn();
    h.fetchPage.mockResolvedValue({ html: PLAIN, finalUrl: "https://careers.test/p" });
    const { jobId } = await (await post({ url: "https://careers.test/p" })).json();
    await completeJob(jobId, "garbage");
    const body = await (await status(jobId)).json();
    expect(body.status).toBe("done");
    expect(body.notice).toMatch(/Couldn't find the company/);
    expect(body.fields.jobDescription).toContain("platform engineer");
  });

  it("falls back to text-only if queueing fails, and records the failure", async () => {
    vi.stubEnv("AI_IMPORT_ENABLED", "true");
    vi.spyOn(console, "error").mockImplementation(() => {});
    setImportQueue({ enqueue: async () => Promise.reject(new Error("queue down")) });
    const user = await signIn();
    h.fetchPage.mockResolvedValue({ html: PLAIN, finalUrl: "https://careers.test/p" });
    const body = await (await post({ url: "https://careers.test/p" })).json();
    expect(body).toMatchObject({ status: "done", via: "text" });
    const jobs = await db.importJob.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } });
    expect(jobs.map((j) => j.status).sort()).toEqual(["DONE", "FAILED"]);
    expect(jobs.find((j) => j.status === "FAILED")?.errorCode).toBe("enqueue_failed");
  });

  it("allows at most 3 waiting jobs per person", async () => {
    vi.stubEnv("AI_IMPORT_ENABLED", "true");
    setImportQueue(fakeQueue);
    await signIn();
    h.fetchPage.mockResolvedValue({ html: PLAIN, finalUrl: "https://careers.test/p" });
    for (let i = 0; i < 3; i++) {
      expect((await (await post({ url: "https://careers.test/p" })).json()).status).toBe("queued");
    }
    const fourth = await (await post({ url: "https://careers.test/p" })).json();
    expect(fourth).toMatchObject({ status: "done", via: "text" });
    expect(fourth.notice).toMatch(/already have 3/);
    expect(queued).toHaveLength(3);
  });

  it("allows 10 AI imports a day", async () => {
    vi.stubEnv("AI_IMPORT_ENABLED", "true");
    setImportQueue(fakeQueue);
    const user = await signIn();
    h.fetchPage.mockResolvedValue({ html: PLAIN, finalUrl: "https://careers.test/p" });
    for (let i = 0; i < 10; i++) {
      const { jobId } = await (await post({ url: "https://careers.test/p" })).json();
      await completeJob(jobId, {});
    }
    const eleventh = await (await post({ url: "https://careers.test/p" })).json();
    expect(eleventh.via).toBe("text");
    expect(eleventh.notice).toMatch(/today's AI imports/);
    expect(queued).toHaveLength(10);
    expect(user.id).toBeTruthy();
  });
});

describe("queued job lifecycle", () => {
  async function queuedJob() {
    vi.stubEnv("AI_IMPORT_ENABLED", "true");
    setImportQueue(fakeQueue);
    const user = await signIn();
    h.fetchPage.mockResolvedValue({ html: PLAIN, finalUrl: "https://careers.test/p" });
    const { jobId } = await (await post({ url: "https://careers.test/p" })).json();
    return { user, jobId };
  }

  it("a failed job still returns the text so nothing is lost", async () => {
    const { jobId } = await queuedJob();
    expect(await failJob(jobId, "extract_failed")).toBe(true);
    const body = await (await status(jobId)).json();
    expect(body.status).toBe("failed");
    expect(body.fields.jobDescription).toContain("platform engineer");
  });

  it("only the first answer counts (duplicate deliveries are harmless)", async () => {
    const { jobId } = await queuedJob();
    expect(await completeJob(jobId, { company: "First", jobTitle: "A" })).toBe(true);
    expect(await completeJob(jobId, { company: "Second", jobTitle: "B" })).toBe(false);
    expect(await failJob(jobId, "late")).toBe(false);
    expect((await (await status(jobId)).json()).fields.company).toBe("First");
  });

  it("a job nobody answered becomes 'expired' after 15 minutes", async () => {
    const { jobId } = await queuedJob();
    vi.setSystemTime(new Date("2026-01-01T12:20:00Z"));
    expect((await (await status(jobId)).json()).status).toBe("queued");
    vi.setSystemTime(new Date("2026-01-01T12:23:31Z"));
    const body = await (await status(jobId)).json();
    expect(body.status).toBe("expired");
    expect(body.fields.jobDescription).toContain("platform engineer");
    // A late answer from the worker can't resurrect it.
    expect(await completeJob(jobId, { company: "Late", jobTitle: "Late" })).toBe(false);
  });

  it("expired jobs stop counting toward the 3-waiting cap", async () => {
    await queuedJob();
    await post({ url: "https://careers.test/p" });
    await post({ url: "https://careers.test/p" });
    vi.setSystemTime(new Date("2026-01-01T12:30:00Z"));
    expect((await (await post({ url: "https://careers.test/p" })).json()).status).toBe("queued");
  });

  it("deletes jobs older than 7 days", async () => {
    const { user } = await queuedJob();
    await db.importJob.updateMany({ data: { createdAt: new Date("2025-12-20T00:00:00Z") } });
    await post({ url: "https://careers.test/p" });
    const rows = await db.importJob.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].createdAt.getTime()).toBeGreaterThan(Date.parse("2026-01-01"));
  });

  it("other people's jobs look like missing ones", async () => {
    const { jobId } = await queuedJob();
    await signIn();
    expect((await status(jobId)).status).toBe(404);
    expect((await status("nope")).status).toBe(404);
  });

  it("requires sign-in to check status", async () => {
    const { jobId } = await queuedJob();
    h.jar.clear();
    expect((await status(jobId)).status).toBe(401);
  });

  it("deleting the account deletes its imports", async () => {
    const { user } = await queuedJob();
    await db.user.delete({ where: { id: user.id } });
    expect(await db.importJob.count()).toBe(0);
  });
});

describe("errors", () => {
  it("explains a blocked address without fetching the body", async () => {
    await signIn();
    h.fetchPage.mockRejectedValue(new FetchError("blocked"));
    const res = await post({ url: "http://169.254.169.254/" });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("blocked");
    expect(body.error).toMatch(/can't be imported/);
    expect(await db.importJob.count()).toBe(0);
  });

  it.each([
    ["timeout", /too long/],
    ["http_error", /login/],
    ["unreachable", /Couldn't reach/],
    ["not_html", /isn't a web page/],
  ] as const)("maps %s to a readable message", async (code, message) => {
    await signIn();
    h.fetchPage.mockRejectedValue(new FetchError(code));
    const body = await (await post({ url: "https://a.test/x" })).json();
    expect(body.error).toMatch(message);
  });

  it("rejects a page with no readable text", async () => {
    await signIn();
    h.fetchPage.mockResolvedValue({
      html: `<html><body><div id="root"></div><script>app()</script></body></html>`,
      finalUrl: "https://spa.test/",
    });
    const res = await post({ url: "https://spa.test/" });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("no_content");
  });
});

describe("a page with too little text", () => {
  // The page names a role but not who is hiring, and has no text to hand a model.
  const SHELL = `<html><head><title>Staff Engineer</title></head><body><div id="root">Loading…</div></body></html>`;

  it("still returns what it found, with a notice instead of a description", async () => {
    await signIn();
    h.fetchPage.mockResolvedValue({ html: SHELL, finalUrl: "https://careers.test/js?utm_source=x" });
    const res = await post({ url: "https://careers.test/js?utm_source=x" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      status: "done",
      via: "text",
      fields: { jobTitle: "Staff Engineer", jobUrl: "https://careers.test/js" },
    });
    expect(body.fields.company).toBeUndefined();
    expect(body.fields.jobDescription).toBeUndefined();
    expect(body.notice).toMatch(/very little readable text/);
  });

  it("returns whichever of company or title is known", async () => {
    await signIn();
    h.fetchPage.mockResolvedValue({
      html: withLd({ title: "Staff Engineer" }).replace(`<p>${LONG}</p>`, ""),
      finalUrl: "https://careers.test/ld",
    });
    const body = await (await post({ url: "https://careers.test/ld" })).json();
    expect(body).toMatchObject({ status: "done", fields: { jobTitle: "Staff Engineer" } });
    expect(body.fields.company).toBeUndefined();
  });

  it("is never queued for the AI worker, even when AI import is on", async () => {
    vi.stubEnv("AI_IMPORT_ENABLED", "true");
    setImportQueue(fakeQueue);
    await signIn();
    h.fetchPage.mockResolvedValue({ html: SHELL, finalUrl: "https://careers.test/js" });
    const body = await (await post({ url: "https://careers.test/js" })).json();
    expect(body).toMatchObject({ status: "done", via: "text", fields: { jobTitle: "Staff Engineer" } });
    expect(queued).toHaveLength(0);
    expect(await db.importJob.count({ where: { status: "QUEUED" } })).toBe(0);
  });

  it("is still an error when nothing at all is known", async () => {
    await signIn();
    h.fetchPage.mockResolvedValue({
      html: `<html><head><title>Jobs</title></head><body><div id="root"></div></body></html>`,
      finalUrl: "https://careers.test/empty",
    });
    const res = await post({ url: "https://careers.test/empty" });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("no_content");
  });

  it("does not change a page with enough text: still queued", async () => {
    vi.stubEnv("AI_IMPORT_ENABLED", "true");
    setImportQueue(fakeQueue);
    await signIn();
    h.fetchPage.mockResolvedValue({ html: PLAIN, finalUrl: "https://careers.test/p" });
    expect((await (await post({ url: "https://careers.test/p" })).json()).status).toBe("queued");
    expect(queued[0].text.length).toBeGreaterThanOrEqual(200);
  });
});

describe("the stored link", () => {
  it("drops tracking parameters but keeps what identifies the posting", async () => {
    await signIn();
    h.fetchPage.mockResolvedValue({
      html: withLd({ title: "Dev", hiringOrganization: { name: "X" }, description: "<p>Do things.</p>" }),
      finalUrl: "https://stripe.test/jobs/search?gh_jid=8172487&utm_source=x&gh_src=y#apply",
    });
    const body = await (await post({ url: "https://stripe.test/jobs/search?gh_jid=8172487" })).json();
    expect(body.fields.jobUrl).toBe("https://stripe.test/jobs/search?gh_jid=8172487#apply");
  });

  it("is set from the page even when only its metadata gave company and title", async () => {
    await signIn();
    h.fetchPage.mockResolvedValue({
      html: `<html><head><title>Platform Engineer | Globex</title><meta property="og:site_name" content="Globex"></head><body><main><p>${LONG}</p></main></body></html>`,
      finalUrl: "https://careers.test/p/12?ref=linkedin",
    });
    const body = await (await post({ url: "https://careers.test/p/12" })).json();
    expect(body.fields.jobUrl).toBe("https://careers.test/p/12");
  });

  it("keeps the page's own link when there are several postings in the page", async () => {
    await signIn();
    const ld = (title: string, url: string) => ({
      "@context": "https://schema.org",
      "@type": "JobPosting",
      title,
      url,
      hiringOrganization: { name: "Globex" },
      description: `<p>${title} description.</p>`,
    });
    h.fetchPage.mockResolvedValue({
      html: `<html><head><script type="application/ld+json">${JSON.stringify([
        ld("Wrong One", "https://careers.test/jobs/1"),
        ld("Right One", "https://careers.test/jobs/2"),
      ])}</script></head><body><main><p>${LONG}</p></main></body></html>`,
      finalUrl: "https://careers.test/jobs/2?utm_campaign=z",
    });
    const body = await (await post({ url: "https://careers.test/jobs/2" })).json();
    expect(body).toMatchObject({
      via: "structured",
      fields: { jobTitle: "Right One", jobUrl: "https://careers.test/jobs/2" },
    });
  });
});

describe("PDF and pasted text", () => {
  it("reads a PDF without storing the file", async () => {
    await signIn();
    const pdf = makePdf(["Staff Engineer at Initech", ...LONG.match(/.{1,70}/g)!.slice(0, 6)]);
    const file = new File([new Uint8Array(pdf)], "posting.pdf", { type: "application/pdf" });
    const body = await (await post({ file })).json();
    expect(body).toMatchObject({ status: "done", via: "text" });
    expect(body.fields.jobDescription).toContain("Staff Engineer at Initech");
    expect(await db.resume.count()).toBe(0);
  });

  it("rejects a file that only claims to be a PDF", async () => {
    await signIn();
    const file = new File(["MZ not a pdf at all, just some text pretending"], "evil.pdf", {
      type: "application/pdf",
    });
    const res = await post({ file });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("not_pdf");
  });

  it("rejects an oversized PDF", async () => {
    await signIn();
    const file = new File([new Uint8Array(4 * 1024 * 1024 + 1)], "big.pdf", { type: "application/pdf" });
    expect((await (await post({ file })).json()).code).toBe("pdf_too_large");
  });

  it("takes pasted text, and asks for more if it is too short", async () => {
    await signIn();
    const ok = await (await post({ text: LONG })).json();
    expect(ok).toMatchObject({ status: "done", via: "text" });
    expect(ok.fields.jobDescription).toContain("platform engineer");
    const short = await post({ text: "too short" });
    expect(short.status).toBe(422);
    expect((await short.json()).code).toBe("text_too_short");
    expect(h.fetchPage).not.toHaveBeenCalled();
  });
});

describe("rate limits", () => {
  it("allows 30 imports a day per person, then 429s before doing any work", async () => {
    await signIn();
    for (let i = 0; i < 30; i++) expect((await post({ text: LONG })).status).toBe(200);
    const limited = await post({ text: LONG });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });

  it("limits each network address too, across accounts", async () => {
    for (let i = 0; i < 60; i++) {
      if (i % 30 === 0) await signIn();
      expect((await post({ text: LONG })).status, `import ${i}`).toBe(200);
    }
    await signIn();
    expect((await post({ text: LONG })).status).toBe(429);
  });
});

describe("application questions found on the posting", () => {
  const FORM = `<form action="/apply"><input type="file" name="resume">
    <label for="q1">Why do you want to join Globex?</label><textarea id="q1"></textarea>
    <label for="q2">Email</label><input id="q2" type="email">
    <button>Submit application</button></form>`;
  const withForm = (html: string) => html.replace("</main>", `${FORM}</main>`);

  it("returns them with a structured posting, and stores them with the job", async () => {
    const user = await signIn();
    h.fetchPage.mockResolvedValue({
      html: withForm(
        withLd({ title: "Platform Engineer", hiringOrganization: { name: "Globex" }, description: "<p>Run it.</p>" }),
      ),
      finalUrl: "https://boards.test/jobs/9",
    });
    const body = await (await post({ url: "https://boards.test/jobs/9" })).json();
    expect(body).toMatchObject({ status: "done", via: "structured", questions: ["Why do you want to join Globex?"] });
    const job = await db.importJob.findFirstOrThrow({ where: { userId: user.id } });
    expect(job.questions).toEqual(["Why do you want to join Globex?"]);
    // The status route gives the same answer back.
    expect((await (await status(job.id)).json()).questions).toEqual(["Why do you want to join Globex?"]);
  });

  it("returns them with a text-only import too", async () => {
    await signIn();
    h.fetchPage.mockResolvedValue({ html: withForm(PLAIN), finalUrl: "https://careers.test/p" });
    const body = await (await post({ url: "https://careers.test/p" })).json();
    expect(body).toMatchObject({ via: "text", questions: ["Why do you want to join Globex?"] });
  });

  it("returns an empty list when there are none, and for text and PDF imports", async () => {
    await signIn();
    h.fetchPage.mockResolvedValue({ html: PLAIN, finalUrl: "https://careers.test/p" });
    expect((await (await post({ url: "https://careers.test/p" })).json()).questions).toEqual([]);
    expect((await (await post({ text: LONG })).json()).questions).toEqual([]);
  });

  it("keeps them through the worker, adding what the model saw (cleaned)", async () => {
    vi.stubEnv("AI_IMPORT_ENABLED", "true");
    setImportQueue(fakeQueue);
    const user = await signIn();
    h.fetchPage.mockResolvedValue({ html: withForm(PLAIN), finalUrl: "https://careers.test/p" });
    const { jobId } = await (await post({ url: "https://careers.test/p" })).json();
    expect(
      await completeJob(jobId, {
        company: "Globex",
        jobTitle: "Platform Engineer",
        questions: [
          "why do you want to join globex",
          "Describe a hard bug you fixed.",
          "Email",
          42,
          "Describe a hard bug you fixed. *",
        ],
      }),
    ).toBe(true);
    const done = await (await status(jobId)).json();
    expect(done.questions).toEqual(["Why do you want to join Globex?", "Describe a hard bug you fixed."]);
    expect((await db.importJob.findFirstOrThrow({ where: { userId: user.id } })).questions).toEqual(done.questions);
  });

  it("ignores a model answer whose questions aren't a list", async () => {
    vi.stubEnv("AI_IMPORT_ENABLED", "true");
    setImportQueue(fakeQueue);
    await signIn();
    h.fetchPage.mockResolvedValue({ html: PLAIN, finalUrl: "https://careers.test/p" });
    const { jobId } = await (await post({ url: "https://careers.test/p" })).json();
    await completeJob(jobId, { company: "Globex", jobTitle: "Eng", questions: "everything" });
    expect((await (await status(jobId)).json()).questions).toEqual([]);
  });

  it("still returns the questions when the worker fails", async () => {
    vi.stubEnv("AI_IMPORT_ENABLED", "true");
    setImportQueue(fakeQueue);
    await signIn();
    h.fetchPage.mockResolvedValue({ html: withForm(PLAIN), finalUrl: "https://careers.test/p" });
    const { jobId } = await (await post({ url: "https://careers.test/p" })).json();
    await failJob(jobId, "worker_error");
    expect((await (await status(jobId)).json()).questions).toEqual(["Why do you want to join Globex?"]);
  });
});
