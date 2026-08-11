import type { RedFlagId } from "@threepio/shared";

export interface RedFlagPattern {
  /** The flag fires if any of these match. An empty list means model-judgment only. */
  any: RegExp[];
  /** When present, one of these must also match somewhere in the same text. */
  alsoRequires?: RegExp[];
}

/**
 * Deterministic patterns for the shared red-flag catalog.
 *
 * The `Record<RedFlagId, ...>` type is the point of this file: adding an entry to
 * `RED_FLAGS` without deciding how (or whether) it can be detected deterministically
 * fails the build. That's what stopped being true when the old scanner kept its own
 * private rule list and silently fell three flags behind the prompt.
 *
 * Patterns stay server-side on purpose — the browser never runs the scan, and shipping
 * the exact trigger phrases in the bundle would only tell someone what not to say.
 */
export const RED_FLAG_PATTERNS: Record<RedFlagId, RedFlagPattern> = {
  thunderclap: {
    any: [/thunderclap/i, /sudden\w*[^.!?]{0,40}(severe|worst|intense)/i],
  },
  "worst-headache": {
    any: [/worst headache/i],
  },
  "fever-neck-stiffness": {
    any: [/fever|temperature of \d|running hot/i],
    alsoRequires: [/stiff neck|neck (is |feels )?stiff|neck stiffness/i],
  },
  "neck-stiffness": {
    any: [/stiff neck|neck (is |feels )?stiff|neck stiffness/i],
  },
  "neuro-deficit": {
    any: [
      /slurred speech|slurring/i,
      /can'?t move|numb(ness)?/i,
      /weak(ness)? (on|down) one side|one side.{0,20}weak/i,
      /(face|facial) droop/i,
    ],
  },
  confusion: {
    any: [/confus(ed|ion)|disorient(ed|ation)|can'?t think straight|not making sense/i],
  },
  "vision-loss": {
    any: [/vision loss|lost my vision|can'?t see|blurry vision|double vision/i],
  },
  "loss-of-consciousness": {
    any: [/passed out|lost consciousness|unconscious|blacked out|seizure|fainted/i],
  },
  "head-injury": {
    any: [/head injury|hit my head|head trauma|banged my head/i],
  },
  pregnancy: {
    any: [/pregnant|pregnancy/i],
  },
  // Age of onset isn't reliably detectable from free text ("I'm 52" is not the same as a
  // first-ever headache after 50), so this one is left to the model. Declared explicitly
  // rather than omitted, so the gap is a decision on the record instead of an oversight.
  "new-onset-over-50": {
    any: [],
  },
};
