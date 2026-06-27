// ===== Ramble — client (v2) =====

// API base. Browser/dev: same origin (""). Tauri widget: the frontend is served from
// tauri://, so /api/* must be routed to the sidecar on 127.0.0.1:<port> (injected on
// boot). This shim rewrites every /api/* fetch so the call sites stay unchanged.
let API_BASE = "";
const _fetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  if (typeof input === "string" && input.startsWith("/api/")) input = API_BASE + input;
  return _fetch(input, init);
};

const $ = (id) => document.getElementById(id);

const els = {
  orb: $("orb"),
  wave: $("wave"),
  hint: $("hint"),
  liveCaption: $("liveCaption"),
  typeToggle: $("typeToggle"),
  typebox: $("typebox"),
  typeInput: $("typeInput"),
  transcript: $("transcript"),
  transcriptText: $("transcriptText"),
  sortIt: $("sortIt"),
  rerecord: $("rerecord"),
  thinking: $("thinking"),
  followups: $("followups"),
  followupStage: $("followupStage"),
  followupProgress: $("followupProgress"),
  skipFollowups: $("skipFollowups"),
  nextFollowup: $("nextFollowup"),
  projectBar: $("projectBar"),
  taskGroups: $("taskGroups"),
  empty: $("empty"),
  tasksCount: $("tasksCount"),
  toast: $("toast"),
  noticeStack: $("noticeStack"),
};

const PRIO_COLOR = { high: "var(--p-high)", medium: "var(--p-med)", low: "var(--p-low)" };

