# Voice pipeline benchmark: cascaded STT → LLM → TTS

**Status:** proposed — pending Stage 1 gate
**Supersedes nothing. Prerequisite for:** a future ADR 0002 on moving off the Realtime API.

## Context

The assistant today is speech-to-speech: the browser opens a WebRTC peer connection **directly**
to OpenAI's Realtime API (`frontend/src/useRealtimeConversation.ts` posts SDP to
`api.openai.com/v1/realtime/calls`), and the backend only mints an ephemeral client secret and
adjudicates tool calls. No audio ever reaches our servers.

This began as a question about making conversations durable and pausable. Investigating it
surfaced something more fundamental: with the Realtime API the conversation is a **live stream
owned by OpenAI**, so durability means snapshotting a moving thing you cannot reattach to. In a
cascaded pipeline the conversation is **at rest between turns** and the message array is ours —
durability, pause/resume and server-side audio capture stop being features to build and become
properties of the shape.

Cascaded also fixes a safety property that the current design can only approximate. Today
`runSafetyCheck` **races** generation: it fires on
`conversation.item.input_audio_transcription.completed`, by which point the model may already be
answering — which is why the hook carries `escalate()`, `pendingAlertRef` and a `response.cancel`
to claw back a reply in flight. In a cascaded pipeline the scan becomes a **gate**: STT text →
`scanForRedFlags` → if flagged, the LLM is never called at all. That converts a
prompt-and-cancel arrangement into a control-flow guarantee, which is the right shape for the
thing `docs/clinical-voice-assistant-requirements.md` says we should design hardest against.

Two things must be proven before committing, because they are the only dimensions on which
cascaded is clearly *worse*:

1. **Latency.** Cascaded serialises three model hops plus an endpointing wait. WebRTC gets this
   for free.
2. **Barge-in.** The patient must be able to interrupt. WebRTC handles this for free; here it
   must be built, and it depends on echo cancellation that WebRTC also provided implicitly.

This document plans **only that proof.**

### Out of scope

Durable persistence, splitting the audit log out of `IntakeRecord` (F-04/F-05), transcript and
audio retention, durable execution frameworks, and the resume protocol. All were designed in
discussion and are deliberately deferred: if the benchmark fails, the architecture changes and
the persistence design changes with it.

### Assumptions

- **All-OpenAI providers.** One vendor, one BAA, one supplier assessment — the simplest answer to
  F-08. The latency cost of this choice is quantified below and is a known risk.
- The benchmark is built as the **foundation of the real implementation**, not throwaway. The
  existing WebRTC path stays untouched and working alongside it for A/B comparison.
- Model names come from environment variables. Nothing is hardcoded, so providers and models can
  be swept without code edits.

---

## The measurement definition that decides whether this succeeds

**"Patient stops speaking" has two meanings, and the entire argument lives in the gap between
them.** Vendors quote latency from *endpoint declared*. Our requirement means *acoustic end of
speech*. The endpoint hangover sits between the two and is 300–700ms of self-inflicted delay —
larger than any individual model hop.

**The benchmark reports from acoustic end.** Reporting from endpoint-declared would produce a
flattering number the patient never experiences. Every headline figure below is
acoustic-end-to-first-audible-sample.

The serial budget on a *latency-optimised* stack is roughly 570–760ms p50 from endpoint declared.
Add a 400ms hangover and that is ~1.0–1.16s acoustic — already missing sub-second at p50, on a
stack faster than the all-OpenAI one we have chosen. Two consequences follow.

### All-OpenAI TTS is the specific weak link

`gpt-4o-mini-tts` time-to-first-byte is roughly 300–600ms, against ~40–90ms for the fastest
alternatives, and it returns **no word-level alignment** — which barge-in truncation will later
need in order to record what the patient actually heard. The single-vendor decision is defensible
on compliance grounds, but it should be made knowing that this is *where* the cost lands, rather
than as a vague "somewhat slower".

### A flat sub-second target is the wrong requirement

`docs/clinical-voice-assistant-requirements.md` specifies "sub-second response start" as one
number. Applied uniformly that number forces a short endpoint hangover in every state, and a
short hangover **clips patients mid-sentence** — which in the `intake` state means losing symptom
data, sometimes the red-flag clause itself. The benchmark should be judged against
state-dependent targets instead:

| Path | Endpoint hangover | Target (acoustic → first audio) |
|---|---|---|
| `verification` — DOB, digits, yes/no | 350ms | **~870ms** — sub-second, met |
| Red-flag escalation | 350ms | **~400ms** — see pre-rendered audio |
| `intake` — open symptom description | 700ms | **~1.3s** — deliberately over budget |

Cutting a patient off mid-symptom is a clinical harm. 300ms of perceived snappiness is not. That
trade belongs in writing rather than buried in a tuned constant.

### Two mechanisms that close the gap — to be measured, not assumed

**Pre-rendered emergency audio.** The 11 red-flag scripts and the closing lines in
`backend/src/policy/blocks.ts` (`emergencyClosing`, `rescheduleClosing`, `lockedClosing`) are
*static text*. Synthesizing them at build time into `backend/assets/audio/` reduces the escalation
path to endpoint + STT final + disk read — **no LLM and no TTS vendor in the loop**. This is both
the best latency result available in the system and the one on the most safety-critical path, and
it makes escalation independent of two vendors being reachable. Measured as its own path.

**Speculative LLM start.** Fire the LLM against the *interim* transcript at ~150ms of silence
rather than waiting for the endpoint; when the final transcript arrives, commit if it is a
prefix-extension of what was sent, otherwise abort and re-fire. This moves 250–450ms of TTFT from
serial to overlapped — precisely the observed shortfall. It costs roughly 1.4–1.8× the LLM calls
and carries a genuine correctness hazard if the commit check is sloppy, so it is flag-gated and
built **only if Stage 1 shows it is needed.**

---

## Stage 1 — Headless latency harness

Built first, and it is a gate: it answers "is this achievable on this stack" before any audio
plumbing exists.

**New: `backend/src/bench/`**

| File | Purpose |
|---|---|
| `fixtures/*.wav` | Four utterances: a one-word answer, a date of birth, a short symptom sentence, and a long rambling description with a deliberate ~900ms mid-sentence pause. |
| `providers.ts` | `SttProvider` / `LlmProvider` / `TtsProvider` interfaces plus OpenAI implementations. `AbortSignal` is a parameter on **every** call — cancellation is the core barge-in requirement and must be impossible to forget. |
| `latency.ts` | N iterations per fixture; reports **p50 and p95** per hop. |

Run via `npm run bench -w threep-backend`.

