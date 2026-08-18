# Product overview — from one call to a clinical service

**Status:** proposed — entity model and lifecycle for review, no code written against it yet
**Depends on:** `docs/voice-architecture.md` (the call itself, and the four data classes), `docs/adr/0001-backend-owned-state-machine.md` (who owns state)
**Scope:** everything around the call — who the patient is, who the clinician is, how an interview gets deployed, and what comes back for signature.

The prototype is **one anonymous call**: an unnamed browser hits `POST /api/session`, gets a
`randomUUID()`, talks for five minutes and disappears. Identity is two environment variables
(`DEMO_PATIENT_DOB`, `DEMO_PATIENT_PHONE`). The record lives in a `Map`. Nobody reviews anything.

The product is a **panel of patients, a queue of work, and a signed clinical artefact**. Three things
are missing, and only the first is obvious:

1. **Identity on both sides** — a `Patient` the call is *about*, a `Clinician` the call is *for*.
2. **A lifecycle that spans days, not minutes.** The existing state machine covers `verification →
   intake → finalized` — the seven minutes the patient is on the line. An interview is deployed on
   Monday, taken on Wednesday, reviewed on Thursday. That arc has its own states, its own
   transitions, and its own authority, and conflating it with the in-call machine is the mistake this
   document exists to prevent.
3. **A review.** A model-generated summary is not a clinical document. It becomes one when a named
   clinician has read it, amended it and signed it — and that act is the product's actual output.

Everything else here follows from those three.

---

## 1. The three surfaces

| Surface | Whose question it answers | Primary entity |
|---|---|---|
| **Clinician dashboard** | *"What is waiting for me, and who is on my panel?"* | `CareAssignment` + work queues |
| **Patient profile** | *"What do we know about this person, and what is outstanding?"* | `Patient` → `Interview[]` |
| **Deployment dashboard** | *"What have I sent out, what came back, and what needs a human now?"* | `Interview` by lifecycle state |

They are three lenses on the same two tables. The clinician dashboard is *patient-major*, the
deployment dashboard is *interview-major*, and the patient profile is the join of the two for one
person. Building them as three query shapes over one model — rather than three features — is what
keeps them from disagreeing.

There is a fourth surface that is easy to forget because it has no dashboard: **the patient's way
in.** An invite link carrying an opaque token, a consent gate, then the existing call. It is
specified in §7.4 because the deploy action is meaningless without it.

---

## 2. Actors and roles

| Actor | What they do | Notes |
|---|---|---|
| **Patient** | Receives an invite, gives consent, takes the interview | No login. Token in the link + DOB/phone verification *in the call* is the second factor — the existing `verify_identity` tool, pointed at a real `Patient` row instead of env vars. |
| **Clinician** | Claims patients, deploys interviews, reviews and signs reports | The primary user. Everything below is scoped to them. |
| **On-call / duty clinician** | Acknowledges escalations raised outside the assigned clinician's hours | A rota, not a person. §9.3 — this is a safety requirement, not a convenience. |
| **Administrator** | Manages users, rotas, protocol publication, retention policy | Cannot read clinical content without break-glass. |
| **Auditor / IG officer** | Reads the ledger and the access log; reads no clinical content by default | Exists because `iso27001-gap-assessment.md` and both scale deployment profiles require the role to exist. |

**Role is not the whole access decision.** A clinician role grants the *capability* to read patient
data; an active `CareAssignment` grants the *right* to read **this** patient's data. Both are
required. See §9.

---

## 3. The entity map

