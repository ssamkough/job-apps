import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ fetchJson: vi.fn() }));
vi.mock("./safe-fetch", async (orig) => ({
  ...(await orig<typeof import("./safe-fetch")>()),
  fetchJson: h.fetchJson,
}));

import { greenhousePosting, readBoard, smartRecruitersPosting, smartRecruitersRef } from "./boards";
import { FetchError } from "./safe-fetch";

// Braces matter: returning the mock from beforeEach would make vitest call it as a teardown hook.
beforeEach(() => {
  h.fetchJson.mockReset();
});

// Shaped like the real API responses (trimmed).
const GREENHOUSE = {
  id: 5456619008,
  title: "3P Revenue Accounting & Reporting",
  company_name: "Anthropic",
  location: { name: "San Francisco, CA | Seattle, WA" },
  metadata: [{ id: 1, name: "Location Type", value: "On-Site", value_type: "single_select" }],
  content:
    "&lt;div class=&quot;content-intro&quot;&gt;&lt;h2&gt;&lt;strong&gt;About Anthropic&lt;/strong&gt;&lt;/h2&gt;" +
    "&lt;p&gt;We build reliable &amp;amp; steerable AI.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Own close&lt;/li&gt;&lt;li&gt;Audit&lt;/li&gt;&lt;/ul&gt;&lt;/div&gt;",
  questions: [
    { label: "First Name", fields: [{ type: "input_text" }] },
    { label: "Why Anthropic?", fields: [{ type: "textarea" }] },
  ],
};

describe("greenhousePosting", () => {
  it("maps the API into form fields with a clean description and the questions", () => {
    const p = greenhousePosting(GREENHOUSE, "https://job-boards.greenhouse.io/anthropic/jobs/5456619008")!;
    expect(p.board).toBe("greenhouse");
    expect(p.fields).toMatchObject({
      company: "Anthropic",
      jobTitle: "3P Revenue Accounting & Reporting",
      location: "San Francisco, CA | Seattle, WA",
      workType: "ONSITE",
      jobUrl: "https://job-boards.greenhouse.io/anthropic/jobs/5456619008",
    });
    // Entity-escaped HTML becomes readable text, with no leftover markup.
    expect(p.fields.jobDescription).toContain("About Anthropic");
    expect(p.fields.jobDescription).toContain("We build reliable & steerable AI.");
    expect(p.fields.jobDescription).not.toMatch(/[<>]|&lt;|&amp;/);
    expect(p.questions).toEqual(["Why Anthropic?"]);
  });

  it("reads remote and hybrid location types, ignores unknown ones", () => {
    const type = (value: string) =>
      greenhousePosting({ ...GREENHOUSE, metadata: [{ name: "Work Model", value }] }, "https://x.test/")!.fields.workType;
    expect(type("Remote")).toBe("REMOTE");
    expect(type("Hybrid")).toBe("HYBRID");
    expect(type("Somewhere")).toBeUndefined();
  });

  it("rejects responses that aren't a posting", () => {
    expect(greenhousePosting(null, "https://x.test/")).toBeNull();
    expect(greenhousePosting([], "https://x.test/")).toBeNull();
    expect(greenhousePosting({ content: "x" }, "https://x.test/")).toBeNull();
  });
});

describe("smartRecruitersRef", () => {
  it("reads the company and id from a posting URL", () => {
    expect(smartRecruitersRef("https://jobs.smartrecruiters.com/SmartRecruiters/744000158320111")).toEqual({
      company: "SmartRecruiters",
      id: "744000158320111",
    });
    expect(
      smartRecruitersRef("https://jobs.smartrecruiters.com/smartrecruiters/744000158320111-senior-lead-engineering-manager"),
    ).toEqual({ company: "smartrecruiters", id: "744000158320111" });
  });
  it("only accepts that host and shape", () => {
    expect(smartRecruitersRef("https://evil.test/SmartRecruiters/744000158320111")).toBeNull();
    expect(smartRecruitersRef("https://jobs.smartrecruiters.com.evil.test/A/744000158320111")).toBeNull();
    expect(smartRecruitersRef("https://jobs.smartrecruiters.com/A/12")).toBeNull();
    expect(smartRecruitersRef("https://jobs.smartrecruiters.com/a%2f..%2fb/744000158320111")).toBeNull();
    expect(smartRecruitersRef("nope")).toBeNull();
  });
});

