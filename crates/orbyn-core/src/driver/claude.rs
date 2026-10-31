//! Claude Code through its own CLI in `-p` stream-json mode. The CLI keeps its
//! own login, so no authentication environment is touched and `--bare`, which
//! ignores OAuth, is never passed. Permissions reach Orbyn through the per-run
//! MCP `approve` tool, not through this process's stdio.

use std::ffi::OsString;
use std::path::Path;
use std::time::Duration;

use async_trait::async_trait;
use futures_util::StreamExt;
use orbyn_contracts::{
    AgUiEvent, EngineAgent, EngineCapabilities, EngineTier, ModelInfo, ModelOption,
    ModelOptionValue, SkillDelivery, ThreadUsage,
};
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::pipes::{
    EngineProcess, exit_message, lines, one_shot_cli, resolve_engine, spawn_engine,
    spawn_engine_with,
};
use super::{
    CLAUDE_APPROVE_TOOL, EngineDescriptor, EngineDriver, EngineEvent, EngineOutcome, EngineProbe,
    ItemRecord, MCP_SERVER_NAME, ModelCatalog, ProbeDir, RunHandle, RunKind, RunSpec, UpdatePlan,
    effort_option,
};
use crate::engines::maintenance;
use crate::engines::probe::{probe_cli, read_login};
use crate::error::{CoreError, Result};
use crate::selection::FAST_MODE;
use crate::util::{new_id, write_private};

const EXIT_GRACE: Duration = Duration::from_secs(3);
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(10);
const INITIALIZE_ID: &str = "orbyn-capabilities";
/// More than any real reply. A process that keeps talking is not answering.
const MAX_INITIALIZE_BYTES: usize = 4 * 1024 * 1024;
/// Efforts the docs name, for the stand-in list only.
const DOCUMENTED_EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];

pub struct ClaudeDriver {
    program: String,
}

impl ClaudeDriver {
    pub fn new(program: String) -> Self {
        Self { program }
    }
}

/// The exact command line for one run. Tests pin this.
pub fn run_args(spec: &RunSpec, mcp_config: &Path) -> Vec<OsString> {
    let mut args: Vec<OsString> = [
        "-p",
        "--output-format",
        "stream-json",
        "--input-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-mode",
        if spec.plan { "plan" } else { "default" },
        "--mcp-config",
    ]
    .iter()
    .map(OsString::from)
    .collect();
    args.push(mcp_config.into());
    // Reach for the checkout without moving the session: skills and instructions
    // still load from the library. On 2.1.150 this loads the checkout's skills, and
    // not its hooks or `.mcp.json`, which ran only when placed in the cwd.
    if spec.checkout != spec.cwd {
        args.push("--add-dir".into());
        args.push(spec.checkout.clone().into());
    }
    args.push("--permission-prompt-tool".into());
    args.push(CLAUDE_APPROVE_TOOL.into());
    if let Some(model) = &spec.model {
        args.push("--model".into());
        args.push(model.into());
    }
    if let Some(effort) = &spec.effort {
        args.push("--effort".into());
        args.push(effort.into());
    }
    if spec.options.contains_key(FAST_MODE) {
        args.push("--settings".into());
        args.push(run_settings_path(spec).into());
    }
    if let Some(session) = &spec.resume {
        args.push("--resume".into());
        args.push(session.into());
    }
    args
}

fn run_settings_path(spec: &RunSpec) -> std::path::PathBuf {
    spec.run_dir.join("settings.json")
}

/// The settings a run passes with `--settings`, which is how the CLI takes fast mode
/// in print mode. It reaches only a model that reports `supportsFastMode`, because
/// admission refuses the option anywhere else.
fn run_settings(spec: &RunSpec) -> Option<Value> {
    let fast = spec.options.get(FAST_MODE)?;
    Some(json!({ "fastMode": fast == "on" }))
}

/// The command line for reading capabilities. These flags are what keep it inert:
/// a real 2.1.150 ran a `SessionStart` hook and started a user-level MCP server
/// without them, even in an empty folder, and did neither with them. Hooks and
/// servers both live in the user's own config, so a temp folder is not enough.
pub fn capability_args(mcp_config: &Path, settings: &Path) -> Vec<OsString> {
    let mut args: Vec<OsString> = [
        "-p",
        "--output-format",
        "stream-json",
        "--input-format",
        "stream-json",
        "--verbose",
        "--no-session-persistence",
        "--strict-mcp-config",
        "--mcp-config",
    ]
    .iter()
    .map(OsString::from)
    .collect();
    args.push(mcp_config.into());
    args.push("--settings".into());
    args.push(settings.into());
    args
}

/// Servers from a claude.ai account are not in any config file, so these stay out
/// of reach of the flags above.
const CAPABILITY_ENV: &[(&str, &str)] = &[
    ("ENABLE_CLAUDEAI_MCP_SERVERS", "false"),
    ("CLAUDE_CODE_AUTO_CONNECT_IDE", "0"),
];

