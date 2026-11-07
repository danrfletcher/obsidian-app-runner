/**
 * G12: why an instance is Held. The reason is stored as data (a short code in the registry entry and on the instance), so
 * a later reason is one more code here and one more line in `heldReasonText`, with no schema change.
 *
 * This PR has one reason: the app was opened in the browser (Pop out, or the Open-in-browser setting). Browser tab
 * monitoring does not exist yet, so nothing ends that hold except Stop, a crash or deleting the project.
 */
export const HELD_OPENED_IN_BROWSER = "opened-in-browser";

const REASON_TEXT: Record<string, string> = {
  [HELD_OPENED_IN_BROWSER]: "opened in browser, stops only on Stop",
};

/** The longest stored reason read back from a registry file, so a hand-edited entry cannot flood the running list. */
export const MAX_HELD_REASON_LENGTH = 200;

/** How the running list words a Held reason. A code with no wording is shown as it is. */
export function heldReasonText(reason: string): string {
  const trimmed = reason.trim();
  return REASON_TEXT[trimmed] ?? trimmed;
}
