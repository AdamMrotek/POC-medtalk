import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import {
  CLOSING_STATES,
  TOOL_STATES,
  TRANSITIONS,
  isToolAllowed,
  nextState,
  type ConversationEvent,
  type ConversationState,
  type ToolName,
} from "@threepio/shared";
import { applyEvent, createSession, resetStore } from "./intakeStore.js";

const ALL_STATES = Object.keys(TRANSITIONS) as ConversationState[];
const ALL_EVENTS: ConversationEvent[] = [
  "identity_verified",
  "verification_locked",
  "reschedule_requested",
  "red_flag",
  "intake_finalized",
];

describe("transition table", () => {
  it("routes verification through its four exits", () => {
    assert.equal(nextState("verification", "identity_verified"), "intake");
    assert.equal(nextState("verification", "verification_locked"), "locked");
    assert.equal(nextState("verification", "reschedule_requested"), "reschedule");
    assert.equal(nextState("verification", "red_flag"), "alert");
  });

  it("lets intake finalize or escalate, and nothing else", () => {
    assert.equal(nextState("intake", "intake_finalized"), "finalized");
    assert.equal(nextState("intake", "red_flag"), "alert");
    assert.equal(nextState("intake", "identity_verified"), null);
    assert.equal(nextState("intake", "reschedule_requested"), null);
  });

  it("makes alert the one true sink", () => {
    for (const event of ALL_EVENTS) {
      assert.equal(nextState("alert", event), null, `alert should not accept ${event}`);
    }
  });

  it("still escalates from every other closing state", () => {
    for (const state of CLOSING_STATES) {
      if (state === "alert") continue;
      assert.equal(
        nextState(state, "red_flag"),
        "alert",
        `${state} must remain reachable by the safety scanner`
      );
    }
  });

  it("rejects every non-declared state/event pair", () => {
    for (const state of ALL_STATES) {
      for (const event of ALL_EVENTS) {
        const declared = TRANSITIONS[state][event];
        assert.equal(
          nextState(state, event),
          declared ?? null,
          `${state} + ${event} should only transition when declared`
        );
      }
    }
  });
});

describe("tool availability", () => {
  it("allows no tools at all from any closing state", () => {
    for (const state of CLOSING_STATES) {
      for (const tool of Object.keys(TOOL_STATES) as ToolName[]) {
        assert.equal(
          isToolAllowed(tool, state),
          false,
          `${tool} must not be callable from ${state}`
        );
      }
    }
  });

  it("keeps verification and intake tools separate", () => {
    assert.equal(isToolAllowed("verify_identity", "verification"), true);
    assert.equal(isToolAllowed("verify_identity", "intake"), false);
    assert.equal(isToolAllowed("update_intake", "intake"), true);
    assert.equal(isToolAllowed("update_intake", "verification"), false);
  });
});

describe("applyEvent", () => {
  beforeEach(resetStore);

  it("refuses an illegal event and leaves the record untouched", () => {
    const { sessionId } = createSession();
    const { record, applied } = applyEvent(sessionId, "intake_finalized");
    assert.equal(applied, false);
    assert.equal(record.state, "verification");
    assert.equal(record.history.length, 0);
  });

  it("appends an audit entry for every accepted transition", () => {
    const { sessionId } = createSession();
    applyEvent(sessionId, "identity_verified", { verified: true });
    const { record } = applyEvent(sessionId, "red_flag");

    assert.equal(record.state, "alert");
    assert.deepEqual(
      record.history.map((entry) => [entry.from, entry.event, entry.to]),
      [
        ["verification", "identity_verified", "intake"],
        ["intake", "red_flag", "alert"],
      ]
    );
  });

  it("does not re-escalate a session already in alert", () => {
    const { sessionId } = createSession();
    applyEvent(sessionId, "red_flag");
    const second = applyEvent(sessionId, "red_flag");
    assert.equal(second.applied, false);
    assert.equal(second.record.history.length, 1);
  });
});
