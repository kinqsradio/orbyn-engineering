//! The native menu bar. Items that act on the window are handled here; the rest go
//! to the service as commands, the same ones the app's keys run. `Cmd+W`, `Cmd+N` and
//! the like belong to the page, which has its own rules for them, so no item takes them.

use crate::core_process::ShellAction;
use crate::window_actions::{self, Target, ViewerZoom};
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
pub struct Zoom(pub Mutex<f64>, pub Mutex<ViewerZoom>);

pub fn next_zoom(current: f64, step: f64) -> f64 {
    let value = (current + step).clamp(ZOOM_MIN, ZOOM_MAX);
    (value * 100.0).round() / 100.0
}

fn focused_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false))
}

fn set_zoom(app: &AppHandle, window: &WebviewWindow, value: f64) {
    let _ = window.set_zoom(value);
    if window.label() == "main" {
        *app.state::<Zoom>().0.lock().expect("zoom") = value;
        crate::shell_state::save(app);
    } else {
        app.state::<Zoom>()
            .1
            .lock()
            .expect("viewer zoom")
            .set(window.label(), value);
    }
}

fn step_zoom(app: &AppHandle, window: &WebviewWindow, step: f64) {
    let current = if window.label() == "main" {
        *app.state::<Zoom>().0.lock().expect("zoom")
    } else {
        app.state::<Zoom>()
            .1
            .lock()
            .expect("viewer zoom")
            .get(window.label())
    };
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

/// A window asking for what its keys can't reach through the menu, like the keypad.
pub fn on_action(app: &AppHandle, action: ShellAction) {
    match action {
        ShellAction::ZoomIn | ShellAction::ZoomOut | ShellAction::ZoomReset => {
            let Some(window) = focused_window(app) else {
                return;
            };
            match action {
                ShellAction::ZoomIn => step_zoom(app, &window, ZOOM_STEP),
                ShellAction::ZoomOut => step_zoom(app, &window, -ZOOM_STEP),
                _ => set_zoom(app, &window, 1.0),
            }
        }
        ShellAction::InstallCli
        | ShellAction::RemoveCli
        | ShellAction::OpenAccessibilitySettings
        | ShellAction::OpenScreenRecordingSettings => crate::system::on_action(app, action),
        ShellAction::Quit => app.exit(0),
        ShellAction::RestartService => crate::restart_service(app),
        ShellAction::ShowLog => crate::show_service_log(app),
    }
}

/// The app menu's Quit item, whose `Cmd+Q` follows the quit confirmation setting.
#[derive(Default)]
pub struct QuitItem(pub Mutex<Option<MenuItem<tauri::Wry>>>);

pub fn set_quit_confirmation(app: &AppHandle, mode: crate::core_process::QuitConfirmation) {
    if let Some(item) = app
        .state::<QuitItem>()
        .0
        .lock()
        .expect("quit item")
        .as_ref()
    {
        let _ = item.set_accelerator(mode.accelerator());
    }
}

pub fn on_event(app: &AppHandle, event: MenuEvent) {
    let id = event.id().as_ref();
    if id == "quit" {
        app.exit(0);
        return;
    }
    let focused = focused_window(app);
    let window = match window_actions::target(id, focused.as_ref().map(|window| window.label())) {
        Target::MainCommand(command) => {
            crate::reveal(app);
            crate::tell_core(
                app,
                serde_json::json!({ "type": "menu_command", "command": command }),
            );
            return;
        }
        Target::Window(_) => {
            let Some(window) = focused else { return };
            window
        }
        Target::Responder => {
            #[cfg(target_os = "macos")]
            speech(id == "speech-start");
            return;
        }
        Target::None => return,
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
    // Its own item rather than the predefined one, so `Cmd+Q` can move to the page.
    let quit = item(app, "quit", "Quit Orbyn Engineering", Some("Cmd+Q"))?;
    if let Some(slot) = app.try_state::<QuitItem>() {
        *slot.0.lock().expect("quit item") = Some(quit.clone());
    }
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
        .item(&quit)
        .build()
}

fn file_submenu(app: &AppHandle) -> tauri::Result<Submenu<tauri::Wry>> {
    let mut menu =
        SubmenuBuilder::new(app, "File").item(&item(app, "new-thread", "New Thread", None)?);
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
        .item(&item(
            app,
            "paste-text",
            "Paste as Text",
            Some("CmdOrCtrl+Shift+V"),
        )?)
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
        .item(&item(
            app,
            "force-reload",
            "Force Reload",
            Some("CmdOrCtrl+Shift+R"),
        )?)
        .item(&item(
            app,
            "devtools",
            "Toggle Developer Tools",
            Some(devtools),
        )?)
        .separator()
        .item(&item(
            app,
            "zoom-reset",
            "Actual Size",
            Some("CmdOrCtrl+0"),
        )?)
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
}
