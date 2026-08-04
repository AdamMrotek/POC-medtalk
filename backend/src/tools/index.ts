import { getRecord, updateRecord, type SessionStage } from "../intakeStore.js";

export interface ToolDefinition {
  name: string;
  description: string;
  stage: SessionStage;
  parameters: Record<string, unknown>;
  handler: (args: Record<string, unknown>, sessionId: string) => Promise<unknown> | unknown;
}

const MAX_VERIFICATION_ATTEMPTS = 3;

function lastDigits(phone: string, count: number): string {
  return phone.replace(/\D/g, "").slice(-count);
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
  verify_identity: {
    name: "verify_identity",
    description:
      "Verify the caller's identity using their date of birth and the last 3 digits of the phone number on file, before discussing any medical information or starting intake questions.",
    stage: "verification",
    parameters: {
      type: "object",
      properties: {
        dateOfBirth: {
          type: "string",
          description: "The caller's stated date of birth, normalized to YYYY-MM-DD.",
        },
        phoneLast3: {
          type: "string",
          description: "The last 3 digits of the phone number the caller states is on file.",
        },
      },
      required: ["dateOfBirth", "phoneLast3"],
    },
    handler: (args, sessionId) => {
      const record = getRecord(sessionId);
      if (!record) throw new Error(`Unknown session "${sessionId}"`);

      const expectedDob = (process.env.DEMO_PATIENT_DOB ?? "").trim();
      const expectedPhone = process.env.DEMO_PATIENT_PHONE ?? "";
      const matches =
        String(args.dateOfBirth ?? "").trim() === expectedDob &&
        String(args.phoneLast3 ?? "").trim() === lastDigits(expectedPhone, 3);

      if (matches) {
        return updateRecord(sessionId, { verified: true, stage: "intake" });
      }

      const verificationAttempts = record.verificationAttempts + 1;
      const locked = verificationAttempts >= MAX_VERIFICATION_ATTEMPTS;
      const updated = updateRecord(sessionId, { verificationAttempts });
      return { ...updated, verified: false, locked };
    },
  },
  request_reschedule: {
    name: "request_reschedule",
    description:
      "Call this if the patient indicates now isn't a good time and wants to reschedule, instead of continuing with identity verification or intake.",
    stage: "verification",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Why the patient wants to reschedule, if they gave one.",
        },
      },
      required: [],
    },
    handler: (args, sessionId) => {
      return updateRecord(sessionId, {
        rescheduleRequested: { reason: args.reason ? String(args.reason) : undefined },
      });
    },
  },
  update_intake: {
    name: "update_intake",
    description:
      "Record or update structured headache intake fields as the patient answers questions. Call this after every new piece of information, even a partial answer.",
    stage: "intake",
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
    stage: "intake",
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
    stage: "intake",
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

export function toRealtimeToolSchemas(stage: SessionStage) {
  return Object.values(tools)
    .filter((tool) => tool.stage === stage)
    .map((tool) => ({
      type: "function" as const,
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
}
