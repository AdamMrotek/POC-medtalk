# PDR — Clinical Voice Intake Platform

**Document type:** Product Design Requirements / preliminary design review
**Status:** for review — no implementation assumed
**Version:** 1.0 · 2026-08-18
**Author:** Adam Mrotek

---

## 0. How to read this

**This document assumes nothing has been built.** It is the consolidated output of an investigation
— architecture, benchmarks, a control-gap assessment and three deployment studies — restated as a
single design specification rather than as a history of how the conclusions were reached.

It consolidates and supersedes, as the design of record:

| Source | What is carried forward |
|---|---|
| `clinical-voice-assistant-requirements.md` | scope, the non-diagnostic boundary, defence-in-depth |
| `voice-architecture.md` | transport and pipeline decisions, the four evidence classes, R-1…R-9 |
| `voice-pipeline-benchmark-plan.md` | every latency and model-behaviour measurement cited here |
| `adr/0001-backend-owned-state-machine.md` | server-owned state, tool authorization by table |
| `iso27001-gap-assessment.md` | eleven control findings, restated here as design inputs |
| `deployment-portfolio.md` · `deployment-uk-nhs.md` · `deployment-us-hipaa.md` | the three target profiles |
| `product-overview.md` | domain model, lifecycle, clinician surfaces |

**On the measurements.** Latency and model-behaviour figures were obtained on a working prototype.
This document does not assume that prototype exists or that any of its code is reused — the numbers
are evidence about *models and topologies*, not about an implementation. Where a number decides
something, §17 says which measurement it came from.

**Requirement IDs are new and stable.** The investigation's `R-1…R-9` are mapped in §3.9 so the
older documents remain readable against this one.

**Two words used precisely throughout:**

- **Interview** — one intake conversation with one patient. The unit that is deployed, taken,
  reviewed and reported on. Spans days.
- **Session** — one connection attempt within an interview. Spans minutes. An interview may have
  several; it has exactly one record.

---

## 1. Product definition

### 1.1 What it is

A **clinical intake platform**: a clinician deploys a structured voice interview to a patient, the
patient takes it in their own time by voice or text, and the clinician receives a structured record
and a machine-drafted summary which they amend and **sign**. The signed review is the product's
output. Everything else exists to make that artefact trustworthy.

The conversation itself is one module of several (§5). It is the hardest part to build and the
smallest part of the product.

### 1.2 What it is not — and this boundary is architectural

**It collects and structures information for a clinician to review. It does not advise, triage, or
diagnose.** That sentence is the regulatory position that keeps the system outside medical-device
classification (FDA SaMD / MHRA), and it is enforced by the shape of the system rather than by
prompt wording:

- a fixed intake schema the model may write into and cannot extend;
- escalation rules that are deterministic and independent of the model;
- no output that ranks, prioritises or recommends without a named human signing it.

**A disposition that *acts* — books an appointment, assigns a triage category by rule — crosses that
boundary.** It is out of scope for v1 and is open decision O-7.

### 1.3 Users and their jobs

| User | Job to be done |
|---|---|
| **Clinician** | "Get structured, safe pre-visit information from my patients without spending my time collecting it — and let me sign off on what I actually believe." |
| **Patient** | "Answer questions about my symptoms when it suits me, in my own words, and be told immediately if what I'm describing needs urgent care." |
| **Duty / on-call clinician** | "Know within minutes that something dangerous was said, even if it wasn't said to me." |
| **IG / compliance officer** | "Show me who accessed what, what the system said and why, and prove it hasn't been edited." |
| **Administrator** | "Manage users, protocols and retention without being able to read clinical content." |

### 1.4 Success criteria

Measurable, and each maps to a requirement class in §3:

| # | Criterion | Target |
|---|---|---|
| S-1 | Red flags reach a human | 100% of escalations acknowledged; median time-to-acknowledge < 10 min in hours |
| S-2 | The conversation completes | ≥ 85% of started interviews reach `finalized` without lockout or abandonment |
| S-3 | The record is usable | ≥ 90% of signed reviews accept the drafted summary with minor or no amendment |
| S-4 | It feels like a conversation | latency budget in §11 met at p95, per state |
| S-5 | Nothing is unexplainable | every "why did it do that?" answerable from evidence alone, without asking an engineer |
| S-6 | Clinician time is saved | interview review takes less time than conducting the intake would have |

**S-5 is the one that justifies the evidence architecture (§9) to anyone who thinks it is overbuilt.**

---

## 2. Scope

### 2.1 In scope, v1

Patient records and care-team assignment · protocol registry with versioning · interview deployment
and delivery · the voice interview engine (§5) · text fallback · deterministic red-flag escalation
with acknowledgement · the four-class evidence store · clinical review and signature · three
clinician surfaces (§8) · authentication, role- and relationship-based access control · telemetry.

### 2.2 Out of scope, v1 — named so they are decisions rather than omissions

EHR/FHIR integration · appointment booking · billing · multi-specialty protocol authoring UI
(protocols are authored in code and published; §4 M3) · patient-facing report access (O-2) ·
telephony / inbound SIP (the chosen transport supports it; the workflow does not) · multi-language
interviews (the field catalog is English-only in v1) · native mobile apps.

### 2.3 One codebase, three deployment profiles

The profiles differ in **where models run and who may see patient data** — not in product behaviour.
This is a design constraint on every module, not a deployment concern to be handled later.

| Profile | Purpose | Voice pipeline | PHI |
|---|---|---|---|
| **Portfolio** | demonstrable, public | single vendor, all hops hosted | none exists |
| **UK NHS** | sovereign, at scale | everything self-hosted, no AI vendor in path | real |
| **US HIPAA** | hyperscaler under BAA | audio self-hosted, transcript to a covered LLM | real |

**The only mechanism this requires is a per-hop provider seam (§5.5) and a refuse-to-start guard.**
Everything else follows.

---

## 3. Requirements

Numbered, testable, ordered by how hard they are to retrofit. **Each carries a test, because a
requirement without one is an aspiration.**

### 3.1 Clinical safety — non-negotiable

| ID | Requirement | Test |
|---|---|---|
| **CS-1** | Red-flag detection runs twice, independently: a deterministic pattern scan and the model's own judgement. Either escalates. | Disable the model's flagging tool; every red-flag fixture still escalates. |
| **CS-2** | The deterministic scan is **control flow, not a race**: transcript → scan → LLM, with the LLM never invoked on a flagged utterance. | On a flagged utterance, LLM invocation count is **zero**. Not "cancelled" — zero. |
| **CS-3** | Escalation is reachable from every conversation state except escalation itself. | Structural test over the transition table, not per-state spot checks. |
| **CS-4** | An escalation creates an obligation on a **named human**, with a clock, that survives the call ending. | Simulate an escalation with the assigned clinician offline; a duty target is notified and the item stays open until acknowledged. |
| **CS-5** | Over-escalation is the safe failure direction; false negatives are not. Tuning may only be loosened with evidence. | Escalation rate is a monitored safety metric (§11); a drop triggers review. |
| **CS-6** | The patient is never cut off mid-symptom in favour of responsiveness. | Endpointing hangover per §11; the rambling-symptom fixture is not clipped. |
| **CS-7** | The model may propose actions; it may never authorize them. | Every tool call is checked against a declarative permission table before execution; a call from a closed state is refused. |

**CS-2 is the requirement that eliminated an entire transport option.** Measured on a
speech-to-speech pipeline, the model began speaking a median of **49 ms before the transcript
existed**, and on **11 of 20 turns** was already speaking before the scan had anything to read. A
gate that arrives after speech has started is a claw-back, not a gate.

