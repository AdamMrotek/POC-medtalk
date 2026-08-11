/**
 * The single red-flag catalog.
 *
 * This list used to exist three times — in the intake instructions, in the
 * `flag_emergency` tool description, and as regexes in the server-side scanner — and the
 * copies had already drifted apart. Everything is now generated from here:
 *
 *   - prompt text and the tool description, via the generators at the bottom of this file
 *   - the deterministic scanner, via `backend/src/safety/patterns.ts`, which is typed
 *     `Record<RedFlagId, ...>` so adding an entry here without deciding its patterns is a
 *     compile error rather than a silent gap in the safety net
 *
 * Regexes deliberately live on the backend: the browser never runs the scan, and the
 * bundle shouldn't enumerate the exact phrases that trigger an escalation.
 */

export const RED_FLAG_IDS = [
  "thunderclap",
  "worst-headache",
  "neck-stiffness",
  "fever-neck-stiffness",
  "neuro-deficit",
  "confusion",
  "vision-loss",
  "loss-of-consciousness",
  "head-injury",
  "pregnancy",
  "new-onset-over-50",
] as const;

export type RedFlagId = (typeof RED_FLAG_IDS)[number];

export interface RedFlag {
  id: RedFlagId;
  /** Patient-facing phrasing, used to generate the model's instructions. */
  label: string;
  /** Clinician-facing sentence recorded on the session when this flag fires. */
  reason: string;
}

export const RED_FLAGS: readonly RedFlag[] = [
  {
    id: "thunderclap",
    label: "a sudden, severe (\"thunderclap\") onset",
    reason: "Sudden, severe (\"thunderclap\") onset reported.",
  },
  {
    id: "worst-headache",
    label: "the worst headache of their life",
    reason: "Patient described this as the worst headache of their life.",
  },
  // Ordered before the standalone neck-stiffness entry so the scanner reports the more
  // specific reason when both a fever and a stiff neck are mentioned. Bare "fever" never
  // escalates on its own; bare neck stiffness still does, exactly as before.
  {
    id: "fever-neck-stiffness",
    label: "a fever together with a stiff neck",
    reason: "Fever with neck stiffness reported (possible meningitis red flag).",
  },
  {
    id: "neck-stiffness",
    label: "a stiff neck",
    reason: "Neck stiffness reported alongside headache (possible meningitis red flag).",
  },
  {
    id: "neuro-deficit",
    label: "weakness, numbness, facial droop, or slurred speech",
    reason:
      "Possible neurological deficit reported (weakness, numbness, slurred speech, or facial droop).",
  },
  {
    id: "confusion",
    label: "confusion or disorientation",
    reason: "Confusion or disorientation reported alongside headache.",
  },
  {
    id: "vision-loss",
    label: "vision loss or double vision",
    reason: "Vision changes reported alongside headache.",
  },
  {
    id: "loss-of-consciousness",
    label: "fainting, loss of consciousness, or a seizure",
    reason: "Loss of consciousness or seizure reported.",
  },
  {
    id: "head-injury",
    label: "a recent head injury",
    reason: "Recent head injury reported.",
  },
  {
    id: "pregnancy",
    label: "being pregnant",
    reason: "Patient is pregnant — headache in pregnancy warrants urgent evaluation.",
  },
  {
    id: "new-onset-over-50",
    label: "a first-ever headache of this kind after age 50",
    reason: "New-onset headache after age 50 reported.",
  },
];

const BY_ID: Record<string, RedFlag> = Object.fromEntries(
  RED_FLAGS.map((flag) => [flag.id, flag])
);

export function redFlagById(id: RedFlagId): RedFlag {
  return BY_ID[id];
}

/** Inline comma-separated list for the model's instructions. */
export function redFlagPromptList(): string {
  return RED_FLAGS.map((flag) => flag.label).join("; ");
}

/** The `flag_emergency` tool description, generated so it can never drift from the list. */
export function redFlagToolDescription(): string {
  return (
    "Call this immediately, interrupting normal intake, if the patient reports any red-flag " +
    `symptom: ${redFlagPromptList()}. Do not wait to finish the questionnaire.`
  );
}
