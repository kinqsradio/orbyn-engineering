//! Real Git worktree cleanup honors project policy without granting force removal.
mod support;
use serde_json::{Value, json};
use std::path::PathBuf;
use support::{Options, Service, TempDir, setup};

async fn put(service: &Service, project: Option<&str>, value: Value) -> u16 {
    let path = project.map_or_else(
        || "/api/preferences".into(),
        |id| format!("/api/projects/{id}/preferences"),
    );
    service
        .client
        .put(format!("{}{path}", service.url))
        .bearer_auth(&service.token)
        .json(&json!({"values":value}))
        .send()
        .await
        .unwrap()
        .status()
        .as_u16()
}
async fn tree(service: &Service, project: &str, name: &str) -> (String, PathBuf) {
    let projects = service.json("/api/projects").await;
    let root = projects
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == project)
        .unwrap()["path"]
        .as_str()
        .unwrap();
    let root = std::path::Path::new(root);
    support::run_git(root, &["add", "."]);
    support::run_git(
        root,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "commit",
            "--allow-empty",
            "-qm",
            "Fixture",
        ],
    );
    let (code, made) = service
        .send(
            "/api/threads",
            json!({"project_id":project,"engine":"codex","worktree":name}),
        )
        .await;
    assert_eq!(code, 201, "{made}");
    let id = made["id"].as_str().unwrap().to_owned();
    assert_eq!(service.patch(&id, json!({"settled":true})).await.0, 200);
    (id, PathBuf::from(made["cwd"].as_str().unwrap()))
}
async fn clean(service: &Service) -> Value {
    let (code, report) = service.send("/api/storage/cleanup", json!({})).await;
    assert_eq!(code, 200, "{report}");
    report
}

#[tokio::test]
async fn project_off_custom_and_inherit_control_actual_worktree_removal() {
    let dir = TempDir::new();
    let (service, base) = setup(&dir, Options::default(), "codex").await;
    let thread = service.json(&format!("/api/threads/{base}")).await;
    let project = thread["project_id"].as_str().unwrap();
    assert_eq!(
        put(
            &service,
            None,
            json!({"storage_cleanup":{"worktree_settled_after_days":0}})
        )
        .await,
        200
    );
    let (_, path) = tree(&service, project, "project-policy").await;
    assert_eq!(
        put(
            &service,
            Some(project),
            json!({"worktree_cleanup":{"mode":"off"}})
        )
        .await,
        200
    );
    clean(&service).await;
    assert!(path.exists());
    assert_eq!(
        put(
            &service,
            Some(project),
            json!({"worktree_cleanup":{"mode":"custom","rules":{}}})
        )
        .await,
        200
    );
    clean(&service).await;
    assert!(
        path.exists(),
        "custom empty rules are Off, not global fallback"
    );
    assert_eq!(
        put(
            &service,
            Some(project),
            json!({"worktree_cleanup":{"mode":"custom","rules":{"settled_after_days":0}}})
        )
        .await,
        200
    );
    clean(&service).await;
    assert!(!path.exists());
    let (_, path) = tree(&service, project, "inherited-policy").await;
    assert_eq!(
        put(&service, Some(project), json!({"worktree_cleanup":null})).await,
        200
    );
    clean(&service).await;
    assert!(!path.exists());
    service.stop().await;
}

#[tokio::test]
async fn empty_project_policy_inherits_environment_off_and_legacy_project_rules_are_ignored() {
    let dir = TempDir::new();
    let (service, base) = setup(&dir, Options::default(), "codex").await;
    let thread = service.json(&format!("/api/threads/{base}")).await;
    let project = thread["project_id"].as_str().unwrap();
    let (_, path) = tree(&service, project, "legacy-policy").await;
    assert_eq!(put(&service,None,json!({"storage_cleanup":{"worktree_settled_after_days":0},"worktree_cleanup":{"mode":"off"}})).await,200);
    assert_eq!(
        put(
            &service,
            Some(project),
            json!({"worktree_cleanup":{},"storage_cleanup":{"worktree_settled_after_days":0}})
        )
        .await,
        200
    );
    clean(&service).await;
    assert!(path.exists());
    assert_eq!(
        put(
            &service,
            None,
            json!({"storage_cleanup":{},"worktree_cleanup":{}})
        )
        .await,
        200
    );
    clean(&service).await;
    assert!(
        path.exists(),
        "legacy project storage_cleanup never enables worktree cleanup"
    );
    service.stop().await;
}

