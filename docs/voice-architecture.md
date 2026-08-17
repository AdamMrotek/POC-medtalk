# Voice architecture

**Status:** proposed — decision pending; transport prototyped
**Evidence:** `docs/voice-pipeline-benchmark-plan.md` (measurements, 2026-08-12 → 2026-08-17)
**Prototype:** `backend/src/agent/index.ts` (LiveKit agent, written 2026-08-17, not yet run — see §3)
**Scope:** which architecture the assistant ships on, how it is deployed, and how providers are swapped.

The benchmark document records *what was measured* and reads as a lab notebook. This document is the
decision: requirements first, then the three architectures worth considering, then deployment and
provider strategy. Every number here is a citation of that document, not a new claim.

---

## 1. Requirements

Eight requirements, ordered by how hard they are to retrofit. R-1 and R-2 are architectural — a
design either has them or it doesn't. The rest are tunable.

### R-1 · Data ownership

The conversation must be **at rest between turns**, with the message array held by us.

- Durability, pause/resume and server-side audio capture become properties of the shape rather than
  features to build.
- Speech-to-speech makes the conversation a live stream owned by the vendor: snapshotting a moving
  thing you cannot reattach to.

**Test:** can a call be resumed after a process restart?

### R-2 · Safety gate

The red-flag scan must be **control flow, not a race**: STT text → `scanForRedFlags` → LLM, with the
LLM never called on a flagged utterance.

- `scanForRedFlags()` in `backend/src/safety/scan.ts` is synchronous and pattern-based, so the gate
  itself costs no measurable time.
- Measured on the current Realtime path: the model started speaking **p50 49ms before the transcript
  existed**, and **11 of 20 turns** had it already speaking before the scan had anything to read. The
  `response.cancel` claw-back is load-bearing, not defence in depth.

**Test:** on a red-flag utterance, is the LLM invocation count zero?

### R-3 · Latency, state-dependent

A single sub-second target is the wrong requirement. Targets differ by state:

| Path | Endpoint hangover | Target (acoustic end → first audio) |
|---|---|---|
| `verification` — DOB, digits, yes/no | 350ms | ~870ms |
| Red-flag escalation | 350ms | ~400ms (pre-rendered audio) |
| `intake` — open symptom description | 700ms | ~1.3s |

All figures are measured from the **acoustic end of speech**, not from endpoint-declared. Vendor
latency claims use the latter and are not comparable.

### R-4 · Clinical safety over perceived speed

Cutting a patient off mid-symptom is a clinical harm; 300ms of snappiness is not.

- *"It started… [thinks] …maybe Tuesday, and my neck's been stiff"* is clipped after "started" at a
  300ms hangover — and the clipped clause is a red flag.
- Hence 700ms in `intake`, and **soft commit**: if speech resumes within 1.5s and the assistant has
  not spoken, merge into the same turn and re-scan the concatenation.

Generic voice-agent guidance recommends aggressive 400ms endpointing. It does not apply here.

**Corollary, once a framework is in the picture:** the hangover and the speed knob are two different
settings, and conflating them is the failure mode this requirement guards against. In the LiveKit
agent, `endpointing.minDelay` stays at 700ms and latency is won from `preemptiveGeneration`
instead — see §5.

### R-5 · Tool-call correctness

The LLM must not fabricate tool arguments. This outranks latency.

- `gpt-oss-20b` called `verify_identity` with invented arguments
  (`{"dateOfBirth":"YYYY-MM-DD","phoneLast3":"123"}`). Three failed attempts hit
  `MAX_VERIFICATION_ATTEMPTS` and lock the call — a model tic can end a patient's intake.
- `llama3.2:1b` called `request_reschedule` in response to *"Yes, that's fine."*
- `gpt-oss-120b` and `qwen3.6-27b` both handle the same prompt correctly.

**Smaller is not better here.** Any model change requires re-running the verification fixtures.

