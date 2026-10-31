//! The per-run MCP server: hand-written JSON-RPC behind `POST /mcp/:thread_token`.
//! A token is random per run, reaches only that run's engine and dies with the run.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;

use orbyn_contracts::{ActionKind, ComputerAction, Question, QuestionOption};
use serde_json::{Value, json};

use crate::app::Core;
use crate::approvals::{ActionAsk, ApprovalGate, RunScope, Verdict};
use crate::computer::{Caller, ComputerGateway};
use crate::driver::MCP_SERVER_NAME;
use crate::error::Result;
use crate::questions::QuestionDesk;
use crate::skills::SkillService;
use crate::util::{random_token, sha256_hex};

const PROTOCOL_VERSION: &str = "2025-06-18";
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;
const QUESTION_TOOL: &str = "AskUserQuestion";
/// Tools this server provides. Each governs itself, so `approve` does not ask again.
const OWN_TOOL_PREFIX: &str = "mcp__orbyn_engineering__";

/// Engines give up on a tool call at about a minute, so a reply has to be sent first.
const TOOL_BUDGET: Duration = Duration::from_secs(45);
/// A tool that can wait on a person gets longer, and a late answer does nothing: the
/// wait is dropped, which expires the approval. Claude's `approve` is a run's own
/// permission prompt, on the approval timeout rather than this.
const GATED_BUDGET: Duration = Duration::from_secs(240);
/// The largest reply a tool sends back, in bytes.
const MAX_RESULT_BYTES: usize = 256 * 1024;
/// The largest request accepted, in bytes. A prompt can be 120,000 characters.
pub const MAX_REQUEST_BYTES: usize = 512 * 1024;

/// The token is unknown or already revoked.
#[derive(Debug)]
pub struct InvalidToken;

#[derive(Clone, Debug)]
pub struct McpBinding {
    pub scope: RunScope,
    /// `approve` is Claude's private permission callback; others never see it.
    pub permission_prompt: bool,
    pub skills: Vec<String>,
}

pub struct McpService {
    /// Keyed by digest, so a lookup reveals nothing about stored tokens.
    tokens: Mutex<HashMap<String, Arc<McpBinding>>>,
    gate: Arc<ApprovalGate>,
    questions: Arc<QuestionDesk>,
    skills: Arc<SkillService>,
    computer: Arc<ComputerGateway>,
    /// Set once the core exists, which is built after this service. Weak, since
    /// the core owns this service.
    host: OnceLock<Weak<Core>>,
}

impl McpService {
    pub fn new(
        gate: Arc<ApprovalGate>,
        questions: Arc<QuestionDesk>,
        skills: Arc<SkillService>,
        computer: Arc<ComputerGateway>,
    ) -> Self {
        Self {
            tokens: Mutex::new(HashMap::new()),
            gate,
            questions,
            skills,
            computer,
            host: OnceLock::new(),
        }
    }

    /// Connects Orbyn's own tools. Until then they refuse rather than guess.
    pub fn bind_host(&self, core: &Arc<Core>) {
        let _ = self.host.set(Arc::downgrade(core));
    }

    pub fn register(&self, binding: McpBinding) -> Result<String> {
        let token = random_token()?;
        self.lock()
            .insert(sha256_hex(token.as_bytes()), Arc::new(binding));
        Ok(token)
    }

    pub fn revoke(&self, token: &str) {
        self.lock().remove(&sha256_hex(token.as_bytes()));
    }

    pub fn is_valid(&self, token: &str) -> bool {
        self.lock().contains_key(&sha256_hex(token.as_bytes()))
    }