#[async_trait]
impl EngineDriver for ClaudeDriver {
    fn descriptor(&self) -> EngineDescriptor {
        EngineDescriptor {
            id: "claude".into(),
            name: "Claude Code".into(),
            tier: EngineTier::Native,
            capabilities: EngineCapabilities {
                streaming: true,
                approvals: true,
                resume: true,
                mcp: true,
                sandbox: false,
                managed: true,
                skill_delivery: vec![
                    SkillDelivery::NativeSkillRoot,
                    SkillDelivery::McpSkillServer,
                ],
                goal_control: false,
            },
        }
    }

    fn resolves_from_checkout(&self) -> bool {
        false
    }

    fn sign_in_command(&self) -> Option<&str> {
        Some("claude auth login")
    }

    async fn probe(&self) -> EngineProbe {
        let mut probe = probe_cli(&self.program, &["--version"]).await;
        if probe.path.is_some() {
            probe.auth =
                Some(read_login(&self.program, &["auth", "status"], parse_auth_status).await);
        }
        probe.sign_in_command = Some("claude auth login".into());
        probe
    }

    async fn update_plan(&self, probe: &EngineProbe) -> Option<UpdatePlan> {
        maintenance::plan_update(probe, &maintenance::CLAUDE).await
    }

    fn manual_hint(&self) -> Option<String> {
        Some("Update Claude Code with the installer you used, then refresh.".into())
    }

    fn npm_package(&self) -> Option<&str> {
        Some(maintenance::CLAUDE.npm_package)
    }

    /// Asks the CLI itself, which works logged out and spends no model usage. If it
    /// cannot say, the aliases its docs name stand in and say so.
    async fn models(&self) -> Result<Option<ModelCatalog>> {
        Ok(Some(match self.initialize().await {
            Ok(response) => parse_capabilities(&response),
            Err(error) => documented_catalog(error.public_message()),
        }))
    }

    /// The list follows the CLI and its login: signing in changes which models
    /// appear, and an update can change everything.
    async fn catalog_key(&self) -> Option<String> {
        let probe = self.probe().await;
        Some(format!("{:?}|{:?}", probe.version, probe.auth))
    }

    async fn one_shot(&self, prompt: &str, model: Option<&str>) -> Result<String> {
        let mut args = vec![
            "-p",
            "--output-format",
            "text",
            "--tools",
            "",
            "--no-session-persistence",
        ];
        if let Some(model) = model {
            args.extend(["--model", model]);
        }
        one_shot_cli(&self.program, &args, prompt).await
    }

    async fn start_run(
        &self,
        spec: RunSpec,
        events: mpsc::Sender<EngineEvent>,
    ) -> Result<RunHandle> {
        let command = resolve_engine(&self.program)?;
        let mcp_config = spec.run_dir.join("mcp.json");
        let config = json!({
            "mcpServers": { (MCP_SERVER_NAME): { "type": "http", "url": spec.mcp_url } }
        });
        write_private(&mcp_config, config.to_string().as_bytes())?;
        if let Some(settings) = run_settings(&spec) {
            write_private(&run_settings_path(&spec), settings.to_string().as_bytes())?;
        }
        let args = run_args(&spec, &mcp_config);
        let process = spawn_engine(&command, &args, &spec.cwd)?;
        let cancel = CancellationToken::new();
        let (input, steering) = mpsc::unbounded_channel();
        let task = tokio::spawn(run_protocol(
            process,
            spec,
            events,
            steering,
            cancel.clone(),
        ));
        Ok(RunHandle {
            cancel,
            task,
            input: Some(input),
        })
    }
}

impl ClaudeDriver {
    /// Reads the CLI's `initialize` response from a process that never gets a
    /// prompt, in an empty folder of its own.
    async fn initialize(&self) -> Result<Value> {
        let command = resolve_engine(&self.program)?;
        let dir = ProbeDir::new()?;
        let mcp_config = dir.path().join("mcp.json");
        let settings = dir.path().join("settings.json");
        write_private(
            &mcp_config,
            json!({ "mcpServers": {} }).to_string().as_bytes(),
        )?;
        write_private(
            &settings,
            json!({ "disableAllHooks": true }).to_string().as_bytes(),
        )?;
        let args = capability_args(&mcp_config, &settings);
        let mut process = spawn_engine_with(&command, &args, dir.path(), CAPABILITY_ENV)?;
        let frame = json!({
            "type": "control_request",
            "request_id": INITIALIZE_ID,
            "request": { "subtype": "initialize" },
        });
        process
            .stdin
            .write_all(format!("{frame}\n").as_bytes())
            .await?;
        process.stdin.flush().await?;
        let answer = tokio::time::timeout(INITIALIZE_TIMEOUT, read_initialize(process.stdout));
        let response = answer.await.map_err(|_| {
            CoreError::EngineUnavailable("Claude Code did not say what it offers in time.".into())
        })?;
        match response {
            Some(response) => Ok(response),
            None => {
                let status = process.child.wait().await.ok();
                Err(CoreError::EngineUnavailable(
                    exit_message(status, &process.stderr).await,
                ))
            }
        }
    }
}

