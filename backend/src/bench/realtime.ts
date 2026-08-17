import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import type { ConversationState } from "@threepio/shared";
import { PIPELINE_SAMPLE_RATE } from "../providers/index.js";
import { applyEvent, createSession } from "../intakeStore.js";
import { runTool, sessionConfigFor } from "../runtime.js";
import { scanForRedFlags } from "../safety/scan.js";
import { readWav, resample } from "../audio/wav.js";
import { ms, renderTable, summarize } from "./stats.js";

/**
 * The speech-to-speech baseline the cascaded benchmark has always been compared against
 * and never actually measured.
 *
 * Until this existed, `latency.ts` produced a deliberately unflattering number — measured
 * from acoustic end of speech, including tool-call round trips — and it was weighed against
 * whatever figure the Realtime API is generally assumed to hit. That is not a comparison.
 * This harness runs the *same fixtures*, with the *same hangover policy*, reported from the
 * *same acoustic end*, so the two tables can be read side by side.
 *
 * Two decisions make it a fair fight rather than a flattering one:
 *
 * 1. **Turn detection is disabled and the buffer is committed by hand**, after exactly the
 *    hangover `latency.ts` uses for that state. Letting server VAD endpoint the turn would
 *    measure OpenAI's silence policy against our chosen one and call the difference an
 *    architecture result. `BENCH_RT_MODE=vad` runs it the other way for comparison, and the
 *    gap between the two modes is a measure of the hangover, not of the vendor.
 *
 * 2. **Tool calls are executed and the model is called back**, exactly as `latency.ts` does.
 *    Tool turns are the common path in this state machine, and excluding them flattered the
 *    cascaded numbers badly enough that the harness was corrected for it once already.
 *
 * It also measures the thing the cascade argument actually rests on. Input transcription
 * runs *alongside* generation here rather than gating it, so the harness records when the
 * transcript became available and when the model started speaking. If audio starts first,
 * the safety scan in `useRealtimeConversation.ts` is provably racing generation rather than
 * gating it — the `response.cancel` claw-back is load-bearing, not belt-and-braces. That is
 * an architectural claim the cascaded design is built on, and it should be a measurement.
 *
 * Run with: npm run bench:realtime -w threep-backend
 */

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const FRAME_MS = 20;
const ITERATIONS = Number(process.env.BENCH_ITERATIONS ?? 5);
const MODEL = process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2.1";
const VOICE = process.env.OPENAI_REALTIME_VOICE ?? "marin";
const TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL ?? "gpt-live-transcribe";
/** "manual" commits after our own hangover; "vad" lets the server endpoint the turn. */
const MODE = process.env.BENCH_RT_MODE === "vad" ? "vad" : "manual";
const TURN_DELAY_MS = Number(process.env.BENCH_TURN_DELAY_MS ?? 0);
/** How long to keep waiting for the input transcript after audio has already started. */
const TRANSCRIPT_GRACE_MS = Number(process.env.BENCH_RT_TRANSCRIPT_GRACE_MS ?? 4000);
/** See the note on the same flag in `latency.ts` — withholding tools removes the
 * tool-call-rate confound that makes cross-architecture p50s only loosely comparable. */
const NO_TOOLS = process.env.BENCH_NO_TOOLS === "1";

/** Identical to `latency.ts`, deliberately — changing it would void the comparison. */
const HANGOVER_MS: Record<string, number> = {
  verification: Number(process.env.BENCH_HANGOVER_VERIFICATION ?? 350),
  intake: Number(process.env.BENCH_HANGOVER_INTAKE ?? 700),
};

interface FixturePlan {
  state: ConversationState;
  priorAssistantTurn: string;
}

const PLANS: Record<string, FixturePlan> = {
  "01-short-answer": {
    state: "verification",
    priorAssistantTurn:
      "Hello, this is an AI assistant calling on behalf of the hospital about your upcoming appointment. Is now a good time for a quick pre-visit check-in about your headache?",
  },
  "02-date-of-birth": {
    state: "verification",
    priorAssistantTurn:
      "For privacy I just need to confirm a couple of details. Could you tell me your date of birth?",
  },
  "03-symptom-short": {
    state: "intake",
    priorAssistantTurn: "Can you describe what the headache feels like?",
  },
  "04-symptom-rambling": {
    state: "intake",
    priorAssistantTurn: "When did the headache first start?",
  },
};

