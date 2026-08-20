# MVP architecture map — phases 1 and 2

**Document type:** build specification
**Status:** for implementation
**Version:** 1.0 · 2026-08-18
**Design of record:** `docs/pdr-clinical-intake-platform.md` — requirement IDs (CS-, IV-, WF-, EV-, SEC-, PRV-, PERF-, OPS-) refer to its §3.

Two phases, each independently shippable:

| Phase | Delivers | PDR phases |
|---|---|---|
| **1 · Spine** | entities in Postgres, login, the authorization seam, deterministic seeding, the whole test harness | P0, P1 (thin), P4 |
| **2 · Flows** | the patient audio view (public, tokenised) and the clinician dashboard (add patient, claim, deploy interview) | P5, part of P9 |

**The voice engine is a module behind a contract** (PDR §5), not part of either phase. Phase 2
consumes it through a **scripted implementation** so the entire patient journey is end-to-end
testable with no microphone, no models, and no vendor spend. Swapping in the real engine is a
configuration change, and that is the point.

---

## 1. The base map

Local development topology. Production differs only in what is behind the engine seam and where
Postgres lives.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  browser                                                                         │
│                                                                                  │
│   /login  /  /patients  /patients/:id  /deploy      │      /i/:token             │
│   ───────────── authenticated app ──────────────────┼──── public patient view ── │
│            (session cookie required)                │   (token only, no cookie)  │
└───────────────────────┬──────────────────────────────────────┬──────────────────┘
                        │ fetch, credentials: include           │ fetch + WebRTC/WS
                        ▼                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│  backend  ·  Express  ·  :3001                                                   │
│                                                                                  │
│   ┌──────────────────────────────────────────────────────────────────────┐       │
│   │ requireSession → requireRole → requirePatientAccess   (SEC-1, SEC-2)  │       │
│   │ every clinical route passes through here. One seam, not thirty.       │       │
│   └───────────────┬──────────────────────────────────────────────────────┘       │
│                   │                                                              │
│   ┌───────────────▼────────┐  ┌──────────────┐  ┌────────────────────────────┐   │
│   │ M2 patients            │  │ M4 interview │  │ M5 engine seam             │   │
│   │ M1 auth + assignments  │  │ orchestration│  │  VOICE_ENGINE=scripted     │   │
│   └───────────────┬────────┘  └──────┬───────┘  │               |cascaded    │   │
│                   │                  │          │               |realtime    │   │
│                   │       brief ─────┼─────────>│  emits event stream        │   │
│                   │       events <───┼──────────│                            │   │
│                   ▼                  ▼          └────────────────────────────┘   │
│   ┌──────────────────────────────────────────────────────────────────────┐       │
│   │ M7 evidence writer — the only thing that writes ledger_entry          │       │
│   └───────────────┬──────────────────────────────────────────────────────┘       │
└───────────────────┼──────────────────────────────────────────────────────────────┘
                    ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│  Postgres 16  ·  :5432  ·  docker compose  ·  ONE database, N schemas             │
│                                                                                  │
│   schema `platform` — shared, no PHI          schema `t_westmoor` — one per tenant │
│     tenant        account                       patient        interview          │
│     membership    auth_session                  care_assignment interview_session │
│     protocol      protocol_version              consent        delivery_attempt   │
│     invite_index  tenant_migration              escalation     review             │
│                                                 ledger_entry   intake_record      │
│                                                 (append-only: no UPDATE/DELETE)   │
│                                               schema `t_dalefield` — same tables   │
│                                                                                  │
│   class 4 telemetry goes to stdout as structured JSON, tagged with a tenant id     │
│   and never containing patient content — it is the only thing that spans tenants   │
└─────────────────────────────────────────────────────────────────────────────────┘
```

**Three boundaries in that picture are load-bearing and everything else is plumbing:**

The **tenant boundary** — every clinical query runs inside one tenant's schema, chosen from
server-held state before the query is built (§4.2). Isolation is physical: reaching another tenant's
data requires being in the wrong schema, not forgetting a `WHERE` clause.

The **authorization seam** — every clinical route passes `requireSession → resolveTenant →
requireRole → requirePatientAccess`. Reproducing the check inside handlers is the failure this design
exists to prevent, and a test enumerates the route table to prove none escapes it.

The **engine seam** — the backend hands the engine an `InterviewBrief` and consumes an event stream.
It never reaches inside. In phase 2 the engine is a fixture player; the calling code cannot tell.

---

## 2. Stack decisions

| Concern | Choice | Why, and what was rejected |
|---|---|---|
| Database | **Postgres 16** | Partial unique indexes enforce two invariants declaratively (one responsible clinician, one open interview) that would otherwise be application race conditions. SQLite cannot. |
| Tenancy | **schema per tenant, one database** | Physical isolation with cross-schema FKs and per-tenant dump/drop. Rejected a `tenant_id` discriminator (isolation becomes a `WHERE` clause you can forget) and database-per-tenant (no shared account registry, N pools). §4.2 states the costs. |
| Schema + queries | **Drizzle ORM + drizzle-kit** | TS schema, generated SQL migrations you commit and may hand-edit. Rejected Prisma (codegen daemon, opaque migrations); rejected raw `pg` (12 tables of hand-written mappers). |
| Migrations | **committed SQL files**, applied by drizzle-kit | Grants, triggers and partial indexes are hand-written into the generated file. The SQL is the artifact; the ORM is a convenience. |
| IDs | **UUIDv7, generated in the app** | Time-ordered, so primary-key order is insertion order and pagination is stable. Deterministic in seeds (§4.9). |
| Enums | **`text` + `CHECK`**, values mirrored from `shared/` | Postgres enums are painful to alter. A test reads the constraint from `information_schema` and asserts it matches the TypeScript union — drift becomes a failing test, not a production 500. |
| Timestamps | **`timestamptz`, UTC everywhere** | No local time in the database, ever. |
| Auth | **server-side sessions, httpOnly cookie, argon2id** | Rejected JWT: revocation is the requirement (SEC-1, break-glass, transfer), and a stateless token cannot be revoked. |
| Validation | **zod** at every boundary | Already in use for tool schemas. One parse at the edge; handlers receive typed values (SEC-4). |
| Backend tests | **`node:test` via tsx** | Already the runner. No new framework. |
| E2E | **Playwright** | Real browser, needed for the microphone-permission and WebRTC paths later. |
| Frontend routing | **React Router v7** | Two route trees with different auth postures (§5.2). |
| Server state | **TanStack Query** | Queues poll; cache invalidation after deploy/claim is otherwise hand-rolled in every view. |
| Telemetry | **structured JSON to stdout**, closed field set | EV-6 is a type signature, not a policy: the logger accepts only primitives from a fixed key list. |

---

## 3. Repo layout after both phases

```
shared/src/
  machine.ts          conversation states, transitions, tool permissions   (exists)
  lifecycle.ts        interview lifecycle states + transitions             ← phase 1
  roles.ts            roles, relationships, permission matrix              ← phase 1
  intakeFields.ts     field catalog                                        (exists)
  redFlags.ts         red-flag catalog                                     (exists)
  brief.ts            InterviewBrief + engine event types (PDR §5.2)       ← phase 2
  record.ts / api.ts  wire contracts                                       (exists)

