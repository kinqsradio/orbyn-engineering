//! Service-level contracts through real HTTP against the real binary.

mod support;

use std::time::Duration;

use serde_json::{Value, json};
use support::{Options, Service, TempDir, setup, text_of, types_of};

#[tokio::test]
async fn token_is_required_on_api_agui_and_ws() {
    let dir = TempDir::new();
    let service = Service::start(&dir.path().join("data"), Options::default());
    let client = reqwest::Client::new();
    for path in [
        "/api/info",
        "/api/projects",
        "/ws/terminal/x",
        "/api/threads/x/events",
    ] {
        let response = client
            .get(format!("{}{path}", service.url))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 401, "{path}");
        let wrong = client
            .get(format!("{}{path}", service.url))
            .bearer_auth("wrong")
            .send()
            .await
            .unwrap();
        assert_eq!(wrong.status(), 401, "{path}");
    }
    let response = client
        .post(format!("{}/agui/threads/x", service.url))
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
    let info = service.json("/api/info").await;
    assert_eq!(info["remote"], false);
}

#[tokio::test]
async fn query_token_works_only_on_streaming_gets() {
    let dir = TempDir::new();
    let service = Service::start(&dir.path().join("data"), Options::default());
    let client = reqwest::Client::new();
    let plain = format!("{}/api/info?token={}", service.url, service.token);
    assert_eq!(client.get(plain).send().await.unwrap().status(), 401);
    let events = format!(
        "{}/api/threads/missing/events?token={}",
        service.url, service.token
    );
    assert_eq!(client.get(events).send().await.unwrap().status(), 404);
}

#[tokio::test]
async fn hostile_host_and_origin_are_rejected_everywhere() {
    let dir = TempDir::new();
    let service = Service::start(&dir.path().join("data"), Options::default());
    for path in ["/api/info", "/", "/mcp/abc"] {
        let response = service
            .get(path)
            .header("Host", "evil.test")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 403, "{path}");
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["code"], "host_not_allowed");
    }
    let response = service
        .get("/api/info")
        .header("Origin", "http://evil.test")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["code"], "origin_not_allowed");
    let same = service
        .get("/api/info")
        .header("Origin", service.url.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(same.status(), 200);
}

#[tokio::test]
async fn allowed_host_flag_extends_the_list() {
    let dir = TempDir::new();
    let service = Service::start(
        &dir.path().join("data"),
        Options {
            args: vec!["--allowed-host".into(), "box.tailnet.ts.net".into()],
            ..Options::default()
        },
    );
    let response = service
        .get("/api/info")
        .header("Host", "box.tailnet.ts.net")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
}

#[tokio::test]
async fn remote_mode_needs_tls_assertion_and_exchanges_a_hashed_key() {
    let dir = TempDir::new();
    let data = dir.path().join("data");
    let refused = Service::try_start(
        &data,
        Options {
            args: vec!["--remote".into()],
            ..Options::default()
        },
    );
    assert!(refused.err().unwrap().contains("--tls-terminated"));

    let remote = || Options {
        args: vec!["--remote".into(), "--tls-terminated".into()],
        ..Options::default()
    };
    let mut service = Service::start(&data, remote());
    let key = service
        .access_key
        .clone()
        .expect("first start shows the key");
    let client = reqwest::Client::builder().build().unwrap();
    let bad = client
        .post(format!("{}/auth/session", service.url))
        .json(&json!({ "key": "wrong" }))
        .send()
        .await
        .unwrap();
    assert_eq!(bad.status(), 401);
    let good = client
        .post(format!("{}/auth/session", service.url))
        .json(&json!({ "key": key }))
        .send()
        .await
        .unwrap();
    assert_eq!(good.status(), 204);
    let cookie = good
        .headers()
        .get("set-cookie")
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    assert!(cookie.contains("HttpOnly"));
    assert!(cookie.contains("SameSite=Strict"));
    let pair = cookie.split(';').next().unwrap();
    let info = client
        .get(format!("{}/api/info", service.url))
        .header("Cookie", pair)
        .send()
        .await
        .unwrap();
    assert_eq!(info.status(), 200);
    assert_eq!(info.json::<Value>().await.unwrap()["remote"], true);

    // The key survives restart hashed, and is never printed again.
    service.kill();
    let again = Service::start(&data, remote());
    assert!(again.access_key.is_none());
    let reopened = client
        .post(format!("{}/auth/session", again.url))
        .json(&json!({ "key": key }))
        .send()
        .await
        .unwrap();
    assert_eq!(reopened.status(), 204);
}

