//! Orbyn's own tools for a running agent, under Orbyn names. A tool reaches only
//! the caller's project. Claude's permission prompt passes these tools without
//! asking, so each one with an effect goes through the gate here, as a `tool` action:
//! it needs a person unless the thread is in full access or a rule allows it.

use std::path::Path;

use orbyn_contracts::{
    ActionKind, CreateThread, DelegateTask, TaskSchedule, Thread, UpdateThread, UpsertTask,
};
use serde_json::{Value, json};

use crate::app::Core;
use crate::approvals::{ActionAsk, Verdict};
use crate::error::{CoreError, Result};
use crate::mcp::McpBinding;
use crate::store::AuditRecord;

/// Under the 45 seconds a tool has to answer, so the caller hears `ended: false`.
const MAX_WAIT_SECONDS: u64 = 40;
const MAX_SEARCH_CHARS: usize = 200_000;
const MAX_HITS: usize = 50;
const MAX_BATCH: usize = 16;

struct Tool {
    name: &'static str,
    description: &'static str,
    /// Has an effect, so it goes through the gate.
    effect: bool,
    /// `(name, type)` of each argument.
    args: &'static [(&'static str, &'static str)],
    required: &'static [&'static str],
}

const fn read(
    name: &'static str,
    description: &'static str,
    args: &'static [(&'static str, &'static str)],
    required: &'static [&'static str],
) -> Tool {
    Tool {
        name,
        description,
        effect: false,
        args,
        required,
    }
}

const fn act(
    name: &'static str,
    description: &'static str,
    args: &'static [(&'static str, &'static str)],
    required: &'static [&'static str],
) -> Tool {
    Tool {
        name,
        description,
        effect: true,
        args,
        required,
    }
}