/// The body of the matching `control_response`, or `None` if the stream ended. The
/// reply carries account details, so it is never logged, and only the fields
/// `parse_capabilities` names leave this file.
async fn read_initialize(stdout: tokio::process::ChildStdout) -> Option<Value> {
    let mut stream = lines(stdout);
    let mut seen = 0;
    while let Some(line) = stream.next().await {
        let Ok(line) = line else { continue };
        seen += line.len();
        if seen > MAX_INITIALIZE_BYTES {
            return None;
        }
        let Ok(frame) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if frame.get("type").and_then(Value::as_str) != Some("control_response") {
            continue;
        }
        let reply = frame.get("response")?;
        if reply.get("request_id").and_then(Value::as_str) != Some(INITIALIZE_ID) {
            continue;
        }
        return reply.get("response").cloned();
    }
    None
}

/// Turns an `initialize` response into a catalog. Each model's effort list is its
/// own, and a model that reports no effort support gets no effort option.
pub fn parse_capabilities(response: &Value) -> ModelCatalog {
    let list = |key: &str| response.get(key).and_then(Value::as_array);
    let reported = list("models").into_iter().flatten();
    let mut models: Vec<ModelInfo> = reported.filter_map(parse_claude_model).collect();
    if !models.iter().any(|model| model.is_default)
        && let Some(first) = models.first_mut()
    {
        first.is_default = true;
    }
    ModelCatalog {
        models,
        commands: list("commands")
            .into_iter()
            .flatten()
            .filter_map(|command| {
                Some((
                    text_of(command, "name")?,
                    text_of(command, "description").unwrap_or_default(),
                ))
            })
            .collect(),
        agents: list("agents")
            .into_iter()
            .flatten()
            .filter_map(|agent| {
                Some(EngineAgent {
                    name: text_of(agent, "name")?,
                    description: text_of(agent, "description").unwrap_or_default(),
                    model: text_of(agent, "model"),
                })
            })
            .collect(),
        output_styles: list("available_output_styles")
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        output_style: text_of(response, "output_style"),
        ..ModelCatalog::engine(Vec::new())
    }
}

fn parse_claude_model(model: &Value) -> Option<ModelInfo> {
    let id = text_of(model, "value")?;
    let flag = |key: &str| model.get(key).and_then(Value::as_bool) == Some(true);
    let mut options = Vec::new();
    let levels: Vec<&str> = model
        .get("supportedEffortLevels")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    if flag("supportsEffort") && !levels.is_empty() {
        options.push(effort_option(levels, None));
    }
    if flag("supportsFastMode") {
        options.push(fast_option());
    }
    Some(ModelInfo {
        label: text_of(model, "displayName").unwrap_or_else(|| id.clone()),
        description: text_of(model, "description"),
        is_default: id == "default",
        custom: false,
        options,
        input_modalities: Vec::new(),
        upgrade: None,
        id,
    })
}

fn fast_option() -> ModelOption {
    let value = |id: &str, label: &str, default: bool| ModelOptionValue {
        id: id.to_owned(),
        label: label.to_owned(),
        default,
        description: None,
    };
    ModelOption {
        id: FAST_MODE.to_owned(),
        label: "Speed".to_owned(),
        values: vec![value("off", "Standard", true), value("on", "Fast", false)],
    }
}

/// The aliases the CLI's docs name, for when it cannot be asked. An alias tracks the
/// vendor's latest, and any full model name also works as a custom model.
fn documented_catalog(reason: String) -> ModelCatalog {
    let model = |id: &str, label: &str, description: &str, is_default: bool| ModelInfo {
        id: id.to_owned(),
        label: label.to_owned(),
        description: Some(description.to_owned()),
        is_default,
        custom: false,
        options: vec![effort_option(DOCUMENTED_EFFORTS.iter().copied(), None)],
        input_modalities: Vec::new(),
        upgrade: None,
    };
    ModelCatalog {
        source: "documented",
        fallback: Some(reason),
        models: vec![
            model(
                "default",
                "Default",
                "What Claude Code picks for your plan",
                true,
            ),
            model("sonnet", "Sonnet", "The latest Sonnet", false),
            model("opus", "Opus", "The latest Opus", false),
            model("haiku", "Haiku", "The latest Haiku", false),
            model(
                "sonnet[1m]",
                "Sonnet (1M context)",
                "Sonnet with a 1M context window",
                false,
            ),
            model(
                "opus[1m]",
                "Opus (1M context)",
                "Opus with a 1M context window",
                false,
            ),
            model(
                "opusplan",
                "Opus for planning",
                "Opus in plan mode, Sonnet otherwise",
                false,
            ),
        ],
        ..ModelCatalog::default()
    }
}

