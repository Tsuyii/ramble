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
  status: $("status"),
  statusText: $("status").querySelector(".status__text"),
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
};

const PRIO_COLOR = { high: "var(--p-high)", medium: "var(--p-med)", low: "var(--p-low)" };

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

function setStatus(s, text) {
  els.status.dataset.state = s;
  els.statusText.textContent = text;
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
    els.orb.dataset.recording = "true";
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
  els.orb.dataset.recording = "false";
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
      grad.addColorStop(0, "rgba(155,124,255,0.85)");
      grad.addColorStop(1, "rgba(95,224,208,0.9)");
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
    ctx.strokeStyle = `rgba(155,124,255,${0.15 + level * 0.4})`;
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

// ---------- AI pipeline ----------

async function transcribe(blob) {
  setStatus("thinking", "Tidying up");
  els.thinking.hidden = false;
  try {
    const form = new FormData();
    form.append("audio", blob, "ramble.webm");
    const res = await fetch("/api/transcribe", { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Transcription failed");
    els.thinking.hidden = true;
    setStatus("ready", "Check it");
    if (!data.transcript) return toast("Didn't catch anything — try again.", "error");
    els.transcriptText.value = data.transcript;
    els.transcript.hidden = false;
    els.transcriptText.focus();
  } catch (err) {
    els.thinking.hidden = true;
    setStatus("ready", "Ready");
    toast(err.message, "error");
  }
}

async function structure(transcript) {
  setStatus("thinking", "Sorting");
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
    if (!currentDrafts.length) return toast("No tasks found in that — try again.");
    buildQueue();
    if (queue.length) startFollowups();
    else finalize();
  } catch (err) {
    els.thinking.hidden = true;
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
    toast(`Added ${data.added} task${data.added === 1 ? "" : "s"} ✦`);
    els.taskGroups.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (err) {
    els.thinking.hidden = true;
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

  const edit = document.createElement("button");
  edit.className = "task__edit";
  edit.setAttribute("aria-label", "Edit task");
  edit.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
  edit.addEventListener("click", () => openEditor(t, el, overdue));

  el.append(check, body, edit);
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
}

// ---------- settings (API keys) ----------

const settingsModal = document.getElementById("settingsModal");

function setKeyState(id, isSet) {
  const el = document.getElementById(id);
  el.textContent = isSet ? "set ✓" : "not set";
  el.dataset.set = String(Boolean(isSet));
}

async function openSettings() {
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

boot();
