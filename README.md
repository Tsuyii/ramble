# Ramble

**Say it. I'll sort it.** A small local tool: tap the orb, ramble out loud about everything on your plate, and it turns the mess into a clean, scheduled task list — asking a couple of smart follow-up questions only when a task actually needs one.

Built because no off-the-shelf app does *all* of: callable widget + voice dump + **adaptive follow-up interview** + runs on **your** models (DeepSeek + Groq). See `CONTEXT.md` for the locked scope.

## How it works

```
browser records audio
   → local Node server (holds your keys)
      → Groq Whisper   (speech → text)
      → DeepSeek       (text → structured tasks + adaptive follow-ups)
   → tasks saved locally to data/tasks.json
```

The DeepSeek "brain" decides *per task* whether to ask anything:
- clear task → saved silently
- vague timing → "when's this due?"
- ambiguous importance → priority chips
- big task → "want me to break it down?"

## Setup

1. **Install** (needs Node 18+):
   ```bash
   npm install
   ```
2. **Keys** — edit `.env`:
   - `DEEPSEEK_API_KEY` — already set. (Rotate it at platform.deepseek.com — it was shared in chat.)
   - `GROQ_API_KEY` — get one free at https://console.groq.com/keys and paste it in. Without it, voice is disabled but the **type box** still works.
3. **Run**:
   ```bash
   npm start
   ```
   Open http://localhost:5179

## Notes

- **Mic needs localhost or https** — `getUserMedia` won't run on `file://`. Always open via the server URL.
- Tasks persist in `data/tasks.json` (git-ignored). Delete it to reset.
- This is **v1 (browser-first)**. Next step is wrapping it as a real tray widget with a global hotkey (Tauri).

## Roadmap

- [ ] v1 — browser app: voice → sorted tasks + adaptive follow-ups *(this)*
- [ ] Tray icon + global hotkey (Tauri wrap)
- [ ] Edit a task inline
- [ ] Optional local Whisper (fully offline transcription)