#[tokio::test]
async fn another_projects_live_subfolder_and_dirty_files_prevent_removal() {
    let dir = TempDir::new();
    let (service, base) = setup(&dir, Options::default(), "codex").await;
    let thread = service.json(&format!("/api/threads/{base}")).await;
    let project = thread["project_id"].as_str().unwrap();
    let (_, path) = tree(&service, project, "shared-policy").await;
    assert_eq!(
        put(
            &service,
            Some(project),
            json!({"worktree_cleanup":{"mode":"custom","rules":{"settled_after_days":0}}})
        )
        .await,
        200
    );
    let child = path.join("selected");
    std::fs::create_dir_all(&child).unwrap();
    let (code, added) = service
        .send("/api/projects/add", json!({"path":child}))
        .await;
    assert_eq!(code, 201, "{added}");
    let other = added["id"].as_str().unwrap();
    assert_eq!(
        service
            .send(&format!("/api/projects/{other}/trust"), json!({}))
            .await
            .0,
        200
    );
    let live = service.thread(other, "codex").await;
    let report = clean(&service).await;
    assert!(path.exists());
    assert_eq!(
        report["entries"][0]["reason"],
        "Another active thread uses it"
    );
    assert_eq!(service.patch(&live, json!({"settled":true})).await.0, 200);
    std::fs::write(path.join("unsaved.txt"), "keep").unwrap();
    clean(&service).await;
    assert!(path.exists());
    std::fs::remove_file(path.join("unsaved.txt")).unwrap();
    clean(&service).await;
    assert!(!path.exists());
    service.stop().await;
}

#[tokio::test]
async fn known_policy_shapes_reject_invalid_values_without_replacing_a_valid_policy() {
    let dir = TempDir::new();
    let (service, base) = setup(&dir, Options::default(), "codex").await;
    let thread = service.json(&format!("/api/threads/{base}")).await;
    let project = thread["project_id"].as_str().unwrap();
    assert_eq!(
        put(
            &service,
            Some(project),
            json!({"worktree_cleanup":{"mode":"off","future":17}})
        )
        .await,
        200
    );
    for bad in [
        json!({"mode":"inherit"}),
        json!({"mode":"custom"}),
        json!({"rules":{}}),
        json!({"mode":"off","rules":[]}),
        json!({"mode":"custom","rules":{"settled_after_days":-1}}),
        json!({"mode":"custom","rules":{"settled_after_days":0.5}}),
        json!({"mode":"custom","rules":{"settled_after_days":3651}}),
    ] {
        assert_eq!(
            put(&service, Some(project), json!({"worktree_cleanup":bad})).await,
            400
        );
    }
    let prefs = service
        .json(&format!("/api/preferences?project_id={project}"))
        .await;
    assert_eq!(
        prefs
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["key"] == "worktree_cleanup")
            .unwrap()["value"],
        json!({"mode":"off","future":17})
    );
    service.stop().await;
}

#[tokio::test]
async fn mixed_group_nested_rule_patches_preserve_each_members_forward_fields_and_fence_stale_edits()
 {
    let dir = TempDir::new();
    let (service, base) = setup(&dir, Options::default(), "codex").await;
    let first = service.json(&format!("/api/threads/{base}")).await;
    let first = service
        .json("/api/projects")
        .await
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == first["project_id"])
        .unwrap()
        .clone();
    let (code, second) = service
        .send("/api/projects/create", json!({"name":"second"}))
        .await;
    assert_eq!(code, 201);
    for (index, project) in [&first, &second].iter().enumerate() {
        support::run_git(
            std::path::Path::new(project["path"].as_str().unwrap()),
            &[
                "config",
                "remote.origin.url",
                "https://example.test/group/repo.git",
            ],
        );
        assert_eq!(put(&service,project["id"].as_str(),json!({"worktree_cleanup":{"mode":"custom","future":index,"rules":{"settled_after_days":8,"future_rule":index}}})).await,200);
    }
    let catalog = service
        .send("/api/settings/project-scopes", json!({}))
        .await
        .1;
    let group = catalog["groups"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| {
            g["members"]
                .as_array()
                .unwrap()
                .iter()
                .any(|m| m["project_id"] == first["id"])
        })
        .unwrap();
    let scope = json!({"selection":{"kind":"project_group","group_key":group["key"]}});
    let (code, query) = service
        .send(
            "/api/settings/preferences/query",
            json!({"scope":scope,"keys":["worktree_cleanup"]}),
        )
        .await;
    assert_eq!(code, 200, "{query}");
    let revision = query["rows"][0]["revision"].clone();
    let body = json!({"scope":scope,"membership_version":query["catalog"]["version"],"if_match":{"worktree_cleanup":revision},"edits":{"worktree_cleanup":{"op":"set","value":{"rules":{"settled_after_days":0}}}}});
    let request = || {
        service
            .client
            .put(format!("{}/api/settings/preferences", service.url))
            .bearer_auth(&service.token)
            .json(&body)
    };
    let response = request().send().await.unwrap();
    assert_eq!(
        response.status().as_u16(),
        200,
        "{}",
        response.text().await.unwrap()
    );
    assert_eq!(request().send().await.unwrap().status().as_u16(), 409);
    for (index, project) in [&first, &second].iter().enumerate() {
        let prefs = service
            .json(&format!(
                "/api/preferences?project_id={}",
                project["id"].as_str().unwrap()
            ))
            .await;
        let value = &prefs
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["key"] == "worktree_cleanup")
            .unwrap()["value"];
        assert_eq!(
            *value,
            json!({"mode":"custom","future":index,"rules":{"settled_after_days":0,"future_rule":index}})
        );
    }
    service.stop().await;
}
