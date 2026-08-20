# ADR 0002 — One protocol: pre-operative assessment, inside a covered window

- **Status:** Accepted
- **Date:** 2026-08-19
- **Deciders:** Adam Mrotek
- **Affects:** product scope, `docs/clinical-voice-assistant-requirements.md`, `docs/pdr-clinical-intake-platform.md` §1.2/§2, `docs/ux-clinical-dashboard.html`, the protocol registry (M3)

## Context

The product has been carrying an unresolved contradiction since the beginning.

`clinical-voice-assistant-requirements.md` calls it an **"Intake/Triage Assistant"** conducting a
"pre-visit intake/**triage** conversation". The PDR says the opposite, and says it is architectural:

> It collects and structures information for a clinician to review. It does not advise, triage, or
> diagnose. — `pdr-clinical-intake-platform.md` §1.2

Both statements have been true of the design at the same time, because nothing ever pinned down
**what the agent is allowed to ask about**. The demonstration protocol — "Headache intake" — quietly
resolved the ambiguity in the wrong direction: a patient describing a headache to an agent, at 04:12,
with an on-call clinician on a clock. That is undifferentiated symptom triage. It is the highest-risk
possible framing of the product, the hardest to get regulatory comfort on, and the easiest for a
sceptical clinician to reject in the first ten seconds.

Two questions had to be answered before anything else could be:

1. **Is an on-call clinician the right answer for someone who should be dialling 999?**
2. **What kind of interview should the agent conduct at all?**

## Decision

### 1. One protocol: pre-operative assessment

The product covers **pre-operative assessment** and nothing else in v1. Not symptom intake, not
triage, not post-operative recovery checks, not undifferentiated "how are you feeling".

This is chosen on a specific test, which now governs all protocol content:

> **Every question must ask the patient to report a fact they already know about themselves — never
> to supply something a clinician would have to form an impression about.**

| Asks for a fact | Asks for an impression |
|---|---|
| What medications are you taking, and at what dose? | Is your wound infected? |
| Have you reacted badly to an anaesthetic before? | Does this pain seem normal for this stage? |
| Can you climb a flight of stairs without stopping? | Tell me about your headache… |

Pre-operative assessment sits almost entirely in the left column. Post-operative follow-up — the
obvious alternative — does not: the moment the agent's next question depends on a judgement about the
last answer, the agent is doing clinical reasoning, and the non-diagnostic boundary is gone in
substance even if the prompt still denies it.

Secondary reasons, in order of weight:

- **The job already exists.** A pre-assessment nurse does this by phone or on paper for every
  surgical patient. We are replacing a known workflow, not inventing one.
- **Someone else authored the questions.** The content is standardised — medications, allergies,
  anaesthetic history, functional capacity, implants, fasting. We are not writing medicine.
- **There is a hard date.** The operation anchors deployment, window, reminders and expiry, which
  makes existing scheduling machinery obviously necessary rather than speculative.
- **The prevented failure is legible and expensive**: an operation cancelled on the morning of
  surgery because nobody knew about the clopidogrel.
- **Escalation becomes genuinely rare.** A pre-op patient volunteering chest pain is unprompted and
  exceptional — which is the correct shape for a safety net.

### 2. Interviews run only inside a covered window

A deployment carries hours during which a named clinician or duty rota is reachable. **A patient
cannot start an interview outside that window.**

This is the direct answer to question 1. The previous design contemplated an escalation raised at
02:00 against a sleeping clinician, backed by a rota with timeout-and-next-target (PDR §7.3). That
machinery remains as a backstop, but it stops being the primary case: escalations now land on a
person who is present.

The cost is honest and must be stated in any patient-facing copy: **"in their own time" becomes "in
their own time, inside hours your practice covers."**

### 3. Escalation is an assurance loop, not the emergency response

Nothing changes in the mechanism, which was always correct: deterministic scan → stop the interview →
pre-rendered "call 999" audio in ~400 ms with no model in the path (PDR PERF-2, CS-2).

