import { parse } from "node-html-parser";
import { sanitizeFields, type ImportFields } from "./fields";

/**
 * Company and job title from the page's own metadata, for pages that have no
 * JSON-LD and no board API. Lowest-confidence source: callers should let any
 * structured data win.
 *
 * Titles are usually "Role at Company", "Role | Company" or "Company - Role",
 * so the site name and the link itself are used to tell the two apart.
 */

/** Names of the job boards themselves: a site name like this is not the employer. */
const BOARD_NAMES = new Set([
    "greenhouse",
    "lever",
    "ashby",
    "ashbyhq",
    "workable",
    "smartrecruiters",
    "workday",
    "jobvite",
    "icims",
    "breezy",
    "breezyhr",
    "bamboohr",
    "recruitee",
    "teamtailor",
    "rippling",
    "indeed",
    "linkedin",
    "glassdoor",
    "ziprecruiter",
  ]);

/** Parts of a page title that say what the page is, not what the role is. */
const GENERIC_PART =
  /^(careers?|jobs?|job (details?|description|posting|opening)s?|current openings|open positions|apply( now| today)?|join us|home|employment|work with us|job search)$/i;
/** Titles of error and bot-check pages. */
const ERROR_TITLE =
  /^(just a moment|access denied|attention required|403|404|page not found|not found|error|sign in|log ?in|redirecting)/i;
/** "Acme Careers", "Acme Jobs": the company with the page type attached. */
const CAREERS_SUFFIX = /^(.+?)\s+(?:careers?|jobs)$/i;
/** "Careers at Acme", "Jobs at Acme": the company with the page type in front. */
const CAREERS_PREFIX = /^(?:careers?|jobs?|work|working|join)\s+(?:at|with|@)\s+(\S.*)$/i;
const SEPARATOR = /\s+[|–—·•-]\s+/;
const ROLE_AT_COMPANY = /^(.*\S)\s+at\s+(\S.*)$/i;

/** Strips the "Careers at" / "Careers" dressing off a company name. */
function cleanCompany(name: string): string {
  const n = name.trim();
  return CAREERS_PREFIX.exec(n)?.[1] ?? CAREERS_SUFFIX.exec(n)?.[1] ?? n;
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Two names that differ only in spacing, case or punctuation (or one inside the other). */
function sameName(a: string, b: string) {
  const x = squash(a);
  const y = squash(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 4 && long.includes(short);
}

function isBoardName(name: string) {
  return BOARD_NAMES.has(squash(name));
}

function prettify(slug: string): string | undefined {
  let s: string;
  try {
    s = decodeURIComponent(slug);
  } catch {
    return undefined;
  }
  s = s.replace(/[-_]+/g, " ").trim();
  if (s.length < 2 || /^[\d\s]+$/.test(s)) return undefined;
  // "acme-corp" reads better as "Acme Corp"; "SmartRecruiters" is left alone.
  return /[A-Z]/.test(s) ? s : s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

// Hosts where the first path segment is the employer.
const PATH_BOARDS = new Set([
  "jobs.lever.co",
  "jobs.eu.lever.co",
  "jobs.ashbyhq.com",
  "boards.greenhouse.io",
  "job-boards.greenhouse.io",
  "boards.eu.greenhouse.io",
  "job-boards.eu.greenhouse.io",
  "apply.workable.com",
  "jobs.smartrecruiters.com",
  "jobs.jobvite.com",
  "ats.rippling.com",
]);
// Hosts where the subdomain is the employer.
const SUBDOMAIN_BOARDS = [".breezy.hr", ".bamboohr.com", ".recruitee.com", ".teamtailor.com", ".applytojob.com", ".myworkdayjobs.com"];

/** The employer a job board link names, e.g. `jobs.lever.co/acme-corp/...`. */
export function companyFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const host = u.hostname.toLowerCase();
  if (PATH_BOARDS.has(host)) {
    const first = u.pathname.split("/").filter(Boolean)[0];
    return first ? prettify(first) : undefined;
  }
  const suffix = SUBDOMAIN_BOARDS.find((s) => host.endsWith(s));
  if (suffix) {
    const label = host.slice(0, -suffix.length).split(".").pop();
    return label && label !== "www" ? prettify(label) : undefined;
  }
  return undefined;
}

type Company = { name: string; strong: boolean };

/**
 * Splits a page title into role and (maybe) company. `company` is what is
 * already believed about the employer; `heading` is the page's <h1>, which
 * settles "A - B" when nothing else says which half is the role.
 */
function parseTitle(raw: string, known: Company | undefined, heading: string): { title?: string; company?: string } {
  let company = known;
  const roleParts: string[] = [];

  for (const part of raw.split(SEPARATOR).map((p) => p.trim()).filter(Boolean)) {
    if (GENERIC_PART.test(part)) continue;
    const careers = CAREERS_SUFFIX.exec(part) ?? CAREERS_PREFIX.exec(part);
    if (careers) {
      company ??= { name: careers[1], strong: false };
      continue;
    }
    if (company && sameName(part, company.name)) continue;
    roleParts.push(part);
  }
  if (!roleParts.length) return { company: company?.name };

  let title = roleParts[0];
  if (roleParts.length > 1 && heading) {
    const i = roleParts.findIndex((p) => sameName(p, heading));
    if (i >= 0) {
      title = roleParts[i];
      const other = roleParts.find((_, j) => j !== i);
      if (!company && other) company = { name: other, strong: false };
    }
  }

  const at = ROLE_AT_COMPANY.exec(title);
  if (at) {
    if (!company || !company.strong) {
      title = at[1];
      company = { name: cleanCompany(at[2]), strong: false };
    } else if (sameName(at[2], company.name)) {
      title = at[1];
    }
  }
  // "Job Openings at Meta" is a listing page, not a role.
  if (GENERIC_PART.test(title)) return { company: company?.name };
  return { title, company: company?.name };
}

function metaContent(root: ReturnType<typeof parse>, selector: string) {
  return root.querySelector(selector)?.getAttribute("content")?.trim() ?? "";
}

export function readPageMeta(html: string, pageUrl?: string): ImportFields {
  const root = parse(html);

  const siteName = metaContent(root, 'meta[property="og:site_name"]');
  const strong: Company | undefined =
    siteName && !isBoardName(siteName) ? { name: cleanCompany(siteName), strong: true } : undefined;
  const fromUrl = companyFromUrl(pageUrl);
  const known: Company | undefined = strong ?? (fromUrl ? { name: fromUrl, strong: false } : undefined);

  const heading = root.querySelector("h1")?.text.replace(/\s+/g, " ").trim() ?? "";
  const candidates = [
    metaContent(root, 'meta[property="og:title"]'),
    metaContent(root, 'meta[name="twitter:title"]'),
    root.querySelector("title")?.text.replace(/\s+/g, " ").trim() ?? "",
    heading,
  ].filter((t) => t && !ERROR_TITLE.test(t));

  let title: string | undefined;
  let company: string | undefined;
  for (const raw of candidates) {
    const parsed = parseTitle(raw, known, heading);
    title ??= parsed.title;
    company ??= parsed.company;
    if (title && company) break;
  }
  return sanitizeFields({ jobTitle: title, company: company ?? known?.name });
}
