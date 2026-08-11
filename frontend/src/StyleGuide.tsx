import "./App.css";
import "./StyleGuide.css";
import { ConnectionPill } from "./ConnectionPill";
import { List } from "./List";

/* Living documentation for the design system, served at #/styleguide.
   It renders the real tokens and the real component classes, so it cannot drift
   from the app: change a token and this page changes with it. */

interface Swatch {
  name: string;
  token: string;
}

const SURFACE_SWATCHES: Swatch[] = [
  { name: "Background", token: "--bg" },
  { name: "Surface", token: "--surface" },
  { name: "Surface raised", token: "--surface-raised" },
  { name: "Surface sunken", token: "--surface-sunken" },
  { name: "Surface inset", token: "--surface-inset" },
];

const TEXT_SWATCHES: Swatch[] = [
  { name: "Primary", token: "--text-primary" },
  { name: "Secondary", token: "--text-secondary" },
  { name: "Tertiary", token: "--text-tertiary" },
  { name: "Faint", token: "--text-faint" },
];

const LINE_SWATCHES: Swatch[] = [
  { name: "Border faint", token: "--border-faint" },
  { name: "Border", token: "--border" },
  { name: "Border strong", token: "--border-strong" },
];

const ACCENT_SWATCHES: Swatch[] = [
  { name: "Accent", token: "--accent" },
  { name: "Accent hover", token: "--accent-hover" },
  { name: "Accent soft", token: "--accent-soft" },
  { name: "Accent border", token: "--accent-border" },
];

const STATUS_SWATCHES: Swatch[] = [
  { name: "Danger", token: "--danger" },
  { name: "Danger soft", token: "--danger-soft" },
  { name: "Warning", token: "--warning" },
  { name: "Warning soft", token: "--warning-soft" },
  { name: "Success", token: "--success" },
  { name: "Success soft", token: "--success-soft" },
];

const TYPE_STEPS = [
  { token: "--text-display", size: "clamp 32–48px", weight: 900, tracking: "-0.03em", display: true },
  { token: "--text-xl", size: "26px", weight: 500, tracking: "-0.015em", display: true },
  { token: "--text-lg", size: "20px", weight: 500, tracking: "-0.015em", display: true },
  { token: "--text-md", size: "17px", weight: 400, tracking: "0" },
  { token: "--text-base", size: "15px", weight: 400, tracking: "0" },
  { token: "--text-sm", size: "13px", weight: 400, tracking: "0" },
  { token: "--text-xs", size: "12px", weight: 500, tracking: "0.04em" },
  { token: "--text-2xs", size: "11px", weight: 600, tracking: "0.09em" },
];

const SPACE_STEPS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20];

const RADIUS_STEPS = ["xs", "sm", "md", "lg", "xl", "2xl", "full"];

const SHADOW_STEPS = ["--shadow-xs", "--shadow-sm", "--shadow-md", "--shadow-lg"];

function SwatchGrid({ swatches }: { swatches: Swatch[] }) {
  return (
    <div className="sg-grid">
      {swatches.map((s) => (
        <div className="sg-swatch" key={s.token}>
          <div className="sg-swatch__chip" style={{ background: `var(${s.token})` }} />
          <span className="sg-swatch__name">{s.name}</span>
          <code className="sg-swatch__var">{s.token}</code>
        </div>
      ))}
    </div>
  );
}