backend/src/
  db/
    schema/platform.ts  shared tables
    schema/tenant.ts    the per-tenant template
    migrations/platform/  committed SQL, applied once
    migrations/tenant/    committed SQL, applied per tenant
    client.ts         pool; the ONLY place `set local search_path` is written
    tenants.ts        registry lookup, provisioning, migration fan-out
  auth/
    password.ts       argon2id hash/verify
    session.ts        issue, resolve, revoke, switch tenant
    middleware.ts     requireSession · resolveTenant · requireRole · requirePatientAccess
  repos/              patients, assignments, interviews, protocols, escalations
  evidence/
    ledger.ts         the ONLY writer of ledger_entry; hash chain
    projection.ts     rebuild intake_record from ledger (EV-4)
  engine/
    contract.ts       brief in, events out
    scripted.ts       fixture player                                       ← phase 2
    cascaded.ts       real engine adapter                                  (later)
    ingest.ts         consumes events → ledger → lifecycle mapping (PDR §7.4)
  routes/             thin: parse, authorize, call a repo, serialize
  seed/
    personas.ts       deterministic clinicians, patients, protocols
    scenarios.ts      one interview per dashboard bucket
    index.ts          npm run db:seed

frontend/src/
  routes/
    public/           Login, PatientInterview (/i/:token)
    app/              Dashboard, Patients, PatientProfile, Deploy, InterviewDetail
  api/                typed fetch client, TanStack Query hooks
  components/         queues, patient search, deploy composer, call surface

e2e/
  fixtures/           seeded database template, auth helpers
  phase1/             auth, authorization, audit
  phase2/             deploy → invite → interview → bucket
```

---

# PHASE 1 · The spine

## 4.1 Scope and exit criteria

**In:** all tables, migrations, seed data, login/logout/session, the authorization seam, the ledger
writer, read-only APIs for patients and assignments, the full test harness.

**Out:** any interview UI, any voice, delivery/notification, review signature.

**Exit criteria — all must be demonstrable:**

1. `npm run db:reset && npm run dev` produces a working app with realistic data in under 30 seconds.
2. A clinician can log in, and every clinical route rejects an unauthenticated request — proven by a
   test that enumerates the route table rather than by inspection.
3. An unassigned clinician receives 403 for a patient, **and the attempt is in the staff ledger**.
4. Claiming a patient works; claiming `responsible` where one exists transfers rather than duplicates
   — enforced by a database constraint, not application logic.
5. `ledger_entry` cannot be updated or deleted by the application role.
6. **Two tenants exist locally, and a clinician in one cannot reach anything in the other** — proven
   by a test that runs every read route against a foreign resource and asserts 404.
7. `npm run tenant:create` provisions a schema, runs the tenant migration set, and the new tenant is
   immediately usable.
8. The whole suite runs green in CI against a real Postgres.

## 4.2 Tenancy — one schema per tenant, one database

**Decided; this resolves PDR open decision O-1.**

**Read as:** a Postgres **schema per tenant**. Every tenant gets its own copy of the clinical tables
inside its own namespace, all in one database behind one connection pool. (The other possible reading
— one schema with suffixed table names, `patient_westmoor` — is rejected outright: it turns every
migration into string manipulation and defeats every tool that expects a stable table name.)

### What this buys, and what it costs

**Buys:**

- **Isolation is physical, not conditional.** A cross-tenant leak requires being in the wrong schema,
  not forgetting a `WHERE` clause. In a DPIA conversation that is a materially shorter answer, and it
  is the reason this is a defensible choice for a clinical product specifically.
- **Per-tenant operations become one-liners.** `pg_dump --schema=t_westmoor` is a backup, an export,
  or an offboarding package; `drop schema … cascade` is erasure of an entire trust.
- **Per-tenant retention and point-in-time restore** without touching anyone else's data.
- **A tenant can be promoted to its own database later** with no table shape changing. That escape
  hatch is free here and expensive under a discriminator column.
- **Cross-schema foreign keys work**, because it is one database — tenant tables reference the shared
  account registry with real referential integrity rather than an application-level join.

**Costs, stated plainly because they land on the build:**

- **Migrations fan out.** Every change runs N times, and a partial run leaves tenants on different
  versions. §4.6 turns that into a refuse-to-serve condition rather than a mystery.
- **Every query needs a resolved `search_path`** — a new failure mode, and a new class of test.
- **Relation count grows linearly.** ~13 tables plus ~20 indexes ≈ 33 relations per tenant. A few
  hundred tenants is comfortable; thousands is where the catalog and autovacuum start to complain,
  and database-per-tenant is the answer at that point.
- **A schema name is a SQL identifier**, which is the one place tenancy introduces an injection
  surface. See the connection rule below.

For tens to low hundreds of tenants — each an NHS trust or a practice group, each with its own
retention posture and its own IG officer — the trade is clearly favourable. It would not be for a
consumer product with fifty thousand tenants, and that is the condition to re-examine it under.

### The split

**`platform` — one shared schema, no PHI in it, ever:**

| Table | Holds |
|---|---|
| `tenant` | the registry; slug, schema name, status, retention policy |
| `account` | login identity and credentials — **staff, not patients** |
| `membership` | account × tenant × role |
| `auth_session` | includes the session's active tenant |
| `protocol`, `protocol_version` | the clinical content library |
| `tenant_migration` | which migration version each schema is on |
| `invite_index` | token hash → tenant id, so a bare invite link resolves. **A hash and a UUID; nothing else** |

**`t_<slug>` — one schema per tenant:** `patient` · `care_assignment` · `interview` ·
`interview_session` · `intake_record` · `ledger_entry` · `escalation` · `consent` · `review` ·
`delivery_attempt`.

Three consequences of that split are decisions in their own right:

**Login is global; membership is per tenant.** A clinician covering two trusts has one password and
one session with an active tenant on it. The alternative — a clinician row per tenant — means two
credentials for one human, which is precisely how shared logins get created.

**Protocols are global with an optional owner.** The headache protocol is the same clinical content
everywhere, and versioning it per tenant forks it N ways on day one. `owner_tenant_id IS NULL` is the
shared library; non-null is that tenant's private protocol. Interviews hold a cross-schema FK to
`platform.protocol_version`, which is what keeps *"this record was produced by exactly this question
set"* true across the whole estate.

**The invite index is the one shared table that touches a patient-facing artefact**, and it holds a
token hash and a tenant id. It exists so a link on a hostname you don't control still resolves without
searching N schemas.

### Resolving the tenant

One rule: **the schema is chosen before any query runs, from server-held state, never from anything
in the request body.**

| Surface | Resolution |
|---|---|
| Authenticated app | `auth_session.active_tenant_id`, fixed at login (chosen when the account has several memberships). Switching tenant re-issues the session — it is never a header. |
| Public invite | host (`westmoor.app.example/i/:token`), falling back to `platform.invite_index` on the token hash. |
| Background jobs | an explicit tenant argument, one job per tenant. Never a loop that mutates `search_path` between iterations. |

Middleware becomes `requireSession → resolveTenant → requireRole → requirePatientAccess`, and the
route-table test in §4.10 gains `resolveTenant` to its assertions.

### The connection rule — the one thing that must not be got wrong

One pool, and per request, inside a transaction:

```ts
// backend/src/db/client.ts — the ONLY place a search_path is set
await tx.execute(sql`set local search_path = ${sql.identifier(tenant.schema)}, platform`);
```

Three non-negotiables:

1. **`SET LOCAL`, inside a transaction — never a bare `SET`.** A pooled connection that carries a
   `search_path` over from the previous request serves the previous tenant's data to the current one.
   That is the schema-per-tenant catastrophe, and it is a one-word difference in a single line.
2. **The schema name never originates from user input.** It comes from the tenant registry, is
   validated against `^t_[a-z0-9_]{2,30}$`, and is emitted through the driver's identifier quoting —
   never concatenated into a string.
3. **A connection with no tenant resolved must be able to reach nothing.** The default `search_path`
   for the application role is empty, so a query that skipped the step fails loudly with *relation
   does not exist* instead of quietly finding a table in `public`. There is no `public` schema in this
   database; it is dropped in the first migration.

A fourth, at the process level: **`resolveTenant` returns a tenant object, and the query layer takes
that object — not a string, and not an ambient value.** A tenant that is a function argument cannot be
forgotten; a tenant in a request-scoped global can.

---

## 4.3 Entities in the MVP

| Entity | Schema | Phase 1 | Note |
|---|---|---|---|
| `tenant`, `membership` | platform | full | the registry; §4.2 |
| `account`, `auth_session` | platform | full | login is phase 1's reason to exist |
| `protocol`, `protocol_version` | platform | full | shared library; seeded and published in code, no authoring UI (PDR §2.2) |
| `invite_index`, `tenant_migration` | platform | full | resolution and fan-out bookkeeping |
| `patient` | tenant | full | |
| `care_assignment` | tenant | full | the access edge (WF-1, WF-2) |
| `interview`, `interview_session` | tenant | tables + repos | driven by the API in phase 2 |
| `intake_record` | tenant | table + projection | |
| `ledger_entry` | tenant | full, hash-chained | one chain per tenant. **WORM deferred** — hash chain now, object-lock storage at first PHI deployment |
| `escalation` | tenant | table + repo | acknowledgement UI in phase 2 |
| `consent` | tenant | full | gates recording (EV-8) |
| `review` | tenant | table only | unused until phase 3; created now so no later migration touches `interview` |
| `delivery_attempt` | tenant | created in phase 1, written in phase 2 | it is in the tenant template, so no fan-out is needed later |
| Audio (class 1) | — | **deferred** | no capture in the MVP; consent is still recorded so the gate is real when capture lands |

## 4.4 Schema

Two migration sets. `platform/` runs once; `tenant/` runs once **per tenant** (§4.6). Presented as
SQL because the SQL is the artifact — Drizzle generates it, you read and edit it before committing.

### 4.4.1 `platform/0001_init.sql` — shared, no PHI

```sql
create extension if not exists citext;

