import {
  INTAKE_FIELDS,
  INTAKE_FIELD_KEYS,
  isToolAllowed,
  redFlagToolDescription,
  type ConversationEvent,
  type ConversationState,
  type IntakeRecord,
  type ToolName,
} from "@threepio/shared";

/**
 * What a tool wants to happen. Handlers are pure: they read the current record and
 * describe the change, but never touch the store. `index.ts` applies the event through
 * `applyEvent`, which is what keeps state transitions in exactly one place.
 */
export interface ToolOutcome {
  /** State transition to apply, if any. */
  event?: ConversationEvent;
  /** Field updates to merge into the record. */
  fields?: Partial<Omit<IntakeRecord, "state" | "history">>;
  /** Payload returned to the model as the function-call output. */
  result?: Record<string, unknown>;
}

export interface ToolDefinition {
  name: ToolName;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: Record<string, unknown>, record: IntakeRecord) => ToolOutcome;
}

export const MAX_VERIFICATION_ATTEMPTS = 3;

function lastDigits(phone: string, count: number): string {
  return phone.replace(/\D/g, "").slice(-count);
}

const intakeFieldProperties = Object.fromEntries(
  INTAKE_FIELDS.map((field) => [
    field.key,
    { type: "string", description: field.promptDescription },
  ])
);

/** Drops anything the model sent that isn't a known intake field. */
function pickIntakeFields(args: Record<string, unknown>): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const key of INTAKE_FIELD_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      picked[key] = value.trim();
    }
  }
  return picked;
}

export const tools: Record<ToolName, ToolDefinition> = {
  verify_identity: {
    name: "verify_identity",
    description:
      "Verify the caller's identity using their date of birth and the last 3 digits of the phone number on file, before discussing any medical information or starting intake questions.",
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
    handler: (args, record) => {
      // Belt-and-braces: the state gate already refuses this tool once the session is
      // locked, since `locked` is a terminal state that lists no tools.
      if (record.locked) {
        return { result: { verified: false, locked: true } };
      }

      const expectedDob = (process.env.DEMO_PATIENT_DOB ?? "").trim();
      const expectedPhone = process.env.DEMO_PATIENT_PHONE ?? "";
      const matches =
        String(args.dateOfBirth ?? "").trim() === expectedDob &&
        String(args.phoneLast3 ?? "").trim() === lastDigits(expectedPhone, 3);

      if (matches) {
        return {
          event: "identity_verified",
          fields: { verified: true },
          result: { verified: true, locked: false },
        };
      }

      const verificationAttempts = record.verificationAttempts + 1;
      if (verificationAttempts >= MAX_VERIFICATION_ATTEMPTS) {
        return {
          event: "verification_locked",
          fields: { verificationAttempts, locked: true },
          result: { verified: false, locked: true },
        };
      }
      return {
        fields: { verificationAttempts },
        result: {
          verified: false,
          locked: false,
          attemptsRemaining: MAX_VERIFICATION_ATTEMPTS - verificationAttempts,
        },
      };
    },
  },

  request_reschedule: {
    name: "request_reschedule",
    description:
      "Call this if the patient indicates now isn't a good time and wants to reschedule, instead of continuing with identity verification or intake.",
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
    handler: (args) => ({
      event: "reschedule_requested",
      fields: {
        rescheduleRequested: { reason: args.reason ? String(args.reason) : undefined },
      },
      result: { rescheduled: true },
    }),
  },

  update_intake: {
    name: "update_intake",
    description:
      "Record or update structured headache intake fields as the patient answers questions. Call this after every new piece of information, even a partial answer.",
    parameters: {
      type: "object",
      properties: intakeFieldProperties,
      required: [],
    },
    handler: (args) => {
      const fields = pickIntakeFields(args);
      return { fields, result: { recorded: Object.keys(fields) } };
    },
  },

  flag_emergency: {
    name: "flag_emergency",
    description: redFlagToolDescription(),
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
    handler: (args) => ({
      event: "red_flag",
      fields: {
        emergency: {
          flagged: true,
          id: null,
          reason: String(args.reason ?? "Red flag reported"),
          source: "model",
        },
      },
      result: { escalated: true },
    }),
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
    handler: (args) => ({
      event: "intake_finalized",
      fields: { finalized: true, summary: String(args.summary ?? "") },
      result: { finalized: true },
    }),
  },
};

export function isToolName(name: string): name is ToolName {
  return name in tools;
}

/** Tools allowed in `state`. The state machine is the authorization table, so which
 * schemas the model is even shown follows from it rather than being listed twice. */
function allowedTools(state: ConversationState): ToolDefinition[] {
  return Object.values(tools).filter((tool) => isToolAllowed(tool.name, state));
}

/** The tool schemas the model should be given while in `state`. */
export function toRealtimeToolSchemas(state: ConversationState) {
  return allowedTools(state).map((tool) => ({
    type: "function" as const,
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

/**
 * The same tools in Chat Completions shape, which nests the definition under `function`
 * rather than flattening it. A sibling rather than a change to `toRealtimeToolSchemas`,
 * so the existing WebRTC path keeps working unchanged while the cascaded pipeline is
 * benchmarked alongside it.
 */
export function toChatToolSchemas(state: ConversationState) {
  return allowedTools(state).map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}
