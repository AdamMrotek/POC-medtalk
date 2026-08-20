# UX brief — the clinician dashboard

**Document type:** interface brief / design language exploration
**Status:** for exploration — precedes any component work
**Version:** 0.1 · 2026-08-18
**Reads against:** `pdr-clinical-intake-platform.md` (§8 surfaces, §7.4 buckets), `frontend/src/styles/README.md`

---

## 0. How to read this

**This is the UI-facing half of the PDR.** The PDR decides *what the system does*; this decides
*what a clinician sees when it does it*. It stops short of component specs deliberately — the point
is to fix the vocabulary before anything is drawn, so that the drawings are variations on one
language rather than five negotiations.

The visual system is not open for re-invention. `Clinical Calm` already exists in
`frontend/src/styles/` and its central rule — **restrained neutrals, one accent, no brand colour, so
that anything coloured on screen means something clinical** — is the single most important UX
decision already made. Everything below extends it.

**One deliberate revision, and its consequence.** The accent moves from sky to a **turquoise
gradient**, and the neutral ramp takes a matching teal bias so ground and accent read as one family.
`tokens.css` originally chose sky *specifically* to keep the interactive colour away from green —
*"'the interactive colour' and 'the everything-is-fine colour' must not be confusable in a clinical
UI."* That constraint is still correct, so **green is removed entirely**: `signed` and
`acknowledged` become neutral rows carrying a check, which is what tier 3 (§3) already said they
should be. The working palette is now **turquoise for interactive · amber for attention · red for
the clock · neutral for everything finished** — four colours, three of which mean something is
unresolved.

---

## 1. The whole app, in one page

### 1.1 The arc

Five acts. Everything in the product is a view onto one of them.

```
   ①  DEPLOY            ②  TAKE              ③  RETURN            ④  REVIEW         ⑤  SIGN
   clinician sends      patient talks         system lands it      clinician reads   clinician
   an interview   ──>   to the assistant ──>  in exactly one  ──>  the evidence ──>  commits their
   to a patient         in their own time     bucket               and the draft     name to it

   seconds              minutes                instant              minutes           irreversible
   Surface C            patient entry point    —                    Surface B         Surface B
```

**Act ⑤ is the product.** A signed clinical review by a named registrant, pinned to the exact
record it was written against. Acts ① – ④ exist to make that signature trustworthy. Any UI decision
that makes the signature faster but less considered is the wrong decision.

**Act ② has a sixth, interrupting path.** At any moment the patient may say something dangerous.
That raises an `Escalation` — an obligation on a named human, with a clock, that survives everything
else. It does not wait for act ④. **This is the only thing in the product with its own clock, and
the interface must reflect that asymmetry everywhere.**

### 1.2 Three surfaces, one model

| | Surface | The question it answers | Major axis |
|---|---|---|---|
| **A** | Clinician dashboard | *"What is waiting for me, and who is on my panel?"* | patient-major |
| **B** | Patient profile → interview detail | *"What do we know about this person, and what is outstanding?"* | one person, chronological |
| **C** | Deployment dashboard | *"What did I send, what came back, what needs a human?"* | interview-major |

They are three **query shapes over one model**, not three features. The practical UX consequence:
an interview row rendered on A, B and C must be the same component showing the same facts in the
same order. If they diverge, the surfaces will eventually disagree, and a clinician who catches
them disagreeing stops trusting all three.

### 1.3 Five things the interface must never get wrong

Derived from the PDR's hard requirements; each one is a UI obligation, not an engineering one.

| # | Rule | Where it comes from |
|---|---|---|
| **U-1** | An unacknowledged escalation is visible from every screen, with elapsed time, until a human acknowledges it. | CS-4, K-1 |
| **U-2** | No clinical content — not a count, not a date, not a badge — renders before an active care assignment exists. Search results show identity only. | SEC-2, §8.1 |
| **U-3** | Signing is irreversible and must *feel* irreversible. Corrections supersede; nothing is ever edited. | WF-6, WF-7 |
| **U-4** | Preconditions **refuse**, they do not warn. A blocked deployment is a blocked button with a stated reason, never a dismissible dialog. | WF-3, §8.3 |
| **U-5** | "Why did it do that?" is answerable from the screen — including *"why did it **not** escalate at 04:12?"*. Scan **passes** are visible, not just matches. | S-5, EV-3 |

