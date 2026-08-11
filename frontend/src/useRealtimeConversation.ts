import { useCallback, useRef, useState } from "react";
import {
  CLOSING_STATES,
  INITIAL_STATE,
  type ConversationState,
  type EmergencyFlag,
  type IntakeRecord,
  type SafetyCheckResponse,
  type SessionUpdate,
  type ToolResponse,
} from "@threepio/shared";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:3001";

export type ConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  /** Closing state reached; holding the line open only until the farewell finishes. */
  | "ending"
  | "ended"
  | "error";

/**
 * Every state where the agent has no move left ends the call — `alert` included, once the
 * 911 message has been spoken.
 */
const AUTO_END_STATES: readonly ConversationState[] = CLOSING_STATES;

/** Beat after the last audio drains, so the hangup doesn't clip the assistant's tail. */
const HANGUP_GRACE_MS = 800;

/** Backstop for when the closing turn emits no audio, or its buffer event never lands. */
const HANGUP_MAX_WAIT_MS = 20_000;

export interface TranscriptTurn {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  /** The conversation state that was active when this turn happened. */
  stage: ConversationState;
}

interface RealtimeEvent {
  type: string;
  [key: string]: unknown;
}

export interface DataChannelLogEntry {
  id: string;
  direction: "in" | "out";
  type: string;
  payload: unknown;
  timestamp: number;
  /** For collapsed delta streaks: number of chunks folded into this entry. */
  count?: number;
  /** Distinct delta subtypes folded into a streak entry (e.g. output_audio, output_audio_transcript). */
  deltaTypes?: string[];
}

const MAX_DC_LOG_ENTRIES = 300;

// Streaming responses fire a flood of small ".delta" events (audio bytes, transcript
// text, function-call args, ...), often interleaved. They're noise individually, so any
// consecutive run of delta events — regardless of exact subtype — folds into one running
// counter card until a non-delta event breaks the streak.
const isDeltaEventType = (type: string) => type.endsWith(".delta");
const MAX_LOGGED_STRING_LENGTH = 200;

function truncateLargeStrings(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > MAX_LOGGED_STRING_LENGTH
      ? `${value.slice(0, MAX_LOGGED_STRING_LENGTH)}… (${value.length} chars)`
      : value;
  }
  if (Array.isArray(value)) {
    return value.map(truncateLargeStrings);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, truncateLargeStrings(v)])
    );
  }
  return value;
}

/**
 * Presentation rule, not a state rule: for these states the tool marker is what opens the
 * stage, so it moves into the new group rather than staying with the previous one.
 */
const MARKER_OPENS_STAGE: readonly ConversationState[] = ["alert", "reschedule", "locked"];

/**
 * Drives the realtime call. The backend owns conversation state entirely — this hook
 * never decides a transition, it reports what the server says and relays the session
 * config the server issues.
 */
