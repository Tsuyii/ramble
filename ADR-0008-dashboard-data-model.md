# ADR-0008 — Dashboard data model: Folders, Tags, Notes, Subtasks, local Profile

**Status:** Accepted (2026-06-28)
**Extends:** [[ADR-0001-projects-and-learning]] (Projects/learning loop) for the dashboard milestone.

## Context
The dashboard ([[ADR-0007-dashboard-supersedes-orb-panel]]) introduces concepts the current model
(Task + Project + priority) doesn't have: colored Tags, freeform Notes, nested Subtasks, and a
profile/account UI. The reference designs also show "Folders" and a "Logout" that collide with our
existing vocabulary and our locked "local-only, no account" scope. This ADR pins the model.

## Decision
1. **Folder = Project (rename, not a new type).** "Folder" is the **UI label** for the existing
   Project (one per Task; **Inbox** remains the fallback). No second hierarchy. Glossary keeps
   *Project* as the canonical term with *Folder* as its UI name.
2. **Tags are NEW and orthogonal.** A Task may have **zero or more** colored Tags (e.g. Web, Design,
   SMM). Tags are independent of the Task's Folder/Project. New storage on Task; the **Brain
   (DeepSeek) may assign Tags** during extraction (in addition to project/due/priority), and Tag
   corrections feed the same memory loop as project corrections.
3. **Notes are a standalone type.** Freeform notes (title/body) in their **own list**, independent
   of Tasks and Folders. The Brain may route a "just remember this" ramble into a Note instead of a
   Task. Stored in `notes.json` alongside `tasks/projects/memory.json`.
4. **Subtasks are lightweight checklist items.** A Subtask is `{ text, done }` under a parent Task —
   **no** own due-date, tags, priority, or project. The "1/2 completed" progress bar counts these.
   (Rejected: full nested Tasks — doubles the model and breaks date-grouping with no v1 payoff.)
5. **Local Profile, no auth, no cloud.** A local-only profile (name + avatar, set once, stored
   locally) plus a **Settings** entry at the sidebar bottom (API keys, theme, fullscreen toggle).
   **No login/logout, no accounts, no sync** — this preserves the locked local-only decision; the
   reference's "Logout" is template chrome we drop.

## Why this is a real trade-off
- **Tags as a first-class, AI-assigned field** changes both storage and the DeepSeek prompt/output
   shape — hard to reverse once tasks are tagged in stored data. Chosen because the references treat
   tags as core, and the memory loop already exists to learn tag-filing the same way it learns
   projects.
- **Subtasks-as-checklist** is a deliberate scope cap to keep date-grouping and AI extraction simple.
- **Local profile over real accounts** explicitly upholds the local-only lock against the reference's
   login UI rather than silently expanding scope into auth/cloud/sync.

## Consequences
- Task schema gains `tags: string[]` and `subtasks: {text, done}[]`. New `notes.json` store and a
  Note type. CONTEXT.md glossary + locked-decisions updated accordingly.
- DeepSeek extraction prompt extends to optionally emit tags and to classify ramble-as-note.
- If real accounts/sync are ever wanted, that reverses the local-only lock and needs its own ADR.