**Measures:** `T_endpoint` (acoustic end → endpoint declared), `T_stt` (endpoint → final
transcript), `T_llm` (request → first content token), `T_tts` (text → first audio byte).

Three details that keep the numbers honest:

- **Streaming STT, not batch upload.** Batch cannot begin until the utterance ends and does not
  represent the real path.
- **Prompt realism.** Reuse `sessionConfigFor("intake")` from `backend/src/runtime.ts` so the LLM
  receives the real ~4KB instruction block and real tool schemas. TTFT scales with prompt size; a
  toy prompt produces a number that will not survive contact with the application.
- **Request `pcm`, not mp3 or opus.** Removes decode latency, and it is what the Stage 2 jitter
  buffer wants anyway.

**Tool-call turns are recorded separately.** A `verify_identity` turn costs *two* LLM round trips
with no speech in between — the latency worst case, and it distorts any average that includes it.
Worth noting for later: verification is a date of birth and three digits, which is slot extraction
plus a templated response, and arguably needs no LLM at all. Handling it deterministically would
also strengthen F-02, since verification would stop depending on the model *choosing* to call the
tool.

**Gate:** if p95 leaves no headroom under ~700ms once hangover and network are added, stop and
revisit the all-OpenAI decision before building Stage 2.

---

## Stage 1 results — gate FAILED

Run 2026-08-12. `gpt-live-transcribe` / `gpt-4o-mini` / `gpt-4o-mini-tts`, 3 iterations across 4
fixtures (12 turns), from a single developer machine on a residential connection.

| Fixture | Hangover | STT | LLM TTFT | LLM span | TTS TTFB | **Response start** |
|---|---|---|---|---|---|---|
| `01-short-answer` | 350 | 830 / 837 | 663 / 900 | 663 / 900 | 1605 / 2893 | **3503 / 4858** |
| `02-date-of-birth` | 350 | 560 / 854 | 568 / 589 | 645 / 734 | 690 / 1383 | **2266 / 3325** |
| `03-symptom-short` | 700 | 709 / 813 | — | — | — | *tool-call turn* |
| `04-symptom-rambling` | 700 | 840 / 854 | — | — | — | *tool-call turn* |

All figures ms, p50 / p95, measured from the acoustic end of speech.

**Headline: p50 3158ms, p95 4633ms, best single turn 2222ms — against a 1000ms target.**

The estimate going in was ~1.2s. The measured result is **~3.2s, roughly three times over
budget**, and the shortfall is not concentrated in one place:

- **TTS is the worst offender by a wide margin.** 690–1605ms p50 and up to **2893ms p95**, against
  a 300–600ms estimate. This alone exceeds the entire latency budget. It confirms the pre-run
  concern about `gpt-4o-mini-tts` but understates how bad it is.
- **STT tail is ~5× the estimate.** 560–840ms from endpoint to final, against 60–150ms. The
  recognizer *is* streaming — a median of 6 partials arrive before the acoustic end, so this is
  genuinely tail cost and not full recognition — which means the number cannot be improved by
  streaming harder. It is the cost of finalizing.
- **LLM TTFT is the closest to estimate** at 568–663ms p50 against 250–450ms, and is the only hop
  that is merely disappointing rather than disqualifying.
- **Half of all turns produced a tool call and no speech at all.** 6 of 12 turns called
  `update_intake` and would need a *second* LLM round trip before the patient heard anything —
  on top of the 3.2s. This is the predicted worst case, and it occurred on every single intake
  turn, not occasionally.

### What this means

Sub-second on all-OpenAI is not reachable by tuning. Closing a 2.2s gap would require every hop
to improve severalfold simultaneously. The available responses are, in rough order of leverage:

1. **Replace TTS.** The single highest-value change; a fast provider is ~40–90ms TTFB against a
   690–1605ms measurement here. This alone recovers over half the gap, at the cost of a second
   vendor and a second BAA.
2. **Replace STT.** A recognizer with tunable endpointing finalizes in ~80–150ms. Recovers most of
   the remainder — but adds a third vendor.
3. **Move `update_intake` off the critical path**, as already planned. Given every intake turn
   tool-called, this is now clearly mandatory rather than an optimisation.
4. **Handle verification deterministically**, with no LLM at all. A date of birth and three digits
   is slot extraction plus a templated response.
5. **Accept a slower target** and design the experience around it — acknowledgement tones,
   visible "thinking" state — rather than pretending the latency is not there.

The compliance-versus-latency trade that motivated the single-vendor choice is real, but it is
now quantified: **one vendor costs roughly 2 seconds per turn.** That is a decision for the
project, not for this document — but it should be made against 3.2s, not against the 1.2s
estimate it was originally made against.

### Provider comparison — Groq and local options

Follow-up run, same fixtures and harness, swapping one hop at a time. The harness was
corrected first: an earlier version excluded tool-call turns from the headline, which
flattered the result badly once it turned out some models tool-call on nearly every turn.
Every figure below now includes the second LLM round trip where one occurred.

**Per-hop cost (ms, p50 range across fixtures):**

| Hop | OpenAI | Groq | Local | Verdict |
|---|---|---|---|---|
| **STT** | 641–883 *(tail only)* | 232–349 *(full)* | **149–232** *(full)* | **local wins, Groq close** |
| **LLM** | 611–1676 | **735–1319** *(two round trips)* | `llama3.2:1b` 1520–3601 · `llama3.1:8b` 6195–10302 | **cloud wins** |
| **TTS** | 534–1088 | **201–216** | Kokoro-82M **372–453** † | **Groq wins, narrowly** |

† Re-measured 2026-08-17. Was 1321–2470 originally; 758–1104 after the espeak fix below;
372–453 after batched streaming. Both changes are in `backend/tools/kokoro_server.py`.

**End-to-end configurations (acoustic end → first audible sample):**

| # | Configuration | p50 | p95 |
|---|---|---|---|
| A | all OpenAI | 3063 | 4054 |
| B | OpenAI STT · `llama3.1:8b` · OpenAI TTS | 13898 | 15779 |
| C | OpenAI STT · `llama3.2:1b` · OpenAI TTS | 4692 | 6544 |
| D | local whisper `base.en` · OpenAI LLM · OpenAI TTS | 2355 | 3149 |
| E | full local (whisper · `llama3.2:1b` · Kokoro) | 4386 ‡ | 6601 ‡ |
| F | local whisper `base.en` · Groq `gpt-oss-20b` · OpenAI TTS | 2497 | 2983 |
| G | Groq STT · Groq `gpt-oss-20b` · OpenAI TTS | 2073 | 2987 |
| H | all Groq, `gpt-oss-20b` | 1772* | 2343* |
| I | all Groq, `gpt-oss-120b` | 1943 | **2479** |
| **J** | **local whisper `base.en` · Groq `gpt-oss-120b` · Groq Orpheus** | **1699** | 3126 |
| K | all Groq, `qwen/qwen3.6-27b` | 1832 | 4416 |
| **L** | **Realtime API `gpt-realtime-2.1` (speech-to-speech)** | **1299** § | **2307** § |