**U-5 is the one that shapes the interview detail screen and looks like over-disclosure until you
need it.** A transcript that shows only the flags looks calmer and answers nothing.

---

## 2. The clinician dashboard — what has to be on it

### 2.1 The one question

> *"Is anything on fire, what do I owe a decision on, and who is on my list?"*

Answered in that order, and the order is the layout. A dashboard that opens with a chart has
answered a question nobody asked.

### 2.2 Zone map

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  wordmark            Dashboard · Patients · Deployments        ⌘K   avatar   │  chrome
├══════════════════════════════════════════════════════════════════════════════┤
│ ● 2 escalations need acknowledgement       A.M. "chest pain…"  06:41  [ Ack ]│  ZONE A
├══════════════════════════════════════════════════════════════════════════════┤  full bleed
│  Good morning, Dr Hollis                        Thursday 18 August           │
│                                                                              │
│   11             3 1 live          4                                         │  ZONE B
│   NEEDS REVIEW   IN PROGRESS       EXPIRING WITHIN 48H                       │  no cards
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │ Needs review   11 open · 3 urgent   [search…] [sort urgency ↓] [all] │    │  ZONE C
│  ├──────────────────────────────────────────────────────────────────────┤    │
│  │ PATIENT   INTERVIEW      ENDED ↓   OUTCOME      CAPTURED  STATUS     │    │
│  ├──────────────────────────────────────────────────────────────────────┤    │
│  ▌ A.Mitchell Headache v3  04:12     Escalated —  ▓▓▓░░ 9/16 urgent   → │    │
│  ▌ ···· 447   1 sess·voice 6 min ago cardiac flag            06:41      │    │
│  ├──────────────────────────────────────────────────────────────────────┤    │
│  │ J. Okafor  Headache v3   17 Aug    Completed   ▓▓▓▓▓16/16 awaiting → │    │
│  ├──────────────────────────────────────────────────────────────────────┤    │
│  │ showing 1–5 of 11                             ‹ [1] 2 3 ›            │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ┌─── ZONE D ──────────────────┐ ┌─── ZONE E ────────────────────────┐  │
│  │ SCHEDULED CARE CALLS      4 │ │ PATIENT FEEDBACK  opt-in · 5 of 9 │  │
│  │ P. Nowak           8h left  │ │ "The questions were easy to    5  │  │
│  │ Today 16:00 · Headache v3   │ │  follow, I never felt rushed" /5  │  │
│  │─────────────────────────────│ │ P. Nowak · Headache v3 · 17 Aug   │  │
│  │ L. Fernandes      32h left  │ │───────────────────────────────────│  │
│  │ Tomorrow · Medication v2    │ │ "It asked me the same thing    3  │  │
│  │─────────────────────────────│ │  about my dose 3 or 4 times"  /5  │  │
│  │ Manage in Deployments →     │ │ L. Fernandes · Medication v2      │  │
│  └─────────────────────────────┘ │ See all feedback · 4.2 avg →      │  │
│                                  └───────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 2.3 The zones, and what each owes the clinician

