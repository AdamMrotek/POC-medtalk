import { compatLlm } from "../openaiCompat.js";
import type { LlmProvider } from "../types.js";

/**
 * Streaming chat completions.
 *
 * Streaming is not optional here. Time-to-first-token is what the patient experiences;
 * total completion time is not, because the first sentence is handed to speech synthesis
 * while the rest is still being generated.
 */
export function openAiLlm(): LlmProvider {
  return compatLlm({
    name: "openai",
    model: process.env.OPENAI_LLM_MODEL ?? "gpt-4o-mini",
    baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    apiKey: requireApiKey(),
    baaCovered: false,
  });
}

function requireApiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set.");
  return key;
}
