/**
 * LiveKit voice agent — the simplest cascaded architecture that meets the requirements in
 * docs/voice-architecture.md.
 *
 * Transport is WebRTC into a LiveKit room, so echo cancellation, jitter buffering and
 * barge-in come from the transport rather than from code we maintain. What remains here is
 * only the part that is actually ours: the state machine, the red-flag gate, and tool
 * adjudication — all reused unchanged from the existing backend.
 *
 * Providers are all Groq by default (Option B), because that needs no infrastructure to
 * stand up. Every hop is an OpenAI-compatible base URL, so swapping any one of them for a
 * local server is an env change, not a code change. See "Switching providers" at the bottom.
 *
 * Run:
 *   npm run agent:dev -w threep-backend      # console mode, no browser needed
 *   npm run agent -w threep-backend          # connects to LiveKit and waits for rooms
 */

import {
  Agent,
  AgentSession,
  AgentSessionEventTypes,
  ServerOptions,
  StopResponse,
  cli,
  defineAgent,
  llm,
  type JobContext,
} from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";
import * as silero from "@livekit/agents-plugin-silero";
import * as turnDetector from "@livekit/agents-plugin-livekit";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { isClosing, type ConversationState } from "@threepio/shared";
import { instructionsFor } from "../policy/instructions.js";
import { emergencyClosing } from "../policy/blocks.js";
import { runSafetyCheck, runTool } from "../runtime.js";
import { createSession, getRecord } from "../intakeStore.js";

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------
//
// Groq is OpenAI-compatible on all three hops, so the openai plugin covers everything with
// a base URL override. There is no dedicated Groq plugin and none is needed.

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const groqKey = () => process.env.GROQ_API_KEY ?? "";

function buildStt() {
  if (process.env.VOICE_STT === "local") {
    // whisper-server, or any OpenAI-compatible /v1/audio/transcriptions endpoint.
    return new openai.STT({
      baseURL: process.env.LOCAL_STT_URL,
      apiKey: "not-needed",
      model: process.env.LOCAL_STT_MODEL ?? "whisper-1",
    });
  }
  return new openai.STT({
    baseURL: GROQ_BASE_URL,
    apiKey: groqKey(),
    model: process.env.GROQ_STT_MODEL ?? "whisper-large-v3-turbo",
  });
}

function buildLlm() {
  return new openai.LLM({
    baseURL: GROQ_BASE_URL,
    apiKey: groqKey(),
    // Pinned by safety, not speed: gpt-oss-20b fabricates verify_identity arguments and
    // three fabrications lock the call. See docs/voice-architecture.md §R-5.
    model: process.env.GROQ_LLM_MODEL ?? "openai/gpt-oss-120b",
    temperature: 0.3,
  });
}

