//! The hidden helpers' CLI contract: what they need, what they refuse and what the
//! Claude history reader prints from a real `orbyn` process.

mod support;

use std::path::Path;
use std::process::{Command, Output};

use serde_json::{Value, json};
use support::TempDir;

const ORBYN: &str = env!("CARGO_BIN_EXE_orbyn");

fn orbyn(env: &[(&str, &Path)], args: &[&str]) -> Output {
    let mut command = Command::new(ORBYN);
    command
        .args(args)
        .env_remove("ORBYN_ACP_MCP_ENDPOINT")
        .env_remove("CLAUDE_CONFIG_DIR");
    for (name, value) in env {
        command.env(name, value);
    }
    command.output().unwrap()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

#[test]
fn the_helpers_stay_out_of_help() {
    let help = orbyn(&[], &["--help"]);
    let text = String::from_utf8_lossy(&help.stdout);
    for hidden in ["acp-mcp-bridge", "acp-mcp-call", "__claude-history"] {
        assert!(!text.contains(hidden), "{hidden} in {text}");
    }
}

#[test]
fn the_acp_helpers_need_the_endpoint_and_object_arguments() {
    for args in [
        &["acp-mcp-bridge"][..],
        &["acp-mcp-call", "skill_search", "{}"][..],
    ] {
        let output = orbyn(&[], args);
        assert_eq!(output.status.code(), Some(2), "{args:?}");
        assert!(stderr(&output).contains("ORBYN_ACP_MCP_ENDPOINT"));
    }
    let endpoint = Path::new("http://127.0.0.1:9/mcp/none");
    let env = [("ORBYN_ACP_MCP_ENDPOINT", endpoint)];
    let output = orbyn(&env, &["acp-mcp-call", "skill_search", "not json"]);
    assert_eq!(output.status.code(), Some(2));
    assert!(stderr(&output).contains("valid JSON"));
    let output = orbyn(&env, &["acp-mcp-call", "skill_search", "[1]"]);
    assert_eq!(output.status.code(), Some(2));
    assert!(stderr(&output).contains("JSON object"));
    let output = orbyn(&env, &["acp-mcp-call", "skill_search", "{}"]);
    assert_eq!(output.status.code(), Some(1));
    assert!(stderr(&output).contains("could not be reached"));
}

#[test]
fn claude_history_reads_one_session_and_refuses_to_fork() {
    let dir = TempDir::new();
    let config = dir.path().join("claude");
    let work = if cfg!(windows) {
        r"C:\work\app"
    } else {
        "/work/app"
    };
    let folder =
        config
            .join("projects")
            .join(orbyn_core::agents::claude_history::project_folder_name(
                work,
            ));
    std::fs::create_dir_all(&folder).unwrap();
    let id = "5b6c7d8e-0000-4000-8000-000000000001";
    let lines = [
        json!({"type":"user","uuid":"u1","sessionId":id,"message":{"role":"user","content":"hi"}}),
        json!({"type":"assistant","uuid":"a1","sessionId":id,"message":{"role":"assistant","content":"hello"}}),
        json!({"type":"user","uuid":"u2","sessionId":id,"message":{"role":"user","content":"later"}}),
    ];
    let text: String = lines.iter().map(|line| format!("{line}\n")).collect();
    std::fs::write(folder.join(format!("{id}.jsonl")), text).unwrap();
    let env = [("CLAUDE_CONFIG_DIR", config.as_path())];

    let output = orbyn(&env, &["__claude-history", "getSessionMessages", id]);
    assert!(output.status.success(), "{}", stderr(&output));
    let messages: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(messages.as_array().unwrap().len(), 3);
    assert_eq!(messages[1]["message"]["content"], "hello");

    let options = json!({ "dir": work, "upToMessageId": "a1" }).to_string();
    let output = orbyn(
        &env,
        &["__claude-history", "getSessionMessages", id, &options],
    );
    assert!(output.status.success(), "{}", stderr(&output));
    let messages: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(messages.as_array().unwrap().len(), 2);

    let output = orbyn(&env, &["__claude-history", "forkSession", id]);
    assert_eq!(output.status.code(), Some(2));
    assert!(stderr(&output).contains("--fork-session"));
    let output = orbyn(&env, &["__claude-history", "getSessionMessages", "../x"]);
    assert_eq!(output.status.code(), Some(1));
    let output = orbyn(
        &env,
        &[
            "__claude-history",
            "getSessionMessages",
            id,
            "{\"unknown\":1}",
        ],
    );
    assert_eq!(output.status.code(), Some(2));
    let missing = "5b6c7d8e-0000-4000-8000-000000000002";
    let output = orbyn(&env, &["__claude-history", "getSessionMessages", missing]);
    assert_eq!(output.status.code(), Some(1));
    assert!(stderr(&output).contains("not found"));
}
