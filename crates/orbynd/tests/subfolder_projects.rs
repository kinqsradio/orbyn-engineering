//! Selected local project scopes retain their folder independently of Git roots.
mod support;

use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use support::{Options, Service, TempDir, canonical, run_git};

async fn fixture(dir: &TempDir) -> (Service, PathBuf, PathBuf) {
    let service = Service::start(&dir.path().join("data"), Options::default());
    service.ensure_workspace(dir.path()).await;
    let repo = dir.path().join("repository");
    let child = repo.join("packages/web");
    std::fs::create_dir_all(&child).unwrap();
    std::fs::create_dir_all(repo.join("packages/api")).unwrap();
    std::fs::write(repo.join("README.md"), "parent-original\n").unwrap();
    std::fs::write(child.join("kept.txt"), "child-original\n").unwrap();
    std::fs::write(repo.join("packages/api/other.txt"), "sibling-original\n").unwrap();
    std::fs::write(
        repo.join("orbyn.json"),
        r#"{"scripts":[{"name":"Parent action","command":"echo parent"}]}"#,
    )
    .unwrap();
    std::fs::write(
        child.join("orbyn.json"),
        r#"{"scripts":[{"name":"Child action","command":"echo child-scope> child-output.txt"}]}"#,
    )
    .unwrap();
    run_git(&repo, &["init", "-q", "-b", "main"]);
    run_git(
        &repo,
        &[
            "config",
            "remote.origin.url",
            "https://example.test/team/project.git",
        ],
    );
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
            "Fixture",
        ],
    );
    (service, canonical(&repo), canonical(&child))
}

async fn add(service: &Service, path: &Path) -> Value {
    let (code, project) = service
        .send("/api/projects/add", json!({"path":path}))
        .await;
    assert_eq!(code, 201, "{project}");
    project
}
async fn trust(service: &Service, project: &Value) {
    assert_eq!(
        service
            .send(
                &format!("/api/projects/{}/trust", project["id"].as_str().unwrap()),
                json!({})
            )
            .await
            .0,
        200
    );
}
async fn thread(service: &Service, project: &Value, worktree: Option<&str>) -> Value {
    let (code, thread) = service.send("/api/threads", json!({"project_id":project["id"],"engine":"codex","title":"Selected folder", "worktree":worktree})).await;
    assert_eq!(code, 201, "{thread}");
    thread
}

