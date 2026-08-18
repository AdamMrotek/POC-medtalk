/**
 * Go/no-go probe for Orpheus-TTS-on-Ollama.
 *
 * Orpheus emits SNAC codec tokens, not audio: 7 tokens per frame, 12.5 frames/sec of
 * speech, so ~87.5 tok/s is the break-even with realtime. Below that the decoder starves
 * and the utterance takes longer to synthesize than it takes to play, which no amount of
 * plumbing downstream can fix. This measures the generation rate alone — no SNAC decoder,
 * no HTTP server, nothing built — because if the rate is under break-even none of that is
 * worth writing.
 */

const MODEL = process.env.ORPHEUS_MODEL ?? "legraphista/Orpheus:latest";
const BASE = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
const VOICE = process.env.ORPHEUS_VOICE ?? "tara";
const ITERATIONS = Number(process.env.ITERATIONS ?? 3);

const TOKENS_PER_FRAME = 7;
const FRAMES_PER_SECOND = 12.5;
const REALTIME_TOKENS_PER_SEC = TOKENS_PER_FRAME * FRAMES_PER_SECOND; // 87.5
/** Orpheus-FastAPI decodes on a sliding window and cannot emit until 4 frames exist. */
const TOKENS_BEFORE_FIRST_AUDIO = TOKENS_PER_FRAME * 4;

/** Lines the assistant actually says, taken from the benchmark's response shapes. */
const TEXTS = [
  { name: "short", text: "Yes, that's right." },
  {
    name: "verification",
    text: "Great, thank you. For privacy I need to confirm a couple of details. Could you please tell me your date of birth?",
  },
  {
    name: "intake",
    text: "I'm sorry to hear that. Can you tell me when the headache started, and whether anything makes it worse?",
  },
];

/**
 * Orpheus wants the voice name inline and the audio-start control tokens appended, so the
 * request goes through /api/generate with raw:true — Ollama's chat template would wrap
 * this in an instruct format the model was never finetuned against, and the model would
 * answer the text rather than speak it.
 */
function prompt(text) {
  return `<custom_token_3><|begin_of_text|>${VOICE}: ${text}<|eot_id|><custom_token_4><custom_token_5><custom_token_1>`;
}

async function measure(text) {
  const started = performance.now();
  let firstTokenAt = null;
  let firstAudioAt = null;
  let tokens = 0;
  let audioTokens = 0;
  let sample = "";
  let final = null;

  const res = await fetch(`${BASE}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      prompt: prompt(text),
      raw: true,
      stream: true,
      options: { temperature: 0.6, top_p: 0.9, num_predict: 1200 },
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);

  let buffered = "";
  for await (const chunk of res.body) {
    buffered += Buffer.from(chunk).toString("utf8");
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.response) {
        tokens += 1;
        firstTokenAt ??= performance.now() - started;
        if (sample.length < 200) sample += msg.response;
        // Count only real SNAC tokens: prose here means the prompt format is wrong and
        // the throughput number would be measuring the wrong thing entirely.
        const matches = msg.response.match(/<custom_token_\d+>/g);
        if (matches) {
          audioTokens += matches.length;
          if (audioTokens >= TOKENS_BEFORE_FIRST_AUDIO && firstAudioAt === null) {
            firstAudioAt = performance.now() - started;
          }
        }
      }
      if (msg.done) final = msg;
    }
  }

  const wall = performance.now() - started;
  // eval_duration is nanoseconds of generation, excluding prefill and queueing.
  const evalTokensPerSec =
    final?.eval_count && final?.eval_duration
      ? final.eval_count / (final.eval_duration / 1e9)
      : null;

  return {
    wall,
    firstTokenAt,
    firstAudioAt,
    tokens,
    audioTokens,
    evalTokensPerSec,
    promptEvalMs: final?.prompt_eval_duration ? final.prompt_eval_duration / 1e6 : null,
    sample,
  };
}

const p = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const ms = (v) => (v === null || v === undefined ? "—" : `${Math.round(v)}`);

console.log(`model:  ${MODEL}`);
console.log(`voice:  ${VOICE}`);
console.log(`break-even: ${REALTIME_TOKENS_PER_SEC} tok/s (7 tokens/frame x 12.5 frames/s)\n`);

// One discarded pass so weights are resident; a cold load would be measured as slowness
// that no production turn would ever pay.
process.stdout.write("warming... ");
await measure("Warm up.");
console.log("done\n");

const rows = [];
for (const { name, text } of TEXTS) {
  const runs = [];
  for (let i = 0; i < ITERATIONS; i++) runs.push(await measure(text));

  const rates = runs.map((r) => r.evalTokensPerSec).filter((r) => r !== null);
  const rate = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null;
  const speechSeconds = runs[0].audioTokens / TOKENS_PER_FRAME / FRAMES_PER_SECOND;

  rows.push({ name, text, runs, rate, speechSeconds });

  console.log(`### ${name} — ${text.length} chars`);
  console.log(`  first token      ${ms(p(runs.map((r) => r.firstTokenAt), 0.5))} ms p50`);
  console.log(
    `  first audio      ${ms(p(runs.map((r) => r.firstAudioAt), 0.5))} ms p50   (28 SNAC tokens, before decode)`
  );
  console.log(`  full utterance   ${ms(p(runs.map((r) => r.wall), 0.5))} ms p50`);
  console.log(`  generation rate  ${rate ? rate.toFixed(1) : "—"} tok/s`);
  console.log(
    `  tokens           ${runs[0].tokens} total, ${runs[0].audioTokens} audio (~${speechSeconds.toFixed(2)}s of speech)`
  );
  if (runs[0].audioTokens === 0) {
    console.log(`  !! no SNAC tokens — model answered as text: ${JSON.stringify(runs[0].sample.slice(0, 120))}`);
  }
  console.log();
}

const overall = rows.map((r) => r.rate).filter(Boolean);
const meanRate = overall.reduce((a, b) => a + b, 0) / (overall.length || 1);
const realtimeFactor = meanRate / REALTIME_TOKENS_PER_SEC;

console.log("---");
console.log(`mean generation rate  ${meanRate.toFixed(1)} tok/s`);
console.log(`realtime factor       ${realtimeFactor.toFixed(2)}x  (>1.0 needed to keep up with playback)`);
console.log(
  realtimeFactor >= 1
    ? "VERDICT: keeps up with realtime — worth building the SNAC decoder and running the full path."
    : `VERDICT: below realtime — a ${rows[1]?.speechSeconds.toFixed(1) ?? "?"}s reply takes ~${(
        (rows[1]?.speechSeconds ?? 0) / realtimeFactor
      ).toFixed(1)}s to synthesize. Decoder work would not change this.`
);
