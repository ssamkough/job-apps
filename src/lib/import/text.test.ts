import { describe, expect, it } from "vitest";
import { truncateAtBoundary } from "./text";

describe("truncateAtBoundary", () => {
  it("returns short text untouched", () => {
    expect(truncateAtBoundary("Short text.", 100)).toBe("Short text.");
    expect(truncateAtBoundary("abcde", 5)).toBe("abcde");
  });

  it("prefers the end of a paragraph", () => {
    const text = "First paragraph here.\nSecond paragraph here.\nThird paragraph is cut off somewhere";
    expect(truncateAtBoundary(text, 60)).toBe("First paragraph here.\nSecond paragraph here.");
  });

  it("keeps a paragraph that ends exactly at the limit", () => {
    expect(truncateAtBoundary("One two three\nfour five six", 13)).toBe("One two three");
  });

  it("falls back to a sentence when no paragraph break is in the second half", () => {
    const text = "Short.\nWe build things. We ship them quickly. And then we keep going until";
    expect(truncateAtBoundary(text, 55)).toBe("Short.\nWe build things. We ship them quickly.");
  });

  it("does not split a closing quote or bracket from its sentence", () => {
    const text = 'He said "we ship fast." Then everyone cheered loudly for the whole team';
    expect(truncateAtBoundary(text, 35)).toBe('He said "we ship fast."');
  });

  it("falls back to a word, never cutting mid-word", () => {
    const text = "alpha beta gamma delta epsilon zeta";
    expect(truncateAtBoundary(text, 13)).toBe("alpha beta");
    expect(truncateAtBoundary(text, 16)).toBe("alpha beta gamma");
  });

  it("ignores a paragraph boundary that would throw away most of the text", () => {
    const text = `Hi\n${"word ".repeat(40)}`;
    const cut = truncateAtBoundary(text, 100);
    expect(cut.length).toBeGreaterThan(50);
    expect(cut.endsWith("word")).toBe(true);
  });

  it("hard-cuts only a single word longer than the limit", () => {
    expect(truncateAtBoundary("x".repeat(500), 100)).toBe("x".repeat(100));
  });

  it("never exceeds the limit", () => {
    const text = "Lorem ipsum dolor sit amet. ".repeat(200) + "\n" + "consectetur ".repeat(100);
    for (const limit of [1, 7, 50, 333, 1000, 5000]) {
      expect(truncateAtBoundary(text, limit).length).toBeLessThanOrEqual(limit);
    }
  });
});
