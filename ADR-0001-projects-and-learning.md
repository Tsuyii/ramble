# ADR-0001 — Projects, and how "self-learning" actually works

**Status:** accepted · **Date:** 2026-06-24

## Context
v2 added two requested capabilities: (1) tasks should be filed into projects/workspaces
(e.g. Ramble, Trade-in), and (2) the app should "learn" the user's habits so its guesses
improve. Both are easy to get wrong in ways that are hard to undo later.

## Decision

### Projects: user-seeded, AI-assigned, AI-may-suggest
- The user owns a project list (seeded with Ramble / Trade-in / Personal on first run).
  An implicit **Inbox** is always the fallback.
- On each ramble, DeepSeek assigns every task to the best-fit existing project **by id**,
  or to `inbox`. When something clearly belongs to a project that doesn't exist yet, it
  returns `projectId: null` + a `suggestedProject` name, surfaced as a follow-up the user
  approves — only then is the project created.
- **Rejected:** AI free-creates projects from speech. Reason: it spawns duplicates
  ("Trade-in" / "Tradein" / "Trade in") and clutter. Approval gate keeps the list clean.

### "Self-learning" = memory + few-shot, NOT model training
- We cannot retrain an LLM locally. Instead, every user correction (priority change,
  project move) is appended to `data/memory.json`, and a compact summary of recent
  corrections + examples of how the user files tasks is injected into the DeepSeek
  structuring prompt (`learnedBlock`).
- The model therefore mimics the user's observed patterns and gets better over time,
  with zero training and full local privacy.
- **Rejected:** fine-tuning / a local model. Reason: overkill, heavy, and unnecessary —
  prompt-side memory captures 90% of the value for a personal tool.
- **Trade-off:** memory is prompt-bounded (last ~18 corrections + ~6 project examples) to
  keep token cost low; it favors *recent* habits over the full history. Acceptable.

## Consequences
- Correcting a task is now a first-class action: it both fixes the task and teaches Ramble.
- Data lives in three local JSON files: `tasks.json`, `projects.json`, `memory.json`.
- Deleting a project re-homes its tasks to Inbox (no orphans).
