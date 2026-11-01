//! Fixed project configuration reads through the real service in disposable roots.
mod support;
use serde_json::{Value, json};
use std::path::Path;
use support::{Options, Service, TempDir};

async fn workspace_preference(service: &Service, scope: &Value) -> Value {
    let (status, response) = service
        .send(
            "/api/settings/preferences/query",
            json!({
                "scope":scope,"keys":["default_thread_env_mode"]
            }),
        )
        .await;
    assert_eq!(status, 200, "{response}");
    response["rows"][0]["members"][0]["view"].clone()
}

#[tokio::test]
async fn scoped_settings_read_only_direct_bounded_project_files() {
    let dir = TempDir::new();
    let service = Service::start(&dir.path().join("data"), Options::default());
    service.ensure_workspace(dir.path()).await;
    let (status, project) = service
        .send(
            "/api/projects/create",
            json!({"name":"file-boundary","readme":true}),
        )
        .await;
    assert_eq!(status, 201, "{project}");
    let root = Path::new(project["path"].as_str().unwrap());
    let (_, catalog) = service
        .send("/api/settings/project-scopes", json!({}))
        .await;
    let group = catalog["groups"]
        .as_array()
        .unwrap()
        .iter()
        .find(|group| {
            group["members"]
                .as_array()
                .unwrap()
                .iter()
                .any(|member| member["project_id"] == project["id"])
        })
        .unwrap();
    let scope = json!({"selection":{"kind":"checkout","group_key":group["key"],"project_id":project["id"]}});
    let text = r#"{"defaultThreadEnvMode":"worktree","unknownField":{"kept":true}}"#;
    std::fs::write(root.join("t3.json"), text).unwrap();
    std::fs::create_dir(root.join("orbyn.json")).unwrap();
    let view = workspace_preference(&service, &scope).await;
    assert_eq!(view["value"], "worktree");
    assert_eq!(view["project_file"]["path"], "t3.json");
    std::fs::remove_dir(root.join("orbyn.json")).unwrap();
    std::fs::write(root.join("orbyn.json"), vec![b' '; 256 * 1024 + 1]).unwrap();
    let view = workspace_preference(&service, &scope).await;
    assert!(
        view.get("project_file").is_none(),
        "oversized first file cannot expose fallback: {view}"
    );
    std::fs::remove_file(root.join("orbyn.json")).unwrap();
    #[cfg(unix)]
    for target in [
        dir.path().join("outside.json"),
        root.join("alias-target.json"),
    ] {
        std::fs::write(&target, text).unwrap();
        std::os::unix::fs::symlink(&target, root.join("orbyn.json")).unwrap();
        let view = workspace_preference(&service, &scope).await;
        assert!(
            view.get("project_file").is_none(),
            "aliased configuration cannot supply defaults: {view}"
        );
        assert_eq!(std::fs::read_to_string(&target).unwrap(), text);
        std::fs::remove_file(root.join("orbyn.json")).unwrap();
    }
    assert_eq!(std::fs::read_to_string(root.join("t3.json")).unwrap(), text);
    assert_eq!(
        workspace_preference(&service, &scope).await["value"],
        "worktree"
    );
    #[cfg(unix)]
    {
        let outside = dir.path().join("replacement");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("orbyn.json"), r#"{"defaultThreadEnvMode":"worktree","scripts":[{"name":"Outside","command":"echo forbidden"}]}"#).unwrap();
        let (status, thread) = service
            .send(
                "/api/threads",
                json!({"project_id":project["id"],"engine":"codex","title":"Boundary"}),
            )
            .await;
        assert_eq!(status, 201, "{thread}");
        std::fs::rename(root, root.with_extension("original")).unwrap();
        std::os::unix::fs::symlink(&outside, root).unwrap();
        // The registered root remains the authority even before the request begins.
        let (status, rejected) = service
            .send(
                "/api/settings/preferences/query",
                json!({"scope":scope,"keys":["default_thread_env_mode","default_project_scripts"]}),
            )
            .await;
        assert_eq!(
            status, 409,
            "changed checkout cannot provide scoped defaults: {rejected}"
        );
        let scripts_view = service
            .json(&format!(
                "/api/threads/{}/scripts",
                thread["id"].as_str().unwrap()
            ))
            .await;
        assert!(scripts_view["file"].is_null(), "{scripts_view}");
        assert_eq!(scripts_view["scripts"], json!([]));
        assert!(scripts_view["problem"].is_string(), "{scripts_view}");

        let view = service
            .json(&format!(
                "/api/preferences?project_id={}",
                project["id"].as_str().unwrap()
            ))
            .await;
        let row = view
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["key"] == "default_thread_env_mode")
            .unwrap();
        assert!(
            row.get("project_file").is_none(),
            "replacement checkout cannot supply defaults: {row}"
        );
        let scripts = view
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["key"] == "default_project_scripts")
            .unwrap();
        assert!(
            scripts.get("project_file").is_none(),
            "replacement checkout cannot supply scripts: {scripts}"
        );
    }
}
