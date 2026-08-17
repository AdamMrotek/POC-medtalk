import { batchStt, postTranscription } from "../batchStt.js";
import { compatLlm, compatTts } from "../openaiCompat.js";
import { PIPELINE_SAMPLE_RATE, type LlmProvider, type SttProvider, type TtsProvider } from "../types.js";

/**
 * Groq. OpenAI-compatible across all three hops, so only configuration differs.
 *
 * The reason to try it is inference speed on the hops where Stage 1 showed OpenAI losing
 * time — but note that its transcription endpoint is batch-only. Given the measured
 * finalize tail, that may be a feature rather than a limitation here.
 */

const BASE_URL = process.env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1";

function apiKey(): string {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY is not set.");
  return key;
}

export function groqStt(): SttProvider {
  const model = process.env.GROQ_STT_MODEL ?? "whisper-large-v3-turbo";
  return batchStt({
    name: "groq",
    model,
    baaCovered: false,
    transcribe: (wav, signal) =>
      postTranscription({
        url: `${BASE_URL}/audio/transcriptions`,
        apiKey: apiKey(),
        model,
        wav,
        signal,
      }),
  });
}

export function groqLlm(): LlmProvider {
  return compatLlm({
    name: "groq",
    // Groq deprecates both Llama models on 2026-08-16. Of the replacements, the *smallest*
    // is not the right default despite winning on p50: gpt-oss-20b invents `verify_identity`
    // arguments out of nothing on a plain "yes", and a fabricated attempt burns one of three
    // before the call locks. 120b is measurably safer on the same prompt and has the better
    // p95; qwen3.6-27b reasons before tool calls and doubles the worst case.
    model: process.env.GROQ_LLM_MODEL ?? "openai/gpt-oss-120b",
    baseUrl: BASE_URL,
    apiKey: apiKey(),
    baaCovered: false,
  });
}

export function groqTts(): TtsProvider {
  return compatTts({
    name: "groq",
    model: process.env.GROQ_TTS_MODEL ?? "canopylabs/orpheus-v1-english",
    baseUrl: BASE_URL,
    apiKey: apiKey(),
    baaCovered: false,
    voice: process.env.GROQ_TTS_VOICE ?? "troy",
    sampleRate: PIPELINE_SAMPLE_RATE,
    // Groq documents wav, not pcm, and does not document stream_format — asking for either
    // is a 400 rather than a graceful fallback, so the WAV header is stripped instead.
    responseFormat: "wav",
    requestStreamFormat: false,
  });
}