-- Nothing lives in the default search path. A query that forgot to resolve a tenant must fail,
-- not silently find a table. See §4.2.
drop schema if exists public cascade;
create schema platform;

create table platform.tenant (
  id             uuid primary key,
  slug           text not null unique check (slug ~ '^[a-z0-9-]{2,28}$'),
  schema_name    text not null unique check (schema_name ~ '^t_[a-z0-9_]{2,30}$'),
  display_name   text not null,
  status         text not null default 'provisioning'
                 check (status in ('provisioning','active','suspended','offboarding')),
  retention_days jsonb not null default '{}'::jsonb,   -- per data class (PDR §9)
  created_at     timestamptz not null default now()
);

-- Login identity. Staff only — there is no patient row anywhere in this schema.
create table platform.account (
  id                  uuid primary key,
  email               citext not null unique,
  display_name        text not null,
  registration_number text,                        -- required to sign a review (WF-6)
  password_hash       text not null,
  failed_attempts     int  not null default 0,
  locked_until        timestamptz,
  status              text not null default 'active' check (status in ('active','suspended')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- One human, one password, N tenants.
create table platform.membership (
  id         uuid primary key,
  account_id uuid not null references platform.account(id) on delete cascade,
  tenant_id  uuid not null references platform.tenant(id),
  role       text not null check (role in ('clinician','admin','auditor')),
  granted_by uuid references platform.account(id),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (account_id, tenant_id, role)
);
create index membership_active on platform.membership (account_id) where revoked_at is null;

create table platform.auth_session (
  id               uuid primary key,
  account_id       uuid not null references platform.account(id) on delete cascade,
  active_tenant_id uuid not null references platform.tenant(id),  -- switching tenant re-issues the session
  token_hash       text not null unique,           -- sha256 of the cookie value; the value is never stored
  issued_at        timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  expires_at       timestamptz not null,
  revoked_at       timestamptz,
  user_agent       text,
  ip               inet
);
create index auth_session_active on platform.auth_session (account_id) where revoked_at is null;

-- Clinical content is shared by default; owner_tenant_id non-null means a tenant's private protocol.
create table platform.protocol (
  id              uuid primary key,
  owner_tenant_id uuid references platform.tenant(id),
  slug            text not null,
  name            text not null,
  specialty       text not null,
  created_at      timestamptz not null default now(),
  unique nulls not distinct (owner_tenant_id, slug)
);

create table platform.protocol_version (
  id              uuid primary key,
  protocol_id     uuid not null references platform.protocol(id),
  semver          text not null,
  definition      jsonb not null,   -- fields, red flags, transitions, tool permissions, prompt ids, endpointing
  definition_hash text not null,    -- sha256 over the canonicalised definition
  status          text not null check (status in ('draft','published','retired')),
  published_at    timestamptz,
  published_by    uuid references platform.account(id),
  created_at      timestamptz not null default now(),
  unique (protocol_id, semver)
);

-- A published version is immutable. Without this, every historical record silently changes meaning.
create or replace function platform.protocol_version_immutable() returns trigger as $fn$
begin
  if old.status = 'published' and new.status <> 'retired' then
    raise exception 'protocol_version % is published and immutable', old.id;
  end if;
  return new;
end;
$fn$ language plpgsql;

create trigger protocol_version_no_edit
  before update on platform.protocol_version
  for each row execute function platform.protocol_version_immutable();

-- Which migration version each tenant schema is on (§4.6).
create table platform.tenant_migration (
  tenant_id  uuid not null references platform.tenant(id),
  version    text not null,
  applied_at timestamptz not null default now(),
  primary key (tenant_id, version)
);

-- Lets a bare invite link resolve without searching N schemas.
-- A hash and a tenant id. No patient, no interview — the interview is looked up
-- inside the tenant schema once the search_path is set.
create table platform.invite_index (
  token_hash text primary key,
  tenant_id  uuid not null references platform.tenant(id),
  expires_at timestamptz not null
);
create index invite_index_expiry on platform.invite_index (expires_at);
```

### 4.4.2 `tenant/0001_spine.sql` — applied once per tenant

Run with the schema name bound from the registry, never interpolated from a request:

```sql
-- psql -v schema=t_westmoor -f tenant/0001_spine.sql
create schema if not exists :"schema";
set local search_path = :"schema", platform;
```

```sql
-- ─── patients and the access edge ────────────────────────────────────────────
create table patient (
  id                  uuid primary key,
  mrn                 text not null unique,
  given_name          text not null,
  family_name         text not null,
  date_of_birth       date not null,
  phone               text,
  email               citext,
  preferred_channel   text not null default 'sms' check (preferred_channel in ('sms','email','link')),
  language            text not null default 'en-GB',
  accessibility_needs text,
  status              text not null default 'active' check (status in ('active','inactive')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
-- WF-1: search is by identifier, never by browse. These are the only two supported lookups.
create index patient_by_name_dob on patient (lower(family_name), date_of_birth);

-- Cross-schema FK: real referential integrity to the shared account registry,
-- which is a property of putting every tenant in one database.
create table care_assignment (
  id           uuid primary key,
  patient_id   uuid not null references patient(id),
  clinician_id uuid not null references platform.account(id),
  relationship text not null check (relationship in ('responsible','covering','observer')),
  reason       text not null,                       -- WF-1: not optional, ever
  source       text not null check (source in ('self_claim','delegated','rota','referral')),
  assigned_by  uuid not null references platform.account(id),
  assigned_at  timestamptz not null default now(),
  ends_at      timestamptz,                         -- covering assignments expire by default
  ended_at     timestamptz
);

-- WF-2 enforced by the database, not by a read-then-write in application code.
create unique index one_responsible_per_patient
  on care_assignment (patient_id)
  where relationship = 'responsible' and ended_at is null;

create index assignment_by_clinician on care_assignment (clinician_id) where ended_at is null;
create index assignment_lookup      on care_assignment (patient_id, clinician_id) where ended_at is null;

-- ─── interviews ──────────────────────────────────────────────────────────────
create table interview (
  id                    uuid primary key,
  patient_id            uuid not null references patient(id),
  protocol_id           uuid not null references platform.protocol(id),         -- for the duplicate guard
  protocol_version_id   uuid not null references platform.protocol_version(id),
  deployed_by           uuid not null references platform.account(id),
  assigned_to           uuid not null references platform.account(id),
  lifecycle_state       text not null check (lifecycle_state in (
                          'draft','scheduled','invited','in_progress','awaiting_review',
                          'in_review','needs_attention','signed','expired','cancelled','archived')),
  outcome               text check (outcome in (
                          'completed','escalated','verification_failed','reschedule_requested',
                          'abandoned','expired','cancelled','fault')),
  priority              text not null default 'routine' check (priority in ('routine','urgent')),
  delivery_channel      text not null check (delivery_channel in ('link','sms','email')),
  opens_at              timestamptz not null,
  expires_at            timestamptz not null,
  access_token_hash     text not null unique,       -- the token itself is never stored
  deployment_note       text,                       -- never enters a prompt (PDR §5.3)
  verification_attempts int not null default 0,     -- on the interview, not the session (IV-2)
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  completed_at          timestamptz,
  check (expires_at > opens_at)
);

-- WF-3: a second open invite makes the first one's abandonment unreadable.
create unique index one_open_interview_per_protocol
  on interview (patient_id, protocol_id)
  where lifecycle_state in ('scheduled','invited','in_progress');

create index interview_review_queue on interview (assigned_to, lifecycle_state, priority, created_at desc);
create index interview_deploy_queue on interview (deployed_by, lifecycle_state, expires_at);
create index interview_by_patient   on interview (patient_id, created_at desc);

create table interview_session (
  id                 uuid primary key,
  interview_id       uuid not null references interview(id),
  transport          text not null check (transport in ('cascaded','realtime','text','scripted')),
  conversation_state text not null check (conversation_state in
                       ('verification','intake','alert','reschedule','locked','finalized')),
  started_at         timestamptz not null default now(),
  ended_at           timestamptz,
  termination_reason text,
  client_info        jsonb
);
create index session_by_interview on interview_session (interview_id, started_at);

create table delivery_attempt (
  id           uuid primary key,
  interview_id uuid not null references interview(id),
  channel      text not null check (channel in ('link','sms','email')),
  status       text not null check (status in ('queued','sent','failed')),
  detail       text,
  attempted_at timestamptz not null default now()
);
create index delivery_by_interview on delivery_attempt (interview_id, attempted_at desc);

-- ─── evidence ────────────────────────────────────────────────────────────────
-- Class 2, and it is per tenant: one chain per tenant, verifiable and exportable on its own.
-- Append-only — the application role holds INSERT and SELECT only (§4.5).
create table ledger_entry (
  seq          bigserial primary key,
  at           timestamptz not null default now(),
  subject      text not null check (subject in ('call','staff')),
  interview_id uuid references interview(id),
  session_id   uuid references interview_session(id),
  actor_type   text not null check (actor_type in ('patient','model','system','clinician')),
  actor_id     uuid,                -- platform.account(id) for staff; deliberately not an FK, so
                                    -- an account can be deleted without rewriting history
  kind         text not null,       -- user_turn | assistant_turn | tool_call | transition |
                                    -- escalation | access | assignment | consent | deploy | erasure
  payload      jsonb not null,
  prev_hash    text,
  hash         text not null
);
create index ledger_by_interview on ledger_entry (interview_id, seq);
create index ledger_by_actor     on ledger_entry (actor_id, at desc) where subject = 'staff';

-- Class 3, a projection of the above (EV-4).
create table intake_record (
  interview_id    uuid primary key references interview(id),
  chief_complaint text,
  fields          jsonb not null default '{}'::jsonb,
  built_to_seq    bigint not null default 0,        -- the ledger position this reflects
  updated_at      timestamptz not null default now()
);

create table escalation (
  id               uuid primary key,
  interview_id     uuid not null references interview(id),
  session_id       uuid references interview_session(id),
  source           text not null check (source in ('model','keyword_scan')),
  red_flag_id      text not null,
  trigger_text     text not null,                   -- PHI; same access rules as the transcript
  raised_at        timestamptz not null default now(),
  notified_targets jsonb not null default '[]'::jsonb,
  acknowledged_by  uuid references platform.account(id),
  acknowledged_at  timestamptz,
  disposition      text,
  disposition_note text,
  closed_at        timestamptz
);
create index escalation_open on escalation (raised_at) where acknowledged_at is null;

create table consent (
  id           uuid primary key,
  patient_id   uuid not null references patient(id),
  interview_id uuid references interview(id),
  scope        text not null check (scope in ('processing','recording','retention')),
  method       text not null check (method in ('in_call','web_form','verbal_recorded','paper')),
  granted_at   timestamptz not null default now(),
  withdrawn_at timestamptz
);
create index consent_active on consent (patient_id, scope) where withdrawn_at is null;

-- Created now, unused until phase 3, so no later migration touches `interview`.
create table review (
  id                  uuid primary key,
  interview_id        uuid not null references interview(id),
  author_id           uuid not null references platform.account(id),
  status              text not null check (status in ('draft','signed','superseded')),
  clinical_impression text,
  amendments          jsonb not null default '[]'::jsonb,
  disposition         text,
  risk_rating         text,
  record_version_hash text,
  ledger_head_hash    text,
  signed_at           timestamptz,
  supersedes          uuid references review(id),
  created_at          timestamptz not null default now()
);
create unique index one_signed_review_per_interview
  on review (interview_id) where status = 'signed';
```

**One deliberate non-FK, worth flagging.** `ledger_entry.actor_id` references `platform.account`
conceptually but is not a foreign key. History must survive the deletion of a staff account, and an FK
would either block that deletion or cascade away the audit trail — both wrong answers. The account id
is recorded as a value; the ledger is the thing that outlasts everything else.

**The ledger is per tenant, and that is the right granularity.** One chain per tenant means a trust
can verify and export its own audit trail without any other tenant's data being part of the proof.


## 4.5 Append-only, enforced where it cannot be argued with

The application connects as `app_rw`, which **has no `UPDATE` or `DELETE` on any ledger**. Migrations
run as the owner. Grants are part of the tenant template, so a new tenant cannot be provisioned
without them.

```sql
-- platform/0002_grants.sql
create role app_rw login password :'app_password';
alter role app_rw set search_path = '';        -- §4.2: no tenant resolved ⇒ nothing reachable

grant usage on schema platform to app_rw;
grant select, insert, update, delete on all tables in schema platform to app_rw;
grant usage, select on all sequences in schema platform to app_rw;

-- tenant/0002_grants.sql — runs for every tenant schema
grant usage on schema :"schema" to app_rw;
grant select, insert, update, delete on all tables in schema :"schema" to app_rw;
grant usage, select on all sequences in schema :"schema" to app_rw;

-- EV-2: append-only is a privilege, not a convention. A future bug cannot rewrite history.
revoke update, delete on :"schema".ledger_entry from app_rw;
```

**`alter role app_rw set search_path = ''` is the belt to §4.2's braces.** Even if a code path skips
`SET LOCAL`, there is no default schema for it to land in — the query fails rather than reading
whatever `public` happens to contain.

**Hash chain in `evidence/ledger.ts`, which is the only module that inserts.** Each entry hashes
`(prev_hash, at, subject, interview_id, kind, canonical(payload))`. Writes take an advisory lock on
the interview so concurrent appends cannot interleave and break the chain.

WORM storage is deferred; the chain is not. **The chain detects tampering including by us; WORM
prevents it including by an attacker with database credentials** — the MVP takes the first and
schedules the second for the first deployment holding real data.

## 4.6 Migrations

Two sets, and the second fans out.

```
migrations/
  platform/   0001_init.sql  0002_grants.sql          applied once
  tenant/     0001_spine.sql 0002_grants.sql          applied once per tenant, in registry order
```

```
npm run db:migrate            platform set, then the tenant set for every active tenant
npm run db:migrate:new        generate from schema.ts, then hand-edit before committing
npm run tenant:create -- --slug=westmoor --name="Westmoor Trust"
                              creates the row, creates t_westmoor, runs the full tenant set
npm run db:reset              drop → create → migrate → seed   (refuses if NODE_ENV=production)
```

Drizzle generates; **you read and edit the SQL before committing it.** Triggers, partial indexes and
grants are hand-added, and a generated migration that silently drops one of them is exactly what a
review is for.

**Fan-out has one dangerous failure mode: a partial run.** Tenant 3 of 40 fails and the estate is now
on two different schema versions, with application code that assumes one of them. Three mechanisms,
in order of how much they matter:

1. **`platform.tenant_migration` records the applied version per tenant**, so the estate's state is a
   query rather than an inference.
2. **The application asserts, at boot and on tenant resolution, that the schema version matches what
   the build expects.** A tenant behind the expected version is *refused service* with a clear error
   — the same posture as refusing to start on an uncovered provider (PRV-3). A tenant serving
   requests against a schema the code does not expect is worse than a tenant that is briefly down.
3. **Migrations run per tenant in their own transaction**, so a failure leaves that tenant on the
   previous version cleanly, and the runner reports exactly which tenants moved and which did not.

**Expand-contract is not optional at this shape.** A destructive change (drop a column, tighten a
constraint) must ship as add → backfill → dual-write → cut over → drop, across separate releases,
because the fan-out is not atomic across tenants and never will be.

**New tenants are built by running the migration set, not by copying a schema.** `CREATE SCHEMA …
TEMPLATE` does not exist in Postgres, and cloning via `pg_dump` of a reference schema drifts silently
the first time someone hotfixes production. The set is the definition.

## 4.7 Authentication

Server-side sessions. **Not JWT** — revocation is a requirement here (suspension, transfer,
break-glass expiry), and revoking a stateless token means building a session store anyway, badly.

| Endpoint | Behaviour |
|---|---|
| `POST /api/auth/login` | argon2id verify → resolve memberships → issue session with an active tenant → `Set-Cookie` |
| `POST /api/auth/logout` | set `revoked_at`, clear cookie |
| `GET  /api/me` | account, active tenant, role **in that tenant**, available tenants, panel counts |
| `POST /api/auth/tenant` | switch active tenant: revoke the session, issue a new one |

**Cookie:** `httpOnly`, `Secure` (except localhost), `SameSite=Strict`, `Path=/`, 12-hour absolute
expiry, 30-minute idle expiry refreshed on use. The cookie carries a 256-bit random value; the
database stores only its SHA-256 — a database read cannot impersonate a user.

**Tenant selection at login.** One membership: it is chosen silently. Several: the login response
carries the list and the client posts a choice, which issues the session. **Switching tenant revokes
and re-issues the session rather than mutating it** — so a stolen or replayed cookie is bound to one
tenant for its whole life, and every ledger entry made under it is unambiguous about which tenant it
belonged to.

**Role is per tenant, not per account.** The same person can be a clinician at one trust and an
auditor at another, and `requireRole` reads the membership for the *active* tenant.

**Password policy:** argon2id (memory 64 MB, iterations 3, parallelism 1), minimum 12 characters,
5 failed attempts locks for 15 minutes with `locked_until`. Login responses are constant-shape and
constant-ish time: wrong email and wrong password are indistinguishable.

**Deferred by design:** SSO/OIDC, MFA, password reset by email. The seam is a `verifyCredentials`
function; MFA lands as a second factor in the same flow. Say this out loud in any demo — an
unexplained missing MFA reads as an oversight, a named deferral reads as scope.

## 4.8 The authorization seam

One file. Four middlewares, composed. **The rule from PDR §9.1, verbatim: role permits the action
*and* an active relationship permits this patient** — now preceded by *and the query runs in the right
tenant's schema*.

```ts
// backend/src/auth/middleware.ts
export const requireSession = ...   // cookie → { account, activeTenantId }, or 401
export const resolveTenant  = ...   // registry lookup → req.tenant; opens the tx and SET LOCAL search_path
export const requireRole    = (...roles: Role[]) => ...   // role in the ACTIVE tenant, or 403
export const requirePatientAccess = async (req, res, next) => {
  const ok = await hasActiveAssignment(req.tenant, req.account.id, req.params.patientId)
          || await hasActiveBreakGlass(req.tenant, req.account.id, req.params.patientId);
  await ledger.appendStaff(req.tenant, {     // SEC-5: logged whether or not it succeeded,
    actorId: req.account.id, kind: "access",  // into THAT tenant's chain
    payload: { patientId: req.params.patientId, route: req.route.path, granted: ok },
  });
  return ok ? next() : res.status(403).json({ error: "no_care_relationship" });
};
```

Two properties worth stating because they are what makes this a control rather than a habit:

**The denial is logged, not just the success.** A run of denials from one account is the signal this
exists to produce; logging only grants throws that away.

**A test enumerates the Express route table** and asserts every path under `/api` except the auth and
public routes carries `requireSession` **and `resolveTenant`**, and every path containing
`:patientId` carries `requirePatientAccess`. A new route without them fails CI. Reviewers do not have
to notice.

**Cross-tenant reads are 404, not 403.** Inside the right schema a foreign id simply does not exist,
which is the answer we want anyway: 403 confirms that the resource exists somewhere, and across a
tenant boundary that is itself a disclosure. Within a tenant, 403 remains correct — it says "this
patient exists and you are not on their care team", which is a true and useful thing for a clinician
to be told.

## 4.9 Seeding for local development

`npm run db:seed` — idempotent, deterministic, and **realistic enough that the dashboards are not
empty on first run.** An empty dashboard is untestable and undemoable.

**Two tenants, always.** `westmoor` (the protagonist) and `dalefield` (a second trust with its own
clinicians and patients). **A single-tenant seed makes every isolation bug invisible**, so the second
tenant is not a nice-to-have — it is what the cross-tenant tests in §4.10 run against, and it costs
one extra line in the seed.

**Deterministic IDs.** Every seeded row's UUID is `uuidv5(SEED_NAMESPACE, "westmoor:patient:abbott")`
— tenant-scoped, so the two tenants get genuinely different ids and a test that accidentally passes
one tenant's id to the other fails loudly. Tests reference `IDS.westmoor.patient.abbott`, and
Playwright selectors, URLs and screenshots stay stable across resets.

**Personas:**

| Persona | Role | Purpose |
|---|---|---|
| `okafor@example.test` | clinician @ westmoor | the protagonist; responsible for most seeded patients |
| `lindqvist@example.test` | clinician @ westmoor | covering; used for transfer and cross-panel denial tests |
| `duty@example.test` | clinician @ westmoor | on rota; escalation routing target |
| `admin@example.test` | admin @ westmoor | can manage, cannot read clinical content |
| `auditor@example.test` | auditor @ westmoor | ledger metadata only |
| `bakare@example.test` | clinician @ dalefield | the other tenant; every cross-tenant test's actor |
| `okafor@example.test` | **also clinician @ dalefield** | one account, two memberships — exercises tenant switching and per-tenant roles |

All seeded passwords are `dev-password-1234`, and the seed **refuses to run when `NODE_ENV` is
`production`.**

**Patients — eight, chosen to cover the branches, not to look plausible:**

- one with no care team at all → the search-and-claim flow;
- one responsible to `lindqvist` → the 403 and transfer paths;
- one with an expiring covering assignment → assignment-lapse behaviour;
- one with recording consent, one without → the EV-8 gate;
- one with an accessibility need → the text path;
- three ordinary ones for list rendering.

**Interviews — one per dashboard bucket, which is the actual design goal of the seed.** Every state
in PDR §7.4's mapping table gets a row: `scheduled`, `invited`, `in_progress` (resumable),
`awaiting_review`, `awaiting_review` + unacknowledged escalation, `needs_attention` (lockout),
`needs_attention` (reschedule), `expired` unstarted, `expired` abandoned mid-interview, `signed`,
`cancelled`. Completed ones carry a real ledger — turns, scan passes, tool calls, transitions — so
the interview detail view and the projection rebuild have something true to work against.

**Protocol:** `headache-intake` v1.0.0 published, v1.1.0 draft (so the version picker and the
"unpublished version" preflight refusal are both exercisable).

**Protocols are seeded once, in `platform`**, and both tenants use them — which is the shared-library
arrangement from §4.2 being exercised rather than asserted. `dalefield` also gets one private
protocol, so the `owner_tenant_id` filter has something to hide from `westmoor`.

```
npm run db:seed                  two tenants, demo dataset, the default
npm run db:seed -- --empty       platform + protocols + accounts, no clinical data
npm run db:seed -- --scale=500   500 patients / 3000 interviews in westmoor, for index sanity
npm run db:seed -- --tenants=12  twelve tenants, for migration fan-out timing
```

**`--tenants=12` exists to make fan-out cost visible early.** Migration time and relation count both
grow linearly, and finding that out at twelve tenants on a laptop is much cheaper than finding it out
at forty in production.

## 4.10 Test suite

Six layers. **Cheap and structural at the bottom, expensive and few at the top** — and the bottom
three need neither a browser nor a model, which is why they can gate every commit.

| Layer | Tool | Needs | Asserts |
|---|---|---|---|
| **0 · Structural** | `node:test` | nothing | escalation reachable from every state but the sink; no tool permitted from any closed state; every field key has a label and a schema; **DB `CHECK` constraints match the TS unions**; every `/api` route carries the right middleware |
| **1 · Unit** | `node:test` | nothing | transitions, red-flag scanning, hash chaining, the §7.4 outcome mapping (exhaustive over conversation states) |
| **2 · Repository** | `node:test` | Postgres | constraints actually fire: second `responsible` rejected, second open interview rejected, published protocol edit rejected, ledger `UPDATE` rejected |
| **2t · Tenant isolation** | `node:test` | Postgres, two tenants | **every read route against a foreign resource returns 404**; a query with no `search_path` errors rather than reading anything; a repository function given tenant A and an id from tenant B finds nothing |
| **3 · API contract** | `node:test` + supertest | Postgres | 401/403/404 discrimination, zod rejection of unknown fields (SEC-4), staff-ledger entry per read |
| **4 · Scenario** | `node:test` | Postgres + scripted engine | full synthetic journeys: normal, red flag, lockout, reschedule, abandonment — **LLM invocation count zero on a flagged utterance (CS-2)** |
| **5 · E2E** | Playwright | everything | the flows in §4.11 and §5.8, in a real browser |

**Database isolation, which decides whether anyone runs these:**

- Layers 2–3 run each test inside a transaction that is rolled back. Milliseconds, total isolation,
  no cleanup code.
- Layer 5 cannot — the browser talks to a server with its own connections. So the seeded database is
  built once as a **template**, and each Playwright worker does
  `CREATE DATABASE test_w3 TEMPLATE app_seeded`. A fresh, fully-seeded database per worker in roughly
  a second, and parallel workers cannot see each other's writes.
- **Note what the template gives you here:** it clones *all* tenant schemas at once, so a worker gets
  both tenants pre-seeded and cross-tenant e2e costs nothing extra to set up.

**Layer 2t is the layer this architecture is bought with, so it is written as a loop, not as
examples.** It enumerates the route table and the repository exports and runs each one across the
tenant boundary; a new route or repo function is covered the day it appears, without anyone
remembering. A schema-per-tenant design whose isolation is checked by a handful of hand-written cases
has the isolation of a discriminator column and the migration cost of separate schemas — the worst of
both.

**One canary test that belongs to no layer and must exist from the first commit (EV-6):** plant a
known string in a transcript, run a scenario, and assert it appears nowhere in stdout, in any error
payload, or in any telemetry line. The leak vector is exception payloads, not metrics, and it is far
cheaper to keep this green than to make it green later.

## 4.11 Phase 1 end-to-end scenarios

| # | Scenario |
|---|---|
| E1-1 | Login with valid credentials lands on the dashboard; the cookie is `httpOnly` and `SameSite=Strict` |
| E1-2 | Wrong password five times locks the account for 15 minutes; wrong email is indistinguishable from wrong password |
| E1-3 | Every `/api` route without a cookie returns 401 — driven by the route table, so new routes are covered automatically |
| E1-4 | `lindqvist` opening `okafor`'s patient gets 403, **and the denial is in the staff ledger** |
| E1-5 | Search by MRN, claim with a reason, then read succeeds; the claim is in the ledger |
| E1-6 | Claiming `responsible` where one exists offers transfer; accepting ends the incumbent's row; the database rejects the duplicate if the UI is bypassed |
| E1-7 | Logout revokes; the same cookie replayed returns 401 |
| E1-8 | Admin can list users and cannot open a patient record |
| E1-9 | `bakare` (dalefield) requesting a westmoor patient by id gets **404**, and the denial is in **dalefield's** ledger, not westmoor's |
| E1-10 | `okafor`, a member of both, sees only westmoor's panel while westmoor is active; switching tenant re-issues the session and the old cookie is dead |
| E1-11 | A request whose session names a suspended tenant is refused before any query runs |
| E1-12 | A tenant whose schema is behind the expected migration version is refused service with a clear error, and the others keep serving |

## 4.12 CI

```yaml
services: { postgres: { image: postgres:16, env: { POSTGRES_PASSWORD: ci } } }
steps:
  - npm ci
  - npm run build          # shared must compile first; the workspace already enforces this
  - npm run test:structural   # layers 0–1, no database, fails in seconds
  - npm run db:migrate && npm run db:seed
  - npm run test:integration  # layers 2–4
  - npx playwright test       # layer 5
  - npm audit --audit-level=high    # SEC-10
```

**Layers 0–1 run first and separately.** They fail in seconds and catch the class of mistake that
would otherwise cost a full database spin-up to discover.

---

# PHASE 2 · The flows

## 5.1 Scope and exit criteria

**In:** the public patient interview view at `/i/:token`, the scripted engine behind the real
contract, deploy + delivery, add/claim patient, the three dashboard buckets that phase 2 can fill,
and escalation acknowledgement.

**Out:** real audio (the engine seam is real; the cascaded implementation is not wired), review
signature, rota routing, real SMS/email delivery.

**Exit criteria:**

1. A clinician adds a patient, claims them, and deploys an interview in one uninterrupted flow.
2. The invite link, opened in a browser with no cookie, runs a complete interview and lands the
   result in **Needs review**.
3. A red-flag utterance ends the interview immediately, raises an escalation, and puts it in
   **Warnings** with a clock — acknowledgeable from the dashboard.
4. Each of the five deploy preflight refusals is demonstrable.
5. The whole of (1)–(3) runs headless in Playwright with **no microphone and no model call**.

## 5.2 Route map

Two route trees with different auth postures. **They are separate trees, not conditional rendering
inside one** — the patient view must not be able to import the authenticated shell, and a bundle
boundary is the cheapest way to make that structural.

| Route | Auth | View |
|---|---|---|
| `/login` | public | Login |
| **`/i/:token`** | **public, token only** | **Patient interview (§5.4)** |
| `/` | session | Dashboard — queues and buckets |
| `/patients` | session | Search and panel |
| `/patients/new` | session | Add patient |
| `/patients/:id` | session + assignment | Patient profile |
| `/deploy` | session | Deploy composer |
| `/interviews/:id` | session + assignment | Interview detail |

## 5.3 The engine seam in phase 2 — and why the scripted engine is the whole trick

The backend hands the engine an `InterviewBrief` and consumes its event stream (PDR §5.2). Phase 2
ships one implementation:

```
VOICE_ENGINE=scripted      ← phase 2. Text in, fixtured responses out, same events.
VOICE_ENGINE=cascaded      ← later. Same brief, same events, real audio.
VOICE_ENGINE=realtime      ← A/B baseline only, never the PHI path.
```

**The scripted engine is the text implementation (IV-5) with a fixture player attached.** The patient
turn arrives as `POST /api/sessions/:id/utterance { text }` in both cases — Playwright types it,
production speaks it and recognition produces it. Everything downstream is byte-identical: the same
safety gate, the same tool permission check, the same event stream, the same ledger.

Three things fall out of that, and together they are the reason the seam is shaped this way:

- **The accessibility requirement and the test harness are the same code**, so the text path cannot
  rot — it is exercised by every CI run.
- **The safety suite runs on every commit** for no money and no audio, and CS-2's zero-invocation
  assertion is checked continuously rather than at release.
- **Wiring the real engine changes no view and no route.** The browser gains a media connection; the
  event stream it renders is unchanged.

Event delivery to the browser is one WebSocket per session (`/ws/sessions/:id`) carrying the engine's
event stream in both modes. Media, when it exists, is separate and engine-specific.

## 5.4 The patient interview view (`/i/:token`)

**The tenant is resolved before anything else happens.** The invite host
(`westmoor.app.example/i/:token`) names it directly; a bare link falls back to
`platform.invite_index` on the SHA-256 of the token, which yields a tenant id and nothing more. Only
then is a schema set and the interview looked up. An unknown token and a token for a suspended tenant
produce the same Unavailable page — a distinguishing response is a tenant-enumeration oracle.

**Public, and it must leak nothing.** The landing page names the practice and the protocol — never
the patient. Identity is confirmed inside the conversation, against the hashed challenge in the
brief. A link forwarded to the wrong person reveals that an appointment exists, and nothing else.

```
  GET /i/:token
        │
        ▼
  ┌───────────┐  token unknown / window closed / already finished
  │ resolving ├──────────────────────────────────────────────► Unavailable
  └─────┬─────┘        (one message for all three — a distinguishing
        │               error message is an enumeration oracle)
        ▼
  ┌──────────────────────────────────────────────┐
  │ Welcome + non-diagnostic disclaimer          │  "This collects information for your
  │ "About 5 minutes. You can stop at any time." │   care team. It does not diagnose or treat."
  └──────────────────┬───────────────────────────┘
                     ▼
  ┌──────────────────────────────────────────────┐
  │ Consent — processing (required)              │  recording consent gates class 1 (EV-8);
  │           recording (optional, separate)     │  declining it still runs the interview
  └──────────────────┬───────────────────────────┘
                     ▼
  ┌──────────────────────────────────────────────┐
  │ Choose: speak  ·  type                       │  the text path is offered, not hidden
  └──────────────────┬───────────────────────────┘
                     ▼
  ┌──────────────────────────────────────────────┐
  │ LIVE                                          │
  │  ┌──────────────┐ ┌───────────────────────┐  │
  │  │ state pill   │ │ transcript, both sides │  │
  │  │ verification │ │                        │  │
  │  │ → intake     │ └───────────────────────┘  │
  │  └──────────────┘ ┌───────────────────────┐  │
  │                   │ intake summary, filling│  │
  │  [ end interview ]│ live as fields land    │  │
  │                   └───────────────────────┘  │
  └──────────────────┬───────────────────────────┘
                     ▼
    finalized ──► "Thank you. Your care team will review this."
    alert     ──► EMERGENCY panel: pre-rendered instruction, call-now number,
                  the interview is over and no further data is recorded
    locked    ──► "We couldn't confirm your identity. Your practice will contact you."
    reschedule──► "No problem — your practice will be in touch."
```

**Reconnection is a first-class path, not an error state.** On disconnect the browser retries with
the same token; the backend finds the interview still `in_progress` inside its window and starts a
second `interview_session` against the same record (IV-4). The patient sees "reconnecting", not a
lost interview.

**Client responsibilities are deliberately tiny.** Render server-reported state; relay utterances;
never decide a transition. The state pill shows what the server said the state is. That constraint
is inherited from ADR-0001 and survives the engine swap unchanged.

## 5.5 Dashboard flows

### Add a patient

```
POST /api/patients { mrn, givenName, familyName, dateOfBirth, phone, email, channel }
   │
   ├─ 409 if MRN exists, or if (family name + DOB) matches — surfaced as
   │       "this may already be <MRN>, open it?" rather than a hard failure
   ├─ creates patient
   ├─ creates CareAssignment(responsible, reason: "created by <clinician>", source: self_claim)
   └─ ledger: patient_create + assignment          → lands on /patients/:id
```

The auto-assignment is deliberate: **creating a patient is a stronger claim of care relationship than
searching for one**, and requiring a separate claim step immediately afterwards would train people to
click through the reason field.

### Claim an existing patient

```
GET  /api/patients?mrn=…            or  ?familyName=…&dob=…
        → identity fields only; no counts, no history, no clinical content
POST /api/patients/:id/assignments { relationship, reason }
        → 409 + transfer offer when relationship=responsible and one is active
        → POST …/assignments/:id/transfer  ends the incumbent's row, notifies them
        → ledger: assignment (and assignment_end on transfer)
```

The search itself is logged, including searches that return nothing (§4.7).

### Deploy an interview

```
clinician                backend                                    delivery
    │                       │                                           │
    │ GET /api/protocols    │  published versions only                  │
    │──────────────────────>│                                           │
    │ POST /api/interviews  │                                           │
    │──────────────────────>│                                           │
    │                       │ 1. requirePatientAccess                   │
    │                       │ 2. PREFLIGHT — refuse, don't warn:        │
    │                       │    · no active assignment      403        │
    │                       │    · no contact for channel    422        │
    │                       │    · recording protocol,                  │
    │                       │      no recording consent      422        │
    │                       │    · open interview exists     409        │
    │                       │    · version not published     422        │
    │                       │ 3. token = 32 random bytes;               │
    │                       │    store sha256 in the tenant's interview │
    │                       │    AND in platform.invite_index →tenant   │
    │                       │ 4. interview: draft → scheduled           │
    │                       │ 5. ledger: deploy                         │
    │                       │ 6. enqueue delivery ─────────────────────>│
    │<──────────────────────│  { interviewId, inviteUrl }               │
    │                       │<───── delivery_attempt: sent | failed ────│
    │                       │        failed → needs_attention (WF-4)    │
```

**The token is returned exactly once, in this response.** It is never retrievable afterwards, because
only its hash is stored — resending generates a new one, invalidates the old, and replaces the
`invite_index` row in the same transaction. The index entry is deleted when the interview closes;
`expires_at` sweeps the stragglers. That is also why the
composer offers "copy link" at this moment and nowhere else.

**Delivery in phase 2 is a link you copy.** `sms` and `email` adapters exist behind the interface and
record a `delivery_attempt` without sending; a `FORCE_DELIVERY_FAILURE` switch makes WF-4's failure
path testable. Real sending is a phase-3 adapter swap and no caller changes.

### Acknowledge an escalation

From the Warnings bucket: open, read the trigger turn in context, acknowledge with a disposition.
`acknowledged_at` stops the clock; time-to-acknowledge goes to telemetry (PDR §11). **The clock runs
from `raised_at`, not from when someone opened the dashboard** — the metric is about the patient, not
the interface.

## 5.6 API added in phase 2

| Method | Route | Auth |
|---|---|---|
| `POST` | `/api/patients` | session |
| `GET` | `/api/patients?mrn=\|familyName&dob=` | session |
| `GET` | `/api/patients/:id` | session + assignment |
| `POST` | `/api/patients/:id/assignments` | session |
| `POST` | `/api/assignments/:id/transfer` | session |
| `GET` | `/api/protocols` | session |
| `POST` | `/api/interviews` | session + assignment |
| `GET` | `/api/interviews?filter=deployedBy\|assignedTo\|careTeam&bucket=` | session |
| `GET` | `/api/interviews/:id` | session + assignment |
| `POST` | `/api/interviews/:id/{cancel,resend,extend}` | session + assignment |
| `POST` | `/api/auth/tenant` | session (re-issues it) |
| `GET` | `/api/me/queues` | session |
| `GET` | `/api/escalations?state=open` | session |
| `POST` | `/api/escalations/:id/acknowledge` | session |
| `GET` | `/i/:token` (resolve) | **public** |
| `POST` | `/api/public/sessions` | **public, token** |
| `POST` | `/api/public/sessions/:id/consent` | **public, token** |
| `POST` | `/api/public/sessions/:id/utterance` | **public, token** |
| `WS` | `/ws/sessions/:id` | **public, token** |

**Public routes are namespaced under `/api/public` on purpose.** The structural test in §4.10 asserts
that everything *not* under that prefix carries `requireSession` — so the auth posture of a new route
is decided by where you put it, and forgetting is a test failure rather than a judgement call.

## 5.7 Frontend inventory

| Component | Used by | Notes |
|---|---|---|
| `QueueCard` | dashboard | count + clock; escalations pinned first |
| `BucketTable` | dashboard | one component, five buckets, different columns |
| `PatientSearch` | patients, deploy | identity-only results before assignment |
| `ClaimDialog` | search, profile | reason is required; transfer branch |
| `DeployComposer` | deploy, profile | preflight errors render inline against the field that caused them |
| `InterviewTimeline` | interview detail | transcript + scan results, **passes included** (EV-3) |
| `IntakeSummary` | interview detail, patient view | same component both sides — one renderer, no drift |
| `EscalationBanner` | profile, interview detail, patient view | |
| `CallSurface` | patient view | state pill, transcript, summary, end button |
| `ConsentGate` | patient view | processing required, recording separate |

**State:** TanStack Query for everything server-owned; queues poll at 30 s and invalidate on mutation.
No client-side clinical state — the record shown is the record the server returned, which is the same
constraint the call view operates under.

## 5.8 Phase 2 end-to-end scenarios

| # | Scenario |
|---|---|
| E2-1 | Add patient → auto-assigned → deploy → copy link → open in a clean context → complete interview → appears in Needs review |
| E2-2 | Red flag mid-interview: interview ends immediately, emergency panel shown, escalation in Warnings, unacknowledged, with a clock |
| E2-3 | Acknowledge the escalation; it leaves Warnings; the ledger records who and when |
| E2-4 | Three failed verifications lock the interview; it lands in Warnings as `verification_failed`, routed to `deployedBy` |
| E2-5 | Expired link shows Unavailable; unknown token shows the **same** message |
| E2-6 | Each preflight refusal: unassigned, no contact, no recording consent, duplicate open, unpublished version |
| E2-7 | Disconnect mid-interview and reopen the link: same record, second session, conversation continues |
| E2-8 | Decline recording consent: the interview completes and produces a record with no audio artefacts |
| E2-9 | Patient completes via the **type** path; the record is indistinguishable from the spoken one |
| E2-10 | `lindqvist` cannot open the interview of a patient assigned to `okafor`, from any of the three filters |
| E2-11 | Resend invalidates the previous link — the old token now shows Unavailable |
| E2-12 | A westmoor invite link opened on the dalefield host still resolves, via `invite_index`, to the westmoor interview — and to nothing in dalefield |
| E2-13 | Deploying in dalefield puts the interview in dalefield's queue only; westmoor's Needs review is unchanged, and the two ledgers are independent |

## 5.9 Phase 2 exit checklist

- [ ] `npm run db:reset && npm run dev` → log in → add → claim → deploy → complete → review queue, without touching the database by hand
- [ ] All eleven scenarios above green in CI, headless, no models
- [ ] The canary test still green with the patient view in the picture
- [ ] Every phase-2 route in the structural middleware test
- [ ] Switching `VOICE_ENGINE=cascaded` changes no view code (may fail to connect; must not fail to compile)

---

## 6. What the MVP deliberately does not include

Named, so they read as scope rather than oversight:

| Not in MVP | Lands in |
|---|---|
| Audio capture and storage (class 1) | first deployment holding real data; consent is already recorded so the gate is real |
| WORM / object-lock storage | same — hash chain is in from phase 1 |
| Real STT/LLM/TTS in the loop | phase 3, behind the same seam |
| Review composer and signature (WF-6, WF-7) | phase 3; the table exists so no migration touches `interview` |
| Rota-based escalation routing | phase 3; phase 2 routes to `assignedTo` + a fixed duty account |
| Real SMS/email delivery | adapter swap; interface and `delivery_attempt` exist |
| Break-glass access | phase 3; `requirePatientAccess` already calls the predicate |
| MFA / SSO | phase 3; `verifyCredentials` is the seam |
| Patient-facing report access (O-2) | undecided |
| FHIR / EHR integration | out of MVP entirely |

## 7. Risks specific to this build

| Risk | Mitigation |
|---|---|
| The seam gets bypassed "just this once" for a read-only endpoint | Route-table structural test; bypass fails CI, not review |
| Seed data drifts from the schema and `db:reset` breaks silently | Seeding runs in CI before the integration layer; a broken seed fails the build |
| The scripted engine diverges from the real one and the safety suite stops meaning anything | They share the gate, the permission check and the event types by construction — divergence is a compile error, not a behaviour difference |
| Ledger writes become a bottleneck under the advisory lock | Lock is per interview, not global; measure at the `--scale=500` seed before it matters |
| **A pooled connection carries a `search_path` between requests and serves tenant A's data to tenant B** | `SET LOCAL` inside a transaction, in one file; role default `search_path = ''`; layer 2t asserts a query without a resolved tenant errors. **This is the failure mode of this design and it deserves the top row** |
| A migration fan-out half-completes and the estate splits across schema versions | Per-tenant transaction, `tenant_migration` bookkeeping, refuse-to-serve on version mismatch (§4.6) |
| A schema name reaches SQL from user input | Registry lookup only, `^t_[a-z0-9_]{2,30}$`, driver identifier quoting, never concatenation |
| Isolation tested by a few hand-written cases, so new routes go uncovered | Layer 2t is a loop over the route table and repo exports, not a list of examples |
| Relation count and migration time grow with tenants until something gives | `--tenants=12` seed makes the curve visible on a laptop; database-per-tenant is the documented exit |
| The public patient route grows a convenience field that leaks PHI | Its response shape is a zod schema with an explicit allow-list, asserted in a test |

## 8. Command reference

```
npm run dev                 backend :3001 + frontend :5173 + postgres :5432
npm run db:up               docker compose up -d postgres
npm run db:migrate          platform set, then the tenant set for every active tenant
npm run db:migrate:new      generate from schema.ts (then hand-edit before committing)
npm run db:seed             two tenants, demo dataset   (--empty | --scale=N | --tenants=N)
npm run db:reset            drop → create → migrate → seed   (refuses in production)
npm run tenant:create       provision a schema and run the tenant set  (-- --slug= --name=)
npm run tenant:status       migration version per tenant — the estate's state as a query

npm run test:structural     layers 0–1 · no database · seconds
npm run test:integration    layers 2–4 · Postgres · transaction-per-test
npm run test:e2e            layer 5 · Playwright · database template per worker
npm run test:all            everything, in that order
```

**`npm run test:structural` is the one to wire into a pre-commit hook.** It needs no services, runs in
seconds, and catches the two mistakes this architecture is most exposed to: a route without an
authorization middleware, and a database constraint that has drifted from its TypeScript union.
