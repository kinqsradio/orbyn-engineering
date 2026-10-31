//! Source control through the real service, a local bare remote and a stand-in
//! `gh` that records its arguments and answers like the real one.

#![cfg(unix)]

mod support;

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use support::{Options, Service, TempDir, run_git, setup};

struct Fixture {
    _dir: TempDir,
    service: Service,
    thread: String,
    checkout: PathBuf,
    gh_log: PathBuf,
    state_file: PathBuf,
}

const GH: &str = r#"#!/bin/sh
echo "$@" >> "$GH_LOG"
case "$1 $2" in
  "pr create") [ -f "$GH_FAIL" ] && { echo "no permission" >&2; exit 1; }
    echo "https://github.com/o/r/pull/12" ;;
  "pr view") case "$*" in
      *body*) echo '{"body":"Details","comments":[{"body":"hi"}],"reviews":[]}' ;;
      *) echo "{\"number\":12,\"title\":\"T\",\"url\":\"https://github.com/o/r/pull/12\",\"state\":\"$(cat "$GH_STATE")\",\"headRefName\":\"feature\",\"baseRefName\":\"main\",\"author\":{\"login\":\"me\"}}" ;;
    esac ;;
  "pr checks") echo '[{"name":"ci","state":"SUCCESS","link":"x"}]'; exit 8 ;;
  "pr list") echo '[{"number":3,"title":"Other","url":"u","state":"OPEN","headRefName":"h","baseRefName":"main","author":{"login":"x"}}]' ;;
  "pr merge") echo MERGED > "$GH_STATE" ;;
esac
"#;

async fn fixture() -> Fixture {
    let dir = TempDir::new();
    let bin = dir.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let gh = bin.join("gh");
    std::fs::write(&gh, GH).unwrap();
    std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o755)).unwrap();
    let gh_log = dir.path().join("gh-log");
    let state_file = dir.path().join("gh-state");
    std::fs::write(&state_file, "OPEN").unwrap();
    let env = vec![
        (
            "PATH".to_owned(),
            format!("{}:{}", bin.display(), std::env::var("PATH").unwrap()),
        ),
        ("GH_LOG".to_owned(), gh_log.to_string_lossy().into_owned()),
        (
            "GH_STATE".to_owned(),
            state_file.to_string_lossy().into_owned(),
        ),
        (
            "GH_FAIL".to_owned(),
            dir.path().join("gh-fail").to_string_lossy().into_owned(),
        ),
    ];
    let (service, thread) = setup(
        &dir,
        Options {
            env,
            ..Options::default()
        },
        "codex",
    )
    .await;
    let checkout = dir.path().join("library/repo/project");
    run_git(&checkout, &["config", "user.email", "t@example.com"]);
    run_git(&checkout, &["config", "user.name", "T"]);
    std::fs::write(checkout.join("base.txt"), "base\n").unwrap();
    run_git(&checkout, &["add", "."]);
    run_git(&checkout, &["commit", "-q", "-m", "first"]);
    let remote = dir.path().join("remote.git");
    run_git(
        dir.path(),
        &["init", "-q", "--bare", remote.to_str().unwrap()],
    );
    run_git(
        &checkout,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    Fixture {
        _dir: dir,
        service,
        thread,
        checkout,
        gh_log,
        state_file,
    }
}

async fn act(f: &Fixture, body: Value) -> (u16, Value) {
    f.service
        .send(&format!("/api/threads/{}/git/action", f.thread), body)
        .await
}

fn phases(result: &Value) -> Vec<(String, bool)> {
    result["phases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|phase| {
            (
                phase["name"].as_str().unwrap().to_owned(),
                phase["ok"] == true,
            )
        })
        .collect()
}

fn remote_has(checkout: &Path, branch: &str) -> bool {
    std::process::Command::new("git")
        .args(["ls-remote", "--exit-code", "--heads", "origin", branch])
        .current_dir(checkout)
        .stdout(std::process::Stdio::null())
        .status()
        .unwrap()
        .success()
}

