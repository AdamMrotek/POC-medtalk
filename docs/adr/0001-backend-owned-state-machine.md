# ADR 0001 — The backend owns conversation state; the frontend consumes a shared model

- **Status:** Accepted
- **Date:** 2026-08-11
- **Deciders:** Adam Mrotek
- **Affects:** `shared/src/machine.ts`, `backend/src/intakeStore.ts`, `backend/src/runtime.ts`, `backend/src/policy/`, `frontend/src/useRealtimeConversation.ts`

## Context

The Headache Intake Assistant is a voice call driven by OpenAI's Realtime API over WebRTC. Because latency matters, the **browser talks to OpenAI directly** — the backend only mints an ephemeral key and then sits to the side, receiving tool calls relayed over the data channel. That topology creates the central problem this ADR addresses:

**The component closest to the conversation (the browser) is the component we trust least, and the model driving the conversation is not a reliable authority on what it is allowed to do.**

The call has real stage-dependent rules, and getting them wrong has clinical and privacy consequences:

- No medical questions may be asked before identity is verified.
- After three failed verification attempts the session is locked and must not continue.
- If the patient asks to reschedule, the call ends — no intake.
- A red-flag symptom escalates to an emergency message from *any* point in the call, including before verification and after intake has otherwise wound down.
- Once intake is finalized (or escalated, or locked, or rescheduled), no further data may be recorded.

The first implementation expressed these rules two ways at once: as prose in a single large system prompt, and as ad-hoc guards in individual tool handlers (`tool.stage === "intake" && !record.verified`). Both were unsatisfactory. Prompt text is a request, not a control — the model could and did drift into intake questions during verification. The ad-hoc guards were per-tool booleans with no shared notion of "the call is over," so nothing structurally prevented a late or duplicate tool call from writing to a finalized record. Meanwhile the frontend maintained its own idea of the current stage in order to render the timeline, which meant the rules effectively lived in three places with no mechanism keeping them in agreement.

## Decision

**Declare the conversation as an explicit finite state machine in a shared package, make the backend the only thing that may move it, and give the frontend the same declaration as a read-only rendering vocabulary.**

Three parts:

### 1. One declaration, in `shared/`

`shared/src/machine.ts` is the single source of truth: the `ConversationState` union (`verification`, `intake`, `alert`, `reschedule`, `locked`, `finalized`), the `ConversationEvent` union, the `TRANSITIONS` table, `TOOL_STATES` (which tools each state permits), and the predicates over them (`nextState`, `isToolAllowed`, `isClosing`). `shared/` is a declaration layer only — no I/O, no store access, no HTTP, no React.

The package is consumed differently by each side for build reasons, but it is the same file: the backend imports the compiled `@threepio/shared` (its NodeNext resolution needs real `.d.ts`), while Vite aliases `@threepio/shared` straight to `shared/src/index.ts` so the frontend picks up edits without a build step.

### 2. The backend is the only authority

- **`applyEvent()` in `backend/src/intakeStore.ts` is the only writer of `record.state`.** It consults `nextState()`, and refuses illegal transitions by returning `applied: false` rather than throwing — a late or duplicate tool call must not be able to take down a live call. Every accepted transition is appended to `record.history` as an append-only audit trail. The sibling `updateRecord()` is typed `Partial<Omit<IntakeRecord, "state" | "history">>`, so the type system forbids bypassing the machine.
- **`isToolAllowed()` in `runTool()` (`backend/src/runtime.ts`) is the authorization check**, executed before any handler runs; a disallowed call returns 409. This is what makes terminal states genuinely terminal: `alert`, `reschedule`, `locked` and `finalized` list no tools at all, so "stop recording data now" is one property of the table rather than a condition repeated in five handlers.
- **Tool handlers are pure.** They receive args and the current record and return a description of the change (`{ event?, fields?, result? }`); they never touch the store. Applying the event stays in exactly one place.
- **The prompt is derived from state, not trusted to encode it.** `sessionConfigFor(state)` composes `instructionsFor(state)` (`backend/src/policy/instructions.ts`, assembled from blocks in `policy/blocks.ts`) with `toRealtimeToolSchemas(state)`, which filters the tool schemas through the same `isToolAllowed`. The model is only *shown* the tools it can legally call, and the session is re-instructed on every accepted transition. Prompting became an optimization for good behavior on top of an enforced boundary, rather than the boundary itself.
- **An independent, non-LLM path can escalate.** `runSafetyCheck()` scans transcribed patient speech with deterministic patterns and applies `red_flag` directly. `red_flag` is legal from every state except `alert`, which is the machine's only sink — being closed to the agent is not the same as being closed to an emergency.

