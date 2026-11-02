//! Short-lived, bounded ACP management. IO is owned by the operation future:
//! no background reader, writer, prompt, new-session, or authentication task.
use std::ffi::OsString;
use std::path::Path;
use std::time::Duration;

use orbyn_contracts::{
    AcpNativeSession, AcpNativeSessionPage, AcpSessionCapabilities, CustomEngine,
};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout};
use tokio::time::Instant;

use super::acp::UpdateMapper;
use super::pipes::{resolve_engine, spawn_engine_with};
use super::{EngineEvent, NativeSessionReplay, ProbeDir};
use crate::error::{CoreError, Result};
use crate::process::ManagedChild;

pub(super) const MAX_BYTES: usize = 4 * 1024 * 1024;
pub(super) const MAX_MESSAGES: usize = 4096;
const OPERATION_TIMEOUT: Duration = Duration::from_secs(60);

pub(super) fn capabilities(init: &Value) -> AcpSessionCapabilities {
    let offered = |name: &str| {
        init.pointer("/agentCapabilities/sessionCapabilities")
            .and_then(|caps| caps.get(name))
            .is_some_and(Value::is_object)
    };
    AcpSessionCapabilities {
        can_list: offered("list"),
        can_load: init
            .pointer("/agentCapabilities/loadSession")
            .and_then(Value::as_bool)
            == Some(true),
        can_resume: offered("resume"),
        can_delete: offered("delete"),
    }
}

pub(super) fn initialize_params() -> Value {
    json!({"protocolVersion":1,"clientInfo":{"name":"orbyn","version":env!("CARGO_PKG_VERSION")},
        "clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false}})
}

pub(super) fn check_version(init: &Value) -> Result<()> {
    if init.get("protocolVersion").and_then(Value::as_u64) != Some(1) {
        return Err(CoreError::Unsupported(
            "This agent does not speak ACP version 1.".into(),
        ));
    }
    Ok(())
}

fn bounded(value: &str, max: usize) -> bool {
    value.chars().count() <= max
}
fn required_text(value: &Value, field: &str, max: usize) -> Result<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && bounded(s, max))
        .map(str::to_owned)
        .ok_or_else(|| {
            CoreError::EngineUnavailable(format!("The agent returned an invalid {field}."))
        })
}
fn optional_text(value: &Value, field: &str, max: usize) -> Result<Option<String>> {
    match value.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if bounded(s, max) => Ok(Some(s.clone())),
        _ => Err(CoreError::EngineUnavailable(format!(
            "The agent returned an invalid {field}."
        ))),
    }
}

pub(super) fn parse_page(
    reply: &Value,
    caps: AcpSessionCapabilities,
) -> Result<AcpNativeSessionPage> {
    let rows = reply
        .get("sessions")
        .and_then(Value::as_array)
        .filter(|rows| rows.len() <= 256)
        .ok_or_else(|| {
            CoreError::EngineUnavailable("The agent returned an invalid session page.".into())
        })?;
    let mut sessions = Vec::with_capacity(rows.len());
    for row in rows {
        let cwd = required_text(row, "cwd", 4096)?;
        if !Path::new(&cwd).is_absolute() {
            return Err(CoreError::EngineUnavailable(
                "The agent returned a relative session folder.".into(),
            ));
        }
        let mut additional_directories = Vec::new();
        match row.get("additionalDirectories") {
            None => {}
            Some(Value::Array(paths)) if paths.len() <= 32 => {
                for path in paths {
                    let path = path
                        .as_str()
                        .filter(|s| bounded(s, 4096) && Path::new(s).is_absolute())
                        .ok_or_else(|| {
                            CoreError::EngineUnavailable(
                                "The agent returned an invalid additional folder.".into(),
                            )
                        })?;
                    additional_directories.push(path.to_owned());
                }
            }
            _ => {
                return Err(CoreError::EngineUnavailable(
                    "The agent returned invalid additional folders.".into(),
                ));
            }
        }
        sessions.push(AcpNativeSession {
            session_id: required_text(row, "sessionId", 1024)?,
            cwd,
            additional_directories,
            title: optional_text(row, "title", 1024)?,
            updated_at: optional_text(row, "updatedAt", 128)?,
            imported_thread_id: None,
        });
    }
    Ok(AcpNativeSessionPage {
        sessions,
        next_cursor: optional_text(reply, "nextCursor", 2048)?,
        can_load: caps.can_load,
        can_resume: caps.can_resume,
        can_delete: caps.can_delete,
    })
}

