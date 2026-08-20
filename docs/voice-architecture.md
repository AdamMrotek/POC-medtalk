# Voice architecture

**Status:** proposed — transport decision pending, pipeline decision made per deployment profile
**Evidence:** `docs/voice-pipeline-benchmark-plan.md` (measurements, 2026-08-12 → 2026-08-17)
**Prototype:** `backend/src/agent/index.ts` (LiveKit agent, written 2026-08-17, not yet run)
**Scope:** what the assistant must do, and the two architectural choices that follow from it.

This document is requirements and architecture only. **It deliberately contains no deployment
detail** — the same architecture is deployed three very different ways, and each has its own
document:

| Profile | Document | Shape |
|---|---|---|
| Portfolio / demo | `docs/deployment-portfolio.md` | one small box, single vendor, no GPUs |
| UK NHS at scale | `docs/deployment-uk-nhs.md` | sovereign UK cloud, everything self-hosted |
| US HIPAA at scale | `docs/deployment-us-hipaa.md` | hyperscaler under BAA, hybrid hosted/self-hosted |

Every number below is a citation of the benchmark document, not a new claim.

**One correction that applies to every local figure quoted here:** all local-STT and local-TTS
measurements were taken on an M1 with **Metal (GPU) active**, not on CPU. Homebrew's
`whisper-server` enables Metal by default and prints `ggml_metal_device_init: GPU name: MTL0 (Apple
M1)` at startup; Ollama likewise uses Metal by default. The benchmark document describes local STT
as running "on the CPU" — it is wrong, and the gap is roughly 4× (see `deployment-uk-nhs.md` §3).
Read every local number below as a GPU number.

---

## 1. Requirements

Eight requirements, ordered by how hard they are to retrofit. R-1 and R-2 are architectural — a
design either has them or it doesn't. The rest are tunable.

### R-1 · Data ownership

The conversation must be **at rest between turns**, with the message array held by us.

Durability, pause/resume and server-side audio capture then become properties of the shape rather
than features to build — which is what R-9 goes on to depend on. Speech-to-speech makes the conversation a live stream owned by the vendor:
snapshotting a moving thing you cannot reattach to.

**Test:** can a call be resumed after a process restart?

### R-2 · Safety gate

The red-flag scan must be **control flow, not a race**: STT text → `scanForRedFlags` → LLM, with the
LLM never called on a flagged utterance.

- `scanForRedFlags()` in `backend/src/safety/scan.ts` is synchronous and pattern-based, so the gate
  itself costs no measurable time.
- Measured on the Realtime path: the model started speaking **p50 49ms before the transcript
  existed**, and **11 of 20 turns** had it already speaking before the scan had anything to read.
  The `response.cancel` claw-back is load-bearing, not defence in depth.

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

*"It started… [thinks] …maybe Tuesday, and my neck's been stiff"* is clipped after "started" at a
300ms hangover — and the clipped clause is a red flag. Hence 700ms in `intake`, and **soft commit**:
if speech resumes within 1.5s and the assistant has not spoken, merge into the same turn and re-scan
the concatenation.

Generic voice-agent guidance recommends aggressive 400ms endpointing. It does not apply here.

**Corollary:** the hangover and the speed knob are two different settings. In the LiveKit agent,
`endpointing.minDelay` stays at 700ms and latency is won from `preemptiveGeneration` instead (§5).

### R-5 · Tool-call correctness

The LLM must not fabricate tool arguments. This outranks latency.

- `gpt-oss-20b` called `verify_identity` with invented arguments
  (`{"dateOfBirth":"YYYY-MM-DD","phoneLast3":"123"}`). Three failed attempts hit
  `MAX_VERIFICATION_ATTEMPTS` and lock the call — a model tic can end a patient's intake.
- `llama3.2:1b` called `request_reschedule` in response to *"Yes, that's fine."*
- `gpt-oss-120b` and `qwen3.6-27b` both handle the same prompt correctly.

**Smaller is not better here.** Any model change requires re-running the verification fixtures.

### R-6 · PHI and processor minimisation

Every hop that sees patient data is a processor to cover by a contract and a supplier assessment.

- Sensitivity is not uniform: **audio is more sensitive than transcript** — voice is biometric, and
  it carries distress and background context the transcript drops.
- Ranked best to worst: nothing leaves → transcript only leaves → audio leaves.
- `PHI_MODE=true` refuses to start if any selected provider is not covered.