    fn binding(&self, token: &str) -> Option<Arc<McpBinding>> {
        self.lock().get(&sha256_hex(token.as_bytes())).cloned()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<McpBinding>>> {
        self.tokens
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Handles one message. `Ok(None)` is a notification, which has no response.
    pub async fn handle(
        &self,
        token: &str,
        message: &Value,
    ) -> Result<Option<Value>, InvalidToken> {
        let binding = self.binding(token).ok_or(InvalidToken)?;
        let Some(id) = message.get("id").filter(|id| !id.is_null()) else {
            return Ok(None);
        };
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        let reply = match method {
            "initialize" => Ok(json!({
                "protocolVersion": params
                    .get("protocolVersion")
                    .cloned()
                    .unwrap_or(json!(PROTOCOL_VERSION)),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": MCP_SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
            })),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({ "tools": tool_list(binding.permission_prompt) })),
            "tools/call" => {
                let name = params.get("name").and_then(Value::as_str).unwrap_or("");
                match budget_for(name) {
                    Some(budget) => within(budget, self.call_tool(&binding, &params)).await,
                    None => self.call_tool(&binding, &params).await,
                }
            }
            _ => Err((METHOD_NOT_FOUND, format!("Unknown method {method}."))),
        };
        Ok(Some(match reply {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err((code, text)) => json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": code, "message": text },
            }),
        }))
    }

    async fn call_tool(
        &self,
        binding: &McpBinding,
        params: &Value,
    ) -> Result<Value, (i64, String)> {
        let name = params.get("name").and_then(Value::as_str).unwrap_or("");
        let args = params.get("arguments").cloned().unwrap_or(json!({}));
        let text_arg = |key: &str| args.get(key).and_then(Value::as_str).map(str::to_owned);
        match name {
            "approve" if binding.permission_prompt => {
                Ok(text_result(&self.approve(binding, &args).await, false))
            }
            "skill_search" => {
                let query = text_arg("query").unwrap_or_default();
                match self.skills.search(&query, &binding.skills) {
                    Ok(found) => Ok(text_result(&json!(found).to_string(), false)),
                    Err(error) => Ok(text_result(&error.public_message(), true)),
                }
            }
            "skill_load" => {
                let Some(skill) = text_arg("name") else {
                    return Err((INVALID_PARAMS, "skill_load needs a name.".into()));
                };
                let file = text_arg("file");
                match self.skills.load(&skill, file.as_deref(), &binding.skills) {
                    Ok(text) => Ok(text_result(&text, false)),
                    Err(error) => Ok(text_result(&error.public_message(), true)),
                }
            }
            other if crate::mcp_tools::is_tool(other) => {
                let Some(core) = self.host.get().and_then(Weak::upgrade) else {
                    return Ok(text_result("This service is not ready.", true));
                };
                if let Err(error) = core.note_tool(binding, other) {
                    tracing::warn!(%error, "could not record a tool call");
                }
                match core.call_orbyn_tool(binding, other, &args).await {
                    Ok(result) => Ok(text_result(&result.to_string(), false)),
                    Err(error) => Ok(text_result(&error.public_message(), true)),
                }
            }
            other if other.starts_with("computer_") => {
                let Some(action) = computer_action(other, &args) else {
                    return Err((METHOD_NOT_FOUND, format!("Unknown tool {other}.")));
                };
                match self.computer.act(Caller::Run(&binding.scope), action).await {
                    Ok(result) => Ok(text_result(&json!(result).to_string(), false)),
                    Err(error) => Ok(text_result(&error.public_message(), true)),
                }
            }
            other => Err((METHOD_NOT_FOUND, format!("Unknown tool {other}."))),
        }
    }

    /// Answers Claude's permission prompt with the JSON the CLI parses.
    async fn approve(&self, binding: &McpBinding, args: &Value) -> String {
        let tool = args
            .get("tool_name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let input = args.get("input").cloned().unwrap_or(json!({}));
        if tool == QUESTION_TOOL {
            return self.ask_question(binding, input).await;
        }
        if tool.starts_with(OWN_TOOL_PREFIX) {
            return allow_json(&input);
        }
        let ask = classify_tool(&tool, &input);
        match self.gate.request(&binding.scope, ask).await {
            Verdict::Allow => allow_json(&input),
            Verdict::Deny(reason) => deny_json(&reason),
        }
    }
}

impl McpService {
    /// Claude's question tool is answered through its input: the person's choices
    /// go back as `answers`, keyed by question text, in one comma-joined string.
    async fn ask_question(&self, binding: &McpBinding, mut input: Value) -> String {
        let questions = parse_questions(&input);
        if questions.is_empty() {
            return deny_json("This question has nothing to show.");
        }
        match self.questions.ask(&binding.scope.run_id, questions).await {
            Some(answers) => {
                let joined: serde_json::Map<String, Value> = answers
                    .into_iter()
                    .map(|(question, values)| (question, json!(values.join(", "))))
                    .collect();
                input["answers"] = Value::Object(joined);
                allow_json(&input)
            }
            None => deny_json("The user dismissed this question without answering."),
        }
    }
}