### R-6 · PHI and processor minimisation

Every hop that sees patient data is a processor to cover by a BAA and a supplier assessment.

- Sensitivity is not uniform: **audio is more sensitive than transcript** (voice is biometric, and
  it carries distress and background context the transcript drops).
- `PHI_MODE=true` refuses to start if any selected provider is not BAA-covered. Neither Groq nor any
  local model is covered today.
- Ranked best to worst: nothing leaves → transcript only leaves → audio leaves.

### R-7 · Barge-in

The patient must be able to interrupt, except during escalation.

- `BARGE_IN_POLICY` in `shared/src/machine.ts`: every state `"allow"`, `alert` is `"duck_only"` —
  the emergency instruction always finishes.
- Duck before stop: onset ducks to 20%; full stop needs ~300ms sustained speech. A cough should cost
  300ms of quiet, not a destroyed turn.
- **False barge-in rate in a quiet room must be 0.** Any non-zero value means echo cancellation is
  failing and barge-in is unshippable.

### R-8 · Provider portability

No provider may be hardcoded. `VOICE_STT` / `VOICE_LLM` / `VOICE_TTS` select each hop independently,
because the right answer differs per hop and changes as vendors ship. See §4.

---

## 2. Architecture options

Three candidates. All three satisfy R-3 within a few hundred milliseconds of each other, so **latency
is not the deciding argument** — R-1, R-2 and R-6 are.

### Option A · Realtime (speech-to-speech)

Browser opens WebRTC directly to the vendor. Current shipped design.

- **Measured:** 1299ms p50 / 2307ms p95. Fastest of the three.
- Echo cancellation, barge-in and jitter buffering come free with WebRTC.
- **Fails R-1** — the conversation is the vendor's live stream.
- **Fails R-2 as configured** — the scan races generation on 11/20 turns. It *can* be gated by
  withholding `response.create` until the scan runs, but that costs the transcript wait (p50
  1073–1784ms), landing it near the cascaded numbers anyway.
- **Fails R-6** — all patient audio leaves.
- ~**$0.10+/call-minute**, and it never amortises.

### Option B · Full Groq (cascaded, single vendor)

All three hops at Groq. `whisper-large-v3-turbo` · `gpt-oss-120b` · `orpheus-v1-english`.

- **Measured:** 1943ms p50 / **2479ms p95** — the best tail of any cascaded configuration.
- **Satisfies R-1, R-2, R-5, R-7.**
- Simplest cascaded option: one vendor, one contract, one supplier assessment, no infrastructure.
- **Fails R-6** — all patient audio leaves, to a vendor with no BAA today.
- Groq TTS is the most *stable* number in the benchmark: p50 and p95 differ by 1–5ms.

### Option C · Hybrid — local STT · Groq LLM · local TTS ← recommended

whisper.cpp `base.en` and Kokoro-82M run on our infrastructure; only the transcript reaches a vendor.

