// Ramble — Electron shell (replaces the Tauri shell, ADR-0006).
// One frameless, transparent, always-on-top window that morphs across orb / capture /
// panel sizes (the morph identity, ADR-0005/0007). server.js is forked with Electron's
// bundled Node — no separate server binary, no rewrite of the Express layer.
const {
  app,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  Tray,
  Menu,
  Notification,
  screen,
  nativeImage,
  session,
} = require("electron");
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");
const fs = require("node:fs");

// --- the three morph sizes (logical px), mirrored from the Tauri shell (lib.rs) ---
const SIZES = { orb: [140, 140], capture: [340, 360], panel: [400, 600] };
const MARGIN = 24;

let win = null;
let tray = null;
let serverChild = null;
let serverPort = 5179;
let currentAccel = null;

// Shell state guards (mirror RecordingState / Dragging / WidgetAnchor in lib.rs).
let recording = false; // while true, blur must NOT collapse (don't dismiss mid-ramble)
let dragging = false; // while true, blur is the OS move loop — don't collapse
let widgetAnchor = null; // {x,y} orb centre, so it returns to its spot after capture/panel

// ---------- backend (forked server.js) ----------

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", () => resolve(5179));
  });
}

function waitForPort(port, tries = 120) {
  return new Promise((resolve) => {
    let n = 0;
    const tick = () => {
      const sock = net.connect(port, "127.0.0.1");
      sock.once("connect", () => {
        sock.destroy();
        resolve(true);
      });
      sock.once("error", () => {
        sock.destroy();
        if (++n >= tries) return resolve(false);
        setTimeout(tick, 150);
      });
    };
    tick();
  });
}

async function startBackend() {
  serverPort = await freePort();
  const dataDir = path.join(app.getPath("userData"), "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const serverPath = path.join(__dirname, "..", "server.js");
  const publicDir = path.join(__dirname, "..", "public");

  // Run server.js with Electron's own Node (ELECTRON_RUN_AS_NODE), so there is no
  // per-OS server binary to bundle. The Express routes/prompt/JSON logic are unchanged.
  serverChild = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PORT: String(serverPort),
      RAMBLE_DATA_DIR: dataDir,
      RAMBLE_PUBLIC_DIR: publicDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverChild.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
  serverChild.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  serverChild.on("exit", (code) => console.log(`[server] exited (${code})`));

  await waitForPort(serverPort);
}

// ---------- window morph (mirror set_widget_mode / position_orb_default) ----------

function setWidgetMode(mode) {
  if (!win) return;
  const [w, h] = SIZES[mode] || SIZES.orb;
  const b = win.getBounds();
  const cur = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  // Leaving the orb: remember where it lives so we can restore it on collapse.
  if (mode !== "orb") widgetAnchor = cur;

  let x;
  let y;
  if (mode === "panel") {
    // Centre the panel on the window's current monitor (independent of the orb corner).
    const wa = screen.getDisplayMatching(b).workArea;
    x = Math.round(wa.x + (wa.width - w) / 2);
    y = Math.round(wa.y + (wa.height - h) / 2);
  } else {
    // orb / capture: grow or shrink around the orb's resting centre (no clamp).
    const c = mode === "orb" ? widgetAnchor || cur : cur;
    x = Math.round(c.x - w / 2);
    y = Math.round(c.y - h / 2);
  }
  win.setBounds({ x: Math.max(0, x), y: Math.max(0, y), width: w, height: h });
}

function positionOrbDefault() {
  if (!win) return;
  const wa = screen.getPrimaryDisplay().workArea; // already excludes the taskbar
  const [w, h] = SIZES.orb;
  const x = wa.x + wa.width - w - MARGIN;
  const y = wa.y + wa.height - h - MARGIN;
  win.setBounds({ x: Math.max(0, x), y: Math.max(0, y), width: w, height: h });
  widgetAnchor = { x: x + w / 2, y: y + h / 2 };
}

// ---------- summon (mirror show_and_record) ----------

function summon() {
  if (!win) return;
  win.show();
  win.focus();
  win.webContents.send("ramble:hotkey"); // frontend: show + start recording
}

// ---------- global hotkey ----------

function codeToAccelKey(code) {
  const m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1];
  const d = /^Digit(\d)$/.exec(code);
  if (d) return d[1];
  if (/^F\d{1,2}$/.test(code)) return code;
  const map = {
    Space: "Space",
    Enter: "Return",
    Tab: "Tab",
    Escape: "Escape",
    Backquote: "`",
    Minus: "-",
    Equal: "=",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
  };
  return map[code] || code;
}

