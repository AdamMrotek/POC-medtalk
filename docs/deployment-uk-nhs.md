# Deployment profile — UK NHS, at scale

**Status:** proposed — no provider selected, no measurement taken on target hardware
**Architecture:** `docs/voice-architecture.md` — assumed, not restated
**Related:** `docs/iso27001-gap-assessment.md` (ISMS gaps), `docs/deployment-portfolio.md` (contrast)
**Governing constraint:** R-6, taken to its limit — **no patient data leaves infrastructure we control**
**Legal review:** required before anything here is submitted to a trust. This is an engineering
document written to be *checkable* by IG, not an IG sign-off.

---

## 1. The distinction this profile turns on: API vs infrastructure

The other two profiles buy AI as a service. This one cannot, and the reason is not "the vendor might
train on the data" — every serious vendor now contractually says it won't. The reason is structural:

**OpenAI and Groq sell software endpoints.** You post audio or text; their servers process it and
return a response. You have no control over the underlying host, the operating system, the storage
layer, the retention behaviour, the support staff who can reach the machine, or the jurisdictions
the traffic and the operations team sit in. The commercial relationship is the *only* control you
hold, and a contract is a promise about behaviour, not a boundary around data.

**Sovereign UK cloud providers sell raw infrastructure** — virtual machines, Kubernetes clusters,
dedicated GPU hosts. They do not hand you an LLM. They hand you the legal and physical walls inside
which you build one. What that buys:

- **Territorial certainty.** Data centres, operating company, and support staff inside the UK, so
  patient data is not exposed to foreign jurisdiction — the **US CLOUD Act** being the specific
  concern that makes a US-owned provider hard to defend to a trust's IG team, *even when the region
  is physically in London.*
- **Pre-vetted connectivity and posture.** Providers on the government's **G-Cloud** framework
  typically already hold **Cyber Essentials Plus**, publish a **DSPT** (Data Security and Protection
  Toolkit) position, and can connect to the **HSCN** (Health and Social Care Network). Each of those
  is months of procurement you inherit rather than run.

**One correction to the usual framing, because IG will make it anyway.** It is commonly said that
sending patient data to a US API "violates UK GDPR data residency law". That overstates it: UK GDPR
has no blanket residency requirement, and transfers to the US can be lawful via the UK Extension to
the EU–US Data Privacy Framework or an IDTA plus a transfer risk assessment. **The real barriers are
NHS Information Governance policy, DSPT assertions, the trust's own risk appetite, and the CLOUD Act
exposure — not a statutory ban.** Stating it accurately matters: a document that overclaims the law
gets its engineering claims discounted too. The practical conclusion is unchanged — sovereign
hosting is by far the shortest path through an IG review — but it is a *procurement and risk*
argument, and should be argued as one.

### Candidate providers

Named as starting points from the G-Cloud framework, **not as a recommendation** — none has been
assessed, and market position and certification status must be verified at procurement time:

| Provider | Note |
|---|---|
| Crown Hosting Data Centres | Government joint venture; strongest sovereignty story, colocation-oriented |
| Civo | UK-based, Kubernetes-first, GPU offering |
| Claranet | UK managed services, healthcare presence |
| Pulsant | UK regional data centres |

**Verify before shortlisting:** GPU availability and model (this profile is GPU-bound and many UK
sovereign providers are thin here — treat it as the primary filter), HSCN connectivity, current DSPT
publication, Cyber Essentials Plus, ISO 27001 scope, ownership structure and ultimate parent
jurisdiction, and willingness to sign an Art. 28 DPA with the sub-processor list this profile needs
(ideally: none).

---

## 2. Shape — colocated tiers

Everything inside one sovereign UK perimeter, on one private network. Three compute tiers plus
storage. The compute tiers are separated because they have **different bottlenecks and different
scaling curves**, not for isolation:

