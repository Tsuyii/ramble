# ADR-0005 — Widget interaction model: one morphing window, orb-first

**Status:** Accepted (2026-06-28)
**Supersedes parts of:** the v2 widget form factor in [[CONTEXT]] (orb pinned bottom-right; tap-to-expand-panel).

## Context
The v2 widget tapped the orb → expanded the **whole panel**, docked bottom-right. In use this
(1) covered the orb so its pipeline animation was never visible, (2) felt heavy for a quick
ramble, (3) was stuck on the right, and (4) didn't follow the active theme. User wants an
ambient orb that records in place with a transcription **bubble**, a repositionable panel,
and full theming.

## Decision
A **single window that morphs between orb and panel** (not two windows), driven by the orb:

1. **Tap orb body → record in place.** No panel. A **bubble** shows the pipeline
   (live caption → transcript → "✓ Sorted N tasks") then auto-dismisses. The orb stays
   visible and animating throughout.
2. **Grip (top edge) → drag** the OS window. The only drag affordance; a movement threshold
   separates drag from a body tap.
3. **Chevron → open the Panel**, which **grows from the orb** (morph) and shrinks back on
   close. Deliberately slow ("make it last longer"); precise motion tuning deferred.
4. **Launches centered.** Resizing (orb → bubble-capture → panel) is **anchored to the orb's
   screen position** (bottom-center) so the orb never jumps — the panel grows out of it.
   Closing remembers the position in-session.
5. **Solid orb that follows the theme** (surface + accent), with an **auto-contrast scrim**
   on light themes (Paper, Cobalt) so it never washes out over a light wallpaper.

## Why these are real trade-offs
- **One morphing window vs two windows:** two windows (a tiny always-on orb + a separate app
  window) is simpler to position independently, but loses the literal "panel grows out of the
  orb" morph and doubles webview/state plumbing. We chose the single morphing window for the
  motion identity, accepting fiddly anchored resize math.
- **Bubble needs window space:** the orb window is grown taller (anchored at the orb) while a
  ramble is active so the bubble has room, then shrunk back — instead of a permanently large
  transparent window that would create a click-dead-zone over the desktop.
- **Grip-only drag:** rejected whole-orb drag (conflicts with tap-to-record) and modifier-key
  drag (needs the keyboard). A dedicated grip is discoverable and unambiguous.

## Consequences
- Shell (`lib.rs`) gains: center-on-launch, a `start_dragging` path for the grip, and an
  anchored resize across three sizes (orb / capture / panel) keeping the orb fixed.
- Frontend gains: orb grip + chevron, the bubble pipeline UI, theme-following + contrast
  scrim, and the longer morph. The in-panel big orb stays for the open-panel view.
- Cross-restart position persistence and smart bubble edge-placement are **follow-ups**.
