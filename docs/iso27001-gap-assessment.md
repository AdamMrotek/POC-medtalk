# ISO/IEC 27001:2022 — Gap Assessment

**Status:** Internal working document — not for external distribution
**Assessment date:** 2026-08-10
**Assessed system:** Headache Intake Assistant (prototype) — `backend/`, `frontend/`
**Driver:** Customer/procurement requirement for certification
**Owner:** TBD

> ⚠️ **Do not send this document to a customer.** It contains an unremediated findings
> register. Section 9 contains the externally shareable position; use that instead.

---

## 1. Purpose and audience

This document records the gap between the current state of the Headache Intake Assistant
and the requirements of ISO/IEC 27001:2022, so that:

1. Engineering has a prioritised remediation backlog.
2. The eventual **Statement of Applicability (SoA)** has a factual starting point.
3. Sales/leadership can answer the customer's security questionnaire honestly while
   certification is in progress.

It is a gap assessment, not an SoA and not an internal audit. Those are separate
deliverables produced later (see §8).

## 2. Standards framing

A recurring misconception worth settling early:

- **ISO/IEC 27000** is the vocabulary document. It is not certifiable.
- **ISO/IEC 27001** is the certifiable standard. It certifies an *organisation's*
  Information Security Management System (ISMS) — a set of governance processes — **not a
  codebase or a product**. No amount of work in this repository alone produces a
  certificate.
- **ISO/IEC 27002** is implementation guidance for the Annex A controls. Not certifiable.
- **ISO/IEC 27701** extends 27001 to privacy/PII management. Given this system is designed
  to process patient health data, 27701 should be treated as in scope from the start
  rather than bolted on later.

Approximately 70% of the certification effort is management-system evidence that lives
outside this repository: scope definition, risk assessment, policies, supplier management,
internal audit, and management review. The technical findings in §5 are necessary but far
from sufficient.

**Important limitation:** ISO 27001 certification does **not** discharge HIPAA or GDPR
obligations. A hospital customer asking for ISO 27001 will almost certainly also require a
Business Associate Agreement (HIPAA) and/or an Art. 28 Data Processing Agreement and Art. 9
lawful basis for special-category health data (GDPR). Certification is evidence of good
process; it is not a legal safe harbour. See §7.

## 3. Proposed ISMS scope

Certifying a prototype is unusual and generally inadvisable — prototypes change too fast to
hold stable evidence, and the certificate would be near-worthless to a hospital buyer.

**Recommended scope statement (draft):**

> The information security management system covering the design, development, operation
> and support of the [Company] clinical voice intake service, including all supporting
> cloud infrastructure, third-party processors, and personnel with access to production
> systems or patient data. Delivered from [locations].

Under this scope the prototype is **not** an in-scope production system; it inherits the
secure-development controls (A 8.25–8.34) rather than being audited as a live service.
This matters: several findings below are acceptable in a prototype but would be blocking
defects in an in-scope production service. They are recorded now so they are never
inherited by the production build.

**Decision required:** confirm scope boundary before any SoA work begins. Everything
downstream derives from it.

## 4. Current posture — what already holds up

Recording these so credit is not lost during audit, and because several are directly
answerable on a customer questionnaire today.

| Area | Evidence | Relevant control |
|---|---|---|
| API credentials never reach the browser; backend mints short-lived ephemeral keys | `backend/src/index.ts` `POST /api/session` | A 8.24, A 5.17 |
| No secrets committed to version control (`backend/.env` gitignored; `git ls-files` confirms only `.env.example` tracked) | `backend/.gitignore:3` | A 8.4, A 5.17 |
| Defence-in-depth on clinical safety: model-driven escalation **plus** independent deterministic keyword scan | `backend/src/safety.ts`, `POST /api/safety-check` | A 8.27 |
| Authorisation gate between conversation stages — intake tools rejected until identity verified | `backend/src/index.ts:114` | A 8.3 |
| Verification attempt limiting (3 attempts, then lockout) | `backend/src/tools/index.ts` `verify_identity` | A 8.5 |
| CORS restricted to a single configured origin rather than wildcard | `backend/src/index.ts:9` | A 8.20 |
| Documented non-functional security requirements exist and predate this assessment | `docs/clinical-voice-assistant-requirements.md` | A 8.26 |
| Transport to the AI provider is TLS/DTLS-encrypted (HTTPS + WebRTC) | `useRealtimeConversation.ts` | A 8.24 |

