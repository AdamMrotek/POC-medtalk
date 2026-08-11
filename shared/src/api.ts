import type { IntakeRecord } from "./record.js";

/**
 * The realtime session config for a state. Only the browser holds the WebRTC data
 * channel, so it has to relay these to OpenAI — but the server now issues one only in
 * the response that authorizes a transition, instead of handing the client every stage's
 * instructions up front and letting it choose when to switch.
 */
export interface SessionUpdate {
  instructions: string;
  tools: Array<Record<string, unknown>>;
}

/** Response from POST /api/tools/:name */
export interface ToolResponse {
  record: IntakeRecord;
  /** Present when the tool call moved the conversation to a new state. */
  sessionUpdate?: SessionUpdate;
  /** Tool-specific payload the model sees, e.g. { verified, locked }. */
  result?: Record<string, unknown>;
}

/** Response from POST /api/safety-check */
export interface SafetyCheckResponse {
  flagged: boolean;
  reason?: string;
  record?: IntakeRecord;
  sessionUpdate?: SessionUpdate;
}

export interface ErrorResponse {
  error: string;
  record?: IntakeRecord;
}
