# ADR-0003 — Live captions are platform-adaptive (Windows only), with graceful fallback

**Status:** accepted · **Date:** 2026-06-25

## Context
The browser app streams **live captions** while you speak using the **Web Speech API**
(`webkitSpeechRecognition`). In the Tauri webview this API is unreliable: **WKWebView
(macOS) does not support it at all**, and **WebView2 (Windows)** support is
inconsistent (it depends on an online speech service and is not guaranteed). The accurate
transcript has always come from **Groq Whisper** on stop — Web Speech only ever drove the
*live* on-screen text, never the saved result.

## Decision
Captions behave **per-platform**, and degrade safely:
- **Windows:** attempt live Web Speech captions while recording.
- **macOS:** no live captions — the orb just **pulses** while recording; the transcript
  appears ~1s after stop (Groq Whisper).
- **Fallback (any OS, incl. Windows):** if Web Speech isn't available at runtime, silently
  fall back to the macOS behavior. The feature **never hard-breaks** — worst case is "no
  live text," not "no transcription."

Accuracy and the saved task list are **identical** on both platforms; only the
while-talking visual differs.

- **Rejected — re-implement streaming cross-platform** (chunked audio → Groq, or bundle a
  local Whisper model): real added scope and app size for a cosmetic, while-talking effect.
  Deferred; can revisit if live captions prove essential on Mac.

## Consequences
- The frontend must **feature-detect** Web Speech at runtime, not assume it (the same build
  runs in a real browser, WebView2, and WKWebView).
- The "show + start recording" hotkey flow does not depend on live captions, so it works
  the same on both OSes — only the visual feedback (pulse vs streaming words) changes.
- One code path, branched by capability detection — no separate Mac/Windows frontend builds.