pub(super) enum Operation<'a> {
    Capabilities,
    List {
        cwd: &'a Path,
        cursor: Option<&'a str>,
    },
    Load {
        cwd: &'a Path,
        id: &'a str,
    },
    Delete {
        id: &'a str,
    },
}
pub(super) enum Output {
    Capabilities(AcpSessionCapabilities),
    Page(AcpNativeSessionPage),
    Replay(NativeSessionReplay),
    Deleted,
}

struct Connection {
    child: ManagedChild,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    deadline: Instant,
    bytes: usize,
    messages: usize,
    next_id: u64,
}

impl Connection {
    fn start(engine: &CustomEngine, env: &[(&str, &str)], dir: &Path) -> Result<Self> {
        let command = resolve_engine(&engine.target)?;
        let args: Vec<OsString> = engine.args.iter().map(OsString::from).collect();
        let process = spawn_engine_with(&command, &args, dir, env)?;
        Ok(Self {
            child: process.child,
            stdin: process.stdin,
            stdout: BufReader::new(process.stdout),
            deadline: Instant::now() + OPERATION_TIMEOUT,
            bytes: 0,
            messages: 0,
            next_id: 1,
        })
    }
    async fn send(&mut self, value: Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(&value)?;
        if bytes.len() > MAX_BYTES {
            return Err(CoreError::Invalid("The ACP request is too large.".into()));
        }
        bytes.push(b'\n');
        tokio::time::timeout_at(self.deadline, async {
            self.stdin.write_all(&bytes).await?;
            self.stdin.flush().await
        })
        .await
        .map_err(|_| CoreError::EngineUnavailable("The ACP operation timed out.".into()))??;
        Ok(())
    }
    async fn receive(&mut self) -> Result<Value> {
        let mut line = Vec::new();
        loop {
            let available = tokio::time::timeout_at(self.deadline, self.stdout.fill_buf())
                .await
                .map_err(|_| {
                    CoreError::EngineUnavailable("The ACP operation timed out.".into())
                })??;
            if available.is_empty() {
                return Err(CoreError::EngineUnavailable(
                    "The agent closed before answering.".into(),
                ));
            }
            let count = available
                .iter()
                .position(|b| *b == b'\n')
                .map_or(available.len(), |at| at + 1);
            if self.bytes.checked_add(count).is_none_or(|n| n > MAX_BYTES) {
                return Err(CoreError::EngineUnavailable(
                    "The ACP operation exceeded its output limit.".into(),
                ));
            }
            let complete = available[count - 1] == b'\n';
            line.extend_from_slice(&available[..count]);
            self.bytes += count;
            self.stdout.consume(count);
            if complete {
                break;
            }
        }
        self.messages += 1;
        if self.messages > MAX_MESSAGES {
            return Err(CoreError::EngineUnavailable(
                "The ACP operation returned too many messages.".into(),
            ));
        }
        serde_json::from_slice(&line).map_err(|_| {
            CoreError::EngineUnavailable("The agent returned invalid ACP JSON.".into())
        })
    }
    async fn call(
        &mut self,
        method: &str,
        params: Value,
        mut replay: Option<&mut UpdateMapper>,
        session: Option<&str>,
    ) -> Result<(Value, Vec<orbyn_contracts::AgUiEvent>)> {
        let id = self.next_id;
        self.next_id += 1;
        self.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .await?;
        let mut events = Vec::new();
        loop {
            let msg = self.receive().await?;
            if msg.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
                return Err(CoreError::EngineUnavailable(
                    "The agent returned an invalid ACP envelope.".into(),
                ));
            }
            if let Some(method) = msg.get("method").and_then(Value::as_str) {
                if let Some(request_id) = msg.get("id") {
                    let reply = if method == "session/request_permission" {
                        json!({"jsonrpc":"2.0","id":request_id,"result":{"outcome":{"outcome":"cancelled"}}})
                    } else {
                        json!({"jsonrpc":"2.0","id":request_id,"error":{"code":-32601,"message":"This operation does not serve client methods."}})
                    };
                    self.send(reply).await?;
                } else if method == "session/update" {
                    let params = msg.get("params").unwrap_or(&Value::Null);
                    if params.get("sessionId").and_then(Value::as_str) != session {
                        return Err(CoreError::EngineUnavailable(
                            "The agent replayed another session.".into(),
                        ));
                    }
                    if let Some(mapper) = replay.as_deref_mut() {
                        for event in mapper.on_update(params.get("update").unwrap_or(&Value::Null))
                        {
                            if let EngineEvent::Agui(event) = event {
                                events.push(event);
                            }
                        }
                    }
                }
                continue;
            }
            if msg.get("id").and_then(Value::as_u64) != Some(id) {
                return Err(CoreError::EngineUnavailable(
                    "The agent returned an unexpected response.".into(),
                ));
            }
            if let Some(error) = msg.get("error") {
                return Err(
                    if error.get("code").and_then(Value::as_i64) == Some(-32601) {
                        CoreError::Unsupported(format!("The agent does not support {method}."))
                    } else if matches!(method, "session/load" | "session/resume")
                        && error.get("code").and_then(Value::as_i64) == Some(-32002)
                    {
                        CoreError::SessionLost
                    } else {
                        CoreError::EngineUnavailable(format!("The agent rejected {method}."))
                    },
                );
            }
            let result = msg
                .get("result")
                .filter(|v| v.is_object())
                .cloned()
                .ok_or_else(|| {
                    CoreError::EngineUnavailable("The agent returned an invalid ACP result.".into())
                })?;
            return Ok((result, events));
        }
    }
    async fn close(&mut self) {
        self.child.terminate();
        let _ = tokio::time::timeout(Duration::from_secs(5), self.child.wait()).await;
    }
}

