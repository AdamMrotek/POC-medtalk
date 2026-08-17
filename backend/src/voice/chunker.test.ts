import assert from "node:assert/strict";
import { test } from "node:test";
import { createChunker } from "./chunker.js";

/** Feeds text one character at a time — the worst case, and closest to how model deltas
 * actually arrive. A chunker that only works on whole sentences is not a chunker. */
function pushCharByChar(text: string, overrides = {}): string[] {
  const chunker = createChunker(overrides);
  const spans: string[] = [];
  for (const ch of text) spans.push(...chunker.push(ch));
  const rest = chunker.flush();
  if (rest) spans.push(rest);
  return spans;
}

test("emits the first span early so audio starts sooner", () => {
  const spans = pushCharByChar("I understand. Let me ask about the pain.");
  assert.equal(spans[0], "I understand.");
});

test("does not split inside a decimal", () => {
  const spans = pushCharByChar("You rated it 7.5 out of ten, which is helpful to know.");
  assert.ok(
    spans.every((s) => !s.endsWith("7.")),
    `a span ended mid-decimal: ${JSON.stringify(spans)}`
  );
  assert.ok(spans.join(" ").includes("7.5"));
});

test("does not split after an abbreviation", () => {
  const spans = pushCharByChar("Dr. Chen will review this before your visit tomorrow.");
  assert.ok(
    spans.every((s) => !s.endsWith("Dr.")),
    `a span ended on an abbreviation: ${JSON.stringify(spans)}`
  );
});

test("does not split after a single initial", () => {
  const spans = pushCharByChar("Your note lists J. Smith as the referring clinician here.");
  assert.ok(spans.every((s) => !s.endsWith("J.")));
});

test("does not split on a list marker", () => {
  const spans = pushCharByChar("Two things:\n1. when it started\n2. how bad it gets right now.");
  assert.ok(spans.every((s) => !/\b1\.$/.test(s)));
});

test("splits on question marks", () => {
  const spans = pushCharByChar("When did it start? Tell me about the pain itself.");
  assert.equal(spans[0], "When did it start?");
});

test("uses clause boundaries only once past the minimum length", () => {
  // The comma arrives at character 3 — far too early to be worth synthesizing alone.
  const spans = pushCharByChar("So, tell me when the headache first began for you.");
  assert.ok(spans[0]!.length > 3, `emitted a runt span: ${JSON.stringify(spans)}`);
});

test("hard flushes a run-on so speech still starts", () => {
  const runOn = "and then " + "it kept going on and on ".repeat(12);
  const spans = pushCharByChar(runOn, { hardFlushChars: 60 });
  assert.ok(spans.length > 1);
  assert.ok(spans.every((s) => s.length <= 80), `span too long: ${JSON.stringify(spans)}`);
});

test("hard flush breaks at a word boundary, not mid-word", () => {
  const spans = pushCharByChar("supercalifragilistic ".repeat(10), { hardFlushChars: 50 });
  for (const span of spans) {
    for (const word of span.split(/\s+/).filter(Boolean)) {
      assert.ok(
        word === "supercalifragilistic",
        `hard flush split a word: ${JSON.stringify(word)}`
      );
    }
  }
});

test("flush returns trailing text with no terminator", () => {
  const chunker = createChunker();
  chunker.push("no punctuation here");
  assert.equal(chunker.flush(), "no punctuation here");
});

test("flush is empty once everything has been emitted", () => {
  const chunker = createChunker();
  assert.deepEqual(chunker.push("I understand completely. "), ["I understand completely."]);
  assert.equal(chunker.flush(), null);
});

test("holds a response shorter than the first-span minimum until flush", () => {
  // "All done." is 9 characters. Emitting it as a span would save nothing — the stream
  // has already ended — so it waits for flush rather than costing a synthesis request.
  const chunker = createChunker();
  assert.deepEqual(chunker.push("All done. "), []);
  assert.equal(chunker.flush(), "All done.");
});

test("loses no text across the whole stream", () => {
  const source =
    "I understand. On a scale of one to ten, where would you put it? Dr. Chen noted 7.5 last time, so let us compare.";
  const spans = pushCharByChar(source);
  assert.equal(spans.join(" ").replace(/\s+/g, " "), source.replace(/\s+/g, " "));
});