```
                 ┌──────────────┐                              ┌──────────────┐
                 │  Clinician   │                              │   Patient    │
                 └──────┬───────┘                              └───────┬──────┘
                        │ n                                          n │
                        │        ┌──────────────────────┐              │
                        └───────<│   CareAssignment     │>─────────────┘
                                 │  role, from, until   │      (many-to-many,
                                 │  assignedBy, reason  │       time-bounded,
                                 └──────────────────────┘       audited)
                                                                       │ 1
                                                                       │
   ┌───────────┐      ┌──────────────────┐                             │ n
   │ Protocol  │──1:n─│ ProtocolVersion  │──────────┐          ┌───────▼───────────┐
   └───────────┘      │ fields, redFlags │          │ 1        │    Interview      │
                      │ machine, prompts │          └─────────n│  (the "talk")     │
                      │ immutable once   │                     │  lifecycle state  │
                      │ published        │      deployedBy ───>│  window, channel  │
                      └──────────────────┘      assignedTo ───>│  accessToken      │
                                                (both Clinician)└─────┬────────────┘
                                                                      │ 1
              ┌──────────────┬────────────────┬─────────────┬─────────┴──────┬────────────────┐
              │ n            │ 1              │ n           │ 0..n           │ 0..n           │ 0..n
       ┌──────▼──────┐ ┌─────▼────────┐ ┌─────▼───────┐ ┌───▼─────────┐ ┌────▼──────┐ ┌───────▼──────┐
       │   Session   │ │ IntakeRecord │ │ LedgerEntry │ │ Escalation  │ │  Review   │ │   Consent    │
       │ one connect │ │  class 3     │ │  class 2    │ │ ack lifecycle│ │ ≤1 signed │ │ recording,   │
       │ attempt;    │ │  projection  │ │ hash-chained│ │ own queue    │ │ addendum  │ │ processing   │
       │ holds the   │ │  of ledger   │ │ append-only │ └─────────────┘ │ never edit│ └──────────────┘
       │ in-call FSM │ └──────────────┘ └─────────────┘                 └───────────┘
       └──────┬──────┘
              │ n                                    ┌──────────────────────────────┐
       ┌──────▼───────┐                              │  TelemetryEvent (class 4)    │
       │ AudioArtifact│                              │  no foreign keys at all —    │
       │  class 1     │                              │  sessionId string, nothing   │
       │ per track    │                              │  else. Separate store.       │
       └──────────────┘                              └──────────────────────────────┘
```

Three cardinalities carry most of the weight, and each is a decision rather than an observation:

**`Patient` ↔ `Clinician` is many-to-many through `CareAssignment`** — as asked. A patient has a
responsible clinician and any number of covering ones; a clinician has a panel. Modelling it as a
row rather than a foreign key is what makes *"pull a patient in and assign them to myself"* an
auditable event with a timestamp, an actor and a reason, instead of a mutated column.

**`Interview` → `Patient` is many-to-one** — as asked. An interview is always about exactly one
patient and never migrates.

**`Session` → `Interview` is many-to-one, and this is the correction to the prototype.** Today
`sessionId` *is* the call and *is* the record. In the product, an `Interview` is the unit that gets
deployed, reviewed and reported on; a `Session` is one connection attempt against it. A patient who
loses signal at 4m12s and rejoins produces two sessions and **one** interview, one record, one
ledger. R-1's own test — *"can a call be resumed after a process restart?"* — is unanswerable while
the record is session-scoped, because there is nothing for the second session to resume *into*.

---

## 4. The entities

### 4.1 Patient

`id · mrn/nhsNumber · givenName · familyName · dateOfBirth · phone · email · preferredChannel ·
language · accessibilityNeeds · status · createdAt`

The identity fields are load-bearing, not decorative: `dateOfBirth` and the last three digits of
`phone` are exactly what `verify_identity` checks. Pointing that tool at this row instead of
`process.env.DEMO_PATIENT_DOB` is the single smallest change that turns the prototype into a system,
and it should be done first (§13).

`accessibilityNeeds` and `language` drive the text-fallback path the requirements already demand.
They are on the patient, not the interview, because they are a property of the person.

### 4.2 Clinician

`id · displayName · registrationNumber (GMC/NPI) · role · organisationId · onCallRotaIds · status`

`registrationNumber` exists because a signed review must name a registrant, not a username.

### 4.3 CareAssignment — the access edge

`id · patientId · clinicianId · relationship (responsible | covering | observer) · assignedBy ·
assignedAt · endsAt? · endedAt? · reason · source (self_claim | delegated | rota | referral)`

- **At most one active `responsible` assignment per patient.** Claiming responsibility while another
  clinician holds it is a *transfer*, which ends their row and opens yours — two ledger entries, not
  a silent overwrite.
- **`covering` assignments should expire by default.** A weekend cover that never lapses is how
  panels silently become org-wide read access, which is precisely the finding an IG review looks for.
