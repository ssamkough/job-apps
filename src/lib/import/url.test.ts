import { describe, expect, it } from "vitest";
import { cleanJobUrl } from "./url";

describe("cleanJobUrl", () => {
  it("removes utm_* and other campaign parameters", () => {
    expect(
      cleanJobUrl("https://acme.test/jobs/42?utm_source=linkedin&utm_medium=social&utm_campaign=x"),
    ).toBe("https://acme.test/jobs/42");
    expect(cleanJobUrl("https://acme.test/jobs/42?fbclid=abc&gclid=def&msclkid=1")).toBe(
      "https://acme.test/jobs/42",
    );
  });

  it("removes Greenhouse and Lever source parameters", () => {
    expect(cleanJobUrl("https://job-boards.greenhouse.io/acme/jobs/123?gh_src=abc123")).toBe(
      "https://job-boards.greenhouse.io/acme/jobs/123",
    );
    expect(
      cleanJobUrl("https://jobs.lever.co/acme/6ed76ce8?lever-source=LinkedIn&lever-origin=applied"),
    ).toBe("https://jobs.lever.co/acme/6ed76ce8");
    expect(cleanJobUrl("https://jobs.lever.co/acme/6ed76ce8?lever-source%5B%5D=Twitter")).toBe(
      "https://jobs.lever.co/acme/6ed76ce8",
    );
  });

  it("removes ref, src and source when they say where the visitor came from", () => {
    expect(cleanJobUrl("https://acme.test/jobs/42?ref=linkedin")).toBe("https://acme.test/jobs/42");
    expect(cleanJobUrl("https://acme.test/jobs/42?src=careers-page&source=Twitter")).toBe(
      "https://acme.test/jobs/42",
    );
  });

  it("keeps a numeric ref, src or source, which may be the posting id", () => {
    expect(cleanJobUrl("https://acme.test/jobs?ref=48123")).toBe("https://acme.test/jobs?ref=48123");
  });

  it("keeps the parameters that identify the posting, in order and as spelled", () => {
    expect(
      cleanJobUrl("https://acme.test/search?utm_source=x&id=7&Dept=R%26D&gclid=1&page=2"),
    ).toBe("https://acme.test/search?id=7&Dept=R%26D&page=2");
  });

  it("keeps gh_jid when the path doesn't identify the job (stripe.com/jobs/search)", () => {
    const url = "https://stripe.com/jobs/search?gh_jid=8172487";
    expect(cleanJobUrl(url)).toBe(url);
    expect(cleanJobUrl(`${url}&utm_source=x`)).toBe(url);
  });

  it("drops gh_jid only when the path already carries the same id", () => {
    expect(cleanJobUrl("https://careers.airbnb.com/positions/8365363/?gh_jid=8365363")).toBe(
      "https://careers.airbnb.com/positions/8365363/",
    );
    expect(
      cleanJobUrl("https://stripe.com/careers/listing/abuse-investigator/8172487?gh_jid=8172487"),
    ).toBe("https://stripe.com/careers/listing/abuse-investigator/8172487");
    // A different id, or one that only appears inside a longer number, is not the same posting.
    const other = "https://acme.test/jobs/999?gh_jid=123";
    expect(cleanJobUrl(other)).toBe(other);
    const longer = "https://acme.test/jobs/81723?gh_jid=1723";
    expect(cleanJobUrl(longer)).toBe(longer);
  });

  it("keeps the fragment", () => {
    expect(cleanJobUrl("https://acme.test/jobs?utm_source=x#/role/42")).toBe("https://acme.test/jobs#/role/42");
  });

  it("returns a link with nothing to remove exactly as given", () => {
    for (const url of [
      "https://acme.test/jobs/42",
      "https://acme.test",
      "https://acme.test/jobs/42?id=1&x=%20y",
      "HTTPS://Acme.test/Jobs/42?Id=1",
    ]) {
      expect(cleanJobUrl(url)).toBe(url);
    }
  });

  it("leaves things that aren't http(s) links alone", () => {
    expect(cleanJobUrl("not a url?utm_source=x")).toBe("not a url?utm_source=x");
    expect(cleanJobUrl("mailto:a@b.test?utm_source=x")).toBe("mailto:a@b.test?utm_source=x");
  });

  it("is idempotent", () => {
    const once = cleanJobUrl("https://acme.test/jobs/42?utm_source=x&gh_src=y&id=1#top");
    expect(cleanJobUrl(once)).toBe(once);
    expect(once).toBe("https://acme.test/jobs/42?id=1#top");
  });
});
