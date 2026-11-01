//! Selected metadata edits use the real service and preserve registration authority.
mod support;
use serde_json::{Value, json};
use std::path::Path;
use support::{Options, Service, TempDir, run_git};

async fn fixture() -> (TempDir, Service, Vec<Value>, Value) {
    let dir = TempDir::new();
    let service = Service::start(&dir.path().join("data"), Options::default());
    service.ensure_workspace(dir.path()).await;
    let mut projects = Vec::new();
    for name in ["one", "two", "other"] {
        let (status, project) = service
            .send("/api/projects/create", json!({"name":name}))
            .await;
        assert_eq!(status, 201, "{project}");
        if name != "other" {
            run_git(
                Path::new(project["path"].as_str().unwrap()),
                &["config", "remote.origin.url", "https://host/Owner/Repo.git"],
            );
        }
        projects.push(project);
    }
    let catalog = service
        .send("/api/settings/project-scopes", json!({}))
        .await
        .1;
    let group = catalog["groups"]
        .as_array()
        .unwrap()
        .iter()
        .find(|group| {
            group["members"]
                .as_array()
                .unwrap()
                .iter()
                .any(|m| m["project_id"] == projects[0]["id"])
        })
        .unwrap();
    let scope = json!({"selection":{"kind":"project_group","group_key":group["key"]}});
    (dir, service, projects, scope)
}

async fn request(service: &Service, scope: Value, members: &[Value], name: &str) -> Value {
    let (status, catalog) = service
        .send("/api/settings/project-scopes", scope.clone())
        .await;
    assert_eq!(status, 200, "{catalog}");
    let expected: serde_json::Map<_, _> = members
        .iter()
        .map(|p| (p["id"].as_str().unwrap().to_owned(), p["name"].clone()))
        .collect();
    json!({"scope":scope,"membership_version":catalog["version"],"expected_names":expected,"name":name})
}

async fn rename_one(service: &Service, id: &Value, name: &str) {
    let response = service
        .client
        .patch(format!(
            "{}/api/projects/{}",
            service.url,
            id.as_str().unwrap()
        ))
        .bearer_auth(&service.token)
        .json(&json!({"name":name}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
}

#[tokio::test]
async fn group_name_changes_only_selected_names_and_preserves_paths_trust_and_files() {
    let (_dir, service, projects, scope) = fixture().await;
    let long = format!("\u{feff} {} \u{feff}", "界🌿".repeat(150));
    let body = request(&service, scope.clone(), &projects[..2], &long).await;
    let (code, changed) = service.send("/api/settings/projects/rename", body).await;
    assert_eq!(code, 200, "{changed}");
    let rows = changed.as_array().unwrap();
    assert_eq!(rows.len(), 2);
    for before in &projects[..2] {
        let after = rows.iter().find(|p| p["id"] == before["id"]).unwrap();
        let mut expected = before.clone();
        expected["name"] = json!("界🌿".repeat(150));
        assert_eq!(after, &expected);
        assert!(Path::new(after["path"].as_str().unwrap()).is_dir());
    }
    let all = service.json("/api/projects").await;
    assert!(all.as_array().unwrap().contains(&projects[2]));
    let catalog = service
        .send("/api/settings/project-scopes", scope.clone())
        .await
        .1;
    let group = catalog["groups"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["key"] == scope["selection"]["group_key"])
        .unwrap();
    assert_eq!(group["label"], "界🌿".repeat(150));

    let checkout = json!({"selection":{"kind":"checkout","group_key":group["key"],"project_id":projects[0]["id"]}});
    let selected = rows
        .iter()
        .find(|p| p["id"] == projects[0]["id"])
        .unwrap()
        .clone();
    let body = request(&service, checkout, &[selected], "\u{0085}Kept\u{0085}").await;
    let (code, changed) = service.send("/api/settings/projects/rename", body).await;
    assert_eq!(code, 200, "{changed}");
    assert_eq!(
        changed[0]["name"], "\u{0085}Kept\u{0085}",
        "NEL is not JavaScript trim whitespace"
    );
    let all = service.json("/api/projects").await;
    assert_eq!(
        all.as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == projects[1]["id"])
            .unwrap()["name"],
        "界🌿".repeat(150)
    );
}

#[tokio::test]
async fn stale_names_membership_and_invalid_scopes_never_partially_rename() {
    let (_dir, service, projects, scope) = fixture().await;
    let original = request(&service, scope.clone(), &projects[..2], "New").await;
    rename_one(&service, &projects[1]["id"], "Concurrent").await;
    let (code, error) = service
        .send("/api/settings/projects/rename", original.clone())
        .await;
    assert_eq!(code, 409, "{error}");
    let all = service.json("/api/projects").await;
    assert!(all.as_array().unwrap().contains(&projects[0]));
    assert!(all.as_array().unwrap().contains(&projects[2]));
    let mut missing = original.clone();
    missing["expected_names"]
        .as_object_mut()
        .unwrap()
        .remove(projects[1]["id"].as_str().unwrap());
    assert_eq!(
        service
            .send("/api/settings/projects/rename", missing)
            .await
            .0,
        409
    );
    let mut unrelated = original.clone();
    unrelated["expected_names"][projects[2]["id"].as_str().unwrap()] = projects[2]["name"].clone();
    assert_eq!(
        service
            .send("/api/settings/projects/rename", unrelated)
            .await
            .0,
        409
    );
    let mut all_scope = original.clone();
    all_scope["scope"] = json!({});
    assert_eq!(
        service
            .send("/api/settings/projects/rename", all_scope)
            .await
            .0,
        409
    );
    let mut unavailable = original.clone();
    unavailable["scope"]["selection"]["group_key"] = json!("removed");
    assert_eq!(
        service
            .send("/api/settings/projects/rename", unavailable)
            .await
            .0,
        409
    );
    for blank in ["", " \t\n\u{feff}\u{3000}"] {
        let mut empty = original.clone();
        empty["name"] = json!(blank);
        assert_eq!(
            service.send("/api/settings/projects/rename", empty).await.0,
            400
        );
    }
    let mut oversized = original.clone();
    oversized["name"] = json!("x".repeat(2 * 1024 * 1024 + 1));
    assert_eq!(
        service
            .send("/api/settings/projects/rename", oversized)
            .await
            .0,
        400
    );
    assert!(
        service
            .json("/api/projects")
            .await
            .as_array()
            .unwrap()
            .contains(&projects[0])
    );
    let (code, _) = service
        .send("/api/projects/create", json!({"name":"new-member"}))
        .await;
    assert_eq!(code, 201);
    assert_eq!(
        service
            .send("/api/settings/projects/rename", original)
            .await
            .0,
        409
    );
}