- **Ending an assignment ends read access to new material but not to what was already reviewed** —
  the reviews a clinician signed stay attributable to and visible by them.
- `reason` is required for `self_claim`. This is not bureaucracy; it is the difference between an
  access log that shows *what* was accessed and one that shows *why*, and only the second survives a
  DPIA.

### 4.4 Protocol and ProtocolVersion

`Protocol: id · name ("Headache intake") · specialty · status`
`ProtocolVersion: id · protocolId · semver · fieldCatalog · redFlagSet · toolStates · promptBlocks ·
modelConfig · latencyProfile · publishedAt · publishedBy · frozen`

Today the protocol *is* the source tree: `shared/src/intakeFields.ts`, `shared/src/redFlags.ts`,
`shared/src/machine.ts`, `backend/src/policy/blocks.ts`. That is correct for one protocol and
untenable for a report you have to interpret six months later.

**Every interview pins a protocol version, and published versions are immutable.** A report says
*"severity: 7"* — that means nothing unless you can recover the question that was asked and the
red-flag set that was armed at the time. Adding a red flag changes clinical behaviour; if versions
are mutable, that change retroactively rewrites the meaning of every historical record. The README's
*"Adding a red flag"* workflow becomes *"cut a new protocol version"*.

This also gives the deploy action something real to choose between, and gives the escalation-rate
metric in class 4 a dimension worth grouping by — a rate that moves on the day a version ships is a
different fact from one that drifts.

### 4.5 Interview — the "talk"

`id · patientId · protocolVersionId · deployedBy · assignedTo · lifecycleState · priority ·
deliveryChannel (link | sms | email | phone_callback) · opensAt · expiresAt · accessTokenHash ·
deploymentNote · createdAt · completedAt · outcome`

**Two clinician references, deliberately.** `deployedBy` is who sent it; `assignedTo` is who owes it
a review. They default to the same person and diverge constantly in practice — one clinician runs a
clinic list, another reviews it. The brief's *"history of interviews chosen by me"* is ambiguous
without this distinction, so the deployment dashboard names the filter explicitly (§8.3).

`deploymentNote` is the clinician's free-text reason for sending it. It is for the *reviewer*, and it
must never enter the prompt — an instruction block that varies per call destroys the prompt-cache
prefix the architecture doc's §5 depends on, and injecting clinician text into a patient-facing model
is a prompt-injection surface for no clinical gain.

`outcome` is the terminal summary of *how* the interview ended (`completed`, `escalated`,
`verification_failed`, `reschedule_requested`, `abandoned`, `expired`, `cancelled`) and is what the
dashboards bucket on.

### 4.6 Session

`id · interviewId · startedAt · endedAt · transport (webrtc | text_fallback) · conversationState ·
verificationAttempts · clientInfo · terminationReason`

This is the current `IntakeRecord`'s call-scoped half: the in-call FSM, the attempt counter, the
LiveKit room. **`verificationAttempts` stays on the interview, not the session** — otherwise
reconnecting three times resets the lockout, and `MAX_VERIFICATION_ATTEMPTS` becomes advisory.

### 4.7 IntakeRecord (class 3)

Unchanged in shape, moved in scope: keyed by `interviewId`, and **a projection of the ledger** per
`voice-architecture.md` §4. `summary` leaves this type — it is the clinical deliverable and belongs
in class 2, where it cannot be silently rewritten after a clinician has acted on it.

### 4.8 LedgerEntry (class 2)

Per the architecture doc: every user turn's final transcript **and its scan result including the
passes**, every LLM turn, every tool call with arguments and the `isToolAllowed()` verdict, every
transition, the summary and its inputs. Hash-chained, WORM-backed.

**One extension this document adds: the staff ledger.** Clinician actions — claimed a patient,
opened a profile, played audio, signed a review, broke glass — are the same kind of fact about a
different subject, and they need the same tamper-evidence for the same reason. Same store, same
chain, `subject: "call" | "staff"`. Building a second, weaker audit mechanism for staff actions is
the predictable mistake.

### 4.9 Escalation

`id · interviewId · sessionId · raisedAt · source (model | keyword_scan) · redFlagId · triggerText ·
notifiedTargets · acknowledgedBy? · acknowledgedAt? · disposition? · dispositionNote? · closedAt?`

