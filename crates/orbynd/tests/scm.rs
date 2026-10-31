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
pull() {
  echo "{\"number\":$1,\"title\":\"$2\",\"url\":\"https://github.com/o/r/pull/$1\",\"state\":\"$(cat "$GH_STATE")\",\"headRefName\":\"$3\",\"baseRefName\":\"$4\",\"author\":{\"login\":\"me\"},\"isDraft\":false,\"labels\":[{\"name\":\"bug\"}],\"reviewDecision\":\"APPROVED\",\"statusCheckRollup\":[]$5}"
}
case "$1 $2" in
  "pr create") [ -f "$GH_FAIL" ] && { echo "no permission" >&2; exit 1; }
    echo "https://github.com/o/r/pull/12" ;;
  "pr view") pull 12 T feature main ',"body":"Details","comments":[{"body":"hi"}],"reviews":[],"mergeable":"MERGEABLE","headRefOid":"abc","baseRefOid":"def","additions":3,"reviewRequests":[{"login":"sam"}]' ;;
  "pr checks") echo '[{"name":"ci","state":"SUCCESS","link":"x","bucket":"pass"},{"name":"lint","state":"FAILURE","link":"y","bucket":"fail"}]'; exit 1 ;;
  "pr list") case "$*" in
      *--head*) echo "[$(pull 12 T feature main)]" ;;
      *) echo "[$(pull 3 Other h main),$(pull 4 Next i h)]" ;;
    esac ;;
  "pr merge") echo MERGED > "$GH_STATE" ;;
  "pr close") [ "$3" = 66 ] && { echo "refused" >&2; exit 1; } ;;
  "label list") echo '[{"name":"bug","description":"Broken"}]' ;;
  "api user") echo '{"login":"me"}' ;;
  "api graphql") echo '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[{"id":"T1","isResolved":false,"path":"a.rs","line":2,"comments":{"nodes":[{"databaseId":11,"body":"line","author":{"login":"them"}}]}}]}}}}}' ;;
  "auth status") echo "  Logged in to github.com account octo (keyring)" >&2 ;;
  "--version "*) echo "gh version 2.0" ;;