| Zone | Contains | Non-negotiable |
|---|---|---|
| **A · Alert rail** | Every unacknowledged escalation assigned to me or to my rota. Patient initials, trigger phrase, raise time, **elapsed clock**, acknowledge action. **It owns the escalation count outright.** | Persistent across every route in the app. Not dismissible. Collapses to a single line when acknowledged, never to nothing until closed. |
| **B · Floating counts** | Needs review · In progress · Expiring soon. Three numbers, **no cards**, aligned to the same left rail as everything below. Each is one indexed predicate (§8.1) and each is a link. | **No escalation count here** — the band above already carries it, with a clock. Two places for one number is two places to disagree. A zero count stays visible and reads "clear". |
| **C · The review table** | The work itself, with room for it: patient + identifier · protocol + version · when it ended and how long ago · **the outcome in a sentence** · capture completeness · status · action. Plus search, sort, protocol filter and pagination. | Urgent rows borrow the alert band's treatment — gradient edge and tint — so the table and the rail read as one system. The outcome column is prose: *"abandoned"* alone is not a handover. |
| **D · Scheduled care calls** | What is out and not yet back: when · who · which protocol version · how long is left. | Two lines per row and no more. This is a glance, not a workspace — Surface C manages these. |
| **E · Patient feedback** | The last five **opt-in** responses — the patient's own sentence, their score, attribution underneath, and a way through to the full list. | Two lines maximum per item. Consent-gated, verbatim, and it measures the protocol rather than the patient (§2.4). Sits beside D: what went out, and what came back. |
| *(chrome)* | Deploy action, global command palette, profile, break-glass entry | Deploying belongs to Surface C; the dashboard carries only the entry point. |

### 2.4 Patient feedback — four rules that come with it

**It is the patient's own words, so the quote leads and the attribution sits underneath.** Two lines
maximum plus a score. This is a pulse, not a transcript — a card that lets one person write a
paragraph stops being something you can read in three seconds.

**One · Consent-gated, and an empty card is normal.** Feedback exists only where the patient agreed
to give it, under its own consent scope alongside `processing` and `recording` (SEC-12). The header
says *"5 of 9 asked"* rather than implying the sample is everyone, and a quiet week renders as
*"nobody has been asked yet"* — not as a broken panel.

**Two · Verbatim, never summarised.** The moment a model rewrites it, it stops being the patient's
feedback and becomes the system's account of it — on the one surface where the patient is supposed
to speak for themselves. Truncate with a *more* affordance; never paraphrase.

**Three · It is patient free text, so it lives inside the perimeter.** It is governed with classes
1–3 and never reaches telemetry, however tempting an aggregate looks in a dashboard a vendor can see
(EV-6). **The score may be a metric; the sentence may not.**

**Four · It measures the protocol, not the patient.** It must never appear on the clinical record,
never influence triage or priority, and never be visible to the model during an interview.
*"It asked me the same thing about my dose three or four times"* is a bug report about a badly
worded field — and this card is the only place anyone would notice the pattern. That is what earns
it a slot beside the schedule rather than a page in an admin console.

**The scores stay neutral in colour.** A 3/5 is not a clinical state, and lending it amber would
spend a status colour the system reserves for work that is owed. The sentence carries the signal;
the number is there to be scanned, not to alarm.

### 2.5 Where the review queue's arrow goes

**Not a card that expands in place, and not the patient profile.** Both are worse than the third
option, and the reasoning generalises to every queue in the product.

An expanding **review card** keeps you in the queue, which is the appeal — but it cannot hold a
transcript, a ledger, four evidence panes and a signature, so it degrades into a preview. **A preview
on a clinical queue is a way to form an impression without reading the evidence**, which is the one
habit the whole evidence architecture exists to prevent. It also gives the signature nowhere
credible to live (U-3).

Routing through the **patient profile** costs a click on every item in a queue you are trying to
drain, and lands on a page whose job is orientation rather than work.

**Build the third:** the arrow opens **interview detail directly**, and interview detail renders
*inside the patient's context* — breadcrumb, care team with expiry, consent state, any open
escalation as a banner, and a **history strip** of that patient's prior interviews across the top.
The overview arrives without the detour, and the full profile is one step up the breadcrumb when it
is actually wanted.

**The history strip is the part that earns this.** *"Is this the third time she has described the
same headache?"* is a question the reviewer needs answered before writing an impression, and it is
exactly what a queue row cannot carry and a modal has no room for.

### 2.6 What is deliberately *not* on this dashboard

Naming them makes them decisions rather than omissions.

- **No charts, no throughput graphs, no "interviews this week".** Class-4 telemetry is an operations
  surface with a different audience and no PHI. Mixing it in makes a clinical screen argue about
  productivity.
- **No clinical content for unassigned patients**, anywhere, at any density (U-2).
- **No "escalated" filter tab.** Escalation is a priority and an obligation, not a lifecycle bucket —
  an escalated interview still lands in *Needs review*, because it needs reviewing most (§7.2).