## 5. Findings register

Severity reflects risk **in a production service processing real patient data**, which is
the state the customer is buying. Several are lower-risk in the current synthetic-data
prototype; the "Prototype risk" column makes that distinction explicit.

### F-01 — No authentication on any API endpoint

| | |
|---|---|
| **Severity** | Critical |
| **Prototype risk** | High (cost abuse is live today) |
| **Controls** | A 5.15, A 8.2, A 8.3, A 8.5 |
| **Location** | `backend/src/index.ts` — all routes |

Every endpoint is unauthenticated. `POST /api/session` mints an OpenAI ephemeral key on
each call, so any party who can reach the service can spend account credit indefinitely.
`POST /api/tools/:name` and `POST /api/safety-check` accept any well-formed `sessionId`.

There is no concept of a user, a caller identity, or a role anywhere in the codebase. This
also means the clinician-facing review surface described in the requirements document has
no access control design to inherit — the requirements doc calls for "basic access control
on the clinician-facing summary/review surface, even at prototype stage."

**Remediation:** introduce an authentication layer before any production build. Minimum:
authenticated session establishment, caller identity bound to the intake record, and
role separation between patient-facing and clinician-facing surfaces. Rate-limit
`/api/session` regardless.

---

### F-02 — Identity verification lockout is bypassable

| | |
|---|---|
| **Severity** | High |
| **Prototype risk** | Low (synthetic demo patient only) |
| **Controls** | A 8.5, A 5.16 |
| **Location** | `backend/src/tools/index.ts` — `verify_identity`, `MAX_VERIFICATION_ATTEMPTS` |

The 3-attempt lockout is tracked per session (`record.verificationAttempts`). Because
session creation is unauthenticated and unlimited (F-01), an attacker defeats the lockout
by requesting a new session after every third attempt.

The verification secret is also weak: date of birth plus the last 3 digits of a phone
number. The 3-digit component has a 1-in-1000 keyspace, and DOB is frequently obtainable
from other sources. Comparison is a non-constant-time string equality.

**Remediation:** track failed attempts against the *identity being asserted*, not the
session; add global and per-identity rate limiting; use constant-time comparison; revisit
the knowledge-factor design with the clinical stakeholder before production.

---

### F-03 — Mass assignment in `update_intake` tool handler

| | |
|---|---|
| **Severity** | High |
| **Prototype risk** | Medium |
| **Controls** | A 8.28, A 8.26 |
| **Location** | `backend/src/tools/index.ts` — `update_intake` handler |

The handler passes caller-supplied arguments straight into the record:

```ts
handler: (args, sessionId) => {
  return updateRecord(sessionId, args as Record<string, string>);
}
```

`updateRecord` spreads these over the existing record (`{ ...existing, ...fields }`), so
any key can be written — including control fields the schema never declares: `verified`,
`stage`, `finalized`, `emergency`, `sessionId`. Clearing `emergency` would silently
suppress a triggered clinical escalation. Overwriting `sessionId` corrupts the store's
key-to-record mapping.

The `as Record<string, string>` cast defeats the type system rather than validating. The
declared JSON schema in `parameters` is sent to the model as guidance but is **never
enforced server-side**.

This directly contradicts a stated requirement: *"Input validation and sandboxing on any
tool the model can call, since tool calls are effectively remote-executed model output."*

**Remediation:** validate every tool payload against its declared schema at the boundary
(zod or equivalent), and allow-list writable fields in `updateRecord`. Control fields
(`verified`, `stage`, `emergency`, `finalized`, `sessionId`) must only be settable by
their dedicated handlers.

---

### F-04 — No audit log

| | |
|---|---|
| **Severity** | Critical |
| **Prototype risk** | High |
| **Controls** | A 8.15, A 8.16, A 5.28, A 5.33 |
| **Location** | backend-wide — only `console.log` on startup exists |

There is no record of who did what, when. No log of tool invocations, verification
attempts and outcomes, emergency escalations, session creation, or access to intake
records. Nothing is retained after process exit.

The requirements document already identifies this as the single most important artefact:
*"Append-only audit log of session events (escalations, tool calls, summary generation) —
the artifact that matters most once real PHI arrives."*