```
┌───────────────── Sovereign UK cloud · UK data centre · HSCN-connected ─────────────────┐
│                                                                                        │
│   ┌────────────────────┐    ┌──────────────────────┐    ┌──────────────────────────┐   │
│   │ TIER 1 · Transport │    │ TIER 2 · Speech      │    │ TIER 3 · Reasoning       │   │
│   │                    │    │                      │    │                          │   │
│   │ LiveKit SFU        │    │ STT  (whisper)       │    │ vLLM                     │   │
│   │  (self-hosted,     │───>│ TTS  (Kokoro/other)  │<──>│  gpt-oss-120b            │   │
│   │   Apache-2.0)      │    │ GPU-bound            │    │  GPU-bound, VRAM-bound   │   │
│   │ + TURN             │    │                      │    │                          │   │
│   │ Network-bound      │    │ scales with          │    │ scales with              │   │
│   │ scales with calls  │    │ concurrent turns     │    │ tokens/sec + context     │   │
│   └────────────────────┘    └──────────────────────┘    └──────────────────────────┘   │
│            ▲                          ▲                                                │
│            │                          │  agent process (Node/TS) — safety gate, state  │
│            │                  ┌───────┴────────┐  machine, runTool, intakeStore        │
│            │                  │  Agent tier    │  colocated with Tier 1 (I/O-bound)    │
│            │                  └────────────────┘                                       │
│            │                                                                           │
│   ┌────────┴───────────────────────────────────────────────────────────────────────┐   │
│   │  TIER 4 · Storage — audio (WORM) · ledger (WORM) · record (DB) · see §7        │   │
│   └────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                        │
│   Egress: deny-by-default. No route from any tier to a public AI endpoint.             │
└────────────────────────────────────────────────────────────────────────────────────────┘
        ▲
        │ WebRTC / DTLS-SRTP
   ┌────┴──────┐
   │  patient  │  (or SIP trunk → LiveKit, if patients phone in)
   └───────────┘
```

**Tier 1 — LiveKit SFU, self-hosted, and this is non-negotiable here.** The SFU terminates
DTLS-SRTP, which means it decrypts and re-encrypts patient audio. **LiveKit Cloud would therefore be
a processor holding raw patient voice** — precisely the thing this profile exists to prevent. The
server is Apache-2.0 and self-hostable; that licence is what makes this profile possible at all.
Network-bound, not compute-bound: it scales with concurrent connections, needs public UDP ingress
and TURN for restrictive patient networks, and needs *none* of the GPU budget.

**Tier 2 — speech, and the tier with the least evidence behind it.** STT and TTS colocated so the
agent reaches them over the private network (or loopback, if merged with Tier 1 at low volume).
GPU-bound — with a caveat in §3 that must be settled before this tier is sized.

**Tier 3 — vLLM, replacing Groq.** Same OpenAI-compatible shape, so this is a base-URL change in
`VOICE_LLM`, not a provider implementation (`voice-architecture.md` §3). This is the payoff of the
portability seam: the most consequential swap in the system is a configuration change.

**Colocation is the point.** Every hop between tiers is private-network, sub-millisecond, and inside
one legal perimeter. The R-3 latency budget survives the split; the IG story is "one perimeter, one
data controller relationship, zero external processors on PHI".

---

## 3. The GPU question — reopened, and unmeasured

`voice-architecture.md` §3 records three closures, all measured on an M1 with Metal. **Every one of
them is hardware-specific, and this profile changes the hardware.** Nothing below is measured; it is
the list of things to measure first.

| Closure on M1/Metal | Status on datacentre NVIDIA | What to do |
|---|---|---|
| Local LLM not viable (`llama3.1:8b`: 6195–10302ms TTFT) | **Reopened.** Prefill on an A100/H100 with vLLM's paged attention and prefix caching is a different problem entirely | Measure TTFT against the real ~4KB policy prompt |
| `large-v3-turbo` disqualified (~1.7s recognition) | **Reopened.** This is where accuracy for unwell, accented, distressed speakers can finally be bought | Measure `base.en` vs `small.en` vs `large-v3-turbo` on the target GPU |
| Kokoro CPU-bound; CoreML slower | **Unknown, and the highest-risk item** | See below |