describe("smartRecruitersPosting", () => {
  const data = {
    name: "Senior / Lead Engineering Operations Manager",
    company: { name: "SmartRecruiters Inc", identifier: "smartrecruiters" },
    location: { city: "Warsaw", region: "Remote", country: "pl", remote: true, hybrid: false },
    jobAd: {
      sections: {
        companyDescription: { title: "Company Description", text: "<p>Skip me.</p>" },
        jobDescription: { title: "Job Description", text: "<p>Own <b>process</b> design.</p>" },
        qualifications: { title: "Qualifications", text: "<ul><li>Analytical</li><li>Coaching</li></ul>" },
      },
    },
  };
  it("maps the API, leaving out the company blurb", () => {
    const p = smartRecruitersPosting(data, "https://jobs.smartrecruiters.com/SmartRecruiters/1")!;
    expect(p.fields).toMatchObject({
      company: "SmartRecruiters Inc",
      jobTitle: "Senior / Lead Engineering Operations Manager",
      location: "Warsaw, PL",
      workType: "REMOTE",
    });
    expect(p.fields.jobDescription).toContain("Job Description\nOwn process design.");
    expect(p.fields.jobDescription).toContain("Qualifications");
    expect(p.fields.jobDescription).not.toContain("Skip me");
    expect(p.questions).toEqual([]);
  });
  it("tolerates missing parts", () => {
    expect(smartRecruitersPosting({ name: "Dev" }, "https://x.test/")!.fields.jobTitle).toBe("Dev");
    expect(smartRecruitersPosting({}, "https://x.test/")).toBeNull();
    expect(smartRecruitersPosting("x", "https://x.test/")).toBeNull();
  });
});

describe("readBoard", () => {
  it("asks Greenhouse's API for a Greenhouse page", async () => {
    h.fetchJson.mockResolvedValue(GREENHOUSE);
    const p = await readBoard({ html: "", finalUrl: "https://job-boards.greenhouse.io/anthropic/jobs/5456619008" });
    expect(p?.fields.company).toBe("Anthropic");
    expect(h.fetchJson).toHaveBeenCalledWith(
      "https://boards-api.greenhouse.io/v1/boards/anthropic/jobs/5456619008?questions=true",
      expect.anything(),
    );
  });

  it("asks SmartRecruiters' API for a SmartRecruiters page", async () => {
    h.fetchJson.mockResolvedValue({ name: "Dev", company: { name: "Acme" } });
    const p = await readBoard({ html: "", finalUrl: "https://jobs.smartrecruiters.com/Acme/744000158320111-dev" });
    expect(p?.fields).toMatchObject({ company: "Acme", jobTitle: "Dev" });
    expect(h.fetchJson).toHaveBeenCalledWith(
      "https://api.smartrecruiters.com/v1/companies/Acme/postings/744000158320111",
      expect.anything(),
    );
  });

  it("returns null for other sites without any request, and swallows failures", async () => {
    expect(await readBoard({ html: "", finalUrl: "https://careers.example.com/job/1" })).toBeNull();
    expect(h.fetchJson).not.toHaveBeenCalled();
    h.fetchJson.mockRejectedValue(new FetchError("http_error", 404));
    expect(await readBoard({ html: "", finalUrl: "https://boards.greenhouse.io/acme/jobs/5" })).toBeNull();
    expect(h.fetchJson).toHaveBeenCalledTimes(1);
  });
});