- **Measured:** 1636ms p50 / **2165ms p95** (tool-free comparison; beats Realtime's 2227ms p95).
- **Satisfies R-1, R-2, R-5, R-7.**
- **Best R-6 position measured.** Patient audio never leaves our infrastructure. One processor to
  cover, in the hop that carries the least sensitive representation.
- Local STT is a strict win, not a trade: whisper `base.en` does *full* recognition in 149–232ms,
  faster than OpenAI's streaming recognizer spends merely finalizing.
- **Cost:** ~$0.003/call-minute at scale, ~30× cheaper than Option A.
- **Gives up partial transcripts**, which constrains speculative execution (see §5).
- Variant **C′** swaps Kokoro for Groq Orpheus: 1699ms p50, ~200ms faster, but audio synthesis
  leaves our infrastructure.

### Comparison

| | A · Realtime | B · Full Groq | C · Hybrid |
|---|---|---|---|
| Latency p50 | **1299ms** | 1943ms | 1636ms |
| Latency p95 | 2307ms | 2479ms | **2165ms** |
| R-1 data ownership | ✗ | ✓ | ✓ |
| R-2 safety gate | ✗ (race) | ✓ | ✓ |
| R-6 audio leaves | yes | yes | **no** |
| Processors on PHI | 1 | 1 | **1 (transcript only)** |
| Cost / call-minute | ~$0.10+ | ~$0.003 | ~$0.003 |
| Infrastructure to run | none | none | STT + TTS servers |
| Barge-in / AEC | free | free via LiveKit | free via LiveKit |

The barge-in/AEC row assumes the LiveKit transport in §3, which applies equally to B and C and adds
an SFU (LiveKit Cloud, or self-hosted Apache-2.0) to the infrastructure row for both.

**Recommendation: Option C**, with B as the fallback if operating inference servers proves
unacceptable and A retained as the A/B baseline. C wins on every requirement that cannot be
retrofitted, ties on p95, and costs a fraction of A. The 337ms it gives up at p50 against A buys data
ownership, a real safety gate, and keeping patient audio in-house.

### What is true regardless of choice

- **The tool-call round trip is the single largest term in the budget** — 2153ms against 1327ms for
  direct-speech turns, an ~825ms penalty larger than any individual hop. Moving `update_intake` off
  the critical path and handling verification deterministically helps A, B and C equally.
- **Pre-rendered emergency audio** — the 11 red-flag scripts and the closing lines in
  `backend/src/policy/blocks.ts` are static text. Synthesizing them at build time puts escalation at
  ~400ms with no LLM and no TTS vendor in the loop. Best latency result available, on the most
  safety-critical path.

---

## 3. Deployment

### What cannot be serverless

Lambda cannot host the call. No inbound UDP, no process that outlives a request, no per-connection
memory — and the session state that matters (one `AbortController` per turn, the turn generation
counter, in-flight TTS text for echo suppression) has nowhere to live. Cost is not the obstacle;
architecture is.

Lambda **is** a good fit for the stateless endpoints: `POST /api/session`, `/api/tools/:name`,
`/api/safety-check`. Note the irony — Option A is Lambda-shaped; cascaded forces a server.

Scale-to-zero is a footgun for the same reason everywhere it is offered (Fly, Render, Railway
serverless): the first call after idle reloads ONNX and GGML weights. Disable it explicitly.

### Concurrency — one server handles many calls

Almost nothing in a call is CPU work:

| Phase | Wall clock | Local CPU |
|---|---|---|
| Patient speaks | ~5s | 0 |
| Endpoint hangover | 0.35–0.7s | 0 |
| STT | 0.2s | **0.2s** |
| LLM (network wait) | 0.5–1.0s | 0 |
| TTS (~4s reply, rtf 0.3) | 1.2s | **1.2s** |
| Assistant speaks | ~4s | 0 |

~1.4s of CPU per ~10.5s turn ≈ **13% duty cycle**. Plan on **~4 concurrent calls per vCPU** and
verify under load. Node is doing I/O only and is not the bottleneck; the inference processes are.

> **Blocker before any load test.** `backend/tools/kokoro_server.py` is a `ThreadingHTTPServer`
> sharing one module-level `EspeakBackend` (line 300). espeak-ng is not thread-safe, so concurrent
> synthesis can corrupt phonemes. Fix with a lock around phonemization (~0.2ms, so it costs nothing)
> and set `intra_op_num_threads` so concurrent ONNX runs don't oversubscribe every core.

### Sizing

**Portfolio / demo — a few hours a month.** Don't self-host the models. Option B makes the server a
plain Node process: no weights, no Python venv, seconds to deploy. Groq usage at this volume is
pennies. Choose an always-warm host (~€4/mo VPS) over a scale-to-zero tier — a cold start means a
visitor waits 30 seconds and leaves.

**Enterprise — 20–30 baseline, 1000 peak.**

| | Concurrent | vCPU (STT+TTS) | Instances |
|---|---|---|---|
| Quiet | 20–30 | ~8 | 1 × `c7g.2xlarge` |
| Peak | 1000 | ~250 | 8 × `c7g.8xlarge` (~$10/hr) |

- **Autoscale on concurrent calls, not CPU.** At 13% duty cycle, CPU-based scaling oscillates. A
  33–50× swing cannot be handled reactively — booting and loading weights takes minutes — so use
  scheduled scaling if peaks track clinic hours.
- **Scale-in must drain, never terminate.** A WebSocket pins a call to a box; killing it drops a
  patient mid-intake. 10–15 minute drain, stop accepting new calls first. This also rules out Spot
  for the call-serving tier: a 2-minute interruption notice is not enough to finish a conversation.
- **Colocate** Node, whisper-server and kokoro_server on each instance so `LOCAL_STT_URL` and
  `LOCAL_TTS_URL` stay on loopback. "One instance = N concurrent calls" is the scaling unit.
- Use **AWS or GCP**, where a BAA is standard and free. No PaaS evaluated will cover PHI at a
  sensible price.

### Transport — LiveKit, prototyped

LiveKit dissolves the tradeoff the benchmark document treats as inherent. The patient connects over
**WebRTC** to an SFU; the agent is a long-lived process receiving decoded frames. Result: AEC,
jitter buffering and barge-in come free *and* the pipeline stays cascaded.

It replaces most of the planned Stage 2 — session/generation management, the turn generation
counter, cancel ordering, sentence chunking, the capture and playback worklets, the ring buffer,
in-browser VAD, and the text-similarity echo suppression. Its contextual **turn-detector model**
also attacks R-4 more directly than a fixed hangover can, by predicting semantic completion rather
than acoustic silence.

Two further benefits at scale: WebRTC carries Opus, removing the ~$15/hr egress that raw PCM would
cost at 1000 concurrent calls; and SIP/telephony is built in, which matters if patients ever phone in.

```
browser ──WebRTC──> LiveKit SFU ──> agent (Node, TypeScript)
                                      ├ STT / LLM / TTS  → Groq (OpenAI-compatible)
                                      ├ VAD              → Silero
                                      ├ turn detection   → LiveKit turn-detector model
                                      ├ gate             → runSafetyCheck → StopResponse
                                      └ tools            → runTool (unchanged)
```

**The cost that was priced in is not real.** The earlier assumption here was that LiveKit Agents is
Python-first, forcing the agent to reach the TypeScript safety core over loopback HTTP. It isn't:
the **Node SDK is at 1.6.4** with the plugins in lockstep, so the agent is TypeScript and
`runSafetyCheck` / `runTool` are called **in-process**. No second language, no HTTP hop on the
safety path, and no risk of a second `redFlags.ts`. `/api/safety-check` stays for the browser path
only.

**R-2 becomes actual control flow.** The gate is `onUserTurnCompleted` → `runSafetyCheck` →
`throw new StopResponse()`. The hook runs after the user turn is committed to the chat context and
before any reply is released, so on a flagged utterance the LLM invocation count is zero — the R-2
test, passed by construction rather than by a `response.cancel` claw-back.

Everything else stays ours: `createSession()` / `getRecord()` in `intakeStore.ts` are untouched, and
every tool routes through `runTool()`, so `isToolAllowed()`, the state transitions and
`MAX_VERIFICATION_ATTEMPTS` keep adjudicating. The model proposes; `runTool` decides.

**Verify before committing:**

- Whether LiveKit Cloud will sign a BAA at an acceptable tier. If not, the SFU is Apache-2.0 and
  self-hostable. (Unchanged, and still the decision that gates R-6.) Note what this costs Option C
  if hosted: the SFU terminates DTLS-SRTP, so **LiveKit Cloud is a second processor that sees
  patient audio** — the exact thing Option C exists to avoid. Self-hosting the SFU alongside the
  agent keeps the "one processor, transcript only" position; hosting it does not.
- The prototype has been **read against the real type definitions but never typechecked or run** —
  the LiveKit packages are not in `backend/`. Install and typecheck is the next step:

  ```
  npm i -w threep-backend @livekit/agents @livekit/agents-plugin-openai \
    @livekit/agents-plugin-silero @livekit/agents-plugin-livekit zod
  ```

- Issue **livekit/agents-js#1365** before any latency measurement — see §5.

---

## 4. Model switching

### The seam

Each hop is selected independently by environment variable, because the right answer differs per hop
and changes as vendors ship:

```
VOICE_STT / VOICE_LLM / VOICE_TTS  =  openai | groq | local
VOICE_PROFILE                      =  sets all three at once
PHI_MODE=true                      =  refuses to start on any uncovered provider
```

Everything speaks the **OpenAI-compatible shape** — including `kokoro_server.py`, which serves
`/v1/audio/speech`. Consequences worth keeping:

- A new vendor is usually a base URL, not a provider implementation.
- The local servers drop into LiveKit's OpenAI plugin unchanged.
- `npm run bench` sweeps any combination without code edits.

### Current selections

| Hop | Choice | Why | Locked? |
|---|---|---|---|
| STT | local whisper `base.en` | 149–232ms full recognition, no vendor, satisfies R-6 | soft |
| LLM | Groq `gpt-oss-120b` | best p95 **and** correct verification behaviour (R-5) | **hard — R-5** |
| TTS | local Kokoro-82M | 372–453ms in-pipeline, flat across utterance length | soft |

The LLM choice is pinned by safety, not speed. Every candidate must pass the verification fixtures
before it is considered — `gpt-oss-20b` is faster on paper and disqualified.

### Not yet evaluated

- **Cartesia Sonic / ElevenLabs Flash.** Claimed sub-100ms TTFB against Kokoro's 372–453ms. A real
  gap: the benchmark cites "~40–90ms for the fastest alternatives" but never measured them.
  `npm run bench:tts` already exists. Note the tension — hosted TTS is priced per character, which
  is where cost concentrates at 1000 concurrent, and it moves synthesis off our infrastructure.
- **Deepgram / AssemblyAI streaming STT.** Only reason to consider: they emit partial transcripts,
  which local whisper does not. See §5.
- **LiveKit's turn detector**, against the 700ms hangover on `04-symptom-rambling`.

### Closed

- **Local LLM.** Not viable on this hardware. The ~4KB policy prompt makes time-to-first-token a
  prefill problem: `llama3.2:1b` measured 1520–3601ms, `llama3.1:8b` 6195–10302ms. Generalises to
  any machine without substantially more GPU throughput.
- **Local Orpheus via Ollama.** 24.1 tok/s against an 87.5 tok/s realtime break-even — a 3.6×
  structural shortfall, measured before the decoder that would add to it.
- **CoreML for Kokoro.** Marginally slower than CPU; the graph's STFT has dynamic shapes and
  partitions badly.

---

## 5. Open decisions

| # | Decision | Owner | Blocking |
|---|---|---|---|
| 1 | Adopt Option C, or B if running inference servers is unacceptable | project | everything below |
| 2 | BAA position — is Groq acceptable for the transcript hop under `PHI_MODE`? | compliance | R-6 sign-off |
| 3 | LiveKit vs hand-rolled Stage 2 | engineering | Stage 2 start — leaning LiveKit, prototype written |
| 4 | Restate the sub-second target in `clinical-voice-assistant-requirements.md` as the R-3 table | project | — |
| 5 | ~~Build speculative execution?~~ Verify LiveKit's, incl. agents-js#1365 | engineering | latency measurement |

### On decision 5 — speculative execution with a commit barrier

**Mostly answered: LiveKit already implements this, and its defaults are the commit barrier we
designed.** What remains is verification, not construction.

The design below was: fire STT on the buffer at ~150ms of silence, run the LLM and TTS
speculatively, and **hold the audio server-side** until the final transcript exists and the scan
passes. R-2 is preserved because nothing is ever emitted — no claw-back, unlike Option A.

- Estimated saving **~550ms**, recovering most of the gap to the R-3 targets.
- The hangover stops being dead time and becomes an overlap window — which means it partly
  *dissolves* the R-3/R-4 tension rather than trading against it.
- With local whisper this needs no streaming partials: if no audio arrives between the speculative
  pass and the endpoint, the transcript is identical by construction and there is no commit check to
  get wrong. Cost is ~2× STT, not 10×.
- **Tool dispatch must be gated with the audio.** A discarded speculation that already ran
  `verify_identity` would burn an attempt toward `MAX_VERIFICATION_ATTEMPTS`. Record the tool call
  speculatively, dispatch only after the gate passes — which also makes tool turns ~550ms faster.
- Keep the two checks separate: the **scan on the final transcript** decides *safe*; prefix-extension
  decides *still apt*. Merging them into one boolean is how this gets silently broken —
  *"my head hurts"* → *"my head hurts and I can't see out of my left eye"* is a valid
  prefix-extension whose meaning is a red flag.
- One explicit gate state (`pending | released | discarded`), not two booleans, with the only
  transition to `released` inside the scan callback.
- **Costs ~33% more infrastructure** — discarded speculation means re-synthesis, and TTS dominates
  CPU. Flag-gated, never default.

### What LiveKit gives for free, and what it does not

**`preemptiveGeneration` is the speed knob, not `endpointing.minDelay`.** It fires the LLM as soon
as a transcript arrives, without waiting for the turn to be confirmed — so inference overlaps the
endpointing wait and the 700ms hangover becomes the overlap window rather than dead time. The
clinical hangover is untouched. This is the "partly dissolves the R-3/R-4 tension" claim above,
already implemented.

**The commit barrier is the default configuration.** `preemptiveGeneration.enabled` defaults to
true and `preemptiveTts` defaults to false: the LLM speculates, but **no audio is synthesised until
the turn is confirmed**, which happens after `onUserTurnCompleted` — i.e. after the scan. The safety
gate is ahead of anything the patient can hear without us building the gate state machine.
Mutating the chat context in that hook discards and regenerates the speculative response;
`StopResponse` discards it outright. Turning `preemptiveTts` on trades that ordering for ~200ms and
should not be done.

Two things this does **not** settle:

- **The hazard — tool dispatch is not gated with the audio.** `livekit/agents-js#1365` reports that
  preemptive generation does not check in-flight function tool execution. This is exactly the
  failure the bullet above anticipated: a speculative `verify_identity` that is later discarded
  still burns an attempt toward `MAX_VERIFICATION_ATTEMPTS`, and three burn the call. Same class of
  harm as the `gpt-oss-20b` fabrication under R-5 — a mechanism, not a model, ending a patient's
  intake. **Write this test before measuring any latency**; `PREEMPTIVE_GENERATION=false` is the
  escape hatch, and disabling preemption for the `verification` state only is the likely fix.
- **The prefix-extension check.** Keep the two checks separate as described above. The framework's
  discard-on-context-change handles *still apt*; the scan on the final transcript decides *safe*.

### Prompt caching — pays twice, and unblocks the benchmark

Groq caches identical prefixes for ~2h at half price, and **cached tokens do not count against the
rate limit** — the limit that forced `BENCH_TURN_DELAY_MS=22000` and the small sample sizes noted in
the benchmark document. `instructionsFor(state)` is byte-identical per state and sits first in the
context, so every turn after the first in a given state hits the cache.

**Constraint this imposes on the policy prompt:** never interpolate anything variable — names,
timestamps, record contents — into the instruction block. A per-call prefix caches nothing. Variable
context belongs in later messages, after the cached prefix.
