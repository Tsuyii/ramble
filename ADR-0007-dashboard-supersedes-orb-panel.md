# ADR-0007 — Orb morphs into a full dashboard (panel grows up, drops always-on-top)

**Status:** Accepted (2026-06-28)
**Revises:** [[ADR-0005-widget-interaction-model]] — keeps the orb-first model and the morph, but
replaces the small "task-list panel" with a full dashboard and changes the panel's window mode.

## Context
ADR-0005 locked an orb that morphs into a **panel** (the task list). The user now wants the panel
to "regroup everything": a full dashboard — left sidebar nav, task list, calendar, notes, stats,
task detail/edit, profile + settings — matching the reference designs. The orb stays: it is the
"essence of the app" (ambient, always-on-top, tap-to-ramble-in-place). The two answers
("orb morphs into it" **and** "keep the orb") are reconciled below.

## Decision
The orb remains the resting/capture state; the **Panel is now a full Dashboard**, and the morph
changes window mode.

1. **Orb = ambient capture, always-on-top.** Unchanged from ADR-0005: rests bottom-right, tap body
   → ramble in place with the bubble, grip → drag, chevron → open.
2. **Chevron morphs the orb UP into the full Dashboard.** Same single-window morph identity as
   ADR-0005, but it grows into a large app surface; closing morphs back down to the orb.
3. **The Dashboard is a NORMAL window — NOT always-on-top.** When morphed to the dashboard the
   window drops always-on-top, appears in the taskbar, and participates in alt-tab. Only the
   resting orb floats over other apps. (A near-fullscreen always-on-top dashboard would pin over
   everything and fight multitasking.)
4. **Dashboard opens centered**, ~1100×720 by default, with a **Settings toggle to maximize /
   go fullscreen-ish** for a "home base" feel.
5. **Editing surfaces:** clicking a task opens a **right-side detail panel** (edit in place);
   creating a task uses a **centered Add-Task modal** (title, subtasks, tags, folder, date,
   start/end, reminder). Two distinct surfaces, per the references.

## Why this is a real trade-off
- **Morph vs two separate windows:** we keep ADR-0005's single morphing window for motion identity,
  even though a corner-orb → centered-large-dashboard morph is a dramatic resize. Rejected splitting
  into two independent windows (loses the "grows out of the orb" identity that is the app's signature).
- **Dropping always-on-top on morph:** a deliberate mode switch mid-morph (on-top orb → normal
  dashboard). Slightly more window-state plumbing, but it's what a real productivity surface needs.

## Consequences
- The shell (now Electron, [[ADR-0006-electron-shell-migration]]) manages two window modes and the
  always-on-top → normal transition across the morph.
- The in-panel "big orb" view from ADR-0005 is reconsidered inside the dashboard layout.
- New data surfaces (calendar, notes, stats, tags) are specified in
  [[ADR-0008-dashboard-data-model]].
