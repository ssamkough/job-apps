import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AiBusyError,
  AiTimeoutError,
  AiUnavailableError,
  buildAnswerPrompt,
  buildPrompt,
  generateAnswerDraft,
  generateCoverLetter,
  stripThinking,
  type AnswerDraftInput,
  type CoverLetterInput,
} from "@/lib/ai";
import { AiBudgetError, spendMonth } from "@/lib/ai-budget";
import { db } from "@/lib/db";
import { resetDb } from "@/test/db";

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

const ok = (content: string, usage?: { prompt_eval_count: number; eval_count: number }) =>
  new Response(
    JSON.stringify({ message: { role: "assistant", content }, ...usage }),
    { status: 200 },
  );

function stubBudget() {
  vi.stubEnv("OLLAMA_INPUT_USD_PER_MILLION", "0.14");
  vi.stubEnv("OLLAMA_OUTPUT_USD_PER_MILLION", "0.40");
  vi.stubEnv("AI_MONTHLY_BUDGET_USD", "20");
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("OLLAMA_BASE_URL", "http://ollama.test:11434/");
  vi.stubEnv("OLLAMA_MODEL", "test-model");
  vi.stubEnv("OLLAMA_MAX_CONCURRENCY", "1");
  vi.stubEnv("OLLAMA_MAX_QUEUE", "1");
  stubBudget();
  await resetDb();
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

  it("records measured tokens and clears the reservation", async () => {
    fetchMock.mockResolvedValueOnce(ok("Dear Team,", { prompt_eval_count: 1000, eval_count: 200 }));
    expect(await generateCoverLetter(input)).toBe("Dear Team,");
    const row = await db.aiSpend.findUniqueOrThrow({ where: { month: spendMonth() } });
    // 1000 * $0.14 + 200 * $0.40 per million tokens = 220 micro-dollars.
    expect(row.spentMicros).toBe(BigInt(220));
    expect(row.reservedMicros).toBe(BigInt(0));
  });

  it("does not call Ollama when the month is already at the cap", async () => {
    await db.aiSpend.create({
      data: { month: spendMonth(), spentMicros: BigInt(20_000_000), reservedMicros: BigInt(0) },
    });
    await expect(generateCoverLetter(input)).rejects.toBeInstanceOf(AiBudgetError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("releases the reservation when the call fails", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("down"));
    await expect(generateCoverLetter(input)).rejects.toBeInstanceOf(AiUnavailableError);
    const row = await db.aiSpend.findUniqueOrThrow({ where: { month: spendMonth() } });
    expect(row.spentMicros).toBe(BigInt(0));
    expect(row.reservedMicros).toBe(BigInt(0));
  });

  it("does not call Ollama when the token prices are missing", async () => {
    vi.stubEnv("OLLAMA_INPUT_USD_PER_MILLION", "");
    await expect(generateCoverLetter(input)).rejects.toBeInstanceOf(AiBudgetError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await db.aiSpend.count()).toBe(0);
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

const answerInput: AnswerDraftInput = {
  question: "Why do you want to work here?",
  applicantName: "Jane Developer",
  company: "Acme Robotics",
  jobTitle: "Senior Engineer",
  jobDescription: "Go and Postgres",
  resumeText: "Built payment systems in Go.",
};

describe("generateAnswerDraft", () => {
  it("asks for a short first-person answer and only facts from the resume and job", async () => {
    fetchMock.mockResolvedValueOnce(ok("I built payment systems."));
    const draft = await generateAnswerDraft(answerInput);
    expect(draft).toBe("I built payment systems.");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe("test-model");
    expect(body.think).toBe(false);
    expect(body.stream).toBe(false);
    expect(body.options.num_predict).toBe(500);
    const system = body.messages[0].content as string;
    const user = body.messages[1].content as string;
    expect(system).toMatch(/first person/i);
    expect(system).toMatch(/never invent employers, degrees, metrics/i);
    expect(system).toMatch(/only facts from the resume text and the job description/i);
    expect(user).toContain("Why do you want to work here?");
    expect(user).toContain("Acme Robotics");
    expect(user).toContain("Built payment systems in Go.");
    expect(user).toContain("<job_description>\nGo and Postgres\n</job_description>");
    expect(user).toMatch(/do not invent employers, degrees, or metrics/i);
  });

  it("drafts from the question alone when there is no job and no resume", () => {
    const prompt = buildAnswerPrompt({
      ...answerInput,
      company: null,
      jobTitle: null,
      jobDescription: null,
      resumeText: null,
    });
    expect(prompt).toContain("<question>\nWhy do you want to work here?\n</question>");
    expect(prompt).toContain("Job: (not provided)");
    expect(prompt).toContain("Resume: (not available)");
    expect(prompt).not.toContain("Acme Robotics");
  });

  it("maps a timeout and an empty response the same way as cover letters", async () => {
    const err = new Error("timed out");
    err.name = "TimeoutError";
    fetchMock.mockRejectedValueOnce(err);
    await expect(generateAnswerDraft(answerInput)).rejects.toBeInstanceOf(AiTimeoutError);

    fetchMock.mockResolvedValueOnce(ok("   "));
    await expect(generateAnswerDraft(answerInput)).rejects.toThrow(/empty/i);
  });
});