\* H's headline is not comparable: 4 of its 12 turns produced *no speech at all* and are
absent from the average. I and J spoke on all 12.

‡ E was re-measured 2026-08-17 with both Kokoro fixes, over 20 turns (5 iterations per
fixture) rather than the 12 used for every other row. It is the only re-measured row; all
others are the original run and still carry Kokoro's pre-fix cost where they use it.
**E's headline barely moved** (5508 → 4496 → 4386) even though its TTS leg fell by ~700ms,
because `llama3.2:1b` dominates and is wildly variable — time-to-first-token ranged
1437–3093ms p50 across fixtures, with a 12.5s outlier. The TTS hop is no longer a
meaningful term in this configuration; the local LLM is the whole problem.

§ **L is the speech-to-speech baseline this document was always implicitly arguing against,
measured 2026-08-17 and never measured before.** Same four fixtures, same acoustic-end
definition, same hangover policy, tool calls executed and charged — see "The Realtime
baseline" below. Until it existed, a rigorously unflattering cascaded number was being
weighed against an assumed one.

**Direct-speech turns in J run 1185–1451ms** — the fastest cascaded configuration measured.
The entire remaining gap is the second LLM round trip.

**Local STT is a strict win, which is the counterintuitive result.** whisper.cpp `base.en`
via `whisper-server` does *full* recognition in 149–232ms — four to five times faster than
OpenAI's streaming recognizer spends merely *finalizing* — with accurate transcripts, on
the CPU, with no vendor involved. It improves latency and eliminates a PHI processor at the
same time, which is not a trade-off at all. The one thing it gives up is partial
transcripts, which forecloses speculative LLM start.

**Local LLM is not viable on this hardware, and the reason generalises.** The system prompt
is ~4KB of policy, so time-to-first-token is dominated by *prefill*, not generation. An
isolated test with a toy prompt showed `qwen3:4b` at 211ms; the same model class against the
real `instructionsFor(state)` prompt is an order of magnitude slower. This is precisely why
the harness feeds the real prompt — a toy-prompt benchmark would have endorsed a
configuration that fails in production.

**Kokoro-82M's fixed floor was a bug in the wrapper, not a property of the model.** The
original run measured ~950ms independent of text length and attributed it to per-call
overhead. That was correct as a measurement and wrong as a diagnosis: ~600ms of it was
grapheme-to-phoneme conversion, and it was flat because `kokoro_onnx`'s tokenizer calls the
module-level `phonemizer.phonemize()`, which **constructs a fresh `EspeakBackend` on every
call**. Constructing the backend costs ~600ms; the phonemization it then performs costs
~0.2ms. Every utterance was paying a full espeak-ng library and language-data
initialisation, and because the cost was fixed it fell hardest on exactly the short opening
span the patient waits through.

`backend/tools/kokoro_server.py` now builds one `EspeakBackend` at startup and passes
`is_phonemes=True`. Output is byte-identical — same sample counts, same waveform.
Interleaved A/B in one process, so thermals hit both paths equally:

| span | stock | resident backend | saved |
|---|---|---|---|
| `"Of course."` | 989ms | **345ms** | 644ms |
| 91-char sentence | 2506ms | **1790ms** | 716ms |
| 221-char paragraph | 4131ms | **3491ms** | 640ms |

**What remains is length-proportional, and there is a second floor.** Measured in isolation
with `npm run bench:tts -w threep-backend`:

| span | chars | ttfb = total | audio | rtf |
|---|---|---|---|---|
| first-span | 10 | **348ms** | 896ms | 0.39 |
| short | 36 | 594ms | 1963ms | 0.30 |
| sentence | 91 | 1208ms | 4288ms | 0.28 |
| long | 221 | 3482ms | 12715ms | 0.27 |

RTF is now near-flat at ~0.27–0.30 for anything longer than a few words, which is itself
the evidence the fixed tax is gone. The residual ~150ms in the first-span figure is ONNX
decoder cost, not espeak — so the floor is ~150ms, not ~950ms, and everything above it
scales with speech length.

**CoreML looks like a lever and is not.** It is marginally *slower* than CPU (352→369ms
first span, 1214→1242ms sentence). `kokoro_onnx` hardcodes `CPUExecutionProvider` at
`__init__.py:43` unless `ONNX_PROVIDER` is set, and setting it is a small loss, not a win —
the graph's STFT has dynamic shapes, so it partitions badly and falls back to CPU anyway
while paying transfer overhead.

**Streaming does work, but not at the transport layer.** Kokoro is non-autoregressive: one
decoder pass emits the entire waveform for a batch, so there is nothing to stream *within*
a batch and chunked transfer alone changes nothing. And `kokoro_onnx`'s `_split_phonemes`
only starts a new batch past 510 phonemes — the 10, 91 and 232-phoneme spans above are all
a single batch, so `create_stream()` would yield exactly once.

What does work is batching the phonemes ourselves, cutting a deliberately short opening
batch and emitting each batch's audio as it is decoded. `kokoro_server.py` now does this
and responds with `Transfer-Encoding: chunked`; the existing `compatTts` client reads it
unchanged. Per-batch cost is ~207ms + ~14ms/phoneme, so a short opener returns audio
quickly no matter how long the utterance is:

| span | chars | ttfb (buffered) | **ttfb (streamed)** | total | audio | rtf |
|---|---|---|---|---|---|---|
| first-span | 10 | 348ms | **345ms** | 345ms | 896ms | 0.38 |
| short | 36 | 594ms | **318ms** | 800ms | 2240ms | 0.36 |
| sentence | 91 | 1208ms | **365ms** | 1403ms | 4544ms | 0.31 |
| long | 221 | 3482ms | **434ms** | 3742ms | 12096ms | 0.31 |

**The point is the flatness, not the averages.** Time-to-first-audio is now ~320–430ms
regardless of utterance length, where before it grew without limit — a paragraph cost 3.5s
before a single sample arrived. Total synthesis time rises slightly (each batch pays the
~207ms decoder cost again), but rtf stays at ~0.31–0.36, so synthesis still outruns
playback by roughly 3× and every batch after the first lands well before it is needed.

