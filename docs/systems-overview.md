# The three systems — what each one is, how it is built, and where the difficulty sits

**Document type:** orientation
**Status:** current
**Version:** 1.0 · 2026-08-20
**Design of record:** `pdr-clinical-intake-platform.md` · **Build spec:** `mvp-architecture.md`
**Screens:** `ux-clinical-dashboard.html` · `ux-patient-portal.html` · `ux-agent-studio.html` · `ux-agent-evals.html`

Three systems, four screens, one backend. They are not three products that happen to share a
palette — they are three views onto the same artefact: a **protocol version** is authored in system
three, deployed by system one, answered in system two, and read back in system one. The same version
id is on all four screens.

```
   ┌── agent studio ───────┐   publishes    ┌── clinician portal ──┐   sends     ┌── patient portal ─┐
   │ six blocks → one      │ ─────────────> │ deploy · review ·    │ ──────────> │ one call, one     │
   │ frozen ProtocolVersion│                │ sign · escalations   │ <────────── │ notes card        │
   └───────────┬───────────┘                └──────────────────────┘  interview  └───────────────────┘
               │ compiles                              ▲
   ┌───────────▼───────────┐                           │ every interview pins a version
   │ evals + benchmarks    │ ── blocks publish ────────┘
   └───────────────────────┘
```

**The shared spine** (`mvp-architecture.md` §1) carries all three: Postgres 16 with **one schema per
tenant**, a single authorization seam every clinical route passes through
(`requireSession → resolveTenant → requireRole → requirePatientAccess`), an **append-only ledger**
that is the only writer of clinical evidence, and an **engine seam** the backend talks to through a
brief-in/events-out contract. Those four boundaries are load-bearing; everything else is plumbing.

---

## 1 · Clinician portal — the workflow system

**What it is.** Five views onto one patient record: the dashboard queue, patient list, patient
profile, interview detail with the review composer, and the deployment composer. A clinician opens
one screen, sees what is owed, reads the evidence, and signs.

**Architecture.** Ordinary CRUD over an unusually opinionated data model. React Router v7 with two
route trees, TanStack Query for the polling queues, Express handlers that stay thin — parse,
authorize, call a repo, serialize. Two invariants are enforced by *partial unique indexes* rather
than application code: one responsible clinician per patient, one open interview at a time. The
review composer writes a `Review` that can never be edited, only superseded by an addendum.

**Where the complexity is: authorization and lifecycle, not the screens.** Role is not the whole
access decision — a clinician role grants the *capability* to read a record, a `CareAssignment`
grants the right to this one. Layered on top is an `Escalation` with its own lifecycle
(raised → notified → acknowledged → closed) that must be closeable by a human **even if the
interview is never reviewed**, plus a rota with a timeout. The lifecycle joint — conversation
outcome → interview state → dashboard bucket → who gets notified — is one function evaluated once on
ingest, and getting it wrong in three views is the classic failure this design is written against.
This is the **broadest** of the three systems: the most tables, the most permission surface, the most
routes.

---

## 2 · Patient portal — the real-time system

**What it is.** One screen. A header naming the clinician, a thread, a call bar, and a notes card
that fills in as the patient talks. No navigation, no counter, no submit.

**Architecture.** Public and tokenised — `/i/:token`, no session cookie, a different auth posture
from the entire rest of the product. The browser connects over **WebRTC to a self-hosted LiveKit
SFU**; a long-lived Node agent receives decoded frames and runs a **cascaded** pipeline: STT →
red-flag gate → LLM → TTS. Cascaded rather than speech-to-speech is the central decision
(`voice-architecture.md` §B): it makes the conversation *at rest between turns*, so the message array
is ours, durability and resume become properties of the shape rather than features, and — the safety
argument — the red-flag scan becomes a **gate ahead of generation** instead of a check racing a reply
already in flight.

**Where the complexity is: everything under the screen.** The UI is the simplest in the product; the
runtime is the hardest thing in it. A ~1.6 s first-response budget across four hops measured from
acoustic end. A **700 ms endpointing hangover** that is a clinical setting, not a latency target —
generic 400 ms voice-agent guidance clips the clause the red flag lives in. Barge-in and echo
cancellation, which WebRTC gave away for free in the speech-to-speech design and must now be built.
Recording written from the agent, because it already holds the frames. **Narrow but deep** — and it
is the only system where being wrong is a clinical harm rather than an inconvenience.

