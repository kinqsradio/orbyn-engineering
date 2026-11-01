//! One database snapshot and transaction boundary for prepared scoped settings.
//! Callbacks are synchronous and must not re-enter Store or perform external I/O.

use std::collections::BTreeMap;

use orbyn_contracts::{Project, ServerSettings};
use rusqlite::{Connection, TransactionBehavior, params};
use serde_json::Value;

use super::{
    AuditRecord, Store, default_settings, insert_audit, project_row, threads::validate_settings,
};
use crate::error::{CoreError, Result};

pub(crate) struct SettingsSnapshot {
    pub projects: Vec<Project>,
    /// Only pref:* and the existing server_settings document; no other settings.
    pub globals: BTreeMap<String, String>,
    pub overrides: BTreeMap<String, BTreeMap<String, String>>,
}

pub(crate) enum ServerSettingField {
    AutoSettleAfterDays,
    AutoSettleOnMerge,
    AutoSettleKeepPullRequests,
    TitleInstructions,
}

pub(crate) enum SettingWrite {
    Global {
        key: String,
        value: Option<String>,
    },
    Project {
        project_id: String,
        key: String,
        value: Option<String>,
    },
    ServerField {
        field: ServerSettingField,
        value: Value,
    },
}

fn snapshot(conn: &Connection) -> Result<SettingsSnapshot> {
    let projects = conn
        .prepare("SELECT * FROM projects WHERE scratch = 0 ORDER BY id")?
        .query_map([], project_row)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let globals = conn
        .prepare(
            "SELECT key, value FROM settings WHERE key GLOB 'pref:*' OR key = 'server_settings'",
        )?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<std::result::Result<BTreeMap<_, _>, _>>()?;
    let mut overrides: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
    let mut statement = conn.prepare("SELECT p.project_id, p.key, p.value FROM project_preferences p JOIN projects ON projects.id = p.project_id WHERE projects.scratch = 0")?;
    for row in statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })? {
        let (project, key, value) = row?;
        overrides.entry(project).or_default().insert(key, value);
    }
    Ok(SettingsSnapshot {
        projects,
        globals,
        overrides,
    })
}

fn change_server_field(server: &mut Value, field: ServerSettingField, value: Value) -> Result<()> {
    let object = server
        .as_object_mut()
        .ok_or_else(|| CoreError::Invalid("Invalid stored server settings.".into()))?;
    let (object, key) = match field {
        ServerSettingField::TitleInstructions => (object, "title_instructions"),
        field => {
            let auto = object
                .get_mut("auto_settle")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| CoreError::Invalid("Invalid stored auto-settle settings.".into()))?;
            let key = match field {
                ServerSettingField::AutoSettleAfterDays => "after_days",
                ServerSettingField::AutoSettleOnMerge => "on_merge",
                ServerSettingField::AutoSettleKeepPullRequests => "keep_pull_requests",
                ServerSettingField::TitleInstructions => unreachable!(),
            };
            (auto, key)
        }
    };
    object.insert(key.into(), value);
    Ok(())
}

impl Store {
    /// All tables are read from one SQLite read transaction, not separate views.
    pub(crate) fn settings_snapshot(&self) -> Result<SettingsSnapshot> {
        let mut conn = self.reader();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Deferred)?;
        let result = snapshot(&tx)?;
        tx.commit()?;
        Ok(result)
    }

    /// The pure callback observes the transaction-current state and prepares the
    /// whole plan before DML. Failure anywhere rolls back every prepared write.
    pub(crate) fn change_settings<R>(
        &self,
        plan: impl FnOnce(&SettingsSnapshot) -> Result<(R, Vec<SettingWrite>)>,
    ) -> Result<R> {
        self.commit(|tx, _| {
            let current = snapshot(tx)?;
            let (result, writes) = plan(&current)?;
            let mut server = None;
            for write in &writes {
                match write {
                    SettingWrite::Global { key, .. } if !key.starts_with("pref:") => {
                        return Err(CoreError::Invalid(
                            "Invalid global preference namespace.".into(),
                        ));
                    }
                    SettingWrite::Project { project_id, .. }
                        if !current.projects.iter().any(|project| &project.id == project_id) =>
                    {
                        return Err(CoreError::NotFound("project settings scope".into()));
                    }
                    _ => {}
                }
            }
            // Merge only requested fields into the current JSON, preserving forward
            // fields. Deserialize a copy for the same validation as the legacy API.
            let mut ordinary = Vec::new();
            for write in writes {
                if let SettingWrite::ServerField { field, value } = write {
                    if server.is_none() {
                        server = Some(match current.globals.get("server_settings") {
                            Some(text) => serde_json::from_str::<Value>(text)?,
                            None => serde_json::to_value(default_settings())?,
                        });
                    }
                    if let Some(server) = server.as_mut() {
                        change_server_field(server, field, value)?;
                    }
                } else {
                    ordinary.push(write);
                }
            }
            if let Some(server) = &server {
                let typed: ServerSettings = serde_json::from_value(server.clone())?;
                validate_settings(&typed)?;
            }
            if let Some(server) = server {
                // These crate-private preference edits arrive as the local user,
                // matching the legacy settings API without recording any values.
                insert_audit(tx, &AuditRecord {
                    actor: "user".into(), action: "settings.save".into(),
                    target: "server_settings".into(), decision: None, source: "user".into(),
                    thread_id: None, run_id: None, detail: Value::Null,
                })?;
                tx.execute(
                    "INSERT INTO settings (key, value) VALUES ('server_settings', ?1)
                     ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                    [serde_json::to_string(&server)?],
                )?;
            }
            for write in ordinary {
                match write {
                    SettingWrite::Global { key, value: Some(value) } => {
                        tx.execute(
                            "INSERT INTO settings (key, value) VALUES (?1, ?2)
                             ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                            params![key, value],
                        )?;
                    }
                    SettingWrite::Global { key, value: None } => {
                        tx.execute("DELETE FROM settings WHERE key = ?1", [key])?;
                    }
                    SettingWrite::Project { project_id, key, value: Some(value) } => {
                        tx.execute(
                            "INSERT INTO project_preferences (project_id, key, value) VALUES (?1, ?2, ?3)
                             ON CONFLICT (project_id, key) DO UPDATE SET value = excluded.value",
                            params![project_id, key, value],
                        )?;
                    }
                    SettingWrite::Project { project_id, key, value: None } => {
                        tx.execute(
                            "DELETE FROM project_preferences WHERE project_id = ?1 AND key = ?2",
                            params![project_id, key],
                        )?;
                    }
                    SettingWrite::ServerField { .. } => unreachable!(),
                }
            }
            Ok(result)
        })
    }
}

#[cfg(test)]
mod tests;
