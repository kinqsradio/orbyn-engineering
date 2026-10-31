//! One driver for any Agent Client Protocol agent: JSON-RPC 2.0 over stdio,
//! protocol version 1. The client advertises no file or terminal methods, so an
//! agent cannot act through Orbyn without asking.

use std::collections::HashSet;
use std::ffi::OsString;
use std::time::Duration;

use async_trait::async_trait;
use orbyn_contracts::{
    ActionKind, AgUiEvent, AuthState, CustomEngine, EngineCapabilities, EngineTier, ModelInfo,
    ModelOption, ModelOptionValue, SkillDelivery,
};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::pipes::{EngineProcess, exit_message, resolve_engine, spawn_engine};
use super::rpc::{Inbound, RpcClient};
use super::{
    EngineDescriptor, EngineDriver, EngineEvent, EngineOutcome, EngineProbe, MCP_SERVER_NAME,
    ModelCatalog, ProbeDir, RunHandle, RunSpec, ask_paths,
};
use crate::approvals::Verdict;
use crate::error::{CoreError, Result};
use crate::selection::MODE;
use crate::util::new_id;

const PROTOCOL_VERSION: u64 = 1;
const CALL_TIMEOUT: Duration = Duration::from_secs(60);
/// How many models one probe tries, and how long it may take over them.
const MAX_PROBED_MODELS: usize = 24;
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const PROMPT_TIMEOUT: Duration = Duration::from_secs(24 * 60 * 60);
const CANCEL_GRACE: Duration = Duration::from_secs(5);
const METHOD_NOT_FOUND: i64 = -32601;
/// Prefix of a `ModelOption` id that names one of the agent's config options.
const CONFIG_PREFIX: &str = "config:";

pub struct AcpDriver {
    engine: CustomEngine,
}

impl AcpDriver {
    pub fn new(engine: CustomEngine) -> Self {
        Self { engine }
    }
}

#[async_trait]
impl EngineDriver for AcpDriver {
    fn descriptor(&self) -> EngineDescriptor {
        EngineDescriptor {
            id: self.engine.id.clone(),
            name: self.engine.name.clone(),
            tier: EngineTier::Acp,
            capabilities: EngineCapabilities {
                streaming: true,
                approvals: true,
                resume: false,
                mcp: true,
                sandbox: false,
                managed: true,
                skill_delivery: vec![SkillDelivery::McpSkillServer],
                goal_control: false,
            },
        }
    }

    async fn probe(&self) -> EngineProbe {
        EngineProbe {
            path: crate::process::resolve(&self.engine.target).map(|command| command.path),
            auth: Some(AuthState::NotApplicable),
            ..EngineProbe::default()
        }
    }

    /// ACP has no listing call, so this opens a session in a temp folder, reads
    /// what the agent reports for it, and ends the process. No prompt is sent.
    async fn models(&self) -> Result<Option<ModelCatalog>> {
        let command = resolve_engine(&self.engine.target)?;
        let args: Vec<OsString> = self.engine.args.iter().map(OsString::from).collect();
        let dir = ProbeDir::new()?;
        let process = spawn_engine(&command, &args, dir.path())?;
        let (rpc, _inbound) = RpcClient::start(process.stdin, process.stdout, true);
        let (id, session, init) = open_raw(&rpc, dir.path(), None).await?;
        let options = parse_session_options(&session);
        let mut models = parse_models(&session);
        let probing = probe_model_options(&rpc, &id, &session, &options, &mut models);
        if tokio::time::timeout(PROBE_TIMEOUT, probing).await.is_err() {
            tracing::debug!("an agent took too long to list its models' options");
        }
        delete_probe_session(&rpc, &init, &id).await;
        Ok(Some(ModelCatalog {
            options,
            ..ModelCatalog::engine(models)
        }))
    }

    async fn start_run(
        &self,
        spec: RunSpec,
        events: mpsc::Sender<EngineEvent>,
    ) -> Result<RunHandle> {
        let command = resolve_engine(&self.engine.target)?;
        let args: Vec<OsString> = self.engine.args.iter().map(OsString::from).collect();
        let process = spawn_engine(&command, &args, &spec.cwd)?;
        let cancel = CancellationToken::new();
        let task = tokio::spawn(run_protocol(process, spec, events, cancel.clone()));
        Ok(RunHandle {
            cancel,
            task,
            input: None,
        })
    }
}

