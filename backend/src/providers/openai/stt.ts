import WebSocket from "ws";
import {
  PIPELINE_SAMPLE_RATE,
  type SttFinal,
  type SttPartial,
  type SttProvider,
  type SttSession,
} from "../types.js";

/**
 * Streaming speech-to-text over the Realtime API's transcription session.
 *
 * Batch upload (`/v1/audio/transcriptions`) is deliberately not used: it cannot begin
 * work until the utterance is complete, so it would forfeit the entire duration of the
 * patient's speech and produce a benchmark number that does not represent the real path.
 *
 * `turn_detection` is set to null so endpointing is *ours*. Server VAD would fold the
 * endpoint hangover into the vendor's number invisibly, and the hangover is the single
 * largest term in the latency budget — it has to be measured separately to be argued
 * about. Stage 2 may hand endpointing back to server VAD once it has been quantified.
 */

const WS_URL =
  process.env.OPENAI_REALTIME_WS_URL ?? "wss://api.openai.com/v1/realtime?intent=transcription";

export function openAiStt(): SttProvider {
  const model = process.env.OPENAI_TRANSCRIBE_MODEL ?? "gpt-live-transcribe";

  return {
    name: "openai",
    model,
    baaCovered: false,

    async open({ signal }): Promise<SttSession> {
      const apiKey = requireApiKey();
      const ws = new WebSocket(WS_URL, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      const openedAt = Date.now();
      const partialCbs: ((p: SttPartial) => void)[] = [];
      const finalCbs: ((f: SttFinal) => void)[] = [];
      const errorCbs: ((e: Error) => void)[] = [];
      let pendingFinal: { resolve: (f: SttFinal) => void; reject: (e: Error) => void } | null =
        null;

      const fail = (err: Error) => {
        pendingFinal?.reject(err);
        pendingFinal = null;
        for (const cb of errorCbs) cb(err);
      };

      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(new Error("Aborted before the STT socket opened"));
        signal.addEventListener("abort", onAbort, { once: true });
        ws.once("open", () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        });
        ws.once("error", (err) => {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        });
      });

      ws.send(
        JSON.stringify({
          type: "session.update",
          session: {
            type: "transcription",
            audio: {
              input: {
                format: { type: "audio/pcm", rate: PIPELINE_SAMPLE_RATE },
                transcription: { model },
                turn_detection: null,
              },
            },
          },
        })
      );

      ws.on("message", (raw) => {
        let event: { type?: string; delta?: string; transcript?: string; error?: unknown };
        try {
          event = JSON.parse(raw.toString());
        } catch {
          return;
        }

        const atMs = Date.now() - openedAt;
        switch (event.type) {
          case "conversation.item.input_audio_transcription.delta": {
            const text = event.delta ?? "";
            if (text) for (const cb of partialCbs) cb({ text, atMs });
            break;
          }
          case "conversation.item.input_audio_transcription.completed": {
            const done: SttFinal = { text: event.transcript ?? "", atMs };
            pendingFinal?.resolve(done);
            pendingFinal = null;
            for (const cb of finalCbs) cb(done);
            break;
          }
          case "error": {
            fail(new Error(`Realtime transcription error: ${JSON.stringify(event.error)}`));
            break;
          }
        }
      });

      ws.on("error", (err) => fail(err as Error));
      ws.on("close", () => {
        if (pendingFinal) fail(new Error("STT socket closed before a final transcript arrived"));
      });

      signal.addEventListener("abort", () => ws.close(), { once: true });

      return {
        push(pcm) {
          if (ws.readyState !== WebSocket.OPEN) return;
          const bytes = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
          ws.send(
            JSON.stringify({ type: "input_audio_buffer.append", audio: bytes.toString("base64") })
          );
        },
        commit() {
          if (ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        },
        close() {
          ws.close();
        },
        onPartial(cb) {
          partialCbs.push(cb);
        },
        onFinal(cb) {
          finalCbs.push(cb);
        },
        onError(cb) {
          errorCbs.push(cb);
        },
        nextFinal() {
          return new Promise<SttFinal>((resolve, reject) => {
            pendingFinal = { resolve, reject };
          });
        },
      };
    },
  };
}

function requireApiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set.");
  return key;
}
