//! Passive metadata reads do not create thread/execution authority.
mod support;
use serde_json::{Value, json};
use support::{Options, Service, TempDir};

#[tokio::test]
async fn authenticated_untrusted_registered_image_is_bounded_and_not_a_file_grant() {
    let dir = TempDir::new();
    let service = Service::start(&dir.path().join("data"), Options::default());
    service.ensure_workspace(dir.path()).await;
    let path = dir.path().join("untrusted");
    std::fs::create_dir_all(&path).unwrap();
    let bytes = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"16\" height=\"16\"/>";
    std::fs::write(path.join("favicon.svg"), bytes).unwrap();
    let (status, added) = service
        .send("/api/projects/add", json!({"path":path}))
        .await;
    assert_eq!(status, 201, "{added}");
    let project = &added;
    assert_eq!(project["trusted"], false);
    let id = project["id"].as_str().unwrap();
    let endpoint = format!("/api/projects/{id}/icon");
    let icon = service.json(&endpoint).await;
    assert_eq!(icon["project_id"], id);
    assert_eq!(icon["project_path"], project["path"]);
    assert_eq!(icon["image"]["media_type"], "svg");
    assert_eq!(icon["image"]["source"], "automatic");
    assert_eq!(icon["image"]["relative_path"], "favicon.svg");
    assert!(icon["image"]["data_base64"].as_str().unwrap().len() < 1024);
    assert!(icon["image"].get("url").is_none());
    assert_eq!(
        service
            .client
            .get(format!("{}{endpoint}", service.url))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    let (code, _) = service
        .send(
            "/api/threads",
            json!({"project_id":id,"engine":"codex","title":"untrusted"}),
        )
        .await;
    // Thread registration may be allowed; it must never silently trust the root.
    assert!(matches!(code, 201 | 403));
    let projects = service.json("/api/projects").await;
    assert_eq!(
        projects
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == id)
            .unwrap()["trusted"],
        false
    );
    std::fs::write(path.join("favicon.svg"), vec![b'x'; 1024 * 1024 + 1]).unwrap();
    let too_large = service.json(&endpoint).await;
    assert_eq!(too_large["image"], Value::Null);
    std::fs::remove_file(path.join("favicon.svg")).unwrap();
    assert_eq!(service.json(&endpoint).await["image"], Value::Null);
    assert_eq!(
        service
            .get("/api/projects/not-registered/icon")
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
}
