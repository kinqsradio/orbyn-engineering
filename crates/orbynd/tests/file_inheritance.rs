//! The displayed inheritance and Core consumers use the same real file layer.
mod support;
use serde_json::{Value, json};
use support::{Options, Service, TempDir, setup};

fn row(views: &Value, key: &str) -> Value {
    views
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["key"] == key)
        .unwrap()
        .clone()
}
async fn set(service: &Service, project: Option<&str>, values: Value) -> Value {
    let path = project.map_or_else(
        || "/api/preferences".into(),
        |id| format!("/api/projects/{id}/preferences"),
    );
    let response = service
        .client
        .put(format!("{}{path}", service.url))
        .bearer_auth(&service.token)
        .json(&json!({"values":values}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    response.json().await.unwrap()
}

#[tokio::test]
async fn file_preferences_follow_project_environment_file_default_and_preserve_bytes() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    let thread = service.json(&format!("/api/threads/{thread}")).await;
    let project = thread["project_id"].as_str().unwrap();
    let root = std::path::Path::new(thread["cwd"].as_str().unwrap());
    let fallback = root.join("t3.json");
    let bytes = br#"{"defaultThreadEnvMode":"worktree","worktreeSubmodules":"skip"}"#;
    std::fs::write(&fallback, bytes).unwrap();
    let url = format!("/api/preferences?project_id={project}");
    for (key, value) in [
        ("default_thread_env_mode", "worktree"),
        ("worktree_submodules", "skip"),
    ] {
        let view = row(&service.json(&url).await, key);
        assert_eq!(view["source"], "file");
        assert_eq!(view["value"], value);
        assert_eq!(
            view["project_file"],
            json!({"path":"t3.json","value":value})
        );
    }
    set(
        &service,
        None,
        json!({"default_thread_env_mode":"local","worktree_submodules":"recursive"}),
    )
    .await;
    let views = service.json(&url).await;
    assert_eq!(row(&views, "worktree_submodules")["source"], "global");
    assert_eq!(row(&views, "worktree_submodules")["value"], "recursive");
    assert_eq!(
        row(&views, "worktree_submodules")["project_file"]["value"],
        "skip"
    );
    // Equal-to-default values still have an explicit override and can be reset.
    let views = set(
        &service,
        Some(project),
        json!({"default_thread_env_mode":"local","worktree_submodules":"recursive"}),
    )
    .await;
    assert_eq!(row(&views, "worktree_submodules")["source"], "project");
    let views = set(
        &service,
        Some(project),
        json!({"default_thread_env_mode":null,"worktree_submodules":null}),
    )
    .await;
    assert_eq!(row(&views, "worktree_submodules")["source"], "global");
    set(
        &service,
        None,
        json!({"default_thread_env_mode":null,"worktree_submodules":null}),
    )
    .await;
    assert_eq!(
        row(&service.json(&url).await, "worktree_submodules")["source"],
        "file"
    );
    assert_eq!(std::fs::read(&fallback).unwrap(), bytes);
    // The canonical own file wins over the compatibility filename.
    std::fs::write(
        root.join("orbyn.json"),
        br#"{"worktreeSubmodules":"top_level"}"#,
    )
    .unwrap();
    let views = service.json(&url).await;
    assert_eq!(row(&views, "worktree_submodules")["value"], "top_level");
    assert_eq!(
        row(&views, "worktree_submodules")["project_file"]["path"],
        "orbyn.json"
    );
    assert_eq!(row(&views, "default_thread_env_mode")["source"], "default");
    // Invalid enum rejects the whole own file, including its otherwise valid key.
    std::fs::write(
        root.join("orbyn.json"),
        br#"{"worktreeSubmodules":"unknown","defaultThreadEnvMode":"worktree"}"#,
    )
    .unwrap();
    let views = service.json(&url).await;
    assert_eq!(row(&views, "default_thread_env_mode")["source"], "default");
    assert_eq!(row(&views, "worktree_submodules")["value"], "recursive");
    assert!(
        row(&views, "worktree_submodules")
            .get("project_file")
            .is_none()
    );
    let view = service
        .json(&format!(
            "/api/threads/{}/scripts",
            thread["id"].as_str().unwrap()
        ))
        .await;
    assert!(
        view["problem"]
            .as_str()
            .unwrap()
            .contains("worktreeSubmodules")
    );
    service.stop().await;
}
