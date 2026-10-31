//! The `agent-desktop` sidecar. Its JSON envelope reports `ok`, `data` and, on
//! failure, `error` with a delivery disposition. An unknown delivery is passed
//! along and never retried here.

use std::process::Stdio;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::process::Command;

use crate::error::{CoreError, Result};
use crate::process::{ResolvedCommand, resolve};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(60);

/// Commands exposed through the gateway. Sessions, batches and skill management
/// stay out: each governed action must be one audited step.
const COMMANDS: &[&str] = &[
    "snapshot",
    "find",
    "get",
    "is",
    "screenshot",
    "list-surfaces",
    "click",
    "double-click",
    "triple-click",
    "right-click",
    "type",
    "set-value",
    "clear",
    "focus",
    "select",
    "toggle",
    "check",
    "uncheck",
    "expand",
    "collapse",
    "scroll",
    "scroll-to",
    "press",
    "hover",
    "drag",
    "launch",
    "close-app",
    "list-apps",
    "list-windows",
    "list-displays",
    "focus-window",
    "resize-window",
    "move-window",
    "minimize",
    "maximize",
    "restore",
    "clipboard-get",
    "clipboard-set",
    "clipboard-clear",
    "wait",
    "status",
];

pub fn is_known(command: &str) -> bool {
    COMMANDS.contains(&command)
}

/// The configured sidecar, `ORBYN_AGENT_DESKTOP`, or `agent-desktop` on PATH.
pub fn find(configured: Option<&str>) -> Option<ResolvedCommand> {
    configured
        .and_then(resolve)
        .or_else(|| resolve("agent-desktop"))
}

pub async fn run(sidecar: &ResolvedCommand, command: &str, args: &[String]) -> Result<Value> {
    let mut builder = Command::new(&sidecar.program);
    builder
        .args(&sidecar.prefix)
        .arg(command)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = tokio::time::timeout(COMMAND_TIMEOUT, builder.output())
        .await
        .map_err(|_| CoreError::Computer("agent-desktop did not finish in time.".into()))?
        .map_err(|error| CoreError::Computer(format!("Could not run agent-desktop: {error}")))?;
    parse_envelope(&String::from_utf8_lossy(&output.stdout))
}

/// Reads the envelope. Output without one is a failure with unknown delivery.
pub fn parse_envelope(stdout: &str) -> Result<Value> {
    let envelope: Value = serde_json::from_str(stdout.trim()).map_err(|_| {
        CoreError::Computer("agent-desktop did not return its JSON envelope.".into())
    })?;
    if envelope.get("ok").and_then(Value::as_bool) == Some(true) {
        return Ok(envelope.get("data").cloned().unwrap_or(json!({})));
    }
    let error = envelope.get("error").cloned().unwrap_or(Value::Null);
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("agent-desktop failed.");
    let code = error
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or("UNKNOWN");
    let delivery = error
        .pointer("/disposition/delivery")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    Err(CoreError::Computer(format!(
        "{code}: {message} (delivery {delivery})"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn success_returns_data_with_its_disposition() {
        let text = r#"{"version":"2.5","ok":true,"command":"click","data":{"action":"click","disposition":{"delivery":"delivered_unverified","retry":"unsafe"}}}"#;
        let data = parse_envelope(text).unwrap();
        assert_eq!(data["disposition"]["delivery"], "delivered_unverified");
    }

    #[test]
    fn failure_keeps_code_and_delivery() {
        let text = r#"{"version":"2.5","ok":false,"command":"click","error":{"code":"STALE_REF","message":"not found","disposition":{"delivery":"not_delivered","retry":"safe"}}}"#;
        let error = parse_envelope(text).unwrap_err().to_string();
        assert!(error.contains("STALE_REF"));
        assert!(error.contains("not_delivered"));
    }

    #[test]
    fn garbage_is_a_failure() {
        assert!(parse_envelope("oops").is_err());
    }
}
