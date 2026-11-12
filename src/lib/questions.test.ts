import { describe, expect, it } from "vitest";
import {
  MAX_IMPORTED_QUESTIONS,
  MAX_QUESTIONS_PER_APPLICATION,
  cleanQuestionText,
  isStandardField,
  parseAttachments,
  questionKey,
  sanitizeQuestionList,
} from "./questions";

describe("cleanQuestionText", () => {
  it("collapses whitespace and strips required markers", () => {
    expect(cleanQuestionText("  Why do   you\n want this?  ✱ ")).toBe("Why do you want this?");
    expect(cleanQuestionText("Why us? *")).toBe("Why us?");
    expect(cleanQuestionText("Why us? (required)")).toBe("Why us?");
  });
});

describe("questionKey", () => {
  it("ignores case, spacing and punctuation", () => {
    expect(questionKey("Why do you want to work here?")).toBe(questionKey("  why do you want to work here "));
    expect(questionKey("Why us?*")).toBe(questionKey("why us"));
  });
  it("keeps different questions apart", () => {
    expect(questionKey("Why us?")).not.toBe(questionKey("Why you?"));
  });
  it("works for non-Latin text", () => {
    expect(questionKey("¿Por qué quieres trabajar aquí?")).toBe("por qué quieres trabajar aquí");
  });
});

describe("isStandardField", () => {
  it.each([
    "First Name",
    "Preferred First Name",
    "Email",
    "Phone",
    "Resume/CV",
    "Cover Letter",
    "LinkedIn Profile",
    "Current company",
    "Pronouns",
    "Gender",
    "What gender do you identify as?",
    "What is your age range?",
    "I identify my ethnicity as...",
    "Are you a protected veteran?",
  ])("treats %s as a standard field", (label) => expect(isStandardField(label)).toBe(true));

  it.each([
    "Why do you want to work here?",
    "Are you legally authorized to work in the country where the job is located?",
    "Describe a race condition you debugged.",
    "How many years of experience do you have?",
  ])("keeps %s", (label) => expect(isStandardField(label)).toBe(false));
});

describe("sanitizeQuestionList", () => {
  it("cleans, drops standard fields and duplicates, and ignores non-strings", () => {
    expect(
      sanitizeQuestionList([
        "Why us? *",
        "why us",
        "Email",
        42,
        null,
        "Tell us about a project you are proud of.",
        "ab",
      ]),
    ).toEqual(["Why us?", "Tell us about a project you are proud of."]);
  });
  it("drops consent headings that end in a colon", () => {
    expect(
      sanitizeQuestionList(["Please review the points below:", "Candidate AI Usage Attestation:", "Why us?"]),
    ).toEqual(["Why us?"]);
  });
  it("is bounded", () => {
    const many = Array.from({ length: 100 }, (_, i) => `Question number ${i} about your work?`);
    expect(sanitizeQuestionList(many)).toHaveLength(MAX_IMPORTED_QUESTIONS);
  });
  it("drops absurdly long text and non-arrays", () => {
    expect(sanitizeQuestionList(["x".repeat(5000)])).toEqual([]);
    expect(sanitizeQuestionList("nope")).toEqual([]);
    expect(sanitizeQuestionList(null)).toEqual([]);
  });
});

describe("parseAttachments", () => {
  it("treats a missing or blank field as none", () => {
    expect(parseAttachments(undefined)).toEqual({ ok: true, items: [] });
    expect(parseAttachments("  ")).toEqual({ ok: true, items: [] });
  });
  it("parses ids and new text, dropping empty entries", () => {
    const r = parseAttachments(
      JSON.stringify([{ questionId: "q1", answerId: "a1" }, { text: "Why us?" }, { text: "   " }, {}]),
    );
    expect(r).toMatchObject({ ok: true });
    expect(r.ok && r.items).toHaveLength(2);
  });
  it("rejects malformed JSON and bad shapes with a message", () => {
    expect(parseAttachments("{nope")).toMatchObject({ ok: false });
    expect(parseAttachments('{"a":1}')).toMatchObject({ ok: false });
    expect(parseAttachments('[{"source":"HACK"}]')).toMatchObject({ ok: false });
  });
  it("caps the list", () => {
    const items = Array.from({ length: MAX_QUESTIONS_PER_APPLICATION + 1 }, (_, i) => ({ text: `Q ${i}?` }));
    expect(parseAttachments(JSON.stringify(items))).toMatchObject({ ok: false });
  });
});
