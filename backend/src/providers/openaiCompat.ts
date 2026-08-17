import type { ChatToolSchema, LlmDelta, LlmMessage, LlmProvider, TtsProvider } from "./types.js";

/**
 * Chat and speech against any OpenAI-shaped endpoint.
 *
 * Groq, vLLM, LM Studio and OpenAI itself all speak this protocol, so the differences that
 * actually matter for the benchmark — which host, which model, which key — collapse to
 * configuration. That is the point of the exercise: the interesting question is not "does
 * a vendor work" but "what does each hop cost", and a shared implementation means a
 * measured difference is a difference in the *service*, not in our client code.
 */

export interface OpenAiCompatConfig {
  name: string;
  model: string;
  baseUrl: string;
  apiKey: string | undefined;
  baaCovered: boolean;
}

// ---------------------------------------------------------------------------
// Chat completions
// ---------------------------------------------------------------------------

export function compatLlm(cfg: OpenAiCompatConfig): LlmProvider {
  return {
    name: cfg.name,
    model: cfg.model,
    baaCovered: cfg.baaCovered,

    async *stream({ system, messages, tools, signal }): AsyncIterable<LlmDelta> {
      const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: "POST",
        signal,
        headers: {
          ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: cfg.model,
          stream: true,
          messages: [{ role: "system", content: system }, ...messages.map(toWireMessage)],
          ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
        }),
      });

      if (!res.ok || !res.body) {
        throw new Error(`${cfg.name} chat failed (${res.status}): ${await res.text()}`);
      }

      const pendingCalls = new Map<number, { id: string; name: string; args: string }>();

      for await (const event of sseEvents(res.body, signal)) {
        const choice = event.choices?.[0];
        if (!choice) continue;

        const text = choice.delta?.content;
        if (text) yield { type: "text", text };

        for (const call of choice.delta?.tool_calls ?? []) {
          const existing = pendingCalls.get(call.index) ?? { id: "", name: "", args: "" };
          pendingCalls.set(call.index, {
            id: call.id ?? existing.id,
            name: call.function?.name ?? existing.name,
            args: existing.args + (call.function?.arguments ?? ""),
          });
        }

        if (choice.finish_reason) {
          for (const call of pendingCalls.values()) {
            yield { type: "tool_call", id: call.id, name: call.name, args: safeParseArgs(call.args) };
          }
          pendingCalls.clear();
        }
      }

      yield { type: "done" };
    },
  };
}

// ---------------------------------------------------------------------------
// Speech
// ---------------------------------------------------------------------------

export interface CompatTtsConfig extends OpenAiCompatConfig {
  voice: string;
  sampleRate: number;
  /** `pcm` where the host supports it; `wav` for hosts that don't (the header is stripped). */
  responseFormat: "pcm" | "wav";
  /** Only OpenAI documents `stream_format`; sending it elsewhere can 400. */
  requestStreamFormat: boolean;
}

export function compatTts(cfg: CompatTtsConfig): TtsProvider {
  return {
    name: cfg.name,
    model: cfg.model,
    baaCovered: cfg.baaCovered,
    sampleRate: cfg.sampleRate,

    async *stream({ text, signal }): AsyncIterable<Int16Array> {
      const res = await fetch(`${cfg.baseUrl}/audio/speech`, {
        method: "POST",
        signal,
        headers: {
          ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: cfg.model,
          voice: cfg.voice,
          input: text,
          response_format: cfg.responseFormat,
          ...(cfg.requestStreamFormat ? { stream_format: "audio" } : {}),
        }),
      });

      if (!res.ok || !res.body) {
        throw new Error(`${cfg.name} speech failed (${res.status}): ${await res.text()}`);
      }

      const reader = res.body.getReader();
      let carry: number | null = null;
      let headerToSkip = cfg.responseFormat === "wav" ? 44 : 0;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done || !value) break;
          let bytes: Uint8Array = value;

          if (headerToSkip > 0) {
            const drop = Math.min(headerToSkip, bytes.length);
            headerToSkip -= drop;
            bytes = bytes.subarray(drop);
            if (bytes.length === 0) continue;
          }

          if (carry !== null) {
            const joined = new Uint8Array(bytes.length + 1);
            joined[0] = carry;
            joined.set(bytes, 1);
            bytes = joined;
            carry = null;
          }
          if (bytes.length % 2 === 1) {
            carry = bytes[bytes.length - 1]!;
            bytes = bytes.subarray(0, bytes.length - 1);
          }
          if (bytes.length === 0) continue;

          const samples = new Int16Array(bytes.length / 2);
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true);
          yield samples;
        }
      } finally {
        reader.cancel().catch(() => {});
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

function toWireMessage(m: LlmMessage) {
  if (m.role === "tool") {
    return { role: "tool" as const, tool_call_id: m.toolCallId, content: m.content };
  }
  if (m.role === "assistant" && m.toolCalls?.length) {
    return {
      role: "assistant" as const,
      content: m.content || null,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: "function" as const,
        function: { name: c.name, arguments: c.args },
      })),
    };
  }
  return { role: m.role, content: m.content };
}

/** Model output is untrusted; a malformed argument blob must not take down the turn. */
function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

interface ChatChunk {
  choices?: {
    delta?: {
      content?: string;
      tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string | null;
  }[];
}

async function* sseEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal
): AsyncIterable<ChatChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let split: number;
      while ((split = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") return;
          try {
            yield JSON.parse(payload) as ChatChunk;
          } catch {
            // Partial frame across a chunk boundary; the next read completes it.
          }
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}
