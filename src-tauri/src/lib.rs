use std::sync::Mutex;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, WebviewWindow, WindowEvent,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// Whether the frontend is mid-recording. While true, blur must NOT auto-hide the orb,
/// otherwise clicking the mic / talking would dismiss the widget mid-ramble.
#[derive(Default)]
struct RecordingState(Mutex<bool>);

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

fn toggle(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            show_and_record(app);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(RecordingState::default())
        .invoke_handler(tauri::generate_handler![set_recording])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // ---- Tray icon + menu ----
            let show_i = MenuItem::with_id(app, "show", "Show Ramble", true, None::<&str>)?;
            let settings_i = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &settings_i, &quit_i])?;

            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Ramble — say it, I'll sort it")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_and_record(app),
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
                        toggle(tray.app_handle());
                    }
                })
                .build(app)?;

            // ---- Global hotkey: Ctrl+Shift+Space -> show + record ----
            let hotkey = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space);
            app.global_shortcut()
                .on_shortcut(hotkey, move |app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle(app);
                    }
                })?;

            // ---- Initial placement ----
            if let Some(window) = app.get_webview_window("main") {
                position_bottom_right(&window);
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // Auto-hide on blur, but stay pinned while recording.
            if let WindowEvent::Focused(false) = event {
                let recording = window
                    .app_handle()
                    .state::<RecordingState>()
                    .0
                    .lock()
                    .map(|g| *g)
                    .unwrap_or(false);
                if !recording {
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
