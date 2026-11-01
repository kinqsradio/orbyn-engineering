//! T3 project-file submodule values through the real daemon and local Git repos.
mod support;
use serde_json::json;
use std::path::Path;
use std::process::Command;
use support::{Options, Service, TempDir};

fn git(root: &Path, home: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args([
            "-c",
            "protocol.file.allow=always",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .current_dir(root)
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("GIT_CONFIG_GLOBAL", home.join("git-config"))
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "Fixture")
        .env("GIT_AUTHOR_EMAIL", "fixture@example.invalid")
        .env("GIT_COMMITTER_NAME", "Fixture")
        .env("GIT_COMMITTER_EMAIL", "fixture@example.invalid")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn repository(root: &Path, home: &Path, file: &str) {
    std::fs::create_dir_all(root).unwrap();
    git(
        root,
        home,
        &["init", "--quiet", "--template=", "--initial-branch=main"],
    );
    std::fs::write(root.join(file), "fixture\n").unwrap();
    git(root, home, &["add", "."]);
    git(root, home, &["commit", "--quiet", "-m", "fixture"]);
}

#[tokio::test]
async fn t3_file_values_control_actual_submodule_population_without_rewriting_the_file() {
    let dir = TempDir::new();
    let home = dir.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::write(home.join("git-config"), "").unwrap();
    let options = Options {
        env: vec![
            ("HOME".into(), home.to_string_lossy().into_owned()),
            ("USERPROFILE".into(), home.to_string_lossy().into_owned()),
            (
                "GIT_CONFIG_GLOBAL".into(),
                home.join("git-config").to_string_lossy().into_owned(),
            ),
            ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
            ("GIT_ALLOW_PROTOCOL".into(), "file".into()),
        ],
        ..Options::default()
    };
    let service = Service::start(&dir.path().join("data"), options);
    service.ensure_workspace(dir.path()).await;
    let (code, project) = service
        .send(
            "/api/projects/create",
            json!({"name":"submodules","readme":true}),
        )
        .await;
    assert_eq!(code, 201, "{project}");
    let id = project["id"].as_str().unwrap();
    let root = Path::new(project["path"].as_str().unwrap());
    let leaf = dir.path().join("leaf");
    let middle = dir.path().join("middle");
    repository(&leaf, &home, "leaf.txt");
    repository(&middle, &home, "middle.txt");
    git(
        &middle,
        &home,
        &["submodule", "add", leaf.to_str().unwrap(), "nested"],
    );
    git(
        &middle,
        &home,
        &["commit", "--quiet", "-am", "nested module"],
    );
    git(
        root,
        &home,
        &["submodule", "add", middle.to_str().unwrap(), "sub"],
    );
    git(root, &home, &["commit", "--quiet", "-am", "direct module"]);
    assert_eq!(
        service
            .send(&format!("/api/projects/{id}/trust"), json!({}))
            .await
            .0,
        200
    );
    for mode in ["none", "top-level", "recursive"] {
        let bytes = format!("{{\"worktreeSubmodules\":\"{mode}\"}}\n");
        std::fs::write(root.join("t3.json"), &bytes).unwrap();
        let views = service
            .json(&format!("/api/preferences?project_id={id}"))
            .await;
        let view = views
            .as_array()
            .unwrap()
            .iter()
            .find(|view| view["key"] == "worktree_submodules")
            .unwrap();
        assert_eq!(view["value"], mode, "file value must be accepted: {view}");
        assert_eq!(view["source"], "file");
        let (code, thread) = service
            .send(
                "/api/threads",
                json!({
                    "project_id":id,"engine":"codex","model":null,"title":null,
                    "worktree":format!("submodules-{mode}"),"skill_profile":null,
                }),
            )
            .await;
        assert_eq!(code, 201, "{thread}");
        let checkout = Path::new(thread["cwd"].as_str().unwrap());
        assert_eq!(
            checkout.join("sub/middle.txt").exists(),
            mode != "none",
            "{mode}: direct submodule"
        );
        assert_eq!(
            checkout.join("sub/nested/leaf.txt").exists(),
            mode == "recursive",
            "{mode}: nested submodule"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("t3.json")).unwrap(),
            bytes
        );
    }
    service.stop().await;
}
