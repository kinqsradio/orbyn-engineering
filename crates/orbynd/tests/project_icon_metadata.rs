//! Physical project icon metadata, optimistic writes and schema compatibility.
mod support;
use serde_json::{Value, json};
use std::path::Path;
use support::{Options, Service, TempDir, run_git};

async fn fixture() -> (TempDir, Service, Vec<Value>, Value) {
    let dir = TempDir::new();
    let service = Service::start(&dir.path().join("data"), Options::default());
    service.ensure_workspace(dir.path()).await;
    let mut projects = Vec::new();
    for name in ["icons-one", "icons-two", "icons-peer"] {
        let (code, project) = service
            .send("/api/projects/create", json!({"name":name}))
            .await;
        assert_eq!(code, 201, "{project}");
        if name != "icons-peer" {
            run_git(
                Path::new(project["path"].as_str().unwrap()),
                &[
                    "config",
                    "remote.origin.url",
                    "https://host/Owner/IconRepo.git",
                ],
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
async fn change(service: &Service, scope: &Value, members: &[Value], icon: Value) -> Value {
    let (status, catalog) = service
        .send("/api/settings/project-scopes", scope.clone())
        .await;
    assert_eq!(status, 200, "{catalog}");
    let revisions: serde_json::Map<_, _> = members
        .iter()
        .map(|p| {
            (
                p["id"].as_str().unwrap().to_owned(),
                p["metadata_revision"].clone(),
            )
        })
        .collect();
    json!({"scope":scope,"membership_version":catalog["version"],"expected_revisions":revisions,"icon":icon})
}
#[tokio::test]
async fn selected_icons_commit_atomically_preserve_authority_and_reset_with_revisions() {
    let (_dir, service, projects, scope) = fixture().await;
    let icon = json!({"kind":"monogram","text":"\u{feff} ab \u{feff}","color":"rose"});
    let body = change(&service, &scope, &projects[..2], icon).await;
    let (code, rows) = service
        .send("/api/settings/projects/icon", body.clone())
        .await;
    assert_eq!(code, 200, "{rows}");
    for original in &projects[..2] {
        let row = rows
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == original["id"])
            .unwrap();
        let mut expected = original.clone();
        expected["project_icon"] = json!({"kind":"monogram","text":"ab","color":"rose"});
        expected["metadata_revision"] = json!("1");
        assert_eq!(*row, expected);
        assert!(Path::new(row["path"].as_str().unwrap()).is_dir());
    }
    assert_eq!(
        service.send("/api/settings/projects/icon", body).await.0,
        409
    );
    let all = service.json("/api/projects").await;
    assert!(all.as_array().unwrap().contains(&projects[2]));
    let changed: Vec<_> = rows.as_array().unwrap().clone();
    let mut reset = change(&service, &scope, &changed, Value::Null).await;
    reset["expected_revisions"][projects[1]["id"].as_str().unwrap()] = json!("0");
    assert_eq!(
        service.send("/api/settings/projects/icon", reset).await.0,
        409
    );
    assert_eq!(
        service.json("/api/projects").await,
        all,
        "a stale member rolls back the group"
    );
    let (code, reset) = service
        .send(
            "/api/settings/projects/icon",
            change(&service, &scope, &changed, Value::Null).await,
        )
        .await;
    assert_eq!(code, 200, "{reset}");
    for row in reset.as_array().unwrap() {
        assert!(row["project_icon"].is_null());
        assert!(row["favicon_path"].is_null());
        assert_eq!(row["metadata_revision"], "2");
    }
}
#[tokio::test]
async fn stale_name_membership_and_invalid_icon_inputs_never_overwrite_other_metadata() {
    let (_dir, service, projects, scope) = fixture().await;
    let icon = json!({"kind":"emoji","emoji":"plain text"});
    let original = change(&service, &scope, &projects[..2], icon.clone()).await;
    let response = service
        .client
        .patch(format!(
            "{}/api/projects/{}",
            service.url,
            projects[0]["id"].as_str().unwrap()
        ))
        .bearer_auth(&service.token)
        .json(&json!({"name":"Concurrent"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);
    let renamed: Value = response.json().await.unwrap();
    assert_eq!(renamed["metadata_revision"], "1");
    assert_eq!(
        service
            .send("/api/settings/projects/icon", original)
            .await
            .0,
        409
    );
    let current = service.json("/api/projects").await;
    let selected: Vec<_> = current
        .as_array()
        .unwrap()
        .iter()
        .filter(|p| {
            projects[..2]
                .iter()
                .any(|selected| selected["id"] == p["id"])
        })
        .cloned()
        .collect();
    let body = change(&service, &scope, &selected, icon).await;
    let mut missing = body.clone();
    missing["expected_revisions"]
        .as_object_mut()
        .unwrap()
        .remove(projects[1]["id"].as_str().unwrap());
    assert_eq!(
        service.send("/api/settings/projects/icon", missing).await.0,
        409
    );
    for invalid in [
        json!({"kind":"monogram","text":"ABC","color":"blue"}),
        json!({"kind":"lucide","name":"bad--name","color":"blue"}),
        json!({"kind":"emoji","emoji":"💻".repeat(17)}),
    ] {
        let mut bad = body.clone();
        bad["icon"] = invalid;
        assert_eq!(
            service.send("/api/settings/projects/icon", bad).await.0,
            400
        );
    }
    assert_eq!(service.json("/api/projects").await, current);
    run_git(
        Path::new(projects[1]["path"].as_str().unwrap()),
        &[
            "config",
            "remote.origin.url",
            "https://host/Owner/Changed.git",
        ],
    );
    assert_eq!(
        service.send("/api/settings/projects/icon", body).await.0,
        409
    );
}
#[tokio::test]
async fn schema22_metadata_reopens_and_an_available_schema20_writer_is_refused() {
    let (dir, service, projects, scope) = fixture().await;
    let (code, rows) = service
        .send(
            "/api/settings/projects/icon",
            change(
                &service,
                &scope,
                &projects[..2],
                json!({"kind":"lucide","name":"future-icon","color":"violet"}),
            )
            .await,
        )
        .await;
    assert_eq!(code, 200, "{rows}");
    service.stop().await;
    let database = dir.path().join("data/orbyn.sqlite3");
    let conn = rusqlite::Connection::open(&database).unwrap();
    assert_eq!(
        conn.query_row("SELECT MAX(version) FROM schema_migrations", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        22
    );
    drop(conn);
    // The archived executable is a local qualification input, not a CI artifact.
    for (key, old_version) in [("ORBYN_SCHEMA20_BIN", "20"), ("ORBYN_SCHEMA21_BIN", "21")] {
        let Some(binary) = std::env::var_os(key) else {
            continue;
        };
        let snapshot = || {
            ["", "-wal", "-shm"].map(|suffix| {
                let path = format!("{}{suffix}", database.display());
                match std::fs::read(path) {
                    Ok(bytes) => Some(bytes),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                    Err(error) => panic!("cannot observe fixture database: {error}"),
                }
            })
        };
        let before = snapshot();
        let mut old = std::process::Command::new(binary)
            .args(["serve", "--data-dir"])
            .arg(dir.path().join("data"))
            .env("ORBYN_OFFLINE", "1")
            .env("HOME", dir.path())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut ended = false;
        for _ in 0..200 {
            if old.try_wait().unwrap().is_some() {
                ended = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        if !ended {
            old.kill().unwrap();
        }
        let output = old.wait_with_output().unwrap();
        assert!(ended, "old writer unexpectedly remained active");
        assert!(!output.status.success());
        let diagnostic = String::from_utf8_lossy(&output.stderr);
        assert!(
            diagnostic.contains("22") && diagnostic.contains(old_version),
            "{diagnostic}"
        );
        assert_eq!(
            snapshot(),
            before,
            "old writer must not change the database or WAL/SHM sidecar state"
        );
    }
    let service = Service::start(&dir.path().join("data"), Options::default());
    let all = service.json("/api/projects").await;
    for row in rows.as_array().unwrap() {
        assert!(all.as_array().unwrap().contains(row));
    }
    let (status, updated) = service
        .send(
            "/api/settings/projects/icon",
            change(
                &service,
                &scope,
                rows.as_array().unwrap(),
                json!({"kind":"emoji","emoji":"reopened"}),
            )
            .await,
        )
        .await;
    assert_eq!(status, 200, "{updated}");
    for row in updated.as_array().unwrap() {
        assert_eq!(row["metadata_revision"], "2");
        assert_eq!(
            row["project_icon"],
            json!({"kind":"emoji","emoji":"reopened"})
        );
    }
}

#[tokio::test]
async fn reserved_saved_paths_are_scoped_precede_project_files_and_reset_clears_them() {
    let (dir, service, projects, scope) = fixture().await;
    let id = projects[0]["id"].as_str().unwrap();
    let root = Path::new(projects[0]["path"].as_str().unwrap());
    std::fs::write(root.join("saved.svg"), "saved image").unwrap();
    std::fs::write(root.join("from-file.svg"), "project file image").unwrap();
    std::fs::write(root.join("orbyn.json"), r#"{"iconPath":"from-file.svg"}"#).unwrap();
    service.stop().await;
    let conn = rusqlite::Connection::open(dir.path().join("data/orbyn.sqlite3")).unwrap();
    conn.execute(
        "UPDATE projects SET favicon_path='saved.svg' WHERE id=?1",
        [id],
    )
    .unwrap();
    drop(conn);
    let service = Service::start(&dir.path().join("data"), Options::default());
    let image = service.json(&format!("/api/projects/{id}/icon")).await;
    assert_eq!(image["image"]["source"], "saved_image");
    assert_eq!(image["image"]["relative_path"], "saved.svg");
    let all = service.json("/api/projects").await;
    let members: Vec<_> = all
        .as_array()
        .unwrap()
        .iter()
        .filter(|p| projects[..2].iter().any(|old| old["id"] == p["id"]))
        .cloned()
        .collect();
    let (status, cleared) = service
        .send(
            "/api/settings/projects/icon",
            change(&service, &scope, &members, Value::Null).await,
        )
        .await;
    assert_eq!(status, 200, "{cleared}");
    assert!(
        cleared
            .as_array()
            .unwrap()
            .iter()
            .all(|p| p["favicon_path"].is_null())
    );
    let image = service.json(&format!("/api/projects/{id}/icon")).await;
    assert_eq!(image["image"]["source"], "project_file");
    assert_eq!(image["image"]["relative_path"], "from-file.svg");
    service.stop().await;
    let outside = dir.path().join("outside.svg");
    std::fs::write(&outside, "outside must not be returned").unwrap();
    let conn = rusqlite::Connection::open(dir.path().join("data/orbyn.sqlite3")).unwrap();
    conn.execute(
        "UPDATE projects SET favicon_path=?2 WHERE id=?1",
        rusqlite::params![id, outside.to_str().unwrap()],
    )
    .unwrap();
    drop(conn);
    let service = Service::start(&dir.path().join("data"), Options::default());
    let image = service.json(&format!("/api/projects/{id}/icon")).await;
    assert_eq!(image["image"]["relative_path"], "from-file.svg");
    assert_eq!(
        std::fs::read_to_string(root.join("orbyn.json")).unwrap(),
        r#"{"iconPath":"from-file.svg"}"#
    );
}

#[tokio::test]
async fn future_stored_variants_fall_back_without_name_writes_erasing_them_but_known_corruption_fails()
 {
    let (dir, service, projects, _) = fixture().await;
    let id = projects[0]["id"].as_str().unwrap();
    service.stop().await;
    let database = dir.path().join("data/orbyn.sqlite3");
    let future = r#"{"kind":"future","payload":"preserve"}"#;
    let conn = rusqlite::Connection::open(&database).unwrap();
    conn.execute(
        "UPDATE projects SET project_icon=?2 WHERE id=?1",
        rusqlite::params![id, future],
    )
    .unwrap();
    drop(conn);
    let store = orbyn_core::store::Store::open(&database, "fixture").unwrap();
    assert!(store.project(id).unwrap().project_icon.is_none());
    let renamed = store.rename_project(id, "Future safe").unwrap();
    assert_eq!(renamed.metadata_revision, "1");
    drop(store);
    let conn = rusqlite::Connection::open(&database).unwrap();
    assert_eq!(
        conn.query_row("SELECT project_icon FROM projects WHERE id=?1", [id], |r| r
            .get::<_, String>(0))
            .unwrap(),
        future
    );
    conn.execute(
        "UPDATE projects SET project_icon=?2 WHERE id=?1",
        rusqlite::params![id, r#"{"kind":"emoji"}"#],
    )
    .unwrap();
    drop(conn);
    let store = orbyn_core::store::Store::open(&database, "fixture-next").unwrap();
    assert!(store.project(id).is_err());
}

#[tokio::test]
async fn selected_name_writes_preserve_icons_and_advance_the_same_revision() {
    let (_dir, service, projects, scope) = fixture().await;
    let icon = json!({"kind":"lucide","name":"future-icon","color":"teal"});
    let (status, icons) = service
        .send(
            "/api/settings/projects/icon",
            change(&service, &scope, &projects[..2], icon.clone()).await,
        )
        .await;
    assert_eq!(status, 200, "{icons}");
    let catalog = service
        .send("/api/settings/project-scopes", scope.clone())
        .await
        .1;
    let names: serde_json::Map<_, _> = projects[..2]
        .iter()
        .map(|p| (p["id"].as_str().unwrap().to_owned(), p["name"].clone()))
        .collect();
    let (status, renamed) = service.send("/api/settings/projects/rename", json!({"scope":scope,"membership_version":catalog["version"],"expected_names":names,"name":"Named after icon"})).await;
    assert_eq!(status, 200, "{renamed}");
    for row in renamed.as_array().unwrap() {
        assert_eq!(row["name"], "Named after icon");
        assert_eq!(row["project_icon"], icon);
        assert_eq!(row["metadata_revision"], "2");
    }
    let (status, reset) = service
        .send(
            "/api/settings/projects/icon",
            change(&service, &scope, renamed.as_array().unwrap(), Value::Null).await,
        )
        .await;
    assert_eq!(status, 200, "{reset}");
    for row in reset.as_array().unwrap() {
        assert_eq!(row["name"], "Named after icon");
        assert!(row["project_icon"].is_null());
        assert_eq!(row["metadata_revision"], "3");
    }
}

#[tokio::test]
async fn scratch_promotion_advances_metadata_revision_without_changing_its_physical_root() {
    let dir = TempDir::new();
    let service = Service::start(&dir.path().join("data"), Options::default());
    service.ensure_workspace(dir.path()).await;
    let (status, thread) = service
        .send("/api/threads", json!({"engine":"codex"}))
        .await;
    assert_eq!(status, 201, "{thread}");
    let (status, project) = service
        .send(
            &format!("/api/threads/{}/adopt", thread["id"].as_str().unwrap()),
            json!({"name":"Kept"}),
        )
        .await;
    assert_eq!(status, 200, "{project}");
    assert_eq!(project["metadata_revision"], "1");
    assert_eq!(project["path"], thread["cwd"]);
    assert_eq!(project["name"], "Kept");
    assert_eq!(project["scratch"], false);
    assert!(project["project_icon"].is_null());
}

#[tokio::test]
async fn populated_schema20_owner_fences_migration_then_schema22_preserves_rows_and_writes() {
    if let Some(binary) = std::env::var_os("ORBYN_SCHEMA20_BIN") {
        qualify_populated_migration(binary, 20).await;
    }
}

#[tokio::test]
async fn populated_schema21_owner_fences_migration_then_schema22_preserves_rows_and_writes() {
    if let Some(binary) = std::env::var_os("ORBYN_SCHEMA21_BIN") {
        qualify_populated_migration(binary, 21).await;
    }
}

async fn qualify_populated_migration(binary: std::ffi::OsString, previous: i64) {
    use std::io::BufRead;
    let dir = TempDir::new();
    let data = dir.path().join("data");
    let private = dir.path().join("private-home");
    std::fs::create_dir_all(&private).unwrap();
    let private_options = || Options {
        env: [
            ("HOME", private.clone()),
            ("CODEX_HOME", private.join("codex")),
            ("CLAUDE_CONFIG_DIR", private.join("claude")),
            ("XDG_CONFIG_HOME", private.join("XDG_CONFIG_HOME")),
            ("XDG_DATA_HOME", private.join("XDG_DATA_HOME")),
            ("XDG_CACHE_HOME", private.join("XDG_CACHE_HOME")),
            ("XDG_STATE_HOME", private.join("XDG_STATE_HOME")),
        ]
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value.to_str().unwrap().to_owned()))
        .chain(std::iter::once((
            "ORBYN_KNOWN_ENGINE_IDS".into(),
            "[]".into(),
        )))
        .collect(),
        ..Options::default()
    };
    let mut command = std::process::Command::new(binary);
    command
        .args(["serve", "--data-dir"])
        .arg(&data)
        .env("ORBYN_OFFLINE", "1")
        .env("ORBYN_CLAUDE_BIN", support::FAKE)
        .env("ORBYN_CODEX_BIN", support::FAKE)
        .env("HOME", &private)
        .env("CODEX_HOME", private.join("codex"))
        .env("CLAUDE_CONFIG_DIR", private.join("claude"))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    for key in [
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
        "XDG_STATE_HOME",
    ] {
        command.env(key, private.join(key));
    }
    let mut child = command.spawn().unwrap();
    let mut stdout = std::io::BufReader::new(child.stdout.take().unwrap());
    let mut ready = String::new();
    stdout.read_line(&mut ready).unwrap();
    if ready.is_empty() {
        let output = child.wait_with_output().unwrap();
        panic!(
            "schema20 fixture failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let ready: Value = serde_json::from_str(&ready).unwrap();
    // Service owns this exact child and releases it on every assertion failure.
    let old = Service {
        url: ready["url"].as_str().unwrap().to_owned(),
        token: ready["token"].as_str().unwrap().to_owned(),
        access_key: ready["access_key"].as_str().map(str::to_owned),
        client: reqwest::Client::new(),
        child,
        stdout,
    };
    old.ensure_workspace(dir.path()).await;
    let (status, mut original) = old
        .send(
            "/api/projects/create",
            json!({"name":"Populated before migration"}),
        )
        .await;
    assert_eq!(status, 201, "{original}");
    let id = original["id"].as_str().unwrap().to_owned();
    let mut icon_peer = None;
    if previous == 21 {
        let catalog = old.send("/api/settings/project-scopes", json!({})).await.1;
        let group = catalog["groups"]
            .as_array()
            .unwrap()
            .iter()
            .find(|g| {
                g["members"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|m| m["project_id"] == id)
            })
            .unwrap();
        let scope =
            json!({"selection":{"kind":"checkout","group_key":group["key"],"project_id":id}});
        let body = change(&old, &scope, std::slice::from_ref(&original), Value::Null).await;
        let (status, rows) = old.send("/api/settings/projects/image",json!({"scope":scope,"membership_version":body["membership_version"],"expected_revisions":body["expected_revisions"],"path":"missing-selected.svg"})).await;
        assert_eq!(status, 200, "{rows}");
        original = rows[0].clone();
        let (status, peer) = old
            .send("/api/projects/create", json!({"name":"Preserved icon"}))
            .await;
        assert_eq!(status, 201);
        let catalog = old.send("/api/settings/project-scopes", json!({})).await.1;
        let group = catalog["groups"]
            .as_array()
            .unwrap()
            .iter()
            .find(|g| {
                g["members"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|m| m["project_id"] == peer["id"])
            })
            .unwrap();
        let scope = json!({"selection":{"kind":"checkout","group_key":group["key"],"project_id":peer["id"]}});
        let body = change(
            &old,
            &scope,
            &[peer],
            json!({"kind":"emoji","emoji":"preserved"}),
        )
        .await;
        let (status, rows) = old.send("/api/settings/projects/icon", body).await;
        assert_eq!(status, 200, "{rows}");
        icon_peer = Some(rows[0].clone());
    }
    let thread_id = old.thread(&id, "codex").await;
    let original_thread = old.json(&format!("/api/threads/{thread_id}")).await;
    let database = data.join("orbyn.sqlite3");
    let schema = || {
        let conn = rusqlite::Connection::open_with_flags(
            &database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        conn.query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap()
    };
    assert_eq!(schema(), previous);
    let lock_before = std::fs::read(data.join("orbynd.lock")).unwrap();
    assert_eq!(
        String::from_utf8_lossy(&lock_before),
        old.child.id().to_string()
    );
    let rejected = match Service::try_start(&data, private_options()) {
        Ok(second) => {
            drop(second);
            panic!("schema22 must not start over a live schema{previous} owner");
        }
        Err(error) => error,
    };
    assert!(
        rejected.contains("another orbynd owns this data directory"),
        "{rejected}"
    );
    assert_eq!(
        schema(),
        previous,
        "the live-owner fence must precede migration"
    );
    assert_eq!(
        std::fs::read(data.join("orbynd.lock")).unwrap(),
        lock_before
    );
    assert_eq!(
        old.json(&format!("/api/threads/{thread_id}")).await,
        original_thread
    );
    old.stop().await;
    let new = Service::start(&data, private_options());
    assert_eq!(schema(), 22);
    let projects = new.json("/api/projects").await;
    let migrated = projects
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == id)
        .unwrap();
    let mut expected = original.clone();
    if previous == 20 {
        expected["project_icon"] = Value::Null;
        expected["favicon_path"] = Value::Null;
        expected["metadata_revision"] = json!("0");
    }
    if let Some(peer) = icon_peer {
        assert!(projects.as_array().unwrap().contains(&peer));
    }
    assert_eq!(*migrated, expected);
    assert_eq!(
        new.json(&format!("/api/threads/{thread_id}")).await,
        original_thread
    );
    let catalog = new.send("/api/settings/project-scopes", json!({})).await.1;
    let group = catalog["groups"]
        .as_array()
        .unwrap()
        .iter()
        .find(|group| {
            group["members"]
                .as_array()
                .unwrap()
                .iter()
                .any(|m| m["project_id"] == id)
        })
        .unwrap();
    let scope = json!({"selection":{"kind":"checkout","group_key":group["key"],"project_id":id}});
    let (status, updated) = new
        .send(
            "/api/settings/projects/icon",
            change(
                &new,
                &scope,
                std::slice::from_ref(migrated),
                json!({"kind":"emoji","emoji":"after migration"}),
            )
            .await,
        )
        .await;
    assert_eq!(status, 200, "{updated}");
    assert_eq!(
        updated[0]["metadata_revision"],
        (original["metadata_revision"]
            .as_str()
            .unwrap_or("0")
            .parse::<u64>()
            .unwrap()
            + 1)
        .to_string()
    );
    assert_eq!(
        updated[0]["project_icon"],
        json!({"kind":"emoji","emoji":"after migration"})
    );
    let body = change(&new, &scope, updated.as_array().unwrap(), Value::Null).await;
    let (status,saved)=new.send("/api/settings/projects/image",json!({"scope":scope,"membership_version":body["membership_version"],"expected_revisions":body["expected_revisions"],"path":"after-migration.svg"})).await;
    assert_eq!(status, 200, "{saved}");
    new.stop().await;
    let reopened = Service::start(&data, private_options());
    assert!(
        reopened
            .json("/api/projects")
            .await
            .as_array()
            .unwrap()
            .contains(&saved[0])
    );
    let conn = rusqlite::Connection::open_with_flags(
        &database,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    assert_eq!(conn.query_row("SELECT selection_count FROM project_image_history WHERE project_id=?1 AND path='after-migration.svg'",[&id],|r|r.get::<_,i64>(0)).unwrap(),1);
}