fn parse_questions(input: &Value) -> Vec<Question> {
    let text = |value: &Value, key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    input
        .get("questions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|item| Question {
            id: text(item, "question"),
            header: text(item, "header"),
            question: text(item, "question"),
            options: item
                .get("options")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|option| QuestionOption {
                    label: text(option, "label"),
                    description: text(option, "description"),
                })
                .collect(),
            multi_select: item.get("multiSelect").and_then(Value::as_bool) == Some(true),
            allow_other: true,
            secret: false,
        })
        .filter(|question| !question.id.is_empty())
        .collect()
}

fn allow_json(input: &Value) -> String {
    json!({ "behavior": "allow", "updatedInput": input }).to_string()
}

fn deny_json(message: &str) -> String {
    json!({ "behavior": "deny", "message": message }).to_string()
}

/// How long a tool may take. `None` is for Claude's permission prompt.
fn budget_for(name: &str) -> Option<Duration> {
    if name == "approve" {
        None
    } else if name.starts_with("computer_") || crate::mcp_tools::has_effect(name) {
        Some(GATED_BUDGET)
    } else {
        Some(TOOL_BUDGET)
    }
}

/// Runs a tool call inside its budget. Going over drops the call, and a call waiting on
/// an approval expires it as it drops.
async fn within(
    budget: Duration,
    call: impl Future<Output = Result<Value, (i64, String)>>,
) -> Result<Value, (i64, String)> {
    match tokio::time::timeout(budget, call).await {
        Ok(reply) => reply,
        Err(_) => Ok(text_result("This tool did not finish in time.", true)),
    }
}

/// Keeps a reply under the limit, on a character boundary, and says so.
fn capped(text: &str) -> std::borrow::Cow<'_, str> {
    if text.len() <= MAX_RESULT_BYTES {
        return text.into();
    }
    let mut end = MAX_RESULT_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n[cut off at {MAX_RESULT_BYTES} bytes]", &text[..end]).into()
}

fn text_result(text: &str, is_error: bool) -> Value {
    let mut result = json!({ "content": [{ "type": "text", "text": capped(text) }] });
    if is_error {
        result["isError"] = json!(true);
    }
    result
}

/// Maps a Claude tool call to the action policy reasons about.
pub fn classify_tool(tool: &str, input: &Value) -> ActionAsk {
    let field = |key: &str| input.get(key).and_then(Value::as_str).map(str::to_owned);
    let (kind, target) = match tool {
        "Bash" => (
            ActionKind::Command,
            field("command").unwrap_or_else(|| tool.to_owned()),
        ),
        "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => (
            ActionKind::FileChange,
            field("file_path")
                .or_else(|| field("notebook_path"))
                .unwrap_or_else(|| tool.to_owned()),
        ),
        "WebFetch" => (
            ActionKind::Network,
            field("url").unwrap_or_else(|| tool.to_owned()),
        ),
        "WebSearch" => (
            ActionKind::Network,
            field("query").unwrap_or_else(|| tool.to_owned()),
        ),
        _ => (ActionKind::Tool, tool.to_owned()),
    };
    let summary = match kind {
        ActionKind::Command => format!("Run {target}"),
        ActionKind::FileChange => format!("Change {target}"),
        ActionKind::Network => format!("Reach {target}"),
        _ => format!("Use {target}"),
    };
    ActionAsk {
        kind,
        target,
        summary,
        detail: json!({ "tool": tool, "input": input }),
        paths: Vec::new(),
    }
}

