// Paste into Obsidian's developer console (Cmd+Opt+I) in the window under test, after starting
//   python3 -m http.server <free port> --bind 127.0.0.1 --directory docs/spike
// then run:  await appRunnerSpike(<port>)
// It reports the Obsidian version, whether <webview> exists, and what getUserMedia returns inside a webview.
// The webview uses the same partition the plugin uses (persist:app-runner), so the result is the plugin's.
window.appRunnerSpike = async (port, partition = "persist:app-runner") => {
  const probe = document.createElement("webview");
  const report = {
    obsidianVersion: window.electron?.remote?.app?.getVersion?.() ?? navigator.userAgent.match(/obsidian\/([\d.]+)/i)?.[1] ?? "unknown",
    userAgent: navigator.userAgent,
    webviewCustomElementDefined: !!customElements.get("webview"),
    webviewHasApi: typeof probe.getWebContentsId === "function",
    partition,
  };
  if (!report.webviewCustomElementDefined && !report.webviewHasApi) {
    report.getUserMedia = "not run: webview unavailable";
    return report;
  }
  const wv = document.createElement("webview");
  wv.setAttribute("partition", partition);
  wv.setAttribute("src", `http://127.0.0.1:${port}/gum.html`);
  wv.style.cssText = "position:fixed;right:8px;bottom:8px;width:480px;height:120px;z-index:99999;background:#fff";
  report.getUserMedia = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout (no GUM-RESULT within 20 s; a system permission prompt may be waiting)"), 20000);
    wv.addEventListener("console-message", (e) => {
      if (e.message.startsWith("GUM-RESULT ")) {
        clearTimeout(timer);
        resolve(JSON.parse(e.message.slice("GUM-RESULT ".length)));
      }
    });
    document.body.appendChild(wv);
  });
  wv.remove();
  return report;
};