#[tokio::test]
async fn untrusted_folder_refuses_runs_and_worktrees() {
    let dir = TempDir::new();
    let service = Service::start(&dir.path().join("data"), Options::default());
    let folder = dir.path().join("project");
    std::fs::create_dir_all(folder.join(".git")).unwrap();
    let project = service.project(&folder, false).await;
    let thread = service.thread(&project, "codex").await;
    let (status, body) = service
        .send(
            &format!("/api/threads/{thread}/runs"),
            json!({ "prompt": "x" }),
        )
        .await;
    assert_eq!(status, 403);
    assert_eq!(body["code"], "folder_untrusted");
    let (status, _) = service
        .send(
            "/api/threads",
            json!({
                "project_id": project, "engine": "codex", "model": null, "title": null,
                "worktree": "feature", "skill_profile": null,
            }),
        )
        .await;
    assert_eq!(status, 403);
    assert!(!dir.path().join("project-wt").exists());
}

#[tokio::test]
async fn second_run_on_a_thread_is_409_and_cancel_is_final() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    let run = service.admit(&thread, "[hang]").await;
    let (status, body) = service
        .send(
            &format!("/api/threads/{thread}/runs"),
            json!({ "prompt": "x" }),
        )
        .await;
    assert_eq!(status, 409);
    assert_eq!(body["code"], "thread_busy");
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (status, _) = service
        .send(&format!("/api/runs/{run}/cancel"), json!({}))
        .await;
    assert_eq!(status, 202);
    assert_eq!(service.finished(&thread).await, "cancelled");
    let (status, body) = service
        .send(&format!("/api/runs/{run}/cancel"), json!({}))
        .await;
    assert_eq!(status, 409);
    assert_eq!(body["code"], "run_closed");
}

#[tokio::test]
async fn replay_then_live_has_no_gap_or_duplicate() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    service.admit(&thread, "[approve]").await;
    let approval = service.pending().await;

    // First client reads what exists, then disconnects at the pending approval.
    let first = service
        .events_until(&thread, None, |event| {
            event["event"]["activityType"] == "approval"
        })
        .await;
    let seen = first.last().unwrap()["seq"].as_i64().unwrap();

    // Second client resumes mid-log and stays connected across the live edge.
    let follower = {
        let client = reqwest::Client::new();
        let url = format!("{}/api/threads/{thread}/events", service.url);
        let token = service.token.clone();
        tokio::spawn(async move {
            let response = client
                .get(url)
                .bearer_auth(token)
                .header("Last-Event-ID", seen.to_string())
                .send()
                .await
                .unwrap();
            let mut body = response.bytes_stream();
            let mut parser = orbyn_core::sse::SseParser::default();
            let mut events: Vec<Value> = Vec::new();
            use futures_util::StreamExt;
            while let Some(Ok(chunk)) = body.next().await {
                for frame in parser.push(&chunk) {
                    events.push(serde_json::from_str(&frame).unwrap());
                }
                if events
                    .iter()
                    .any(|event| event["event"]["type"] == "RUN_FINISHED")
                {
                    break;
                }
            }
            events
        })
    };
    tokio::time::sleep(Duration::from_millis(100)).await;
    service.decide(approval["id"].as_str().unwrap(), true).await;
    let second = tokio::time::timeout(Duration::from_secs(15), follower)
        .await
        .unwrap()
        .unwrap();
    let mut seqs: Vec<i64> = first.iter().map(|e| e["seq"].as_i64().unwrap()).collect();
    seqs.extend(second.iter().map(|e| e["seq"].as_i64().unwrap()));
    assert_eq!(seqs, (1..=seqs.len() as i64).collect::<Vec<_>>());
    assert_eq!(*types_of(&second).last().unwrap(), "RUN_FINISHED");
}

#[tokio::test]
async fn approval_decided_twice_keeps_the_first_outcome() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    service.admit(&thread, "[approve]").await;
    let approval = service.pending().await;
    let id = approval["id"].as_str().unwrap().to_owned();
    let (first, second) = tokio::join!(service.decide(&id, true), service.decide(&id, false));
    let statuses = [first.0, second.0];
    assert!(
        statuses.contains(&200) && statuses.contains(&409),
        "{statuses:?}"
    );
    let winner = if first.0 == 200 { &first.1 } else { &second.1 };
    let loser = if first.0 == 409 { &first.1 } else { &second.1 };
    assert_eq!(loser["code"], "already_decided");
    assert_eq!(loser["detail"]["state"], winner["state"]);
    service.finished(&thread).await;
}