What changes is what we claim it is for. **The patient is never waiting for the clinician.** By the
time an escalation exists, the patient has already been told by a machine, in under half a second, to
call an ambulance. The clinician acknowledgement is a named human confirming that instruction was
issued and deciding whether anything further is owed — ring the patient, alert the ward, flag the
record. It is assurance, not response.

Escalations split into two kinds, which must never be visually confusable:

| | Trigger | Behaviour |
|---|---|---|
| **Immediate danger** — rare | Deterministic scan matches a red-flag phrase | Interview stops. Patient told to call 999. Named human acknowledges against a clock. |
| **Clinician attention needed** — routine | Abandoned mid-answer, lockout, an answer contradicting the record | Goes to the top of the review queue. No clock — an interview is never late; only an acknowledgement is. |

### 4. The boundary is stated out loud

The following are published product claims, not internal notes:

- **We don't triage.** No ranking, no priority category, no urgency score.
- **We don't diagnose or advise.** Output goes to a clinician; nothing clinical reaches the patient.
- **We don't ask anything requiring judgement.** The field catalog is fixed and versioned; the agent
  cannot invent a question.
- **We are not a front door for feeling unwell.** The interview runs against a scheduled operation,
  inside covered hours.
- **Nothing is prioritised, booked or acted on without a named human signing it.**

## Consequences

**What this simplifies**

- The regulatory position stops depending on prompt wording and starts depending on the protocol
  content, which is versioned and reviewable.
- The safety story shortens to one sentence a clinician can check: the agent asks for facts, and
  stops if it hears something it was not asking about.
- 24/7 duty-rota staffing is no longer a precondition for a customer to adopt the product.

**What this invalidates and must be revisited**

- `clinical-voice-assistant-requirements.md` — the title and scope line still say "triage". Stale and
  now actively wrong.
- The PDR needs a protocol-scope statement; §2.1/§2.2 name features in and out of scope but say
  nothing about permitted clinical content.
- "Headache intake" as the demonstration protocol, everywhere it appears — docs, the pitch site, and
  the frontend fixtures.
- Success criterion S-1 ("median time-to-acknowledge < 10 min **in hours**") can drop its
  qualification, since there are no longer out-of-hours escalations by design.
- Open decision O-7 (may a disposition *act*?) is unchanged but easier to hold shut: pre-op
  assessment has no natural pressure toward booking or triaging.

**What we give up**

- Asynchronous "any time, any hour" answering, which was a real patient-facing benefit.
- The larger cohorts — medication reconciliation, chronic-condition monitoring, pre-visit checks —
  all of which remain plausible later, and all of which pass the fact/impression test. They are
  deferred for focus, not rejected on principle.

## Open questions

| # | Question |
|---|---|
| PS-1 | Does the covered window belong to the protocol, the deployment, or the organisation? |
| PS-2 | What happens when a patient tries to start outside the window — refuse with a reason, or offer the next opening? |
| PS-3 | Does the surgery date drive expiry automatically, or is the window set independently of it? |
| PS-4 | Who authors and signs off the field catalog for a customer — us, the trust, or the pre-assessment lead? |

 Plan written. Three points where I made a judgement call worth flagging, all argued in the plan:

  1. Cauda equina is not in v1. It's the strongest citable red flag in your research, but this cohort is peri-operative joint
     patients, not undifferentiated back pain. It arms only if a spinal protocol is added. Letting the scanner accrete flags
     for cohorts the product doesn't serve is how it becomes noisy.
  2. Your three-rung ladder folds into ADR 0002's two kinds. Terminate-999 and notify-now are both the clocked kind at
     different urgencies; route-to-queue is the attention-needed kind. The UX brief permits exactly three visual intensities
     and tier 1 is reserved for one thing — a third treatment would break it.
  3. The middle rung is the actual product. Headache intake had nothing clinically interesting between "emergency" and
     "noise." Pre-op does: still on clopidogrel, fever in the window, fasting misunderstood. Deterministic, detectable from a
     fact answer, and directly tied to the lost-theatre-revenue argument. That's the strongest reason the vertical choice
     works.

