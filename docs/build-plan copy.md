# Build plan — protocol/platform inversion

- **Status:** Proposed
- **Date:** 2026-08-19
- **Supersedes:** nothing; sequences work already scoped in `pdr-clinical-intake-platform.md` §4
- **Depends on:** ADR 0002 (one protocol: pre-operative assessment)

## The inversion

The artifact stops being *"a pre-operative assessment agent"* and becomes **the harness that safely
executes a clinical protocol someone else specifies**.

That relocates the engineering claim onto ground we can actually defend. A pre-op agent needs
clinical authority we do not have. A conformance-tested protocol executor needs exactly the skills
this project is meant to demonstrate — a declaration layer, a state machine, an enforcement seam, and
two harnesses that prove it behaves.

Three consequences fall out:

1. **Evals become principled.** They test *"does the executor satisfy the protocol's declared
   requirements"*, not *"is this clinically correct"*. Ground truth comes from the declaration, which
   we own and version. That is how conformance testing works everywhere else; it is not a workaround.
2. **It matches what is already built.** `shared/` is already a declaration layer generating the
   prompt, the tool schemas, the scanner and the tests from one source. Going from *one hardcoded
   protocol* to *a versioned `ProtocolVersion` artifact* is a short step, not a rewrite.
3. **The clinical-input question gets an honest answer in code**, not in prose — see §"Protocol
   shapes" below.

The PDR already names the seam: **M3 Protocol Registry** supplies the brief, **M5 Voice Interview
Engine** depends on M3 and nothing else. This plan is the order in which that stops being a diagram.

---

## Where the project actually is

Clear-eyed, because it determines the ordering.

**Built and load-bearing:** the declaration layer (`shared/`), backend-owned state machine with tool
gating (`backend/src/runtime.ts`, ADR 0001), defence-in-depth escalation (model tool call +
independent deterministic scanner), the realtime voice path, and a latency benchmark harness
(`backend/src/bench/`).

**Not built at all:** persistence of any kind (records are garbage-collected when the call ends),
identity, patients, consultants, approval workflow, call deployment, typed interview output.

**Wrong content:** the shipped protocol is still headache intake. ADR 0002 decided pre-operative
assessment. That gap gets closed *by* the extraction in Phase 1, not before it.

So: the agent is the part that is done, the platform around it is the part that is not, and no
amount of protocol abstraction shortens the platform work.

---

## Hard constraints

Written down because the failure mode of this idea is a spec explosion — `docs/` is already ~6,700
lines against ~4,500 lines of TypeScript.

- **One type, one validator, two instances.** The protocol schema is one TypeScript type and one
  validator function. Exactly two published protocols. **A third protocol requires deleting
  something.**
- **Universal escalations are never overridable.** A protocol may *add* escalations. It may never
  subtract, weaken, or reword a universal one. This single rule is what makes pluggable clinical
  content safe.
- **The engine never reads a registry.** It is *given* a pinned `ProtocolVersion` and executes it.
- **A published `ProtocolVersion` is immutable.** Changes produce a new version. Every interview
  record pins the version it ran under.
- **No doc lands more than one phase ahead of the code it describes.**

---

## Phase 0 — Settle the abstraction (docs only, two artifacts)