#[tokio::test]
async fn remember_allows_the_same_target_next_time() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    service.admit(&thread, "[approve]").await;
    let approval = service.pending().await;
    let (status, _) = service
        .send(
            &format!("/api/approvals/{}/decide", approval["id"].as_str().unwrap()),
            json!({ "allow": true, "remember": true }),
        )
        .await;
    assert_eq!(status, 200);
    service.finished(&thread).await;
    let rules = service.json("/api/policy/rules").await;
    assert_eq!(rules[0]["pattern"], "=ls");
    service.admit(&thread, "[approve]").await;
    assert_eq!(service.finished(&thread).await, "completed");
    let events = service.all_events(&thread).await;
    assert!(text_of(&events).contains("decision accept"));
}

#[tokio::test]
async fn policy_deny_beats_allow_without_asking() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    for (effect, pattern) in [("allow", "*"), ("deny", "ls*")] {
        let (status, _) = service
            .send(
                "/api/policy/rules",
                json!({ "effect": effect, "kind": "command", "pattern": pattern,
                        "engine": null, "note": null }),
            )
            .await;
        assert_eq!(status, 201);
    }
    service.admit(&thread, "[approve]").await;
    assert_eq!(service.finished(&thread).await, "completed");
    assert_eq!(
        text_of(&service.all_events(&thread).await),
        "decision decline"
    );
    let audit = service.audit(&thread).await;
    assert!(audit.iter().any(|row| row["action"] == "action.deny"));
}

#[tokio::test]
async fn audit_precedes_the_engine_hearing_the_answer() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    service.admit(&thread, "[approve]").await;
    let approval = service.pending().await;
    service.decide(approval["id"].as_str().unwrap(), true).await;
    service.finished(&thread).await;
    let audit = service.audit(&thread).await;
    let actions: Vec<&str> = audit
        .iter()
        .filter_map(|row| row["action"].as_str())
        .rev()
        .collect();
    let position = |name: &str| actions.iter().position(|action| *action == name).unwrap();
    assert!(position("run.admit") < position("approval.request"));
    assert!(position("approval.request") < position("approval.allowed"));
    assert!(position("approval.allowed") < position("run.finish"));
}

#[tokio::test]
async fn revoked_mcp_token_is_refused_after_the_run() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "claude").await;
    service.admit(&thread, "say hi").await;
    service.finished(&thread).await;
    let client = reqwest::Client::new();
    let response = client
        .post(format!("{}/mcp/not-a-token", service.url))
        .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 404);
}

#[tokio::test]
async fn crash_recovery_interrupts_runs_and_expires_approvals() {
    let dir = TempDir::new();
    let data = dir.path().join("data");
    let (mut service, thread) = setup(&dir, Options::default(), "codex").await;
    service.admit(&thread, "[approve]").await;
    let approval = service.pending().await;
    service.kill();

    let reopened = Service::start(&data, Options::default());
    assert_eq!(reopened.run_state(&thread).await, "interrupted");
    let body = reopened.json("/api/approvals?state=expired").await;
    assert_eq!(body[0]["id"], approval["id"]);
    let events = reopened.all_events(&thread).await;
    let last = events.last().unwrap();
    assert_eq!(last["event"]["type"], "RUN_ERROR");
    assert_eq!(last["event"]["code"], "interrupted");
    // The thread works again after recovery.
    reopened.admit(&thread, "hello").await;
    assert_eq!(reopened.finished(&thread).await, "completed");
}

#[tokio::test]
async fn second_service_on_a_data_dir_is_refused() {
    let dir = TempDir::new();
    let data = dir.path().join("data");
    let _first = Service::start(&data, Options::default());
    let second = Service::try_start(&data, Options::default());
    assert!(second.err().unwrap().contains("owns this data directory"));
}

