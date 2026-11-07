//! Claude Code through its own CLI in `-p` stream-json mode. The CLI keeps its
//! own login, so no authentication environment is touched and `--bare`, which
//! ignores OAuth, is never passed. Permissions reach Orbyn through the per-run
//! MCP `approve` tool, not through this process's stdio.

mod usage;
mod workflows;

use usage::parse_usage_report;
use workflows::Workflows;

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use futures_util::StreamExt;
use orbyn_contracts::{
    AgUiEvent, EngineAgent, EngineCapabilities, EngineTier, ModelInfo, ModelOption,
    ModelOptionValue, ProviderInstance, SkillDelivery, ThreadUsage,
};
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio_util::codec::{FramedRead, LinesCodec};
use tokio_util::sync::CancellationToken;

use super::pipes::{
    EngineProcess, exit_message, lines, one_shot_at, one_shot_cli, resolve_engine, spawn_engine,
    spawn_engine_with,
};
use super::{
    CLAUDE_APPROVE_TOOL, EngineDescriptor, EngineDriver, EngineEvent, EngineOutcome, EngineProbe,
    ItemRecord, MCP_SERVER_NAME, ModelCatalog, ProbeDir, RunControl, RunHandle, RunKind, RunSpec,
    UpdatePlan, WarmProcess, effort_option, proposed_plan_events,
};
use crate::agents::console::{ConsoleCommand, ConsoleSpec};
use crate::agents::engines::maintenance;
use crate::agents::engines::probe::{probe_cli, read_login};
use crate::agents::selection::FAST_MODE;
use crate::error::{CoreError, Result};
use crate::util::{new_id, write_private};

const EXIT_GRACE: Duration = Duration::from_secs(3);
/// How long a run held open for a workflow waits, once the last one ends, for the
/// follow-up turn the CLI starts after a finished workflow. A stopped one starts none.
const HOLD_GRACE: Duration = Duration::from_secs(5);
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(10);
const INITIALIZE_ID: &str = "orbyn-capabilities";
const USAGE_ID: &str = "orbyn-usage";
const USAGE_TIMEOUT: Duration = Duration::from_secs(4);
/// More than any real reply. A process that keeps talking is not answering.
const MAX_INITIALIZE_BYTES: usize = 4 * 1024 * 1024;
/// Efforts the docs name, for the stand-in list only.
const DOCUMENTED_EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];

pub struct ClaudeDriver {
    program: String,
    /// The id and name of an instance, when this is one.
    named: Option<(String, String)>,
    /// Tokens before Claude compacts, from the instance.
    auto_compact_window: Option<u32>,
}

impl ClaudeDriver {
    pub fn new(program: String) -> Self {
        Self {
            program,
            named: None,
            auto_compact_window: None,
        }
    }
}

/// The exact command line for one run. Tests pin this.
pub fn run_args(spec: &RunSpec, mcp_config: &Path, window: Option<u32>) -> Vec<OsString> {
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
    if run_settings(spec, window).is_some() {
        args.push("--settings".into());
        args.push(run_settings_path(spec).into());
    }
    if let Some(session) = &spec.resume {
        args.push("--resume".into());
        args.push(session.into());
    }
    args
}

/// Claude's interactive command line on a run's session. Runs start at the
/// library, where Claude keeps the session, and reach the checkout with `--add-dir`.
pub fn console_args(console: &ConsoleSpec<'_>) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec!["--resume".into(), console.session.into()];
    if let Some(model) = console.model {
        args.extend(["--model".into(), model.into()]);
    }
    args.extend([
        "--permission-mode".into(),
        if console.plan { "plan" } else { "default" }.into(),
    ]);
    if console.checkout != console.root {
        args.extend(["--add-dir".into(), console.checkout.into()]);
    }
    args
}

fn run_settings_path(spec: &RunSpec) -> std::path::PathBuf {
    spec.run_dir.join("settings.json")
}

