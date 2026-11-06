//! F66: a Jujutsu checkout with no Git of its own shows its working-copy change
//! and diff through the installed `jj`. A stand-in `jj` on PATH answers here, so
//! these tests prove what Orbyn asks and how it reads the answer, not jj itself.
mod support;

use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use support::{Options, Service, TempDir};

const STAND_IN: &str = r#"
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.JJ_STAND_IN_LOG, JSON.stringify({ cwd: process.cwd(), args }) + '\n');
if (args.includes('log')) {
  process.stdout.write('kxqpmzwt\n3f2a9c1b\nfeature,main\n0\nTeach the parser\n');
} else if (args.includes('diff')) {
  process.stdout.write([
    'diff --git a/src/parse.rs b/src/parse.rs',
    'index 1111111..2222222 100644',
    '--- a/src/parse.rs',
    '+++ b/src/parse.rs',
    '@@ -1 +1,2 @@',
    '-fn old() {}',
    '+fn new() {}',
    '+fn more() {}',
    'diff --git a/README.md b/README.md',
    'new file mode 100644',
    'index 0000000..3333333',
    '--- /dev/null',
    '+++ b/README.md',
    '@@ -0,0 +1 @@',
    '+# Notes',
    '',
  ].join('\n'));
} else {
  process.stderr.write('unexpected jj call');
  process.exit(2);
}
"#;

/// A bin folder with `jj` for Unix and `jj.cmd` for Windows, both running the
/// same Node script.
fn stand_in(dir: &Path) -> PathBuf {
    let bin = dir.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::write(bin.join("jj.cjs"), STAND_IN).unwrap();
    std::fs::write(bin.join("jj.cmd"), "@node \"%~dp0\\jj.cjs\" %*\r\n").unwrap();
    let unix = bin.join("jj");
    std::fs::write(
        &unix,
        "#!/bin/sh\nexec node \"$(dirname \"$0\")/jj.cjs\" \"$@\"\n",
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&unix, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    bin
}

fn options(dir: &TempDir, bin: Option<&Path>) -> Options {
    let path = std::env::var_os("PATH").unwrap_or_default();
    let path = match bin {
        Some(bin) => std::env::join_paths(
            std::iter::once(bin.to_path_buf()).chain(std::env::split_paths(&path)),
        )
        .unwrap(),
        None => path,
    };
    Options {
        env: vec![
            ("HOME".into(), dir.path().to_string_lossy().into_owned()),
            ("PATH".into(), path.to_string_lossy().into_owned()),
            (
                "JJ_STAND_IN_LOG".into(),
                dir.path().join("jj.ndjson").to_string_lossy().into_owned(),
            ),
        ],
        ..Options::default()
    }
}

/// A trusted project registered in place on a jj-only folder, and a thread on it.
async fn jj_thread(service: &Service, dir: &TempDir) -> (String, PathBuf) {
    let repo = dir.path().join("jj-repo");
    std::fs::create_dir_all(repo.join(".jj/repo")).unwrap();
    std::fs::create_dir_all(repo.join("src")).unwrap();
    service.ensure_workspace(dir.path()).await;
    let (status, project) = service
        .send("/api/projects/add", json!({ "path": repo }))
        .await;
    assert_eq!(status, 201, "{project}");
    assert_eq!(project["is_git"], false);
    let id = project["id"].as_str().unwrap().to_owned();
    let (status, _) = service
        .send(&format!("/api/projects/{id}/trust"), json!({}))
        .await;
    assert_eq!(status, 200);
    (service.thread(&id, "codex").await, repo)
}

fn calls(dir: &TempDir) -> Vec<Value> {
    std::fs::read_to_string(dir.path().join("jj.ndjson"))
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[tokio::test]
async fn a_jj_checkout_reports_its_change_and_diff_through_the_installed_jj() {
    let dir = TempDir::new();
    let bin = stand_in(dir.path());
    let service = Service::start(&dir.path().join("data"), options(&dir, Some(&bin)));
    let (thread, repo) = jj_thread(&service, &dir).await;

    let status = service.json(&format!("/api/threads/{thread}/jj")).await;
    assert_eq!(status["change_id"], "kxqpmzwt");
    assert_eq!(status["commit_id"], "3f2a9c1b");
    assert_eq!(status["bookmarks"], json!(["feature", "main"]));
    assert_eq!(status["description"], "Teach the parser");
    assert_eq!(status["conflict"], false);
    assert_eq!(status["changed_files"], 2);
    assert_eq!(status["additions"], 3);
    assert_eq!(status["deletions"], 1);

    let files = service.json(&format!("/api/threads/{thread}/diff")).await;
    let files = files.as_array().unwrap();
    let summary: Vec<_> = files
        .iter()
        .map(|file| (file["path"].clone(), file["status"].clone()))
        .collect();
    assert_eq!(
        summary,
        vec![
            (json!("README.md"), json!("added")),
            (json!("src/parse.rs"), json!("modified")),
        ]
    );
    assert!(
        files[1]["patch"]
            .as_str()
            .unwrap()
            .contains("+fn more() {}")
    );

    let seen = calls(&dir);
    assert!(!seen.is_empty());
    let root = support::canonical(&repo);
    for call in &seen {
        let args: Vec<&str> = call["args"]
            .as_array()
            .unwrap()
            .iter()
            .map(|arg| arg.as_str().unwrap())
            .collect();
        assert_eq!(support::canonical(call["cwd"].as_str().unwrap()), root);
        assert!(args.starts_with(&[
            "--no-pager",
            "--color",
            "never",
            "--config",
            "fsmonitor.backend=none"
        ]));
        if args.contains(&"diff") {
            assert!(
                args.contains(&"--git"),
                "built-in Git format only: {args:?}"
            );
        }
    }
    service.stop().await;
}

#[tokio::test]
async fn a_plain_folder_is_not_a_jj_checkout_and_runs_no_jj() {
    let dir = TempDir::new();
    let bin = stand_in(dir.path());
    let service = Service::start(&dir.path().join("data"), options(&dir, Some(&bin)));
    let folder = dir.path().join("plain");
    std::fs::create_dir_all(&folder).unwrap();
    service.ensure_workspace(dir.path()).await;
    let (status, project) = service
        .send("/api/projects/add", json!({ "path": folder }))
        .await;
    assert_eq!(status, 201, "{project}");
    let id = project["id"].as_str().unwrap();
    service
        .send(&format!("/api/projects/{id}/trust"), json!({}))
        .await;
    let thread = service.thread(id, "codex").await;
    assert_eq!(
        service.json(&format!("/api/threads/{thread}/jj")).await,
        Value::Null
    );
    assert_eq!(
        service.json(&format!("/api/threads/{thread}/diff")).await,
        json!([])
    );
    assert!(calls(&dir).is_empty());
    service.stop().await;
}

#[tokio::test]
async fn without_an_installed_jj_the_checkout_is_unsupported() {
    if std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .any(|dir| dir.join("jj").is_file() || dir.join("jj.exe").is_file())
    {
        // A machine with a real jj cannot show the missing case.
        return;
    }
    let dir = TempDir::new();
    let service = Service::start(&dir.path().join("data"), options(&dir, None));
    let (thread, _) = jj_thread(&service, &dir).await;
    let response = service
        .get(&format!("/api/threads/{thread}/jj"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 422);
    let body: Value = response.json().await.unwrap();
    assert!(body.to_string().contains("jj is not installed"), "{body}");
    service.stop().await;
}
