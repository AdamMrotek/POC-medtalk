import { RED_FLAGS, type RedFlagId } from "@threepio/shared";
import { RED_FLAG_PATTERNS } from "./patterns.js";

export interface SafetyScanResult {
  flagged: boolean;
  id?: RedFlagId;
  reason?: string;
}

/**
 * Independent, non-LLM safety net: scans the patient's own transcribed words for
 * red-flag phrases so an emergency isn't missed if the conversational model doesn't call
 * flag_emergency. Catalog order decides precedence, so more specific entries are listed
 * first and win.
 */
export function scanForRedFlags(text: string): SafetyScanResult {
  for (const flag of RED_FLAGS) {
    const pattern = RED_FLAG_PATTERNS[flag.id];
    if (pattern.any.length === 0) continue;
    if (!pattern.any.some((re) => re.test(text))) continue;
    if (pattern.alsoRequires && !pattern.alsoRequires.some((re) => re.test(text))) continue;
    return { flagged: true, id: flag.id, reason: flag.reason };
  }
  return { flagged: false };
}