async fn run_protocol(
    mut process: EngineProcess,
    spec: RunSpec,
    events: mpsc::Sender<EngineEvent>,
    cancel: CancellationToken,
) {
    let (rpc, mut inbound) = RpcClient::start(process.stdin, process.stdout, true);
    let opened = tokio::select! {
        biased;
        () = cancel.cancelled() => Err(CoreError::RunClosed),
        result = open_session(&rpc, &spec) => result,
    };
    let session = match opened {
        Ok(session) => session,
        Err(error) => {
            let outcome = if cancel.is_cancelled() {
                EngineOutcome::Cancelled
            } else {
                EngineOutcome::Failed(error.to_string())
            };
            let _ = events.send(EngineEvent::Finished(outcome)).await;
            return;
        }
    };
    let prompt_call = rpc.call(
        "session/prompt",
        json!({ "sessionId": session, "prompt": [{ "type": "text", "text": spec.prompt }] }),
        PROMPT_TIMEOUT,
    );
    tokio::pin!(prompt_call);
    let mut mapper = UpdateMapper::default();
    let mut cancel_sent = false;
    let outcome = loop {
        tokio::select! {
            biased;
            () = cancel.cancelled(), if !cancel_sent => {
                cancel_sent = true;
                let _ = rpc
                    .notify("session/cancel", Some(json!({ "sessionId": session })))
                    .await;
            }
            () = tokio::time::sleep(CANCEL_GRACE), if cancel_sent => {
                break EngineOutcome::Cancelled;
            }
            message = inbound.recv() => {
                match message {
                    Some(Inbound::Notification { method, params }) => {
                        if method == "session/update" {
                            for event in mapper.on_update(params.get("update").unwrap_or(&Value::Null)) {
                                if events.send(event).await.is_err() {
                                    return;
                                }
                            }
                        }
                    }
                    Some(Inbound::Request { id, method, params }) => {
                        answer_request(&rpc, &events, &cancel, id, method, params);
                    }
                    None => {
                        if cancel.is_cancelled() {
                            break EngineOutcome::Cancelled;
                        }
                        let status = tokio::time::timeout(CANCEL_GRACE, process.child.wait()).await;
                        let status = status.ok().and_then(Result::ok);
                        break EngineOutcome::Failed(exit_message(status, &process.stderr).await);
                    }
                }
            }
            result = &mut prompt_call => {
                // Updates sent before the reply are already queued; drain them.
                while let Ok(message) = inbound.try_recv() {
                    if let Inbound::Notification { method, params } = message
                        && method == "session/update"
                    {
                        for event in mapper.on_update(params.get("update").unwrap_or(&Value::Null)) {
                            let _ = events.send(event).await;
                        }
                    }
                }
                break match result {
                    Ok(reply) => stop_outcome(&reply),
                    Err(error) => EngineOutcome::Failed(error.to_string()),
                };
            }
        }
    };
    for event in mapper.close() {
        let _ = events.send(event).await;
    }
    let outcome = if cancel.is_cancelled() {
        EngineOutcome::Cancelled
    } else {
        outcome
    };
    let _ = events.send(EngineEvent::Finished(outcome)).await;
}

async fn open_session(rpc: &RpcClient, spec: &RunSpec) -> Result<String> {
    let (id, mut session, _) = open_raw(rpc, &spec.cwd, spec.mcp_url.as_deref()).await?;
    // Mode first: an agent can change what it offers per mode and per model, so each
    // step reads the reply of the one before it, and the prompt waits for them all.
    if let Some(mode) = spec.options.get(MODE) {
        require_offered(&session, MODE, mode)?;
        let params = json!({ "sessionId": id, "modeId": mode });
        rpc.call("session/set_mode", params, CALL_TIMEOUT).await?;
    }
    if let Some(model) = &spec.model {
        session = select_model(rpc, &id, &session, model).await?;
    }
    for (option, value) in &spec.options {
        let Some(config) = option.strip_prefix(CONFIG_PREFIX) else {
            continue;
        };
        require_offered(&session, option, value)?;
        let params = json!({ "sessionId": id, "configId": config, "value": value });
        let reply = rpc
            .call("session/set_config_option", params, CALL_TIMEOUT)
            .await?;
        if reply.get("configOptions").is_some() {
            session = reply;
        }
    }
    Ok(id)
}

