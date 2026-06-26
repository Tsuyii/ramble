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

const MARGIN: i32 = 24;
const TASKBAR_ALLOWANCE: f64 = 48.0;

// Orb (collapsed) vs panel (expanded) window sizes.
const ORB_SIZE: f64 = 104.0;
const PANEL_W: f64 = 400.0;
const PANEL_H: f64 = 600.0;

/// Resize between the small orb and the full panel, keeping it pinned bottom-right.
/// Called by the frontend when it switches modes.
#[tauri::command]
fn set_expanded(window: WebviewWindow, expanded: bool) {
    let size = if expanded {
        LogicalSize::new(PANEL_W, PANEL_H)
    } else {
        LogicalSize::new(ORB_SIZE, ORB_SIZE)
    };
    let _ = window.set_size(size);
    position_bottom_right(&window);
}

/// Pin the widget to the bottom-right of the current monitor, above the taskbar.
fn position_bottom_right(window: &WebviewWindow) {
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
        position_bottom_right(&window);
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
        .manage(RecordingState::default())
        .manage(Sidecar::default())
        .manage(ApiPort::default())
        .invoke_handler(tauri::generate_handler![
            set_recording,
            set_expanded,
            get_api_port
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

            // ---- Global hotkey: Ctrl+Shift+Space -> show + record ----
            let hotkey = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space);
            app.global_shortcut()
                .on_shortcut(hotkey, move |app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        summon(app);
                    }
                })?;

            // ---- Backend: in production, spawn the bundled Node sidecar ----
            if !cfg!(debug_assertions) {
                start_backend(app.handle());
            }

            // ---- Initial placement ----
            if let Some(window) = app.get_webview_window("main") {
                position_bottom_right(&window);
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // Collapse the panel back to the orb on blur, but stay expanded while recording.
            if let WindowEvent::Focused(false) = event {
                let recording = window
                    .app_handle()
                    .state::<RecordingState>()
                    .0
                    .lock()
                    .map(|g| *g)
                    .unwrap_or(false);
                if !recording {
                    let _ = window.emit("ramble:collapse", ());
                }
            }
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
