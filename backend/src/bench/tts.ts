import "dotenv/config";
import { providersFromEnv, PIPELINE_SAMPLE_RATE } from "../providers/index.js";
import { ms, renderTable, summarize } from "./stats.js";

/**
 * Text-to-speech in isolation — no recognizer, no language model, no fixtures.
 *
 * The full-pipeline benchmark can only tell you that a turn was slow; it cannot tell you
 * whether synthesis was slow to *start* or merely slow to *finish*, because it stops the
 * clock at the first byte and aborts. For a local model those are entirely different
 * diagnoses, and only one of them is fixable by streaming.
 *
 * So this harness reads the whole utterance and reports three numbers per span:
 *
 *   ttfb   request -> first audio sample. What the patient waits through.
 *   total  request -> last audio sample. What the machine actually spent.
 *   rtf    total / duration of the audio produced. Below 1.0 means synthesis outruns
 *          playback, so the span could in principle be spoken while the rest is still
 *          being made. Above 1.0 means it cannot keep up at all.
 *
 * When ttfb and total are the same number, the whole utterance arrived at once. Whether
 * that is fixable depends on the engine: a buffering HTTP layer in front of a streaming
 * model is a transport bug, but a non-autoregressive model like Kokoro genuinely has no
 * output until its single decoder pass finishes, and no transport change will alter that.
 * There the only lever is span length, which belongs to the chunker upstream — which is
 * why the first span is measured separately and reported against a budget.
 *
 * Run with: npm run bench:tts -w threep-backend
 */

const ITERATIONS = Number(process.env.BENCH_TTS_ITERATIONS ?? 10);
const WARMUPS = Number(process.env.BENCH_TTS_WARMUPS ?? 2);

/**
 * Spans sized the way the chunker actually cuts them, not round numbers. The first span
 * of a turn is the only one the patient waits on, and `DEFAULT_CHUNKER_OPTIONS` cuts it
 * at twelve characters — so a benchmark that only synthesizes whole paragraphs measures
 * a case that never gates anything.
 */
const SPANS: { label: string; text: string }[] = [
  { label: "first-span (12ch)", text: "Of course." },
  { label: "short (40ch)", text: "Thanks, I've got that noted for you." },
  {
    label: "sentence (~90ch)",
    text: "Could you tell me roughly when the headache first started, and whether it came on suddenly?",
  },
  {
    label: "long (~220ch)",
    text:
      "I understand, that sounds really uncomfortable. Before your appointment I'd like to " +
      "ask a few questions about the headache itself — how often it happens, how long each " +
      "one lasts, and whether anything seems to bring it on.",
  },
];

interface Sample {
  label: string;
  chars: number;
  ttfbMs: number;
  totalMs: number;
  audioMs: number;
  rtf: number;
  chunks: number;
}

async function synthesize(
  tts: ReturnType<typeof providersFromEnv>["tts"],
  label: string,
  text: string
): Promise<Sample> {
  const controller = new AbortController();
  const started = Date.now();
  let ttfbMs = NaN;
  let samples = 0;
  let chunks = 0;

  for await (const pcm of tts.stream({ text, signal: controller.signal })) {
    if (!Number.isFinite(ttfbMs)) ttfbMs = Date.now() - started;
    samples += pcm.length;
    chunks++;
  }

  const totalMs = Date.now() - started;
  const audioMs = (samples / tts.sampleRate) * 1000;

  return {
    label,
    chars: text.length,
    ttfbMs,
    totalMs,
    audioMs,
    // Guard the divide: a provider that returned nothing should show as "—", not Infinity.
    rtf: audioMs > 0 ? totalMs / audioMs : NaN,
    chunks,
  };
}

async function main(): Promise<void> {
  const { tts } = providersFromEnv();

  console.log(`tts: ${tts.name}/${tts.model} @ ${tts.sampleRate} Hz`);
  if (tts.sampleRate !== PIPELINE_SAMPLE_RATE) {
    console.log(
      `  note: provider rate differs from the pipeline's ${PIPELINE_SAMPLE_RATE} Hz — ` +
        `audio duration below is computed at the provider's rate.`
    );
  }
  console.log(`iterations per span: ${ITERATIONS} (after ${WARMUPS} warm-up)\n`);

  const results: Sample[] = [];

  for (const span of SPANS) {
    process.stdout.write(`${span.label.padEnd(18)} `);

    // The first inference after a cold start pays one-off allocation and graph-warming
    // costs that belong to startup, not to a turn. Charging them to iteration one would
    // put the whole cost in the max column and none of it anywhere useful.
    for (let i = 0; i < WARMUPS; i++) {
      try {
        await synthesize(tts, span.label, span.text);
        process.stdout.write("~");
      } catch {
        process.stdout.write("x");
      }
    }

    for (let i = 0; i < ITERATIONS; i++) {
      try {
        results.push(await synthesize(tts, span.label, span.text));
        process.stdout.write(".");
      } catch (err) {
        process.stdout.write("x");
        console.error(`\n  ${(err as Error).message}`);
      }
    }
    process.stdout.write("\n");
  }

  report(results, tts.name, tts.model);
}

