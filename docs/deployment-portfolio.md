# Deployment profile — portfolio / demo

**Status:** proposed
**Architecture:** `docs/voice-architecture.md` — this document assumes it and does not restate it
**Audience:** a hiring manager or interviewer clicking a link, from a phone, once, for four minutes
**Governing constraint:** no PHI exists here, so R-6 is satisfied by the absence of patient data

The scale profiles (`deployment-uk-nhs.md`, `deployment-us-hipaa.md`) are compliance-driven and
expensive. This one is not, and the mistake to avoid is inheriting their shape. **Everything the
other two documents self-host, this profile buys from a vendor**, because the thing being
demonstrated is the architecture, not the operations.

---

## 1. What this deployment is for

It has to do exactly two things:

1. **Answer instantly.** A visitor who waits 30 seconds for a cold start leaves and never sees any
   of the work.
2. **Show both transports side by side.** The interesting claim in `voice-architecture.md` is that
   Realtime is *faster and wrong* — that R-1 and R-2 are not retrofittable. A demo that only runs
   the recommended option asserts this; a demo with a toggle **proves** it.

It explicitly does **not** need: PHI controls, a BAA, GPUs, autoscaling, multi-AZ, drain-on-scale-in,
or self-hosted models. Building those here costs money and reviewer attention and demonstrates
nothing that the architecture and compliance documents don't already say better.

---

## 2. Shape

```
  ┌──────────────────────────── one small always-warm VPS ────────────────────────────┐
  │                                                                                   │
  │   Node process (TypeScript)                                                       │
  │     ├ Express — /api/session, /api/tools/:name, /api/safety-check                  │
  │     ├ LiveKit agent  ── STT / LLM / TTS ──> Groq (single vendor, all three hops)   │
  │     └ intakeStore    ── SQLite on local disk                                       │
  │                                                                                   │
  └───────────────────────────────────────────────────────────────────────────────────┘
        ▲                                    ▲
        │ WebRTC                             │ WebRTC (path B)
        │ (path A: direct to OpenAI)         │
   ┌────┴──────┐                    ┌────────┴─────────┐
   │  browser  │───────────────────>│ LiveKit Cloud    │  free tier
   └───────────┘                    └──────────────────┘
```

**Single vendor for all three hops.** Groq `whisper-large-v3-turbo` · `gpt-oss-120b` ·
`orpheus-v1-english`: 1943ms p50 / 2479ms p95 — the best *tail* of any cascaded configuration
measured, and the tail is what a demo visitor notices. One contract, one API key, one base URL.

**No local models. This is the decision that defines the profile.** Self-hosting whisper and Kokoro
buys the R-6 position (audio never leaves), which is worth a great deal in the scale profiles and
**exactly nothing here**, because the audio belongs to the visitor and there is no PHI. What it
costs is a Python venv, ~2GB of model weights, a GPU-shaped hosting decision, and the espeak-ng
thread-safety fix — all of it to defend a property that does not apply. The server stays a plain
Node process: no weights, seconds to deploy, restartable on a whim.

**LiveKit Cloud, not self-hosted SFU.** The BAA question that forces self-hosting in the scale
profiles is moot here. The free tier covers a portfolio's traffic comfortably, and it removes the
one genuinely fiddly piece of infrastructure (TURN, certificates, UDP port ranges).

---

## 3. Hosting

**Always-warm, ~€4/month VPS.** Hetzner CX22, DigitalOcean or Fly with a min-machines floor — the
provider barely matters. Two properties do:

- **Scale-to-zero must be disabled explicitly.** It is offered by default on Fly, Render and
  Railway, and it is a footgun everywhere it appears: the first request after idle pays process
  start plus provider connection setup, and a portfolio server is idle *by definition* — the visitor
  is always the first request after idle.
- **No GPU, and none needed** — every model is hosted. This is the only profile where the GPU
  question in `voice-architecture.md` §3 simply does not arise.

**Lambda cannot host the call, and the irony is worth stating in the demo.** No inbound UDP, no
process that outlives a request, no per-connection memory — and the session state that matters (one
`AbortController` per turn, the turn generation counter, in-flight TTS text for echo suppression)
has nowhere to live. Cost is not the obstacle; architecture is. Note which way this cuts:
**Realtime is Lambda-shaped, and choosing the correct architecture is what forces a server.** Lambda
remains a fine fit for the stateless endpoints (`/api/session`, `/api/tools/:name`,
`/api/safety-check`) if you ever want them split out; for a demo, don't bother.

**One box, no autoscaling.** Concurrency for this profile is roughly "the number of people looking
at your CV simultaneously". With every model hosted, the Node process is doing I/O only — the
duty-cycle and calls-per-vCPU analysis that dominates the scale profiles has no local inference to
be about.

---

## 4. Cost

