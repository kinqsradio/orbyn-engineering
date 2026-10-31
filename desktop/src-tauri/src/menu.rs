//! The native menu bar. Items that act on the window are handled here; the rest go
//! to the service as commands, the same ones the app's keys run. `Cmd+W`, `Cmd+N` and
//! the like belong to the page, which has its own rules for them, so no item takes them.

use std::sync::Mutex;
use tauri::menu::{
    AboutMetadata, Menu, MenuBuilder, MenuEvent, MenuItem, PredefinedMenuItem, Submenu,
    SubmenuBuilder,
};
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

const ZOOM_MIN: f64 = 0.5;
const ZOOM_MAX: f64 = 3.0;
const ZOOM_STEP: f64 = 0.1;

/// The window's zoom, kept with its size and place.
#[derive(Default)]
pub struct Zoom(pub Mutex<f64>);

pub fn next_zoom(current: f64, step: f64) -> f64 {
    let value = (current + step).clamp(ZOOM_MIN, ZOOM_MAX);
    (value * 100.0).round() / 100.0
}

/// A command for the windows, or `None` for an item handled here.
fn page_command(id: &str) -> Option<&'static str> {
    match id {
        "settings" => Some("settings.open"),
        "new-thread" => Some("chat.new"),
        "check-updates" => Some("updates.check"),
        "toggle-sidebar" => Some("sidebar.toggle"),
        "palette" => Some("commandPalette.toggle"),
        _ => None,
    }
}

fn set_zoom(app: &AppHandle, window: &WebviewWindow, value: f64) {
    let _ = window.set_zoom(value);
    *app.state::<Zoom>().0.lock().expect("zoom") = value;
    crate::shell_state::save(app);
}

fn step_zoom(app: &AppHandle, window: &WebviewWindow, step: f64) {
    let current = *app.state::<Zoom>().0.lock().expect("zoom");
    set_zoom(app, window, next_zoom(current, step));
}

/// Pastes the clipboard's text, so a page sees typing and no formatting comes along.
/// The text is encoded as a JSON string, which is a safe script literal.
fn paste_as_text(window: &WebviewWindow, text: Option<String>) {
    let Some(text) = text.and_then(|text| serde_json::to_string(&text).ok()) else {
        return;
    };
    let _ = window.eval(format!("document.execCommand('insertText', false, {text})"));
}

#[cfg(target_os = "macos")]
fn speech(start: bool) {
    use objc2::sel;
    use objc2_app_kit::NSApplication;
    use objc2_foundation::MainThreadMarker;
    // Menu events arrive on the main thread.
    let Some(main) = MainThreadMarker::new() else {
        return;
    };
    let app = NSApplication::sharedApplication(main);
    let action = if start {
        sel!(startSpeaking:)
    } else {
        sel!(stopSpeaking:)
    };
    // SAFETY: nil target and sender follow the responder chain, as a menu item does.
    unsafe { app.sendAction_to_from(action, None, None) };
}

pub fn on_event(app: &AppHandle, event: &MenuEvent) {
    let id = event.id().as_ref();
    if let Some(command) = page_command(id) {
        crate::reveal(app);
        crate::tell_core(
            app,
            serde_json::json!({ "type": "menu_command", "command": command }),
        );
        return;
    }
    let Some(window) = crate::main_window(app) else {
        return;
    };
    match id {
        "reload" => {
            let _ = window.eval("location.reload()");
        }
        "force-reload" => {
            let _ = window.reload();
        }
        "devtools" => {
            if window.is_devtools_open() {
                window.close_devtools();
            } else {
                window.open_devtools();
            }
        }
        "zoom-in" => step_zoom(app, &window, ZOOM_STEP),
        "zoom-out" => step_zoom(app, &window, -ZOOM_STEP),
        "zoom-reset" => set_zoom(app, &window, 1.0),
        "paste-text" => {
            use tauri_plugin_clipboard_manager::ClipboardExt;
            paste_as_text(&window, app.clipboard().read_text().ok());
        }
        "close-window" => {
            let _ = window.close();
        }
        #[cfg(target_os = "macos")]
        "speech-start" => speech(true),
        #[cfg(target_os = "macos")]
        "speech-stop" => speech(false),
        _ => {}
    }
}

