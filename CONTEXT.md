# Brain-Dump Todo — Context & Locked Scope

A small personal tool: summon it, ramble out loud, and it turns the mess into clean,
scheduled tasks — asking a couple of smart follow-up questions only when a task needs it.

## Why this exists (not Todoist Ramble)
Todoist Ramble (Jan 2026) does voice → structured tasks, but: it's **one-shot** (never
interviews you), it's **locked to Google Gemini**, and it lives in Todoist's ecosystem.
The point of this build is (a) it's **ours / local**, (b) it runs on **DeepSeek**, and
(c) it does the **adaptive follow-up interview** — the genuinely missing piece.

## Glossary (canonical terms)
- **Ramble** — one unstructured voice (or text) brain-dump session. Input.
- **Capture** — the act of summoning the widget and starting a Ramble. Live captions
  stream while speaking; an accurate transcript is editable before sorting.
- **Task** — a single structured todo extracted from a Ramble. Has: title, optional
  due-date, optional priority (high/med/low), **projectId**, optional sub-steps, status.
- **Project** — a workspace a task is filed into (e.g. Ramble, Trade-in). User-owned list;
  **Inbox** is the always-present fallback. See [[ADR-0001-projects-and-learning]].
- **Follow-up** — an AI clarifying question asked *before saving*, **one at a time**, only
  when genuinely unsure (project / due / priority / breakdown). Conservative by design.
- **Correction** — when the user edits a saved task's project or priority. Logged to
  memory and fed back to the AI as a learned pattern.
- **Memory loop** — prompt-side learning: recent corrections + filing examples injected
  into the DeepSeek prompt. NOT model training. See [[ADR-0001-projects-and-learning]].
- **Reminder** — an alert that a task needs attention. Two kinds: an **auto due-alert**
  (3 days / 1 day before, and on the day, derived from `due`) and a **manual reminder**
  (`remindAt`, set via the bell). Delivered both as an in-app card and an OS notification.
  See [[ADR-0004-reminders-and-notifications]].
- **Brain (the AI)** — DeepSeek (text LLM, OpenAI-compatible). Extraction + follow-ups +
  finalize. Does NOT do speech-to-text.
- **Transcription** — speech→text. Live captions use the browser Web Speech API (instant);
  the accurate final pass uses **Groq Whisper** on stop. In the widget, live captions are
  **platform-adaptive** — see [[ADR-0003-platform-adaptive-captions]].
- **Widget** — the v2 desktop form of Ramble: a Tauri-shelled tray app with a global
  hotkey. The browser app and the widget run the **same** frontend + server code.
- **Orb** — the widget's resting form: a small circle pinned bottom-right of the screen.
  Summon → it **pulses** while recording → expands into a **panel** showing sorted tasks →
  collapses back to an orb when idle.
- **Sidecar** — the bundled Node runtime + `server.js` that Tauri spawns to hold the keys
  and serve the API locally. The Rust shell is a thin wrapper around it. See
  [[ADR-0002-tauri-node-sidecar]].

## Locked decisions
1. **Form factor:** desktop widget — but **browser/localhost first**, wrap as a real
   tray + global-hotkey widget (Tauri/Electron) only after the flow works.
2. **Input:** real voice (speaking). v1 uses Web Speech API; typing is a free fallback.
3. **Brain:** DeepSeek via its OpenAI-compatible endpoint (`https://api.deepseek.com`).
4. **Key safety:** the DeepSeek key must NOT live in the browser. A tiny local server
   holds the key and proxies calls. (Browser-only would leak the key.)
5. **Follow-ups are adaptive:** the AI inspects each task and asks for due-date /
   priority / breakdown *only when warranted*; trivial tasks save with no questions.
6. **Storage:** v1 = local only (localStorage / a local JSON file). No cloud, no account.

## Locked decisions — v2 widget (Tauri wrap)
1. **Backend:** Tauri spawns the existing `server.js` as a bundled **Node sidecar**; the
   webview loads the same frontend from `127.0.0.1`. No rewrite. See
   [[ADR-0002-tauri-node-sidecar]].
2. **Targets:** Windows **and** macOS. (Per-OS Node sidecar binary; macOS needs
   codesigning + notarization.)
3. **Form:** an **orb** bottom-right of the screen that expands to a panel and collapses
   back; movable, default position bottom-right above the tray.
4. **Hotkey:** global, **show + start recording** in one press (instant "tap and ramble").
   Default `Ctrl+Shift+Space`, **rebindable in Settings**.
5. **Dismiss:** **auto-hide on blur** (like Spotlight); stays pinned while recording.
6. **Captions:** platform-adaptive — live on Windows, pulse-only + transcript-after-stop on
   macOS, graceful fallback everywhere. See [[ADR-0003-platform-adaptive-captions]].
7. **Keys:** a **Settings page** (gear icon, or tray → Settings) to enter DeepSeek/Groq
   keys. **v1 stores them in `config.json` in the OS app-data dir**, owned by the local
   server, never bundled in JS, never echoed back to the UI; keys are read fresh per
   request so changes apply with no restart. (Deviation from the original **OS keychain**
   plan — accepted for v1 simplicity; keychain is a future hardening.)
8. **Data:** sidecar writes `tasks/projects/memory.json` to the **OS app-data dir** (the
   install dir is read-only when packaged).

## Out of scope for v1 (deliberately)
- Phone app, multi-device sync, accounts/login.
- Calendar integration.
- The native tray widget (comes after v1 proves the flow).

> **Reminders/notifications** were originally parked here; they are now **in scope** as of
> 2026-06-27 — see [[ADR-0004-reminders-and-notifications]]. Quiet-hours / a per-user
> preferred alert time remain out of scope (auto-alerts fire at a fixed 09:00).

## Open question still to settle
- Task list groups by **date** (Overdue / Today / Tomorrow / weekday / dated). Priority
  shows as a colored left-border + tag, not as a grouping axis. Light/dark handled by the
  6 themes. (The grouping question is effectively settled; revisit only if it stops scaling.)
