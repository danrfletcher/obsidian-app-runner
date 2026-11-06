# App Runner

Obsidian desktop plugin (macOS): register local apps with a start command, open them in Obsidian tabs, and stop them when the last tab closes.

Under construction. This first slice has the project registry (Settings, App Runner), the `Open <name>` and `Stop <name>` commands per project, a global "Pop out current App Runner tab to browser" command, and the webview tab. Starting and stopping the app itself arrives in the next slice; until then Open shows a tab on a project's URL override.

The webview and microphone spike is recorded in `docs/webview-spike.md`.

## Development

    npm install
    npm run typecheck
    npm test
    npm run build     # writes main.js
    npm run dev       # rebuilds main.js on change
