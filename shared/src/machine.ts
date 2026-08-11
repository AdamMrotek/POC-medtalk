/**
 * The conversation state machine, declared once and shared by both sides.
 *
 * The backend is the only authority: it owns `applyEvent` and rejects tool calls that
 * aren't legal for the current state. The frontend imports this to *render* state, never
 * to decide it.
 */

export type ConversationState =
  | "verification"
  | "intake"
  | "alert"
  | "reschedule"
  | "locked"
  | "finalized";

export type ConversationEvent =
  | "identity_verified"
  | "verification_locked"
  | "reschedule_requested"
  | "red_flag"
  | "intake_finalized";

export type ToolName =
  | "verify_identity"
  | "request_reschedule"
  | "update_intake"
  | "flag_emergency"
  | "finalize_intake";

/**
 * Legal transitions.
 *
 * `red_flag` is reachable from every state except `alert` itself. The deterministic
 * transcript scanner runs on every patient turn, including before identity is confirmed
 * and after the call has otherwise wound down — someone reporting stroke symptoms while
 * we're apologising for a failed verification still needs to be told to call 911.
 * `alert` is the one true sink.
 */
export const TRANSITIONS: Record<
  ConversationState,
  Partial<Record<ConversationEvent, ConversationState>>
> = {
  verification: {
    identity_verified: "intake",
    verification_locked: "locked",
    reschedule_requested: "reschedule",
    red_flag: "alert",
  },
  intake: {
    red_flag: "alert",
    intake_finalized: "finalized",
  },
  alert: {},
  reschedule: { red_flag: "alert" },
  locked: { red_flag: "alert" },
  finalized: { red_flag: "alert" },
};

export const INITIAL_STATE: ConversationState = "verification";

/**
 * States where the agent's work is done: no tool may be called from any of them (see
 * TOOL_STATES). They can still receive a `red_flag` from the safety scanner — being
 * closed to the agent is not the same as being closed to an emergency.
 */
export const CLOSING_STATES = ["alert", "reschedule", "locked", "finalized"] as const;

export function isClosing(state: ConversationState): boolean {
  return (CLOSING_STATES as readonly ConversationState[]).includes(state);
}

/** The state an event leads to from `from`, or null if the transition is illegal. */
export function nextState(
  from: ConversationState,
  event: ConversationEvent
): ConversationState | null {
  return TRANSITIONS[from][event] ?? null;
}

/**
 * Which states each tool may be invoked from. This replaces the old
 * `tool.stage === "intake" && !record.verified` check, and is what makes terminal states
 * actually terminal: no tool lists `alert`, `reschedule`, `locked`, or `finalized`, so
 * every tool call after an escalation or a finalized intake is rejected.
 */
export const TOOL_STATES: Record<ToolName, readonly ConversationState[]> = {
  verify_identity: ["verification"],
  request_reschedule: ["verification"],
  update_intake: ["intake"],
  flag_emergency: ["intake"],
  finalize_intake: ["intake"],
};

export function isToolAllowed(tool: ToolName, state: ConversationState): boolean {
  return TOOL_STATES[tool].includes(state);
}
