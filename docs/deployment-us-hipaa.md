# Deployment profile — US HIPAA, at scale

**Status:** ⚠️ **sketch — deliberately unresearched.** Written to record the shape and the questions,
not to be executed. Do not cost, plan or commit against it. The UK profile
(`docs/deployment-uk-nhs.md`) is the researched one; this is its counterpart placeholder.
**Architecture:** `docs/voice-architecture.md` — assumed, not restated
**Governing constraint:** R-6 satisfied **by contract plus selective self-hosting**, rather than by
full sovereignty
**Legal review:** required. Nothing here has been checked by counsel.

---

## 1. Why this is a different problem from the UK

The UK profile self-hosts everything because NHS Information Governance makes third-party AI
processors hard to defend regardless of contract. **HIPAA is not shaped that way.** It is a
contractual regime: a Business Associate Agreement plus the Security Rule safeguards makes a vendor
a legitimate part of the pipeline, not an exception to be argued for.

Two consequences follow, and together they define the profile:

1. **A BAA is standard and free at AWS and GCP**, unlike the bespoke arrangements the UK profile has
   to construct. HIPAA-eligible service lists are published, and managed AI services
   (**Bedrock**, **Vertex AI**) appear on them under BAA — *verify current status, this changes.*
2. **There is no CLOUD Act problem**, because the data is already in the US and the concern is US
   jurisdiction. The whole argument that forces sovereignty in the UK is simply absent.

**So the US profile does not need to self-host the LLM, and probably should not.** The UK profile
runs vLLM because it has no lawful alternative; running it in the US would mean buying and operating
GPUs to avoid a contract that is available for free. That is cost and operational burden with no
compliance return.

---

## 2. Shape — hybrid, split on R-6's sensitivity ranking

R-6 ranks exposure: *nothing leaves* → *transcript only leaves* → *audio leaves*. The US profile
buys the position in the middle, and buys it deliberately rather than by default:

```
┌───────────── AWS or GCP · US region · account under BAA ─────────────┐
│                                                                      │
│   SELF-HOSTED — everything that touches raw audio                    │
│   ┌────────────────────┐   ┌──────────────────────┐                  │
│   │ LiveKit SFU        │──>│ STT · TTS            │                  │
│   │ (Apache-2.0, ours) │   │ (whisper · Kokoro)   │                  │
│   └────────────────────┘   └──────────────────────┘                  │
│            │                          │                              │
│            └──── agent (Node/TS) — safety gate, state machine ───────┼──┐
│                                                                      │  │
│   Storage — audio · ledger · record, all in-account (§4)             │  │
└──────────────────────────────────────────────────────────────────────┘  │
                                                                          │ transcript only
                                        ┌─────────────────────────────────▼──────────┐
                                        │  BAA-covered managed LLM                   │
                                        │  Bedrock / Vertex AI — in-account, in-region│
                                        └────────────────────────────────────────────┘
```

**Self-host the audio tiers.** Voice is biometric and carries distress and background context the
transcript drops. Self-hosting them costs GPU/CPU but not a compliance argument, and it keeps the
most sensitive representation entirely in-account. The LiveKit SFU stays self-hosted for the same
reason as in the UK profile — **it terminates DTLS-SRTP, so a hosted SFU is a processor holding raw
patient voice.**

**Buy the transcript hop under BAA.** The largest, most expensive, most operationally demanding
component becomes someone else's problem, and the thing crossing the boundary is the least sensitive
representation — inside the same cloud account, same region, under the same BAA.

**Groq is not usable in this profile as things stand** (`voice-architecture.md`: no BAA today).
That is the single change from the default configuration: `VOICE_LLM` points at a BAA-covered
endpoint. Because everything speaks the OpenAI-compatible shape, this is a base URL and a model
name — **the portability seam doing exactly the job it was built for.**

**The R-5 gate does not relax.** Whatever model Bedrock or Vertex serves must pass the verification
fixtures before it ships. `gpt-oss-120b` being open-weight (per the UK profile) means self-hosting
it on the same infrastructure is a live fallback if no BAA-covered managed model passes.

---

## 3. What carries over unchanged

From `docs/deployment-uk-nhs.md`, and not repeated in detail:

- **The GPU question is still open and still blocking** — Kokoro's CPU-bound finding is a CoreML
  result and may or may not hold under CUDA. Same benchmark, same half-day, same gating effect on
  sizing. (UK §3)
- **The espeak-ng thread-safety fix** in `kokoro_server.py` — patient-safety defect at concurrency.
- **Pre-render every fixed line at build time.** Same reduction in the speech tier, same ~400ms
  escalation path.
- **Drain on scale-in, never terminate. Never scale to zero. Autoscale on concurrent calls, not
  CPU.** All structural, all independent of jurisdiction.
