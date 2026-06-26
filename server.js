import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

dotenv.config();

// In the esbuild CJS bundle, import.meta.url is empty and fileURLToPath throws — fall
// back to cwd. Harmless because the packaged sidecar gets its dirs from env (below).
const __dirname = (() => {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
})();
// Dev: ./data. Packaged widget: the Tauri shell passes RAMBLE_DATA_DIR (an OS app-data
// path) because the install dir is read-only. See ADR-0002.
const DATA_DIR = process.env.RAMBLE_DATA_DIR || path.join(__dirname, "data");
const TASKS_FILE = path.join(DATA_DIR, "tasks.json");
const PROJECTS_FILE = path.join(DATA_DIR, "projects.json");
const MEMORY_FILE = path.join(DATA_DIR, "memory.json");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");

// Keys come from the user-entered config file (in the app-data dir), falling back to
// env / .env for local dev. Read fresh each time so Settings changes take effect with
// no restart. The key never lives in bundled JS — the frontend posts it to this local
// server only (see ADR-0002, key-safety).
async function currentKeys() {
  const cfg = await readJson(CONFIG_FILE, {});
  return {
    deepseek: (cfg.deepseekKey || process.env.DEEPSEEK_API_KEY || "").trim(),
    groq: (cfg.groqKey || process.env.GROQ_API_KEY || "").trim(),
  };
}
const PORT = process.env.PORT || 5179;

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL = "deepseek-chat";
const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODEL = "whisper-large-v3-turbo";

const INBOX = { id: "inbox", name: "Inbox", color: "#6f6883" };
const PROJECT_COLORS = ["#9b7cff", "#5fe0d0", "#ffb454", "#ff6b9d", "#5fd3a3", "#7c8cff", "#ff8a5b"];
const MAX_CORRECTIONS = 60;

const app = express();
app.use(express.json({ limit: "1mb" }));
// Dev: ./public. Packaged widget: the Tauri shell passes RAMBLE_PUBLIC_DIR (the
// bundled frontend in app resources), since the sidecar is a compiled binary with no
// ./public next to it. See ADR-0002.
const PUBLIC_DIR = process.env.RAMBLE_PUBLIC_DIR || path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// ---------- persistence ----------

async function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}
async function writeJson(file, value) {
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2), "utf8");
}

const loadTasks = () => readJson(TASKS_FILE, []);
const saveTasks = (t) => writeJson(TASKS_FILE, t);
const loadMemory = () => readJson(MEMORY_FILE, { corrections: [] });
const saveMemory = (m) => writeJson(MEMORY_FILE, m);

async function loadProjects() {
  let projects = await readJson(PROJECTS_FILE, null);
  if (!projects) {
    // First run: seed a few example projects the user mentioned. Editable in the UI.
    projects = ["Ramble", "Trade-in", "Personal"].map((name, i) => ({
      id: randomUUID(),
      name,
      color: PROJECT_COLORS[i % PROJECT_COLORS.length],
      createdAt: new Date().toISOString(),
    }));
    await writeJson(PROJECTS_FILE, projects);
  }
  return projects;
}

async function ensureProject(name, projects) {
  const trimmed = (name || "").trim();
  if (!trimmed || /^inbox$|^none$/i.test(trimmed)) return { id: "inbox", projects };
  const found = projects.find((p) => p.name.toLowerCase() === trimmed.toLowerCase());
  if (found) return { id: found.id, projects };
  const created = {
    id: randomUUID(),
    name: trimmed,
    color: PROJECT_COLORS[projects.length % PROJECT_COLORS.length],
    createdAt: new Date().toISOString(),
  };
  const next = [...projects, created];
  await writeJson(PROJECTS_FILE, next);
  return { id: created.id, projects: next };
}

// ---------- AI ----------

function todayContext() {
  const now = new Date();
  return {
    iso: now.toISOString().slice(0, 10),
    weekday: now.toLocaleDateString("en-US", { weekday: "long" }),
  };
}

async function deepseek(messages) {
  const { deepseek: key } = await currentKeys();
  if (!key) throw new Error("DeepSeek API key not set — add it in Settings.");
  const res = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: DEEPSEEK_MODEL, messages, temperature: 0.2, response_format: { type: "json_object" } }),
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return JSON.parse(data.choices?.[0]?.message?.content ?? "{}");
}

