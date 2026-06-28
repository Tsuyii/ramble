# AGENTS.md — electron/ (desktop shell DOX)

Child of the root `AGENTS.md`. Read the root first. This doc owns the **Electron shell** that
replaces the retired Tauri shell (ADR-0006).

## Purpose
The desktop wrapper: forks `server.js`, hosts the frontend in a frameless/transparent window,
and provides the orb↔panel morph, global hotkey, tray, and OS notifications.

## Ownership
- `main.cjs` — Electron main process. Forks `server.js`, manages the window + morph + tray +
  global shortcut, and serves the IPC command surface.
- `preload.cjs` — exposes the neutral `window.ramble` API (`invoke`, `on`) via `contextBridge`.
- `tray.png` — the tray icon (read at runtime via `path.join(__dirname, "tray.png")`).
- Page-side bridge lives in `public/electron-bridge.js` (owned by `public/AGENTS.md`). Window
  dragging is CSS (`-webkit-app-region`) in `public/styles.css`, not a main-process concern.

## Local Contracts
- **CommonJS on purpose.** Files are `.cjs` so they stay CommonJS even though the repo root is
  `"type": "module"`. Don't rename to `.js`.
- **Faithful port, no behavior change (Phase 0).** `main.cjs` mirrors the old `lib.rs`: same 3
  morph sizes (orb 140², capture 340×360, panel 400×600), bottom-right orb rest, blur→collapse
  guarded by `recording`/`dragging`, default hotkey `Ctrl+Shift+Space`. The dashboard's
  *normal-window / drop-always-on-top* behavior (ADR-0007) is a **Phase 1** change, NOT here.
- **IPC command surface = the old Tauri commands.** `ramble:invoke` handles `set_recording`,
  `set_widget_mode`, `set_dragging`, `get_api_port`, `set_global_shortcut`, `notify`. Keep these
  names — the frontend depends on them. Errors must **throw** so the renderer promise rejects.
- **Server is forked, not rewritten.** `server.js` runs via `spawn(process.execPath, …,
  { ELECTRON_RUN_AS_NODE: "1" })` with `PORT` / `RAMBLE_DATA_DIR` / `RAMBLE_PUBLIC_DIR`. No
  separate server binary. Kill the child on `will-quit`.
- **Renderer loads from the server origin** (`http://127.0.0.1:PORT`) so the frontend is
  same-origin with the API and mic works (localhost = secure context). Don't load `file://`.
- **Keys never reach the renderer** (root contract). The shell only proxies window/OS concerns.

## Work Guidance
- Run locally: `npm run electron` (this is the whole point of the migration — it builds/runs
  with no Rust, so Smart App Control can't block it). Package: `npm run electron:build`.
- When the real dashboard lands, extend `set_widget_mode`: in `panel` mode drop `alwaysOnTop`,
  clear `skipTaskbar`, and size to the dashboard (ADR-0007). Restore on return to orb.

## Verification
- `node --check electron/main.cjs` and `node --check electron/preload.cjs`.
- `npm run electron` → orb appears bottom-right; tap records; chevron opens the panel; hotkey
  summons; blur collapses (not while recording); tray Show/Settings/Quit work.

## Child DOX Index
- _None._