// Inline SVGs — one icon language with the rest of the app (no emoji).
const ICON = {
  bell: `<svg viewBox="0 0 24 24"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.95 1.95 0 0 0 3.4 0"/></svg>`,
  edit: `<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
  trash: `<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/><path d="M10 11v5M14 11v5"/></svg>`,
};

const state = {
  projects: [],
  tasks: [],
  filter: "all", // "all" | "inbox" | projectId
};

let mediaRecorder = null;
let chunks = [];
let audioCtx = null;
let analyser = null;
let rafId = null;
let recognition = null;
let recording = false;

let currentDrafts = [];
let queue = [];
let qIndex = 0;
let answers = {};

// ---------- helpers ----------

// Status pill was removed from the UI; the orb state, hint text, and "thinking"
// section already convey what's happening. Kept as a no-op so call sites stay put.
function setStatus() {}

// The orb is the living centrepiece of the pipeline. One attribute drives which
// glyph shows and which animation runs; all glyphs inherit the theme accent.
// States: idle | listening | transcribing | structuring | done
function setOrbState(s) {
  if (els.orb.dataset.state === s) return;
  els.orb.dataset.state = s;
  // Re-trigger the momentum pulse: remove, force a reflow, re-add so the
  // animation restarts on every change (CSS can't detect attribute changes).
  els.orb.classList.remove("orb--pulse");
  void els.orb.offsetWidth;
  els.orb.classList.add("orb--pulse");
}

function toast(msg, kind = "info") {
  els.toast.textContent = msg;
  els.toast.dataset.kind = kind;
  els.toast.hidden = false;
  requestAnimationFrame(() => (els.toast.dataset.show = "true"));
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    els.toast.dataset.show = "false";
    setTimeout(() => (els.toast.hidden = true), 250);
  }, kind === "error" ? 5000 : 2800);
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const projectName = (id) => (id === "inbox" || !id ? "Inbox" : state.projects.find((p) => p.id === id)?.name || "Inbox");
const projectColor = (id) => (id === "inbox" || !id ? "var(--text-faint)" : state.projects.find((p) => p.id === id)?.color || "var(--text-faint)");

// ---------- recording + live captions ----------

els.orb.addEventListener("click", () => (recording ? stopRecording() : startRecording()));

// ---------- widget orb mode (Tauri only) ----------
const IS_WIDGET = Boolean(window.__TAURI__);

// Switch between the collapsed orb and the expanded panel; the shell resizes the window.
function setMode(mode) {
  const panel = mode === "panel";
  document.body.classList.toggle("panel", panel);
  window.dispatchEvent(new CustomEvent("ramble:want-expand", { detail: panel }));
}

const widgetOrb = document.getElementById("widgetOrb");
if (widgetOrb) {
  widgetOrb.addEventListener("click", () => {
    setMode("panel");
    if (!recording) startRecording();
  });
}

// Hotkey (show + start recording) → expand, then record.
window.addEventListener("ramble:start-recording", () => {
  setMode("panel");
  if (!recording) startRecording();
});

// Blur → collapse back to the orb (unless mid-ramble).
window.addEventListener("ramble:collapse", () => {
  if (!recording) setMode("orb");
});

// Esc collapses the panel (when Settings isn't open).
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && IS_WIDGET && document.body.classList.contains("panel") && settingsModal.hidden && !recording) {
    setMode("orb");
  }
});

if (IS_WIDGET) {
  setMode("orb");
  // Native-app feel: no browser right-click menu, no text-drag selection of chrome.
  document.addEventListener("contextmenu", (e) => e.preventDefault());
}

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mediaRecorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      transcribe(new Blob(chunks, { type: mediaRecorder.mimeType || "audio/webm" }));
    };
    mediaRecorder.start();
    recording = true;
    window.dispatchEvent(new CustomEvent("ramble:recording", { detail: true }));
    setOrbState("listening");
    els.orb.setAttribute("aria-label", "Stop recording");
    els.hint.textContent = "Listening… tap to stop";
    els.transcript.hidden = true;
    els.followups.hidden = true;
    els.liveCaption.hidden = false;
    els.liveCaption.textContent = "";
    setStatus("recording", "Recording");
    startWaveform(stream);
    startLiveCaptions();
  } catch {
    toast("Mic access denied — try the type box instead.", "error");
    showTypebox();
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  recording = false;
  window.dispatchEvent(new CustomEvent("ramble:recording", { detail: false }));
  // Don't reset the glyph here — transcribe() takes over with "transcribing".
  // The cancel path resets to "idle" explicitly via cancelCapture().
  els.orb.setAttribute("aria-label", "Start recording");
  els.hint.textContent = "Tap to speak";
  stopWaveform();
  stopLiveCaptions();
}

function startLiveCaptions() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return; // best-effort; Groq still does the accurate pass on stop
  recognition = new SR();
  recognition.lang = "en-US";
  recognition.continuous = true;
  recognition.interimResults = true;
  let finalText = "";
  recognition.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    els.liveCaption.textContent = (finalText + interim).trim();
  };
  recognition.onerror = () => {};
  try {
    recognition.start();
  } catch {}
}

function stopLiveCaptions() {
  if (recognition) {
    try {
      recognition.stop();
    } catch {}
    recognition = null;
  }
  els.liveCaption.hidden = true;
}

// ---------- waveform ----------

// Read the current theme's accent colours so the waveform matches the active look.
function waveColors() {
  const s = getComputedStyle(document.body);
  const c1 = (s.getPropertyValue("--accent").trim() || "#c2410c").slice(0, 7);
  const c2 = (s.getPropertyValue("--accent-2").trim() || "#4d7c45").slice(0, 7);
  return { c1, c2 };
}
const alphaHex = (a) =>
  Math.max(0, Math.min(255, Math.round(a * 255)))
    .toString(16)
    .padStart(2, "0");

function startWaveform(stream) {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioCtx.createMediaStreamSource(stream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);
  const canvas = els.wave;
  const ctx = canvas.getContext("2d");
  const data = new Uint8Array(analyser.frequencyBinCount);
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const { c1, c2 } = waveColors();
  const draw = () => {
    rafId = requestAnimationFrame(draw);
    analyser.getByteFrequencyData(data);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const bars = 56;
    const baseR = canvas.width * 0.3;
    let sum = 0;
    for (let i = 0; i < bars; i++) {
      const v = data[Math.floor((i / bars) * data.length)] / 255;
      sum += v;
      const len = 8 + v * 64;
      const ang = (i / bars) * Math.PI * 2 - Math.PI / 2;
      const x1 = cx + Math.cos(ang) * baseR;
      const y1 = cy + Math.sin(ang) * baseR;
      const x2 = cx + Math.cos(ang) * (baseR + len);
      const y2 = cy + Math.sin(ang) * (baseR + len);
      const grad = ctx.createLinearGradient(x1, y1, x2, y2);
      grad.addColorStop(0, c1 + alphaHex(0.85));
      grad.addColorStop(1, c2 + alphaHex(0.9));
      ctx.strokeStyle = grad;
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    const level = sum / bars;
    ctx.beginPath();
    ctx.arc(cx, cy, baseR - 6, 0, Math.PI * 2);
    ctx.strokeStyle = c1 + alphaHex(0.15 + level * 0.4);
    ctx.lineWidth = 2;
    ctx.stroke();
  };
  draw();
}

function stopWaveform() {
  if (rafId) cancelAnimationFrame(rafId);
  if (audioCtx) audioCtx.close().catch(() => {});
  audioCtx = null;
  analyser = null;
  const ctx = els.wave.getContext("2d");
  ctx.clearRect(0, 0, els.wave.width, els.wave.height);
}

// ---------- type fallback ----------

els.typeToggle.addEventListener("click", showTypebox);
function showTypebox() {
  els.typebox.hidden = false;
  els.typeToggle.hidden = true;
  els.typeInput.focus();
}

els.typebox.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = els.typeInput.value.trim();
  if (!text) return;
  els.transcriptText.value = text;
  els.transcript.hidden = false;
  structure(text);
  els.typeInput.value = "";
});

els.sortIt.addEventListener("click", () => {
  const text = els.transcriptText.value.trim();
  if (!text) return toast("Nothing to sort — say or type something first.");
  structure(text);
});

els.rerecord.addEventListener("click", () => {
  els.transcript.hidden = true;
  els.followups.hidden = true;
  startRecording();
});

// Cancel: abort the current ramble, reset to idle, and collapse the widget to the orb.
function cancelCapture() {
  if (recording) stopRecording();
  els.transcript.hidden = true;
  els.followups.hidden = true;
  const thinking = document.getElementById("thinking");
  if (thinking) thinking.hidden = true;
  els.transcriptText.value = "";
  els.liveCaption.hidden = true;
  els.hint.textContent = "Tap to speak";
  setOrbState("idle");
  if (IS_WIDGET) setMode("orb");
}
document.getElementById("transcriptCancel").addEventListener("click", cancelCapture);

// ---------- AI pipeline ----------

async function transcribe(blob) {
  setStatus("thinking", "Tidying up");
  setOrbState("transcribing");
  els.thinking.hidden = false;
  try {
    const form = new FormData();
    form.append("audio", blob, "ramble.webm");
    const res = await fetch("/api/transcribe", { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Transcription failed");
    els.thinking.hidden = true;
    setOrbState("idle");
    setStatus("ready", "Check it");
    if (!data.transcript) return toast("Didn't catch anything — try again.", "error");
    els.transcriptText.value = data.transcript;
    els.transcript.hidden = false;
    els.transcriptText.focus();
  } catch (err) {
    els.thinking.hidden = true;
    setOrbState("idle");
    setStatus("ready", "Ready");
    toast(err.message, "error");
  }
}

async function structure(transcript) {
  setStatus("thinking", "Sorting");
  setOrbState("structuring");
  els.thinking.hidden = false;
  els.followups.hidden = true;
  try {
    const res = await fetch("/api/structure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not sort that");
    if (data.projects) state.projects = data.projects;
    els.thinking.hidden = true;
    setStatus("ready", "Ready");
    currentDrafts = data.drafts || [];
    if (!currentDrafts.length) {
      setOrbState("idle");
      return toast("No tasks found in that — try again.");
    }
    buildQueue();
    if (queue.length) {
      setOrbState("idle"); // user answers follow-ups; finalize() resumes the glyph
      startFollowups();
    } else {
      finalize();
    }
  } catch (err) {
    els.thinking.hidden = true;
    setOrbState("idle");
    setStatus("ready", "Ready");
    toast(err.message, "error");
  }
}

// ---------- one-at-a-time follow-ups ----------

function buildQueue() {
  queue = [];
  answers = {};
  qIndex = 0;
  for (const d of currentDrafts) {
    for (const q of d.questions || []) {
      queue.push({ ...q, draftTitle: d.title });
    }
  }
}

function startFollowups() {
  els.transcript.hidden = true;
  els.followups.hidden = false;
  renderQuestion();
  els.followups.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderQuestion() {
  const q = queue[qIndex];
  els.followupProgress.textContent = `${qIndex + 1} of ${queue.length}`;
  els.nextFollowup.textContent = qIndex === queue.length - 1 ? "Save tasks" : "Next";

  const card = document.createElement("div");
  card.className = "fcard";
  card.innerHTML = `<p class="fcard__for">↳ ${escapeHtml(q.draftTitle)}</p><p class="fcard__q">${escapeHtml(q.text)}</p>`;

  if (q.options && q.options.length) {
    const chips = document.createElement("div");
    chips.className = "chips";
    // New-project confirmations read like actions ("Create …" / "Use Inbox"),
    // but the stored answer stays the raw project name the server expects.
    const labelFor = (opt) =>
      q.field === "project" ? (/^inbox$/i.test(opt) ? "Use Inbox" : `Create “${opt}”`) : opt;
    for (const opt of q.options) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.textContent = labelFor(opt);
      chip.setAttribute("aria-pressed", String(answers[q.id] === opt));
      chip.addEventListener("click", () => {
        answers[q.id] = opt;
        chips.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", "false"));
        chip.setAttribute("aria-pressed", "true");
        advance();
      });
      chips.appendChild(chip);
    }
    card.appendChild(chips);
  } else {
    const input = document.createElement("input");
    input.className = "fcard__input";
    input.type = "text";
    input.value = answers[q.id] || "";
    input.placeholder = q.field === "due" ? "e.g. next friday, the 12th, in two days" : "Type your answer";
    input.addEventListener("input", () => (answers[q.id] = input.value.trim()));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") advance();
    });
    card.appendChild(input);
    setTimeout(() => input.focus(), 50);
  }

  els.followupStage.innerHTML = "";
  els.followupStage.appendChild(card);
}

function advance() {
  if (qIndex < queue.length - 1) {
    qIndex++;
    renderQuestion();
  } else {
    finalize();
  }
}

els.nextFollowup.addEventListener("click", advance);
els.skipFollowups.addEventListener("click", () => finalize());

async function finalize() {
  els.followups.hidden = true;
  els.thinking.hidden = false;
  setOrbState("structuring");
  setStatus("thinking", "Saving");
  try {
    const res = await fetch("/api/finalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ drafts: currentDrafts, answers }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not save");
    els.thinking.hidden = true;
    els.transcript.hidden = true;
    setStatus("ready", "Ready");
    if (data.projects) state.projects = data.projects;
    state.tasks = data.tasks;
    renderProjectBar();
    renderTasks();
    // Flash the checkmark, then settle the orb back to idle.
    setOrbState("done");
    clearTimeout(finalize._t);
    finalize._t = setTimeout(() => setOrbState("idle"), 1300);
    toast(`Added ${data.added} task${data.added === 1 ? "" : "s"} ✦`);
    els.taskGroups.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (err) {
    els.thinking.hidden = true;
    setOrbState("idle");
    setStatus("ready", "Ready");
    toast(err.message, "error");
  }
}

// ---------- project bar ----------

function renderProjectBar() {
  els.projectBar.innerHTML = "";
  const counts = { all: state.tasks.filter((t) => !t.done).length };
  for (const t of state.tasks) {
    if (t.done) continue;
    const key = t.projectId || "inbox";
    counts[key] = (counts[key] || 0) + 1;
  }
  const tabs = [
    { id: "all", name: "All", color: "var(--accent)" },
    { id: "inbox", name: "Inbox", color: "var(--text-faint)" },
    ...state.projects.map((p) => ({ id: p.id, name: p.name, color: p.color })),
  ];
  for (const tab of tabs) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "pchip";
    chip.setAttribute("aria-pressed", String(state.filter === tab.id));
    chip.style.setProperty("--pc", tab.color);
    const n = counts[tab.id] || 0;
    chip.innerHTML = `<span class="pchip__dot"></span>${escapeHtml(tab.name)}${n ? ` <span class="pchip__n">${n}</span>` : ""}`;
    chip.addEventListener("click", () => {
      state.filter = tab.id;
      renderProjectBar();
      renderTasks();
    });
    els.projectBar.appendChild(chip);
  }
  const add = document.createElement("button");
  add.type = "button";
  add.className = "pchip pchip--add";
  add.textContent = "+ Project";
  add.addEventListener("click", addProject);
  els.projectBar.appendChild(add);
}

async function addProject() {
  const name = prompt("New project name:");
  if (!name || !name.trim()) return;
  const res = await fetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name.trim() }),
  });
  const data = await res.json();
  if (res.ok) {
    state.projects = data.projects;
    state.filter = data.id;
    renderProjectBar();
    renderTasks();
  }
}

// ---------- task rendering ----------

function dayKey(due) {
  if (!due) return { key: "zzz-none", label: "No date", note: "" };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(due + "T00:00:00");
  const diff = Math.round((d - today) / 86400000);
  const note = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (diff < 0) return { key: "000-overdue", label: "Overdue", note, overdue: true };
  if (diff === 0) return { key: "001-today", label: "Today", note };
  if (diff === 1) return { key: "002-tomorrow", label: "Tomorrow", note };
  if (diff < 7) return { key: "003-" + due, label: d.toLocaleDateString("en-US", { weekday: "long" }), note };
  return { key: "004-" + due, label: note, note: d.toLocaleDateString("en-US", { weekday: "short" }) };
}

function visibleTasks() {
  if (state.filter === "all") return state.tasks;
  if (state.filter === "inbox") return state.tasks.filter((t) => !t.projectId || t.projectId === "inbox");
  return state.tasks.filter((t) => t.projectId === state.filter);
}

function renderTasks() {
  const tasks = visibleTasks();
  els.tasksCount.textContent = tasks.length ? `${tasks.filter((t) => !t.done).length} open` : "";
  els.taskGroups.innerHTML = "";
  if (!tasks.length) {
    els.empty.hidden = false;
    return;
  }
  els.empty.hidden = true;

  const groups = new Map();
  for (const t of tasks) {
    const g = dayKey(t.due);
    if (!groups.has(g.key)) groups.set(g.key, { meta: g, items: [] });
    groups.get(g.key).items.push(t);
  }
  for (const group of [...groups.values()].sort((a, b) => a.meta.key.localeCompare(b.meta.key))) {
    const wrap = document.createElement("div");
    wrap.className = "group";
    const label = document.createElement("div");
    label.className = "group__label";
    label.innerHTML = `${group.meta.label}${group.meta.note ? ` <span>${group.meta.note}</span>` : ""}<span class="group__rule"></span>`;
    wrap.appendChild(label);
    for (const t of group.items) wrap.appendChild(taskEl(t, group.meta.overdue));
    els.taskGroups.appendChild(wrap);
  }
}

function taskEl(t, overdue) {
  const el = document.createElement("div");
  el.className = "task";
  el.dataset.done = String(t.done);
  if (t.priority) el.style.setProperty("--prio", PRIO_COLOR[t.priority]);

  const check = document.createElement("button");
  check.className = "check";
  check.setAttribute("aria-label", t.done ? "Mark as not done" : "Mark as done");
  check.innerHTML = `<svg viewBox="0 0 16 16"><path d="M2 8l4 4 8-9"/></svg>`;
  check.addEventListener("click", () => toggleTask(t, el));

  const body = document.createElement("div");
  body.className = "task__body";
  const title = document.createElement("p");
  title.className = "task__title";
  title.textContent = t.title;
  title.title = "Click to edit";
  title.addEventListener("click", () => openEditor(t, el, overdue));
  body.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "task__meta";
  if (state.filter === "all" && t.projectId && t.projectId !== "inbox") {
    const proj = document.createElement("span");
    proj.className = "tag tag--proj";
    proj.style.setProperty("--pc", projectColor(t.projectId));
    proj.textContent = projectName(t.projectId);
    meta.appendChild(proj);
  }
  if (t.due) {
    const due = document.createElement("span");
    due.className = "tag " + (overdue ? "tag--overdue" : "tag--due");
    due.textContent = new Date(t.due + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
    meta.appendChild(due);
  }
  if (t.priority) {
    const p = document.createElement("span");
    p.className = "tag tag--prio";
    p.style.setProperty("--prio", PRIO_COLOR[t.priority]);
    p.textContent = t.priority;
    meta.appendChild(p);
  }
  if (t.remindAt && !t.remindFiredAt && !t.done) {
    const r = document.createElement("span");
    r.className = "tag tag--remind";
    r.innerHTML = `${ICON.bell}<span>${escapeHtml(formatReminder(t.remindAt))}</span>`;
    meta.appendChild(r);
  }
  if (meta.children.length) body.appendChild(meta);

  if (t.subtasks && t.subtasks.length) {
    const ul = document.createElement("ul");
    ul.className = "subtasks";
    t.subtasks.forEach((s, i) => {
      const li = document.createElement("li");
      li.className = "subtask";
      li.dataset.done = String(s.done);
      li.innerHTML = `<span class="subtask__box"></span><span>${escapeHtml(s.text)}</span>`;
      li.addEventListener("click", () => toggleSubtask(t, i, li));
      ul.appendChild(li);
    });
    body.appendChild(ul);
  }

  const actions = document.createElement("div");
  actions.className = "task__actions";

  const remindBtn = document.createElement("button");
  remindBtn.className = "taskbtn taskbtn--remind";
  remindBtn.type = "button";
  remindBtn.title = "Remind me";
  remindBtn.setAttribute("aria-label", "Set a reminder");
  remindBtn.innerHTML = ICON.bell;
  if (t.remindAt && !t.remindFiredAt) remindBtn.dataset.armed = "true";
  remindBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openReminderPopover(t, remindBtn);
  });

  const editBtn = document.createElement("button");
  editBtn.className = "taskbtn";
  editBtn.type = "button";
  editBtn.title = "Edit";
  editBtn.setAttribute("aria-label", "Edit task");
  editBtn.innerHTML = ICON.edit;
  editBtn.addEventListener("click", () => openEditor(t, el, overdue));

  const delBtn = document.createElement("button");
  delBtn.className = "taskbtn taskbtn--danger";
  delBtn.type = "button";
  delBtn.title = "Delete";
  delBtn.setAttribute("aria-label", "Delete task");
  delBtn.innerHTML = ICON.trash;
  delBtn.addEventListener("click", () => deleteTask(t, el));

  actions.append(remindBtn, editBtn, delBtn);
  el.append(check, body, actions);
  return el;
}

// ---------- inline editor ----------

function openEditor(t, el, overdue) {
  if (el.querySelector(".editor")) return; // already open
  const editor = document.createElement("div");
  editor.className = "editor";
  const projectOptions = [
    `<option value="inbox"${t.projectId === "inbox" || !t.projectId ? " selected" : ""}>Inbox</option>`,
    ...state.projects.map((p) => `<option value="${p.id}"${t.projectId === p.id ? " selected" : ""}>${escapeHtml(p.name)}</option>`),
  ].join("");
  const prio = (v, label) => `<option value="${v}"${(t.priority || "") === v ? " selected" : ""}>${label}</option>`;
  editor.innerHTML = `
    <label class="editor__row"><span>Task</span><input class="editor__input" data-f="title" value="${escapeHtml(t.title)}" /></label>
    <div class="editor__grid">
      <label class="editor__row"><span>Due</span><input class="editor__input" data-f="due" type="date" value="${t.due || ""}" /></label>
      <label class="editor__row"><span>Priority</span><select class="editor__input" data-f="priority">
        ${prio("", "—")}${prio("high", "High")}${prio("medium", "Medium")}${prio("low", "Low")}
      </select></label>
    </div>
    <label class="editor__row"><span>Project</span><select class="editor__input" data-f="projectId">${projectOptions}</select></label>
    <div class="editor__actions">
      <button class="btn-ghost editor__del" type="button">Delete</button>
      <span style="flex:1"></span>
      <button class="btn-ghost editor__cancel" type="button">Cancel</button>
      <button class="btn-send editor__save" type="button">Save</button>
    </div>`;
  el.appendChild(editor);
  el.classList.add("task--editing");

  editor.querySelector(".editor__cancel").addEventListener("click", () => closeEditor(el));
  editor.querySelector(".editor__del").addEventListener("click", () => deleteTask(t, el));
  editor.querySelector(".editor__save").addEventListener("click", async () => {
    const get = (f) => editor.querySelector(`[data-f="${f}"]`).value;
    const patch = {
      title: get("title").trim(),
      due: get("due") || null,
      priority: get("priority") || null,
      projectId: get("projectId"),
    };
    await fetch(`/api/tasks/${t.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    await refresh();
    toast("Saved ✦");
  });
}