/// A value the session no longer lists fails the turn. Running under something else
/// could mean running under a looser mode than the one chosen.
fn require_offered(session: &Value, option: &str, value: &str) -> Result<()> {
    let offered = parse_session_options(session);
    match offered.iter().find(|known| known.id == option) {
        Some(known) if known.values.iter().any(|choice| choice.id == value) => Ok(()),
        _ => Err(CoreError::UnsupportedOption(format!(
            "This agent no longer offers {value} for {option}."
        ))),
    }
}

/// Sets the model through whichever route this session lists it on. Returns the
/// session state to read later steps from, which a config reply replaces.
async fn select_model(rpc: &RpcClient, id: &str, session: &Value, model: &str) -> Result<Value> {
    if let Some(config) = model_config(session) {
        let config_id = config.get("id").and_then(Value::as_str).unwrap_or_default();
        let params = json!({ "sessionId": id, "configId": config_id, "value": model });
        let reply = rpc
            .call("session/set_config_option", params, CALL_TIMEOUT)
            .await?;
        return Ok(if reply.get("configOptions").is_some() {
            reply
        } else {
            session.clone()
        });
    }
    let listed = parse_models(session);
    if !listed.is_empty() && !listed.iter().any(|known| known.id == model) {
        return Err(CoreError::UnsupportedOption(format!(
            "This agent no longer offers {model}."
        )));
    }
    let params = json!({ "sessionId": id, "modelId": model });
    match rpc.call("session/set_model", params, CALL_TIMEOUT).await {
        Ok(reply) if reply.get("configOptions").is_some() => {
            let mut next = session.clone();
            next["configOptions"] = reply["configOptions"].clone();
            Ok(next)
        }
        Ok(_) => Ok(session.clone()),
        Err(error) => Err(CoreError::EngineUnavailable(format!(
            "This agent did not take the model {model}: {error}"
        ))),
    }
}

fn config_options(session: &Value) -> impl Iterator<Item = &Value> {
    session
        .get("configOptions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

/// The config option that picks the model, for an agent that lists models there.
fn model_config(session: &Value) -> Option<&Value> {
    config_options(session)
        .find(|option| option.get("category").and_then(Value::as_str) == Some("model"))
}

/// A config option's choices. They can be flat or sorted into named groups.
fn config_values(option: &Value) -> Vec<&Value> {
    option
        .get("options")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(
            |entry| match entry.get("options").and_then(Value::as_array) {
                Some(grouped) => grouped.iter().collect(),
                None => vec![entry],
            },
        )
        .collect()
}

/// What a session offers beyond the model: its modes and its other config options.
fn parse_session_options(session: &Value) -> Vec<ModelOption> {
    let mut options = Vec::new();
    let current_mode = session
        .pointer("/modes/currentModeId")
        .and_then(Value::as_str);
    let modes: Vec<ModelOptionValue> = session
        .pointer("/modes/availableModes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|mode| {
            let id = mode.get("id")?.as_str()?;
            Some(choice(mode, "name", id, current_mode == Some(id)))
        })
        .collect();
    if !modes.is_empty() {
        options.push(ModelOption {
            id: MODE.to_owned(),
            label: "Mode".to_owned(),
            values: modes,
        });
    }
    for option in config_options(session) {
        let category = option.get("category").and_then(Value::as_str);
        let Some(id) = option.get("id").and_then(Value::as_str) else {
            continue;
        };
        if category == Some("model") || category == Some(MODE) {
            continue;
        }
        let current = option.get("currentValue").and_then(Value::as_str);
        let values: Vec<ModelOptionValue> = config_values(option)
            .into_iter()
            .filter_map(|entry| {
                let value = entry.get("value")?.as_str()?;
                Some(choice(entry, "name", value, current == Some(value)))
            })
            .collect();
        if values.is_empty() {
            continue;
        }
        options.push(ModelOption {
            id: format!("{CONFIG_PREFIX}{id}"),
            label: field(option, "name"),
            values,
        });
    }
    options
}

fn choice(entry: &Value, name_key: &str, id: &str, default: bool) -> ModelOptionValue {
    ModelOptionValue {
        id: id.to_owned(),
        label: entry
            .get(name_key)
            .and_then(Value::as_str)
            .unwrap_or(id)
            .to_owned(),
        default,
        description: entry
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_owned),
    }
}

