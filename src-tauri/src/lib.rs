use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewWindow, WindowEvent,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

/// Whether the frontend is mid-recording. While true, blur must NOT auto-hide the orb,
/// otherwise clicking the mic / talking would dismiss the widget mid-ramble.
#[derive(Default)]
struct RecordingState(Mutex<bool>);

/// Holds the spawned Node sidecar so it can be killed on exit (no orphaned servers).
#[derive(Default)]
struct Sidecar(Mutex<Option<CommandChild>>);

/// The port the sidecar is listening on, so the frontend can reach /api/* (the page
/// itself is served from tauri://, a different origin). 0 = same origin (dev/browser).
#[derive(Default)]
struct ApiPort(Mutex<u16>);

/// The currently-registered global "summon" hotkey. Tracked so we can unregister it
/// before swapping in a user-chosen combo — otherwise the handlers would stack.
#[derive(Default)]
struct CurrentShortcut(Mutex<Option<Shortcut>>);

/// The orb's screen centre (physical px). The widget is one window that morphs across
/// orb/capture/panel sizes; we capture this when leaving the orb and restore it when
/// returning, so the orb never drifts after recording or after the panel closes
/// (the panel may be clamped on-screen, but the orb goes back exactly where it was).
#[derive(Default)]
struct WidgetAnchor(Mutex<Option<(i32, i32)>>);

/// True while the user is dragging the panel by its title bar. Windows blurs the window
/// during the OS move loop, which would otherwise trip the blur-to-collapse behaviour and
/// snap the panel shut mid-drag. The frontend sets this on drag-start; it clears on the
/// focus the window regains when the drag ends.
#[derive(Default)]
struct Dragging(Mutex<bool>);

/// Set by the frontend when a title-bar drag starts/ends (see [`Dragging`]).
#[tauri::command]
fn set_dragging(state: tauri::State<Dragging>, dragging: bool) {
    if let Ok(mut g) = state.0.lock() {
        *g = dragging;
    }
}

#[tauri::command]
fn get_api_port(state: tauri::State<ApiPort>) -> u16 {
    state.0.lock().map(|g| *g).unwrap_or(0)
}

/// Frontend calls this when recording starts/stops so the shell knows whether it's safe
/// to auto-hide on blur. See ADR-0002 (same frontend in browser + webview).
#[tauri::command]
fn set_recording(state: tauri::State<RecordingState>, recording: bool) {
    if let Ok(mut guard) = state.0.lock() {
        *guard = recording;
    }
}

/// Re-register the global "summon" hotkey from a user-chosen combo. The frontend sends the
/// modifier flags plus a W3C key code (e.g. "Space", "KeyR", "F8") and enforces the
/// one-key-or-(one-modifier + key) rule before calling. Returns an error string the UI shows.
#[tauri::command]
fn set_global_shortcut(
    app: AppHandle,
    state: tauri::State<CurrentShortcut>,
    ctrl: bool,
    shift: bool,
    alt: bool,
    meta: bool,
    code: String,
) -> Result<(), String> {
    use std::str::FromStr;

    let mut mods = Modifiers::empty();
    if ctrl {
        mods |= Modifiers::CONTROL;
    }
    if shift {
        mods |= Modifiers::SHIFT;
    }
    if alt {
        mods |= Modifiers::ALT;
    }
    if meta {
        mods |= Modifiers::SUPER;
    }

    let key = Code::from_str(&code).map_err(|_| format!("Unsupported key: {code}"))?;
    let shortcut = Shortcut::new((!mods.is_empty()).then_some(mods), key);

    let gs = app.global_shortcut();
    // Drop the previously-registered hotkey first so handlers don't stack.
    if let Ok(mut guard) = state.0.lock() {
        if let Some(prev) = guard.take() {
            let _ = gs.unregister(prev);
        }
    }
    gs.on_shortcut(shortcut, |app, _shortcut, event| {
        if event.state() == ShortcutState::Pressed {
            summon(app);
        }
    })
    .map_err(|e| e.to_string())?;
    if let Ok(mut guard) = state.0.lock() {
        *guard = Some(shortcut);
    }
    Ok(())
}

