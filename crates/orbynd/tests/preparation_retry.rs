//! Real Core, HTTP transport and disposable setup processes. Engine protocol
//! doubles assert admission ordering; these tests do not qualify live engines.
mod support;

use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use support::{Options, Service, TempDir, run_git};

fn options(dir: &TempDir) -> Options {
    Options {
        env: vec![
            ("HOME".into(), dir.path().to_string_lossy().into_owned()),
            (
                "CODEX_HOME".into(),
                dir.path().join("codex").to_string_lossy().into_owned(),
            ),
            (
                "CLAUDE_CONFIG_DIR".into(),
                dir.path().join("claude").to_string_lossy().into_owned(),
            ),
            (
                "ORBYN_FAKE_LAUNCH_FILE".into(),
                dir.path()
                    .join("launch.ndjson")
                    .to_string_lossy()
                    .into_owned(),
            ),
        ],
        ..Options::default()
    }
}
async fn fixture_with_async(
    dir: &TempDir,
    asynchronous: bool,
) -> (Service, String, String, PathBuf) {
    let service = Service::start(&dir.path().join("data"), options(dir));
    let repo = dir.path().join("project");
    std::fs::create_dir_all(&repo).unwrap();
    std::fs::write(repo.join("setup.cjs"), r#"
const fs = require('node:fs');
const n = Number(fs.existsSync('attempt') ? fs.readFileSync('attempt','utf8') : '0') + 1;
fs.writeFileSync('attempt', String(n));
const timer = setInterval(() => {
  const release = 'release-' + n;
  if (fs.existsSync(release)) { clearInterval(timer); fs.writeFileSync('finished-' + n, 'done'); process.exit(Number(fs.readFileSync(release,'utf8'))); }
}, 20);
setTimeout(() => process.exit(71), 30000).unref();
"#).unwrap();
    std::fs::write(repo.join("orbyn.json"), json!({"scripts":[{"name":"Setup", "command":"node setup.cjs", "runOnWorktreeCreate":true,"async":asynchronous}]}).to_string()).unwrap();
    run_git(&repo, &["init", "-q", "-b", "main"]);
    run_git(&repo, &["add", "."]);
    run_git(
        &repo,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "commit",
            "-qm",
            "Setup fixture",
        ],
    );
    let project = service.project(&repo, true).await;
    let response = service
        .client
        .put(format!("{}/api/preferences", service.url))
        .bearer_auth(&service.token)
        .json(&json!({"values":{"auto_thread_titles":false}}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let (status, thread) = service.send("/api/threads", json!({"project_id":project,"engine":"codex","worktree":"preparation-retry","title":"Preparation"})).await;
    assert_eq!(status, 201, "{thread}");
    let cwd = PathBuf::from(thread["cwd"].as_str().unwrap());
    attempt(&cwd, 1).await;
    (service, project, thread["id"].as_str().unwrap().into(), cwd)
}
async fn fixture(dir: &TempDir) -> (Service, String, String, PathBuf) {
    fixture_with_async(dir, false).await
}
async fn attempt(cwd: &Path, n: u32) {
    for _ in 0..1000 {
        if std::fs::read_to_string(cwd.join("attempt")).ok().as_deref() == Some(&n.to_string()) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("setup attempt {n} did not start");
}
fn release(cwd: &Path, n: u32, code: i32) {
    std::fs::write(cwd.join(format!("release-{n}")), code.to_string()).unwrap();
}
fn turns(dir: &TempDir) -> usize {
    std::fs::read_to_string(dir.path().join("launch.ndjson"))
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|row| row["mode"] == "codex-turn")
        .count()
}
async fn failed(service: &Service, thread: &str, cwd: &Path) -> String {
    let run = service.admit(thread, "captured-original-input").await;
    release(cwd, 1, 7);
    assert_eq!(service.finished(thread).await, "failed");
    run
}
async fn retry(service: &Service, thread: &str, run: &str) -> (u16, Value) {
    service
        .send(
            &format!("/api/threads/{thread}/preparation/retry"),
            json!({"run_id":run}),
        )
        .await
}
async fn queue(service: &Service, thread: &str, prompt: &str) -> String {
    let (status, row) = service
        .send(
            &format!("/api/threads/{thread}/queue"),
            json!({"prompt":prompt}),
        )
        .await;
    assert_eq!(status, 201, "{row}");
    row["id"].as_str().unwrap().into()
}
fn db(dir: &TempDir) -> rusqlite::Connection {
    rusqlite::Connection::open(dir.path().join("data/orbyn.sqlite3")).unwrap()
}

fn run_context(dir: &TempDir, run: &str) -> Value {
    let (state, error, stop_requested): (String, Option<String>, bool) = db(dir)
        .query_row(
            "SELECT state, error, stop_requested FROM runs WHERE id = ?1",
            [run],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    json!({ "run_id": run, "state": state, "error": error, "stop_requested": stop_requested })
}

#[tokio::test]
async fn retry_uses_captured_command_input_and_rejects_duplicate_attempts() {
    let dir = TempDir::new();
    let (service, _, thread, cwd) = fixture(&dir).await;
    let run = failed(&service, &thread, &cwd).await;
    assert_eq!(turns(&dir), 0);
    let held = queue(&service, &thread, "hold-through-later-turn").await;
    service.admit(&thread, "ordinary-later-turn").await;
    assert_eq!(service.finished(&thread).await, "completed");
    assert_eq!(
        service
            .json(&format!("/api/threads/{thread}/preparation"))
            .await,
        json!({"run_id":run})
    );
    assert_eq!(turns(&dir), 1);
    std::fs::write(cwd.join("orbyn.json"), r#"{"scripts":[]}"#).unwrap();
    let (status, admitted) = retry(&service, &thread, &run).await;
    assert_eq!(status, 202, "{admitted}");
    attempt(&cwd, 2).await;
    assert_eq!(retry(&service, &thread, &run).await.0, 400);
    assert_eq!(turns(&dir), 1);
    release(&cwd, 2, 0);
    assert_eq!(service.finished(&thread).await, "completed");
    assert_eq!(turns(&dir), 2);
    assert_eq!(retry(&service, &thread, &run).await.0, 400);
    let conn = db(&dir);
    assert!(
        conn.query_row(
            "SELECT held FROM queued_messages WHERE id = ?1",
            [&held],
            |row| row.get::<_, bool>(0)
        )
        .unwrap()
    );
    let state: String = conn
        .query_row("SELECT state FROM runs WHERE id = ?1", [&run], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(state, "failed");
    let prompt: String = conn
        .query_row(
            "SELECT text FROM thread_messages WHERE run_key = ?1 AND role = 'user'",
            [admitted["id"].as_str().unwrap()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(prompt, "captured-original-input");
}

#[tokio::test]
async fn repeated_failure_keeps_owned_queue_held_and_success_preserves_unrelated_holds() {
    let dir = TempDir::new();
    let (service, _, thread, cwd) = fixture(&dir).await;
    let run = service.admit(&thread, "captured-original-input").await;
    let unrelated = queue(&service, &thread, "unrelated-user-hold").await;
    db(&dir)
        .execute(
            "UPDATE queued_messages SET held = 1 WHERE id = ?1",
            [&unrelated],
        )
        .unwrap();
    let owned = queue(&service, &thread, "preparation-owned").await;
    // This second message is waiting on the active turn, independently of the
    // first message's user hold. Only preparation's failure owns its later hold.
    db(&dir)
        .execute(
            "UPDATE queued_messages SET held = 0 WHERE id = ?1",
            [&owned],
        )
        .unwrap();
    release(&cwd, 1, 7);
    assert_eq!(service.finished(&thread).await, "failed");
    let (status, next) = retry(&service, &thread, &run).await;
    assert_eq!(status, 202, "{next}");
    attempt(&cwd, 2).await;
    release(&cwd, 2, 8);
    assert_eq!(service.finished(&thread).await, "failed");
    let held: i64 = db(&dir)
        .query_row(
            "SELECT held FROM queued_messages WHERE id = ?1",
            [&owned],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(held, 1);
    assert_eq!(turns(&dir), 0);
    assert_eq!(
        retry(&service, &thread, next["id"].as_str().unwrap())
            .await
            .0,
        202
    );
    attempt(&cwd, 3).await;
    release(&cwd, 3, 0);
    assert_eq!(service.finished(&thread).await, "completed");
    let conn = db(&dir);
    assert!(
        !conn
            .query_row(
                "SELECT held FROM queued_messages WHERE id = ?1",
                [&owned],
                |row| row.get::<_, bool>(0)
            )
            .unwrap()
    );
    assert!(
        conn.query_row(
            "SELECT held FROM queued_messages WHERE id = ?1",
            [&unrelated],
            |row| row.get::<_, bool>(0)
        )
        .unwrap()
    );
    assert_eq!(turns(&dir), 1);
}

#[tokio::test]
async fn active_run_trust_and_cancel_fence_preparation_retry() {
    let dir = TempDir::new();
    let (service, project, thread, cwd) = fixture(&dir).await;
    let run = failed(&service, &thread, &cwd).await;
    db(&dir)
        .execute("UPDATE projects SET trusted = 0 WHERE id = ?1", [&project])
        .unwrap();
    assert_eq!(retry(&service, &thread, &run).await.0, 403);
    assert_eq!(std::fs::read_to_string(cwd.join("attempt")).unwrap(), "1");
    assert_eq!(
        service
            .send(&format!("/api/projects/{project}/trust"), json!({}))
            .await
            .0,
        200
    );
    let active = service.admit(&thread, "[hang]").await;
    assert_eq!(retry(&service, &thread, &run).await.0, 409);
    let (cancel_status, cancel_body) = service
        .send(&format!("/api/runs/{active}/cancel"), json!({}))
        .await;
    assert_eq!(
        cancel_status,
        202,
        "cancel response {cancel_body}; run {}",
        run_context(&dir, &active)
    );
    assert_eq!(
        service.finished(&thread).await,
        "cancelled",
        "run {}",
        run_context(&dir, &active)
    );
    let held = queue(&service, &thread, "later-stop-hold").await;
    let (status, next) = retry(&service, &thread, &run).await;
    assert_eq!(status, 202, "{next}");
    attempt(&cwd, 2).await;
    assert_eq!(
        service
            .send(
                &format!("/api/runs/{}/cancel", next["id"].as_str().unwrap()),
                json!({})
            )
            .await
            .0,
        202
    );
    assert_eq!(service.finished(&thread).await, "cancelled");
    release(&cwd, 2, 0);
    tokio::time::sleep(Duration::from_millis(150)).await;
    let conn = db(&dir);
    assert!(
        conn.query_row(
            "SELECT held FROM queued_messages WHERE id = ?1",
            [&held],
            |row| row.get::<_, bool>(0)
        )
        .unwrap()
    );
    assert_eq!(std::fs::read_to_string(cwd.join("attempt")).unwrap(), "2");
}

#[tokio::test]
async fn crashed_preparation_restarts_as_retryable_failure_without_replaying_a_command() {
    let dir = TempDir::new();
    let (mut service, _, thread, cwd) = fixture(&dir).await;
    let run = failed(&service, &thread, &cwd).await;
    let (status, next) = retry(&service, &thread, &run).await;
    assert_eq!(status, 202);
    attempt(&cwd, 2).await;
    service.kill();
    drop(service);
    let service = Service::start(&dir.path().join("data"), options(&dir));
    assert_eq!(service.finished(&thread).await, "failed");
    assert_eq!(std::fs::read_to_string(cwd.join("attempt")).unwrap(), "2");
    let (status, _) = retry(&service, &thread, next["id"].as_str().unwrap()).await;
    assert_eq!(status, 202);
    attempt(&cwd, 3).await;
    release(&cwd, 3, 0);
    assert_eq!(service.finished(&thread).await, "completed");
    assert_eq!(turns(&dir), 1);
    // Let the orphaned disposable process exit without affecting attempt 3.
    release(&cwd, 2, 7);
}

#[tokio::test]
async fn stopping_the_model_keeps_started_async_setup_alive() {
    for force in [false, true] {
        let dir = TempDir::new();
        let (service, _, thread, cwd) = fixture_with_async(&dir, true).await;
        let run = service.admit(&thread, "[hang]").await;
        let mut released = false;
        for _ in 0..1000 {
            let state = service.json(&format!("/api/threads/{thread}")).await;
            if state["active_run"]["state"] == "running" {
                released = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(released, "model never passed preparation");
        let path = if force {
            format!("/api/threads/{thread}/force-stop")
        } else {
            format!("/api/runs/{run}/cancel")
        };
        let (status, body) = service.send(&path, json!({})).await;
        assert!((200..300).contains(&status), "{status}: {body}");
        assert_eq!(service.finished(&thread).await, "cancelled");
        let state: String = db(&dir)
            .query_row(
                "SELECT status FROM thread_setup WHERE thread_id = ?1",
                [&thread],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            state, "running",
            "model Stop must leave released async setup running"
        );
        release(&cwd, 1, 0);
        let mut finished = false;
        for _ in 0..1000 {
            if cwd.join("finished-1").exists() {
                finished = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(finished, "model Stop killed the real async setup process");
    }
}

async fn preferences(service: &Service, values: Value) {
    let response = service
        .client
        .put(format!("{}/api/preferences", service.url))
        .bearer_auth(&service.token)
        .json(&json!({"values":values}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200, "{}", response.text().await.unwrap());
}
fn protocol(dir: &TempDir, mode: &str) -> Vec<Value> {
    std::fs::read_to_string(dir.path().join("launch.ndjson"))
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|row| row["mode"] == mode)
        .map(|row| serde_json::from_str(row["args"][0].as_str().unwrap()).unwrap())
        .collect()
}

#[tokio::test]
async fn retry_keeps_saved_selection_and_current_permissions_without_changing_preferences() {
    let dir = TempDir::new();
    let (service, _, thread, cwd) = fixture(&dir).await;
    assert_eq!(service.patch(&thread, json!({"model":"fake-big","effort":"xhigh","options":{"service_tier":"priority"},"permission_mode":"full_access"})).await.0, 200);
    let run = failed(&service, &thread, &cwd).await;
    assert_eq!(service.patch(&thread, json!({"model":"fake-small","effort":"low","options":{"service_tier":""},"permission_mode":"supervised","plan_mode":true})).await.0, 200);
    service.admit(&thread, "later-current-selection").await;
    assert_eq!(service.finished(&thread).await, "completed");
    let remembered: String = db(&dir)
        .query_row(
            "SELECT value FROM settings WHERE key = 'engine_selection:codex'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(retry(&service, &thread, &run).await.0, 202);
    attempt(&cwd, 2).await;
    release(&cwd, 2, 0);
    assert_eq!(service.finished(&thread).await, "completed");
    let sent = protocol(&dir, "codex-turn");
    assert_eq!(sent.len(), 2);
    assert_eq!(sent[1]["model"], "fake-big");
    assert_eq!(sent[1]["effort"], "xhigh");
    assert_eq!(sent[1]["serviceTier"], "priority");
    assert_eq!(sent[1]["approvalPolicy"], "on-request");
    assert_eq!(sent[1]["sandboxPolicy"]["type"], "readOnly");
    let current = service.json(&format!("/api/threads/{thread}")).await;
    assert_eq!(current["model"], "fake-small");
    assert_eq!(current["effort"], "low");
    assert!(current["options"].get("service_tier").is_none());
    assert_eq!(
        db(&dir)
            .query_row(
                "SELECT value FROM settings WHERE key = 'engine_selection:codex'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        remembered
    );
}

#[tokio::test]
async fn original_instance_is_revalidated_and_never_uses_or_overwrites_another_instance_session() {
    let dir = TempDir::new();
    let (service, _, thread, cwd) = fixture(&dir).await;
    let instances = |captured: Option<bool>| {
        let mut list = vec![json!({"id":"later-instance","driver":"codex"})];
        if let Some(enabled) = captured {
            list.push(json!({"id":"captured-instance","driver":"codex","enabled":enabled}));
        }
        json!(list)
    };
    preferences(
        &service,
        json!({"provider_instances":instances(Some(true))}),
    )
    .await;
    assert_eq!(
        service
            .send(
                &format!("/api/threads/{thread}/switch-engine"),
                json!({"engine":"captured-instance","model":"fake-big"})
            )
            .await
            .0,
        200
    );
    let run = failed(&service, &thread, &cwd).await;
    assert_eq!(
        service
            .send(
                &format!("/api/threads/{thread}/switch-engine"),
                json!({"engine":"later-instance","model":"fake-small"})
            )
            .await
            .0,
        200
    );
    service.admit(&thread, "later-provider-context").await;
    assert_eq!(service.finished(&thread).await, "completed");
    db(&dir).execute("UPDATE threads SET engine_session = 'other-provider-session', handoff = 'other-provider-handoff' WHERE id = ?1", [&thread]).unwrap();
    preferences(
        &service,
        json!({"provider_instances":instances(Some(false))}),
    )
    .await;
    assert_ne!(retry(&service, &thread, &run).await.0, 202);
    preferences(&service, json!({"provider_instances":instances(None)})).await;
    assert_ne!(retry(&service, &thread, &run).await.0, 202);
    assert_eq!(std::fs::read_to_string(cwd.join("attempt")).unwrap(), "1");
    preferences(
        &service,
        json!({"provider_instances":instances(Some(true))}),
    )
    .await;
    let (status, next) = retry(&service, &thread, &run).await;
    assert_eq!(status, 202, "{next}");
    attempt(&cwd, 2).await;
    release(&cwd, 2, 0);
    assert_eq!(service.finished(&thread).await, "completed");
    let sent = protocol(&dir, "codex-turn");
    assert_eq!(sent.len(), 2);
    assert_eq!(sent[1]["model"], "fake-big");
    let context = sent[1]["input"][0]["text"].as_str().unwrap();
    assert!(
        context.contains("later-provider-context"),
        "fresh run keeps shared conversation context"
    );
    assert!(!context.contains("other-provider-handoff"));
    let starts = protocol(&dir, "codex-thread");
    assert!(
        starts.last().unwrap()["threadId"].is_null(),
        "fresh provider must not resume another instance"
    );
    let conn = db(&dir);
    let current: (String, String, String, String) = conn
        .query_row(
            "SELECT engine, model, engine_session, handoff FROM threads WHERE id = ?1",
            [&thread],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(
        current,
        (
            "later-instance".into(),
            "fake-small".into(),
            "other-provider-session".into(),
            "other-provider-handoff".into()
        )
    );
    assert_eq!(
        conn.query_row(
            "SELECT engine FROM runs WHERE id = ?1",
            [next["id"].as_str().unwrap()],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        "captured-instance"
    );
}

#[tokio::test]
async fn queued_first_turn_captures_its_applied_model_and_options() {
    let dir = TempDir::new();
    let (service, _, thread, cwd) = fixture(&dir).await;
    assert_eq!(
        service
            .patch(&thread, json!({"model":"fake-small","effort":"low"}))
            .await
            .0,
        200
    );
    let (status, _) = service.send(&format!("/api/threads/{thread}/queue"), json!({"prompt":"queued-original", "model":"fake-big","effort":"xhigh","options":{"service_tier":"priority"}})).await;
    assert_eq!(status, 201);
    let active = service.json(&format!("/api/threads/{thread}")).await;
    let run = active["active_run"]["id"].as_str().unwrap();
    release(&cwd, 1, 7);
    assert_eq!(service.finished(&thread).await, "failed");
    service
        .patch(
            &thread,
            json!({"model":"fake-small","effort":"low","options":{"service_tier":""}}),
        )
        .await;
    assert_eq!(retry(&service, &thread, run).await.0, 202);
    attempt(&cwd, 2).await;
    release(&cwd, 2, 0);
    assert_eq!(service.finished(&thread).await, "completed");
    let sent = protocol(&dir, "codex-turn");
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["model"], "fake-big");
    assert_eq!(sent[0]["effort"], "xhigh");
    assert_eq!(sent[0]["serviceTier"], "priority");
}

#[tokio::test]
async fn missing_saved_model_and_failed_catalog_never_start_preparation_or_apply_fallback() {
    let dir = TempDir::new();
    let (service, _, thread, cwd) = fixture(&dir).await;
    preferences(
        &service,
        json!({"custom_models":[{"engine":"codex","id":"retired-model"}]}),
    )
    .await;
    service
        .patch(&thread, json!({"model":"retired-model"}))
        .await;
    let run = failed(&service, &thread, &cwd).await;
    preferences(
        &service,
        json!({"custom_models":[],"fallback_model":"fake-small"}),
    )
    .await;
    assert_ne!(retry(&service, &thread, &run).await.0, 202);
    assert_eq!(std::fs::read_to_string(cwd.join("attempt")).unwrap(), "1");
    preferences(
        &service,
        json!({"custom_models":[{"engine":"codex","id":"retired-model"}]}),
    )
    .await;
    std::fs::write(dir.path().join("lost-models"), "yes").unwrap();
    let catalog = service.json("/api/engines/codex/models?refresh=true").await;
    assert!(!catalog["error"].is_null());
    assert_ne!(retry(&service, &thread, &run).await.0, 202);
    assert_eq!(std::fs::read_to_string(cwd.join("attempt")).unwrap(), "1");
    assert_eq!(turns(&dir), 0);
}

#[tokio::test]
async fn missing_saved_terminal_executable_does_not_rerun_setup() {
    let dir = TempDir::new();
    let (service, _, thread, cwd) = fixture(&dir).await;
    let executable = dir.path().join(if cfg!(windows) {
        "terminal-fixture.exe"
    } else {
        "terminal-fixture"
    });
    std::fs::copy(support::FAKE, &executable).unwrap();
    let (status, body) = service.send("/api/engines/custom", json!({"id":"saved-terminal","name":"Fixture terminal","tier":"terminal","target":executable,"args":[]})).await;
    assert_eq!(status, 201, "{body}");
    assert_eq!(
        service
            .send(
                &format!("/api/threads/{thread}/switch-engine"),
                json!({"engine":"saved-terminal"})
            )
            .await
            .0,
        200
    );
    let run = failed(&service, &thread, &cwd).await;
    std::fs::remove_file(&executable).unwrap();
    assert_ne!(retry(&service, &thread, &run).await.0, 202);
    assert_eq!(std::fs::read_to_string(cwd.join("attempt")).unwrap(), "1");
    assert_eq!(
        db(&dir)
            .query_row(
                "SELECT COUNT(*) FROM runs WHERE thread_id = ?1",
                [&thread],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
}
