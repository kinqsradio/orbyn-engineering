//! Native menu ownership, independent of the platform event loop.

#[derive(Debug, PartialEq)]
pub enum Target<'a> {
    MainCommand(&'static str),
    Window(&'a str),
    Responder,
    None,
}

pub fn target<'a>(id: &str, focused: Option<&'a str>) -> Target<'a> {
    match id {
        "settings" => Target::MainCommand("settings.open"),
        "new-thread" => Target::MainCommand("chat.new"),
        "check-updates" => Target::MainCommand("updates.check"),
        "toggle-sidebar" => Target::MainCommand("sidebar.toggle"),
        "palette" => Target::MainCommand("commandPalette.toggle"),
        "speech-start" | "speech-stop" => Target::Responder,
        "reload" | "force-reload" | "devtools" | "zoom-in" | "zoom-out" | "zoom-reset"
        | "paste-text" | "close-window" => focused.map_or(Target::None, Target::Window),
        _ => Target::None,
    }
}

/// The main window stays alive for the tray and service; viewers close normally.
pub fn hide_on_close(label: &str) -> bool {
    label == "main"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_actions_never_fall_back_to_an_unfocused_main() {
        for action in [
            "close-window",
            "reload",
            "force-reload",
            "devtools",
            "zoom-in",
            "zoom-out",
            "zoom-reset",
            "paste-text",
        ] {
            assert_eq!(
                target(action, Some("preview-61-62")),
                Target::Window("preview-61-62")
            );
            assert_eq!(target(action, Some("main")), Target::Window("main"));
            assert_eq!(target(action, None), Target::None);
        }
    }

    #[test]
    fn global_commands_belong_to_main_even_with_a_viewer_or_no_focus() {
        for focused in [Some("preview-61-62"), Some("main"), None] {
            for (id, command) in [
                ("settings", "settings.open"),
                ("new-thread", "chat.new"),
                ("check-updates", "updates.check"),
                ("toggle-sidebar", "sidebar.toggle"),
                ("palette", "commandPalette.toggle"),
            ] {
                assert_eq!(target(id, focused), Target::MainCommand(command));
            }
            assert_eq!(target("speech-start", focused), Target::Responder);
            assert_eq!(target("unknown", focused), Target::None);
        }
    }

    #[test]
    fn closing_a_viewer_does_not_take_the_main_hide_policy() {
        assert!(hide_on_close("main"));
        assert!(!hide_on_close("preview-61-62"));
    }
}

/// Only the main window persists zoom. Viewer state ends when that viewer closes.
#[derive(Default)]
pub struct ViewerZoom(std::collections::HashMap<String, f64>);

impl ViewerZoom {
    pub fn get(&self, label: &str) -> f64 {
        self.0.get(label).copied().unwrap_or(1.0)
    }

    pub fn set(&mut self, label: &str, value: f64) {
        self.0.insert(label.to_owned(), value);
    }

    pub fn forget(&mut self, label: &str) {
        self.0.remove(label);
    }
}

#[cfg(test)]
mod zoom_tests {
    use super::*;

    #[test]
    fn viewers_have_independent_transient_zoom() {
        let mut zoom = ViewerZoom::default();
        zoom.set("preview-a", 1.2);
        assert_eq!(zoom.get("preview-a"), 1.2);
        assert_eq!(zoom.get("preview-b"), 1.0);
        zoom.forget("preview-a");
        assert_eq!(zoom.get("preview-a"), 1.0);
    }
}
