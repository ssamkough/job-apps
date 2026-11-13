import type { HTMLElement } from "node-html-parser";

/**
 * Site chrome that is not part of a posting: cookie banners, "Apply" buttons,
 * share links, footer link lists. Everything here is deliberately narrow, an
 * exact-looking short line or a small element, so real posting text is never
 * dropped. Missing a piece of chrome costs a stray line; dropping content
 * costs the user's description.
 */

// ---- Elements --------------------------------------------------------------

const CONSENT_ATTR = /(^|[^a-z])(cookie|cookies|cookiebanner|consent|gdpr|onetrust|cc-window)([^a-z]|$)/i;
/** What a banner says. A wrapper that only has the word in a class doesn't. */
const CONSENT_TEXT = /cookie|consent|gdpr|tracking|privacy/i;
/** A banner is a few lines; anything bigger is a page wrapper that merely has the word in a class. */
const CONSENT_MAX_CHARS = 1_500;

/** Cookie and consent banners, by id, class or aria-label. */
export function removeConsentBanners(root: HTMLElement) {
  const total = root.text.length;
  for (const el of root.querySelectorAll("[id], [class], [aria-label]")) {
    const tag = el.tagName?.toLowerCase();
    if (!tag || tag === "html" || tag === "body" || tag === "main" || tag === "article") continue;
    const marker = `${el.getAttribute("id") ?? ""} ${el.getAttribute("class") ?? ""} ${el.getAttribute("aria-label") ?? ""}`;
    if (!CONSENT_ATTR.test(marker)) continue;
    // Never remove something that holds the posting.
    if (el.querySelector("main, article, [role=main]")) continue;
    const text = el.text;
    if (text.length > CONSENT_MAX_CHARS || text.length > total * 0.6 || !CONSENT_TEXT.test(text)) continue;
    el.remove();
  }
}

// ---- Lines -----------------------------------------------------------------

/** Whole lines that are only a button or link, never a sentence of the posting. */
const BOILERPLATE_LINE = [
  /^apply( (now|today|here|online))?( (for|to) (this|the) (job|role|position|opening|posting))?( now)?[\s»›→>!.]*$/i,
  /^apply (with|using|via) \S+( \S+)?$/i,
  /^(submit|start|continue) (your |an |the )?application[\s»›→>!.]*$/i,
  /^(save|bookmark)( this)?( job| posting| position| role)?$/i,
  /^share( this)?( job| posting| position| role| opening)?( (on|via|with|to) .{1,30})?$/i,
  /^(copy|get) (the |job |this )?(job )?link$/i,
  /^(tweet|share on (facebook|linkedin|twitter|x|email)|email (this )?job|print( this)?( job| page)?)$/i,
  /^back to (all )?(jobs|openings|positions|listings|search results|job search|careers|job board)[\s»‹←<.]*$/i,
  /^[←‹«<]\s*(back|all jobs|view all jobs)$/i,
  /^skip to (main )?(content|navigation|main)\b.{0,30}$/i,
  /^(\S+ ){0,3}powered by( \S+){0,2}$/i,
  /^(©|copyright\b).{0,120}$/i,
  /^.{0,80}all rights reserved\.?$/i,
];

/** Cookie notices and their buttons. Sentences must name the site or "we" using cookies. */
const COOKIE_LINE = [
  /\b(we|this (web)?site|our (web)?sites?|[a-z0-9-]+\.[a-z]{2,}) uses? cookies\b/i,
  /\bagree to (the )?(storing|use) of cookies\b/i,
  /^by (clicking|continuing|using|browsing)\b.{0,160}\bcookies\b/i,
  /^(accept|reject|decline|allow|manage|customi[sz]e)( all| necessary| essential| optional| only necessary)?( cookies| preferences| settings| choices)?[\s.]*$/i,
  /^cookies? (settings|preferences|policy|notice|consent|choices)\b.{0,40}$/i,
  /^your privacy choices$/i,
];
const COOKIE_MAX_CHARS = 300;

// A footer or menu: runs of short lines made of these.
const NAV_WORD =
  /^(home|jobs?|careers?|career opportunities|about|about us|contact|contact us|privacy|privacy policy|privacy notice|candidate privacy|terms|terms of (use|service)|terms (&|and) conditions|sitemap|faq|faqs|help|help cent(er|re)|support|log ?in|sign ?in|sign ?up|register|search jobs|job search|all jobs|open (positions|roles)|blog|press|newsroom|investors|accessibility|cookie(s)? (policy|settings|preferences)|your privacy choices|life at .{1,30}|english|français|francais|deutsch|español|espanol|italiano|português|nederlands|日本語|中文)\W*$/i;
const NAV_ITEM_MAX_WORDS = 6;
const NAV_ITEM_MAX_CHARS = 48;
const NAV_RUN_MIN = 3;

const wordCount = (line: string) => line.split(/\s+/).filter(Boolean).length;

const isNavItem = (line: string) =>
  line.length > 0 &&
  line.length <= NAV_ITEM_MAX_CHARS &&
  wordCount(line) <= NAV_ITEM_MAX_WORDS &&
  !/[.!?:;,]$/.test(line);

function isChromeLine(line: string): boolean {
  if (BOILERPLATE_LINE.some((re) => re.test(line))) return true;
  return line.length <= COOKIE_MAX_CHARS && COOKIE_LINE.some((re) => re.test(line));
}

/**
 * Drops chrome lines from page text. Lines are the block structure
 * `structuredText` produces. A run of three or more short lines is removed
 * only when at least half of it is made of well-known menu and footer words,
 * so a list of skills or benefits survives.
 */
export function dropChromeLines(text: string): string {
  const lines = text.split("\n").map((l) => l.trim());
  const drop = new Array<boolean>(lines.length).fill(false);

  lines.forEach((line, i) => {
    if (line && isChromeLine(line)) drop[i] = true;
  });

  // Lines already dropped as chrome are transparent: they neither break a run
  // nor count towards it. Only the stretch from the first to the last menu
  // word is removed, so a real list that sits right above a footer survives.
  for (let start = 0; start < lines.length; ) {
    if (drop[start] || !isNavItem(lines[start])) {
      start++;
      continue;
    }
    let end = start;
    while (end < lines.length && (drop[end] || isNavItem(lines[end]))) end++;
    const run: number[] = [];
    for (let i = start; i < end; i++) if (!drop[i]) run.push(i);
    const navAt = run.filter((i) => NAV_WORD.test(lines[i]));
    if (navAt.length) {
      const span = run.slice(run.indexOf(navAt[0]), run.indexOf(navAt[navAt.length - 1]) + 1);
      if (span.length >= NAV_RUN_MIN && navAt.length >= Math.max(2, Math.ceil(span.length / 2))) {
        for (let i = span[0]; i <= span[span.length - 1]; i++) drop[i] = true;
      }
    }
    start = end;
  }

  return lines
    .filter((_, i) => !drop[i])
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
