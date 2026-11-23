import { describe, expect, it } from "vitest";
import { choiceLine, choiceText, Choices, MAX_CHOICES, typedChoice } from "../../../src/core/choices.js";
import { CHOICES_MAX } from "../../../src/world/protocol/messages.js";

/** The session's questions and the choice texts (18, piece 7). */
describe("choices (18, piece 7)", () => {
  it("offers at most the protocol's limit", () => expect(MAX_CHOICES).toBe(CHOICES_MAX));

  it("numbers questions q1, q2, … and finds the latest unanswered one on a request", () => {
    const c = new Choices();
    const a = c.add({ request: 4, question: "Which?", choices: ["a", "b"] });
    const b = c.add({ request: 4, question: "And?", choices: ["c"] });
    c.add({ request: 5, question: "Other", choices: ["d"] });
    expect([a.id, b.id, a.answered]).toEqual(["q1", "q2", false]);
    expect(c.get("q2")).toBe(b);
    expect(c.openOn(4)).toBe(b);
    b.answered = true;
    expect(c.openOn(4)).toBe(a);
    a.answered = true;
    expect(c.openOn(4)).toBeUndefined();
    expect(c.openOn(9)).toBeUndefined();
  });

  it("reads a typed answer as a choice only when it is one digit from 1 to 9", () => {
    expect(["2", " 7 ", "9"].map(typedChoice)).toEqual([2, 7, 9]);
    expect(["0", "10", "2 please", "", "two", "-1"].map(typedChoice)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
  });

  it("writes lines 1-based and the answer as the agent wrote the choice", () => {
    expect(choiceLine(1, "ruin 180 blocks west")).toBe("[2] ruin 180 blocks west");
    const q = { request: 12, question: "Which   house?\nPick one.", choices: ["mossy house", 'ruin "west"'] };
    expect(choiceText("Kev", q, 1)).toBe('Choice answer from Kev (request 12) to "Which house? Pick one.": [2] "ruin \\"west\\"".');
    expect(choiceText("Kev", { ...q, request: null, question: "" }, 0)).toBe('Choice answer from Kev: [1] "mossy house".');
    expect(choiceText("Kev", { ...q, question: "x".repeat(300) }, 0)).toContain(`"${"x".repeat(199)}…"`);
  });
});
