//! The native dialog for a project image outside the project. The shell only shows
//! it and hands the chosen path back; the service decides what the file may become
//! and copies it into its own data directory.

use std::path::Path;

use serde_json::{Value, json};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

/// The extensions the service accepts for a project image.
pub const IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "icns", "svg", "heic", "heif",
    "tif", "tiff",
];

/// The answer line for one request: the path, or `null` when the dialog was cancelled.
pub fn chosen_line(request_id: &str, path: Option<&Path>) -> Value {
    json!({
        "type": "project_image_chosen",
        "request_id": request_id,
        "path": path.map(|path| path.to_string_lossy().into_owned()),
    })
}

/// Opens the dialog without blocking the event loop; the answer goes to the service.
pub fn choose(app: &AppHandle, request_id: String) {
    let reply = app.clone();
    app.dialog()
        .file()
        .set_title("Choose a project icon")
        .add_filter("Images", IMAGE_EXTENSIONS)
        .pick_file(move |file| {
            let path = file.and_then(|file| file.into_path().ok());
            crate::tell_core(&reply, chosen_line(&request_id, path.as_deref()));
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_answer_carries_only_the_request_and_the_path() {
        let path = std::env::temp_dir().join("logo.png");
        assert_eq!(
            chosen_line("r1", Some(&path)),
            json!({ "type": "project_image_chosen", "request_id": "r1", "path": path.to_string_lossy() })
        );
        assert_eq!(
            chosen_line("r2", None),
            json!({ "type": "project_image_chosen", "request_id": "r2", "path": null })
        );
    }

    #[test]
    fn the_filter_offers_the_service_image_kinds() {
        for extension in ["png", "svg", "icns", "jpeg", "tiff"] {
            assert!(IMAGE_EXTENSIONS.contains(&extension));
        }
        assert!(!IMAGE_EXTENSIONS.contains(&"exe"));
    }

    #[test]
    fn the_service_request_is_read() {
        let message: crate::core_process::ServiceMessage =
            serde_json::from_value(json!({ "type": "choose_project_image", "request_id": "r3" }))
                .unwrap();
        assert!(
            matches!(message, crate::core_process::ServiceMessage::ChooseProjectImage { request_id } if request_id == "r3")
        );
    }
}