function closeEditor(el) {
  el.querySelector(".editor")?.remove();
  el.classList.remove("task--editing");
}

// ---------- task mutations ----------

async function toggleTask(t, el) {
  t.done = !t.done;
  el.dataset.done = String(t.done);
  await fetch(`/api/tasks/${t.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ done: t.done }),
  });
  await refresh();
}

async function toggleSubtask(t, i, li) {
  const done = li.dataset.done !== "true";
  li.dataset.done = String(done);
  await fetch(`/api/tasks/${t.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subtaskIndex: i, subtaskDone: done }),
  });
}

async function deleteTask(t, el) {
  el.style.opacity = "0";
  await fetch(`/api/tasks/${t.id}`, { method: "DELETE" });
  await refresh();
}

// ---------- reminders + notifications ----------
//
// Two kinds of reminder: (1) AUTO alerts derived from a task's due date — a heads-up
// 3 days / 1 day before, and on the day; (2) MANUAL reminders the user sets via the
// bell. A light client-side poller checks every REMINDER_TICK and fires anything due.
// "Fired" markers are persisted on the task so a reminder never repeats across restarts.

const REMINDER_TICK = 30000; // ms between reminder checks
const REMIND_HOUR = 9; // auto due-alerts fire at 9am local on their day
const DUE_LEADS = [{ label: "3", days: 3 }, { label: "1", days: 1 }, { label: "0", days: 0 }];
const STALE_MS = 24 * 60 * 60 * 1000; // suppress (but mark) alerts whose moment passed >24h ago
const SNOOZE_MS = { "15 min": 15 * 60000, "1 hour": 60 * 60000 };

