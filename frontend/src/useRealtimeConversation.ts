import { useCallback, useRef, useState } from "react";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:3001";

export type ConnectionState = "idle" | "connecting" | "connected" | "error";

export interface TranscriptTurn {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
}

export type SessionStage = "verification" | "intake";

export interface RescheduleRequest {
  reason?: string;
}

export interface IntakeRecord {
  sessionId: string;
  stage: SessionStage;
  verified: boolean;
  verificationAttempts: number;
  rescheduleRequested?: RescheduleRequest;
  chiefComplaint: string;
  onset?: string;
  location?: string;
  character?: string;
  severity?: string;
  duration?: string;
  timing?: string;
  aggravatingFactors?: string;
  alleviatingFactors?: string;
  associatedSymptoms?: string;
  summary?: string;
  finalized: boolean;
  updatedAt: string;
}

interface StageConfig {
  instructions: string;
  tools: Array<Record<string, unknown>>;
}

export interface EmergencyState {
  flagged: true;
  reason: string;
  source: "model" | "keyword_scan";
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

export const INTAKE_FIELD_LABELS: Record<string, string> = {
  onset: "Onset",
  location: "Location",
  character: "Character",
  severity: "Severity",
  duration: "Duration",
  timing: "Timing",
  aggravatingFactors: "Aggravating factors",
  alleviatingFactors: "Alleviating factors",
  associatedSymptoms: "Associated symptoms",
};

export function useRealtimeConversation() {
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [intakeRecord, setIntakeRecord] = useState<IntakeRecord | null>(null);
  const [emergency, setEmergency] = useState<EmergencyState | null>(null);
  const [dataChannelLog, setDataChannelLog] = useState<DataChannelLogEntry[]>([]);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const assistantTurnIdByItemId = useRef<Map<string, string>>(new Map());
  const nextStageConfigRef = useRef<StageConfig | null>(null);

  const appendTurn = useCallback((turn: TranscriptTurn) => {
    setTranscript((prev) => [...prev, turn]);
  }, []);

  const updateTurn = useCallback((id: string, text: string) => {
    setTranscript((prev) => prev.map((t) => (t.id === id ? { ...t, text } : t)));
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

  const applyRecord = useCallback((record: IntakeRecord | undefined | null) => {
    if (!record) return;
    setIntakeRecord(record);
    if ("emergency" in record && (record as unknown as { emergency?: EmergencyState }).emergency) {
      setEmergency((record as unknown as { emergency: EmergencyState }).emergency);
    }
  }, []);

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
        const data = await response.json();
        if (data.flagged && data.record) {
          applyRecord(data.record);
        }
      } catch {
        // best-effort secondary check; the model's own flag_emergency call is the primary path
      }
    },
    [applyRecord]
  );

  const handoffToIntakeStage = useCallback(() => {
    const nextStage = nextStageConfigRef.current;
    if (!nextStage) return;
    sendEvent({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: nextStage.instructions,
        tools: nextStage.tools,
        tool_choice: "auto",
      },
    });
  }, [sendEvent]);

  const handleFunctionCall = useCallback(
    async (name: string, argsJson: string, callId: string) => {
      const toolTurnId = crypto.randomUUID();
      appendTurn({ id: toolTurnId, role: "tool", text: `${name}…` });

      let resultPayload: unknown;
      let resultText: string;
      try {
        const args = argsJson ? JSON.parse(argsJson) : {};
        const sessionId = sessionIdRef.current;
        const response = await fetch(`${BACKEND_URL}/api/tools/${name}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ args, sessionId }),
        });
        resultPayload = await response.json();
        if (!response.ok) {
          throw new Error(
            typeof resultPayload === "object" && resultPayload && "error" in resultPayload
              ? String((resultPayload as { error: string }).error)
              : "Tool call failed"
          );
        }

        applyRecord(resultPayload as IntakeRecord);

        if (name === "verify_identity") {
          const verified = Boolean((resultPayload as { verified?: boolean }).verified);
          resultText = verified ? "Identity verified" : "Identity verification failed";
          if (verified) {
            handoffToIntakeStage();
          }
        } else if (name === "request_reschedule") {
          resultText = "Reschedule requested";
        } else if (name === "update_intake") {
          resultText = `Recorded: ${Object.keys(args).join(", ") || "(no fields)"}`;
        } else if (name === "flag_emergency") {
          resultText = `⚠️ Emergency flagged — ${String(args.reason ?? "")}`;
        } else if (name === "finalize_intake") {
          resultText = "Intake finalized";
        } else {
          resultText = `${name} completed`;
        }
      } catch (err) {
        resultPayload = { error: (err as Error).message };
        resultText = `${name} failed: ${(err as Error).message}`;
      }

      updateTurn(toolTurnId, resultText);

      sendEvent({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify(resultPayload),
        },
      });
      sendEvent({ type: "response.create" });
    },
    [appendTurn, applyRecord, handoffToIntakeStage, sendEvent, updateTurn]
  );

  const handleServerEvent = useCallback(
    (event: RealtimeEvent) => {
      switch (event.type) {
        case "conversation.item.input_audio_transcription.completed": {
          const transcriptText = String((event as { transcript?: string }).transcript ?? "");
          appendTurn({ id: crypto.randomUUID(), role: "user", text: transcriptText });
          void runSafetyCheck(transcriptText);
          break;
        }
        case "response.output_audio_transcript.delta": {
          const itemId = String((event as { item_id?: string }).item_id ?? "");
          const delta = String((event as { delta?: string }).delta ?? "");
          const existingId = assistantTurnIdByItemId.current.get(itemId);
          if (existingId) {
            setTranscript((prev) =>
              prev.map((t) => (t.id === existingId ? { ...t, text: t.text + delta } : t))
            );
          } else {
            const newId = crypto.randomUUID();
            assistantTurnIdByItemId.current.set(itemId, newId);
            appendTurn({ id: newId, role: "assistant", text: delta });
          }
          break;
        }
        case "response.output_audio_transcript.done": {
          const itemId = String((event as { item_id?: string }).item_id ?? "");
          const finalText = String((event as { transcript?: string }).transcript ?? "");
          const existingId = assistantTurnIdByItemId.current.get(itemId);
          if (existingId && finalText) {
            updateTurn(existingId, finalText);
          }
          break;
        }
        case "response.done": {
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
    [appendTurn, handleFunctionCall, runSafetyCheck, updateTurn]
  );

  const cleanup = useCallback(() => {
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
    assistantTurnIdByItemId.current.clear();
    nextStageConfigRef.current = null;
  }, []);

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
    assistantTurnIdByItemId.current.clear();

    try {
      const sessionResponse = await fetch(`${BACKEND_URL}/api/session`, { method: "POST" });
      const sessionData = await sessionResponse.json();
      if (!sessionResponse.ok) {
        throw new Error(sessionData.error ?? "Failed to create realtime session");
      }
      const ephemeralKey: string = sessionData.value;
      sessionIdRef.current = sessionData.sessionId;
      nextStageConfigRef.current = sessionData.nextStage ?? null;

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
  }, [cleanup, handleServerEvent, sendEvent]);

  return { connectionState, transcript, error, intakeRecord, emergency, dataChannelLog, start, stop };
}
