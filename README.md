# Headache Intake Assistant (prototype)

A patient-facing voice intake/triage assistant, built as a prototype on synthetic/de-identified data. Press a button, describe your headache over your mic, and the assistant asks step-by-step follow-up questions (onset, location, character, severity, timing, aggravating/alleviating factors, associated symptoms) while a structured intake summary fills in live on screen for the care team to review. Built with a React (Vite) frontend and a thin Node/Express backend.

Under the hood it uses OpenAI's Realtime API over WebRTC. The backend's only job is to mint a short-lived ("ephemeral") session key so the real `OPENAI_API_KEY` never reaches the browser; the browser then talks to OpenAI directly for low-latency audio.

**Structured extraction via tool calls.** The model doesn't just talk — it calls backend tools mid-conversation to record what it's learned:
- `update_intake` — records/merges structured fields as the patient answers
- `flag_emergency` — the model calls this immediately if it hears a red-flag symptom (e.g. "worst headache of my life," neurological symptoms, head trauma), which surfaces an emergency banner in the UI
- `finalize_intake` — closes the session with a short clinician-facing summary

**Safety is defense-in-depth, not just the model's judgment.** Every patient utterance is also scanned server-side by an independent, deterministic keyword check (`backend/src/safety/scan.ts`) for red-flag phrases, so an emergency isn't missed if the conversational model doesn't call `flag_emergency` on its own. Either path sets the same `emergency` state and shows the same banner.

**The backend owns conversation state.** The call is a declared state machine (`shared/src/machine.ts`) — `verification → intake → finalized`, with `alert`, `reschedule` and `locked` as branches — and the server is the only thing that moves it. Tools are authorized against the current state, so intake tools are refused before identity is verified and after an escalation, a lockout, a reschedule or a finalized intake. The browser renders the state the server reports; it never decides one.

This is a prototype: intake records live in an in-memory per-session store on the backend (`backend/src/intakeStore.ts`), not a database, and no real patient data should be used with it. See `docs/clinical-voice-assistant-requirements.md` for the fuller functional/non-functional requirements this is built against.

## Setup

This is an npm workspace: `npm install` once at the repo root installs all three packages.

```bash
npm install
cp backend/.env.example backend/.env
# edit backend/.env and set OPENAI_API_KEY=sk-...  (needs Realtime API access)
cp frontend/.env.example frontend/.env   # defaults already point at http://localhost:3001
```

Then run the two dev servers in separate terminals:

```bash
npm run dev:backend    # http://localhost:3001  (check /health)
npm run dev:frontend   # http://localhost:5173
```

`npm test` runs the backend's safety-critical suite (state transitions, verification lockout, tool gating, red-flag scanner coverage).

> **Note:** the backend consumes `@threepio/shared` as a compiled package, so its `dev`/`build`/`test` scripts rebuild `shared/` first. Editing `shared/` while `npm run dev:backend` is already running won't hot-rebuild — restart it. The frontend reads `shared/src` directly through a Vite alias, so it picks up changes immediately.

### 3. Try it

Open the frontend, click **Start Conversation**, allow microphone access, and describe a (fictional/synthetic) headache. You should hear the AI ask follow-up questions, see both sides of the conversation as text, and watch the **Intake Summary** panel fill in as fields are recorded. Say something like "this is the worst headache of my life" to see the emergency banner trigger. Click **Stop Conversation** to end the session and release the mic.

## Project layout

```
shared/     Declaration layer imported by both sides — and nothing else:
              machine.ts       states, transition table, which tools each state allows
              redFlags.ts      the one red-flag catalog; prompt text is generated from it
              intakeFields.ts  field keys, UI labels, and the schema descriptions
              record.ts        the IntakeRecord contract
backend/    Express server + the enforcement layer:
              POST /api/session       mints ephemeral OpenAI key with the verification-stage config only
              POST /api/tools/:name   authorizes against machine state, then executes (409 if not allowed)
              POST /api/safety-check  independent keyword-based red-flag scan on transcribed patient text
            src/runtime.ts            tool gating + escalation, independent of HTTP (this is what the tests drive)
            src/intakeStore.ts        in-memory per-session record, applyEvent, append-only audit trail
            src/policy/               composable prompt blocks, assembled per state
            src/safety/patterns.ts    the red-flag regexes (server-side only)
frontend/   Vite + React + TS: call button, WebRTC connection, live transcript, intake summary panel, emergency banner
```

Instructions and regexes deliberately stay on the backend. The browser only ever receives the session config for a state the server has already decided the call may enter, and relays it to OpenAI over the data channel.

## Adding a red flag

Add an entry to `RED_FLAGS` in `shared/src/redFlags.ts`. The prompt text, the `flag_emergency` tool description, and the scanner all derive from that one list. `backend/src/safety/patterns.ts` is typed `Record<RedFlagId, ...>`, so the build fails until you decide how (or whether) the new flag can be detected deterministically — a flag left to the model's judgment is declared with an empty pattern rather than quietly omitted. The test suite is keyed the same way, so it also requires a sample utterance.

## Adding a tool

Add an entry to `TOOL_STATES` in `shared/src/machine.ts` declaring which states may call it, then add the implementation to the `tools` registry in `backend/src/tools/index.ts` (name, description, JSON-schema `parameters`, `handler`). Handlers are pure: they receive `(args, record)` and return a `ToolOutcome` describing the state event and field updates, which `applyEvent` then applies. The tool is automatically offered in the states you listed and reachable at `POST /api/tools/<name>` — no frontend changes needed.