**The Kokoro finding does not generalise, and must not be assumed either way.** The measured cause
was specific: the ONNX graph's STFT has dynamic shapes, partitions badly under CoreML, and falls
back to CPU while still paying transfer overhead. CUDA's execution provider has different
partitioning behaviour and different dynamic-shape support, so the result may reverse — or may not.
`kokoro_server.py:296` constructs `Kokoro(model, voices)` with no execution provider and so takes
the hardcoded CPU default; **making the provider configurable and benchmarking CUDA is a
half-day of work and it gates the entire Tier 2 sizing.**

This matters more than it looks. TTS measured ~6× the CPU cost of STT (~1.2s vs ~0.2s per turn). If
TTS stays CPU-bound, Tier 2 is a CPU box with a small GPU attached, sized for TTS cores — and the
GPU speeds up only the cheap half of the work. If CUDA works, Tier 2 is GPU-bound throughout and
looks completely different. **These are two different purchase orders**, and the difference is one
benchmark.

**GPU-less deployment is not an option here, and this is measured.** Same model, same fixtures,
`-ng` to force CPU on the M1:

| Fixture | Metal | CPU only |
|---|---|---|
| 01-short-answer | 340ms | 1229ms |
| 02-date-of-birth | 327ms | 1181ms |
| 03-symptom-short | 371ms | 1400ms |
| 04-symptom-rambling | 418ms | 1677ms |

*(These include process start and model load, so read the ~4× ratio rather than the absolutes.)* A
CPU-only speech tier moves STT from ~0.2s to near a second and eats the R-3 budget before the LLM is
called. Whichever way the TTS question in the table above resolves, **Tier 2 needs a GPU for STT.**

**Two levers that reduce Tier 2 regardless of the answer:**

- **Pre-render every fixed line at build time.** Emergency scripts, verification prompts, standard
  intake questions — all scripted text in `backend/src/policy/blocks.ts` and the state machine.
  Anything said identically every call is synthesized once and never costs a cycle again. At NHS
  volume this is not an optimisation, it is a material reduction in the tier's size, and it also
  puts escalation at ~400ms with nothing in the loop.
- **Consider a different TTS entirely.** Kokoro-82M was chosen for CPU efficiency on a laptop, which
  is not the constraint here. GPU-native alternatives (Fish Audio, XTTS, Orpheus served through
  vLLM) may be better suited — Orpheus's 3.6× realtime shortfall was measured on Metal via Ollama
  and does not transfer. Any candidate must be evaluated for voice quality and licence, not just
  throughput.

**A prerequisite before any load test, carried over unchanged:** `backend/tools/kokoro_server.py` is
a `ThreadingHTTPServer` sharing one module-level `EspeakBackend` (line 300). espeak-ng is not
thread-safe, so concurrent synthesis can corrupt phonemes. Fix with a lock around phonemization
(~0.2ms, costs nothing) and set `intra_op_num_threads` so concurrent ONNX runs don't oversubscribe
every core. **At NHS concurrency this is a patient-safety defect, not a demo bug** — corrupted
phonemes in an emergency instruction.

---

## 4. The model choice is a safety decision, not a licensing one

R-5 pins `gpt-oss-120b` because it handles verification correctly where `gpt-oss-20b` fabricated
tool arguments and `llama3.2:1b` called `request_reschedule` on *"Yes, that's fine."* Three fabricated
`verify_identity` calls hit `MAX_VERIFICATION_ATTEMPTS` and lock a patient out of their own intake.

**`gpt-oss-120b` is open-weight and Apache-2.0 licensed, so the sovereign profile can serve the
model that already passed the fixtures rather than substituting an unvalidated one.** Verify the
licence terms at procurement — but if it holds, this is the single most important fact in this
document, because it means going sovereign costs infrastructure and **not** a re-run of the safety
evaluation. The usual sovereign-AI tradeoff — accept a weaker open model — does not apply.

