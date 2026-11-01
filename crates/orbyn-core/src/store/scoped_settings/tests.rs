use super::*;
use crate::{store::NewProject, testing::TempDir};
use serde_json::json;

fn fixture() -> (TempDir, Store, String, String) {
    let dir = TempDir::new();
    let store = Store::open(&dir.path().join("db"), "settings-test").unwrap();
    let mut ids = Vec::new();
    for (path, scratch) in [("/one", false), ("/two", false), ("/scratch", true)] {
        ids.push(
            store
                .add_project(NewProject {
                    path,
                    name: path,
                    is_git: false,
                    managed: false,
                    scratch,
                })
                .unwrap()
                .id,
        );
    }
    (dir, store, ids.remove(0), ids.remove(0))
}

fn project(id: &str, value: Option<&str>) -> SettingWrite {
    SettingWrite::Project {
        project_id: id.into(),
        key: "auto_settle_after_days".into(),
        value: value.map(str::to_owned),
    }
}
fn global(value: &str) -> SettingWrite {
    SettingWrite::Global {
        key: "pref:auto_pull".into(),
        value: Some(value.into()),
    }
}
fn server(field: ServerSettingField, value: Value) -> SettingWrite {
    SettingWrite::ServerField { field, value }
}

#[test]
fn snapshot_only_reads_preferences_and_registered_non_scratch_projects() {
    let (_dir, store, a, _) = fixture();
    store
        .set_setting("engine_private_fixture", "DO-NOT-INCLUDE")
        .unwrap();
    store.set_setting("pref:auto_pull", "true").unwrap();
    store
        .change_settings(|_| {
            Ok((
                (),
                vec![SettingWrite::Project {
                    project_id: a.clone(),
                    key: "auto_pull".into(),
                    value: Some("false".into()),
                }],
            ))
        })
        .unwrap();
    let snapshot = store.settings_snapshot().unwrap();
    assert_eq!(snapshot.projects.len(), 2);
    assert_eq!(snapshot.globals.len(), 1);
    assert_eq!(snapshot.globals["pref:auto_pull"], "true");
    assert_eq!(snapshot.overrides[&a]["auto_pull"], "false");
}

#[test]
fn later_project_abort_rolls_back_all_scopes_and_normal_retry_succeeds() {
    let (_dir, store, a, b) = fixture();
    let mut original = serde_json::to_value(default_settings()).unwrap();
    original["future_server_field"] = json!({"preserved":true});
    original["auto_settle"]["future_nested"] = json!("kept");
    store
        .set_setting("server_settings", &original.to_string())
        .unwrap();
    store.writer().execute_batch(&format!("CREATE TRIGGER reject_later BEFORE INSERT ON project_preferences WHEN NEW.project_id = '{b}' BEGIN SELECT RAISE(ABORT, 'fixture abort'); END;")).unwrap();
    let mutate = || {
        store.change_settings(|current| {
            assert_eq!(current.globals["server_settings"], original.to_string());
            Ok((
                17,
                vec![
                    global("true"),
                    server(ServerSettingField::AutoSettleAfterDays, Value::Null),
                    project(&a, Some("null")),
                    project(&b, Some("7")),
                ],
            ))
        })
    };
    assert!(mutate().is_err());
    assert!(store.list_audit(None, 20).unwrap().is_empty());
    assert!(store.project_preferences(&a).unwrap().is_empty());
    assert!(store.setting("pref:auto_pull").unwrap().is_none());
    assert_eq!(
        store.setting("server_settings").unwrap().unwrap(),
        original.to_string()
    );
    store
        .writer()
        .execute_batch("DROP TRIGGER reject_later")
        .unwrap();
    assert_eq!(mutate().unwrap(), 17);
    let audit = store.list_audit(None, 20).unwrap();
    assert_eq!(audit.len(), 1);
    assert_eq!(audit[0].action, "settings.save");
    assert_eq!(audit[0].actor, "user");
    assert_eq!(audit[0].target, "server_settings");
    assert!(audit[0].detail.is_null());
    let snapshot = store.settings_snapshot().unwrap();
    assert_eq!(snapshot.overrides[&a]["auto_settle_after_days"], "null");
    let saved: Value = serde_json::from_str(&snapshot.globals["server_settings"]).unwrap();
    assert!(saved["auto_settle"]["after_days"].is_null());
    assert_eq!(
        saved["future_server_field"],
        original["future_server_field"]
    );
    assert_eq!(saved["auto_settle"]["future_nested"], "kept");
    assert_eq!(saved["snooze_presets"], original["snooze_presets"]);
    store
        .change_settings(|_| Ok(((), vec![project(&a, None)])))
        .unwrap();
    assert!(
        !store
            .settings_snapshot()
            .unwrap()
            .overrides
            .contains_key(&a),
        "deleting inheritance override differs from explicit Never/null"
    );
    assert!(store.settings().unwrap().auto_settle.after_days.is_none());
}