### 3.2 The interview

| ID | Requirement | Test |
|---|---|---|
| **IV-1** | Identity is verified before any clinical question is asked. | A clinical tool call from the verification state is refused. |
| **IV-2** | Verification failure is bounded and terminal (3 attempts), and the bound survives reconnection. | Disconnect and rejoin after 2 failures; the third failure locks. |
| **IV-3** | Questioning is protocol-driven and branching on what the record is missing — not open-ended. | The model is offered only the tools and fields its current state permits. |
| **IV-4** | An interview may be resumed after a network drop **or a server restart**, within its window. | Kill the process mid-interview; rejoin; the record and ledger are intact and the conversation continues. |
| **IV-5** | A text-only path exists, produces the same record and passes the same safety gate. | The full red-flag fixture suite runs against the text implementation. |
| **IV-6** | The patient may interrupt at any point except during an emergency instruction, which always completes. | Barge-in policy per state; false barge-in rate in a quiet room is **0**. |
| **IV-7** | An interview belongs to exactly one patient and one protocol version, both pinned at deployment. | Attempting to re-point either is rejected. |

### 3.3 Clinical workflow

| ID | Requirement | Test |
|---|---|---|
| **WF-1** | A clinician can find a patient by identifier and take them onto their panel; the assignment is an audited event with a reason. | Assignment without a reason is rejected; the event appears in the staff ledger. |
| **WF-2** | Patient ↔ clinician is many-to-many and time-bounded; at most one *responsible* clinician at a time. | Claiming responsibility where one exists produces a transfer, not a duplicate. |
| **WF-3** | Deploying an interview is refused, not warned, when preconditions fail (§8.3). | Each precondition has a rejection test. |
| **WF-4** | Delivery failure is a lifecycle event, not a log line. | A bounced invite surfaces in the warnings queue. |
| **WF-5** | Every interview outcome lands in exactly one dashboard bucket, by table (§7.4). | Exhaustive mapping test over conversation-terminal states. |
| **WF-6** | The clinical output is a **signed** review by a named registrant, pinned to the exact record and ledger state it was written against. | Signature stores content hashes; altering either invalidates verification. |
| **WF-7** | A signed review is never edited — corrections supersede. | Edit attempt on a signed review is rejected; supersede creates a second attributable document. |

### 3.4 Evidence

| ID | Requirement | Test |
|---|---|---|
| **EV-1** | A completed interview leaves four separable records: audio, an immutable ledger, the structured record, and PHI-free telemetry. | §9 store-by-store. |
| **EV-2** | The ledger is append-only and **tamper-evident** — hash-chained *and* WORM-backed. | Mutate a row directly in storage; verification fails and identifies the entry. |
| **EV-3** | The ledger records scan **passes**, not only flags. | "The scanner ran at 04:12 and matched nothing" is retrievable. |
| **EV-4** | The structured record is a **projection** of the ledger and is rebuildable by replay. | Delete and rebuild the record; it is byte-identical. |
| **EV-5** | The issued summary is immutable evidence, not a mutable field on the record. | Regenerating a summary creates a new entry; the issued one is unchanged. |
| **EV-6** | Telemetry contains **no free text from the conversation**, by construction. | A known PHI canary planted in a transcript never appears in the telemetry stream. |
| **EV-7** | Erasure is satisfiable without breaking the chain: redact content, retain the entry, log the erasure. | Erase a patient; chain verification still passes; the record rebuilds from redacted history. |
| **EV-8** | Audio is recorded per speaker track, never pre-mixed, and only with recording consent. | Two tracks exist; capture is absent when consent is absent, and the interview still completes. |

**EV-6's leak vector is errors, not metrics.** Nobody logs a transcript deliberately; they log an
exception whose payload carries the request body. Discipline is not a control — the logger's
signature must accept only a closed set of primitive fields, with redaction at the serializer
boundary.

### 3.5 Security and access

Restated from eleven findings in the control-gap assessment. **In a greenfield build these are
design inputs, not defects** — which is the entire value of having assessed a prototype first.

| ID | Requirement | Origin |
|---|---|---|
| **SEC-1** | Every endpoint authenticated; no anonymous surface except the tokenised patient entry point. | F-01 (critical) |
| **SEC-2** | Authorization is one server-side seam — role **and** an active care relationship — not a per-handler condition. | F-01 |
| **SEC-3** | Verification attempt counters are server-authoritative and non-resettable by the client. | F-02 |
| **SEC-4** | Tool arguments are validated against a closed schema; unknown keys are dropped, never merged. | F-03 (mass assignment) |
| **SEC-5** | All access to clinical content is logged — reads included — to the same tamper-evident store as writes. | F-04 (critical) |
| **SEC-6** | Persistence, retention and deletion are defined before first storage, not retrofitted. | F-05 |
| **SEC-7** | No clinical free text in any log, error surface or event stream. | F-06 |
| **SEC-8** | Upstream provider errors are never proxied to a client; they are mapped to opaque codes. | F-07 |
| **SEC-9** | Every AI provider sits behind an interface with a documented supplier assessment. | F-08 |
| **SEC-10** | CI with dependency scanning and the safety test suite gates every merge from commit one. | F-09 |
| **SEC-11** | TLS 1.3, security headers, rate limiting and per-tenant quotas at the edge. | F-10 |
| **SEC-12** | Consent is captured, versioned and enforced — recording consent gates audio capture. | F-11 |
| **SEC-13** | Break-glass access exists, is time-boxed, notifies the responsible clinician on use, and is reviewed. | derived from SEC-2 |

**SEC-13 is a requirement precisely because SEC-2 is strict.** An emergency access path that is hard
to use becomes a shared standing account, which is worse than the control it replaced.

### 3.6 Privacy and jurisdiction

| ID | Requirement | Test |
|---|---|---|
| **PRV-1** | Every hop that sees patient data is an enumerable processor with a contract. | The processor list is generated from configuration, not maintained by hand. |
| **PRV-2** | Sensitivity is ranked and honoured: *nothing leaves* > *transcript only leaves* > *audio leaves*. | Each deployment profile declares its position; configuration cannot silently downgrade it. |
| **PRV-3** | The system **refuses to start** in PHI mode if any selected provider is not covered by an agreement. | Boot with an uncovered provider; the process exits non-zero. |
| **PRV-4** | Only telemetry may cross the trust perimeter. | Egress deny-by-default; a network test asserts it. |
| **PRV-5** | Data-subject rights (access, rectification, erasure) are satisfiable across all four classes. | See EV-7. |

### 3.7 Performance

Full budget in §11. **A single sub-second target is the wrong requirement** — it trades a clinical
harm for a perceptual one. Targets are per state.

| ID | Requirement |
|---|---|
| **PERF-1** | Response latency meets the per-state budget in §11, measured from the **acoustic end of speech**, not from endpoint-declared. |
| **PERF-2** | Emergency instructions are delivered from pre-rendered audio — no LLM, no TTS vendor, on the most safety-critical path. |
| **PERF-3** | Speculative execution may shorten latency but may never cause a side effect: no tool call, no state transition, no audio from a discarded speculation. |
| **PERF-4** | Degradation is graceful: pipeline failure falls back to text within the same interview, never a silent drop. |

**PERF-1's measurement basis is not pedantry.** Vendor latency claims are quoted from
endpoint-declared, which excludes the hangover — the largest single term. Numbers measured the two
ways are not comparable, and mixing them is how a budget is missed by half a second.

### 3.8 Portability and operations

