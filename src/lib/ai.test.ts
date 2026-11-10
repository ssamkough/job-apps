import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AiBusyError,
  AiTimeoutError,
  AiUnavailableError,
  buildPrompt,
  generateCoverLetter,
  stripThinking,
  type CoverLetterInput,
} from "@/lib/ai";

const input: CoverLetterInput = {
  applicantName: "Jane Developer",
  company: "Acme Robotics",
  jobTitle: "Senior Engineer",
  jobDescription: "Go and Postgres",
  contactName: null,
  instructions: null,
  existingDraft: null,
  resumeText: "Built payment systems in Go.",
};

const ok = (content: string) =>
  new Response(JSON.stringify({ message: { role: "assistant", content } }), { status: 200 });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("OLLAMA_BASE_URL", "http://ollama.test:11434/");
  vi.stubEnv("OLLAMA_MODEL", "test-model");
  vi.stubEnv("OLLAMA_MAX_CONCURRENCY", "1");
  vi.stubEnv("OLLAMA_MAX_QUEUE", "1");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("generateCoverLetter", () => {
  it("calls Ollama chat with thinking off and returns the text", async () => {
    fetchMock.mockResolvedValueOnce(ok("  Dear Hiring Team,\n\nHi.  "));
    const letter = await generateCoverLetter(input);
    expect(letter).toBe("Dear Hiring Team,\n\nHi.");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://ollama.test:11434/api/chat"); // trailing slash trimmed
    const body = JSON.parse(init.body);
    expect(body.model).toBe("test-model");
    expect(body.think).toBe(false);
    expect(body.stream).toBe(false);
    expect(body.options.num_ctx).toBe(8192);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].content).toContain("Acme Robotics");
    expect(body.messages[1].content).toContain("Built payment systems in Go.");
  });

  it("sends bearer and extra headers when configured", async () => {
    vi.stubEnv("OLLAMA_API_KEY", "secret");
    vi.stubEnv("OLLAMA_EXTRA_HEADERS", JSON.stringify({ "CF-Access-Client-Id": "abc" }));
    fetchMock.mockResolvedValueOnce(ok("letter"));
    await generateCoverLetter(input);
    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe("Bearer secret");
    expect(headers["CF-Access-Client-Id"]).toBe("abc");
  });

  it("strips <think> reasoning if the model emits it anyway", async () => {
    fetchMock.mockResolvedValueOnce(ok("<think>plan the letter</think>\nDear Team,"));
    expect(await generateCoverLetter(input)).toBe("Dear Team,");
  });

  it("maps a connection failure to AiUnavailableError", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(generateCoverLetter(input)).rejects.toBeInstanceOf(AiUnavailableError);
  });

  it("maps a missing model (404) to a helpful message", async () => {
    fetchMock.mockResolvedValueOnce(new Response("model not found", { status: 404 }));
    await expect(generateCoverLetter(input)).rejects.toThrow(/test-model.*not installed/);
  });

  it("maps a timeout to AiTimeoutError", async () => {
    const err = new Error("timed out");
    err.name = "TimeoutError";
    fetchMock.mockRejectedValueOnce(err);
    await expect(generateCoverLetter(input)).rejects.toBeInstanceOf(AiTimeoutError);
  });

  it("errors on an empty response", async () => {
    fetchMock.mockResolvedValueOnce(ok("   "));
    await expect(generateCoverLetter(input)).rejects.toThrow(/empty/i);
  });

  it("runs one at a time, queues one, and turns the rest away", async () => {
    const releases: Array<(r: Response) => void> = [];
    fetchMock.mockImplementation(
      () => new Promise<Response>((resolve) => releases.push(resolve)),
    );

    const first = generateCoverLetter(input); // running
    const second = generateCoverLetter(input); // queued
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // queue (size 1) is full -> third is rejected immediately
    await expect(generateCoverLetter(input)).rejects.toBeInstanceOf(AiBusyError);

    // finishing the first lets the queued one start
    releases[0](ok("one"));
    expect(await first).toBe("one");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    releases[1](ok("two"));
    expect(await second).toBe("two");

    // and the slot is free again afterwards
    fetchMock.mockImplementation(async () => ok("three"));
    expect(await generateCoverLetter(input)).toBe("three");
  });

  it("frees the slot when a request fails", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("down"));
    await expect(generateCoverLetter(input)).rejects.toBeInstanceOf(AiUnavailableError);
    fetchMock.mockResolvedValueOnce(ok("recovered"));
    expect(await generateCoverLetter(input)).toBe("recovered");
  });
});

describe("prompt building", () => {
  it("wraps untrusted text in tags and notes missing pieces", () => {
    const prompt = buildPrompt({ ...input, resumeText: null, jobDescription: null, instructions: "Keep it short", existingDraft: "old" });
    expect(prompt).toContain("Resume: (not available)");
    expect(prompt).toContain("Job description: (not provided)");
    expect(prompt).toContain("<instructions>\nKeep it short\n</instructions>");
    expect(prompt).toContain("<draft>\nold\n</draft>");
  });

  it("stripThinking leaves normal text alone", () => {
    expect(stripThinking("Dear Team,\n\nHello")).toBe("Dear Team,\n\nHello");
  });
});
