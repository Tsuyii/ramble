# ADR-0006 — Migrate the desktop shell from Tauri to Electron

**Status:** Accepted (2026-06-28)
**Supersedes:** [[ADR-0002-tauri-node-sidecar]] (the Rust-shell + bundled Node-sidecar architecture).

## Context
The v2 widget is a Tauri (Rust) shell wrapping the existing Express `server.js`, which Tauri
spawns as a bundled per-OS **Node sidecar**. Two forces broke this:

1. **Local builds are blocked.** Windows Smart App Control blocks Tauri's proc-macro DLLs, so
   the desktop app **cannot be built locally** — every change goes through a GitHub Actions
   cloud build. That is a slow iteration loop.
2. **The dashboard milestone means heavy frontend iteration.** We're about to build a full
   dashboard (see [[ADR-0007-dashboard-supersedes-orb-panel]]) and the user will iterate on it
   constantly. A blocked local build loop is the dominant tax on that work.

## Decision
Replace the Tauri/Rust shell with **Electron**.

- `server.js` runs **in-process as the Electron main process** (or a forked child), not as a
  bundled per-OS Node binary. The webview (`BrowserWindow`) loads the same frontend from
  `127.0.0.1`. No frontend rewrite; no per-OS sidecar binary to package.
- The orb (frameless, transparent, always-on-top, draggable) and the dashboard window are
  Electron `BrowserWindow`s. The 505-line Rust shell (`lib.rs`: centering, grip-drag, anchored
  resize) is reimplemented once in Electron's window APIs.
- Keys still live server-side in `config.json` in the OS app-data dir, never in the renderer.

## Why this is a real trade-off
- **Bundle size & RAM:** Electron ships ~150 MB and uses more memory vs Tauri's ~10 MB. Accepted:
  this is a personal tool where **iteration speed and local buildability outweigh footprint**.
- **Throwing away working Rust:** the orb/morph shell already exists in Rust. Accepted: it's a
  one-time, mechanical reimplementation, and Electron's multi-window / transparent / always-on-top
  APIs are simpler to extend as the dashboard grows.
- **Considered & rejected:** (a) *Stay on Tauri, fix SAC* — fragile, OS-policy-dependent, still
  fiddly window APIs. (b) *Prototype dashboard in the browser, migrate last* — defers but doesn't
  remove the migration, and means building the big surface without a real desktop loop.

## Consequences
- **Build order:** migrate the shell to Electron **first** (small, well-understood) to unblock
  local builds, **then** build the dashboard with a fast local loop.
- The "always cloud-build via GitHub Actions" rule (project memory) is retired once Electron
  builds locally; CI remains for release artifacts.
- `tasks/projects/notes/memory.json` still written to the OS app-data dir by the same server code.