esac
case "$*" in
  api*/issues/*/comments*) cat "$GH_COMMENTS" 2>/dev/null || echo '[{"id":7,"body":"hello","user":{"login":"me"}}]' ;;
  api*/issues/*/timeline*) echo '[{"id":1,"event":"labeled","actor":{"login":"me"}}]' ;;
  api*/pulls/*/files*) echo '[{"filename":"a.rs","status":"changed","additions":1,"deletions":2,"patch":"@@"},{"filename":"b.rs","status":"removed","additions":0,"deletions":1}]' ;;
  api*/pulls/*/reviews*--input*) cat >> "$GH_LOG" ;;
  api*assignees*) echo '[{"login":"sam"}]' ;;
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
            "GH_COMMENTS".to_owned(),
            dir.path()
                .join("library/repo/comments.json")
                .to_string_lossy()
                .into_owned(),
        ),
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

impl Fixture {
    async fn project(&self) -> String {
        let thread = self
            .service
            .json(&format!("/api/threads/{}", self.thread))
            .await;
        thread["project_id"].as_str().unwrap().to_owned()
    }

    fn log(&self) -> String {
        std::fs::read_to_string(&self.gh_log).unwrap_or_default()
    }

    /// Points origin at a GitHub-shaped URL, so forge routes go through `gh`.
    fn hosted(&self) {
        run_git(
            &self.checkout,
            &["remote", "set-url", "origin", "https://github.com/o/r.git"],
        );
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

#[tokio::test]
async fn lists_narrow_and_read_into_one_shape() {
    let f = fixture().await;
    f.hosted();
    let project = f.project().await;
    let pulls = f
        .service
        .json(&format!(
            "/api/projects/{project}/pulls?state=all&q=fix&author=me&label=bug"
        ))
        .await;
    assert_eq!(pulls[0]["labels"][0], "bug");
    assert_eq!(pulls[0]["review_state"], "approved");
    let log = f.log();
    assert!(log.contains("--state all"));
    assert!(
        log.contains("--search fix --author me --label bug"),
        "{log}"
    );
    let all = f.service.json("/api/pulls").await;
    assert_eq!(all["pulls"][0]["project_id"], project.as_str());
    assert_eq!(all["failed"].as_array().unwrap().len(), 0);
    let (code, _) = f
        .service
        .send(
            &format!("/api/projects/{project}/pulls/9/action"),
            json!({ "action": "nope" }),
        )
        .await;
    assert_eq!(code, 400);
}

#[tokio::test]
async fn detail_checks_conversation_timeline_and_files_are_normalized() {
    let f = fixture().await;
    f.hosted();
    let project = f.project().await;
    let base = format!("/api/projects/{project}/pulls/12");
    let detail = f.service.json(&base).await;
    assert_eq!(detail["mergeable"], "mergeable");
    assert_eq!(detail["reviewers"][0], "sam");
    assert_eq!(detail["additions"], 3);
    let checks = f.service.json(&format!("{base}/checks")).await;
    assert_eq!(checks[1]["state"], "fail");
    let talk = f.service.json(&format!("{base}/comments")).await;
    assert_eq!(talk["comments"][0]["author"], "me");
    assert_eq!(talk["threads"][0]["id"], "T1");
    let timeline = f.service.json(&format!("{base}/timeline")).await;
    assert_eq!(timeline[0]["kind"], "labeled");
    let (code, _) = f
        .service
        .send(
            &format!("{base}/viewed"),
            json!({ "paths": ["a.rs"], "viewed": true }),
        )
        .await;
    assert_eq!(code, 204);
    let files = f.service.json(&format!("{base}/files")).await;
    assert_eq!(files[0]["status"], "modified");
    assert_eq!(files[0]["viewed"], true);
    assert_eq!(files[1]["status"], "deleted");
    assert_eq!(files[1]["viewed"], false);
}

#[tokio::test]
async fn writes_reach_the_forge_with_their_arguments_and_are_audited() {
    let f = fixture().await;
    f.hosted();
    let project = f.project().await;
    let base = format!("/api/projects/{project}/pulls/12");
    for (path, body) in [
        ("comments", json!({ "body": "plain" })),
        (
            "comments",
            json!({ "body": "on a line", "path": "a.rs", "line": 3 }),
        ),
        ("comments", json!({ "body": "reply", "reply_to": "11" })),
        (
            "comments/7/react",
            json!({ "kind": "issue", "content": "rocket" }),
        ),
        ("threads/T1/resolve", json!({ "resolved": true })),
        ("reviewers", json!({ "add": ["sam"], "remove": ["kim"] })),
        ("labels", json!({ "add": ["bug"] })),
        (
            "merge",
            json!({
                "method": "squash", "auto": true, "delete_branch": true,
                "body": "Done\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
                "strip_credits": true,
            }),
        ),
        (
            "review",
            json!({
                "event": "comment", "body": "Notes",
                "comments": [{ "path": "a.rs", "line": 1, "body": "here" }],
            }),
        ),
        ("action", json!({ "action": "update_branch" })),
    ] {
        let (code, reply) = f.service.send(&format!("{base}/{path}"), body).await;
        assert_eq!(code, 202, "{path}: {reply}");
    }
    let (code, _) = f
        .service
        .send(
            &format!("{base}/comments/1%2F..%2F2/react"),
            json!({ "kind": "issue", "content": "+1" }),
        )
        .await;
    assert_eq!(code, 400);
    let (code, _) = f
        .service
        .send(
            &format!("{base}/comments/7/react"),
            json!({ "kind": "issue", "content": "shrug" }),
        )
        .await;
    assert_eq!(code, 400);
    let patched = f
        .service
        .client
        .patch(format!("{}{base}", f.service.url))
        .bearer_auth(&f.service.token)
        .json(&json!({ "title": "New", "draft": true, "maintainer_can_modify": false }))
        .send()
        .await
        .unwrap();
    assert_eq!(patched.status(), 200);
    let log = f.log();
    for expected in [
        "pr comment 12 --body plain",
        "commit_id=abc -f path=path=a.rs"
            .replace("path=path=", "path=")
            .as_str(),
        "repos/{owner}/{repo}/pulls/12/comments/11/replies",
        "repos/{owner}/{repo}/issues/comments/7/reactions -f content=rocket",
        "resolveReviewThread",
        "--add-reviewer sam --remove-reviewer kim",
        "--add-label bug",
        "pr merge 12 --squash --auto --delete-branch --body Done",
        "\"event\":\"COMMENT\"",
        "pr update-branch 12",
        "pr edit 12 --title New",
        "pr ready 12 --undo",
        "maintainer_can_modify=false",
    ] {
        assert!(log.contains(expected), "missing {expected}\n{log}");
    }
    assert!(!log.contains("Co-Authored-By"), "{log}");
    let audit = f.service.json("/api/audit?limit=100").await;
    assert!(
        audit
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["action"] == "git.merge")
    );
}

#[tokio::test]
async fn bulk_close_reports_each_and_stacks_follow_bases() {
    let f = fixture().await;
    f.hosted();
    let project = f.project().await;
    let (code, results) = f
        .service
        .send(
            &format!("/api/projects/{project}/pulls/close"),
            json!({ "numbers": [65, 66, 67] }),
        )
        .await;
    assert_eq!(code, 200);
    assert_eq!(results[1]["ok"], false);
    assert_eq!(results[2]["ok"], true, "one refusal does not stop the rest");
    let stack = f
        .service
        .json(&format!("/api/projects/{project}/pulls/4/stack"))
        .await;
    assert_eq!(stack["layers"][0]["number"], 3);
    assert_eq!(stack["position"], 1);
    let (code, results) = f
        .service
        .send(
            &format!("/api/projects/{project}/pulls/4/stack"),
            json!({ "action": "merge", "method": "squash" }),
        )
        .await;
    assert_eq!(code, 200, "{results}");
    assert_eq!(results.as_array().unwrap().len(), 2);
    let log = f.log();
    let first = log.find("pr merge 3").unwrap();
    assert!(
        first < log.find("pr merge 4").unwrap(),
        "bottom layer first"
    );
}

#[tokio::test]
async fn a_watch_wakes_on_news_and_ends_with_the_pull_request() {
    let f = fixture().await;
    f.hosted();
    let watch = format!("/api/threads/{}/pulls/12/watch", f.thread);
    let (code, _) = f.service.send(&watch, json!({})).await;
    assert_eq!(code, 201);
    // The first pass sees a failing check, which is news.
    let (code, _) = f.service.send("/api/watches/check", json!({})).await;
    assert_eq!(code, 204);
    assert_eq!(f.service.finished(&f.thread).await, "completed");
    let events = f.service.all_events(&f.thread).await;
    assert!(
        format!("{events:?}").contains("A check failed."),
        "{events:?}"
    );
    // Nothing moved, so the next pass stays quiet.
    let (code, _) = f.service.send("/api/watches/check", json!({})).await;
    assert_eq!(code, 204);
    let queue = f
        .service
        .json(&format!("/api/threads/{}/queue", f.thread))
        .await;
    assert_eq!(queue.as_array().unwrap().len(), 0);
    let list = f
        .service
        .json(&format!("/api/threads/{}/watches", f.thread))
        .await;
    assert_eq!(list.as_array().unwrap().len(), 1);
    // A comment from someone else wakes it; your own would not.
    let comments = f.checkout.parent().unwrap().join("comments.json");
    std::fs::write(
        &comments,
        r#"[{"id":8,"body":"hey","user":{"login":"them"}}]"#,
    )
    .unwrap();
    std::fs::write(&f.state_file, "MERGED").unwrap();
    let (code, _) = f.service.send("/api/watches/check", json!({})).await;
    assert_eq!(code, 204);
    let list = f
        .service
        .json(&format!("/api/threads/{}/watches", f.thread))
        .await;
    assert_eq!(list.as_array().unwrap().len(), 0, "a merge ends the watch");
}

#[tokio::test]
async fn settling_ends_watches_and_a_settled_thread_cannot_start_one() {
    let f = fixture().await;
    f.hosted();
    let watch = format!("/api/threads/{}/pulls/12/watch", f.thread);
    assert_eq!(f.service.send(&watch, json!({})).await.0, 201);
    let (code, _) = f.service.patch(&f.thread, json!({ "settled": true })).await;
    assert_eq!(code, 200);
    let list = f
        .service
        .json(&format!("/api/threads/{}/watches", f.thread))
        .await;
    assert_eq!(list.as_array().unwrap().len(), 0);
    assert_eq!(f.service.send(&watch, json!({})).await.0, 400);
}

#[tokio::test]
async fn refresh_links_the_branch_pull_request_on_its_own() {
    let f = fixture().await;
    f.hosted();
    let (code, _) = f
        .service
        .send(
            &format!("/api/threads/{}/branches", f.thread),
            json!({ "name": "feature" }),
        )
        .await;
    assert_eq!(code, 201);
    let (code, linked) = f
        .service
        .send(
            &format!("/api/threads/{}/pulls/refresh", f.thread),
            json!({}),
        )
        .await;
    assert_eq!(code, 200, "{linked}");
    assert_eq!(linked[0]["number"], 12);
}

#[tokio::test]
async fn forges_report_each_cli_and_bitbucket_says_why_not() {
    let f = fixture().await;
    let forges = f.service.json("/api/forges").await;
    let github = forges
        .as_array()
        .unwrap()
        .iter()
        .find(|forge| forge["id"] == "github")
        .unwrap();
    assert_eq!(github["installed"], true);
    assert_eq!(github["signed_in"], true);
    assert_eq!(github["accounts"][0], "octo");
    let bitbucket = forges
        .as_array()
        .unwrap()
        .iter()
        .find(|forge| forge["id"] == "bitbucket")
        .unwrap();
    assert!(bitbucket["program"].is_null());
    assert!(bitbucket["problem"].as_str().unwrap().contains("tokens"));
    f.hosted();
    run_git(
        &f.checkout,
        &["remote", "set-url", "origin", "git@bitbucket.org:o/r.git"],
    );
    let project = f.project().await;
    let response = f
        .service
        .get(&format!("/api/projects/{project}/pulls"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 422);
}

/// Stand-ins for the other CLIs: each logs its arguments and prints one record in
/// that tool's own JSON. They prove the routing and parsing, not the real flags.
const OTHER_CLIS: &[(&str, &str, &str)] = &[
    (
        "glab",
        "https://gitlab.com/o/r.git",
        r#"[{"iid":5,"title":"Lab","web_url":"u","state":"opened","source_branch":"h","target_branch":"main","author":{"username":"a"}}]"#,
    ),
    (
        "az",
        "https://dev.azure.com/o/p/_git/r",
        r#"[{"pullRequestId":5,"title":"Lab","status":"active","sourceRefName":"refs/heads/h","targetRefName":"refs/heads/main","createdBy":{"displayName":"a"}}]"#,
    ),
    (
        "tea",
        "https://codeberg.org/o/r.git",
        r#"[{"index":5,"title":"Lab","state":"open","head":"h","base":"main","poster":"a"}]"#,
    ),
];

#[tokio::test]
async fn gitlab_azure_and_forgejo_list_and_merge_through_their_own_clis() {
    let f = fixture().await;
    let dir = f
        .checkout
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap();
    let project = f.project().await;
    for (program, remote, reply) in OTHER_CLIS {
        let script = format!("#!/bin/sh\necho \"{program} $@\" >> \"$GH_LOG\"\necho '{reply}'\n");
        let path = dir.join("bin").join(program);
        std::fs::write(&path, script).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        run_git(&f.checkout, &["remote", "set-url", "origin", remote]);
        let pulls = f
            .service
            .json(&format!("/api/projects/{project}/pulls"))
            .await;
        assert_eq!(pulls[0]["number"], 5, "{program}: {pulls}");
        assert_eq!(pulls[0]["state"], "open", "{program}");
        assert_eq!(pulls[0]["head"], "h", "{program}");
        assert_eq!(pulls[0]["author"], "a", "{program}");
        let (code, body) = f
            .service
            .send(
                &format!("/api/projects/{project}/pulls/5/merge"),
                json!({ "method": "squash", "delete_branch": true }),
            )
            .await;
        assert_eq!(code, 202, "{program}: {body}");
    }
    let log = f.log();
    for expected in [
        "glab mr merge 5 --yes --squash --remove-source-branch",
        "az repos pr update --id 5 --detect true --status completed --squash true",
        "tea pulls merge --style squash 5",
    ] {
        assert!(log.contains(expected), "missing {expected}\n{log}");
    }
    // A forge with no route for this says so instead of guessing.
    let (code, body) = f
        .service
        .send(
            &format!("/api/projects/{project}/pulls/5/comments"),
            json!({ "body": "hi" }),
        )
        .await;
    assert_eq!((code, body["code"].as_str()), (422, Some("unsupported")));
}
