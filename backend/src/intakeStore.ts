import { randomUUID } from "node:crypto";
import {
  INITIAL_STATE,
  nextState,
  type ConversationEvent,
  type ConversationState,
  type IntakeRecord,
} from "@threepio/shared";

const sessions = new Map<string, IntakeRecord>();

export function createSession(): IntakeRecord {
  const sessionId = randomUUID();
  const record: IntakeRecord = {
    sessionId,
    state: INITIAL_STATE,
    verified: false,
    verificationAttempts: 0,
    locked: false,
    chiefComplaint: "headache",
    finalized: false,
    history: [],
    updatedAt: new Date().toISOString(),
  };
  sessions.set(sessionId, record);
  return record;
}

export function getRecord(sessionId: string): IntakeRecord | undefined {
  return sessions.get(sessionId);
}

/** Field-only update. State changes must go through `applyEvent`. */
export function updateRecord(
  sessionId: string,
  fields: Partial<Omit<IntakeRecord, "state" | "history">>
): IntakeRecord {
  const existing = sessions.get(sessionId);
  if (!existing) {
    throw new Error(`Unknown session "${sessionId}"`);
  }
  const updated: IntakeRecord = { ...existing, ...fields, updatedAt: new Date().toISOString() };
  sessions.set(sessionId, updated);
  return updated;
}

export interface ApplyEventResult {
  record: IntakeRecord;
  /** False when the event was illegal for the current state; the record is unchanged. */
  applied: boolean;
}

/**
 * The only way conversation state changes. Illegal transitions are refused rather than
 * throwing, so a late or duplicate tool call can't take down the call — the caller sees
 * `applied: false` and the record stays put.
 *
 * Every accepted transition is appended to `record.history`, which is the audit trail of
 * escalations and stage changes the requirements ask for.
 */
export function applyEvent(
  sessionId: string,
  event: ConversationEvent,
  fields: Partial<Omit<IntakeRecord, "state" | "history">> = {}
): ApplyEventResult {
  const existing = sessions.get(sessionId);
  if (!existing) {
    throw new Error(`Unknown session "${sessionId}"`);
  }

  const to = nextState(existing.state, event);
  if (!to) {
    return { record: existing, applied: false };
  }

  const now = new Date().toISOString();
  const updated: IntakeRecord = {
    ...existing,
    ...fields,
    state: to,
    history: [...existing.history, { at: now, from: existing.state, event, to }],
    updatedAt: now,
  };
  sessions.set(sessionId, updated);
  return { record: updated, applied: true };
}

/** Test seam: drops all in-memory sessions. */
export function resetStore(): void {
  sessions.clear();
}

export type { ConversationState };