const startOfDay = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};
const atHour = (date, h, m = 0) => {
  const x = new Date(date);
  x.setHours(h, m, 0, 0);
  return x;
};

// Human, theme-agnostic phrasing for a reminder timestamp ("Today 9:00 AM", "Jun 30 2:15 PM").
function formatReminder(iso) {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `Today ${time}`;
  const tmr = new Date(now.getTime() + 86400000);
  if (d.toDateString() === tmr.toDateString()) return `Tomorrow ${time}`;
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${time}`;
}

// The datetime a given lead alert should fire (e.g. 3 days before due, at 9am).
function dueAlertAt(due, days) {
  const d = startOfDay(new Date(due + "T00:00:00"));
  d.setDate(d.getDate() - days);
  return atHour(d, REMIND_HOUR).getTime();
}

let _checking = false;
async function checkReminders() {
  if (_checking) return;
  _checking = true;
  let firedAny = false;
  try {
    const now = Date.now();
    for (const t of state.tasks) {
      if (t.done) continue;

      // (2) Manual reminder.
      if (t.remindAt && !t.remindFiredAt && new Date(t.remindAt).getTime() <= now) {
        fireNotice(t, "Reminder", false);
        await markFired(t, { remindFiredAt: new Date().toISOString() });
        firedAny = true;
      }

      // (1) Auto due-date alerts.
      if (t.due) {
        const fired = new Set((t.dueAlertsFired || []).map(String));
        const createdMs = t.createdAt ? new Date(t.createdAt).getTime() : 0;
        const before = fired.size;
        for (const lead of DUE_LEADS) {
          if (fired.has(lead.label)) continue;
          const at = dueAlertAt(t.due, lead.days);
          if (at > now) continue; // not yet
          fired.add(lead.label);
          // Don't fire for moments that passed before the task existed, or long ago —
          // just record them so the widget doesn't dump a backlog on launch.
          if (now - at > STALE_MS || (createdMs && at < createdMs)) continue;
          const { reason, overdue } = dueAlertCopy(t);
          fireNotice(t, reason, overdue);
          firedAny = true;
        }
        if (fired.size !== before) await markFired(t, { dueAlertsFired: [...fired] });
      }
    }
  } finally {
    _checking = false;
  }
  if (firedAny) renderTasks(); // refresh the armed-bell / reminder-tag state
}

// Phrase a due-alert from the ACTUAL distance to due at fire time, not the lead offset —
// so an alert that fires late (app was closed at the intended 9am) still reads correctly
// ("Due today", not a stale "Due tomorrow").
function dueAlertCopy(t) {
  const diffDays = Math.round((startOfDay(new Date(t.due + "T00:00:00")) - startOfDay(new Date())) / 86400000);
  if (diffDays < 0) return { reason: "Overdue", overdue: true };
  if (diffDays === 0) return { reason: "Due today", overdue: false };
  if (diffDays === 1) return { reason: "Due tomorrow", overdue: false };
  return { reason: `Due in ${diffDays} days`, overdue: false };
}

// Persist a "fired" marker and mirror it locally so we don't re-fire this session.
async function markFired(t, patch) {
  Object.assign(t, patch);
  try {
    await fetch(`/api/tasks/${t.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  } catch {}
}

