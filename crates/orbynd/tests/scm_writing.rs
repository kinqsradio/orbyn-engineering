//! Real service and Git, synthetic provider executable; no model or forge call.
mod support;

use serde_json::{Value, json};
use std::path::Path;
use support::{Options, Service, TempDir, run_git};

fn git(cwd: &Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .unwrap();
    assert!(output.status.success(), "{args:?}: {output:?}");
    String::from_utf8(output.stdout).unwrap()
}

async fn fixture(engine: &str) -> (TempDir, Service, String, std::path::PathBuf) {
    fixture_with_head(engine, true).await
}

async fn fixture_with_head(
    engine: &str,
    committed: bool,
) -> (TempDir, Service, String, std::path::PathBuf) {
    let dir = TempDir::new();
    let record = dir.path().join("one-shot.txt");
    let barrier = dir.path().join("barrier");
    std::fs::write(barrier.with_extension("release"), "release").unwrap();
    let options = Options {
        env: vec![
            (
                "ORBYN_FAKE_SCM_BARRIER".into(),
                barrier.to_str().unwrap().into(),
            ),
            (
                "ORBYN_FAKE_ONE_SHOT_FILE".into(),
                record.to_str().unwrap().into(),
            ),
            (
                "CLAUDE_CONFIG_DIR".into(),
                dir.path().join("claude").to_str().unwrap().into(),
            ),
            (
                "CODEX_HOME".into(),
                dir.path().join("codex").to_str().unwrap().into(),
            ),
            ("HOME".into(), dir.path().to_str().unwrap().into()),
            ("USERPROFILE".into(), dir.path().to_str().unwrap().into()),
        ],
        ..Default::default()
    };
    let cwd = dir.path().join("project");
    std::fs::create_dir_all(&cwd).unwrap();
    run_git(&cwd, &["init", "-q", "-b", "main"]);
    run_git(&cwd, &["config", "user.name", "Test"]);
    run_git(&cwd, &["config", "user.email", "test@example.com"]);
    std::fs::write(cwd.join("tracked.txt"), "initial\n").unwrap();
    run_git(&cwd, &["add", "."]);
    if committed {
        run_git(&cwd, &["commit", "-qm", "initial"]);
    }
    let service = Service::start(&dir.path().join("data"), options);
    let project = service.project(&cwd, true).await;
    let thread = service.thread(&project, engine).await;
    assert_eq!(
        service.json(&format!("/api/threads/{thread}")).await["cwd"],
        cwd.to_str().unwrap()
    );
    assert_eq!(
        service
            .patch(&thread, json!({"model":"chosen-model"}))
            .await
            .0,
        200
    );
    (dir, service, thread, record)
}

#[tokio::test]
async fn explicit_blank_uses_strict_selected_provider_and_real_diff() {
    let (dir, service, thread, record) = fixture("claude").await;
    let cwd = dir.path().join("project");
    std::fs::write(cwd.join("tracked.txt"), "changed é\n").unwrap();
    std::fs::write(cwd.join("new space.txt"), "new content\n").unwrap();
    let (status, result) = service
        .send(
            &format!("/api/threads/{thread}/git/action"),
            json!({"commit_message":""}),
        )
        .await;
    assert_eq!(status, 200, "{result}");
    assert_eq!(result["phases"][0]["ok"], true);
    assert_eq!(
        git(&cwd, &["log", "-1", "--format=%s"]).trim(),
        "feat(git): describe the change"
    );
    let prompt = std::fs::read_to_string(&record).unwrap();
    assert!(prompt.contains("changed é"));
    assert!(prompt.contains("new content"));
    let boundary: Value = serde_json::from_str(
        &std::fs::read_to_string(record.with_extension("writing.json")).unwrap(),
    )
    .unwrap();
    let args: Vec<&str> = boundary["args"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap())
        .collect();
    let after = |flag| args[args.iter().position(|arg| *arg == flag).unwrap() + 1];
    assert_eq!(after("--tools"), "");
    assert_eq!(after("--model"), "chosen-model");
    assert_eq!(after("--permission-mode"), "dontAsk");
    for flag in [
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--no-session-persistence",
    ] {
        assert!(args.contains(&flag));
    }
    assert_eq!(boundary["mcp"], "{\"mcpServers\":{}}");
    assert_eq!(boundary["settings"], "{\"disableAllHooks\":true}");
    assert_eq!(boundary["cloud_mcp"], "false");
    assert_eq!(boundary["ide"], "0");
    let private = boundary["cwd"].as_str().unwrap();
    assert!(!Path::new(private).exists(), "request directory retired");
    service.stop().await;
}

