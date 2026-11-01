use std::fmt::Write;

use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::{Context, Layer};

/// Hands each warning to the service's diagnostics, fields and all.
pub struct RecentEvents;

#[derive(Default)]
struct Text(String);

impl Visit for Text {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        let gap = if self.0.is_empty() { "" } else { " " };
        let _ = if field.name() == "message" {
            write!(self.0, "{gap}{value:?}")
        } else {
            write!(self.0, "{gap}{}={value:?}", field.name())
        };
    }
}

impl<S: Subscriber> Layer<S> for RecentEvents {
    fn on_event(&self, event: &Event<'_>, _: Context<'_, S>) {
        let mut text = Text::default();
        event.record(&mut text);
        let meta = event.metadata();
        orbyn_core::diagnostics::note_event(meta.level().as_str(), meta.target(), text.0);
    }
}