async fn run_protocol(
    mut process: EngineProcess,
    spec: RunSpec,
    events: mpsc::Sender<EngineEvent>,
    mut steering: mpsc::UnboundedReceiver<String>,
    cancel: CancellationToken,
) {
    // The prompt goes over stdin, never argv: it can exceed ARG_MAX and argv is
    // visible to other processes.
    let prompt = user_message(&spec);
    let wrote = async {
        process.stdin.write_all(prompt.as_bytes()).await?;
        process.stdin.write_all(b"\n").await?;
        process.stdin.flush().await
    }
    .await;
    if let Err(error) = wrote {
        tracing::debug!(%error, "could not write the prompt");
    }
    let mut stdin = process.stdin;
    let mut mapper = StreamMapper::default();
    let mut stream = lines(process.stdout);
    let mut outcome = None;
    let stream_ended = loop {
        tokio::select! {
            biased;
            () = cancel.cancelled() => break false,
            Some(text) = steering.recv() => {
                // The CLI folds a message sent mid-turn into the running turn.
                let frame = format!("{}\n", user_frame(&text));
                if let Err(error) = stdin.write_all(frame.as_bytes()).await {
                    tracing::debug!(%error, "could not steer the run");
                }
                let _ = stdin.flush().await;
            }
            line = stream.next() => {
                let Some(line) = line else { break true };
                let Ok(line) = line else { continue };
                let Ok(frame) = serde_json::from_str::<Value>(&line) else {
                    tracing::debug!("skipping a non-JSON Claude line");
                    continue;
                };
                for event in mapper.on_frame(&frame) {
                    if events.send(event).await.is_err() {
                        return;
                    }
                }
                if let Some(result) = mapper.outcome.take() {
                    outcome = Some(result);
                    break false;
                }
            }
        }
    };
    // Closing stdin is the CLI's signal to exit.
    drop(stdin);
    for event in mapper.close_open_blocks() {
        let _ = events.send(event).await;
    }
    let cancelled = cancel.is_cancelled();
    let status = match tokio::time::timeout(EXIT_GRACE, process.child.wait()).await {
        Ok(status) => status.ok(),
        Err(_) => {
            process.child.terminate();
            None
        }
    };
    let outcome = match (outcome, cancelled, stream_ended) {
        (_, true, _) => EngineOutcome::Cancelled,
        (Some(result), _, _) => result,
        _ => {
            let message = exit_message(status, &process.stderr).await;
            if message.contains(NO_SESSION) {
                EngineOutcome::SessionLost
            } else {
                EngineOutcome::Failed(message)
            }
        }
    };
    let _ = events.send(EngineEvent::Finished(outcome)).await;
}

/// How the CLI reports a `--resume` id it does not have.
const NO_SESSION: &str = "No conversation found";

/// Slash commands reach the CLI bare, or it would read them as ordinary text.
fn user_message(spec: &RunSpec) -> String {
    match spec.kind {
        RunKind::Turn => user_frame(&spec.prompt),
        _ => user_frame(&spec.user_prompt),
    }
}

fn user_frame(text: &str) -> String {
    json!({ "type": "user", "message": { "role": "user", "content": text } }).to_string()
}

fn parse_auth_status(status: i32, stdout: &str) -> orbyn_contracts::AuthState {
    use orbyn_contracts::AuthState;
    match serde_json::from_str::<Value>(stdout) {
        Ok(value) => match value.get("loggedIn").and_then(Value::as_bool) {
            Some(true) => AuthState::LoggedIn,
            Some(false) => AuthState::LoggedOut,
            None => AuthState::Unknown,
        },
        Err(_) if status == 0 => AuthState::Unknown,
        Err(_) => AuthState::LoggedOut,
    }
}

#[derive(Clone)]
enum Block {
    Text(String),
    Reasoning(String),
    Tool(String),
}

/// Maps Claude stream-json frames to events. Text and tool input come from the
/// `stream_event` partials; `assistant` frames only fill in when partials were absent.
#[derive(Default)]
struct StreamMapper {
    blocks: Vec<(u64, Block)>,
    saw_partials: bool,
    outcome: Option<EngineOutcome>,
}

impl StreamMapper {
    fn on_frame(&mut self, frame: &Value) -> Vec<EngineEvent> {
        // Subagent traffic carries a parent; the run shows its top-level turn.
        let nested = frame
            .get("parent_tool_use_id")
            .is_some_and(|parent| !parent.is_null());
        match frame.get("type").and_then(Value::as_str) {
            Some("system") if frame.get("subtype").and_then(Value::as_str) == Some("init") => {
                let mut events = session(frame);
                events.extend(init_commands(frame));
                events
            }
            Some("stream_event") if !nested => frame
                .get("event")
                .map_or_else(Vec::new, |event| self.on_stream_event(event)),
            Some("assistant") if !nested => self.on_assistant(frame),
            Some("user") if !nested => on_user(frame),
            Some("assistant") => vec![
                AgUiEvent::Custom {
                    name: "subagent.activity".into(),
                    value: json!({ "parentToolCallId": frame.get("parent_tool_use_id") }),
                }
                .into(),
            ],
            Some("result") => {
                self.outcome = Some(result_outcome(frame));
                let mut events = session(frame);
                events.extend(frame.get("usage").map(usage_event));
                events
            }
            _ => Vec::new(),
        }
    }

