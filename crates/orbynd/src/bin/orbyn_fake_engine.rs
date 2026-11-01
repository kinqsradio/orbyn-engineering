//! A deterministic protocol double. It speaks each engine's wire format over
//! real pipes or sockets so tests exercise real parsing. Frames are written by
//! hand from the Codex 0.166.0 generated schema, Claude Code's stream-json
//! output, ACP v1 and the AG-UI 1.0 schema; none are recorded from live engines.
//!
//! Prompts carry scenario tags:
//! `[approve]`, `[crash-in-approval]`, `[hang]`, `[late]`, `[fail]`,
//! `[unknown-request]`, `[mcp-tools]`, `[question]`. With `ORBYN_FAKE_LOSE_SESSION`
//! set, Claude and Codex refuse every resume.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};

use serde_json::{Value, json};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    record_pid();
    let first = args.first().map(String::as_str).unwrap_or_default();
    match first {
        "--version" => println!(
            "{}",
            std::env::var("FAKE_VERSION").unwrap_or("0.166.0".into())
        ),
        "auth" => println!("{}", json!({ "loggedIn": true, "authMethod": "fake" })),
        "login" => println!("Logged in using fake"),
        "app-server" => {
            record_launch("codex", &args);
            codex();
        }
        "-p" if !args.iter().any(|arg| arg == "--input-format") => one_shot(),
        "exec" => one_shot(),
        "-p" => {
            record_launch("claude", &args);
            claude(&args);
        }
        "acp" => {
            record_launch("acp", &args);
            acp();
        }
        "agui" => agui(&args),
        "pty" => pty(),
        other => {
            eprintln!("unknown mode {other}");
            std::process::exit(2);
        }
    }
}

/// Lets a test watch this process's lifetime.
/// Lets a test assert how an engine was launched.
fn record_launch(mode: &str, args: &[String]) {
    if let Ok(path) = std::env::var("ORBYN_FAKE_LAUNCH_FILE") {
        let entry = json!({
            "mode": mode,
            "args": args,
            "cwd": std::env::current_dir().expect("cwd"),
            "env": std::env::vars_os()
                .map(|(name, _)| name.to_string_lossy().into_owned())
                .filter(|name| ["CLAUDE", "ANTHROPIC", "CODEX_S", "OPENAI"]
                    .iter()
                    .any(|prefix| name.starts_with(prefix)))
                .collect::<Vec<_>>(),
        });
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .expect("launch file");
        writeln!(file, "{entry}").expect("launch write");
    }
}

fn record_pid() {
    if let Ok(path) = std::env::var("ORBYN_FAKE_PID_FILE") {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .expect("pid file");
        writeln!(file, "{}", std::process::id()).expect("pid write");
    }
}

fn record_claude_control(frame: &Value) {
    if let Ok(path) = std::env::var("ORBYN_FAKE_CLAUDE_CONTROL_FILE") {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        writeln!(file, "{frame}").unwrap();
    }
}

fn send(value: &Value) {
    let mut out = std::io::stdout().lock();
    writeln!(out, "{value}").expect("stdout");
    out.flush().expect("flush");
}

fn stdin_lines() -> impl Iterator<Item = Value> {
    std::io::stdin()
        .lock()
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| serde_json::from_str(&line).ok())
}

fn has(prompt: &str, tag: &str) -> bool {
    prompt.contains(&format!("[{tag}]"))
}