export function useRealtimeConversation() {
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [intakeRecord, setIntakeRecord] = useState<IntakeRecord | null>(null);
  const [emergency, setEmergency] = useState<EmergencyFlag | null>(null);
  const [dataChannelLog, setDataChannelLog] = useState<DataChannelLogEntry[]>([]);
  const [stage, setStage] = useState<ConversationState>(INITIAL_STATE);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const turnIdByItemId = useRef<Map<string, string>>(new Map());
  const stageRef = useRef<ConversationState>(INITIAL_STATE);
  /** Non-null once the call is on its way out; see armHangup. */
  const hangupRef = useRef<{ sawResponseDone: boolean } | null>(null);
  const hangupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** True between response.created and response.done — creating a second one is an error. */
  const activeResponseRef = useRef(false);
  /** Set when an escalation is waiting on a cancelled reply to clear out of the way. */
  const pendingAlertRef = useRef(false);

  const appendTurn = useCallback((turn: Omit<TranscriptTurn, "stage">) => {
    setTranscript((prev) => [...prev, { ...turn, stage: stageRef.current }]);
  }, []);

  /**
   * Writes text into the turn belonging to a realtime conversation item, creating the turn
   * the first time we see that item.
   *
   * Ordering depends on this: input-audio transcription runs as a separate async job, so a
   * patient's transcript routinely arrives *after* the assistant has already answered it.
   * Appending on arrival would print the answer above the question. Keying on item_id lets
   * the item's slot be reserved the moment the server creates it — which is in true
   * conversation order — and filled in whenever its text shows up.
   */
  const writeTurn = useCallback(
    (
      itemId: string,
      role: TranscriptTurn["role"],
      text: string,
      mode: "append" | "replace"
    ) => {
      if (!itemId) return;
      const existingId = turnIdByItemId.current.get(itemId);
      if (existingId) {
        setTranscript((prev) =>
          prev.map((t) =>
            t.id === existingId ? { ...t, text: mode === "append" ? t.text + text : text } : t
          )
        );
        return;
      }
      const turnId = crypto.randomUUID();
      turnIdByItemId.current.set(itemId, turnId);
      appendTurn({ id: turnId, role, text });
    },
    [appendTurn]
  );

  const updateTurn = useCallback((id: string, text: string, stage?: ConversationState) => {
    setTranscript((prev) =>
      prev.map((t) => (t.id === id ? { ...t, text, ...(stage ? { stage } : null) } : t))
    );
  }, []);

  const logDataChannelEvent = useCallback((direction: "in" | "out", payload: unknown) => {
    const type =
      typeof payload === "object" && payload && "type" in payload
        ? String((payload as { type: unknown }).type)
        : "unknown";
    setDataChannelLog((prev) => {
      if (isDeltaEventType(type)) {
        const last = prev[prev.length - 1];
        if (last && last.count !== undefined && last.direction === direction) {
          const updated = [...prev];
          const deltaTypes = last.deltaTypes ?? [];
          updated[updated.length - 1] = {
            ...last,
            count: last.count + 1,
            timestamp: Date.now(),
            deltaTypes: deltaTypes.includes(type) ? deltaTypes : [...deltaTypes, type],
          };
          return updated;
        }
        const next = [
          ...prev,
          {
            id: crypto.randomUUID(),
            direction,
            type: "delta stream",
            payload: undefined,
            timestamp: Date.now(),
            count: 1,
            deltaTypes: [type],
          },
        ];
        return next.length > MAX_DC_LOG_ENTRIES ? next.slice(next.length - MAX_DC_LOG_ENTRIES) : next;
      }
      const next = [
        ...prev,
        {
          id: crypto.randomUUID(),
          direction,
          type,
          payload: truncateLargeStrings(payload),
          timestamp: Date.now(),
        },
      ];
      return next.length > MAX_DC_LOG_ENTRIES ? next.slice(next.length - MAX_DC_LOG_ENTRIES) : next;
    });
  }, []);

  const sendEvent = useCallback(
    (payload: Record<string, unknown>) => {
      const dc = dcRef.current;
      if (!dc || dc.readyState !== "open") return;
      dc.send(JSON.stringify(payload));
      logDataChannelEvent("out", payload);
    },
    [logDataChannelEvent]
  );

  const clearHangupTimer = useCallback(() => {
    if (hangupTimerRef.current !== null) {
      clearTimeout(hangupTimerRef.current);
      hangupTimerRef.current = null;
    }
  }, []);

  const cleanup = useCallback(() => {
    clearHangupTimer();
    hangupRef.current = null;
    activeResponseRef.current = false;
    pendingAlertRef.current = false;

    dcRef.current?.close();
    dcRef.current = null;

    pcRef.current?.getSenders().forEach((sender) => sender.track?.stop());
    pcRef.current?.close();
    pcRef.current = null;

    micStreamRef.current?.getTracks().forEach((track) => track.stop());
    micStreamRef.current = null;

    if (audioElRef.current) {
      audioElRef.current.srcObject = null;
    }

    sessionIdRef.current = null;
    turnIdByItemId.current.clear();
  }, [clearHangupTimer]);

  /** Tears down the call the conversation itself ended, as opposed to the user hanging up. */
  const endCall = useCallback(() => {
    if (!pcRef.current) return;
    appendTurn({
      id: crypto.randomUUID(),
      role: "tool",
      text: "Conversation complete — connection closed",
    });
    cleanup();
    setConnectionState("ended");
  }, [appendTurn, cleanup]);

  /**
   * Schedules the hangup once the conversation has reached a closing state. We can't tear
   * down at the transition itself: the assistant still has a closing line to deliver, and
   * closing the peer connection cuts it off mid-sentence. So we wait for two things —
   * the closing response to finish generating (`response.done`), then its audio to drain
   * out of the output buffer (`output_audio_buffer.stopped`, which WebRTC sessions emit
   * when playback has actually finished) — and hang up a beat after that.
   *
   * Only a `response.done` that lands *after* arming counts, so the audio still playing
   * from the turn that carried the closing tool call can't trigger an early hangup.
   */
  const armHangup = useCallback(() => {
    if (!pcRef.current || hangupRef.current) return;
    hangupRef.current = { sawResponseDone: false };
    setConnectionState("ending");
    clearHangupTimer();
    hangupTimerRef.current = setTimeout(endCall, HANGUP_MAX_WAIT_MS);
  }, [clearHangupTimer, endCall]);

  /** Asks for the alert turn and hangs up behind it, in that order — arming is what makes
   * the *next* reply the one we wait on. */
  const speakAlertAndHangUp = useCallback(() => {
    sendEvent({ type: "response.create" });
    armHangup();
  }, [armHangup, sendEvent]);

  /**
   * Delivers a scanner escalation, which is the awkward one: unlike a tool call, it can
   * land mid-reply — the model is usually already answering the very turn that carried the
   * red flag, composed under the pre-alert instructions. That reply is cancelled so the
   * alert takes its place; `response.done` for the cancellation is what releases the new
   * response, since creating one while another is active is an error.
   *
   * Any hangup already in flight is disarmed first: a red flag stays legal after the call
   * has otherwise wound down, and the pending farewell timer would otherwise cut the 911
   * message off.
   */
  const escalate = useCallback(() => {
    if (!pcRef.current) return;
    clearHangupTimer();
    hangupRef.current = null;

    if (activeResponseRef.current) {
      pendingAlertRef.current = true;
      sendEvent({ type: "response.cancel" });
      return;
    }
    speakAlertAndHangUp();
  }, [clearHangupTimer, sendEvent, speakAlertAndHangUp]);

  /**
   * Relays a server-issued session config to the realtime model. The browser is only a
   * courier here: it never composes instructions, and only ever forwards a config the
   * server returned alongside a transition it authorized.
   */
  const relaySessionUpdate = useCallback(
    (sessionUpdate: SessionUpdate | undefined) => {
      if (!sessionUpdate) return;
      sendEvent({
        type: "session.update",
        session: {
          type: "realtime",
          instructions: sessionUpdate.instructions,
          tools: sessionUpdate.tools,
          tool_choice: "auto",
        },
      });
    },
    [sendEvent]
  );

  /**
   * Adopts the server's record as the single source of truth for state and UI.
   * Returns the new state when it changed, so callers can tag a marker turn with it.
   */
  const applyRecord = useCallback(
    (record: IntakeRecord | undefined | null): ConversationState | null => {
      if (!record) return null;
      setIntakeRecord(record);
      if (record.emergency) setEmergency(record.emergency);

      if (record.state === stageRef.current) return null;
      stageRef.current = record.state;
      setStage(record.state);
      return record.state;
    },
    []
  );

  const runSafetyCheck = useCallback(
    async (text: string) => {
      const sessionId = sessionIdRef.current;
      if (!sessionId || !text.trim()) return;
      try {
        const response = await fetch(`${BACKEND_URL}/api/safety-check`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, text }),
        });
        const data: SafetyCheckResponse = await response.json();
        if (!data.flagged || !data.record) return;

        // A sessionUpdate is only present when this scan is what escalated the session,
        // so it doubles as the "this is new" signal for the transcript marker.
        const isNewEscalation = Boolean(data.sessionUpdate);
        // Adopt the new state first, so the marker lands in the stage it opens.
        applyRecord(data.record);
        relaySessionUpdate(data.sessionUpdate);
        if (isNewEscalation) {
          appendTurn({
            id: crypto.randomUUID(),
            role: "tool",
            text: `Safety scan flagged a red flag — ${data.reason ?? "red flag detected"}`,
          });
          escalate();
        }
      } catch {
        // best-effort secondary check; the model's own flag_emergency call is the primary path
      }
    },
    [appendTurn, applyRecord, escalate, relaySessionUpdate]
  );

  const handleFunctionCall = useCallback(
    async (name: string, argsJson: string, callId: string) => {
      const toolTurnId = crypto.randomUUID();
      appendTurn({ id: toolTurnId, role: "tool", text: `${name}…` });

      let modelOutput: unknown;
      let resultText: string;
      // Set when this call opened a new stage, so the marker moves into it.
      let markerStage: ConversationState | undefined;
      // Set when this call ended the conversation, so we hang up after the farewell.
      let endsCall = false;
      try {
        const args = argsJson ? JSON.parse(argsJson) : {};
        const sessionId = sessionIdRef.current;
        const response = await fetch(`${BACKEND_URL}/api/tools/${name}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ args, sessionId }),
        });
        const payload = (await response.json()) as ToolResponse & { error?: string };

        if (!response.ok) {
          // A refused tool call still carries the authoritative record, so the UI stays
          // in sync with the state the server actually thinks we're in.
          applyRecord(payload.record);
          throw new Error(payload.error ?? "Tool call failed");
        }

        const newState = applyRecord(payload.record);
        relaySessionUpdate(payload.sessionUpdate);
        if (newState && MARKER_OPENS_STAGE.includes(newState)) {
          markerStage = newState;
        }
        if (newState && AUTO_END_STATES.includes(newState)) {
          endsCall = true;
        }

        modelOutput = payload.result ?? {};
        resultText = describeToolResult(name, args, payload);
      } catch (err) {
        modelOutput = { error: (err as Error).message };
        resultText = `${name} failed: ${(err as Error).message}`;
      }

      updateTurn(toolTurnId, resultText, markerStage);

      sendEvent({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify(modelOutput),
        },
      });
      sendEvent({ type: "response.create" });

      // Armed only after the closing response has been requested, so the reply we wait on
      // is the farewell and not the turn that made this tool call.
      if (endsCall) armHangup();
    },
    [appendTurn, applyRecord, armHangup, relaySessionUpdate, sendEvent, updateTurn]
  );

  const handleServerEvent = useCallback(
    (event: RealtimeEvent) => {
      switch (event.type) {
        // The item is created in conversation order, before either side's text exists.
        // Reserving its slot here is what keeps the transcript in the order things were
        // actually said. ("added" is the GA event name, "created" the older one.)
        case "conversation.item.added":
        case "conversation.item.created": {
          const item = (event as { item?: { id?: string; type?: string; role?: string } }).item;
          if (!item?.id || item.type !== "message") break;
          if (item.role !== "user" && item.role !== "assistant") break;
          // Reserve only — never overwrite. Both event names can fire for the same item,
          // and text may already have streamed in by the time the second one lands.
          if (turnIdByItemId.current.has(item.id)) break;
          writeTurn(item.id, item.role, "", "replace");
          break;
        }
        case "conversation.item.input_audio_transcription.delta": {
          const itemId = String((event as { item_id?: string }).item_id ?? "");
          const delta = String((event as { delta?: string }).delta ?? "");
          writeTurn(itemId, "user", delta, "append");
          break;
        }
        case "conversation.item.input_audio_transcription.completed": {
          const itemId = String((event as { item_id?: string }).item_id ?? "");
          const transcriptText = String((event as { transcript?: string }).transcript ?? "");
          writeTurn(itemId, "user", transcriptText, "replace");
          void runSafetyCheck(transcriptText);
          break;
        }
        case "response.output_audio_transcript.delta": {
          const itemId = String((event as { item_id?: string }).item_id ?? "");
          const delta = String((event as { delta?: string }).delta ?? "");
          writeTurn(itemId, "assistant", delta, "append");
          break;
        }
        case "response.output_audio_transcript.done": {
          const itemId = String((event as { item_id?: string }).item_id ?? "");
          const finalText = String((event as { transcript?: string }).transcript ?? "");
          if (finalText) writeTurn(itemId, "assistant", finalText, "replace");
          break;
        }
        case "response.created": {
          activeResponseRef.current = true;
          break;
        }
        case "response.done": {
          activeResponseRef.current = false;
          const output =
            ((event as { response?: { output?: Array<Record<string, unknown>> } }).response
              ?.output ?? []) as Array<Record<string, unknown>>;
          for (const item of output) {
            if (item.type === "function_call") {
              void handleFunctionCall(
                String(item.name ?? ""),
                String(item.arguments ?? ""),
                String(item.call_id ?? "")
              );
            }
          }
          // The reply an escalation cancelled — the alert takes the channel from here, and
          // this `done` belongs to the cancelled turn, not to anything we hang up behind.
          if (pendingAlertRef.current) {
            pendingAlertRef.current = false;
            speakAlertAndHangUp();
            break;
          }
          if (hangupRef.current) hangupRef.current.sawResponseDone = true;
          break;
        }
        // WebRTC-only: fires when the output audio buffer has drained, i.e. the assistant
        // has actually finished speaking rather than merely finished generating.
        case "output_audio_buffer.stopped": {
          if (!hangupRef.current?.sawResponseDone) break;
          clearHangupTimer();
          hangupTimerRef.current = setTimeout(endCall, HANGUP_GRACE_MS);
          break;
        }
        case "error": {
          setError(String((event as { error?: { message?: string } }).error?.message ?? "Realtime error"));
          break;
        }
        default:
          break;
      }
    },
    [clearHangupTimer, endCall, handleFunctionCall, runSafetyCheck, speakAlertAndHangUp, writeTurn]
  );

  const stop = useCallback(() => {
    cleanup();
    setConnectionState("idle");
  }, [cleanup]);

  const start = useCallback(async () => {
    setError(null);
    setConnectionState("connecting");
    setTranscript([]);
    setIntakeRecord(null);
    setEmergency(null);
    setDataChannelLog([]);
    setStage(INITIAL_STATE);
    stageRef.current = INITIAL_STATE;
    turnIdByItemId.current.clear();
    clearHangupTimer();
    hangupRef.current = null;
    activeResponseRef.current = false;
    pendingAlertRef.current = false;

    try {
      const sessionResponse = await fetch(`${BACKEND_URL}/api/session`, { method: "POST" });
      const sessionData = await sessionResponse.json();
      if (!sessionResponse.ok) {
        throw new Error(sessionData.error ?? "Failed to create realtime session");
      }
      const ephemeralKey: string = sessionData.value;
      sessionIdRef.current = sessionData.sessionId;
      setIntakeRecord(sessionData.record ?? null);

      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      const audioEl = document.createElement("audio");
      audioEl.autoplay = true;
      audioElRef.current = audioEl;
      pc.ontrack = (e) => {
        audioEl.srcObject = e.streams[0];
      };

      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = micStream;
      micStream.getTracks().forEach((track) => pc.addTrack(track, micStream));

      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;
      dc.addEventListener("message", (e) => {
        try {
          const parsed = JSON.parse(e.data);
          logDataChannelEvent("in", parsed);
          handleServerEvent(parsed);
        } catch {
          // ignore malformed events
        }
      });
      dc.addEventListener("open", () => {
        setConnectionState("connected");
        sendEvent({ type: "response.create" });
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const sdpResponse = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${ephemeralKey}`,
          "Content-Type": "application/sdp",
        },
      });

      if (!sdpResponse.ok) {
        throw new Error(`Realtime call setup failed (${sdpResponse.status})`);
      }

      const answerSdp = await sdpResponse.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    } catch (err) {
      cleanup();
      setError((err as Error).message);
      setConnectionState("error");
    }
  }, [cleanup, clearHangupTimer, handleServerEvent, logDataChannelEvent, sendEvent]);

  return {
    connectionState,
    transcript,
    error,
    intakeRecord,
    emergency,
    dataChannelLog,
    stage,
    start,
    stop,
  };
}

/** Human-readable label for the tool marker in the transcript. Presentation only. */
function describeToolResult(
  name: string,
  args: Record<string, unknown>,
  payload: ToolResponse
): string {
  switch (name) {
    case "verify_identity":
      return payload.result?.verified ? "Identity verified" : "Identity verification failed";
    case "request_reschedule":
      return "Reschedule requested";
    case "update_intake": {
      const recorded = (payload.result?.recorded as string[] | undefined) ?? [];
      return `Recorded: ${recorded.join(", ") || "(no fields)"}`;
    }
    case "flag_emergency":
      return `Emergency flagged — ${String(args.reason ?? "")}`;
    case "finalize_intake":
      return "Intake finalized";
    default:
      return `${name} completed`;
  }
}