/// Initializes and opens a session, returning its id and the agent's whole reply.
async fn open_raw(
    rpc: &RpcClient,
    cwd: &std::path::Path,
    mcp_url: Option<&str>,
) -> Result<(String, Value, Value)> {
    let init = rpc
        .call(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "clientInfo": { "name": "orbyn", "version": env!("CARGO_PKG_VERSION") },
                "clientCapabilities": {
                    "fs": { "readTextFile": false, "writeTextFile": false },
                    "terminal": false,
                },
            }),
            CALL_TIMEOUT,
        )
        .await?;
    let version = init.get("protocolVersion").and_then(Value::as_u64);
    if version != Some(PROTOCOL_VERSION) {
        return Err(CoreError::EngineUnavailable(format!(
            "This agent speaks ACP {}, and Orbyn speaks version {PROTOCOL_VERSION}.",
            version.map_or_else(|| "of an unknown version".to_owned(), |v| v.to_string())
        )));
    }
    let http_mcp = init
        .pointer("/agentCapabilities/mcpCapabilities/http")
        .and_then(Value::as_bool)
        == Some(true);
    let servers = match mcp_url {
        Some(url) if http_mcp => {
            json!([{ "type": "http", "name": MCP_SERVER_NAME, "url": url, "headers": [] }])
        }
        _ => json!([]),
    };
    let session = rpc
        .call(
            "session/new",
            json!({ "cwd": cwd, "mcpServers": servers }),
            CALL_TIMEOUT,
        )
        .await?;
    let id = session
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| CoreError::EngineUnavailable("The agent returned no session id.".into()))?;
    Ok((id, session, init))
}

/// Some agents list what a model offers only once it is chosen, so a probe chooses each
/// in turn, in a session nobody will use, and keeps what differs from the session's own
/// options. One that refuses is left with those.
async fn probe_model_options(
    rpc: &RpcClient,
    id: &str,
    session: &Value,
    baseline: &[ModelOption],
    models: &mut [ModelInfo],
) {
    let mut state = session.clone();
    for model in models.iter_mut().take(MAX_PROBED_MODELS) {
        let Ok(reply) = select_model(rpc, id, &state, &model.id).await else {
            continue;
        };
        model.options = parse_session_options(&reply)
            .into_iter()
            .filter(|option| !baseline.contains(option))
            .collect();
        state = reply;
    }
}

/// Removes the session a probe opened, so an agent that keeps sessions does not show
/// it among real work. An agent may offer neither call, and a failure here is only a
/// leftover in a temp folder that is about to go.
async fn delete_probe_session(rpc: &RpcClient, init: &Value, id: &str) {
    let offered = |name: &str| {
        init.pointer("/agentCapabilities/sessionCapabilities")
            .and_then(|capabilities| capabilities.get(name))
            .is_some_and(|capability| !capability.is_null())
    };
    let method = if offered("delete") {
        "session/delete"
    } else if offered("close") {
        "session/close"
    } else {
        return;
    };
    let params = json!({ "sessionId": id });
    if let Err(error) = rpc.call(method, params, CALL_TIMEOUT).await {
        tracing::debug!(%error, "could not remove a probe session");
    }
}

/// Reads the models a session reply lists, marking the agent's current one. An
/// agent can list them as a config option instead of a `models` block.
fn parse_models(session: &Value) -> Vec<ModelInfo> {
    if let Some(config) = model_config(session) {
        let current = config.get("currentValue").and_then(Value::as_str);
        return config_values(config)
            .into_iter()
            .filter_map(|entry| {
                let id = entry.get("value")?.as_str()?;
                let picked = choice(entry, "name", id, current == Some(id));
                Some(ModelInfo {
                    id: picked.id,
                    label: picked.label,
                    description: picked.description,
                    is_default: picked.default,
                    custom: false,
                    options: Vec::new(),
                    input_modalities: Vec::new(),
                    upgrade: None,
                })
            })
            .collect();
    }
    let current = session
        .pointer("/models/currentModelId")
        .and_then(Value::as_str);
    session
        .pointer("/models/availableModels")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|model| {
            let id = model.get("modelId")?.as_str()?.to_owned();
            Some(ModelInfo {
                label: model
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(&id)
                    .to_owned(),
                description: model
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                is_default: current == Some(id.as_str()),
                custom: false,
                options: Vec::new(),
                input_modalities: Vec::new(),
                upgrade: None,
                id,
            })
        })
        .collect()
}