/// The settings a run passes with `--settings`, which is how the CLI takes fast mode
/// in print mode. It reaches only a model that reports `supportsFastMode`, because
/// admission refuses the option anywhere else.
fn run_settings(spec: &RunSpec, window: Option<u32>) -> Option<Value> {
    let mut settings = serde_json::Map::new();
    if let Some(fast) = spec.options.get(FAST_MODE) {
        settings.insert("fastMode".into(), json!(fast == "on"));
    }
    if let Some(window) = window {
        settings.insert("autoCompactWindow".into(), json!(window));
    }
    (!settings.is_empty()).then_some(Value::Object(settings))
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
        let (id, name) = self
            .named
            .clone()
            .unwrap_or_else(|| ("claude".into(), "Claude Code".into()));
        EngineDescriptor {
            id,
            name,
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
                decline_feedback: true,
                permission_modes: orbyn_contracts::PermissionMode::ALL.to_vec(),
            },
        }
    }

    fn family(&self) -> String {
        "claude".into()
    }

    fn instance(&self, instance: &ProviderInstance) -> Option<Arc<dyn EngineDriver>> {
        Some(Arc::new(Self {
            program: instance.program.clone().unwrap_or(self.program.clone()),
            named: Some((
                instance.id.clone(),
                instance.name.clone().unwrap_or(instance.id.clone()),
            )),
            auto_compact_window: instance
                .auto_compact_window
                .as_deref()
                .and_then(|window| window.parse().ok()),
        }))
    }

    fn resolves_from_checkout(&self) -> bool {
        false
    }

    fn console(&self, console: &ConsoleSpec<'_>) -> Option<ConsoleCommand> {
        Some(ConsoleCommand {
            program: self.program.clone(),
            args: console_args(console),
            cwd: console.root.to_path_buf(),
            title: "Claude console".into(),
        })
    }

    fn sign_in_command(&self) -> Option<String> {
        Some("claude auth login".into())
    }

    fn check_launch_available(&self) -> Result<()> {
        resolve_engine(&self.program).map(|_| ())
    }

    async fn probe(&self) -> EngineProbe {
        let mut probe = probe_cli(&self.program, &["--version"]).await;
        if probe.path.is_some() {
            let (auth, account) = read_login(
                &self.program,
                &["auth", "status"],
                parse_auth_status,
                parse_auth_account,
            )
            .await;
            probe.auth = Some(auth);
            probe.account = account;
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

    async fn limits(&self) -> Result<Option<Value>> {
        parse_usage_report(&self.control_probe(true).await?)
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

    async fn write_text(&self, prompt: &str, model: Option<&str>) -> Result<String> {
        let dir = ProbeDir::new()?;
        let mcp = dir.path().join("mcp.json");
        let settings = dir.path().join("settings.json");
        write_private(&mcp, br#"{"mcpServers":{}}"#)?;
        write_private(&settings, br#"{"disableAllHooks":true}"#)?;
        let mcp = mcp
            .to_str()
            .ok_or_else(|| CoreError::Invalid("Unsupported temporary path.".into()))?;
        let settings = settings
            .to_str()
            .ok_or_else(|| CoreError::Invalid("Unsupported temporary path.".into()))?;
        let mut args = vec![
            "-p",
            "--output-format",
            "text",
            "--tools",
            "",
            "--no-session-persistence",
            "--strict-mcp-config",
            "--mcp-config",
            mcp,
            "--settings",
            settings,
            "--disable-slash-commands",
            "--permission-mode",
            "dontAsk",
        ];
        if let Some(model) = model {
            args.extend(["--model", model]);
        }
        one_shot_at(&self.program, &args, prompt, dir.path(), CAPABILITY_ENV).await
    }

    fn supports_writing(&self) -> bool {
        true
    }

    async fn start_run(
        &self,
        spec: RunSpec,
        events: mpsc::Sender<EngineEvent>,
    ) -> Result<RunHandle> {
        let process = self.launch(&spec)?;
        Ok(handle_for(process, spec, events, None))
    }

    fn can_warm(&self) -> bool {
        true
    }

    fn warm_key(&self, spec: &RunSpec) -> Option<String> {
        let command = resolve_engine(&self.program).ok()?;
        // A reinstall at the same path is a different program.
        let installed = std::fs::metadata(&command.program).ok()?;
        let modified = installed
            .modified()
            .ok()?
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?;
        // The run's own folder differs per run; what goes in it is compared instead.
        let mut neutral = spec.clone();
        neutral.run_dir = std::path::PathBuf::from("run");
        let args: Vec<String> = run_args(
            &neutral,
            Path::new("run/mcp.json"),
            self.auto_compact_window,
        )
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
        Some(
            json!({
                "program": command.program,
                "prefix": command.prefix.iter().map(|part| part.to_string_lossy()).collect::<Vec<_>>(),
                "size": installed.len(),
                "modified": modified.as_nanos().to_string(),
                "args": args,
                "cwd": spec.cwd,
                "mcp": spec.mcp_url,
                "settings": run_settings(spec, self.auto_compact_window),
                "mode": spec.mode,
                "saved_login": crate::host::child_env::prefers_saved_login(),
            })
            .to_string(),
        )
    }

    async fn start_warm(&self, mut spec: RunSpec) -> Result<Option<WarmProcess>> {
        let Some(key) = self.warm_key(&spec) else {
            return Ok(None);
        };
        let dir = ProbeDir::new()?;
        spec.run_dir = dir.path().to_path_buf();
        let process = self.launch(&spec)?;
        Ok(Some(WarmProcess { key, process, dir }))
    }

    async fn adopt_run(
        &self,
        spec: RunSpec,
        events: mpsc::Sender<EngineEvent>,
        warm: WarmProcess,
    ) -> Result<RunHandle> {
        let WarmProcess { process, dir, .. } = warm;
        Ok(handle_for(process, spec, events, Some(dir)))
    }
}

/// Starts `run_protocol` on a process. A warm process's folder lives as long as it.
fn handle_for(
    process: EngineProcess,
    spec: RunSpec,
    events: mpsc::Sender<EngineEvent>,
    dir: Option<ProbeDir>,
) -> RunHandle {
    let cancel = CancellationToken::new();
    let (input, steering) = mpsc::unbounded_channel();
    let (control, controls) = mpsc::unbounded_channel();
    let protocol = run_protocol(
        process,
        spec,
        events,
        Inputs { steering, controls },
        cancel.clone(),
    );
    let task = tokio::spawn(async move {
        let _dir = dir;
        protocol.await;
    });
    RunHandle {
        cancel,
        task,
        input: Some(input),
        control: Some(control),
    }
}

impl ClaudeDriver {
    /// Writes a run's files into its folder and starts the CLI on them.
    fn launch(&self, spec: &RunSpec) -> Result<EngineProcess> {
        let command = resolve_engine(&self.program)?;
        let mcp_config = spec.run_dir.join("mcp.json");
        let config = json!({
            "mcpServers": { (MCP_SERVER_NAME): { "type": "http", "url": spec.mcp_url } }
        });
        write_private(&mcp_config, config.to_string().as_bytes())?;
        if let Some(settings) = run_settings(spec, self.auto_compact_window) {
            write_private(&run_settings_path(spec), settings.to_string().as_bytes())?;
        }
        let args = run_args(spec, &mcp_config, self.auto_compact_window);
        spawn_engine(&command, &args, &spec.cwd)
    }

    /// Reads the CLI's `initialize` response from a process that never gets a
    /// prompt, in an empty folder of its own.
    async fn initialize(&self) -> Result<Value> {
        self.control_probe(false).await
    }

    async fn control_probe(&self, usage: bool) -> Result<Value> {
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
        let mut stream = FramedRead::new(
            process.stdout,
            LinesCodec::new_with_max_length(MAX_INITIALIZE_BYTES),
        );
        let response = async {
            let requests = if usage {
                vec![
                    (INITIALIZE_ID, "initialize", INITIALIZE_TIMEOUT),
                    (USAGE_ID, "get_usage", USAGE_TIMEOUT),
                ]
            } else {
                vec![(INITIALIZE_ID, "initialize", INITIALIZE_TIMEOUT)]
            };
            let mut answer = Value::Null;
            for (id, subtype, deadline) in requests {
                let frame = json!({ "type": "control_request", "request_id": id,
                    "request": { "subtype": subtype } });
                answer = tokio::time::timeout(deadline, async {
                    process
                        .stdin
                        .write_all(format!("{frame}\n").as_bytes())
                        .await?;
                    process.stdin.flush().await?;
                    read_control(&mut stream, id).await
                })
                .await
                .map_err(|_| probe_failed())??;
            }
            Ok(answer)
        }
        .await;
        drop(process.stdin);
        drop(stream);
        // A control-only probe has no turn to preserve. Always stop and reap it,
        // including malformed replies and deadline failures, before its cwd goes.
        process.child.terminate();
        if !matches!(
            tokio::time::timeout(EXIT_GRACE, process.child.wait()).await,
            Ok(Ok(_))
        ) && !matches!(
            tokio::time::timeout(EXIT_GRACE, process.child.child_mut().kill()).await,
            Ok(Ok(()))
        ) {
            return Err(probe_failed());
        }
        response
    }
}

fn probe_failed() -> CoreError {
    CoreError::EngineUnavailable("Claude Code did not report a usable control response.".into())
}

/// Read only the matching success body. Never return a CLI error payload or log
/// frames: initialization and usage replies may also carry account information.
async fn read_control<R: AsyncRead + Unpin>(
    stream: &mut FramedRead<R, LinesCodec>,
    id: &str,
) -> Result<Value> {
    let mut seen = 0;
    while let Some(line) = stream.next().await {
        let line = line.map_err(|_| probe_failed())?;
        seen += line.len() + 1;
        if seen > MAX_INITIALIZE_BYTES {
            return Err(probe_failed());
        }
        let Ok(frame) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if frame.get("type").and_then(Value::as_str) != Some("control_response") {
            continue;
        }
        let Some(reply) = frame.get("response") else {
            continue;
        };
        if reply.get("request_id").and_then(Value::as_str) != Some(id) {
            continue;
        }
        if reply.get("subtype").and_then(Value::as_str) != Some("success") {
            return Err(probe_failed());
        }
        return reply
            .get("response")
            .filter(|body| body.is_object())
            .cloned()
            .ok_or_else(probe_failed);
    }
    Err(probe_failed())
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

/// What a run takes while it works: steering text and controls.
struct Inputs {
    steering: mpsc::UnboundedReceiver<String>,
    controls: mpsc::UnboundedReceiver<RunControl>,
}

async fn sleep_until(due: Option<tokio::time::Instant>) {
    match due {
        Some(due) => tokio::time::sleep_until(due).await,
        None => std::future::pending().await,
    }
}

async fn run_protocol(
    mut process: EngineProcess,
    spec: RunSpec,
    events: mpsc::Sender<EngineEvent>,
    inputs: Inputs,
    cancel: CancellationToken,
) {
    let Inputs {
        mut steering,
        mut controls,
    } = inputs;
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
    let mut grace = None;
    let stream_ended = loop {
        tokio::select! {
            biased;
            () = cancel.cancelled() => break false,
            () = sleep_until(grace) => {
                outcome = mapper.held.take();
                break false;
            }
            Some(control) = controls.recv() => {
                let RunControl::StopWorkflow { tool_call_id } = control;
                if let Some(frame) = mapper.workflows.stop_request(&tool_call_id) {
                    if let Err(error) = stdin.write_all(format!("{frame}\n").as_bytes()).await {
                        tracing::debug!(%error, "could not ask Claude to stop a workflow");
                    }
                    let _ = stdin.flush().await;
                } else if events.send(Workflows::already_ended(&tool_call_id)).await.is_err() {
                    return;
                }
            }
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
                if mapper.waiting_on_hold() {
                    grace.get_or_insert_with(|| tokio::time::Instant::now() + HOLD_GRACE);
                } else {
                    grace = None;
                }
            }
        }
    };
    // The turn finished before the CLI went away; a workflow it held for is gone.
    let outcome = outcome.or_else(|| mapper.held.take());
    // Closing stdin is the CLI's signal to exit.
    drop(stdin);
    for event in mapper.close_open_blocks() {
        let _ = events.send(event).await;
    }
    for event in mapper.workflows.end_all() {
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

/// The account `claude auth status` names, if it names one.
fn parse_auth_account(stdout: &str) -> Option<String> {
    let value: Value = serde_json::from_str(stdout).ok()?;
    let email = value.get("email")?.as_str()?.trim();
    (!email.is_empty() && email.len() <= 254 && !email.chars().any(char::is_control))
        .then(|| email.to_owned())
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
    /// Plan tools already shown, since Claude can repeat a block across frames.
    plans_seen: HashSet<String>,
    /// Files each open write tool named, until its result arrives.
    writing: HashMap<String, Vec<String>>,
    /// Claude's modern task list, kept in the order it was reported.
    tasks: Vec<TaskStep>,
    /// Task tool calls held until their result reports the new state.
    task_calls: HashMap<String, (String, Value)>,
    /// Background workflows this run launched that still run.
    workflows: Workflows,
    /// A finished turn's outcome, held while a workflow it launched still runs.
    held: Option<EngineOutcome>,
    /// A follow-up turn started after the outcome was held.
    resumed: bool,
}

/// One row of the plan activity fed by Claude's TaskCreate/TaskUpdate/TaskList.
struct TaskStep {
    id: String,
    title: String,
    status: String,
}

impl StreamMapper {
    /// The turn is done and its workflows have ended, and no follow-up turn has
    /// started yet.
    fn waiting_on_hold(&self) -> bool {
        self.held.is_some() && self.workflows.is_empty() && !self.resumed
    }

    fn on_frame(&mut self, frame: &Value) -> Vec<EngineEvent> {
        // Subagent traffic carries a parent; the run shows its top-level turn.
        let nested = frame
            .get("parent_tool_use_id")
            .is_some_and(|parent| !parent.is_null());
        let kind = frame.get("type").and_then(Value::as_str);
        if self.held.is_some()
            && !nested
            && (matches!(kind, Some("assistant" | "stream_event"))
                || (kind == Some("system")
                    && frame.get("subtype").and_then(Value::as_str) == Some("init")))
        {
            self.resumed = true;
        }
        match kind {
            Some("control_response") => Workflows::control_response(frame),
            Some("system")
                if matches!(
                    frame.get("subtype").and_then(Value::as_str),
                    Some("task_notification" | "task_updated")
                ) =>
            {
                self.workflows.system(frame)
            }
            Some("system") if frame.get("subtype").and_then(Value::as_str) == Some("init") => {
                let mut events = session(frame);
                events.extend(init_commands(frame));
                events
            }
            Some("stream_event") if !nested => frame
                .get("event")
                .map_or_else(Vec::new, |event| self.on_stream_event(event)),
            Some("assistant") if !nested => self.on_assistant(frame),
            Some("user") if !nested => {
                let mut events = self.writes_finished(frame);
                events.extend(self.tasks_finished(frame));
                events.extend(on_user(frame));
                events.extend(self.workflows.launched(frame));
                events
            }
            Some("assistant") => vec![
                AgUiEvent::Custom {
                    name: "subagent.activity".into(),
                    value: json!({ "parentToolCallId": frame.get("parent_tool_use_id") }),
                }
                .into(),
            ],
            Some("rate_limit_event") => rejected_limit(frame).into_iter().collect(),
            Some("system")
                if frame.get("subtype").and_then(Value::as_str) == Some("compact_boundary") =>
            {
                vec![
                    AgUiEvent::Custom {
                        name: "context.compacted".into(),
                        value: Value::Null,
                    }
                    .into(),
                ]
            }
            Some("result") => {
                let outcome = result_outcome(frame);
                // The CLI keeps a workflow running past the turn that launched it, and
                // closing its input would end the workflow with it.
                if outcome == EngineOutcome::Completed && !self.workflows.is_empty() {
                    self.held = Some(outcome);
                    self.resumed = false;
                } else {
                    self.held = None;
                    self.outcome = Some(outcome);
                }
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
        for block in &content {
            events.extend(self.plan_events(block));
            self.write_started(block);
            self.task_started(block);
        }
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

    /// Remembers what a write tool names until its result says it ran.
    fn write_started(&mut self, block: &Value) {
        if block.get("type").and_then(Value::as_str) != Some("tool_use") {
            return;
        }
        let paths = crate::conversation::checkpoints::claude_write_paths(block);
        if let (false, Some(id)) = (paths.is_empty(), text_of(block, "id")) {
            self.writing.insert(id, paths);
        }
    }

    fn writes_finished(&mut self, frame: &Value) -> Vec<EngineEvent> {
        let empty = Vec::new();
        frame
            .pointer("/message/content")
            .and_then(Value::as_array)
            .unwrap_or(&empty)
            .iter()
            .filter_map(|block| self.writing.remove(block.get("tool_use_id")?.as_str()?))
            .map(EngineEvent::Files)
            .collect()
    }

    /// `TodoWrite` is the plan as a checklist and `ExitPlanMode` carries a proposed
    /// plan. Their input is only whole in the `assistant` frame, which is why this reads
    /// them there and not from the partials.
    fn plan_events(&mut self, block: &Value) -> Vec<EngineEvent> {
        if block.get("type").and_then(Value::as_str) != Some("tool_use") {
            return Vec::new();
        }
        let Some(id) = text_of(block, "id") else {
            return Vec::new();
        };
        let name = block.get("name").and_then(Value::as_str);
        let input = block.get("input").cloned().unwrap_or(Value::Null);
        let events = match name {
            Some("TodoWrite") => vec![
                AgUiEvent::ActivitySnapshot {
                    message_id: "plan".into(),
                    activity_type: "plan".into(),
                    content: todo_content(&input),
                    replace: Some(true),
                }
                .into(),
            ],
            Some("ExitPlanMode") => text_of(&input, "plan")
                .map(|plan| proposed_plan_events(&id, &plan))
                .unwrap_or_default(),
            _ => return Vec::new(),
        };
        if self.plans_seen.insert(id) {
            events
        } else {
            Vec::new()
        }
    }

    /// Claude's modern task tools only report their state in the result, so the
    /// call is held until it arrives.
    fn task_started(&mut self, block: &Value) {
        if block.get("type").and_then(Value::as_str) != Some("tool_use") {
            return;
        }
        let Some(name) = block.get("name").and_then(Value::as_str) else {
            return;
        };
        if !matches!(name, "TaskCreate" | "TaskUpdate" | "TaskList") {
            return;
        }
        if let Some(id) = text_of(block, "id") {
            self.task_calls.insert(
                id,
                (
                    name.to_owned(),
                    block.get("input").cloned().unwrap_or(Value::Null),
                ),
            );
        }
    }

    fn tasks_finished(&mut self, frame: &Value) -> Vec<EngineEvent> {
        let Some(content) = frame.pointer("/message/content").and_then(Value::as_array) else {
            return Vec::new();
        };
        let mut changed = false;
        for block in content {
            if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                continue;
            }
            let Some(id) = text_of(block, "tool_use_id") else {
                continue;
            };
            let Some((name, input)) = self.task_calls.remove(&id) else {
                continue;
            };
            if block.get("is_error").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            let result = task_result(frame, block);
            changed |= self.apply_task(&name, &input, &result);
        }
        if !changed {
            return Vec::new();
        }
        vec![
            AgUiEvent::ActivitySnapshot {
                message_id: "plan".into(),
                activity_type: "plan".into(),
                content: task_content(&self.tasks),
                replace: Some(true),
            }
            .into(),
        ]
    }

    fn apply_task(&mut self, name: &str, input: &Value, result: &Value) -> bool {
        match name {
            "TaskList" => {
                let Some(listed) = result.get("tasks").and_then(Value::as_array) else {
                    return false;
                };
                let mut next = Vec::new();
                for task in listed {
                    let Some(id) = text_of(task, "id") else {
                        continue;
                    };
                    next.push(TaskStep {
                        id,
                        title: text_of(task, "subject").unwrap_or_default(),
                        status: task_status(text_of(task, "status").as_deref())
                            .unwrap_or("pending")
                            .to_owned(),
                    });
                }
                self.tasks = next;
                true
            }
            "TaskCreate" => {
                let created = result.get("task");
                let from_text = created_from_text(result);
                let id = created
                    .and_then(|task| text_of(task, "id"))
                    .or_else(|| from_text.as_ref().map(|(id, _)| id.clone()));
                let title = created
                    .and_then(|task| text_of(task, "subject"))
                    .or_else(|| from_text.map(|(_, subject)| subject))
                    .or_else(|| text_of(input, "subject"));
                let (Some(id), Some(title)) = (id, title) else {
                    return false;
                };
                match self.tasks.iter_mut().find(|task| task.id == id) {
                    Some(task) => task.title = title,
                    None => self.tasks.push(TaskStep {
                        id,
                        title,
                        status: "pending".into(),
                    }),
                }
                true
            }
            "TaskUpdate" => {
                if result.get("success").and_then(Value::as_bool) == Some(false) {
                    return false;
                }
                if let Some(text) = result.as_str()
                    && !text.starts_with("Updated task #")
                {
                    return false;
                }
                let id = text_of(input, "taskId").or_else(|| text_of(result, "taskId"));
                let Some(index) =
                    id.and_then(|id| self.tasks.iter().position(|task| task.id == id))
                else {
                    return false;
                };
                let native = text_of(input, "status");
                if native.as_deref() == Some("deleted") {
                    self.tasks.remove(index);
                    return true;
                }
                let title =
                    text_of(input, "subject").unwrap_or_else(|| self.tasks[index].title.clone());
                let status = native
                    .as_deref()
                    .and_then(|value| task_status(Some(value)))
                    .map(str::to_owned)
                    .unwrap_or_else(|| self.tasks[index].status.clone());
                let changed =
                    self.tasks[index].title != title || self.tasks[index].status != status;
                self.tasks[index].title = title;
                self.tasks[index].status = status;
                changed
            }
            _ => false,
        }
    }

    fn close_open_blocks(&mut self) -> Vec<EngineEvent> {
        self.blocks
            .drain(..)
            .map(|(_, block)| end_event(&block).into())
            .collect()
    }
}

/// `TodoWrite`'s list in the `plan` activity's shape. Its statuses are the same words.
fn todo_content(input: &Value) -> Value {
    let steps: Vec<Value> = input
        .get("todos")
        .and_then(Value::as_array)
        .map(|todos| {
            todos
                .iter()
                .map(|todo| {
                    json!({
                        "title": text_of(todo, "content").unwrap_or_default(),
                        "status": text_of(todo, "status").unwrap_or_else(|| "pending".into()),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    json!({ "steps": steps })
}

/// The structured result when Claude sends one, otherwise the text the tool
/// result carries.
fn task_result(frame: &Value, block: &Value) -> Value {
    if let Some(result) = frame
        .get("tool_use_result")
        .filter(|value| !value.is_null())
    {
        return result.clone();
    }
    match block.get("content") {
        Some(Value::Array(parts)) => Value::String(
            parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(""),
        ),
        Some(value) => value.clone(),
        None => Value::Null,
    }
}

/// A subagent result carries no structured task, only the created line.
fn created_from_text(result: &Value) -> Option<(String, String)> {
    let rest = result.as_str()?.strip_prefix("Task #")?;
    let (id, subject) = rest.split_once(" created successfully: ")?;
    Some((id.trim().to_owned(), subject.trim().to_owned()))
}

fn task_status(value: Option<&str>) -> Option<&'static str> {
    match value {
        Some("pending") => Some("pending"),
        Some("in_progress") => Some("running"),
        Some("completed") => Some("completed"),
        _ => None,
    }
}

/// The task list in the same `plan` activity shape `TodoWrite` produces.
fn task_content(tasks: &[TaskStep]) -> Value {
    let steps: Vec<Value> = tasks
        .iter()
        .map(|task| json!({ "title": task.title, "status": task.status }))
        .collect();
    json!({ "steps": steps })
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
    let mut events = Vec::new();
    for block in content
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("tool_result"))
    {
        let Some(id) = text_of(block, "tool_use_id") else {
            continue;
        };
        events.push(
            AgUiEvent::ToolCallResult {
                message_id: new_id(),
                tool_call_id: id.clone(),
                content: tool_text(block.get("content")),
                role: Some("tool".into()),
            }
            .into(),
        );
        let outcome = match block.get("is_error") {
            None | Some(Value::Bool(false)) => Some("success"),
            Some(Value::Bool(true)) => Some("failure"),
            _ => None,
        };
        if let Some(outcome) = outcome {
            events.push(
                AgUiEvent::Custom {
                    name: "tool.outcome".into(),
                    value: json!({ "toolCallId": id, "outcome": outcome }),
                }
                .into(),
            );
        }
    }
    events
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

/// Claude reports limits as it goes; only a rejected one stops the turn.
fn rejected_limit(frame: &Value) -> Option<EngineEvent> {
    let info = frame.get("rate_limit_info")?;
    (info.get("status").and_then(Value::as_str) == Some("rejected")).then(|| EngineEvent::Limited {
        resets_at: info.get("resetsAt").and_then(Value::as_i64),
    })
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

    fn launch_frame() -> Value {
        json!({
            "type": "user",
            "message": { "content": [{ "type": "tool_result", "tool_use_id": "wf" }] },
            "tool_use_result": { "status": "async_launched", "taskId": "t1",
                "taskType": "local_workflow", "workflowName": "probe" },
        })
    }

    #[test]
    fn a_workflow_holds_a_completed_turn_but_not_a_failed_one() {
        let mut mapper = StreamMapper::default();
        mapper.on_frame(&launch_frame());
        assert!(
            mapper
                .workflows
                .stop_request("wf")
                .unwrap()
                .contains("\"task_id\":\"t1\"")
        );
        mapper.on_frame(&json!({ "type": "result", "subtype": "success" }));
        assert!(mapper.outcome.is_none());
        assert!(!mapper.waiting_on_hold());
        mapper.on_frame(&json!({ "type": "system", "subtype": "task_notification",
            "task_id": "t1", "status": "stopped" }));
        assert!(mapper.waiting_on_hold());
        assert!(mapper.workflows.stop_request("wf").is_none());

        let mut failed = StreamMapper::default();
        failed.on_frame(&launch_frame());
        failed.on_frame(
            &json!({ "type": "result", "subtype": "error_during_execution",
            "is_error": true, "errors": ["boom"] }),
        );
        assert_eq!(failed.outcome, Some(EngineOutcome::Failed("boom".into())));
    }

    #[test]
    fn a_refused_stop_is_shown_and_other_replies_are_not() {
        let refused = json!({ "type": "control_response", "response": {
            "subtype": "error", "request_id": "orbyn-stop-wf", "error": "no" } });
        let events = StreamMapper::default().on_frame(&refused);
        assert!(
            matches!(&events[..], [EngineEvent::Agui(AgUiEvent::Custom { name, .. })]
            if name == "workflow.stop_failed")
        );
        let other = json!({ "type": "control_response", "response": {
            "subtype": "error", "request_id": "orbyn-usage" } });
        assert!(StreamMapper::default().on_frame(&other).is_empty());
    }

    #[test]
    fn tool_result_outcomes_preserve_unknown_flags() {
        let frame = json!({ "message": { "content": [
            { "type": "tool_result", "tool_use_id": "ok" },
            { "type": "tool_result", "tool_use_id": "bad", "is_error": true },
            { "type": "tool_result", "tool_use_id": "unknown", "is_error": "unknown" }
        ] } });
        let outcomes: Vec<_> = on_user(&frame)
            .into_iter()
            .filter_map(|event| match event {
                EngineEvent::Agui(AgUiEvent::Custom { name, value }) if name == "tool.outcome" => {
                    Some(value)
                }
                _ => None,
            })
            .collect();
        assert_eq!(
            outcomes,
            vec![
                json!({"toolCallId":"ok","outcome":"success"}),
                json!({"toolCallId":"bad","outcome":"failure"})
            ]
        );
    }

    use std::path::PathBuf;

    #[tokio::test]
    async fn control_replies_match_ids_and_bound_untrusted_frames() {
        let wire = format!(
            "{}\n{}\n",
            json!({ "type": "control_response", "response": {
            "subtype": "success", "request_id": "other", "response": { "account": "PRIVATE-MARKER" } } }),
            json!({ "type": "control_response", "response": { "subtype": "success", "request_id": USAGE_ID,
                "response": { "rate_limits_available": false } } })
        );
        let mut stream = FramedRead::new(
            wire.as_bytes(),
            LinesCodec::new_with_max_length(MAX_INITIALIZE_BYTES),
        );
        assert_eq!(
            read_control(&mut stream, USAGE_ID).await.unwrap(),
            json!({ "rate_limits_available": false })
        );
        let oversized = vec![b'x'; MAX_INITIALIZE_BYTES + 1];
        let mut stream = FramedRead::new(
            oversized.as_slice(),
            LinesCodec::new_with_max_length(MAX_INITIALIZE_BYTES),
        );
        assert!(read_control(&mut stream, USAGE_ID).await.is_err());
        let error = format!(
            "{}\n",
            json!({ "type": "control_response", "response": {
            "subtype": "error", "request_id": USAGE_ID, "error": "PRIVATE-MARKER" } })
        );
        let mut stream = FramedRead::new(
            error.as_bytes(),
            LinesCodec::new_with_max_length(MAX_INITIALIZE_BYTES),
        );
        assert!(
            !read_control(&mut stream, USAGE_ID)
                .await
                .unwrap_err()
                .to_string()
                .contains("PRIVATE-MARKER")
        );
    }

    #[test]
    fn quota_events_only_reject_the_turn_when_the_cli_says_rejected() {
        assert!(
            rejected_limit(
                &json!({ "rate_limit_info": { "status": "allowed", "utilization": 0.8 } })
            )
            .is_none()
        );
        assert!(matches!(
            rejected_limit(
                &json!({ "rate_limit_info": { "status": "rejected", "resetsAt": 1800000000 } })
            ),
            Some(EngineEvent::Limited {
                resets_at: Some(1800000000)
            })
        ));
    }

    fn spec() -> RunSpec {
        RunSpec {
            run_id: "r".into(),
            thread_id: "t".into(),
            cwd: PathBuf::from("/workspace"),
            checkout: PathBuf::from("/workspace/repo/app"),
            prompt: "hello".into(),
            user_prompt: "hello".into(),
            context: String::new(),
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

    fn tool_frame(id: &str, name: &str, input: Value) -> Value {
        json!({
            "type": "assistant",
            "parent_tool_use_id": null,
            "message": { "content": [
                { "type": "tool_use", "id": id, "name": name, "input": input },
            ]},
        })
    }

    fn agui(events: Vec<EngineEvent>) -> Vec<AgUiEvent> {
        events
            .into_iter()
            .filter_map(|event| match event {
                EngineEvent::Agui(event) => Some(event),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_todo_list_becomes_plan_steps_even_with_partials_on() {
        let mut mapper = StreamMapper {
            saw_partials: true,
            ..StreamMapper::default()
        };
        let frame = tool_frame(
            "t1",
            "TodoWrite",
            json!({ "todos": [
                { "content": "Read", "status": "completed", "activeForm": "Reading" },
                { "content": "Write", "status": "in_progress" },
                { "content": "Check" },
            ]}),
        );
        let events = agui(mapper.on_frame(&frame));
        let [
            AgUiEvent::ActivitySnapshot {
                activity_type,
                content,
                ..
            },
        ] = &events[..]
        else {
            panic!("{events:?}");
        };
        assert_eq!(activity_type, "plan");
        assert_eq!(content["steps"][0]["title"], "Read");
        assert_eq!(content["steps"][1]["status"], "in_progress");
        assert_eq!(content["steps"][2]["status"], "pending");
    }

    fn plan_snapshot(events: Vec<AgUiEvent>) -> Value {
        events
            .into_iter()
            .find_map(|event| match event {
                AgUiEvent::ActivitySnapshot {
                    activity_type,
                    content,
                    ..
                } if activity_type == "plan" => Some(content),
                _ => None,
            })
            .expect("plan snapshot")
    }

    fn task_result(tool: &str, result: Value) -> Value {
        json!({
            "type": "user",
            "parent_tool_use_id": null,
            "message": { "content": [
                { "type": "tool_result", "tool_use_id": tool, "content": "done" },
            ]},
            "tool_use_result": result,
        })
    }

    /// Modern task tools report state in their result, and each change replaces
    /// the plan activity's steps.
    #[test]
    fn modern_task_tools_feed_the_plan_activity() {
        let mut mapper = StreamMapper {
            saw_partials: true,
            ..StreamMapper::default()
        };
        let created = mapper.on_frame(&tool_frame(
            "c1",
            "TaskCreate",
            json!({ "subject": "alpha", "description": "first" }),
        ));
        assert!(agui(created).is_empty(), "the call waits for its result");
        let steps = plan_snapshot(agui(mapper.on_frame(&task_result(
            "c1",
            json!({ "task": { "id": "1", "subject": "alpha" } }),
        ))));
        assert_eq!(
            steps["steps"],
            json!([{ "title": "alpha", "status": "pending" }])
        );

        mapper.on_frame(&tool_frame(
            "u2",
            "TaskUpdate",
            json!({ "taskId": "1", "status": "in_progress" }),
        ));
        let steps = plan_snapshot(agui(mapper.on_frame(&task_result(
            "u2",
            json!({ "success": true, "taskId": "1" }),
        ))));
        assert_eq!(steps["steps"][0]["status"], "running");

        mapper.on_frame(&tool_frame("l1", "TaskList", json!({})));
        let steps = plan_snapshot(agui(mapper.on_frame(&task_result(
            "l1",
            json!({ "tasks": [
                { "id": "1", "subject": "alpha", "status": "completed" },
                { "id": "2", "subject": "beta", "status": "in_progress" },
            ]}),
        ))));
        assert_eq!(
            steps["steps"],
            json!([
                { "title": "alpha", "status": "completed" },
                { "title": "beta", "status": "running" },
            ])
        );

        mapper.on_frame(&tool_frame(
            "d1",
            "TaskUpdate",
            json!({ "taskId": "1", "status": "deleted" }),
        ));
        let steps = plan_snapshot(agui(mapper.on_frame(&task_result(
            "d1",
            json!({ "success": true, "taskId": "1" }),
        ))));
        assert_eq!(
            steps["steps"],
            json!([{ "title": "beta", "status": "running" }])
        );
    }

    #[test]
    fn failed_task_updates_preserve_the_plan_and_failure_outcome() {
        for status in ["completed", "deleted"] {
            let mut mapper = StreamMapper::default();
            mapper.on_frame(&tool_frame(
                "create",
                "TaskCreate",
                json!({ "subject": "alpha" }),
            ));
            mapper.on_frame(&task_result(
                "create",
                json!({ "task": { "id": "1", "subject": "alpha" } }),
            ));
            mapper.on_frame(&tool_frame(
                "update",
                "TaskUpdate",
                json!({ "taskId": "1", "status": status }),
            ));
            let events = agui(mapper.on_frame(&json!({
                "type": "user",
                "message": { "content": [{ "type": "tool_result", "tool_use_id": "update", "is_error": true }] },
            })));
            assert!(
                !events
                    .iter()
                    .any(|event| matches!(event, AgUiEvent::ActivitySnapshot { .. })),
                "failed {status} changed the plan"
            );
            assert_eq!(
                task_content(&mapper.tasks),
                json!({ "steps": [{ "title": "alpha", "status": "pending" }] })
            );
            assert!(events.iter().any(|event| matches!(event, AgUiEvent::Custom { name, value } if name == "tool.outcome" && value == &json!({ "toolCallId": "update", "outcome": "failure" }))));
            assert!(mapper.task_calls.is_empty());
        }
    }

    /// A subagent reports the created task as text, not as a structured result.
    #[test]
    fn a_text_only_task_create_still_becomes_a_step() {
        let mut mapper = StreamMapper::default();
        mapper.on_frame(&tool_frame(
            "c1",
            "TaskCreate",
            json!({ "subject": "from input" }),
        ));
        let frame = json!({
            "type": "user",
            "parent_tool_use_id": null,
            "message": { "content": [
                { "type": "tool_result", "tool_use_id": "c1",
                  "content": "Task #7 created successfully: gamma" },
            ]},
        });
        let steps = plan_snapshot(agui(mapper.on_frame(&frame)));
        assert_eq!(
            steps["steps"],
            json!([{ "title": "gamma", "status": "pending" }])
        );
        mapper.on_frame(&tool_frame(
            "u7",
            "TaskUpdate",
            json!({ "taskId": "7", "status": "completed" }),
        ));
        let updated = json!({
            "type": "user",
            "message": { "content": [{ "type": "tool_result", "tool_use_id": "u7",
                "content": "Updated task #7 status" }] },
        });
        let steps = plan_snapshot(agui(mapper.on_frame(&updated)));
        assert_eq!(
            steps["steps"],
            json!([{ "title": "gamma", "status": "completed" }])
        );
    }

    #[test]
    fn a_proposed_plan_appears_once_and_a_subagents_stays_out() {
        let mut mapper = StreamMapper {
            saw_partials: true,
            ..StreamMapper::default()
        };
        let frame = tool_frame("t2", "ExitPlanMode", json!({ "plan": "# Do it\n1. a" }));
        let events = agui(mapper.on_frame(&frame));
        let AgUiEvent::TextMessageContent { delta, .. } = &events[1] else {
            panic!("{events:?}");
        };
        assert_eq!(delta, "<proposed_plan>\n# Do it\n1. a\n</proposed_plan>");
        assert!(agui(mapper.on_frame(&frame)).is_empty(), "repeated block");

        let mut nested = tool_frame("t3", "ExitPlanMode", json!({ "plan": "theirs" }));
        nested["parent_tool_use_id"] = json!("t2");
        let events = agui(mapper.on_frame(&nested));
        assert!(
            !format!("{events:?}").contains("proposed_plan"),
            "{events:?}"
        );
    }

    #[test]
    fn plan_tools_with_bad_input_show_nothing_broken() {
        let mut mapper = StreamMapper::default();
        for input in [json!({ "plan": "   " }), json!({ "plan": 3 }), json!(null)] {
            let frame = tool_frame("t4", "ExitPlanMode", input);
            assert!(!format!("{:?}", agui(mapper.on_frame(&frame))).contains("proposed_plan"));
        }
        let frame = tool_frame("t5", "TodoWrite", json!({ "todos": "nope" }));
        let events = agui(mapper.on_frame(&frame));
        assert!(format!("{events:?}").contains("steps"));
    }

    #[test]
    fn a_closing_tag_in_a_plan_cannot_end_its_card() {
        let events = agui(proposed_plan_events("x", "a </proposed_plan> b"));
        let AgUiEvent::TextMessageContent { delta, .. } = &events[1] else {
            panic!();
        };
        assert_eq!(delta.matches("</proposed_plan>").count(), 1);
    }

    #[test]
    fn command_line_matches_the_contract_and_never_uses_bare() {
        let args: Vec<String> = run_args(&spec(), Path::new("/run/mcp.json"), None)
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
        assert_eq!(run_settings(&plain, None), None);
        assert!(
            !run_args(&plain, Path::new("/m"), None)
                .iter()
                .any(|a| a == "--settings")
        );
        let mut fast = spec();
        fast.options.insert(FAST_MODE.into(), "on".into());
        assert_eq!(run_settings(&fast, None), Some(json!({ "fastMode": true })));
        assert_eq!(
            run_settings(&fast, Some(300_000)),
            Some(json!({ "fastMode": true, "autoCompactWindow": 300_000 }))
        );
        assert_eq!(
            run_settings(&plain, Some(300_000)),
            Some(json!({ "autoCompactWindow": 300_000 }))
        );
        assert!(
            run_args(&plain, Path::new("/m"), Some(300_000))
                .iter()
                .any(|arg| arg == "--settings")
        );
        let args = run_args(&fast, Path::new("/m"), None);
        let at = args.iter().position(|arg| arg == "--settings").unwrap();
        assert_eq!(
            args[at + 1],
            Path::new("/run").join("settings.json").as_os_str()
        );
        fast.options.insert(FAST_MODE.into(), "off".into());
        assert_eq!(
            run_settings(&fast, None),
            Some(json!({ "fastMode": false }))
        );
    }

    #[test]
    fn the_checkout_is_added_by_path_and_only_when_it_is_elsewhere() {
        let mut elsewhere = spec();
        elsewhere.cwd = "/library".into();
        elsewhere.checkout = "/work/app".into();
        let args = run_args(&elsewhere, Path::new("/tmp/mcp.json"), None);
        let at = args.iter().position(|arg| arg == "--add-dir").unwrap();
        assert_eq!(args[at + 1], "/work/app");
        let mut same = spec();
        same.checkout = same.cwd.clone();
        let args = run_args(&same, Path::new("/tmp/mcp.json"), None);
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
    fn the_account_is_the_email_the_status_reports_and_only_that() {
        let signed_in = "{\"loggedIn\":true,\"email\":\" a@example.com \",\"orgId\":\"o\"}";
        assert_eq!(
            parse_auth_account(signed_in).as_deref(),
            Some("a@example.com")
        );
        assert_eq!(parse_auth_account("{\"loggedIn\":false}"), None);
        assert_eq!(parse_auth_account("{\"email\":\"bad\\u0007\"}"), None);
        assert_eq!(parse_auth_account("not json"), None);
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