#[tokio::test]
async fn a_fenced_json_reply_is_accepted_for_commit_and_pull_request_text() {
    let (dir, service, thread, _) = fixture("claude").await;
    let cwd = dir.path().join("project");
    run_git(&cwd, &["switch", "-qc", "feature"]);
    std::fs::write(cwd.join("tracked.txt"), "[fenced-scm-text]\n").unwrap();
    let (status, result) = service
        .send(
            &format!("/api/threads/{thread}/git/action"),
            json!({"commit_message":"","pull_request":{"title":"","body":"","base":"main"}}),
        )
        .await;
    assert_eq!(status, 200, "{result}");
    assert_eq!(result["phases"][0]["ok"], true, "{result}");
    assert_eq!(
        git(&cwd, &["log", "-1", "--format=%B"]).trim(),
        "feat(git): fenced reply\n\nInside a fence"
    );
    assert_eq!(
        pull_titles(&service, &thread).await,
        ["feat(git): fenced reply"]
    );
    service.stop().await;
}

#[tokio::test]
async fn unsupported_codex_generation_does_not_redirect_and_manual_text_bypasses_it() {
    let (dir, service, thread, record) = fixture("codex").await;
    let cwd = dir.path().join("project");
    std::fs::write(cwd.join("tracked.txt"), "changed\n").unwrap();
    let (status, error) = service
        .send(
            &format!("/api/threads/{thread}/git/action"),
            json!({"commit_message":""}),
        )
        .await;
    // Main's behavior: a blank commit message is refused, never generated.
    assert_eq!(status, 400, "{error}");
    assert_eq!(error["message"], "Enter a commit message.");
    assert!(!record.exists());
    let (status, result) = service
        .send(
            &format!("/api/threads/{thread}/git/action"),
            json!({"commit_message":"fix: manual on codex"}),
        )
        .await;
    assert_eq!(status, 200, "{result}");
    assert!(!record.exists());
    service.stop().await;
}

