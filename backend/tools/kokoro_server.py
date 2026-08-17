"""
A minimal OpenAI-compatible /v1/audio/speech server backed by Kokoro-82M (ONNX).

Why a server rather than a subprocess per turn: the model takes seconds to load, and
loading it once per utterance would swamp the very thing being measured. Keeping it
resident is what makes local synthesis competitive at all — the same reason whisper-server
is preferred over the whisper-cli binary.

Speaks the OpenAI shape so the backend can point at it with LOCAL_TTS_URL and reuse the
existing provider implementation unchanged.

Run:
  ~/.cache/kokoro-venv/bin/python backend/tools/kokoro_server.py --port 8179
"""

import argparse
import io
import json
import os
import re
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
from kokoro_onnx import Kokoro
from kokoro_onnx.config import MAX_PHONEME_LENGTH
from kokoro_onnx.tokenizer import Tokenizer
from kokoro_onnx.trim import trim as trim_audio
from phonemizer.backend import EspeakBackend

MODEL_DIR = os.path.expanduser("~/.cache/kokoro-models")
TARGET_RATE = 24_000  # matches the rest of the pipeline, so nothing is resampled
LANG = "en-us"

# ---------------------------------------------------------------------------
# Streaming
# ---------------------------------------------------------------------------
#
# Kokoro is non-autoregressive: one decoder pass emits the entire waveform for a batch, so
# there is no partial output to stream *within* a batch and no transport change can invent
# one. kokoro_onnx's own `_split_phonemes` only starts a new batch past MAX_PHONEME_LENGTH
# (510), which no conversational utterance reaches — so out of the box every request is a
# single batch and the caller waits for the whole thing.
#
# The only real lever is therefore to make the *first* batch small. Cost is roughly
# 207ms + 14ms/phoneme on this machine, so a 24-phoneme opener returns audio in ~550ms
# where the full sentence would take ~1200ms and a paragraph ~3500ms. Later batches are cut
# long, because by then synthesis (rtf ~0.27) is racing playback rather than the listener's
# patience, and longer batches carry better prosody.
#
# This is the same shape as `createChunker` in the backend, and deliberately so — but it
# belongs here as well as there, because this way the opening latency does not depend on
# the language model happening to emit a short first sentence.
#
# The cost is real and worth stating: each batch is an independent decoder pass, and
# kokoro_onnx even selects the voice style vector by token count, so intonation resets at
# every seam. Cutting at punctuation hides this well; cutting mid-clause to hit the first
# batch's size target does not, and is audible. That is the trade being made, and it is why
# only the first batch is cut aggressively.

FIRST_BATCH_PHONEMES = 24
LATER_BATCH_PHONEMES = 160

# Prefer to break here, in descending order of how natural the seam sounds.
SENTENCE_END = ".!?"
CLAUSE_END = ",;:"

kokoro: Kokoro | None = None
tokenizer: Tokenizer | None = None
phonemizer_backend: EspeakBackend | None = None


def phonemize(text: str) -> str:
    """
    Grapheme-to-phoneme against a *resident* espeak-ng backend.

    kokoro_onnx's own tokenizer calls the top-level `phonemizer.phonemize()`, which
    constructs a fresh EspeakBackend per call. Constructing one costs ~600ms; the actual
    phonemization costs ~0.2ms. So the default path pays a 600ms fixed tax on every
    utterance, and it does not scale with text length — which makes it *worst* precisely
    where it hurts most, on the short opening span the patient is waiting through.

    Building the backend once at startup and reusing it here produces byte-identical
    phonemes for a ~600ms saving per request.
    """
    assert tokenizer is not None and phonemizer_backend is not None
    # espeak returns an empty *list* for empty input rather than a list with an empty
    # string, so indexing [0] unguarded turns a blank utterance into a 500.
    stripped = text.strip()
    if not stripped:
        return ""
    results = phonemizer_backend.phonemize([stripped], strip=True)
    raw = results[0] if results else ""
    # Mirror the tokenizer's own filtering: anything outside the model's vocab would be
    # dropped downstream anyway, and leaving it in risks a tokenize() failure.
    return "".join(p for p in raw if p in tokenizer.vocab).strip()


def split_batches(phonemes: str, first_target: int, later_target: int) -> list[str]:
    """
    Cut a phoneme string into batches, short one first.

    Within each batch we take the latest natural break that still fits the size target —
    a sentence end if there is one, else a clause end, else a word boundary. Preferring
    the latest break keeps later batches long, which is what protects prosody; the first
    batch is small only because its target is small.

    A consequence worth knowing: the first batch can come out well under its target when
    an early comma is the only break available ("Thanks," is seven phonemes). That is
    good for latency and costs a seam at a place the listener would pause anyway. Falling
    through to a word boundary is the case that sounds worst, and only happens when a
    clause runs longer than the target with no punctuation in it at all.
    """
    if first_target <= 0:
        # Streaming disabled: one batch, subject only to the model's hard limit.
        return [phonemes[i : i + MAX_PHONEME_LENGTH] for i in range(0, len(phonemes), MAX_PHONEME_LENGTH)] or [""]

    batches: list[str] = []
    rest = phonemes.strip()
    target = first_target

    while rest:
        limit = min(target, MAX_PHONEME_LENGTH)
        if len(rest) <= limit:
            batches.append(rest)
            break

        head = rest[:limit]
        # A break *at or after* the target reads better than one before it, so look for the
        # first candidate in the remainder before settling for the last one inside `head`.
        cut = -1
        for marks in (SENTENCE_END, CLAUSE_END):
            found = max((head.rfind(m) for m in marks), default=-1)
            if found > 0:
                cut = found + 1
                break
        if cut <= 0:
            space = head.rfind(" ")
            cut = space if space > 0 else limit

        batches.append(rest[:cut].strip())
        rest = rest[cut:].strip()
        target = later_target

    return [b for b in batches if b]