Without it, A 5.28 (collection of evidence) is unachievable, incident investigation is
impossible, and the customer's own audit obligations cannot be met — a hospital will
generally require an access log over patient records as a contractual term.

**Remediation:** append-only, tamper-evident event log with actor, action, subject,
timestamp and outcome. Must exclude clinical free-text (see F-06). Retain per the policy
established in F-05.

---

### F-05 — No persistence, no retention or deletion policy

| | |
|---|---|
| **Severity** | High |
| **Prototype risk** | Medium |
| **Controls** | A 8.10, A 8.13, A 8.14, A 5.33 |
| **Location** | `backend/src/intakeStore.ts` — `const sessions = new Map<...>()` |

Intake records live in a process-local `Map`. Consequences:

- **No deletion mechanism.** Records are never expired or purged; the map grows unbounded
  for the process lifetime. There is no way to service a data subject erasure request
  (GDPR Art. 17) or an equivalent HIPAA request. A 8.10 cannot be satisfied.
- **No retention policy** of any kind — the requirements doc asks for one "from day one,
  even for synthetic data, so it's a policy decision rather than a later retrofit."
- **No backup and no durability.** A restart destroys all in-flight clinical data,
  including triggered emergency flags. A 8.13 unachievable.
- **Contradicts the stated architecture.** The requirements doc specifies "stateless
  backend sessions so concurrent patients don't interfere with each other and horizontal
  scaling is trivial." Process-local state makes horizontal scaling incorrect, not just
  hard — a second instance cannot see the first's sessions.
- **No session expiry.** Sessions remain valid indefinitely.

**Remediation:** move to durable encrypted-at-rest storage; define and enforce a retention
schedule; implement hard deletion; add session TTL; document the backup and restore
procedure and test it.

---

### F-06 — Clinical free-text exposed in the event log surface

| | |
|---|---|
| **Severity** | Medium |
| **Prototype risk** | Medium |
| **Controls** | A 8.11, A 8.12, A 8.15, A 5.34 |
| **Location** | `frontend/src/useRealtimeConversation.ts` — `logDataChannelEvent`, `dataChannelLog` |

Every data-channel event is captured with its payload and rendered in the UI, including
patient transcript content and the arguments to `verify_identity` — i.e. the asserted date
of birth and phone digits.

`truncateLargeStrings` caps strings at 200 characters. **Truncation is not redaction:** a
date of birth, a phone fragment, and most clinically sensitive utterances are well under
200 characters and pass through intact.

The requirements document states the target explicitly: *"no plaintext PHI-shaped data in
logs."* The current implementation does not meet its own bar.

**Remediation:** redact by field, not by length. Verification arguments should never be
logged. Gate the developer event-log panel behind a build flag so it cannot ship to a
patient-facing or clinician-facing production build.

---

### F-07 — Upstream provider error bodies returned to the client

| | |
|---|---|
| **Severity** | Low |
| **Prototype risk** | Low |
| **Controls** | A 8.28 |
| **Location** | `backend/src/index.ts:78` |

```ts
res.status(upstream.status).json({ error: `OpenAI session creation failed: ${body}` });
```

The raw upstream response body is forwarded to the browser, disclosing provider-side detail
(account state, model configuration, quota and organisation identifiers) to an
unauthenticated caller. `POST /api/tools/:name` similarly returns internal exception
messages.

**Remediation:** log the detail server-side with a correlation ID; return a generic error
plus that ID to the client.

---

### F-08 — AI provider not abstracted; no supplier assurance

| | |
|---|---|
| **Severity** | High |
| **Prototype risk** | Medium |
| **Controls** | A 5.19, A 5.20, A 5.21, A 5.22, A 5.23 |
| **Location** | `frontend/src/useRealtimeConversation.ts` — `https://api.openai.com/...` hardcoded |

Patient audio streams **directly from the browser to OpenAI**, bypassing the backend
entirely. The provider endpoint is hardcoded in frontend code, so there is no seam at which
to substitute a BAA-covered or in-region endpoint.

The requirements document anticipates exactly this: *"a swappable AI-provider layer so a
BAA-covered endpoint can replace direct OpenAI later without a rewrite."* That layer does
not exist.

Supplier-side gaps, all currently unaddressed: no supplier security assessment, no signed
BAA or DPA, no zero-data-retention commitment, no documented sub-processor list, no data
residency determination, no defined exit plan. A 5.19–5.23 are among the controls a
hospital procurement team scrutinises most closely, because your processors become their
processors.