#[tokio::test]
async fn commit_push_and_pull_request_run_in_phases_and_link_the_thread() {
    let f = fixture().await;
    let (code, _) = f
        .service
        .send(
            &format!("/api/threads/{}/branches", f.thread),
            json!({ "name": "feature" }),
        )
        .await;
    assert_eq!(code, 201);
    std::fs::write(f.checkout.join("work.txt"), "work\n").unwrap();
    let (code, result) = act(
        &f,
        json!({
            "commit_message": "Add work",
            "push": true,
            "pull_request": { "title": "T", "body": "Body; rm -rf / $(id)", "base": "main" },
        }),
    )
    .await;
    assert_eq!(code, 200, "{result}");
    assert_eq!(
        phases(&result),
        [
            ("commit".to_owned(), true),
            ("push".to_owned(), true),
            ("pull_request".to_owned(), true),
        ]
    );
    assert_eq!(result["phases"][2]["url"], "https://github.com/o/r/pull/12");
    assert!(remote_has(&f.checkout, "feature"));
    let log = std::fs::read_to_string(&f.gh_log).unwrap();
    assert!(
        log.contains("--body Body; rm -rf / $(id)"),
        "arguments stay literal: {log}"
    );
    let linked = f
        .service
        .json(&format!("/api/threads/{}/pulls", f.thread))
        .await;
    assert_eq!(linked[0]["number"], 12);
    assert_eq!(linked[0]["state"], "open");
    let events = f
        .service
        .events_until(&f.thread, None, |event| {
            event["event"]["name"] == "git.phase"
                && event["event"]["value"]["name"] == "pull_request"
        })
        .await;
    assert!(!events.is_empty());
}

#[tokio::test]
async fn a_failed_phase_stops_the_rest() {
    let f = fixture().await;
    let (code, result) = act(
        &f,
        json!({
            "commit_message": "Nothing changed",
            "push": true,
        }),
    )
    .await;
    assert_eq!(code, 200);
    assert_eq!(phases(&result), [("commit".to_owned(), false)]);
    assert!(!remote_has(&f.checkout, "main"));

    std::fs::write(f.checkout.join("work.txt"), "x").unwrap();
    std::fs::write(f._dir.path().join("gh-fail"), "").unwrap();
    let (_, result) = act(
        &f,
        json!({
            "commit_message": "Work",
            "push": true,
            "pull_request": { "title": "T" },
        }),
    )
    .await;
    assert_eq!(
        phases(&result).last().unwrap(),
        &("pull_request".to_owned(), false)
    );
    assert!(
        result["phases"][2]["message"]
            .as_str()
            .unwrap()
            .contains("no permission")
    );
    assert!(remote_has(&f.checkout, "main"), "earlier phases stand");
}

#[tokio::test]
async fn writes_wait_for_the_run_and_a_failing_commit_hook_is_honored() {
    let f = fixture().await;
    let hook = f.checkout.join(".git/hooks/pre-commit");
    std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
    std::fs::write(&hook, "#!/bin/sh\necho hook refused >&2\nexit 1\n").unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(f.checkout.join("work.txt"), "x").unwrap();
    let (_, result) = act(&f, json!({ "commit_message": "Work" })).await;
    assert!(
        result["phases"][0]["message"]
            .as_str()
            .unwrap()
            .contains("hook refused")
    );
    std::fs::remove_file(&hook).unwrap();

    let run = f.service.admit(&f.thread, "[hang]").await;
    let (code, body) = act(&f, json!({ "commit_message": "Work" })).await;
    assert_eq!(code, 409);
    assert_eq!(body["code"], "thread_busy");
    let (code, _) = f
        .service
        .send(
            &format!("/api/threads/{}/branches/switch", f.thread),
            json!({ "name": "main" }),
        )
        .await;
    assert_eq!(code, 409);
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    f.service
        .send(&format!("/api/runs/{run}/cancel"), json!({}))
        .await;
    f.service.finished(&f.thread).await;
}

#[tokio::test]
async fn branches_list_create_switch_and_refuse_bad_names() {
    let f = fixture().await;
    let path = format!("/api/threads/{}/branches", f.thread);
    let (code, _) = f.service.send(&path, json!({ "name": "--force" })).await;
    assert_eq!(code, 400);
    let (code, _) = f.service.send(&path, json!({ "name": "a..b" })).await;
    assert_eq!(code, 400);
    assert_eq!(
        f.service.send(&path, json!({ "name": "topic" })).await.0,
        201
    );
    let list = f.service.json(&path).await;
    let current: Vec<_> = list
        .as_array()
        .unwrap()
        .iter()
        .filter(|branch| branch["current"] == true)
        .collect();
    assert_eq!(current[0]["name"], "topic");
    let switch = format!("{path}/switch");
    assert_eq!(
        f.service.send(&switch, json!({ "name": "main" })).await.0,
        204
    );

    // Git refuses to overwrite local work, and the refusal reaches the client.
    std::fs::write(f.checkout.join("base.txt"), "main edit\n").unwrap();
    run_git(&f.checkout, &["commit", "-q", "-am", "on main"]);
    run_git(&f.checkout, &["switch", "-q", "topic"]);
    std::fs::write(f.checkout.join("base.txt"), "local edit\n").unwrap();
    let (code, body) = f.service.send(&switch, json!({ "name": "main" })).await;
    assert_eq!(code, 409, "{body}");
    assert_eq!(body["code"], "git_failed");
    assert_eq!(
        std::fs::read_to_string(f.checkout.join("base.txt")).unwrap(),
        "local edit\n"
    );
}

