//! What the shell remembers itself. The window's size and place are the window state
//! plugin's; this holds the zoom, which that plugin doesn't keep.

use crate::menu::Zoom;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Default, Deserialize, Serialize)]
struct Saved {
    zoom: Option<f64>,
}

fn path(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_config_dir().ok()?.join("shell-state.json"))
}

/// A missing or damaged file is the same as a first launch.
pub fn load(app: &AppHandle) {
    let saved = path(app)
        .and_then(|path| std::fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice::<Saved>(&bytes).ok())
        .unwrap_or_default();
    *app.state::<Zoom>().0.lock().expect("zoom") = saved.zoom.unwrap_or(1.0);
}

pub fn save(app: &AppHandle) {
    let zoom = *app.state::<Zoom>().0.lock().expect("zoom");
    let Some(path) = path(app) else { return };
    if let Some(folder) = path.parent() {
        let _ = std::fs::create_dir_all(folder);
    }
    if let Ok(bytes) = serde_json::to_vec(&Saved { zoom: Some(zoom) }) {
        let _ = std::fs::write(path, bytes);
    }
}