/// Show a native OS notification. Called by the frontend when a reminder fires, so the
/// user is alerted even while the widget is collapsed to the orb or minimized to tray.
#[tauri::command]
fn notify(app: AppHandle, title: String, body: String) {
    let _ = app
        .notification()
        .builder()
        .title(title)
        .body(body)
        .show();
}

const MARGIN: i32 = 24;
const TASKBAR_ALLOWANCE: f64 = 48.0;

// The widget is ONE window that morphs across three sizes. The RESTING ORB lives in a
// corner (out of the way — a centred always-on-top orb covers whatever you're looking at).
// The capture window grows around the orb in place; the PANEL opens centred on screen.
// The orb visual is 88px; the orb window is larger so its glow fades inside transparent
// space instead of being clipped. See ADR-0005.
const ORB_SIZE: f64 = 140.0; // resting orb (+ grip/chevron + glow room)
const CAP_W: f64 = 340.0; // recording: the bubble floats above the orb
const CAP_H: f64 = 360.0;
const PANEL_W: f64 = 400.0; // full task-list panel
const PANEL_H: f64 = 600.0;

/// Resize the widget between `orb` / `capture` / `panel`.
/// - `orb`: return to the orb's stored resting spot (its corner, or wherever it was dragged).
/// - `capture`: grow around the orb in place (bubble above it) — the orb does not move.
/// - `panel`: open centred on screen, clamped to fit. The orb's resting spot is preserved so
///   closing the panel returns the orb to its corner.
#[tauri::command]
fn set_widget_mode(window: WebviewWindow, anchor: tauri::State<WidgetAnchor>, mode: String) {
    let (w, h) = match mode.as_str() {
        "panel" => (PANEL_W, PANEL_H),
        "capture" => (CAP_W, CAP_H),
        _ => (ORB_SIZE, ORB_SIZE),
    };
    // Current window centre (physical px) — where the orb sits right now.
    let cur = window.outer_position().ok().and_then(|p| {
        window
            .outer_size()
            .ok()
            .map(|s| (p.x + s.width as i32 / 2, p.y + s.height as i32 / 2))
    });
    // Leaving the orb: remember where it lives so we can restore it on collapse.
    if mode != "orb" {
        if let (Ok(mut g), Some(c)) = (anchor.0.lock(), cur) {
            *g = Some(c);
        }
    }

    let _ = window.set_size(LogicalSize::new(w, h));
    let Ok(size) = window.outer_size() else { return };
    let x;
    let y;

    if mode == "panel" {
        // Centre the panel on the monitor (independent of the orb's corner).
        if let Ok(Some(mon)) = window.current_monitor() {
            let scr = mon.size();
            x = (scr.width as i32 - size.width as i32) / 2;
            y = (scr.height as i32 - size.height as i32) / 2;
        } else {
            return;
        }
    } else {
        // orb / capture: grow or shrink around the orb's resting centre (no clamp, so the
        // orb stays exactly put even near a screen edge).
        let (cx, cy) = if mode == "orb" {
            anchor.0.lock().ok().and_then(|g| *g).or(cur)
        } else {
            cur
        }
        .unwrap_or((0, 0));
        x = cx - size.width as i32 / 2;
        y = cy - size.height as i32 / 2;
    }
    let _ = window.set_position(PhysicalPosition::new(x.max(0), y.max(0)));
}

/// Park the resting orb in the bottom-right corner, above the taskbar (initial placement).
fn position_orb_default(window: &WebviewWindow) {
    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let screen = monitor.size();
    let scale = monitor.scale_factor();
    let margin = (MARGIN as f64 * scale) as i32;
    let taskbar = (TASKBAR_ALLOWANCE * scale) as i32;
    let x = screen.width as i32 - size.width as i32 - margin;
    let y = screen.height as i32 - size.height as i32 - margin - taskbar;
    let _ = window.set_position(PhysicalPosition::new(x.max(0), y.max(0)));
}