| ID | Requirement |
|---|---|
| **OPS-1** | No provider is hardcoded. STT, LLM and TTS are selected independently, per hop, by configuration. |
| **OPS-2** | Any model change re-runs the tool-correctness fixtures before it ships (§3.1 CS-7, §5.6). |
| **OPS-3** | An engineer can diagnose a production latency regression with **no access to PHI whatsoever**. |
| **OPS-4** | Prompt instruction blocks are byte-identical per state and contain no interpolated per-call content. |

**OPS-4 looks like a micro-optimisation and is a cost and rate-limit decision.** Providers cache
identical prompt prefixes; cached tokens are cheaper and typically do not count against rate limits.
One interpolated patient name at the top of the block caches nothing, ever. Variable context belongs
in later messages.

### 3.9 Mapping to the investigation's requirement IDs

| Was | Now |
|---|---|
| R-1 data ownership | IV-4, EV-1 |
| R-2 safety gate | CS-2 |
| R-3 latency, state-dependent | PERF-1, §11 |
| R-4 clinical safety over speed | CS-6 |
| R-5 tool-call correctness | CS-7, OPS-2 |
| R-6 PHI / processor minimisation | PRV-1, PRV-2, PRV-3 |
| R-7 barge-in | IV-6 |
| R-8 provider portability | OPS-1 |
| R-9 four evidence classes | EV-1…EV-8 |

---

## 4. System decomposition

Eleven modules. **A module earns its boundary by owning a decision that changes independently of
the others** — not by being a convenient folder.

| # | Module | Owns | Changes when |
|---|---|---|---|
| **M1** | Identity & Access | authentication, roles, the authorization seam, break-glass | security policy changes |
| **M2** | Patient & Care Team | patients, care assignments, transfers | clinical org structure changes |
| **M3** | Protocol Registry | field catalogs, red-flag sets, permission tables, prompt blocks, model config — **versioned and immutable once published** | clinical content changes |
| **M4** | Interview Orchestration | the interview lifecycle, deployment, windows, tokens, resumption | workflow changes |
| **M5** | **Voice Interview Engine** | the conversation: transport, pipeline, turn-taking, in-call state, the safety gate | voice technology changes — **constantly** |
| **M6** | Safety & Escalation | escalation records, routing, rotas, acknowledgement clocks | safety policy changes |
| **M7** | Evidence Store | the four classes, hash chain, WORM, retention, erasure | compliance regime changes |
| **M8** | Clinical Review | drafts, amendments, dispositions, signature | clinical governance changes |
| **M9** | Clinician Workspace | the three surfaces (§8) | user needs change |
| **M10** | Delivery & Notification | invites, receipts, reminders, escalation alerts | channels change |
| **M11** | Telemetry | metrics, traces, alerting — PHI-free by construction | operations change |

### 4.1 The dependency rule

```
        M9 Workspace ─────────────────────────────────┐
             │ (reads everything through M1)          │
             ▼                                        │
   ┌─── M1 Identity & Access ────┐                    │
   │        (every call passes)  │                    │
   └──┬──────────┬──────────┬────┘                    │
      ▼          ▼          ▼                         ▼
     M2         M4 ◄──── M3 Protocols            M8 Review
   Patients  Orchestration    │                       │
                 │  ▲         │                       │
      dispatches │  │ events  │ supplies the brief    │
                 ▼  │         ▼                       │
        ┌──────────────────────────────┐              │
        │  M5 Voice Interview Engine   │              │
        │  (replaceable, sandboxed)    │              │
        └──────────┬───────────────────┘              │
                   │ emits                            │
      ┌────────────┼─────────────┬───────────┐        │
      ▼            ▼             ▼           ▼        ▼
  M6 Escalation  M7 Evidence  M11 Telemetry  M10 Delivery
```

Three rules, and they are the design:

1. **Everything clinical passes through M1.** One authorization seam, not thirty.
2. **M5 depends on M3 and nothing else.** It is *given* a protocol; it does not look one up.
3. **M5 never writes to a clinical store.** It emits events; M7 persists them; M4 interprets them.
   This is what makes the engine replaceable and testable in isolation, and it is the subject of §5.

---

## 5. M5 — the Voice Interview Engine

### 5.1 Why voice is a module and not the application

Three independent reasons, any one of which would be sufficient:

- **It changes on a different clock.** Every hop in the pipeline has had a materially better option
  appear within the last year. The clinical workflow around it has not changed in decades.
- **It has four legitimate implementations at once** (§5.4) — cascaded, speech-to-speech, text, and
  scripted-for-test — and the platform must be indifferent to which is running.
- **It is the only module that varies across all three deployment profiles.** Isolating the variation
  in one module is what makes "one codebase, three profiles" true rather than aspirational.

There is a fourth reason that matters more than any of them: **the engine is the only component that
runs untrusted model output in the audio path.** Giving it a narrow, one-directional contract is a
security control, not an aesthetic preference.

### 5.2 The contract

**Inbound — the Interview Brief.** Everything the engine needs, handed to it once at session start.
It looks nothing up and holds no persistent state of its own.

```
InterviewBrief {
  sessionId          opaque, not derivable from patient identity
  interviewId
  protocol {                          ← from M3, a pinned immutable version
    versionId
    states, transitions               the conversation machine
    toolPermissions                   which tools each state allows
    fieldCatalog                      what may be recorded, and nothing else
    redFlagSet                        patterns + model-facing descriptions
    promptBlocks                      per state, byte-identical, no interpolation (OPS-4)
    bargeInPolicy                     per state
    endpointing                       per state
  }
  identityChallenge {                 ← from M2, hashed, never plaintext PHI
    expectedDobHash, expectedPhoneSuffixHash, maxAttempts, attemptsUsed
  }
  consent { recording: bool, processing: bool }
  resumeFrom?        prior conversation state + record projection (IV-4)
  pipeline           per-hop provider selection for this deployment (§5.5)
}
```

**Outbound — an event stream, and one outcome.** The engine's entire output. Every event is
append-only and destined for M7; the engine does not decide what is persisted.

```
UserTurn        { at, transcript, confidence, scanResult: {ran, matched|null} }   ← passes too (EV-3)
AssistantTurn   { at, text, audioRef?, model, latencyBreakdown }
ToolCall        { at, name, arguments, permitted: bool, effect }
Transition      { at, from, event, to }
Escalation      { at, source: model|scan, redFlagId, triggerText }
AudioSegment    { at, track: patient|assistant, codec, ref }
Telemetry       { at, metric, value }        ← PHI-free, separate sink (EV-6)
Outcome         { finalized | escalated | verification_failed |
                  reschedule_requested | abandoned | fault, at, summary? }
```

**Two properties of this contract carry the design:**

**It is one-directional.** The engine never queries the platform mid-turn. There is no HTTP hop on
the safety path — a call that could fail, hang, or add 200 ms to the one code path where neither is
acceptable. Everything it needs arrived in the brief.

**Decide locally, ratify centrally.** The engine evaluates tool permissions and transitions
in-process (they are pure functions over the protocol it was handed), and M4 **re-evaluates the same
functions** when ingesting the event stream. A compromised or buggy engine can emit whatever it
likes; it cannot cause the platform to record something the protocol forbids. This gives CS-2's
zero-invocation property *and* CS-7's authorization property without choosing between them.

### 5.3 The boundary, stated as exclusions

**Inside the engine:** transport and media, VAD and turn detection, STT/LLM/TTS orchestration, the
safety gate as control flow, the in-call state machine, tool argument validation, barge-in, audio
frame capture, per-turn latency measurement.

