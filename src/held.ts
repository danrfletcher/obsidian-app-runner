/**
 * G12, G13: why an instance is Held. The reason is stored as data (a short code in the registry entry and on the
 * instance), so a reason is one code here and one line in `heldReasonText`, with no schema change.
 *
 * - `opened-in-browser`: the app was opened in the browser (Pop out, or the Open-in-browser setting) and the 30 s hold
 *   has not ended. It ends when the browser poll sees a tab, or 30 s after its first successful tab read with none seen.
 * - The other three say the browser cannot be read, so the app cannot be judged and is never stopped for lack of a tab.
 *   `automation-denied` is permanent for the instance (the macOS permission was refused); the other two clear at the
 *   next poll that can read.
 */
export const HELD_OPENED_IN_BROWSER = "opened-in-browser";
export const HELD_BROWSER_UNSUPPORTED = "browser-unsupported";
export const HELD_AUTOMATION_DENIED = "automation-denied";
export const HELD_BROWSER_UNREADABLE = "browser-unreadable";

const REASON_TEXT: Record<string, string> = {
  [HELD_OPENED_IN_BROWSER]: "opened in browser, waiting to read its tabs",
  [HELD_BROWSER_UNSUPPORTED]: "default browser not supported (Brave, Chrome, Arc or Edge only), stops only on Stop",
  [HELD_AUTOMATION_DENIED]: "browser Automation permission denied, stops only on Stop",
  [HELD_BROWSER_UNREADABLE]: "could not read the browser's tabs",
};

/** The longest stored reason read back from a registry file, so a hand-edited entry cannot flood the running list. */
export const MAX_HELD_REASON_LENGTH = 200;

/** How the running list words a Held reason. A code with no wording is shown as it is. */
export function heldReasonText(reason: string): string {
  const trimmed = reason.trim();
  return REASON_TEXT[trimmed] ?? trimmed;
}