// Fire both surfaces: the in-app card (always) and an OS notification (background-safe).
function fireNotice(t, reason, overdue) {
  showNotice(t, reason, overdue);
  osNotify(reason, t.title);
}

// OS-level notification. In the widget, route through the Tauri shell; in a plain
// browser, use the Web Notifications API when the user has granted permission.
function osNotify(title, body) {
  if (IS_WIDGET) {
    window.dispatchEvent(new CustomEvent("ramble:notify", { detail: { title, body } }));
    return;
  }
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(title, { body });
    }
  } catch {}
}

// Ask for browser notification permission once, on a deliberate action (setting a reminder).
function requestOsPermission() {
  if (IS_WIDGET) return;
  try {
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
  } catch {}
}

// ----- in-app notification cards -----

function noticeSubtitle(t) {
  const bits = [];
  if (t.projectId && t.projectId !== "inbox") bits.push(projectName(t.projectId));
  if (t.due) bits.push(new Date(t.due + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }));
  return bits.join("  ·  ");
}

function showNotice(t, reason, overdue) {
  const key = `${t.id}:${reason}`;
  if (els.noticeStack.querySelector(`[data-key="${CSS.escape(key)}"]`)) return; // already showing

  const card = document.createElement("div");
  card.className = "notice";
  card.dataset.key = key;
  card.dataset.overdue = String(Boolean(overdue));
  card.setAttribute("role", "alert");

  const sub = noticeSubtitle(t);
  card.innerHTML = `
    <div class="notice__head">
      <svg class="notice__bell" viewBox="0 0 24 24" aria-hidden="true">${ICON.bell.replace(/^<svg[^>]*>|<\/svg>$/g, "")}</svg>
      <span class="notice__reason">${escapeHtml(reason)}</span>
      <button class="notice__dismiss" type="button" aria-label="Dismiss">✕</button>
    </div>
    <p class="notice__title">${escapeHtml(t.title)}</p>
    ${sub ? `<p class="notice__sub">${escapeHtml(sub)}</p>` : ""}
    <div class="notice__actions">
      <span class="notice__snooze">
        <button class="notice__btn" type="button" data-act="snooze" aria-haspopup="true">Snooze</button>
      </span>
      <button class="notice__btn notice__btn--primary" type="button" data-act="done">Done</button>
    </div>`;

  card.querySelector(".notice__dismiss").addEventListener("click", () => dismissNotice(card));
  card.querySelector('[data-act="done"]').addEventListener("click", () => noticeDone(t, card));
  const snoozeWrap = card.querySelector(".notice__snooze");
  card.querySelector('[data-act="snooze"]').addEventListener("click", () => toggleSnoozeMenu(t, snoozeWrap, card));

  els.noticeStack.appendChild(card);
}

