interface RedFlagRule {
  pattern: RegExp;
  reason: string;
}

const RED_FLAG_RULES: RedFlagRule[] = [
  { pattern: /worst headache/i, reason: "Patient described this as the worst headache of their life." },
  { pattern: /thunderclap|sudden.*(severe|worst)/i, reason: "Sudden, severe (\"thunderclap\") onset reported." },
  { pattern: /stiff neck/i, reason: "Neck stiffness reported alongside headache (possible meningitis red flag)." },
  {
    pattern: /(slurred speech|can'?t move|numb(ness)?|weak(ness)? on one side|face droop)/i,
    reason: "Possible neurological deficit reported (weakness, numbness, slurred speech, or facial droop).",
  },
  {
    pattern: /(vision loss|can'?t see|blurry vision|double vision)/i,
    reason: "Vision changes reported alongside headache.",
  },
  {
    pattern: /(passed out|lost consciousness|unconscious|seizure)/i,
    reason: "Loss of consciousness or seizure reported.",
  },
  { pattern: /head injury|hit my head|head trauma/i, reason: "Recent head injury reported." },
  { pattern: /pregnant/i, reason: "Patient is pregnant — headache in pregnancy warrants urgent evaluation." },
];

export interface SafetyScanResult {
  flagged: boolean;
  reason?: string;
}

export function scanForRedFlags(text: string): SafetyScanResult {
  for (const rule of RED_FLAG_RULES) {
    if (rule.pattern.test(text)) {
      return { flagged: true, reason: rule.reason };
    }
  }
  return { flagged: false };
}