fn stop_outcome(reply: &Value) -> EngineOutcome {
    match reply.get("stopReason").and_then(Value::as_str) {
        Some("end_turn") => EngineOutcome::Completed,
        Some("cancelled") => EngineOutcome::Cancelled,
        Some(reason) => EngineOutcome::Failed(format!("The agent stopped: {reason}.")),
        None => EngineOutcome::Completed,
    }
}

fn answer_request(
    rpc: &RpcClient,
    events: &mpsc::Sender<EngineEvent>,
    cancel: &CancellationToken,
    id: Value,
    method: String,
    params: Value,
) {
    let rpc = rpc.clone();
    if method != "session/request_permission" {
        tokio::spawn(async move {
            let text = format!("Orbyn does not serve {method}.");
            let _ = rpc.respond_error(id, METHOD_NOT_FOUND, &text).await;
        });
        return;
    }
    let events = events.clone();
    let cancel = cancel.clone();
    tokio::spawn(async move {
        let (kind, target, summary) = classify(&params);
        let paths = if kind == ActionKind::FileChange {
            vec![target.clone()]
        } else {
            Vec::new()
        };
        let verdict = ask_paths(&events, kind, target, summary, params.clone(), paths).await;
        let outcome = permission_outcome(&params, &verdict, cancel.is_cancelled());
        let _ = rpc.respond(id, json!({ "outcome": outcome })).await;
    });
}

/// Picks the option that matches the verdict. Fails closed: with no matching
/// option the request is reported cancelled, never allowed.
fn permission_outcome(params: &Value, verdict: &Verdict, cancelled: bool) -> Value {
    if cancelled {
        return json!({ "outcome": "cancelled" });
    }
    let wanted: &[&str] = if verdict.is_allowed() {
        &["allow_once", "allow_always"]
    } else {
        &["reject_once", "reject_always"]
    };
    let options = params
        .get("options")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    wanted
        .iter()
        .find_map(|kind| {
            options
                .iter()
                .find(|option| option.get("kind").and_then(Value::as_str) == Some(kind))
        })
        .and_then(|option| option.get("optionId").and_then(Value::as_str))
        .map_or_else(
            || json!({ "outcome": "cancelled" }),
            |id| json!({ "outcome": "selected", "optionId": id }),
        )
}

fn classify(params: &Value) -> (ActionKind, String, String) {
    let call = params.get("toolCall").cloned().unwrap_or(Value::Null);
    let title = call
        .get("title")
        .or_else(|| params.get("title"))
        .and_then(Value::as_str)
        .unwrap_or("Agent action")
        .to_owned();
    let path = call
        .pointer("/locations/0/path")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let command = call
        .pointer("/rawInput/command")
        .and_then(Value::as_str)
        .map(str::to_owned);
    match call.get("kind").and_then(Value::as_str) {
        Some("execute") => (
            ActionKind::Command,
            command.unwrap_or_else(|| title.clone()),
            title,
        ),
        Some("edit" | "delete" | "move") => (
            ActionKind::FileChange,
            path.unwrap_or_else(|| title.clone()),
            title,
        ),
        Some("fetch" | "search") => (ActionKind::Network, title.clone(), title),
        _ => (ActionKind::Tool, title.clone(), title),
    }
}

/// Maps `session/update` payloads. Chunks of one kind form one message, which
/// closes when another kind of update arrives.
#[derive(Default)]
struct UpdateMapper {
    text: Option<String>,
    reasoning: Option<String>,
    tools: HashSet<String>,
}

