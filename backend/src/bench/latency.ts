import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConversationState } from "@threepio/shared";
import { instructionsFor } from "../policy/instructions.js";
import {
  providersFromEnv,
  PIPELINE_SAMPLE_RATE,
  type LlmMessage,
  type ProviderSet,
} from "../providers/index.js";
import { applyEvent, createSession } from "../intakeStore.js";
import { runTool } from "../runtime.js";
import { scanForRedFlags } from "../safety/scan.js";
import { toChatToolSchemas } from "../tools/index.js";
import { createChunker } from "../voice/chunker.js";
import { ms, renderTable, summarize } from "./stats.js";
import { readWav, resample } from "../audio/wav.js";

/**
 * Stage 1 of the voice pipeline benchmark: how long does a cascaded turn take, with no
 * browser and no audio plumbing in the way?
 *
 * This exists to be a gate. If the answer here leaves no headroom, that is worth knowing
 * before an AudioWorklet, a VAD and a WebSocket protocol get built on top of it.
 *
 * The one measurement decision that governs everything: **timings are reported from the
 * acoustic end of speech**, not from the moment an endpoint is declared. Vendors quote the
 * latter, and the gap between them — the endpoint hangover — is the largest single term in
 * the budget. Reporting from endpoint-declared would produce a number the patient never
 * experiences.
 *
 * Run with: npm run bench -w threep-backend
 */

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const FRAME_MS = 20;
const ITERATIONS = Number(process.env.BENCH_ITERATIONS ?? 5);

/**
 * Idle time between turns. Zero by default — it measures nothing and only costs wall clock.
 * It exists because a rate-limited free tier turns a latency benchmark into a benchmark of
 * the rate limiter: Groq's on-demand tier allows 8000 tokens/min and one turn against the
 * real ~4KB policy prompt costs ~1200 per round trip, so unpaced runs mostly measure 429s.
 * Pacing the requests is the honest fix; retrying inside the timed section is not.
 */
const TURN_DELAY_MS = Number(process.env.BENCH_TURN_DELAY_MS ?? 0);

/**
 * Offer the model no tools at all.
 *
 * Not a production configuration — this state machine tool-calls on most turns, and the
 * headline figures deliberately include that cost. It exists because tool-call *rate*
 * varies by model (5/20 turns for one, 15/20 for another), so a p50 over "all turns" mixes
 * one-trip and two-trip populations in different proportions depending on which model is
 * under test. That makes cross-architecture headlines only loosely comparable. With tools
 * withheld every turn is one round trip by construction, which isolates the pipeline's
 * floor from the state machine's design.
 *
 * **It also creates a contradiction the caller must account for.** `instructionsFor()`
 * mandates tool calls in prose — the intake role says "after every patient answer, call
 * update_intake" — so withholding the tools instructs the model to do something it cannot.
 * Some models answer that with an empty completion, which drops the turn from every
 * latency column and quietly shrinks n. That is the harness's doing, not a model defect,
 * and the "spoke" column exists so it cannot pass unnoticed. Treat tool-free numbers as a
 * floor measured under a deliberately inconsistent prompt.
 */
const NO_TOOLS = process.env.BENCH_NO_TOOLS === "1";

/**
 * The endpoint hangover, per conversation state. This is a *policy* number, not a measured
 * one — it is how long we wait in silence before declaring the turn over. Verification
 * answers are short and predictable so they can be cut fast; intake answers are where a
 * patient pauses to think mid-symptom, and cutting those off loses clinical data.
 */
const HANGOVER_MS: Record<string, number> = {
  verification: Number(process.env.BENCH_HANGOVER_VERIFICATION ?? 350),
  intake: Number(process.env.BENCH_HANGOVER_INTAKE ?? 700),
};

