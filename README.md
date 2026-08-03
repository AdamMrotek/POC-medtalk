# Headache Intake Assistant (prototype)

A patient-facing voice intake/triage assistant, built as a prototype on synthetic/de-identified data. Press a button, describe your headache over your mic, and the assistant asks step-by-step follow-up questions (onset, location, character, severity, timing, aggravating/alleviating factors, associated symptoms) while a structured intake summary fills in live on screen for the care team to review. Built with a React (Vite) frontend and a thin Node/Express backend.

Under the hood it uses OpenAI's Realtime API over WebRTC. The backend's only job is to mint a short-lived ("ephemeral") session key so the real `OPENAI_API_KEY` never reaches the browser; the browser then talks to OpenAI directly for low-latency audio.

**Structured extraction via tool calls.** The model doesn't just talk — it calls backend tools mid-conversation to record what it's learned:
- `update_intake` — records/merges structured fields as the patient answers
- `flag_emergency` — the model calls this immediately if it hears a red-flag symptom (e.g. "worst headache of my life," neurological symptoms, head trauma), which surfaces an emergency banner in the UI
- `finalize_intake` — closes the session with a short clinician-facing summary

**Safety is defense-in-depth, not just the model's judgment.** Every patient utterance is also scanned server-side by an independent, deterministic keyword check (`backend/src/safety.ts`) for red-flag phrases, so an emergency isn't missed if the conversational model doesn't call `flag_emergency` on its own. Either path sets the same `emergency` state and shows the same banner.

This is a prototype: intake records live in an in-memory per-session store on the backend (`backend/src/intakeStore.ts`), not a database, and no real patient data should be used with it. See `docs/clinical-voice-assistant-requirements.md` for the fuller functional/non-functional requirements this is built against.

## Setup

### 1. Backend

```bash
cd backend
npm install
cp .env.example .env
# edit .env and set OPENAI_API_KEY=sk-...  (needs Realtime API access)
npm run dev
```

Runs on http://localhost:3001. Check http://localhost:3001/health.

### 2. Frontend

```bash
cd frontend
npm install
cp .env.example .env   # defaults already point at http://localhost:3001
npm run dev
```

Runs on http://localhost:5173.

### 3. Try it

Open the frontend, click **Start Conversation**, allow microphone access, and describe a (fictional/synthetic) headache. You should hear the AI ask follow-up questions, see both sides of the conversation as text, and watch the **Intake Summary** panel fill in as fields are recorded. Say something like "this is the worst headache of my life" to see the emergency banner trigger. Click **Stop Conversation** to end the session and release the mic.

## Project layout

```
backend/    Express server:
              POST /api/session       mints ephemeral OpenAI key, embeds intake tools + instructions
              POST /api/tools/:name   executes a tool (update_intake, flag_emergency, finalize_intake)
              POST /api/safety-check  independent keyword-based red-flag scan on transcribed patient text
            backend/src/intakeStore.ts  in-memory per-session intake record
            backend/src/safety.ts       red-flag keyword rules
frontend/   Vite + React + TS: call button, WebRTC connection, live transcript, intake summary panel, emergency banner
```

## Adding a real tool

Edit `backend/src/tools/index.ts` and add another entry to the `tools` registry (name, description, JSON-schema `parameters`, and a `handler`). It's automatically included in the session's tool list and reachable at `POST /api/tools/<name>` — no frontend changes needed. Handlers receive `(args, sessionId)`, so a new tool can read/write the same per-session intake record via `backend/src/intakeStore.ts`.