impl UpdateMapper {
    fn on_update(&mut self, update: &Value) -> Vec<EngineEvent> {
        let mut events = Vec::new();
        match update.get("sessionUpdate").and_then(Value::as_str) {
            Some("agent_message_chunk") => {
                self.close_reasoning(&mut events);
                let delta = chunk_text(update);
                let id = self.text.get_or_insert_with(new_id).clone();
                if !self.tools.contains(&format!("open:{id}")) {
                    self.tools.insert(format!("open:{id}"));
                    events.push(
                        AgUiEvent::TextMessageStart {
                            message_id: id.clone(),
                            role: "assistant".into(),
                        }
                        .into(),
                    );
                }
                events.push(
                    AgUiEvent::TextMessageContent {
                        message_id: id,
                        delta,
                    }
                    .into(),
                );
            }
            Some("agent_thought_chunk") => {
                self.close_text(&mut events);
                let delta = chunk_text(update);
                let id = self.reasoning.get_or_insert_with(new_id).clone();
                if !self.tools.contains(&format!("open:{id}")) {
                    self.tools.insert(format!("open:{id}"));
                    events.push(
                        AgUiEvent::ReasoningMessageStart {
                            message_id: id.clone(),
                            role: "reasoning".into(),
                        }
                        .into(),
                    );
                }
                events.push(
                    AgUiEvent::ReasoningMessageContent {
                        message_id: id,
                        delta,
                    }
                    .into(),
                );
            }
            Some("tool_call") => {
                self.close_text(&mut events);
                self.close_reasoning(&mut events);
                let id = field(update, "toolCallId");
                self.tools.insert(id.clone());
                events.push(
                    AgUiEvent::ToolCallStart {
                        tool_call_id: id.clone(),
                        tool_call_name: field(update, "title"),
                    }
                    .into(),
                );
                if let Some(input) = update.get("rawInput") {
                    events.push(
                        AgUiEvent::ToolCallArgs {
                            tool_call_id: id,
                            delta: input.to_string(),
                        }
                        .into(),
                    );
                }
            }
            Some("tool_call_update") => {
                let id = field(update, "toolCallId");
                let status = update.get("status").and_then(Value::as_str);
                if matches!(status, Some("completed" | "failed")) && self.tools.remove(&id) {
                    events.push(
                        AgUiEvent::ToolCallEnd {
                            tool_call_id: id.clone(),
                        }
                        .into(),
                    );
                    events.push(
                        AgUiEvent::ToolCallResult {
                            message_id: new_id(),
                            tool_call_id: id,
                            content: tool_output(update),
                            role: Some("tool".into()),
                        }
                        .into(),
                    );
                }
            }
            Some("available_commands_update") => {
                let listed = update.get("availableCommands").and_then(Value::as_array);
                events.push(EngineEvent::Commands(
                    listed
                        .into_iter()
                        .flatten()
                        .map(|command| (field(command, "name"), field(command, "description")))
                        .filter(|(name, _)| !name.is_empty())
                        .collect(),
                ));
            }
            Some("plan") => {
                let steps: Vec<Value> = update
                    .get("entries")
                    .and_then(Value::as_array)
                    .map(|entries| {
                        entries
                            .iter()
                            .map(|entry| {
                                json!({
                                    "title": field(entry, "content"),
                                    "status": field(entry, "status"),
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                events.push(
                    AgUiEvent::ActivitySnapshot {
                        message_id: "plan".into(),
                        activity_type: "plan".into(),
                        content: json!({ "steps": steps }),
                        replace: Some(true),
                    }
                    .into(),
                );
            }
            _ => {}
        }
        events
    }

    fn close_text(&mut self, events: &mut Vec<EngineEvent>) {
        if let Some(id) = self.text.take() {
            self.tools.remove(&format!("open:{id}"));
            events.push(AgUiEvent::TextMessageEnd { message_id: id }.into());
        }
    }

    fn close_reasoning(&mut self, events: &mut Vec<EngineEvent>) {
        if let Some(id) = self.reasoning.take() {
            self.tools.remove(&format!("open:{id}"));
            events.push(AgUiEvent::ReasoningMessageEnd { message_id: id }.into());
        }
    }

    fn close(&mut self) -> Vec<EngineEvent> {
        let mut events = Vec::new();
        self.close_text(&mut events);
        self.close_reasoning(&mut events);
        for id in self.tools.drain() {
            events.push(AgUiEvent::ToolCallEnd { tool_call_id: id }.into());
        }
        events
    }
}

fn chunk_text(update: &Value) -> String {
    update
        .pointer("/content/text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn tool_output(update: &Value) -> String {
    if let Some(output) = update.get("rawOutput") {
        return match output {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        };
    }
    update
        .get("content")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| part.pointer("/content/text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options() -> Value {
        json!({ "options": [
            { "optionId": "yes-always", "name": "Always", "kind": "allow_always" },
            { "optionId": "yes", "name": "Yes", "kind": "allow_once" },
            { "optionId": "no", "name": "No", "kind": "reject_once" },
        ]})
    }

    #[test]
    fn allow_picks_the_narrowest_grant() {
        assert_eq!(
            permission_outcome(&options(), &Verdict::Allow, false),
            json!({ "outcome": "selected", "optionId": "yes" })
        );
    }

    #[test]
    fn deny_picks_reject_and_missing_option_never_allows() {
        assert_eq!(
            permission_outcome(&options(), &Verdict::Deny("x".into()), false),
            json!({ "outcome": "selected", "optionId": "no" })
        );
        let only_allow = json!({ "options": [{ "optionId": "y", "kind": "allow_once" }] });
        assert_eq!(
            permission_outcome(&only_allow, &Verdict::Deny("x".into()), false),
            json!({ "outcome": "cancelled" })
        );
    }

    #[test]
    fn cancellation_answers_cancelled() {
        assert_eq!(
            permission_outcome(&options(), &Verdict::Allow, true),
            json!({ "outcome": "cancelled" })
        );
    }

    #[test]
    fn chunks_form_one_message_until_the_kind_changes() {
        let mut mapper = UpdateMapper::default();
        let chunk = json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "a" } });
        assert_eq!(mapper.on_update(&chunk).len(), 2);
        assert_eq!(mapper.on_update(&chunk).len(), 1);
        let tool = json!({ "sessionUpdate": "tool_call", "toolCallId": "c", "title": "ls" });
        assert_eq!(mapper.on_update(&tool).len(), 2);
        assert_eq!(mapper.close().len(), 1);
    }

    #[test]
    fn modes_and_config_options_are_listed_and_the_current_ones_marked() {
        let session = json!({
            "modes": { "currentModeId": "ask", "availableModes": [
                { "id": "ask", "name": "Ask", "description": "Asks first" },
                { "id": "code", "name": "Code" },
            ]},
            "configOptions": [
                { "id": "model", "name": "Model", "category": "model", "currentValue": "b",
                  "type": "select", "options": [
                    { "group": "one", "name": "One", "options": [{ "value": "a", "name": "A" }] },
                    { "value": "b", "name": "B", "description": "Big" },
                ]},
                { "id": "think", "name": "Thinking", "category": "thought_level",
                  "currentValue": "on", "type": "select",
                  "options": [{ "value": "on", "name": "On" }, { "value": "off", "name": "Off" }] },
                { "id": "broken", "name": "No choices", "options": [] },
            ],
        });
        let models = parse_models(&session);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "a");
        assert!(models[1].is_default);
        assert_eq!(models[1].description.as_deref(), Some("Big"));
        let options = parse_session_options(&session);
        assert_eq!(options.len(), 2, "{options:?}");
        assert_eq!(options[0].id, "mode");
        assert!(options[0].values[0].default);
        assert_eq!(options[1].id, "config:think");
        assert!(options[1].values[0].default);
    }

    #[test]
    fn a_mode_the_session_stopped_offering_fails_the_turn() {
        let session = json!({ "modes": { "availableModes": [{ "id": "code" }] } });
        require_offered(&session, MODE, "code").unwrap();
        let refused = require_offered(&session, MODE, "plan").unwrap_err();
        assert_eq!(refused.code(), "unsupported_option");
        assert!(require_offered(&json!({}), MODE, "code").is_err());
    }

    #[test]
    fn execute_targets_the_command_text() {
        let params = json!({ "toolCall": { "title": "List", "kind": "execute", "rawInput": { "command": "ls -a" } } });
        let (kind, target, _) = classify(&params);
        assert_eq!(kind, ActionKind::Command);
        assert_eq!(target, "ls -a");
    }
}
