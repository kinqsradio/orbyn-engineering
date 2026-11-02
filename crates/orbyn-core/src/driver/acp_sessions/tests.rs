//! Ordinary JSONL peer, not an installed provider or a model invocation.
use super::*;
use crate::driver::acp::AcpDriver;
use crate::driver::{EngineDriver, EngineOutcome, RunKind, RunSpec};
use orbyn_contracts::{AgUiEvent, EngineTier, PermissionMode};
use std::collections::BTreeMap;

const PEER: &str = include_str!("peer.cjs");

struct Fixture {
    dir: ProbeDir,
    driver: AcpDriver,
    record: std::path::PathBuf,
    cwd: std::path::PathBuf,
}
impl Fixture {
    fn new(scenario: &str) -> Self {
        let dir = ProbeDir::new().unwrap();
        let script = dir.path().join("peer.cjs");
        std::fs::write(&script, PEER).unwrap();
        let record = dir.path().join("calls.jsonl");
        let cwd = dir.path().join("project");
        std::fs::create_dir(&cwd).unwrap();
        let node = crate::process::resolve("node")
            .expect("Node is required by the repository's protocol fixture");
        let driver = AcpDriver::new(CustomEngine {
            id: "test-acp".into(),
            name: "Test ACP".into(),
            tier: EngineTier::Acp,
            target: node.path.to_string_lossy().into_owned(),
            args: vec![
                script.to_string_lossy().into_owned(),
                scenario.into(),
                record.to_string_lossy().into_owned(),
                cwd.to_string_lossy().into_owned(),
            ],
        });
        Self {
            dir,
            driver,
            record,
            cwd,
        }
    }
    fn calls(&self) -> Vec<Value> {
        std::fs::read_to_string(&self.record)
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
    fn methods(&self) -> Vec<String> {
        self.calls()
            .iter()
            .filter_map(|v| v.get("method").and_then(Value::as_str).map(str::to_owned))
            .collect()
    }
    async fn run(&self, resume: Option<&str>) -> Vec<EngineEvent> {
        let (tx, mut rx) = tokio::sync::mpsc::channel(32);
        let spec = RunSpec {
            run_id: "run".into(),
            thread_id: "thread".into(),
            cwd: self.cwd.clone(),
            checkout: self.cwd.clone(),
            prompt: "new prompt".into(),
            user_prompt: "new prompt".into(),
            kind: RunKind::Turn,
            mode: PermissionMode::Supervised,
            plan: false,
            model: None,
            effort: None,
            options: BTreeMap::new(),
            resume: resume.map(str::to_owned),
            mcp_url: None,
            run_dir: self.dir.path().join("run"),
        };
        let handle = self.driver.start_run(spec, tx).await.unwrap();
        let mut events = Vec::new();
        loop {
            let event = tokio::time::timeout(Duration::from_secs(10), rx.recv())
                .await
                .unwrap()
                .unwrap();
            let finished = matches!(event, EngineEvent::Finished(_));
            events.push(event);
            if finished {
                break;
            }
        }
        handle.task.await.unwrap();
        events
    }
}

#[tokio::test]
async fn capabilities_and_listing_never_create_prompt_or_authenticate() {
    let f = Fixture::new("load");
    let caps = f
        .driver
        .native_session_capabilities()
        .await
        .unwrap()
        .unwrap();
    assert!(caps.can_list && caps.can_load && caps.can_delete);
    assert!(!caps.can_resume);
    let page = f
        .driver
        .list_native_sessions(&f.cwd, Some("opaque/next"))
        .await
        .unwrap();
    assert_eq!(page.sessions.len(), 1);
    assert_eq!(page.sessions[0].session_id, "native");
    assert_eq!(page.next_cursor.as_deref(), Some("next"));
    assert_eq!(page.sessions[0].imported_thread_id, None);
    assert_eq!(f.methods(), ["initialize", "initialize", "session/list"]);
    let calls = f.calls();
    let list = calls
        .iter()
        .find(|v| v["method"] == "session/list")
        .unwrap();
    assert_eq!(list["params"]["cwd"], json!(f.cwd));
    assert_eq!(list["params"]["cursor"], "opaque/next");
    for init in calls.iter().filter(|v| v["method"] == "initialize") {
        assert_eq!(init["params"]["clientCapabilities"]["terminal"], false);
        assert_eq!(
            init["params"]["clientCapabilities"]["fs"]["readTextFile"],
            false
        );
    }
}

#[tokio::test]
async fn load_captures_closed_history_and_denies_client_effects() {
    let f = Fixture::new("requests");
    let replay = f
        .driver
        .load_native_session(&f.cwd, "native")
        .await
        .unwrap();
    let starts: Vec<_> = replay
        .events
        .iter()
        .filter_map(|v| match v {
            AgUiEvent::TextMessageStart { message_id, role } => {
                Some((message_id.clone(), role.clone()))
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        starts,
        vec![
            ("acp-history-1".into(), "user".into()),
            ("acp-history-2".into(), "assistant".into())
        ]
    );
    assert_eq!(
        replay
            .events
            .iter()
            .filter(|v| matches!(v, AgUiEvent::TextMessageEnd { .. }))
            .count(),
        2
    );
    let calls = f.calls();
    let acknowledgements: Vec<_> = calls.iter().filter(|v| v.get("reply").is_some()).collect();
    assert_eq!(acknowledgements.len(), 3);
    assert_eq!(
        acknowledgements[0]["reply"]["result"]["outcome"]["outcome"],
        "cancelled"
    );
    assert_eq!(acknowledgements[1]["reply"]["error"]["code"], -32601);
    assert_eq!(acknowledgements[2]["reply"]["error"]["code"], -32601);
    let load = calls
        .iter()
        .find(|v| v["method"] == "session/load")
        .unwrap();
    assert_eq!(load["params"]["cwd"], json!(f.cwd));
    assert_eq!(load["params"]["additionalDirectories"], json!([]));
    assert_eq!(load["params"]["mcpServers"], json!([]));
    assert!(!f.methods().iter().any(|m| matches!(
        m.as_str(),
        "session/new" | "session/prompt" | "session/delete" | "authenticate"
    )));
}

#[tokio::test]
async fn resume_only_activation_returns_empty_history() {
    let f = Fixture::new("resume");
    assert!(
        f.driver
            .load_native_session(&f.cwd, "native")
            .await
            .unwrap()
            .events
            .is_empty()
    );
    assert_eq!(f.methods(), ["initialize", "session/resume"]);
}

#[tokio::test]
async fn delete_uses_only_advertised_protocol_method() {
    let f = Fixture::new("load");
    f.driver
        .delete_native_session(&f.cwd, "native")
        .await
        .unwrap();
    assert_eq!(f.methods(), ["initialize", "session/delete"]);
    let f = Fixture::new("unsupported");
    assert!(matches!(
        f.driver.delete_native_session(&f.cwd, "native").await,
        Err(CoreError::Unsupported(_))
    ));
    assert_eq!(f.methods(), ["initialize"]);
}

#[tokio::test]
async fn live_load_suppresses_replay_before_prompt_and_persists_session() {
    let f = Fixture::new("load");
    let events = f.run(Some("native")).await;
    assert!(
        events
            .iter()
            .any(|e| matches!(e,EngineEvent::Session(id)if id=="native"))
    );
    let text: String = events
        .iter()
        .filter_map(|e| match e {
            EngineEvent::Agui(AgUiEvent::TextMessageContent { delta, .. }) => Some(delta.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(text, "new output");
    assert!(matches!(
        events.last(),
        Some(EngineEvent::Finished(EngineOutcome::Completed))
    ));
    assert_eq!(
        f.methods(),
        ["initialize", "session/load", "session/prompt"]
    );
}

#[tokio::test]
async fn live_prefers_resume_and_new_sessions_only_persist_when_continuable() {
    let f = Fixture::new("both");
    assert!(matches!(
        f.run(Some("native")).await.last(),
        Some(EngineEvent::Finished(EngineOutcome::Completed))
    ));
    assert_eq!(
        f.methods(),
        ["initialize", "session/resume", "session/prompt"]
    );
    let f = Fixture::new("unsupported");
    let events = f.run(None).await;
    assert!(!events.iter().any(|e| matches!(e, EngineEvent::Session(_))));
    assert_eq!(f.methods(), ["initialize", "session/new", "session/prompt"]);
    let f = Fixture::new("load");
    let events = f.run(None).await;
    assert!(
        events
            .iter()
            .any(|e| matches!(e,EngineEvent::Session(id)if id=="new-native"))
    );
}

#[tokio::test]
async fn only_structured_restore_unknown_session_is_session_lost() {
    let f = Fixture::new("unknown");
    assert!(matches!(
        f.run(Some("native")).await.last(),
        Some(EngineEvent::Finished(EngineOutcome::SessionLost))
    ));
    assert_eq!(f.methods(), ["initialize", "session/load"]);
    for scenario in ["auth", "init-error"] {
        let f = Fixture::new(scenario);
        assert!(matches!(
            f.run(Some("native")).await.last(),
            Some(EngineEvent::Finished(EngineOutcome::Failed(_)))
        ));
        assert!(!f.methods().contains(&"session/new".into()));
    }
}

#[tokio::test]
async fn replay_wrong_session_and_output_budgets_fail_closed() {
    for scenario in ["wrong", "oversize", "flood"] {
        let f = Fixture::new(scenario);
        assert!(
            f.driver
                .load_native_session(&f.cwd, "native")
                .await
                .is_err(),
            "{scenario}"
        );
        assert!(!f.methods().contains(&"session/prompt".into()));
    }
}

#[test]
fn capability_shapes_and_page_bounds_are_independent() {
    let caps = capabilities(
        &json!({"agentCapabilities":{"loadSession":true,"sessionCapabilities":{"list":{},"resume":false,"delete":null}}}),
    );
    assert!(caps.can_list && caps.can_load && !caps.can_resume && !caps.can_delete);
    let cwd = std::env::temp_dir().to_string_lossy().into_owned();
    let row = json!({"sessionId":"native","cwd":cwd});
    assert!(parse_page(&json!({"sessions":[row.clone()]}), caps.clone()).is_ok());
    assert!(parse_page(&json!({"sessions":vec![row;257]}), caps.clone()).is_err());
    assert!(parse_page(&json!({"sessions":[],"nextCursor":"x".repeat(2049)}), caps).is_err());
}

async fn child_gone(pid: u32) {
    let pid = sysinfo::Pid::from_u32(pid);
    let mut system = sysinfo::System::new();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            system.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
            if system.process(pid).is_none() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the operation's owned child must exit");
}

#[tokio::test]
async fn cancellation_drops_owned_process_and_io_without_prompt() {
    let f = std::sync::Arc::new(Fixture::new("hang"));
    let task_fixture = f.clone();
    let task = tokio::spawn(async move {
        task_fixture
            .driver
            .load_native_session(&task_fixture.cwd, "native")
            .await
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        while !f.methods().contains(&"session/load".into()) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let pid = f.calls().iter().find_map(|v| v["pid"].as_u64()).unwrap() as u32;
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    child_gone(pid).await;
    assert_eq!(f.methods(), ["initialize", "session/load"]);
}

#[tokio::test]
async fn normal_management_completion_reaps_the_child() {
    let f = Fixture::new("load");
    f.driver.list_native_sessions(&f.cwd, None).await.unwrap();
    let pid = f.calls().iter().find_map(|v| v["pid"].as_u64()).unwrap() as u32;
    child_gone(pid).await;
}

#[tokio::test]
async fn live_replay_budget_failure_never_sends_the_new_prompt() {
    for scenario in ["large-frame", "large-reply", "flood", "wrong"] {
        let f = Fixture::new(scenario);
        let events = f.run(Some("native")).await;
        assert!(
            matches!(
                events.last(),
                Some(EngineEvent::Finished(EngineOutcome::Failed(_)))
            ),
            "{scenario}"
        );
        assert!(!f.methods().contains(&"session/prompt".into()));
        assert!(
            !events
                .iter()
                .any(|event| matches!(event, EngineEvent::Agui(_)))
        );
    }
}

#[tokio::test]
async fn live_restoration_denies_effect_requests_before_the_prompt() {
    let f = Fixture::new("requests");
    let events = f.run(Some("native")).await;
    assert!(matches!(
        events.last(),
        Some(EngineEvent::Finished(EngineOutcome::Completed))
    ));
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, EngineEvent::Permission(_)))
    );
    let calls = f.calls();
    let denied = calls.iter().filter(|v| v.get("reply").is_some()).count();
    assert_eq!(denied, 3);
    let prompt = calls
        .iter()
        .position(|v| v["method"] == "session/prompt")
        .unwrap();
    assert!(
        calls[..prompt]
            .iter()
            .filter(|v| v.get("reply").is_some())
            .count()
            == 3
    );
}

#[tokio::test]
async fn live_session_ids_are_bounded_before_prompt_or_persistence() {
    let f = Fixture::new("oversize-id");
    let events = f.run(None).await;
    assert!(matches!(
        events.last(),
        Some(EngineEvent::Finished(EngineOutcome::Failed(_)))
    ));
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, EngineEvent::Session(_)))
    );
    assert_eq!(f.methods(), ["initialize", "session/new"]);
    let f = Fixture::new("load");
    let events = f.run(Some(&"x".repeat(1025))).await;
    assert!(matches!(
        events.last(),
        Some(EngineEvent::Finished(EngineOutcome::Failed(_)))
    ));
    assert!(f.methods().is_empty());
}
