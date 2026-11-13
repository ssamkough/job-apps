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

  it("leaves out the doctype and the <title> in the head", () => {
    const html = `<!DOCTYPE html><html><head><title>Engineer - Careers at Acme</title></head>
      <body><h1>Engineer</h1><p>Build things.</p></body></html>`;
    expect(pageText(html)).toBe("Engineer\nBuild things.");
  });

  it("uses [role=main] and, failing that, <article>", () => {
    expect(
      pageText(`<body><div>Chrome</div><div role="main"><p>The posting</p></div><article>Other</article></body>`),
    ).toBe("The posting");
    expect(pageText(`<body><div>Chrome</div><article><p>The article</p></article></body>`)).toBe("The article");
  });

  it("cuts at a paragraph boundary, never mid-word, and never over the cap", () => {
    const para = (n: number) => `Paragraph ${n} says that we build reliable software together.`;
    const html = `<body>${[1, 2, 3, 4, 5].map((n) => `<p>${para(n)}</p>`).join("")}</body>`;
    const limit = para(1).length * 3 + 10; // room for 3 paragraphs and a bit of the 4th
    const text = pageText(html, limit);
    expect(text).toBe([1, 2, 3].map(para).join("\n"));
    expect(text.length).toBeLessThanOrEqual(limit);
  });

  it("falls back to a sentence, then a word, when a paragraph is too long to cut at", () => {
    const sentence = "We build reliable software for people who care about it.";
    const html = `<body><p>${Array(10).fill(sentence).join(" ")}</p></body>`;
    const bySentence = pageText(html, sentence.length * 5 + 20);
    expect(bySentence.endsWith("about it.")).toBe(true);
    expect(bySentence.length).toBeLessThanOrEqual(sentence.length * 5 + 20);

    const words = `<body><p>${"alpha beta gamma delta ".repeat(100)}</p></body>`;
    const byWord = pageText(words, 101);
    expect(byWord).toMatch(/(alpha|beta|gamma|delta)$/);
    expect(byWord.split(" ").every((w) => ["alpha", "beta", "gamma", "delta"].includes(w))).toBe(true);
    expect(byWord.length).toBeLessThanOrEqual(101);
  });

  describe("site chrome", () => {
    const POSTING = `<h1>Platform Engineer</h1><p>Remote, US</p><h2>About the role</h2>
      <p>You will build and run the services that power our product, with a team that cares.</p>
      <h2>Requirements</h2><ul><li>Go</li><li>SQL</li><li>Kubernetes</li><li>AWS</li><li>Postgres</li></ul>`;

    it("drops cookie banners, but keeps the posting", () => {
      const html = `<body>
        <div id="cookie-banner"><p>We use cookies to improve your experience.</p><button>Accept all</button></div>
        <div class="onetrust-consent-sdk">Manage preferences</div>
        ${POSTING}</body>`;
      const text = pageText(html);
      expect(text).not.toMatch(/cookies|Accept all|Manage preferences/);
      expect(text).toContain("Platform Engineer");
      expect(text).toContain("Kubernetes");
    });

    it("never removes a wrapper that only has 'consent' or 'cookie' in a class", () => {
      const html = `<body class="cookie-consent-open"><div class="page cookie-wrapper">${POSTING}</div></body>`;
      expect(pageText(html)).toContain("build and run the services");
    });

    it("keeps a posting that mentions privacy inside a wrapper with 'cookie' in its class", () => {
      const html = `<body><div class="cookie-wrapper"><p>Respect user privacy in everything you build here, every single day.</p></div></body>`;
      expect(pageText(html)).toContain("Respect user privacy");
    });

    it("drops cookie notice lines even without a recognisable container", () => {
      const html = `<body><p>This website uses cookies to ensure you get the best experience.</p>
        <p>Cookie Preferences Your Privacy Choices</p>${POSTING}</body>`;
      expect(pageText(html)).not.toMatch(/uses cookies|Cookie Preferences/i);
    });

    it("keeps job text that merely mentions cookies", () => {
      const html = `<body><p>Experience with cookies, sessions and tokens in web apps is a plus.</p></body>`;
      expect(pageText(html)).toContain("Experience with cookies");
    });

    it("drops Apply buttons, share lines and back links, but not sentences that start with those words", () => {
      const html = `<body>
        <p>Back to jobs</p>${POSTING}
        <a>Apply</a><p>Share this job</p><p>Share on LinkedIn</p><button>Apply now</button>
        <p>Apply for this job</p>
        <p>Apply your skills to problems that matter to millions of people.</p>
        <p>Share ownership of the roadmap with product and design.</p></body>`;
      const text = pageText(html);
      expect(text.split("\n")).not.toContain("Apply");
      expect(text).not.toMatch(/Back to jobs|Share this job|Share on LinkedIn|Apply now|Apply for this job/);
      expect(text).toContain("Apply your skills to problems");
      expect(text).toContain("Share ownership of the roadmap");
    });

    it("drops a footer link list and copyright line made of well-known menu words", () => {
      const html = `<body>${POSTING}
        <div>Life at Acme</div><div>FAQ</div><div>Candidate Privacy</div><div>Careers</div>
        <div>Terms</div><div>Sitemap</div><div>© Acme, Inc</div></body>`;
      const text = pageText(html);
      expect(text).not.toMatch(/Life at Acme|FAQ|Sitemap|©/);
      expect(text).toContain("Postgres");
    });

    it("keeps short lists of real content, such as skills and benefits", () => {
      const html = `<body><h2>Skills</h2><ul><li>Python</li><li>Go</li><li>Rust</li><li>SQL</li><li>Privacy</li></ul>
        <h2>About us</h2><p>We make things.</p><h2>Careers</h2><p>Grow here.</p></body>`;
      const text = pageText(html);
      expect(text).toContain("Python\nGo\nRust\nSQL\nPrivacy");
      expect(text).toContain("About us\nWe make things.");
      expect(text).toContain("Careers\nGrow here.");
    });
  });
});

describe("htmlToText", () => {
  it("turns blocks into lines", () => {
    expect(htmlToText("<p>One</p><p>Two</p><ul><li>a</li><li>b</li></ul>")).toBe("One\nTwo\na\nb");
  });
});
