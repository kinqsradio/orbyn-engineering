//! The parts of the app that live outside it: the `orbyn` command on the person's
//! machine, and macOS privacy permissions. Nothing here runs unless asked, except
//! reading state, which never prompts.

use crate::core_process::ShellAction;
use serde_json::json;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const CLI_LINK_MARK: &str = "rem Orbyn Engineering command";

/// Where the command goes, in a folder the person owns so no prompt is needed.
fn cli_path(home: &Path, local_data: &Path) -> PathBuf {
    if cfg!(windows) {
        local_data.join("Orbyn").join("bin").join("orbyn.cmd")
    } else {
        home.join(".local").join("bin").join("orbyn")
    }
}

/// The command this copy of the app carries.
fn bundled_cli() -> Option<PathBuf> {
    let name = if cfg!(windows) { "orbyn.exe" } else { "orbyn" };
    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.join(name))
}

fn windows_shim(target: &Path) -> String {
    format!(
        "@echo off\r\n{CLI_LINK_MARK}\r\n\"{}\" %*\r\n",
        target.display()
    )
}

/// True for something this app put there, whichever copy of the app did.
fn is_ours(path: &Path) -> bool {
    if cfg!(windows) {
        return std::fs::read_to_string(path).is_ok_and(|text| text.contains(CLI_LINK_MARK));
    }
    std::fs::read_link(path).is_ok_and(|target| {
        target.file_name().is_some_and(|name| name == "orbyn")
            && target
                .parent()
                .is_some_and(|dir| dir.ends_with("Contents/MacOS"))
    })
}

/// Puts the command in place. Refuses to replace anything it didn't make.
fn install_cli(path: &Path, target: &Path) -> Result<(), String> {
    let describe = |error: std::io::Error| format!("Couldn't install the command: {error}.");
    if std::fs::symlink_metadata(path).is_ok() {
        if !is_ours(path) {
            return Err(format!(
                "{} already exists, so it was left alone.",
                path.display()
            ));
        }
        std::fs::remove_file(path).map_err(describe)?;
    }
    if let Some(folder) = path.parent() {
        std::fs::create_dir_all(folder).map_err(describe)?;
    }
    #[cfg(windows)]
    return std::fs::write(path, windows_shim(target)).map_err(describe);
    #[cfg(unix)]
    return std::os::unix::fs::symlink(target, path).map_err(describe);
}

fn remove_cli(path: &Path) -> Result<(), String> {
    if !is_ours(path) {
        return Err(format!(
            "{} isn't this app's, so it was left alone.",
            path.display()
        ));
    }
    std::fs::remove_file(path).map_err(|error| format!("Couldn't remove the command: {error}."))
}

fn locations(app: &AppHandle) -> Option<PathBuf> {
    let paths = app.path();
    Some(cli_path(
        &paths.home_dir().ok()?,
        &paths.local_data_dir().ok()?,
    ))
}

#[cfg(target_os = "macos")]
mod permissions {
    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn CGPreflightScreenCaptureAccess() -> bool;
    }

    /// Reads without prompting.
    pub fn read() -> serde_json::Value {
        // SAFETY: both take nothing and return a flag.
        let (accessibility, screen) =
            unsafe { (AXIsProcessTrusted(), CGPreflightScreenCaptureAccess()) };
        serde_json::json!([
            { "id": "accessibility", "granted": accessibility },
            { "id": "screen_recording", "granted": screen },
        ])
    }

    pub const ACCESSIBILITY: &str =
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
    pub const SCREEN: &str =
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
}

/// Tells the service what it can't see for itself.
pub fn report(app: &AppHandle) {
    let cli = locations(app).map(|path| json!({ "installed": is_ours(&path), "path": path }));
    #[cfg(target_os = "macos")]
    let permissions = permissions::read();
    #[cfg(not(target_os = "macos"))]
    let permissions = json!([]);
    crate::tell_core(
        app,
        json!({ "type": "shell_facts", "cli": cli, "permissions": permissions }),
    );
}

fn run_cli_action(app: &AppHandle, action: ShellAction) -> Result<(), String> {
    let path = locations(app).ok_or("Couldn't find your home folder.")?;
    if action == ShellAction::RemoveCli {
        return remove_cli(&path);
    }
    let target = bundled_cli().ok_or("Couldn't find the command in this app.")?;
    install_cli(&path, &target)
}

pub fn on_action(app: &AppHandle, action: ShellAction) {
    match action {
        ShellAction::InstallCli | ShellAction::RemoveCli => {
            if let Err(message) = run_cli_action(app, action) {
                crate::tell_core(app, json!({ "type": "shell_failed", "message": message }));
            }
            report(app);
        }
        #[cfg(target_os = "macos")]
        ShellAction::OpenAccessibilitySettings | ShellAction::OpenScreenRecordingSettings => {
            use tauri_plugin_opener::OpenerExt;
            let pane = if action == ShellAction::OpenAccessibilitySettings {
                permissions::ACCESSIBILITY
            } else {
                permissions::SCREEN
            };
            let _ = app.opener().open_url(pane, None::<&str>);
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Folder(PathBuf);

    impl Folder {
        fn new(name: &str) -> Self {
            let path =
                std::env::temp_dir().join(format!("orbyn-shell-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn target(root: &Path) -> PathBuf {
        let name = if cfg!(windows) { "orbyn.exe" } else { "orbyn" };
        root.join("App.app/Contents/MacOS").join(name)
    }

    #[test]
    fn the_command_installs_moves_with_the_app_and_comes_out() {
        let folder = Folder::new("install");
        let path = cli_path(&folder.0, &folder.0);
        install_cli(&path, &target(&folder.0)).unwrap();
        assert!(is_ours(&path));
        install_cli(&path, &target(&folder.0.join("moved"))).unwrap();
        assert!(is_ours(&path));
        remove_cli(&path).unwrap();
        assert!(std::fs::symlink_metadata(&path).is_err());
    }

    #[test]
    fn something_else_at_that_path_is_left_alone() {
        let folder = Folder::new("refuse");
        let path = cli_path(&folder.0, &folder.0);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "mine").unwrap();
        assert!(install_cli(&path, &target(&folder.0)).is_err());
        assert!(remove_cli(&path).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "mine");
    }
}
