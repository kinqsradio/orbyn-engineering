//! Project removal must delete a thread family once, regardless of list order.
mod support;

use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::path::Path;
use support::{Options, Service, TempDir};

async fn project(service: &Service, name: &str) -> Value {
    let (status, project) = service
        .send("/api/projects/create", json!({ "name": name }))
        .await;
    assert_eq!(status, 201, "{project}");
    project
}

async fn fork(service: &Service, parent: &str, side: bool) -> String {
    let (status, thread) = service
        .send(
            &format!("/api/threads/{parent}/fork"),
            json!({ "side": side }),
        )
        .await;
    assert_eq!(status, 201, "{thread}");
    assert_eq!(thread["lifecycle"]["parent_thread_id"], parent);
    thread["id"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn removing_a_project_with_a_pinned_parent_deletes_each_family_once_and_keeps_peers() {
    let dir = TempDir::new();
    let service = Service::start(&dir.path().join("data"), Options::default());
    service.ensure_workspace(dir.path()).await;
    let removed = project(&service, "family-removal").await;
    let removed_id = removed["id"].as_str().unwrap();
    let root = Path::new(removed["path"].as_str().unwrap());
    std::fs::write(root.join("keep.txt"), "project files stay").unwrap();
    let parent = service.thread(removed_id, "codex").await;
    let child = fork(&service, &parent, true).await;
    let grandchild = fork(&service, &child, false).await;
    assert_eq!(
        service
            .patch(&grandchild, json!({ "archived": true }))
            .await
            .0,
        200
    );
    assert_eq!(
        service.patch(&parent, json!({ "pinned": true })).await.0,
        200
    );

    let live = service
        .json(&format!("/api/threads?project_id={removed_id}"))
        .await;
    let archived = service
        .json(&format!(
            "/api/threads?project_id={removed_id}&archived=true"
        ))
        .await;
    assert_eq!(live[0]["id"], parent, "parent must precede its descendants");
    let counted: BTreeSet<_> = live
        .as_array()
        .unwrap()
        .iter()
        .chain(archived.as_array().unwrap())
        .map(|thread| thread["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        counted,
        BTreeSet::from([parent.as_str(), child.as_str(), grandchild.as_str()])
    );

    let peer = project(&service, "unrelated-peer").await;
    let peer_id = peer["id"].as_str().unwrap();
    let peer_thread = service.thread(peer_id, "codex").await;
    let response = service
        .client
        .delete(format!(
            "{}/api/projects/{removed_id}?delete_files=false",
            service.url
        ))
        .bearer_auth(&service.token)
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    let body: Value = response.json().await.unwrap();
    let projects = service.json("/api/projects").await;
    let mut family_statuses = Vec::new();
    for id in [&parent, &child, &grandchild] {
        family_statuses.push(
            service
                .get(&format!("/api/threads/{id}"))
                .send()
                .await
                .unwrap()
                .status()
                .as_u16(),
        );
    }
    assert_eq!(
        status, 200,
        "one file-preserving removal must succeed; body={body}; family HTTP statuses={family_statuses:?}; projects={projects}"
    );
    assert_eq!(family_statuses, [404, 404, 404]);
    assert!(
        !projects
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["id"] == removed_id)
    );
    assert!(
        projects
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["id"] == peer_id)
    );
    assert_eq!(
        service.json(&format!("/api/threads/{peer_thread}")).await["project_id"],
        peer_id
    );
    assert_eq!(
        std::fs::read_to_string(root.join("keep.txt")).unwrap(),
        "project files stay"
    );
    assert!(Path::new(peer["path"].as_str().unwrap()).is_dir());
}

#[tokio::test]
async fn an_active_child_still_prevents_any_project_family_deletion() {
    let dir = TempDir::new();
    let service = Service::start(&dir.path().join("data"), Options::default());
    service.ensure_workspace(dir.path()).await;
    let project = project(&service, "busy-family").await;
    let id = project["id"].as_str().unwrap();
    let root = Path::new(project["path"].as_str().unwrap());
    std::fs::write(root.join("keep.txt"), "busy files stay").unwrap();
    let (status, body) = service
        .send(&format!("/api/projects/{id}/trust"), json!({}))
        .await;
    assert_eq!(status, 200, "{body}");
    let parent = service.thread(id, "codex").await;
    let child = fork(&service, &parent, true).await;
    assert_eq!(
        service.patch(&parent, json!({ "pinned": true })).await.0,
        200
    );
    let run = service.admit(&child, "[hang]").await;
    let active = service.json(&format!("/api/threads/{child}")).await;
    let response = service
        .client
        .delete(format!(
            "{}/api/projects/{id}?delete_files=false",
            service.url
        ))
        .bearer_auth(&service.token)
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    let body: Value = response.json().await.unwrap();
    let parent_status = service
        .get(&format!("/api/threads/{parent}"))
        .send()
        .await
        .unwrap()
        .status();
    let child_status = service
        .get(&format!("/api/threads/{child}"))
        .send()
        .await
        .unwrap()
        .status();
    let projects = service.json("/api/projects").await;
    // Release the owned protocol-double run before checking the rejection.
    let (cancel_status, cancel) = service
        .send(&format!("/api/runs/{run}/cancel"), json!({}))
        .await;
    assert!(cancel_status < 300, "{cancel}");
    assert_eq!(service.finished(&child).await, "cancelled");
    assert_eq!(active["active_run"]["id"], run);
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["code"], "thread_busy");
    assert_eq!(parent_status.as_u16(), 200);
    assert_eq!(child_status.as_u16(), 200);
    assert!(
        projects
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["id"] == id)
    );
    assert_eq!(
        std::fs::read_to_string(root.join("keep.txt")).unwrap(),
        "busy files stay"
    );
}
