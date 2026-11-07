# App Runner

Obsidian desktop plugin (macOS): register local apps with a start command, open them in Obsidian tabs, and stop them when the last tab closes.

Under construction. So far: the project registry (Settings, App Runner), the `Open <name>` and `Stop <name>` commands per project, a global "Pop out current App Runner tab to browser" command, the webview tab, and starting and stopping the app itself.

## How an app is run

- `Open <name>` runs the project's command as `/bin/zsh -lic '<command>'` in the project folder, in its own process group. Your login shell's PATH applies (nvm node, for example). stdin is ignored and there is no terminal.
- The plugin looks for the TCP ports the group listens on (`lsof`), waits until one answers `GET /` over loopback (any status counts; 2 s per try, retried every 1 s, 60 s in all), then opens the tab. If several ports serve a page it asks once and remembers the choice as the project's URL override. Only 127.0.0.1, localhost and [::1] are ever probed or shown; a listener on any other address, or a URL override that is not loopback, is ignored.
- If every process exits first, or 60 s pass, the group is stopped, no tab opens and a notice shows the last 10 log lines.
- `Stop <name>` sends SIGTERM to the group, then SIGKILL after 5 s if anything is still alive. It only signals a group the plugin started: the pid and start time of each member are recorded in `running.json`, and a group with no live recorded member is left alone. If the signal cannot be sent (for example a permission error), a notice says why and the app stays listed as running; the Kill-when-all-tabs-closed timer does not retry it, so Stop (or opening it again) is up to you. Until adoption at relaunch lands, apps are also stopped when the plugin unloads.
- Output (stdout and stderr) goes to `logs/<slug>.log`, truncated at each start. Runtime files live in `~/Library/Application Support/Obsidian App Runner/<vault key>/`, outside the vault. **Show log** in the project's settings row opens the file in the system app, or reveals it in Finder.

### Known limit

Stop kills the process group, nothing more. A child that daemonises and leaves the group (a new session, for example `setsid` or Node's `detached: true`) survives Stop. The plugin does not hunt for it and does not claim it is stopped. Members started after the app was ready are recorded by a 5 s poll while the app runs, and again when the leader exits, so a worker that outlives its leader keeps the app running and Stop still signals it; the app is reported as stopped on its own only once no recorded member is left. A worker that leaves the group within one poll interval of starting is not seen.

The webview and microphone spike is recorded in `docs/webview-spike.md`.

## Development

    npm install
    npm run typecheck
    npm test
    npm run build     # writes main.js
    npm run dev       # rebuilds main.js on change
