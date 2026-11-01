//! Scoped settings against the real service and its disposable SQLite database.
mod support;
use serde_json::{Value, json};
use std::path::Path;
use support::{Options, Service, TempDir, run_git};

async fn put(service: &Service, path: &str, body: Value) -> (u16, Value) {
    let response = service
        .client
        .put(format!("{}{path}", service.url))
        .bearer_auth(&service.token)
        .json(&body)
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    (status, response.json().await.unwrap())
}
async fn query(service: &Service, scope: Value, keys: &[&str]) -> Value {
    let (status, body) = service
        .send(
            "/api/settings/preferences/query",
            json!({"scope":scope,"keys":keys}),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    body
}
fn row<'a>(response: &'a Value, key: &str) -> &'a Value {
    response["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["key"] == key)
        .unwrap()
}
fn edit_body(response: &Value, scope: Value, edits: Value) -> Value {
    let revisions: serde_json::Map<_, _> = edits
        .as_object()
        .unwrap()
        .keys()
        .map(|key| (key.clone(), row(response, key)["revision"].clone()))
        .collect();
    json!({"scope":scope,"membership_version":response["catalog"]["version"],"if_match":revisions,"edits":edits})
}
async fn fixture(dir: &TempDir) -> (Service, Vec<Value>, Value) {
    let service = Service::start(&dir.path().join("data"), Options::default());
    service.ensure_workspace(dir.path()).await;
    let mut projects = Vec::new();
    for name in ["one", "two"] {
        let (status, project) = service
            .send("/api/projects/create", json!({"name":name,"readme":true}))
            .await;
        assert_eq!(status, 201, "{project}");
        run_git(
            Path::new(project["path"].as_str().unwrap()),
            &["config", "remote.origin.url", "https://host/Owner/Repo.git"],
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
        .find(|group| {
            group["members"]
                .as_array()
                .unwrap()
                .iter()
                .any(|member| member["project_id"] == projects[0]["id"])
        })
        .unwrap();
    let scope = json!({"selection":{"kind":"project_group","group_key":group["key"]}});
    (service, projects, scope)
}

#[tokio::test]
async fn real_scope_edits_fan_out_with_mixed_sources_null_inherit_and_explicit_reset() {
    let dir = TempDir::new();
    let (service, projects, scope) = fixture(&dir).await;
    let id = projects[0]["id"].as_str().unwrap();
    assert_eq!(
        put(
            &service,
            &format!("/api/projects/{id}/preferences"),
            json!({"values":{"auto_pull":false}})
        )
        .await
        .0,
        200
    );
    let uniform = query(&service, scope.clone(), &["auto_pull"]).await;
    assert_eq!(row(&uniform, "auto_pull")["mixed"], false);
    assert_eq!(
        row(&uniform, "auto_pull")["overrides"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let all = query(&service, json!({}), &["auto_pull"]).await;
    let (code, _) = put(
        &service,
        "/api/settings/preferences",
        edit_body(
            &all,
            json!({}),
            json!({"auto_pull":{"op":"set","value":true}}),
        ),
    )
    .await;
    assert_eq!(code, 200);
    let mixed = query(&service, scope.clone(), &["auto_pull"]).await;
    assert_eq!(row(&mixed, "auto_pull")["mixed"], true);
    assert!(row(&mixed, "auto_pull")["value"].is_null());
    let (code, changed) = put(
        &service,
        "/api/settings/preferences",
        edit_body(
            &mixed,
            scope.clone(),
            json!({"auto_pull":{"op":"set","value":false}}),
        ),
    )
    .await;
    assert_eq!(code, 200, "{changed}");
    assert_eq!(
        row(&changed, "auto_pull")["members"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(row(&changed, "auto_pull")["environment"]["value"], true);
    assert_eq!(
        row(&changed, "auto_pull")["overrides"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let nullable = query(&service, scope.clone(), &["auto_settle_after_days"]).await;
    let (code, never) = put(
        &service,
        "/api/settings/preferences",
        edit_body(
            &nullable,
            scope.clone(),
            json!({"auto_settle_after_days":{"op":"set","value":null}}),
        ),
    )
    .await;
    assert_eq!(code, 200, "{never}");
    assert_eq!(row(&never, "auto_settle_after_days")["mixed"], false);
    assert!(row(&never, "auto_settle_after_days")["value"].is_null());
    assert_eq!(
        row(&never, "auto_settle_after_days")["members"][0]["view"]["source"],
        "project"
    );
    let (code, inherited) = put(
        &service,
        "/api/settings/preferences",
        edit_body(
            &never,
            scope.clone(),
            json!({"auto_settle_after_days":{"op":"inherit"}}),
        ),
    )
    .await;
    assert_eq!(code, 200, "{inherited}");
    assert_eq!(row(&inherited, "auto_settle_after_days")["value"], 3);
    assert!(
        row(&inherited, "auto_settle_after_days")["overrides"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let all_days = query(&service, json!({}), &["auto_settle_after_days"]).await;
    let (code, never_global) = put(
        &service,
        "/api/settings/preferences",
        edit_body(
            &all_days,
            json!({}),
            json!({"auto_settle_after_days":{"op":"set","value":null}}),
        ),
    )
    .await;
    assert_eq!(code, 200, "{never_global}");
    assert!(service.json("/api/settings").await["auto_settle"]["after_days"].is_null());
    assert_eq!(
        put(
            &service,
            "/api/preferences",
            json!({"values":{"auto_settle_after_days":null}})
        )
        .await
        .0,
        200
    );
    assert_eq!(
        service.json("/api/settings").await["auto_settle"]["after_days"],
        3
    );
    let all = query(&service, json!({}), &["auto_pull"]).await;
    let (code, reset) = put(
        &service,
        "/api/settings/preferences",
        edit_body(
            &all,
            json!({}),
            json!({"auto_pull":{"op":"reset_overrides","project_ids":[id]}}),
        ),
    )
    .await;
    assert_eq!(code, 200, "{reset}");
    assert_eq!(row(&reset, "auto_pull")["value"], true);
    assert_eq!(
        row(&reset, "auto_pull")["overrides"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        row(&reset, "auto_pull")["overrides"][0]["project_id"],
        projects[1]["id"]
    );
    let invalid = query(&service, json!({}), &["auto_pull"]).await;
    let (code, _) = put(
        &service,
        "/api/settings/preferences",
        edit_body(
            &invalid,
            json!({}),
            json!({"auto_pull":{"op":"set","value":null}}),
        ),
    )
    .await;
    assert_eq!(code, 400);
    let invalid = query(&service, scope.clone(), &["auto_pull", "preview_zoom"]).await;
    let (code, _) = put(
        &service,
        "/api/settings/preferences",
        edit_body(
            &invalid,
            scope.clone(),
            json!({"auto_pull":{"op":"set","value":true},"preview_zoom":{"op":"set","value":2}}),
        ),
    )
    .await;
    assert_eq!(code, 400);
    assert_eq!(
        query(&service, json!({}), &["auto_pull"]).await["rows"],
        reset["rows"]
    );
    // A compound setting patches each member's own current map, even when mixed.
    for (index, project) in projects.iter().enumerate() {
        let (code,_) = put(&service,&format!("/api/projects/{}/preferences",project["id"].as_str().unwrap()),json!({"values":{"storage_cleanup":{"edited":1,"other":index,"future":{"member":index}}}})).await;
        assert_eq!(code, 200);
    }
    let objects = query(&service, scope.clone(), &["storage_cleanup"]).await;
    assert_eq!(row(&objects, "storage_cleanup")["mixed"], true);
    let (code, objects) = put(
        &service,
        "/api/settings/preferences",
        edit_body(
            &objects,
            scope.clone(),
            json!({"storage_cleanup":{"op":"set","value":{"edited":7}}}),
        ),
    )
    .await;
    assert_eq!(code, 200, "{objects}");
    for member in row(&objects, "storage_cleanup")["members"]
        .as_array()
        .unwrap()
    {
        let index = projects
            .iter()
            .position(|project| project["id"] == member["project_id"])
            .unwrap();
        assert_eq!(
            member["view"]["value"],
            json!({"edited":7,"other":index,"future":{"member":index}})
        );
    }
    let (code, _) = put(
        &service,
        "/api/preferences",
        json!({"values":{"storage_cleanup":{"keep":"global","edited":1}}}),
    )
    .await;
    assert_eq!(code, 200);
    let objects = query(&service, json!({}), &["storage_cleanup"]).await;
    let (code, objects) = put(
        &service,
        "/api/settings/preferences",
        edit_body(
            &objects,
            json!({}),
            json!({"storage_cleanup":{"op":"set","value":{"edited":9}}}),
        ),
    )
    .await;
    assert_eq!(code, 200, "{objects}");
    assert_eq!(
        row(&objects, "storage_cleanup")["value"],
        json!({"keep":"global","edited":9})
    );
    // File inheritance uses the same resolver as the legacy endpoint.
    std::fs::write(
        Path::new(projects[0]["path"].as_str().unwrap()).join("orbyn.json"),
        r#"{"defaultThreadEnvMode":"worktree"}"#,
    )
    .unwrap();
    let file = query(&service, scope.clone(), &["default_thread_env_mode"]).await;
    assert_eq!(row(&file, "default_thread_env_mode")["mixed"], true);
    service.stop().await;
}

#[tokio::test]
async fn real_scope_conflicts_and_sqlite_fault_leave_every_setting_unchanged() {
    let dir = TempDir::new();
    let (service, projects, scope) = fixture(&dir).await;
    let original = query(&service, scope.clone(), &["auto_pull"]).await;
    let id = projects[0]["id"].as_str().unwrap();
    assert_eq!(
        put(
            &service,
            &format!("/api/projects/{id}/preferences"),
            json!({"values":{"auto_pull":true}})
        )
        .await
        .0,
        200
    );
    let (code, error) = put(
        &service,
        "/api/settings/preferences",
        edit_body(
            &original,
            scope.clone(),
            json!({"auto_pull":{"op":"set","value":false}}),
        ),
    )
    .await;
    assert_eq!(code, 409, "{error}");
    assert_eq!(error["code"], "settings_conflict");
    let current = query(&service, scope.clone(), &["auto_pull"]).await;
    assert_eq!(
        row(&current, "auto_pull")["overrides"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let (code, _) = service
        .send(
            "/api/projects/create",
            json!({"name":"three","readme":true}),
        )
        .await;
    assert_eq!(code, 201);
    let (code, error) = put(
        &service,
        "/api/settings/preferences",
        edit_body(
            &current,
            scope.clone(),
            json!({"auto_pull":{"op":"set","value":false}}),
        ),
    )
    .await;
    assert_eq!(code, 409, "{error}");
    // A later delete fails after the server/global/first project DML ran.
    let current = query(&service, scope.clone(), &["auto_pull"]).await;
    let (code, _) = put(
        &service,
        "/api/settings/preferences",
        edit_body(
            &current,
            scope.clone(),
            json!({"auto_pull":{"op":"set","value":false}}),
        ),
    )
    .await;
    assert_eq!(code, 200);
    let db = rusqlite::Connection::open(dir.path().join("data/orbyn.sqlite3")).unwrap();
    let mut settings = service.json("/api/settings").await;
    settings["future_field"] = json!({"keep":true});
    settings["title_instructions"] = json!("Server original");
    db.execute("INSERT INTO settings(key,value) VALUES('server_settings',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[settings.to_string()]).unwrap();
    db.execute(
        "INSERT INTO settings(key,value) VALUES('pref:project_title_instructions',?1)",
        [json!("Legacy stored").to_string()],
    )
    .unwrap();
    let reject = projects[1]["id"].as_str().unwrap();
    db.execute_batch(&format!("CREATE TRIGGER fail_scoped_delete BEFORE DELETE ON project_preferences WHEN OLD.project_id='{reject}' BEGIN SELECT RAISE(ABORT,'fixture later delete'); END;")).unwrap();
    let keys = ["auto_pull", "app_update_mode", "project_title_instructions"];
    let before = query(&service, json!({}), &keys).await;
    assert_eq!(
        row(&before, "project_title_instructions")["value"],
        "Legacy stored"
    );
    let body = edit_body(
        &before,
        json!({}),
        json!({"auto_pull":{"op":"reset_overrides","project_ids":[projects[0]["id"],projects[1]["id"]]},"app_update_mode":{"op":"set","value":"off"},"project_title_instructions":{"op":"set","value":"New title"}}),
    );
    let audit_before: i64 = db
        .query_row(
            "SELECT count(*) FROM audit_events WHERE action='settings.save'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let (code, error) = put(&service, "/api/settings/preferences", body.clone()).await;
    assert_eq!(code, 500, "{error}");
    let after = query(&service, json!({}), &keys).await;
    assert_eq!(before["rows"], after["rows"]);
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM audit_events WHERE action='settings.save'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        audit_before
    );
    assert_eq!(
        db.query_row(
            "SELECT value FROM settings WHERE key='server_settings'",
            [],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        settings.to_string()
    );
    db.execute_batch("DROP TRIGGER fail_scoped_delete").unwrap();
    let (code, result) = put(&service, "/api/settings/preferences", body).await;
    assert_eq!(code, 200, "{result}");
    let saved: Value = serde_json::from_str(
        &db.query_row(
            "SELECT value FROM settings WHERE key='server_settings'",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(saved["future_field"]["keep"], true);
    assert_eq!(saved["title_instructions"], "New title");
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM settings WHERE key='pref:project_title_instructions'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    for malformed in [
        json!({"scope":null}),
        json!({"scope":{"selection":null}}),
        json!({"scope":{"selection":{"kind":"all_projects","extra":1}}}),
    ] {
        assert_eq!(
            service
                .send("/api/settings/preferences/query", malformed)
                .await
                .0,
            400
        );
    }
    let (code,error)=service.send("/api/settings/preferences/query",json!({"scope":{"selection":{"kind":"project_group","group_key":"removed"}},"keys":["auto_pull"]})).await;
    assert_eq!(code, 409, "{error}");
    assert_eq!(error["code"], "settings_scope_unavailable");
    drop(db);
    service.stop().await;
}
