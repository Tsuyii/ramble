// Bridge between the Tauri shell and the (shell-agnostic) frontend.
// No-op in a plain browser — `window.__TAURI__` only exists inside the widget.
// The app emits/consumes plain DOM CustomEvents so app.js never depends on Tauri.
(function () {
  const T = window.__TAURI__;
  if (!T) return;

  const { invoke } = T.core;
  const { listen } = T.event;

  // Mark widget mode immediately (before app.js) so it renders as the orb, not the
  // full app, avoiding a flash of the panel on launch.
  document.body.classList.add("widget");

  // Tell the Rust shell when recording starts/stops so blur won't collapse mid-ramble.
  window.addEventListener("ramble:recording", (e) => {
    invoke("set_recording", { recording: Boolean(e.detail) }).catch(() => {});
  });

  // Frontend asks the shell to morph between orb / capture (recording) / panel.
  window.addEventListener("ramble:mode", (e) => {
    invoke("set_widget_mode", { mode: String(e.detail || "orb") }).catch(() => {});
  });

  // Title-bar drag start/end — so the shell doesn't collapse the panel on the blur that
  // Windows fires during the OS move loop.
  window.addEventListener("ramble:dragging", (e) => {
    invoke("set_dragging", { dragging: Boolean(e.detail) }).catch(() => {});
  });

  // Global hotkey (Ctrl+Shift+Space) → show + start recording.
  listen("ramble:hotkey", () => {
    window.dispatchEvent(new CustomEvent("ramble:start-recording"));
  });

  // Blur → collapse the panel back to the orb.
  listen("ramble:collapse", () => {
    window.dispatchEvent(new CustomEvent("ramble:collapse"));
  });

  // Tray "Settings" item.
  listen("ramble:open-settings", () => {
    window.dispatchEvent(new CustomEvent("ramble:open-settings"));
  });

  // Reminder fired → show a native OS notification (works even when collapsed to the orb).
  window.addEventListener("ramble:notify", (e) => {
    const { title, body } = e.detail || {};
    invoke("notify", { title: String(title || "Ramble"), body: String(body || "") }).catch(() => {});
  });
})();
