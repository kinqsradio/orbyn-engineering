//! A deterministic protocol double. It speaks each engine's wire format over
//! real pipes or sockets so tests exercise real parsing. Frames are written by
//! hand from the Codex 0.166.0 generated schema, Claude Code's stream-json
//! output, ACP v1 and the AG-UI 1.0 schema; none are recorded from live engines.
//!
//! Prompts carry scenario tags:
//! `[approve]`, `[crash-in-approval]`, `[hang]`, `[late]`, `[fail]`,
//! `[unknown-request]`, `[mcp-tools]`.

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
        "app-server" => codex(),
        "-p" if !args.iter().any(|arg| arg == "--input-format") => one_shot(),
        "exec" => one_shot(),
        "-p" => claude(&args),
        "acp" => acp(),
        "agui" => agui(&args),
        "pty" => pty(),
        other => {
            eprintln!("unknown mode {other}");
            std::process::exit(2);
        }
    }
}

/// Lets a test watch this process's lifetime.
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
        std::fs::write(path, &prompt).expect("record");
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
    let Some(first) = lines.next() else { return };
    let prompt = first
        .pointer("/message/content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let session = flag("--resume").unwrap_or_else(|| "claude-session-1".to_owned());
    send(&json!({ "type": "system", "subtype": "init", "session_id": session, "model": "fake" }));
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

    let mut answer = "hello from claude".to_owned();
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
        send(&json!({
            "type": "user",
            "message": { "role": "user", "content": [{
                "type": "tool_result", "tool_use_id": "toolu_1",
                "content": [{ "type": "text", "text": format!("tool {behavior}") }],
            }]},
        }));
        answer = format!("permission {behavior}");
    }
    if has(&prompt, "hang") {
        // Stays alive until stdin closes, like the real CLI between turns.
        for _ in lines {}
        return;
    }
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
            "skills/extraRoots/set" => send(&json!({ "id": id, "result": {} })),
            "thread/start" | "thread/resume" => {
                let params = &message["params"];
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
    let mut answer = "hello from codex".to_owned();
    if has(prompt, "unknown-request") {
        let reply = codex_request(
            "item/tool/requestUserInput",
            json!({ "itemId": "x" }),
            lines,
        );
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
    if has(prompt, "mcp-tools") {
        let url = state.mcp_url.as_deref().expect("mcp url");
        let (status, reply) = mcp_call(url, 1, "tools/list", json!({}));
        let tools = reply
            .pointer("/result/tools")
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        answer = format!("mcp {status} tools {tools}");
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
        }
        return;
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

fn acp() {
    let mut lines = stdin_lines();
    let session = "acp-session-1";
    while let Some(message) = lines.next() {
        assert_eq!(message["jsonrpc"], "2.0", "ACP frames carry the header");
        let id = message.get("id").cloned().unwrap_or(Value::Null);
        match message["method"].as_str().unwrap_or_default() {
            "initialize" => acp_send(json!({ "id": id, "result": {
                "protocolVersion": 1,
                "agentCapabilities": { "mcpCapabilities": { "http": true } },
                "authMethods": [],
            }})),
            "session/new" => acp_send(json!({ "id": id, "result": { "sessionId": session } })),
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