function learnedBlock(memory, tasks, projects) {
  const lines = [];
  const recentCorrections = (memory.corrections || []).slice(-18);
  if (recentCorrections.length) {
    lines.push("Patterns learned from this user's past corrections (mimic these):");
    for (const c of recentCorrections) {
      lines.push(`- "${c.title}" → ${c.field} = ${c.to}`);
    }
  }
  // A few recent examples of how tasks map to projects/priority.
  const byProject = {};
  for (const t of tasks.slice(0, 24)) {
    const pname = projects.find((p) => p.id === t.projectId)?.name || "Inbox";
    (byProject[pname] ||= []).push(t.title);
  }
  const exLines = Object.entries(byProject)
    .map(([p, titles]) => `- ${p}: ${titles.slice(0, 4).map((x) => `"${x}"`).join(", ")}`)
    .slice(0, 6);
  if (exLines.length) {
    lines.push("", "Recent examples of how this user files tasks:");
    lines.push(...exLines);
  }
  return lines.length ? "\n\n" + lines.join("\n") : "";
}

const structureSystem = (ctx, projects, learned) => `You are Ramble, an assistant that turns a messy spoken brain-dump into clean, scheduled todo tasks.
Today is ${ctx.weekday}, ${ctx.iso}. Resolve relative dates ("tomorrow", "next friday", "in two weeks") to absolute YYYY-MM-DD.

The user files tasks into PROJECTS. Existing projects (use the id):
${projects.map((p) => `- ${p.id} = ${p.name}`).join("\n")}
- inbox = Inbox (default when nothing fits)

For each task you extract, infer:
- title: short imperative phrase, no trailing period.
- due: YYYY-MM-DD or null.
- priority: "high" | "medium" | "low" or null (only when clearly implied).
- projectId: the best-fit existing project id, or "inbox". If it clearly belongs to a NEW project not listed, set projectId to null and set suggestedProject to a short project name.
- suggestedProject: string or null (only when proposing a brand-new project).
- subtasks: array of short steps ONLY if the task is genuinely large/multi-step; else [].

Then add adaptive follow-up questions. Be CONSERVATIVE — most tasks need ZERO questions. Ask at most ONE question per task, on the single most useful gap, and only when you are genuinely unsure and it matters:
- "project": ONLY when you are proposing a brand-NEW project (you set projectId to null and suggestedProject to a name). Ask the user to confirm creating it. Options = [the suggestedProject name, "Inbox"]. When a task fits an EXISTING project, file it silently — NEVER ask a project question in that case.
- "due": only if scheduling clearly matters and no date was given.
- "priority": only if importance is genuinely ambiguous AND the task seems to matter. Options ["High","Medium","Low"].
- "breakdown": only if the task is large and you did not already add subtasks. Options ["Yes, break it down","No"].
Never ask just to confirm something you already inferred well. Max 3 questions total across all tasks — EXCEPT new-project confirmations, which you should always ask and which do NOT count toward that limit.${learned}

Return STRICT JSON:
{"tasks":[{"title":"...","due":null,"priority":null,"projectId":"inbox","suggestedProject":null,"subtasks":[],"questions":[{"field":"project|due|priority|breakdown","text":"...","options":["..."]}]}]}
If there is no real task, return {"tasks":[]}.`;

const finalizeSystem = (ctx) => `You are Ramble. Today is ${ctx.weekday}, ${ctx.iso}. Resolve relative dates to YYYY-MM-DD.
You get draft tasks; some need a due date resolved from natural language and some need to be broken into subtasks (flagged with needsBreakdown:true).
- Resolve any "dueAnswer" to YYYY-MM-DD and put it in "due".
- For tasks with needsBreakdown:true, generate 2-6 concise subtasks.
- Leave everything else exactly as given.
Return STRICT JSON: {"tasks":[{"due":null,"subtasks":[]}]} with one entry per input task, SAME ORDER.`;

// ---------- routes ----------

app.get("/api/health", async (_req, res) => {
  const k = await currentKeys();
  res.json({ deepseek: Boolean(k.deepseek), groq: Boolean(k.groq) });
});