**Remediation:** introduce a provider abstraction; execute BAA/DPA with zero-retention
terms before any real patient data flows; add all processors to a supplier register with
review dates; determine and document data residency.

---

### F-09 — No CI, dependency scanning, security testing, or tests of any kind

| | |
|---|---|
| **Severity** | High |
| **Prototype risk** | High |
| **Controls** | A 8.8, A 8.9, A 8.25, A 8.29, A 8.31, A 8.32 |
| **Location** | repo-wide — no CI configuration, no test files |

There is no automated pipeline, no `npm audit` gate, no SAST, no dependency update
mechanism, and no test suite. There is no evidence trail that any change was reviewed or
tested — A 8.32 (change management) has nothing to audit.

This is a clinical safety issue as well as a security one. The requirements document asks
for *"a library of scripted synthetic patient scenarios (including red-flag scenarios)
runnable as regression tests before any change ships, since conversation-flow regressions
here are a safety issue, not just a UX one."* A regression that stops `flag_emergency`
firing would currently ship undetected.

`backend/tsconfig.tsbuildinfo` is present in the working tree and should be confirmed as
ignored (A 8.9, configuration hygiene).

**Remediation:** CI on every PR running build, lint, dependency audit and tests; branch
protection and mandatory review; the red-flag scenario suite as a release gate; automated
dependency updates; documented environment separation.

---

### F-10 — No transport hardening, security headers, or rate limiting

| | |
|---|---|
| **Severity** | Medium |
| **Prototype risk** | Low |
| **Controls** | A 8.20, A 8.21, A 8.24, A 8.6 |
| **Location** | `backend/src/index.ts` — Express app configuration |

No HTTPS enforcement or HSTS, no security headers (`helmet` or equivalent), no request
rate limiting, no request size limits, no timeouts. Combined with F-01 this leaves the
service open to trivial resource exhaustion and, with F-02, to credential brute-forcing.

**Remediation:** enforce TLS with HSTS; add standard security headers and a CSP; apply
per-IP and global rate limits and body size caps.

---

### F-11 — No consent capture or processing record

| | |
|---|---|
| **Severity** | High |
| **Prototype risk** | Medium |
| **Controls** | A 5.34, A 5.31 |
| **Location** | `backend/src/index.ts` — `VERIFICATION_INSTRUCTIONS`; no consent storage |

The agent's opening line — *"Hello, AI assistant calling on behalf of the hospital, do you
have a moment for assessment?"* — discloses the AI caller and asks about timing, but no
consent is ever **recorded**. Nothing persists whether the patient agreed to proceed, was
told the interaction is processed by AI, or was given the non-diagnostic disclaimer.

The requirements document specifies: *"Explicit non-diagnostic framing: consent/disclaimer
at session start."* Currently this exists only as prompt wording, which is neither
guaranteed to be spoken nor evidenced afterwards.

Related unaddressed items: no privacy notice, no lawful-basis determination for
special-category health data, no record of processing activities (GDPR Art. 30), and no
text-only fallback path — the requirements doc lists that as an accessibility requirement,
and an accessibility gap can become a discrimination exposure in a healthcare setting.

**Remediation:** capture and persist explicit consent as a structured, auditable event
before intake begins; enforce the disclaimer architecturally rather than by prompt wording;
produce a privacy notice, lawful-basis assessment, DPIA and Art. 30 record.

---

### Severity summary

| Severity | Findings | Count |
|---|---|---|
| Critical | F-01, F-04 | 2 |
| High | F-02, F-03, F-05, F-08, F-09, F-11 | 6 |
| Medium | F-06, F-10 | 2 |
| Low | F-07 | 1 |

## 6. Annex A control status (all 93 controls)

Status key: **G** = gap, no capability exists · **P** = partial, some capability but not
evidenced or incomplete · **M** = met for current scope · **O** = organisational, outside
this repository and not yet started · **N/A candidate** = likely excludable in the SoA with
justification.

Every control must eventually appear in the Statement of Applicability with an
include/exclude decision and justification. This table is the input to that document, not
a substitute for it.

### A.5 Organizational controls (37)

