import { useEffect, useRef, useState } from "react";
import { INTAKE_FIELDS, type ConversationState, type IntakeRecord } from "@threepio/shared";
import { Check, ChevronRight, LoaderCircle, TriangleAlert, type LucideIcon } from "lucide-react";
import { Icon } from "./Icon";
import { List } from "./List";
import type { ConnectionState, TranscriptTurn } from "./useRealtimeConversation";

/**
 * The timeline shows one step per stage the call passed through. `finalized` isn't its
 * own step — a finished intake is the intake step marked complete — so it folds back into
 * `intake` for display. Everything else maps one-to-one onto a conversation state.
 */
type DisplayStage = Exclude<ConversationState, "finalized">;

function toDisplayStage(state: ConversationState): DisplayStage {
  return state === "finalized" ? "intake" : state;
}

interface StageMeta {
  agent: string;
  title: string;
  blurb: string;
}

const STAGE_META: Record<DisplayStage, StageMeta> = {
  verification: {
    agent: "Auth agent",
    title: "Identity verification",
    blurb: "Greets the patient, confirms it's a good time, checks DOB + phone.",
  },
  intake: {
    agent: "Clinical agent",
    title: "Headache intake",
    blurb: "Collects structured history for the care team.",
  },
  alert: {
    agent: "Safety agent",
    title: "Emergency escalation",
    blurb: "A red flag was reported — intake stopped.",
  },
  reschedule: {
    agent: "Auth agent",
    title: "Reschedule requested",
    blurb: "The patient asked to be called back another time.",
  },
  locked: {
    agent: "Auth agent",
    title: "Verification locked",
    blurb: "Too many failed attempts — the care team will follow up by phone.",
  },
};

// The stages every call is expected to walk through. The rest are conditional branches,
// so they only appear in the timeline once they actually happen.
const PLANNED_STAGES: DisplayStage[] = ["verification", "intake"];

type StageStatus = "active" | "done" | "failed" | "pending";

interface StageGroup {
  stage: DisplayStage;
  turns: TranscriptTurn[];
}

/** Splits the flat transcript into consecutive runs of the same stage. */
function groupByStage(turns: TranscriptTurn[], currentStage: ConversationState): StageGroup[] {
  const groups: StageGroup[] = [];
  for (const turn of turns) {
    const stage = toDisplayStage(turn.stage);
    const last = groups[groups.length - 1];
    if (last && last.stage === stage) last.turns.push(turn);
    else groups.push({ stage, turns: [turn] });
  }
  // A stage that has just started but hasn't produced a turn yet still gets a header,
  // so the timeline never appears to stall at the previous stage.
  const current = toDisplayStage(currentStage);
  if (groups[groups.length - 1]?.stage !== current) {
    groups.push({ stage: current, turns: [] });
  }
  return groups;
}

function stageStatus(
  group: StageGroup,
  isLast: boolean,
  isLive: boolean,
  record: IntakeRecord | null
): StageStatus {
  if (group.stage === "alert" || group.stage === "locked") return "failed";
  if (isLast && isLive) return "active";
  switch (group.stage) {
    case "verification":
      return record?.verified ? "done" : "pending";
    case "intake":
      return record?.finalized ? "done" : "pending";
    case "reschedule":
      return "done";
  }
}

/** One-line recap shown on a collapsed stage, so rolling it up loses nothing important. */
function stageSummary(group: StageGroup, record: IntakeRecord | null, emergencyReason?: string): string {
  switch (group.stage) {
    case "verification": {
      if (record?.verified) return "Verified — DOB and phone digits matched.";
      const attempts = record?.verificationAttempts ?? 0;
      if (attempts > 0) return `${attempts} failed attempt${attempts === 1 ? "" : "s"}.`;
      return STAGE_META.verification.blurb;
    }
    case "intake": {
      const filled = record
        ? INTAKE_FIELDS.filter((field) => Boolean(record[field.key])).length
        : 0;
      const progress = `${filled} of ${INTAKE_FIELDS.length} fields collected`;
      return record?.finalized ? `${progress} — finalized.` : `${progress}.`;
    }
    case "alert":
      return emergencyReason ?? STAGE_META.alert.blurb;
    case "reschedule":
      return record?.rescheduleRequested?.reason ?? STAGE_META.reschedule.blurb;
    case "locked":
      return `Locked after ${record?.verificationAttempts ?? 0} failed attempts.`;
  }
}

const STATUS_LABEL: Record<StageStatus, string> = {
  active: "In progress",
  done: "Complete",
  failed: "Escalated",
  pending: "Incomplete",
};

/** Maps a stage status onto a .pill--* variant from styles/base.css. */
const STATUS_VARIANT: Record<StageStatus, string> = {
  active: "pill pill--accent",
  done: "pill pill--success",
  failed: "pill pill--danger",
  pending: "pill",
};

/**
 * A glyph per status, so complete / escalated / in-progress differ in shape and
 * not only in the pill's colour. `pending` has none on purpose: it is the
 * absence of an outcome, and drawing something for "nothing has happened yet"
 * would give it more presence than the three states that did happen.
 */
