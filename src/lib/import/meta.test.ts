import { describe, expect, it } from "vitest";
import { companyFromUrl, readPageMeta } from "./meta";

const page = (head: string, body = "") => `<html><head>${head}</head><body>${body}</body></html>`;

describe("companyFromUrl", () => {
  it("reads the employer from board paths and subdomains", () => {
    expect(companyFromUrl("https://jobs.lever.co/acme-corp/123")).toBe("Acme Corp");
    expect(companyFromUrl("https://jobs.ashbyhq.com/Ashby/abc")).toBe("Ashby");
    expect(companyFromUrl("https://apply.workable.com/globex/j/ABC/")).toBe("Globex");
    expect(companyFromUrl("https://initech.bamboohr.com/careers/4")).toBe("Initech");
    expect(companyFromUrl("https://acme.breezy.hr/p/abc-engineer")).toBe("Acme");
  });
  it("says nothing for other sites or bad input", () => {
    expect(companyFromUrl("https://careers.example.com/jobs/1")).toBeUndefined();
    expect(companyFromUrl("https://jobs.lever.co/")).toBeUndefined();
    expect(companyFromUrl("https://jobs.lever.co/12345/x")).toBeUndefined();
    expect(companyFromUrl("not a url")).toBeUndefined();
    expect(companyFromUrl(undefined)).toBeUndefined();
  });
});

describe("readPageMeta", () => {
  it("uses og:title for the role and og:site_name for the company", () => {
    const html = page(
      '<meta property="og:title" content="Staff Engineer"><meta property="og:site_name" content="Acme">',
    );
    expect(readPageMeta(html)).toEqual({ jobTitle: "Staff Engineer", company: "Acme" });
  });

  it("strips the site name off the end of the title", () => {
    const html = page('<title>Staff Engineer | Acme</title><meta property="og:site_name" content="Acme">');
    expect(readPageMeta(html)).toEqual({ jobTitle: "Staff Engineer", company: "Acme" });
  });

  it("splits 'Role at Company' when nothing else names the company", () => {
    expect(readPageMeta(page("<title>Data Analyst at Globex</title>"))).toEqual({
      jobTitle: "Data Analyst",
      company: "Globex",
    });
    expect(readPageMeta(page("<title>Data Analyst at Globex - Careers</title>"))).toEqual({
      jobTitle: "Data Analyst",
      company: "Globex",
    });
  });

  it("keeps ' at ' in a title when the site name is already known", () => {
    const html = page(
      '<title>Receptionist at Large | Acme</title><meta property="og:site_name" content="Acme">',
    );
    expect(readPageMeta(html).jobTitle).toBe("Receptionist at Large");
  });

  it("takes the company from the link on a job board, and drops it from the title", () => {
    const html = page("<title>Platform Engineer - Acme Corp</title>");
    expect(readPageMeta(html, "https://jobs.lever.co/acme-corp/1")).toEqual({
      jobTitle: "Platform Engineer",
      company: "Acme Corp",
    });
  });

  it("ignores a site name that is only the job board", () => {
    const html = page('<meta property="og:site_name" content="Greenhouse"><title>Designer</title>');
    expect(readPageMeta(html, "https://boards.greenhouse.io/globex/jobs/9")).toEqual({
      jobTitle: "Designer",
      company: "Globex",
    });
  });

  it("understands 'Company Careers' and drops generic parts", () => {
    expect(readPageMeta(page("<title>Product Manager | Initech Careers</title>"))).toEqual({
      jobTitle: "Product Manager",
      company: "Initech",
    });
    expect(readPageMeta(page("<title>Careers | Jobs</title>"))).toEqual({});
  });

  it("strips 'Careers at' from a company and ignores listing pages", () => {
    expect(
      readPageMeta(page('<meta property="og:site_name" content="Careers at Airbnb"><title>Account Executive</title>')),
    ).toEqual({ jobTitle: "Account Executive", company: "Airbnb" });
    expect(readPageMeta(page("<title>Job Openings at Meta</title>"))).toEqual({ company: "Meta" });
  });

  it("uses the heading to tell 'Company - Role' from 'Role - Company'", () => {
    const html = page("<title>Hooli - Site Reliability Engineer</title>", "<h1>Site Reliability Engineer</h1>");
    expect(readPageMeta(html)).toEqual({ jobTitle: "Site Reliability Engineer", company: "Hooli" });
  });

  it("falls back to the h1 when there is no title at all", () => {
    expect(readPageMeta(page("", "<h1>  Support   Lead </h1>"))).toEqual({ jobTitle: "Support Lead" });
  });

  it("does not treat error and bot-check pages as a job title", () => {
    expect(readPageMeta(page("<title>Just a moment...</title>"))).toEqual({});
    expect(readPageMeta(page("<title>404 Not Found</title>"))).toEqual({});
  });

  it("decodes entities and returns nothing for an empty page", () => {
    expect(readPageMeta(page('<meta property="og:title" content="R&amp;D Engineer">')).jobTitle).toBe(
      "R&D Engineer",
    );
    expect(readPageMeta("")).toEqual({});
  });
});