def synthesize_batches(text: str, voice: str, speed: float, first_target: int):
    """Yield (samples, rate) per batch, so the caller can write audio as it is produced."""
    assert kokoro is not None
    voice_style = kokoro.get_voice_style(voice)

    for batch in split_batches(phonemize(text), first_target, LATER_BATCH_PHONEMES):
        samples, rate = kokoro._create_audio(batch, voice_style, speed)
        # Trim per batch, exactly as kokoro.create() does — without it the leading silence
        # the model emits on every pass would be re-inserted at every seam.
        samples, _ = trim_audio(samples)
        yield samples, rate


def synthesize(text: str, voice: str, speed: float, first_target: int) -> tuple[np.ndarray, int]:
    parts = list(synthesize_batches(text, voice, speed, first_target))
    rate = parts[0][1] if parts else TARGET_RATE
    return np.concatenate([p for p, _ in parts]) if parts else np.zeros(0, "float32"), rate


def to_pcm16(samples: np.ndarray) -> bytes:
    clipped = np.clip(samples, -1.0, 1.0)
    return (clipped * 32767.0).astype("<i2").tobytes()


def to_wav(pcm: bytes, rate: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # quiet
        pass

    def do_POST(self):
        if not self.path.endswith("/audio/speech"):
            self.send_error(404)
            return

        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")

        text = body.get("input", "")
        voice = body.get("voice") or "af_heart"
        speed = float(body.get("speed") or 1.0)
        fmt = body.get("response_format") or "pcm"

        first_target = 0 if fmt == "wav" else self.server.first_batch_phonemes

        # WAV carries its length in the header, so it cannot be streamed without lying
        # about the size up front. It is a debugging convenience here; PCM is what the
        # pipeline actually requests, so only PCM gets the streaming path.
        if fmt == "wav":
            try:
                samples, rate = synthesize(text, voice, speed, first_target)
            except Exception as exc:
                self.send_error_json(exc)
                return
            data = to_wav(to_pcm16(self.at_target_rate(samples, rate)), TARGET_RATE)
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        # Chunked transfer: the response starts before synthesis has finished, so the
        # caller receives the opening batch while later ones are still being decoded.
        # Headers have to go out before the first batch is decoded, which means a failure
        # partway through can no longer be reported as a 500 — see below.
        started = False
        try:
            for samples, rate in synthesize_batches(text, voice, speed, first_target):
                if not started:
                    self.send_response(200)
                    self.send_header("Content-Type", "application/octet-stream")
                    self.send_header("Transfer-Encoding", "chunked")
                    self.end_headers()
                    started = True
                chunk = to_pcm16(self.at_target_rate(samples, rate))
                if chunk:
                    self.wfile.write(f"{len(chunk):x}\r\n".encode())
                    self.wfile.write(chunk)
                    self.wfile.write(b"\r\n")
                    self.wfile.flush()
        except Exception as exc:
            if not started:
                self.send_error_json(exc)
                return
            # Mid-stream failure. The status line is already 200, so the only honest
            # signal left is to terminate the response without the closing chunk, which
            # the client sees as a truncated body rather than as success.
            self.close_connection = True
            return

        if not started:  # empty input — a valid, zero-length utterance
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()

    def at_target_rate(self, samples: np.ndarray, rate: int) -> np.ndarray:
        if rate == TARGET_RATE:
            return samples
        # Linear resample; Kokoro emits 24k already, so this is a safety net.
        idx = np.linspace(0, len(samples) - 1, int(len(samples) * TARGET_RATE / rate))
        return np.interp(idx, np.arange(len(samples)), samples)

    def send_error_json(self, exc: Exception) -> None:
        payload = json.dumps({"error": str(exc)}).encode()
        self.send_response(500)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")


def main():
    global kokoro, tokenizer, phonemizer_backend
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8179)
    ap.add_argument("--model", default=os.path.join(MODEL_DIR, "kokoro-v1.0.onnx"))
    ap.add_argument("--voices", default=os.path.join(MODEL_DIR, "voices-v1.0.bin"))
    ap.add_argument(
        "--first-batch-phonemes",
        type=int,
        default=FIRST_BATCH_PHONEMES,
        help="Phonemes in the opening batch; smaller returns audio sooner at the cost of an "
        "audible prosody seam. 0 disables streaming and synthesizes the utterance whole.",
    )
    args = ap.parse_args()

    kokoro = Kokoro(args.model, args.voices)
    # Constructing the Tokenizer is what points espeak-ng at its bundled library and data,
    # so it has to happen before the backend below is built. We keep it for its vocab only.
    tokenizer = Tokenizer()
    phonemizer_backend = EspeakBackend(LANG, preserve_punctuation=True, with_stress=True)

    # Warm the graph: the first inference pays one-off allocation costs that would
    # otherwise land on whichever benchmark iteration happened to go first.
    synthesize("Warming up.", "af_heart", 1.0, args.first_batch_phonemes)

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.first_batch_phonemes = args.first_batch_phonemes

    mode = (
        f"streaming, first batch {args.first_batch_phonemes} phonemes"
        if args.first_batch_phonemes > 0
        else "buffered (streaming disabled)"
    )
    print(
        f"kokoro server ready on http://127.0.0.1:{args.port}/v1/audio/speech — {mode}",
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
