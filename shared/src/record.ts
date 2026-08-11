import type { ConversationEvent, ConversationState } from "./machine.js";
import type { IntakeFieldKey } from "./intakeFields.js";
import type { RedFlagId } from "./redFlags.js";

export interface EmergencyFlag {
  flagged: true;
  id: RedFlagId | null;
  reason: string;
  source: "model" | "keyword_scan";
}

export interface RescheduleRequest {
  reason?: string;
}

/** One entry in the append-only audit trail of state changes. */
export interface HistoryEntry {
  at: string;
  from: ConversationState;
  event: ConversationEvent;
  to: ConversationState;
}

/**
 * The session record. This type is the contract between server and client: the server
 * owns every field, the client only renders them. It previously existed as two separate
 * declarations that had already diverged.
 */
export type IntakeRecord = {
  sessionId: string;
  state: ConversationState;
  verified: boolean;
  verificationAttempts: number;
  locked: boolean;
  rescheduleRequested?: RescheduleRequest;
  chiefComplaint: string;
  summary?: string;
  emergency?: EmergencyFlag;
  finalized: boolean;
  history: HistoryEntry[];
  updatedAt: string;
} & Partial<Record<IntakeFieldKey, string>>;
