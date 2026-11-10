import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { clear, emailKey, hit, ipFromHeaders, peek, prune } from "@/lib/rate-limit";
import { resetDb } from "@/test/db";

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const rule = { limit: 3, windowSec: 60 };

beforeEach(resetDb);
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("hit", () => {
  it("allows up to the limit then blocks", async () => {
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await hit("k", rule));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false, false]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0, 0]);
    expect(results[4].retryAfterSec).toBeGreaterThan(0);
    expect(results[4].retryAfterSec).toBeLessThanOrEqual(60);
  });

  it("keeps separate counters per key", async () => {
    for (let i = 0; i < 3; i++) await hit("a", rule);
    expect((await hit("a", rule)).allowed).toBe(false);
    expect((await hit("b", rule)).allowed).toBe(true);
  });

  it("starts a fresh count in the next window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:10Z"));
    for (let i = 0; i < 4; i++) await hit("k", rule);
    expect((await hit("k", rule)).allowed).toBe(false);

    vi.setSystemTime(new Date("2026-01-01T00:01:05Z")); // next 60s window
    expect((await hit("k", rule)).allowed).toBe(true);
  });

  it("is atomic under concurrency: never admits more than the limit", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => hit("race", rule)));
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
    const row = await db.rateLimit.findFirst({ where: { key: "race" } });
    expect(row?.count).toBe(20);
  });
});

describe("peek / clear / prune", () => {
  it("peek reads without counting", async () => {
    expect((await peek("k", rule)).remaining).toBe(3);
    await hit("k", rule);
    await hit("k", rule);
    expect((await peek("k", rule)).remaining).toBe(1);
    expect((await peek("k", rule)).remaining).toBe(1); // unchanged
  });

  it("peek reports blocked once the limit is reached", async () => {
    for (let i = 0; i < 3; i++) await hit("k", rule);
    expect((await peek("k", rule)).allowed).toBe(false);
  });

  it("clear resets a key", async () => {
    for (let i = 0; i < 3; i++) await hit("k", rule);
    await clear("k");
    expect((await peek("k", rule)).allowed).toBe(true);
  });

  it("prune removes old windows but keeps recent ones", async () => {
    await db.rateLimit.create({ data: { key: "old", windowStart: new Date(Date.now() - 5 * 86_400_000), count: 1 } });
    await hit("recent", rule);
    await prune();
    expect(await db.rateLimit.count({ where: { key: "old" } })).toBe(0);
    expect(await db.rateLimit.count({ where: { key: "recent" } })).toBe(1);
  });
});

describe("helpers", () => {
  it("emailKey is case/space-insensitive and doesn't contain the address", () => {
    expect(emailKey(" A@Example.com ")).toBe(emailKey("a@example.com"));
    expect(emailKey("a@example.com")).not.toContain("example");
  });

  it("ipFromHeaders uses the first entry of the configured header", () => {
    const h = new Headers({ "x-forwarded-for": "1.2.3.4, 10.0.0.1", "cf-connecting-ip": "9.9.9.9" });
    expect(ipFromHeaders(h)).toBe("1.2.3.4");
    vi.stubEnv("CLIENT_IP_HEADER", "CF-Connecting-IP");
    expect(ipFromHeaders(h)).toBe("9.9.9.9");
    expect(ipFromHeaders(new Headers())).toBe("unknown");
  });
});