**The cost is prosody, and it is not only the seams.** Each batch is an independent decoder
pass, so intonation resets at every boundary. Less obviously, `kokoro_onnx` selects the
voice style vector *by token count* (`voice[len(tokens)]`), so a short batch is not merely
a truncated version of the long one — it is spoken in a measurably different style. The
same sentence renders as 4.288s whole and 4.544s in two batches, ~6% slower. Cutting at
punctuation hides this well, since the listener expects a pause there; cutting mid-clause
to hit a size target does not. That is why only the *first* batch is cut aggressively
(`--first-batch-phonemes`, default 24) and later ones are cut long, and why the flag exists
at all — set it to 0 to synthesize whole and get the buffered column back.

**These numbers are structural, not perceptual.** No phonemes are lost (round-tripped in
test), byte counts match exactly, and levels are unclipped — but whether the seams are
*acceptable* on a clinical call is a listening judgement that has not been made yet.

At 345ms against Groq Orpheus's 201–216ms the gap is now ~140ms on the first span and no
longer widens with length, where before it was a factor of 5 and unbounded. Per the
Orpheus-on-Ollama measurement below, Kokoro remains the best local TTS on this machine.

**A model-quality signal worth more than the latency numbers:** `llama3.2:1b` called
`request_reschedule` in response to *"Yes, that's fine"* — the opposite of what the patient
said, in a tool that ends the call. Tool-selection accuracy in a clinical state machine
matters more than milliseconds, and small local models are not obviously safe here.

### Groq — measured 2026-08-12

Model choice was forced: Groq deprecates `llama-3.1-8b-instant` and `llama-3.3-70b-versatile`
on **2026-08-16**. The replacements are `openai/gpt-oss-20b`, `openai/gpt-oss-120b` and
`qwen/qwen3.6-27b`, and all three were benchmarked on the same fixtures.

**Groq TTS is the result this whole exercise was looking for.**
`canopylabs/orpheus-v1-english` returns first audio in **201–216ms**, against 534–1088ms for
`gpt-4o-mini-tts` and 372–453ms in-pipeline for Kokoro (after the espeak fix and batched
streaming above; it was ~950ms of apparently fixed overhead when this section was first
written, which is why the margin described here was once far larger). It is also the most
*stable*
number in the entire benchmark — p50 and p95 differ by 1–5ms across every fixture, where
OpenAI's TTS varied by more than a second. The hop that opened this investigation as the
single largest cost is now the smallest, and it is the one thing that moves the pipeline from
"3× over budget" to "arguably tunable".

**Groq STT is the other pleasant surprise.** `whisper-large-v3-turbo` does *full* recognition,
including uploading the utterance, in **223–349ms** — roughly a third of what OpenAI's
streaming recognizer spends merely finalizing, on a substantially better model than the local
`base.en`. Transcripts matched local whisper on all four fixtures. Local still wins outright
(149–244ms, and no vendor at all), but Groq STT makes the local-whisper dependency a
convenience rather than a necessity.

**The LLM hop is where the smallest model is the wrong choice, and the reason is safety, not
speed.** Asked *"Yes, that's fine"* in `verification`, `gpt-oss-20b` calls `verify_identity`
with arguments it invented — `{"dateOfBirth":"YYYY-MM-DD","phoneLast3":"123"}` on one run,
`{"dateOfBirth":"2000-01-01","phoneLast3":"123"}` on the next. The variation is the tell: this
is confabulation, not a fixed formatting bug. `verify_identity` counts each as a failed
attempt, and three of them lock the call (`MAX_VERIFICATION_ATTEMPTS`), so a model tic can
terminate a patient's intake. It is a worse failure than `llama3.2:1b`'s wrong-tool error,
because the arguments are PHI-shaped and the tool accepts them.

`gpt-oss-20b` fails a second way that the headline number hides: it tool-called on **every**
turn and then, on 4 of 12, produced no speech even after the second round trip. Its flattering
1772ms p50 is an average over the turns that happened to work.

Both larger models handle the same prompt correctly, answering *"Great, thank you. For privacy
I need to confirm a couple of details. Could you please tell me your date of birth?"* and
calling no tool at all.

| Model | Verification behaviour | Tool-call turns | Silent turns | p50 | p95 |
|---|---|---|---|---|---|
| `gpt-oss-20b` | **fabricates arguments** | 12/12 | 4/12 | 1772* | 2343* |
| **`gpt-oss-120b`** | **correct — asks for DOB** | 7/12 | 0/12 | 1943 | **2479** |
| `qwen/qwen3.6-27b` | correct — asks for DOB | 5/12 | 1/12 | 1832 | 4416 |

**`gpt-oss-120b` is the default**, on p95 rather than p50. `qwen3.6-27b` is a reasoning model:
it is fine when it speaks directly, but its tool-call turns cost 3020ms in the LLM alone
(4141ms p50 end-to-end), which is the worst case that matters in a pipeline where tool calls
are how the intake record gets written.

**Free-tier rate limits distort the measurement and had to be paced around.** The on-demand
tier allows 8000 tokens/min; one turn against the real prompt costs ~1200 per round trip, so
an unpaced run measures mostly 429s. `BENCH_TURN_DELAY_MS` was added to the harness for this
(22000ms for every run above). Shared on-demand capacity also means the p95 figures may
reflect queueing rather than compute — J's 3126ms p95 comes from a single slow LLM call out of
three on one fixture, and should not be read as a stable tail.

**Free-tier rate limits distort the measurement and had to be paced around.** The on-demand
tier allows 8000 tokens/min; one turn against the real prompt costs ~1200 per round trip, so
an unpaced run measures mostly 429s. `BENCH_TURN_DELAY_MS` was added for this
(`BENCH_TURN_DELAY_MS=22000` for the runs above). Two consequences: sample sizes are small
(n=10 of 12, n=7 of 8 — the remainder produced a tool call and no speech at all even after the
second round trip), and shared on-demand capacity means the p95 figures may reflect queueing
rather than compute.

### Orpheus locally, via Ollama — measured 2026-08-15

Groq's Orpheus was the single best result in this benchmark, which raises the question the
vendor discussion above could not answer: can the *same voice* run on the machine, with no
processor at all? That would collapse the compliance argument and the latency argument into
one answer. Ollama does carry Orpheus-3b GGUFs — `legraphista/Orpheus`, `sematre/orpheus`,
both repackaging lex-au's Orpheus-FastAPI weights — so the model is obtainable. It is not
sufficient.

**Ollama cannot emit audio, and this is structural rather than a missing feature.** It has no
`/v1/audio/speech` (404), and its model cards tag these builds `Text` accurately: Orpheus
generates SNAC *codec tokens* as text (`<custom_token_N>`), which a separate decoder must turn
into PCM. A local Orpheus is therefore two processes — Ollama for token generation, plus a SNAC
server in front of it. That server is the Orpheus-FastAPI shape, which is also the
`backend/tools/kokoro_server.py` shape, so it would drop into `LOCAL_TTS_URL` with no provider
code. The question is whether it is worth building.

