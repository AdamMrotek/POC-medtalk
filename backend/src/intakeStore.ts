import { randomUUID } from "node:crypto";

export interface EmergencyFlag {
  flagged: true;
  reason: string;
  source: "model" | "keyword_scan";
}

export interface IntakeRecord {
  sessionId: string;
  chiefComplaint: string;
  onset?: string;
  location?: string;
  character?: string;
  severity?: string;
  duration?: string;
  timing?: string;
  aggravatingFactors?: string;
  alleviatingFactors?: string;
  associatedSymptoms?: string;
  summary?: string;
  emergency?: EmergencyFlag;
  finalized: boolean;
  updatedAt: string;
}

const sessions = new Map<string, IntakeRecord>();

export function createSession(): string {
  const sessionId = randomUUID();
  sessions.set(sessionId, {
    sessionId,
    chiefComplaint: "headache",
    finalized: false,
    updatedAt: new Date().toISOString(),
  });
  return sessionId;
}

export function getRecord(sessionId: string): IntakeRecord | undefined {
  return sessions.get(sessionId);
}

export function updateRecord(sessionId: string, fields: Partial<IntakeRecord>): IntakeRecord {
  const existing = sessions.get(sessionId);
  if (!existing) {
    throw new Error(`Unknown session "${sessionId}"`);
  }
  const updated: IntakeRecord = { ...existing, ...fields, updatedAt: new Date().toISOString() };
  sessions.set(sessionId, updated);
  return updated;
}