#[test]
fn server_field_changes_preserve_transaction_current_document_and_validate_everything() {
    let (_dir, store, a, _) = fixture();
    store
        .change_settings(|_| {
            Ok((
                (),
                vec![server(ServerSettingField::AutoSettleOnMerge, json!(false))],
            ))
        })
        .unwrap();
    store.change_settings(|current| {
        assert_eq!(serde_json::from_str::<Value>(&current.globals["server_settings"]).unwrap()["auto_settle"]["on_merge"], false);
        Ok(((), vec![server(ServerSettingField::AutoSettleKeepPullRequests, json!(true)), server(ServerSettingField::TitleInstructions, json!("Keep it short"))]))
    }).unwrap();
    let before = store.setting("server_settings").unwrap();
    for value in [json!(0), json!(366), json!("bad")] {
        assert!(
            store
                .change_settings(|_| Ok((
                    (),
                    vec![
                        global("true"),
                        project(&a, Some("7")),
                        server(ServerSettingField::AutoSettleAfterDays, value)
                    ]
                )))
                .is_err()
        );
        assert_eq!(store.setting("server_settings").unwrap(), before);
        assert!(store.setting("pref:auto_pull").unwrap().is_none());
        assert!(store.project_preferences(&a).unwrap().is_empty());
    }
    // Validation includes unrelated current settings, not just the patched field.
    let mut bad: Value = serde_json::from_str(before.as_ref().unwrap()).unwrap();
    bad["snooze_presets"] = json!(vec![json!({"label":"bad", "minutes":1}); 9]);
    store
        .set_setting("server_settings", &bad.to_string())
        .unwrap();
    assert!(
        store
            .change_settings(|_| Ok((
                (),
                vec![server(ServerSettingField::TitleInstructions, Value::Null)]
            )))
            .is_err()
    );
    assert_eq!(
        store.setting("server_settings").unwrap().unwrap(),
        bad.to_string()
    );
}

#[test]
fn planning_failure_unknown_projects_and_non_preference_globals_write_nothing() {
    let (_dir, store, _, _) = fixture();
    let failed: Result<()> =
        store.change_settings(|_| Err(CoreError::Invalid("stale membership".into())));
    assert!(failed.is_err());
    assert!(
        store
            .change_settings(|_| Ok(((), vec![global("true"), project("removed", Some("7"))])))
            .is_err()
    );
    assert!(
        store
            .change_settings(|_| Ok((
                (),
                vec![SettingWrite::Global {
                    key: "server_settings".into(),
                    value: Some("{}".into())
                }]
            )))
            .is_err()
    );
    assert!(store.setting("pref:auto_pull").unwrap().is_none());
}

#[test]
fn concurrent_commit_does_not_mix_snapshot_tables_or_reuse_a_stale_read() {
    let (_dir, store, a, _) = fixture();
    store
        .change_settings(|_| Ok(((), vec![global("false"), project(&a, Some("3"))])))
        .unwrap();
    let mut reader = store.reader();
    let transaction = reader
        .transaction_with_behavior(TransactionBehavior::Deferred)
        .unwrap();
    let before = snapshot(&transaction).unwrap();
    // A WAL writer can finish while this read transaction retains its snapshot.
    store
        .change_settings(|_| Ok(((), vec![global("true"), project(&a, Some("7"))])))
        .unwrap();
    let during = snapshot(&transaction).unwrap();
    assert_eq!(during.globals, before.globals);
    assert_eq!(during.overrides, before.overrides);
    transaction.commit().unwrap();
    drop(reader);
    let after = store.settings_snapshot().unwrap();
    assert_eq!(after.globals["pref:auto_pull"], "true");
    assert_eq!(after.overrides[&a]["auto_settle_after_days"], "7");
}