**One piece of arithmetic answers that before any decoder exists.** SNAC at 24 kHz is 7 tokens
per frame at 12.5 frames/sec, so **87.5 tok/s is break-even with realtime playback**. Below
that the decoder starves — synthesis takes longer than the utterance takes to *play* — and no
amount of downstream chunking, buffering or streaming recovers it. Measured on
`legraphista/Orpheus:latest` (Orpheus-3b-FT, Q4_K_M, 2.4GB) on an M1 / 16GB, three iterations
per line, weights resident, no decoder in the loop:

| Line | Chars | First token | First audio* | Full utterance | Rate | Speech generated |
|---|---|---|---|---|---|---|
| short — *"Yes, that's right."* | 18 | 267 | 1365 | 11385 | 24.3 tok/s | 2.51s |
| verification — DOB request | 113 | 275 | 1394 | 27600 | 23.9 tok/s | 8.11s |
| intake — symptom follow-up | 103 | 272 | 1381 | 31491 | 24.0 tok/s | 8.19s |

All figures ms p50. \* first audio is the 28th SNAC token — four frames, the minimum
Orpheus-FastAPI's sliding window needs — and is therefore a *floor* that still excludes decode.

**24.1 tok/s mean against an 87.5 requirement is a realtime factor of 0.28.** An 8.1-second
reply takes ~29.5 seconds to synthesize. This is not a tuning gap; it is a 3.6× structural
shortfall, and it is measured before the decoder that would only add to it.

Three details make the result more informative than the headline:

- **First-token latency is fine (~270ms) and flat across all three lines.** Unlike the local
  *LLM* finding above, this is not a prefill problem — the TTS prompt is one short sentence,
  so there is nothing to prefill. It is pure generation throughput, which means the usual
  prompt-shrinking levers do not apply.
- **The cost scales far worse with speech length than Kokoro's.** Both scale — the claim
  here was originally that Kokoro's did not, which the espeak fix above showed to be an
  artefact — but Kokoro runs at rtf ~0.27, while Orpheus-on-Ollama needs another 87.5 tokens
  for every additional second of speech and produces ~24/sec, so it is roughly 3.6× short of
  realtime. On short verification lines the two are merely both bad; on a long intake
  response Orpheus is far worse. Even its *floor* — 1365–1394ms to the 28th token — is ~4×
  Kokoro's 348ms first span and ~6.5× Groq Orpheus's 208–216ms.
- **Quantization cannot rescue it.** The Q8 builds (`sematre/orpheus:en`, 4.0GB) are slower
  still, and the q2_k builds degrade audio tokens into audible artifacts rather than merely
  weaker prose — the failure mode is worse than for a text model, because there is no
  semantic redundancy for the decoder to lean on.

**This generalises the same way the local-LLM finding does.** A 3B model on this M1 runs at
~24 tok/s regardless of what its tokens mean; TTS is simply the workload that needs 87.5 of
them per second of output. The conclusion is about the hardware, not about Orpheus: a machine
with substantially more GPU throughput would change the answer, and nothing else will. **The
LLM-based local TTS route is closed on this hardware** — which leaves Kokoro, and after the
espeak fix above Kokoro is genuinely viable rather than merely the least bad local option.
The distinction matters: what is closed is running a *speech LLM* locally, not local speech
synthesis as such. A non-autoregressive 82M model does the job at rtf ~0.27 on the same CPU
that cannot keep a 3B autoregressive model within 3.6× of realtime.

### The Realtime baseline — measured 2026-08-17

`backend/src/bench/realtime.ts`, run with `npm run bench:realtime -w threep-backend`. It
drives the Realtime API over **WebSocket** rather than WebRTC, which is what makes a
headless comparison possible at all: no browser, no audio device, no echo canceller, and
the fixture is pushed in 20ms frames at real speed exactly as `latency.ts` pushes it at an
STT provider.

Three choices keep it a fair fight rather than a flattering one:

- **Turn detection disabled, buffer committed by hand** after exactly the hangover
  `latency.ts` uses for that state (350ms verification, 700ms intake). Letting server VAD
  endpoint the turn would compare OpenAI's silence policy against ours and call the
  difference an architecture result. `BENCH_RT_MODE=vad` runs it the other way; **that mode
  has not been run yet.**
- **Tool calls executed and the model called back**, so tool turns are charged their second
  round trip. Excluding them once flattered the cascaded numbers badly.
- **Reported from acoustic end of speech**, not endpoint-declared.

| | p50 | p95 | min | max | n |
|---|---|---|---|---|---|
| all turns | **1299** | 2307 | 872 | 2583 | 20 |
| spoke directly | 1106 | 1667 | 872 | 1692 | 15 |
| tool call first | 2182 | 2525 | 1825 | 2583 | 5 |

**Speech-to-speech is faster than the best cascaded configuration, and by more at the tail
than at the median** — 1299ms against J's 1699ms p50, and 2307ms against J's 3126ms p95.
Against configuration A, the all-OpenAI cascade that is the like-for-like vendor
comparison, it is 3063 → 1299ms. This is the result the two "must be proven" risks in the
Context section anticipated, and it is now a number rather than an expectation.

Note that L pays the same tool-call penalty the cascade does (2182ms against 1106ms), for
the same reason: the patient hears nothing until a second round trip completes. Removing
`update_intake` from the critical path is worth roughly as much to Realtime as to cascaded.

**The safety scan is measurably a race, and it is close to a coin flip.** The harness
records when the input transcript became available and when the model started speaking:

> the model started speaking **p50 49ms before** the input transcript existed, over 20 turns.
> **11/20 turns** had the model already speaking before the transcript the safety scan needs.

This is the architectural claim in the Context section, quantified. On more than half of
turns, `runSafetyCheck` in `useRealtimeConversation.ts` cannot gate anything — the
`response.cancel` claw-back at line 310 is load-bearing, not defence in depth. A patient
describing a red-flag symptom can hear the model begin an ordinary intake reply before the
escalation fires.

**But this is a configuration property, not a law of speech-to-speech.** With turn
detection disabled the client owns `response.create`, so it *could* withhold it until the
scan has run — converting the race into the same control-flow gate the cascade gives for
free. The cost is exactly the transcript wait, which measured p50 1073–1784ms across
fixtures against response starts of 1024–2182ms. Gating Realtime this way would therefore
land it somewhere near the cascade's numbers, which is the honest way to state the trade:
**the cascade is not buying a safety property Realtime cannot have; it is buying one
Realtime has to pay a comparable latency price for.**