interface FixturePlan {
  state: ConversationState;
  /** A plausible preceding assistant turn, so the model is answering in context rather
   * than cold — prompt shape affects both tool choice and time to first token. */
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
  /** Endpoint declared -> final transcript. */
  sttMs: number;
  /** How many partial transcripts arrived while the patient was still speaking. Zero means
   * the recognizer is not actually working ahead, and `sttMs` is full recognition cost
   * rather than just the tail — a completely different latency story. */
  partialsDuringSpeech: number;
  /** Last partial before the acoustic end, relative to it (negative = arrived early). */
  lastPartialLeadMs: number;
  /** LLM request -> first content token. */
  llmTtftMs: number;
  /** LLM request -> first span worth synthesizing. */
  llmFirstSpanMs: number;
  /** Synthesis request -> first audio byte. */
  ttsTtfbMs: number;
  /** Acoustic end of speech -> first audible sample. The headline number. */
  responseStartMs: number;
  /** How many LLM round trips the turn needed. 2 means a tool call ran first and the
   * patient waited through both before hearing anything. */
  llmRoundTrips: number;
  toolName?: string;
  /** True when the deterministic scan fired, so the LLM would be skipped entirely. */
  redFlagged: boolean;
  /** Acoustic end -> escalation audio could start, assuming pre-rendered emergency audio. */
  escalationMs: number;
}

const sleep = (msDelay: number) => new Promise((r) => setTimeout(r, msDelay));

async function runTurn(
  providers: ProviderSet,
  fixture: string,
  samples: Int16Array,
  plan: FixturePlan
): Promise<TurnResult> {
  const controller = new AbortController();
  const hangoverMs = HANGOVER_MS[plan.state] ?? 500;

  try {
    const stt = await providers.stt.open({ signal: controller.signal });

    const partialTimes: number[] = [];
    stt.onPartial(() => partialTimes.push(Date.now()));

    // Stream the fixture at real speed. Blasting it at full rate would let the recognizer
    // work ahead of the clock and produce a final transcript that looks nearly free.
    const frame = (FRAME_MS / 1000) * PIPELINE_SAMPLE_RATE;
    const started = Date.now();
    for (let at = 0, i = 0; at < samples.length; at += frame, i++) {
      stt.push(samples.subarray(at, Math.min(at + frame, samples.length)));
      const nextDeadline = started + (i + 1) * FRAME_MS;
      const wait = nextDeadline - Date.now();
      if (wait > 0) await sleep(wait);
    }

    // End of file is end of speech: the generator trims trailing silence precisely so this
    // is true, because every number below is anchored here.
    const tAcousticEnd = Date.now();

    await sleep(hangoverMs);
    stt.commit();
    const tEndpoint = Date.now();

    const final = await stt.nextFinal();
    const tSttFinal = Date.now();
    stt.close();

    const transcript = final.text.trim();

    // The safety gate. In the real pipeline a hit here means the LLM is never called and
    // pre-rendered emergency audio plays straight from disk — so the escalation path costs
    // the hangover plus recognition and essentially nothing else.
    const scan = scanForRedFlags(transcript);
    const escalationMs = tSttFinal - tAcousticEnd;

    const messages: LlmMessage[] = [
      { role: "assistant", content: plan.priorAssistantTurn },
      { role: "user", content: transcript },
    ];

    const tLlmStart = Date.now();
    let tFirstToken = 0;
    let tFirstSpan = 0;
    let firstSpan = "";
    let toolCall: { id: string; name: string; args: Record<string, unknown> } | undefined;
    let llmRoundTrips = 1;

    const chunker = createChunker();
    const llmController = new AbortController();

    const consume = async (system: string, history: LlmMessage[]) => {
      for await (const delta of providers.llm.stream({
        system,
        messages: history,
        tools: NO_TOOLS ? [] : toChatToolSchemas(plan.state),
        signal: llmController.signal,
      })) {
        if (delta.type === "text") {
          if (!tFirstToken) tFirstToken = Date.now();
          if (!firstSpan) {
            const spans = chunker.push(delta.text);
            if (spans.length > 0) {
              firstSpan = spans[0]!;
              tFirstSpan = Date.now();
            }
          }
        } else if (delta.type === "tool_call") {
          toolCall ??= { id: delta.id, name: delta.name, args: delta.args };
        }
      }
      if (!firstSpan) {
        const rest = chunker.flush();
        if (rest) {
          firstSpan = rest;
          tFirstSpan = Date.now();
        }
      }
    };

    await consume(instructionsFor(plan.state), messages);

    // A tool call means the patient has heard nothing yet: the model has to be called a
    // second time, with the tool's result, before there is anything to say. Measuring only
    // the first round trip would report a latency no patient experiences — and the local
    // model tool-calls on effectively every turn, so this is the common path, not an edge.
    if (!firstSpan && toolCall) {
      llmRoundTrips = 2;

      const session = createSession();
      if (plan.state === "intake") applyEvent(session.sessionId, "identity_verified");
      const outcome = runTool(toolCall.name, toolCall.args, session.sessionId);
      const toolResult = outcome.ok ? outcome.result : { error: outcome.error };
      const nextState = outcome.ok ? outcome.record.state : plan.state;

      await consume(instructionsFor(nextState), [
        ...messages,
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: toolCall.id, name: toolCall.name, args: JSON.stringify(toolCall.args) },
          ],
        },
        { role: "tool", content: JSON.stringify(toolResult), toolCallId: toolCall.id },
      ]);
    }

    let ttsTtfbMs = NaN;
    let responseStartMs = NaN;

    if (firstSpan) {
      const tTtsStart = Date.now();
      const ttsController = new AbortController();
      for await (const _chunk of providers.tts.stream({
        text: firstSpan,
        signal: ttsController.signal,
      })) {
        ttsTtfbMs = Date.now() - tTtsStart;
        responseStartMs = Date.now() - tAcousticEnd;
        // Only the first byte is being measured; synthesizing the rest costs money and
        // teaches nothing.
        ttsController.abort();
        break;
      }
    }

    return {
      fixture,
      state: plan.state,
      hangoverMs,
      transcript,
      sttMs: tSttFinal - tEndpoint,
      partialsDuringSpeech: partialTimes.filter((t) => t <= tAcousticEnd).length,
      lastPartialLeadMs: partialTimes.length
        ? Math.max(...partialTimes) - tAcousticEnd
        : NaN,
      llmTtftMs: tFirstToken ? tFirstToken - tLlmStart : NaN,
      llmFirstSpanMs: tFirstSpan ? tFirstSpan - tLlmStart : NaN,
      ttsTtfbMs,
      responseStartMs,
      llmRoundTrips,
      toolName: toolCall?.name,
      redFlagged: scan.flagged,
      escalationMs,
    };
  } finally {
    controller.abort();
  }
}