const STATUS_ICON: Partial<Record<StageStatus, LucideIcon>> = {
  active: LoaderCircle,
  done: Check,
  failed: TriangleAlert,
};

interface Props {
  transcript: TranscriptTurn[];
  stage: ConversationState;
  connectionState: ConnectionState;
  intakeRecord: IntakeRecord | null;
  emergencyReason?: string;
}

export function ConversationTimeline({
  transcript,
  stage,
  connectionState,
  intakeRecord,
  emergencyReason,
}: Props) {
  const [overrides, setOverrides] = useState<Partial<Record<DisplayStage, boolean>>>({});
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const isLive =
    connectionState === "connected" ||
    connectionState === "connecting" ||
    connectionState === "ending";
  const started = connectionState !== "idle" || transcript.length > 0;
  // A turn's slot in the transcript is reserved when the realtime item is created, which
  // is before its text exists — so an empty turn is one still waiting on transcription,
  // not an empty message. Hide it until it has something to say; it keeps its place.
  const spokenTurns = transcript.filter((turn) => turn.text.trim() !== "");
  const groups = started ? groupByStage(spokenTurns, stage) : [];

  // Follow the live conversation, but don't yank the view while reviewing a finished call.
  useEffect(() => {
    if (!isLive) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript, stage, isLive]);

  // An escalation takes over the view: drop any stages the user had manually expanded
  // so the warning is the only thing open.
  useEffect(() => {
    if (stage === "alert") setOverrides({});
  }, [stage]);

  if (!started) {
    return (
      <section className="panel">
        <header className="panel__header">
          <span className="eyebrow">Conversation</span>
        </header>
        <div className="panel__body timeline timeline--empty">
          <List
            className="timeline-preview"
            items={PLANNED_STAGES.map((s) => ({
              title: STAGE_META[s].title,
              subtitle: STAGE_META[s].agent,
            }))}
          />
          <p className="timeline-empty-note">
            Each stage rolls up into a single step once it hands off. If a red flag is reported, the
            safety agent takes over and collapses the rest.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="panel">
      <header className="panel__header">
        <span className="eyebrow">Conversation</span>
        <span className="pill">
          {spokenTurns.length} {spokenTurns.length === 1 ? "message" : "messages"}
        </span>
      </header>
      <div className="panel__body timeline scroll-area" ref={scrollRef}>
        {groups.map((group, index) => {
          const meta = STAGE_META[group.stage];
          const isLast = index === groups.length - 1;
          const status = stageStatus(group, isLast, isLive, intakeRecord);
          const StatusGlyph = STATUS_ICON[status];
          // Finished stages roll up to a single timeline step; the newest one stays open.
          const expanded = overrides[group.stage] ?? isLast;

          return (
            <section
              key={`${group.stage}-${index}`}
              className={`stage stage--${group.stage} stage--${status} ${expanded ? "stage--open" : ""}`}
            >
              <span className="stage-rail" aria-hidden="true">
                <span className="stage-dot" />
              </span>

              <button
                type="button"
                className="stage-header"
                aria-expanded={expanded}
                onClick={() =>
                  setOverrides((prev) => ({ ...prev, [group.stage]: !expanded }))
                }
              >
                <span className="stage-heading">
                  <span className="stage-agent">{meta.agent}</span>
                  <span className="stage-title">{meta.title}</span>
                </span>
                <span className={STATUS_VARIANT[status]}>
                  {StatusGlyph && (
                    <Icon as={StatusGlyph} size={13} className={status === "active" ? "spinner" : undefined} />
                  )}
                  {STATUS_LABEL[status]}
                </span>
                <Icon as={ChevronRight} className="stage-chevron" />
                <span className="stage-summary">{stageSummary(group, intakeRecord, emergencyReason)}</span>
                {!expanded && group.turns.length > 0 && (
                  <span className="stage-turn-count">{group.turns.length} messages</span>
                )}
              </button>

              {/* Rendered whether or not it is open: the 0fr -> 1fr collapse in
                  App.css needs something to measure, and unmounting would also
                  replay every turn's entry animation on re-expand. `inert`
                  keeps a closed stage out of both the tab order and the
                  accessibility tree, which is what the old unmount did for
                  free. */}
              <div className="stage-body-wrap" inert={!expanded}>
                <div className="stage-body">
                  {group.stage === "alert" && (
                    <div className="stage-alert">
                      <Icon as={TriangleAlert} className="stage-alert__icon" />
                      <span>
                        <strong>Red flag reported.</strong> {emergencyReason} Normal intake questions
                        have stopped; the patient was told to seek emergency care.
                      </span>
                    </div>
                  )}
                  {group.turns.length === 0 && <p className="stage-waiting">Waiting for the assistant…</p>}
                  {group.turns.map((turn) => (
                    <div key={turn.id} className={`turn turn--${turn.role}`}>
                      <span className="turn-role">{turn.role === "tool" ? "action" : turn.role}</span>
                      <span className="turn-text">{turn.text}</span>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
}