/// Plain HTTP POST, enough to reach Orbyn's MCP endpoint without a client stack.
fn http_post(url: &str, body: &Value) -> (u16, Value) {
    let rest = url.strip_prefix("http://").expect("http url");
    let (host, path) = rest.split_once('/').expect("path");
    let mut stream = TcpStream::connect(host).expect("connect");
    let body = body.to_string();
    write!(
        stream,
        "POST /{path} HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .expect("write");
    let mut response = String::new();
    stream.read_to_string(&mut response).expect("read");
    let (head, text) = response.split_once("\r\n\r\n").expect("response");
    let status = head
        .split_whitespace()
        .nth(1)
        .expect("status")
        .parse()
        .expect("status");
    (status, serde_json::from_str(text).unwrap_or(Value::Null))
}

fn mcp_call(url: &str, id: u64, method: &str, params: Value) -> (u16, Value) {
    http_post(
        url,
        &json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
    )
}

/// A one-off prompt on stdin, answered on stdout. Each call is recorded,
/// because in a real engine each one spends the user's usage.
fn one_shot() {
    let mut prompt = String::new();
    std::io::stdin().read_to_string(&mut prompt).expect("stdin");
    if let Ok(path) = std::env::var("ORBYN_FAKE_ONE_SHOT_FILE") {
        std::fs::write(&path, &prompt).expect("record");
        let args: Vec<String> = std::env::args().skip(1).collect();
        let args_path = std::path::Path::new(&path).with_extension("args");
        std::fs::write(args_path, args.join(" ")).expect("record args");
    }
    if prompt.contains("[slow-title]") {
        std::thread::sleep(std::time::Duration::from_millis(600));
    }
    if prompt.contains("[bad-title]") {
        eprintln!("title failure");
        std::process::exit(4);
    }
    println!("\"A fresh title.\"\nextra line");
}

// Claude Code stream-json.

fn claude(args: &[String]) {
    if args.iter().any(|arg| arg == "--bare") {
        eprintln!("--bare ignores OAuth login");
        std::process::exit(9);
    }
    let flag = |name: &str| {
        args.iter()
            .position(|arg| arg == name)
            .and_then(|index| args.get(index + 1))
            .cloned()
    };
    let mut lines = stdin_lines();
    let Some(mut first) = lines.next() else {
        return;
    };
    if first["type"] == "control_request" {
        assert_eq!(first["request"]["subtype"], "initialize");
        record_claude_control(&first);
        if std::env::var_os("ORBYN_FAKE_NO_INITIALIZE").is_some() {
            return;
        }
        record_launch("claude-probe", args);
        send(&json!({ "type": "control_response", "response": {
            "subtype": "success", "request_id": first["request_id"], "response": {
                "models": [
                    { "value": "default", "displayName": "Default", "supportsEffort": true,
                      "supportedEffortLevels": ["low", "high"] },
                    { "value": "fable", "displayName": "Fable", "supportsEffort": true,
                      "supportedEffortLevels": ["low"], "supportsFastMode": true },
                    { "value": "haiku", "displayName": "Haiku" },
                ],
                "commands": [{ "name": "review", "description": "Review a change" }],
                "agents": [{ "name": "Explore", "description": "Search the code" }],
                "available_output_styles": ["default", "Learning"],
                "output_style": "default",
                "account": { "email": "person@example.com" },
            },
        }}));
        let Some(next) = lines.next() else { return };
        first = next;
        record_claude_control(&first);
        if first["type"] == "control_request" && first["request"]["subtype"] == "get_usage" {
            assert!(args.iter().any(|arg| arg == "--no-session-persistence"));
            assert!(args.iter().any(|arg| arg == "--strict-mcp-config"));
            let mcp: Value =
                serde_json::from_slice(&std::fs::read(flag("--mcp-config").unwrap()).unwrap())
                    .unwrap();
            let settings: Value =
                serde_json::from_slice(&std::fs::read(flag("--settings").unwrap()).unwrap())
                    .unwrap();
            assert_eq!(mcp, json!({ "mcpServers": {} }));
            assert_eq!(settings, json!({ "disableAllHooks": true }));
            assert_eq!(
                std::env::var("ENABLE_CLAUDEAI_MCP_SERVERS").unwrap(),
                "false"
            );
            assert_eq!(std::env::var("CLAUDE_CODE_AUTO_CONNECT_IDE").unwrap(), "0");
            let mode = std::env::var("ORBYN_FAKE_CLAUDE_USAGE").unwrap_or_default();
            if mode == "silent" {
                // EOF is the probe's cleanup path; this is not a model turn.
                for _ in lines {}
                return;
            }
            if mode == "error" {
                send(&json!({ "type": "control_response", "response": {
                    "subtype": "error", "request_id": first["request_id"], "error": "SECRET-MARKER failure",
                }}));
                return;
            }
            let response = if mode == "malformed" {
                json!({ "account": "SECRET-MARKER" })
            } else if mode == "unavailable" || mode.is_empty() {
                json!({ "rate_limits_available": false, "rate_limits": null })
            } else {
                json!({ "rate_limits_available": true, "subscription_type": "pro",
                    "account": { "token": "SECRET-MARKER" }, "session": { "private": "SECRET-MARKER" },
                    "rate_limits": {
                        "five_hour": { "utilization": 54.0, "resets_at": "2027-01-15T08:00:00Z" },
                        "seven_day": { "utilization": 18.4, "resets_at": null },
                        "model_scoped": [{ "display_name": "Fable", "utilization": 73.0, "resets_at": null }],
                        "extra_usage": { "is_enabled": true, "monthly_limit": 100.0, "used_credits": 25.0 }
                    }
                })
            };
            send(&json!({ "type": "control_response", "response": {
                "subtype": "success", "request_id": first["request_id"], "response": response,
            }}));
            return;
        }
    }
    let prompt = first
        .pointer("/message/content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let resume = flag("--resume");
    if let (Some(session), true) = (
        &resume,
        std::env::var_os("ORBYN_FAKE_LOSE_SESSION").is_some(),
    ) {
        send(&json!({
            "type": "result", "subtype": "error_during_execution", "is_error": true,
            "errors": [format!("No conversation found with session ID: {session}")],
        }));
        return;
    }
    if std::env::var_os("ORBYN_FAKE_NOT_LOGGED_IN").is_some() {
        send(&json!({
            "type": "result", "subtype": "error_during_execution", "is_error": true,
            "errors": ["Not logged in · Please run /login\nkey sk-ant-do-not-show"],
        }));
        return;
    }
    let session = resume.unwrap_or_else(|| "claude-session-1".to_owned());
    send(&json!({
        "type": "system", "subtype": "init", "session_id": session, "model": "fake",
        "slash_commands": ["compact", "review", "fake-command"],
    }));
    let block = |index: u64, block: Value| {
        send(&json!({
            "type": "stream_event",
            "event": { "type": "content_block_start", "index": index, "content_block": block },
        }));
    };
    let delta = |index: u64, delta: Value| {
        send(&json!({
            "type": "stream_event",
            "event": { "type": "content_block_delta", "index": index, "delta": delta },
        }));
    };
    let stop = |index: u64| {
        send(&json!({
            "type": "stream_event",
            "event": { "type": "content_block_stop", "index": index },
        }));
    };
    block(0, json!({ "type": "thinking", "thinking": "" }));
    delta(
        0,
        json!({ "type": "thinking_delta", "thinking": "considering" }),
    );
    stop(0);

    if has(&prompt, "plan-item") {
        send(&json!({
            "type": "assistant", "parent_tool_use_id": null,
            "message": { "content": [{
                "type": "tool_use", "id": "todo1", "name": "TodoWrite",
                "input": { "todos": [{ "content": "do it", "status": "in_progress" }] },
            }]},
        }));
        send(&json!({
            "type": "assistant", "parent_tool_use_id": null,
            "message": { "content": [{
                "type": "tool_use", "id": "exit1", "name": "ExitPlanMode",
                "input": { "plan": "# Ship\n1. a" },
            }]},
        }));
    }
    let mut answer = "hello from claude".to_owned();
    let mut lines = lines;
    if has(&prompt, "approve") || has(&prompt, "crash-in-approval") {
        block(
            1,
            json!({ "type": "tool_use", "id": "toolu_1", "name": "Bash" }),
        );
        delta(
            1,
            json!({ "type": "input_json_delta", "partial_json": "{\"command\":\"ls\"}" }),
        );
        stop(1);
        let config: Value = serde_json::from_str(
            &std::fs::read_to_string(flag("--mcp-config").expect("mcp config")).expect("read"),
        )
        .expect("mcp json");
        let url = config["mcpServers"]["orbyn_engineering"]["url"]
            .as_str()
            .expect("url")
            .to_owned();
        mcp_call(
            &url,
            1,
            "initialize",
            json!({ "protocolVersion": "2025-06-18" }),
        );
        if has(&prompt, "crash-in-approval") {
            let call = url.clone();
            std::thread::spawn(move || {
                mcp_call(
                    &call,
                    2,
                    "tools/call",
                    json!({ "name": "approve", "arguments": {
                        "tool_name": "Bash", "input": { "command": "ls" }, "tool_use_id": "toolu_1"
                    }}),
                );
            });
            std::thread::sleep(std::time::Duration::from_millis(300));
            std::process::exit(7);
        }
        let (_, reply) = mcp_call(
            &url,
            2,
            "tools/call",
            json!({ "name": "approve", "arguments": {
                "tool_name": "Bash", "input": { "command": "ls" }, "tool_use_id": "toolu_1"
            }}),
        );
        let text = reply
            .pointer("/result/content/0/text")
            .and_then(Value::as_str)
            .unwrap_or("{}");
        let decision: Value = serde_json::from_str(text).unwrap_or(Value::Null);
        let behavior = decision["behavior"].as_str().unwrap_or("none").to_owned();
        if let Some(words) = decision["message"].as_str() {
            record_launch("claude-denied", &[words.to_owned()]);
        }
        send(&json!({
            "type": "user",
            "message": { "role": "user", "content": [{
                "type": "tool_result", "tool_use_id": "toolu_1",
                "content": [{ "type": "text", "text": format!("tool {behavior}") }],
            }]},
        }));
        answer = format!("permission {behavior}");
    }
    if has(&prompt, "question") {
        let config: Value = serde_json::from_str(
            &std::fs::read_to_string(flag("--mcp-config").expect("mcp config")).expect("read"),
        )
        .expect("mcp json");
        let url = config["mcpServers"]["orbyn_engineering"]["url"]
            .as_str()
            .expect("url")
            .to_owned();
        mcp_call(
            &url,
            1,
            "initialize",
            json!({ "protocolVersion": "2025-06-18" }),
        );
        let (_, reply) = mcp_call(
            &url,
            2,
            "tools/call",
            json!({ "name": "approve", "arguments": {
                "tool_name": "AskUserQuestion", "tool_use_id": "toolu_2", "input": { "questions": [{
                    "question": "Which color?", "header": "Color", "multiSelect": true,
                    "options": [{ "label": "Red", "description": "Warm" }],
                }]},
            }}),
        );
        let decision = reply
            .pointer("/result/content/0/text")
            .and_then(Value::as_str)
            .unwrap_or("{}");
        let decision: Value = serde_json::from_str(decision).unwrap_or(Value::Null);
        answer = format!(
            "question {} {}",
            decision["behavior"].as_str().unwrap_or("none"),
            decision["updatedInput"]["answers"]["Which color?"]
                .as_str()
                .unwrap_or("-"),
        );
    }
    if has(&prompt, "hang") {
        // Stays alive until stdin closes, like the real CLI between turns.
        match lines.next() {
            Some(steer) => {
                answer = format!(
                    "steered: {}",
                    steer
                        .pointer("/message/content")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                );
            }
            None => return,
        }
    }
    record_launch("claude-prompt", std::slice::from_ref(&prompt));
    block(2, json!({ "type": "text", "text": "" }));
    delta(2, json!({ "type": "text_delta", "text": answer }));
    stop(2);
    if has(&prompt, "fail") {
        send(&json!({
            "type": "result", "subtype": "error_during_execution", "is_error": true,
            "errors": ["fake failure"], "session_id": session,
        }));
    } else {
        send(&json!({
            "type": "result", "subtype": "success", "is_error": false,
            "result": answer, "session_id": session,
        }));
    }
    if has(&prompt, "late") {
        block(3, json!({ "type": "text", "text": "" }));
        delta(3, json!({ "type": "text_delta", "text": "too late" }));
    }
    for _ in lines {}
}

// Codex app-server: JSONL without a `jsonrpc` header.

struct CodexState {
    prompt: String,
    mcp_url: Option<String>,
    thread: String,
}

fn codex() {
    let mut lines = stdin_lines();
    let mut state = CodexState {
        prompt: String::new(),
        mcp_url: None,
        thread: "codex-thread-1".to_owned(),
    };
    while let Some(message) = lines.next() {
        let method = message["method"].as_str().unwrap_or_default().to_owned();
        let id = message.get("id").cloned().unwrap_or(Value::Null);
        assert!(
            message.get("jsonrpc").is_none(),
            "app-server frames have no header"
        );
        if method.starts_with("account/login") {
            eprintln!("drivers must never call {method}");
            std::process::exit(11);
        }
        match method.as_str() {
            "initialize" => send(&json!({ "id": id, "result": {
                "userAgent": "fake/0.166.0", "codexHome": "/tmp/codex",
                "platformFamily": "unix", "platformOs": "macos",
            }})),
            "initialized" => {}
            "skills/extraRoots/set" => {
                eprintln!("skills come from native discovery");
                std::process::exit(12);
            }
            "thread/resume" if std::env::var_os("ORBYN_FAKE_LOSE_SESSION").is_some() => {
                send(&json!({ "id": id, "error": {
                    "code": -32600, "message": "no rollout found for thread id",
                }}));
            }
            "thread/start" | "thread/resume" => {
                let params = &message["params"];
                record_launch("codex-thread", &[params.to_string()]);
                if let Some(thread) = params["threadId"].as_str() {
                    state.thread = thread.to_owned();
                }
                state.mcp_url = params["config"]["mcp_servers"]["orbyn_engineering"]["url"]
                    .as_str()
                    .map(str::to_owned);
                send(&json!({ "id": id, "result": {
                    "thread": { "id": state.thread }, "cwd": params["cwd"], "model": "fake",
                    "modelProvider": "fake", "approvalPolicy": params["approvalPolicy"],
                    "approvalsReviewer": "user", "sandbox": { "type": "workspaceWrite" },
                }}));
            }
            "turn/start" => {
                record_launch("codex-turn", &[message["params"].to_string()]);
                state.prompt = message["params"]["input"][0]["text"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned();
                // A notification ahead of its reply is a legal ordering.
                send(&json!({ "method": "turn/started", "params": {
                    "threadId": state.thread,
                    "turn": { "id": "turn-1", "items": [], "status": "inProgress" },
                }}));
                send(&json!({ "id": id, "result": {
                    "turn": { "id": "turn-1", "items": [], "status": "inProgress" },
                }}));
                codex_turn(&state, &mut lines);
            }
            "turn/interrupt" => {
                send(&json!({ "id": id, "result": {} }));
                codex_finish(&state, "interrupted");
            }
            "account/rateLimits/read" => {
                send(&json!({ "id": id, "result": { "rateLimits": {
                    "primary": { "usedPercent": 12, "windowDurationMins": 300, "resetsAt": 1800000000 },
                    "secondary": { "usedPercent": 40, "windowDurationMins": 10080 },
                }}}));
            }
            "account/read" => {
                send(&json!({ "id": id, "result": {
                    "account": { "type": "chatgpt", "email": "x@y.z", "planType": "plus" },
                    "requiresOpenaiAuth": true,
                }}));
            }
            "model/list" if sibling_exists("lost-models") => {
                send(&json!({ "id": id, "error": { "code": -32000, "message": "no list" } }));
            }
            "model/list" => {
                send(&json!({ "id": id, "result": { "nextCursor": null, "data": [
                    {
                        "id": "fake-big", "model": "fake-big", "displayName": "Fake Big",
                        "description": "Large", "hidden": false, "isDefault": true,
                        "defaultReasoningEffort": "medium",
                        "supportedReasoningEfforts": [
                            { "reasoningEffort": "medium", "description": "Balanced" },
                            { "reasoningEffort": "xhigh", "description": "Deep" },
                        ],
                        "serviceTiers": [
                            { "id": "priority", "name": "Fast", "description": "Quicker" },
                        ],
                        "inputModalities": ["text", "image"],
                    },
                    {
                        "id": "fake-small", "model": "fake-small", "displayName": "Fake Small",
                        "description": "", "hidden": false, "isDefault": false,
                        "defaultReasoningEffort": "low",
                        "supportedReasoningEfforts": [
                            { "reasoningEffort": "low", "description": "Quick" },
                        ],
                    },
                    {
                        "id": "fake-old", "model": "fake-old", "displayName": "Fake Old",
                        "description": "", "hidden": true, "isDefault": false,
                        "defaultReasoningEffort": "low", "supportedReasoningEfforts": [],
                    },
                ]}}));
            }
            "config/read" => {
                send(&json!({ "id": id, "result": { "config": {
                    "service_tier": std::env::var("ORBYN_FAKE_CODEX_TIER").ok(),
                }, "origins": {} }}));
            }
            "thread/compact/start" => {
                record_launch("codex-compact", &[]);
                send(&json!({ "id": id, "result": {} }));
                codex_finish(&state, "completed");
            }
            "thread/goal/set" => {
                let params = &message["params"];
                record_launch("codex-goal", &[params.to_string()]);
                let goal = json!({
                    "objective": params["objective"].as_str().unwrap_or("kept"),
                    "status": params["status"], "tokensUsed": 5, "timeUsedSeconds": 2,
                });
                send(&json!({ "id": id, "result": { "goal": goal } }));
                send(&json!({ "method": "thread/goal/updated", "params": {
                    "threadId": state.thread, "goal": goal,
                }}));
            }
            "thread/goal/clear" => {
                record_launch("codex-goal", &["clear".to_owned()]);
                send(&json!({ "id": id, "result": { "cleared": true } }));
                send(&json!({ "method": "thread/goal/cleared", "params": {
                    "threadId": state.thread,
                }}));
            }
            _ => {
                if id != Value::Null && !method.is_empty() {
                    send(&json!({ "id": id, "error": { "code": -32601, "message": "unknown" } }));
                }
            }
        }
    }
}

fn codex_note(state: &CodexState, method: &str, mut params: Value) {
    params["threadId"] = json!(state.thread);
    params["turnId"] = json!("turn-1");
    send(&json!({ "method": method, "params": params }));
}

fn codex_finish(state: &CodexState, status: &str) {
    let error = (status == "failed").then(|| json!({ "message": "fake failure" }));
    send(&json!({ "method": "turn/completed", "params": {
        "threadId": state.thread,
        "turn": { "id": "turn-1", "items": [], "status": status, "error": error },
    }}));
}

/// Sends a server request and waits for its answer, as app-server does.
fn codex_request(method: &str, params: Value, lines: &mut impl Iterator<Item = Value>) -> Value {
    send(&json!({ "id": 900, "method": method, "params": params }));
    for message in lines.by_ref() {
        if message.get("id") == Some(&json!(900)) && message.get("method").is_none() {
            return message;
        }
    }
    std::process::exit(0);
}

fn codex_turn(state: &CodexState, lines: &mut impl Iterator<Item = Value>) {
    let prompt = &state.prompt;
    // Sub-agent traffic shares the stream and must not end this turn.
    send(&json!({ "method": "turn/completed", "params": {
        "threadId": "subagent-thread",
        "turn": { "id": "turn-x", "items": [], "status": "completed" },
    }}));
    codex_note(
        state,
        "item/started",
        json!({
            "startedAtMs": 1, "item": { "type": "reasoning", "id": "rs1" },
        }),
    );
    codex_note(
        state,
        "item/reasoning/summaryTextDelta",
        json!({
            "itemId": "rs1", "summaryIndex": 0, "delta": "thinking",
        }),
    );
    codex_note(
        state,
        "item/completed",
        json!({
            "completedAtMs": 2, "item": { "type": "reasoning", "id": "rs1" },
        }),
    );
    codex_note(
        state,
        "turn/plan/updated",
        json!({
            "explanation": null, "plan": [{ "step": "do it", "status": "inProgress" }],
        }),
    );
    if has(prompt, "plan-item") {
        codex_note(
            state,
            "item/completed",
            json!({
                "completedAtMs": 2, "item": { "type": "plan", "id": "plan1", "text": "# Ship\n1. a" },
            }),
        );
    }
    let mut answer = "hello from codex".to_owned();
    if has(prompt, "unknown-request") {
        let reply = codex_request("item/tool/call", json!({ "itemId": "x" }), lines);
        answer = format!(
            "refused {}",
            reply.pointer("/error/code").unwrap_or(&Value::Null)
        );
    }
    if has(prompt, "token-refresh") {
        let reply = codex_request(
            "account/chatgptAuthTokens/refresh",
            json!({ "reason": "unauthorized" }),
            lines,
        );
        let code = reply.pointer("/error/code").unwrap_or(&Value::Null);
        let result = reply.get("result").unwrap_or(&Value::Null);
        answer = format!("token refresh error {code} result {result}");
    }
    if has(prompt, "outside-write") {
        let target = std::env::var("ORBYN_FAKE_WRITE_PATH").expect("write path");
        codex_note(
            state,
            "item/started",
            json!({
                "startedAtMs": 3,
                "item": {
                    "type": "fileChange", "id": "fc1", "status": "inProgress",
                    "changes": [{ "path": target, "kind": { "type": "update" }, "diff": "" }],
                },
            }),
        );
        let reply = codex_request(
            "item/fileChange/requestApproval",
            json!({
                "itemId": "fc1", "threadId": state.thread, "turnId": "turn-1", "startedAtMs": 3,
            }),
            lines,
        );
        let decision = reply
            .pointer("/result/decision")
            .and_then(Value::as_str)
            .unwrap_or("none");
        answer = format!("write {decision}");
    }
    // Writing is how a turn changes the workspace; `[write:<name>]` names the file.
    if let Some(rest) = prompt.split("[write:").nth(1)
        && let Some(name) = rest.split(']').next()
    {
        let checkout = std::env::var("ORBYN_FAKE_CHECKOUT").expect("checkout");
        let item = json!({
            "type": "fileChange", "id": format!("write-{name}"), "status": "inProgress",
            "changes": [{ "path": name, "kind": { "type": "add" }, "diff": "" }],
        });
        codex_note(state, "item/started", json!({ "item": item }));
        std::fs::write(
            std::path::Path::new(&checkout).join(name),
            "written by turn\n",
        )
        .expect("write");
        codex_note(state, "item/completed", json!({ "item": item }));
    }
    // `[mcp-call:<tool>]<json args>[/mcp-call]` calls one tool and answers with it.
    if let Some(rest) = prompt.split("[mcp-call:").nth(1)
        && let Some((name, rest)) = rest.split_once(']')
        && let Some((arguments, _)) = rest.split_once("[/mcp-call]")
    {
        let url = state.mcp_url.as_deref().expect("mcp url");
        let arguments: Value = serde_json::from_str(arguments).expect("tool arguments");
        let (_, reply) = mcp_call(
            url,
            1,
            "tools/call",
            json!({ "name": name, "arguments": arguments }),
        );
        answer = format!(
            "tool error={} {}",
            reply.pointer("/result/isError").is_some(),
            reply
                .pointer("/result/content/0/text")
                .and_then(Value::as_str)
                .unwrap_or("none"),
        );
    }
    if has(prompt, "mcp-tools") {
        let url = state.mcp_url.as_deref().expect("mcp url");
        let (status, reply) = mcp_call(url, 1, "tools/list", json!({}));
        let tools = reply
            .pointer("/result/tools")
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        answer = format!("mcp {status} tools {tools}");
    }
    if has(prompt, "question") {
        let reply = codex_request(
            "item/tool/requestUserInput",
            json!({
                "threadId": state.thread, "turnId": "turn-1", "itemId": "ask1",
                "questions": [{
                    "id": "q1", "header": "Token", "question": "Paste it", "isOther": true,
                    "isSecret": true, "options": null,
                }],
            }),
            lines,
        );
        answer = format!("answers {}", reply["result"]["answers"]);
    }
    if has(prompt, "approve") || has(prompt, "crash-in-approval") {
        codex_note(
            state,
            "item/started",
            json!({
                "startedAtMs": 3,
                "item": {
                    "type": "commandExecution", "id": "cmd1", "command": "ls", "cwd": "/repo",
                    "commandActions": [], "status": "inProgress",
                },
            }),
        );
        if has(prompt, "crash-in-approval") {
            send(
                &json!({ "id": 901, "method": "item/commandExecution/requestApproval", "params": {
                    "itemId": "cmd1", "threadId": state.thread, "turnId": "turn-1",
                    "startedAtMs": 3, "command": "ls",
                }}),
            );
            std::thread::sleep(std::time::Duration::from_millis(300));
            std::process::exit(7);
        }
        let reply = codex_request(
            "item/commandExecution/requestApproval",
            json!({
                "itemId": "cmd1", "threadId": state.thread, "turnId": "turn-1",
                "startedAtMs": 3, "command": "ls",
            }),
            lines,
        );
        let decision = reply
            .pointer("/result/decision")
            .and_then(Value::as_str)
            .unwrap_or("none");
        codex_note(
            state,
            "item/commandExecution/outputDelta",
            json!({
                "itemId": "cmd1", "delta": "listing",
            }),
        );
        codex_note(
            state,
            "item/completed",
            json!({
                "completedAtMs": 4,
                "item": {
                    "type": "commandExecution", "id": "cmd1", "command": "ls", "cwd": "/repo",
                    "commandActions": [], "status": "completed", "aggregatedOutput": "listing",
                "exitCode": 0,
                },
            }),
        );
        codex_note(
            state,
            "turn/diff/updated",
            json!({
                "diff": "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n",
            }),
        );
        answer = format!("decision {decision}");
    }
    if has(prompt, "hang") {
        for message in lines.by_ref() {
            if message["method"] == "turn/interrupt" {
                send(&json!({ "id": message["id"], "result": {} }));
                codex_finish(state, "interrupted");
                return;
            }
            if message["method"] == "turn/steer" {
                send(&json!({ "id": message["id"], "result": { "turnId": "turn-1" } }));
                answer = format!(
                    "steered: {}",
                    message["params"]["input"][0]["text"]
                        .as_str()
                        .unwrap_or_default()
                );
                break;
            }
        }
        if !answer.starts_with("steered") {
            return;
        }
    }
    codex_note(
        state,
        "item/started",
        json!({
            "startedAtMs": 5, "item": { "type": "agentMessage", "id": "msg1", "text": "" },
        }),
    );
    codex_note(
        state,
        "item/agentMessage/delta",
        json!({ "itemId": "msg1", "delta": answer }),
    );
    codex_note(
        state,
        "item/completed",
        json!({
            "completedAtMs": 6, "item": { "type": "agentMessage", "id": "msg1", "text": answer },
        }),
    );
    codex_note(
        state,
        "thread/tokenUsage/updated",
        json!({
            "tokenUsage": {
                "total": { "totalTokens": 120 }, "last": { "totalTokens": 20 },
                "modelContextWindow": 1000,
            },
        }),
    );
    if has(prompt, "fail") {
        codex_note(
            state,
            "error",
            json!({
                "error": { "message": "fake failure" }, "willRetry": false,
            }),
        );
        codex_finish(state, "failed");
    } else {
        codex_finish(state, "completed");
    }
    if has(prompt, "late") {
        codex_note(
            state,
            "item/agentMessage/delta",
            json!({ "itemId": "msg1", "delta": "too late" }),
        );
    }
}

// ACP v1: JSON-RPC 2.0 with the header.

fn acp_send(value: Value) {
    let mut value = value;
    value["jsonrpc"] = json!("2.0");
    send(&value);
}

fn acp_update(session: &str, update: Value) {
    acp_send(
        json!({ "method": "session/update", "params": { "sessionId": session, "update": update } }),
    );
}

/// Lets a test change the engine's answers while it runs.
fn sibling_exists(name: &str) -> bool {
    std::env::var("ORBYN_FAKE_LAUNCH_FILE")
        .is_ok_and(|path| std::path::Path::new(&path).with_file_name(name).exists())
}

/// A test takes a mode away between reading the list and running.
fn acp_lost_mode() -> bool {
    sibling_exists("lost-mode")
}

fn acp() {
    let mut lines = stdin_lines();
    let session = "acp-session-1";
    while let Some(message) = lines.next() {
        assert_eq!(message["jsonrpc"], "2.0", "ACP frames carry the header");
        let id = message.get("id").cloned().unwrap_or(Value::Null);
        match message["method"].as_str().unwrap_or_default() {
            "initialize" => acp_send(json!({ "id": id, "result": {
                "protocolVersion": 1,
                "agentCapabilities": {
                    "mcpCapabilities": { "http": true },
                    "sessionCapabilities": if std::env::var_os("ORBYN_FAKE_ACP_SESSIONS").is_some() {
                        json!({ "delete": {} })
                    } else {
                        json!({})
                    },
                },
                "authMethods": [],
            }})),
            "session/delete" => {
                record_launch("acp-delete", &[message["params"].to_string()]);
                acp_send(json!({ "id": id, "result": {} }));
            }
            "session/new" => acp_send(json!({ "id": id, "result": {
                "sessionId": session,
                "models": {
                    "currentModelId": "acp-small",
                    "availableModels": [
                        { "modelId": "acp-small", "name": "ACP Small" },
                        { "modelId": "acp-large", "name": "ACP Large", "description": "Big" },
                    ],
                },
                "modes": {
                    "currentModeId": "ask",
                    "availableModes": if acp_lost_mode() {
                        json!([{ "id": "ask", "name": "Ask" }])
                    } else {
                        json!([{ "id": "ask", "name": "Ask" }, { "id": "code", "name": "Code" }])
                    },
                },
                "configOptions": [{
                    "id": "think", "name": "Thinking", "category": "thought_level",
                    "type": "select", "currentValue": "off",
                    "options": [{ "value": "off", "name": "Off" }, { "value": "on", "name": "On" }],
                }],
            }})),
            "session/set_model" => {
                record_launch("acp-model", &[message["params"].to_string()]);
                // A large model shows what it offers only once it is chosen.
                let large = message["params"]["modelId"] == "acp-large";
                if large && std::env::var_os("ORBYN_FAKE_ACP_SESSIONS").is_some() {
                    acp_send(json!({ "id": id, "result": { "configOptions": [{
                        "id": "effort", "name": "Effort", "category": "thought_level",
                        "type": "select", "currentValue": "low",
                        "options": [{ "value": "low", "name": "Low" }, { "value": "max", "name": "Max" }],
                    }]}}));
                } else if std::env::var_os("ORBYN_FAKE_ACP_REFUSE_MODEL").is_some() {
                    acp_send(json!({ "id": id, "error": { "code": -32000, "message": "no" } }));
                } else {
                    acp_send(json!({ "id": id, "result": {} }));
                }
            }
            "session/set_mode" | "session/set_config_option" => {
                record_launch("acp-config", &[message.to_string()]);
                acp_send(json!({ "id": id, "result": {} }));
            }
            "session/prompt" => {
                let prompt = message["params"]["prompt"][0]["text"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned();
                acp_update(
                    session,
                    json!({
                        "sessionUpdate": "agent_thought_chunk",
                        "content": { "type": "text", "text": "thinking" },
                    }),
                );
                let mut answer = "hello from acp".to_owned();
                if has(&prompt, "approve") {
                    acp_update(
                        session,
                        json!({
                            "sessionUpdate": "tool_call", "toolCallId": "c1", "title": "List files",
                            "kind": "execute", "status": "pending",
                            "rawInput": { "command": "ls" },
                        }),
                    );
                    acp_send(
                        json!({ "id": 700, "method": "session/request_permission", "params": {
                            "sessionId": session,
                            "toolCall": {
                                "toolCallId": "c1", "title": "List files", "kind": "execute",
                                "rawInput": { "command": "ls" },
                            },
                            "options": [
                                { "optionId": "once", "name": "Allow", "kind": "allow_once" },
                                { "optionId": "no", "name": "Reject", "kind": "reject_once" },
                            ],
                        }}),
                    );
                    let reply = lines
                        .by_ref()
                        .find(|line| line.get("id") == Some(&json!(700)));
                    let outcome = reply
                        .as_ref()
                        .and_then(|reply| reply.pointer("/result/outcome/optionId"))
                        .and_then(Value::as_str)
                        .unwrap_or("cancelled")
                        .to_owned();
                    acp_update(
                        session,
                        json!({
                            "sessionUpdate": "tool_call_update", "toolCallId": "c1",
                            "status": "completed", "rawOutput": "listing",
                        }),
                    );
                    answer = format!("option {outcome}");
                }
                if has(&prompt, "hang") {
                    if lines
                        .by_ref()
                        .any(|line| line["method"] == "session/cancel")
                    {
                        acp_send(json!({ "id": id, "result": { "stopReason": "cancelled" } }));
                    }
                    continue;
                }
                acp_update(
                    session,
                    json!({
                        "sessionUpdate": "agent_message_chunk",
                        "content": { "type": "text", "text": answer },
                    }),
                );
                acp_send(json!({ "id": id, "result": { "stopReason": "end_turn" } }));
            }
            _ => {}
        }
    }
}

// AG-UI over HTTP and SSE.

fn agui(args: &[String]) {
    let port_file = args.get(1).expect("port file");
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    std::fs::write(port_file, port.to_string()).expect("port file");
    for stream in listener.incoming().map_while(Result::ok) {
        std::thread::spawn(move || agui_connection(stream));
    }
}

fn agui_connection(mut stream: TcpStream) {
    let mut reader = BufReader::new(stream.try_clone().expect("clone"));
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() {
        return;
    }
    let mut length = 0usize;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() || line == "\r\n" || line.is_empty() {
            break;
        }
        if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            length = value.trim().parse().unwrap_or(0);
        }
    }
    if !request_line.starts_with("POST") {
        let _ = write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        return;
    }
    let mut body = vec![0u8; length];
    if reader.read_exact(&mut body).is_err() {
        return;
    }
    let input: Value = serde_json::from_slice(&body).expect("RunAgentInput");
    for field in ["threadId", "runId", "messages"] {
        assert!(input.get(field).is_some(), "RunAgentInput needs {field}");
    }
    let _ = write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n"
    );
    let thread = input["threadId"].clone();
    let run = input["runId"].clone();
    let mut frame = |value: Value| {
        let _ = write!(stream, "data: {value}\n\n");
        let _ = stream.flush();
    };
    frame(json!({ "type": "RUN_STARTED", "threadId": thread, "runId": run }));
    if let Some(resume) = input["resume"].as_array() {
        let approved = resume[0]["payload"]["approved"].as_bool().unwrap_or(false);
        frame(json!({ "type": "TEXT_MESSAGE_START", "messageId": "m2" }));
        frame(json!({
            "type": "TEXT_MESSAGE_CONTENT", "messageId": "m2",
            "delta": format!("resumed approved={approved}"),
        }));
        frame(json!({ "type": "TEXT_MESSAGE_END", "messageId": "m2" }));
        frame(json!({
            "type": "RUN_FINISHED", "threadId": thread, "runId": run,
            "outcome": { "type": "success" },
        }));
        return;
    }
    let prompt = input["messages"][0]["content"].as_str().unwrap_or_default();
    if has(prompt, "approve") {
        frame(json!({ "type": "TOOL_CALL_START", "toolCallId": "t1", "toolCallName": "deploy" }));
        frame(json!({ "type": "TOOL_CALL_END", "toolCallId": "t1" }));
        frame(json!({
            "type": "RUN_FINISHED", "threadId": thread, "runId": run,
            "outcome": { "type": "interrupt", "interrupts": [{
                "id": "int-1", "reason": "tool_approval", "message": "Deploy now?",
                "toolCallId": "t1",
            }]},
        }));
        return;
    }
    if has(prompt, "fail") {
        frame(json!({ "type": "RUN_ERROR", "message": "fake failure", "code": "fake" }));
        return;
    }
    frame(json!({ "type": "TEXT_MESSAGE_START", "messageId": "m1" }));
    frame(json!({ "type": "TEXT_MESSAGE_CONTENT", "messageId": "m1", "delta": "hello from agui" }));
    frame(json!({ "type": "TEXT_MESSAGE_END", "messageId": "m1" }));
    frame(json!({ "type": "STATE_SNAPSHOT", "snapshot": { "n": 1 } }));
    frame(json!({
        "type": "RUN_FINISHED", "threadId": thread, "runId": run,
        "outcome": { "type": "success" },
    }));
}

/// A line-echoing terminal program. `exit` ends it.
fn pty() {
    println!("fake terminal ready");
    for line in std::io::stdin().lock().lines().map_while(Result::ok) {
        if line.contains("exit") {
            return;
        }
        println!("echo: {line}");
    }
}
