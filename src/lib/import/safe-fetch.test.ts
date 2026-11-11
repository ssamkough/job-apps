import http from "node:http";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FetchError, fetchPage, parsePublicUrl } from "./safe-fetch";

let server: http.Server;
let base: string;
let local: { testLoopbackPort: number };
const hits: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    const url = req.url ?? "";
    if (url === "/ok") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      return res.end("<html><body><h1>Hello é</h1></body></html>");
    }
    if (url === "/gzip") {
      res.setHeader("content-type", "text/html");
      res.setHeader("content-encoding", "gzip");
      return res.end(zlib.gzipSync("<p>zipped</p>"));
    }
    if (url === "/bomb") {
      res.setHeader("content-type", "text/html");
      res.setHeader("content-encoding", "gzip");
      return res.end(zlib.gzipSync("a".repeat(5_000_000)));
    }
    if (url === "/big") {
      res.setHeader("content-type", "text/html");
      res.write("x".repeat(100_000));
      return res.end("x".repeat(100_000));
    }
    if (url === "/json") {
      res.setHeader("content-type", "application/json");
      return res.end("{}");
    }
    if (url === "/404") {
      res.statusCode = 404;
      return res.end("nope");
    }
    if (url === "/r1") {
      res.statusCode = 302;
      res.setHeader("location", "/ok");
      return res.end();
    }
    if (url === "/loop") {
      res.statusCode = 302;
      res.setHeader("location", "/loop");
      return res.end();
    }
    if (url === "/to-metadata") {
      res.statusCode = 302;
      res.setHeader("location", "http://169.254.169.254/latest/meta-data/");
      return res.end();
    }
    if (url === "/slow") return; // never answers
    res.statusCode = 500;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  local = { testLoopbackPort: port };
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof FetchError ? e.code : `other:${e}`;
  }
  return "no error";
};

describe("parsePublicUrl", () => {
  it.each([
    ["ftp://example.com/x", "invalid_url"],
    ["file:///etc/passwd", "invalid_url"],
    ["javascript:alert(1)", "invalid_url"],
    ["not a url", "invalid_url"],
    ["https://user:pw@example.com/", "invalid_url"],
    ["http://example.com:8080/", "blocked"],
    ["https://example.com:22/", "blocked"],
    ["http://localhost/", "blocked"],
    ["http://app.localhost/", "blocked"],
    ["http://metadata.google.internal/", "blocked"],
  ])("rejects %s", (url, expected) => {
    try {
      parsePublicUrl(url);
      expect.unreachable();
    } catch (e) {
      expect((e as FetchError).code).toBe(expected);
    }
  });

  it("accepts ordinary web addresses", () => {
    expect(parsePublicUrl("https://example.com/jobs?id=1").hostname).toBe("example.com");
    expect(parsePublicUrl(" http://example.com:80/x ").port).toBe("");
  });
});

describe("fetchPage address guard", () => {
  it.each([
    "http://127.0.0.1/",
    "http://10.1.2.3/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://2130706433/", // 127.0.0.1 as one integer
    "http://0x7f.0.0.1/",
    "http://127.1/",
  ])("blocks %s", async (url) => {
    expect(await code(fetchPage(url))).toBe("blocked");
  });

  it("blocks names that resolve to loopback", async () => {
    // "localhost" is refused by name; this one only fails at connect time.
    expect(await code(fetchPage("http://127.0.0.1.nip.io/", { timeoutMs: 3000 }))).toMatch(
      /blocked|unreachable|timeout/,
    );
  });

  it("never sends a request to a blocked redirect target", async () => {
    hits.length = 0;
    expect(await code(fetchPage(`${base}/to-metadata`, local))).toBe("blocked");
    expect(hits).toEqual(["/to-metadata"]);
  });

  it("refuses the local server itself when no exemption is given", async () => {
    hits.length = 0;
    expect(await code(fetchPage(`${base}/ok`))).toBe("blocked");
    expect(hits).toEqual([]);
  });
});

describe("fetchPage reading", () => {
  it("returns the HTML and final URL", async () => {
    const page = await fetchPage(`${base}/ok`, local);
    expect(page.html).toContain("Hello é");
    expect(page.finalUrl).toBe(`${base}/ok`);
  });

  it("follows redirects", async () => {
    const page = await fetchPage(`${base}/r1`, local);
    expect(page.finalUrl).toBe(`${base}/ok`);
  });

  it("stops redirect loops", async () => {
    expect(await code(fetchPage(`${base}/loop`, local))).toBe("too_many_redirects");
  });

  it("decompresses gzip", async () => {
    expect((await fetchPage(`${base}/gzip`, local)).html).toBe("<p>zipped</p>");
  });

  it("caps size after decompression (zip bomb)", async () => {
    expect(await code(fetchPage(`${base}/bomb`, local))).toBe("too_large");
  });

  it("caps size of plain bodies", async () => {
    expect(await code(fetchPage(`${base}/big`, { ...local, maxBytes: 50_000 }))).toBe("too_large");
  });

  it("rejects non-HTML", async () => {
    expect(await code(fetchPage(`${base}/json`, local))).toBe("not_html");
  });

  it("reports HTTP errors", async () => {
    try {
      await fetchPage(`${base}/404`, local);
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ code: "http_error", status: 404 });
    }
  });

  it("times out on a server that never answers", async () => {
    expect(await code(fetchPage(`${base}/slow`, { ...local, timeoutMs: 300 }))).toBe("timeout");
  });

  it("reports an unreachable host", async () => {
    // Any other loopback port stays blocked even with the exemption.
    expect(await code(fetchPage("http://127.0.0.1:1/", local))).toBe("blocked");
  });
});