**Its own entity with its own lifecycle — `raised → notified → acknowledged → closed` — because it
must be closed by a human even if the interview is never reviewed.** Folding it into the interview's
review status means an escalation is discharged by someone reading a report, possibly the next
working day. That is the failure mode the whole defence-in-depth design exists to prevent; it would
be perverse to reintroduce it in the workflow layer.

`triggerText` is PHI and sits behind the same access rules as the transcript. The *notification* that
leaves the perimeter carries an interview ID and a severity, never the text.

### 4.10 Review — the clinical review report

`id · interviewId · authorId · status (draft | signed | superseded) · clinicalImpression ·
amendments[] · disposition · riskRating · recordVersionHash · ledgerHeadHash · signedAt · signature`

**The review never edits the record; it references it and adds to it.** `recordVersionHash` and
`ledgerHeadHash` pin exactly what the clinician saw at signature time. A correction after signing is
a *new* review superseding the old one — both survive, both are attributable. This is the only
arrangement compatible with an append-only ledger, and it is also simply how clinical records work.

`disposition` is the enum that makes the product useful, and it is a clinical decision so it belongs
to a named human: `routine_appointment · urgent_appointment · same_day · advice_only ·
repeat_interview (protocol did not fit) · invalid (wrong patient / test / unusable)`.

`invalid` matters more than it looks: without it, the only way to remove a bad interview is deletion,
and deletion is what class 2 forbids.

### 4.11 Consent

`id · patientId · interviewId? · scope (processing | recording | retention) · grantedAt · method ·
withdrawnAt?`

**Recording consent is a hard gate on class 1, not a checkbox** — the architecture doc says so
explicitly. The consequence for this model: `Session` must be able to run with audio capture
*disabled* and still produce classes 2–4, and the deploy preflight must refuse a recording-required
protocol for a patient with no consent on file.

### 4.12 AudioArtifact (class 1) / TelemetryEvent (class 4)

As specified in `voice-architecture.md` §4 — listed here only so the entity map is complete. Audio is
per-session-per-track, never pre-mixed. Telemetry has **no foreign keys into any of this** by
design; `sessionId` is a string it carries, not a relation it joins.

---

## 5. Three state machines, and how they connect

This is the part worth getting right, because two of these already half-exist and the third does not
exist at all.

### 5.1 The conversation machine (exists — `shared/src/machine.ts`)

Minutes long, session-scoped, owned by `applyEvent()`. Unchanged:

```
verification ──identity_verified──> intake ──intake_finalized──> finalized
     │                                │
     ├─verification_locked──> locked  │
     ├─reschedule_requested─> reschedule
     └──────────── red_flag ──────────┴──────────> alert   (reachable from every state but alert)
```

### 5.2 The interview lifecycle (new — proposed `shared/src/lifecycle.ts`)

Days long, interview-scoped. **Declared exactly the way the conversation machine is** — a transition
table in `shared/`, a single writer on the backend, the frontend rendering it and never deciding it.
The ADR's reasoning transfers without modification, and so does its payoff: the dashboards' buckets
become a table you can read, not a set of conditions repeated across three views.

```
   draft ──publish──> scheduled ──invite_sent──> invited ──session_started──> in_progress
     │                    │                         │                            │
     │                    │                         └──window_elapsed──> expired │
     │                    └──window_elapsed──> expired                           │
     │                                                                           │
     │                          ┌────────────────────────────────────────────────┤
     │                          │                                                │
     │              in_progress─┴─ conversation reached a terminal state ────────┤
     │                                                                           │
     │        ┌──────────────────┬───────────────────┬────────────────┬──────────┘
     │        ▼                  ▼                   ▼                ▼
     │  awaiting_review   needs_attention        expired         (still resumable:
     │   (completed)      (locked / reschedule)  (abandoned,       stays in_progress
     │        │                  │                window open)     until the window
     │        ▼                  │                                 closes)
     │    in_review              │
     │        │                  │
     │        ▼                  ▼
     │     signed ──────────> archived
     │
     └──cancel──> cancelled   (legal from every non-terminal state)
```