**This requirement is what makes three deployment documents necessary.** It is satisfied trivially
in the portfolio profile (no PHI exists), by self-hosting everything in the UK profile, and by
contract in the US profile.

### R-7 · Barge-in

The patient must be able to interrupt, except during escalation.

- `BARGE_IN_POLICY` in `shared/src/machine.ts`: every state `"allow"`, `alert` is `"duck_only"` —
  the emergency instruction always finishes.
- Duck before stop: onset ducks to 20%; full stop needs ~300ms sustained speech. A cough should cost
  300ms of quiet, not a destroyed turn.
- **False barge-in rate in a quiet room must be 0.** Any non-zero value means echo cancellation is
  failing and barge-in is unshippable.

### R-8 · Provider portability

No provider may be hardcoded. `VOICE_STT` / `VOICE_LLM` / `VOICE_TTS` select each hop
independently, because the right answer differs per hop, per jurisdiction, and changes as vendors
ship. This is the seam that lets one codebase serve all three deployment profiles (§3).

### R-9 · Recorded evidence, in four separable classes

A call must leave four records, stored separately because they differ in sensitivity, mutability,
retention and — critically — in whether they may cross the trust boundary:

1. **Audio** — the full conversation as received.
2. **An immutable ledger** of the conversation and the clinical summary.
3. **The structured record** extracted from it.
4. **Telemetry** — metrics and errors, carrying no medical data at all.

This is a requirement and not an implementation detail because class 1 is **impossible on a
speech-to-speech transport** and class 4 is impossible to retrofit onto a logger that has been
carrying PHI. See §4.

**Test one:** can you answer *"why did the assistant not escalate at 4m12s?"* — needs 1 and 2, and
needs them to agree.
**Test two:** can an on-call engineer diagnose a production latency regression **without any access
to PHI**? — needs 4 to be genuinely separate, not merely filtered on the way out.

---

## 2. Decision one — transport

Two ways to get audio between the patient's browser and our code. This choice is independent of
which models run where.

### A · Realtime, speech-to-speech

Browser opens WebRTC directly to the vendor (OpenAI Realtime). Current shipped design.

- **Measured:** 1299ms p50 / 2307ms p95. Fastest available.
- Echo cancellation, barge-in and jitter buffering come free with WebRTC.
- **Fails R-1** — the conversation is the vendor's live stream, not our message array.
- **Fails R-2 as configured** — the scan races generation on 11/20 turns. It *can* be gated by
  withholding `response.create` until the scan runs, but that costs the transcript wait (p50
  1073–1784ms), landing it near cascaded numbers anyway.
- **Fails R-6** — all patient audio leaves, to one specific vendor with no alternative.
- **Fails R-9, and this one has no workaround.** The audio is the vendor's stream, so class 1
  recording is not possible at any price. R-1 and R-2 could in principle be argued around; this
  cannot.
- ~**$0.10+/call-minute**, and it never amortises.

### B · LiveKit SFU + cascaded agent ← recommended

Patient connects over **WebRTC** to an SFU; the agent is a long-lived process receiving decoded
frames and running STT → gate → LLM → TTS itself.

```
browser ──WebRTC──> LiveKit SFU ──> agent (Node, TypeScript)
                                      ├ STT / LLM / TTS  → per-hop provider (§3)
                                      ├ VAD              → Silero
                                      ├ turn detection   → LiveKit turn-detector model
                                      ├ gate             → runSafetyCheck → StopResponse
                                      └ tools            → runTool (unchanged)
```

- AEC, jitter buffering and barge-in come free *and* the pipeline stays cascaded — this dissolves
  the tradeoff the benchmark document treats as inherent.
- **R-2 becomes actual control flow.** `onUserTurnCompleted` → `runSafetyCheck` →
  `throw new StopResponse()`. The hook runs after the user turn is committed and before any reply is
  released, so on a flagged utterance the LLM invocation count is zero — passed by construction, not
  by claw-back.
- **The TypeScript cost is not real.** The Node SDK is at **1.6.4** with plugins in lockstep, so the
  agent is TypeScript and `runSafetyCheck` / `runTool` are called **in-process**. No second
  language, no HTTP hop on the safety path, no risk of a second `redFlags.ts`.
- Replaces most of hand-rolled Stage 2: session/generation management, turn generation counter,
  cancel ordering, sentence chunking, capture/playback worklets, ring buffer, in-browser VAD, and
  text-similarity echo suppression.
