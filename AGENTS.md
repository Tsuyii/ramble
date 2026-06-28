# AGENTS.md — Ramble (root DOX)

Binding work contract for this repo. Read this before editing anything here; read any
child `AGENTS.md` on the path to the files you touch; update the nearest owning doc after
meaningful changes.

## Purpose
Ramble — "say it, I'll sort it." A voice/text brain-dump turns into clean, scheduled tasks
via an **adaptive follow-up interview**. It runs as a localhost web app AND as a desktop
**widget**: an always-on-top **orb** for quick capture that **morphs into a full dashboard**.
The browser app and the widget run the **same** frontend and server code.

## Authoritative decisions (read these — don't re-derive)
- `CONTEXT.md` — glossary + all locked decisions (v1, v2 widget, **v3 dashboard+Electron**).
- `ADR-0001-projects-and-learning.md` — projects model + prompt-side "learning".
- `ADR-0002-tauri-node-sidecar.md` — *superseded by ADR-0006* (was: Tauri Node sidecar).
- `ADR-0003-platform-adaptive-captions.md` — live captions Windows-only, graceful fallback.
- `ADR-0004-reminders-and-notifications.md` — due-alerts + manual reminders.
- `ADR-0005-widget-interaction-model.md` — orb-first morph; *revised by ADR-0007*.
- `ADR-0006-electron-shell-migration.md` — **shell is Electron, not Tauri**; `server.js` runs
  in the Electron main process (no per-OS Node sidecar).
- `ADR-0007-dashboard-supersedes-orb-panel.md` — orb morphs UP into a full dashboard that is a
  **normal window, NOT always-on-top**; right detail-panel edits, centered create-modal.
- `ADR-0008-dashboard-data-model.md` — Folder=Project; **Tags** (new, AI-assigned); **Notes**
  (new, standalone); **Subtasks** = `{text,done}` checklist items; local **Profile**, no auth.

## Architecture (target)
- `server.js` — Node/Express. Holds the keys; proxies Groq Whisper (transcribe) and DeepSeek
  (structure/finalize). Persists `data/{tasks,projects,notes,memory}.json`. **The DeepSeek key
  must never reach the renderer.** Under Electron it is started **in the main process**, not as
  a spawned sidecar binary.
- `public/` — vanilla JS/CSS/HTML frontend served at `127.0.0.1:5179`. No build step, no
  framework. The dashboard surfaces live here. See `public/AGENTS.md`.
- `electron/` — the Electron main + preload + tray icon: orb window (frameless, transparent,
  always-on-top, drag), dashboard window (normal), the morph, global hotkey, tray. See
  `electron/AGENTS.md`. (Tauri's `src-tauri/` shell was removed once Electron was proven, ADR-0006.)
- `build/` — packaging resources (`icon.ico` = the app/exe icon for electron-builder).
- `data/` — local JSON state (git-ignored).

## Local Contracts
- **No rewrite of the Express layer.** The four routes and all prompt/JSON/memory logic stay
  unchanged across the Electron migration. The shell change moves *how* `server.js` is started
  (main process vs sidecar), not its behavior (ADR-0006).
- **Same code, two shells.** Anything added to `public/` must keep working in a plain browser
  AND in the Electron renderer. Feature-detect platform/browser capabilities (e.g. Web Speech)
  at runtime — never assume them (ADR-0003).
- **Two window modes.** Orb = always-on-top, frameless, transparent. Dashboard = normal window
  (taskbar + alt-tab), NOT on-top. The morph switches modes (ADR-0007). Only the orb floats.
- **Local-only holds.** Profile is local (name+avatar); **no login, account, cloud, or sync**
  (ADR-0008). Don't add auth surfaces because a reference design shows "Logout".
- **Keys:** `.env` locally; in the packaged app, a Settings page writes them to `config.json`
  in the OS app-data dir (read fresh per request via `currentKeys()`). Never hardcode, commit,
  log, or echo keys back to the UI.
- **Data path:** `server.js` must write JSON to a configurable dir (OS app-data when packaged,
  `./data` in dev) — the install dir is read-only when packaged.
- **Style:** small files (<800 lines), early returns, immutable updates, explicit error
  handling, design tokens (no hardcoded palette/spacing). Conventional-commit messages.

## Work Guidance
- **Build order:** Phase 0 = Electron migration (unblocks LOCAL builds — SAC blocked Tauri),
  then dashboard shell → data model → surfaces. See `electron-dashboard-milestone` memory.
- Dev/debug in the browser at `localhost:5179` (`npm start`); the shell is a thin wrapper. Mic
  needs `localhost`/https — never `file://`.
- Building dashboard UI: run the design skill stack (ui-ux-pro-max → frontend-design →
  taste-skill → impeccable → 21st.dev Magic). Re-token references to Ramble's 6 themes; don't
  paste raw palettes. Reference designs: `C:\Users\Badr\AppData\Local\SXshot\shots\sxshot-79/82/83/84/85.png`.

## Verification
- `node --check server.js` and `node --check public/app.js` after edits.
- Manual: `npm start` → http://localhost:5179, run a ramble end-to-end.
- After Phase 0: local Electron build must succeed (`npm run <electron build>`) — this is the
  whole point of the migration; if it can't build locally, the migration isn't done.
- (No automated test suite yet — add one under a `test/` boundary when it exists.)

## Child DOX Index
- `public/AGENTS.md` — the vanilla-JS frontend: dashboard surfaces, orb/morph UI, design
  tokens/themes, the same-code-two-shells contract.
- `electron/AGENTS.md` — the Electron shell: window modes, morph, hotkey, tray, packaging,
  local build (replaces the retired Tauri shell).