Sizing note: 120B parameters needs meaningful VRAM (multi-GPU, or a single 80GB card with
quantisation). Quantisation is a **behavioural** change, not just a memory one: **any quantised
variant must re-run the verification fixtures before deployment.** Treat a quant level as a model
change under R-5.

If a smaller or different model is forced by hardware availability, the gate is the same and is not
negotiable: **it must pass the verification fixtures first.** Gemma and Llama are reasonable
candidates to *evaluate*; neither has been evaluated.

**Prompt caching carries over.** vLLM's automatic prefix caching behaves like Groq's: identical
prefixes hit the cache. `instructionsFor(state)` is byte-identical per state and sits first in
context, so the constraint from `voice-architecture.md` §4 holds unchanged — **never interpolate
names, timestamps, or record contents into the instruction block.** A per-call prefix caches
nothing. On self-hosted GPUs this is not a cost saving, it is throughput: cached prefill is capacity
that does not have to be bought.

---

## 5. Sizing

**No sizing table is offered here, and that is deliberate.** The M1 figures in
`voice-architecture.md` (13% duty cycle, ~4 concurrent calls per vCPU) are Metal figures for a
CPU-TTS/GPU-STT split that this profile does not have. Publishing a derived table would launder an
untested assumption into a procurement document. The method, instead:

1. Settle §3 — CUDA execution provider for Kokoro, or a GPU-native TTS. **Blocking.**
2. Benchmark one instance of each tier on target hardware, and derive per-tier concurrency
   independently. The tiers scale on different axes; a single "calls per box" number is what got the
   previous sizing into trouble.
3. Establish the scaling unit per tier, then size to the trust's actual call profile.

Structural facts that hold regardless of the numbers, carried from `voice-architecture.md` §3:

- **Autoscale on concurrent calls, not CPU.** At a low duty cycle, CPU-based scaling oscillates.
  Loading model weights takes minutes, so a large peak cannot be met reactively — use scheduled
  scaling, since NHS call volume tracks clinic hours almost perfectly.
- **Scale-in must drain, never terminate.** A WebRTC session pins a call to a box; killing it drops
  a patient mid-intake. 10–15 minute drain, stop accepting new calls first. This also rules out
  spot/preemptible capacity for the call-serving tiers — a 2-minute interruption notice is not
  enough to finish a conversation. **Tier 3 can tolerate it; Tiers 1 and 2 cannot.**
- **Never scale to zero.** First call after idle reloads model weights.
- Reserve GPU headroom for the peak, do not autoscale into it. Sovereign providers have far
  shallower GPU pools than hyperscalers; **capacity you have not reserved may simply not exist when
  the peak arrives.** Confirm reserved-capacity terms during procurement.

---

## 6. Information Governance — what a trust will ask

Engineering positions, for IG to check. Not a compliance sign-off.

