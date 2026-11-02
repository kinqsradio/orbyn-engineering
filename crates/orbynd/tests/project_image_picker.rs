//! Real-service passive image search, selected hint writes and streaming extents.
mod support;
use serde_json::{Value, json};
use std::path::Path;
use support::{Options, Service, TempDir, run_git};

fn png() -> Vec<u8> {
    vec![
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6,
        0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 96, 96, 96, 248, 15,
        0, 1, 4, 1, 0, 95, 229, 195, 75, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
    ]
}
fn write(root: &Path, path: &str, bytes: impl AsRef<[u8]>) {
    let path = root.join(path);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, bytes).unwrap();
}
async fn fixture() -> (TempDir, Service, Vec<Value>, Value) {
    let dir = TempDir::new();
    let service = Service::start(&dir.path().join("data"), Options::default());
    service.ensure_workspace(dir.path()).await;
    let mut projects = Vec::new();
    for name in ["images-a", "images-b"] {
        let (code, project) = service
            .send("/api/projects/create", json!({"name":name}))
            .await;
        assert_eq!(code, 201, "{project}");
        run_git(
            Path::new(project["path"].as_str().unwrap()),
            &[
                "config",
                "remote.origin.url",
                "https://host/Owner/Images.git",
            ],
        );
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
        .find(|g| {
            g["members"]
                .as_array()
                .unwrap()
                .iter()
                .any(|m| m["project_id"] == projects[0]["id"])
        })
        .unwrap();
    let scope = json!({"selection":{"kind":"project_group","group_key":group["key"]}});
    (dir, service, projects, scope)
}
async fn request(service: &Service, scope: &Value, path: &str) -> Value {
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
    let revisions: serde_json::Map<_, _> = group["members"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| {
            (
                m["project_id"].as_str().unwrap().to_owned(),
                m["metadata_revision"].clone(),
            )
        })
        .collect();
    json!({"scope":scope,"membership_version":catalog["version"],"expected_revisions":revisions,"path":path})
}
async fn search(service: &Service, scope: &Value, query: &str) -> Value {
    let catalog = service
        .send("/api/settings/project-scopes", scope.clone())
        .await
        .1;
    let (status, result) = service
        .send(
            "/api/settings/projects/image-search",
            json!({"scope":scope,"membership_version":catalog["version"],"query":query}),
        )
        .await;
    assert_eq!(status, 200, "{result}");
    result
}
#[tokio::test]
async fn image_search_uses_representative_ignore_data_and_bounded_results_without_execution() {
    let (_dir, service, projects, scope) = fixture().await;
    for project in &projects {
        let root = Path::new(project["path"].as_str().unwrap());
        write(root, ".gitignore", "*.png\n!keep.png\nignored/\n");
        write(root, ".ignore", "plain.svg\n");
        for path in [
            "keep.png",
            "skip.png",
            "ignored/deep.png",
            "plain.svg",
            ".idea/logo.svg",
            "nested/child.png",
        ] {
            write(root, path, png());
        }
        write(root, "nested/.gitignore", "!child.png\n");
        write(root, ".git/never.png", png());
        write(
            root,
            "orbyn.json",
            r#"{"scripts":[{"name":"Never","command":"echo no > executed"}]}"#,
        );
    }
    let result = search(&service, &scope, "").await;
    assert_eq!(
        result["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["path"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [".idea/logo.svg", "keep.png", "nested/child.png"]
    );
    assert_eq!(
        search(&service, &scope, "nested child").await["entries"][0]["path"],
        "nested/child.png"
    );
    let root = Path::new(result["project_path"].as_str().unwrap());
    assert!(!root.join("executed").exists());
    for n in 0..205 {
        write(root, &format!("many/{n:03}.svg"), "<svg/>");
    }
    let result = search(&service, &scope, "many").await;
    assert_eq!(result["entries"].as_array().unwrap().len(), 200);
    assert_eq!(result["truncated"], true);
    let (status, _) = service
        .send(
            "/api/settings/projects/image-search",
            json!({"scope":{},"membership_version":result["membership_version"],"query":""}),
        )
        .await;
    assert_eq!(status, 409);
}
#[tokio::test]
async fn relative_hints_fan_out_even_after_source_disappears_and_stale_group_writes_are_atomic() {
    let (_dir, service, projects, scope) = fixture().await;
    let initial = search(&service, &scope, "").await;
    let representative = Path::new(initial["project_path"].as_str().unwrap());
    write(representative, "chosen.png", png());
    assert_eq!(
        search(&service, &scope, "chosen").await["entries"][0]["path"],
        "chosen.png"
    );
    std::fs::remove_file(representative.join("chosen.png")).unwrap();
    for p in &projects {
        write(
            Path::new(p["path"].as_str().unwrap()),
            "favicon.svg",
            "<svg/>",
        );
    }
    let body = request(&service, &scope, "chosen.png").await;
    let (status, rows) = service
        .send("/api/settings/projects/image", body.clone())
        .await;
    assert_eq!(status, 200, "{rows}");
    for p in rows.as_array().unwrap() {
        assert_eq!(p["favicon_path"], "chosen.png");
        assert!(p["project_icon"].is_null());
        assert_eq!(p["trusted"], false);
        let image = service
            .json(&format!(
                "/api/projects/{}/icon/resource",
                p["id"].as_str().unwrap()
            ))
            .await;
        assert_eq!(image["image"]["relative_path"], "favicon.svg");
    }
    assert_eq!(
        service.send("/api/settings/projects/image", body).await.0,
        409
    );
    let before = service.json("/api/projects").await;
    let mut stale = request(&service, &scope, "other.svg").await;
    stale["expected_revisions"][projects[1]["id"].as_str().unwrap()] = json!("0");
    assert_eq!(
        service.send("/api/settings/projects/image", stale).await.0,
        409
    );
    assert_eq!(service.json("/api/projects").await, before);
    for path in [
        "../outside.png",
        "/tmp/outside.png",
        ".git/image.png",
        "C:/outside.png",
        "images\\out.png",
        "auth.json",
    ] {
        let body = request(&service, &scope, path).await;
        assert_eq!(
            service.send("/api/settings/projects/image", body).await.0,
            400,
            "{path}"
        );
    }
    let old = request(&service, &scope, "missing.svg").await;
    run_git(
        Path::new(projects[1]["path"].as_str().unwrap()),
        &[
            "config",
            "remote.origin.url",
            "https://host/Owner/Other.git",
        ],
    );
    assert_eq!(
        service.send("/api/settings/projects/image", old).await.0,
        409
    );
}
#[tokio::test]
async fn valid_large_bitmap_and_embedded_png_stream_with_content_revisions_and_offsets() {
    let (_dir, service, projects, scope) = fixture().await;
    let p = &projects[0];
    let root = Path::new(p["path"].as_str().unwrap());
    let width = 1024u32;
    let height = 512u32;
    let size = 54 + width * height * 3;
    let mut bmp = vec![0u8; size as usize];
    bmp[..2].copy_from_slice(b"BM");
    bmp[2..6].copy_from_slice(&size.to_le_bytes());
    bmp[10..14].copy_from_slice(&54u32.to_le_bytes());
    bmp[14..18].copy_from_slice(&40u32.to_le_bytes());
    bmp[18..22].copy_from_slice(&width.to_le_bytes());
    bmp[22..26].copy_from_slice(&height.to_le_bytes());
    bmp[26..28].copy_from_slice(&1u16.to_le_bytes());
    bmp[28..30].copy_from_slice(&24u16.to_le_bytes());
    bmp[34..38].copy_from_slice(&(size - 54).to_le_bytes());
    write(root, "large.bmp", &bmp);
    assert!(bmp.len() > 1024 * 1024);
    let (status, rows) = service
        .send(
            "/api/settings/projects/image",
            request(&service, &scope, "large.bmp").await,
        )
        .await;
    assert_eq!(status, 200, "{rows}");
    let id = p["id"].as_str().unwrap();
    let resource = service
        .json(&format!("/api/projects/{id}/icon/resource"))
        .await;
    assert_eq!(resource["project_id"], p["id"]);
    assert_eq!(resource["project_path"], p["path"]);
    assert_eq!(resource["favicon_path"], "large.bmp");
    assert_eq!(resource["image"]["size"], size);
    assert_eq!(resource["image"]["media_type"], "bmp");
    let response = service
        .get(&format!("/api/projects/{id}/icon/raw"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["content-type"], "image/bmp");
    let tag = response.headers()["etag"].to_str().unwrap().to_owned();
    assert_eq!(
        tag,
        format!("\"{}\"", resource["image"]["revision"].as_str().unwrap())
    );
    assert_eq!(response.bytes().await.unwrap().as_ref(), bmp);
    assert_eq!(
        service
            .get(&format!("/api/projects/{id}/icon/raw"))
            .header("if-none-match", tag)
            .send()
            .await
            .unwrap()
            .status(),
        304
    );
    let png = png();
    let total = 8 + 12 + 8 + png.len();
    let mut icns = b"icns".to_vec();
    icns.extend((total as u32).to_be_bytes());
    icns.extend(b"junk");
    icns.extend(12u32.to_be_bytes());
    icns.extend([0; 4]);
    icns.extend(b"ic07");
    icns.extend(((png.len() + 8) as u32).to_be_bytes());
    icns.extend(&png);
    write(root, "chosen.icns", icns);
    let response = service
        .get(&format!("/api/projects/{id}/images/raw?path=chosen.icns"))
        .header("range", "bytes=0-7")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 206);
    assert_eq!(response.headers()["content-type"], "image/png");
    assert_eq!(response.bytes().await.unwrap().as_ref(), &png[..8]);
}

#[tokio::test]
async fn non_git_folders_use_local_ignore_data_and_never_follow_image_or_metadata_escapes() {
    let dir = TempDir::new();
    let service = Service::start(&dir.path().join("data"), Options::default());
    service.ensure_workspace(dir.path()).await;
    let root = dir.path().join("plain-folder");
    std::fs::create_dir(&root).unwrap();
    let (status, p) = service
        .send("/api/projects/add", json!({"path":root}))
        .await;
    assert_eq!(status, 201, "{p}");
    assert_eq!(p["is_git"], false);
    write(&root, ".gitignore", "hidden.svg\n");
    write(&root, "hidden.svg", "<svg/>");
    write(&root, "shown.png", png());
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
                .any(|m| m["project_id"] == p["id"])
        })
        .unwrap();
    let scope =
        json!({"selection":{"kind":"checkout","group_key":group["key"],"project_id":p["id"]}});
    assert_eq!(
        search(&service, &scope, "").await["entries"],
        json!([{"path":"shown.png","name":"shown.png"}])
    );
    let id = p["id"].as_str().unwrap();
    for path in [
        "../outside.svg",
        ".git/config.png",
        "/tmp/outside.svg",
        "auth.json",
    ] {
        assert_eq!(
            service
                .get(&format!("/api/projects/{id}/images/raw"))
                .query(&[("path", path)])
                .send()
                .await
                .unwrap()
                .status(),
            400,
            "{path}"
        );
    }
    assert_eq!(
        service
            .get("/api/projects/not-registered/icon/resource")
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    #[cfg(unix)]
    {
        let outside = dir.path().join("outside.svg");
        std::fs::write(&outside, "outside image bytes").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("escape.svg")).unwrap();
        write(
            &root,
            "auth.json",
            r#"{"synthetic":"must not be read as image"}"#,
        );
        std::os::unix::fs::symlink(root.join("auth.json"), root.join("alias.png")).unwrap();
        assert_eq!(
            service
                .get(&format!("/api/projects/{id}/images/raw?path=escape.svg"))
                .send()
                .await
                .unwrap()
                .status(),
            404
        );
        assert_eq!(
            service
                .get(&format!("/api/projects/{id}/images/raw?path=alias.png"))
                .send()
                .await
                .unwrap()
                .status(),
            404
        );
        let result = search(&service, &scope, "").await;
        assert_eq!(
            result["entries"],
            json!([{"path":"shown.png","name":"shown.png"}])
        );
        std::fs::remove_file(root.join(".gitignore")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join(".gitignore")).unwrap();
        let result = search(&service, &scope, "").await;
        assert_eq!(result["entries"], json!([]));
        assert_eq!(result["truncated"], true);
        std::fs::rename(&root, dir.path().join("moved")).unwrap();
        let replacement = dir.path().join("replacement");
        std::fs::create_dir(&replacement).unwrap();
        write(&replacement, "favicon.svg", "outside replacement");
        std::os::unix::fs::symlink(&replacement, &root).unwrap();
        assert_eq!(
            service
                .get(&format!("/api/projects/{id}/icon/resource"))
                .send()
                .await
                .unwrap()
                .status(),
            409
        );
    }
}

