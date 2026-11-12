import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ fetchJson: vi.fn(), fetchPage: vi.fn() }));
vi.mock("./safe-fetch", async (orig) => ({
  ...(await orig<typeof import("./safe-fetch")>()),
  fetchJson: h.fetchJson,
  fetchPage: h.fetchPage,
}));

import {
  findQuestions,
  formQuestions,
  greenhouseQuestions,
  greenhouseRef,
  leverApplyUrl,
  leverQuestions,
} from "./questions";
import { FetchError } from "./safe-fetch";

beforeEach(() => {
  h.fetchJson.mockReset();
  h.fetchPage.mockReset();
});

describe("greenhouseRef", () => {
  it("reads the board and job from a hosted URL", () => {
    expect(greenhouseRef({ html: "", finalUrl: "https://boards.greenhouse.io/acme/jobs/12345?gh_src=x" })).toEqual({
      api: "https://boards-api.greenhouse.io",
      token: "acme",
      jobId: "12345",
    });
    expect(greenhouseRef({ html: "", finalUrl: "https://job-boards.greenhouse.io/acme/jobs/9" })?.token).toBe("acme");
    expect(greenhouseRef({ html: "", finalUrl: "https://job-boards.eu.greenhouse.io/acme/jobs/9" })?.api).toBe(
      "https://boards-api.eu.greenhouse.io",
    );
  });

  it("reads an embedded board on a company page", () => {
    const html = `<script src="https://boards.greenhouse.io/embed/job_board/js?for=acme-co"></script>`;
    expect(greenhouseRef({ html, finalUrl: "https://acme.com/careers?gh_jid=777" })).toEqual({
      api: "https://boards-api.greenhouse.io",
      token: "acme-co",
      jobId: "777",
    });
  });

  it("needs both a board and a numeric job id", () => {
    expect(greenhouseRef({ html: "", finalUrl: "https://acme.com/careers?gh_jid=777" })).toBeNull();
    expect(greenhouseRef({ html: "for=acme", finalUrl: "https://acme.com/careers" })).toBeNull();
    expect(greenhouseRef({ html: "", finalUrl: "https://boards.greenhouse.io/acme" })).toBeNull();
    expect(greenhouseRef({ html: "", finalUrl: "https://boards.greenhouse.io/acme/jobs/abc" })).toBeNull();
    expect(greenhouseRef({ html: "", finalUrl: "not a url" })).toBeNull();
  });

  it("never lets page content choose the host or inject into the path", () => {
    const html = `<script src="//greenhouse.io/embed/job_board/js?for=a/../../evil"></script>`;
    expect(greenhouseRef({ html, finalUrl: "https://acme.com/?gh_jid=1" })?.token ?? "ok").not.toContain("/");
    expect(greenhouseRef({ html: "", finalUrl: "https://boards.greenhouse.io/a%2f..%2fb/jobs/1" })).toBeNull();
  });
});

describe("greenhouseQuestions", () => {
  it("keeps real questions and drops contact fields and file uploads", () => {
    const data = {
      questions: [
        { label: "First Name", fields: [{ type: "input_text" }] },
        { label: "Email", fields: [{ type: "input_text" }] },
        { label: "Resume/CV", fields: [{ type: "input_file" }, { type: "textarea" }] },
        { label: "Portfolio samples", fields: [{ type: "input_file" }] },
        { label: "Why have you chosen to apply to Acme?", required: true, fields: [{ type: "textarea" }] },
        { label: "Are you legally authorized to work here?\n", fields: [{ type: "multi_value_single_select" }] },
        { label: "Gender", fields: [{ type: "multi_value_single_select" }] },
      ],
    };
    expect(greenhouseQuestions(data)).toEqual([
      "Why have you chosen to apply to Acme?",
      "Are you legally authorized to work here?",
    ]);
  });

  it("tolerates unexpected shapes", () => {
    expect(greenhouseQuestions(null)).toEqual([]);
    expect(greenhouseQuestions({})).toEqual([]);
    expect(greenhouseQuestions({ questions: "x" })).toEqual([]);
    expect(greenhouseQuestions({ questions: [null, 3, { label: 5 }, {}] })).toEqual([]);
  });
});

const ID = "ad208490-4052-4f91-a57e-433f2d1e484b";