fn show_and_record(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        // Show where the user left it (don't reposition); launch centring happens once at setup.
        let _ = window.set_focus();
        // Hotkey = "show + start recording" (locked decision). Frontend listens.
        let _ = window.emit("ramble:hotkey", ());
    }
}

/// Bring the widget forward and expand it (the frontend handles the expand + record).
fn summon(app: &AppHandle) {
    show_and_record(app);
}

/// Pick a free TCP port (bind to :0, read the assigned port, release it).
fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|l| l.local_addr().ok())
        .map(|a| a.port())
        .unwrap_or(5179)
}

/// Strip Windows' `\\?\` verbatim prefix. Tauri's resource_dir() returns one, and Node's
/// main-module resolver chokes on it (EISDIR lstat 'C:'). Express dislikes it too.
fn plain_path(p: &Path) -> String {
    let s = p.to_string_lossy().to_string();
    s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s)
}

/// Find a file by name anywhere under `root` (bounded depth). Used to locate the bundled
/// `server.cjs` / `index.html` regardless of exactly where Tauri placed the resources.
fn find_file(root: &Path, name: &str, max_depth: usize) -> Option<PathBuf> {
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if depth < max_depth {
                    stack.push((path, depth + 1));
                }
            } else if path.file_name().and_then(|n| n.to_str()) == Some(name) {
                return Some(path);
            }
        }
    }
    None
}