function buildTts() {
  if (process.env.VOICE_TTS === "local") {
    // backend/tools/kokoro_server.py already serves /v1/audio/speech.
    return new openai.TTS({
      baseURL: process.env.LOCAL_TTS_URL,
      apiKey: "not-needed",
      model: "kokoro",
      voice: process.env.LOCAL_TTS_VOICE ?? "af_heart",
    });
  }
  return new openai.TTS({
    baseURL: GROQ_BASE_URL,
    apiKey: groqKey(),
    model: process.env.GROQ_TTS_MODEL ?? "canopylabs/orpheus-v1-english",
    voice: process.env.GROQ_TTS_VOICE ?? "tara",
  });
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
//
// These do not reimplement anything. Each one calls runTool(), which is the same
// adjudicated path the HTTP route uses: it checks isToolAllowed() for the current state,
// applies the state transition, and enforces MAX_VERIFICATION_ATTEMPTS. The model proposes;
// runTool decides.

function buildTools(sessionId: string) {
  const dispatch = (name: string) => async (args: Record<string, unknown>) => {
    const result = runTool(name, args, sessionId);
    if (!result.ok) return `REJECTED: ${result.error}`;
    return JSON.stringify(result.value);
  };

  return {
    verify_identity: llm.tool({
      description:
        "Verify the patient's identity. Call only once you have BOTH their date of birth and the last three digits of their phone number.",
      parameters: z.object({
        dateOfBirth: z.string().describe("Date of birth as YYYY-MM-DD, exactly as the patient stated it"),
        phoneLast3: z.string().describe("The last three digits of their phone number"),
      }),
      execute: async (args) => dispatch("verify_identity")(args),
    }),

    update_intake: llm.tool({
      description: "Record intake fields the patient has just described.",
      parameters: z.object({
        fields: z.record(z.string()).describe("Intake fields to merge into the record"),
      }),
      execute: async (args) => dispatch("update_intake")(args),
    }),

    flag_emergency: llm.tool({
      description: "Escalate immediately when the patient reports a red-flag symptom.",
      parameters: z.object({
        reason: z.string().describe("The red-flag symptom the patient stated, in their words"),
      }),
      execute: async (args) => dispatch("flag_emergency")(args),
    }),

    request_reschedule: llm.tool({
      description: "The patient asked to be called back another time.",
      parameters: z.object({
        reason: z.string().optional(),
      }),
      execute: async (args) => dispatch("request_reschedule")(args),
    }),
  };
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();

    // The intake store mints its own session id, so the record and its audit trail are
    // created exactly as they are on the HTTP path — nothing about the store changes.
    const record = createSession();
    const sessionId = record.sessionId;
    let state: ConversationState = record.state;

    const agent = Agent.create({
      instructions: instructionsFor(state),
      tools: buildTools(sessionId),

      /**
       * THE SAFETY GATE (docs/voice-architecture.md §R-2).
       *
       * This runs after the user's turn is committed to the chat context and BEFORE the
       * reply is released. Throwing StopResponse prevents the LLM reply entirely — this is
       * control flow, not a race, which is the property the Realtime path cannot offer.
       *
       * It also composes correctly with preemptive generation: mutating the chat context
       * here causes any speculative response to be discarded and regenerated, and
       * StopResponse discards it outright. Nothing speculative is ever spoken, because
       * preemptiveTts is off (the default) — audio waits for turn confirmation, which
       * happens after this hook returns.
       */
      onUserTurnCompleted: async (_hookCtx, _chatCtx, newMessage) => {
        const text = newMessage.textContent ?? "";
        if (!text.trim()) throw new StopResponse(); // empty turn, nothing to answer

        const check = runSafetyCheck(sessionId, text);
        if (check.ok && check.value.flagged) {
          // Escalate on our terms. The LLM is never called for this turn.
          // runSafetyCheck has already moved the record to `alert`.
          state = "alert";
          await agent.updateInstructions(instructionsFor(state));
          await session.say(emergencyClosing, { allowInterruptions: false });
          throw new StopResponse();
        }
      },

      // Keep instructions in step with the state machine after each tool call.
      onEnter: async () => {
        session.on(AgentSessionEventTypes.FunctionToolsExecuted, () => {
          const current = getRecord(sessionId);
          if (current && current.state !== state) {
            state = current.state;
            void agent.updateInstructions(instructionsFor(state));
            if (isClosing(state)) session.interrupt();
          }
        });
      },
    });

    const session = new AgentSession({
      stt: buildStt(),
      llm: buildLlm(),
      tts: buildTts(),
      vad: await silero.VAD.load(),

      turnHandling: {
        /**
         * Semantic endpointing. The turn detector predicts end-of-turn from meaning as well
         * as silence, which is a better answer to §R-4 than any fixed hangover: "It
         * started... [thinks] ...maybe Tuesday" reads as unfinished to a model and as
         * finished to a timer.
         */
        turnDetection: new turnDetector.MultilingualModel(),

        /**
         * minDelay is the floor the detector cannot go below. Keep it at the clinically
         * safe value — this is NOT where speculation is configured. Lowering it to 300ms to
         * "go faster" is the mistake §R-4 exists to prevent: it clips patients mid-symptom,
         * and the clipped clause is sometimes the red flag itself.
         */
        endpointing: {
          mode: "dynamic",
          minDelay: Number(process.env.ENDPOINT_MIN_DELAY_MS ?? 700),
          maxDelay: Number(process.env.ENDPOINT_MAX_DELAY_MS ?? 3000),
        },

        /**
         * THE SPECULATION. This is where latency is won, not in endpointing.
         *
         * The LLM fires as soon as a transcript arrives, overlapping inference with the
         * endpointing wait — so the ~700ms hangover stops being dead time and becomes an
         * overlap window. Expected saving is roughly the LLM's time-to-first-token.
         *
         * preemptiveTts stays FALSE (the default). With it off, audio is not synthesised
         * until the turn is confirmed, which is what keeps the safety gate above ahead of
         * anything the patient can hear. Turning it on trades that ordering for ~200ms.
         *
         * KNOWN HAZARD — verify before shipping: livekit/agents-js#1365 reports that
         * preemptive generation does not check in-flight function tool execution. Our
         * verify_identity burns an attempt toward MAX_VERIFICATION_ATTEMPTS, so a
         * speculative dispatch that is later discarded could lock a patient out of their own
         * intake. Test this explicitly (see agent.test.ts) and set enabled:false for the
         * verification state if it reproduces.
         */
        preemptiveGeneration: {
          enabled: process.env.PREEMPTIVE_GENERATION !== "false",
          preemptiveTts: false,
          maxRetries: 3,
        },

        /**
         * Barge-in (§R-7). resumeFalseInterruption is the framework's version of
         * duck-before-stop: a cough costs a moment of quiet, not a destroyed turn.
         * Escalation is made uninterruptible at the call site via allowInterruptions:false.
         */
        interruption: {
          enabled: true,
          mode: "adaptive",
          minDuration: 300,
          resumeFalseInterruption: true,
        },
      },
    });

    await session.start({ agent, room: ctx.room });
    await session.say(
      "Hello, you're through to the headache intake assistant. I'll ask a few questions before your appointment.",
    );
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));

// ---------------------------------------------------------------------------
// Switching providers
// ---------------------------------------------------------------------------
//
//   all Groq (default)     — no infrastructure, all audio leaves
//   VOICE_STT=local        — whisper-server; patient audio stays on our infrastructure
//   VOICE_TTS=local        — kokoro_server.py; synthesis stays too
//
// Both local servers already speak the OpenAI shape, so they attach through the same
// openai plugin with a base URL. Running both is Option C in docs/voice-architecture.md:
// only the transcript reaches a vendor.
//
// Prompt caching: Groq caches identical prefixes for ~2h at half price, and cached tokens
// do NOT count against the rate limit. instructionsFor(state) is byte-identical per state
// and sits first in the context, so every turn after the first in a given state hits the
// cache. Do not interpolate anything variable (names, timestamps, record contents) into the
// instruction block or the prefix changes and the cache misses on every turn.
