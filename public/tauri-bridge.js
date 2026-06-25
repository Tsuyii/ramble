// Bridge between the Tauri shell and the (shell-agnostic) frontend.
// No-op in a plain browser — `window.__TAURI__` only exists inside the widget.
// The app emits/consumes plain DOM CustomEvents so app.js never depends on Tauri.
(function () {
  const T = window.__TAURI__;
  if (!T) return;

  const { invoke } = T.core;
  const { listen } = T.event;

  // Tell the Rust shell when recording starts/stops so it won't auto-hide on blur.
  window.addEventListener("ramble:recording", (e) => {
    invoke("set_recording", { recording: Boolean(e.detail) }).catch(() => {});
  });

  // Global hotkey (Ctrl+Shift+Space) → show + start recording.
  listen("ramble:hotkey", () => {
    window.dispatchEvent(new CustomEvent("ramble:start-recording"));
  });

  // Tray "Settings" item.
  listen("ramble:open-settings", () => {
    window.dispatchEvent(new CustomEvent("ramble:open-settings"));
  });
})();