const TOOLS: &[Tool] = &[
    read(
        "orbyn_environment_read",
        "This service's version, platform and this thread's folder.",
        &[],
        &[],
    ),
    read(
        "orbyn_project_read",
        "This thread's project, with its project file.",
        &[],
        &[],
    ),
    read(
        "orbyn_worktree_list",
        "Worktrees of this project.",
        &[],
        &[],
    ),
    read("orbyn_thread_list", "Threads in this project.", &[], &[]),
    read(
        "orbyn_thread_read",
        "A thread and its recent text.",
        &[("thread_id", "string")],
        &["thread_id"],
    ),
    read(
        "orbyn_thread_search",
        "Threads in this project matching every word.",
        &[("query", "string")],
        &["query"],
    ),
    read(
        "orbyn_thread_wait",
        "Wait for a thread's run to end, up to five minutes.",
        &[("thread_id", "string"), ("seconds", "number")],
        &["thread_id"],
    ),
    read(
        "orbyn_queue_list",
        "A thread's queued messages.",
        &[("thread_id", "string")],
        &["thread_id"],
    ),
    read(
        "orbyn_pending_requests",
        "Approvals and questions open in a thread.",
        &[("thread_id", "string")],
        &["thread_id"],
    ),
    read(
        "orbyn_pull_list",
        "Pull requests linked to this thread, and those it watches.",
        &[],
        &[],
    ),
    read(
        "orbyn_schedule_list",
        "Scheduled tasks in this project.",
        &[],
        &[],
    ),
    read(
        "orbyn_task_status",
        "A delegated thread's state.",
        &[("thread_id", "string")],
        &["thread_id"],
    ),
    read(
        "orbyn_worktree_status",
        "This checkout's branch, whether it is a worktree, and its uncommitted files.",
        &[],
        &[],
    ),
    read(
        "orbyn_orchestrator_capabilities",
        "What this thread can start: engines, and whether it may delegate.",
        &[],
        &[],
    ),
    read(
        "orbyn_preview_list",
        "This thread's preview tabs.",
        &[],
        &[],
    ),
    read(
        "orbyn_preview_status",
        "One preview tab: where it is, its size, view and state.",
        &[("tab_id", "string")],
        &["tab_id"],
    ),
    read(
        "orbyn_track_files",
        "Before writing files no tool reports, such as from a shell script, call this with \
         the checkout paths; call it again with done true afterwards.",
        &[("paths", "array"), ("done", "boolean")],
        &["paths"],
    ),
    act(
        "orbyn_thread_launch",
        "Start a new thread in this project with a first message.",
        &[
            ("prompt", "string"),
            ("engine", "string"),
            ("title", "string"),
        ],
        &["prompt"],
    ),
    act(
        "orbyn_threads_create",
        "Start several threads in this project, each with a first message. One failure \
         does not stop the rest.",
        &[("threads", "array")],
        &["threads"],
    ),
    act(
        "orbyn_worktree_handoff",
        "Continue in a new worktree: a new thread there, with a first message.",
        &[
            ("purpose", "string"),
            ("prompt", "string"),
            ("base_branch", "string"),
            ("title", "string"),
        ],
        &["purpose", "prompt"],
    ),
    act(
        "orbyn_environment_preferences_update",
        "Change this project's preferences. null goes back to the default.",
        &[("values", "object")],
        &["values"],
    ),
    act(
        "orbyn_project_update",
        "Rename this project.",
        &[("name", "string")],
        &["name"],
    ),
    act(
        "orbyn_thread_send",
        "Queue a message on a thread, with attachments from orbyn_attachment_add.",
        &[
            ("thread_id", "string"),
            ("prompt", "string"),
            ("attachment_ids", "array"),
        ],
        &["thread_id", "prompt"],
    ),
    act(
        "orbyn_attachment_add",
        "Attach a file from this checkout to a thread, for orbyn_thread_send.",
        &[("thread_id", "string"), ("path", "string")],
        &["thread_id", "path"],
    ),
    act(
        "orbyn_attachment_discard",
        "Remove an attachment that was not sent.",
        &[("thread_id", "string"), ("attachment_id", "string")],
        &["thread_id", "attachment_id"],
    ),
    act(
        "orbyn_thread_organize",
        "Pin, settle, snooze, archive or mark a thread unread.",
        &[
            ("thread_id", "string"),
            ("pinned", "boolean"),
            ("settled", "boolean"),
            ("archived", "boolean"),
            ("unread", "boolean"),
            ("snoozed_until", "string"),
        ],
        &["thread_id"],
    ),
    act(
        "orbyn_thread_configure",
        "Set a thread's model, effort, permission mode or plan mode.",
        &[
            ("thread_id", "string"),
            ("model", "string"),
            ("effort", "string"),
            ("permission_mode", "string"),
            ("plan_mode", "boolean"),
        ],
        &["thread_id"],
    ),
    act(
        "orbyn_preview_open",
        "Open a web page in a preview tab for this thread.",
        &[("url", "string"), ("width", "number"), ("height", "number")],
        &["url"],
    ),
    act(
        "orbyn_preview_navigate",
        "Go to a page, or back or forward, in one of this thread's preview tabs.",
        &[("tab_id", "string"), ("url", "string"), ("back", "boolean")],
        &["tab_id"],
    ),
    act(
        "orbyn_preview_resize",
        "Set a preview tab's size.",
        &[
            ("tab_id", "string"),
            ("width", "number"),
            ("height", "number"),
        ],
        &["tab_id", "width", "height"],
    ),
    act(
        "orbyn_preview_set_appearance",
        "Set a preview tab's color scheme: system, light or dark.",
        &[("tab_id", "string"), ("appearance", "string")],
        &["tab_id", "appearance"],
    ),
    act(
        "orbyn_preview_dialog",
        "Answer the alert, confirm or prompt a page opened. `handled` is false if none was.",
        &[
            ("tab_id", "string"),
            ("accept", "boolean"),
            ("text", "string"),
        ],
        &["tab_id", "accept"],
    ),
    act(
        "orbyn_preview_close",
        "Close one of this thread's preview tabs.",
        &[("tab_id", "string")],
        &["tab_id"],
    ),
    act(
        "orbyn_preview_recording_start",
        "Start recording a preview tab's frames.",
        &[("tab_id", "string")],
        &["tab_id"],
    ),
    act(
        "orbyn_preview_recording_stop",
        "Stop recording, and return where the frames are.",
        &[("tab_id", "string")],
        &["tab_id"],
    ),
    act(
        "orbyn_thread_update",
        "Rename, pin or settle a thread.",
        &[
            ("thread_id", "string"),
            ("title", "string"),
            ("pinned", "boolean"),
            ("settled", "boolean"),
        ],
        &["thread_id"],
    ),
    act(
        "orbyn_thread_interrupt",
        "Stop a thread's running turn.",
        &[("thread_id", "string")],
        &["thread_id"],
    ),
    act(
        "orbyn_pull_link",
        "Link a pull request to this thread.",
        &[("number", "number")],
        &["number"],
    ),
    act(
        "orbyn_pull_unlink",
        "Unlink a pull request from this thread.",
        &[("number", "number")],
        &["number"],
    ),
    act(
        "orbyn_pull_watch",
        "Wake this thread when a pull request changes.",
        &[("number", "number")],
        &["number"],
    ),
    act(
        "orbyn_pull_unwatch",
        "Stop watching a pull request.",
        &[("number", "number")],
        &["number"],
    ),
    act(
        "orbyn_delegate_task",
        "Hand work to a child thread, which reports back when it ends.",
        &[
            ("prompt", "string"),
            ("title", "string"),
            ("engine", "string"),
        ],
        &["prompt"],
    ),
    act(
        "orbyn_task_cancel",
        "Stop a delegated thread's run.",
        &[("thread_id", "string")],
        &["thread_id"],
    ),
    act(
        "orbyn_schedule_task",
        "Run a prompt in this project every so many minutes.",
        &[
            ("name", "string"),
            ("prompt", "string"),
            ("every_minutes", "number"),
        ],
        &["name", "prompt", "every_minutes"],
    ),
    act(
        "orbyn_schedule_delete",
        "Delete a scheduled task in this project.",
        &[("task_id", "string")],
        &["task_id"],
    ),
    act(
        "orbyn_schedule_run",
        "Run a scheduled task in this project now.",
        &[("task_id", "string")],
        &["task_id"],
    ),
];