#[tokio::test]
async fn parent_stdin_close_stops_the_service_and_its_engines() {
    let dir = TempDir::new();
    let pid_file = dir.path().join("pids");
    let (mut service, thread) = setup(
        &dir,
        Options {
            args: vec!["--parent-stdin".into()],
            env: vec![(
                "ORBYN_FAKE_PID_FILE".into(),
                pid_file.to_string_lossy().into_owned(),
            )],
            ..Options::default()
        },
        "codex",
    )
    .await;
    service.admit(&thread, "[hang]").await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    drop(service.child.stdin.take());
    let mut status = None;
    for _ in 0..1500 {
        status = service.child.try_wait().unwrap();
        if status.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(status.expect("service exited").success());
}

#[tokio::test]
async fn delete_refuses_an_active_thread_then_removes_it() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    let run = service.admit(&thread, "[hang]").await;
    let client = reqwest::Client::new();
    let url = format!("{}/api/threads/{thread}", service.url);
    let busy = client
        .delete(&url)
        .bearer_auth(&service.token)
        .send()
        .await
        .unwrap();
    assert_eq!(busy.status(), 409);
    tokio::time::sleep(Duration::from_millis(100)).await;
    service
        .send(&format!("/api/runs/{run}/cancel"), json!({}))
        .await;
    service.finished(&thread).await;
    let gone = client
        .delete(&url)
        .bearer_auth(&service.token)
        .send()
        .await
        .unwrap();
    assert_eq!(gone.status(), 204);
    assert_eq!(
        service
            .get(&format!("/api/threads/{thread}"))
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
}

fn write(path: &std::path::Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn skill_library(root: &std::path::Path) -> std::path::PathBuf {
    let source = root.join("library/skills");
    write(
        &source.join("catalog.json"),
        r#"{"skills":[{"name":"how","category":"Engineering practice","related":[]}]}"#,
    );
    write(
        &source.join("how/SKILL.md"),
        "---\nname: how\ndescription: \"Trace behavior\"\n---\n\n# how\n",
    );
    source
}

#[tokio::test]
async fn tampered_pack_is_reported_and_blocks_runs() {
    let dir = TempDir::new();
    let source = skill_library(dir.path());
    let (service, thread) = setup(
        &dir,
        Options {
            skills: Some(source),
            ..Options::default()
        },
        "codex",
    )
    .await;
    let status = service.json("/api/skills").await;
    assert_eq!(status["signature_valid"], true);
    assert_eq!(status["skills"][0]["name"], "how");
    service.admit(&thread, "ok").await;
    assert_eq!(service.finished(&thread).await, "completed");

    let packs = dir.path().join("data/skills/packs");
    let pack = std::fs::read_dir(&packs)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| path.join("manifest.json").exists())
        .unwrap();
    write(&pack.join("skills/how/SKILL.md"), "tampered");
    assert_eq!(service.json("/api/skills").await["signature_valid"], false);
    service.admit(&thread, "again").await;
    assert_eq!(service.finished(&thread).await, "failed");
    let events = service
        .events_until(&thread, None, |event| event["event"]["type"] == "RUN_ERROR")
        .await;
    assert!(
        events.last().unwrap()["event"]["message"]
            .as_str()
            .unwrap()
            .contains("verification")
    );
}

#[tokio::test]
async fn profiles_keep_the_builtin_default() {
    let dir = TempDir::new();
    let source = skill_library(dir.path());
    let (service, _) = setup(
        &dir,
        Options {
            skills: Some(source),
            ..Options::default()
        },
        "codex",
    )
    .await;
    let (status, created) = service
        .send(
            "/api/skills/profiles",
            json!({ "id": "", "name": "Backend", "skills": ["how"] }),
        )
        .await;
    assert_eq!(status, 201);
    let profiles = service.json("/api/skills/profiles").await;
    assert_eq!(profiles[0]["id"], "default");
    assert_eq!(profiles.as_array().unwrap().len(), 2);
    let client = reqwest::Client::new();
    let refused = client
        .delete(format!("{}/api/skills/profiles/default", service.url))
        .bearer_auth(&service.token)
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status(), 400);
    let deleted = client
        .delete(format!(
            "{}/api/skills/profiles/{}",
            service.url,
            created["id"].as_str().unwrap()
        ))
        .bearer_auth(&service.token)
        .send()
        .await
        .unwrap();
    assert_eq!(deleted.status(), 204);
}

#[tokio::test]
async fn folder_browser_lists_directories_only() {
    let dir = TempDir::new();
    let service = Service::start(&dir.path().join("data"), Options::default());
    std::fs::create_dir_all(dir.path().join("root/repo/.git")).unwrap();
    std::fs::create_dir_all(dir.path().join("root/plain")).unwrap();
    std::fs::write(dir.path().join("root/file.txt"), "x").unwrap();
    let path = dir.path().join("root");
    let listing = service
        .get("/api/fs/browse")
        .query(&[("path", path.to_str().unwrap())])
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    let names: Vec<_> = listing["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            (
                entry["name"].as_str().unwrap(),
                entry["is_git"].as_bool().unwrap(),
            )
        })
        .collect();
    assert_eq!(names, [("plain", false), ("repo", true)]);
    assert_eq!(listing["parent"], dir.path().to_str().unwrap());
}