fn item<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    label: &str,
    keys: Option<&str>,
) -> tauri::Result<MenuItem<R>> {
    MenuItem::with_id(app, id, label, true, keys)
}

#[cfg(target_os = "macos")]
fn app_submenu(app: &AppHandle) -> tauri::Result<Submenu<tauri::Wry>> {
    let about = AboutMetadata {
        name: Some(app.package_info().name.clone()),
        version: Some(app.package_info().version.to_string()),
        ..AboutMetadata::default()
    };
    SubmenuBuilder::new(app, "Orbyn Engineering")
        .about(Some(about))
        .item(&item(app, "check-updates", "Check for Updates...", None)?)
        .separator()
        .item(&item(app, "settings", "Settings...", Some("CmdOrCtrl+,"))?)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()
}

fn file_submenu(app: &AppHandle) -> tauri::Result<Submenu<tauri::Wry>> {
    let mut menu = SubmenuBuilder::new(app, "File").item(&item(app, "new-thread", "New Thread", None)?);
    if cfg!(not(target_os = "macos")) {
        menu = menu
            .item(&item(app, "settings", "Settings...", Some("CmdOrCtrl+,"))?)
            .item(&item(app, "check-updates", "Check for Updates...", None)?);
    }
    menu.separator()
        .item(&item(app, "close-window", "Close Window", None)?)
        .build()
}

fn edit_submenu(app: &AppHandle) -> tauri::Result<Submenu<tauri::Wry>> {
    let menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .item(&item(app, "paste-text", "Paste as Text", Some("CmdOrCtrl+Shift+V"))?)
        .separator()
        .select_all();
    #[cfg(target_os = "macos")]
    let menu = {
        let speech = SubmenuBuilder::new(app, "Speech")
            .item(&item(app, "speech-start", "Start Speaking", None)?)
            .item(&item(app, "speech-stop", "Stop Speaking", None)?)
            .build()?;
        menu.separator().item(&speech)
    };
    menu.build()
}

fn view_submenu(app: &AppHandle) -> tauri::Result<Submenu<tauri::Wry>> {
    let devtools = if cfg!(target_os = "macos") {
        "Alt+Cmd+I"
    } else {
        "Ctrl+Shift+I"
    };
    SubmenuBuilder::new(app, "View")
        .item(&item(app, "toggle-sidebar", "Toggle Sidebar", None)?)
        .item(&item(app, "palette", "Command Palette", None)?)
        .separator()
        .item(&item(app, "reload", "Reload", Some("CmdOrCtrl+R"))?)
        .item(&item(app, "force-reload", "Force Reload", Some("CmdOrCtrl+Shift+R"))?)
        .item(&item(app, "devtools", "Toggle Developer Tools", Some(devtools))?)
        .separator()
        .item(&item(app, "zoom-reset", "Actual Size", Some("CmdOrCtrl+0"))?)
        .item(&item(app, "zoom-in", "Zoom In", Some("CmdOrCtrl+="))?)
        .item(&item(app, "zoom-out", "Zoom Out", Some("CmdOrCtrl+-"))?)
        .separator()
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .build()
}

fn window_submenu(app: &AppHandle) -> tauri::Result<Submenu<tauri::Wry>> {
    SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .build()
}

pub fn build(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let builder = MenuBuilder::new(app);
    #[cfg(target_os = "macos")]
    let builder = builder.item(&app_submenu(app)?);
    let file = file_submenu(app)?;
    let edit = edit_submenu(app)?;
    let view = view_submenu(app)?;
    let window = window_submenu(app)?;
    builder.items(&[&file, &edit, &view, &window]).build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zoom_stays_in_range_and_keeps_round_steps() {
        assert_eq!(next_zoom(1.0, ZOOM_STEP), 1.1);
        assert_eq!(next_zoom(1.1, -ZOOM_STEP), 1.0);
        assert_eq!(next_zoom(3.0, ZOOM_STEP), ZOOM_MAX);
        assert_eq!(next_zoom(0.5, -ZOOM_STEP), ZOOM_MIN);
    }

    #[test]
    fn items_for_the_page_name_real_commands() {
        assert_eq!(page_command("new-thread"), Some("chat.new"));
        assert_eq!(page_command("settings"), Some("settings.open"));
        assert_eq!(page_command("reload"), None);
    }
}
