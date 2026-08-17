import { groqLlm, groqStt, groqTts } from "./groq/index.js";
import { localLlm, localStt, localTts } from "./local/index.js";
import { openAiLlm } from "./openai/llm.js";
import { openAiStt } from "./openai/stt.js";
import { openAiTts } from "./openai/tts.js";
import type { LlmProvider, ProviderSet, SttProvider, TtsProvider } from "./types.js";

export * from "./types.js";

/**
 * Provider selection, one hop at a time.
 *
 * Fixed bundles ("the fast profile", "the compliant profile") were the obvious design and
 * the wrong one. Stage 1 showed the cost is not spread evenly — text-to-speech alone
 * consumed more than the entire budget while the language model was merely disappointing —
 * so the question worth answering is per-hop: *which* substitution buys the most, for how
 * much added supplier risk? Bundles cannot express that. Per-hop selection can:
 *
 *     VOICE_STT=groq VOICE_LLM=local VOICE_TTS=openai npm run bench -w threep-backend
 *
 * `VOICE_PROFILE` still sets all three at once as a shorthand.
 */

export type ProviderName = "openai" | "groq" | "local";

const STT: Record<ProviderName, () => SttProvider> = {
  openai: openAiStt,
  groq: groqStt,
  local: localStt,
};
const LLM: Record<ProviderName, () => LlmProvider> = {
  openai: openAiLlm,
  groq: groqLlm,
  local: localLlm,
};
const TTS: Record<ProviderName, () => TtsProvider> = {
  openai: openAiTts,
  groq: groqTts,
  local: localTts,
};

function pick<T>(table: Record<ProviderName, () => T>, envVar: string, fallback: string): T {
  const name = (process.env[envVar] ?? fallback) as ProviderName;
  const make = table[name];
  if (!make) {
    throw new Error(
      `Unknown provider "${name}" for ${envVar}. Available: ${Object.keys(table).join(", ")}`
    );
  }
  return make();
}

export function providersFromEnv(): ProviderSet {
  const profile = process.env.VOICE_PROFILE ?? "openai";
  return {
    stt: pick(STT, "VOICE_STT", profile),
    llm: pick(LLM, "VOICE_LLM", profile),
    tts: pick(TTS, "VOICE_TTS", profile),
  };
}

/**
 * Refuses to run uncovered providers once real patient data is in play. A compliance rule
 * that is only written down is a rule that gets forgotten during a demo; expressed as a
 * boot-time failure it cannot be.
 */
export function assertPhiSafe(set: ProviderSet): void {
  if (process.env.PHI_MODE !== "true") return;
  const uncovered = (Object.entries(set) as [string, { name: string; model: string; baaCovered: boolean }][])
    .filter(([, p]) => !p.baaCovered)
    .map(([hop, p]) => `${hop} (${p.name}/${p.model})`);
  if (uncovered.length > 0) {
    throw new Error(
      `PHI_MODE is on but these providers are not BAA-covered: ${uncovered.join(", ")}`
    );
  }
}
