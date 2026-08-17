import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { readWav, resample, writeWav } from "../../audio/wav.js";

/** whisper.cpp is hard-wired to this rate. */
const WHISPER_SAMPLE_RATE = 16_000;
import { batchStt, postTranscription } from "../batchStt.js";
import { compatLlm, compatTts } from "../openaiCompat.js";
import { PIPELINE_SAMPLE_RATE, type LlmProvider, type SttProvider, type TtsProvider } from "../types.js";

const run = promisify(execFile);

/**
 * Fully local inference. No third party sees patient audio, so this is the only
 * configuration that is trivially PHI-safe — no BAA to negotiate, no sub-processor list,
 * no residency determination, nothing to exclude from a data-flow diagram.
 *
 * Whether it is *fast enough* is the open question, and the whole reason to measure it
 * rather than assume. A warm local model has no network leg at all, which on the LLM hop
 * turns out to matter more than raw parameter count.
 */

// ---------------------------------------------------------------------------
// LLM — Ollama, via its OpenAI-compatible surface
// ---------------------------------------------------------------------------

export function localLlm(): LlmProvider {
  return compatLlm({
    name: "local",
    model: process.env.LOCAL_LLM_MODEL ?? "qwen3:4b",
    baseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1",
    apiKey: "ollama", // required by the shape, ignored by the server
    // Nothing leaves the machine, so there is no processor to cover.
    baaCovered: true,
  });
}

// ---------------------------------------------------------------------------
// STT — a local OpenAI-compatible server, or a whisper.cpp binary
// ---------------------------------------------------------------------------

export function localStt(): SttProvider {
  const model = process.env.LOCAL_STT_MODEL ?? "whisper-large-v3-turbo";
  const url = process.env.LOCAL_STT_URL;
  const binary = process.env.LOCAL_STT_BIN ?? "whisper-cli";
  const weights = process.env.LOCAL_STT_WEIGHTS;

  return batchStt({
    name: "local",
    model: url ? model : `${binary}${weights ? ` (${weights})` : ""}`,
    baaCovered: true,

    async transcribe(wav, signal) {
      // whisper.cpp accepts 16 kHz only and rejects anything else outright, so the turn is
      // downsampled here rather than at the pipeline level — the rest of the system runs at
      // 24 kHz because that is what the cloud providers speak.
      const at16k = writeWav(resample(readWav(wav), WHISPER_SAMPLE_RATE));

      // A local server that speaks the OpenAI shape (whisper.cpp --server, speaches, …).
      // Strongly preferred over the CLI: the server keeps the model resident, while
      // spawning the binary per turn reloads weights every single time.
      if (url) {
        return postTranscription({ url, apiKey: undefined, model, wav: at16k, signal });
      }

      if (!weights) {
        throw new Error(
          "Local STT needs either LOCAL_STT_URL (an OpenAI-compatible endpoint) or " +
            "LOCAL_STT_WEIGHTS (a whisper.cpp .bin model path)."
        );
      }

      const dir = await mkdtemp(join(tmpdir(), "threepio-stt-"));
      try {
        const input = join(dir, "turn.wav");
        await writeFile(input, at16k);
        // -nt strips timestamps; whisper.cpp writes <input>.txt beside the input.
        await run(binary, ["-m", weights, "-f", input, "-otxt", "-nt"], { signal });
        return (await readFile(`${input}.txt`, "utf8")).trim();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  });
}

// ---------------------------------------------------------------------------
// TTS — Piper if configured, otherwise the macOS system voice
// ---------------------------------------------------------------------------

export function localTts(): TtsProvider {
  const piperModel = process.env.PIPER_MODEL;
  const sayVoice = process.env.LOCAL_TTS_VOICE ?? "Samantha";
  const url = process.env.LOCAL_TTS_URL;

  // A resident local server (Kokoro, Piper HTTP, …) speaking the OpenAI shape. Strongly
  // preferred: the alternatives below spawn a process per utterance, so they pay model
  // load on every single turn.
  if (url) {
    return compatTts({
      name: "local",
      model: process.env.LOCAL_TTS_MODEL ?? "kokoro-82m",
      baseUrl: url,
      apiKey: undefined,
      baaCovered: true,
      voice: process.env.LOCAL_TTS_VOICE ?? "af_heart",
      sampleRate: PIPELINE_SAMPLE_RATE,
      responseFormat: "pcm",
      requestStreamFormat: false,
    });
  }

  return {
    name: "local",
    model: piperModel ? `piper (${piperModel})` : `say (${sayVoice})`,
    baaCovered: true,
    sampleRate: PIPELINE_SAMPLE_RATE,

    async *stream({ text, signal }): AsyncIterable<Int16Array> {
      const dir = await mkdtemp(join(tmpdir(), "threepio-tts-"));
      const out = join(dir, "speech.wav");
      try {
        if (piperModel) {
          await run(process.env.PIPER_BIN ?? "piper", ["-m", piperModel, "-f", out], {
            signal,
            input: text,
          } as never);
        } else {
          await run("say", ["-o", out, "--data-format=LEI16@24000", "-v", sayVoice, text], {
            signal,
          });
        }

        // Neither backend streams: the file only exists once synthesis is finished, so
        // time-to-first-byte here is really time-to-*complete*. That is a genuine
        // disadvantage against a streaming cloud voice and the benchmark should show it
        // as such rather than flattering it.
        const pcm = resample(readWav(await readFile(out)), PIPELINE_SAMPLE_RATE);
        yield pcm.samples;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
