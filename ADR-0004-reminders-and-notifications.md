# ADR-0004 — Reminders & notifications (client poller, dual delivery)

**Status:** accepted · **Date:** 2026-06-27 · **Supersedes:** the "reminders/notifications"
line under *Out of scope for v1* in `CONTEXT.md`.

## Context
Tasks have a date-only `due` but nothing ever told the user a task was coming up, and there
was no way to set an ad-hoc reminder. Reminders were deliberately parked in v1. With the
task list and the Tauri widget shell working, the missing piece is a heads-up: "this is due
soon" and "remind me at X". Two constraints shape the design:

- **Same code, two shells** (AGENTS.md): the build runs in a plain browser *and* the Tauri
  webview. A reminder mechanism can't assume Tauri.
- **The widget lives in the tray**, collapsed to an orb. The most useful alert fires when
  the app is *not* in front of you — which a styled in-app banner alone can't do.

## Decision

### What fires
1. **Auto due-date alerts** — derived from `due`: a heads-up **3 days before**, **1 day
   before**, and **on the day** (overdue if the due date has already passed). Auto-alerts
   fire at **09:00 local** on their day (`due` has no time-of-day).
2. **Manual reminders** — a per-task **bell** opens a popover: quick presets (In 1 hour,
   Tonight, Tomorrow 9am, Day before due) plus a custom date+time. Stored as `remindAt`.

### Where it shows (dual delivery)
- **In-app card** (always): a persistent notification card, top-right, with **Snooze /
  Done / Dismiss**. The "nice UI" surface; a visual sibling of the task card.
- **OS notification** (background-safe): native system toast so the alert lands even when
  the widget is collapsed to the orb or in the tray. In the widget, routed through a Rust
  `notify` command (`tauri-plugin-notification`); in a plain browser, the Web Notifications
  API when the user has granted permission (asked once, on the first manual reminder).

### Who schedules it — a **client-side poller**, not the server
A `setInterval` in the frontend checks every 30s (and on boot) and fires anything due. The
server (`server.js`) stays a dumb store: it only persists the new fields. Rationale:
- It works identically in the browser and the widget — no Rust scheduler, no second code
  path, honoring "same code, two shells".
- The server can't show UI anyway; a server cron would still have to push to a client.
- Reminder latency tolerance is minutes, so a 30s poll is plenty.

### Persistence / no double-fire
New task fields (defaulted in `finalize`, merged in `PATCH /api/tasks/:id`):
- `remindAt` (ISO) / `remindFiredAt` (ISO) — setting `remindAt` **re-arms** (clears
  `remindFiredAt`); the client sets `remindFiredAt` when it delivers.
- `dueAlertsFired` (array of lead labels `"3"|"1"|"0"`) — which auto-alerts already fired.

Fired markers are persisted so a reminder never repeats across restarts. On launch, any
alert whose moment passed **before the task existed** (`< createdAt`) or **more than 24h
ago** is recorded-but-suppressed, so a widget opened after days away doesn't dump a backlog.

### Rejected alternatives
- **Server-side scheduler (Node cron / Rust timer).** Adds a second delivery path, can't
  render the in-app card, and the server can fire only while the sidecar runs anyway.
- **OS notification only.** Can't be styled — the user explicitly wanted a *nice* surface.
- **In-app only.** Useless for a tray widget that's collapsed most of the time.
- **Relative-to-due reminders only.** Forces every reminder to depend on a due date.

## Consequences
- `server.js` gains three optional fields and stays otherwise unchanged (no rewrite — ADR-0002).
- The Tauri shell gains `tauri-plugin-notification`, a `notify` command, the
  `notification:default` capability, and a `ramble:notify` bridge event. **OS notifications
  need a Tauri rebuild to take effect; the in-app card works in the browser immediately.**
- Edit and delete (already in the inline editor) are now also surfaced as an always-visible
  **action row** (bell / edit / delete) on each task, so all three are discoverable.
- Auto-alerts firing at a fixed 09:00 is a deliberate simplification; a per-user quiet-hours
  / preferred-time setting is a future refinement, not v1.