**Outside, and the engine must never do these:**

| Must never | Because |
|---|---|
| Write to any clinical store | M7 owns evidence; a module that both acts and records its own actions cannot be audited |
| Look up a patient, protocol or clinician | Everything arrives in the brief; lookups are a coupling and a PHI surface |
| See clinician-authored text | Deployment notes and review content are prompt-injection surface with no clinical benefit |
| Hold identity truth | It receives a hashed challenge and reports pass/fail; it never learns the patient's DOB |
| Decide an interview's lifecycle | It reports how the conversation ended; M4 decides what that means (§7.4) |
| Retry a failed turn silently | A retried turn is a second turn; it goes in the ledger as one |
| Persist anything across sessions | Resumption state arrives via `resumeFrom`, so a restart loses nothing (IV-4) |

### 5.4 Four implementations of one contract

| Implementation | Role | Notes |
|---|---|---|
| **Cascaded** (default) | production | SFU + agent process; STT → gate → LLM → TTS. The only one satisfying CS-2 and EV-8 together. |
| **Speech-to-speech** | latency baseline, demo | Fastest measured, and **structurally incapable** of EV-8 — the audio is a vendor's live stream, so there are no frames to record. Retained as an A/B reference, never as the PHI path. |
| **Text** | accessibility, degradation (IV-5, PERF-4) | Same brief, same gate, same events; no media. |
| **Scripted** | test harness | Replays fixture transcripts through the identical gate and tool logic. **This is what makes the safety suite runnable in CI without audio, models, or money.** |

**The scripted implementation is not a testing convenience — it is why the contract is shaped this
way.** A safety requirement you can only verify by placing a phone call is a safety requirement you
will verify rarely.

### 5.5 Internal architecture

```
  patient browser ──WebRTC──> SFU ──decoded frames──> agent process
                                                        │
      ┌─────────────────────────────────────────────────┤
      │  VAD ──> turn detection ──> STT                  │
      │                              │                   │
      │                              ▼                   │
      │                     ┌──────────────────┐         │
      │                     │  SAFETY GATE     │  flagged ──> pre-rendered audio, stop
      │                     │  deterministic   │         │      (PERF-2, ~400ms, no LLM)
      │                     └────────┬─────────┘         │
      │                        clean │                   │
      │                              ▼                   │
      │                    LLM ──> tool proposal ──> permission check ──> effect
      │                              │                                      │
      │                              ▼                                      ▼
      │                     TTS ──> audio out                         event stream ──> M7
      └──────────────────────────────────────────────────┘
                    │            │            │
                 VOICE_STT   VOICE_LLM    VOICE_TTS      ← independent per-hop selection
```

**The per-hop seam is the mechanism behind "one codebase, three profiles" (§2.3).** Each hop is
selected independently because the right answer differs per hop, per jurisdiction, and changes as
vendors ship. Everything speaks one common request shape, so a new vendor is usually a base URL
rather than an implementation, and a self-hosted server drops into the same slot as a hosted one.

`PHI_MODE=true` refuses to start when any selected hop is uncovered (PRV-3) — defence in depth
behind network egress control, never the primary control.

### 5.6 Engine decisions carried from the investigation

Each is a decision with evidence, not a preference. Sources in §17.

