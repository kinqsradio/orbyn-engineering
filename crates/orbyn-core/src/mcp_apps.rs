//! MCP Apps: a tool whose descriptor names a `ui://` resource gets that page shown
//! beside its row. Codex is the only engine that reports one today: a finished
//! `mcpToolCall` item carries `mcpAppUi.resourceUri`, or the older
//! `mcpAppResourceUri`, and the same app-server answers `mcpServer/resource/read`.
//!
//! The page is untrusted. It is stored with the C22 render store and framed with the
//! C21 sandbox and `?render=` token, so it runs offline in an opaque origin with no
//! service credential. Checkout images are never embedded into it.

use serde_json::{Value, json};

/// The resource scheme MCP Apps use for their pages.
pub const RESOURCE_SCHEME: &str = "ui://";
/// The MIME type of an MCP App page.
pub const APP_MIME: &str = "text/html;profile=mcp-app";
const MAX_RESOURCE_URI_BYTES: usize = 4096;
const MAX_NAME_BYTES: usize = 256;
/// Structured tool output kept for the page's `tool-result` notification. Beyond
/// this the page still gets the text content from the row.
const MAX_STRUCTURED_BYTES: usize = 32 * 1024;

/// One app page, read while the run's engine was still alive.
#[derive(Debug, Clone, PartialEq)]
pub struct McpAppSnapshot {
    pub tool_call_id: String,
    pub server: String,
    pub tool: String,
    pub resource_uri: String,
    pub html: String,
    /// `inline` or `fullscreen`, as the tool descriptor prefers.
    pub display_mode: String,
    pub prefers_border: bool,
    pub structured: Option<Value>,
}

fn bounded_name(item: &Value, key: &str) -> Option<String> {
    let value = item.get(key)?.as_str()?.trim();
    (!value.is_empty() && value.len() <= MAX_NAME_BYTES).then(|| value.to_owned())
}

/// What an app read needs from a finished Codex `mcpToolCall` item: the server, the
/// tool and the page's `ui://` resource. A failed call, a call still running or a
/// resource outside `ui://` has no app.
pub fn codex_app_target(item: &Value) -> Option<(String, String, String, String)> {
    if item.get("type")?.as_str()? != "mcpToolCall" || item.get("status")?.as_str()? != "completed"
    {
        return None;
    }
    let ui = item.get("mcpAppUi").filter(|ui| ui.is_object());
    let uri = ui
        .and_then(|ui| ui.get("resourceUri"))
        .or_else(|| item.get("mcpAppResourceUri"))?
        .as_str()?;
    if !uri.starts_with(RESOURCE_SCHEME) || uri.len() > MAX_RESOURCE_URI_BYTES {
        return None;
    }
    let mode = ui
        .and_then(|ui| ui.get("preferredModelDisplayMode"))
        .and_then(Value::as_str)
        .filter(|mode| *mode == "fullscreen")
        .unwrap_or("inline");
    Some((
        bounded_name(item, "server")?,
        bounded_name(item, "tool")?,
        uri.to_owned(),
        mode.to_owned(),
    ))
}

/// The page from a `mcpServer/resource/read` answer: the first text content for the
/// asked URI that is HTML. A blob page is not decoded.
pub fn page_from_read(read: &Value, uri: &str) -> Option<(String, bool)> {
    read.get("contents")?
        .as_array()?
        .iter()
        .filter(|content| content.get("uri").and_then(Value::as_str) == Some(uri))
        .find_map(|content| {
            let mime = content
                .get("mimeType")
                .and_then(Value::as_str)
                .unwrap_or("");
            if !mime.to_ascii_lowercase().starts_with("text/html") {
                return None;
            }
            let html = content.get("text")?.as_str()?.to_owned();
            let border = content
                .pointer("/_meta/ui/prefersBorder")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            Some((html, border))
        })
}

/// The call's structured output, when it is small enough to hand the page.
pub fn structured_output(item: &Value) -> Option<Value> {
    let structured = item.pointer("/result/structuredContent")?;
    (!structured.is_null() && structured.to_string().len() <= MAX_STRUCTURED_BYTES)
        .then(|| structured.clone())
}