/// The tool list for `tools/list`.
pub(crate) fn tool_specs() -> impl Iterator<Item = Value> {
    TOOLS.iter().map(|tool| {
        let properties: serde_json::Map<String, Value> = tool
            .args
            .iter()
            .map(|(name, kind)| ((*name).to_owned(), json!({ "type": kind })))
            .collect();
        json!({
            "name": tool.name,
            "description": tool.description,
            "inputSchema": {
                "type": "object",
                "properties": properties,
                "required": tool.required,
            },
        })
    })
}

pub(crate) fn has_effect(name: &str) -> bool {
    TOOLS.iter().any(|tool| tool.name == name && tool.effect)
}

pub(crate) fn is_tool(name: &str) -> bool {
    TOOLS.iter().any(|tool| tool.name == name)
}

fn text<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| CoreError::Invalid(format!("{key} is required.")))
}

fn number(args: &Value, key: &str) -> Result<u64> {
    args.get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| CoreError::Invalid(format!("{key} is required.")))
}

/// All of the query's words, in any order, ignoring case.
pub(crate) fn matches_words(haystack: &str, query: &str) -> bool {
    let haystack = haystack.to_lowercase();
    let mut words = query.split_whitespace().peekable();
    words.peek().is_some() && words.all(|word| haystack.contains(&word.to_lowercase()))
}

