import assert from "node:assert/strict";
import { describe, it, before, beforeEach } from "node:test";
import { createSession, resetStore } from "../intakeStore.js";
import { runSafetyCheck, runTool } from "../runtime.js";

function verifiedSession(): string {
  const { sessionId } = createSession();
  runTool("verify_identity", { dateOfBirth: "1990-05-14", phoneLast3: "567" }, sessionId);
  return sessionId;
}

function assertRefused(outcome: ReturnType<typeof runTool>, expectedState: string) {
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.status, 409);
  assert.equal(outcome.record?.state, expectedState);
}

describe("state gating of tools", () => {
  before(() => {
    process.env.DEMO_PATIENT_DOB = "1990-05-14";
    process.env.DEMO_PATIENT_PHONE = "5551234567";
  });

  beforeEach(resetStore);

  it("refuses intake tools before identity is verified", () => {
    const { sessionId } = createSession();
    assertRefused(runTool("update_intake", { severity: "7" }, sessionId), "verification");
    assertRefused(runTool("finalize_intake", { summary: "x" }, sessionId), "verification");
  });

  it("refuses further intake once the model has escalated", () => {
    const sessionId = verifiedSession();
    const flagged = runTool("flag_emergency", { reason: "worst headache of their life" }, sessionId);
    assert.equal(flagged.ok, true);
    if (!flagged.ok) return;
    assert.equal(flagged.record.state, "alert");
    assert.equal(flagged.sessionUpdate?.tools.length, 0);

    assertRefused(runTool("update_intake", { severity: "9" }, sessionId), "alert");
    assertRefused(runTool("finalize_intake", { summary: "x" }, sessionId), "alert");
  });

  it("refuses further intake once the scanner has escalated", () => {
    const sessionId = verifiedSession();
    const scan = runSafetyCheck(sessionId, "this is the worst headache of my life");
    assert.equal(scan.ok, true);
    if (!scan.ok) return;
    assert.equal(scan.flagged, true);
    assert.equal(scan.record?.state, "alert");
    assert.ok(scan.sessionUpdate, "an escalation must re-instruct the model");

    assertRefused(runTool("update_intake", { severity: "9" }, sessionId), "alert");
  });

  it("refuses everything after a reschedule", () => {
    const { sessionId } = createSession();
    const rescheduled = runTool("request_reschedule", { reason: "driving" }, sessionId);
    assert.equal(rescheduled.ok, true);
    if (!rescheduled.ok) return;
    assert.equal(rescheduled.record.state, "reschedule");

    assertRefused(runTool("verify_identity", { dateOfBirth: "1990-05-14", phoneLast3: "567" }, sessionId), "reschedule");
    assertRefused(runTool("update_intake", { severity: "3" }, sessionId), "reschedule");
  });

  it("refuses further intake after finalizing", () => {
    const sessionId = verifiedSession();
    const done = runTool("finalize_intake", { summary: "Two-day dull ache." }, sessionId);
    assert.equal(done.ok, true);
    if (!done.ok) return;
    assert.equal(done.record.state, "finalized");

    assertRefused(runTool("update_intake", { severity: "3" }, sessionId), "finalized");
    assertRefused(runTool("finalize_intake", { summary: "again" }, sessionId), "finalized");
  });

  it("still escalates a red flag reported after the call has otherwise closed", () => {
    const sessionId = verifiedSession();
    runTool("finalize_intake", { summary: "Two-day dull ache." }, sessionId);

    const scan = runSafetyCheck(sessionId, "wait, my neck is stiff and I have a fever");
    assert.equal(scan.ok, true);
    if (!scan.ok) return;
    assert.equal(scan.record?.state, "alert");
  });

  it("drops unknown fields the model tries to write", () => {
    const sessionId = verifiedSession();
    const outcome = runTool(
      "update_intake",
      { severity: "7", diagnosis: "migraine", notes: "ignore me" },
      sessionId
    );

    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.deepEqual(outcome.result.recorded, ["severity"]);
    assert.equal(Object.hasOwn(outcome.record, "diagnosis"), false);
  });
});