interface TurnResult {
  fixture: string;
  state: ConversationState;
  hangoverMs: number;
  transcript: string;
  /** Acoustic end -> first output audio sample. The headline, same definition as cascaded. */
  responseStartMs: number;
  /** Acoustic end -> input transcript available. NaN when none arrived before audio. */
  transcriptMs: number;
  /**
   * Transcript-available -> first audio. Negative means the model was already speaking
   * before the text the safety scan needs existed.
   */
  safetyMarginMs: number;
  llmRoundTrips: number;
  toolName?: string;
  redFlagged: boolean;
}

const sleep = (d: number) => new Promise((r) => setTimeout(r, d));

function connect(): Promise<WebSocket> {
  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`;
  const ws = new WebSocket(url, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
  });
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

async function runTurn(
  fixture: string,
  samples: Int16Array,
  plan: FixturePlan
): Promise<TurnResult> {
  const ws = await connect();
  const send = (o: unknown) => ws.send(JSON.stringify(o));

  let tAcousticEnd = 0;
  let tFirstAudio = 0;
  let tTranscript = 0;
  let transcript = "";
  let llmRoundTrips = 1;
  let toolCall: { callId: string; name: string; args: string } | undefined;
  let failure: string | undefined;
  let audioDone = false;

  const session = createSession();
  if (plan.state === "intake") applyEvent(session.sessionId, "identity_verified");

  ws.on("message", (raw) => {
    const ev = JSON.parse(raw.toString());
    switch (ev.type) {
      case "response.output_audio.delta":
        if (!tFirstAudio) tFirstAudio = Date.now();
        break;
      case "conversation.item.input_audio_transcription.completed":
        if (!tTranscript) {
          tTranscript = Date.now();
          transcript = (ev.transcript ?? "").trim();
        }
        break;
      case "response.function_call_arguments.done":
        toolCall ??= { callId: ev.call_id, name: ev.name, args: ev.arguments ?? "{}" };
        break;
      case "response.done":
        // This response is finished, whether it spoke or only called a tool. Which of
        // those happened is decided below by whether any audio arrived.
        audioDone = true;
        break;
      case "error":
        failure = ev.error?.message ?? JSON.stringify(ev.error ?? ev);
        break;
    }
  });

  try {
    // Same policy prompt and tool schemas the live client is given for this state, so the
    // model is choosing among the same options against the same ~4KB of instructions.
    const cfg = sessionConfigFor(plan.state);
    send({
      type: "session.update",
      session: {
        type: "realtime",
        output_modalities: ["audio"],
        instructions: cfg.instructions,
        tools: NO_TOOLS ? [] : cfg.tools,
        tool_choice: NO_TOOLS ? "none" : "auto",
        audio: {
          input: {
            format: { type: "audio/pcm", rate: PIPELINE_SAMPLE_RATE },
            transcription: { model: TRANSCRIBE_MODEL },
            turn_detection:
              MODE === "vad"
                ? { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500, create_response: true }
                : null,
          },
          output: { format: { type: "audio/pcm", rate: PIPELINE_SAMPLE_RATE }, voice: VOICE },
        },
      },
    });

    // The preceding assistant turn, so the model answers in context rather than cold.
    send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: plan.priorAssistantTurn }],
      },
    });

    // Stream at real speed. Blasting the fixture would let the model work ahead of the
    // clock and produce a response time no patient could ever experience.
    const frame = (FRAME_MS / 1000) * PIPELINE_SAMPLE_RATE;
    const started = Date.now();
    for (let at = 0, i = 0; at < samples.length; at += frame, i++) {
      const slice = samples.subarray(at, Math.min(at + frame, samples.length));
      send({
        type: "input_audio_buffer.append",
        audio: Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength).toString("base64"),
      });
      const wait = started + (i + 1) * FRAME_MS - Date.now();
      if (wait > 0) await sleep(wait);
    }

    // End of file is end of speech: the generator trims trailing silence precisely so this
    // is true, because every number below is anchored here.
    tAcousticEnd = Date.now();

    if (MODE === "manual") {
      await sleep(HANGOVER_MS[plan.state] ?? 500);
      send({ type: "input_audio_buffer.commit" });
      send({ type: "response.create" });
    }

    // Stop at the *first* audio sample rather than at the end of the response — the same
    // choice `latency.ts` makes when it aborts TTS after one chunk. Synthesising the rest
    // would only add wall clock to the benchmark.
    const deadline = Date.now() + 30_000;
    while (!tFirstAudio && !audioDone && !failure && Date.now() < deadline) await sleep(10);

    // The tool path: the patient has heard nothing yet, and will not until the model has
    // been called a second time with the tool's result.
    if (!tFirstAudio && toolCall && !failure) {
      llmRoundTrips = 2;
      const outcome = runTool(toolCall.name, safeArgs(toolCall.args), session.sessionId);
      send({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: toolCall.callId,
          output: JSON.stringify(outcome.ok ? outcome.result : { error: outcome.error }),
        },
      });
      send({ type: "response.create" });

      const second = Date.now() + 30_000;
      while (!tFirstAudio && !failure && Date.now() < second) await sleep(10);
    }

    if (failure) throw new Error(failure);
    if (!tFirstAudio) throw new Error("no audio produced within timeout");

    // Keep listening for the input transcript even though the latency measurement is
    // already complete. Stopping at the first audio sample would silently drop exactly
    // the turns where the transcript arrived *late* — recording them as "no transcript"
    // rather than as the race they are, which biases the safety figure in favour of
    // whichever architecture is being measured. The timestamp above is already fixed, so
    // waiting here costs wall clock and changes no latency number.
    const grace = Date.now() + TRANSCRIPT_GRACE_MS;
    while (!tTranscript && !failure && Date.now() < grace) await sleep(10);

    return {
      fixture,
      state: plan.state,
      hangoverMs: MODE === "manual" ? (HANGOVER_MS[plan.state] ?? 500) : NaN,
      transcript,
      responseStartMs: tFirstAudio - tAcousticEnd,
      transcriptMs: tTranscript ? tTranscript - tAcousticEnd : NaN,
      safetyMarginMs: tTranscript ? tFirstAudio - tTranscript : NaN,
      llmRoundTrips,
      toolName: toolCall?.name,
      redFlagged: scanForRedFlags(transcript).flagged,
    };
  } finally {
    ws.close();
  }
}

function safeArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is not set.");
    process.exit(1);
  }

  console.log(`realtime: ${MODEL}  voice=${VOICE}  transcription=${TRANSCRIBE_MODEL}`);
  console.log(
    MODE === "manual"
      ? "mode: manual commit after our own hangover — same endpointing policy as the cascaded bench"
      : "mode: server VAD — OpenAI endpoints the turn, so this is NOT hangover-comparable"
  );
  if (NO_TOOLS) console.log("tools: NONE — architecture floor, not a production configuration");
  console.log(`iterations per fixture: ${ITERATIONS}\n`);

  let files: string[];
  try {
    files = (await readdir(FIXTURE_DIR)).filter((f) => f.endsWith(".wav")).sort();
  } catch {
    files = [];
  }
  if (files.length === 0) {
    console.error(`No fixtures in ${FIXTURE_DIR}. Generate with: npm run bench:fixtures -w threep-backend`);
    process.exit(1);
  }

  const results: TurnResult[] = [];
  let attempted = 0;

  for (const file of files) {
    const name = file.replace(/\.wav$/, "");
    const plan = PLANS[name];
    if (!plan) {
      console.warn(`skipping ${file}: no plan entry`);
      continue;
    }

    const pcm = resample(readWav(await readFile(join(FIXTURE_DIR, file))), PIPELINE_SAMPLE_RATE);
    process.stdout.write(`${name} (${(pcm.samples.length / PIPELINE_SAMPLE_RATE).toFixed(2)}s, ${plan.state}) `);

    for (let i = 0; i < ITERATIONS; i++) {
      if (TURN_DELAY_MS > 0 && attempted > 0) await sleep(TURN_DELAY_MS);
      attempted++;
      try {
        results.push(await runTurn(name, pcm.samples, plan));
        process.stdout.write(".");
      } catch (err) {
        process.stdout.write("x");
        console.error(`\n  ${(err as Error).message}`);
      }
    }
    process.stdout.write("\n");
  }

  report(results);
}

function report(results: TurnResult[]): void {
  if (results.length === 0) {
    console.error("\nNo successful turns — nothing to report.");
    process.exit(1);
  }

  const byFixture = new Map<string, TurnResult[]>();
  for (const r of results) {
    const list = byFixture.get(r.fixture) ?? [];
    list.push(r);
    byFixture.set(r.fixture, list);
  }

  console.log("\n\nPER-FIXTURE (ms, p50 / p95)\n");
  const rows: string[][] = [];
  for (const [fixture, list] of byFixture) {
    const col = (pick: (r: TurnResult) => number) => {
      const s = summarize(list.map(pick));
      return `${ms(s.p50)} / ${ms(s.p95)}`;
    };
    const trips = summarize(list.map((r) => r.llmRoundTrips));
    rows.push([
      fixture,
      Number.isFinite(list[0]!.hangoverMs) ? String(list[0]!.hangoverMs) : "vad",
      col((r) => r.transcriptMs),
      trips.p50 >= 2 ? "2" : "1",
      col((r) => r.responseStartMs),
    ]);
  }
  console.log(renderTable(["fixture", "hangover", "transcript", "trips", "RESPONSE START"], rows));

  console.log("\n\nHEADLINE — acoustic end of speech to first audible sample\n");
  const all = summarize(results.map((r) => r.responseStartMs));
  const one = summarize(results.filter((r) => r.llmRoundTrips === 1).map((r) => r.responseStartMs));
  const two = summarize(results.filter((r) => r.llmRoundTrips >= 2).map((r) => r.responseStartMs));
  console.log(
    renderTable(
      ["", "p50", "p95", "min", "max", "n"],
      [
        ["all turns", ms(all.p50), ms(all.p95), ms(all.min), ms(all.max), String(all.n)],
        ["spoke directly", ms(one.p50), ms(one.p95), ms(one.min), ms(one.max), String(one.n)],
        ["tool call first", ms(two.p50), ms(two.p95), ms(two.min), ms(two.max), String(two.n)],
      ]
    )
  );

  // The architectural measurement, not just a latency one.
  const margins = results.filter((r) => Number.isFinite(r.safetyMarginMs));
  if (margins.length > 0) {
    const m = summarize(margins.map((r) => r.safetyMarginMs));
    const raced = margins.filter((r) => r.safetyMarginMs < 0).length;
    console.log(
      "\nSAFETY SCAN: " +
        (m.p50 >= 0
          ? `the input transcript arrived p50 ${ms(m.p50)}ms BEFORE the first audio sample, over ${m.n} turns.\n`
          : `the model started speaking p50 ${ms(-m.p50)}ms BEFORE the input transcript existed, over ${m.n} turns.\n`) +
        (raced > 0
          ? `  ${raced}/${m.n} turns had the model ALREADY SPEAKING before the transcript the\n` +
            `  safety scan needs existed. On those turns the scan cannot gate anything — it can\n` +
            `  only cancel a reply already in flight, which is what response.cancel is for.`
          : `  The transcript preceded audio on every turn, so a scan could gate generation here\n` +
            `  provided the client withholds response.create until it has run.`)
    );
  } else {
    console.log(
      "\nSAFETY SCAN: no input transcript arrived before audio on any turn — the scan has\n" +
        "  nothing to gate on at the moment the model starts speaking."
    );
  }

  const toolTurns = results.filter((r) => r.llmRoundTrips >= 2);
  if (toolTurns.length > 0) {
    const names = [...new Set(toolTurns.map((r) => r.toolName))].join(", ");
    console.log(
      `\ntool-call turns: ${toolTurns.length}/${results.length} (${names}) — each cost a second ` +
        `round trip before the patient heard anything.`
    );
  }

  console.log("\nTranscripts (check for recognition errors before trusting the numbers):");
  for (const [fixture, list] of byFixture) {
    console.log(`  ${fixture}: ${JSON.stringify(list[0]!.transcript)}`);
  }

  const target = Number(process.env.BENCH_TARGET_MS ?? 1000);
  console.log(
    `\nGATE: p50 ${ms(all.p50)}ms against a ${target}ms target — ` +
      (all.p50 <= target ? "MET" : `MISSED by ${ms(all.p50 - target)}ms`)
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