**Two things were cut after the first pass, and the reasoning is worth keeping.**

**Find a patient moves to Patients**, and takes claim and **Add patient** with it. Search exists only
to reach a profile, so it belongs on the route that has one; on the dashboard it was a second front
door to the same place, and the claim flow it leads into (typed reason, transfer prompt, logged
empty results) needs more room than a single-line bar honestly gives it. The Patients list is a
working roster — patient and identifier · relationship **with its expiry** · last interview and
outcome · next scheduled · open items — which is what the cut panel would have had to become to earn
a screen. **`Add patient` is a registration action, not a search fallback:** it is reachable only
once a search has returned nothing, which is what keeps the duplicate-record path narrow.

**My panel is gone outright.** Sorted by open items it restated the review table; sorted any other
way it was a directory nobody opens a dashboard to read. Its one genuinely unique fact — *who is
idle and overdue a check* — is a filter on Patients, not a panel here. **What replaced it answers a
question the panel never did:** what is out and not yet back.

---

## 3. Information hierarchy — three tiers, and only three

**The hardest thing about this screen is that most of it is normal.** If everything competes, the
one clocked item loses. So the language has exactly three intensities and they are used sparingly.

| Tier | What is in it | Treatment |
|---|---|---|
| **1 · Clocked** | Unacknowledged escalations. One thing only. | **Full-bleed danger gradient spanning the entire layout**, white label, elapsed clock, persistent rail, pulsing dot. It outranks the page beneath it. **Nothing else in the app may look like this.** |
| **2 · Owed** | Needs review, expiring soon, lockouts, delivery failures, faults. | Turquoise or amber accents on an otherwise neutral card. Counts in `--text-primary`, context in `--text-tertiary`. |
| **3 · Ambient** | Panel, history, completed, signed, archived. | Pure neutral. No chroma at all. A signed review is a **calm** row — it is finished. |

**There is no green, and the absence is the point.** *Acknowledged* and *signed* are the two moments
a human closed something, and they are rendered as neutral rows with a check — because a finished
thing should read calm, and because a screen full of green ticks trains the eye to skip them. That
is the muscle which must not be trained here.

---

## 4. The interview row — the atom of the product

