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
  - The active bridge is `electron-bridge.js` (talks to the preload's `window.ramble`). The old
    `tauri-bridge.js` and the `window.__TAURI__` fallback were removed (ADR-0006). `app.js` reads
    the shell via `const shell = window.ramble || null`.
- **Window drag = CSS, not Tauri.** Elements marked `[data-tauri-drag-region]` (a kept hook name)
  move the frameless Electron window via `-webkit-app-region: drag` (defined at the end of
  `styles.css`); buttons/inputs are `no-drag`. `app.js` only emits `ramble:dragging` as a blur
  guard — it does NOT move the window. Don't remove the drag CSS or dragging breaks.
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
- **Dashboard shell is gated by `body.dash`.** `.dash` is `display: contents` (passthrough)
  until `body.dash` is set, so the small widget panel still flows normally. The browser adds
  `body.dash` at boot (`!IS_WIDGET`); the widget will add it when it morphs to `dashboard`
  mode. Sidebar nav drives `state.filter` (`all`/`today`/`upcoming`/`completed`/`inbox`/a
  folderId) via `selectFilter` → `renderSidebar`+`renderTasks`. `renderSidebar()` runs in
  `refresh()`. **Slice A done** (shell); Tags/detail-panel/modal/calendar/stats pending.
- **Notes (ADR-0008) done.** Standalone freeform jots (`{id,title,body,timestamps}`), their own
  `notes.json` store + `GET/POST/PATCH/DELETE /api/notes` (additive, keys stay server-side). The
  UI is a self-contained two-pane overlay (index + autosaving title/body editor) built in
  `app.js` and appended to `<body>` — the only shared-file touch is the sidebar **Notes** entry
  after `#sideNav`. Independent of tasks/folders. Elements registered via `Object.assign(els,…)`;
  events wired at the end of the init section; styles under `/* ===== Notes ===== */` (tokens, all
  6 themes). Autosave is debounced + flushed on blur/select/close.
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