`escalated` is **not** a lifecycle state. A red flag raises an `Escalation` and sets the interview's
priority to urgent; the interview still lands in `awaiting_review` like any other. Making escalation a
lifecycle state would mean an escalated interview cannot also be reviewed, which is exactly backwards
— it needs reviewing *more*.

### 5.3 The review machine (new)

`draft → signed → (superseded)`. Trivial, but declared rather than implied, because "signed" is the
moment the record becomes evidence.

### 5.4 The mapping — conversation end → lifecycle → dashboard bucket

**This table is the joint between the prototype and the product.** It is the only place the two
machines touch, and it should exist as one function (`lifecycleEventFor(conversationState)`) rather
than as branching in three views.

| Conversation ended in | Interview outcome | Lifecycle state | Bucket | Notified |
|---|---|---|---|---|
| `finalized` | `completed` | `awaiting_review` | Needs review | `assignedTo`, batched |
| `alert` | `escalated` | `awaiting_review`, priority urgent, `Escalation` raised | **Warnings** | on-call **now**, then `assignedTo` |
| `locked` | `verification_failed` | `needs_attention` | Warnings | `deployedBy` — this is a *delivery* failure, not a clinical one |
| `reschedule` | `reschedule_requested` | `needs_attention` | Pending | `deployedBy` |
| session dropped, window open | — | `in_progress` (resumable) | In progress | nobody yet |
| session dropped, window closed | `abandoned` | `expired` | Warnings | `deployedBy`, digest |
| never started by `expiresAt` | `expired` | `expired` | Pending → Expired | `deployedBy`, digest |

Two of these deserve emphasis. A **lockout is an operational failure, not a clinical one** — the
patient may be entirely well and simply unable to recall the phone on file, or the model may have
fabricated arguments (R-5). It routes to whoever deployed it, and a lockout rate that climbs is a
telemetry alarm about the *system*. And an **abandoned interview is a real clinical signal** — a
patient who started describing a headache and stopped is not the same as one who never began.

---

## 6. Surface A — clinician dashboard

Answers *"what is waiting for me, and who is on my panel?"* — landing page after login.

### 6.1 Find and claim a patient

The brief's *"pull in patients he wants to assign to himself"*. The design constraint: **search is
not browse.** A clinician with no assignment may not page through the patient directory; they may
resolve an identifier they already hold.

- Query requires an exact-ish match on MRN/NHS number, **or** family name + date of birth.
- Results before assignment show identity only — name, DOB, MRN, whether a care team exists. No
  clinical content, no interview history, no counts.
- **Claim** opens a `CareAssignment` with a `relationship` and a required `reason`. Claiming
  `responsible` where one exists prompts for transfer and notifies the incumbent.
- Every search and every claim writes to the staff ledger. Searches that return nothing are logged
  too — a burst of them is the signature this control exists to catch.

### 6.2 My panel

`GET /api/me/patients` — patients with an active assignment, showing: name, DOB, relationship,
last interview date and outcome, count of open items, next pending interview. Sortable by open items
so the list orders itself by need.

### 6.3 My work queues

Four counted queues, each a single indexed query on `Interview` — no ad-hoc joins:

| Queue | Predicate |
|---|---|
| **Escalations to acknowledge** | `Escalation.acknowledgedAt IS NULL` where I am on-call or assigned |
| **Needs review** | `assignedTo = me AND lifecycleState = awaiting_review`, urgent first |
| **In progress** | `assignedTo = me AND lifecycleState = in_progress` |
| **Expiring soon** | `deployedBy = me AND lifecycleState IN (scheduled, invited) AND expiresAt < now + 48h` |

The escalation queue sits above the fold and above the others, always. It is the only one with a
clock on it.

---

## 7. Surface B — patient profile

Answers *"what do we know about this person, and what is outstanding?"*. Reachable only with an
active assignment or a break-glass grant, and **every open writes to the staff ledger** before the
page renders.

### 7.1 Header

Identity, care team (with assign/transfer/end actions), consent status per scope, and standing flags.
Any unacknowledged escalation renders as a banner here, not as a row in a tab.

### 7.2 Interviews — history and pending, one list

The brief separates *"talks report history"* from *"pending talks"*; they are one chronological list
with a lifecycle badge, because the interesting question is *"what has happened with this person"* and
splitting it into two panels hides the ordering. Filters, not tabs.

