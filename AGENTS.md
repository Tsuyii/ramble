# AGENTS.md — Ramble (root DOX)

Binding work contract for this repo. Read this before editing anything here; read any
child `AGENTS.md` on the path to the files you touch; update the nearest owning doc after
meaningful changes.

## Purpose
Ramble — "say it, I'll sort it." A voice/text brain-dump turns into clean, scheduled tasks
via an **adaptive follow-up interview**. v1 is a browser app; v2 wraps it as a Tauri tray +
global-hotkey desktop **widget**. The browser app and the widget run the **same** frontend
and server code.

## Authoritative decisions (read these — don't re-derive)
- `CONTEXT.md` — glossary + all locked decisions (v1 and v2 widget).
- `ADR-0001-projects-and-learning.md` — projects model + prompt-side "learning".
- `ADR-0002-tauri-node-sidecar.md` — Tauri spawns `server.js` as a bundled Node sidecar.
- `ADR-0003-platform-adaptive-captions.md` — live captions Windows-only, graceful fallback.

## Architecture (current)
- `server.js` — Node/Express. Holds the keys; proxies Groq Whisper (transcribe) and DeepSeek
  (structure/finalize). Persists `data/{tasks,projects,memory}.json`. **The DeepSeek key must
  never reach the browser.**
- `public/` — vanilla JS/CSS/HTML frontend served at `127.0.0.1:5179`. No build step, no
  framework. `app.js` = client logic, the one-at-a-time follow-up interview, project bar.
- `data/` — local JSON state (git-ignored).

## Local Contracts
- **No rewrite of `server.js` for the widget.** Tauri wraps it as a sidecar; the four routes
  and all prompt/JSON/memory logic stay unchanged (ADR-0002). New backend behavior is added,
  not migrated to Rust.
- **Same code, two shells.** Anything added to `public/` must keep working in a plain browser
  AND in the Tauri webview. Feature-detect platform/browser capabilities (e.g. Web Speech) at
  runtime — never assume them (ADR-0003).
- **Keys:** `.env` locally; in the packaged app, a Settings page writes them to
  `config.json` in the OS app-data dir (read by the server via `currentKeys()`, fresh per
  request). Never hardcode or commit keys; never log them; never echo them back to the UI.
- **Data path:** `server.js` must write JSON to a configurable dir (OS app-data when packaged,
  `./data` in dev) — the install dir is read-only when packaged.
- **Style:** small files (<800 lines), early returns, immutable updates, explicit error
  handling, design tokens (no hardcoded palette/spacing). Conventional-commit messages.

## Work Guidance
- Dev/debug in the browser at `localhost:5179` (`npm start`); the Tauri shell is a thin
  wrapper. Mic needs `localhost`/https — never `file://`.
- The widget UX: an **orb** bottom-right → pulses while recording → expands to a task panel →
  collapses when idle. Global hotkey = show + start recording (default `Ctrl+Shift+Space`,
  rebindable). Auto-hide on blur; pinned while recording.

## Verification
- `node --check server.js` and `node --check public/app.js` after edits.
- Manual: `npm start` → http://localhost:5179, run a ramble end-to-end.
- (No automated test suite yet — add one under a `test/` boundary when it exists.)

## Child DOX Index
- _None yet._ Create `src-tauri/AGENTS.md` when the Tauri shell lands (its own build/sign/
  package + sidecar-spawn contracts).