/// The timeline marker that ties a tool row to its stored page. The frame token
/// opens only this render, as an `orbyn_html_render` result's does.
pub fn timeline_marker(app: &McpAppSnapshot, render_id: &str, frame_token: &str) -> Value {
    json!({
        "toolCallId": app.tool_call_id,
        "renderId": render_id,
        "frameToken": frame_token,
        "server": app.server,
        "tool": app.tool,
        "resourceUri": app.resource_uri,
        "displayMode": app.display_mode,
        "prefersBorder": app.prefers_border,
        "structuredContent": app.structured,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(extra: Value) -> Value {
        let mut item = json!({
            "type": "mcpToolCall", "id": "call-1", "server": "demo", "tool": "show_widget",
            "status": "completed", "arguments": { "text": "hello" },
        });
        item.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        item
    }

    /// The shape Codex 0.166.0 reported for a descriptor with `_meta.ui.resourceUri`.
    #[test]
    fn the_observed_legacy_field_names_the_page() {
        let observed =
            item(json!({ "mcpAppResourceUri": "ui://demo/widget.html", "mcpAppUi": null }));
        assert_eq!(
            codex_app_target(&observed),
            Some((
                "demo".into(),
                "show_widget".into(),
                "ui://demo/widget.html".into(),
                "inline".into()
            ))
        );
    }

    #[test]
    fn the_newer_field_wins_and_carries_the_display_mode() {
        let both = item(json!({
            "mcpAppResourceUri": "ui://demo/old.html",
            "mcpAppUi": { "resourceUri": "ui://demo/new.html", "preferredModelDisplayMode": "fullscreen" },
        }));
        let (_, _, uri, mode) = codex_app_target(&both).unwrap();
        assert_eq!(
            (uri.as_str(), mode.as_str()),
            ("ui://demo/new.html", "fullscreen")
        );
    }

    #[test]
    fn only_a_finished_call_with_a_ui_resource_has_an_app() {
        for extra in [
            json!({}),
            json!({ "mcpAppResourceUri": "https://evil.example/page.html" }),
            json!({ "mcpAppResourceUri": format!("ui://{}", "a".repeat(5000)) }),
            json!({ "mcpAppResourceUri": "ui://demo/w.html", "status": "failed" }),
            json!({ "mcpAppResourceUri": "ui://demo/w.html", "status": "inProgress" }),
            json!({ "mcpAppResourceUri": "ui://demo/w.html", "type": "commandExecution" }),
            json!({ "mcpAppResourceUri": "ui://demo/w.html", "server": " " }),
        ] {
            assert!(codex_app_target(&item(extra.clone())).is_none(), "{extra}");
        }
    }

    #[test]
    fn the_page_is_the_html_text_for_the_asked_uri() {
        let read = json!({ "contents": [
            { "uri": "ui://other", "mimeType": APP_MIME, "text": "<p>other</p>" },
            { "uri": "ui://demo/w.html", "mimeType": "text/plain", "text": "not html" },
            { "uri": "ui://demo/w.html", "mimeType": APP_MIME, "text": "<p>page</p>",
              "_meta": { "ui": { "prefersBorder": true } } },
        ]});
        assert_eq!(
            page_from_read(&read, "ui://demo/w.html"),
            Some(("<p>page</p>".into(), true))
        );
        let blob = json!({ "contents": [{ "uri": "ui://demo/w.html", "mimeType": APP_MIME, "blob": "PHA+" }] });
        assert_eq!(page_from_read(&blob, "ui://demo/w.html"), None);
    }

    #[test]
    fn only_small_structured_output_reaches_the_page() {
        let small = item(json!({ "result": { "structuredContent": { "text": "hello" } } }));
        assert_eq!(structured_output(&small), Some(json!({ "text": "hello" })));
        let big =
            item(json!({ "result": { "structuredContent": { "text": "x".repeat(40_000) } } }));
        assert_eq!(structured_output(&big), None);
    }
}