Per row: date, protocol name + version, lifecycle badge, outcome, escalation marker, review status
and signer, one-line summary excerpt. Pending rows carry a countdown to `expiresAt` and the actions
that make sense for them — resend invite, extend window, cancel.

### 7.3 Interview detail — where the review happens

Three panes over the same interview:

- **Transcript** (class 2) with scan results inline — including the passes, which is what makes
  *"why did it not escalate at 4m12s?"* answerable from the UI rather than from a database.
- **Structured record** (class 3), field by field, each traceable to the turn that set it.
- **Ledger** (class 2, raw) — tool calls with arguments and verdicts, transitions, model and protocol
  version. Collapsed by default.
- **Audio** (class 1) — gated on recording consent, role, and an explicit "reveal" that is itself a
  ledger entry. Two tracks, separately, never mixed.

The **review composer** sits alongside: the issued summary (read-only, from class 2), a clinical
impression field, amendments as additions, disposition, risk rating, and a sign action that captures
`recordVersionHash` + `ledgerHeadHash`. Signing is irreversible; correcting means superseding.

### 7.4 The patient's own entry point

Not a dashboard, but part of this surface's contract: `GET /i/:token` resolves the interview,
enforces `opensAt`/`expiresAt` and single-use-ish token semantics, presents the non-diagnostic
disclaimer and the consent gate, and then starts a `Session`. The token identifies the interview; it
does **not** authenticate the patient — `verify_identity` inside the call still does that, against
the `Patient` row. Keeping those two separate is what makes a forwarded link harmless.

---

## 8. Surface C — deployment dashboard

Answers *"what have I sent out, what came back, and what needs a human now?"*. The operational view.

### 8.1 Deploying an interview

Compose: patient (must be assigned — assign inline if not) · protocol + version (defaults to latest
published) · delivery channel · window (`opensAt`, `expiresAt`) · priority · reviewer (defaults to
self) · deployment note.

**Preflight refuses, rather than warns, on:**

- no active care assignment for the deploying clinician;
- no valid contact on the chosen channel;
- recording-required protocol with no recording consent on file;
- an open interview for the same patient on the same protocol — duplicate invites to a patient are a
  quality-of-care problem, and the second link also makes the first one's abandonment unreadable;
- protocol version not `published`.

Deploying writes `Interview(draft → scheduled)` plus a staff ledger entry, and hands delivery to a
job that produces its own receipt. **Delivery failure is a lifecycle event** (`invite_failed →
needs_attention`), not a silent log line — an SMS that bounced is an interview that will expire
looking exactly like a patient who ignored it.

### 8.2 The buckets

| Bucket | Contents | Why it is its own bucket |
|---|---|---|
| **Pending** | `scheduled`, `invited` — sent, not started | Nothing to do yet; watch the clock |
| **In progress** | `in_progress`, including resumable drops | Transient; a stuck row here is a systems alarm |
| **Needs review** | `awaiting_review`, `in_review` | The work |
| **Warnings** | unacknowledged escalations · verification lockouts · delivery failures · abandoned mid-interview · expired unstarted · sessions ended on a technical fault | Heterogeneous by design — see below |
| **History** | `signed`, `archived`, `cancelled`, `expired` | The record |

**Warnings is deliberately heterogeneous, and that is a claim worth defending.** It mixes one
clinical event (escalation) with several operational ones (lockout, bounce, abandonment, fault). The
alternative — a queue per failure type — buries the escalation among four operational lists that are
individually rare. One bucket, sorted by severity with escalations pinned and clocked, means the
clinician looks in exactly one place for *"something here is not proceeding normally"*. The severity
ordering, not the bucketing, carries the distinction.

### 8.3 "Interviews chosen by me"

The default filter is `deployedBy = me`, with two siblings: `assignedTo = me` (my review load) and
`careTeam contains me` (everything about my panel, regardless of who sent it). They answer genuinely
different questions and the dashboard names them rather than picking one silently. Plus date range,
protocol version, outcome, and patient.

---

## 9. Access control

### 9.1 Two conditions, both required

```
may_read(clinician, patient) :=
      role_permits(clinician, action)
  AND ( active_assignment(clinician, patient)
        OR active_break_glass(clinician, patient) )
```