// Settings: report which keys are set (never echo the keys back), and save new ones.
app.get("/api/config", async (_req, res) => {
  const k = await currentKeys();
  res.json({ deepseek: Boolean(k.deepseek), groq: Boolean(k.groq) });
});

app.post("/api/config", async (req, res) => {
  const cfg = await readJson(CONFIG_FILE, {});
  const body = req.body || {};
  // Only overwrite a key when a non-empty string is provided; "" clears it.
  if (typeof body.deepseekKey === "string") cfg.deepseekKey = body.deepseekKey.trim();
  if (typeof body.groqKey === "string") cfg.groqKey = body.groqKey.trim();
  await writeJson(CONFIG_FILE, cfg);
  const k = await currentKeys();
  res.json({ deepseek: Boolean(k.deepseek), groq: Boolean(k.groq) });
});

app.get("/api/state", async (_req, res) => {
  res.json({ tasks: await loadTasks(), projects: await loadProjects(), inbox: INBOX });
});

app.post("/api/projects", async (req, res) => {
  const name = (req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "Name required" });
  const projects = await loadProjects();
  const { id, projects: next } = await ensureProject(name, projects);
  res.json({ id, projects: next });
});

app.delete("/api/projects/:id", async (req, res) => {
  const projects = await loadProjects();
  await writeJson(PROJECTS_FILE, projects.filter((p) => p.id !== req.params.id));
  // Orphaned tasks fall back to Inbox.
  const tasks = await loadTasks();
  let changed = false;
  for (const t of tasks) if (t.projectId === req.params.id) { t.projectId = "inbox"; changed = true; }
  if (changed) await saveTasks(tasks);
  res.json({ ok: true });
});