| Control | Title | Status | Note |
|---|---|---|---|
| 5.1 | Policies for information security | O | No policy set exists |
| 5.2 | Information security roles and responsibilities | O | No named ISMS owner |
| 5.3 | Segregation of duties | O | |
| 5.4 | Management responsibilities | O | |
| 5.5 | Contact with authorities | O | Incl. ICO/regulator breach contacts |
| 5.6 | Contact with special interest groups | O | |
| 5.7 | Threat intelligence | O | |
| 5.8 | Information security in project management | P | Requirements doc is good evidence |
| 5.9 | Inventory of information and associated assets | O | No asset register |
| 5.10 | Acceptable use of assets | O | |
| 5.11 | Return of assets | O | |
| 5.12 | Classification of information | G | No data classification scheme |
| 5.13 | Labelling of information | G | |
| 5.14 | Information transfer | P | TLS in place; no policy |
| 5.15 | Access control | G | **F-01** |
| 5.16 | Identity management | P | **F-02** |
| 5.17 | Authentication information | P | Key handling good; no rotation policy |
| 5.18 | Access rights | G | **F-01** — no roles exist |
| 5.19 | Information security in supplier relationships | G | **F-08** |
| 5.20 | Addressing security in supplier agreements | G | **F-08** — no BAA/DPA |
| 5.21 | Security in the ICT supply chain | G | **F-09** — no dependency assurance |
| 5.22 | Monitoring and review of supplier services | G | **F-08** |
| 5.23 | Information security for cloud services | G | **F-08** |
| 5.24 | Incident management planning and preparation | O | No IR plan |
| 5.25 | Assessment and decision on security events | O | |
| 5.26 | Response to security incidents | O | |
| 5.27 | Learning from security incidents | O | |
| 5.28 | Collection of evidence | G | **F-04** |
| 5.29 | Information security during disruption | O | |
| 5.30 | ICT readiness for business continuity | G | **F-05** |
| 5.31 | Legal, statutory, regulatory requirements | G | **F-11** — no register |
| 5.32 | Intellectual property rights | O | |
| 5.33 | Protection of records | G | **F-04**, **F-05** |
| 5.34 | Privacy and protection of PII | G | **F-06**, **F-11** |
| 5.35 | Independent review of information security | O | |
| 5.36 | Compliance with policies and standards | O | |
| 5.37 | Documented operating procedures | P | README covers dev setup only |

### A.6 People controls (8)

| Control | Title | Status | Note |
|---|---|---|---|
| 6.1 | Screening | O | Background checks for PHI access |
| 6.2 | Terms and conditions of employment | O | |
| 6.3 | Security awareness, education and training | O | Records required as evidence |
| 6.4 | Disciplinary process | O | |
| 6.5 | Responsibilities after termination | O | |
| 6.6 | Confidentiality or NDAs | O | |
| 6.7 | Remote working | O | |
| 6.8 | Information security event reporting | O | |

### A.7 Physical controls (14)

| Control | Title | Status | Note |
|---|---|---|---|
| 7.1 | Physical security perimeters | O | Largely inherited from cloud provider |
| 7.2 | Physical entry | O | |
| 7.3 | Securing offices, rooms and facilities | O | |
| 7.4 | Physical security monitoring | O | |
| 7.5 | Protecting against physical/environmental threats | O | |
| 7.6 | Working in secure areas | N/A candidate | Justify if no secure areas |
| 7.7 | Clear desk and clear screen | O | |
| 7.8 | Equipment siting and protection | O | |
| 7.9 | Security of assets off-premises | O | |
| 7.10 | Storage media | O | |
| 7.11 | Supporting utilities | O | Inherited from cloud provider |
| 7.12 | Cabling security | N/A candidate | Justify via cloud inheritance |
| 7.13 | Equipment maintenance | O | |
| 7.14 | Secure disposal or re-use of equipment | O | |

Cloud-inherited physical controls still require evidence — collect the provider's ISO 27001
certificate and SOC 2 report for the audit file, and record the inheritance explicitly.

### A.8 Technological controls (34)