**ADR 0003 — protocol/platform inversion.** Records the decision above, the universal-escalation
rule, and the "two instances" constraint. Supersedes the parts of ADR 0002 it changes (ADR 0002's
*clinical* scope decision survives untouched — it becomes the pre-op protocol's content).

**`docs/protocol-shapes.md`** — the comparison table across the four call types the product could
carry, scored on what each would cost to build honestly:

| | Admin (confirm/remind) | Research (structured questionnaire) | Pre-op assessment | Post-op check |
|---|---|---|---|---|
| Clinical input required | none | low | **high** | high |
| Who signs the protocol off | ops | study PI | anaesthetist / pre-op lead | surgical team |
| What the agent may say | logistics only | fixed instrument wording | declared items only | declared items only |
| Escalation surface | universal only | universal only | universal + protocol-specific | universal + protocol-specific, symptom-led |
| Output | attendance decision | instrument scores | typed assessment + score | typed check + disposition |
| Regulatory exposure | low | moderate (governance) | high | highest (symptom-led) |

This is the strongest single artifact in the project: it demonstrates product judgment about
clinical risk *without* claiming clinical knowledge, and it reframes the build choice as a decision
rather than a limitation. First-class doc, not an appendix.

**Exit:** both merged. No code yet.

---

## Phase 1 — Extract `ProtocolVersion` (the seam)

Turn the hardcoded content in `shared/` into data, and the runtime into a generic executor.

Target shape — one type, in `shared/src/protocol.ts`:

```
ProtocolVersion
  identity      id, name, version, publishedAt, signedOffBy
  items[]       what to ask, slot schema, required vs optional
  outputSchema  the typed interview output
  scoring?      optional deterministic function (STOP-BANG is arithmetic, not judgment)
  escalations   universal (shared catalog, always on)
              + specific (protocol-declared, additive only)
  clinicalInput inputRequired: none | low | med | high
                signOffRole, sources[]        ← the honest artifact, in the type
  deployment    windows, expiry, reschedule rules
```

`clinicalInput` living in the type is what stops the consultant question from drifting back into
prose. It is not documentation; it is a field the validator checks.

Work:
- `intakeFields.ts` → `protocol.items` (its `label` / `promptDescription` split already anticipates this).
- `redFlags.ts` splits: universal catalog stays platform-owned; protocol-specific escalations move
  into the instance. `backend/src/safety/patterns.ts` stays keyed exhaustively, so a declared
  escalation without a decided detection strategy remains a compile error.
- `record.ts`: `IntakeRecord` → `InterviewRecord` carrying `protocolId` + `protocolVersion` and
  protocol-shaped slots.
- `backend/src/policy/instructions.ts` generates prompt blocks *from the protocol*, not from
  hardcoded text.
- `machine.ts` stays platform-owned and unchanged in spirit: states, transitions and tool gating are
  platform concerns. Protocols do not get to invent states.
- **Content swap:** publish `preop-assessment@1` with ADR 0002's content, retiring headache intake.

**Exit:** the existing test suite passes with the protocol supplied as data; nothing clinical is left
hardcoded in `backend/`.

---

## Phase 2 — Conformance eval harness

Two harnesses, two purposes, kept visibly separate — `bench/` measures **latency**, `evals/` measures
**correctness**. Most portfolio projects have neither; having both, clearly separated, is the signal.

Evals run against a **scripted (non-audio) engine implementation** so they are deterministic and run
in CI. The PDR already allows for this — the platform is meant to be indifferent to which engine
implementation is running, and evals are the thing that proves it.

**Conformance suite (generic, runs for every protocol):**
- slot coverage — every required item is asked
- no out-of-scope questions — nothing asked that the protocol does not declare
- escalation recall against an adversarial utterance corpus
- state-machine legality — no illegal transition reachable from any input
- tool gating — no tool callable outside its declared states
- output-schema validity

**Exit:** `npm run evals` produces a per-protocol conformance report for `preop-assessment@1`.

---

## Phase 3 — The second protocol (proves the seam)

Abstracting over an N of 1 guarantees the seam is guessed wrong. Ship **`admin-confirmation@1`** —
appointment confirmation and reminders.

It is nearly free *because* it needs almost zero clinical input, and it proves the abstraction by
being maximally unlike pre-op: `inputRequired: none`, universal escalations only, a one-field output.
It also makes the Phase 0 table concrete at both ends of the risk range.

The claim this phase buys: **adding a protocol gets you its conformance suite for free.** That is a
platform claim, and platform claims are what this project exists to make.

Then add the **protocol-specific eval layer**: scoring exact-match, required-item completion, output
validity — declared per protocol, on top of the conformance suite it inherits.

**Exit:** two protocols, one executor, one conformance suite, two protocol-specific suites. Freeze
the protocol schema here.

---

## Phase 4 — The pipeline (the bulk of the work)

Everything the agent hands off to. Ordered by what unblocks the most:

1. **Persistence** — patients, consultants, protocol versions, interviews, escalation events,
   append-only audit trail. Nothing else on this list is possible first.
2. **Deployment** — an interview is *dispatched* against a patient with a pinned protocol version,
   a window, and an expiry token.
3. **The two reschedules, kept distinct** — *reschedule call* moves the AI interview; *reschedule
   visit* moves the actual clinical appointment. Different events, different downstream effects,
   different notifications. Collapsing them is the mistake this line exists to prevent.
4. **Escalation routing** — universal escalations reach a human on a clock, with acknowledgement.
5. **Typed output + approval** — the interview produces a protocol-shaped draft; a consultant
   reviews, amends and signs. Nothing leaves the system unsigned.

**Exit:** an interview can be deployed, taken, escalated, rescheduled (either kind), and signed off,
with the whole trail persisted.

---

## Phase 5 — Portfolio surface

Clinician workspace over the real data, and a README rewritten around the actual claim: *a
conformance-tested executor for versioned clinical protocols, demonstrated on two protocols at
opposite ends of the clinical-risk range.*

---

## Sequencing rationale

```
Phase 0  docs          settle the abstraction before touching code
Phase 1  seam          protocol as data, engine as executor
Phase 2  conformance   the harness exists BEFORE protocol #2 …
Phase 3  protocol #2   … so "free conformance suite" is demonstrated, not asserted
Phase 4  pipeline      the long pole; unblocked by nothing above it
Phase 5  surface       last, because it renders Phase 4's data
```

Phases 0–3 are the differentiating work and are small. Phase 4 is most of the calendar time.

## Risks

| Risk | Mitigation |
|---|---|
| Abstracting over an N of 1 | Phase 3 is not optional and is deliberately unlike pre-op |
| Spec explosion | The hard constraints above; a third protocol requires a deletion |
| Protocol schema churns during Phase 4 | Freeze it at the end of Phase 3 |
| Phase 4 stalls and the repo reads as docs-heavy | Phases 1–3 must land a working executor + green evals before Phase 4 starts |

## Non-goals

Clinical validity of protocol *content* (that is the sign-off role's job, and the type says so),
real patient data, more than two protocols, and any new deployment profile beyond what
`deployment-portfolio.md` already covers.