What that leaves as genuinely exclusive to cascaded is durability — the conversation at
rest between turns with the message array ours — plus server-side audio capture. Those were
the findings that started this investigation, and they are the ones that survive the
measurement.

### Tool-free floor — the comparison with the confound removed

Every headline above averages one-round-trip and two-round-trip turns together, and **the
proportion differs by configuration**: 5/20 turns tool-called under Realtime, 15/20 under
full-local. A p50 over "all turns" is therefore partly a measurement of how often a given
model reached for a tool, not only of how fast its architecture is. The per-config
"spoke directly" rows do not fix this either — they are whichever turns *happened* not to
tool-call, which is a biased sample of the easy ones.

`BENCH_NO_TOOLS=1` withholds tools from both harnesses, so every turn is one round trip by
construction. Measured 2026-08-17, 3 iterations per fixture:

| Configuration | p50 | p95 | min | max | n |
|---|---|---|---|---|---|
| local whisper · Groq `gpt-oss-120b` · **local Kokoro** | 1636 | **2165** | 1200 | 2236 | 9 ¶ |
| **Realtime `gpt-realtime-2.1`** | **1445** | 2227 | 890 | 2328 | 12 |

**The architectures are within ~190ms at p50, and the cascade is marginally better at p95.**
That is a different conclusion from the tool-inclusive headline, where Realtime led by
400ms — most of that lead was the tool-call-rate confound rather than an architectural
advantage. Note also that both tool-free figures are *higher* than their respective
"spoke directly" rows (Realtime 1445 vs 1106; J 1185–1451), which is the bias predicted
above showing up as expected: removing tools measures the hard turns too.

The cascaded row here carries **Kokoro rather than Groq Orpheus**, costing it roughly 200ms
on the TTS hop — so a tool-free J would land near 1400ms, at or slightly ahead of Realtime.
The point is not that either wins; it is that **on latency the two are close enough that
latency should stop being the deciding argument.** Durability and server-side audio capture
were always the real reasons to prefer cascaded, and they survive this measurement intact.

This configuration is also the strongest PHI story measured: patient audio never leaves the
machine (local whisper), the reply is synthesised locally (Kokoro), and only the transcript
reaches a vendor. That is one processor to cover in the LLM hop, rather than three.

¶ **Nine of twelve turns, not twelve — and the harness caused it.** Three produced no
speech: `gpt-oss-120b` returned an empty completion. This was initially written up as a
model reliability signal alongside configuration H's silent turns. That was wrong, and the
distinction matters.

`instructionsFor()` mandates tool calls *in prose*. The intake role says "after every
patient answer, call `update_intake`"; the verification role says "call `verify_identity`
…". Withholding the tool schemas does not withhold those sentences, so a tool-free run
instructs the model to do something it has no means of doing. An empty completion is a
defensible response to a contradictory prompt. The fixture pattern fits: `03-symptom-short`
— an *intake* turn, where the `update_intake` directive is unconditional — lost two of its
three turns, while the verification fixtures, whose tool directive is conditional on having
collected both details first, mostly survived.

H's silent turns are a genuinely different failure: those occurred **with tools available**,
and remain a model reliability finding. This row's do not.

Two consequences. First, the tool-free latency figures stand — the turns that spoke were
timed correctly — but they are measured under a deliberately inconsistent prompt and should
be read as a floor, not as a configuration anyone would ship. Second, a proper tool-free
comparison needs a tool-free *prompt*, which is a change to `instructionsFor()` and has not
been made. `latency.ts` now reports a `spoke` column and warns when turns are missing, so
this cannot recur silently.

### Where this leaves the target

The best measured configuration is **J at 1699ms p50** — local whisper, Groq `gpt-oss-120b`,
Groq Orpheus. Against the 3063ms all-OpenAI starting point that is a **1.4s improvement**, and
the shape of the problem has changed completely:

| | Config A (start) | Config J (now) |
|---|---|---|
| STT | 641–883 | 158–241 |
| LLM | 611–1676 | 517–1010 |
| TTS | 534–1088 | **208–216** |
| Turns that spoke directly | — | **1185–1451ms** |

**Direct-speech turns are now within ~200–450ms of the target, and every remaining lever is
about the second LLM round trip rather than about vendors.** Tool-call turns cost 2153ms p50
against 1327ms for direct ones — an ~825ms penalty that is now the single largest term in the
budget, larger than any individual hop. In order of expected value:

1. **Eliminate the second round trip.** Moving `update_intake` off the critical path (write
   the record *after* speaking, not before) and handling verification deterministically covers
   most turns. This has been on the list since Stage 1 as an optimisation; it is now both the
   dominant latency lever *and* — per the fabricated-argument finding — a safety requirement.
2. **Pre-rendered emergency audio**, as already planned. `flag_emergency` fired on the
   rambling fixture, which is the correct call and also the slowest path measured. Escalation
   should never touch an LLM or a TTS vendor.
3. **Re-examine the target.** A ~1.2–1.4s direct turn with a 700ms intake hangover inside it
   is a defensible clinical experience. The sub-second figure in the requirements was written
   against a speech-to-speech architecture; it deserves restating as the state-dependent table
   at the top of this document rather than being carried over unchanged.
4. **Reconsider the vendor position.** J uses local STT plus Groq for two hops. Configuration
   I (all Groq, 1943ms p50 / 2479ms p95) is 244ms slower at p50 but has the better tail and
   one fewer moving part. Neither Groq nor a local model is BAA-covered today, which is the
   `PHI_MODE` question and not a latency one.

   **This conclusion was reversed by the espeak fix and should be re-read carefully.** It
   originally read that TTS is the hop where a vendor is unavoidable, on the strength of
   Kokoro's apparent ~950ms floor. That floor was a wrapper bug. Kokoro now returns first
   audio in **372–453ms in-pipeline against Groq Orpheus's 201–216ms** — a ~150–240ms
   difference, not a disqualifying one — and because batched streaming holds that figure
   flat regardless of utterance length, the gap no longer widens on long intake responses
   the way it did. A fully local, PHI-safe voice is therefore back on the table, and the
   BAA conversation no longer has to cover TTS as a matter of necessity. It remains a
   matter of choice: the gap is real, Groq Orpheus is still the most stable number in the
   benchmark, and the batching that buys the local win costs prosody at every seam.

   **The in-pipeline gap has since been closed in the server, not the chunker.** Kokoro
   measured 348ms on a 12-character span in isolation but 758–1104ms in-pipeline, because
   `firstChunkMinChars: 12` is a *floor*, not a target — `createChunker` emits at the first
   clause or sentence boundary *after* 12 characters, which for typical model output lands
   at 30–60. Batched streaming in `kokoro_server.py` makes this irrelevant: the server cuts
   its own short opening batch, so first-audio latency no longer depends on how long a span
   the language model happened to produce. In-pipeline TTS is now **372–453ms**, flat across
   all four fixtures. Tuning `createChunker` for latency is no longer necessary, which is
   the better outcome — its span sizes can now be chosen for prosody alone.

