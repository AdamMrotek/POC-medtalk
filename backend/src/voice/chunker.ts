/**
 * Splits a streaming model response into spans worth synthesizing.
 *
 * This is the largest lever on perceived latency in the cascaded pipeline. The patient
 * hears nothing until the first span is synthesized, so the first span is cut
 * aggressively — a dozen characters is enough to start talking. Later spans are cut
 * longer, because by then synthesis is racing playback rather than the patient's
 * patience, and longer spans carry better prosody.
 *
 * A pure function with no I/O: it can be tested exhaustively without a network, a socket
 * or a model, which is what makes it worth getting right rather than approximately right.
 */

export interface ChunkerOptions {
  /** The first span is cut short to start audio sooner. */
  firstChunkMinChars: number;
  /** Later spans are cut longer, for prosody. */
  chunkMinChars: number;
  /** Emit regardless once a span gets this long, so a run-on sentence still speaks. */
  hardFlushChars: number;
}

export const DEFAULT_CHUNKER_OPTIONS: ChunkerOptions = {
  firstChunkMinChars: 12,
  chunkMinChars: 40,
  hardFlushChars: 140,
};

/** Words that end in a period without ending a sentence. */
const ABBREVIATIONS = new Set([
  "dr", "mr", "mrs", "ms", "prof", "st", "sr", "jr",
  "etc", "vs", "approx", "no", "dept", "est",
  "e.g", "i.e", "a.m", "p.m", "u.s",
]);

const SENTENCE_END = new Set([".", "?", "!"]);
const CLAUSE_END = new Set([",", ";", ":", "—"]);

export interface Chunker {
  /** Feed a model delta; returns zero or more spans ready to synthesize. */
  push(delta: string): string[];
  /** Emit whatever is left at end of stream. */
  flush(): string | null;
}

export function createChunker(overrides: Partial<ChunkerOptions> = {}): Chunker {
  const opts = { ...DEFAULT_CHUNKER_OPTIONS, ...overrides };
  let buffer = "";
  let emittedAny = false;

  const minChars = () => (emittedAny ? opts.chunkMinChars : opts.firstChunkMinChars);

  function takeNextSpan(): string | null {
    const min = minChars();

    for (let i = 0; i < buffer.length; i++) {
      const ch = buffer[i]!;
      const isSentence = SENTENCE_END.has(ch);
      const isClause = CLAUSE_END.has(ch);
      if (!isSentence && !isClause) continue;

      // A boundary is only trustworthy once we've seen what follows it: mid-stream the
      // next delta might turn "3" + "." into "3.5", or "Dr" + "." into "Dr. Chen".
      const next = buffer[i + 1];
      if (next === undefined) break;
      if (!/\s/.test(next)) continue;

      if (i + 1 < min) continue;
      if (isSentence && ch === "." && !isRealPeriod(buffer, i)) continue;

      const span = buffer.slice(0, i + 1).trim();
      buffer = buffer.slice(i + 1).replace(/^\s+/, "");
      return span;
    }

    if (buffer.length >= opts.hardFlushChars) {
      // Break at the last word boundary rather than mid-word, which would make the
      // synthesizer mispronounce the fragment on both sides of the seam.
      const cut = buffer.lastIndexOf(" ", opts.hardFlushChars);
      const at = cut > min ? cut : opts.hardFlushChars;
      const span = buffer.slice(0, at).trim();
      buffer = buffer.slice(at).replace(/^\s+/, "");
      return span;
    }

    return null;
  }

  return {
    push(delta) {
      buffer += delta;
      const spans: string[] = [];
      for (;;) {
        const span = takeNextSpan();
        if (span === null) break;
        if (span) {
          spans.push(span);
          emittedAny = true;
        }
      }
      return spans;
    },
    flush() {
      const rest = buffer.trim();
      buffer = "";
      if (!rest) return null;
      emittedAny = true;
      return rest;
    },
  };
}

/** True when a period actually ends a sentence, rather than sitting inside a number, an
 * abbreviation, an initial, or a list marker. */
function isRealPeriod(text: string, dot: number): boolean {
  const before = text[dot - 1];
  const after = text[dot + 1];

  // 3.5 — a decimal. Severity answers are full of these.
  if (before && after && /\d/.test(before) && /\d/.test(after)) return false;

  // "1. " at the start of a line — a list marker.
  if (before && /\d/.test(before)) {
    const run = /(?:^|\n)\s*\d+$/.test(text.slice(0, dot));
    if (run) return false;
  }

  const word = /([A-Za-z.]+)$/.exec(text.slice(0, dot))?.[1] ?? "";
  if (!word) return true;

  // A single initial: "J. Smith".
  if (word.length === 1) return false;

  return !ABBREVIATIONS.has(word.toLowerCase().replace(/\.+$/, ""));
}
