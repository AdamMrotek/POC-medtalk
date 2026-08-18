import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openAiTts } from "../providers/openai/tts.js";
import { PIPELINE_SAMPLE_RATE } from "../providers/types.js";
import { concat, silence, trimSilence, writeWav } from "../audio/wav.js";

/**
 * Generates the benchmark fixtures by synthesizing them.
 *
 * A caveat that has to travel with every number this produces: **synthetic speech is
 * cleaner than a real patient.** No room tone, no phone codec, no accent, no false start,
 * no trailing "umm". Recognition on these fixtures will be optimistic, which means the
 * STT numbers here are a floor rather than an estimate. Before the gate decision is
 * treated as final, these should be replaced with real recordings over the actual audio
 * path — drop any 16-bit WAV into `src/bench/fixtures/` and the harness will use it.
 *
 * What the fixtures *can* honestly exercise is timing structure, which is what the
 * endpointing question turns on — hence the deliberate mid-sentence pause below.
 *
 * Run with: npm run bench:fixtures -w threep-backend
 */

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** A different voice from the assistant's, so a fixture can never be mistaken for the
 * assistant's own output during echo testing later. */
const PATIENT_VOICE = process.env.BENCH_PATIENT_VOICE ?? "ash";

interface FixtureSpec {
  name: string;
  /** Spoken parts. More than one part means silence is inserted between them. */
  parts: string[];
  /** Gap between parts, in ms. */
  gapMs?: number;
  note: string;
}

const FIXTURES: FixtureSpec[] = [
  {
    name: "01-short-answer",
    parts: ["Yes, that's fine."],
    note: "Shortest realistic turn. The case where sub-second should be achievable.",
  },
  {
    name: "02-date-of-birth",
    parts: ["May fourteenth, nineteen ninety."],
    note: "Verification turn. Slot extraction, and the tool-call latency worst case.",
  },
  {
    name: "03-symptom-short",
    parts: ["It's a throbbing pain behind my right eye."],
    note: "Typical intake answer. One clause, no pause.",
  },
  {
    name: "04-symptom-rambling",
    parts: [
      "It started, I think, maybe Tuesday",
      "and my neck has been really stiff since then.",
    ],
    gapMs: 900,
    note:
      "The endpointing trap. A 900ms mid-sentence pause, and the clause AFTER the pause " +
      "carries the red flag (neck stiffness). An endpointer that cuts in at 300ms loses " +
      "the clinically important half of this sentence.",
  },
];

async function synthesize(text: string): Promise<Int16Array> {
  const tts = openAiTts();
  const controller = new AbortController();
  const chunks: Int16Array[] = [];
  for await (const chunk of tts.stream({ text, signal: controller.signal })) {
    chunks.push(chunk);
  }
  return trimSilence(concat(chunks));
}

async function main(): Promise<void> {
  process.env.OPENAI_REALTIME_VOICE = PATIENT_VOICE;
  await mkdir(FIXTURE_DIR, { recursive: true });

  for (const spec of FIXTURES) {
    const spoken: Int16Array[] = [];
    for (const [i, part] of spec.parts.entries()) {
      if (i > 0) spoken.push(silence(spec.gapMs ?? 0));
      spoken.push(await synthesize(part));
    }

    // Trim again at the ends only: end-of-file must mean end-of-speech, because the
    // headline metric is measured from the acoustic end. Interior silence is preserved —
    // that pause is the whole point of fixture 04.
    const samples = trimSilence(concat(spoken));
    const path = join(FIXTURE_DIR, `${spec.name}.wav`);
    await writeFile(path, writeWav({ samples, sampleRate: PIPELINE_SAMPLE_RATE }));

    const seconds = (samples.length / PIPELINE_SAMPLE_RATE).toFixed(2);
    console.log(`${spec.name}.wav  ${seconds}s  — ${spec.note}`);
  }

  console.log(`\nWrote ${FIXTURES.length} fixtures to ${FIXTURE_DIR}`);
  console.log("These are synthetic. Replace with real recordings before trusting STT numbers.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