**One function, server-side, mirroring `isToolAllowed()`.** The ADR's argument applies verbatim: put
the check in one authorization seam that every route passes through, not as a condition repeated in
each handler, and it becomes a property you can test structurally rather than spot-check.

### 9.2 Permission sketch

| Action | Clinician (assigned) | Clinician (unassigned) | Admin | Auditor |
|---|---|---|---|---|
| Search patients by identifier | ✓ | ✓ (identity fields only) | ✓ | ✗ |
| Claim / transfer assignment | ✓ | ✓ (with reason) | ✓ | ✗ |
| Read record + transcript | ✓ | break-glass | break-glass | ✗ |
| Play audio | ✓ + consent | ✗ | break-glass | ✗ |
| Deploy interview | ✓ | ✗ | ✗ | ✗ |
| Sign review | ✓ | ✗ | ✗ | ✗ |
| Acknowledge escalation | ✓ or on-call | on-call | ✗ | ✗ |
| Read ledger metadata | ✓ | ✗ | ✓ | ✓ |
| Publish protocol version | ✗ | ✗ | ✓ | ✗ |

**Break-glass is available, loud and time-boxed:** reason required, access granted for a fixed
window, notification to the responsible clinician at the moment of use, and a staff-ledger entry that
is reviewed rather than merely written. An emergency access path that is hard to use is an emergency
access path that gets shared as a standing account.

### 9.3 Escalation routing is a safety control

An escalation raised at 02:00 against a clinician who is asleep is an unacknowledged red flag. The
routing target is a **rota**, with a timeout that escalates further if unacknowledged. This is why
`Escalation` carries `notifiedTargets` and its own clock, and it is the one part of the workflow
layer that has the same standing as the in-call safety gate.

---

## 10. API surface

Existing routes are unchanged in shape; everything new sits beside them.

| Group | Endpoints |
|---|---|
| Auth | `POST /api/auth/session`, `GET /api/me` |
| Patients | `GET /api/patients?q=`, `GET /api/patients/:id`, `GET /api/patients/:id/interviews` |
| Assignments | `POST /api/patients/:id/assignments`, `DELETE /api/assignments/:id`, `POST /api/assignments/:id/transfer` |
| Protocols | `GET /api/protocols`, `GET /api/protocols/:id/versions`, `POST /api/protocols/:id/versions/:v/publish` |
| Interviews | `POST /api/interviews` (deploy), `GET /api/interviews?filter=`, `GET /api/interviews/:id`, `POST /api/interviews/:id/cancel`, `POST /api/interviews/:id/resend`, `POST /api/interviews/:id/extend` |
| Queues | `GET /api/me/queues`, `GET /api/me/patients` |
| Reviews | `POST /api/interviews/:id/review` (draft), `POST /api/reviews/:id/sign`, `GET /api/reviews/:id` |
| Escalations | `GET /api/escalations?state=`, `POST /api/escalations/:id/acknowledge`, `POST /api/escalations/:id/close` |
| Patient entry | `GET /i/:token`, `POST /api/interviews/:id/consent`, `POST /api/sessions` (replaces `POST /api/session`) |
| In-call (existing) | `POST /api/tools/:name`, `POST /api/safety-check` |

`POST /api/session` becoming `POST /api/sessions` with an interview ID and token is the seam where the
prototype's anonymous call joins the product.

---

## 11. Where this lands on the four data classes

Nothing here disturbs the split; it populates it.

| Class | New entities | Crosses the perimeter |
|---|---|---|
| 1 · Audio | `AudioArtifact` per session per track | never |
| 2 · Ledger | `LedgerEntry` (call) + staff ledger + signed `Review` + issued summary | never |
| 3 · Record | `IntakeRecord`, now interview-scoped | never |
| 4 · Telemetry | queue depths, time-to-acknowledge, time-to-review, lockout rate, delivery failure rate, escalation rate by protocol version | **yes — still nothing in it** |
| Operational | `Patient`, `Clinician`, `CareAssignment`, `Interview`, `Protocol*`, `Consent` | never (contains PHI: names, DOB, contact) |