describe("Lever", () => {
  it("finds the apply page for a posting", () => {
    expect(leverApplyUrl(`https://jobs.lever.co/acme/${ID}`)).toBe(`https://jobs.lever.co/acme/${ID}/apply`);
    expect(leverApplyUrl(`https://jobs.lever.co/acme/${ID}/apply`)).toBe(`https://jobs.lever.co/acme/${ID}/apply`);
    expect(leverApplyUrl(`https://jobs.eu.lever.co/acme/${ID}/`)).toBe(`https://jobs.eu.lever.co/acme/${ID}/apply`);
    expect(leverApplyUrl("https://jobs.lever.co/acme")).toBeNull();
    expect(leverApplyUrl(`https://evil.test/acme/${ID}`)).toBeNull();
    expect(leverApplyUrl(`https://jobs.lever.co.evil.test/acme/${ID}`)).toBeNull();
  });

  it("reads only the custom questions", () => {
    const html = `<ul>
      <li class="application-question"><label><div class="application-label">Full name<span class="required">✱</span></div></label></li>
      <li class="application-question custom-question"><label><div class="application-label">Are you eligible to work in the United States?<span class="required">✱</span></div>
        <select><option>Yes</option><option>No</option></select></label></li>
      <li class="application-question custom-question"><label><div class="application-label">What excites you about this role?</div></label><textarea></textarea></li>
      <li class="application-question"><label><div class="application-label">What is your age range?</div></label></li>
    </ul>`;
    expect(leverQuestions(html)).toEqual([
      "Are you eligible to work in the United States?",
      "What excites you about this role?",
    ]);
  });
});

describe("formQuestions", () => {
  const application = (inner: string) =>
    `<form action="/apply"><input type="file" name="resume">${inner}<button>Submit application</button></form>`;

  it("reads labelled textareas, selects, text inputs and choice groups", () => {
    const html = application(`
      <label for="a">Why do you want to join us?</label><textarea id="a"></textarea>
      <label>How did you hear about this job? <select><option>Friend</option><option>Ad</option></select></label>
      <input aria-label="Expected salary in USD" type="text">
      <fieldset><legend>Do you require visa sponsorship?</legend>
        <label><input type="radio" name="v">Yes</label><label><input type="radio" name="v">No</label></fieldset>
      <label for="e">Email</label><input id="e" type="email">
      <label for="n">Name</label><input id="n" type="text">`);
    expect(formQuestions(html)).toEqual([
      "Why do you want to join us?",
      "How did you hear about this job?",
      "Expected salary in USD",
      "Do you require visa sponsorship?",
    ]);
  });

  it("ignores forms that aren't applications", () => {
    const login = `<form><label for="u">Enter your username here</label><input id="u" type="text"><input type="password"><button>Sign in</button></form>`;
    const search = `<form role="search"><label for="q">Search for something</label><input id="q" type="text"><button>Go</button></form>`;
    const newsletter = `<form><label for="m">Join our newsletter for updates</label><input id="m" type="text"><button>Subscribe</button></form>`;
    expect(formQuestions(login + search + newsletter)).toEqual([]);
  });

  it("copes with odd markup", () => {
    expect(formQuestions("")).toEqual([]);
    expect(formQuestions(application(`<textarea aria-labelledby="missing"></textarea><label for="#x[">??</label>`))).toEqual([]);
    expect(formQuestions(application(`<textarea aria-labelledby="a b\" onclick=\""></textarea>`))).toEqual([]);
  });
});

describe("findQuestions", () => {
  const gh = { html: "<html></html>", finalUrl: "https://boards.greenhouse.io/acme/jobs/55" };

  it("asks Greenhouse's public API for a Greenhouse posting", async () => {
    h.fetchJson.mockResolvedValue({ questions: [{ label: "Why Acme?", fields: [{ type: "textarea" }] }] });
    expect(await findQuestions(gh)).toEqual(["Why Acme?"]);
    expect(h.fetchJson).toHaveBeenCalledWith(
      "https://boards-api.greenhouse.io/v1/boards/acme/jobs/55?questions=true",
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(h.fetchPage).not.toHaveBeenCalled();
  });

  it("fetches Lever's apply page, with room for its size", async () => {
    h.fetchPage.mockResolvedValue({
      html: `<li class="application-question custom-question"><div class="application-label">Why Lever?</div></li>`,
      finalUrl: `https://jobs.lever.co/acme/${ID}/apply`,
    });
    const found = await findQuestions({ html: "", finalUrl: `https://jobs.lever.co/acme/${ID}` });
    expect(found).toEqual(["Why Lever?"]);
    expect(h.fetchPage).toHaveBeenCalledWith(
      `https://jobs.lever.co/acme/${ID}/apply`,
      expect.objectContaining({ maxBytes: expect.any(Number) }),
    );
  });

  it("falls back to the page's own form when the API fails or is empty", async () => {
    const html = `<form><textarea aria-label="Tell us about yourself"></textarea></form>`;
    h.fetchJson.mockRejectedValue(new FetchError("http_error", 404));
    expect(await findQuestions({ ...gh, html })).toEqual(["Tell us about yourself"]);
    h.fetchJson.mockResolvedValue({ questions: [] });
    expect(await findQuestions({ ...gh, html })).toEqual(["Tell us about yourself"]);
  });

  it("reads forms on any other page, and never throws", async () => {
    const html = `<form><textarea aria-label="Why this company?"></textarea></form>`;
    expect(await findQuestions({ html, finalUrl: "https://careers.example.com/job/1" })).toEqual([
      "Why this company?",
    ]);
    h.fetchPage.mockRejectedValue(new Error("boom"));
    expect(await findQuestions({ html: "<<<", finalUrl: `https://jobs.lever.co/acme/${ID}` })).toEqual([]);
  });
});
