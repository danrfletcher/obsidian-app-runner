# Webview spike (PR-1)

Question: can App Runner embed an app in an Obsidian tab with `<webview>`, and can the embedded page use the
microphone (Live Captions needs it)? This result gates the rest of the ticket.

## Status

| Part | State |
|---|---|
| Code that decides at tab load (`isWebviewAvailable()`, fallback to the default browser) | Built and unit-tested in PR-1 |
| Static reading of the installed Obsidian app on Dan's Mac (1.14.4) | Done, below. A reading of the code, not a run |
| Container run (is `webviewTag` available, what does `getUserMedia` return) | Done 2026-11-06 by the tester. Results below under "Container result" |
| Real microphone, Live Captions on port 8957, inside an Obsidian tab on the Mac | **Not yet run. Human at Review fills in "Final call".** |

Nothing in this file is a runtime result unless it is under a "result" heading and says who ran it and when.

## What the code does (E18)

At tab load `isWebviewAvailable()` (src/webview-view.ts) returns true when the `webview` custom element is defined or a
created `<webview>` element has `getWebContentsId`. In an Electron window created without `webviewTag` the tag is an
unknown element and both checks fail. When it is false the tab renders nothing, the page opens in the default browser,
a notice says why, and the tab closes. The check is a heuristic; the container run below confirms it on a real window.

## Static reading of Obsidian 1.14.4 (`/Applications/Obsidian.app`, `obsidian.asar` main process)

Read from the unpacked main-process bundle on 2026-11-06. This is evidence for what to expect, not a test.

- The main window's `webPreferences` contain `webviewTag: true` (so is the pop-out window's). Expected: E18's case is
  "webview available" for this version. Obsidian does attach a `will-attach-webview` hook that removes preload scripts,
  forces `sandbox`, disables node integration and sets `webviewTag=false` for the guest (so a page inside cannot nest
  another webview). A guest that opens an `http(s)` link in a new window is handed to the OS browser.
- Permissions are decided in the main process, per session:
  - the default session's request handler allows only the app's own `app://obsidian.md/` pages, and logs
    "Blocked permission request" for anything else. A `<webview>` with no `partition` attribute lives in that session,
    so the microphone request from `http://127.0.0.1:8957` would be refused there.
  - sessions Obsidian creates itself for its Web viewer (`create-browser-session`) answer true only for
    `clipboard-read` and `clipboard-sanitized-write`, so the microphone is refused there too.
  - no handler is set for any other partition name. Electron's default for a session with no handler is to allow the
    request. The plugin therefore gives its webviews their own partition, `persist:app-runner`, which is neither of the
    two sessions above.
- The app bundle's Info.plist has `NSMicrophoneUsageDescription`, so macOS can show its microphone prompt for Obsidian.

Consequence for the design: the tab sets `partition="persist:app-runner"` (src/webview-view.ts). Without it the
microphone would very likely be blocked. Whether the guess holds (no handler, so allowed) is what the runs below decide.

## How to run the container check

1. In the container, with the plugin enabled in a test vault, start a page server on a free port, bound to loopback:
   `python3 -m http.server <port> --bind 127.0.0.1 --directory docs/spike`
2. Open Obsidian's developer console in the window under test, paste `docs/spike/probe.js`, run
   `await appRunnerSpike(<port>)`, and copy the printed object into "Container result".
3. For the G11 screenshot: set a project's URL override to `http://127.0.0.1:<port>` and run its Open command. The DOM
   check is `document.querySelector('.app-runner-webview')?.tagName` giving `WEBVIEW`.

The container has no microphone, so `getUserMedia` there can only show whether the request reaches the system (a
`NotFoundError` or `NotReadableError` means the permission layer let it through and no device exists; `NotAllowedError`
means Obsidian or Electron refused it).

## Container result

Run by the tester on 2026-11-06 in the disposable desktop container `desktop-warkworth-52` (linux aarch64), with the
plugin enabled in a test vault and `docs/spike/probe.js` run in Obsidian's developer console against a loopback page
server. Raw output: `evidence/PR-1/spike-container-result.json` in the ticket folder (outside the repo).

| Item | Result |
|---|---|
| Obsidian version | The window's user agent reports 1.14.4. The log shows the 1.15.0 asar loaded at start (Obsidian auto-updated itself during the run) |
| Electron | 43.7.7 |
| `webviewCustomElementDefined` | `true` |
| `webviewHasApi` | `true` (so `isWebviewAvailable()` returns true; E18's fallback is not taken) |
| partition | `persist:app-runner` |
| `getUserMedia({audio: true})` in the webview | secure context `true`, `navigator.mediaDevices` present, **rejected with `NotFoundError: Requested device not found`** |

Reading: `NotFoundError` is not `NotAllowedError`, so the permission layer let the request through and the only thing
missing was a device. That is what the dedicated partition was meant to achieve (see the static reading above).

**Caveat: container only, no microphone.** The container has no audio input, so this does not show that a real
microphone is captured, only that Obsidian and Electron did not refuse the request. It also does not cover the macOS
microphone prompt for Obsidian on Dan's Mac. That is what "Final call" below is for.

## Decision

Provisional, tested in the container only: **keep the webview, with the dedicated `persist:app-runner` partition.** The
request reached the device layer (`NotFoundError`, not `NotAllowedError`), so the Open-in-browser fallback for Live
Captions (tabs showing a banner that offers Pop out to browser) is not needed on this evidence. It becomes the decision
if the final call below shows `NotAllowedError` or no audio. The spike still gates PR-2 to PR-6 until the final call is
recorded.

## Final call (human at Review)

_Not yet run._ Live Captions on port 8957 inside an Obsidian tab on the Mac with a real microphone: record granted or
refused, the Obsidian version, the date, and the final decision (webview kept, or the Open-in-browser fallback).