- Its contextual **turn-detector model** attacks R-4 more directly than a fixed hangover can, by
  predicting semantic completion rather than acoustic silence.
- Two benefits that only appear at scale: WebRTC carries Opus, removing the ~$15/hr egress raw PCM
  would cost at 1000 concurrent calls; and SIP/telephony is built in, if patients ever phone in.
- Everything else stays ours: `createSession()` / `getRecord()` in `intakeStore.ts` untouched, every
  tool through `runTool()`, so `isToolAllowed()`, the state transitions and
  `MAX_VERIFICATION_ATTEMPTS` keep adjudicating. **The model proposes; `runTool` decides.**

**One deployment consequence, carried into all three profiles:** the SFU terminates DTLS-SRTP, so
**LiveKit Cloud is a processor that sees patient audio.** Self-hosting the SFU (Apache-2.0) keeps
the "transcript only" position; hosting it does not. This is decided per profile, not here.

### Verdict

**LiveKit.** Realtime is faster and simpler and fails the three requirements that cannot be
retrofitted — R-1, R-2 and now R-9. The addition of R-9 changes the character of this decision:
before it, Realtime was a defensible choice for anyone willing to accept a claw-back gate, and the
argument was about risk appetite. It is now an architectural impossibility, because you cannot
record audio you never receive.

Retain Realtime as an A/B latency baseline and as the fallback demo path — where, usefully, its
inability to record becomes the clearest demonstration of why the shipped path is shaped as it is.

---

## 3. Decision two — pipeline, per hop

Cascaded means three independent choices. The seam:

```
VOICE_STT / VOICE_LLM / VOICE_TTS  =  openai | groq | local
VOICE_PROFILE                      =  sets all three at once
PHI_MODE=true                      =  refuses to start on any uncovered provider
```

Everything speaks the **OpenAI-compatible shape** — including `kokoro_server.py`, which serves
`/v1/audio/speech`. Consequences worth keeping: a new vendor is usually a base URL, not a provider
implementation; the local servers drop into LiveKit's OpenAI plugin unchanged; `npm run bench`
sweeps any combination without code edits; and **vLLM is a drop-in for Groq** because it serves the
same shape, which is the whole basis of the sovereign profile.

### Measured configurations

| | Realtime | Single-vendor cascade | Hybrid cascade |
|---|---|---|---|
| | OpenAI speech-to-speech | all three hops at Groq | local STT · Groq LLM · local TTS |
| Latency p50 | **1299ms** | 1943ms | 1636ms |
| Latency p95 | 2307ms | 2479ms | **2165ms** |
| R-1 data ownership | ✗ | ✓ | ✓ |
| R-2 safety gate | ✗ (race) | ✓ | ✓ |
| Audio leaves | yes | yes | **no** |
| Processors on PHI | 1 (audio) | 1 (audio) | **1 (transcript only)** |
| Cost / call-minute | ~$0.10+ | ~$0.003 | ~$0.003 |
| Infrastructure to run | none | none | STT + TTS servers |

Single-vendor Groq is `whisper-large-v3-turbo` · `gpt-oss-120b` · `orpheus-v1-english`; its Groq TTS
number is the most *stable* in the benchmark, p50 and p95 differing by 1–5ms. Hybrid is
whisper.cpp `base.en` and Kokoro-82M locally. Swapping Kokoro for Groq Orpheus (variant C′) is
1699ms p50, ~200ms faster, at the cost of audio synthesis leaving.

**All three land within a few hundred milliseconds of each other, so latency is not the deciding
argument.** R-1, R-2 and R-6 are — and R-6 is decided per jurisdiction, which is why the pipeline
choice is delegated to the deployment documents rather than settled here.

### Current default selections

| Hop | Choice | Why | Locked? |
|---|---|---|---|
| STT | local whisper `base.en` | 149–232ms full recognition, no vendor, satisfies R-6 | soft |
| LLM | Groq `gpt-oss-120b` | best p95 **and** correct verification behaviour (R-5) | **hard — R-5** |
| TTS | local Kokoro-82M | 372–453ms in-pipeline, flat across utterance length | soft |

The LLM choice is pinned by safety, not speed. Every candidate must pass the verification fixtures
before it is considered — `gpt-oss-20b` is faster on paper and disqualified. **When the sovereign
profile replaces Groq with self-hosted vLLM, the replacement model must clear the same fixtures.**