| Decision | Rationale | Firmness |
|---|---|---|
| **SFU + cascaded agent, not speech-to-speech** | Speech-to-speech fails CS-2 (gate races generation), IV-4 (conversation is the vendor's stream) and EV-8 (**cannot be worked around at any price** — you cannot record audio you never receive). It is ~1.3 s p50 against ~1.6–1.9 s and ~30× the per-minute cost. | **Hard** |
| **Safety gate in the turn-completed hook** | Runs after the user turn commits and before any reply is released: LLM invocation count is zero by construction, not by cancellation. | **Hard** |
| **Agent in the same language as the platform's declaration layer** | The gate and the permission table are called in-process. A second language means a second copy of the red-flag catalog, and two catalogs is one catalog. | **Hard** |
| **LLM choice is pinned by tool correctness, not speed** | Smaller models fabricated verification arguments and called tools in response to *"Yes, that's fine."* Three fabricated attempts lock a patient out — **a model tic ending an intake is the same class of harm as a missed red flag.** Two larger models handle the same prompt correctly. | **Hard (CS-7, OPS-2)** |
| **Endpointing hangover ~700 ms during open symptom description** | At 300 ms, *"It started… [thinks] …maybe Tuesday, and my neck's been stiff"* clips after "started" — and the clipped clause is the red flag. Generic 400 ms voice-agent guidance does not apply to clinical intake. | **Hard (CS-6)** |
| **Latency is won from speculation, not from the hangover** | Firing inference on transcript arrival overlaps the endpointing wait; the clinical hangover is untouched. ~550 ms estimated saving. | Firm |
| **Speculative audio synthesis stays off** | Speculating the LLM is free if discarded; speculating audio trades the ordering guarantee CS-2 depends on for ~200 ms. | **Hard** |
| **Speculative tool dispatch must be gated** | Known hazard in this class of framework: speculation does not check in-flight tool execution, so a discarded `verify_identity` still burns an attempt. **Write this test before measuring any latency.** | **Hard (PERF-3)** |
| **Emergency lines pre-rendered at build time** | Fixed text, synthesized once: ~400 ms with no LLM and no TTS vendor, on the most safety-critical path. Extends to every scripted line in the machine. | Firm |
| **Small local STT is sufficient on modest hardware** | 149–232 ms full recognition versus ~1.7 s for the largest model — which alone exceeds the whole latency budget. **Reopened on datacentre GPUs**, where it reverses. | Soft, hardware-dependent |
| **Transcode nothing** | The transport already carries a compressed codec at ~240 KB/min/track; converting to raw PCM is ~8× the bytes for no benefit, since recognition resamples anyway. | Firm |
| **Record from the agent, not a recording service** | The agent already holds decoded frames. A composite-recording service drags in a headless browser and a media stack — a whole service to operate for something already in hand. | Firm |

**One caveat that must travel with every local measurement quoted here:** they were taken with GPU
acceleration active, not on CPU. The gap is roughly 4×. A CPU-only deployment plan built on these
numbers would be wrong by that factor.

---

## 6. Domain model

```
                 ┌──────────────┐                              ┌──────────────┐
                 │  Clinician   │                              │   Patient    │
                 └──────┬───────┘                              └───────┬──────┘
                        │ n            many-to-many,                  n │
                        └───────────< CareAssignment >─────────────────┘
                                      role · from · until
                                      assignedBy · reason

   ┌───────────┐      ┌──────────────────┐                     ┌───────────────────┐
   │ Protocol  │──1:n─│ ProtocolVersion  │──────────1:n───────>│    Interview      │
   └───────────┘      │ immutable once   │                     │  many-to-one on   │
                      │ published        │   deployedBy ──────>│  Patient          │
                      └──────────────────┘   assignedTo ──────>│  lifecycle state  │
                                             (both Clinician)  └─────────┬─────────┘
                                                                         │ 1
        ┌──────────────┬──────────────┬──────────────┬──────────────┬────┴─────────┐
        │ n            │ 1            │ n            │ 0..n         │ 0..n         │ 0..n
   ┌────▼─────┐  ┌─────▼────────┐ ┌───▼────────┐ ┌───▼─────────┐ ┌──▼───────┐ ┌────▼─────┐
   │ Session  │  │ IntakeRecord │ │ LedgerEntry│ │ Escalation  │ │  Review  │ │ Consent  │
   │ one      │  │  class 3     │ │  class 2   │ │ own ack     │ │ ≤1 signed│ │ scoped   │
   │ connect  │  │  projection  │ │ hash-chain │ │ lifecycle   │ │ addendum │ │          │
   └────┬─────┘  └──────────────┘ └────────────┘ └─────────────┘ └──────────┘ └──────────┘
        │ n
   ┌────▼──────────┐        ┌──────────────────────────────────────────┐
   │ AudioArtifact │        │ TelemetryEvent · class 4 · separate store │
   │ class 1       │        │ no foreign keys — sessionId is a string,  │
   │ per track     │        │ not a relation                            │
   └───────────────┘        └──────────────────────────────────────────┘
```

### 6.1 The three cardinalities that carry the model

**`Patient` ↔ `Clinician` is many-to-many through `CareAssignment`.** A patient has one responsible
clinician and any number of covering ones; a clinician has a panel. Modelling the relationship as a
row rather than a foreign key is what makes *"take this patient onto my list"* an auditable event
with an actor, a timestamp and a reason — rather than a mutated column that answers *what* but never
*why*. That distinction is the difference between an access log that survives a DPIA and one that
does not.

**`Interview` → `Patient` is many-to-one, pinned at deployment.** An interview is about exactly one
patient and one protocol version, and never migrates (IV-7).

**`Session` → `Interview` is many-to-one.** The interview is the clinical unit; a session is one
connection attempt. A patient who loses signal at 04:12 and rejoins produces two sessions and **one**
record, one ledger, one review. Without this split, IV-4's resumption test has nothing to resume
into, and a dropped call silently becomes a second, half-empty clinical record.

### 6.2 Entities

**Patient** — `id · mrn/nhsNumber · name · dateOfBirth · phone · email · preferredChannel ·
language · accessibilityNeeds · status`. The identity fields are functional, not descriptive: date of
birth and the last digits of the phone number are exactly what the in-call challenge verifies.

**Clinician** — `id · displayName · registrationNumber · role · organisationId · rotaIds · status`.
The registration number exists because a signed review must name a registrant, not a username.

**CareAssignment** — `patientId · clinicianId · relationship (responsible|covering|observer) ·
assignedBy · assignedAt · endsAt? · endedAt? · reason · source`. **Covering assignments expire by
default** — a weekend cover that never lapses is how a panel silently becomes org-wide read access,
and it is the first thing an IG review looks for.

**Protocol / ProtocolVersion** — the clinical content: field catalog, red-flag set, permission table,
prompt blocks, model configuration, latency profile. **Published versions are immutable, and every
interview pins one.** A record saying *"severity: 7"* is uninterpretable six months later unless the
question asked and the red-flag set armed at the time are both recoverable. Mutable protocols
retroactively rewrite the meaning of every historical record — including, and this is the sharp
case, by changing which symptoms would have escalated.

**Interview** — `patientId · protocolVersionId · deployedBy · assignedTo · lifecycleState ·
priority · deliveryChannel · opensAt · expiresAt · accessTokenHash · deploymentNote · outcome`.
**Two clinician references, deliberately:** who sent it and who owes it a review. They default to the
same person and diverge constantly — one clinician runs a list, another reviews it — and without the
distinction, "my interviews" is an ambiguous filter (§8.4).

**Session** — `interviewId · startedAt · endedAt · transport · conversationState · clientInfo ·
terminationReason`. **The verification attempt counter lives on the interview, not the session** —
otherwise reconnecting resets the lockout and IV-2 is advisory.

**IntakeRecord** (class 3) — the structured extraction, keyed by interview, **a projection of the
ledger** (EV-4). The summary is *not* on it (EV-5).

**LedgerEntry** (class 2) — every user turn and its scan result including passes, every model turn,
every tool call with arguments and verdict, every transition, the summary and its inputs.
Hash-chained, WORM-backed. **Plus the staff ledger:** clinician actions — claimed a patient, opened a
profile, played audio, signed a review, broke glass — are the same kind of fact about a different
subject and need the same tamper-evidence. Same store, same chain, a `subject` discriminator.
Building a second, weaker audit mechanism for staff actions is the predictable mistake.

**Escalation** — `interviewId · sessionId · raisedAt · source · redFlagId · triggerText ·
notifiedTargets · acknowledgedBy? · acknowledgedAt? · disposition? · closedAt?`. **Its own entity
with its own clock**, for the reason in §7.3.

**Review** — `interviewId · authorId · status · clinicalImpression · amendments[] · disposition ·
riskRating · recordVersionHash · ledgerHeadHash · signedAt · signature`. Disposition enum:
`routine_appointment · urgent_appointment · same_day · advice_only · repeat_interview · invalid`.
**`invalid` matters more than it looks** — without it, the only way to retire a bad interview is
deletion, and deletion is what the ledger forbids.

**Consent** — `patientId · interviewId? · scope (processing|recording|retention) · grantedAt ·
method · withdrawnAt?`. Recording consent is a hard gate on class 1 (EV-8), which means the engine
must run with capture disabled and still produce classes 2–4.

---

## 7. State model

Three machines. Conflating any two of them is the most expensive mistake available in this design.

### 7.1 Conversation — minutes, session-scoped, owned by M5

```
verification ──identity_verified──> intake ──intake_finalized──> finalized
     │                                │
     ├─verification_locked──> locked  │
     ├─reschedule_requested─> reschedule
     └──────────── red_flag ──────────┴──────────> alert   (reachable from every state but alert)
```

`alert` is the only sink. **Being closed to the agent is not the same as being closed to an
emergency** — a patient reporting stroke symptoms while the system is apologising for a failed
verification still needs to be told to call for help. That is why `red_flag` is legal from
`locked`, `reschedule` and `finalized` alike, and it is a structural test (CS-3), not a code review
item.

`alert`, `reschedule`, `locked` and `finalized` permit **no tools at all**. "Stop recording data now"
is therefore one property of a table rather than a condition repeated across five handlers.

### 7.2 Interview lifecycle — days, interview-scoped, owned by M4

Declared the same way and in the same layer as the conversation machine, so the dashboards' buckets
are a table you read rather than conditions scattered across three views.

```
   draft ──publish──> scheduled ──invite_sent──> invited ──session_started──> in_progress
     │                    │            │              │                            │
     │                    │            └─invite_failed┴──> needs_attention          │
     │                    └────window_elapsed────> expired                          │
     │                                                                              │
     │              conversation reached a terminal state ─────────────────────────┤
     │        ┌──────────────────┬───────────────────┬────────────────┬─────────────┘
     │        ▼                  ▼                   ▼                ▼
     │  awaiting_review   needs_attention        expired        (still resumable:
     │        │           (locked/reschedule)    (abandoned)     stays in_progress
     │        ▼                  │                                until window closes)
     │    in_review              │
     │        │                  │
     │        ▼                  ▼
     │     signed ──────────> archived
     │
     └──cancel──> cancelled     (legal from every non-terminal state)
```

**`escalated` is deliberately not a lifecycle state.** A red flag raises an `Escalation` and sets the
interview's priority to urgent; the interview still lands in `awaiting_review` like any other.
Making escalation a lifecycle state would mean an escalated interview cannot also be reviewed —
exactly backwards, since it needs reviewing most.

### 7.3 Escalation — its own machine, and this is a safety decision

```
raised ──> notified ──> acknowledged ──> closed(disposition)
   │           │
   └─ timeout ─┴──> escalate to next rota target
```

**It exists separately because it must be closed by a human even if the interview is never
reviewed.** Folding acknowledgement into review status means a red flag is discharged by someone
reading a report — possibly the next working day. That is precisely the failure mode the
double-detection design (CS-1, CS-2) exists to prevent, and reintroducing it in the workflow layer
would waste the whole exercise. An escalation raised at 02:00 against a sleeping clinician is an
unacknowledged red flag; the routing target is a rota with a timeout, not a person.

### 7.4 The joint — conversation outcome → lifecycle → bucket

**One function, evaluated in M4 on ingest.** Not branching logic in three views.

| Conversation ended in | Outcome | Lifecycle | Bucket | Notified |
|---|---|---|---|---|
| `finalized` | `completed` | `awaiting_review` | Needs review | `assignedTo`, batched |
| `alert` | `escalated` | `awaiting_review`, urgent + `Escalation` raised | **Warnings** | rota **now**, then `assignedTo` |
| `locked` | `verification_failed` | `needs_attention` | Warnings | `deployedBy` |
| `reschedule` | `reschedule_requested` | `needs_attention` | Pending | `deployedBy` |
| dropped, window open | — | `in_progress` (resumable) | In progress | nobody yet |
| dropped, window closed | `abandoned` | `expired` | Warnings | `deployedBy`, digest |
| never started by `expiresAt` | `expired` | `expired` | Pending → Expired | `deployedBy`, digest |
| engine fault | `fault` | `needs_attention` | Warnings | `deployedBy` + on-call engineering |

Two rows deserve emphasis. **A lockout is an operational failure, not a clinical one** — the patient
may be entirely well and simply unable to recall the number on file, or the model may have
fabricated the arguments. It routes to whoever deployed it, and a rising lockout rate is a telemetry
alarm about the *system*. And **an abandoned interview is a real clinical signal**: a patient who
began describing a headache and stopped is not the same as one who never started.

---

## 8. Clinician surfaces (M9)

Three lenses on two tables. The clinician dashboard is patient-major, the deployment dashboard is
interview-major, and the patient profile is the join for one person. **Building them as three query
shapes over one model — rather than three features — is what keeps them from disagreeing.**

### 8.1 Clinician dashboard — *"what is waiting for me, and who is on my panel?"*

**Find and claim.** Search is not browse: a clinician with no assignment may resolve an identifier
they already hold, not page a directory. Exact match on MRN/NHS number, or family name + date of
birth. Results before assignment show identity only — no clinical content, no counts, no history.
Claiming opens a `CareAssignment` with a required reason; claiming `responsible` where one exists
prompts a transfer and notifies the incumbent. **Searches returning nothing are logged too** — a
burst of them is the signature this control exists to catch.

**My panel** — assigned patients with last interview, outcome, open items, next pending interview.
Sorted by open items, so the list orders itself by need.

**Four counted queues**, each a single indexed predicate:

| Queue | Predicate |
|---|---|
| **Escalations to acknowledge** | unacknowledged, where I am assigned or on rota |
| **Needs review** | `assignedTo = me AND state = awaiting_review`, urgent first |
| **In progress** | `assignedTo = me AND state = in_progress` |
| **Expiring soon** | `deployedBy = me AND state IN (scheduled, invited) AND expiresAt < now + 48h` |

The escalation queue sits above the others, always. It is the only one with a clock on it.

### 8.2 Patient profile — *"what do we know, and what is outstanding?"*

Reachable only with an active assignment or break-glass, and **every open writes to the staff ledger
before the page renders.**

Header: identity, care team with assign/transfer/end, consent status per scope, standing flags. Any
unacknowledged escalation renders as a banner here, not a row in a tab.

**History and pending are one chronological list with a lifecycle badge, filtered — not two panels.**
The question a clinician is actually asking is *"what has happened with this person"*, and splitting
it hides the ordering. Per row: date, protocol version, lifecycle badge, outcome, escalation marker,
review status and signer, summary excerpt. Pending rows carry a countdown and their own actions —
resend, extend, cancel.

**Interview detail** is where review happens — four panes over one interview:

- **Transcript** with scan results inline, **including the passes**, which is what makes *"why did it
  not escalate at 04:12?"* answerable from the UI rather than from a database (EV-3).
- **Structured record**, field by field, each traceable to the turn that set it.
- **Ledger**, raw — tool calls with arguments and verdicts, transitions, model and protocol version.
  Collapsed by default.
- **Audio** — gated on consent, role, and an explicit reveal that is itself a ledger entry. Two
  tracks, separately, never mixed.

The **review composer** sits alongside: the issued summary read-only from the ledger, a clinical
impression, amendments as additions, disposition, risk rating, and a signature capturing both content
hashes. Signing is irreversible; correcting supersedes (WF-7).

### 8.3 Deployment dashboard — *"what did I send, what came back, what needs a human?"*

**Compose:** patient (must be assigned; assign inline) · protocol + version · channel · window ·
priority · reviewer (defaults to self) · deployment note.

**Preflight refuses rather than warns on:** no active care assignment · no valid contact on the
chosen channel · recording-required protocol with no recording consent · an open interview for the
same patient on the same protocol · unpublished protocol version. **The duplicate check is not
tidiness** — a second invite makes the first one's abandonment unreadable, and abandonment is
clinical signal (§7.4).

**Buckets:**

| Bucket | Contents |
|---|---|
| Pending | sent, not started |
| In progress | live and resumable |
| Needs review | the work |
| **Warnings** | unacknowledged escalations · lockouts · delivery failures · abandoned · expired · faults |
| History | signed, archived, cancelled, expired |

**Warnings is deliberately heterogeneous.** It mixes one clinical event with several operational
ones. The alternative — a queue per failure type — buries the escalation among four individually
rare lists. One bucket, sorted by severity with escalations pinned and clocked, means there is
exactly one place to look for *"something here is not proceeding normally"*. The severity ordering,
not the bucketing, carries the distinction.

### 8.4 "My interviews" is three filters, and they are named

`deployedBy = me` (what I sent) · `assignedTo = me` (my review load) · `careTeam contains me`
(everything about my panel, whoever sent it). Different questions; the UI names them rather than
picking one silently.

### 8.5 The patient's entry point

Not a dashboard, but part of this module's contract. `GET /i/:token` resolves the interview, enforces
the window and token semantics, presents the non-diagnostic disclaimer and consent gate, then starts
a session. **The token identifies the interview; it does not authenticate the patient** — the in-call
challenge does that. Keeping those separate is what makes a forwarded link harmless.

---

## 9. Evidence architecture

Four classes, four stores, because they differ on **every axis that matters operationally**:

| | 1 · Audio | 2 · Ledger | 3 · Record | 4 · Telemetry |
|---|---|---|---|---|
| What | per-speaker tracks | transcript, scans, tool calls, transitions, summary | current structured intake | latency, counts, errors |
| Mutability | write-once | **append-only, tamper-evident** | mutable projection | append-only |
| Sensitivity | **highest — biometric** | high — PHI | high — PHI | **none, by construction** |
| Volume | largest | moderate | tiny | high frequency, tiny |
| May leave the perimeter | **never** | never | never | **yes — that is the point** |
| Retention | shortest | longest — medico-legal | policy | short |

**Volume runs inverse to retention; sensitivity runs inverse to reach.** The largest asset is kept
shortest, and the only one allowed out is the one with nothing in it. **A single database serving all
four gets every one of these tradeoffs wrong at once** — which is the entire argument for the split.

**Tenancy cuts across all five stores.** Each tenant holds its own copy of classes 1–3 and of the
operational tables, in its own schema; only class 4 spans tenants, tagged with an opaque tenant id.
That is the same boundary as the perimeter rule above, drawn one level down — and it is why per-tenant
retention, export and erasure are single operations rather than filtered queries.
`docs/mvp-architecture.md` §4.2 is the implementation.

**A fifth store exists and pretending otherwise is how the split leaks.** The operational tables —
patients, clinicians, assignments, interviews, protocols, consent — hold names, dates of birth and
contact details. That is PHI. It is mutable, so it is not the ledger; it is not interview-scoped, so
it is not the record; it is obviously not telemetry. It lives inside the perimeter and is governed
like classes 1–3.

**Tamper-evidence needs both mechanisms, because they fail differently.** Hash-chaining detects
tampering *including by us*; WORM storage prevents it *including by an attacker holding database
credentials*. Either alone leaves a hole the other covers.

**Erasure collides with append-only — resolve it now, deliberately, not during an audit.** Redact the
content, keep the entry and the chain intact, record the erasure as its own entry (EV-7). Class 3
being a *projection* of class 2 is what makes post-redaction rebuild possible at all; it is the
reason that inversion is a requirement rather than a preference.

---

## 10. Compliance posture

| Question | Position |
|---|---|
| Regulatory class | Not a medical device: collects and structures for clinician review; the boundary is architectural (§1.2). Confirm per jurisdiction; O-7 is where it could be crossed. |
| Lawful basis (UK) | Art. 6 + Art. 9(2)(h) health/social care, plus the separate common-law duty of confidentiality. DPO to confirm. |
| DPIA | **Required** in both scale profiles — special-category data, automated processing, vulnerable subjects. Must cover the escalation path specifically. |
| Clinical safety (England) | DCB0129 (manufacturer) and DCB0160 (deploying org) are mandatory. Named Clinical Safety Officer and a Hazard Log — **start at design time, not before go-live.** |
| Is voice recorded? | **Yes, and it is the most consequential IG item here.** Justified by safety-incident review, accuracy measurement and clinical dispute (EV-8). Consent is a hard gate, not a formality. |
| Which third parties see PHI? | Declared per profile (§12) and enumerable from configuration (PRV-1). |
| Audit | Append-only, hash-chained, WORM — transcript, scan results **including passes**, tool calls, transitions, summary, plus all staff access. |
| Access control | Role **and** care relationship; break-glass time-boxed, notified and reviewed. |
| Data subject rights | Access, rectification, erasure across all classes via redact-with-tombstone (EV-7). |
| Certification | An ISMS certifies process, not a codebase, and **discharges neither GDPR nor NHS IG obligations.** Roughly 70% of that work sits outside the repository. |

---

## 11. Performance budget

Measured from the **acoustic end of speech** (PERF-1). All figures are end of patient speech → first
assistant audio.

| Path | Endpointing hangover | p50 target | p95 target |
|---|---|---|---|
| Verification — dates, digits, yes/no | 350 ms | ~870 ms | 1.2 s |
| **Red-flag escalation** | 350 ms | **~400 ms** | 500 ms |
| Intake — open symptom description | **700 ms** | ~1.3 s | 2.2 s |

**The escalation path is the fastest because it is pre-rendered** — fixed text, synthesized at build
time, no model and no vendor in the loop. The safety-critical path is also the cheapest and most
reliable. That is not a coincidence; it is the design.

**Where the budget actually goes:** the tool-call round trip is the single largest term — larger than
any individual hop, on the order of an extra ~825 ms against a direct spoken turn. Keeping record
updates off the critical path and handling verification deterministically buys more than any model
swap. Three pipeline configurations measured within a few hundred milliseconds of each other, which
is precisely why **latency is not the deciding argument between them** — data ownership, the safety
gate and processor minimisation are.

**Class 4 metrics to emit from day one:** per-hop latency, tool-call failure rate, escalation rate
**by protocol version**, false barge-in rate, lockout rate, delivery failure rate, queue depth,
**time-to-acknowledge**, time-to-review.

**Escalation rate is a safety metric, not an engineering one.** A drop in it is either a healthier
patient population or a broken scanner, and telemetry alone cannot tell you which — which is one of
the reasons classes 1 and 2 exist. **Time-to-acknowledge is the most important new number**: it needs
no content at all, and it is what says whether the safety path works in practice rather than on
paper.

---

## 12. Deployment profiles

| | Portfolio | UK NHS | US HIPAA |
|---|---|---|---|
| Purpose | public demonstration | sovereign, at scale | hyperscaler, at scale |
| PHI | none — synthetic only | real | real |
| Media server | hosted | **self-hosted** | **self-hosted** |
| STT / TTS | hosted, single vendor | self-hosted | self-hosted |
| LLM | hosted, single vendor | self-hosted on GPUs | **managed, under BAA** |
| PRV-2 position | audio leaves (nothing at stake) | **nothing leaves** | transcript only leaves |
| Governing instrument | none | sovereignty + IG | contract (BAA) |
| Cost shape | ~€5/month | GPU-dominated | hosted inference + storage |

Three notes that decide more than they look:

**The media server terminates encryption, so a hosted one is a processor that sees patient audio.**
Self-hosting it is what buys the "transcript only" position in the US profile and the "nothing
leaves" position in the UK one. This is decided per profile, never globally.

**The US profile should not self-host the LLM.** The UK profile does so because it has no lawful
alternative; doing it in the US means buying and operating GPUs to avoid a contract that is available
for free, with no compliance return.

**The portfolio profile deliberately proves nothing about scale, GPUs, compliance or real-patient
accuracy.** Stating that on the page is stronger than letting a reviewer assume it was missed.

---

## 13. Verification strategy

**A safety requirement that can only be verified by placing a phone call is a safety requirement that
will be verified rarely.** The engine contract (§5.2) exists partly to make the table below possible.

| Layer | What it verifies | Runs |
|---|---|---|
| **Structural tests over declarations** | escalation reachable from every state but the sink; no tool permitted from any closed state; every field key has a label and a schema description | every commit, no I/O |
| **Fixture tests — red flags** | every entry in the catalog has a sample utterance that escalates | every commit |
| **Fixture tests — tool correctness** | the current LLM does not fabricate arguments; does not call tools on *"Yes, that's fine."* | **every model or prompt change (OPS-2)** |
| **Scripted scenario suite** | full synthetic patient journeys, including red-flag, lockout, reschedule and abandonment paths, through the scripted engine | every commit |
| **Gate ordering test** | LLM invocation count is **zero** on a flagged utterance (CS-2) | every commit |
| **Speculation safety test** | a discarded speculative turn causes no tool call, no attempt burn, no audio (PERF-3) | **before any latency measurement** |
| **PHI canary test** | a planted canary never appears in telemetry, logs or error payloads (EV-6) | every commit |
| **Ledger integrity test** | direct storage mutation is detected; erasure preserves chain validity | nightly |
| **Projection rebuild test** | record rebuilt from ledger replay is identical (EV-4) | nightly |
| **Resumption test** | process killed mid-interview; interview continues intact (IV-4) | nightly |
| **Latency benchmark** | per-hop and end-to-end, per configuration, from acoustic end | on pipeline change |
| **Load test** | concurrency, queue depth, escalation delivery under load | before each scale deployment |
| **Accuracy measurement** | recognition against **real recorded audio**, not synthetic fixtures | continuous once class 1 exists |

**The last row closes a gap that cannot be closed any other way.** Synthetic fixtures have no accent,
no room tone and no false starts; every model transcribes them correctly, so they cannot rank
accuracy and must not be read as doing so. Recording real audio (EV-8) converts "collect
patient-like recordings" from a project into a query.

---

## 14. Risk register

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| **K-1** | A red flag is spoken and no human ever acknowledges it | Patient harm; the failure the system exists to prevent | Double detection (CS-1), gate as control flow (CS-2), separate escalation entity with rota routing and timeout (§7.3), time-to-acknowledge monitored |
| **K-2** | A model swap silently degrades tool correctness and locks patients out | Intakes ending by mechanism, not clinical reason | Fixture suite gates every model change (OPS-2); attempt counter server-side (SEC-3) |
| **K-3** | Speculative execution causes a real side effect | Same harm as K-2, harder to see | PERF-3 test written before any latency work; speculation disabled in verification |
| **K-4** | PHI leaks into telemetry through an exception payload | Compliance breach, unlogged | Closed-field logger signature, serializer redaction, canary test (EV-6) |
| **K-5** | The ledger and the record disagree | Every "why did it do that?" becomes unanswerable — S-5 fails | Record is a projection, rebuilt and compared nightly (EV-4) |
| **K-6** | Erasure request arrives against an append-only chain with no procedure | Regulatory exposure discovered under time pressure | Redact-with-tombstone designed in, tested nightly (EV-7) |
| **K-7** | Care assignments accumulate and become de-facto org-wide access | Access control exists on paper only | Covering assignments expire by default; access reviewed; all reads logged |
| **K-8** | Latency budget missed, patients abandon mid-interview | S-2 and S-6 both fail | Per-state budgets, pre-rendered escalation, speculation for speed, tool calls off the critical path |
| **K-9** | Recognition accuracy on real accents and noise is materially worse than fixtures suggest | Wrong record content, possibly missed red flags | Real-audio measurement from first production call; scanner operates on text, so accuracy is a safety input |
| **K-10** | A hosted media server is assumed to be neutral infrastructure | Undeclared processor of patient audio | Declared per profile; self-hosted in both PHI profiles |
| **K-11** | Clinical safety documentation (Hazard Log, CSO) started near go-live | Deployment blocked late, or shipped without it | Started at design time — it is an input to §3, not an output |

**K-1 is the only one whose realisation is unrecoverable.** Everything in §7.3 is proportionate to
that.

---

## 15. Build plan

Module-ordered. **Each phase ends with something demonstrable, and no phase requires the next to be
useful.**

| Phase | Delivers | Modules | Exit criterion |
|---|---|---|---|
| **P0 · Declarations** | protocol registry, state machines, field catalog, red-flag catalog, permission tables — as data, with structural tests | M3 | Structural + fixture suites green in CI, with no runtime |
| **P1 · Evidence spine** | the four stores, hash chain, WORM, projection rebuild, PHI-free logger | M7, M11 | Ledger integrity, rebuild and canary tests green |
| **P2 · Engine, scripted only** | contract, gate, tool authorization, in-call machine — driven by fixtures, no audio | M5 (scripted) | CS-2 zero-invocation and the full scenario suite green |
| **P3 · Engine, voice** | transport, pipeline, per-hop seam, barge-in, recording, resumption | M5 (cascaded, text) | Latency budget met per state; speculation safety test green |
| **P4 · Identity spine** | auth, roles, authorization seam, patients, care assignments, staff ledger | M1, M2 | Search-and-claim works; every read logged |
| **P5 · Orchestration** | interview lifecycle, deployment, tokens, windows, delivery, outcome mapping | M4, M10 | An interview can be deployed, taken and land in the right bucket |
| **P6 · Safety workflow** | escalation entity, rota routing, acknowledgement clock, alerting | M6 | K-1 mitigations demonstrable end-to-end |
| **P7 · Review** | composer, amendments, disposition, signature, supersession | M8 | A signed review verifies against its pinned hashes |
| **P8 · Surfaces** | three dashboards as query shapes over the above | M9 | Success criteria S-1…S-6 measurable |

**P0 and P1 before anything that talks.** Both are cheap, both are impossible to retrofit, and both
are where every one of the eleven control findings in the source assessment originated. **P6 is the
phase it is tempting to defer and the one that must not be** — it is a safety control wearing
workflow clothes.

---

## 16. Open decisions

| # | Decision | Owner | Blocks |
|---|---|---|---|
| ~~**O-1**~~ | ~~Single-tenant or organisation-scoped from the start~~ — **decided 2026-08-18: multi-tenant, one Postgres schema per tenant in a single database.** See `docs/mvp-architecture.md` §4.2 | project | — |
| **O-2** | Does the patient ever see their own report? Changes consent wording and retention | project + clinical | P7 |
| **O-3** | Rota model for escalation routing — real rota or a fixed duty inbox for v1 | project + clinical | P6 |
| **O-4** | Store choice for classes 2 and 3 — one database with an append-only table, or genuinely separate stores | engineering | P1 |
| **O-5** | Does a reschedule request auto-deploy a replacement interview, or only notify? | clinical | P5 |
| **O-6** | Break-glass: any clinician, or admin-approved? The second is safer and reliably worked around | project | P4 |
| **O-7** | May a review disposition *act* (book, triage by rule), or only record intent? | project + regulatory | P7 — **and §1.2** |
| **O-8** | Retention per class; whether an `invalid` disposition shortens it | project + legal | P1 |
| **O-9** | Which deployment profile is built first — decides GPU questions and every sizing figure | project | P3 |
| **O-10** | Recognition model size at scale — closed on modest hardware, reopens on datacentre GPUs | engineering | P3, revisit at P9 |
| **O-11** | Named Clinical Safety Officer and Hazard Log ownership | project | any real-patient deployment |

**O-7 is the regulatory one, and it is worth restating why.** *"Collects and structures information
for a clinician to review"* is the position that keeps this out of medical-device territory. A
disposition that records a clinician's decision is safely inside it. A disposition that acts — books,
triages, prioritises by rule — is a different product with a different approval path, and that
boundary should be crossed deliberately or not at all.

---

## 17. Evidence sources

Every decision above that cites a number traces to one of these.

| Claim | Source |
|---|---|
| Speech-to-speech: model speaks ~49 ms before transcript exists; 11/20 turns | latency benchmark, realtime transport |
| Transport latency: ~1.3 s p50 speech-to-speech vs ~1.6–1.9 s cascaded | pipeline benchmark, three configurations |
| Cost: ~$0.10+/call-minute speech-to-speech vs ~$0.003 cascaded | provider pricing at benchmark date |
| Tool-argument fabrication and spurious tool calls in smaller models | verification fixture runs |
| Recognition: 149–232 ms small model vs ~1.7 s largest, on GPU-accelerated consumer hardware | recognition benchmark, four fixtures, best of three |
| Recognition cost is per-model not per-utterance (fixed 30 s window padding) | same |
| Tool round trip ≈ +825 ms over a direct spoken turn | latency benchmark, tool-call turns |
| Speculation saves ~550 ms; speculative audio costs ~200 ms of ordering guarantee | framework defaults + benchmark estimate |
| Pre-rendered escalation ~400 ms | derived: no model, no synthesis, playback only |
| Audio ~240 KB/min/track in the transport's native codec | codec bitrate at standard settings |
| Local measurements are GPU-accelerated, ~4× faster than CPU | correction recorded in the architecture document |
| Eleven control findings — 2 critical, 6 high, 2 medium, 1 low | control-gap assessment against ISO/IEC 27001:2022 |

**All latency figures are measured from the acoustic end of speech.** Vendor claims are quoted from
endpoint-declared and are not comparable with anything in this document.