function buildAccelerator({ ctrl, shift, alt, meta, code }) {
  const parts = [];
  if (ctrl) parts.push("Control");
  if (shift) parts.push("Shift");
  if (alt) parts.push("Alt");
  if (meta) parts.push("Super");
  parts.push(codeToAccelKey(code));
  return parts.join("+");
}

function registerShortcut(args) {
  const accel = buildAccelerator(args);
  if (currentAccel) globalShortcut.unregister(currentAccel);
  const ok = globalShortcut.register(accel, summon);
  if (!ok) {
    currentAccel = null;
    throw new Error(`Couldn't register ${accel} (already in use?)`);
  }
  currentAccel = accel;
}

// ---------- IPC: the shell command surface app.js / electron-bridge.js call ----------

ipcMain.handle("ramble:invoke", (_e, cmd, args = {}) => {
  switch (cmd) {
    case "set_recording":
      recording = Boolean(args.recording);
      return;
    case "set_dragging":
      dragging = Boolean(args.dragging);
      return;
    case "set_widget_mode":
      setWidgetMode(String(args.mode || "orb"));
      return;
    case "get_api_port":
      return serverPort;
    case "set_global_shortcut":
      registerShortcut(args); // throws → renderer promise rejects (UI toasts)
      return;
    case "notify":
      new Notification({
        title: String(args.title || "Ramble"),
        body: String(args.body || ""),
      }).show();
      return;
    default:
      throw new Error(`unknown command: ${cmd}`);
  }
});

// ---------- tray ----------

function buildTray() {
  const iconPath = path.join(__dirname, "..", "src-tauri", "icons", "32x32.png");
  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip("Ramble — say it, I'll sort it");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show Ramble", click: summon },
      { label: "Hide widget", click: () => win && win.hide() },
      {
        label: "Settings",
        click: () => {
          if (!win) return;
          win.show();
          win.focus();
          win.webContents.send("ramble:open-settings");
        },
      },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ])
  );
  tray.on("click", summon);
}

// ---------- window ----------

function createWindow() {
  const [w, h] = SIZES.orb;
  win = new BrowserWindow({
    width: w,
    height: h,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Blur → collapse the panel back to the orb, but NOT mid-recording and NOT while the
  // OS move loop has stolen focus (dragging). Mirrors on_window_event in lib.rs.
  win.on("blur", () => {
    if (!recording && !dragging) win.webContents.send("ramble:collapse");
  });
  win.on("focus", () => {
    dragging = false;
  });

  win.loadURL(`http://127.0.0.1:${serverPort}`);
  win.webContents.once("did-finish-load", () => {
    positionOrbDefault();
    win.show();
  });
}

// ---------- lifecycle ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", summon);

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    // Grant mic to the local tool (renderer is served from 127.0.0.1, a secure context).
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(true));
    session.defaultSession.setPermissionCheckHandler(() => true);

    await startBackend();
    createWindow();
    buildTray();

    // Default summon hotkey: Ctrl+Shift+Space → show + record. The frontend re-applies
    // the user's stored choice on boot via set_global_shortcut.
    try {
      registerShortcut({ ctrl: true, shift: true, alt: false, meta: false, code: "Space" });
    } catch (e) {
      console.error(e);
    }
  });

  // Tray app: closing the window does not quit; only the tray Quit / app.quit() does.
  app.on("window-all-closed", () => {});

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    if (serverChild) serverChild.kill();
  });
}
