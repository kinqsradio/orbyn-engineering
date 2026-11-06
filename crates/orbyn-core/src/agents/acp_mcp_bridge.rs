//! Stdio access to a run's MCP endpoint, for ACP agents that support only stdio MCP
//! servers. ACP requires stdio support; HTTP support is optional. The agent starts
//! `orbyn acp-mcp-bridge`, which relays newline JSON-RPC to `POST /mcp/:token` and
//! back. `orbyn acp-mcp-call` makes one tool call, for agents that take `mcpServers`
//! but never show those tools to their model.
//!
//! The endpoint URL carries the run's token, which is its only credential, so it
//! travels in the environment and never on a command line.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio::task::JoinSet;

use crate::agents::driver::MCP_SERVER_NAME;
use crate::error::{CoreError, Result};

/// The variable that names the run's endpoint, token included.
pub const ENDPOINT_ENV: &str = "ORBYN_ACP_MCP_ENDPOINT";
pub const BRIDGE_COMMAND: &str = "acp-mcp-bridge";
const PROTOCOL_VERSION: &str = "2025-06-18";
const PARSE_ERROR: i64 = -32700;
const INTERNAL_ERROR: i64 = -32603;
/// Longer than the server's longest tool budget, so its own reply arrives first.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);
/// The largest line read from the agent, in bytes. Matches the endpoint's own limit.
const MAX_LINE_BYTES: usize = crate::tools::mcp::MAX_REQUEST_BYTES;

/// The `orbyn` program next to this one, which ACP agents start as the bridge.
pub fn bridge_program() -> Option<PathBuf> {
    let current = std::env::current_exe().ok()?;
    bridge_program_beside(&current)
}

fn bridge_program_beside(current: &Path) -> Option<PathBuf> {
    let program = current
        .parent()?
        .join(format!("orbyn{}", std::env::consts::EXE_SUFFIX));
    program.is_file().then_some(program)
}

/// The ACP `mcpServers` entry that starts the bridge for `endpoint`.
pub fn stdio_server(program: &Path, endpoint: &str) -> Value {
    json!({
        "name": MCP_SERVER_NAME,
        "command": program,
        "args": [BRIDGE_COMMAND],
        "env": [{ "name": ENDPOINT_ENV, "value": endpoint }],
    })
}

fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| CoreError::Internal(format!("Could not start the MCP client: {error}")))
}

/// What the endpoint said to one message: a reply, nothing (a notification), or an error.
async fn post(client: &reqwest::Client, endpoint: &str, body: String) -> Result<Option<Value>> {
    let response = client
        .post(endpoint)
        .header("content-type", "application/json")
        .header("accept", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|error| unavailable(&format!("could not be reached: {error}")))?;
    let status = response.status();
    if status == reqwest::StatusCode::ACCEPTED {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(unavailable(&format!(
            "responded with HTTP {}",
            status.as_u16()
        )));
    }
    let reply = response
        .json::<Value>()
        .await
        .map_err(|error| unavailable(&format!("sent a reply that is not JSON: {error}")))?;
    Ok(Some(reply))
}

fn unavailable(detail: &str) -> CoreError {
    CoreError::EngineUnavailable(format!("Orbyn's MCP endpoint {detail}."))
}

fn error_reply(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Relays newline JSON-RPC between `input` and the endpoint until `input` ends, then
/// waits for replies still on their way. The handshake runs in order; later requests
/// run side by side, since a tool can wait minutes on a person.
pub async fn run_bridge<R, W>(endpoint: &str, input: R, mut output: W) -> Result<()>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let client = client()?;
    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    let writer = tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            let mut line = message.to_string();
            line.push('\n');
            if output.write_all(line.as_bytes()).await.is_err() || output.flush().await.is_err() {
                break;
            }
        }
    });
    let mut running = JoinSet::new();
    let mut lines = input.lines();
    while let Some(line) = lines
        .next_line()
        .await
        .map_err(|error| CoreError::Internal(format!("Could not read the agent: {error}")))?
    {
        if line.trim().is_empty() {
            continue;
        }
        let parsed = (line.len() <= MAX_LINE_BYTES)
            .then(|| serde_json::from_str::<Value>(&line).ok())
            .flatten();
        let Some(message) = parsed.filter(Value::is_object) else {
            let _ = tx.send(error_reply(Value::Null, PARSE_ERROR, "Parse error"));
            continue;
        };
        let id = message.get("id").cloned().filter(|id| !id.is_null());
        let handshake = matches!(
            message.get("method").and_then(Value::as_str),
            Some("initialize" | "notifications/initialized")
        );
        let relay = relay(client.clone(), endpoint.to_owned(), line, id, tx.clone());
        if handshake {
            relay.await;
        } else {
            running.spawn(relay);
        }
    }
    while running.join_next().await.is_some() {}
    drop(tx);
    let _ = writer.await;
    Ok(())
}