It appears on all three surfaces and on the patient profile. Design it once.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  ●   Headache intake v3   ·  18 Aug 04:12  ·  A. Mitchell        [ awaiting  │
│  ↑   ↑                       ↑                ↑                    review ]  │
│  │   │                       │                │                        ↑     │
│  │   protocol + VERSION      when the         patient (initials      lifecycle│
│  │   (pinned; never a        conversation     off-panel; full name    badge   │
│  │   bare protocol name)     ended            on-panel)              (§7.4)   │
│  │                                                                            │
│  urgency dot — the only chroma in the row when nothing is wrong               │
│                                                                              │
│  escalated · chest pain radiating to jaw          14 of 16 fields · 2 sessions│
│  ↑                                                 ↑                          │
│  outcome + trigger excerpt, only when it exists    completeness, always       │
└──────────────────────────────────────────────────────────────────────────────┘
```

Five facts, always in this order, always in these slots: **urgency · what was asked · when · who ·
where it stands.** The second line is context and may be empty. A row that has to be read
left-to-right to be understood is a row that will be misread at 07:40 on a ward round.

**The protocol version is part of the identity of an interview, not metadata.** `severity: 7` is
uninterpretable six months later unless the question asked and the red-flag set armed at the time
are both recoverable — so the version travels on the row, everywhere, at `--text-sm`.

---

## 5. Status vocabulary

One badge set, generated from the lifecycle table (§7.2), used identically on all three surfaces.

| Badge | Lifecycle | Tier | Pill variant |
|---|---|---|---|
| Draft | `draft` | 3 | neutral |
| Scheduled / Invited | `scheduled`, `invited` | 3 | neutral, with countdown when < 48h |
| In progress | `in_progress` | 3 | `pill--accent`, gradient dot when a session is live |
| **Awaiting review** | `awaiting_review` | 2 | `pill--accent` (turquoise) |
| **Urgent · escalated** | `awaiting_review` + open `Escalation` | **1** | `pill--danger`, clocked |
| Needs attention | `needs_attention` (lockout, reschedule, fault) | 2 | `pill--warning` |
| Expired | `expired` | 2 | `pill--warning`, muted |
| In review | `in_review` | 3 | neutral, with the reviewer's name |
| Acknowledged | open `Escalation` closed by a human | 3 | neutral + check |
| Signed | `signed` | 3 | neutral + check, with signer and time |
| Cancelled / Archived | `cancelled`, `archived` | 3 | neutral, `--text-faint` |

**Two of these carry more meaning than they look.** A **lockout** is an operational failure, not a
clinical one — the patient may be perfectly well and simply unable to recall the number on file — so
its copy must not read as patient fault. And an **abandoned** interview is genuine clinical signal:
someone who began describing a headache and stopped is not the same as someone who never started.
The badge for the two must not be the same word.

---

## 6. Interface language — what to explore next

### 6.1 What is already settled (do not relitigate)

Teal-biased neutrals, one turquoise accent gradient, two status hues (amber, red), **no brand
colour and no green** · one typeface, weight carries hierarchy, headings cap at 600 · hairline
structure, no shadows · four contrast-budgeted text tiers, all AA against the *worst-case* surface ·
generous vertical rhythm · one easing curve · the danger gradient never lightens in dark mode,
because the surface that says *call 999* does not get to fail AA for looking better on a dark page.

**Three accent ramps, and the split is a rule rather than a convenience.**

| Ramp | Stops | Contrast with white | Carries |
|---|---|---|---|
| `--grad` | teal-700 → cyan-700 | 5.47 / 5.36 : 1 | primary actions, small marks, anything that must not wash out |
| `--grad-card` | `#0b8478` → `#0a7f8e` → `#0a80a1` | **4.58 / 4.73 / 4.55 : 1** | large filled surfaces carrying white text |
| `--grad-bright` | teal-500 → cyan-400 | — | decorative only: meters, rules. **Never behind text.** |

`--grad-card` sits deliberately at the ceiling. Teal-600 (`#0d9488`) is the prettier stop and lands
at **3.74:1**, so it is out — the card is as light as it can be and still hold AA. Like the danger
gradient, it is **not re-pointed in dark mode**: it carries white text in both themes.

### 6.2 What the dashboard adds — the actual exploration

| Question | The tension | Starting position |
|---|---|---|
| **Density** | The intake screen is one conversation and can breathe. The dashboard is a work queue and cannot. | A second density scale — `--space-2/3` rhythm for rows against `--space-5/6` for panels. One toggle, not per-view. |
| **Tabular type** | Counts, clocks and dates must align down a column and never reflow as digits change. | `font-variant-numeric: tabular-nums` on every number in a list; `--font-mono` for the ledger only. |
| **The clock** | Elapsed time is the most important number on the screen and must not read as a decoration. | Live `mm:ss` under 1h, then `Hh Mm`. Colour escalates with the rota timeout, not with elapsed time in the abstract. |
| **The gradient's reach** | A gradient on every surface is texture; used four times it is a signal. | Spent on the primary action, the sequence markers, the rule accents and one hairline — and nowhere else. |
| **The rail** | Persistent alerts either get ignored or dominate. Both are failures. | Full-bleed band above content, above nav, below the wordmark. Collapsed to one line by default with a count; expands in place. Never a floating toast — a toast that vanishes cannot carry an obligation. |
| **Counts** | A badge count that might be stale is worse than none. | Counts are the *only* live-polled thing on the dashboard, and carry a "as of" that is visible on hover, not a spinner. |
| **The signature moment** | U-3: irreversibility must be felt without being theatrical. | A distinct surface — full-width, `--surface-raised`, the two content hashes shown, a typed name, one primary action and no secondary. Explore this before the composer around it. |
| **Break-glass** | SEC-13: too hard to use and it becomes a shared standing account. | Visible, one step, states its consequences in copy ("this notifies Dr X and is reviewed"), and changes the chrome's colour for the duration of the session. |
| **Motion** | Clinical screens with animation read as unserious; but a new escalation appearing silently is a safety failure. | Motion is reserved for **state that changed while you were looking away**: a new rail item slides and pulses once. Nothing else moves. |