| Line | Estimate |
|---|---|
| VPS, always warm | ~€4/mo |
| LiveKit Cloud | free tier |
| Groq, cascaded | ~$0.003/call-minute → **cents per month** at demo volume |
| Realtime path (A/B toggle) | ~$0.10+/call-minute — the reason to cap it (§5) |
| **Total** | **~€4–6/month** |

Realtime is ~30× the per-minute cost of the cascade. At demo volume that is still small, but it is
the only line that can run away if the page is linked somewhere busy — hence the caps below.

---

## 5. Guard rails

Public and unauthenticated, with vendor keys behind it. Four things, none of them elaborate:

- **Session cap per IP** and a **hard wall-clock limit per call** (~5 minutes). A demo conversation
  that has not made its point in five minutes is not going to.
- **Global daily spend ceiling.** Refuse new sessions past it and serve a static "demo limit
  reached" page rather than an error. This is the actual defence against a front-page link.
- **Keys never reach the browser** — unchanged from the existing ephemeral-key pattern; the Realtime
  path already mints short-lived tokens server-side.
- **Synthetic data only, and say so on the page.** The consent line already required by
  `clinical-voice-assistant-requirements.md` does double duty here: it is a demo disclaimer *and* it
  is the deployed evidence that the non-diagnostic boundary is enforced in the product, not just in
  a document.

**`PHI_MODE=false` in this profile, deliberately and visibly.** The flag refusing to start on an
uncovered provider is a feature worth showing; running with it off, with Groq selected, is the
honest configuration — and the fact that flipping it to `true` would *stop the demo booting* is
itself the clearest possible demonstration of what it does.

---

## 6. Storage — the four classes, cheaply

`voice-architecture.md` §4 defines four data classes. All four exist here; none needs infrastructure.

| Class | Where | Retention |
|---|---|---|
| 1 · Audio | Opus files on the VPS disk (or a cheap object store) | **24 hours**, cron-deleted |
| 2 · Ledger | SQLite table, append-only, hash-chained | 7 days |
| 3 · Record | SQLite, projection of class 2 | 7 days |
| 4 · Telemetry | stdout → journald, or a free Sentry/Grafana Cloud tier | 30 days |

**Build all four here even though nothing requires it**, because this is the profile where they are
cheap to get right and the profile where a reviewer can actually see them. A demo that records
audio, replays a ledger and shows a PHI-free error dashboard *is* the architecture argument; the
same four classes described in a document are a claim.

**SQLite is sufficient and appropriate.** The hash-chained ledger, the projection, the append-only
discipline — none of that needs Postgres. Class 2 as a table with a `prev_digest` column
demonstrates tamper-evidence exactly as well as WORM object storage does, at zero cost.

**Class 4 is the one to get structurally right from the start**, because it is the only one that
cannot be retrofitted (`voice-architecture.md` §4). The typed logger, the serializer-boundary
redaction and the PHI-canary test cost an hour here and are impossible to add later once a year of
logs carries transcript fragments. It is also the class a technical reviewer is most likely to
probe, since "we don't log PHI" is the easiest claim in the industry to make and the hardest to
substantiate.

**Retention is aggressive and that is deliberate.** Nothing here is worth keeping, and a portfolio
piece that accumulates strangers' voice recordings indefinitely argues against its own compliance
story. State the retention on the page next to the consent line.

**The restart-resume demo is worth wiring up**, on the LiveKit path only: restart the server
mid-call, reconnect, and the conversation continues from the stored ledger. **On the Realtime path
the same action loses the call, and the audio was never recordable in the first place** — that
contrast is §2 and §4 of the architecture document demonstrated in about eight seconds, which is
more than either will get read.

## 7. Build order

1. Typecheck and run the LiveKit agent — `docs/voice-architecture.md` open decision 2. Nothing else
   in this document can be verified until this is done.
2. `VOICE_PROFILE=groq` — all three hops hosted, no local servers running.
3. Pre-render the emergency scripts and the fixed verification/intake lines at build time. ~400ms
   escalation with no vendor in the loop is both the best latency number available and the most
   safety-relevant thing to show.
4. Deploy to the always-warm box; confirm scale-to-zero is off by leaving it idle an hour and timing
   the next call.
5. Add the A/B transport toggle and the restart-resume demo (§6).
6. Add the caps (§5) *before* the link goes anywhere public.

---

## 8. What this profile deliberately does not prove

State these on the page rather than letting a reviewer assume they were missed — the scale
constraints are documented in the other two profiles, and pointing at them is stronger than
silence:

- Concurrency and autoscaling behaviour. One box, no load test.
- The GPU/CPU question for local STT and TTS. No local models run here.
- Any compliance posture. No BAA, no DPA, no data residency guarantee, no PHI.
- Real-patient STT accuracy. The synthetic fixtures cannot judge it (`voice-architecture.md` §3).