**The operational table is a fifth store and pretending otherwise is how the split leaks.** `Patient`
holds name, DOB and phone — it is PHI, and it does not belong in the ledger (mutable), the record
(interview-scoped) or telemetry (obviously). It sits inside the perimeter with classes 1–3 and is
governed by them.

**Time-to-acknowledge is class 4's most important new metric.** It is measurable without any content
at all, and it is the number that says whether the escalation path works in practice rather than in
design.

---

## 12. What changes in the code that exists

| Today | Becomes | Why |
|---|---|---|
| `sessions = new Map()` in `intakeStore.ts` | durable store behind the same `applyEvent`/`updateRecord` seam | open decision 7; R-1 fails on persistence, not shape |
| `IntakeRecord` keyed by `sessionId` | keyed by `interviewId`, `Session` split out | §3 — resume, and one record per talk |
| `summary?: string` on the record | ledger entry, immutable | architecture §4, class 2 |
| `DEMO_PATIENT_DOB` / `DEMO_PATIENT_PHONE` | `Patient` row bound to the interview | smallest change with the largest effect; do it first |
| `verificationAttempts` per session | per interview | reconnect must not reset the lockout |
| protocol hardcoded in `shared/` | `ProtocolVersion`, pinned per interview | reports must stay interpretable |
| no auth | session auth + `may_read` seam | requirements: "basic access control on the clinician-facing surface" |
| `history: HistoryEntry[]` on the record | full ledger, hash-chained | architecture §4 — `update_intake` currently leaves no trace |

`shared/` gains `lifecycle.ts` and `roles.ts` and stays what the ADR says it is: a declaration layer,
no I/O. The frontend gains three routed views and keeps rendering server-decided state.

---

## 13. Build order

Each step leaves something demonstrable; none requires the next to be useful.

1. **Persist what exists.** SQLite behind `intakeStore`, no schema change. Closes open decision 7 and
   makes R-1's resume test runnable.
2. **`Patient` + real verification.** One table; `verify_identity` reads it. The demo stops being a
   demo.
3. **`Interview` + `Session` split**, with the lifecycle machine in `shared/` and the §5.4 mapping as
   one function. Nothing visible changes; everything after depends on it.
4. **Auth + `CareAssignment` + the `may_read` seam**, with the staff ledger. Search-and-claim works.
5. **Deploy + delivery**, with preflight and invite tokens. The deployment dashboard's write path.
6. **The ledger properly** — every turn, scan pass, tool call and verdict; record becomes a
   projection. Unlocks the interview-detail view.
7. **Review + signature.** The product's actual output.
8. **Escalation entity + rota routing + acknowledgement clock.** Warnings become real.
9. **The three dashboards** as query shapes over the above.

Steps 1–3 are refactors of working code and should be done before any UI. Step 8 is the one that is
tempting to defer and shouldn't be — it is a safety control wearing workflow clothes.

---

## 14. Open decisions

| # | Decision | Owner | Blocking |
|---|---|---|---|
| 1 | Single-tenant or `Organisation`-scoped from the start — cheap now, invasive later | project | schema, step 1 |
| 2 | Does the patient ever see their own report, or only the clinician? Changes consent wording and retention | project + clinical | review UI, §7 |
| 3 | Rota model for on-call escalation routing — real rota, or a fixed duty inbox for now | project | step 8 |
| 4 | Store choice for classes 2 and 3 — one Postgres with an append-only table, or separate stores per the architecture doc's argument | engineering | step 1 |
| 5 | Does a `reschedule_requested` outcome auto-deploy a replacement interview, or only notify? | clinical | step 5 |
| 6 | Break-glass: available to any clinician, or admin-approved? Second is safer and reliably worked around | project | step 4 |
| 7 | Whether `Review` disposition can create a downstream action (book appointment) or only record intent — the boundary where this stops being an intake tool | project | step 7 |
| 8 | Retention per class, and whether an `invalid` review shortens it | project + legal | inherited from architecture §6.8 |

**Decision 7 is the regulatory one.** *"Collects and structures information for a clinician to
review"* is the position that keeps this out of SaMD territory, per the requirements doc. A
disposition that records a clinician's decision is safely inside it. A disposition that *acts* —
books, triages, prioritises by rule — is a different product with a different approval path, and the
boundary should be crossed deliberately or not at all.