async fn relay(
    client: reqwest::Client,
    endpoint: String,
    line: String,
    id: Option<Value>,
    tx: mpsc::UnboundedSender<Value>,
) {
    let reply = match post(&client, &endpoint, line).await {
        Ok(reply) => reply,
        // A notification has no one to tell.
        Err(error) => id.map(|id| error_reply(id, INTERNAL_ERROR, &error.public_message())),
    };
    if let Some(reply) = reply {
        for entry in match reply {
            Value::Array(entries) => entries,
            single => vec![single],
        } {
            let _ = tx.send(entry);
        }
    }
}

/// Opens a session, calls one tool and returns its `CallToolResult`. A text part that
/// only repeats `structuredContent` is dropped, so a terminal shows each once.
pub async fn call_tool(endpoint: &str, tool: &str, arguments: Value) -> Result<Value> {
    if !arguments.is_object() {
        return Err(CoreError::Invalid(
            "Tool arguments must be a JSON object.".into(),
        ));
    }
    let client = client()?;
    request(
        &client,
        endpoint,
        0,
        "initialize",
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": "orbyn-acp-mcp-call", "version": env!("CARGO_PKG_VERSION") },
        }),
    )
    .await?;
    post(
        &client,
        endpoint,
        json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }).to_string(),
    )
    .await?;
    let result = request(
        &client,
        endpoint,
        1,
        "tools/call",
        json!({ "name": tool, "arguments": arguments }),
    )
    .await?;
    Ok(without_repeated_text(result))
}

async fn request(
    client: &reqwest::Client,
    endpoint: &str,
    id: u64,
    method: &str,
    params: Value,
) -> Result<Value> {
    let body = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    let reply = post(client, endpoint, body.to_string())
        .await?
        .ok_or_else(|| unavailable(&format!("sent no reply to {method}")))?;
    if let Some(error) = reply.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("no message");
        return Err(CoreError::Invalid(format!(
            "MCP {method} failed: {message}"
        )));
    }
    reply
        .get("result")
        .cloned()
        .ok_or_else(|| unavailable(&format!("sent no result for {method}")))
}

fn without_repeated_text(mut result: Value) -> Value {
    let Some(encoded) = result
        .get("structuredContent")
        .filter(|value| !value.is_null())
        .map(Value::to_string)
    else {
        return result;
    };
    if let Some(parts) = result.get_mut("content").and_then(Value::as_array_mut) {
        parts.retain(|part| {
            !(part.get("type").and_then(Value::as_str) == Some("text")
                && part.get("text").and_then(Value::as_str) == Some(encoded.as_str()))
        });
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_stdio_entry_keeps_the_endpoint_off_the_command_line() {
        let program = Path::new(if cfg!(windows) {
            r"C:\Program Files\Orbyn\orbyn.exe"
        } else {
            "/Applications/Orbyn.app/Contents/MacOS/orbyn"
        });
        let entry = stdio_server(program, "http://127.0.0.1:9/mcp/secret");
        assert_eq!(entry["command"], json!(program));
        assert_eq!(entry["args"], json!([BRIDGE_COMMAND]));
        assert!(!entry["args"].to_string().contains("secret"));
        assert_eq!(entry["env"][0]["name"], ENDPOINT_ENV);
        assert_eq!(entry["name"], MCP_SERVER_NAME);
    }

    #[test]
    fn the_bridge_program_is_the_sibling_with_this_platform_suffix() {
        let dir = crate::testing::TempDir::new();
        let current = dir
            .path()
            .join(format!("orbynd{}", std::env::consts::EXE_SUFFIX));
        assert_eq!(bridge_program_beside(&current), None);
        let sibling = dir
            .path()
            .join(format!("orbyn{}", std::env::consts::EXE_SUFFIX));
        std::fs::write(&sibling, b"").unwrap();
        assert_eq!(bridge_program_beside(&current), Some(sibling));
    }

    #[test]
    fn only_text_that_repeats_the_structured_result_is_dropped() {
        let structured = json!({ "ok": true });
        let result = without_repeated_text(json!({
            "content": [
                { "type": "text", "text": structured.to_string() },
                { "type": "text", "text": "other" },
            ],
            "structuredContent": structured,
        }));
        assert_eq!(
            result["content"],
            json!([{ "type": "text", "text": "other" }])
        );
        let plain = json!({ "content": [{ "type": "text", "text": "{}" }] });
        assert_eq!(without_repeated_text(plain.clone()), plain);
    }

    #[tokio::test]
    async fn bad_lines_get_a_parse_error_and_an_unreachable_endpoint_answers_the_id() {
        let input = b"not json\n\n{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"tools/list\"}\n{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n";
        let (mut read, write) = tokio::io::duplex(64 * 1024);
        run_bridge("http://127.0.0.1:9/mcp/none", &input[..], write)
            .await
            .unwrap();
        let mut out = String::new();
        tokio::io::AsyncReadExt::read_to_string(&mut read, &mut out)
            .await
            .unwrap();
        let replies: Vec<Value> = out
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(replies.len(), 2, "{out}");
        assert_eq!(replies[0]["error"]["code"], PARSE_ERROR);
        assert_eq!(replies[1]["id"], 7);
        assert_eq!(replies[1]["error"]["code"], INTERNAL_ERROR);
    }
}
