import { writeWav } from "../audio/wav.js";
import { PIPELINE_SAMPLE_RATE, type SttFinal, type SttProvider, type SttSession } from "./types.js";

/**
 * Adapts a batch transcriber to the streaming session interface.
 *
 * Batch recognition sounds like the wrong shape for a real-time pipeline, and it usually
 * is — but the Stage 1 measurements complicate that instinct. The endpoint hangover means
 * we are already waiting for the patient to stop before anything can be finalized, and
 * OpenAI's *streaming* recognizer still spends 560–840ms finalizing after that point. A
 * batch recognizer running at 200x real time transcribes a three-second utterance in
 * roughly fifteen milliseconds, so the only real cost is the upload.
 *
 * The honest trade: no partial transcripts. That forecloses speculative LLM start, which
 * is the main trick for hiding time-to-first-token. The harness reports partial counts
 * precisely so this shows up in the numbers rather than in a footnote.
 */

export interface BatchSttConfig {
  name: string;
  model: string;
  baaCovered: boolean;
  /** Receives a complete WAV of the turn, returns the transcript. */
  transcribe(wav: Buffer, signal: AbortSignal): Promise<string>;
}

export function batchStt(cfg: BatchSttConfig): SttProvider {
  return {
    name: cfg.name,
    model: cfg.model,
    baaCovered: cfg.baaCovered,

    async open({ signal }): Promise<SttSession> {
      const opened = Date.now();
      const frames: Int16Array[] = [];
      const finalCbs: ((f: SttFinal) => void)[] = [];
      const errorCbs: ((e: Error) => void)[] = [];
      let finalPromise: Promise<SttFinal> | null = null;

      const runTranscription = async (): Promise<SttFinal> => {
        const total = frames.reduce((n, f) => n + f.length, 0);
        const samples = new Int16Array(total);
        let at = 0;
        for (const f of frames) {
          samples.set(f, at);
          at += f.length;
        }

        try {
          const text = await cfg.transcribe(
            writeWav({ samples, sampleRate: PIPELINE_SAMPLE_RATE }),
            signal
          );
          const result: SttFinal = { text, atMs: Date.now() - opened };
          for (const cb of finalCbs) cb(result);
          return result;
        } catch (err) {
          for (const cb of errorCbs) cb(err as Error);
          throw err;
        }
      };

      return {
        push(pcm) {
          // Copy: the caller hands out subarray views over a buffer it keeps reusing.
          frames.push(Int16Array.from(pcm));
        },
        commit() {
          finalPromise ??= runTranscription();
        },
        close() {
          frames.length = 0;
        },
        onPartial() {
          // Batch recognition has no partials. Deliberately a no-op rather than an error:
          // the caller should be able to swap providers without special-casing, and the
          // absence shows up honestly as a zero in the benchmark's partial count.
        },
        onFinal(cb) {
          finalCbs.push(cb);
        },
        onError(cb) {
          errorCbs.push(cb);
        },
        nextFinal() {
          finalPromise ??= runTranscription();
          return finalPromise;
        },
      };
    },
  };
}

/** Multipart upload shared by every OpenAI-compatible `/audio/transcriptions` endpoint. */
export async function postTranscription(opts: {
  url: string;
  apiKey: string | undefined;
  model: string;
  wav: Buffer;
  signal: AbortSignal;
}): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(opts.wav)], { type: "audio/wav" }), "turn.wav");
  form.append("model", opts.model);
  form.append("response_format", "json");
  // Temperature 0: this transcript feeds a deterministic red-flag scan, and creative
  // rewording of a patient's symptoms is the last thing we want.
  form.append("temperature", "0");

  const res = await fetch(opts.url, {
    method: "POST",
    signal: opts.signal,
    headers: opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {},
    body: form,
  });

  if (!res.ok) throw new Error(`Transcription failed (${res.status}): ${await res.text()}`);
  const body = (await res.json()) as { text?: string };
  return (body.text ?? "").trim();
}