#[tokio::test]
async fn structured_icon_and_reset_clear_the_saved_image_hint_without_source_writes() {
    let (_dir, service, projects, scope) = fixture().await;
    let root = Path::new(projects[0]["path"].as_str().unwrap());
    write(root, "chosen.png", png());
    let (status, images) = service
        .send(
            "/api/settings/projects/image",
            request(&service, &scope, "chosen.png").await,
        )
        .await;
    assert_eq!(status, 200, "{images}");
    let catalog = service
        .send("/api/settings/project-scopes", scope.clone())
        .await
        .1;
    let revisions: serde_json::Map<_, _> = images
        .as_array()
        .unwrap()
        .iter()
        .map(|p| {
            (
                p["id"].as_str().unwrap().to_owned(),
                p["metadata_revision"].clone(),
            )
        })
        .collect();
    let (status,icons)=service.send("/api/settings/projects/icon",json!({"scope":scope,"membership_version":catalog["version"],"expected_revisions":revisions,"icon":{"kind":"emoji","emoji":"🚀"}})).await;
    assert_eq!(status, 200, "{icons}");
    for p in icons.as_array().unwrap() {
        assert!(p["favicon_path"].is_null());
    }
    let (status, _) = service
        .send(
            "/api/settings/projects/image",
            request(&service, &scope, "chosen.png").await,
        )
        .await;
    assert_eq!(status, 200);
    let body = request(&service, &scope, "chosen.png").await;
    let (status,reset)=service.send("/api/settings/projects/icon",json!({"scope":scope,"membership_version":body["membership_version"],"expected_revisions":body["expected_revisions"],"icon":null})).await;
    assert_eq!(status, 200, "{reset}");
    for p in reset.as_array().unwrap() {
        assert!(p["favicon_path"].is_null());
        assert!(p["project_icon"].is_null());
    }
    assert_eq!(std::fs::read(root.join("chosen.png")).unwrap(), png());
}