impl Core {
    /// Runs one of Orbyn's tools for `binding`'s run. A tool with an effect is
    /// refused unless the gate allows it, and the gate's reason comes back.
    pub async fn call_orbyn_tool(
        &self,
        binding: &McpBinding,
        name: &str,
        args: &Value,
    ) -> Result<Value> {
        let tool = TOOLS
            .iter()
            .find(|tool| tool.name == name)
            .ok_or_else(|| CoreError::NotFound(format!("tool {name}")))?;
        if tool.effect {
            let ask = ActionAsk {
                kind: ActionKind::Tool,
                target: name.to_owned(),
                summary: format!("Use {name}"),
                detail: args.clone(),
                paths: Vec::new(),
            };
            if let Verdict::Deny(reason) = self.gate.request(&binding.scope, ask).await {
                return Err(CoreError::PolicyDenied(reason));
            }
        }
        self.run_orbyn_tool(binding, name, args).await
    }

    /// A thread in the caller's project. Anything else reads as not found, so a
    /// tool cannot be used to learn what other projects hold.
    fn project_thread(&self, binding: &McpBinding, id: &str) -> Result<Thread> {
        let own = self.store.thread(&binding.scope.thread_id)?;
        let thread = self.store.thread(id)?;
        if thread.project_id != own.project_id {
            return Err(CoreError::NotFound("thread".into()));
        }
        Ok(thread)
    }

    fn project_task(&self, binding: &McpBinding, id: &str) -> Result<()> {
        let own = self.store.thread(&binding.scope.thread_id)?;
        if self.store.task(id)?.project_id != own.project_id {
            return Err(CoreError::NotFound("scheduled task".into()));
        }
        Ok(())
    }

    /// A new thread in the caller's project with a first message.
    async fn launch(&self, own: &Thread, spec: &Value, worktree: Option<String>) -> Result<Value> {
        let string = |key: &str| spec.get(key).and_then(Value::as_str).map(str::to_owned);
        let thread = self
            .create_thread(CreateThread {
                project_id: Some(own.project_id.clone()),
                engine: string("engine").unwrap_or_else(|| own.engine.clone()),
                model: None,
                title: string("title"),
                worktree,
                skill_profile: own.skill_profile.clone(),
                base_branch: string("base_branch"),
                effort: None,
                options: std::collections::BTreeMap::new(),
            })
            .await?;
        self.runs.enqueue(&thread.id, text(spec, "prompt")?, &[])?;
        Ok(json!({ "thread_id": thread.id }))
    }

    /// A checkout file as an attachment. Trust, `..`, links and `.git` are the same
    /// checks as any file route, and a thread can only draw on its own checkout.
    fn attach_from_checkout(
        &self,
        own: &Thread,
        target: &str,
        path: &str,
    ) -> Result<orbyn_contracts::Attachment> {
        let bytes = self.open_raw_file(&own.id, path, true)?;
        let mut body = Vec::new();
        std::io::Read::read_to_end(&mut &bytes.file, &mut body)?;
        self.add_attachment(target, &bytes.name, "application/octet-stream", &body)
    }

    fn own_preview(&self, own: &Thread, args: &Value) -> Result<String> {
        let tab = text(args, "tab_id")?.to_owned();
        if !self
            .previews
            .list(&own.id)
            .iter()
            .any(|view| view.id == tab)
        {
            return Err(CoreError::NotFound("preview".into()));
        }
        Ok(tab)
    }