### STT model size — `base.en` holds, measured

Recognition time on the M1 with Metal active, model load excluded, best of 3:

| Fixture | `base.en` | `small.en` | `large-v3-turbo` |
|---|---|---|---|
| 01-short-answer | 172ms | 538ms | 1776ms |
| 02-date-of-birth | 184ms | 460ms | 1696ms |
| 03-symptom-short | 230ms | 523ms | 1704ms |
| 04-symptom-rambling | 292ms | 634ms | 1865ms |

`large-v3-turbo` is disqualified **on this hardware** — ~1.7s exceeds the whole R-3 budget before
the LLM is called. On datacentre GPUs this reverses, which is why the scale profiles revisit it.

**Cost is nearly fixed per model, not per utterance:** whisper pads every input to a 30s window, so
encode time barely moves with length (`large-v3-turbo`: 1507–1650ms across a 1.7s and a 7.2s clip).
Short verification turns get no discount for being short.

**These fixtures cannot judge accuracy and must not be read as doing so.** All three models
transcribed all four correctly — synthetic speech has no accent, no room tone, no false starts, so
this is the case `base.en` was always going to win. Real recordings remain the highest-value missing
measurement.

### Closed on current hardware, reopened at scale

- **Local LLM.** The ~4KB policy prompt makes time-to-first-token a prefill problem: `llama3.2:1b`
  measured 1520–3601ms, `llama3.1:8b` 6195–10302ms on an M1. **This closure is hardware-specific and
  is explicitly reopened by the UK profile,** where vLLM on datacentre GPUs is the only legal option.
- **Local Orpheus via Ollama.** 24.1 tok/s against an 87.5 tok/s realtime break-even — a 3.6×
  structural shortfall, and already a Metal number, so there is no acceleration left to enable.
- **CoreML for Kokoro.** Marginally slower than CPU; the graph's STFT has dynamic shapes and
  partitions badly. Generalises to *this* accelerator, not to CUDA — see the UK profile.

### Not yet evaluated

- **Cartesia Sonic / ElevenLabs Flash** — claimed sub-100ms TTFB against Kokoro's 372–453ms.
  `npm run bench:tts` already exists. Note the tension: hosted TTS is priced per character, which is
  where cost concentrates at 1000 concurrent, and it moves synthesis off our infrastructure.
- **Deepgram / AssemblyAI streaming STT** — only reason to consider is partial transcripts, which
  local whisper does not emit.
- **LiveKit's turn detector**, against the 700ms hangover on `04-symptom-rambling`.

---

## 4. Decision three — the four data classes

R-9 asks for four records. The reason they are four stores and not four columns is that they differ
on every axis that matters operationally:

| | Class 1 · Audio | Class 2 · Ledger | Class 3 · Record | Class 4 · Telemetry |
|---|---|---|---|---|
| What | Opus tracks, per speaker | transcript, tool calls, transitions, scan results, summary | current structured intake | latency, counts, errors |
| Mutability | write-once | **append-only, tamper-evident** | mutable | append-only |
| Sensitivity | **highest** — biometric | high — PHI | high — PHI | **none, by construction** |
| Volume | largest | moderate | tiny | high frequency, tiny items |
| May cross the perimeter | **never** | never | never | **yes — this is the point** |
| Retention | shortest | longest — medico-legal | records policy | short |

Note that **volume runs inverse to retention and sensitivity runs inverse to reach.** The biggest
asset is the one kept shortest; the only one that may leave is the one with nothing in it. A single
database serving all four gets every one of these tradeoffs wrong at once.

### Class 1 · Audio

**This class is what finally disqualifies the Realtime transport.** Under R-1 and R-2, Realtime was
recommended against; under R-9 it is *impossible* — the audio is the vendor's live stream and there
are no server-side frames to write. The LiveKit agent already receives decoded frames, so recording
is a property of the transport already chosen rather than a component to add.

- **Record the two tracks separately, never pre-mixed.** The patient track alone is what you re-run
  STT against; a mixed track has the assistant's voice bleeding into it and is worthless for
  accuracy work. Separate tracks also make R-7's *"false barge-in rate in a quiet room must be 0"*
  an auditable claim rather than an assertion — you can see whether AEC failed.
- **Store Opus as received; do not transcode.** WebRTC already carries Opus at ~32kbps ≈ 240KB per
  minute per track — a 5-minute two-track call is ~2.4MB. Transcoding to 16kHz PCM is ~8× the bytes
  for no benefit, since STT resamples anyway.