#[tokio::test]
async fn a_bad_ignore_pattern_keeps_valid_rules_and_ordinary_images() {
    let (_dir, service, projects, scope) = fixture().await;
    for p in &projects {
        let root = Path::new(p["path"].as_str().unwrap());
        write(root, ".gitignore", "*.svg\n[z-a]\n");
        write(root, "hidden.svg", "<svg/>");
        write(root, "visible.png", png());
    }
    let result = search(&service, &scope, "").await;
    assert_eq!(
        result["entries"],
        json!([{"path":"visible.png","name":"visible.png"}])
    );
    assert_eq!(
        result["truncated"], true,
        "a malformed ignore line is recorded as incomplete indexing"
    );
}

#[tokio::test]
async fn fuzzy_search_ranks_the_whole_pool_and_remembers_selections_after_reset_and_restart() {
    let (dir, service, projects, scope) = fixture().await;
    for project in &projects {
        let root = Path::new(project["path"].as_str().unwrap());
        for n in 0..205 {
            write(root, &format!("a{n:03}/f-a-v.svg"), "<svg/>");
        }
        write(root, "z/favicon.svg", "<svg/>");
        write(root, "other/logotype.svg", "<svg/>");
        write(root, "logo/drawing.svg", "<svg/>");
    }
    let result = search(&service, &scope, "fav").await;
    assert_eq!(result["entries"][0]["path"], "z/favicon.svg");
    assert_eq!(result["entries"].as_array().unwrap().len(), 200);
    assert_eq!(result["truncated"], true);
    let fuzzy = search(&service, &scope, "lgo").await;
    assert_eq!(fuzzy["entries"][0]["path"], "other/logotype.svg");
    let body = request(&service, &scope, "z/favicon.svg").await;
    assert_eq!(
        service
            .send("/api/settings/projects/image", body.clone())
            .await
            .0,
        200
    );
    let before = search(&service, &scope, "").await;
    assert_eq!(before["entries"][0]["path"], "z/favicon.svg");
    assert_eq!(
        service.send("/api/settings/projects/image", body).await.0,
        409
    );
    let database = dir.path().join("data/orbyn.sqlite3");
    let conn = rusqlite::Connection::open_with_flags(
        &database,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    for project in &projects {
        assert_eq!(conn.query_row("SELECT selection_count FROM project_image_history WHERE project_id=?1 AND path='z/favicon.svg'",[project["id"].as_str().unwrap()],|r|r.get::<_,i64>(0)).unwrap(),1);
    }
    drop(conn);
    let body = request(&service, &scope, "z/favicon.svg").await;
    let (status,_) = service.send("/api/settings/projects/icon",json!({"scope":scope,"membership_version":body["membership_version"],"expected_revisions":body["expected_revisions"],"icon":null})).await;
    assert_eq!(status, 200);
    service.stop().await;
    let service = Service::start(&dir.path().join("data"), Options::default());
    assert_eq!(
        search(&service, &scope, "").await["entries"][0]["path"],
        "z/favicon.svg"
    );
}

#[tokio::test]
async fn trust_advances_row_revision_once_and_preserves_image_name_and_audit() {
    let (_dir, service, projects, scope) = fixture().await;
    let (status, rows) = service
        .send(
            "/api/settings/projects/image",
            request(&service, &scope, "missing.png").await,
        )
        .await;
    assert_eq!(status, 200);
    let before = rows
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == projects[0]["id"])
        .unwrap();
    let id = before["id"].as_str().unwrap();
    assert_eq!(before["trusted"], false);
    let (status, trusted) = service
        .send(&format!("/api/projects/{id}/trust"), json!({}))
        .await;
    assert_eq!(status, 200, "{trusted}");
    let mut expected = before.clone();
    expected["trusted"] = json!(true);
    expected["metadata_revision"] = json!("2");
    assert_eq!(trusted, expected);
    assert_eq!(
        service
            .send(&format!("/api/projects/{id}/trust"), json!({}))
            .await
            .1,
        trusted
    );
    let audit = service.json("/api/audit").await;
    assert_eq!(
        audit
            .as_array()
            .unwrap()
            .iter()
            .filter(|row| row["action"] == "project.trust" && row["target"] == before["path"])
            .count(),
        2
    );
    let stale = request(&service, &scope, "other.png").await;
    let mut stale = stale;
    stale["expected_revisions"][id] = json!("1");
    assert_eq!(
        service.send("/api/settings/projects/image", stale).await.0,
        409
    );
    assert!(
        service
            .json("/api/projects")
            .await
            .as_array()
            .unwrap()
            .contains(&trusted)
    );
}
