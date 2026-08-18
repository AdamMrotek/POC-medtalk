import { compatTts } from "../openaiCompat.js";
import { PIPELINE_SAMPLE_RATE, type TtsProvider } from "../types.js";

/**
 * Streaming text-to-speech.
 *
 * `response_format: "pcm"` rather than mp3/opus is deliberate: compressed formats add a
 * decode step before the first sample can play, and the browser jitter buffer wants raw
 * frames anyway. OpenAI returns headerless 16-bit signed little-endian mono at 24 kHz,
 * the same rate the transcription session consumes, so nothing is resampled server-side.
 *
 * `stream_format: "audio"` gives raw chunks over a chunked response, so time-to-first-byte
 * is simply the first chunk. Note that `speed` must be 1.0 (or omitted) when streaming.
 */
export function openAiTts(): TtsProvider {
  return compatTts({
    name: "openai",
    model: process.env.OPENAI_TTS_MODEL ?? "gpt-4o-mini-tts",
    baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    apiKey: requireApiKey(),
    baaCovered: false,
    voice: process.env.OPENAI_REALTIME_VOICE ?? "marin",
    sampleRate: PIPELINE_SAMPLE_RATE,
    responseFormat: "pcm",
    requestStreamFormat: true,
  });
}

function requireApiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set.");
  return key;
}