    fn on_stream_event(&mut self, event: &Value) -> Vec<EngineEvent> {
        self.saw_partials = true;
        let index = event.get("index").and_then(Value::as_u64).unwrap_or(0);
        match event.get("type").and_then(Value::as_str) {
            Some("content_block_start") => {
                let Some(block) = event.get("content_block") else {
                    return Vec::new();
                };
                self.open_block(index, block)
            }
            Some("content_block_delta") => {
                let Some(open) = self.block(index) else {
                    return Vec::new();
                };
                let delta = event.get("delta").cloned().unwrap_or(Value::Null);
                match (&open, delta.get("type").and_then(Value::as_str)) {
                    (Block::Text(id), Some("text_delta")) => text_of(&delta, "text")
                        .map(|text| AgUiEvent::TextMessageContent {
                            message_id: id.clone(),
                            delta: text,
                        })
                        .into_iter()
                        .map(Into::into)
                        .collect(),
                    (Block::Reasoning(id), Some("thinking_delta")) => text_of(&delta, "thinking")
                        .map(|text| AgUiEvent::ReasoningMessageContent {
                            message_id: id.clone(),
                            delta: text,
                        })
                        .into_iter()
                        .map(Into::into)
                        .collect(),
                    (Block::Tool(id), Some("input_json_delta")) => text_of(&delta, "partial_json")
                        .map(|text| AgUiEvent::ToolCallArgs {
                            tool_call_id: id.clone(),
                            delta: text,
                        })
                        .into_iter()
                        .map(Into::into)
                        .collect(),
                    _ => Vec::new(),
                }
            }
            Some("content_block_stop") => {
                let position = self.blocks.iter().position(|(open, _)| *open == index);
                position
                    .map(|position| vec![end_event(&self.blocks.remove(position).1).into()])
                    .unwrap_or_default()
            }
            _ => Vec::new(),
        }
    }

    fn block(&self, index: u64) -> Option<Block> {
        self.blocks
            .iter()
            .find(|(open, _)| *open == index)
            .map(|(_, block)| block.clone())
    }

    fn open_block(&mut self, index: u64, block: &Value) -> Vec<EngineEvent> {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                let id = new_id();
                self.blocks.push((index, Block::Text(id.clone())));
                vec![
                    AgUiEvent::TextMessageStart {
                        message_id: id,
                        role: "assistant".into(),
                    }
                    .into(),
                ]
            }
            Some("thinking") => {
                let id = new_id();
                self.blocks.push((index, Block::Reasoning(id.clone())));
                vec![
                    AgUiEvent::ReasoningMessageStart {
                        message_id: id,
                        role: "reasoning".into(),
                    }
                    .into(),
                ]
            }
            Some("tool_use") => {
                let id = text_of(block, "id").unwrap_or_else(new_id);
                self.blocks.push((index, Block::Tool(id.clone())));
                vec![
                    AgUiEvent::ToolCallStart {
                        tool_call_id: id,
                        tool_call_name: text_of(block, "name").unwrap_or_else(|| "tool".into()),
                    }
                    .into(),
                ]
            }
            _ => Vec::new(),
        }
    }

    fn on_assistant(&mut self, frame: &Value) -> Vec<EngineEvent> {
        let content = frame
            .pointer("/message/content")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut events: Vec<EngineEvent> = content
            .iter()
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("tool_use"))
            .filter_map(|block| {
                Some(EngineEvent::Item(ItemRecord {
                    id: text_of(block, "id")?,
                    kind: "tool_use".to_owned(),
                    raw: block.clone(),
                    exit_code: None,
                }))
            })
            .collect();
        if self.saw_partials {
            return events;
        }
        for block in content {
            match block.get("type").and_then(Value::as_str) {
                Some("text") => {
                    let id = new_id();
                    events.push(
                        AgUiEvent::TextMessageStart {
                            message_id: id.clone(),
                            role: "assistant".into(),
                        }
                        .into(),
                    );
                    events.push(
                        AgUiEvent::TextMessageContent {
                            message_id: id.clone(),
                            delta: text_of(&block, "text").unwrap_or_default(),
                        }
                        .into(),
                    );
                    events.push(AgUiEvent::TextMessageEnd { message_id: id }.into());
                }
                Some("tool_use") => {
                    let id = text_of(&block, "id").unwrap_or_else(new_id);
                    events.push(
                        AgUiEvent::ToolCallStart {
                            tool_call_id: id.clone(),
                            tool_call_name: text_of(&block, "name")
                                .unwrap_or_else(|| "tool".into()),
                        }
                        .into(),
                    );
                    events.push(
                        AgUiEvent::ToolCallArgs {
                            tool_call_id: id.clone(),
                            delta: block.get("input").map(Value::to_string).unwrap_or_default(),
                        }
                        .into(),
                    );
                    events.push(AgUiEvent::ToolCallEnd { tool_call_id: id }.into());
                }
                _ => {}
            }
        }
        events
    }

    fn close_open_blocks(&mut self) -> Vec<EngineEvent> {
        self.blocks
            .drain(..)
            .map(|(_, block)| end_event(&block).into())
            .collect()
    }
}