| Question | Position |
|---|---|
| Where is patient data processed? | One named UK data centre. No processing outside the UK. |
| Which third parties see PHI? | **None.** No AI vendor is in the path; the cloud provider is an infrastructure processor under an Art. 28 DPA and sees only encrypted volumes and encrypted traffic. |
| Is voice recorded? | **Yes — full-conversation audio is retained (R-9, class 1).** This is a deliberate reversal of an earlier position in this document and is the single most consequential IG item here. Justification, retention period and consent flow in §7. |
| Lawful basis | Art. 6 plus **Art. 9(2)(h)** (health/social care) — trust's DPO to confirm; also common-law duty of confidentiality, which is separate from UK GDPR and separately satisfied. |
| DPIA | **Required.** Special-category data, automated processing, vulnerable data subjects — no argument for exemption. Must cover the red-flag escalation path specifically. |
| DSPT | Trust's own submission; this system is evidence within it. Provider's DSPT is separate and must be current. |
| Clinical safety | **DCB0129** (manufacturer) and **DCB0160** (deploying organisation) are mandatory for health IT in England. Requires a named Clinical Safety Officer and a Hazard Log. **Not yet started — see §8.** |
| Encryption | TLS 1.3 in transit externally, DTLS-SRTP for media, mTLS between tiers, encryption at rest with provider-managed or customer-managed keys. |
| Audit | Append-only, hash-chained ledger on WORM storage (R-9, class 2) — transcript, scan results **including passes**, tool calls, state transitions, summary. **Not yet implemented**: today `intakeStore.ts` is an in-memory `Map` recording state transitions only. See §7. |
| Access control | Clinician review surface authenticated and role-based; break-glass access logged. |
| Data subject rights | Access, rectification, erasure across classes 1–3. Erasure collides with the append-only ledger and with recorded audio — redact-with-tombstone, resolve deliberately, do not discover it during an audit. Class 3 being a *projection* of class 2 is what makes post-redaction rebuild possible at all. |
| Egress control | Deny-by-default at the network layer. `PHI_MODE=true` refuses to start on any uncovered provider — defence in depth, not the primary control. |
| Non-diagnostic boundary | Enforced architecturally by the fixed intake schema and escalation rules, not by prompt wording (`clinical-voice-assistant-requirements.md`). **Relevant to whether the MHRA treats this as a medical device — see §8.** |

`docs/iso27001-gap-assessment.md` is the companion here and its warning applies directly: ISO 27001
certifies an ISMS, not a codebase, and it **does not discharge UK GDPR or NHS IG obligations**. It is
evidence of good process, not a safe harbour. Roughly 70% of that work sits outside this repository.

---

## 7. Storage — the four classes under sovereignty

`voice-architecture.md` §4 defines the classes. This profile is where the boundary between them
becomes a legal boundary rather than an engineering preference.

| Class | Store | Encryption | Retention | Leaves the UK? |
|---|---|---|---|---|
| 1 · Audio | Object storage with **Object Lock / WORM**, in-region | at rest, **separate key** from classes 2–3 | shortest defensible — propose 30 days, DPO to set | **never** |
| 2 · Ledger | Append-only, hash-chained, WORM | at rest, customer-managed key | longest — NHS records management, potentially years | **never** |
| 3 · Record | Encrypted database, projection of class 2 | at rest, customer-managed key | per records management policy | **never** |
| 4 · Telemetry | Metrics/error backend | in transit | 30–90 days | **yes — and it is the only thing that may** |

**Class 1 is the item that will dominate the DPIA.** Recording full patient audio in an NHS setting
is defensible — safety-incident review, STT accuracy measurement, clinical dispute — but it is
defensible *on a stated justification with a stated retention period*, not by default. Three things
follow:

- **Consent must be explicit and recorded in the ledger**, at the top of the call, before
  verification. The consent line already required by `clinical-voice-assistant-requirements.md`
  becomes load-bearing rather than a disclaimer: the fact that recording was consented to, and when,
  is itself a class 2 entry.
- **Separate encryption key from classes 2–3.** Audio is the one asset where the ability to destroy
  it independently — key destruction as an erasure mechanism — is worth the key-management overhead.
- **Set the shortest retention that serves the justification.** If the purpose is incident review
  and accuracy measurement, that is weeks, not years. The ledger, not the audio, is the long-lived
  medico-legal record. Proposing 30 days and letting the DPO extend it is a far better posture than
  proposing indefinite and being negotiated down.

**Class 2 is what the trust actually needs medico-legally**, and it is cheap: text, hash-chained,
on WORM. The hash chain matters more here than in either other profile, because the question an NHS
audit asks is not "do you have logs" but "could you have altered them" — and *we* are inside the
threat model for that question. Anchor the chain digest periodically to something outside the
application's write path.

**Class 4 is the only thing that may cross the perimeter, and this profile is where that stops being
a convenience and becomes the entire observability strategy.** Nothing else may leave, so on-call
engineers debug production entirely through class 4 or not at all. Two consequences:

