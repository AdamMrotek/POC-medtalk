/**
 * The intake field catalog: one definition feeding both the tool's JSON schema
 * (`promptDescription`, consumed by the backend) and the UI (`label`, consumed by the
 * intake panel and timeline). Previously these were two separate hand-kept lists.
 */

export const INTAKE_FIELD_KEYS = [
  "onset",
  "location",
  "character",
  "severity",
  "duration",
  "timing",
  "aggravatingFactors",
  "alleviatingFactors",
  "associatedSymptoms",
] as const;

export type IntakeFieldKey = (typeof INTAKE_FIELD_KEYS)[number];

export interface IntakeField {
  key: IntakeFieldKey;
  /** Short human label for the clinician-facing UI. */
  label: string;
  /** Description handed to the model as part of the tool's parameter schema. */
  promptDescription: string;
}

export const INTAKE_FIELDS: readonly IntakeField[] = [
  {
    key: "onset",
    label: "Onset",
    promptDescription:
      "When and how the headache started, e.g. 'sudden, 2 hours ago' or 'gradual over the past day'.",
  },
  {
    key: "location",
    label: "Location",
    promptDescription:
      "Where the pain is located, e.g. 'right temple', 'whole head', 'back of head'.",
  },
  {
    key: "character",
    label: "Character",
    promptDescription: "What the pain feels like, e.g. 'throbbing', 'sharp', 'pressure'.",
  },
  {
    key: "severity",
    label: "Severity",
    promptDescription: "Pain severity, ideally on a 0-10 scale.",
  },
  {
    key: "duration",
    label: "Duration",
    promptDescription: "How long the headache or each episode lasts.",
  },
  {
    key: "timing",
    label: "Timing",
    promptDescription:
      "Frequency/pattern, and whether this is the worst headache the patient has ever had.",
  },
  {
    key: "aggravatingFactors",
    label: "Aggravating factors",
    promptDescription: "What makes it worse: light, noise, movement, straining, etc.",
  },
  {
    key: "alleviatingFactors",
    label: "Alleviating factors",
    promptDescription: "What makes it better: rest, dark room, medication, etc.",
  },
  {
    key: "associatedSymptoms",
    label: "Associated symptoms",
    promptDescription:
      "Other symptoms alongside the headache: nausea, vomiting, visual changes, fever, neck stiffness, weakness, numbness, confusion, etc.",
  },
];

export const INTAKE_FIELD_LABELS: Record<IntakeFieldKey, string> = Object.fromEntries(
  INTAKE_FIELDS.map((field) => [field.key, field.label])
) as Record<IntakeFieldKey, string>;
