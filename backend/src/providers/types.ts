/**
 * Provider seams for the cascaded voice pipeline: speech-to-text, language model,
 * text-to-speech.
 *
 * Two design rules, both load-bearing:
 *
 * 1. `AbortSignal` is a parameter on every streaming call rather than an afterthought.
 *    Barge-in means cancelling an in-flight generation mid-sentence, so cancellation is
 *    the core requirement of this interface, not an edge case. Making it a required
 *    argument means a call site cannot forget it.
 *
 * 2. Providers declare `baaCovered`. The clinical requirements call for a swappable
 *    provider layer so a BAA-covered endpoint can replace a direct one without a rewrite
 *    (ISO gap finding F-08). Declaring coverage on the provider lets that become a
 *    mechanical boot-time check rather than a documentation promise.
 */

/** Everything in this pipeline is mono PCM16 at this rate — OpenAI's realtime input and
 * speech output both use 24 kHz, so there is no resampling anywhere on the server. */
export const PIPELINE_SAMPLE_RATE = 24_000;

export interface ProviderInfo {
  readonly name: string;
  readonly model: string;
  /** Whether this endpoint is covered by a signed BAA/DPA. Prototype endpoints are not. */
  readonly baaCovered: boolean;
}

// ---------------------------------------------------------------------------
// Speech to text
// ---------------------------------------------------------------------------

export interface SttPartial {
  text: string;
  /** ms since the session opened, taken when the event was received. */
  atMs: number;
}

export interface SttFinal {
  text: string;
  atMs: number;
}

/**
 * A live transcription stream. Audio is pushed in as it is captured; partials arrive
 * continuously and a final arrives once the turn is committed.
 *
 * `commit()` exists because endpointing is a policy decision the caller owns, not the
 * provider. The benchmark drives it from a fixture's known acoustic end so that
 * `T_endpoint` is measured rather than inherited from a vendor default.
 */
export interface SttSession {
  /** Push one frame of mono PCM16 at `PIPELINE_SAMPLE_RATE`. */
  push(pcm: Int16Array): void;
  /** Declare the turn over and ask for a final transcript. */
  commit(): void;
  close(): void;
  onPartial(cb: (p: SttPartial) => void): void;
  onFinal(cb: (f: SttFinal) => void): void;
  onError(cb: (e: Error) => void): void;
  /** Resolves with the first final transcript after `commit()`. */
  nextFinal(): Promise<SttFinal>;
}

export interface SttProvider extends ProviderInfo {
  open(opts: { signal: AbortSignal }): Promise<SttSession>;
}

// ---------------------------------------------------------------------------
// Language model
// ---------------------------------------------------------------------------

export interface LlmMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: { id: string; name: string; args: string }[];
}

export interface ChatToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type LlmDelta =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "done" };

export interface LlmProvider extends ProviderInfo {
  stream(req: {
    /** `instructionsFor(state)` — the state's policy prompt. */
    system: string;
    messages: LlmMessage[];
    tools: ChatToolSchema[];
    signal: AbortSignal;
  }): AsyncIterable<LlmDelta>;
}

// ---------------------------------------------------------------------------
// Text to speech
// ---------------------------------------------------------------------------

export interface TtsProvider extends ProviderInfo {
  readonly sampleRate: number;
  /**
   * Streams mono PCM16 for one span of text.
   *
   * Note this is a *request* per span, not an input-streaming session: OpenAI's speech
   * endpoint accepts a complete string and has no way to append to an in-flight
   * synthesis. The consequence is that every sentence pays time-to-first-byte again and
   * prosody resets at each boundary. Pipelining hides the latency after the first
   * sentence — synthesis of sentence N+1 overlaps playback of sentence N — but the seams
   * are audible and are a real cost of the single-vendor choice.
   */
  stream(req: { text: string; signal: AbortSignal }): AsyncIterable<Int16Array>;
}

export interface ProviderSet {
  stt: SttProvider;
  llm: LlmProvider;
  tts: TtsProvider;
}
