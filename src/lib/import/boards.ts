import "server-only";
import { parse } from "node-html-parser";
import { sanitizeFields, type ImportFields } from "./fields";
import { htmlToText } from "./html";
import { greenhouseQuestions, greenhouseRef } from "./questions";
import { fetchJson, type FetchedPage } from "./safe-fetch";
import { cleanJobUrl } from "./url";

/**
 * Job boards that publish a public posting API. Asking the API beats reading
 * the page: the fields are exact, the description is clean, and it works even
 * when the page is a JavaScript shell with no structured data.
 *
 * Best effort: every adapter swallows its own failure and the importer falls
 * back to the page itself. Hosts are fixed and ids are validated, so page
 * content can never choose where a request goes.
 */

export type BoardName = "greenhouse" | "smartrecruiters";

export type BoardPosting = {
  board: BoardName;
  fields: ImportFields;
  /** Application questions the API lists (empty when it doesn't). */
  questions: string[];
};

const STEP_TIMEOUT_MS = 5_000;

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Text of HTML that a board entity-escaped (Greenhouse sends `&lt;p&gt;`). */
function escapedHtmlToText(escaped: string): string {
  const html = parse(escaped).text; // decodes the entities back into markup
  return htmlToText(html);
}

// ---- Greenhouse -------------------------------------------------------------

function workTypeFrom(value: string): string | undefined {
  const v = value.toLowerCase().replace(/[^a-z]/g, "");
  if (v.includes("remote")) return "REMOTE";
  if (v.includes("hybrid")) return "HYBRID";
  if (v === "onsite" || v === "inoffice" || v === "inperson") return "ONSITE";
  return undefined;
}

export function greenhousePosting(data: unknown, pageUrl: string): BoardPosting | null {
  if (!isObject(data)) return null;
  const metadata = Array.isArray(data.metadata) ? data.metadata : [];
  const locationType = metadata
    .filter(isObject)
    .find((m) => /location type|work (type|model)/i.test(str(m.name)));
  const fields = sanitizeFields({
    company: str(data.company_name),
    jobTitle: str(data.title),
    location: isObject(data.location) ? str(data.location.name) : "",
    workType: locationType ? workTypeFrom(str(locationType.value)) : undefined,
    jobDescription: typeof data.content === "string" ? escapedHtmlToText(data.content) : "",
    jobUrl: cleanJobUrl(pageUrl),
  });
  if (!fields.jobTitle && !fields.company) return null;
  return { board: "greenhouse", fields, questions: greenhouseQuestions(data) };
}

async function fromGreenhouse(page: FetchedPage): Promise<BoardPosting | null> {
  const ref = greenhouseRef(page);
  if (!ref) return null;
  const data = await fetchJson(`${ref.api}/v1/boards/${ref.token}/jobs/${ref.jobId}?questions=true`, {
    timeoutMs: STEP_TIMEOUT_MS,
  });
  return greenhousePosting(data, page.finalUrl);
}

// ---- SmartRecruiters --------------------------------------------------------

/** `jobs.smartrecruiters.com/{Company}/{id}-{slug}` */
export function smartRecruitersRef(finalUrl: string): { company: string; id: string } | null {
  let url: URL;
  try {
    url = new URL(finalUrl);
  } catch {
    return null;
  }
  if (url.hostname !== "jobs.smartrecruiters.com") return null;
  const m = /^\/([A-Za-z0-9_-]{1,64})\/(\d{6,20})(?:-[^/]*)?\/?$/.exec(url.pathname);
  return m ? { company: m[1], id: m[2] } : null;
}

const SMARTRECRUITERS_SECTIONS = ["jobDescription", "qualifications", "additionalInformation"] as const;

export function smartRecruitersPosting(data: unknown, pageUrl: string): BoardPosting | null {
  if (!isObject(data)) return null;
  const company = isObject(data.company) ? str(data.company.name) : "";
  const loc = isObject(data.location) ? data.location : {};
  const remote = loc.remote === true;
  const hybrid = loc.hybrid === true;
  // "city, region" reads better than fullLocation ("Poland, Remote, Poland").
  const place = [str(loc.city), str(loc.region) === "Remote" ? "" : str(loc.region), str(loc.country).toUpperCase()]
    .filter(Boolean)
    .filter((part, i, all) => all.indexOf(part) === i)
    .join(", ");

  const sections = isObject(data.jobAd) && isObject(data.jobAd.sections) ? data.jobAd.sections : {};
  const description = SMARTRECRUITERS_SECTIONS.map((key) => {
    const section = sections[key];
    if (!isObject(section) || typeof section.text !== "string") return "";
    const body = htmlToText(section.text);
    const title = str(section.title);
    return body ? (title ? `${title}\n${body}` : body) : "";
  })
    .filter(Boolean)
    .join("\n\n");

  const fields = sanitizeFields({
    company,
    jobTitle: str(data.name),
    location: place,
    workType: remote ? "REMOTE" : hybrid ? "HYBRID" : undefined,
    jobDescription: description,
    jobUrl: cleanJobUrl(pageUrl),
  });
  if (!fields.jobTitle && !fields.company) return null;
  return { board: "smartrecruiters", fields, questions: [] };
}

async function fromSmartRecruiters(page: FetchedPage): Promise<BoardPosting | null> {
  const ref = smartRecruitersRef(page.finalUrl);
  if (!ref) return null;
  const data = await fetchJson(
    `https://api.smartrecruiters.com/v1/companies/${ref.company}/postings/${ref.id}`,
    { timeoutMs: STEP_TIMEOUT_MS },
  );
  return smartRecruitersPosting(data, page.finalUrl);
}

// ---- Entry point ------------------------------------------------------------

/** The posting as its board's API describes it, or null. Never throws. */
export async function readBoard(page: FetchedPage): Promise<BoardPosting | null> {
  for (const adapter of [fromGreenhouse, fromSmartRecruiters]) {
    try {
      const posting = await adapter(page);
      if (posting) return posting;
    } catch {
      // Try the next adapter, then the page itself.
    }
  }
  return null;
}
