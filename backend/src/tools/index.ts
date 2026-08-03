import { updateRecord } from "../intakeStore.js";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: Record<string, unknown>, sessionId: string) => Promise<unknown> | unknown;
}

const intakeFieldProperties = {
  onset: {
    type: "string",
    description: "When and how the headache started, e.g. 'sudden, 2 hours ago' or 'gradual over the past day'.",
  },
  location: {
    type: "string",
    description: "Where the pain is located, e.g. 'right temple', 'whole head', 'back of head'.",
  },
  character: {
    type: "string",
    description: "What the pain feels like, e.g. 'throbbing', 'sharp', 'pressure'.",
  },
  severity: {
    type: "string",
    description: "Pain severity, ideally on a 0-10 scale.",
  },
  duration: {
    type: "string",
    description: "How long the headache or each episode lasts.",
  },
  timing: {
    type: "string",
    description: "Frequency/pattern, and whether this is the worst headache the patient has ever had.",
  },
  aggravatingFactors: {
    type: "string",
    description: "What makes it worse: light, noise, movement, straining, etc.",
  },
  alleviatingFactors: {
    type: "string",
    description: "What makes it better: rest, dark room, medication, etc.",
  },
  associatedSymptoms: {
    type: "string",
    description:
      "Other symptoms alongside the headache: nausea, vomiting, visual changes, fever, neck stiffness, weakness, numbness, confusion, etc.",
  },
};

export const tools: Record<string, ToolDefinition> = {
  update_intake: {
    name: "update_intake",
    description:
      "Record or update structured headache intake fields as the patient answers questions. Call this after every new piece of information, even a partial answer.",
    parameters: {
      type: "object",
      properties: intakeFieldProperties,
      required: [],
    },
    handler: (args, sessionId) => {
      return updateRecord(sessionId, args as Record<string, string>);
    },
  },
  flag_emergency: {
    name: "flag_emergency",
    description:
      "Call this immediately, interrupting normal intake, if the patient reports any red-flag symptom: thunderclap/sudden severe onset, \"worst headache of my life\", fever with neck stiffness, weakness/numbness/confusion/slurred speech, vision loss, head injury, new onset after age 50, or pregnancy. Do not wait to finish the questionnaire.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Which red flag was reported and why it's concerning.",
        },
      },
      required: ["reason"],
    },
    handler: (args, sessionId) => {
      return updateRecord(sessionId, {
        emergency: { flagged: true, reason: String(args.reason ?? "Red flag reported"), source: "model" },
      });
    },
  },
  finalize_intake: {
    name: "finalize_intake",
    description:
      "Call once enough intake fields have been gathered, or the conversation is ending, to close out the session with a short clinician-facing summary.",
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "2-4 sentence clinician-facing summary of the presenting complaint.",
        },
      },
      required: ["summary"],
    },
    handler: (args, sessionId) => {
      return updateRecord(sessionId, { finalized: true, summary: String(args.summary ?? "") });
    },
  },
};

export function toRealtimeToolSchemas() {
  return Object.values(tools).map((tool) => ({
    type: "function" as const,
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}
