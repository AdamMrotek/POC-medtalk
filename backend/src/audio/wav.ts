import { PIPELINE_SAMPLE_RATE } from "../providers/types.js";

/**
 * Just enough WAV to read benchmark fixtures and write generated ones. Deliberately not a
 * general decoder — it handles 16-bit PCM, which is what the pipeline speaks end to end.
 */

export interface Pcm {
  samples: Int16Array;
  sampleRate: number;
}

export function readWav(buf: Buffer): Pcm {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a RIFF/WAVE file");
  }

  let channels = 1;
  let sampleRate = PIPELINE_SAMPLE_RATE;
  let bitsPerSample = 16;
  let data: Buffer | null = null;

  // Chunks may appear in any order and a LIST chunk often sits between fmt and data, so
  // walk them rather than assuming the canonical 44-byte header.
  let at = 12;
  while (at + 8 <= buf.length) {
    const id = buf.toString("ascii", at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const body = at + 8;

    if (id === "fmt ") {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bitsPerSample = buf.readUInt16LE(body + 14);
    } else if (id === "data") {
      data = buf.subarray(body, body + size);
    }

    at = body + size + (size % 2); // chunks are word-aligned
  }

  if (!data) throw new Error("WAV has no data chunk");
  if (bitsPerSample !== 16) throw new Error(`Expected 16-bit PCM, got ${bitsPerSample}-bit`);

  const frames = Math.floor(data.length / 2 / channels);
  const mono = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    // Downmix by averaging, so a stereo fixture doesn't arrive 6 dB hot on one side.
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += data.readInt16LE((i * channels + c) * 2);
    mono[i] = Math.round(sum / channels);
  }

  return { samples: mono, sampleRate };
}

export function writeWav({ samples, sampleRate }: Pcm): Buffer {
  const header = Buffer.alloc(44);
  const bytes = samples.length * 2;

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + bytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // format = PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(bytes, 40);

  const body = Buffer.alloc(bytes);
  for (let i = 0; i < samples.length; i++) body.writeInt16LE(samples[i]!, i * 2);
  return Buffer.concat([header, body]);
}

/** Linear resampling. Crude, but fixtures are generated at the pipeline rate anyway — this
 * exists so a real recording at 44.1k can be dropped in without a conversion step. */
export function resample(pcm: Pcm, to: number): Pcm {
  if (pcm.sampleRate === to) return pcm;
  const ratio = pcm.sampleRate / to;
  const out = new Int16Array(Math.floor(pcm.samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const src = i * ratio;
    const lo = Math.floor(src);
    const hi = Math.min(lo + 1, pcm.samples.length - 1);
    const frac = src - lo;
    out[i] = Math.round(pcm.samples[lo]! * (1 - frac) + pcm.samples[hi]! * frac);
  }
  return { samples: out, sampleRate: to };
}

export function silence(ms: number, sampleRate = PIPELINE_SAMPLE_RATE): Int16Array {
  return new Int16Array(Math.round((ms / 1000) * sampleRate));
}

export function concat(parts: Int16Array[]): Int16Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Int16Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Trims leading and trailing near-silence.
 *
 * This matters more than it looks: the headline metric is measured from *acoustic end of
 * speech*, and a fixture with half a second of trailing room tone would silently inflate
 * every number by half a second. Trimming makes "end of file" mean "end of speech".
 */
export function trimSilence(samples: Int16Array, threshold = 500): Int16Array {
  let start = 0;
  let end = samples.length;
  while (start < end && Math.abs(samples[start]!) < threshold) start++;
  while (end > start && Math.abs(samples[end - 1]!) < threshold) end--;
  return samples.subarray(start, end);
}