- **Write from the agent, not LiveKit Egress.** Egress is built for composite video recording and
  drags in headless Chrome/GStreamer — a whole service to operate for something the agent can do
  with the frames already in hand.
- **Why keep it, which is exactly the DPIA justification:** safety-incident review (if the scanner
  missed a red flag, audio is the only ground truth), STT accuracy measurement, clinical dispute,
  and QA. Note that this **retires open decision 5** — "record real patient-like audio to replace
  the synthetic fixtures" stops being a project to run and becomes a query against production.
- It is also the highest-risk asset in the system, and the reason consent is a hard gate rather than
  a formality.

### Class 2 · The immutable ledger

**What exists today is much thinner than the ADR implies, and the gap is worth stating precisely.**
`record.history` holds `{at, from, event, to}` — state transitions only. Three consequences:

- **Tool calls that cause no transition leave no trace.** `update_intake` is invisible.
- **`updateRecord()` overwrites fields silently.** A severity going 3 → 8 mid-call is unrecoverable.
- **`sessions` is a `Map`** in `intakeStore.ts`, so nothing survives a restart — R-1's own test
  ("can a call be resumed after a process restart?") currently fails on persistence, not on shape.

The ledger must carry: every user turn's **final transcript and its scan result — including the
passes**. "The scanner ran at 4m12s and matched nothing" is the entry that answers test one; only
logging flags means the interesting case is the one with no record. Then every LLM turn, every tool
call with arguments and the `isToolAllowed()` verdict, every state transition, and the summary with
the inputs it was generated from.

**Immutable means tamper-evident, not merely "we don't call update".** Two mechanisms, because they
fail differently: hash-chain each entry over the previous digest (detects tampering, including by
us), and WORM at the storage layer — S3 Object Lock or equivalent (prevents it, including by an
attacker with database credentials).

**The summary belongs here, not on the record.** It is the clinical deliverable handed to a human
and must be reproducible exactly as issued. Today `summary?: string` sits on the mutable record —
wrong class, and a silent rewrite of a summary a clinician has already acted on is the failure this
prevents.

**Append-only collides with erasure — resolve it deliberately, not during an audit.** Redact the
content, keep the entry and the chain intact, and record the erasure as its own ledger entry.

### Class 3 · The structured record

**Make it a projection of class 2, rebuildable by replaying the ledger.** Today the record is the
source of truth and history is a side effect; inverting that is the refactor, and it is what makes
the rest tractable — a derived record can be rebuilt after redaction, and any disagreement between
record and ledger becomes a detectable bug rather than an unanswerable question.

This does not disturb the ADR-0001 arrangement. `applyEvent()` stays the only writer and
`isToolAllowed()` stays the authorization check; they gain a durable append target. The type-level
guard (`Partial<Omit<IntakeRecord, "state" | "history">>`) should extend to the fields as well, so
`updateRecord` cannot bypass the ledger any more than it can bypass the machine.

### Class 4 · Telemetry, PHI-free by construction

Per-hop latency (the R-3 table measured in production, not just on fixtures), tool-call failure
rate, escalation trigger rate, false barge-in rate, STT confidence distribution, error traces,
model and version identifiers.

**Escalation rate is a safety metric, not an engineering one.** A drop in it is either a healthier
patient population or a broken scanner — and you cannot tell which from class 4 alone. That is a
reason classes 1 and 2 exist, and a reason the three are designed together.

**The hard rule: no free text from the conversation ever enters this class.** Not transcript, not
record fields, not tool arguments, not the summary, not exception payloads. Session ID is the only
join key, and it must not be derivable from patient identity — `createSession()`'s `randomUUID()`
already satisfies that.

**The leak vector is errors, not metrics.** Nobody deliberately logs a transcript; they log `err`
and the stack frame carries the request body. **Discipline is not a control here** — one
`console.error(e)` is enough. Make it structural: a logger whose signature accepts only a closed set
of primitive fields, redaction at the serializer boundary, and a test asserting a known PHI canary
never appears in the telemetry stream.

**This is the only class that may leave the perimeter, and that is its purpose** — it is what allows
a hosted APM without a BAA, and what makes on-call debugging possible at all in the UK profile,
where nothing else may leave. Retention is short; none of it is medico-legal.

### The consequence for deployment