#[tokio::test]
async fn external_agui_projects_a_pause_and_resumes_the_same_process() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    let input = json!({
        "threadId": thread, "runId": "external-1",
        "messages": [{ "id": "m", "role": "user", "content": "[approve]" }],
    });
    let (frames, _) = agui_stream(&service, &thread, input).await;
    let first = frames.first().unwrap();
    assert_eq!(first["type"], "RUN_STARTED");
    assert_eq!(first["runId"], "external-1");
    let last = frames.last().unwrap();
    assert_eq!(last["type"], "RUN_FINISHED");
    assert_eq!(last["outcome"]["type"], "interrupt");
    let interrupt = &last["outcome"]["interrupts"][0];
    let interrupt_id = interrupt["id"].as_str().unwrap().to_owned();
    assert_eq!(service.run_state(&thread).await, "awaiting_approval");

    // New input while paused is refused by the interrupt contract.
    let blocked = json!({
        "threadId": thread, "runId": "external-x",
        "messages": [{ "id": "m", "role": "user", "content": "other" }],
    });
    let (frames, _) = agui_stream(&service, &thread, blocked).await;
    assert_eq!(frames.last().unwrap()["type"], "RUN_ERROR");

    let resume = json!({
        "threadId": thread, "runId": "external-2", "messages": [],
        "resume": [{ "interruptId": interrupt_id, "status": "resolved",
                     "payload": { "approved": true } }],
    });
    let (frames, _) = agui_stream(&service, &thread, resume.clone()).await;
    assert_eq!(frames.first().unwrap()["runId"], "external-2");
    let last = frames.last().unwrap();
    assert_eq!(last["type"], "RUN_FINISHED");
    assert_eq!(last["outcome"]["type"], "success");
    assert_eq!(last["runId"], "external-2");
    let text: String = frames
        .iter()
        .filter(|frame| frame["type"] == "TEXT_MESSAGE_CONTENT")
        .filter_map(|frame| frame["delta"].as_str())
        .collect();
    assert_eq!(text, "decision accept");
    assert_eq!(service.finished(&thread).await, "completed");

    // Replaying the same resume is harmless.
    let (frames, _) = agui_stream(&service, &thread, resume).await;
    assert_eq!(frames.last().unwrap()["type"], "RUN_FINISHED");
}

#[tokio::test]
async fn external_agui_rejects_a_mismatched_thread() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    let (status, _) = service
        .send(
            &format!("/agui/threads/{thread}"),
            json!({ "threadId": "other", "runId": "r", "messages": [] }),
        )
        .await;
    assert_eq!(status, 400);
}

async fn agui_stream(service: &Service, thread: &str, input: Value) -> (Vec<Value>, u16) {
    let response = service
        .post(&format!("/agui/threads/{thread}"))
        .header("Accept", "text/event-stream")
        .json(&input)
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    let mut body = response.bytes_stream();
    let mut parser = orbyn_core::sse::SseParser::default();
    let mut frames = Vec::new();
    use futures_util::StreamExt;
    loop {
        let chunk = tokio::time::timeout(Duration::from_secs(15), body.next())
            .await
            .expect("stream stalled");
        let Some(chunk) = chunk else { break };
        for frame in parser.push(&chunk.unwrap()) {
            frames.push(serde_json::from_str(&frame).unwrap());
        }
    }
    (frames, status)
}

#[tokio::test]
async fn static_ui_has_csp_and_spa_fallback() {
    let dir = TempDir::new();
    let ui = dir.path().join("ui");
    write(&ui.join("index.html"), "<!doctype html><title>app</title>");
    write(&ui.join("assets/app.js"), "console.log(1)");
    let service = Service::start(
        &dir.path().join("data"),
        Options {
            args: vec!["--ui-dir".into(), ui.to_string_lossy().into_owned()],
            ..Options::default()
        },
    );
    let client = reqwest::Client::new();
    let page = client
        .get(format!("{}/threads/abc", service.url))
        .send()
        .await
        .unwrap();
    assert_eq!(page.status(), 200);
    let csp = page
        .headers()
        .get("content-security-policy")
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    assert!(csp.contains("default-src 'self'"));
    assert!(csp.contains("frame-ancestors 'none'"));
    assert!(page.text().await.unwrap().contains("<title>app</title>"));
    let script = client
        .get(format!("{}/assets/app.js", service.url))
        .send()
        .await
        .unwrap();
    assert!(
        script.headers()["content-type"]
            .to_str()
            .unwrap()
            .contains("javascript")
    );
    let missing_api = service.get("/api/nothing").send().await.unwrap();
    assert_eq!(missing_api.status(), 404);
    let body: Value = missing_api.json().await.unwrap();
    assert_eq!(body["code"], "not_found");
}