- **Prompt-caching discipline** — no names, timestamps or record contents in the instruction block.
- **The four data classes** (`voice-architecture.md` §4) — same split, same WORM ledger, same
  PHI-free telemetry boundary. See §4 for the one place this profile differs.

**One thing that gets easier:** GPU capacity is deep at hyperscalers, so the UK profile's warning
about reserved capacity possibly not existing at peak does not apply with the same force. Reserved
instances or capacity blocks remain the sensible purchase, for cost rather than for availability.

---

## 4. Storage — where the four classes fall

`voice-architecture.md` §4 defines them; `deployment-uk-nhs.md` §7 works through the strict version.
The US profile differs in exactly one place, and it is the place where HIPAA's contractual character
shows up again:

| Class | Position | Differs from UK? |
|---|---|---|
| 1 · Audio | Object storage with Object Lock, in-account, in-region, separate key | no |
| 2 · Ledger | Append-only, hash-chained, WORM | no |
| 3 · Record | Encrypted DB, projection of class 2 | no |
| 4 · Telemetry | PHI-free, may leave the account | **yes — a hosted APM is straightforwardly available** |

**Classes 1–3 stay in-account regardless**, and note this is *not* required by HIPAA the way the UK
position is required by IG — a BAA-covered object store would be lawful. Keep them in-account
anyway: it costs nothing, it is what a hospital security review expects, and it means the answer to
"who else holds patient voice recordings" is nobody rather than a list.

**The class 4 boundary is worth more here than in the UK profile, not less.** Because the LLM hop is
already outside the self-hosted set, the discipline that keeps PHI out of telemetry is the same
discipline that keeps it out of anything crossing a boundary — and this profile has two boundaries
instead of one. A logger that has been carelessly carrying transcript fragments is a breach
notification under the 60-day rule, not a tidiness problem.

**Two US-specific items on class 1.** Voice recordings are **biometric data under some state
regimes** (§5 item 5), which can constrain retention independently of HIPAA — so the retention
period may be driven by state law rather than by clinical need. And state one-party/two-party
consent-to-record law varies, which affects the consent wording at the top of the call, not just
the privacy notice.

---

## 5. Questions to answer when this profile is actually researched

Ordered by how much they would change the shape above:

1. **Which managed LLM endpoints are BAA-covered, in which regions, serving which models — and do
   any of them pass the R-5 verification fixtures?** Everything else follows from this. If none
   passes, the profile collapses back toward the UK shape and self-hosts vLLM.
2. **Does OpenAI's API BAA (zero data retention) change the calculus?** If a BAA-covered path to a
   known-good model exists, it competes directly with Bedrock/Vertex. Unverified.
3. **Does Groq offer a BAA now, or a path to one?** It is the measured best-p95 option and its
   exclusion here is purely contractual. Worth asking directly rather than assuming.
4. **Is the transcript hop defensible to a hospital's security review**, or will customers ask for
   the full self-hosted position anyway? Enterprise healthcare procurement frequently exceeds what
   HIPAA requires, and the answer is a sales question, not a legal one.
5. **State law on top of HIPAA** — CMIA (California), HB 300 (Texas), and the growing set of state
   AI and biometric-privacy statutes. **Voice is biometric data in some state regimes**, which may
   constrain the audio tiers independently of HIPAA. Also 42 CFR Part 2 if substance-use information
   is ever in scope, which is stricter than HIPAA and is a real risk in an open symptom description.
6. **FDA position** on the non-diagnostic boundary — the US counterpart to the UK's MHRA question,
   and the same architectural argument (fixed intake schema, escalation rules, no advice) should
   support it. Needs a written determination.
7. **Breach notification readiness** — 60-day rule, plus the audit-log retention that makes an
   investigation possible at all.
8. **Multi-tenancy.** If this serves several provider organisations, tenant isolation and per-tenant
   BAAs become an architectural question, not a contractual one. The UK profile assumes a single
   trust; the US market probably does not allow that assumption.

---

## 6. Cost shape

Between the other two profiles, which is the point of it.

| | Portfolio | **US hybrid** | UK sovereign |
|---|---|---|---|
| LLM | hosted, per-token | **hosted under BAA, per-token** | self-hosted, fixed GPU cost |
| Speech | hosted | **self-hosted** | self-hosted |
| SFU | LiveKit Cloud | **self-hosted** | self-hosted |
| Fixed cost floor | ~€4/mo | moderate — audio tiers only | high — all tiers, GPU-heavy |
| Marginal cost per call | low | low-moderate | ~zero |

The fixed floor is the audio tiers; the LLM stays variable. **This is a better fit for uncertain or
seasonal volume than the UK profile's all-fixed structure**, and it means the break-even-volume
problem in UK §7 does not arise in the same form.

No figures. Nothing here has been priced, and pricing it before question 1 is answered would be
guesswork with a decimal point on it.
