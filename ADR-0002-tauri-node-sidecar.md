# ADR-0002 — Tauri shell wraps the existing Node server as a sidecar

**Status:** accepted · **Date:** 2026-06-25

## Context
The next milestone wraps Ramble (browser app at `localhost:5179`) as a real desktop
tray + global-hotkey widget. Tauri's webview cannot run the Express server, and the
DeepSeek/Groq keys must NOT live in the browser (locked decision #4). So the
key-holding backend has to be hosted *somewhere* inside the packaged app. Three
options were on the table: bundle Node as a **sidecar**, **port the routes to Rust**,
or keep Node running **externally**.

## Decision
Tauri ships a **bundled Node runtime + the existing `server.js` as a sidecar process**.
On launch the Rust shell spawns the sidecar; the webview loads the *same* frontend from
`http://127.0.0.1:<port>`. The four routes (`/api/transcribe`, `/api/structure`,
`/api/finalize`, projects CRUD) and all prompt/JSON/memory logic stay **byte-for-byte
unchanged**.

- **Rejected — port to Rust:** would re-implement the one part that already works
  (DeepSeek prompting, follow-up/question plumbing, memory loop) in `reqwest`/`serde`.
  High regression risk for the app's core value, for a smaller-binary payoff that a
  personal tool doesn't need.
- **Rejected — keep Node external:** not a self-contained widget; user must keep a
  terminal open. Defeats the milestone.

## Consequences
- **Installer carries a Node binary per OS** (~40-50MB). Targets are Windows + macOS, so
  the build bundles `node-win-x64` and `node-darwin` sidecars; macOS needs codesigning +
  notarization so the spawned binary runs without Gatekeeper warnings.
- **Writable data dir:** a packaged `.app`/`Program Files` install is read-only, so the
  sidecar must NOT write `data/*.json` next to itself. Tauri passes an OS app-data path
  (via env var) and `server.js` writes there instead of `./data`.
- **Port handling:** `5179` may be taken; the shell picks/passes a free port to both the
  sidecar and the webview URL rather than hardcoding.
- **Mic permissions** become a packaging concern: WebView2 permission handler on Windows;
  macOS entitlements (`NSMicrophoneUsageDescription`, audio-input) in the bundle.
- Upside: the browser build at `localhost:5179` and the widget run the **same code**, so
  development/debugging stays in the browser; the Tauri shell is a thin wrapper.