| Control | Title | Status | Note |
|---|---|---|---|
| 8.1 | User endpoint devices | O | Developer device management |
| 8.2 | Privileged access rights | G | **F-01** |
| 8.3 | Information access restriction | P | **F-01** — stage gate only |
| 8.4 | Access to source code | P | Secrets kept out of VCS; no branch protection |
| 8.5 | Secure authentication | G | **F-01**, **F-02** |
| 8.6 | Capacity management | G | **F-05**, **F-10** |
| 8.7 | Protection against malware | O | |
| 8.8 | Management of technical vulnerabilities | G | **F-09** |
| 8.9 | Configuration management | G | **F-09** |
| 8.10 | Information deletion | G | **F-05** — no deletion mechanism |
| 8.11 | Data masking | G | **F-06** |
| 8.12 | Data leakage prevention | G | **F-06** |
| 8.13 | Information backup | G | **F-05** |
| 8.14 | Redundancy of information processing facilities | G | **F-05** |
| 8.15 | Logging | G | **F-04** |
| 8.16 | Monitoring activities | G | **F-04** — no metrics or alerting |
| 8.17 | Clock synchronisation | P | ISO timestamps used; NTP undocumented |
| 8.18 | Use of privileged utility programs | O | |
| 8.19 | Installation of software on operational systems | O | |
| 8.20 | Networks security | P | CORS restricted; **F-10** |
| 8.21 | Security of network services | P | **F-10** |
| 8.22 | Segregation of networks | O | |
| 8.23 | Web filtering | N/A candidate | Justify in SoA |
| 8.24 | Use of cryptography | P | TLS in transit; no at-rest, no key policy |
| 8.25 | Secure development life cycle | G | **F-09** |
| 8.26 | Application security requirements | P | Documented, not implemented |
| 8.27 | Secure system architecture and engineering principles | P | Defence-in-depth on safety is genuine |
| 8.28 | Secure coding | G | **F-03**, **F-07** |
| 8.29 | Security testing in development and acceptance | G | **F-09** — no tests exist |
| 8.30 | Outsourced development | N/A candidate | If development stays in-house |
| 8.31 | Separation of development, test and production | G | **F-09** |
| 8.32 | Change management | G | **F-09** |
| 8.33 | Test information | P | Synthetic data used — good; undocumented |
| 8.34 | Protection of systems during audit testing | O | |

### Rollup

| Status | Count |
|---|---|
| Met (M) | 0 |
| Partial (P) | 16 |
| Gap (G) | 27 |
| Organisational, not started (O) | 45 |
| N/A candidate | 5 |

No control is currently fully met **with evidence**, which is the standard the auditor
applies. Several are substantively implemented (see §4) but lack the documentation and
records that make them auditable. This is normal at the start of a programme and is not
cause for alarm — but it does mean the timeline in §8 cannot be meaningfully compressed.

## 7. Clause 4–10 status

Annex A is only the control set. The audited backbone is Clauses 4–10, and **none of it
exists yet**. An organisation with perfect controls and no management system fails
certification.

| Clause | Requirement | Status |
|---|---|---|
| 4 | Context of the organisation, interested parties, ISMS scope | Not started — §3 is a draft input |
| 5 | Leadership, policy, roles and responsibilities | Not started |
| 6 | Planning: risk assessment, risk treatment, SoA, objectives | Not started |
| 7 | Support: resources, competence, awareness, documented information | Not started |
| 8 | Operation: risk assessment execution, risk treatment | Not started |
| 9 | Performance evaluation: monitoring, internal audit, management review | Not started |
| 10 | Improvement: nonconformity, corrective action, continual improvement | Not started |

The mandatory documented artefacts are: ISMS scope, information security policy, risk
assessment and treatment methodology, **Statement of Applicability**, risk treatment plan,
security objectives, competence evidence, operational planning records, monitoring results,
internal audit programme and results, management review minutes, and nonconformity and
corrective action records.

Clause 9 is the usual timeline constraint: you cannot audit or review a system that has not
been operating. Certification bodies generally expect **at least three months** of
operating records before Stage 2.

## 8. Roadmap

Assumes a start in August 2026 and a dedicated part-time ISMS owner. The engineering and
governance tracks run in parallel — they are not sequential, and treating them as such is
the most common cause of slipped certification dates.

### Phase 0 — Immediate (Aug 2026)

Defects worth fixing regardless of any certification decision:

- **F-01** authentication and rate limiting on `/api/session` (cost abuse is live today)
- **F-03** schema validation and field allow-listing on tool handlers
- **F-07** sanitised error responses
- **F-06** redact verification arguments from the event log; gate the panel behind a flag

### Phase 1 — Foundations (Sep–Oct 2026)

