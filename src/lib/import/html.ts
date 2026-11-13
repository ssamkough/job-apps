import { parse, type HTMLElement } from "node-html-parser";
import { sanitizeFields, type ImportFields } from "./fields";

/** Keeps what a model would be handed within its context window. */
export const MAX_TEXT_CHARS = 12_000;
/** Below this a page has no usable posting text (SPA shell, login wall). */
export const MIN_TEXT_CHARS = 200;

// Parts of a page that are never the posting itself.
// (<form> and <header> stay: some job boards wrap the whole page in them.)
const NOISE = "script, style, noscript, template, svg, iframe, nav, footer, aside";

function collapse(text: string) {
  return text
    .replace(/\r/g, "")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Visible text of an HTML fragment or page, with block structure as newlines. */
export function htmlToText(html: string): string {
  const root = parse(html);
  root.querySelectorAll(NOISE).forEach((n) => n.remove());
  return collapse(root.structuredText);
}

/**
 * Text of the page's main content. Prefers <main>/<article> when present,
 * which drops most site chrome; otherwise the whole body.
 */
export function pageText(html: string, limit = MAX_TEXT_CHARS): string {
  const root = parse(html);
  root.querySelectorAll(NOISE).forEach((n) => n.remove());
  const main = root.querySelector("main") ?? root.querySelector("article") ?? root;
  const text = collapse(main.structuredText);
  return text.length > limit ? text.slice(0, limit) : text;
}

// ---- JSON-LD ---------------------------------------------------------------

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const asArray = <T,>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Every JSON-LD object in the page, with @graph containers flattened. */
function jsonLdNodes(root: HTMLElement): Json[] {
  const nodes: Json[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 4) return;
    if (Array.isArray(value)) return value.forEach((v) => visit(v, depth + 1));
    if (!isObject(value)) return;
    nodes.push(value);
    if (value["@graph"]) visit(value["@graph"], depth + 1);
  };
  for (const script of root.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      visit(JSON.parse(script.text), 0);
    } catch {
      // Sites ship malformed JSON-LD all the time; skip that block.
    }
  }
  return nodes;
}

const isJobPosting = (node: Json) => asArray(node["@type"]).some((t) => str(t).toLowerCase() === "jobposting");

function nameOf(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (isObject(v)) return str(v.name) || str(v.legalName);
  return "";
}

function locationOf(posting: Json): string {
  const places = asArray(posting.jobLocation).map((place) => {
    if (typeof place === "string") return place.trim();
    if (!isObject(place)) return "";
    const address = place.address;
    if (typeof address === "string") return address.trim();
    if (!isObject(address)) return str(place.name);
    const country = isObject(address.addressCountry)
      ? str(address.addressCountry.name)
      : str(address.addressCountry);
    return [str(address.addressLocality), str(address.addressRegion), country]
      .filter(Boolean)
      .join(", ");
  });
  const joined = places.filter(Boolean).slice(0, 2).join(" · ");
  if (joined) return joined;
  // Remote roles often list only where applicants may live.
  return asArray(posting.applicantLocationRequirements).map(nameOf).filter(Boolean).slice(0, 2).join(" · ");
}

const UNIT: Record<string, string> = {
  HOUR: "hr",
  DAY: "day",
  WEEK: "wk",
  MONTH: "mo",
  YEAR: "yr",
};

function salaryOf(posting: Json): string {
  const base = posting.baseSalary;
  if (!isObject(base)) return "";
  const currency = str(base.currency);
  const value = isObject(base.value) ? base.value : base;
  const num = (v: unknown) => {
    const n = typeof v === "number" ? v : Number(str(v).replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const min = num(value.minValue);
  const max = num(value.maxValue);
  const single = num(value.value);
  const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  let amount = "";
  if (min && max && min !== max) amount = `${fmt(min)}–${fmt(max)}`;
  else if (min ?? max ?? single) amount = fmt((min ?? max ?? single)!);
  if (!amount) return "";
  const unit = UNIT[str(value.unitText).toUpperCase()];
  return `${currency ? `${currency} ` : ""}${amount}${unit ? ` / ${unit}` : ""}`;
}

/**
 * Reads a schema.org JobPosting from the page's JSON-LD, which most job
 * boards publish for Google Jobs. Returns null when there isn't one.
 */
export function readJobPosting(html: string, pageUrl?: string): ImportFields | null {
  const root = parse(html);
  const posting = jsonLdNodes(root).find(isJobPosting);
  if (!posting) return null;

  const remote = str(posting.jobLocationType).toUpperCase() === "TELECOMMUTE";
  const fields = sanitizeFields({
    company: nameOf(posting.hiringOrganization),
    jobTitle: htmlToText(str(posting.title) || str(posting.name)),
    jobUrl: str(posting.url) || pageUrl,
    location: locationOf(posting),
    workType: remote ? "REMOTE" : undefined,
    salary: salaryOf(posting),
    jobDescription: htmlToText(str(posting.description)),
  });
  // The posting's own URL can point somewhere unrelated; the page we read is
  // the better link to keep.
  if (pageUrl) fields.jobUrl = sanitizeFields({ jobUrl: pageUrl }).jobUrl ?? fields.jobUrl;
  return fields;
}