function dismissNotice(card) {
  card.dataset.leaving = "true";
  setTimeout(() => card.remove(), 200);
}

function toggleSnoozeMenu(t, wrap, card) {
  const open = wrap.querySelector(".notice__snoozemenu");
  if (open) return open.remove();
  const menu = document.createElement("div");
  menu.className = "notice__snoozemenu";
  const opts = [
    { label: "15 min", at: () => Date.now() + SNOOZE_MS["15 min"] },
    { label: "1 hour", at: () => Date.now() + SNOOZE_MS["1 hour"] },
    { label: "Tomorrow 9am", at: () => atHour(new Date(Date.now() + 86400000), REMIND_HOUR).getTime() },
  ];
  for (const o of opts) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = o.label;
    b.addEventListener("click", () => {
      menu.remove();
      snoozeTo(t, new Date(o.at()).toISOString(), card);
    });
    menu.appendChild(b);
  }
  wrap.appendChild(menu);
}

async function snoozeTo(t, iso, card) {
  Object.assign(t, { remindAt: iso, remindFiredAt: null });
  try {
    await fetch(`/api/tasks/${t.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ remindAt: iso }),
    });
  } catch {}
  dismissNotice(card);
  renderTasks();
  toast(`Snoozed — ${formatReminder(iso)}`);
}

async function noticeDone(t, card) {
  t.done = true;
  try {
    await fetch(`/api/tasks/${t.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ done: true }),
    });
  } catch {}
  dismissNotice(card);
  await refresh();
}

// ----- reminder popover (the bell) -----

let openPopover = null;

function closeReminderPopover() {
  if (openPopover) {
    openPopover.remove();
    openPopover = null;
    document.removeEventListener("click", onPopoverOutside, true);
    window.removeEventListener("resize", closeReminderPopover);
  }
}

function onPopoverOutside(e) {
  if (openPopover && !openPopover.contains(e.target)) closeReminderPopover();
}

function reminderPresets(t) {
  const now = new Date();
  const presets = [{ label: "In 1 hour", at: new Date(now.getTime() + 3600000) }];
  let tonight = atHour(now, 20);
  if (tonight <= now) tonight = atHour(new Date(now.getTime() + 86400000), 20);
  presets.push({ label: "Tonight", at: tonight });
  presets.push({ label: "Tomorrow 9am", at: atHour(new Date(now.getTime() + 86400000), REMIND_HOUR) });
  if (t.due) {
    const dayBefore = atHour(new Date(new Date(t.due + "T00:00:00").getTime() - 86400000), REMIND_HOUR);
    if (dayBefore > now) presets.push({ label: "Day before due", at: dayBefore });
  }
  return presets;
}

function openReminderPopover(t, anchor) {
  const wasForThis = openPopover && openPopover.dataset.taskId === t.id;
  closeReminderPopover();
  if (wasForThis) return; // clicking the bell again closes it

  const pending = t.remindAt && !t.remindFiredAt;
  const pop = document.createElement("div");
  pop.className = "rpop";
  pop.dataset.taskId = t.id;
  pop.innerHTML = `
    <p class="rpop__title">Remind me</p>
    ${
      pending
        ? `<div class="rpop__current"><span>${escapeHtml(formatReminder(t.remindAt))}</span><button class="rpop__clear" type="button">Clear</button></div>`
        : ""
    }
    <div class="rpop__presets"></div>
    <div class="rpop__divider"></div>
    <div class="rpop__custom">
      <input type="datetime-local" aria-label="Custom reminder time" />
      <button class="btn-send" type="button">Set</button>
    </div>`;

  const presetWrap = pop.querySelector(".rpop__presets");
  for (const p of reminderPresets(t)) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = p.label;
    chip.addEventListener("click", () => setReminder(t, p.at.toISOString()));
    presetWrap.appendChild(chip);
  }

  if (pending) pop.querySelector(".rpop__clear").addEventListener("click", () => clearReminder(t));

  const input = pop.querySelector('input[type="datetime-local"]');
  pop.querySelector(".rpop__custom .btn-send").addEventListener("click", () => {
    if (!input.value) return toast("Pick a date and time first.");
    const at = new Date(input.value);
    if (at.getTime() <= Date.now()) return toast("Pick a time in the future.");
    setReminder(t, at.toISOString());
  });

  document.body.appendChild(pop);
  positionPopover(pop, anchor);
  openPopover = pop;
  // Defer so this very click doesn't immediately close it.
  setTimeout(() => document.addEventListener("click", onPopoverOutside, true), 0);
  window.addEventListener("resize", closeReminderPopover);
}

// Anchor the popover to the bell, flipping/clamping so it never leaves the viewport.
function positionPopover(pop, anchor) {
  const a = anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  let left = a.right - w;
  let top = a.bottom + 8;
  if (top + h > window.innerHeight - 8) top = a.top - h - 8; // flip above
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  top = Math.max(8, top);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

async function setReminder(t, iso) {
  requestOsPermission();
  Object.assign(t, { remindAt: iso, remindFiredAt: null });
  try {
    await fetch(`/api/tasks/${t.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ remindAt: iso }),
    });
  } catch {}
  closeReminderPopover();
  renderTasks();
  toast(`Reminder set — ${formatReminder(iso)}`);
}

async function clearReminder(t) {
  Object.assign(t, { remindAt: null, remindFiredAt: null });
  try {
    await fetch(`/api/tasks/${t.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ remindAt: null }),
    });
  } catch {}
  closeReminderPopover();
  renderTasks();
  toast("Reminder cleared");
}