#[tokio::test]
async fn pull_details_keep_checks_when_gh_exits_nonzero_and_merge_settles_by_rule() {
    let f = fixture().await;
    let pulls = format!("/api/threads/{}/pulls", f.thread);
    let (code, linked) = f.service.send(&pulls, json!({ "number": 12 })).await;
    assert_eq!(code, 201, "{linked}");
    let detail = f.service.json(&format!("{pulls}/12")).await;
    assert_eq!(detail["body"], "Details");
    assert_eq!(detail["pull"]["state"], "open");
    assert_eq!(detail["comments"]["comments"][0]["body"], "hi");

    let (code, _) = f
        .service
        .send(&format!("{pulls}/12/merge"), json!({ "method": "yolo" }))
        .await;
    assert_eq!(code, 400);
    let (code, body) = f
        .service
        .send(&format!("{pulls}/12/merge"), json!({ "method": "squash" }))
        .await;
    assert_eq!(code, 202, "{body}");
    assert!(
        std::fs::read_to_string(&f.gh_log)
            .unwrap()
            .contains("pr merge 12 --squash")
    );
    let thread = f.service.json(&format!("/api/threads/{}", f.thread)).await;
    assert!(thread["lifecycle"]["settled_at"].is_string(), "{thread}");
    assert_eq!(f.service.json(&pulls).await[0]["state"], "merged");
}

#[tokio::test]
async fn a_thread_that_opted_out_stays_active_after_a_merge() {
    let f = fixture().await;
    let pulls = format!("/api/threads/{}/pulls", f.thread);
    f.service.send(&pulls, json!({ "number": 12 })).await;
    f.service
        .patch(&f.thread, json!({ "auto_settle": "disabled" }))
        .await;
    std::fs::write(&f.state_file, "MERGED").unwrap();
    let (code, refreshed) = f.service.send(&format!("{pulls}/refresh"), json!({})).await;
    assert_eq!(code, 200);
    assert_eq!(refreshed[0]["state"], "merged");
    let thread = f.service.json(&format!("/api/threads/{}", f.thread)).await;
    assert!(thread["lifecycle"]["settled_at"].is_null());
}

#[tokio::test]
async fn review_list_and_publish_use_the_users_own_cli() {
    let f = fixture().await;
    let pulls = format!("/api/threads/{}/pulls", f.thread);
    f.service.send(&pulls, json!({ "number": 12 })).await;
    let (code, _) = f
        .service
        .send(
            &format!("{pulls}/12/review"),
            json!({ "event": "request_changes", "body": "Fix" }),
        )
        .await;
    assert_eq!(code, 202);
    let (code, _) = f
        .service
        .send(&format!("{pulls}/12/review"), json!({ "event": "bogus" }))
        .await;
    assert_eq!(code, 400);
    let log = std::fs::read_to_string(&f.gh_log).unwrap();
    assert!(log.contains("pr review 12 --request-changes --body Fix"));

    let thread = f.service.json(&format!("/api/threads/{}", f.thread)).await;
    let project = thread["project_id"].as_str().unwrap();
    let open = f
        .service
        .json(&format!("/api/projects/{project}/pulls"))
        .await;
    assert_eq!(open[0]["number"], 3);
    assert_eq!(open[0]["state"], "open");
    let bad = f
        .service
        .get(&format!("/api/projects/{project}/pulls?state=x"))
        .send()
        .await
        .unwrap();
    assert_eq!(bad.status(), 400);

    let (code, body) = f
        .service
        .send(
            &format!("/api/projects/{project}/publish"),
            json!({ "private": true }),
        )
        .await;
    assert_eq!(
        code, 400,
        "a project with a remote is already published: {body}"
    );
    run_git(&f.checkout, &["remote", "remove", "origin"]);
    let (code, _) = f
        .service
        .send(
            &format!("/api/projects/{project}/publish"),
            json!({ "private": true, "name": "r" }),
        )
        .await;
    assert_eq!(code, 202);
    assert!(
        std::fs::read_to_string(&f.gh_log)
            .unwrap()
            .contains("repo create r --private --source . --push")
    );
}