#[tokio::test]
async fn git_worktree_and_diff_through_the_api() {
    let dir = TempDir::new();
    let service = Service::start(&dir.path().join("data"), Options::default());
    let repo = dir.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    let git = |args: &[&str]| {
        assert!(
            std::process::Command::new("git")
                .args(args)
                .current_dir(&repo)
                .status()
                .unwrap()
                .success()
        );
    };
    git(&["init", "-q", "-b", "main"]);
    git(&["config", "user.email", "t@example.com"]);
    git(&["config", "user.name", "T"]);
    std::fs::write(repo.join("a.txt"), "one\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "-q", "-m", "first"]);
    let project = service.project(&repo, true).await;
    let (status, thread) = service
        .send(
            "/api/threads",
            json!({ "project_id": project, "engine": "codex", "model": null, "title": "T",
                    "worktree": "feature-x", "skill_profile": null }),
        )
        .await;
    assert_eq!(status, 201, "{thread}");
    let path = dir.path().join("repo-wt/feature-x");
    assert_eq!(thread["cwd"], path.to_str().unwrap());
    std::fs::write(path.join("b.txt"), "new\n").unwrap();
    let diff = service
        .json(&format!(
            "/api/threads/{}/diff",
            thread["id"].as_str().unwrap()
        ))
        .await;
    assert_eq!(diff[0]["path"], "b.txt");
    assert_eq!(diff[0]["status"], "added");
    assert!(repo.join(".git").exists());
    assert!(!repo.join("b.txt").exists());
}

#[tokio::test]
async fn terminal_websocket_echoes_and_resizes() {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::connect_async;
    use tokio_tungstenite::tungstenite::Message;

    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    let url = format!(
        "{}/ws/terminal/{thread}?token={}",
        service.url.replacen("http", "ws", 1),
        service.token
    );
    let (mut socket, _) = connect_async(url).await.unwrap();
    socket
        .send(Message::text(r#"{"cols":100,"rows":30}"#))
        .await
        .unwrap();
    socket
        .send(Message::binary(b"echo orbyn-terminal-$((40+2))\r".to_vec()))
        .await
        .unwrap();
    let mut seen = String::new();
    let found = tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(Ok(frame)) = socket.next().await {
            if let Message::Binary(bytes) = frame {
                seen.push_str(&String::from_utf8_lossy(&bytes));
                if seen.contains("orbyn-terminal-42") {
                    return true;
                }
            }
        }
        false
    })
    .await
    .unwrap_or(false);
    assert!(found, "terminal output: {seen}");
    let audit = service.audit(&thread).await;
    assert!(audit.iter().any(|row| row["action"] == "terminal.open"));
}

#[tokio::test]
async fn terminal_needs_a_trusted_folder() {
    let dir = TempDir::new();
    let service = Service::start(&dir.path().join("data"), Options::default());
    let folder = dir.path().join("project");
    std::fs::create_dir_all(&folder).unwrap();
    let project = service.project(&folder, false).await;
    let thread = service.thread(&project, "codex").await;
    let url = format!(
        "{}/ws/terminal/{thread}?token={}",
        service.url.replacen("http", "ws", 1),
        service.token
    );
    let refused = tokio_tungstenite::connect_async(url).await;
    assert!(refused.is_err());
}

#[tokio::test]
async fn computer_action_without_a_run_needs_an_allow_rule() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    let (status, body) = service
        .send(
            &format!("/api/threads/{thread}/computer"),
            json!({ "action": "browser.navigate", "target": "https://example.com", "args": null }),
        )
        .await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(body["code"], "policy_denied");
    let audit = service.audit(&thread).await;
    assert_eq!(audit[0]["action"], "action.deny");
    assert_eq!(audit[0]["target"], "https://example.com/");
}

#[tokio::test]
async fn update_without_provable_ownership_is_refused() {
    let dir = TempDir::new();
    let (service, _) = setup(&dir, Options::default(), "codex").await;
    let (status, body) = service.send("/api/engines/codex/update", json!({})).await;
    assert_eq!(status, 422);
    assert_eq!(body["code"], "update_unavailable");
}