// Esc closes the reminder popover (before any other Esc handler reacts).
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && openPopover) {
    e.stopPropagation();
    closeReminderPopover();
  }
}, true);

// ---------- boot ----------

async function refresh() {
  const data = await (await fetch("/api/state")).json();
  state.tasks = data.tasks;
  state.projects = data.projects;
  renderProjectBar();
  renderTasks();
}

// In the widget, ask the shell which port the sidecar is on, then wait for it to boot.
async function resolveApi() {
  if (!IS_WIDGET) return;
  // The port is set in Rust during startup; retry until it's known (avoids a boot race
  // where /api/* would otherwise resolve to the tauri:// page and return HTML).
  for (let i = 0; i < 60; i++) {
    try {
      const port = await window.__TAURI__.core.invoke("get_api_port");
      if (port) {
        API_BASE = `http://127.0.0.1:${port}`;
        return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function waitForBackend() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch("/api/health");
      if (r.ok) {
        // The tauri:// fallback returns index.html with 200 — make sure it's real JSON.
        const j = await r.json();
        if (j && "deepseek" in j) return true;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function boot() {
  await resolveApi();
  await waitForBackend();
  try {
    const health = await (await fetch("/api/health")).json();
    if (!health.groq) {
      els.hint.textContent = "Add a Groq key to speak — or type below";
      showTypebox();
    }
  } catch {}
  await refresh();
  // Start the reminder poller once tasks are loaded.
  checkReminders();
  setInterval(checkReminders, REMINDER_TICK);
}

// ---------- themes ----------

const THEME_KEY = "ramble-theme";
const THEMES = [
  { id: "paper", name: "Paper & Ink", sw: ["#f4f1ea", "#1c1a17", "#c2410c"] },
  { id: "ember", name: "Graphite & Ember", sw: ["#181714", "#f0ece4", "#ff8a3d"] },
  { id: "dusk", name: "Refine Dusk", sw: ["#131119", "#ece8f4", "#8b7bd8"] },
  { id: "forest", name: "Forest", sw: ["#101610", "#e8ede2", "#cdaa5e"] },
  { id: "cobalt", name: "Cobalt & Cream", sw: ["#f2f1ee", "#15171c", "#1d4ed8"] },
  { id: "mono", name: "Mono Signal", sw: ["#0e0f10", "#ededee", "#22d3ee"] },
];

const currentTheme = () => document.documentElement.dataset.theme || "paper";

function applyTheme(id) {
  document.documentElement.dataset.theme = id;
  try {
    localStorage.setItem(THEME_KEY, id);
  } catch {}
  renderThemeGrid();
}

function renderThemeGrid() {
  const grid = document.getElementById("themeGrid");
  if (!grid) return;
  const cur = currentTheme();
  grid.innerHTML = "";
  for (const t of THEMES) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "theme-card";
    card.setAttribute("aria-pressed", String(t.id === cur));
    card.innerHTML = `
      <span class="theme-card__sw">${t.sw.map((c) => `<span style="background:${c}"></span>`).join("")}</span>
      <span class="theme-card__name">${escapeHtml(t.name)}
        <svg class="theme-card__check" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8l4 4 8-9"/></svg>
      </span>`;
    card.addEventListener("click", () => applyTheme(t.id));
    grid.appendChild(card);
  }
}

// Tabs inside the Settings modal (Appearance / API keys).
for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    const name = tab.dataset.tab;
    document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
    document.querySelectorAll(".tabpanel").forEach((p) => (p.hidden = p.dataset.panel !== name));
  });
}

// ---------- settings (API keys) ----------

const settingsModal = document.getElementById("settingsModal");

function setKeyState(id, isSet) {
  const el = document.getElementById(id);
  el.textContent = isSet ? "set ✓" : "not set";
  el.dataset.set = String(Boolean(isSet));
}

async function openSettings() {
  renderThemeGrid();
  document.getElementById("deepseekKey").value = "";
  document.getElementById("groqKey").value = "";
  try {
    const cfg = await (await fetch("/api/config")).json();
    setKeyState("dsState", cfg.deepseek);
    setKeyState("groqState", cfg.groq);
    document.getElementById("deepseekKey").placeholder = cfg.deepseek ? "•••••• saved — type to replace" : "sk-…";
    document.getElementById("groqKey").placeholder = cfg.groq ? "•••••• saved — type to replace" : "gsk_…";
  } catch {}
  settingsModal.hidden = false;
  setTimeout(() => document.getElementById("deepseekKey").focus(), 60);
}

function closeSettings() {
  settingsModal.hidden = true;
}

async function saveSettings() {
  // Only send fields the user actually typed — a blank field leaves the saved key intact.
  const ds = document.getElementById("deepseekKey").value.trim();
  const gq = document.getElementById("groqKey").value.trim();
  const body = {};
  if (ds) body.deepseekKey = ds;
  if (gq) body.groqKey = gq;
  if (!Object.keys(body).length) return closeSettings();
  try {
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error();
    toast("Keys saved.");
    closeSettings();
    boot(); // re-check health (voice availability)
  } catch {
    toast("Couldn't save keys.", "error");
  }
}

document.getElementById("settingsBtn").addEventListener("click", openSettings);
document.getElementById("settingsSave").addEventListener("click", saveSettings);
settingsModal.addEventListener("click", (e) => {
  if (e.target.hasAttribute("data-close")) closeSettings();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !settingsModal.hidden) closeSettings();
});
// Tray "Settings" item (widget) routes here via tauri-bridge.
window.addEventListener("ramble:open-settings", openSettings);

// ---------- custom summon hotkey ----------

const HOTKEY_KEY = "ramble.hotkey";
const DEFAULT_HOTKEY = { ctrl: true, shift: true, alt: false, meta: false, code: "Space" };
// e.code values for the bare modifier keys — we wait for a "real" key before finishing.
const MODIFIER_CODES = new Set([
  "ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight",
  "AltLeft", "AltRight", "MetaLeft", "MetaRight",
]);

