import "server-only";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { PassThrough, type Readable } from "node:stream";
import zlib from "node:zlib";
import { isBlockedIp } from "./net-guard";

export const FETCH_TIMEOUT_MS = 8_000;
export const FETCH_MAX_BYTES = 2 * 1024 * 1024;
export const FETCH_MAX_REDIRECTS = 3;

export type FetchFailure =
  | "invalid_url" // not a usable http(s) address
  | "blocked" // points at a private or internal network
  | "unreachable" // DNS failure, refused, reset
  | "timeout"
  | "too_large"
  | "too_many_redirects"
  | "http_error" // 4xx / 5xx from the site
  | "not_html"; // not a web page

export class FetchError extends Error {
  constructor(
    public code: FetchFailure,
    public status?: number,
  ) {
    super(`fetch failed: ${code}${status ? ` (${status})` : ""}`);
  }
}

export type FetchedPage = { html: string; finalUrl: string };

type Options = {
  /**
   * Test seam only; production callers never pass it. Exempts exactly
   * http://127.0.0.1:<port>, so tests can use a local server while every
   * other private address, port and redirect target stays blocked.
   */
  testLoopbackPort?: number;
  timeoutMs?: number;
  maxBytes?: number;
};

const isTestLoopback = (url: URL, port?: number) =>
  port !== undefined &&
  url.protocol === "http:" &&
  url.hostname === "127.0.0.1" &&
  url.port === String(port);

/** Validates the shape of a URL before any network traffic. */
export function parsePublicUrl(raw: string, loopbackPort?: number): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new FetchError("invalid_url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new FetchError("invalid_url");
  if (url.username || url.password) throw new FetchError("invalid_url");
  if (isTestLoopback(url, loopbackPort)) return url;
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  if (port !== "80" && port !== "443") throw new FetchError("blocked");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new FetchError("blocked");
  }
  return url;
}

/**
 * DNS lookup used for the actual connection. It resolves, rejects the host if
 * ANY answer is internal, and hands back an address that was just checked, so
 * a name can't resolve to a public IP for the check and an internal one for
 * the connect (DNS rebinding).
 */
function guardedLookup(allowPrivate: boolean): net.LookupFunction {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) return callback(err, "", 4);
      if (!allowPrivate && addresses.some((a) => isBlockedIp(a.address))) {
        return callback(new FetchError("blocked"), "", 4);
      }
      const first = addresses[0];
      if (!first) return callback(new Error("no addresses"), "", 4);
      if (options && typeof options === "object" && options.all) {
        // Node 20+ asks for every address when autoSelectFamily is on.
        return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, addresses);
      }
      callback(null, first.address, first.family);
    });
  };
}

/** One request, no redirect following. Resolves with the response stream. */
function request(url: URL, exempt: boolean, signal: AbortSignal) {
  return new Promise<http.IncomingMessage>((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    // IP literals skip DNS, so they need checking up front.
    if (net.isIP(host) && !exempt && isBlockedIp(host)) {
      return reject(new FetchError("blocked"));
    }
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      url,
      {
        method: "GET",
        lookup: guardedLookup(exempt),
        signal,
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; JobAppsImport/1.0)",
          accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
          "accept-encoding": "gzip, deflate, br",
          "accept-language": "en",
        },
      },
      resolve,
    );
    req.on("error", reject);
    req.end();
  });
}

function decoded(res: http.IncomingMessage): Readable {
  const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase();
  if (encoding === "gzip" || encoding === "x-gzip") return res.pipe(zlib.createGunzip());
  if (encoding === "deflate") return res.pipe(zlib.createInflate());
  if (encoding === "br") return res.pipe(zlib.createBrotliDecompress());
  return res;
}

async function readCapped(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  // Piping through a PassThrough lets decompression errors surface here too.
  const sink = stream.pipe(new PassThrough());
  stream.on("error", (e) => sink.destroy(e));
  for await (const chunk of sink) {
    size += (chunk as Buffer).length;
    // Counted after decompression, so a zip bomb hits the cap too.
    if (size > maxBytes) {
      stream.destroy();
      sink.destroy();
      throw new FetchError("too_large");
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function toFetchError(e: unknown): FetchError {
  if (e instanceof FetchError) return e;
  // `lookup` errors arrive wrapped by the socket layer.
  const cause = (e as { cause?: unknown })?.cause;
  if (cause instanceof FetchError) return cause;
  const name = (e as { name?: string })?.name;
  if (name === "AbortError" || name === "TimeoutError") return new FetchError("timeout");
  return new FetchError("unreachable");
}

/**
 * Fetches a public web page for import. Guards: http(s) on 80/443 only; every
 * connection goes only to public addresses (checked at connect time, redirects
 * included); at most 3 redirects, each re-validated; 8 s overall; 2 MB after
 * decompression; HTML content types only.
 */
export async function fetchPage(rawUrl: string, options: Options = {}): Promise<FetchedPage> {
  const loopbackPort = options.testLoopbackPort;
  const maxBytes = options.maxBytes ?? FETCH_MAX_BYTES;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? FETCH_TIMEOUT_MS);

  try {
    let url = parsePublicUrl(rawUrl, loopbackPort);
    for (let hop = 0; hop <= FETCH_MAX_REDIRECTS; hop++) {
      const res = await request(url, isTestLoopback(url, loopbackPort), timeout);
      const status = res.statusCode ?? 0;

      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (hop === FETCH_MAX_REDIRECTS) throw new FetchError("too_many_redirects");
        let next: URL;
        try {
          next = new URL(res.headers.location, url);
        } catch {
          throw new FetchError("invalid_url");
        }
        // Re-run the same checks the first URL got.
        url = parsePublicUrl(next.toString(), loopbackPort);
        continue;
      }

      if (status < 200 || status >= 300) {
        res.resume();
        throw new FetchError("http_error", status);
      }

      const type = String(res.headers["content-type"] ?? "").toLowerCase();
      if (!/\b(text\/html|application\/xhtml\+xml)\b/.test(type)) {
        res.resume();
        throw new FetchError("not_html");
      }
      const declared = Number(res.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maxBytes) {
        res.resume();
        throw new FetchError("too_large");
      }

      const body = await readCapped(decoded(res), maxBytes);
      const charset = /charset=([\w-]+)/.exec(type)?.[1] ?? "utf-8";
      let html: string;
      try {
        html = new TextDecoder(charset).decode(body);
      } catch {
        html = new TextDecoder("utf-8").decode(body);
      }
      return { html, finalUrl: url.toString() };
    }
    throw new FetchError("too_many_redirects");
  } catch (e) {
    throw toFetchError(e);
  }
}