fn end_event(block: &Block) -> AgUiEvent {
    match block {
        Block::Text(id) => AgUiEvent::TextMessageEnd {
            message_id: id.clone(),
        },
        Block::Reasoning(id) => AgUiEvent::ReasoningMessageEnd {
            message_id: id.clone(),
        },
        Block::Tool(id) => AgUiEvent::ToolCallEnd {
            tool_call_id: id.clone(),
        },
    }
}

fn usage_event(usage: &Value) -> EngineEvent {
    let count = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
    let total = count("input_tokens")
        + count("output_tokens")
        + count("cache_read_input_tokens")
        + count("cache_creation_input_tokens");
    EngineEvent::Usage(ThreadUsage {
        total_tokens: Some(total),
        context_window: None,
        raw: usage.clone(),
    })
}

fn session(frame: &Value) -> Vec<EngineEvent> {
    text_of(frame, "session_id")
        .map(EngineEvent::Session)
        .into_iter()
        .collect()
}

/// The init frame lists names alone.
fn init_commands(frame: &Value) -> Option<EngineEvent> {
    let names = frame.get("slash_commands")?.as_array()?;
    Some(EngineEvent::Commands(
        names
            .iter()
            .filter_map(Value::as_str)
            .map(|name| (name.to_owned(), String::new()))
            .collect(),
    ))
}

fn text_of(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn on_user(frame: &Value) -> Vec<EngineEvent> {
    let Some(content) = frame.pointer("/message/content").and_then(Value::as_array) else {
        return Vec::new();
    };
    content
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("tool_result"))
        .filter_map(|block| {
            Some(
                AgUiEvent::ToolCallResult {
                    message_id: new_id(),
                    tool_call_id: text_of(block, "tool_use_id")?,
                    content: tool_text(block.get("content")),
                    role: Some("tool".into()),
                }
                .into(),
            )
        })
        .collect()
}

fn tool_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

