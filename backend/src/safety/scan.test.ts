import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RED_FLAGS, redFlagById, type RedFlagId } from "@threepio/shared";
import { RED_FLAG_PATTERNS } from "./patterns.js";
import { scanForRedFlags } from "./scan.js";

/**
 * One utterance per catalog entry. Typed `Record<RedFlagId, ...>` on purpose: adding a
 * red flag to the shared catalog without deciding how it is tested fails the build, the
 * same way `patterns.ts` fails the build if you don't decide how it is detected.
 *
 * `null` means the flag is model-judgment only and has no deterministic sample.
 */
const SAMPLE_UTTERANCE: Record<RedFlagId, string | null> = {
  thunderclap: "it came on suddenly and it was severe",
  "worst-headache": "honestly this is the worst headache of my life",
  "fever-neck-stiffness": "I have a fever and my neck is stiff",
  "neck-stiffness": "my neck is stiff when I try to look down",
  "neuro-deficit": "there's numbness in my left arm",
  confusion: "I feel confused and a bit disoriented",
  "vision-loss": "I've been getting double vision with it",
  "loss-of-consciousness": "I passed out this morning",
  "head-injury": "I hit my head last week",
  pregnancy: "I should mention I'm pregnant",
  "new-onset-over-50": null,
};

describe("red flag scanner", () => {
  for (const flag of RED_FLAGS) {
    const sample = SAMPLE_UTTERANCE[flag.id];

    if (sample === null) {
      it(`leaves "${flag.id}" to the model`, () => {
        assert.equal(
          RED_FLAG_PATTERNS[flag.id].any.length,
          0,
          "a flag with no sample utterance must be declared model-judgment only"
        );
      });
      continue;
    }

    it(`flags "${flag.id}"`, () => {
      const result = scanForRedFlags(sample);
      assert.equal(result.flagged, true, `expected "${sample}" to flag`);
      assert.equal(result.id, flag.id);
      assert.equal(result.reason, redFlagById(flag.id).reason);
    });
  }

  it("does not escalate on a fever alone", () => {
    assert.deepEqual(scanForRedFlags("I've had a bit of a fever since yesterday"), {
      flagged: false,
    });
  });

  it("escalates on fever plus neck stiffness, with the more specific reason", () => {
    const result = scanForRedFlags("I've got a fever and a stiff neck");
    assert.equal(result.flagged, true);
    assert.equal(result.id, "fever-neck-stiffness");
  });

  it("ignores an ordinary headache description", () => {
    assert.equal(
      scanForRedFlags("it's a dull ache behind my right eye, been there two days").flagged,
      false
    );
  });

  it("has a deterministic pattern decision recorded for every catalog entry", () => {
    for (const flag of RED_FLAGS) {
      assert.ok(
        RED_FLAG_PATTERNS[flag.id],
        `${flag.id} is missing from RED_FLAG_PATTERNS`
      );
    }
  });
});
