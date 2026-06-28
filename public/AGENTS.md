# AGENTS.md — public/ (frontend DOX)

Child of the root `AGENTS.md`. Read the root first (repo-wide rules, ADRs, key safety,
build order). This doc owns the **frontend**: the vanilla-JS UI, the orb/morph, and the
dashboard surfaces.

## Purpose
The entire Ramble UI: served at `127.0.0.1:5179`, runs identically in a plain browser and
in the desktop shell's renderer. No framework, no build step.

## Ownership
- `index.html` — single-page shell + templates.
- `app.js` (~1.6k lines) — all client logic: capture/recording, the one-at-a-time follow-up
  interview, task rendering, project bar, themes. The dashboard surfaces are added here.
- `styles.css` (~2.5k lines) — design tokens + all styling; 6 themes via `data-theme`.
- `tauri-bridge.js` — *(being replaced)* shell adapter; see Local Contracts.

## Local Contracts
- **Shell-agnostic core (do not break this).** `app.js` MUST depend only on DOM CustomEvents,
  never on a specific shell global. The bridge file translates between the shell and these
  events. The contract:
  - app.js **emits**: `ramble:recording` (bool), `ramble:mode` (`orb`|`capture`|`panel`),
    `ramble:dragging` (bool), `ramble:notify` (`{title,body}`).
  - app.js **listens for**: `ramble:hotkey`, `ramble:collapse`, `ramble:open-settings`,
    `ramble:start-recording`.
  - In a plain browser the bridge is a no-op (events go nowhere) and the app runs full-page.
  - **Electron migration:** add `electron-bridge.js` mirroring `tauri-bridge.js` exactly — same
    events, wired through the preload `contextBridge` API instead of `window.__TAURI__`. `app.js`
    stays untouched. Remove `tauri-bridge.js` once Electron is proven (ADR-0006).
- **Widget mode flag.** The bridge adds `body.widget` before `app.js` runs so it renders as the
  orb, not a flash of the full panel. Preserve this.
- **Feature-detect, never assume.** Web Speech / mic / platform APIs are detected at runtime
  (ADR-0003). Mic requires `localhost`/https — never `file://`.
- **Design tokens only.** No hardcoded palette/spacing/typography — use the CSS custom
  properties. New dashboard colors (tag colors, folder accents) become tokens that respect all
  6 themes; re-token reference designs, don't paste raw hex (see root Work Guidance).
- **Dashboard surfaces (ADR-0007/0008):** sidebar nav (Folders, Tags, filters, Profile +
  Settings) · task list grouped by date · **right detail-panel** to edit a clicked task ·
  **centered modal** to create one · calendar · standalone notes · stats. Tags = 0+ colored
  labels/task; Subtasks = `{text,done}` checklist; Profile is local-only (no login UI).
- **Two window modes are the shell's job, not CSS.** The frontend signals intent via
  `ramble:mode`; the shell resizes/repositions and toggles always-on-top. Don't fake the
  morph with viewport tricks.
- **Style:** keep files focused; if `app.js`/`styles.css` outgrow ~800 lines per concern,
  split by surface (e.g. `dashboard/`, `capture/`) rather than one ever-growing file.

## Work Guidance
- Build dashboard UI with the design skill stack (see root). Reference shots in
  `C:\Users\Badr\AppData\Local\SXshot\shots\sxshot-79/82/83/84/85.png`.
- Iterate at `localhost:5179` (`npm start`) — fastest loop; the shell is a thin wrapper.

## Verification
- `node --check public/app.js` after edits.
- Manual: `npm start` → run a ramble end-to-end; toggle each of the 6 themes; verify the orb
  renders (not the full panel) when `body.widget` is set.

## Child DOX Index
- _None yet._ Add one if a surface (e.g. `public/dashboard/`) becomes its own durable boundary.