- **The PHI-free guarantee has to be structural, and it has to be testable**, because it is now
  load-bearing for a compliance claim and not just good hygiene. The typed logger, the
  serializer-boundary redaction and the PHI-canary test from `voice-architecture.md` §4 are
  requirements here, and the canary test belongs in CI.
- **Design class 4 to be sufficient for debugging before you need it.** An engineer who cannot
  diagnose an incident from metrics alone will ask for a transcript, and the answer has to be no.
  Per-hop latency, state transitions as counters, error taxonomy, tool-call outcomes — enough to
  localise a fault to a tier and a state without ever seeing a word the patient said.

**Volume is not a constraint.** Opus at ~32kbps is ~240KB per minute per track, so a 5-minute
two-track call is ~2.4MB; even at high trust volume this is terabytes per year, which is a rounding
error against the GPU line in §8. **Do not transcode to WAV** — 8× the bytes, and the reason to
resist is that PCM feels more "archival" and is not.

**Egress control applies to storage too.** Object storage with a public-internet endpoint is the
classic way sovereign perimeters leak. Private endpoints only, deny-by-default, and no bucket
reachable from outside the VPC.

---

## 8. Cost shape

The economics invert relative to the other profiles, and this is worth being explicit about with a
trust that expects per-call pricing.

- **Hosted (portfolio/US):** ~$0.003/call-minute, near-zero fixed cost, scales linearly with use.
- **Sovereign (here):** GPU rental is a **fixed monthly cost incurred whether or not anyone calls**,
  and per-call marginal cost is near zero.

There is therefore a break-even volume below which sovereignty is dramatically more expensive per
call, and above which it is cheaper. **A single trust's intake volume may well sit below it.** That
is not an argument against this profile — the compliance position is the product, not the unit
economics — but it must be stated honestly in any business case, and it argues for a shared
regional deployment across trusts rather than one per trust.

Cost drivers, in order: reserved GPU capacity (Tier 3 dominant, Tier 2 second) → engineering time to
operate it → Tier 1 and storage, which are rounding errors. **No figures are given because no
provider has been quoted and GPU pricing at UK sovereign providers is not comparable to hyperscaler
list prices.**

---

## 9. Open items — blocking, in order

1. **CUDA execution provider for Kokoro, benchmarked** — or a GPU-native TTS selected. Gates all
   Tier 2 sizing. (§3)
2. **The espeak-ng thread-safety fix.** Patient-safety defect at concurrency, trivial to fix. (§3)
3. **Confirm `gpt-oss-120b` licence and VRAM footprint** on candidate hardware; re-run verification
   fixtures against the exact quantisation to be deployed. (§4)
4. **Provider shortlist filtered on GPU availability first**, then HSCN, DSPT, CE+, ownership
   jurisdiction. (§1)
5. **Real patient-like audio recordings.** `voice-architecture.md` §3 — synthetic fixtures cannot
   judge accuracy, and this profile is the one that can afford a larger STT model if they show
   `base.en` failing. Consent and IG approval needed to collect them, so start early.
6. **DCB0129/0160 clinical safety case** and a named Clinical Safety Officer. Mandatory in England,
   not started, and long lead time.
7. **MHRA position.** Whether this is a medical device turns on the non-diagnostic boundary holding
   in practice. Needs a written determination before deployment, not an assumption.
8. **DPIA**, with the trust's DPO. (§6)
9. Retention policy for transcripts and audit log, aligned to NHS records management.
10. **Implement the four classes at all** — `intakeStore.ts` is an in-memory `Map` today, so
    audio, ledger, durable record and PHI-free telemetry are all unbuilt. (§7)
11. **Audio retention period and consent wording**, with the DPO. Gates the DPIA. (§7)
12. Penetration test and an independent review of the red-flag scanner against clinical guidance.

Items 6 and 7 have the longest lead times and the least engineering content. **Start them before the
infrastructure work, not after it.**