### 3. The frontend renders state, never decides it

`frontend/src/useRealtimeConversation.ts` holds a `stage` in React state, but it is *derived* from the record the server returns with each tool result and safety check; the client performs no transitions of its own. It imports the shared types for the same reason the backend does — `CLOSING_STATES` drives auto-ending the call, `ConversationState` types the timeline grouping in `ConversationTimeline.tsx` — so adding a state is a compile error on the rendering side rather than a silently unhandled case.

The browser still relays `session.update` to OpenAI (only it holds the data channel), but it relays a config the server produced, and it receives that config *in the response that authorized the transition* rather than being handed every stage's instructions up front. A compromised or buggy client can send whatever it likes to OpenAI; it cannot make the server record intake data it isn't entitled to record.

## Consequences

**What this buys us**

- Illegal sequences are refused by construction, not by the model's cooperation. Verification-before-intake, lockout, and post-escalation silence hold even if the prompt is ignored, the client is modified, or a tool call arrives late.
- The rules are auditable as a table. `TRANSITIONS` and `TOOL_STATES` read as a specification, which is directly useful for the ISO 27001 gap assessment and the requirements doc: "which tools can run after an escalation" is answered by reading nine lines, not by tracing five handlers.
- Every escalation and stage change is timestamped in `record.history` without any handler remembering to log.
- The safety-critical paths are testable without a running server, because they live in `runtime.ts` rather than in Express route bodies. `machine.test.ts` asserts structural invariants over the whole table (`red_flag` reachable from everywhere but `alert`; no tool permitted from any closing state), so those properties survive future edits to the table rather than only being spot-checked.
- Frontend and backend cannot disagree about what states exist.

**What it costs**

- A third workspace package and a two-mode consumption story (compiled for backend, source-aliased for frontend). The backend's `dev`/`build`/`test` scripts must rebuild `shared/` first, and editing `shared/` while the backend dev server runs requires a restart — a documented footgun.
- Adding a stage is a multi-file change: state, transitions, tool permissions, an `instructionsFor` branch, and frontend display handling. This is deliberate — the compiler enumerates the sites — but it is not a one-line change.
- Two round trips per turn in the worst case (tool call, then safety check), and the model briefly holds stale instructions between the transition and the relayed `session.update`. Acceptable because server-side authorization does not depend on the model having caught up.
- State is in-memory per session (`intakeStore.ts`), so it does not survive a backend restart and does not scale past one process. Correct for a prototype; a durable store is the obvious follow-up and the `applyEvent` seam is where it would go.

## Alternatives considered

**Prompt-only control (the status quo ante).** One large system prompt describing all the stage rules. Rejected: the model drifted into intake during verification, and nothing prevented a tool call after finalize. Prompts express intent; they do not enforce it. Retained as a *layer* — state-specific instructions still exist — but not as the boundary.

**Per-handler guards without a machine.** Keep `if (!record.verified) return error` in each tool. Rejected: no shared concept of "the call is closed," so each new terminal condition means auditing every handler, and the rules can't be read in one place.

**Frontend-owned state.** The browser already holds the data channel and knows the conversation turn-by-turn, so it is the tempting place to sequence stages. Rejected outright: it puts the clinical-safety boundary in the least trustworthy component and makes the server's records only as good as the client's honesty.

**A state machine library (XState or similar).** Rejected as overweight for six states and five events. The hand-rolled table is ~90 lines with no dependency, is trivially serializable into the audit trail, and — because it is plain data — can be asserted over structurally in tests. Worth revisiting if the machine grows guards, parallel regions, or timed transitions.

**Duplicating types across backend and frontend.** Rejected; that is the drift this ADR exists to prevent.

## Verification

- `backend/src/machine.test.ts` — transition table correctness, the `red_flag`-from-everywhere invariant, `alert` as sink, no tools in closing states, `applyEvent` refusal + audit-trail append.
- `backend/src/tools/gating.test.ts` — the 409 path through `runTool`.
- `backend/src/safety/scan.test.ts` — red-flag scanner coverage feeding the independent escalation path.
- `npm test` runs all of the above.
- `docs/state-machine.html` renders the transition table as a diagram.