### 6.3 The states that are not the happy path

Draft these *with* the screen, not after. They are where a clinical UI earns trust.

- **Empty** — a clear queue is a positive statement (*"Nothing waiting for review"*), not a blank
  panel with an illustration.
- **Loading** — skeletons that match final row height, so nothing jumps. A count never renders as
  `0` while loading; it renders as nothing.
- **Stale** — the dashboard knows when its own data last refreshed and says so rather than lying
  quietly.
- **Denied** — U-2 refusals explain *which* condition failed and offer the legitimate route (claim
  the patient / break glass), because an unexplained denial is what makes people share logins.
- **Degraded** — a voice interview that fell back to text is a visible fact on the row, not a
  detail in the ledger.

---

## 7. Interaction principles

1. **Refuse, don't warn.** A precondition that fails disables the action and states the reason
   inline. No dismissible confirmations for things that should be impossible (U-4).
2. **Every read is a write.** Opening a patient profile writes to the staff ledger before the page
   renders; revealing audio is its own logged event with its own explicit action. The UI should say
   so once, plainly, and then not nag.
3. **Irreversible actions look different from reversible ones.** Signing, transferring
   responsibility, and breaking glass are the three. They share one treatment and nothing else uses it.
4. **Name the filter.** *"My interviews"* is three different questions — sent by me, assigned to me,
   about my panel — and the UI names all three rather than silently picking one (§8.4).
5. **The clock belongs to the escalation, not to the interview.** An interview is never late; an
   acknowledgement is.

---

## 8. What to draft next

In this order, because each constrains the next:

| # | Screen | Why first |
|---|---|---|
| 1 | **The interview row**, in all five badge states | It is the atom; everything else is a container for it. |
| 2 | **The alert rail**, collapsed and expanded, light and dark | It is the only tier-1 treatment and it must not be arrived at by iteration. |
| 3 | **Dashboard, full** — populated, empty, and denied | Composition falls out of 1 and 2. |
| 4 | **Interview detail** — four panes with scan passes visible | Where U-5 is either satisfied or lost. |
| 5 | **Review composer + signature** | The product's actual output. |
| 6 | **Deployment compose**, with a refused preflight | Where U-4 is demonstrated. |

---

## 9. Open UX questions

| # | Question | Blocks |
|---|---|---|
| **UX-1** | Does the alert rail follow the clinician into the patient profile and interview detail, or is the escalation banner on the profile sufficient there? | rail spec |
| ~~**UX-2**~~ | ~~Is *My panel* on the dashboard?~~ — **closed 2026-08-18: no.** It restated the review table when sorted usefully and was a directory otherwise. Scheduled care calls took the slot; the idle-patient view moves to Patients. | — |
| **UX-7** | Does the review table's search reach the transcript, or only structured fields? Full-text over clinical free text is a powerful feature *and* a new access surface SEC-5 must log. | review table |
| **UX-8** | How far back does the history strip reach, and does it page? A patient with forty interviews needs a different affordance from one with four. | interview detail |
| **UX-9** | Does opening interview detail from the queue write the same staff-ledger entry as opening the profile does, or a distinct one? They are different accesses and the audit should be able to tell them apart. | §7 principle 2 |
| **UX-3** | How is a patient identified on-screen off-panel — initials, partial identifier, or nothing at all? U-2 sets a floor, not the answer. | interview row |
| **UX-4** | Does the dashboard poll, use a live channel, or refresh on focus? Determines whether the "stale" state is common or exceptional. | counts, rail |
| **UX-5** | Mobile: is the clinician dashboard responsive-down, or is the acknowledgement flow the only mobile surface? A rota target at 02:00 is on a phone. | everything |
| **UX-6** | Does the reviewer see the summary draft before or after reading the transcript? Ordering shapes S-3 and can bias the review. | review composer |

**UX-5 and UX-6 are the two that change the shape of screens rather than their styling** — worth
deciding before drafting item 5 above.
