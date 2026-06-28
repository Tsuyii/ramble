// Exposes the neutral, shell-agnostic API the frontend talks to. The renderer never sees
// Electron internals — only `window.ramble.invoke(cmd, args)` (request/response) and
// `window.ramble.on(event, cb)` (shell → frontend events). The Tauri shell exposed the
// same surface via window.__TAURI__; app.js prefers window.ramble. See public/AGENTS.md.
const { contextBridge, ipcRenderer } = require("electron");

const SHELL_EVENTS = ["ramble:hotkey", "ramble:collapse", "ramble:open-settings"];

contextBridge.exposeInMainWorld("ramble", {
  invoke: (cmd, args = {}) => ipcRenderer.invoke("ramble:invoke", cmd, args),
  on: (event, cb) => {
    if (!SHELL_EVENTS.includes(event)) return () => {};
    const handler = () => cb();
    ipcRenderer.on(event, handler);
    return () => ipcRenderer.removeListener(event, handler);
  },
});