/// Spawn the bundled Node sidecar (the unchanged Express server) and, once it's
/// listening, point the webview at it. Production only — in dev the webview uses
/// `devUrl` and `beforeDevCommand` runs the server. See ADR-0002.
fn start_backend(app: &AppHandle) {
    let port = free_port();
    if let Some(state) = app.try_state::<ApiPort>() {
        if let Ok(mut guard) = state.0.lock() {
            *guard = port;
        }
    }

    let data_dir = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    let _ = std::fs::create_dir_all(&data_dir);

    let resource_dir = app
        .path()
        .resource_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    log::info!("resource_dir = {}", resource_dir.display());
    if let Ok(entries) = std::fs::read_dir(&resource_dir) {
        for e in entries.flatten() {
            log::info!("  resource entry: {}", e.path().display());
        }
    }

    // Tauri's exact resource layout for `../` mappings is fiddly — locate the bundled
    // files by searching, so it works wherever they actually landed.
    let server_js = find_file(&resource_dir, "server.cjs", 5)
        .unwrap_or_else(|| resource_dir.join("server.cjs"));
    let public_dir = find_file(&resource_dir, "index.html", 5)
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| resource_dir.join("public"));

    log::info!("server_js = {} (exists: {})", server_js.display(), server_js.exists());
    log::info!("public_dir = {} (exists: {})", public_dir.display(), public_dir.exists());
    log::info!("data_dir = {}", data_dir.display());
    log::info!("sidecar port = {port}");

    let sidecar = match app.shell().sidecar("ramble-server") {
        Ok(cmd) => cmd
            .args([plain_path(&server_js)])
            .env("PORT", port.to_string())
            .env("RAMBLE_DATA_DIR", plain_path(&data_dir))
            .env("RAMBLE_PUBLIC_DIR", plain_path(&public_dir)),
        Err(e) => {
            log::error!("failed to resolve sidecar: {e}");
            return;
        }
    };

    match sidecar.spawn() {
        Ok((mut rx, child)) => {
            if let Some(state) = app.try_state::<Sidecar>() {
                *state.0.lock().unwrap() = Some(child);
            }
            // Drain sidecar output so its stdout/stderr buffer never blocks it.
            tauri::async_runtime::spawn(async move {
                use tauri_plugin_shell::process::CommandEvent;
                while let Some(event) = rx.recv().await {
                    if let CommandEvent::Stderr(line) | CommandEvent::Stdout(line) = event {
                        log::info!("[server] {}", String::from_utf8_lossy(&line).trim_end());
                    }
                }
            });
        }
        Err(e) => {
            log::error!("failed to spawn sidecar: {e}");
            return;
        }
    }

    // Log when the server is reachable (the frontend polls /api/health itself and is
    // served from tauri://, so we no longer navigate the webview to the sidecar).
    std::thread::spawn(move || {
        let mut connected = false;
        for _ in 0..120 {
            if TcpStream::connect(("127.0.0.1", port)).is_ok() {
                connected = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(150));
        }
        log::info!("backend reachable on 127.0.0.1:{port}: {connected}");
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .manage(RecordingState::default())
        .manage(Sidecar::default())
        .manage(ApiPort::default())
        .manage(CurrentShortcut::default())
        .manage(WidgetAnchor::default())
        .manage(Dragging::default())
        .invoke_handler(tauri::generate_handler![
            set_recording,
            set_widget_mode,
            set_dragging,
            get_api_port,
            set_global_shortcut,
            notify
        ])
        .setup(|app| {
            // Log in release too, to a file in the app log dir, so we can diagnose the
            // packaged build (the dev machine can't run it — Smart App Control).
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .target(tauri_plugin_log::Target::new(
                        tauri_plugin_log::TargetKind::LogDir {
                            file_name: Some("ramble".into()),
                        },
                    ))
                    .build(),
            )?;

            // ---- Tray icon + menu ----
            let show_i = MenuItem::with_id(app, "show", "Show Ramble", true, None::<&str>)?;
            let hide_i = MenuItem::with_id(app, "hide", "Hide widget", true, None::<&str>)?;
            let settings_i = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &hide_i, &settings_i, &quit_i])?;

            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Ramble — say it, I'll sort it")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => summon(app),
                    "hide" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.hide();
                        }
                    }
                    "settings" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                            let _ = w.emit("ramble:open-settings", ());
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        summon(tray.app_handle());
                    }
                })
                .build(app)?;

            // ---- Global hotkey: default Ctrl+Shift+Space -> show + record ----
            // The frontend re-registers this from the user's stored choice on boot via the
            // set_global_shortcut command; we seed CurrentShortcut so that swap can unregister
            // this one cleanly.
            let hotkey = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space);
            app.global_shortcut()
                .on_shortcut(hotkey, move |app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        summon(app);
                    }
                })?;
            if let Ok(mut guard) = app.state::<CurrentShortcut>().0.lock() {
                *guard = Some(hotkey);
            }

            // ---- Backend: in production, spawn the bundled Node sidecar ----
            if !cfg!(debug_assertions) {
                start_backend(app.handle());
            }

            // ---- Initial placement: park the orb bottom-right, out of the way (ADR-0005) ----
            if let Some(window) = app.get_webview_window("main") {
                position_orb_default(&window);
            }

            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Collapse the panel back to the orb on blur — but NOT while recording, and NOT
            // while dragging the title bar (Windows blurs during the OS move loop).
            WindowEvent::Focused(false) => {
                let app = window.app_handle();
                let recording = app
                    .state::<RecordingState>()
                    .0
                    .lock()
                    .map(|g| *g)
                    .unwrap_or(false);
                let dragging = app
                    .try_state::<Dragging>()
                    .map(|s| s.0.lock().map(|g| *g).unwrap_or(false))
                    .unwrap_or(false);
                if !recording && !dragging {
                    let _ = window.emit("ramble:collapse", ());
                }
            }
            // Drag ended → the window regains focus; clear the drag guard.
            WindowEvent::Focused(true) => {
                if let Some(s) = window.app_handle().try_state::<Dragging>() {
                    if let Ok(mut g) = s.0.lock() {
                        *g = false;
                    }
                }
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Kill the Node sidecar when the app exits — no orphaned servers.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app.try_state::<Sidecar>() {
                    if let Some(child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
