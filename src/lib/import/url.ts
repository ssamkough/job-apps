/**
 * Cleans a job link before it is stored: removes campaign and referral
 * parameters that say how someone arrived, and keeps everything that says
 * which posting it is. The fragment is always kept (some boards route on it).
 */

/** Always tracking, whatever the value. Compared lowercase, without a trailing `[]`. */
const TRACKING_PARAMS = new Set([
  "gh_src", // Greenhouse
  "lever-source", // Lever
  "lever-origin",
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "twclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "_hsenc",
  "_hsmi",
  "li_fat_id",
  "trk",
  "trkid",
  "ref_src",
  "referrer",
]);

/** Usually "where from" (`?ref=linkedin`), but a number there may be a posting id. */
const REFERRAL_PARAMS = new Set(["ref", "src", "source"]);

const paramName = (pair: string) => {
  const raw = pair.split("=", 1)[0];
  let name = raw;
  try {
    name = decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    // Keep the raw name.
  }
  return name.toLowerCase().replace(/\[\]$/, "");
};

const paramValue = (pair: string) => {
  const i = pair.indexOf("=");
  if (i < 0) return "";
  const raw = pair.slice(i + 1);
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    return raw;
  }
};

/** True when `id` appears in the path as its own number or token (`/jobs/123`, `/123-slug`). */
function pathHasId(pathname: string, id: string) {
  if (!id) return false;
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let path = pathname;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    // Test the raw path.
  }
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}($|[^A-Za-z0-9])`).test(path);
}

function isTracking(pair: string, pathname: string) {
  const name = paramName(pair);
  if (name.startsWith("utm_") || TRACKING_PARAMS.has(name)) return true;
  if (REFERRAL_PARAMS.has(name)) return !/^\d+$/.test(paramValue(pair));
  // Greenhouse's job id is the posting itself on a company's own site
  // (stripe.com/jobs/search?gh_jid=1), and redundant once the path has it.
  if (name === "gh_jid") return pathHasId(pathname, paramValue(pair));
  return false;
}

/**
 * The link without tracking parameters. Anything that isn't an http(s) URL,
 * or has nothing to remove, is returned exactly as given.
 */
export function cleanJobUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return raw;
  if (!url.search) return raw;

  const pairs = url.search.slice(1).split("&").filter(Boolean);
  const kept = pairs.filter((pair) => !isTracking(pair, url.pathname));
  if (kept.length === pairs.length) return raw;

  // Remaining parameters keep their original spelling and order.
  url.search = kept.length ? `?${kept.join("&")}` : "";
  return url.toString();
}
