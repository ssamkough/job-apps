import { describe, expect, it } from "vitest";
import { htmlToText, pageText, readJobPosting } from "./html";

const page = (ld: unknown, body = "<p>hi</p>") =>
  `<html><head><title>T</title><script type="application/ld+json">${
    typeof ld === "string" ? ld : JSON.stringify(ld)
  }</script></head><body>${body}</body></html>`;

describe("readJobPosting", () => {
  it("reads a full JobPosting", () => {
    const html = page({
      "@context": "https://schema.org",
      "@type": "JobPosting",
      title: "Senior Backend Engineer",
      description: "<p>Build <b>APIs</b> &amp; services.</p><ul><li>Go</li><li>SQL</li></ul>",
      hiringOrganization: { "@type": "Organization", name: "Acme Corp" },
      jobLocation: {
        "@type": "Place",
        address: { addressLocality: "Austin", addressRegion: "TX", addressCountry: "US" },
      },
      baseSalary: {
        "@type": "MonetaryAmount",
        currency: "USD",
        value: { "@type": "QuantitativeValue", minValue: 140000, maxValue: 170000, unitText: "YEAR" },
      },
      url: "https://elsewhere.test/other",
    });
    const f = readJobPosting(html, "https://acme.test/jobs/1")!;
    expect(f).toMatchObject({
      company: "Acme Corp",
      jobTitle: "Senior Backend Engineer",
      location: "Austin, TX, US",
      salary: "USD 140,000–170,000 / yr",
      // The page we actually read beats the posting's own URL.
      jobUrl: "https://acme.test/jobs/1",
    });
    expect(f.jobDescription).toContain("Build APIs & services.");
    expect(f.jobDescription).toContain("Go");
    expect(f.jobDescription).not.toContain("<");
    expect(f.workType).toBeUndefined();
  });

  it("finds the posting inside @graph and arrays", () => {
    const graph = page({
      "@graph": [
        { "@type": "WebSite", name: "Board" },
        { "@type": ["JobPosting"], title: "Designer", hiringOrganization: "Studio" },
      ],
    });
    expect(readJobPosting(graph)).toMatchObject({ company: "Studio", jobTitle: "Designer" });

    const arr = page([{ "@type": "Organization" }, { "@type": "JobPosting", title: "PM", hiringOrganization: { name: "X" } }]);
    expect(readJobPosting(arr)).toMatchObject({ company: "X", jobTitle: "PM" });
  });

  it("marks telecommute roles as remote", () => {
    const html = page({
      "@type": "JobPosting",
      title: "Dev",
      hiringOrganization: { name: "X" },
      jobLocationType: "TELECOMMUTE",
      applicantLocationRequirements: { "@type": "Country", name: "USA" },
    });
    expect(readJobPosting(html)).toMatchObject({ workType: "REMOTE", location: "USA" });
  });

  it("handles a single salary figure and no unit", () => {
    const html = page({
      "@type": "JobPosting",
      title: "Dev",
      hiringOrganization: { name: "X" },
      baseSalary: { currency: "EUR", value: 65000 },
    });
    expect(readJobPosting(html)!.salary).toBe("EUR 65,000");
  });

  it("returns null without a JobPosting and survives bad JSON-LD", () => {
    expect(readJobPosting(page({ "@type": "Article" }))).toBeNull();
    expect(readJobPosting(page("{not json"))).toBeNull();
    expect(readJobPosting("<html><body>nothing</body></html>")).toBeNull();
  });

  it("uses a good block even if another block is malformed", () => {
    const html = `<script type="application/ld+json">{oops</script>${page({
      "@type": "JobPosting",
      title: "Dev",
      hiringOrganization: { name: "X" },
    })}`;
    expect(readJobPosting(html)).toMatchObject({ company: "X" });
  });

  it("ignores values that aren't strings", () => {
    const html = page({ "@type": "JobPosting", title: { evil: 1 }, hiringOrganization: 5 });
    expect(readJobPosting(html)).toEqual({});
  });
});

describe("pageText", () => {
  it("drops scripts, styles and site chrome, and decodes entities", () => {
    const html = `<html><head><style>.x{}</style></head><body>
      <nav>Home Jobs About</nav>
      <script>var secret = 1;</script>
      <h1>Engineer &amp; Builder</h1>
      <p>Write code.</p>
      <footer>© Acme</footer></body></html>`;
    const text = pageText(html);
    expect(text).toContain("Engineer & Builder");
    expect(text).toContain("Write code.");
    expect(text).not.toMatch(/secret|Home Jobs|©|\.x/);
  });

  it("prefers <main>", () => {
    const html = `<body><div>Cookie banner text</div><main><p>The posting</p></main></body>`;
    expect(pageText(html)).toBe("The posting");
  });

  it("keeps content wrapped in a <form>", () => {
    expect(pageText(`<body><form><p>Real posting inside form</p></form></body>`)).toContain(
      "Real posting inside form",
    );
  });

  it("caps length", () => {
    expect(pageText(`<body><p>${"a".repeat(30_000)}</p></body>`, 1000)).toHaveLength(1000);
  });
});

describe("htmlToText", () => {
  it("turns blocks into lines", () => {
    expect(htmlToText("<p>One</p><p>Two</p><ul><li>a</li><li>b</li></ul>")).toBe("One\nTwo\na\nb");
  });
});
