// Bridge between the Electron shell and the (shell-agnostic) frontend. Mirrors
// tauri-bridge.js exactly, but talks to window.ramble (preload) instead of window.__TAURI__.
// No-op in a plain browser — window.ramble only exists inside the Electron widget.
// app.js stays shell-agnostic: it emits/consumes plain DOM CustomEvents; this file
// translates them to/from the shell. See public/AGENTS.md, ADR-0006.
(function () {
  const R = window.ramble;
  if (!R) return;

  // Render as the orb, not the full app, avoiding a flash of the panel on launch.
  document.body.classList.add("widget");

  // Frontend → shell (fire-and-forget).
  window.addEventListener("ramble:recording", (e) => {
    R.invoke("set_recording", { recording: Boolean(e.detail) });
  });
  window.addEventListener("ramble:mode", (e) => {
    R.invoke("set_widget_mode", { mode: String(e.detail || "orb") });
  });
  window.addEventListener("ramble:dragging", (e) => {
    R.invoke("set_dragging", { dragging: Boolean(e.detail) });
  });
  window.addEventListener("ramble:notify", (e) => {
    const { title, body } = e.detail || {};
    R.invoke("notify", { title: String(title || "Ramble"), body: String(body || "") });
  });

  // Shell → frontend.
  R.on("ramble:hotkey", () => window.dispatchEvent(new CustomEvent("ramble:start-recording")));
  R.on("ramble:collapse", () => window.dispatchEvent(new CustomEvent("ramble:collapse")));
  R.on("ramble:open-settings", () => window.dispatchEvent(new CustomEvent("ramble:open-settings")));
})();