async function main(): Promise<void> {
  const providers = providersFromEnv();
  console.log(
    `providers: stt=${providers.stt.name}/${providers.stt.model}  ` +
      `llm=${providers.llm.name}/${providers.llm.model}  ` +
      `tts=${providers.tts.name}/${providers.tts.model}`
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
    console.error(
      `No fixtures in ${FIXTURE_DIR}.\nGenerate them with: npm run bench:fixtures -w threep-backend`
    );
    process.exit(1);
  }

  const results: TurnResult[] = [];
  let attempted = 0;

  for (const file of files) {
    const name = file.replace(/\.wav$/, "");
    const plan = PLANS[name];
    if (!plan) {
      console.warn(`skipping ${file}: no plan entry (add one to PLANS in latency.ts)`);
      continue;
    }

    const pcm = resample(readWav(await readFile(join(FIXTURE_DIR, file))), PIPELINE_SAMPLE_RATE);
    const seconds = (pcm.samples.length / PIPELINE_SAMPLE_RATE).toFixed(2);
    process.stdout.write(`${name} (${seconds}s, ${plan.state}, hangover ${HANGOVER_MS[plan.state]}ms) `);

    for (let i = 0; i < ITERATIONS; i++) {
      if (TURN_DELAY_MS > 0 && attempted > 0) await sleep(TURN_DELAY_MS);
      attempted++;
      try {
        results.push(await runTurn(providers, name, pcm.samples, plan));
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

  console.log("\n\nPER-HOP (ms, p50 / p95)\n");
  const rows: string[][] = [];
  for (const [fixture, list] of byFixture) {
    const col = (pick: (r: TurnResult) => number) => {
      const s = summarize(list.map(pick));
      return `${ms(s.p50)} / ${ms(s.p95)}`;
    };
    const trips = summarize(list.map((r) => r.llmRoundTrips));
    // Spoke/attempted, not just a percentile. A turn where the model returned no text is
    // dropped from every latency column above, so without this the row silently reports
    // the timing of whichever turns happened to speak and gives no hint that others did
    // not — which is exactly how a prompt/tool mismatch hides as a good-looking number.
    const spoke = summarize(list.map((r) => r.responseStartMs)).n;
    rows.push([
      fixture,
      String(list[0]!.hangoverMs),
      col((r) => r.sttMs),
      col((r) => r.llmTtftMs),
      col((r) => r.ttsTtfbMs),
      trips.p50 >= 2 ? "2" : "1",
      `${spoke}/${list.length}`,
      col((r) => r.responseStartMs),
    ]);
  }
  console.log(
    renderTable(
      ["fixture", "hangover", "STT", "LLM ttft", "TTS ttfb", "trips", "spoke", "RESPONSE START"],
      rows
    )
  );

  const silent = results.length - summarize(results.map((r) => r.responseStartMs)).n;
  if (silent > 0) {
    console.log(
      `\nWARNING: ${silent}/${results.length} turns produced NO SPEECH and are absent from every\n` +
        "  latency figure above. If tools were withheld (BENCH_NO_TOOLS=1), suspect the harness\n" +
        "  before the model: instructionsFor() mandates tool calls, so a tool-free run asks for\n" +
        "  something impossible and an empty completion is a reasonable response to that."
    );
  }

  // Every turn now carries a response-start figure, including the ones that had to run a
  // tool first. An earlier version of this harness excluded those, which flattered the
  // result badly: with some models a tool call is what happens on nearly every turn.
  console.log("\n\nHEADLINE — acoustic end of speech to first audible sample\n");
  const all = summarize(results.map((r) => r.responseStartMs));
  const oneTrip = summarize(
    results.filter((r) => r.llmRoundTrips === 1).map((r) => r.responseStartMs)
  );
  const twoTrip = summarize(
    results.filter((r) => r.llmRoundTrips >= 2).map((r) => r.responseStartMs)
  );
  console.log(
    renderTable(
      ["", "p50", "p95", "min", "max", "n"],
      [
        ["all turns", ms(all.p50), ms(all.p95), ms(all.min), ms(all.max), String(all.n)],
        ["spoke directly", ms(oneTrip.p50), ms(oneTrip.p95), ms(oneTrip.min), ms(oneTrip.max), String(oneTrip.n)],
        ["tool call first", ms(twoTrip.p50), ms(twoTrip.p95), ms(twoTrip.min), ms(twoTrip.max), String(twoTrip.n)],
      ]
    )
  );

  const escalations = results.filter((r) => r.redFlagged);
  if (escalations.length > 0) {
    const esc = summarize(escalations.map((r) => r.escalationMs));
    console.log(
      `\nescalation path (LLM skipped, pre-rendered audio): p50 ${ms(esc.p50)}ms  p95 ${ms(esc.p95)}ms  ` +
        `over ${esc.n} flagged turns`
    );
  }

  const toolTurns = results.filter((r) => r.llmRoundTrips >= 2);
  if (toolTurns.length > 0) {
    const names = [...new Set(toolTurns.map((r) => r.toolName))].join(", ");
    console.log(
      `\ntool-call turns: ${toolTurns.length}/${results.length} (${names}) — each cost a second ` +
        `LLM round trip before the patient heard anything.`
    );
  }

  // If the recognizer never emits a partial before the patient stops talking, it is not
  // streaming in any useful sense and the STT column above is full recognition cost, not a
  // tail. That distinction decides whether speculative LLM start is even possible.
  const streamed = summarize(results.map((r) => r.partialsDuringSpeech));
  console.log(
    `\nSTT streaming: p50 ${ms(streamed.p50)} partials arrived before the acoustic end ` +
      (streamed.p50 > 0
        ? "— the recognizer works ahead, so the STT column is tail cost only."
        : "— NOTHING arrived during speech, so the STT column is FULL recognition cost.")
  );

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
