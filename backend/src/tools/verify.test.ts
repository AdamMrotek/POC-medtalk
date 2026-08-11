import assert from "node:assert/strict";
import { describe, it, before, beforeEach } from "node:test";
import { createSession, resetStore } from "../intakeStore.js";
import { runTool } from "../runtime.js";
import { MAX_VERIFICATION_ATTEMPTS } from "./index.js";

const GOOD = { dateOfBirth: "1990-05-14", phoneLast3: "567" };
const BAD = { dateOfBirth: "1980-01-01", phoneLast3: "000" };

describe("identity verification", () => {
  before(() => {
    process.env.DEMO_PATIENT_DOB = "1990-05-14";
    process.env.DEMO_PATIENT_PHONE = "5551234567";
  });

  beforeEach(resetStore);

  it("verifies on matching details and hands off to intake", () => {
    const { sessionId } = createSession();
    const outcome = runTool("verify_identity", GOOD, sessionId);

    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.result.verified, true);
    assert.equal(outcome.record.state, "intake");
    assert.ok(outcome.sessionUpdate, "a handoff must ship the next state's config");
    assert.ok(
      outcome.sessionUpdate.tools.some((tool) => tool.name === "update_intake"),
      "intake config must expose the intake tools"
    );
  });

  it("counts down attempts, then locks", () => {
    const { sessionId } = createSession();

    for (let attempt = 1; attempt < MAX_VERIFICATION_ATTEMPTS; attempt += 1) {
      const outcome = runTool("verify_identity", BAD, sessionId);
      assert.equal(outcome.ok, true);
      if (!outcome.ok) return;
      assert.equal(outcome.result.verified, false);
      assert.equal(outcome.result.locked, false);
      assert.equal(outcome.record.state, "verification");
    }

    const final = runTool("verify_identity", BAD, sessionId);
    assert.equal(final.ok, true);
    if (!final.ok) return;
    assert.equal(final.result.locked, true);
    assert.equal(final.record.state, "locked");
    assert.equal(final.record.locked, true);
    assert.ok(final.sessionUpdate, "locking must re-instruct the model to stop asking");
    assert.equal(
      final.sessionUpdate.tools.length,
      0,
      "a locked session must leave the model with no tools"
    );
  });

  // The regression test for the original defect: `matches` was evaluated before the
  // attempt counter and `locked` was never persisted, so a correct answer on the fourth
  // try verified the caller anyway.
  it("refuses a correct answer once the session is locked", () => {
    const { sessionId } = createSession();
    for (let attempt = 0; attempt < MAX_VERIFICATION_ATTEMPTS; attempt += 1) {
      runTool("verify_identity", BAD, sessionId);
    }

    const outcome = runTool("verify_identity", GOOD, sessionId);

    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.status, 409);
    assert.equal(outcome.record?.state, "locked");
    assert.equal(outcome.record?.verified, false);
  });
});