export function StyleGuide() {
  return (
    <div className="sg">
      <header className="sg-head">
        <span className="eyebrow">Design system</span>
        <h1>Headache Intake Assistant</h1>
        <p>
          Warm near-monochrome neutrals, a blue → white → red brand tricolour, and a flat saturated
          red reserved for emergencies so an escalation can never read as ordinary chrome. Every
          value below is live — it comes from the same tokens the app renders with.
        </p>
      </header>

      {/* ------------------------------------------------------------ colour */}
      <section className="sg-section">
        <header>
          <h2>Colour</h2>
          <p>
            Two tiers. Primitives (<code>--warm-500</code>, <code>--blue-600</code>) are the raw
            palette; semantic tokens name a role and are the only ones component CSS may reference.
            Dark mode re-points the semantic layer and touches nothing else. Note that every accent{" "}
            <em>surface</em> — soft fills, borders, focus — is blue: red exists only inside the brand
            gradient, which is what keeps it from competing with danger.
          </p>
        </header>

        <div className="sg-stack">
          <span className="eyebrow">Surfaces</span>
          <SwatchGrid swatches={SURFACE_SWATCHES} />
        </div>

        <div className="sg-stack">
          <span className="eyebrow">Text</span>
          <SwatchGrid swatches={TEXT_SWATCHES} />
        </div>

        <div className="sg-stack">
          <span className="eyebrow">Lines</span>
          <SwatchGrid swatches={LINE_SWATCHES} />
        </div>

        <div className="sg-stack">
          <span className="eyebrow">Accent</span>
          <SwatchGrid swatches={ACCENT_SWATCHES} />
        </div>

        <div className="sg-stack">
          <span className="eyebrow">Status</span>
          <SwatchGrid swatches={STATUS_SWATCHES} />
        </div>
      </section>

      {/* --------------------------------------------------- grain gradients */}
      <section className="sg-section">
        <header>
          <h2>Grain &amp; gradient</h2>
          <p>
            A mesh gradient with a fixed-size film grain tiled over it. The tile never scales with
            its host — that constant pixel size is what reads as film rather than as a blurry image.
            Grain is reserved for ambient and emphatic surfaces; it never sits under sustained
            reading. Tuned subtle: fine specks and no contrast stretch, so it reads as paper tooth
            rather than as film. Strength lives in two tokens —{" "}
            <code>--grain-opacity</code> for the page backdrop,{" "}
            <code>--grain-surface-opacity</code> for discrete surfaces (buttons, banners).
          </p>
        </header>

        <div className="sg-grid">
          <div
            className="sg-tile u-grain"
            style={{ backgroundImage: "var(--mesh-brand)", borderColor: "var(--border-strong)" }}
          >
            <span className="sg-tile__label">--mesh-brand (reference only, unused)</span>
          </div>
          <div className="sg-tile sg-tile--on-accent u-grain u-gradient-accent">
            <span className="sg-tile__label">--mesh-accent (labelled surfaces)</span>
          </div>
          <div className="sg-tile sg-tile--on-danger u-grain u-gradient-danger">
            <span className="sg-tile__label">--mesh-danger + grain</span>
          </div>
          <div className="sg-tile u-mesh-panel">
            <span className="sg-tile__label">--mesh-panel (no grain)</span>
          </div>
          <div className="sg-tile" style={{ backgroundImage: "var(--mesh-ambient)" }}>
            <span className="sg-tile__label">--mesh-ambient</span>
          </div>
        </div>

        <p className="sg-note">
          The page backdrop behind this guide is <code>--mesh-ambient</code> plus{" "}
          <code>--grain-texture</code>, painted on two fixed pseudo-elements isolated inside{" "}
          <code>body</code>. Both layers drop out under{" "}
          <code>prefers-reduced-transparency</code>.
        </p>
      </section>

      {/* -------------------------------------------------------------- type */}
      <section className="sg-section">
        <header>
          <h2>Type</h2>
          <p>
            15px body on a tight eight-step scale. Tracking is optical: display sizes pull in to
            -0.03em, uppercase micro-labels open out to 0.09em. Two faces:{" "}
            <code>--font-display</code> (Phenomena) on h1/h2, the wordmark and button labels,{" "}
            <code>--font-sans</code> everywhere else — samples below render in the display face at
            the top three steps, so the split is visible here. Three weights are installed, each
            with one job: <strong>900</strong> for h1 and buttons, <strong>700</strong> for the
            wordmark, <strong>400</strong> for h2 — where the 500 requested resolves down to Regular
            rather than being faked, since <code>font-synthesis</code> is off. The face falls back
            to the sans stack if the files are missing from <code>public/fonts/</code>.
          </p>
        </header>

        <div>
          {TYPE_STEPS.map((step) => (
            <div className="sg-type" key={step.token}>
              <div className="sg-type__meta">
                {step.token}
                <br />
                {step.size} · {step.weight} · {step.tracking}
              </div>
              <div
                className="sg-type__sample"
                style={{
                  fontSize: `var(${step.token})`,
                  fontWeight: step.weight,
                  letterSpacing: step.tracking,
                  fontFamily: step.display ? "var(--font-display)" : "var(--font-sans)",
                }}
              >
                Describe the headache
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------------------- space */}
      <section className="sg-section">
        <header>
          <h2>Space &amp; radius</h2>
          <p>4px base. Every gap, pad and margin in the app resolves to one of these steps.</p>
        </header>

        <div className="sg-stack">
          {SPACE_STEPS.map((n) => (
            <div className="sg-scale" key={n}>
              <span className="sg-scale__label" style={{ width: "6.5rem" }}>
                --space-{n}
              </span>
              <span className="sg-scale__bar" style={{ width: `var(--space-${n})` }} />
              <span className="sg-scale__label">{n * 4}px</span>
            </div>
          ))}
        </div>

        <div className="sg-grid">
          {RADIUS_STEPS.map((r) => (
            <div className="sg-swatch" key={r}>
              <div
                className="sg-swatch__chip sg-radius-demo"
                style={{ borderRadius: `var(--radius-${r})` }}
              />
              <code className="sg-swatch__var">--radius-{r}</code>
            </div>
          ))}
        </div>
      </section>

      {/* --------------------------------------------------------- elevation */}
      <section className="sg-section">
        <header>
          <h2>Elevation</h2>
          <p>
            Light mode casts real shadows. Dark mode trades most of the lift for a 1px top highlight
            (<code>--highlight-inset</code>), because a shadow on near-black reads as nothing.
          </p>
        </header>

        <div className="sg-grid">
          {SHADOW_STEPS.map((s) => (
            <div
              className="sg-tile"
              key={s}
              style={{ boxShadow: `var(${s}), var(--highlight-inset)` }}
            >
              <span className="sg-tile__label">{s}</span>
            </div>
          ))}
        </div>
      </section>

      {/* ----------------------------------------------------------- buttons */}
      <section className="sg-section">
        <header>
          <h2>Buttons</h2>
          <p>
            <code>.btn</code> is shape and behaviour; a variant supplies colour. Exactly one gradient
            button is on screen at a time — that is how you find the thing to press. Labels are the
            display face at 900, the only place it runs at body size; tracking opens to 0.04em
            because Black closes Phenomena's already-narrow counters.
          </p>
        </header>

        <div className="sg-row">
          <button type="button" className="btn btn--lg btn--primary">
            Start conversation
          </button>
          <button type="button" className="btn btn--lg btn--danger">
            End conversation
          </button>
          <button type="button" className="btn btn--lg btn--primary" disabled>
            Connecting…
          </button>
        </div>

        <div className="sg-row">
          <button type="button" className="btn btn--primary">
            Primary
          </button>
          <button type="button" className="btn btn--secondary">
            Secondary
          </button>
          <button type="button" className="btn btn--ghost">
            Ghost
          </button>
          <button type="button" className="btn btn--sm btn--secondary">
            Small
          </button>
          <button type="button" className="btn btn--secondary" disabled>
            Disabled
          </button>
        </div>
      </section>

      {/* ------------------------------------------------------------- pills */}
      <section className="sg-section">
        <header>
          <h2>Pills</h2>
          <p>
            Status chips. Colour rides on a single <code>--pill-color</code> hook, so a variant is
            one declaration rather than three. Live states get a breathing dot — motion is the only
            thing separating "connecting" from "connected" at a glance.
          </p>
        </header>

        <div className="sg-row">
          <ConnectionPill state="idle" />
          <ConnectionPill state="connecting" />
          <ConnectionPill state="connected" />
          <ConnectionPill state="error" />
        </div>

        <div className="sg-row">
          <span className="pill">Incomplete</span>
          <span className="pill pill--accent">In progress</span>
          <span className="pill pill--success">Complete</span>
          <span className="pill pill--danger">Escalated</span>
          <span className="pill pill--warning">Reschedule</span>
        </div>
      </section>

      {/* ----------------------------------------------------------- banners */}
      <section className="sg-section">
        <header>
          <h2>Banners</h2>
          <p>
            Danger takes the grain gradient because it has to win against everything else on the
            page. Warning stays a flat tint so the two are never confused at speed.
          </p>
        </header>

        <div className="banner-stack">
          <div className="banner banner--danger">
            <span>
              <strong>Seek emergency care now.</strong> Sudden severe headache described as the worst
              of the patient's life. If this is a medical emergency, call 911.
            </span>
          </div>
          <div className="banner banner--warning">
            <span>
              <strong>Reschedule requested.</strong> The patient asked to be called back another
              time.
            </span>
          </div>
          <div className="banner banner--error">
            <span>Microphone permission was denied. Check your browser settings and try again.</span>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------- panels and pieces */}
      <section className="sg-section">
        <header>
          <h2>Panels</h2>
          <p>
            A panel is a header strip plus a scrolling body. Both panels in the app share one fixed
            height so the layout never reflows as turns land.
          </p>
        </header>

        <div className="panels">
          <section className="panel">
            <header className="panel__header">
              <span className="eyebrow">Conversation</span>
              <span className="pill">6 messages</span>
            </header>
            <div className="panel__body timeline scroll-area">
              <section className="stage stage--verification stage--done">
                <span className="stage-rail" aria-hidden="true">
                  <span className="stage-dot" />
                </span>
                <div className="stage-header">
                  <span className="stage-heading">
                    <span className="stage-agent">Auth agent</span>
                    <span className="stage-title">Identity verification</span>
                  </span>
                  <span className="pill pill--success">Complete</span>
                  <span className="stage-chevron">▸</span>
                  <span className="stage-summary">Verified — DOB and phone digits matched.</span>
                </div>
              </section>

              <section className="stage stage--intake stage--active">
                <span className="stage-rail" aria-hidden="true">
                  <span className="stage-dot" />
                </span>
                <div className="stage-header">
                  <span className="stage-heading">
                    <span className="stage-agent">Clinical agent</span>
                    <span className="stage-title">Headache intake</span>
                  </span>
                  <span className="pill pill--accent">In progress</span>
                  <span className="stage-chevron">▾</span>
                  <span className="stage-summary">4 of 12 fields collected.</span>
                </div>
                <div className="stage-body">
                  <div className="turn turn--assistant">
                    <span className="turn-role">assistant</span>
                    <span className="turn-text">Where in your head does the pain start?</span>
                  </div>
                  <div className="turn turn--user">
                    <span className="turn-role">user</span>
                    <span className="turn-text">Usually behind my right eye.</span>
                  </div>
                  <div className="turn turn--tool">
                    <span className="turn-role">action</span>
                    <span className="turn-text">record_intake_field(location)</span>
                  </div>
                </div>
              </section>
            </div>
          </section>

          <section className="panel">
            <header className="panel__header">
              <span className="eyebrow">Intake summary</span>
              <span className="pill">
                <span className="text-mono">4/12</span> collected
              </span>
            </header>
            <div className="panel__body intake-body scroll-area">
              <dl className="intake-fields">
                <div className="field">
                  <dt className="field__label">Location</dt>
                  <dd className="field__value">Behind the right eye</dd>
                </div>
                <div className="field">
                  <dt className="field__label">Severity</dt>
                  <dd className="field__value">7 out of 10 at worst</dd>
                </div>
                <div className="field">
                  <dt className="field__label">Duration</dt>
                  <dd className="field__value">Four to six hours untreated</dd>
                </div>
              </dl>
            </div>
          </section>
        </div>
      </section>

      {/* -------------------------------------------------------------- misc */}
      <section className="sg-section">
        <header>
          <h2>Lists &amp; fields</h2>
        </header>

        <div className="panel">
          <div className="panel__body">
            <List
              items={[
                { title: "Identity verification", subtitle: "Auth agent" },
                { title: "Headache intake", subtitle: "Clinical agent" },
              ]}
            />
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ motion */}
      <section className="sg-section">
        <header>
          <h2>Motion</h2>
          <p>
            One easing curve for everything (<code>--ease-out</code>), three durations. Animation is
            informational only — the pulsing dots carry connection and stage state, so they are the
            only things that loop. All of it collapses to near-zero under{" "}
            <code>prefers-reduced-motion</code>.
          </p>
        </header>

        <div className="sg-grid">
          <div className="sg-tile">
            <span className="sg-tile__label">--duration-fast · 120ms</span>
          </div>
          <div className="sg-tile">
            <span className="sg-tile__label">--duration-base · 200ms</span>
          </div>
          <div className="sg-tile">
            <span className="sg-tile__label">--duration-slow · 400ms</span>
          </div>
        </div>
      </section>
    </div>
  );
}