#[tokio::test]
async fn changed_candidate_after_model_request_is_refused_without_staging() {
    let (dir, service, thread, record) = fixture("claude").await;
    let cwd = dir.path().join("project");
    std::fs::write(cwd.join("tracked.txt"), "[slow-scm-text]\n").unwrap();
    let path = format!("/api/threads/{thread}/git/action");
    let action = service.send(&path, json!({"commit_message":""}));
    let mutation = async {
        for _ in 0..200 {
            if record.exists() {
                std::fs::write(cwd.join("tracked.txt"), "newer user work\n").unwrap();
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("the synthetic model request did not start");
    };
    let ((status, error), ()) = tokio::join!(action, mutation);
    assert_eq!(status, 400, "{error}");
    assert!(git(&cwd, &["diff", "--cached", "--name-only"]).is_empty());
    assert_eq!(
        std::fs::read_to_string(cwd.join("tracked.txt")).unwrap(),
        "newer user work\n"
    );
    service.stop().await;
}

#[tokio::test]
async fn project_style_overrides_global_and_reset_restores_inheritance() {
    let (dir, service, thread, record) = fixture("claude").await;
    let cwd = dir.path().join("project");
    let project = service.json(&format!("/api/threads/{thread}")).await["project_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let put = |path: String, body: Value| {
        service
            .client
            .put(format!("{}{path}", service.url))
            .bearer_auth(&service.token)
            .json(&body)
            .send()
    };
    assert!(put("/api/preferences".into(), json!({"values":{"source_control_writing_style":{"mode":"custom","custom_instructions":"Global sentence"},"text_generation_model":"explicit-writer"}})).await.unwrap().status().is_success());
    let path = format!("/api/projects/{project}/preferences");
    assert!(put(path.clone(), json!({"values":{"source_control_writing_style":{"mode":"custom","custom_instructions":"Project sentence"}}})).await.unwrap().status().is_success());
    std::fs::write(cwd.join("tracked.txt"), "[bad-scm-text]\n").unwrap();
    let action = format!("/api/threads/{thread}/git/action");
    // A failed reply still commits now; the prompt is what this case checks.
    assert_eq!(
        service.send(&action, json!({"commit_message":""})).await.0,
        200
    );
    let prompt = std::fs::read_to_string(&record).unwrap();
    assert!(prompt.contains("Project sentence"));
    assert!(!prompt.contains("Global sentence"));
    assert!(
        std::fs::read_to_string(record.with_extension("args"))
            .unwrap()
            .contains("explicit-writer")
    );
    assert!(
        put(
            path.clone(),
            json!({"values":{"source_control_writing_style":null}})
        )
        .await
        .unwrap()
        .status()
        .is_success()
    );
    std::fs::write(cwd.join("tracked.txt"), "[bad-scm-text] again\n").unwrap();
    assert_eq!(
        service.send(&action, json!({"commit_message":""})).await.0,
        200
    );
    assert!(
        std::fs::read_to_string(&record)
            .unwrap()
            .contains("Global sentence")
    );
    assert_eq!(
        put(
            path,
            json!({"values":{"source_control_writing_style":{"mode":"unknown"}}})
        )
        .await
        .unwrap()
        .status()
        .as_u16(),
        400
    );
    assert!(git(&cwd, &["diff", "--cached", "--name-only"]).is_empty());
    service.stop().await;
}

#[tokio::test]
async fn disabling_the_engine_between_generations_prevents_the_second_call_and_all_effects() {
    let (dir, service, thread, _) = fixture("claude").await;
    let cwd = dir.path().join("project");
    run_git(&cwd, &["switch", "-qc", "feature"]);
    std::fs::write(cwd.join("tracked.txt"), "pending change\n").unwrap();
    let barrier = dir.path().join("barrier");
    std::fs::remove_file(barrier.with_extension("release")).unwrap();
    let head = git(&cwd, &["rev-parse", "HEAD"]);
    let path = format!("/api/threads/{thread}/git/action");
    let action = service.send(&path, json!({"commit_message":"","push":true,"pull_request":{"title":"","body":"","base":"main"}}));
    let disable = async {
        for _ in 0..500 {
            if barrier.with_extension("ready").exists() {
                let response = service
                    .client
                    .put(format!("{}/api/preferences", service.url))
                    .bearer_auth(&service.token)
                    .json(&json!({"values":{"disabled_engines":["claude"]}}))
                    .send()
                    .await
                    .unwrap();
                assert!(response.status().is_success());
                std::fs::write(barrier.with_extension("release"), "release").unwrap();
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("the synthetic model request was not admitted");
    };
    let ((status, error), ()) = tokio::join!(action, disable);
    assert_eq!(status, 400, "{error}");
    assert!(error["message"].as_str().unwrap().contains("turned off"));
    let calls = service
        .audit(&thread)
        .await
        .into_iter()
        .filter(|row| row["action"] == "engine.one_shot")
        .count();
    assert_eq!(calls, 1, "the second generation must not be admitted");
    assert_eq!(git(&cwd, &["rev-parse", "HEAD"]), head);
    assert!(git(&cwd, &["diff", "--cached", "--name-only"]).is_empty());
    service.stop().await;
}

#[cfg(unix)]
#[tokio::test]
async fn executable_mode_changed_during_generation_is_refused() {
    use std::os::unix::fs::PermissionsExt;
    let (dir, service, thread, _) = fixture("claude").await;
    let cwd = dir.path().join("project");
    run_git(&cwd, &["config", "core.filemode", "true"]);
    std::fs::write(cwd.join("tracked.txt"), "pending content\n").unwrap();
    let barrier = dir.path().join("barrier");
    std::fs::remove_file(barrier.with_extension("release")).unwrap();
    let path = format!("/api/threads/{thread}/git/action");
    let action = service.send(&path, json!({"commit_message":""}));
    let chmod = async {
        for _ in 0..500 {
            if barrier.with_extension("ready").exists() {
                std::fs::set_permissions(
                    cwd.join("tracked.txt"),
                    std::fs::Permissions::from_mode(0o755),
                )
                .unwrap();
                std::fs::write(barrier.with_extension("release"), "release").unwrap();
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("the synthetic model request was not admitted");
    };
    let ((status, error), ()) = tokio::join!(action, chmod);
    assert_eq!(status, 400, "{error}");
    assert!(git(&cwd, &["diff", "--cached", "--name-only"]).is_empty());
    assert_ne!(
        std::fs::metadata(cwd.join("tracked.txt"))
            .unwrap()
            .permissions()
            .mode()
            & 0o100,
        0
    );
    service.stop().await;
}

#[cfg(unix)]
#[tokio::test]
async fn staged_unborn_native_mode_is_described_and_committed_without_a_false_stale_refusal() {
    use std::os::unix::fs::PermissionsExt;
    let (dir, service, thread, record) = fixture_with_head("claude", false).await;
    let cwd = dir.path().join("project");
    run_git(&cwd, &["config", "core.filemode", "true"]);
    std::fs::set_permissions(
        cwd.join("tracked.txt"),
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    let (status, result) = service
        .send(
            &format!("/api/threads/{thread}/git/action"),
            json!({"commit_message":""}),
        )
        .await;
    assert_eq!(status, 200, "{result}");
    assert_eq!(result["phases"][0]["ok"], true);
    assert!(
        std::fs::read_to_string(record)
            .unwrap()
            .contains("mode 100755")
    );
    assert!(git(&cwd, &["ls-tree", "HEAD", "tracked.txt"]).starts_with("100755"));
    service.stop().await;
}

#[cfg(unix)]
#[tokio::test]
async fn staged_unborn_mode_changed_during_generation_is_rejected_before_add() {
    use std::os::unix::fs::PermissionsExt;
    let (dir, service, thread, _) = fixture_with_head("claude", false).await;
    let cwd = dir.path().join("project");
    run_git(&cwd, &["config", "core.filemode", "true"]);
    let barrier = dir.path().join("barrier");
    std::fs::remove_file(barrier.with_extension("release")).unwrap();
    let index = git(&cwd, &["ls-files", "--stage"]);
    let path = format!("/api/threads/{thread}/git/action");
    let action = service.send(&path, json!({"commit_message":""}));
    let chmod = async {
        for _ in 0..500 {
            if barrier.with_extension("ready").exists() {
                std::fs::set_permissions(
                    cwd.join("tracked.txt"),
                    std::fs::Permissions::from_mode(0o755),
                )
                .unwrap();
                std::fs::write(barrier.with_extension("release"), "release").unwrap();
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("the synthetic model request was not admitted");
    };
    let ((status, error), ()) = tokio::join!(action, chmod);
    assert_eq!(status, 400, "{error}");
    assert_eq!(
        git(&cwd, &["ls-files", "--stage"]),
        index,
        "generation must reject before staging a new mode"
    );
    assert!(!cwd.join(".git/refs/heads/main").exists());
    service.stop().await;
}

fn feature_with_commit(cwd: &Path) {
    run_git(cwd, &["switch", "-qc", "feature"]);
    std::fs::write(cwd.join("tracked.txt"), "feature change\n").unwrap();
    run_git(cwd, &["commit", "-qam", "feature work"]);
}

async fn pull_titles(service: &Service, thread: &str) -> Vec<String> {
    service
        .audit(thread)
        .await
        .into_iter()
        .filter(|row| row["action"] == "git.pull_request")
        .map(|row| row["target"].as_str().unwrap().to_owned())
        .rev()
        .collect()
}

#[tokio::test]
async fn engine_without_writing_keeps_manual_pull_request_behavior_for_blank_fields() {
    let (dir, service, thread, record) = fixture("codex").await;
    let cwd = dir.path().join("project");
    feature_with_commit(&cwd);
    let path = format!("/api/threads/{thread}/git/action");
    let thread_title = service.json(&format!("/api/threads/{thread}")).await["title"]
        .as_str()
        .unwrap()
        .to_owned();
    let (status, result) = service
        .send(
            &path,
            json!({"pull_request":{"title":"Typed title","body":"","base":"main"}}),
        )
        .await;
    assert_eq!(status, 200, "{result}");
    let (status, result) = service
        .send(
            &path,
            json!({"pull_request":{"title":"","body":"","base":"main"}}),
        )
        .await;
    assert_eq!(status, 200, "{result}");
    assert_eq!(
        pull_titles(&service, &thread).await,
        ["Typed title".to_owned(), thread_title]
    );
    assert!(!record.exists(), "no generation for an unsupported engine");
    service.stop().await;
}

#[tokio::test]
async fn writing_engine_keeps_a_typed_title_and_generates_only_the_blank_body() {
    let (dir, service, thread, record) = fixture("claude").await;
    let cwd = dir.path().join("project");
    feature_with_commit(&cwd);
    let (status, result) = service
        .send(
            &format!("/api/threads/{thread}/git/action"),
            json!({"pull_request":{"title":"Typed title","body":"","base":"main"}}),
        )
        .await;
    assert_eq!(status, 200, "{result}");
    assert!(record.exists(), "the body was generated");
    assert_eq!(pull_titles(&service, &thread).await, ["Typed title"]);
    service.stop().await;
}

#[tokio::test]
async fn switching_branches_at_the_same_commit_during_pull_request_generation_is_refused() {
    let (dir, service, thread, _) = fixture("claude").await;
    let cwd = dir.path().join("project");
    feature_with_commit(&cwd);
    let barrier = dir.path().join("barrier");
    std::fs::remove_file(barrier.with_extension("release")).unwrap();
    let path = format!("/api/threads/{thread}/git/action");
    let action = service.send(
        &path,
        json!({"push":true,"pull_request":{"title":"","body":"","base":"main"}}),
    );
    let switch = async {
        for _ in 0..500 {
            if barrier.with_extension("ready").exists() {
                run_git(&cwd, &["switch", "-qc", "other"]);
                std::fs::write(barrier.with_extension("release"), "release").unwrap();
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("the synthetic model request was not admitted");
    };
    let ((status, error), ()) = tokio::join!(action, switch);
    assert_eq!(status, 400, "{error}");
    assert!(pull_titles(&service, &thread).await.is_empty());
    service.stop().await;
}

#[tokio::test]
async fn a_malformed_reply_commits_with_the_thread_title_and_says_why() {
    let (dir, service, thread, record) = fixture("claude").await;
    let cwd = dir.path().join("project");
    std::fs::write(cwd.join("tracked.txt"), "[bad-scm-text]\n").unwrap();
    let title = thread_title(&service, &thread).await;
    let (status, result) = service
        .send(
            &format!("/api/threads/{thread}/git/action"),
            json!({"commit_message":""}),
        )
        .await;
    assert_eq!(status, 200, "{result}");
    assert_eq!(result["phases"][0]["ok"], true, "{result}");
    assert_eq!(git(&cwd, &["log", "-1", "--format=%B"]).trim(), title);
    let notice = result["notice"].as_str().unwrap();
    assert!(notice.starts_with("Text was not generated"), "{notice}");
    assert!(notice.contains("invalid commit text"), "{notice}");
    // Typed text never asks the engine.
    let prompt = std::fs::read(&record).unwrap();
    std::fs::write(cwd.join("tracked.txt"), "more\n").unwrap();
    let (status, result) = service
        .send(
            &format!("/api/threads/{thread}/git/action"),
            json!({"commit_message":"fix: keep manual text"}),
        )
        .await;
    assert_eq!(status, 200, "{result}");
    assert!(result["notice"].is_null());
    assert_eq!(std::fs::read(&record).unwrap(), prompt);
    assert_eq!(
        git(&cwd, &["log", "-1", "--format=%s"]).trim(),
        "fix: keep manual text"
    );
    service.stop().await;
}

#[tokio::test]
async fn a_failed_pull_request_generation_keeps_the_generated_commit_text() {
    let (dir, service, thread, _) = fixture("claude").await;
    let cwd = dir.path().join("project");
    run_git(&cwd, &["switch", "-qc", "feature"]);
    std::fs::write(cwd.join("tracked.txt"), "[bad-pr-text]\n").unwrap();
    let title = thread_title(&service, &thread).await;
    let (status, result) = service
        .send(
            &format!("/api/threads/{thread}/git/action"),
            json!({"commit_message":"","pull_request":{"title":"","body":"","base":"main"}}),
        )
        .await;
    assert_eq!(status, 200, "{result}");
    assert_eq!(result["phases"][0]["ok"], true, "{result}");
    assert_eq!(
        git(&cwd, &["log", "-1", "--format=%s"]).trim(),
        "feat(git): describe the change"
    );
    assert_eq!(pull_titles(&service, &thread).await, [title]);
    assert!(
        result["notice"]
            .as_str()
            .unwrap()
            .contains("invalid pull request text")
    );
    service.stop().await;
}

#[tokio::test]
async fn a_change_too_large_to_describe_still_commits_without_waiting_out_the_read() {
    let (dir, service, thread, record) = fixture("claude").await;
    let cwd = dir.path().join("project");
    let title = thread_title(&service, &thread).await;
    let path = format!("/api/threads/{thread}/git/action");
    std::fs::write(cwd.join("big.txt"), "x\n".repeat(80_000)).unwrap();
    let started = std::time::Instant::now();
    let (status, result) = service.send(&path, json!({"commit_message":""})).await;
    assert_eq!(status, 200, "{result}");
    // Refused at the size cap, not after the read deadline.
    assert!(started.elapsed() < std::time::Duration::from_secs(15));
    assert_eq!(git(&cwd, &["log", "-1", "--format=%s"]).trim(), title);
    let notice = result["notice"].as_str().unwrap();
    assert!(notice.contains("too large"), "{notice}");
    assert!(!record.exists(), "nothing was sent to the engine");
    service.stop().await;
}

async fn thread_title(service: &Service, thread: &str) -> String {
    service.json(&format!("/api/threads/{thread}")).await["title"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// Git older than 2.40 ignores `GIT_ATTR_SOURCE`, so generation is refused and
/// the commit falls back. A stand-in `git` reports an old version and passes
/// everything else to the real one.
#[cfg(unix)]
#[tokio::test]
async fn git_older_than_2_40_never_reads_the_change_for_generation() {
    use std::os::unix::fs::PermissionsExt;
    let real = String::from_utf8(
        std::process::Command::new("sh")
            .args(["-c", "command -v git"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();
    let dir = TempDir::new();
    let bin = dir.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let stand_in = bin.join("git");
    std::fs::write(
        &stand_in,
        format!(
            "#!/bin/sh\nfor arg in \"$@\"; do [ \"$arg\" = version ] && {{ echo 'git version 2.39.5'; exit 0; }}; done\nexec {} \"$@\"\n",
            real.trim()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&stand_in, std::fs::Permissions::from_mode(0o755)).unwrap();
    let record = dir.path().join("one-shot.txt");
    let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap());
    let options = Options {
        env: vec![
            ("PATH".into(), path),
            (
                "ORBYN_FAKE_ONE_SHOT_FILE".into(),
                record.to_str().unwrap().into(),
            ),
            ("HOME".into(), dir.path().to_str().unwrap().into()),
        ],
        ..Default::default()
    };
    let cwd = dir.path().join("project");
    std::fs::create_dir_all(&cwd).unwrap();
    run_git(&cwd, &["init", "-q", "-b", "main"]);
    run_git(&cwd, &["config", "user.name", "Test"]);
    run_git(&cwd, &["config", "user.email", "test@example.com"]);
    std::fs::write(cwd.join("tracked.txt"), "initial\n").unwrap();
    run_git(&cwd, &["add", "."]);
    run_git(&cwd, &["commit", "-qm", "initial"]);
    let service = Service::start(&dir.path().join("data"), options);
    let project = service.project(&cwd, true).await;
    let thread = service.thread(&project, "claude").await;
    assert_eq!(
        service
            .patch(&thread, json!({"model":"chosen-model"}))
            .await
            .0,
        200
    );
    std::fs::write(cwd.join("tracked.txt"), "changed\n").unwrap();
    let (status, result) = service
        .send(
            &format!("/api/threads/{thread}/git/action"),
            json!({"commit_message":""}),
        )
        .await;
    assert_eq!(status, 200, "{result}");
    assert_eq!(result["phases"][0]["ok"], true, "{result}");
    assert!(
        result["notice"]
            .as_str()
            .is_some_and(|notice| notice.contains("Git 2.40 or later")),
        "{result}"
    );
    assert!(!record.exists(), "no change was sent to the engine");
    assert_eq!(
        git(&cwd, &["log", "-1", "--format=%s"]).trim(),
        thread_title(&service, &thread).await
    );
    service.stop().await;
}