Classes 1–3 stay inside the perimeter in every profile; class 4 is the only thing that crosses it.
That single line is the storage boundary each deployment document then implements, and it is why
the four-class split is an architectural decision rather than a schema.

---

## 5. What is true regardless of choice

- **The tool-call round trip is the single largest term in the budget** — 2153ms against 1327ms for
  direct-speech turns, an ~825ms penalty larger than any individual hop. Moving `update_intake` off
  the critical path and handling verification deterministically helps every configuration equally.
- **Pre-rendered emergency audio.** The 11 red-flag scripts and closing lines in
  `backend/src/policy/blocks.ts` are static text. Synthesizing them at build time puts escalation at
  ~400ms with no LLM and no TTS vendor in the loop — best latency result available, on the most
  safety-critical path. The same argument extends to every fixed line in the state machine:
  verification prompts and standard intake questions are scripted, and **anything said identically
  every call can be synthesized once and never cost a CPU cycle again.**
- **`preemptiveGeneration` is the speed knob, not `endpointing.minDelay`.** It fires the LLM as soon
  as a transcript arrives, so inference overlaps the endpointing wait and the 700ms hangover becomes
  an overlap window rather than dead time. The clinical hangover is untouched. Estimated saving
  ~550ms.
- **The commit barrier is LiveKit's default configuration.** `preemptiveGeneration.enabled` defaults
  true and `preemptiveTts` defaults false: the LLM speculates, but **no audio is synthesised until
  the turn is confirmed**, which happens after `onUserTurnCompleted` — i.e. after the scan.
  Turning `preemptiveTts` on trades that ordering for ~200ms and should not be done.
- **The hazard — tool dispatch is not gated with the audio.** `livekit/agents-js#1365`: preemptive
  generation does not check in-flight function tool execution. A speculative `verify_identity` that
  is later discarded still burns an attempt toward `MAX_VERIFICATION_ATTEMPTS`, and three burn the
  call. Same class of harm as the R-5 fabrication — a mechanism, not a model, ending an intake.
  **Write this test before measuring any latency;** `PREEMPTIVE_GENERATION=false` is the escape
  hatch, and disabling preemption in the `verification` state only is the likely fix.
- **Keep the two speculation checks separate.** The scan on the final transcript decides *safe*;
  prefix-extension decides *still apt*. Merging them into one boolean is how this gets silently
  broken — *"my head hurts"* → *"my head hurts and I can't see out of my left eye"* is a valid
  prefix-extension whose meaning is a red flag.
- **Prompt caching pays twice.** Groq caches identical prefixes for ~2h at half price, and cached
  tokens do not count against the rate limit — the limit that forced `BENCH_TURN_DELAY_MS=22000`.
  `instructionsFor(state)` is byte-identical per state and sits first in context. **Constraint this
  imposes:** never interpolate names, timestamps or record contents into the instruction block. A
  per-call prefix caches nothing. Variable context belongs in later messages. vLLM's prefix cache
  behaves the same way, so this constraint carries into the sovereign profile.

---

## 6. Open decisions

| # | Decision | Owner | Blocking |
|---|---|---|---|
| 1 | LiveKit vs Realtime as the shipped transport | engineering | Stage 2 start — leaning LiveKit, prototype written |
| 2 | Typecheck and run the LiveKit prototype | engineering | every latency number below |
| 3 | Write the agents-js#1365 tool-dispatch test | engineering | any latency measurement |
| 4 | Restate the sub-second target in `clinical-voice-assistant-requirements.md` as the R-3 table | project | — |
| 5 | ~~Record real patient-like audio~~ — retired by class 1 recording; becomes a production query | project | any accuracy claim |
| 6 | Which deployment profile is being built next | project | all sizing work |
| 7 | Persist the four classes — `intakeStore` is an in-memory `Map` today, so none of them exist | engineering | R-1's own test, and R-9 entirely |
| 8 | Ledger erasure semantics (redact-with-tombstone) and audio retention period | project + legal | DPIA in either scale profile |

**Decision 2, concretely** — the prototype has been read against the real type definitions but never
typechecked or run; the packages are not in `backend/`:

```
npm i -w threep-backend @livekit/agents @livekit/agents-plugin-openai \
  @livekit/agents-plugin-silero @livekit/agents-plugin-livekit zod
```

Deployment-specific decisions (hardware, jurisdiction, contracts, sizing) live in the three
deployment documents and are not repeated here.