---

## 3 · Agent studio + evals runner — the authoring system

**What it is.** Two screens. The studio authors an intake agent as **six blocks** — interview script,
safety break, urgent escalation, soft review escalation, tools, report guidance — and compiles them
into one immutable `ProtocolVersion`. The evals runner executes the suite those blocks generated and
either lets the version publish or does not.

**Architecture.** The studio is, structurally, a **compiler with a UI**, and it needs less new backend
than it looks like. `ProtocolVersion` already exists in the entity model
(`fieldCatalog · redFlagSet · toolStates · promptBlocks · modelConfig`), and today those declarations
already live in source as `shared/src/intakeFields.ts`, `shared/src/redFlags.ts`,
`shared/src/machine.ts` and `backend/src/policy/blocks.ts`. The studio moves them into rows and adds
versioning; the generators that already turn the red-flag catalog into prompt text and scanner
patterns are the same generators the compile column reports on.

The evals runner is a **job runner over the seam phase 2 already builds**: `VOICE_ENGINE=scripted`
exists so the patient journey is testable with no microphone and no vendor spend, which is exactly
what a scenario case needs. Benchmarks reuse `backend/src/bench/` (latency, stats, TTS) unchanged.
New parts are a queue, run records with artefacts, and a rubric judge for the two report fields that
are about writing rather than arithmetic.

**Where the complexity is: immutability and derivation.** Two properties carry it. **Freezing** —
a published version can never be edited, because a report saying *"severity 7"* is meaningless unless
you can recover the question that was asked and the red-flag set armed at the time; editing means
forking. **Derivation** — every case must fall out of a declaration, never be hand-written beside it,
which is the trick `shared/src/redFlags.ts` already plays by typing patterns as
`Record<RedFlagId, …>` so a new flag without patterns is a *compile error*. The studio generalises
that: a flag without a sample utterance cannot publish. **Mid-breadth, high-leverage** — it is the
only system whose failure mode is silent, because nothing breaks when a suite is thin.

---

## Side by side

| | Clinician portal | Patient portal | Studio + evals |
|---|---|---|---|
| **Surfaces** | 5 views | 1 view | 2 views |
| **Who uses it** | Clinicians, admins, auditors | Patients, unauthenticated | Clinical safety leads, engineers |
| **Auth posture** | Session cookie + role + care assignment | Token only, no cookie | Session cookie + role |
| **Shape of the work** | CRUD over a strict model | Real-time media pipeline | Compiler + test harness |
| **Hard part** | Authorization seam, escalation lifecycle | Latency, barge-in, gate ordering | Immutable versions, derived cases |
| **Fails by** | Leaking access or losing an escalation | Missing a red flag, or clipping the clause it was in | Shipping a version nobody proved |
| **New infrastructure** | None beyond the spine | SFU, STT, TTS, GPU | Job queue, artefact storage |
| **Complexity shape** | Broad | Deep | Tall |
| **Rough build, spine in place** | 6–8 weeks | 2 weeks of UI over 6–10 weeks of pipeline | 4–5 weeks studio, 3–4 weeks runner |

Estimates are for one experienced engineer and assume phase 1 (the spine) is done; they are
order-of-magnitude, not a plan.

---

## What exists today

About 6,300 lines across `backend/`, `frontend/` and `shared/`: a single-tenant prototype where the
browser talks **directly to OpenAI's Realtime API**, with the red-flag scan *racing* generation
rather than gating it. Real and working today: the red-flag catalog and its generators, the
deterministic scanner and its tests, the conversation machine, tool gating tests, and the latency
bench harness — which is to say, several of the pieces the studio and the runner are designed to sit
on top of.

Not yet built: Postgres, tenancy, auth, the ledger, every clinician view, the cascaded pipeline, and
both agent-studio screens. The four UX documents are design of record for those, not descriptions of
running software.
