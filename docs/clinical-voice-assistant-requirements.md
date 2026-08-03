# Clinical Voice Intake/Triage Assistant — Requirements

## Scope

Patient-facing voice assistant that conducts a pre-visit intake/triage conversation, extracts a structured clinical summary for care-team review, and escalates immediately on emergency red flags. Explicitly **not** diagnostic — it collects and structures information for a clinician, it does not advise or treat.

Current phase: prototype using synthetic/de-identified data, architected for HIPAA-readiness so real PHI can be introduced later without a rewrite.

## Functional Requirements

### Conversation & intake

- Voice in / voice out with a live text transcript (extends the existing WebRTC realtime pattern).
- Structured extraction: as the patient talks, the agent populates a structured intake record (chief complaint, onset, duration, severity, associated symptoms, allergies, current medications, relevant history) via tool calls — the same mechanism as the mocked `get_weather` tool, but calling things like `record_symptom`, `record_allergy`, `finalize_intake`.
- Guided, branching questioning driven by an intake protocol, not open-ended medical advice — the model asks follow-ups based on what's missing from the structured record.
- End-of-session structured summary handed to clinical staff for review — this is the actual deliverable, not the raw transcript.
- Explicit non-diagnostic framing: consent/disclaimer at session start ("this collects information for your care team, it does not diagnose or treat").
- Text-only fallback path for patients who can't or won't use voice (accessibility, noisy environments).

### Safety (non-negotiable)

- Red-flag / emergency detection (chest pain, breathing difficulty, stroke symptoms, suicidal ideation, etc.) interrupts normal intake flow and redirects the patient to emergency services or a human immediately.
- Detection must not depend solely on the conversational LLM noticing — see the defense-in-depth requirement below.

## Non-Functional Requirements

### Safety & compliance posture

- Architected for HIPAA-readiness now, even though real PHI isn't flowing yet: no plaintext PHI-shaped data in logs, encryption in transit/at rest, a swappable AI-provider layer so a BAA-covered endpoint can replace direct OpenAI later without a rewrite.
- Red-flag detection runs twice, independently: once as a model-driven check, once as a deterministic/rule-based check server-side on the transcript. An LLM missing an emergency is the failure mode to design hardest against — false positives (over-escalating) are the safe failure direction, false negatives are not.
- Regulatory boundary: staying "collects/structures information for a clinician to review" rather than "advises/diagnoses" is what keeps this out of FDA SaMD territory. That boundary should be enforced architecturally (fixed intake schema + escalation rules), not left to prompt wording alone.

### Reliability & performance

- Low end-to-end voice latency (sub-second response start) for the conversation to feel natural.
- Graceful degradation: if the realtime voice pipeline fails mid-session, fall back to text rather than dropping the patient silently.
- Stateless backend sessions so concurrent patients don't interfere with each other and horizontal scaling is trivial.

### Data handling

- Persistence is now required (unlike the original weather-tool MVP's "no DB yet"): at minimum, session transcript, structured intake record, and an audit trail of tool calls/escalations.
- Defined retention/deletion policy from day one, even for synthetic data, so it's a policy decision rather than a later retrofit.
- Append-only audit log of session events (escalations, tool calls, summary generation) — the artifact that matters most once real PHI arrives.

### Security

- Same server-side-secret pattern already in place: API keys never reach the browser.
- Basic access control on the clinician-facing summary/review surface, even at prototype stage.
- Input validation and sandboxing on any tool the model can call, since tool calls are effectively remote-executed model output.

### Observability & testability

- Metrics/tracing on latency, tool-call failures, and escalation trigger rate — a safety-relevant metric to watch, not just an engineering one.
- A library of scripted synthetic patient scenarios (including red-flag scenarios) runnable as regression tests before any change ships, since conversation-flow regressions here are a safety issue, not just a UX one.