- **Governance:** appoint ISMS owner; ratify scope (§3); adopt a risk methodology; build
  the initial risk register; draft the core policy set
- **Engineering:** **F-04** audit log; **F-05** persistence, encryption at rest, retention
  and deletion, session TTL; **F-09** CI with dependency audit and the red-flag regression
  suite

### Phase 2 — Controls and suppliers (Nov 2026 – Jan 2027)

- **Governance:** Statement of Applicability across all 93 controls; risk treatment plan;
  incident response plan; business continuity plan; supplier register; awareness training
  delivered and recorded
- **Engineering:** **F-08** provider abstraction and executed BAA/DPA; **F-02** identity
  hardening; **F-10** transport hardening; **F-11** consent capture, DPIA and Art. 30 record

### Phase 3 — Evidence accumulation (Feb–Apr 2027)

Operate the ISMS and generate records. Nothing here can be short-cut — this phase *is* the
evidence. Run the internal audit programme, hold the first management review, close
nonconformities, and commission an external penetration test.

### Phase 4 — Certification (May–Jul 2027)

Select an accredited certification body (verify UKAS/ANAB accreditation — an unaccredited
certificate will not satisfy a hospital procurement team). Stage 1 is a documentation
review; Stage 2 is the full audit, typically 4–8 weeks later. Budget time to close
findings between the two.

**Realistic earliest certification: Q3 2027.** Be direct with the customer about this. A
compressed timeline sold into a procurement process and then missed does more damage than
an honest 12-month plan.

## 9. Externally shareable position

This section — and only this section — is suitable for sharing with the customer or
pasting into a security questionnaire. Everything above is internal.

**Suggested wording:**

> We are implementing an Information Security Management System aligned to ISO/IEC 27001:2022,
> with certification targeted for Q3 2027. Our current programme includes a completed gap
> assessment against all 93 Annex A controls, a prioritised remediation plan, and a defined
> ISMS scope covering the design, development and operation of our clinical voice intake
> service.
>
> Security measures currently in place include: server-side isolation of all API
> credentials with short-lived scoped tokens; encryption in transit for all patient audio
> and data; layered clinical safety controls combining model-driven and deterministic
> rule-based emergency detection; staged authorisation controls within the intake flow;
> and documented security requirements applied from the design phase.
>
> The system is presently a prototype operating exclusively on synthetic data. No real
> patient data is processed. Prior to processing any patient data we will complete
> [list the Phase 1–2 items], and will execute a Business Associate Agreement / Data
> Processing Agreement with all processors in our data path.

**Guidance for whoever handles the questionnaire:**

- The prototype/synthetic-data status is a genuine strength — say it plainly and early. It
  reframes every open gap as "planned before go-live" rather than "unmitigated in production."
- Never claim certification, "ISO 27001 compliant," or "ISO 27001 ready." Auditors and
  procurement teams treat this as a material misrepresentation, and it is the fastest way to
  lose a healthcare deal.
- Expect the customer to ask for a BAA/DPA, a penetration test report, a sub-processor list,
  a breach notification SLA, and evidence of data residency. Only the last is currently
  answerable. Prepare the others in Phase 2.
- If the customer will accept an interim assurance, an independent penetration test report
  plus this remediation plan is usually the strongest available substitute for a certificate.
- Consider asking whether SOC 2 Type I would satisfy the requirement instead. It is
  materially faster to obtain and some US healthcare buyers accept it as an alternative.

## 10. Open decisions

| # | Decision | Needed by | Owner |
|---|---|---|---|
| 1 | Confirm ISMS scope — organisation-wide vs. service-only | Before SoA work | TBD |
| 2 | Confirm the customer's actual requirement — certification, or evidence of programme? | Immediately | TBD |
| 3 | Would SOC 2 Type I satisfy the customer instead? | Immediately | TBD |
| 4 | Include ISO 27701 in scope from the start? (recommended) | Phase 1 | TBD |
| 5 | Jurisdiction — HIPAA, UK/EU GDPR, or both? Determines the legal register | Phase 1 | TBD |
| 6 | AI provider decision — BAA-covered endpoint, or self-hosted? | Phase 2 | TBD |
| 7 | Named ISMS owner with sufficient authority and time allocation | Phase 1 | TBD |

---

**Review cycle:** reassess at the end of each phase and after any material architecture
change. This document is superseded by the Statement of Applicability once that exists.