fn result_outcome(frame: &Value) -> EngineOutcome {
    let failed = frame.get("is_error").and_then(Value::as_bool) == Some(true)
        || frame
            .get("subtype")
            .and_then(Value::as_str)
            .is_some_and(|subtype| subtype != "success");
    if !failed {
        return EngineOutcome::Completed;
    }
    let lost = |text: &str| text.contains(NO_SESSION);
    let errors = frame.get("errors").and_then(Value::as_array).map(|errors| {
        errors
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join("; ")
    });
    let message = errors
        .filter(|text| !text.is_empty())
        .or_else(|| text_of(frame, "result").filter(|text| !text.is_empty()))
        .or_else(|| text_of(frame, "subtype"))
        .unwrap_or_else(|| "Claude ended the turn with an error.".to_owned());
    if lost(&message) {
        return EngineOutcome::SessionLost;
    }
    EngineOutcome::Failed(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn spec() -> RunSpec {
        RunSpec {
            run_id: "r".into(),
            thread_id: "t".into(),
            cwd: PathBuf::from("/workspace"),
            checkout: PathBuf::from("/workspace/repo/app"),
            prompt: "hello".into(),
            user_prompt: "hello".into(),
            kind: RunKind::Turn,
            mode: orbyn_contracts::PermissionMode::Supervised,
            plan: false,
            model: Some("sonnet".into()),
            effort: None,
            options: std::collections::BTreeMap::new(),
            resume: Some("sess".into()),
            mcp_url: Some("http://127.0.0.1:1/mcp/x".into()),
            run_dir: PathBuf::from("/run"),
        }
    }

    #[test]
    fn command_line_matches_the_contract_and_never_uses_bare() {
        let args: Vec<String> = run_args(&spec(), Path::new("/run/mcp.json"))
            .into_iter()
            .map(|arg| arg.into_string().unwrap())
            .collect();
        assert_eq!(
            args,
            [
                "-p",
                "--output-format",
                "stream-json",
                "--input-format",
                "stream-json",
                "--verbose",
                "--include-partial-messages",
                "--permission-mode",
                "default",
                "--mcp-config",
                "/run/mcp.json",
                "--add-dir",
                "/workspace/repo/app",
                "--permission-prompt-tool",
                "mcp__orbyn_engineering__approve",
                "--model",
                "sonnet",
                "--resume",
                "sess",
            ]
        );
        assert!(
            !args
                .iter()
                .any(|arg| arg == "--bare" || arg == "--plugin-dir")
        );
    }

    #[test]
    fn capability_reads_cannot_start_servers_or_hooks_and_never_use_bare() {
        let args: Vec<String> = capability_args(Path::new("/p/mcp.json"), Path::new("/p/s.json"))
            .into_iter()
            .map(|arg| arg.into_string().unwrap())
            .collect();
        for flag in ["--strict-mcp-config", "--no-session-persistence"] {
            assert!(args.iter().any(|arg| arg == flag), "{flag}");
        }
        let after = |flag: &str| {
            let at = args.iter().position(|arg| arg == flag).unwrap();
            args[at + 1].clone()
        };
        assert_eq!(after("--mcp-config"), "/p/mcp.json");
        assert_eq!(after("--settings"), "/p/s.json");
        assert!(!args.iter().any(|arg| arg == "--bare"));
        assert!(CAPABILITY_ENV.contains(&("ENABLE_CLAUDEAI_MCP_SERVERS", "false")));
    }

    /// The shape of a real 2.1.150 reply, with the account block it also carries.
    fn initialize_reply() -> Value {
        json!({
            "models": [
                { "value": "default", "displayName": "Default (recommended)",
                  "description": "The default", "supportsEffort": true,
                  "supportedEffortLevels": ["low", "medium", "high", "xhigh", "max"],
                  "supportsAdaptiveThinking": true, "supportsAutoMode": true },
                { "value": "sonnet", "displayName": "Sonnet", "supportsEffort": true,
                  "supportedEffortLevels": ["low", "medium", "high", "max"] },
                { "value": "opus", "displayName": "Opus", "supportsEffort": true,
                  "supportedEffortLevels": ["low"], "supportsFastMode": true },
                { "value": "haiku", "displayName": "Haiku", "description": "Fastest" },
            ],
            "commands": [{ "name": "review", "description": "Review a change" }],
            "agents": [{ "name": "Explore", "description": "Search", "model": "haiku" }],
            "available_output_styles": ["default", "Learning"],
            "output_style": "default",
            "account": { "email": "person@example.com", "organization": "Secret Co" },
            "pid": 12,
        })
    }

    #[test]
    fn each_model_keeps_its_own_efforts_and_only_a_supporting_one_offers_speed() {
        let catalog = parse_capabilities(&initialize_reply());
        assert_eq!(catalog.source, "engine");
        assert_eq!(catalog.fallback, None);
        let efforts = |id: &str| -> Vec<String> {
            let model = catalog.models.iter().find(|model| model.id == id).unwrap();
            model
                .options
                .iter()
                .filter(|option| option.id == "effort")
                .flat_map(|option| option.values.iter().map(|value| value.id.clone()))
                .collect()
        };
        assert_eq!(efforts("sonnet"), ["low", "medium", "high", "max"]);
        assert_eq!(efforts("default").len(), 5);
        assert!(efforts("haiku").is_empty());
        assert!(catalog.models[0].is_default);
        let with_fast: Vec<&str> = catalog
            .models
            .iter()
            .filter(|model| model.options.iter().any(|option| option.id == FAST_MODE))
            .map(|model| model.id.as_str())
            .collect();
        assert_eq!(with_fast, ["opus"]);
        assert_eq!(catalog.commands[0].0, "review");
        assert_eq!(catalog.agents[0].name, "Explore");
        assert_eq!(catalog.output_styles, ["default", "Learning"]);
    }

    /// A real 2.1.150 reply to `initialize`, read logged out from an empty config
    /// folder, with its account block and pid removed.
    const RECORDED: &str = include_str!("fixtures/claude-2.1.150-initialize.json");

    #[test]
    fn a_recorded_reply_parses_as_the_live_one_will() {
        let frame: Value = serde_json::from_str(RECORDED).unwrap();
        assert_eq!(frame["type"], "control_response");
        assert_eq!(frame["response"]["request_id"], INITIALIZE_ID);
        let catalog = parse_capabilities(&frame["response"]["response"]);
        assert!(catalog.models.iter().any(|model| model.is_default));
        let sonnet = catalog
            .models
            .iter()
            .find(|model| model.id == "sonnet")
            .unwrap();
        assert_eq!(sonnet.options[0].id, "effort");
        assert!(!sonnet.options[0].values.is_empty());
        let haiku = catalog
            .models
            .iter()
            .find(|model| model.id == "haiku")
            .unwrap();
        assert!(haiku.options.is_empty());
        assert!(!catalog.output_styles.is_empty());
        assert!(!catalog.agents.is_empty());
    }

    /// `cargo test -p orbyn-core live_ -- --ignored`. Needs the CLI, spends no usage.
    #[tokio::test]
    #[ignore = "needs a real Claude Code"]
    async fn live_catalog_is_the_engines_own() {
        let catalog = ClaudeDriver::new("claude".into())
            .models()
            .await
            .unwrap()
            .unwrap();
        assert_eq!(catalog.source, "engine", "{:?}", catalog.fallback);
        assert!(!catalog.models.is_empty());
    }

    #[test]
    fn the_account_block_never_reaches_a_catalog() {
        let catalog = parse_capabilities(&initialize_reply());
        let text = format!("{catalog:?}");
        assert!(!text.contains("person@example.com"), "{text}");
        assert!(!text.contains("Secret Co"), "{text}");
    }

    #[test]
    fn the_stand_in_list_says_it_is_one_and_why() {
        let catalog = documented_catalog("no answer".into());
        assert_eq!(catalog.source, "documented");
        assert_eq!(catalog.fallback.as_deref(), Some("no answer"));
        assert!(catalog.models.iter().any(|model| model.id == "opus"));
    }

    #[test]
    fn speed_goes_through_settings_and_only_when_chosen() {
        let plain = spec();
        assert_eq!(run_settings(&plain), None);
        assert!(
            !run_args(&plain, Path::new("/m"))
                .iter()
                .any(|a| a == "--settings")
        );
        let mut fast = spec();
        fast.options.insert(FAST_MODE.into(), "on".into());
        assert_eq!(run_settings(&fast), Some(json!({ "fastMode": true })));
        let args = run_args(&fast, Path::new("/m"));
        let at = args.iter().position(|arg| arg == "--settings").unwrap();
        assert_eq!(args[at + 1], "/run/settings.json");
        fast.options.insert(FAST_MODE.into(), "off".into());
        assert_eq!(run_settings(&fast), Some(json!({ "fastMode": false })));
    }

    #[test]
    fn the_checkout_is_added_by_path_and_only_when_it_is_elsewhere() {
        let mut elsewhere = spec();
        elsewhere.cwd = "/library".into();
        elsewhere.checkout = "/work/app".into();
        let args = run_args(&elsewhere, Path::new("/tmp/mcp.json"));
        let at = args.iter().position(|arg| arg == "--add-dir").unwrap();
        assert_eq!(args[at + 1], "/work/app");
        let mut same = spec();
        same.checkout = same.cwd.clone();
        let args = run_args(&same, Path::new("/tmp/mcp.json"));
        assert!(!args.iter().any(|arg| arg == "--add-dir"));
    }

    #[test]
    fn permission_tool_follows_the_server_name() {
        assert_eq!(
            CLAUDE_APPROVE_TOOL,
            format!("mcp__{MCP_SERVER_NAME}__approve")
        );
    }

    #[test]
    fn real_logged_out_status_is_read_from_json() {
        let text = "{\n  \"loggedIn\": false,\n  \"authMethod\": \"none\",\n  \"apiProvider\": \"firstParty\"\n}\n";
        assert_eq!(
            parse_auth_status(1, text),
            orbyn_contracts::AuthState::LoggedOut
        );
    }

    #[test]
    fn partials_are_not_duplicated_by_the_assistant_frame() {
        let mut mapper = StreamMapper::default();
        let frames = [
            json!({"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text"}}}),
            json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}}),
            json!({"type":"stream_event","event":{"type":"content_block_stop","index":0}}),
            json!({"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}),
        ];
        let events: Vec<_> = frames.iter().flat_map(|f| mapper.on_frame(f)).collect();
        assert_eq!(events.len(), 3);
    }

    #[test]
    fn subagent_messages_are_reported_without_joining_the_turn() {
        let mut mapper = StreamMapper::default();
        let events = mapper.on_frame(&json!({
            "type":"assistant","parent_tool_use_id":"toolu_1",
            "message":{"content":[{"type":"text","text":"inner"}]}
        }));
        assert_eq!(events.len(), 1);
        assert!(matches!(
            &events[0],
            EngineEvent::Agui(AgUiEvent::Custom { name, .. }) if name == "subagent.activity"
        ));
    }

    #[test]
    fn result_usage_adds_every_token_kind() {
        let mut mapper = StreamMapper::default();
        let events = mapper.on_frame(&json!({
            "type":"result","subtype":"success","is_error":false,
            "usage":{"input_tokens":1,"output_tokens":2,"cache_read_input_tokens":3}
        }));
        assert!(events.iter().any(|event| matches!(
            event, EngineEvent::Usage(usage) if usage.total_tokens == Some(6)
        )));
    }

    #[test]
    fn subagent_frames_stay_out_of_the_top_level_turn() {
        let mut mapper = StreamMapper::default();
        let frame = json!({
            "type":"stream_event",
            "parent_tool_use_id":"toolu_1",
            "event":{"type":"content_block_start","index":0,"content_block":{"type":"text"}}
        });
        assert!(mapper.on_frame(&frame).is_empty());
    }

    #[test]
    fn error_result_reports_its_reason() {
        let mut mapper = StreamMapper::default();
        mapper.on_frame(&json!({
            "type":"result","subtype":"error_during_execution","is_error":true,
            "errors":["Not logged in"],"session_id":"s"
        }));
        assert_eq!(
            mapper.outcome,
            Some(EngineOutcome::Failed("Not logged in".into()))
        );
    }
}