### Reproducing

```bash
# local STT — keeps the model resident; the CLI reloads weights per turn
whisper-server -m ~/.cache/whisper-models/ggml-base.en.bin --host 127.0.0.1 --port 8178

# local TTS. Leave ONNX_PROVIDER unset: kokoro_onnx defaults to CPU, and CoreML measured
# 2–5% slower (the graph's STFT has dynamic shapes, so it partitions badly and falls back).
# Streams by default, cutting a short opening batch; --first-batch-phonemes 0 disables it
# and synthesizes each span whole, which is the fair comparison for prosody.
~/.cache/kokoro-venv/bin/python backend/tools/kokoro_server.py --port 8179

# TTS in isolation — separates time-to-first-sample from time-to-complete, which the
# pipeline bench cannot see because it aborts after the first chunk.
VOICE_TTS=local LOCAL_TTS_URL=http://127.0.0.1:8179/v1 \
  npm run bench:tts -w threep-backend

# the speech-to-speech baseline (row L). Manual commit by default, so the hangover policy
# matches the cascaded bench; BENCH_RT_MODE=vad lets OpenAI endpoint the turn instead.
# Takes ~6 minutes: fixtures are streamed at real speed, as in the cascaded harness.
npm run bench:realtime -w threep-backend

# tool-free floor. BENCH_NO_TOOLS=1 works on both harnesses and removes the tool-call-rate
# confound that makes cross-architecture p50s only loosely comparable.
BENCH_NO_TOOLS=1 BENCH_ITERATIONS=3 npm run bench:realtime -w threep-backend

BENCH_NO_TOOLS=1 BENCH_ITERATIONS=3 BENCH_TURN_DELAY_MS=22000 \
  VOICE_STT=local LOCAL_STT_URL=http://127.0.0.1:8178/inference \
  VOICE_LLM=groq VOICE_TTS=local LOCAL_TTS_URL=http://127.0.0.1:8179/v1 \
  npm run bench -w threep-backend

# any combination of hops
VOICE_STT=local LOCAL_STT_URL=http://127.0.0.1:8178/inference \
  npm run bench -w threep-backend

# the best measured configuration (J). The delay is not optional on Groq's free tier —
# without it the benchmark measures the rate limiter rather than the pipeline.
BENCH_TURN_DELAY_MS=22000 \
  VOICE_STT=local LOCAL_STT_URL=http://127.0.0.1:8178/inference \
  VOICE_LLM=groq VOICE_TTS=groq \
  npm run bench -w threep-backend

# Orpheus-on-Ollama go/no-go. Measures SNAC token generation rate against the 87.5 tok/s
# realtime break-even — deliberately no decoder, since below break-even one is pointless.
ollama pull legraphista/Orpheus:latest
node backend/tools/orpheus_throughput.mjs
```

### Caveats on these numbers

- **Fixtures are synthetic.** TTS-generated speech is cleaner than a real patient on a real
  microphone, so the STT figures are a *floor*. Real recordings will be worse, not better.
- Single machine, single network location, small sample. The p95 figures in particular are drawn
  from only 3 iterations per fixture and should be treated as indicative. Row L and the
  re-measured row E use 5 per fixture (20 turns).
- **Row L has not been run in `BENCH_RT_MODE=vad`.** Production would use server VAD, which
  endpoints on its own silence policy rather than ours; the manual-commit figure is the
  architecture comparison, not necessarily the number a shipped Realtime call would show.
- **Row L is one run on one afternoon.** The cascaded rows were measured 2026-08-12 and L on
  2026-08-17, so any change in OpenAI-side load between those dates lands entirely in this
  comparison. It should be re-run alongside A before anything irreversible is decided on it.
- Measured server-side only. Stage 2 adds browser capture, WebSocket transport and jitter-buffer
  priming on top of everything above.

---

## Stage 2 — Live duplex spike

Per-turn HTTP meets neither requirement: uploading a complete utterance forfeits the entire
speech duration before STT can start, and there is no channel on which to interrupt. This needs a
**duplex WebSocket** — PCM frames up, PCM frames down, JSON control both ways.

### Backend — new `backend/src/voice/`

`wsServer.ts` (a `ws` upgrade on the existing Express server), `session.ts` (per-connection state,
one `AbortController` per turn), `generation.ts` (LLM → chunker → TTS → frames, abortable at any
point), and `providers/openai/{stt,llm,tts}.ts` promoted from `bench/`.

- **Sentence chunking is the largest lever on perceived latency.** `chunker.ts` is a pure function
  with no I/O, making it the cheapest high-value test in the project. Emit the first chunk at ~12
  characters for speed and ~40 thereafter for prosody, with a hard flush at 140. Never split
  inside a decimal (`3.5`), an abbreviation (`Dr.`, `a.m.`), or a list marker.
- **Feed chunks into a single TTS *session*, not one request per sentence.** Per-sentence requests
  pay TTFB every sentence and produce audible prosody seams at every boundary.
- **Turn generation counter.** Bump on every cancel; every async callback checks
  `if (gen !== session.turnGen) return;` before touching state. This eliminates the
  late-delta-from-a-dead-turn bug class outright — the same class the current hook wrestles with
  via `activeResponseRef` and `pendingAlertRef`.
- **Cancel order on barge-in:** bump generation → `tts.cancel()` → `llm.abort()` → ack. TTS first,
  because it is what is making noise.

### Frontend — new `frontend/src/audio/`

`capture-worklet.js` and `playback-worklet.js` live in `frontend/public/audio/` (served raw, not
bundled), alongside `capture.ts`, `playback.ts`, `vad.ts`, `ringBuffer.ts` and `useVoiceBench.ts`.
The UI mounts on a `#/bench` hash route in `main.tsx`, matching the existing `#/styleguide`
pattern — no router dependency, and `App.tsx` is untouched.

- **Capture:** `getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression:
  true, autoGainControl: true } })`. **Keep all three enabled.** Disabling NS/AGC "for STT
  quality" is a trap — the assistant re-triggering its own VAD is a far worse failure than a few
  dB of quality. Run the AudioContext at 48kHz (Safari ignores the `sampleRate` hint), resample
  48k→16k inside the worklet, and accumulate 128-sample render quanta into 320-sample (20ms)
  frames posted as transferable `Int16Array`. Never `ScriptProcessorNode`.
