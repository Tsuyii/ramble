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
  // The frontend emits semantic modes ("orb" | "capture" | "panel"). Per ADR-0007 the
  // expanded surface IS the dashboard, so map "panel" → the shell's "dashboard" window mode
  // (drops always-on-top, joins the taskbar, centres at 1100×720). The orb morphs up into it,
  // and collapse emits "orb" — which restores the floating chrome. "capture" passes through.
  const MODE_MAP = { panel: "dashboard" };
  window.addEventListener("ramble:mode", (e) => {
    const requested = String(e.detail || "orb");
    R.invoke("set_widget_mode", { mode: MODE_MAP[requested] || requested });
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