─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 Ready to code?

 Here is Claude's plan:
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Narrow the product to one vertical: private orthopaedic pre-operative assessment

 Context

 The problem. The repo carries ~6,400 lines of design documents describing a general
 "clinical intake platform" and ~1,000 lines of working prototype that is a headache triage
 demo. The gap is not implementation debt — it is that nobody has said what the product is for.
 docs/adr/0002-product-scope-pre-operative-assessment.md (Accepted, 2026-08-19, still
 untracked) took the first real step by naming one protocol and one governing test, but it named
 no buyer, no cohort, and no roadmap — so "pre-operative assessment" is still an unbounded surface
 and the code is still headache intake.

 Why this matters now. The stated next step is an eval harness. An eval harness is a
 specification of what must not go wrong; it cannot be written before the product decides what it
 is trying to do and for whom. Every prior attempt to specify verification (PDR §13 lists 14
 layers; mvp-architecture.md §5.3 names a scripted engine) has stalled because the failures being
 guarded against are hypothetical.

 The decision taken. Buyer is a private orthopaedic hospital group — multi-site,
 private-pay, elective joint surgery. Patient is a working-age adult on an elective orthopaedic
 list (knee, hip, ACL, shoulder). v1 protocol is pre-operative assessment, which keeps
 ADR 0002's test intact; PROM instruments (KOOS / OKS / ODI / QuickDASH) enter as v2–v3 because
 they are published, free, already routine, and pass the same test; post-operative check-ins are
 deferred to v4 as an explicit, documented boundary crossing rather than a feature.

 MVP bar. One protocol end-to-end and demoable: deploy → patient takes the call → structured
 record → clinician reviews and signs → escalation acknowledged. Single tenant, seeded patients.

 Scope of this round: documents only. No code changes. The output is the product definition
 that the eval harness and the protocol re-pointing will both be written against.

 ---

 Deliverables

 Three files in docs/. Deliberately three and not six — the complaint being answered is that the
 doc set is too broad, so this adds the minimum needed and declares what it makes stale.

 1. docs/adr/0003-vertical-private-orthopaedic.md

 An ADR, following the shape of 0001 and 0002 (Status / Date / Deciders / Affects / Context /
 Decision / Consequences / Open questions).

 It extends ADR 0002, it does not supersede it. 0002's decision (pre-operative assessment) and
 its governing test survive verbatim and are quoted, not restated:

 ▎ Every question must ask the patient to report a fact they already know about themselves — never
 ▎ to supply something a clinician would have to form an impression about.

 This mirrors the repo's own principle for Review (product-overview.md §4.10): never edit,
 supersede or add. Content:

 - Decision 1 — the buyer and the cohort. Private orthopaedic group; elective joint surgery;
   working-age adult. Reasons in order of weight: the pre-assessment job already exists and is done
   by phone today; the question content is authored by someone other than us; the surgery date
   anchors window, reminders and expiry (answering ADR 0002's open question PS-3); a cancelled list
   is directly lost revenue to a private hospital rather than a waiting-list statistic, so the
   buyer can decide without a trust procurement cycle; and the cohort removes capacity,
   safeguarding and cognitive-impairment modelling entirely.
 - Decision 2 — a second test, for the roadmap. ADR 0002's test governs questions. A second
   test governs versions: a protocol version crosses a boundary the moment the agent's next
   question depends on a judgement about the last answer. v1–v3 never do. v4 does, and must be
   approved as such.
 - Decision 3 — autonomy classes, named to avoid the existing collision. tier already means
   three unrelated things in this repo (ux-clinical-dashboard.md §3 UI hierarchy;
   deployment-uk-nhs.md §2 compute tiers; frontend/src/styles/README.md text-contrast tiers).
   The autonomy model is therefore called Class A / B / C, and the ADR states the collision
   explicitly so the next person does not reintroduce it.
   - Class A — fixed pre-authored content, ungated (reminders, prep instructions). No generated
     text reaches the patient.
   - Class B — output-gated instrument administration. The model conducts; a named clinician
     signs; nothing clinical reaches the patient. v1–v3 are Class B and the product ships Class B
     only.
   - Class C — input-gated and output-gated: a named clinician configures the protocol for
     this patient before it runs. v4 only.
 - Consequences → what this invalidates. Carry forward ADR 0002's unactioned list and extend it
   with the concrete code and doc sites found in exploration (see Invalidation list below).
 - Open questions — carry PS-1…PS-4 forward, resolving PS-3 (the surgery date drives expiry),
   and add: which instrument per body site and who chooses it; whether PROM follow-up (v3) can run
   outside the covered window given it raises no 999-class flags.

 2. docs/product-scope-mvp.md

 The primary artefact. Status line in the house style: "for review — supersedes the scope section
 of clinical-voice-assistant-requirements.md".

 §1 — The one sentence. What it is, who it is for, what comes out. Ends with the five published
 claims from ADR 0002 §4 quoted intact.

 §2 — The v1 field catalog. The concrete replacement for the 9 headache fields in
 shared/src/intakeFields.ts, every entry annotated with the fact/impression test:

 ┌────────────────────────────────────────────────────────────┬──────────────────────────────────────────────────────────┐
 │                           Field                            │                     Why it is a fact                     │
 ├────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
 │ currentMedications (name + dose)                           │ The patient reads their own boxes                        │
 ├────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
 │ anticoagulants (explicit sub-question)                     │ Named drug, named last dose — the cancellation preventer │
 ├────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
 │ allergies (agent + reaction as reported)                   │ Reported history, not assessment                         │
 ├────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
 │ anaestheticHistory (previous + adverse reaction)           │ Recall of an event                                       │
 ├────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
 │ familyAnaestheticReaction                                  │ Recall of an event                                       │
 ├────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
 │ functionalCapacity ("a flight of stairs without stopping") │ ADR 0002's own worked example                            │
 ├────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
 │ implantsAndDevices (pacemaker, metalwork, prostheses)      │ Known to the patient                                     │
 ├────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
 │ heightWeight                                               │ Self-reported measurement                                │
 ├────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
 │ dentalAirway (loose teeth, crowns, dentures)               │ Self-observed fact                                       │
 ├────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
 │ recentIllness (cold, fever, infection in last 2 weeks)     │ Did it happen — not "is it significant"                  │
 ├────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
 │ smokingAlcohol                                             │ Self-reported quantity                                   │
 ├────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
 │ pregnancyPossible                                          │ Self-known                                               │
 ├────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
 │ fastingUnderstood                                          │ Confirmation of receipt, not judgement                   │
 ├────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
 │ escortAndSupport (discharge planning)                      │ Logistical fact                                          │
 └────────────────────────────────────────────────────────────┴──────────────────────────────────────────────────────────┘

 Explicitly listed as excluded because they fail the test: any "how is your knee", any pain
 interpretation, any "does this seem normal".

 §3 — What the MVP is, and what it is not. The end-to-end loop as the acceptance statement.
 Maps onto product-overview.md §13 build order steps 1–3, 7, 8 (persist → Patient + real
 verification → Interview/Session split → Review + signature → Escalation entity), naming §13
 step 8 as non-deferrable per that document's own warning. Out of scope for the MVP, stated as
 decisions not omissions: multi-tenancy, break-glass, rota routing beyond a fixed duty target,
 audio retention, text fallback, SMS/phone delivery.

 §4 — The roadmap. Four versions, each with an entry condition, so "extend it later" is a
 gate rather than a wish.

 ┌─────────────────┬──────────────────────────────────┬───────┬─────────────────────────────────────────────────────────┐
 │     Version     │             Content              │ Class │                     Entry condition                     │
 ├─────────────────┼──────────────────────────────────┼───────┼─────────────────────────────────────────────────────────┤
 │ v1 Pre-op       │ §2 catalog, inside a covered     │       │                                                         │
 │ assessment      │ window, anchored to the surgery  │ B     │ —                                                       │
 │                 │ date                             │       │                                                         │
 ├─────────────────┼──────────────────────────────────┼───────┼─────────────────────────────────────────────────────────┤
 │ v2 Baseline     │ KOOS / OKS / ODI / QuickDASH by  │ B     │ v1 signed-review loop working end to end; instrument    │
 │ PROM at listing │ body site, same call as v1       │       │ chosen by the clinic, never by the agent                │
 ├─────────────────┼──────────────────────────────────┼───────┼─────────────────────────────────────────────────────────┤
 │ v3 Follow-up    │ Same instrument at 6wk / 3mo /   │       │ Scheduling, expiry and reminder machinery real; and a   │
 │ PROM            │ 12mo                             │ B     │ written rule that a poor score is a data point, not an  │
 │                 │                                  │       │ escalation                                              │
 ├─────────────────┼──────────────────────────────────┼───────┼─────────────────────────────────────────────────────────┤
 │ v4 Post-op      │ Judgement-adjacent content,      │       │ Deliberate approval: fails Decision 2's test, changes   │
 │ recovery        │ configured per patient           │ C     │ the regulatory position, needs an input gate. "A        │
 │ check-in        │                                  │       │ different product with a different approval path."      │
 └─────────────────┴──────────────────────────────────┴───────┴─────────────────────────────────────────────────────────┘

 v3 is called out as the point where the product first runs after surgery while still asking only
 facts — the instrument asks whether the patient can climb stairs, never whether the knee is doing
 well. That distinction is what keeps v3 in Class B and v4 out of it.

 §5 — Value. Three claims, ordered, with the mechanism stated and figures marked as needing
 sourcing rather than invented:

 1. Prevented same-day cancellation. A patient still taking clopidogrel, an unrecognised chest
    infection, a misunderstood fasting instruction. In a private hospital an abandoned list is lost
    theatre revenue on the day, and the loss is attributable to a single missed question.
 2. Pre-assessment nurse time. The call is made today, by a person, for every patient.
 3. PROM completion rate → an outcome-data asset. Private groups need outcome data for
    consultant credentialing and insurer contracts; PROM follow-up compliance is chronically poor
    because it depends on someone chasing. This is the compounding value and the reason v2–v3 exist.

 §6 — Risks, each paired with its control and — the load-bearing column — the observable that
 would demonstrate the control works.

 ┌────────────────────────────────────┬───────────────────────────────────────┬─────────────────────────────────────────┐
 │                Risk                │                Control                │               Observable                │
 ├────────────────────────────────────┼───────────────────────────────────────┼─────────────────────────────────────────┤
 │ K-1 a red flag is spoken and no    │ Escalation entity with its own        │ Time-to-acknowledge distribution; count │
 │ human acknowledges it (PDR: "the   │ lifecycle and clock, closed by a      │  of escalations discharged by a review  │
 │ only one whose realisation is      │ human independently of review         │ rather than an acknowledgement must be  │
 │ unrecoverable")                    │                                       │ 0                                       │
 ├────────────────────────────────────┼───────────────────────────────────────┼─────────────────────────────────────────┤
 │ False negative on a red flag       │ Double detection (CS-1) + gate        │ LLM invocation count on a flagged       │
 │                                    │ ordering (CS-2)                       │ utterance = 0 — not "cancelled", zero   │
 ├────────────────────────────────────┼───────────────────────────────────────┼─────────────────────────────────────────┤
 │                                    │ Fixed, versioned field catalog the    │ Count of asked questions not traceable  │
 │ Question drift into impressions    │ model may write into and cannot       │ to the catalog, per transcript          │
 │                                    │ extend                                │                                         │
 ├────────────────────────────────────┼───────────────────────────────────────┼─────────────────────────────────────────┤
 │ Over-escalation training the eye   │ CS-5 says over-escalation is the safe │ Escalation rate by protocol version;    │
 │ to ignore alerts                   │  direction; UI tier-1 treatment       │ alert-rail occupancy                    │
 │                                    │ reserved for one thing                │                                         │
 ├────────────────────────────────────┼───────────────────────────────────────┼─────────────────────────────────────────┤
 │                                    │ Class B only; disposition records a   │ Audit that no disposition has a side    │
 │ Regulatory reclassification (SaMD) │ clinician's intent and never acts     │ effect                                  │
 │                                    │ (product-overview.md open decision 7) │                                         │
 ├────────────────────────────────────┼───────────────────────────────────────┼─────────────────────────────────────────┤
 │                                    │                                       │ The existing bench/realtime.ts          │
 │ Current transport cannot satisfy   │ The cascade / provider work already   │ measurement (model began speaking 49 ms │
 │ CS-2                               │ on this branch                        │  before the transcript existed, on 11   │
 │                                    │                                       │ of 20 turns)                            │
 ├────────────────────────────────────┼───────────────────────────────────────┼─────────────────────────────────────────┤
 │ Scope creep back to "how are you   │ ADR 0002 test + ADR 0003 Decision 2,  │ Every field annotated in §2             │
 │ feeling"                           │ applied per field at review           │                                         │
 └────────────────────────────────────┴───────────────────────────────────────┴─────────────────────────────────────────┘

 §7 — The handoff. One paragraph: the observables column of §6 is the specification for the
 eval harness, and the next round writes it. Nothing about the harness is designed here.

 3. docs/escalation-spec.md

 Escalation earns its own file because it is the safety control every other document refers to and
 because the current implementation is a banner and nothing more.

 - §1 — What escalation is for. ADR 0002 §3 quoted intact: "The patient is never waiting for
   the clinician… It is assurance, not response."
 - §2 — Two kinds that must never be visually confusable (ADR 0002's table), reconciled with the
   three-rung ladder from the product research. The research's three rungs map cleanly:
   terminate-and-999 and notify-now are both the clocked kind at different urgencies;
   route-to-queue is the attention-needed kind. The spec keeps ADR 0002's two-kind taxonomy
   and adds urgency as an attribute, rather than inventing a third visual treatment — the UX brief
   permits exactly three intensities and tier 1 is reserved for one thing.
 - §3 — The v1 red-flag catalog. The replacement for the 11 headache flags in
   shared/src/redFlags.ts. Small by design: a pre-op patient volunteering these is unprompted and
   exceptional, which is the correct shape for a safety net.
   - Immediate danger (stop, 999): chest pain now; new severe breathlessness at rest; stroke
     symptoms (facial droop / one-sided weakness / slurred speech); collapse or loss of
     consciousness; suicidal ideation; uncontrolled bleeding.
 - §4 — The middle rung, and why this vertical has one worth building. This is the
   pre-op-specific finding and the reason the vertical was chosen. Clinician attention needed, no
   clock: still taking an anticoagulant with no stop plan; fever or infection within the surgical
   window; a new symptom since listing; fasting instruction misunderstood; interview abandoned
   mid-answer; verification locked; an answer contradicting the record. Headache intake had no
   clinically interesting middle rung — everything was either an emergency or noise. Here the middle
   rung is the product: it is detectable from a fact answer, it is deterministic, and it is where
   the money is.
 - §5 — What escalation looks like. Patient side: deterministic scan → interview stops →
   pre-rendered audio in ~400 ms with no model in the path (PDR PERF-2, CS-2). Clinician side: the
   tier-1 clocked rail from ux-clinical-dashboard.md §3, and the Escalation lifecycle
   raised → notified → acknowledged → closed(disposition) from product-overview.md §4.9.
   Restates that escalated is not a lifecycle state.
 - §6 — Which rung each roadmap version arms. v1 arms §3 and §4. Cauda equina screening —
   the strongest citable red flag in the research — is not v1, because this cohort is
   peri-operative joint patients, not undifferentiated back pain; it arms only if a spinal protocol
   is added. DVT and wound-infection signs arm only at v4. Stating this prevents the catalog from
   accreting flags for cohorts the product does not serve, which is how a scanner becomes noisy.
 - §7 — Copy. Emergency copy is 999, not 911. Currently wrong in
   backend/src/policy/blocks.ts (emergencyClosing) and frontend/src/App.tsx.

 ---

 Invalidation list

 Recorded in ADR 0003's Consequences section. Not actioned this round — this is documents only —
 but written down precisely so the next round is execution rather than rediscovery.

 Protocol content (all still headache):
 - shared/src/intakeFields.ts — 9 headache fields → §2 catalog
 - shared/src/redFlags.ts — 11 headache flags → escalation-spec §3
 - backend/src/safety/patterns.ts — typed Record<RedFlagId, …>, so it fails to compile until updated
 - backend/src/policy/instructions.ts:15 — the scripted opening line names headache
 - backend/src/policy/blocks.ts — emergencyClosing says 911
 - backend/src/safety/scan.test.ts — typed Record<RedFlagId, string | null>; replacing the
   catalog is a compile error until every new flag has a sample utterance. This is the one piece
   of eval scaffolding that already exists and it should be preserved exactly as it is.
 - backend/src/bench/fixtures/{03-symptom-short,04-symptom-rambling}.wav and bench/fixtures.ts —
   headache-shaped; fixture 04's endpointing trap depends on a headache red flag in the clause after
   the pause

 Frontend copy: frontend/src/App.tsx (brand string, hero copy, 911 banner),
 frontend/src/ConversationTimeline.tsx (STAGE_META says "Clinical agent / Headache intake"),
 frontend/src/IntakePanel.tsx (n/9).

 Docs: README.md (title and "intake/triage assistant"), docs/clinical-voice-assistant- requirements.md (ADR 0002 already
 called this "stale and now actively wrong"),
 docs/ux-clinical-dashboard.{md,html} fixtures, docs/iso27001-gap-assessment.md §4 (cites
 backend/src/safety.ts and backend/src/index.ts:114, both moved).

 ---

 Deliberately not in this round

 - Any code change, including the protocol re-pointing above.
 - The eval-harness design. §6's observables column is its input; writing it is the next round.
 - Re-litigating the transport decision. The CS-2 finding stands and the cascade work on this branch
   is the response; the scope docs cite it and move on.
 - Editing the PDR or mvp-architecture.md. They are large, dated, and correct about mechanism;
   ADR 0003 changes content, and the repo's own convention is to supersede by addition.

 ---

 Verification

 Documents have no test suite, so verification is adversarial reading against fixed criteria.

 1. Apply the fact/impression test to every field. Read §2's table row by row and confirm each
    left-column justification holds. Any field needing a paragraph to defend is a failed field.
 2. Apply Decision 2's test to every roadmap version. For v1, v2 and v3, confirm no question's
    selection depends on a judgement about a prior answer. Confirm v4 fails it — if v4 passes, the
    boundary has been drawn in the wrong place.
 3. Every observable in §6 must be countable. Read the column and confirm each is a number a
    program could produce from a transcript, a ledger or a benchmark run — not a quality to be
    assessed. Any row that is not countable is a risk without a control.
 4. Consistency sweep against accepted decisions. Confirm no statement contradicts ADR 0001
    (backend owns the state machine), ADR 0002 (protocol and covered window), PDR §1.2
    (non-diagnostic boundary) or PDR §3.1 CS-1…CS-7.
 5. Verify the invalidation list. grep -rin "headache\|911\|triage" README.md docs/ shared/src backend/src frontend/src and
    confirm every hit is either listed above or deliberately excluded.
    The list is the next round's work order; a missing entry is a defect now.
 6. Tier-collision check. grep -rn "tier" docs/ and confirm the new documents use
    Class A/B/C and never tier for autonomy.