- **Playback must be a worklet ring buffer, not a queue of scheduled `AudioBufferSourceNode`s.**
  Scheduled sources cannot be cancelled cheaply below their scheduled boundaries, which defeats
  the purpose. A worklet ring flushes in **one render quantum (~2.7ms)**, with a 10ms cosine fade
  to avoid a click. It also counts rendered samples, so it knows `playedMs` exactly — which is
  what will later let the server record what the patient *actually heard*.
- **VAD:** `@ricky0123/vad-web` (Silero v5, ~1–2ms per frame with WASM SIMD), with an energy+ZCR
  fallback so a WASM load failure degrades the call rather than killing it.
- **Duck before stop, using two thresholds.** Speech onset (p>0.6 sustained ~64ms) **ducks
  playback to 20%** rather than stopping it. Full stop and server cancel fire only after ~300ms of
  sustained speech *or* a non-empty STT partial. A cough should cost 300ms of quiet, not a
  destroyed turn.
- **Barge-in is local-first:** fade and flush locally *first*, and send `barge_in` in the same
  tick. Waiting for the server round trip is audible.
- **Prefix every binary audio frame with a 4-byte turn sequence number.** Four bytes eliminates
  the entire "stale audio from the cancelled turn plays over the new one" bug class.

### Two clinical controls built in from the start

**`BARGE_IN_POLICY`** — a table in `shared/src/machine.ts` beside `TOOL_STATES`, because it is the
same kind of table and belongs in the same file. Every state is `"allow"` except
**`alert: "duck_only"`**: the emergency instruction always finishes. One line, expressed as data,
testable in `machine.test.ts` alongside the existing structural invariants.

**Server-side echo suppression by text similarity.** The server knows exactly what it is currently
speaking and how far into it. If an STT partial has ≥0.6 token overlap with the in-flight TTS
text, treat it as AEC leakage and drop it. Roughly 30 lines, and it catches what browser AEC
misses on speakerphone and Bluetooth — where AEC is defeated outright by variable output delay.

---

## Metrics the spike must report

| Metric | Definition | Target |
|---|---|---|
| **`T_response_start`** | **acoustic** speech end → first audible sample | per the state-dependent table above |
| `T_endpoint` | acoustic end → endpoint declared | 350ms verification / 700ms intake |
| `T_stt` / `T_llm` / `T_tts` | per-hop, as Stage 1 | — |
| `T_play` | first audio byte received → first sample audible | < 60ms (3-frame prime) |
| **`T_bargein`** | speech onset during playback → playback silent | < 200ms |
| **False barge-in rate** | VAD triggers during 60s of assistant speech, quiet room, no input | **0** |
| Escalation path | acoustic end → first sample of pre-rendered emergency audio | ~400ms |

The false barge-in rate is the echo-cancellation test. Any non-zero value means AEC is failing and
barge-in is unshippable until it is fixed.

---

## What is reused

The safety-critical core is transport-agnostic and carries over **unchanged**:
`shared/src/machine.ts`, `redFlags.ts`, `intakeFields.ts`, `backend/src/policy/*`,
`backend/src/safety/*`, and the pure tool handlers in `backend/src/tools/index.ts`. All four
existing test files (`machine.test.ts`, `tools/gating.test.ts`, `tools/verify.test.ts`,
`safety/scan.test.ts`) must keep passing untouched — this work adds surface, it does not modify
the state machine. That property is the direct payoff of ADR 0001.

`sessionConfigFor("intake")` is reused for prompt realism in both stages. `toRealtimeToolSchemas`
needs a *sibling* for the Chat Completions tool shape rather than being modified in place.

**Added dependencies:** backend `ws` and `@types/ws`; frontend `@ricky0123/vad-web`.

**Untouched:** `useRealtimeConversation.ts`, `App.tsx`, `POST /api/session`, `/api/tools/:name`
and `/api/safety-check`. The WebRTC path keeps working as the A/B baseline — which is the point,
since it is what the cascaded numbers must actually be judged against.

---

## Verification

1. `npm test` at the root — the four existing suites pass, proving the core is unmodified.
2. `npm run bench -w threep-backend` — per-hop p50/p95 table across all fixtures. **This is the
   gate decision**; capture the output into this document.
3. `npm run dev:backend` and `npm run dev:frontend`, then open `#/bench`:
   - ~20 short answers → p50/p95 `T_response_start`, measured from acoustic end.
   - Interrupt mid-sentence → audio stops, `T_bargein` recorded.
   - Assistant talks for 60s in a quiet room with no speech → false barge-in count is **0**.
   - Rambling fixture with a deliberate mid-sentence pause → the endpointer does not cut in.
   - Trigger a red flag → pre-rendered audio plays and the LLM is never called.
4. A/B against the WebRTC path on the main route, same utterances, same machine — an honest delta
   rather than an absolute judged against a spec number.
5. New tests (`node:test`, matching the existing `tsx --test` setup): chunker boundary cases
   (decimals, abbreviations), `ringBuffer.ts` pure math, generation abort terminating both streams
   and discarding late frames, and `BARGE_IN_POLICY.alert === "duck_only"` in `machine.test.ts`.

---

## Risks

1. **Endpointing cuts a patient off mid-symptom.** The top clinical risk, and in direct tension
   with the latency requirement. *"It started… [thinks] …maybe Tuesday, and my neck's been stiff"*
   is clipped after "started" at a 300ms hangover — and the clipped clause is a red flag.
   Mitigated by the state-dependent hangover plus **soft commit**: if speech resumes within 1.5s
   of an endpoint and the assistant has not yet spoken, merge into the same user turn and re-scan
   the concatenation.
2. **AEC leakage causing false barge-in**, worst on speakerphone and Bluetooth. The pathological
   case is the assistant's own emergency instruction interrupting itself. Mitigated by
   duck-before-stop, the 300ms sustain threshold, server-side text-similarity echo suppression,
   and `BARGE_IN_POLICY.alert`.
3. **All-OpenAI cannot hit the targets**, with `gpt-4o-mini-tts` TTFB the specific weak link.
   Stage 1 exists to force that trade into the open with real numbers rather than estimates.
4. **LLM TTFT p95** (~1200ms against a ~300ms p50) blows the budget on roughly one turn in twenty.
   Do **not** play early conversational fillers as mitigation — in a clinical context a synthetic
   "mm-hm" reads as feigned understanding. A "one moment" only after 1.5s.
5. **Tool-call turns are the latency worst case** — two LLM round trips with no speech between.
   Measured separately in Stage 1.