    #[allow(clippy::too_many_lines)]
    async fn run_orbyn_tool(
        &self,
        binding: &McpBinding,
        name: &str,
        args: &Value,
    ) -> Result<Value> {
        let actor = format!("engine:{}", binding.scope.engine);
        let own = self.store.thread(&binding.scope.thread_id)?;
        let thread_arg = || self.project_thread(binding, text(args, "thread_id")?);
        if name.starts_with("orbyn_preview")
            && self.preference("enable_agent_browser_access", Some(&own.project_id))?
                == json!(false)
        {
            return Err(CoreError::Invalid(
                "Agents can't use the browser here. It's turned off in Settings.".into(),
            ));
        }
        Ok(match name {
            "orbyn_environment_read" => json!({
                "version": env!("CARGO_PKG_VERSION"),
                "platform": std::env::consts::OS,
                "thread_id": own.id,
                "project_id": own.project_id,
                "checkout": own.cwd,
                "engine": own.engine,
            }),
            "orbyn_project_read" => json!({
                "project": self.store.project(&own.project_id)?,
                "file": self.project_file(&own.id)?,
            }),
            "orbyn_worktree_list" => {
                let project = self.store.project(&own.project_id)?;
                let found = crate::git::linked_worktrees(Path::new(&project.path)).await;
                let listed: Vec<Value> = found
                    .unwrap_or_default()
                    .into_iter()
                    .map(|worktree| json!({ "path": worktree.path, "branch": worktree.branch }))
                    .collect();
                json!(listed)
            }
            "orbyn_thread_list" => json!(self.store.list_threads(Some(&own.project_id), false)?),
            "orbyn_thread_read" => {
                let thread = thread_arg()?;
                let text = self.store.recovery_handoff(&thread.id)?;
                json!({ "thread": thread, "text": text })
            }
            "orbyn_thread_search" => {
                let query = text(args, "query")?;
                let mut hits = Vec::new();
                for thread in self.store.list_threads(Some(&own.project_id), false)? {
                    let body = self.store.transcript(&thread.id, MAX_SEARCH_CHARS)?;
                    if matches_words(&format!("{} {body}", thread.title), query) {
                        hits.push(json!({ "id": thread.id, "title": thread.title }));
                        if hits.len() == MAX_HITS {
                            break;
                        }
                    }
                }
                json!(hits)
            }
            "orbyn_thread_wait" => {
                let thread = thread_arg()?;
                if thread.id == own.id {
                    return Err(CoreError::Invalid(
                        "A thread cannot wait for itself.".into(),
                    ));
                }
                let seconds = args.get("seconds").and_then(Value::as_u64).unwrap_or(30);
                let deadline = std::time::Instant::now()
                    + std::time::Duration::from_secs(seconds.min(MAX_WAIT_SECONDS));
                loop {
                    let thread = self.store.thread(&thread.id)?;
                    let ended = thread.active_run.is_none();
                    if ended || std::time::Instant::now() >= deadline {
                        break json!({
                            "ended": ended,
                            "last_run_state": thread.last_run_state,
                        });
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                }
            }
            "orbyn_queue_list" => json!(self.store.list_queue(&thread_arg()?.id)?),
            "orbyn_pending_requests" => {
                let thread = thread_arg()?;
                json!({
                    "approvals": self.store.pending_for_thread(&thread.id)?,
                    "questions": self.store.list_questions(
                        Some(&thread.id),
                        Some(orbyn_contracts::QuestionState::Pending),
                    )?,
                })
            }
            "orbyn_pull_list" => json!({
                "linked": self.store.linked_pulls(&own.id)?,
                "watched": self.thread_watches(&own.id)?,
            }),
            "orbyn_schedule_list" => {
                let tasks = self.store.tasks()?;
                let tasks: Vec<_> = tasks
                    .into_iter()
                    .filter(|task| task.project_id == own.project_id)
                    .collect();
                json!(tasks)
            }
            "orbyn_task_status" => {
                let thread = thread_arg()?;
                json!({
                    "active": thread.active_run.is_some(),
                    "last_run_state": thread.last_run_state,
                })
            }
            "orbyn_track_files" => {
                let paths: Vec<String> = args
                    .get("paths")
                    .and_then(Value::as_array)
                    .ok_or_else(|| CoreError::Invalid("paths is required.".into()))?
                    .iter()
                    .filter_map(|path| path.as_str().map(str::to_owned))
                    .take(200)
                    .collect();
                let done = args.get("done").and_then(Value::as_bool).unwrap_or(false);
                crate::file_changes::record(&self.store, &binding.scope, &paths, done);
                json!({ "tracked": paths.len() })
            }
            "orbyn_thread_launch" => self.launch(&own, args, None).await?,
            "orbyn_threads_create" => {
                let specs = args
                    .get("threads")
                    .and_then(Value::as_array)
                    .filter(|specs| specs.len() <= MAX_BATCH)
                    .ok_or_else(|| {
                        CoreError::Invalid(format!("threads is a list of up to {MAX_BATCH}."))
                    })?;
                let mut results = Vec::with_capacity(specs.len());
                for spec in specs {
                    results.push(match self.launch(&own, spec, None).await {
                        Ok(started) => started,
                        Err(error) => json!({ "error": error.public_message() }),
                    });
                }
                json!(results)
            }
            "orbyn_worktree_handoff" => {
                let purpose = text(args, "purpose")?.to_owned();
                self.launch(&own, args, Some(purpose)).await?
            }
            "orbyn_worktree_status" => {
                let checkout = Path::new(&own.cwd);
                let status = crate::git::git(checkout, &["status", "--porcelain", "-b"]).await?;
                let status = String::from_utf8_lossy(&status);
                let mut lines = status.lines();
                let branch = lines.next().and_then(|line| line.strip_prefix("## "));
                let project = self.store.project(&own.project_id)?;
                json!({
                    "checkout": own.cwd,
                    "branch": branch,
                    "worktree": Path::new(&project.path) != checkout,
                    "changed": lines.map(|line| line.get(3..).unwrap_or(line)).collect::<Vec<_>>(),
                })
            }
            "orbyn_orchestrator_capabilities" => {
                let nested =
                    own.lifecycle.as_ref().and_then(|l| l.relation.as_deref()) == Some("subagent");
                let engines: Vec<Value> = self
                    .engines
                    .statuses(false)
                    .await?
                    .into_iter()
                    .map(|engine| json!({ "id": engine.id, "name": engine.name }))
                    .collect();
                json!({
                    "engines": engines,
                    "can_delegate": !nested,
                    "max_batch": MAX_BATCH,
                })
            }
            "orbyn_environment_preferences_update" => {
                let values = args
                    .get("values")
                    .and_then(Value::as_object)
                    .ok_or_else(|| CoreError::Invalid("values is required.".into()))?
                    .iter()
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect();
                self.set_preferences(Some(&own.project_id), &values)?;
                json!({ "updated": values.len() })
            }
            "orbyn_project_update" => {
                json!(self.rename_project(&own.project_id, text(args, "name")?)?)
            }
            "orbyn_thread_send" => {
                let thread = thread_arg()?;
                let attachments: Vec<String> = args
                    .get("attachment_ids")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|id| id.as_str().map(str::to_owned))
                    .collect();
                json!(
                    self.runs
                        .enqueue(&thread.id, text(args, "prompt")?, &attachments)?
                )
            }
            "orbyn_attachment_add" => {
                let thread = thread_arg()?;
                json!(self.attach_from_checkout(&own, &thread.id, text(args, "path")?)?)
            }
            "orbyn_attachment_discard" => {
                let thread = thread_arg()?;
                let id = text(args, "attachment_id")?;
                let held = self.store.list_attachments(&thread.id)?;
                if !held.iter().any(|(attachment, _)| attachment.id == id) {
                    return Err(CoreError::NotFound("attachment".into()));
                }
                self.remove_attachment(id)?;
                json!({ "discarded": true })
            }
            "orbyn_thread_organize" => {
                let thread = thread_arg()?;
                let flag = |key: &str| args.get(key).and_then(Value::as_bool);
                let patch = UpdateThread {
                    pinned: flag("pinned"),
                    settled: flag("settled"),
                    archived: flag("archived"),
                    unread: flag("unread"),
                    snoozed_until: args
                        .get("snoozed_until")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    ..UpdateThread::default()
                };
                json!(self.update_thread(&thread.id, &patch, &actor)?)
            }
            "orbyn_thread_configure" => {
                let thread = thread_arg()?;
                let string = |key: &str| args.get(key).and_then(Value::as_str).map(str::to_owned);
                let mode = args
                    .get("permission_mode")
                    .filter(|value| !value.is_null())
                    .map(|value| serde_json::from_value(value.clone()))
                    .transpose()
                    .map_err(|_| CoreError::Invalid("That is not a permission mode.".into()))?;
                let patch = UpdateThread {
                    model: string("model"),
                    effort: string("effort"),
                    permission_mode: mode,
                    plan_mode: args.get("plan_mode").and_then(Value::as_bool),
                    ..UpdateThread::default()
                };
                json!(self.update_thread(&thread.id, &patch, &actor)?)
            }
            "orbyn_preview_list" => json!(self.previews.list(&own.id)),
            "orbyn_preview_open" => {
                let size = |key: &str| {
                    args.get(key)
                        .and_then(Value::as_u64)
                        .and_then(|value| u32::try_from(value).ok())
                };
                let url = text(args, "url")?;
                let opened = self.open_preview(
                    &own.id,
                    url,
                    (size("width"), size("height")),
                    &actor,
                    crate::preview::OpenHow::default(),
                );
                json!(opened.await?)
            }
            "orbyn_preview_navigate" => {
                let tab = self.own_preview(&own, args)?;
                if let Some(url) = args.get("url").and_then(Value::as_str) {
                    json!(self.previews.navigate(&own.id, &tab, url).await?)
                } else {
                    let back = args.get("back").and_then(Value::as_bool);
                    let back = back.ok_or_else(|| {
                        CoreError::Invalid("Name a url, or back true or false.".into())
                    })?;
                    json!(self.previews.step(&own.id, &tab, back).await?)
                }
            }
            "orbyn_preview_resize" => {
                let tab = self.own_preview(&own, args)?;
                let side = |key: &str| {
                    u32::try_from(number(args, key)?)
                        .map_err(|_| CoreError::Invalid(format!("{key} is too large.")))
                };
                let (width, height) = (side("width")?, side("height")?);
                json!(self.previews.resize(&own.id, &tab, width, height).await?)
            }
            "orbyn_preview_status" => {
                let tab = self.own_preview(&own, args)?;
                let tabs = self.previews.list(&own.id);
                json!(tabs.into_iter().find(|view| view.id == tab))
            }
            "orbyn_preview_set_appearance" => {
                let tab = self.own_preview(&own, args)?;
                let view = orbyn_contracts::PreviewView {
                    zoom: None,
                    appearance: Some(text(args, "appearance")?.to_owned()),
                    mobile: None,
                };
                json!(self.previews.set_view(&own.id, &tab, &view).await?)
            }
            "orbyn_preview_dialog" => {
                let tab = self.own_preview(&own, args)?;
                let accept = args
                    .get("accept")
                    .and_then(Value::as_bool)
                    .ok_or_else(|| CoreError::Invalid("Say whether to accept.".into()))?;
                let answer = args.get("text").and_then(Value::as_str);
                let handled = self.previews.answer_dialog(&own.id, &tab, accept, answer);
                json!({ "handled": handled.await? })
            }
            "orbyn_preview_close" => {
                let tab = self.own_preview(&own, args)?;
                self.previews.close(&own.id, &tab)?;
                json!({ "closed": true })
            }
            "orbyn_preview_recording_start" => {
                let tab = self.own_preview(&own, args)?;
                self.start_preview_recording(&own.id, &tab)?;
                json!({ "recording": true })
            }
            "orbyn_preview_recording_stop" => {
                let tab = self.own_preview(&own, args)?;
                json!(self.previews.stop_recording(&own.id, &tab)?)
            }
            "orbyn_thread_update" => {
                let thread = thread_arg()?;
                let patch = UpdateThread {
                    title: args.get("title").and_then(Value::as_str).map(str::to_owned),
                    pinned: args.get("pinned").and_then(Value::as_bool),
                    settled: args.get("settled").and_then(Value::as_bool),
                    ..UpdateThread::default()
                };
                json!(self.update_thread(&thread.id, &patch, &actor)?)
            }
            "orbyn_thread_interrupt" | "orbyn_task_cancel" => {
                let thread = thread_arg()?;
                if thread.id == own.id {
                    return Err(CoreError::Invalid("A thread cannot stop itself.".into()));
                }
                let stopped = thread.active_run.map(|run| self.runs.cancel(&run.id));
                json!({ "stopped": matches!(stopped, Some(Ok(()))) })
            }
            "orbyn_pull_link" => json!(self.link_pull(&own.id, number(args, "number")?).await?),
            "orbyn_pull_unlink" => {
                self.store.unlink_pull(&own.id, number(args, "number")?)?;
                json!({ "unlinked": true })
            }
            "orbyn_pull_watch" => json!(self.watch_pull(&own.id, number(args, "number")?)?),
            "orbyn_pull_unwatch" => {
                self.store.unwatch_pull(&own.id, number(args, "number")?)?;
                json!({ "unwatched": true })
            }
            "orbyn_delegate_task" => {
                let nested =
                    own.lifecycle.as_ref().and_then(|l| l.relation.as_deref()) == Some("subagent");
                if nested {
                    return Err(CoreError::Invalid(
                        "A delegated thread cannot delegate further.".into(),
                    ));
                }
                let task = DelegateTask {
                    prompt: text(args, "prompt")?.to_owned(),
                    title: args.get("title").and_then(Value::as_str).map(str::to_owned),
                    engine: args
                        .get("engine")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    model: None,
                    effort: None,
                    options: std::collections::BTreeMap::new(),
                };
                let child = self.delegate(&own.id, &task, &actor)?;
                json!({ "thread_id": child.id })
            }
            "orbyn_schedule_task" => {
                let minutes = u32::try_from(number(args, "every_minutes")?)
                    .map_err(|_| CoreError::Invalid("That interval is too long.".into()))?;
                let task = UpsertTask {
                    id: None,
                    project_id: own.project_id.clone(),
                    thread_id: None,
                    name: text(args, "name")?.to_owned(),
                    prompt: text(args, "prompt")?.to_owned(),
                    engine: own.engine.clone(),
                    schedule: TaskSchedule {
                        kind: "interval".into(),
                        every_minutes: Some(minutes),
                        time: None,
                        weekdays: Vec::new(),
                        utc_offset_minutes: 0,
                        after_thread: None,
                        only_on_success: false,
                    },
                    signature: None,
                    secret: None,
                    filters: Vec::new(),
                    dedupe: None,
                    max_age_seconds: None,
                    timestamp_path: None,
                };
                json!(self.save_task(task, &actor)?)
            }
            "orbyn_schedule_delete" => {
                let id = text(args, "task_id")?;
                self.project_task(binding, id)?;
                self.delete_task(id, &actor)?;
                json!({ "deleted": true })
            }
            "orbyn_schedule_run" => {
                let id = text(args, "task_id")?;
                self.project_task(binding, id)?;
                json!({ "thread_id": self.run_task(id).await? })
            }
            other => return Err(CoreError::NotFound(format!("tool {other}"))),
        })
    }

    /// Records a call before it happens, whichever way the gate then goes.
    pub(crate) fn note_tool(&self, binding: &McpBinding, name: &str) -> Result<()> {
        self.store.append_audit(&AuditRecord {
            actor: format!("engine:{}", binding.scope.engine),
            action: "tool.call".into(),
            target: name.to_owned(),
            decision: None,
            source: "engine".into(),
            thread_id: Some(binding.scope.thread_id.clone()),
            run_id: Some(binding.scope.run_id.clone()),
            detail: Value::Null,
        })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_word_must_match_in_any_order() {
        assert!(matches_words("Fix the Login page", "login fix"));
        assert!(!matches_words("Fix the login page", "login logout"));
        assert!(!matches_words("anything", "   "));
    }

    #[test]
    fn tool_names_are_unique_and_required_arguments_exist() {
        for tool in TOOLS {
            assert_eq!(TOOLS.iter().filter(|t| t.name == tool.name).count(), 1);
            for required in tool.required {
                assert!(
                    tool.args.iter().any(|(name, _)| name == required),
                    "{}",
                    tool.name
                );
            }
        }
    }
}