pub(super) async fn perform(
    engine: &CustomEngine,
    env: &[(&str, &str)],
    op: Operation<'_>,
) -> Result<Output> {
    match &op {
        Operation::List { cwd, cursor } => {
            if !cwd.is_absolute()
                || !bounded(&cwd.to_string_lossy(), 4096)
                || cursor.is_some_and(|c| !bounded(c, 2048))
            {
                return Err(CoreError::Invalid("Invalid ACP session query.".into()));
            }
        }
        Operation::Load { cwd, id } => {
            if !cwd.is_absolute()
                || !bounded(&cwd.to_string_lossy(), 4096)
                || id.is_empty()
                || !bounded(id, 1024)
            {
                return Err(CoreError::Invalid("Invalid ACP session identity.".into()));
            }
        }
        Operation::Delete { id } => {
            if id.is_empty() || !bounded(id, 1024) {
                return Err(CoreError::Invalid("Invalid ACP session identity.".into()));
            }
        }
        Operation::Capabilities => {}
    }
    let dir = ProbeDir::new()?;
    let mut connection = Connection::start(engine, env, dir.path())?;
    let result = async {
        let (init, _) = connection.call("initialize", initialize_params(), None, None).await?;
        check_version(&init)?;
        let caps = capabilities(&init);
        match op {
            Operation::Capabilities => Ok(Output::Capabilities(caps)),
            Operation::List { cwd, cursor } if caps.can_list => {
                let mut params = json!({"cwd": cwd});
                if let Some(cursor) = cursor { params["cursor"] = json!(cursor); }
                let (reply, _) = connection.call("session/list", params, None, None).await?;
                Ok(Output::Page(parse_page(&reply, caps)?))
            }
            Operation::Load { cwd, id } if caps.can_load || caps.can_resume => {
                let mut mapper = UpdateMapper::historical();
                let method = if caps.can_load { "session/load" } else { "session/resume" };
                let (_, mut events) = connection.call(
                    method,
                    json!({"sessionId": id, "cwd": cwd, "mcpServers": [], "additionalDirectories": []}),
                    Some(&mut mapper), Some(id),
                ).await?;
                for event in mapper.close() {
                    if let EngineEvent::Agui(event) = event { events.push(event); }
                }
                if !caps.can_load && !events.is_empty() {
                    return Err(CoreError::EngineUnavailable("The agent replayed history while resuming.".into()));
                }
                Ok(Output::Replay(NativeSessionReplay { events }))
            }
            Operation::Delete { id } if caps.can_delete => {
                connection.call("session/delete", json!({"sessionId": id}), None, None).await?;
                Ok(Output::Deleted)
            }
            _ => Err(CoreError::Unsupported("This agent does not support this native session operation.".into())),
        }
    }.await;
    connection.close().await;
    result
}

#[cfg(test)]
mod tests;
