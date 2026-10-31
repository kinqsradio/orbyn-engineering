//! The per-run MCP server: hand-written JSON-RPC behind `POST /mcp/:thread_token`.
//! A token is random per run, reaches only that run's engine and dies with the run.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use orbyn_contracts::{ActionKind, ComputerAction};
use serde_json::{Value, json};

use crate::approvals::{ActionAsk, ApprovalGate, RunScope, Verdict};
use crate::computer::{Caller, ComputerGateway};
use crate::driver::MCP_SERVER_NAME;
use crate::error::Result;
use crate::skills::SkillService;
use crate::util::{random_token, sha256_hex};

const PROTOCOL_VERSION: &str = "2025-06-18";
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;
const QUESTION_TOOL: &str = "AskUserQuestion";
/// Tools this server provides. Each governs itself, so `approve` does not ask again.
const OWN_TOOL_PREFIX: &str = "mcp__orbyn_engineering__";

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
    skills: Arc<SkillService>,
    computer: Arc<ComputerGateway>,
}

impl McpService {
    pub fn new(
        gate: Arc<ApprovalGate>,
        skills: Arc<SkillService>,
        computer: Arc<ComputerGateway>,
    ) -> Self {
        Self {
            tokens: Mutex::new(HashMap::new()),
            gate,
            skills,
            computer,
        }
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
            "tools/call" => self.call_tool(&binding, &params).await,
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
            return deny_json(
                "Orbyn cannot show this question as a form. Ask it in your reply and stop.",
            );
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

fn allow_json(input: &Value) -> String {
    json!({ "behavior": "allow", "updatedInput": input }).to_string()
}

fn deny_json(message: &str) -> String {
    json!({ "behavior": "deny", "message": message }).to_string()
}

fn text_result(text: &str, is_error: bool) -> Value {
    let mut result = json!({ "content": [{ "type": "text", "text": text }] });
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
    let mut tools = vec![
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
    ];
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
