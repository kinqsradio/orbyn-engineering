//! The local project catalog is a full-app read, never a settings mutation.
mod support;

use serde_json::{Value, json};
use std::path::Path;
use support::{Options, Service, TempDir, run_git};

#[tokio::test]
async fn local_scope_catalog_requires_app_access_and_never_returns_remote_credentials() {
    let dir = TempDir::new();
    let service = Service::start(&dir.path().join("data"), Options::default());
    service.ensure_workspace(dir.path()).await;
    let mut projects = Vec::new();
    for name in ["one", "two"] {
        let (code, project) = service
            .send(
                "/api/projects/create",
                json!({ "name": name, "readme": true }),
            )
            .await;
        assert_eq!(code, 201, "{project}");
        projects.push(project);
    }
    run_git(
        Path::new(projects[0]["path"].as_str().unwrap()),
        &[
            "config",
            "remote.origin.url",
            "https://user:PRIVATE-MARKER@host/Owner/Repo.git?token=PRIVATE-MARKER",
        ],
    );
    run_git(
        Path::new(projects[1]["path"].as_str().unwrap()),
        &["config", "remote.origin.url", "git@host:Owner/Repo.git"],
    );
    // This deliberately unauthorized fixture request verifies the app boundary.
    let denied = service
        .client
        .post(format!("{}/api/settings/project-scopes", service.url))
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), 401);
    let (code, catalog) = service
        .send("/api/settings/project-scopes", json!({}))
        .await;
    assert_eq!(code, 200, "{catalog}");
    assert_eq!(catalog["selection"]["kind"], "all_projects");
    assert_eq!(catalog["metadata_complete"], true);
    assert!(!catalog.to_string().contains("PRIVATE-MARKER"));
    assert!(!catalog.to_string().contains("https://"));
    let groups = catalog["groups"].as_array().unwrap();
    assert_eq!(
        groups
            .iter()
            .flat_map(|group| group["members"].as_array().unwrap())
            .count(),
        2
    );
    assert!(
        groups
            .iter()
            .flat_map(|group| group["members"].as_array().unwrap())
            .all(|member| member["path"].as_str() != dir.path().join("library").to_str())
    );
    let group = groups
        .iter()
        .find(|group| {
            group["members"]
                .as_array()
                .unwrap()
                .iter()
                .any(|member| member["project_id"] == projects[0]["id"])
        })
        .unwrap();
    assert_eq!(group["members"].as_array().unwrap().len(), 2);
    let query = json!({ "selection": { "kind": "project_group", "group_key": group["key"] } });
    let (code, selected) = service.send("/api/settings/project-scopes", query).await;
    assert_eq!(code, 200);
    assert_eq!(
        selected["selection"]["project_ids"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(selected["version"], catalog["version"]);
    let (code, stale) = service
        .send(
            "/api/settings/project-scopes",
            json!({ "selection": { "kind": "project_group", "group_key": "removed" } }),
        )
        .await;
    assert_eq!(code, 200);
    assert_eq!(stale["selection"]["kind"], "unavailable");
    for value in [
        Value::Null,
        json!({}),
        json!({ "kind": "all_projects", "project_id": "removed" }),
    ] {
        let (code, _) = service
            .send(
                "/api/settings/project-scopes",
                json!({ "selection": value }),
            )
            .await;
        assert_eq!(code, 400);
    }
    let (code, _) = service
        .send(
            "/api/settings/project-scopes",
            json!({ "recipe": { "overrides": [{ "project_id": "removed", "mode": "separate" }] } }),
        )
        .await;
    assert_eq!(code, 404);
    service.stop().await;
}