fn computer_action(tool: &str, args: &Value) -> Option<ComputerAction> {
    let field = |key: &str| {
        args.get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let (action, target) = match tool {
        "computer_browser_navigate" => ("browser.navigate".to_owned(), field("url")),
        "computer_browser_text" => ("browser.text".to_owned(), String::new()),
        "computer_browser_screenshot" => ("browser.screenshot".to_owned(), String::new()),
        "computer_browser_click" => ("browser.click".to_owned(), field("selector")),
        "computer_desktop" => (format!("desktop.{}", field("command")), field("target")),
        _ => return None,
    };
    Some(ComputerAction {
        action,
        target,
        args: args.get("args").cloned().unwrap_or(Value::Null),
    })
}

fn tool_list(permission_prompt: bool) -> Vec<Value> {
    let object = |properties: Value, required: Value| json!({ "type": "object", "properties": properties, "required": required });
    let mut tools: Vec<Value> = crate::mcp_tools::tool_specs().collect();
    tools.extend([
        json!({
            "name": "skill_search",
            "description": "Search this project's Orbyn engineering skills by keyword.",
            "inputSchema": object(json!({ "query": { "type": "string" } }), json!(["query"])),
        }),
        json!({
            "name": "skill_load",
            "description": "Read a skill's SKILL.md, or a file it references.",
            "inputSchema": object(
                json!({ "name": { "type": "string" }, "file": { "type": "string" } }),
                json!(["name"]),
            ),
        }),
        json!({
            "name": "computer_browser_navigate",
            "description": "Open a URL in the governed browser. Requires approval by policy.",
            "inputSchema": object(json!({ "url": { "type": "string" } }), json!(["url"])),
        }),
        json!({
            "name": "computer_browser_text",
            "description": "Read the current page's text. Requires approval by policy.",
            "inputSchema": object(json!({}), json!([])),
        }),
        json!({
            "name": "computer_browser_screenshot",
            "description": "Capture the current page. Requires approval by policy.",
            "inputSchema": object(json!({}), json!([])),
        }),
        json!({
            "name": "computer_browser_click",
            "description": "Click a CSS selector on the current page. Requires approval by policy.",
            "inputSchema": object(json!({ "selector": { "type": "string" } }), json!(["selector"])),
        }),
        json!({
            "name": "computer_desktop",
            "description": "Run one agent-desktop command. Requires approval by policy.",
            "inputSchema": object(
                json!({
                    "command": { "type": "string" },
                    "target": { "type": "string" },
                    "args": { "type": "array", "items": { "type": "string" } },
                }),
                json!(["command"]),
            ),
        }),
    ]);
    if permission_prompt {
        tools.insert(
            0,
            json!({
                "name": "approve",
                "description": "Ask Orbyn whether a tool use is allowed.",
                "inputSchema": object(
                    json!({
                        "tool_name": { "type": "string" },
                        "input": { "type": "object" },
                        "tool_use_id": { "type": "string" },
                    }),
                    json!(["tool_name", "input"]),
                ),
            }),
        );
    }
    tools
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_tool_over_its_budget_answers_rather_than_hanging() {
        let reply = within(Duration::from_millis(5), std::future::pending()).await;
        let reply = reply.unwrap();
        assert_eq!(reply["isError"], true);
    }

    #[test]
    fn only_the_permission_prompt_has_no_budget() {
        assert_eq!(budget_for("approve"), None);
        assert_eq!(budget_for("skill_search"), Some(TOOL_BUDGET));
        assert_eq!(budget_for("orbyn_thread_list"), Some(TOOL_BUDGET));
        assert_eq!(budget_for("orbyn_thread_send"), Some(GATED_BUDGET));
        assert_eq!(budget_for("computer_click"), Some(GATED_BUDGET));
    }

    #[test]
    fn a_long_reply_is_cut_on_a_character_boundary_and_says_so() {
        let text = "é".repeat(MAX_RESULT_BYTES);
        let result = text_result(&text, false);
        let shown = result["content"][0]["text"].as_str().unwrap();
        assert!(shown.len() < MAX_RESULT_BYTES + 64);
        assert!(shown.ends_with("bytes]"));
        assert_eq!(text_result("short", false)["content"][0]["text"], "short");
    }

    #[test]
    fn claude_tools_map_to_policy_actions() {
        let bash = classify_tool("Bash", &json!({ "command": "ls -la" }));
        assert_eq!(bash.kind, ActionKind::Command);
        assert_eq!(bash.target, "ls -la");
        let edit = classify_tool("Edit", &json!({ "file_path": "/a/b.rs" }));
        assert_eq!(edit.kind, ActionKind::FileChange);
        assert_eq!(edit.target, "/a/b.rs");
        let fetch = classify_tool("WebFetch", &json!({ "url": "https://x.test" }));
        assert_eq!(fetch.kind, ActionKind::Network);
        assert_eq!(classify_tool("Mystery", &json!({})).kind, ActionKind::Tool);
    }

    #[test]
    fn approve_is_listed_only_for_the_permission_prompt() {
        let names = |tools: Vec<Value>| -> Vec<String> {
            tools
                .iter()
                .map(|tool| tool["name"].as_str().unwrap().to_owned())
                .collect()
        };
        assert!(names(tool_list(true)).contains(&"approve".to_owned()));
        assert!(!names(tool_list(false)).contains(&"approve".to_owned()));
    }

    #[test]
    fn computer_tools_become_gateway_actions() {
        let action = computer_action(
            "computer_desktop",
            &json!({ "command": "click", "target": "@s1:e2" }),
        )
        .unwrap();
        assert_eq!(action.action, "desktop.click");
        assert_eq!(action.target, "@s1:e2");
        assert!(computer_action("computer_unknown", &json!({})).is_none());
    }
}