function loadHotkey() {
  try {
    const hk = JSON.parse(localStorage.getItem(HOTKEY_KEY) || "null");
    if (hk && typeof hk.code === "string") {
      return { ctrl: !!hk.ctrl, shift: !!hk.shift, alt: !!hk.alt, meta: !!hk.meta, code: hk.code };
    }
  } catch {}
  return { ...DEFAULT_HOTKEY };
}

const hotkeysEqual = (a, b) =>
  a.ctrl === b.ctrl && a.shift === b.shift && a.alt === b.alt && a.meta === b.meta && a.code === b.code;

// Human label for a single key code: "KeyR" → "R", "ArrowUp" → "↑", "F8" → "F8".
function keyLabel(code) {
  if (code === "Space") return "Space";
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
  if ((m = /^Digit(\d)$/.exec(code))) return m[1];
  if (/^F\d{1,2}$/.test(code)) return code;
  const named = {
    ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
    Enter: "Enter", NumpadEnter: "Enter", Tab: "Tab", Backspace: "⌫",
  };
  return named[code] || code;
}

// <kbd> chips for a {ctrl,shift,alt,meta,code} combo.
function hotkeyChips(hk) {
  const parts = [];
  if (hk.ctrl) parts.push("Ctrl");
  if (hk.shift) parts.push("Shift");
  if (hk.alt) parts.push("Alt");
  if (hk.meta) parts.push("Win");
  parts.push(keyLabel(hk.code));
  return parts.map((p) => `<kbd>${escapeHtml(p)}</kbd>`).join("");
}

// One modifier max (the 1-or-2-button rule). A lone key must be a function key so it can't
// hijack ordinary typing system-wide. Returns an error string, or null when valid.
function validateHotkey(hk) {
  if (!hk.code || MODIFIER_CODES.has(hk.code)) return "Press a key to finish.";
  const mods = [hk.ctrl, hk.shift, hk.alt, hk.meta].filter(Boolean).length;
  if (mods > 1) return "Use one key, or one modifier + a key.";
  if (mods === 0 && !/^F\d{1,2}$/.test(hk.code)) {
    return "A single-key shortcut must be a function key (e.g. F8). Otherwise add Ctrl, Alt or Shift.";
  }
  return null;
}

async function applyHotkey(hk) {
  if (!IS_WIDGET) return true;
  try {
    await window.__TAURI__.core.invoke("set_global_shortcut", {
      ctrl: hk.ctrl, shift: hk.shift, alt: hk.alt, meta: hk.meta, code: hk.code,
    });
    return true;
  } catch (e) {
    toast(typeof e === "string" ? e : "Couldn't set that shortcut.", "error");
    return false;
  }
}

let hotkeyCurrent = loadHotkey();
let hotkeyPending = null;
let hotkeyCapturing = false;

const hkRow = document.getElementById("hotkeyRow");
const hkDisplay = document.getElementById("hotkeyDisplay");
const hkEdit = document.getElementById("hotkeyEdit");
const hkSave = document.getElementById("hotkeySave");
const hkCancel = document.getElementById("hotkeyCancel");
const hkHint = document.getElementById("hotkeyHint");
const hkReset = document.getElementById("hotkeyReset");

function renderHotkey() {
  if (!hkDisplay) return;
  if (hotkeyCapturing) {
    hkDisplay.innerHTML = hotkeyPending
      ? hotkeyChips(hotkeyPending)
      : `<span class="hotkey__prompt">Press a shortcut…</span>`;
  } else {
    hkDisplay.innerHTML = hotkeyChips(hotkeyCurrent);
    if (hkReset) hkReset.hidden = hotkeysEqual(hotkeyCurrent, DEFAULT_HOTKEY);
  }
}

function setCapturing(on) {
  hotkeyCapturing = on;
  hotkeyPending = null;
  if (hkRow) hkRow.classList.toggle("is-capturing", on);
  if (hkEdit) hkEdit.hidden = on;
  if (hkSave) { hkSave.hidden = !on; hkSave.disabled = true; }
  if (hkCancel) hkCancel.hidden = !on;
  if (hkHint) hkHint.hidden = true;
  if (hkReset) hkReset.hidden = on || hotkeysEqual(hotkeyCurrent, DEFAULT_HOTKEY);
  renderHotkey();
}

function onHotkeyKeydown(e) {
  if (!hotkeyCapturing) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.code === "Escape") return setCapturing(false);
  // Hold off until a non-modifier key lands.
  if (MODIFIER_CODES.has(e.code)) {
    hotkeyPending = null;
    if (hkSave) hkSave.disabled = true;
    if (hkDisplay) hkDisplay.innerHTML = `<span class="hotkey__prompt">Press a shortcut…</span>`;
    return;
  }
  const hk = { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey, code: e.code };
  const err = validateHotkey(hk);
  hotkeyPending = hk;
  if (hkDisplay) hkDisplay.innerHTML = hotkeyChips(hk);
  if (hkHint) { hkHint.hidden = !err; hkHint.textContent = err || ""; }
  if (hkSave) hkSave.disabled = !!err;
}

if (hkEdit) hkEdit.addEventListener("click", () => setCapturing(true));
if (hkCancel) hkCancel.addEventListener("click", () => setCapturing(false));
if (hkSave) {
  hkSave.addEventListener("click", async () => {
    if (!hotkeyPending || validateHotkey(hotkeyPending)) return;
    const hk = hotkeyPending;
    if (!(await applyHotkey(hk))) return;
    hotkeyCurrent = hk;
    try { localStorage.setItem(HOTKEY_KEY, JSON.stringify(hk)); } catch {}
    setCapturing(false);
    toast("Shortcut updated.");
  });
}
if (hkReset) {
  hkReset.addEventListener("click", async () => {
    if (!(await applyHotkey(DEFAULT_HOTKEY))) return;
    hotkeyCurrent = { ...DEFAULT_HOTKEY };
    try { localStorage.setItem(HOTKEY_KEY, JSON.stringify(hotkeyCurrent)); } catch {}
    renderHotkey();
    toast("Shortcut reset to Ctrl + Shift + Space.");
  });
}
// Capture phase so the combo is grabbed before the Esc-to-close / collapse handlers.
document.addEventListener("keydown", onHotkeyKeydown, true);

renderHotkey();
// Sync the shell with the stored choice on startup (covers a custom combo from a past run).
applyHotkey(hotkeyCurrent);

boot();
