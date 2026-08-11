import {
  isToolAllowed,
  type ConversationState,
  type IntakeRecord,
  type SessionUpdate,
} from "@threepio/shared";
import { isToolName, tools, toRealtimeToolSchemas } from "./tools/index.js";
import { applyEvent, getRecord, updateRecord } from "./intakeStore.js";
import { instructionsFor } from "./policy/instructions.js";
import { scanForRedFlags } from "./safety/scan.js";

/**
 * The conversation runtime: everything the HTTP layer does apart from speaking HTTP.
 * Kept separate so the safety-critical paths (tool gating, lockout, escalation) can be
 * tested directly instead of through a running server.
 */

/**
 * The realtime config for a state. Only the browser can send `session.update` over the
 * data channel, so it still relays these — but it now receives one only in the response
 * that authorizes the transition, rather than being handed every stage up front.
 */
export function sessionConfigFor(state: ConversationState): SessionUpdate {
  return {
    instructions: instructionsFor(state),
    tools: toRealtimeToolSchemas(state),
  };
}

export type RunResult<T> =
  | ({ ok: true } & T)
  | { ok: false; status: number; error: string; record?: IntakeRecord };

export interface ToolSuccess {
  record: IntakeRecord;
  result: Record<string, unknown>;
  sessionUpdate?: SessionUpdate;
}

export function runTool(
  name: string,
  args: Record<string, unknown>,
  sessionId: string
): RunResult<ToolSuccess> {
  if (!isToolName(name)) {
    return { ok: false, status: 404, error: `Unknown tool "${name}"` };
  }
  const record = getRecord(sessionId);
  if (!record) {
    return { ok: false, status: 404, error: `Unknown session "${sessionId}"` };
  }

  // The state machine is the authorization check. Closing states list no tools, so an
  // attempt to keep collecting history after an escalation, a reschedule, a lockout or a
  // finalized intake is refused here rather than depending on the model behaving.
  if (!isToolAllowed(name, record.state)) {
    return {
      ok: false,
      status: 409,
      error: `Tool "${name}" is not available in state "${record.state}".`,
      record,
    };
  }

  const outcome = tools[name].handler(args, record);

  let updated = record;
  let sessionUpdate: SessionUpdate | undefined;

  if (outcome.event) {
    const applied = applyEvent(sessionId, outcome.event, outcome.fields);
    updated = applied.record;
    if (applied.applied) {
      sessionUpdate = sessionConfigFor(updated.state);
    }
  } else if (outcome.fields && Object.keys(outcome.fields).length > 0) {
    updated = updateRecord(sessionId, outcome.fields);
  }

  return { ok: true, record: updated, result: outcome.result ?? {}, sessionUpdate };
}

export interface SafetySuccess {
  flagged: boolean;
  reason?: string;
  record?: IntakeRecord;
  sessionUpdate?: SessionUpdate;
}

/**
 * Independent, non-LLM safety net: scans the patient's own transcribed words for red-flag
 * phrases so an emergency isn't missed if the conversational model doesn't call
 * flag_emergency. On a hit it moves the session to `alert` and returns the alert-state
 * config, so the model is actually re-instructed to stop intake and direct the patient to
 * emergency care.
 */
export function runSafetyCheck(sessionId: string, text: string): RunResult<SafetySuccess> {
  const existing = getRecord(sessionId);
  if (!existing) {
    return { ok: false, status: 404, error: `Unknown session "${sessionId}"` };
  }

  const scan = scanForRedFlags(text);
  if (!scan.flagged) {
    return { ok: true, flagged: false };
  }

  const { record, applied } = applyEvent(sessionId, "red_flag", {
    emergency: {
      flagged: true,
      id: scan.id ?? null,
      reason: scan.reason ?? "Red flag detected",
      source: "keyword_scan",
    },
  });

  return {
    ok: true,
    flagged: true,
    reason: scan.reason,
    record,
    // Absent when the session was already escalated, so a repeated hit doesn't re-push
    // the same instructions mid-turn.
    sessionUpdate: applied ? sessionConfigFor(record.state) : undefined,
  };
}