app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  try {
    const { groq: groqKey } = await currentKeys();
    if (!groqKey) return res.status(400).json({ error: "Groq key not set — add it in Settings (or use the type box)." });
    if (!req.file) return res.status(400).json({ error: "No audio received." });
    const form = new FormData();
    form.append("file", new Blob([req.file.buffer], { type: req.file.mimetype || "audio/webm" }), req.file.originalname || "ramble.webm");
    form.append("model", GROQ_MODEL);
    form.append("response_format", "json");
    const groqRes = await fetch(GROQ_URL, { method: "POST", headers: { Authorization: `Bearer ${groqKey}` }, body: form });
    if (!groqRes.ok) return res.status(502).json({ error: `Groq ${groqRes.status}: ${(await groqRes.text()).slice(0, 300)}` });
    const data = await groqRes.json();
    res.json({ transcript: (data.text || "").trim() });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post("/api/structure", async (req, res) => {
  try {
    const transcript = (req.body?.transcript || "").trim();
    if (!transcript) return res.status(400).json({ error: "Empty brain-dump." });
    const ctx = todayContext();
    const [projects, memory, tasks] = await Promise.all([loadProjects(), loadMemory(), loadTasks()]);
    const learned = learnedBlock(memory, tasks, projects);
    const result = await deepseek([
      { role: "system", content: structureSystem(ctx, projects, learned) },
      { role: "user", content: transcript },
    ]);
    const drafts = (result.tasks || []).map((t) => ({
      id: randomUUID(),
      title: t.title || "Untitled task",
      due: t.due || null,
      priority: t.priority || null,
      projectId: t.projectId || (t.suggestedProject ? null : "inbox"),
      suggestedProject: t.suggestedProject || null,
      subtasks: Array.isArray(t.subtasks) ? t.subtasks : [],
      questions: (Array.isArray(t.questions) ? t.questions : []).map((q) => ({
        id: randomUUID(),
        field: q.field,
        text: q.text,
        options: Array.isArray(q.options) ? q.options : [],
      })),
    }));
    res.json({ drafts, projects });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post("/api/finalize", async (req, res) => {
  try {
    const drafts = Array.isArray(req.body?.drafts) ? req.body.drafts : [];
    const answers = req.body?.answers || {};
    let projects = await loadProjects();

    // Apply project + priority answers locally; flag due/breakdown for the AI pass.
    for (const d of drafts) {
      d.needsBreakdown = false;
      d.dueAnswer = null;
      for (const q of d.questions || []) {
        const a = answers[q.id];
        if (a == null || a === "") continue;
        if (q.field === "priority") d.priority = String(a).toLowerCase();
        else if (q.field === "due") d.dueAnswer = a;
        else if (q.field === "breakdown") d.needsBreakdown = /yes/i.test(a);
        else if (q.field === "project") {
          const r = await ensureProject(a, projects);
          d.projectId = r.id;
          projects = r.projects;
        }
      }
      // A suggested new project is created ONLY if the user confirmed it via the
      // project question above (handled in the answers loop). If it was never
      // confirmed, fall back to Inbox — never silently spin up a new project.
      if (!d.projectId) d.projectId = "inbox";
    }

    // One AI pass only if some task needs a date resolved or a breakdown.
    const needAI = drafts.some((d) => d.dueAnswer || d.needsBreakdown);
    if (needAI) {
      const ctx = todayContext();
      const payload = {
        tasks: drafts.map((d) => ({
          title: d.title,
          due: d.due,
          dueAnswer: d.dueAnswer,
          subtasks: d.subtasks,
          needsBreakdown: d.needsBreakdown,
        })),
      };
      const result = await deepseek([
        { role: "system", content: finalizeSystem(ctx) },
        { role: "user", content: JSON.stringify(payload) },
      ]);
      const out = result.tasks || [];
      drafts.forEach((d, i) => {
        if (out[i]) {
          if (out[i].due) d.due = out[i].due;
          if (Array.isArray(out[i].subtasks) && out[i].subtasks.length) d.subtasks = out[i].subtasks;
        }
      });
    }

    const existing = await loadTasks();
    const now = new Date().toISOString();
    const created = drafts.map((t) => ({
      id: randomUUID(),
      title: t.title || "Untitled task",
      due: t.due || null,
      priority: t.priority || null,
      projectId: t.projectId || "inbox",
      subtasks: (Array.isArray(t.subtasks) ? t.subtasks : []).map((s) =>
        typeof s === "string" ? { text: s, done: false } : { text: s.text, done: Boolean(s.done) }
      ),
      done: false,
      createdAt: now,
      aiPriority: t.priority || null,
      aiProjectId: t.projectId || "inbox",
    }));
    const all = [...created, ...existing];
    await saveTasks(all);
    res.json({ tasks: all, projects, added: created.length });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.patch("/api/tasks/:id", async (req, res) => {
  const tasks = await loadTasks();
  const task = tasks.find((t) => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: "Not found" });
  const b = req.body || {};

  if (typeof b.done === "boolean") task.done = b.done;
  if (typeof b.title === "string" && b.title.trim()) task.title = b.title.trim();
  if ("due" in b) task.due = b.due || null;

  const memory = await loadMemory();
  const logCorrection = (field, to) => {
    memory.corrections = memory.corrections || [];
    memory.corrections.push({ title: task.title, field, to, at: new Date().toISOString() });
    if (memory.corrections.length > MAX_CORRECTIONS) memory.corrections = memory.corrections.slice(-MAX_CORRECTIONS);
  };

  if ("priority" in b && b.priority !== task.priority) {
    task.priority = b.priority || null;
    if (b.priority) logCorrection("priority", b.priority);
  }
  if ("projectId" in b && b.projectId !== task.projectId) {
    task.projectId = b.projectId || "inbox";
    const projects = await loadProjects();
    const pname = projects.find((p) => p.id === task.projectId)?.name || "Inbox";
    logCorrection("project", pname);
  }
  if (typeof b.subtaskIndex === "number" && task.subtasks[b.subtaskIndex]) {
    task.subtasks[b.subtaskIndex].done = Boolean(b.subtaskDone);
  }

  await Promise.all([saveTasks(tasks), saveMemory(memory)]);
  res.json({ task });
});

app.delete("/api/tasks/:id", async (req, res) => {
  const tasks = await loadTasks();
  await saveTasks(tasks.filter((t) => t.id !== req.params.id));
  res.json({ ok: true });
});

app.listen(PORT, async () => {
  console.log(`\n  Ramble running →  http://localhost:${PORT}`);
  const k = await currentKeys();
  console.log(`  DeepSeek: ${k.deepseek ? "set" : "not set"}   Groq: ${k.groq ? "set" : "not set (voice disabled)"}\n`);
});