function report(results: Sample[], name: string, model: string): void {
  if (results.length === 0) {
    console.error(
      "\nNo successful synthesis — nothing to report.\n" +
        "If this is the local provider, check the server is up:\n" +
        "  ~/.cache/kokoro-venv/bin/python backend/tools/kokoro_server.py --port 8179\n" +
        "and that LOCAL_TTS_URL points at it (e.g. http://127.0.0.1:8179/v1)."
    );
    process.exit(1);
  }

  const byLabel = new Map<string, Sample[]>();
  for (const r of results) {
    const list = byLabel.get(r.label) ?? [];
    list.push(r);
    byLabel.set(r.label, list);
  }

  console.log(`\n\n${name}/${model} — SYNTHESIS COST (ms, p50 / p95)\n`);
  const rows: string[][] = [];
  for (const [label, list] of byLabel) {
    const col = (pick: (s: Sample) => number) => {
      const s = summarize(list.map(pick));
      return `${ms(s.p50)} / ${ms(s.p95)}`;
    };
    const rtf = summarize(list.map((s) => s.rtf));
    const audio = summarize(list.map((s) => s.audioMs));
    const chunks = summarize(list.map((s) => s.chunks));
    rows.push([
      label,
      String(list[0]!.chars),
      col((s) => s.ttfbMs),
      col((s) => s.totalMs),
      ms(audio.p50),
      Number.isFinite(rtf.p50) ? rtf.p50.toFixed(2) : "—",
      ms(chunks.p50),
    ]);
  }
  console.log(
    renderTable(["span", "chars", "ttfb", "total", "audio", "rtf", "chunks"], rows)
  );

  // The diagnosis, stated rather than left for the reader to infer from two columns.
  const gaps = results.map((s) => s.totalMs - s.ttfbMs);
  const gap = summarize(gaps);
  const totals = summarize(results.map((s) => s.totalMs));
  const buffered = Number.isFinite(gap.p95) && gap.p95 <= 5;

  console.log(
    `\nSTREAMING: p50 ${ms(gap.p50)}ms elapsed between the first audio sample and the last, ` +
      `over a p50 total of ${ms(totals.p50)}ms.\n` +
      (buffered
        ? "  Everything arrived at once: time-to-first-byte here IS time-to-complete, and the\n" +
          "  patient waits for the whole span. For Kokoro this is not a transport bug and\n" +
          "  chunked transfer would not fix it — the model is non-autoregressive (one decoder\n" +
          "  pass emits the entire waveform) and kokoro_onnx only splits into batches past 510\n" +
          "  phonemes, which no conversational span reaches. The only lever is to send SHORTER\n" +
          "  SPANS, which is the chunker's job upstream — hence the first-span figure below."
        : "  Audio arrived progressively, so time-to-first-byte is a genuine head start and the\n" +
          "  rest of the utterance synthesizes while the opening plays.")
  );

  const rtf = summarize(results.map((s) => s.rtf));
  console.log(
    `\nTHROUGHPUT: p50 rtf ${Number.isFinite(rtf.p50) ? rtf.p50.toFixed(2) : "—"}× ` +
      (rtf.p50 < 1
        ? `— synthesis runs ${(1 / rtf.p50).toFixed(1)}× faster than playback, so the model has ` +
          `the headroom to stream.`
        : `— synthesis is SLOWER than playback, so audio cannot be produced fast enough to keep ` +
          `speaking without gaps, whatever the transport does.`)
  );

  // The number that matters for the turn budget: the first span is what the patient
  // waits on, and it is the only span whose cost cannot be hidden behind playback.
  const first = byLabel.get(SPANS[0]!.label) ?? [];
  if (first.length > 0) {
    const s = summarize(first.map((r) => r.ttfbMs));
    const budget = Number(process.env.BENCH_TTS_BUDGET_MS ?? 300);
    console.log(
      `\nFIRST SPAN: p50 ${ms(s.p50)}ms  p95 ${ms(s.p95)}ms against a ${budget}ms budget — ` +
        (s.p50 <= budget ? "MET" : `MISSED by ${ms(s.p50 - budget)}ms`)
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
