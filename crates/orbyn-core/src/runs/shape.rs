//! What a run's events look like on their way to the log. Text is merged so a fast
//! engine does not cost a transaction per word, and tool traffic is bounded so one
//! large file or a long build cannot fill the log. Full tool items stay in
//! `thread_items` for the inspector.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use orbyn_contracts::AgUiEvent;
use serde_json::{Value, json};
use tokio::time::Instant;

/// Merged text waits this long at most.
pub const FLUSH_AFTER: Duration = Duration::from_millis(33);
const FLUSH_BYTES: usize = 8 * 1024;
/// A tool's arguments in the log. Past this the JSON cannot be parsed, so this is set
/// above the usual call and not at a tidy preview size.
const MAX_ARGS_BYTES: usize = 16 * 1024;
const MAX_OUTPUT_BYTES: usize = 8 * 1024;
/// Tools in one run that keep their output in the log.
const MAX_SNAPSHOTS: usize = 64;
const CUT_NOTICE: &str = "\n[cut off here; the full output is in the raw item]";
const DROPPED_NOTICE: &str = "[output not kept: this run has had many tools]";

/// The longest prefix of `text` within `max` bytes, on a character boundary.
fn prefix(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

enum Pending {
    Text { id: String, text: String },
    Reasoning { id: String, text: String },
}

#[derive(Default)]
pub struct EventShaper {
    pending: Option<Pending>,
    due: Option<Instant>,
    args: HashMap<String, usize>,
    output: HashMap<String, usize>,
    snapshots: HashSet<String>,
}

impl EventShaper {
    /// When the merged text has to go out, if any is waiting.
    pub fn due(&self) -> Option<Instant> {
        self.due
    }

    /// Everything waiting, in order. Called ahead of anything that isn't text.
    pub fn flush(&mut self) -> Vec<AgUiEvent> {
        self.due = None;
        match self.pending.take() {
            Some(Pending::Text { id, text }) => vec![AgUiEvent::TextMessageContent {
                message_id: id,
                delta: text,
            }],
            Some(Pending::Reasoning { id, text }) => vec![AgUiEvent::ReasoningMessageContent {
                message_id: id,
                delta: text,
            }],
            None => Vec::new(),
        }
    }

    fn merge(&mut self, id: String, delta: String, reasoning: bool) -> Vec<AgUiEvent> {
        let same = match &mut self.pending {
            Some(Pending::Text { id: open, text }) if !reasoning && *open == id => Some(text),
            Some(Pending::Reasoning { id: open, text }) if reasoning && *open == id => Some(text),
            _ => None,
        };
        let mut ready = Vec::new();
        match same {
            Some(text) => text.push_str(&delta),
            None => {
                ready = self.flush();
                self.due = Some(Instant::now() + FLUSH_AFTER);
                self.pending = Some(if reasoning {
                    Pending::Reasoning { id, text: delta }
                } else {
                    Pending::Text { id, text: delta }
                });
            }
        }
        let size = match &self.pending {
            Some(Pending::Text { text, .. } | Pending::Reasoning { text, .. }) => text.len(),
            None => 0,
        };
        if size >= FLUSH_BYTES {
            ready.extend(self.flush());
        }
        ready
    }

    /// Takes one event and returns what can be written now, in order.
    pub fn push(&mut self, event: AgUiEvent) -> Vec<AgUiEvent> {
        match event {
            AgUiEvent::TextMessageContent { message_id, delta } => {
                self.merge(message_id, delta, false)
            }
            AgUiEvent::ReasoningMessageContent { message_id, delta } => {
                self.merge(message_id, delta, true)
            }
            other => {
                let mut ready = self.flush();
                ready.extend(self.bound(other));
                ready
            }
        }
    }

    fn may_keep(&mut self, tool: &str) -> bool {
        if self.snapshots.contains(tool) {
            return true;
        }
        if self.snapshots.len() >= MAX_SNAPSHOTS {
            return false;
        }
        self.snapshots.insert(tool.to_owned());
        true
    }

    fn bound(&mut self, event: AgUiEvent) -> Option<AgUiEvent> {
        match event {
            AgUiEvent::ToolCallArgs {
                tool_call_id,
                delta,
            } => {
                let used = self.args.entry(tool_call_id.clone()).or_default();
                let room = MAX_ARGS_BYTES.saturating_sub(*used);
                let kept = prefix(&delta, room);
                if kept.is_empty() && !delta.is_empty() {
                    return None;
                }
                *used += kept.len();
                Some(AgUiEvent::ToolCallArgs {
                    delta: kept.to_owned(),
                    tool_call_id,
                })
            }
            AgUiEvent::ToolCallResult {
                message_id,
                tool_call_id,
                content,
                role,
            } => {
                let content = if !self.may_keep(&tool_call_id) {
                    DROPPED_NOTICE.to_owned()
                } else if content.len() > MAX_OUTPUT_BYTES {
                    format!("{}{CUT_NOTICE}", prefix(&content, MAX_OUTPUT_BYTES))
                } else {
                    content
                };
                Some(AgUiEvent::ToolCallResult {
                    message_id,
                    tool_call_id,
                    content,
                    role,
                })
            }
            AgUiEvent::Custom { name, value } if name == "tool.output" => self
                .bound_output(value)
                .map(|value| AgUiEvent::Custom { name, value }),
            other => Some(other),
        }
    }

    /// Live output counts against the same limit per tool, and ends with one notice.
    fn bound_output(&mut self, value: Value) -> Option<Value> {
        let tool = value.get("toolCallId").and_then(Value::as_str)?.to_owned();
        let delta = value.get("delta").and_then(Value::as_str).unwrap_or("");
        if !self.may_keep(&tool) {
            return None;
        }
        let used = self.output.entry(tool.clone()).or_default();
        if *used >= MAX_OUTPUT_BYTES {
            return None;
        }
        let kept = prefix(delta, MAX_OUTPUT_BYTES - *used);
        let cut = kept.len() < delta.len();
        *used += if cut { MAX_OUTPUT_BYTES } else { kept.len() };
        let shown = if cut {
            format!("{kept}{CUT_NOTICE}")
        } else {
            kept.to_owned()
        };
        Some(json!({ "toolCallId": tool, "delta": shown }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(id: &str, delta: &str) -> AgUiEvent {
        AgUiEvent::TextMessageContent {
            message_id: id.into(),
            delta: delta.into(),
        }
    }

    #[tokio::test]
    async fn deltas_merge_and_order_survives_anything_else() {
        let mut shaper = EventShaper::default();
        assert!(shaper.push(text("m", "a")).is_empty());
        assert!(shaper.push(text("m", "b")).is_empty());
        assert!(shaper.due().is_some());
        let ready = shaper.push(AgUiEvent::TextMessageEnd {
            message_id: "m".into(),
        });
        assert_eq!(ready.len(), 2);
        assert_eq!(ready[0], text("m", "ab"), "the text goes before its end");
        assert!(shaper.due().is_none());
    }

    #[tokio::test]
    async fn another_message_flushes_the_first_and_text_never_mixes_with_reasoning() {
        let mut shaper = EventShaper::default();
        shaper.push(text("one", "a"));
        assert_eq!(shaper.push(text("two", "b")), vec![text("one", "a")]);
        let ready = shaper.push(AgUiEvent::ReasoningMessageContent {
            message_id: "two".into(),
            delta: "c".into(),
        });
        assert_eq!(ready, vec![text("two", "b")]);
    }

    #[tokio::test]
    async fn a_large_buffer_goes_at_once_and_no_text_is_lost() {
        let mut shaper = EventShaper::default();
        let ready = shaper.push(text("m", &"x".repeat(FLUSH_BYTES)));
        assert_eq!(ready.len(), 1);
        assert!(shaper.flush().is_empty());
    }

    #[test]
    fn output_is_cut_on_a_character_boundary_and_says_so() {
        let mut shaper = EventShaper::default();
        let long = "é".repeat(MAX_OUTPUT_BYTES);
        let shaped = shaper.bound(AgUiEvent::ToolCallResult {
            message_id: "m".into(),
            tool_call_id: "t".into(),
            content: long,
            role: None,
        });
        let Some(AgUiEvent::ToolCallResult { content, .. }) = shaped else {
            panic!("a result stays a result");
        };
        assert!(content.len() <= MAX_OUTPUT_BYTES + CUT_NOTICE.len());
        assert!(content.ends_with(CUT_NOTICE));
    }

    #[test]
    fn arguments_stop_at_the_limit() {
        let mut shaper = EventShaper::default();
        let delta = |size: usize| AgUiEvent::ToolCallArgs {
            tool_call_id: "t".into(),
            delta: "x".repeat(size),
        };
        let mut kept = 0;
        for _ in 0..3 {
            if let Some(AgUiEvent::ToolCallArgs { delta, .. }) =
                shaper.bound(delta(MAX_ARGS_BYTES / 2 + 1))
            {
                kept += delta.len();
            }
        }
        assert_eq!(kept, MAX_ARGS_BYTES);
    }

    #[test]
    fn live_output_stops_once_with_a_notice() {
        let mut shaper = EventShaper::default();
        let chunk = || json!({ "toolCallId": "t", "delta": "x".repeat(MAX_OUTPUT_BYTES / 2 + 1) });
        assert!(shaper.bound_output(chunk()).is_some());
        let last = shaper.bound_output(chunk()).unwrap();
        assert!(last["delta"].as_str().unwrap().ends_with(CUT_NOTICE));
        assert_eq!(shaper.bound_output(chunk()), None);
    }

    #[test]
    fn past_the_snapshot_limit_a_tool_keeps_its_row_and_not_its_output() {
        let mut shaper = EventShaper::default();
        let result = |id: String| AgUiEvent::ToolCallResult {
            message_id: "m".into(),
            tool_call_id: id,
            content: "output".into(),
            role: None,
        };
        for index in 0..MAX_SNAPSHOTS {
            shaper.bound(result(index.to_string()));
        }
        let Some(AgUiEvent::ToolCallResult { content, .. }) = shaper.bound(result("late".into()))
        else {
            panic!("a result stays a result");
        };
        assert_eq!(content, DROPPED_NOTICE);
        let early = shaper.bound(result("3".into()));
        assert!(matches!(
            early,
            Some(AgUiEvent::ToolCallResult { content, .. }) if content == "output"
        ));
    }
}