#[tokio::test]
async fn selected_folder_identity_trust_settings_and_files_stay_local() {
    let dir = TempDir::new();
    let (service, repo, child) = fixture(&dir).await;
    let project = add(&service, &child).await;
    assert_eq!(project["path"], child.to_string_lossy().as_ref());
    assert_eq!(project["name"], "web");
    assert_eq!(project["is_git"], true);
    assert_eq!(project["trusted"], false);
    let parent = add(&service, &repo).await;
    assert_ne!(parent["id"], project["id"]);
    trust(&service, &parent).await;
    assert_eq!(
        service
            .send("/api/projects/add", json!({"path":child.join(".")}))
            .await
            .0,
        409
    );
    let projects = service.json("/api/projects").await;
    assert_eq!(
        projects
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["id"] == project["id"])
            .unwrap()["trusted"],
        false
    );
    let local = thread(&service, &project, None).await;
    assert_eq!(local["cwd"], child.to_string_lossy().as_ref());
    let base = format!("/api/threads/{}", local["id"].as_str().unwrap());
    let scripts = service.json(&format!("{base}/scripts")).await;
    assert_eq!(scripts["scripts"][0]["name"], "Child action");
    assert_eq!(
        service
            .send(&format!("{base}/scripts"), json!({"name":"Child action"}))
            .await
            .0,
        403
    );
    trust(&service, &project).await;
    assert_eq!(
        service
            .json(&format!("{base}/files/content?path=kept.txt"))
            .await["content"],
        "child-original\n"
    );
    assert!(
        !service
            .get(&format!("{base}/files/content?path=../../README.md"))
            .send()
            .await
            .unwrap()
            .status()
            .is_success()
    );
    assert_eq!(
        service
            .send(&format!("{base}/scripts"), json!({"name":"Child action"}))
            .await
            .0,
        201
    );
    tokio::time::timeout(std::time::Duration::from_secs(45), async {
        while !child.join("child-output.txt").exists() {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(!repo.join("child-output.txt").exists());
    assert_eq!(
        std::fs::read_to_string(repo.join("README.md")).unwrap(),
        "parent-original\n"
    );
    let separate = service
        .send(
            "/api/settings/project-scopes",
            json!({"recipe":{"mode":"repository_path"}}),
        )
        .await
        .1;
    let groups = separate["groups"].as_array().unwrap();
    let child_group = groups
        .iter()
        .find(|group| {
            group["members"]
                .as_array()
                .unwrap()
                .iter()
                .any(|member| member["project_id"] == project["id"])
        })
        .unwrap();
    assert_eq!(
        child_group["members"][0]["repository_relative_path"],
        "packages/web"
    );
    assert!(
        !child_group["members"]
            .as_array()
            .unwrap()
            .iter()
            .any(|member| member["project_id"] == parent["id"])
    );
    let together = service
        .send("/api/settings/project-scopes", json!({}))
        .await
        .1;
    assert!(together["groups"].as_array().unwrap().iter().any(|group| {
        let members = group["members"].as_array().unwrap();
        members
            .iter()
            .any(|member| member["project_id"] == project["id"])
            && members
                .iter()
                .any(|member| member["project_id"] == parent["id"])
    }));
    service.stop().await;
}

#[tokio::test]
async fn subfolder_worktree_threads_use_the_primary_sibling_and_the_whole_new_checkout() {
    let dir = TempDir::new();
    let (service, repo, child) = fixture(&dir).await;
    let project = add(&service, &child).await;
    trust(&service, &project).await;
    let first = thread(&service, &project, Some("first-child")).await;
    let first_root = canonical(repo.with_file_name("repository-wt").join("first-child"));
    assert_eq!(first["cwd"], first_root.to_string_lossy().as_ref());
    assert_eq!(first["worktree"]["path"], first["cwd"]);
    let scripts = service
        .json(&format!(
            "/api/threads/{}/scripts",
            first["id"].as_str().unwrap()
        ))
        .await;
    assert_eq!(scripts["scripts"][0]["name"], "Parent action");
    let linked_child = add(&service, &first_root.join("packages/web")).await;
    assert_eq!(linked_child["trusted"], false);
    trust(&service, &linked_child).await;
    let second = thread(&service, &linked_child, Some("second-child")).await;
    let expected = canonical(repo.with_file_name("repository-wt").join("second-child"));
    assert_eq!(second["cwd"], expected.to_string_lossy().as_ref());
    assert!(!repo.join("packages/web-wt").exists());
    assert!(!first_root.with_file_name("first-child-wt").exists());
    service.stop().await;
}

#[tokio::test]
async fn navigation_coordinates_do_not_expand_the_selected_file_scope() {
    let dir = TempDir::new();
    let (service, repo, child) = fixture(&dir).await;
    let project = add(&service, &child).await;
    trust(&service, &project).await;
    let local = thread(&service, &project, None).await;
    let base = format!("/api/threads/{}", local["id"].as_str().unwrap());
    let resolve = |path: &str, basis: &str| json!({"cwd":local["cwd"],"path":path,"basis":basis});
    for path in [
        "kept.txt".to_owned(),
        "packages/web/kept.txt".to_owned(),
        child.join("kept.txt").to_string_lossy().into_owned(),
    ] {
        let (code, resolved) = service
            .send(&format!("{base}/paths/resolve"), resolve(&path, "thread"))
            .await;
        assert_eq!(code, 200, "{resolved}");
        assert_eq!(resolved["checkout_path"], "kept.txt");
        assert_eq!(resolved["repository_path"], "packages/web/kept.txt");
    }
    // T3 prefers the stripped workspace match even if a literal repeated tree exists.
    std::fs::create_dir_all(child.join("packages/web")).unwrap();
    std::fs::write(child.join("packages/web/kept.txt"), "literal-duplicate").unwrap();
    let resolved = service
        .send(
            &format!("{base}/paths/resolve"),
            resolve("packages/web/kept.txt", "thread"),
        )
        .await
        .1;
    assert_eq!(resolved["checkout_path"], "kept.txt");
    for path in [
        "README.md",
        "packages/api/other.txt",
        "packages/web/deleted.txt",
    ] {
        let (code, resolved) = service
            .send(
                &format!("{base}/paths/resolve"),
                resolve(path, "repository"),
            )
            .await;
        assert_eq!(code, 200, "{resolved}");
        assert!(resolved["checkout_path"].is_null());
        assert_eq!(resolved["repository_path"], path);
    }
    let stale = service
        .send(
            &format!("{base}/paths/resolve"),
            json!({"cwd":repo,"path":"kept.txt","basis":"thread"}),
        )
        .await;
    assert_ne!(stale.0, 200);
    let metadata = service
        .send(
            &format!("{base}/paths/resolve"),
            resolve(".git/config", "repository"),
        )
        .await
        .1;
    assert!(metadata["checkout_path"].is_null() && metadata["repository_path"].is_null());
    std::fs::write(child.join("kept.txt"), "child-diff-result\n").unwrap();
    std::fs::write(repo.join("README.md"), "parent-diff-result\n").unwrap();
    let diffs = service.json(&format!("{base}/diff")).await;
    for (path, marker) in [
        ("packages/web/kept.txt", "child-diff-result"),
        ("README.md", "parent-diff-result"),
    ] {
        let diff = diffs
            .as_array()
            .unwrap()
            .iter()
            .find(|file| file["path"] == path)
            .unwrap();
        assert!(diff["patch"].as_str().unwrap().contains(marker));
    }
    assert!(
        !service
            .get(&format!("{base}/files/content?path=README.md"))
            .send()
            .await
            .unwrap()
            .status()
            .is_success()
    );
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(repo.join("README.md"), child.join("escape.txt")).unwrap();
        let resolved = service
            .send(
                &format!("{base}/paths/resolve"),
                resolve("escape.txt", "thread"),
            )
            .await
            .1;
        assert!(resolved["checkout_path"].is_null());
    }
    service.stop().await;
}
